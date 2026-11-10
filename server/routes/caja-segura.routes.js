'use strict';
// /api/caja — cierre seguro con arqueo por denominaciones (mejora 8) y control
// de aperturas manuales de la gaveta (mejora 9). Factory con dependencias
// inyectadas; el cierre en sí sigue en POST /api/cash/close (server.js), que
// llama a prepararCierre() dentro de su transacción.
//
// Reglas:
// - Arqueo a ciegas: con el cierre seguro, nadie ve el esperado ni la
//   diferencia de un turno abierto (los arqueos del turno se guardan con ellos
//   y salen en el reporte de cierre). Solo quien puede ver reportes de caja
//   consulta el resumen de un turno abierto.
// - El dinero solo cambia con un movimiento explícito (retiro, gasto, cambio
//   desigual). Abrir la gaveta por sí solo no mueve el efectivo esperado.
// - Un consumo interno descuenta inventario y NO abre la gaveta.
// - No hay aprobaciones extra: se respetan los permisos que ya existen.
const express = require('express');
const os = require('os');
const { randomUUID } = require('crypto');
const M = require('../../js/pos-money');
const arqueo = require('../services/caja-arqueo');
const { ensureCajaSegura } = require('../services/finance-migration');

const MOTIVOS = Object.freeze({
  conteo: { etiqueta: 'Conteo de efectivo', abreGaveta: true },
  cambio: { etiqueta: 'Cambio de menudo / denominaciones', abreGaveta: true },
  retiro: { etiqueta: 'Corte parcial / retiro para resguardo', abreGaveta: true },
  consumo: { etiqueta: 'Consumo interno de productos', abreGaveta: false },
  gasto: { etiqueta: 'Gasto o salida de efectivo', abreGaveta: true },
  otro: { etiqueta: 'Otro motivo', abreGaveta: true },
  venta: { etiqueta: 'Apertura con venta', abreGaveta: true },
});
const ESTADOS_GAVETA = new Set(['abierta', 'fallo', 'sin_gaveta']);
const UUID = /^[\w-]{16,64}$/;

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
const texto = (v, max) => String(v ?? '').trim().slice(0, max);
function montoPositivo(value, campo) {
  let cents;
  try { cents = M.cents(value ?? 0); M.number(cents); } catch (_) { throw httpError(`${campo}: importe no válido.`); }
  if (cents <= 0n) throw httpError(`${campo} debe ser mayor que cero.`);
  return cents;
}
function montoOpcional(value, campo) {
  if (value === undefined || value === null || value === '') return 0n;
  let cents;
  try { cents = M.cents(value); M.number(cents); } catch (_) { throw httpError(`${campo}: importe no válido.`); }
  if (cents < 0n) throw httpError(`${campo} no puede ser negativo.`);
  return cents;
}

// Mesas con consumo guardado y sin cobrar en la sucursal (módulo Mesas).
// Una cuenta abierta vacía no es deuda. Si otra caja de la misma sucursal
// sigue abierta, esas mesas se pueden cobrar allí y el cierre no se bloquea.
async function mesasConDeuda(runner, { branchId, cashRegisterId }) {
  if (!branchId) return { mesas: [], otraCajaAbierta: false, bloquea: false };
  let rows;
  try {
    rows = await runner(
      `SELECT id, nombre, elemento_id, estado, draft_json, updated_at FROM mesas_cuentas
        WHERE branch_id = ? AND estado IN ('abierta', 'cobrando') ORDER BY updated_at`, [branchId]);
  } catch (error) {
    // Sin el módulo de Mesas la tabla no existe: no hay cuentas que cobrar.
    if (/no such table|doesn't exist|does not exist/i.test(String(error?.message || ''))) return { mesas: [], otraCajaAbierta: false, bloquea: false };
    throw error;
  }
  const mesas = [];
  for (const r of rows) {
    let draft = {};
    try { draft = JSON.parse(r.draft_json || '{}'); } catch (_) { draft = {}; }
    const items = Array.isArray(draft.items) ? draft.items.filter((i) => Number(i?.qty) > 0) : [];
    if (!items.length) continue;
    let consumo = 0n;
    for (const it of items) consumo += M.cents((Number(it.qty) * Number(it.precio || 0) * (1 - Number(it.descuento || 0) / 100)).toFixed(2));
    mesas.push({ cuentaId: r.id, mesa: String(draft.tableLabel || r.elemento_id || 'Mesa'), cuenta: r.nombre || 'General', productos: items.length,
      consumo: M.number(consumo), estado: r.estado, actualizada: String(r.updated_at || '') });
  }
  let otraCajaAbierta = false;
  if (mesas.length && cashRegisterId) {
    const [o] = await runner(`SELECT COUNT(*) AS total FROM cash_sessions WHERE status = 'open' AND branch_id = ? AND cash_register_id <> ?`, [branchId, cashRegisterId]);
    otraCajaAbierta = Number(o?.total || 0) > 0;
  }
  return { mesas, otraCajaAbierta, bloquea: mesas.length > 0 && !otraCajaAbierta };
}
function mensajeMesas({ mesas }) {
  const lista = mesas.slice(0, 8).map((m) => `${m.mesa}${m.cuenta && m.cuenta !== 'General' ? ` (${m.cuenta})` : ''} · RD$ ${m.consumo.toFixed(2)}`).join(', ');
  return `No puedes cerrar caja: hay ${mesas.length} mesa(s) con consumo sin cobrar (${lista}${mesas.length > 8 ? ', …' : ''}). Cóbralas antes de cerrar.`;
}

function createCajaSeguraRouter(deps) {
  const {
    query, withTransaction, addColumnIfMissing, resolveRequestActorUser, getActor, writeAuditLog,
    resolveScopedBusinessStructureSelection, userCanCloseCash, userCanMakeCorte, userCanOpenDrawer,
    userCanViewCashReports, userCanManageGlobalConfig, getUserScopeBranchId, isMysqlDeployment,
    changeBranchInventoryStock, registerInventoryMovement, nowSql, ensureReturnTables,
  } = deps;
  const router = express.Router();
  let schemaReady = null;
  const ensureSchema = () => {
    if (!schemaReady) {
      schemaReady = (async () => {
        if (typeof ensureReturnTables === 'function') await ensureReturnTables();
        await ensureCajaSegura(query, addColumnIfMissing);
      })().catch((e) => { schemaReady = null; throw e; });
    }
    return schemaReady;
  };
  const deviceOf = (req) => texto(req.headers['x-device-id'] || req.body?.deviceId || os.hostname(), 160);
  const run = (conn) => (sql, params) => conn.query(sql, params);
  const auditar = (req, actor, structure, extra, conn) => writeAuditLog({
    ...actor, moduleName: 'Caja', branchId: structure?.branchId ?? null, cashRegisterId: structure?.cashRegisterId ?? null,
    deviceId: deviceOf(req), ...extra,
  }, conn);

  async function leerCierreSeguro(runner = query) {
    const [row] = await runner('SELECT secure_cash_close FROM config WHERE id = 1');
    return Boolean(Number(row?.secure_cash_close || 0));
  }

  async function turnoAbierto(conn, cashRegisterId) {
    const lock = isMysqlDeployment() ? ' FOR UPDATE' : '';
    const [session] = await conn.query(
      `SELECT * FROM cash_sessions WHERE status = 'open' AND cash_register_id = ? ORDER BY id DESC LIMIT 1${lock}`,
      [cashRegisterId]
    );
    return session || null;
  }

  async function registrarMovimiento(conn, { session, structure, actor, tipo, monto, notas, fecha }) {
    const result = await conn.query(
      `INSERT INTO cash_movements (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at, branch_id, cash_register_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [session.id, tipo, M.number(monto), texto(notas, 255), actor.userId || null, actor.userName || 'Sistema', fecha, structure.branchId, structure.cashRegisterId]
    );
    // Se mantienen los acumulados de siempre para las pantallas que los leen.
    await conn.query('UPDATE cash_sessions SET current_amount = current_amount + ? WHERE id = ?', [M.number(monto), session.id]);
    await conn.query('UPDATE config SET cash_amount = cash_amount + ? WHERE id = 1', [M.number(monto)]);
    return Number(result.insertId);
  }

  // ── Configuración ──────────────────────────────────────────────────────
  router.get('/config', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    await ensureSchema();
    res.json({
      cierreSeguro: await leerCierreSeguro(), denominaciones: arqueo.DENOMINACIONES, motivos: MOTIVOS,
      // Con el cierre seguro y la caja abierta, Reportes solo se abre para
      // quien ve reportes de caja (el cajero ve sus ventas al cerrar).
      veTurnoAbierto: Boolean(userCanViewCashReports(actorUser)),
      puedeConfigurar: Boolean(userCanManageGlobalConfig(actorUser)),
    });
  });

  router.put('/config', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (!userCanManageGlobalConfig(actorUser)) return res.status(403).json({ error: 'Solo un administrador puede cambiar el modo de cierre.' });
    if (typeof req.body?.cierreSeguro !== 'boolean') return res.status(400).json({ error: 'Indica si el cierre seguro queda activo.' });
    await ensureSchema();
    await withTransaction(async (conn) => {
      const antes = await leerCierreSeguro(run(conn));
      await conn.query('UPDATE config SET secure_cash_close = ? WHERE id = 1', [req.body.cierreSeguro ? 1 : 0]);
      await auditar(req, getActor(req), null, {
        moduleName: 'Configuración', actionName: 'Modo de cierre de caja', before: { cierreSeguro: antes }, after: { cierreSeguro: req.body.cierreSeguro },
        detail: req.body.cierreSeguro ? 'Cierre seguro con arqueo por denominaciones activado' : 'Cierre seguro desactivado',
      }, conn);
    });
    res.json({ cierreSeguro: req.body.cierreSeguro });
  });

  // ── ¿Se puede cerrar? (antes de pedir el conteo) ───────────────────────
  router.get('/cierre/verificar', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (!userCanCloseCash(actorUser)) return res.status(403).json({ error: 'No tienes permiso para cerrar caja.' });
    const structure = await resolveScopedBusinessStructureSelection(req, null, req.query.branchId, req.query.cashRegisterId);
    const mesas = await mesasConDeuda(query, { branchId: structure.branchId, cashRegisterId: structure.cashRegisterId });
    res.json({ puedeCerrar: !mesas.bloquea, mesas: mesas.mesas, otraCajaAbierta: mesas.otraCajaAbierta, mensaje: mesas.bloquea ? mensajeMesas(mesas) : '' });
  });

  // ── Resumen de un turno ────────────────────────────────────────────────
  // Abierto: solo para quien ve reportes de caja (el cajero cuenta a ciegas).
  // Cerrado: también para quien cierra caja, para reimprimir su reporte.
  router.get('/turnos/:sessionId/resumen', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    await ensureSchema();
    const sessionId = Number(req.params.sessionId);
    const [session] = await query('SELECT id, status, branch_id FROM cash_sessions WHERE id = ? LIMIT 1', [sessionId]);
    if (!session) return res.status(404).json({ error: 'Turno no encontrado.' });
    const scope = getUserScopeBranchId(actorUser);
    if (scope && Number(scope) !== Number(session.branch_id)) return res.status(403).json({ error: 'Ese turno es de otra sucursal.' });
    const puedeVer = userCanViewCashReports(actorUser) || (session.status !== 'open' && userCanCloseCash(actorUser));
    if (!puedeVer) return res.status(403).json({ error: 'El esperado del turno se muestra después de declarar el conteo.' });
    const [cierre] = await query('SELECT report_json FROM cash_closings WHERE cash_session_id = ? ORDER BY id DESC LIMIT 1', [sessionId]);
    if (cierre?.report_json) {
      try { return res.json(JSON.parse(cierre.report_json)); } catch (_) { /* se recalcula */ }
    }
    res.json(await arqueo.resumenTurno(query, sessionId));
  });

  // ── Arqueo durante el turno (no cierra ni cambia el esperado) ──────────
  router.post('/arqueos', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (!userCanMakeCorte(actorUser)) return res.status(403).json({ error: 'No tienes permiso para hacer arqueos de caja.' });
    await ensureSchema();
    const countUuid = texto(req.body?.countUuid || randomUUID(), 64);
    if (!UUID.test(countUuid)) return res.status(400).json({ error: 'Identificador de conteo no válido.' });
    const conteo = arqueo.contarDenominaciones(req.body?.denominaciones);
    const actor = getActor(req);
    const structure = await resolveScopedBusinessStructureSelection(req, null, req.body?.branchId, req.body?.cashRegisterId);
    const result = await withTransaction(async (conn) => {
      const [previo] = await conn.query('SELECT * FROM cash_counts WHERE count_uuid = ? LIMIT 1', [countUuid]);
      if (previo) return { repetido: true, fila: previo };
      const session = await turnoAbierto(conn, structure.cashRegisterId);
      if (!session) throw httpError('No hay una caja abierta para contar.', 409);
      const resumen = await arqueo.resumenTurno(run(conn), session.id);
      const cmp = arqueo.compararConteo(conteo.total, resumen.efectivo.esperado);
      const ins = await conn.query(
        `INSERT INTO cash_counts (count_uuid, cash_session_id, branch_id, cash_register_id, kind, denominations_json, counted_amount, expected_amount, difference_amount, notes, counted_by_user_id, counted_by_user_name, device_id, created_at)
         VALUES (?, ?, ?, ?, 'arqueo', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [countUuid, session.id, structure.branchId, structure.cashRegisterId, JSON.stringify(conteo.lineas), cmp.contado, cmp.esperado, cmp.diferencia,
          texto(req.body?.notas, 255) || null, actor.userId || null, actor.userName || 'Sistema', deviceOf(req), nowSql()]
      );
      const drawerUuid = texto(req.body?.drawerEventUuid, 64);
      if (drawerUuid) await conn.query('UPDATE cash_drawer_events SET cash_count_id = ? WHERE event_uuid = ? AND cash_session_id = ?', [ins.insertId, drawerUuid, session.id]);
      await auditar(req, actor, structure, {
        actionName: 'Arqueo de caja', cashSessionId: session.id, documentRef: countUuid, amount: cmp.contado,
        result: cmp.estado === 'cuadrada' ? 'exito' : 'diferencia', after: { contado: cmp.contado, esperado: cmp.esperado, diferencia: cmp.diferencia },
        detail: `Arqueo sin cierre · contado ${cmp.contado.toFixed(2)} · diferencia ${cmp.diferencia.toFixed(2)}`,
      }, conn);
      const [fila] = await conn.query('SELECT * FROM cash_counts WHERE id = ?', [ins.insertId]);
      return { repetido: false, fila };
    });
    const f = result.fila;
    const cmp = arqueo.compararConteo(f.counted_amount, f.expected_amount);
    const base = {
      id: Number(f.id), countUuid: f.count_uuid, repetido: result.repetido, sesionCajaId: Number(f.cash_session_id),
      denominaciones: JSON.parse(f.denominations_json || '[]'),
    };
    // Cierre seguro: el esperado y la diferencia quedan guardados y salen en el
    // reporte de cierre; durante el turno solo se devuelve lo contado.
    const ciego = await leerCierreSeguro();
    res.status(result.repetido ? 200 : 201).json(ciego ? { ...base, contado: cmp.contado, ciego: true } : { ...base, ...cmp });
  });

  // Lo llama POST /api/cash/close dentro de su transacción (la sesión ya está
  // bloqueada). Devuelve lo que se guarda en cash_sessions/cash_closings.
  async function prepararCierre(conn, { session, body = {}, actor, structure, req }) {
    await ensureSchema();
    // Mesas con consumo sin cobrar: la cuenta quedaría huérfana al cerrar.
    const mesas = await mesasConDeuda(run(conn), {
      branchId: Number(session.branch_id || structure.branchId || 0) || null,
      cashRegisterId: Number(session.cash_register_id || structure.cashRegisterId || 0) || null,
    });
    if (mesas.bloquea) throw Object.assign(httpError(mensajeMesas(mesas), 409), { code: 'MESAS_PENDIENTES' });
    const cierreSeguro = await leerCierreSeguro(run(conn));
    const traeConteo = body.denominaciones && typeof body.denominaciones === 'object';
    if (cierreSeguro && !traeConteo) throw httpError('El cierre seguro exige el conteo por denominaciones.', 400);
    const conteo = traeConteo ? arqueo.contarDenominaciones(body.denominaciones) : null;
    const resumen = await arqueo.resumenTurno(run(conn), session.id);
    const contado = conteo ? conteo.total : Number(body.monto || 0);
    const cmp = arqueo.compararConteo(contado, resumen.efectivo.esperado);
    let verifon = null;
    if (body.tarjetaVerifon !== undefined && body.tarjetaVerifon !== null && body.tarjetaVerifon !== '') {
      const cents = montoOpcional(body.tarjetaVerifon, 'Total del verifón');
      verifon = { total: M.number(cents), diferencia: M.number(cents - M.cents(resumen.tarjeta.cobrado.toFixed(2))) };
    }
    let countId = null;
    if (conteo) {
      const ins = await conn.query(
        `INSERT INTO cash_counts (count_uuid, cash_session_id, branch_id, cash_register_id, kind, denominations_json, counted_amount, expected_amount, difference_amount, notes, counted_by_user_id, counted_by_user_name, device_id, created_at)
         VALUES (?, ?, ?, ?, 'cierre', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), session.id, structure.branchId, structure.cashRegisterId, JSON.stringify(conteo.lineas), cmp.contado, cmp.esperado, cmp.diferencia,
          texto(body.obs, 255) || null, actor.userId || null, actor.userName || 'Sistema', req ? deviceOf(req) : os.hostname(), nowSql()]
      );
      countId = Number(ins.insertId);
    }
    const reporte = {
      ...resumen,
      conteo: { modo: conteo ? 'denominaciones' : 'monto', cierreSeguro, denominaciones: conteo ? conteo.lineas : null, ...cmp, countId },
      verifon,
      cerradoPor: actor.userName || 'Sistema',
      notas: texto(body.obs, 255),
      generadoEn: nowSql(),
    };
    reporte.turno.estado = 'closed';
    reporte.turno.cierre = reporte.generadoEn;
    reporte.turno.cerradoPor = reporte.cerradoPor;
    return { cierreSeguro, conteo, comparacion: cmp, reporte, countId, verifon };
  }

  async function guardarReporteCierre(conn, closingId, preparado) {
    await conn.query(
      'UPDATE cash_closings SET denominations_json = ?, report_json = ?, secure_mode = ?, card_terminal_total = ? WHERE id = ?',
      [preparado.conteo ? JSON.stringify(preparado.conteo.lineas) : null, JSON.stringify(preparado.reporte),
        preparado.cierreSeguro ? 1 : 0, preparado.verifon ? preparado.verifon.total : null, closingId]
    );
  }

  // ── Aperturas manuales de la gaveta ────────────────────────────────────
  router.post('/gaveta', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    await ensureSchema();
    const motivo = String(req.body?.motivo || '').trim();
    const definicion = MOTIVOS[motivo];
    if (!definicion) return res.status(400).json({ error: 'Selecciona el motivo de la apertura.' });
    if (motivo !== 'venta' && !userCanOpenDrawer(actorUser)) return res.status(403).json({ error: 'No tienes permiso para abrir la gaveta.' });
    const eventUuid = texto(req.body?.eventUuid || randomUUID(), 64);
    if (!UUID.test(eventUuid)) return res.status(400).json({ error: 'Identificador de apertura no válido.' });
    const actor = getActor(req);
    const structure = await resolveScopedBusinessStructureSelection(req, null, req.body?.branchId, req.body?.cashRegisterId);
    const b = req.body || {};

    const result = await withTransaction(async (conn) => {
      const [previo] = await conn.query('SELECT * FROM cash_drawer_events WHERE event_uuid = ? LIMIT 1', [eventUuid]);
      if (previo) return { repetido: true, fila: previo };
      const session = await turnoAbierto(conn, structure.cashRegisterId);
      const fecha = nowSql();
      const evento = {
        description: texto(b.descripcion, 500) || null, amount: 0n, cashIn: 0n, cashOut: 0n, destination: null,
        responsible: texto(b.responsable, 160) || null, evidence: texto(b.evidencia, 255) || null,
        movementId: null, items: null, saleRef: texto(b.saleRef, 60) || null,
        drawerStatus: definicion.abreGaveta ? 'pendiente' : 'no_aplica',
      };
      const requiereTurno = ['conteo', 'cambio', 'retiro', 'gasto'].includes(motivo);
      if (requiereTurno && !session) throw httpError('La caja debe estar abierta para esta operación.', 409);

      if (motivo === 'cambio') {
        evento.cashIn = montoOpcional(b.entrada, 'Efectivo que entra');
        evento.cashOut = montoOpcional(b.salida, 'Efectivo que sale');
        evento.amount = evento.cashIn - evento.cashOut;
        // Cambiar denominaciones por el mismo valor no mueve el saldo.
        if (evento.amount !== 0n) {
          evento.movementId = await registrarMovimiento(conn, { session, structure, actor, tipo: 'Cambio de menudo', monto: evento.amount, fecha,
            notas: `Cambio de menudo${evento.description ? ` — ${evento.description}` : ''}` });
        }
      } else if (motivo === 'retiro' || motivo === 'gasto') {
        const monto = montoPositivo(b.monto, motivo === 'retiro' ? 'El monto del retiro' : 'El monto del gasto');
        if (motivo === 'retiro') {
          evento.destination = texto(b.destino, 160);
          if (!evento.destination) throw httpError('Indica a dónde va el dinero retirado (caja fuerte, banco, administración…).');
        } else if (!evento.description) throw httpError('Indica el concepto del gasto.');
        const resumen = await arqueo.resumenTurno(run(conn), session.id);
        if (M.cents(resumen.efectivo.esperado.toFixed(2)) < monto) throw httpError('El monto supera el efectivo registrado en caja.', 409);
        evento.cashOut = monto; evento.amount = -monto;
        evento.movementId = await registrarMovimiento(conn, {
          session, structure, actor, fecha, monto: -monto,
          tipo: motivo === 'retiro' ? 'Retiro de efectivo' : 'Gasto',
          notas: motivo === 'retiro'
            ? `Corte parcial → ${evento.destination}${evento.responsible ? ` · recibe ${evento.responsible}` : ''}`
            : `${evento.description}${evento.responsible ? ` · ${evento.responsible}` : ''}`,
        });
      } else if (motivo === 'consumo') {
        const items = Array.isArray(b.items) ? b.items : [];
        if (!items.length) throw httpError('Selecciona los productos consumidos.');
        if (!evento.responsible) throw httpError('Indica la persona responsable del consumo.');
        const branchId = Number(structure.branchId || 0);
        const lineas = [];
        for (const it of items.slice(0, 100)) {
          const productId = Number(it?.productId || 0);
          const qty = Number(it?.qty || 0);
          if (!productId || !Number.isFinite(qty) || qty <= 0 || qty > 100000) throw httpError('Cantidad de producto no válida.');
          const [product] = await conn.query('SELECT id, nombre, tracks_stock, precio_compra FROM products WHERE id = ? LIMIT 1', [productId]);
          if (!product) throw httpError('Producto no encontrado.', 404);
          let stock = null;
          if (Number(product.tracks_stock ?? 1) !== 0 && branchId) {
            stock = await changeBranchInventoryStock(conn, { productId, branchId, quantityDelta: -qty, preventNegative: true });
            await registerInventoryMovement(conn, {
              productId, branchId, cashRegisterId: structure.cashRegisterId || null, tipo: 'consumo_interno', cantidad: -qty,
              stockAnterior: stock.previousStock, stockNuevo: stock.nextStock, costoUnitario: Number(stock.unitCost || product.precio_compra || 0),
              referenciaTipo: 'consumo_interno', referenciaId: eventUuid,
              notas: `Consumo interno · ${evento.responsible}${evento.description ? ` — ${evento.description}` : ''}`.slice(0, 255),
              usuarioId: actor.userId || null, usuarioNombre: actor.userName || 'Sistema',
            });
          }
          lineas.push({ productId, nombre: product.nombre, cantidad: qty, costoUnitario: Number(stock?.unitCost || product.precio_compra || 0), descontoInventario: Boolean(stock) });
        }
        evento.items = lineas;
      } else if (motivo === 'otro') {
        if (!evento.description || evento.description.length < 4) throw httpError('Describe el motivo de la apertura.');
      } else if (motivo === 'venta') {
        if (!evento.saleRef) throw httpError('Falta la factura de la venta.');
        evento.drawerStatus = ESTADOS_GAVETA.has(b.estadoGaveta) ? b.estadoGaveta : 'abierta';
      }

      const ins = await conn.query(
        `INSERT INTO cash_drawer_events (event_uuid, cash_session_id, branch_id, cash_register_id, device_id, user_id, user_name, origin, reason, description,
           amount, cash_in, cash_out, destination, responsible, evidence, cash_movement_id, sale_ref, items_json, drawer_requested, drawer_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [eventUuid, session?.id || null, structure.branchId, structure.cashRegisterId, deviceOf(req), actor.userId || null, actor.userName || 'Sistema',
          motivo === 'venta' ? 'venta' : 'manual', motivo, evento.description, M.number(evento.amount), M.number(evento.cashIn), M.number(evento.cashOut),
          evento.destination, evento.responsible, evento.evidence, evento.movementId, evento.saleRef, evento.items ? JSON.stringify(evento.items) : null,
          definicion.abreGaveta ? 1 : 0, evento.drawerStatus, fecha]
      );
      if (motivo !== 'venta') {
        await auditar(req, actor, structure, {
          actionName: `Gaveta: ${definicion.etiqueta}`, cashSessionId: session?.id || null, documentRef: eventUuid,
          amount: evento.amount === 0n ? null : M.number(evento.amount), reason: evento.description || evento.destination || null,
          after: { motivo, monto: M.number(evento.amount), destino: evento.destination, responsable: evento.responsible, productos: evento.items },
          detail: `${definicion.etiqueta}${evento.amount !== 0n ? ` · ${M.number(evento.amount).toFixed(2)}` : ''}${evento.description ? ` · ${evento.description}` : ''}`,
        }, conn);
      }
      const [fila] = await conn.query('SELECT * FROM cash_drawer_events WHERE id = ?', [ins.insertId]);
      return { repetido: false, fila };
    });
    res.status(result.repetido ? 200 : 201).json({ ...mapEvento(result.fila), repetido: result.repetido, abrirGaveta: Boolean(Number(result.fila.drawer_requested)) && result.fila.drawer_status === 'pendiente' });
  });

  // Resultado físico de la orden de apertura (la gaveta respondió o no).
  router.patch('/gaveta/:uuid/resultado', async (req, res) => {
    await resolveRequestActorUser(req, { required: true });
    await ensureSchema();
    const estado = String(req.body?.estado || '');
    if (!ESTADOS_GAVETA.has(estado)) return res.status(400).json({ error: 'Estado de gaveta no válido.' });
    const result = await query(
      `UPDATE cash_drawer_events SET drawer_status = ?, drawer_error = ? WHERE event_uuid = ? AND drawer_requested = 1`,
      [estado, texto(req.body?.error, 255) || null, texto(req.params.uuid, 64)]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Apertura no encontrada.' });
    const [fila] = await query('SELECT * FROM cash_drawer_events WHERE event_uuid = ?', [texto(req.params.uuid, 64)]);
    res.json(mapEvento(fila));
  });

  router.get('/gaveta', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (!userCanViewCashReports(actorUser)) return res.status(403).json({ error: 'No tienes permiso para ver el historial de la gaveta.' });
    await ensureSchema();
    const desde = String(req.query.desde || ''), hasta = String(req.query.hasta || '');
    if (![desde, hasta].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) || desde > hasta) return res.status(400).json({ error: 'Período no válido.' });
    const params = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    let where = 'e.created_at BETWEEN ? AND ?';
    const scope = getUserScopeBranchId(actorUser) || Number(req.query.branchId || 0);
    if (scope) { where += ' AND e.branch_id = ?'; params.push(scope); }
    for (const [campo, col] of [['cashRegisterId', 'e.cash_register_id'], ['userId', 'e.user_id']]) {
      if (Number(req.query[campo])) { where += ` AND ${col} = ?`; params.push(Number(req.query[campo])); }
    }
    if (MOTIVOS[req.query.motivo]) { where += ' AND e.reason = ?'; params.push(req.query.motivo); }
    if (req.query.origen === 'manual' || req.query.origen === 'venta') { where += ' AND e.origin = ?'; params.push(req.query.origen); }
    const rows = await query(
      `SELECT e.*, cr.nombre AS register_name, b.nombre AS branch_name FROM cash_drawer_events e
         LEFT JOIN cash_registers cr ON cr.id = e.cash_register_id LEFT JOIN branches b ON b.id = e.branch_id
        WHERE ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT 2000`, params);
    const porMotivo = {}, porUsuario = {};
    let entradas = 0n, salidas = 0n;
    for (const r of rows) {
      porMotivo[r.reason] = (porMotivo[r.reason] || 0) + 1;
      const u = r.user_name || 'Sistema';
      porUsuario[u] = (porUsuario[u] || 0) + 1;
      entradas += M.cents(Number(r.cash_in || 0).toFixed(2)); salidas += M.cents(Number(r.cash_out || 0).toFixed(2));
    }
    res.json({
      desde, hasta, total: rows.length, porMotivo, porUsuario, entradas: M.number(entradas), salidas: M.number(salidas),
      nota: 'Se registran las órdenes de apertura que envía el sistema. Sin un sensor de gaveta compatible no se detectan aperturas con llave.',
      eventos: rows.map(mapEvento),
    });
  });

  // ── Estado real de tarjetas y transferencias ───────────────────────────
  router.patch('/pagos/:saleId', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (!userCanViewCashReports(actorUser)) return res.status(403).json({ error: 'No tienes permiso para confirmar pagos.' });
    await ensureSchema();
    const metodo = String(req.body?.metodo || '');
    const estado = String(req.body?.estado || '');
    const validos = { transferencia: ['pendiente', 'confirmada', 'rechazada'], tarjeta: ['aprobada', 'reversada'] };
    if (!validos[metodo]?.includes(estado)) return res.status(400).json({ error: 'Estado de pago no válido.' });
    const saleId = Number(req.params.saleId);
    const actor = getActor(req);
    const venta = await withTransaction(async (conn) => {
      const [sale] = await conn.query('SELECT id, invoice_number, branch_id, transfer_amount, card_amount, payment_method, total, card_status, transfer_status FROM sales WHERE id = ? LIMIT 1', [saleId]);
      if (!sale) throw httpError('Venta no encontrada.', 404);
      const scope = getUserScopeBranchId(actorUser);
      if (scope && Number(scope) !== Number(sale.branch_id)) throw httpError('Esa venta es de otra sucursal.', 403);
      const monto = metodo === 'transferencia'
        ? Number(sale.transfer_amount ?? (sale.payment_method === 'transferencia' ? sale.total : 0))
        : Number(sale.card_amount ?? (sale.payment_method === 'tarjeta' ? sale.total : 0));
      if (!(monto > 0)) throw httpError(`Esa venta no tiene pago con ${metodo}.`, 409);
      const columna = metodo === 'transferencia' ? 'transfer_status' : 'card_status';
      const antes = sale[columna] || (metodo === 'transferencia' ? 'pendiente' : 'aprobada');
      if (metodo === 'transferencia') {
        await conn.query('UPDATE sales SET transfer_status = ?, transfer_confirmed_by = ?, transfer_confirmed_at = ? WHERE id = ?', [estado, actor.userName || 'Sistema', nowSql(), saleId]);
      } else await conn.query('UPDATE sales SET card_status = ? WHERE id = ?', [estado, saleId]);
      await writeAuditLog({
        ...actor, moduleName: 'Caja', actionName: `Pago con ${metodo}: ${estado}`, documentRef: sale.invoice_number, amount: monto, paymentMethod: metodo,
        reason: texto(req.body?.nota, 255) || null, before: { estado: antes }, after: { estado }, detail: `${sale.invoice_number} · ${metodo} ${antes} → ${estado}`,
      }, conn);
      return { saleId, factura: sale.invoice_number, metodo, estado };
    });
    res.json(venta);
  });

  return { router, prepararCierre, guardarReporteCierre, ensureSchema, MOTIVOS };
}

function mapEvento(r) {
  return {
    id: Number(r.id), eventUuid: r.event_uuid, sesionCajaId: r.cash_session_id ? Number(r.cash_session_id) : null,
    sucursalId: r.branch_id ? Number(r.branch_id) : null, cajaId: r.cash_register_id ? Number(r.cash_register_id) : null,
    sucursal: r.branch_name || '', caja: r.register_name || '', dispositivo: r.device_id || '', usuario: r.user_name || '',
    origen: r.origin, motivo: r.reason, etiqueta: MOTIVOS[r.reason]?.etiqueta || r.reason, descripcion: r.description || '',
    monto: Number(r.amount || 0), entrada: Number(r.cash_in || 0), salida: Number(r.cash_out || 0),
    destino: r.destination || '', responsable: r.responsible || '', evidencia: r.evidence || '',
    movimientoCajaId: r.cash_movement_id ? Number(r.cash_movement_id) : null, conteoId: r.cash_count_id ? Number(r.cash_count_id) : null,
    factura: r.sale_ref || '', productos: (() => { try { return r.items_json ? JSON.parse(r.items_json) : []; } catch (_) { return []; } })(),
    estadoGaveta: r.drawer_status, errorGaveta: r.drawer_error || '',
    fecha: r.created_at instanceof Date ? r.created_at.toISOString().slice(0, 19).replace('T', ' ') : String(r.created_at || ''),
  };
}

module.exports = { createCajaSeguraRouter, MOTIVOS, mesasConDeuda };

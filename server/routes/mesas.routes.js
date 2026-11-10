'use strict';
const express = require('express');
const { validarPlano } = require('../services/mesas-plano');
const cuentas = require('../services/mesas-cuentas');
const reservas = require('../services/mesas-reservas');
const anticipos = require('../services/mesas-anticipos');

module.exports = function createMesasRouter(deps) {
  const { query, withTransaction, addColumnIfMissing, resolveRequestActorUser,
    isGlobalAdministratorUser, isBranchAdministratorUser, getUserScopeBranchId,
    getTerminalBranchId, writeAuditLog, userRoleHasPermission } = deps;
  // Caja de esta terminal (anticipos de reservas): sucursal/caja de la petición,
  // con las mismas validaciones de acceso que una venta.
  const resolveCashStructure = deps.resolveCashStructure || (async () => { throw Object.assign(new Error('Caja no disponible.'), { statusCode: 400 }); });
  const prepararCaja = deps.prepararCaja || (async () => {});
  const userCanReturnSales = deps.userCanReturnSales || (() => false);
  const sincronizarMovimientoCaja = deps.sincronizarMovimientoCaja || (() => {});
  const getConfig = deps.getConfig || null;
  const nowSql = deps.nowSql || (() => anticipos.fechaLocalSql());
  const router = express.Router();
  let ready;
  const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
  async function schema() {
    await cuentas.ensure(query, addColumnIfMissing);
    await addColumnIfMissing('config', 'mesas_enabled', 'INTEGER DEFAULT 0');
    await query(`CREATE TABLE IF NOT EXISTS mesas_planos (
      branch_id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0,
      elementos_json LONGTEXT NOT NULL, updated_at VARCHAR(40) NOT NULL)`);
    // Reservaciones (js/mesas-reservas.js). Fecha y hora en hora local del negocio.
    await query(`CREATE TABLE IF NOT EXISTS mesas_reservas (id VARCHAR(80) PRIMARY KEY,
      branch_id INTEGER NOT NULL, elemento_id VARCHAR(80) NOT NULL, cliente VARCHAR(120) NOT NULL,
      telefono VARCHAR(40) DEFAULT NULL, personas INTEGER NOT NULL DEFAULT 1, fecha VARCHAR(10) NOT NULL,
      hora VARCHAR(5) NOT NULL, nota VARCHAR(300) DEFAULT NULL, estado VARCHAR(20) NOT NULL DEFAULT 'activa',
      user_id INTEGER DEFAULT NULL, user_name VARCHAR(120) DEFAULT NULL,
      created_at VARCHAR(40) NOT NULL, updated_at VARCHAR(40) NOT NULL)`);
    await anticipos.ensure(addColumnIfMissing);
  }
  router.use(async (req, res, next) => {
    try {
      req.mesasActor = await resolveRequestActorUser(req, { required: true });
      if (!isGlobalAdministratorUser(req.mesasActor) && !isBranchAdministratorUser(req.mesasActor) && !userRoleHasPermission(req.mesasActor, 'ventas')) throw fail('No tienes permiso para operar ventas.', 403);
      if (!ready) ready = schema().catch((e) => { ready = null; throw e; });
      await ready;
      next();
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  };
  // Una cuenta sin productos no ocupa la mesa (entrar y salir sin pedir).
  // Si el consumo no se puede leer, se trata como ocupada.
  function tieneConsumo(draftJson) {
    try { return (JSON.parse(draftJson || '{}').items || []).some((i) => Number(i?.qty) > 0); } catch (_) { return true; }
  }
  function manager(req) {
    if (!isGlobalAdministratorUser(req.mesasActor) && !isBranchAdministratorUser(req.mesasActor)) {
      throw fail('Solo un administrador puede editar el plano.', 403);
    }
  }
  function branch(req) {
    const id = Number(getUserScopeBranchId(req.mesasActor) || getTerminalBranchId());
    if (!Number.isSafeInteger(id) || id <= 0) throw fail('Selecciona una sucursal para trabajar con el plano.');
    return id;
  }
  router.get('/estado', wrap(async (req, res) => {
    const config = await query('SELECT mesas_enabled FROM config WHERE id = 1');
    res.json({ activo: Boolean(Number(config[0]?.mesas_enabled)),
      puedeEditar: isGlobalAdministratorUser(req.mesasActor) || isBranchAdministratorUser(req.mesasActor),
      puedeConfigurar: isGlobalAdministratorUser(req.mesasActor) });
  }));
  router.put('/config', wrap(async (req, res) => {
    if (!isGlobalAdministratorUser(req.mesasActor)) throw fail('Solo el administrador general puede activar el módulo.', 403);
    if (typeof req.body.activo !== 'boolean') throw fail('Estado inválido.');
    await query('UPDATE config SET mesas_enabled = ? WHERE id = 1', [req.body.activo ? 1 : 0]);
    res.json({ activo: req.body.activo });
  }));
  router.get('/plano', wrap(async (req, res) => {
    const rows = await query('SELECT * FROM mesas_planos WHERE branch_id = ?', [branch(req)]);
    res.json(rows[0] ? { version: Number(rows[0].version), elementos: JSON.parse(rows[0].elementos_json) } : { version: 0, elementos: [] });
  }));
  router.put('/plano', wrap(async (req, res) => {
    manager(req);
    const branchId = branch(req);
    const version = req.body.version;
    if (!Number.isSafeInteger(version) || version < 0) throw fail('Versión inválida.');
    let elementos;
    await withTransaction(async (conn) => {
      // Serializa también apertura de cuentas y modificaciones del plano.
      await conn.query('UPDATE config SET mesas_enabled = mesas_enabled WHERE id = 1');
      const abiertas = await conn.query("SELECT id, elemento_id, estado, draft_json FROM mesas_cuentas WHERE branch_id = ? AND estado IN ('abierta', 'cobrando')", [branchId]);
      const activas = abiertas.filter((r) => r.estado !== 'abierta' || tieneConsumo(r.draft_json));
      // Una mesa con reserva pendiente tampoco se quita ni deja de vender.
      const reservadas = await conn.query("SELECT DISTINCT elemento_id FROM mesas_reservas WHERE branch_id = ? AND estado = 'activa' AND fecha >= ?", [branchId, reservas.fechaLocal()]);
      try { elementos = validarPlano(req.body.elementos, [...activas, ...reservadas].map((r) => r.elemento_id)); } catch (e) {
        throw fail(reservadas.length && /operaciones activas/.test(e.message) ? `${e.message} (también cuentan las mesas con reservas pendientes: cancélalas primero).` : e.message);
      }
      // Cuentas vacías de elementos que se quitaron o ya no venden: no quedan colgando.
      const vendibles = new Set(elementos.filter((e) => e.vendible).map((e) => e.id));
      for (const r of abiertas) {
        if (r.estado === 'abierta' && !tieneConsumo(r.draft_json) && !vendibles.has(r.elemento_id)) {
          await conn.query("DELETE FROM mesas_cuentas WHERE id = ? AND estado = 'abierta'", [r.id]);
        }
      }
      await conn.query('INSERT OR IGNORE INTO mesas_planos (branch_id, version, elementos_json, updated_at) VALUES (?, 0, ?, ?)', [branchId, '[]', new Date().toISOString()]);
      const result = await conn.query('UPDATE mesas_planos SET elementos_json = ?, version = version + 1, updated_at = ? WHERE branch_id = ? AND version = ?',
        [JSON.stringify(elementos), new Date().toISOString(), branchId, version]);
      if (Number(result.affectedRows ?? result.rowsAffected) !== 1) throw fail('Otra caja modificó el plano. Recarga antes de guardar.', 409);
    });
    await Promise.resolve(writeAuditLog({ userId: req.mesasActor.id, userName: req.mesasActor.nombre,
      userRole: req.mesasActor.rol, moduleName: 'Mesas', actionName: 'Guardar plano', detail: `Sucursal ${branchId}, versión ${version + 1}` })).catch(() => {});
    res.json({ version: version + 1, elementos });
  }));
  router.get('/cuentas', wrap(async (req, res) => {
    const rows = await query("SELECT * FROM mesas_cuentas WHERE branch_id = ? AND estado = 'abierta' ORDER BY updated_at", [branch(req)]);
    res.json(rows.map((r) => ({ ...r, version: Number(r.version), draft: JSON.parse(r.draft_json), draft_json: undefined })));
  }));
  router.post('/cuentas', wrap(async (req, res) => {
    const branchId = branch(req), id = String(req.body.id || '');
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw fail('Identificador inválido.');
    await withTransaction(async (conn) => {
      await conn.query('UPDATE config SET mesas_enabled = mesas_enabled WHERE id = 1');
      const existing = await conn.query('SELECT * FROM mesas_cuentas WHERE id = ?', [id]);
      if (existing.length) { if (Number(existing[0].branch_id) !== branchId) throw fail('Cuenta no disponible.', 403); return; }
      const rows = await conn.query('SELECT elementos_json FROM mesas_planos WHERE branch_id = ?', [branchId]);
      const elemento = JSON.parse(rows[0]?.elementos_json || '[]').find((e) => e.id === req.body.elementoId && e.vendible);
      if (!elemento) throw fail('El elemento no admite ventas.');
      await conn.query('INSERT INTO mesas_cuentas (id, branch_id, elemento_id, nombre, draft_json, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, branchId, elemento.id, String(req.body.nombre || 'General').slice(0, 100), JSON.stringify({ items: [], tableLabel: elemento.codigo, orderType: 'mesa' }), req.mesasActor.id, new Date().toISOString()]);
    });
    res.json({ id });
  }));
  router.put('/cuentas/:id', wrap(async (req, res) => {
    const draft = cuentas.validarDraft(req.body.draft);
    if (draft.meseroId) {
      const mesero = await query('SELECT id FROM mesas_meseros WHERE id = ? AND branch_id = ? AND activo = 1', [draft.meseroId, branch(req)]);
      if (!mesero.length) throw fail('El mesero no está disponible en esta sucursal.');
    }
    const result = await query("UPDATE mesas_cuentas SET draft_json = ?, version = version + 1, user_id = ?, updated_at = ? WHERE id = ? AND branch_id = ? AND version = ? AND estado = 'abierta'",
      [JSON.stringify(draft), req.mesasActor.id, new Date().toISOString(), req.params.id, branch(req), req.body.version]);
    if (Number(result.affectedRows ?? result.rowsAffected) !== 1) throw fail('La cuenta cambió en otra caja. Recarga antes de continuar.', 409);
    res.json({ version: Number(req.body.version) + 1 });
  }));
  // ── Reservaciones (reglas en js/mesas-reservas.js) ─────────────────────────
  const mapReserva = (r) => ({ id: r.id, elemento_id: r.elemento_id, cliente: r.cliente, telefono: r.telefono || '',
    personas: Number(r.personas), fecha: r.fecha, hora: r.hora, nota: r.nota || '', estado: r.estado,
    usuario: r.user_name || '', creada: r.created_at, anticipo: anticipos.deFila(r) });
  const auditarReserva = (req, accion, detalle) => Promise.resolve(writeAuditLog({ userId: req.mesasActor.id, userName: req.mesasActor.nombre,
    userRole: req.mesasActor.rol, moduleName: 'Mesas', actionName: accion, detail: detalle })).catch(() => {});
  const codigoDe = async (conn, branchId, elementoId) => {
    const planos = await conn.query('SELECT elementos_json FROM mesas_planos WHERE branch_id = ?', [branchId]);
    return JSON.parse(planos[0]?.elementos_json || '[]').find((e) => e.id === elementoId)?.codigo || 'Mesa';
  };
  // Movimiento de caja de un anticipo: reportes en segundo plano (como un ingreso de caja).
  const avisarMovimiento = (movimiento, structure, actor) => {
    if (!movimiento) return;
    try {
      sincronizarMovimientoCaja({ id: `res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, movement_type: movimiento.monto > 0 ? 'entrada' : 'salida',
        amount: Math.abs(movimiento.monto), notes: `${movimiento.tipo}: ${movimiento.notas}`, branch_id: structure.branchId,
        cash_register_id: structure.cashRegisterId, created_by_user_name: actor.nombre || 'Sistema', happened_at: new Date() });
    } catch (_) { /* los reportes nunca frenan la caja */ }
  };
  const textoAnticipo = (a) => `anticipo RD$ ${Number(a.monto).toFixed(2)} (${a.metodo}${a.consumible ? ', consumible' : ''})`;
  // Lo que la pantalla de Caja necesita para verlo al instante, como un ingreso
  // de caja: saldo de la caja, el movimiento y los anticipos del turno.
  async function estadoCaja(movimiento, structure, actor = {}) {
    try {
      const turno = structure ? await anticipos.turnoAbierto({ query }, structure.cashRegisterId) : null;
      return {
        config: getConfig ? await getConfig() : null,
        movimiento: movimiento ? { tipo: movimiento.tipo, monto: movimiento.monto, hora: movimiento.fecha, obs: movimiento.notas,
          usuarioId: actor.id ? Number(actor.id) : null, usuarioNombre: actor.nombre || 'Sistema' } : null,
        anticipos: turno ? await anticipos.totalesTurno(query, Number(turno.id)) : null,
      };
    } catch (_) { return null; } // la reserva ya quedó guardada; la pantalla se pone al día al recargar
  }
  router.get('/reservas', wrap(async (req, res) => {
    // De hoy en adelante (las activas y las de hoy ya resueltas, para el listado)
    // y las de días anteriores con un anticipo todavía sin resolver.
    const rows = await query("SELECT * FROM mesas_reservas WHERE branch_id = ? AND (fecha >= ? OR anticipo_estado = 'recibido') ORDER BY fecha, hora LIMIT 500",
      [branch(req), reservas.fechaLocal()]);
    res.json(rows.map(mapReserva));
  }));
  router.get('/reservas/:id', wrap(async (req, res) => {
    const rows = await query('SELECT * FROM mesas_reservas WHERE id = ? AND branch_id = ?', [String(req.params.id), branch(req)]);
    if (!rows.length) throw fail('Reserva no encontrada.', 404);
    res.json(mapReserva(rows[0]));
  }));
  async function guardarReserva(req, id = null) {
    const branchId = branch(req);
    const datos = reservas.validarReserva(req.body);
    // El anticipo se registra al crear la reserva (o después con su propio botón); no se edita.
    const anticipo = id ? null : reservas.validarAnticipo(req.body);
    const elementoId = String(req.body.elementoId || '');
    let guardada, movimiento = null, structure = null;
    if (anticipo) await prepararCaja();
    await withTransaction(async (conn) => {
      // Mismo candado que cuentas y plano: dos cajas no reservan la misma hora a la vez.
      await conn.query('UPDATE config SET mesas_enabled = mesas_enabled WHERE id = 1');
      const planos = await conn.query('SELECT elementos_json FROM mesas_planos WHERE branch_id = ?', [branchId]);
      const elemento = JSON.parse(planos[0]?.elementos_json || '[]').find((e) => e.id === elementoId && e.vendible);
      if (!elemento) throw fail('Esa mesa no existe o no admite ventas.');
      const mismas = await conn.query("SELECT * FROM mesas_reservas WHERE branch_id = ? AND elemento_id = ? AND fecha = ? AND estado = 'activa'", [branchId, elementoId, datos.fecha]);
      const choque = reservas.chocaCon(mismas, { elementoId, fecha: datos.fecha, hora: datos.hora, excluirId: id });
      if (choque) throw fail(`${elemento.codigo} ya está reservada a las ${choque.hora} para ${choque.cliente}. Deja al menos 2 horas entre reservas o elige otra mesa.`, 409);
      const ahora = new Date().toISOString();
      if (id) {
        const result = await conn.query(`UPDATE mesas_reservas SET elemento_id = ?, cliente = ?, telefono = ?, personas = ?, fecha = ?, hora = ?, nota = ?, updated_at = ?
          WHERE id = ? AND branch_id = ? AND estado = 'activa'`, [elementoId, datos.cliente, datos.telefono, datos.personas, datos.fecha, datos.hora, datos.nota, ahora, id, branchId]);
        if (Number(result.affectedRows ?? result.rowsAffected) !== 1) throw fail('Esa reserva ya no está activa.', 409);
      } else {
        id = cuentas.nuevoId();
        await conn.query(`INSERT INTO mesas_reservas (id, branch_id, elemento_id, cliente, telefono, personas, fecha, hora, nota, estado, user_id, user_name, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'activa', ?, ?, ?, ?)`,
        [id, branchId, elementoId, datos.cliente, datos.telefono, datos.personas, datos.fecha, datos.hora, datos.nota, req.mesasActor.id || null, String(req.mesasActor.nombre || '').slice(0, 120), ahora, ahora]);
        if (anticipo) {
          structure = await resolveCashStructure(req, conn);
          ({ movimiento } = await anticipos.recibir(conn, { reserva: { id, ...datos }, anticipo, structure, actor: req.mesasActor, mesa: elemento.codigo, fecha: nowSql() }));
        }
      }
      guardada = (await conn.query('SELECT * FROM mesas_reservas WHERE id = ?', [id]))[0];
      guardada.codigo = elemento.codigo;
    });
    if (movimiento) avisarMovimiento(movimiento, structure, req.mesasActor);
    return { guardada, movimiento, structure };
  }
  router.post('/reservas', wrap(async (req, res) => {
    const { guardada: r, movimiento, structure } = await guardarReserva(req);
    const a = anticipos.deFila(r);
    await auditarReserva(req, 'Reserva creada', `${r.codigo} · ${r.fecha} ${r.hora} · ${r.cliente} · ${r.personas} persona(s)${a ? ` · ${textoAnticipo(a)}` : ''}`);
    res.status(201).json({ ...mapReserva(r), ...(a ? { caja: await estadoCaja(movimiento, structure, req.mesasActor) } : {}) });
  }));
  // Anticipo dejado después de reservar (la reserva sigue activa y aún no tiene).
  router.post('/reservas/:id/anticipo', wrap(async (req, res) => {
    const branchId = branch(req);
    const anticipo = reservas.validarAnticipo(req.body);
    if (!anticipo) throw fail('Escribe el monto del anticipo.');
    await prepararCaja();
    let r, movimiento = null, structure = null;
    await withTransaction(async (conn) => {
      await conn.query('UPDATE config SET mesas_enabled = mesas_enabled WHERE id = 1');
      r = (await conn.query("SELECT * FROM mesas_reservas WHERE id = ? AND branch_id = ?", [String(req.params.id), branchId]))[0];
      if (!r) throw fail('Reserva no encontrada.', 404);
      if (r.estado !== 'activa') throw fail('Esa reserva ya está cerrada: no se le puede agregar un anticipo.', 409);
      if (r.anticipo_estado) throw fail('Esta reserva ya tiene un anticipo registrado.', 409);
      structure = await resolveCashStructure(req, conn);
      r.codigo = await codigoDe(conn, branchId, r.elemento_id);
      ({ movimiento } = await anticipos.recibir(conn, { reserva: r, anticipo, structure, actor: req.mesasActor, mesa: r.codigo, fecha: nowSql() }));
      r = { ...(await conn.query('SELECT * FROM mesas_reservas WHERE id = ?', [r.id]))[0], codigo: r.codigo };
    });
    avisarMovimiento(movimiento, structure, req.mesasActor);
    await auditarReserva(req, 'Anticipo de reserva recibido', `${r.codigo} · ${r.fecha} ${r.hora} · ${r.cliente} · ${textoAnticipo(anticipos.deFila(r))}`);
    res.status(201).json({ ...mapReserva(r), caja: await estadoCaja(movimiento, structure, req.mesasActor) });
  }));
  // Lo que queda del anticipo: devolverlo al cliente o dejarlo al negocio.
  router.patch('/reservas/:id/anticipo', wrap(async (req, res) => {
    const branchId = branch(req);
    const accion = String(req.body?.accion || '');
    const metodo = String(req.body?.metodo || 'efectivo');
    if (accion === 'devolver' && !isGlobalAdministratorUser(req.mesasActor) && !isBranchAdministratorUser(req.mesasActor) && !userCanReturnSales(req.mesasActor)) {
      throw fail('Devolver un anticipo requiere permiso de devoluciones. Pide a un supervisor o administrador.', 403);
    }
    await prepararCaja();
    let r, resultado, structure = null;
    await withTransaction(async (conn) => {
      await conn.query('UPDATE config SET mesas_enabled = mesas_enabled WHERE id = 1');
      r = (await conn.query('SELECT * FROM mesas_reservas WHERE id = ? AND branch_id = ?', [String(req.params.id), branchId]))[0];
      if (!r) throw fail('Reserva no encontrada.', 404);
      if (r.estado === 'activa') throw fail('Primero marca la reserva como atendida, no vino o cancelada.', 409);
      structure = await resolveCashStructure(req, conn);
      r.codigo = await codigoDe(conn, branchId, r.elemento_id);
      resultado = await anticipos.resolver(conn, { row: r, accion, metodo, structure, actor: req.mesasActor, mesa: r.codigo, fecha: nowSql() });
      r = { ...(await conn.query('SELECT * FROM mesas_reservas WHERE id = ?', [r.id]))[0], codigo: r.codigo };
    });
    avisarMovimiento(resultado.movimiento, structure, req.mesasActor);
    await auditarReserva(req, accion === 'devolver' ? 'Anticipo de reserva devuelto' : 'Anticipo de reserva quedó al negocio',
      `${r.codigo} · ${r.fecha} ${r.hora} · ${r.cliente} · RD$ ${resultado.saldo.toFixed(2)}${resultado.via ? ` (${resultado.via})` : ''}`);
    res.json({ ...mapReserva(r), caja: await estadoCaja(resultado.movimiento, structure, req.mesasActor) });
  }));
  router.put('/reservas/:id', wrap(async (req, res) => {
    const { guardada: r } = await guardarReserva(req, String(req.params.id));
    await auditarReserva(req, 'Reserva modificada', `${r.codigo} · ${r.fecha} ${r.hora} · ${r.cliente}`);
    res.json(mapReserva(r));
  }));
  // Cerrar una reserva: llegó (cumplida), no vino o se canceló. Solo desde activa.
  router.patch('/reservas/:id/estado', wrap(async (req, res) => {
    const estado = String(req.body?.estado || '');
    if (!['cumplida', 'no_vino', 'cancelada'].includes(estado)) throw fail('Estado de reserva inválido.');
    const branchId = branch(req);
    const result = await query("UPDATE mesas_reservas SET estado = ?, updated_at = ? WHERE id = ? AND branch_id = ? AND estado = 'activa'",
      [estado, new Date().toISOString(), String(req.params.id), branchId]);
    if (Number(result.affectedRows ?? result.rowsAffected) !== 1) {
      const existe = await query('SELECT estado FROM mesas_reservas WHERE id = ? AND branch_id = ?', [String(req.params.id), branchId]);
      throw fail(existe.length ? 'Esa reserva ya estaba cerrada.' : 'Reserva no encontrada.', existe.length ? 409 : 404);
    }
    const r = (await query('SELECT * FROM mesas_reservas WHERE id = ?', [String(req.params.id)]))[0];
    await auditarReserva(req, { cumplida: 'Reserva atendida', no_vino: 'Reserva: no vino', cancelada: 'Reserva cancelada' }[estado], `${r.fecha} ${r.hora} · ${r.cliente}`);
    res.json(mapReserva(r));
  }));

  // Salir de una mesa sin pedir nada: la cuenta vacía se borra para que la mesa
  // vuelva a estar disponible. Nunca borra una cuenta con productos, y si otra
  // caja la modificó (cambió la versión) no la toca.
  router.delete('/cuentas/:id', wrap(async (req, res) => {
    const branchId = branch(req);
    const version = Number(req.query.version);
    if (!Number.isSafeInteger(version) || version < 0) throw fail('Versión inválida.');
    const rows = await query("SELECT draft_json FROM mesas_cuentas WHERE id = ? AND branch_id = ? AND estado = 'abierta' AND version = ?", [req.params.id, branchId, version]);
    if (!rows.length || tieneConsumo(rows[0].draft_json)) return res.json({ eliminada: false });
    const result = await query("DELETE FROM mesas_cuentas WHERE id = ? AND branch_id = ? AND estado = 'abierta' AND version = ?", [req.params.id, branchId, version]);
    res.json({ eliminada: Number(result.affectedRows ?? result.rowsAffected) === 1 });
  }));
  router.get('/meseros', wrap(async (req, res) => {
    res.json(await query('SELECT * FROM mesas_meseros WHERE branch_id = ? ORDER BY nombre', [branch(req)]));
  }));
  router.post('/meseros', wrap(async (req, res) => {
    manager(req);
    const nombre = String(req.body.nombre || '').trim();
    if (!nombre || nombre.length > 100) throw fail('Nombre de mesero inválido.');
    const id = cuentas.nuevoId();
    await query('INSERT INTO mesas_meseros (id, branch_id, nombre, telefono) VALUES (?, ?, ?, ?)', [id, branch(req), nombre, String(req.body.telefono || '').slice(0, 40)]);
    res.status(201).json({ id, nombre });
  }));
  // Quitar (o volver a activar) un mesero: no se borra porque sus ventas lo nombran.
  router.patch('/meseros/:id', wrap(async (req, res) => {
    manager(req);
    if (typeof req.body.activo !== 'boolean') throw fail('Estado inválido.');
    const result = await query('UPDATE mesas_meseros SET activo = ? WHERE id = ? AND branch_id = ?', [req.body.activo ? 1 : 0, req.params.id, branch(req)]);
    if (Number(result.affectedRows ?? result.rowsAffected) !== 1) throw fail('Mesero no encontrado.', 404);
    res.json({ id: req.params.id, activo: req.body.activo });
  }));
  return router;
};

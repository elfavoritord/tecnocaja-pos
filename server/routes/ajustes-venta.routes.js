'use strict';
// Cancelación de facturas y notas de crédito (mejora 4). Reemplaza la
// "Devolución" suelta: la devolución de productos ahora es una nota de
// crédito, y cada acción depende del documento y de su estado fiscal real
// (ver server/services/ajustes-venta.js).
//   GET   /api/ventas/:invoice/ajustes          → acciones permitidas y por qué
//   GET   /api/ventas/ajustes/:id               → nota para imprimir / PDF
//   POST  /api/ventas/ajustes/:id/reintentar    → reintento de la E34 (mismo origen, sin duplicar)
//   POST  /api/sales/return                     → nota de crédito (productos o monto)
//   PATCH /api/sales/:invoice/cancel            → cancelar factura
// Todo el dinero se ajusta con movimientos trazables (caja, crédito del
// cliente); la factura original queda intacta.
const express = require('express');
const M = require('../../js/pos-money');
const ajustes = require('../services/ajustes-venta');

const n = (v) => M.number(v);
const c = (v) => M.cents(v === null || v === undefined || v === '' ? 0 : Number(v).toFixed(2));
const texto = (v, max) => String(v ?? '').trim().slice(0, max);
function httpError(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const fecha = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : String(v || ''));

function createAjustesVentaRouters(deps) {
  const {
    query, withTransaction, resolveRequestActorUser, getActor, writeAuditLog, userCanReturnSales, isGlobalAdministratorUser,
    userRoleHasPermission, assertActorCanAccessBranch, resolveScopedBusinessStructureSelection, isMysqlDeployment,
    ensureSchema, changeBranchInventoryStock, registerInventoryMovement, combosService, getNextNcfFromSequence,
    getEcfService, isInternetOffline, mapSaleRows, afterCancel, getConfig, nowSql,
  } = deps;
  const ventas = express.Router();
  const sales = express.Router();
  const lock = () => (isMysqlDeployment() ? ' FOR UPDATE' : '');
  const puedeCancelar = (u) => isGlobalAdministratorUser(u) || userRoleHasPermission(u, 'borrar_ventas');

  async function cargarVenta(run, invoiceNumber, { bloquear = false } = {}) {
    const [sale] = await run(
      `SELECT s.*, COALESCE(c.nombre, s.client_name_snapshot, 'Consumidor Final') AS client_name, COALESCE(u.nombre, u.usuario, 'Sistema') AS cashier_name
         FROM sales s LEFT JOIN clients c ON c.id = s.client_id LEFT JOIN users u ON u.id = COALESCE(s.billed_by_user_id, s.user_id)
        WHERE s.invoice_number = ? LIMIT 1${bloquear ? lock() : ''}`, [invoiceNumber]);
    if (!sale) throw httpError('Factura no encontrada.', 404);
    return sale;
  }
  async function previos(run, saleId) {
    const [r] = await run(
      `SELECT COALESCE(SUM(returned_amount), 0) AS total, COALESCE(SUM(tax_returned), 0) AS itbis, COALESCE(SUM(legal_tip_returned), 0) AS propina, COUNT(*) AS cantidad
         FROM sale_returns WHERE original_sale_id = ?`, [saleId]);
    return { total: Number(r?.total || 0), itbis: Number(r?.itbis || 0), propina: Number(r?.propina || 0), cantidad: Number(r?.cantidad || 0) };
  }
  async function devueltoPorLinea(run, saleId) {
    const rows = await run(
      `SELECT sri.sale_item_id, SUM(sri.qty_returned) AS total, SUM(CASE WHEN COALESCE(sri.restocked, 1) = 1 THEN sri.qty_returned ELSE 0 END) AS reintegrado
         FROM sale_return_items sri JOIN sale_returns sr ON sr.id = sri.return_id WHERE sr.original_sale_id = ? GROUP BY sri.sale_item_id`, [saleId]);
    const devuelto = {}, reintegrado = {};
    for (const r of rows) { devuelto[r.sale_item_id] = Number(r.total || 0); reintegrado[r.sale_item_id] = Number(r.reintegrado || 0); }
    return { devuelto, reintegrado };
  }
  async function lineasVenta(run, saleId) {
    return run(
      `SELECT si.*, COALESCE(si.item_name, p.nombre, 'Producto') AS product_name, p.codigo AS product_code, p.tracks_stock, p.precio_compra
         FROM sale_items si LEFT JOIN products p ON p.id = si.product_id WHERE si.sale_id = ? ORDER BY si.id`, [saleId]);
  }
  async function turnoAbierto(conn, cashRegisterId) {
    if (!cashRegisterId) return null;
    const [s] = await conn.query(`SELECT id FROM cash_sessions WHERE status = 'open' AND cash_register_id = ? ORDER BY id DESC LIMIT 1${lock()}`, [cashRegisterId]);
    return s || null;
  }
  // Devolver efectivo: un movimiento negativo en el turno abierto de esta caja.
  // Sin caja en la petición, sale de la caja donde se cobró la venta.
  async function salidaDeCaja(conn, { monto, tipo, notas, actor, structure, sale }) {
    const cashRegisterId = structure.cashRegisterId || Number(sale?.charged_cash_register_id || sale?.cash_register_id || 0) || null;
    const branchId = structure.branchId || Number(sale?.charged_branch_id || sale?.branch_id || 0) || null;
    const session = await turnoAbierto(conn, cashRegisterId);
    if (!session) throw httpError('Abre la caja para devolver el efectivo, o desmarca "Devolver efectivo de la caja".', 409);
    const ins = await conn.query(
      `INSERT INTO cash_movements (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at, branch_id, cash_register_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [session.id, tipo, -monto, texto(notas, 255), actor.userId || null, actor.userName || 'Sistema', nowSql(), branchId, cashRegisterId]);
    await conn.query('UPDATE cash_sessions SET current_amount = current_amount - ? WHERE id = ?', [monto, session.id]);
    await conn.query('UPDATE config SET cash_amount = cash_amount - ? WHERE id = 1', [monto]);
    return { movementId: Number(ins.insertId), sessionId: Number(session.id) };
  }
  // Nota de crédito: rebaja lo pendiente de esa factura (credit_adjustment) y
  // queda como abono en el estado de cuenta (credit_reduction). Cancelación:
  // la factura sale de la cartera por estar cancelada y el estado de cuenta la
  // muestra como "Cancelación de saldo"; solo se ajusta el saldo del cliente.
  async function rebajarCredito(conn, sale, monto, { returnId = null } = {}) {
    if (!(monto > 0) || !sale.client_id) return;
    if (returnId) {
      await conn.query('UPDATE sales SET credit_adjustment = COALESCE(credit_adjustment, 0) + ? WHERE id = ?', [monto, sale.id]);
      await conn.query('UPDATE sale_returns SET credit_reduction = ? WHERE id = ?', [monto, returnId]);
    }
    await conn.query(`UPDATE clients SET balance = CASE WHEN COALESCE(balance, 0) - ? < 0 THEN 0 ELSE COALESCE(balance, 0) - ? END WHERE id = ?`, [monto, monto, sale.client_id]);
  }
  async function reintegrar(conn, { sale, lineas, actor, structure, referencia, nota }) {
    const branchId = Number(sale.inventory_branch_id || sale.billed_branch_id || sale.branch_id || structure.branchId || 0);
    const productos = new Set();
    if (!branchId) return productos;
    for (const item of lineas) {
      const partes = item.comboSnapshot
        ? combosService.inventoryLinesForSaleItem({ combo_snapshot: item.comboSnapshot }, item.qty).filter((l) => l.tracksStock && l.qty > 0)
        : (item.productId && item.tracksStock ? [{ productId: item.productId, qty: item.qty, comboName: '' }] : []);
      for (const l of partes) {
        const stock = await changeBranchInventoryStock(conn, { productId: l.productId, branchId, quantityDelta: +l.qty, preventNegative: false });
        await registerInventoryMovement(conn, {
          productId: l.productId, branchId, cashRegisterId: structure.cashRegisterId || null, saleId: sale.id, tipo: 'devolucion', cantidad: l.qty,
          stockAnterior: stock.previousStock, stockNuevo: stock.nextStock, costoUnitario: Number(l.unitCost || stock.unitCost || 0),
          referenciaTipo: 'nota_credito', referenciaId: referencia,
          notas: `${nota} ${sale.invoice_number}${l.comboName ? ` (combo ${l.comboName})` : ''}`.slice(0, 255),
          usuarioId: actor.userId || null, usuarioNombre: actor.userName || 'Sistema',
        });
        productos.add(l.productId);
      }
    }
    return productos;
  }
  const numeroInterno = (id) => `NCI-${String(id).padStart(8, '0')}`;

  async function estadoNota(run, r) {
    if (r.adjustment_kind !== 'nota_credito_e34') return null;
    const origenes = r.return_type === 'cancelacion' ? [`sale:${r.original_sale_id}:anulacion`] : [`return:${r.id}`];
    const rows = await run(`SELECT id, encf, estado_dgii, track_id FROM ecf_documents WHERE origen IN (${origenes.map(() => '?').join(',')}) AND tipo_ecf = 'E34' ORDER BY id DESC LIMIT 1`, origenes).catch(() => []);
    return rows[0] ? { documentId: Number(rows[0].id), encf: rows[0].encf, estado: rows[0].estado_dgii } : { estado: 'no_emitida' };
  }

  // ── Acciones permitidas para una factura ───────────────────────────────
  ventas.get('/:invoiceNumber/ajustes', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    await ensureSchema();
    const sale = await cargarVenta(query, texto(req.params.invoiceNumber, 60));
    assertActorCanAccessBranch(actorUser, Number(sale.inventory_branch_id || sale.branch_id || 0), 'No puedes ver ventas de otra sucursal.');
    const clasificacion = await ajustes.clasificar(query, sale);
    const items = await lineasVenta(query, sale.id);
    const { devuelto } = await devueltoPorLinea(query, sale.id);
    const prev = await previos(query, sale.id);
    const historial = await query('SELECT * FROM sale_returns WHERE original_sale_id = ? ORDER BY id', [sale.id]);
    const comp = ajustes.componentes(sale);
    res.json({
      venta: {
        id: Number(sale.id), factura: sale.invoice_number, ncf: sale.ncf || '', tipoDocumento: sale.document_type, cliente: sale.client_name,
        clienteId: sale.client_id ? Number(sale.client_id) : null, cajero: sale.cashier_name, fecha: fecha(sale.created_at),
        total: Number(sale.total || 0), itbis: Number(sale.tax || 0), propinaLegal: Number(sale.legal_tip_amount || 0), metodo: sale.payment_method,
        estadoVenta: sale.sale_status, estadoFiscal: sale.fiscal_status,
        cobro: { efectivo: n(comp.cash), tarjeta: n(comp.card), transferencia: n(comp.transfer), credito: n(comp.credit) },
        yaAjustado: prev.total, restante: Math.max(0, n(c(sale.total) - c(prev.total))),
      },
      clasificacion,
      permisos: { cancelar: puedeCancelar(actorUser), notaCredito: userCanReturnSales(actorUser) },
      items: items.map((i) => ({ id: Number(i.id), productId: i.product_id ? Number(i.product_id) : null, nombre: i.product_name, codigo: i.product_code || '',
        cantidad: Number(i.qty || 0), precio: Number(i.price || 0), descuentoPct: Number(i.discount_rate || 0), itbisPct: Number(i.tax_rate || 0),
        devuelto: devuelto[i.id] || 0, disponible: Math.max(0, Number(i.qty || 0) - (devuelto[i.id] || 0)), controlaInventario: Number(i.tracks_stock ?? 1) !== 0,
        saleMode: i.sale_mode || 'unidad' })),
      historial: await Promise.all(historial.map(async (r) => ({ id: Number(r.id), fecha: fecha(r.returned_at), tipo: r.adjustment_kind || r.return_type,
        documento: r.fiscal_document || (r.adjustment_kind === 'nota_credito_interna' ? numeroInterno(r.id) : ''), total: Number(r.returned_amount || 0),
        motivo: r.return_reason || '', usuario: r.returned_by_user_name || '', estadoE34: await estadoNota(query, r) }))),
    });
  });

  // ── Nota de crédito para imprimir ──────────────────────────────────────
  ventas.get('/ajustes/:id', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    await ensureSchema();
    const [r] = await query('SELECT * FROM sale_returns WHERE id = ? LIMIT 1', [Number(req.params.id)]);
    if (!r) return res.status(404).json({ error: 'Nota no encontrada.' });
    const [sale] = await query(`SELECT s.*, COALESCE(c.nombre, s.client_name_snapshot, 'Consumidor Final') AS client_name, c.rnc AS client_rnc, c.cedula AS client_cedula
      FROM sales s LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = ?`, [r.original_sale_id]);
    assertActorCanAccessBranch(actorUser, Number(sale?.inventory_branch_id || sale?.branch_id || 0), 'No puedes ver ventas de otra sucursal.');
    const lineas = await query('SELECT * FROM sale_return_items WHERE return_id = ? ORDER BY id', [r.id]);
    const cfg = await getConfig({ syncRemote: false });
    const reparto = (() => { try { return JSON.parse(r.refund_breakdown || '{}'); } catch (_) { return {}; } })();
    res.json({
      id: Number(r.id), tipo: r.adjustment_kind || 'devolucion', documento: r.fiscal_document || numeroInterno(r.id), fecha: fecha(r.returned_at),
      negocio: { nombre: cfg.nombre || cfg.businessName || '', rnc: cfg.rnc || '', direccion: cfg.direccion || cfg.address || '', telefono: cfg.telefono || cfg.phone || '' },
      original: { factura: sale?.invoice_number || r.original_invoice_number, ncf: sale?.ncf || '', fecha: fecha(sale?.created_at), total: Number(sale?.total || 0) },
      cliente: { nombre: sale?.client_name || '', documento: sale?.client_rnc || sale?.client_cedula || sale?.client_tax_id_snapshot || '' },
      motivo: r.return_reason || '', usuario: r.returned_by_user_name || '', alcance: r.return_type,
      lineas: lineas.map((l) => ({ nombre: l.product_name, cantidad: Number(l.qty_returned || 0), precio: Number(l.price || 0), total: Number(l.line_total || 0), reintegrado: Number(l.restocked ?? 1) === 1 })),
      base: n(c(r.returned_amount) - c(r.tax_returned) - c(r.legal_tip_returned)), itbis: Number(r.tax_returned || 0), propinaLegal: Number(r.legal_tip_returned || 0),
      total: Number(r.returned_amount || 0), itbisAfecta: Number(r.tax_affects ?? 1) === 1, reembolso: reparto,
      estadoE34: await estadoNota(query, r),
    });
  });

  // Reintento controlado de la E34: el mismo origen reutiliza la reserva y no
  // firma ni envía otra vez lo que ya salió.
  ventas.post('/ajustes/:id/reintentar', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (!userCanReturnSales(actorUser) && !puedeCancelar(actorUser)) return res.status(403).json({ error: 'No tienes permiso para reintentar notas de crédito.' });
    await ensureSchema();
    const [r] = await query('SELECT * FROM sale_returns WHERE id = ? LIMIT 1', [Number(req.params.id)]);
    if (!r || r.adjustment_kind !== 'nota_credito_e34') return res.status(404).json({ error: 'Esa nota no es una E34.' });
    const actor = getActor(req);
    const resultado = await emitirE34({ returnRow: r, actor, items: r.return_type === 'cancelacion' ? null : await itemsE34DesdeNota(r) });
    res.json(resultado);
  });

  async function itemsE34DesdeNota(r) {
    const lineas = await query('SELECT * FROM sale_return_items WHERE return_id = ? ORDER BY id', [r.id]);
    if (!lineas.length) {
      const base = n(c(r.returned_amount) - c(r.tax_returned) - c(r.legal_tip_returned));
      const tasa = base > 0 ? Math.round((Number(r.tax_returned || 0) / base) * 100) : 0;
      return [{ name: (r.return_reason || 'Ajuste de monto').slice(0, 80), quantity: 1, unitPrice: base, discount: 0, taxRate: [0, 16, 18].includes(tasa) ? tasa : 18, legalTipAmount: Number(r.legal_tip_returned || 0) }];
    }
    return lineas.map((l) => ({ name: l.product_name || 'Producto', quantity: Number(l.qty_returned || 0), unitPrice: Number(l.price || 0),
      discount: Math.max(0, n(c(Number(l.price || 0) * Number(l.qty_returned || 0)) - c(l.net_amount ?? l.line_total))), taxRate: Number(l.tax_rate || 0), legalTipAmount: Number(l.legal_tip_amount || 0) }));
  }

  // Código de modificación de la DGII: 1 = anula todo el e-CF (solo si es la
  // primera nota y cubre la factura completa); 3 = corrige montos.
  async function codigoModificacion(returnRow) {
    if (returnRow.return_type === 'cancelacion') return '1';
    if (returnRow.return_type !== 'total') return '3';
    const [antes] = await query('SELECT COUNT(*) AS total FROM sale_returns WHERE original_sale_id = ? AND id < ?', [returnRow.original_sale_id, returnRow.id]);
    return Number(antes?.total || 0) === 0 ? '1' : '3';
  }

  async function emitirE34({ returnRow, actor, items }) {
    const ecf = getEcfService();
    const cancelacion = returnRow.return_type === 'cancelacion';
    const result = await ecf.emitSafely('emitNoteForSale', {
      saleId: Number(returnRow.original_sale_id), tipoEcf: 'E34', items,
      codigoModificacion: await codigoModificacion(returnRow),
      razon: returnRow.return_reason || 'Nota de crédito',
      origen: cancelacion ? `sale:${returnRow.original_sale_id}:anulacion` : `return:${returnRow.id}`,
      context: { userId: actor.userId || null, userName: actor.userName || null, internetOffline: isInternetOffline() },
    });
    if (result?.encf) await query('UPDATE sale_returns SET fiscal_document = ? WHERE id = ?', [result.encf, returnRow.id]);
    const estado = result?.skipped ? 'no_aplica' : (result?.ok === false ? 'error' : String(result?.estado || 'enviada'));
    await writeAuditLog({
      ...actor, moduleName: 'Facturación electrónica', actionName: 'Nota de crédito E34', documentType: 'E34', documentRef: result?.encf || `ajuste-${returnRow.id}`,
      amount: Number(returnRow.returned_amount || 0), result: result?.ok === false ? 'error' : (/rechaz/.test(estado) ? 'rechazado' : (/^aceptado/.test(estado) ? 'exito' : 'pendiente')),
      reason: returnRow.return_reason || null, after: { ajusteId: Number(returnRow.id), encf: result?.encf || null, estado, error: result?.error || null },
      detail: `${returnRow.original_invoice_number} · E34 ${result?.encf || 'sin emitir'} · ${estado}${result?.error ? ` · ${result.error}` : ''}`,
    }).catch(() => {});
    return { ok: result?.ok !== false && !result?.skipped, encf: result?.encf || null, estado, error: result?.error || null, skipped: Boolean(result?.skipped) };
  }

  // ── Nota de crédito (productos o ajuste de monto) ──────────────────────
  sales.post('/return', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    if (!userCanReturnSales(actorUser)) return res.status(403).json({ error: 'No tienes permiso para emitir notas de crédito.' });
    await ensureSchema();
    const actor = getActor(req);
    const b = req.body || {};
    const invoiceNumber = texto(b.invoiceNumber, 60);
    const reason = texto(b.reason, 255);
    const tipo = b.tipo === 'monto' ? 'monto' : 'productos';
    const requestId = texto(b.clientRequestId, 100) || null;
    if (!invoiceNumber) return res.status(400).json({ error: 'Número de factura requerido.' });
    if (!reason) return res.status(400).json({ error: 'Indica el motivo de la nota de crédito.' });
    if (tipo === 'productos' && !(Array.isArray(b.items) && b.items.length)) return res.status(400).json({ error: 'Selecciona al menos un producto.' });
    if (requestId && !/^[\w-]{16,100}$/.test(requestId)) return res.status(400).json({ error: 'Identificador de la nota no válido.' });
    let structure;
    try { structure = await resolveScopedBusinessStructureSelection(req, null, b.branchId, b.cashRegisterId); }
    catch (_e) { structure = { branchId: null, cashRegisterId: null, branch: { nombre: 'Principal' }, cashRegister: { nombre: 'Caja' } }; }

    const result = await withTransaction(async (conn) => {
      const run = (sql, p) => conn.query(sql, p);
      if (requestId) {
        const [ya] = await conn.query('SELECT * FROM sale_returns WHERE request_id = ? LIMIT 1', [requestId]);
        if (ya) return { repetida: true, returnRow: ya };
      }
      const sale = await cargarVenta(run, invoiceNumber, { bloquear: true });
      assertActorCanAccessBranch(actorUser, Number(sale.inventory_branch_id || sale.branch_id || 0), 'No puedes emitir notas de otra sucursal.');
      const clas = await ajustes.clasificar(run, sale);
      if (!clas.notaCredito.permitido) throw httpError(clas.notaCredito.razon, 409);
      const prev = await previos(run, sale.id);
      const restante = c(sale.total) - c(prev.total);
      if (restante <= 0n) throw httpError('Esta factura ya no tiene saldo para notas de crédito.', 409);

      let calc;
      if (tipo === 'monto') {
        const monto = c(b.monto);
        if (monto <= 0n) throw httpError('Indica el monto del ajuste.');
        if (monto > restante) throw httpError(`El ajuste supera lo que queda de la factura (${n(restante).toFixed(2)}).`, 409);
        const tasa = [0, 16, 18].includes(Number(b.itbisTasa)) ? Number(b.itbisTasa) : 0;
        const base = tasa ? M.divide(monto * 100n, BigInt(100 + tasa)) : monto;
        calc = { lineas: [], completa: monto === restante, neto: base, itbis: monto - base, propina: 0n, total: monto, tasa, concepto: texto(b.concepto, 120) || reason };
      } else {
        const originalItems = await lineasVenta(run, sale.id);
        const { devuelto } = await devueltoPorLinea(run, sale.id);
        calc = ajustes.calcularLineas({ sale, originalItems, devueltoMap: devuelto, itemsToReturn: b.items, previos: prev });
        if (calc.total > restante) calc.total = restante;
      }

      const kind = clas.notaCredito.tipo === 'B04' ? 'nota_credito_b04' : (clas.notaCredito.tipo === 'E34' ? 'nota_credito_e34' : 'nota_credito_interna');
      let documento = null;
      if (kind === 'nota_credito_b04') {
        const ncf = await getNextNcfFromSequence(conn, 'B04', structure.branchId || sale.branch_id);
        documento = ncf.ncf;
      }
      const refundCash = b.refundCash !== false;
      const reparto = ajustes.repartirReembolso(sale, calc.total, { refundCash });
      const returnType = calc.completa ? 'total' : 'parcial';
      const ins = await conn.query(
        `INSERT INTO sale_returns (original_sale_id, original_invoice_number, return_type, return_reason, returned_amount, returned_by_user_id, returned_by_user_name,
           branch_id, cash_register_id, returned_at, tax_returned, legal_tip_returned, adjustment_kind, fiscal_document, restock, request_id, refund_breakdown, tax_affects)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sale.id, sale.invoice_number, returnType, reason, n(calc.total), actor.userId || null, actor.userName || 'Sistema', structure.branchId, structure.cashRegisterId,
          nowSql(), n(calc.itbis), n(calc.propina), kind, documento, calc.lineas.some((l) => l.restock) ? 1 : 0, requestId, JSON.stringify(reparto), clas.masDe30Dias ? 0 : 1]);
      const returnId = Number(ins.insertId);
      for (const l of calc.lineas) {
        await conn.query(
          `INSERT INTO sale_return_items (return_id, sale_item_id, product_id, product_name, qty_returned, price, line_total, restocked, net_amount, tax_rate, tax_amount, legal_tip_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [returnId, l.saleItemId, l.productId, l.productName, l.qty, l.price, n(l.total), l.restock ? 1 : 0, n(l.neto), l.taxRate, n(l.itbis), n(l.propina)]);
      }
      const productos = await reintegrar(conn, { sale, lineas: calc.lineas.filter((l) => l.restock), actor, structure, referencia: documento || numeroInterno(returnId), nota: 'Nota de crédito' });

      let caja = null;
      if (reparto.efectivoDesdeCaja > 0) {
        caja = await salidaDeCaja(conn, { monto: reparto.efectivoDesdeCaja, tipo: 'Devolución', notas: `Nota de crédito ${documento || numeroInterno(returnId)} · ${sale.invoice_number} — ${reason}`, actor, structure, sale });
        await conn.query('UPDATE sale_returns SET cash_movement_id = ?, cash_session_id = ? WHERE id = ?', [caja.movementId, caja.sessionId, returnId]);
      } else {
        const abierto = await turnoAbierto(conn, structure.cashRegisterId);
        if (abierto) await conn.query('UPDATE sale_returns SET cash_session_id = ? WHERE id = ?', [abierto.id, returnId]);
      }
      await rebajarCredito(conn, sale, reparto.creditoRebajado, { returnId });
      if (calc.completa) {
        await conn.query(`UPDATE sales SET sale_status = 'devuelta', fiscal_status = 'cancelada', canceled_at = ?, canceled_by_user_id = ?, canceled_by_user_name = ?, cancel_reason = ?, cancel_refund_mode = 'devolucion' WHERE id = ?`,
          [nowSql(), actor.userId || null, actor.userName || 'Sistema', `Nota de crédito total — ${reason}`, sale.id]);
      }
      await writeAuditLog({
        ...actor, moduleName: 'Ventas', actionName: 'Nota de crédito', branchId: structure.branchId, cashRegisterId: structure.cashRegisterId,
        cashSessionId: caja?.sessionId || null, clientId: sale.client_id || null, documentType: kind, documentRef: documento || numeroInterno(returnId),
        amount: n(calc.total), reason,
        before: { factura: sale.invoice_number, total: Number(sale.total || 0), yaAjustado: prev.total },
        after: { ajusteId: returnId, alcance: returnType, tipo, base: n(calc.neto), itbis: n(calc.itbis), propina: n(calc.propina), reembolso: reparto,
          reintegrados: calc.lineas.filter((l) => l.restock).map((l) => ({ producto: l.productName, cantidad: l.qty })), itbisAfecta: !clas.masDe30Dias },
        detail: `${sale.invoice_number} · ${documento || numeroInterno(returnId)} · ${returnType} · ${n(calc.total).toFixed(2)} — ${reason}`,
      }, conn);
      const [returnRow] = await conn.query('SELECT * FROM sale_returns WHERE id = ?', [returnId]);
      return { repetida: false, returnRow, calc, reparto, clas, productos: [...productos], sale };
    });

    const r = result.returnRow;
    let ecfNota = null;
    if (!result.repetida && r.adjustment_kind === 'nota_credito_e34') {
      const items = result.calc.lineas.length
        ? result.calc.lineas.map((l) => ({ name: l.productName || 'Producto', quantity: l.qty, unitPrice: l.price,
          discount: Math.max(0, n(c(l.price * l.qty) - l.neto)), taxRate: l.taxRate, legalTipAmount: n(l.propina) }))
        : [{ name: result.calc.concepto.slice(0, 80), quantity: 1, unitPrice: n(result.calc.neto), discount: 0, taxRate: result.calc.tasa }];
      ecfNota = await emitirE34({ returnRow: r, actor, items });
    }
    if (!result.repetida && result.productos?.length) afterCancel?.({ productIds: result.productos, branchId: Number(result.sale.inventory_branch_id || result.sale.branch_id || 0) || null });
    const documento = ecfNota?.encf || r.fiscal_document || numeroInterno(r.id);
    res.status(result.repetida ? 200 : 201).json({
      ok: true, repetida: result.repetida, returnId: Number(r.id), documento, tipo: r.adjustment_kind, alcance: r.return_type,
      returnedAmount: Number(r.returned_amount || 0), itbis: Number(r.tax_returned || 0), propinaLegal: Number(r.legal_tip_returned || 0),
      reembolso: (() => { try { return JSON.parse(r.refund_breakdown || '{}'); } catch (_) { return {}; } })(),
      cashPortion: result.reparto?.efectivoDesdeCaja ?? null, creditBalancePortion: result.reparto?.creditoRebajado ?? null,
      itbisAfecta: Number(r.tax_affects ?? 1) === 1,
      message: `Nota de crédito ${documento}: RD$ ${Number(r.returned_amount || 0).toFixed(2)}.`,
      ecfNota,
    });
  });

  // ── Cancelar factura ───────────────────────────────────────────────────
  sales.patch('/:invoiceNumber/cancel', async (req, res) => {
    const actorUser = await resolveRequestActorUser(req, { required: true });
    if (!puedeCancelar(actorUser)) return res.status(403).json({ error: 'No tienes permiso para cancelar ventas históricas.' });
    await ensureSchema();
    const actor = getActor(req);
    const b = req.body || {};
    const invoiceNumber = texto(req.params.invoiceNumber, 60);
    const reason = texto(b.reason, 255);
    if (!reason) return res.status(400).json({ error: 'Indica el motivo de la cancelación.' });
    let structure;
    try { structure = await resolveScopedBusinessStructureSelection(req, null, b.branchId, b.cashRegisterId); }
    catch (_e) { structure = { branchId: null, cashRegisterId: null, branch: { nombre: 'Principal' }, cashRegister: { nombre: 'Caja' } }; }

    const result = await withTransaction(async (conn) => {
      const run = (sql, p) => conn.query(sql, p);
      const sale = await cargarVenta(run, invoiceNumber, { bloquear: true });
      assertActorCanAccessBranch(actorUser, Number(sale.inventory_branch_id || sale.billed_branch_id || sale.branch_id || 0), 'No puedes cancelar ventas de otra sucursal.');
      const clas = await ajustes.clasificar(run, sale);
      if (!clas.cancelar.permitido) throw httpError(clas.cancelar.razon, 409);
      const modo = clas.cancelar.modos.includes(b.modoFiscal) ? b.modoFiscal : clas.cancelar.modos[0];
      const prev = await previos(run, sale.id);
      // Anular con nota un comprobante que ya tiene notas parciales sumaría de
      // más: el resto se ajusta con otra nota de crédito.
      if (prev.cantidad > 0 && (modo === 'nota_credito_b04' || modo === 'nota_credito_e34' || modo === 'anulacion_608')) {
        throw httpError('Esta factura ya tiene notas de crédito. Emite otra nota de crédito por lo que queda en lugar de cancelarla.', 409);
      }
      const cobrada = ['pagada', 'devuelta'].includes(String(sale.sale_status || 'pagada'));
      const restante = c(sale.total) - c(prev.total);

      // Inventario: solo lo que no regresó ya con una nota anterior.
      const items = await lineasVenta(run, sale.id);
      const { reintegrado } = await devueltoPorLinea(run, sale.id);
      const inventarioDescontado = Boolean(sale.inventory_discounted_at) || String(sale.sale_status || '') === 'pagada';
      const pendientesInventario = inventarioDescontado ? items.map((i) => ({
        saleItemId: Number(i.id), productId: i.product_id ? Number(i.product_id) : null, productName: i.product_name, comboSnapshot: i.combo_snapshot || null,
        qty: Math.max(0, Number(i.qty || 0) - (reintegrado[i.id] || 0)), tracksStock: Number(i.tracks_stock ?? 1) !== 0,
      })).filter((i) => i.qty > 0) : [];
      const reintegrar_ = b.reintegrarInventario !== false;
      const productos = reintegrar_ ? await reintegrar(conn, { sale, lineas: pendientesInventario, actor, structure, referencia: invoiceNumber, nota: 'Reintegro por cancelación' }) : new Set();

      const reparto = cobrada && restante > 0n ? ajustes.repartirReembolso(sale, restante, { refundCash: b.refundCash !== false }) : null;
      let caja = null;
      if (reparto?.efectivoDesdeCaja > 0) {
        caja = await salidaDeCaja(conn, { monto: reparto.efectivoDesdeCaja, tipo: 'Cancelación', notas: `Cancelación ${invoiceNumber} — ${reason}`, actor, structure, sale });
      }
      if (reparto) await rebajarCredito(conn, sale, reparto.creditoRebajado);
      const refundMode = !cobrada ? 'sin_cobro' : (caja ? 'efectivo' : 'sin_reembolso');
      await conn.query(
        `UPDATE sales SET fiscal_status = 'cancelada', canceled_at = ?, canceled_by_user_id = ?, canceled_by_user_name = ?, cancel_reason = ?,
           cancel_refund_mode = ?, cancel_cash_movement_id = ? WHERE id = ?`,
        [nowSql(), actor.userId || null, actor.userName || 'Sistema', `${reason}${modo === 'anulacion_608' ? ' (NCF anulado, formato 608)' : ''}`, refundMode, caja?.movementId || null, sale.id]);

      // Las anulaciones con nota de crédito quedan como ajuste propio (B04 o E34).
      let notaId = null, documento = null;
      if (cobrada && restante > 0n && (modo === 'nota_credito_b04' || modo === 'nota_credito_e34')) {
        if (modo === 'nota_credito_b04') documento = (await getNextNcfFromSequence(conn, 'B04', structure.branchId || sale.branch_id)).ncf;
        const itbisRest = c(sale.tax) - c(prev.itbis), propinaRest = c(sale.legal_tip_amount) - c(prev.propina);
        const ins = await conn.query(
          `INSERT INTO sale_returns (original_sale_id, original_invoice_number, return_type, return_reason, returned_amount, returned_by_user_id, returned_by_user_name,
             branch_id, cash_register_id, returned_at, tax_returned, legal_tip_returned, adjustment_kind, fiscal_document, restock, refund_breakdown, tax_affects, cash_movement_id, cash_session_id)
           VALUES (?, ?, 'cancelacion', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [sale.id, sale.invoice_number, reason, n(restante), actor.userId || null, actor.userName || 'Sistema', structure.branchId, structure.cashRegisterId, nowSql(),
            n(itbisRest > 0n ? itbisRest : 0n), n(propinaRest > 0n ? propinaRest : 0n), modo, documento, reintegrar_ ? 1 : 0, JSON.stringify(reparto),
            clas.masDe30Dias ? 0 : 1, caja?.movementId || null, caja?.sessionId || null]);
        notaId = Number(ins.insertId);
      }
      const releasedOnlineOrderId = sale.online_order_id && deps.onSaleCancelledInTx ? await deps.onSaleCancelledInTx(conn, sale, actorUser) : null;
      await writeAuditLog({
        ...actor, moduleName: 'Ventas', actionName: 'Factura cancelada', branchId: structure.branchId, cashRegisterId: structure.cashRegisterId,
        cashSessionId: caja?.sessionId || null, clientId: sale.client_id || null, documentType: sale.document_type, documentRef: sale.ncf || invoiceNumber,
        amount: Number(sale.total || 0), reason,
        before: { estadoFiscal: sale.fiscal_status, estadoVenta: sale.sale_status, total: Number(sale.total || 0) },
        after: { estadoFiscal: 'cancelada', modo, reembolso: reparto, modoReembolso: refundMode, notaCredito: documento, inventarioReintegrado: [...productos].length },
        detail: `${invoiceNumber} · ${modo} · ${reason}`,
      }, conn);
      const rows = await conn.query('SELECT s.*, u.nombre AS cashier_name, COALESCE(c.nombre, "Consumidor Final") AS client_name, COALESCE(c.telefono, "") AS client_phone FROM sales s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = ?', [sale.id]);
      const its = await conn.query(`SELECT si.*, COALESCE(si.item_name, p.nombre, 'Producto') AS product_name, p.codigo AS product_code FROM sale_items si LEFT JOIN products p ON p.id = si.product_id WHERE sale_id = ?`, [sale.id]);
      return { sale: mapSaleRows(rows, its)[0], saleRow: sale, notaId, modo, reparto, refundMode, productos: [...productos], releasedOnlineOrderId };
    });

    let ecfNota = null;
    if (result.modo === 'nota_credito_e34' && result.notaId) {
      const [r] = await query('SELECT * FROM sale_returns WHERE id = ?', [result.notaId]);
      ecfNota = await emitirE34({ returnRow: r, actor, items: null });
    }
    afterCancel?.({ invoiceNumber, reason, productIds: result.productos, branchId: Number(result.saleRow.inventory_branch_id || result.saleRow.branch_id || 0) || null, releasedOnlineOrderId: result.releasedOnlineOrderId });
    res.json({ sale: result.sale, config: await getConfig(), modo: result.modo, reembolso: result.reparto, modoReembolso: result.refundMode, notaId: result.notaId, ecfNota });
  });

  return { ventas, sales, ensureSchema };
}

module.exports = { createAjustesVentaRouters };

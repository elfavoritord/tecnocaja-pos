'use strict';

/**
 * facturacion.routes.js — Facturación de servicios.
 * Factura desde: directa · cotización · (M2) orden/proyecto.
 * Comprobante: NCF tradicional (consume ncf_authorized_sequences) o e-CF
 * (numera desde config, queda ecf_status='pendiente' para firmar/enviar luego).
 *
 *  GET    /api/servicios/facturas?estado=&clientId=&branchId=&desde=&hasta=
 *  POST   /api/servicios/facturas
 *  POST   /api/servicios/facturas/desde-cotizacion/:id
 *  GET    /api/servicios/facturas/:id
 *  GET    /api/servicios/facturas/:id/documento?formato=a4|80mm|58mm
 *  POST   /api/servicios/facturas/:id/email      { to?, pdfBase64, subject?, mensaje? }
 *  POST   /api/servicios/facturas/:id/anular     { motivo }
 */

const express = require('express');
const {
  httpError, roleCodeOf, actorName, computeTotals, makeServiceGuard, resolveBranch,
} = require('./_common');
const { renderInvoiceDoc, renderEmailBody } = require('./renderDoc');
const { sendInvoiceEmail } = require('./mailer');

function mapInvoice(row, items = [], payments = []) {
  return {
    id: row.id,
    numero: row.numero,
    quotationId: row.quotation_id || null,
    originType: row.origin_type || 'directa',
    originId: row.origin_id || null,
    clientId: row.client_id || null,
    clientName: row.client_name || '',
    clientRnc: row.client_rnc || '',
    branchId: row.branch_id || null,
    sucursal: row.branch_name || '',
    fecha: row.fecha,
    vencimiento: row.vencimiento || null,
    condicionPago: row.condicion_pago || 'contado',
    fiscalMode: row.fiscal_mode || 'ncf',
    ncf: row.ncf || '',
    ncfTipo: row.ncf_tipo || '',
    ncfVencimiento: row.ncf_vencimiento || null,
    ecfStatus: row.ecf_status || null,
    subtotal: Number(row.subtotal || 0),
    descuento: Number(row.descuento || 0),
    itbis: Number(row.itbis || 0),
    total: Number(row.total || 0),
    pagado: Number(row.pagado || 0),
    balance: Number(row.balance || 0),
    estado: row.estado,
    notas: row.notas || '',
    creadoPor: row.created_by_user_name || '',
    createdAt: row.created_at,
    anuladaAt: row.anulada_at || null,
    motivoAnulacion: row.motivo_anulacion || '',
    items: items.map((it) => ({
      id: it.id,
      serviceId: it.service_id || null,
      descripcion: it.descripcion,
      cantidad: Number(it.cantidad || 0),
      precio: Number(it.precio || 0),
      descuentoPct: Number(it.descuento_pct || 0),
      itbisPct: Number(it.itbis_pct || 0),
      total: Number(it.total || 0),
    })),
    pagos: payments.map((p) => ({
      id: p.id,
      fecha: p.fecha,
      monto: Number(p.monto || 0),
      metodo: p.metodo,
      referencia: p.referencia || '',
      anuladoAt: p.anulado_at || null,
    })),
  };
}

// Mapea el comprobante fiscal de servicios al document_type que usa el POS.
function saleDocType({ fiscalMode, ncfTipo }) {
  if (fiscalMode === 'ecf') return 'factura-electronica';
  if (fiscalMode === 'ncf' && ncfTipo) return String(ncfTipo).toUpperCase();
  return 'ticket';
}

// Inserta la factura de servicios como una venta en `sales` + `sale_items`
// (ítems tipo "venta rápida", sin producto). Devuelve el sale_id.
async function mirrorInvoiceToSales(conn, { numero, ncf, fiscalMode, ncfTipo, actor, branchId, cashRegisterId, p, cobrarAhora, metodoPago }) {
  const total = Number(p.totals.total || 0);
  const recibido = cobrarAhora ? total : 0;
  const metodo = cobrarAhora ? metodoPago : (p.condicionPago === 'credito' ? 'credito' : metodoPago);
  const docType = saleDocType({ fiscalMode, ncfTipo });
  const ins = await conn.query(
    `INSERT INTO sales
      (invoice_number, user_id, client_id, branch_id, cash_register_id,
       billed_branch_id, billed_by_user_id, charged_branch_id, charged_by_user_id, charged_at,
       document_type, sale_status, sale_mode, client_name_snapshot, client_tax_id_snapshot,
       payment_method, subtotal, discount, tax, total, received_amount, change_amount,
       fiscal_status, order_type, kitchen_status, operative_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${cobrarAhora ? "datetime('now')" : 'NULL'},
       ?, 'pagada', 'directa', ?, ?, ?, ?, ?, ?, ?, ?, 0,
       'emitida', 'mostrador', 'entregada', ?, datetime('now'))`,
    [numero, actor.id, p.clientId || null, branchId || null, cashRegisterId || null,
     branchId || null, actor.id, cobrarAhora ? (branchId || null) : null, cobrarAhora ? actor.id : null,
     docType, p.clientName || null, p.clientRnc || null,
     metodo, p.totals.subtotal, p.totals.descuento, p.totals.itbis, total, recibido,
     p.fecha || null]
  );
  const saleId = ins.insertId;
  if (ncf) {
    await conn.query('UPDATE sales SET ncf = ?, ncf_type = ? WHERE id = ?', [ncf, ncfTipo || null, saleId]).catch(() => {});
  }
  for (const it of p.totals.items) {
    const lineTotal = Number(it.total || 0);
    const taxAmt = Number((Number(it.cantidad || 0) * Number(it.precio || 0) * (1 - Number(it.descuentoPct || 0) / 100) * (Number(it.itbisPct || 0) / 100)).toFixed(2));
    await conn.query(
      `INSERT INTO sale_items (sale_id, product_id, item_name, is_quick_sale, qty, price, discount_rate, tax_rate, tax_mode, tax_amount, sale_mode, line_total)
       VALUES (?, NULL, ?, 1, ?, ?, ?, ?, 'porcentaje', ?, 'unidad', ?)`,
      [saleId, it.descripcion, it.cantidad, it.precio, it.descuentoPct || 0, it.itbisPct || 0, taxAmt, lineTotal]
    );
  }
  return saleId;
}

// Backfill: espeja en `sales` las facturas de servicios emitidas ANTES de que
// existiera el espejo (sale_id IS NULL). Se corre una vez al arrancar.
async function backfillInvoiceMirror(query, withTransaction) {
  let pend;
  try {
    pend = await query(
      `SELECT * FROM svc_invoices WHERE sale_id IS NULL AND estado <> 'anulada' ORDER BY id LIMIT 300`
    );
  } catch (_) { return 0; }
  if (!pend || !pend.length) return 0;
  const [u] = await query("SELECT id FROM users ORDER BY id LIMIT 1").catch(() => []);
  const fallbackUserId = u?.id || null;
  let done = 0;
  for (const inv of pend) {
    try {
      const [items, [{ pagado = 0 } = {}]] = await Promise.all([
        query('SELECT * FROM svc_invoice_items WHERE invoice_id = ? ORDER BY id', [inv.id]),
        query('SELECT COALESCE(SUM(monto),0) AS pagado FROM svc_invoice_payments WHERE invoice_id = ? AND anulado_at IS NULL', [inv.id]),
      ]);
      const [firstPay] = await query('SELECT metodo FROM svc_invoice_payments WHERE invoice_id = ? AND anulado_at IS NULL ORDER BY id LIMIT 1', [inv.id]).catch(() => []);
      const total = Number(inv.total || 0);
      const paid = Number(pagado || 0);
      const cobrado = paid >= total - 0.009;
      const p = {
        clientId: inv.client_id || null, clientName: inv.client_name || null, clientRnc: inv.client_rnc || null,
        fecha: inv.fecha, condicionPago: inv.condicion_pago || 'contado',
        totals: {
          subtotal: Number(inv.subtotal || 0), descuento: Number(inv.descuento || 0),
          itbis: Number(inv.itbis || 0), total,
          items: items.map((it) => ({
            descripcion: it.descripcion, cantidad: Number(it.cantidad || 0), precio: Number(it.precio || 0),
            descuentoPct: Number(it.descuento_pct || 0), itbisPct: Number(it.itbis_pct || 0), total: Number(it.total || 0),
          })),
        },
      };
      await withTransaction(async (conn) => {
        const saleId = await mirrorInvoiceToSales(conn, {
          numero: inv.numero, ncf: inv.ncf, fiscalMode: inv.fiscal_mode, ncfTipo: inv.ncf_tipo,
          actor: { id: inv.created_by_user_id || fallbackUserId }, branchId: inv.branch_id, cashRegisterId: inv.cash_register_id,
          p, cobrarAhora: cobrado, metodoPago: firstPay?.metodo || 'efectivo',
        });
        await conn.query('UPDATE svc_invoices SET sale_id = ? WHERE id = ?', [saleId, inv.id]);
        if (!cobrado && paid > 0) await conn.query('UPDATE sales SET received_amount = ? WHERE id = ?', [paid, saleId]);
      });
      done += 1;
    } catch (e) {
      console.warn(`[servicios] backfill factura #${inv.id} falló:`, e.message);
    }
  }
  if (done) console.log(`[servicios] backfill: ${done} factura(s) espejadas en sales.`);
  return done;
}

// Recalcula pagado/balance/estado de una factura tras pagos. Reutilizado por cobros.
async function recalcInvoice(query, invoiceId) {
  const [inv] = await query('SELECT total, estado, sale_id FROM svc_invoices WHERE id = ?', [invoiceId]);
  if (!inv || inv.estado === 'anulada') return;
  const [{ pagado = 0 } = {}] = await query(
    'SELECT COALESCE(SUM(monto), 0) AS pagado FROM svc_invoice_payments WHERE invoice_id = ? AND anulado_at IS NULL',
    [invoiceId]
  );
  const total = Number(inv.total || 0);
  const paid = Number(pagado || 0);
  const balance = Number((total - paid).toFixed(2));
  const estado = paid <= 0 ? 'pendiente' : (balance <= 0.009 ? 'pagada' : 'parcial');
  await query(
    `UPDATE svc_invoices SET pagado = ?, balance = ?, estado = ?, updated_at = datetime('now') WHERE id = ?`,
    [paid, balance < 0 ? 0 : balance, estado, invoiceId]
  );
  // Mantener el espejo en `sales` al día (lo que ya se cobró).
  if (inv.sale_id) {
    await query('UPDATE sales SET received_amount = ? WHERE id = ?', [paid, inv.sale_id]).catch(() => {});
  }
}

function createFacturacionRouter(deps) {
  const {
    query, withTransaction, writeAuditLog, ensureSchema, nextServiceDocNumber,
    getNextNcfFromSequence, getConfig, isGlobalAdministratorUser, getUserScopeBranchId,
  } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();

  router.use(guard.requireService());
  router.use(async (_req, _res, next) => {
    try { await ensureSchema(query); next(); } catch (e) { next(e); }
  });

  async function fetchFull(id) {
    const [row] = await query(
      `SELECT i.*, b.nombre AS branch_name, c.email AS client_email FROM svc_invoices i
       LEFT JOIN branches b ON b.id = i.branch_id
       LEFT JOIN clients c ON c.id = i.client_id
       WHERE i.id = ?`, [id]
    );
    if (!row) return null;
    const [items, payments] = await Promise.all([
      query('SELECT * FROM svc_invoice_items WHERE invoice_id = ? ORDER BY id', [id]),
      query('SELECT * FROM svc_invoice_payments WHERE invoice_id = ? ORDER BY id', [id]),
    ]);
    return { ...mapInvoice(row, items, payments), clientEmail: row.client_email || '' };
  }

  // Ensambla el payload para renderInvoiceDoc (empresa + factura con datos de
  // contacto del cliente). Reusado por /documento y /email.
  async function buildDocPayload(full, cfg) {
    let contact = {};
    if (full.clientId) {
      const [c] = await query('SELECT email, telefono, direccion FROM clients WHERE id = ? LIMIT 1', [full.clientId]);
      if (c) contact = { clientEmail: c.email || '', clientTel: c.telefono || '', clientDir: c.direccion || '' };
    }
    let correo = '';
    try {
      const [mc] = await query('SELECT service_mail_from, service_mail_user FROM config WHERE id = 1 LIMIT 1');
      correo = (mc && (mc.service_mail_user || '')) || '';
    } catch (_) { /* columnas aún no migradas */ }
    return {
      empresa: {
        nombre: cfg.nombre || 'Tecno Caja', rnc: cfg.rnc || '', direccion: cfg.direccion || '',
        telefono: cfg.telefono || '', correo, logo: cfg.logo || '',
      },
      invoice: { ...full, ...contact, docType: 'factura' },
      items: full.items,
    };
  }

  // Consume el comprobante fiscal según el modo. Corre dentro de la transacción.
  async function assignFiscal(conn, { fiscalMode, ncfTipo, branchId }) {
    const mode = ['ncf', 'ecf', 'consumidor'].includes(fiscalMode) ? fiscalMode : 'ncf';
    if (mode === 'consumidor') return { fiscal_mode: 'consumidor', ncf: null, ncf_tipo: null, ncf_vencimiento: null, ecf_status: null };
    if (mode === 'ecf') {
      const rows = await conn.query('SELECT e_invoice_prefix, e_invoice_next_number FROM config WHERE id = 1 LIMIT 1');
      const c = rows[0] || { e_invoice_prefix: 'E31', e_invoice_next_number: 1 };
      const n = Number(c.e_invoice_next_number || 1);
      const numero = `${String(c.e_invoice_prefix || 'E31').replace(/-+$/,'')}${String(n).padStart(10, '0')}`;
      await conn.query('UPDATE config SET e_invoice_next_number = ? WHERE id = 1', [n + 1]);
      return { fiscal_mode: 'ecf', ncf: numero, ncf_tipo: ncfTipo || 'E31', ncf_vencimiento: null, ecf_status: 'pendiente' };
    }
    // NCF tradicional
    const tipo = String(ncfTipo || 'B02').toUpperCase();
    if (typeof getNextNcfFromSequence !== 'function') throw httpError('El motor de secuencias NCF no está disponible.', 500);
    let ncfResult;
    try {
      ncfResult = await getNextNcfFromSequence(conn, tipo, branchId || null);
    } catch (e) {
      throw httpError(`No se pudo asignar NCF ${tipo}: ${e.message}. Configura las secuencias en Configuración → Secuencias NCF.`, 409);
    }
    return { fiscal_mode: 'ncf', ncf: ncfResult.ncf, ncf_tipo: tipo, ncf_vencimiento: ncfResult.fechaVencimiento || null, ecf_status: null };
  }

  function readInvoiceBody(body, fallbackFiscalMode) {
    const totals = computeTotals(body?.items);
    if (!totals.items.length) throw httpError('Agrega al menos un servicio a la factura.');
    if (totals.items.some((i) => !i.descripcion)) throw httpError('Cada línea necesita una descripción.');
    const fecha = String(body?.fecha || '').trim() || new Date().toISOString().slice(0, 10);
    return {
      fecha,
      vencimiento: String(body?.vencimiento || '').trim() || null,
      condicionPago: String(body?.condicionPago || 'contado').trim().toLowerCase(),
      clientId: body?.clientId ? Number(body.clientId) : null,
      clientName: String(body?.clientName || '').trim() || null,
      clientRnc: String(body?.clientRnc || '').trim() || null,
      fiscalMode: String(body?.fiscalMode || fallbackFiscalMode || 'ncf').toLowerCase(),
      ncfTipo: String(body?.ncfTipo || '').toUpperCase() || null,
      notas: String(body?.notas || '').trim() || null,
      totals,
    };
  }

  async function createInvoice({ actor, body, origin }) {
    const cfg = await getConfig().catch(() => ({}));
    const fallbackFiscal = cfg.serviceFiscalMode || 'ncf';
    const p = readInvoiceBody(body, fallbackFiscal);
    // Si viene de un cliente registrado, usar sus datos fiscales guardados.
    if (p.clientId) {
      const [cli] = await query('SELECT nombre, cedula, email FROM clients WHERE id = ? LIMIT 1', [p.clientId]);
      if (cli) {
        p.clientName = cli.nombre || p.clientName;
        p.clientRnc = String(cli.cedula || '').trim() || p.clientRnc;
      } else {
        p.clientId = null;
      }
    }
    const branchId = resolveBranch(actor, body?.branchId, deps) || (body?.branchId ? Number(body.branchId) : null);
    const cashRegisterId = body?.cashRegisterId ? Number(body.cashRegisterId) : null;
    // Cobro inmediato si es contado (registra el pago con el método elegido).
    const METODOS_PAGO = ['efectivo', 'transferencia', 'tarjeta', 'deposito', 'cheque', 'otro'];
    const metodoPago = METODOS_PAGO.includes(String(body?.metodoPago)) ? String(body.metodoPago) : 'efectivo';
    const cobrarAhora = p.condicionPago === 'contado' && body?.pagoInmediato !== false;

    const saved = await withTransaction(async (conn) => {
      const numero = await nextServiceDocNumber(conn, 'invoice');
      const fiscal = await assignFiscal(conn, { fiscalMode: p.fiscalMode, ncfTipo: p.ncfTipo, branchId });
      // Vencimiento del pago = el del comprobante (NCF válido hasta), salvo que
      // el usuario indique uno distinto explícitamente.
      if (!p.vencimiento && fiscal.ncf_vencimiento) p.vencimiento = fiscal.ncf_vencimiento;
      const r = await conn.query(
        `INSERT INTO svc_invoices
          (numero, quotation_id, origin_type, origin_id, client_id, client_name, client_rnc, branch_id, cash_register_id,
           fecha, vencimiento, condicion_pago, fiscal_mode, ncf, ncf_tipo, ncf_vencimiento, ecf_status,
           subtotal, descuento, itbis, total, pagado, balance, estado, notas, created_by_user_id, created_by_user_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'pendiente', ?, ?, ?)`,
        [numero, origin?.quotationId || null, origin?.type || 'directa', origin?.id || null,
         p.clientId, p.clientName, p.clientRnc, branchId, cashRegisterId,
         p.fecha, p.vencimiento, p.condicionPago, fiscal.fiscal_mode, fiscal.ncf, fiscal.ncf_tipo, fiscal.ncf_vencimiento, fiscal.ecf_status,
         p.totals.subtotal, p.totals.descuento, p.totals.itbis, p.totals.total, p.totals.total,
         p.notas, actor.id, actorName(actor)]
      );
      const invoiceId = r.insertId;
      for (const it of p.totals.items) {
        await conn.query(
          `INSERT INTO svc_invoice_items (invoice_id, service_id, descripcion, cantidad, precio, descuento_pct, itbis_pct, total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [invoiceId, it.serviceId, it.descripcion, it.cantidad, it.precio, it.descuentoPct, it.itbisPct, it.total]
        );
      }
      if (origin?.quotationId) {
        await conn.query(
          `UPDATE svc_quotations SET estado = 'convertida', converted_invoice_id = ?, updated_at = datetime('now') WHERE id = ?`,
          [invoiceId, origin.quotationId]
        );
      }
      if (cobrarAhora) {
        await conn.query(
          `INSERT INTO svc_invoice_payments
            (invoice_id, fecha, monto, metodo, is_anticipo, branch_id, cash_register_id, created_by_user_id, created_by_user_name)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
          [invoiceId, p.fecha, p.totals.total, metodoPago, branchId, cashRegisterId, actor.id, actorName(actor)]
        );
        await conn.query(
          `UPDATE svc_invoices SET pagado = ?, balance = 0, estado = 'pagada', updated_at = datetime('now') WHERE id = ?`,
          [p.totals.total, invoiceId]
        );
      }

      // ── Espejo en `sales` (para Reportes/Dashboard del POS) ──────────────
      // La factura de servicios se registra también como una venta normal con
      // ítems de "venta rápida" (sin producto). Cualquier fallo aquí NO debe
      // tumbar la emisión de la factura.
      try {
        const saleId = await mirrorInvoiceToSales(conn, {
          numero, ncf: fiscal.ncf, fiscalMode: fiscal.fiscal_mode, ncfTipo: fiscal.ncf_tipo,
          actor, branchId, cashRegisterId, p, cobrarAhora, metodoPago,
        });
        if (saleId) await conn.query('UPDATE svc_invoices SET sale_id = ? WHERE id = ?', [saleId, invoiceId]);
      } catch (mirrorErr) {
        console.warn('[servicios] espejo en sales falló:', mirrorErr.message);
      }

      return { invoiceId, numero, ncf: fiscal.ncf };
    });

    await writeAuditLog({
      userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
      moduleName: 'Facturación', actionName: 'Factura de servicios emitida',
      detail: `${saved.numero}${saved.ncf ? ' · ' + saved.ncf : ''} · RD$ ${p.totals.total.toFixed(2)}${cobrarAhora ? ' · pagada (' + metodoPago + ')' : ''}`,
      branchId, clientId: p.clientId, documentType: 'factura', documentRef: saved.numero,
      amount: p.totals.total, paymentMethod: cobrarAhora ? metodoPago : null,
    });
    return fetchFull(saved.invoiceId);
  }

  // ── Buscar la factura de servicios por su número o NCF (para reimpresión) ─
  router.get('/por-numero/:numero', async (req, res) => {
    try {
      const n = String(req.params.numero || '').trim();
      const [row] = await query(
        'SELECT id FROM svc_invoices WHERE numero = ? OR ncf = ? LIMIT 1', [n, n]
      );
      if (!row) return res.status(404).json({ error: 'No es una factura de servicios.' });
      res.json({ id: row.id });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Comprobantes fiscales disponibles (para el selector de factura) ──────
  const NCF_LABELS = {
    B01: 'Crédito Fiscal', B02: 'Consumo', B03: 'Nota de Débito', B04: 'Nota de Crédito',
    B11: 'Comprobante de Compras', B12: 'Registro Único de Ingresos', B13: 'Gastos Menores',
    B14: 'Régimen Especial', B15: 'Gubernamental', B16: 'Exportaciones', B17: 'Pagos al Exterior',
    E31: 'e-CF Crédito Fiscal', E32: 'e-CF Consumo', E34: 'e-CF Nota de Crédito',
  };
  router.get('/comprobantes', async (_req, res) => {
    try {
      let v2 = false;
      try {
        const [cfg] = await query('SELECT ncf_authorized_sequences_v2_enabled FROM config WHERE id = 1 LIMIT 1');
        v2 = Boolean(Number(cfg?.ncf_authorized_sequences_v2_enabled || 0));
      } catch (_) { /* noop */ }

      const [autorizadas, legacy] = await Promise.all([
        query(
          `SELECT document_type AS tipo, document_name AS nombre, expiration_date AS vencimiento,
                  (end_number - next_number + 1) AS disponibles
           FROM ncf_authorized_sequences
           WHERE deleted_at IS NULL AND status = 'activo' AND next_number <= end_number
           ORDER BY document_type`
        ).catch(() => []),
        query(
          `SELECT ncf_type AS tipo, NULL AS nombre, fecha_vencimiento AS vencimiento,
                  (maximo - siguiente_numero + 1) AS disponibles
           FROM ncf_sequences WHERE activa = 1 AND siguiente_numero <= maximo ORDER BY ncf_type`
        ).catch(() => []),
      ]);

      // Motor real que consume el NCF: v2 → autorizadas; si no → legacy.
      const fuente = v2 ? autorizadas : legacy;
      // Si el motor activo no tiene nada pero SÍ hay rangos registrados en la
      // otra tabla, se muestran igual con aviso para que el usuario active el
      // switch correspondiente.
      const necesitaActivar = !fuente.length && autorizadas.length > 0 && !v2;
      const items = (fuente.length ? fuente : autorizadas).map((r) => ({
        tipo: r.tipo,
        nombre: r.nombre || NCF_LABELS[r.tipo] || r.tipo,
        vencimiento: r.vencimiento || null,
        disponibles: Math.max(0, Number(r.disponibles || 0)),
      }));
      res.json({ comprobantes: items, necesitaActivar });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Listar ───────────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const branchScope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = [];
      const params = [];
      if (branchScope) { cond.push('i.branch_id = ?'); params.push(branchScope); }
      if (req.query.estado) {
        cond.push('i.estado = ?'); params.push(String(req.query.estado));
      } else if (req.query.todas !== '1') {
        // Por defecto la lista muestra solo lo que falta gestionar (pendiente/
        // parcial). Las pagadas y anuladas ya viven en Reportes. ?todas=1 las trae.
        cond.push("i.estado IN ('pendiente', 'parcial')");
      }
      if (req.query.clientId) { cond.push('i.client_id = ?'); params.push(Number(req.query.clientId)); }
      if (req.query.desde) { cond.push('i.fecha >= ?'); params.push(String(req.query.desde)); }
      if (req.query.hasta) { cond.push('i.fecha <= ?'); params.push(String(req.query.hasta)); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(
        `SELECT i.*, b.nombre AS branch_name FROM svc_invoices i
         LEFT JOIN branches b ON b.id = i.branch_id
         ${where} ORDER BY i.fecha DESC, i.id DESC LIMIT 500`, params
      );
      res.json(rows.map((r) => mapInvoice(r)));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Crear directa ────────────────────────────────────────────────────────
  router.post('/', guard.requirePerm('servicios.facturar'), async (req, res) => {
    try {
      res.status(201).json(await createInvoice({ actor: req.authUser, body: req.body, origin: { type: 'directa' } }));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Convertir cotización → factura ───────────────────────────────────────
  router.post('/desde-cotizacion/:id', guard.requirePerm('servicios.facturar'), async (req, res) => {
    const quotationId = Number(req.params.id);
    try {
      const [q] = await query('SELECT * FROM svc_quotations WHERE id = ?', [quotationId]);
      if (!q) throw httpError('Cotización no encontrada.', 404);
      if (q.estado === 'convertida') throw httpError('Esta cotización ya fue convertida en factura.', 409);
      if (q.estado === 'rechazada') throw httpError('No se puede facturar una cotización rechazada.', 409);
      const qItems = await query('SELECT * FROM svc_quotation_items WHERE quotation_id = ? ORDER BY id', [quotationId]);
      const body = {
        ...req.body,
        clientId: q.client_id, clientName: q.client_name, clientRnc: q.client_rnc,
        branchId: q.branch_id, cashRegisterId: q.cash_register_id,
        items: qItems.map((it) => ({
          serviceId: it.service_id, descripcion: it.descripcion, cantidad: it.cantidad,
          precio: it.precio, descuentoPct: it.descuento_pct, itbisPct: it.itbis_pct,
        })),
        notas: req.body?.notas || q.notas,
      };
      const invoice = await createInvoice({
        actor: req.authUser, body, origin: { type: 'cotizacion', id: quotationId, quotationId },
      });
      res.status(201).json(invoice);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const full = await fetchFull(Number(req.params.id));
      if (!full) return res.status(404).json({ error: 'Factura no encontrada.' });
      res.json(full);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Documento imprimible ─────────────────────────────────────────────────
  router.get('/:id/documento', async (req, res) => {
    try {
      const full = await fetchFull(Number(req.params.id));
      if (!full) return res.status(404).json({ error: 'Factura no encontrada.' });
      const cfg = await getConfig().catch(() => ({}));
      const formato = String(req.query.formato || cfg.serviceInvoiceDefaultFormat || 'a4').toLowerCase();
      const html = renderInvoiceDoc(await buildDocPayload(full, cfg), formato);
      if (req.query.raw === '1') { res.type('html').send(html); return; }
      res.json({ formato, html, invoice: full });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Enviar por correo (siempre A4) ───────────────────────────────────────
  router.post('/:id/email', guard.requirePerm('servicios.facturar', 'servicios.enviar'), async (req, res) => {
    const actor = req.authUser;
    try {
      const full = await fetchFull(Number(req.params.id));
      if (!full) throw httpError('Factura no encontrada.', 404);
      let to = String(req.body?.to || '').trim();
      if (!to && full.clientId) {
        const [c] = await query('SELECT email FROM clients WHERE id = ? LIMIT 1', [full.clientId]);
        to = String(c?.email || '').trim();
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw httpError('Indica un correo de destino válido.');

      const cfg = await getConfig().catch(() => ({}));
      const payload = await buildDocPayload(full, cfg);
      const mensaje = String(req.body?.mensaje || '').trim()
        || `Estimado/a ${full.clientName || 'cliente'}, adjunto la factura ${full.numero} por RD$ ${full.total.toFixed(2)}.`;

      await sendInvoiceEmail(query, {
        to,
        subject: req.body?.subject || `Factura ${full.numero} — ${payload.empresa.nombre}`,
        text: mensaje,
        html: renderEmailBody(payload, mensaje),
        pdfBase64: req.body?.pdfBase64 || null,
        filename: `${full.numero}.pdf`,
      });

      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Facturación', actionName: 'Factura enviada por correo',
        detail: `${full.numero} → ${to}`,
        branchId: full.branchId, clientId: full.clientId, documentType: 'factura', documentRef: full.numero, amount: full.total,
      });
      res.json({ ok: true, to });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Anular ───────────────────────────────────────────────────────────────
  router.post('/:id/anular', guard.requirePerm('servicios.anular'), async (req, res) => {
    const actor = req.authUser;
    const id = Number(req.params.id);
    const motivo = String(req.body?.motivo || '').trim();
    try {
      if (!motivo) throw httpError('Indica el motivo de la anulación.');
      const [inv] = await query('SELECT * FROM svc_invoices WHERE id = ?', [id]);
      if (!inv) throw httpError('Factura no encontrada.', 404);
      if (inv.estado === 'anulada') throw httpError('La factura ya está anulada.', 409);
      const [{ pagos = 0 } = {}] = await query(
        'SELECT COUNT(*) AS pagos FROM svc_invoice_payments WHERE invoice_id = ? AND anulado_at IS NULL', [id]
      );
      if (Number(pagos) > 0 && !req.body?.forzar) {
        throw httpError('La factura tiene pagos registrados. Anula los pagos primero o envía forzar=true.', 409);
      }
      const r = await query(
        `UPDATE svc_invoices SET estado = 'anulada', balance = 0, motivo_anulacion = ?, anulada_at = datetime('now'),
           anulada_by_user_name = ?, updated_at = datetime('now') WHERE id = ? AND estado <> 'anulada'`,
        [motivo, actorName(actor), id]
      );
      if (!r.affectedRows) throw httpError('La factura ya está anulada.', 409);
      if (inv.sale_id) {
        await query(
          `UPDATE sales SET sale_status = 'anulada', fiscal_status = 'cancelada',
             canceled_at = datetime('now'), canceled_by_user_id = ?, canceled_by_user_name = ?, cancel_reason = ?
           WHERE id = ?`,
          [actor.id, actorName(actor), motivo, inv.sale_id]
        ).catch(() => {});
      }
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Facturación', actionName: 'Factura de servicios anulada',
        detail: `${inv.numero}${inv.ncf ? ' · ' + inv.ncf : ''} · ${motivo}`,
        branchId: inv.branch_id, clientId: inv.client_id, documentType: 'factura', documentRef: inv.numero, amount: Number(inv.total || 0),
      });
      res.json(await fetchFull(id));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createFacturacionRouter, mapInvoice, recalcInvoice, backfillInvoiceMirror };

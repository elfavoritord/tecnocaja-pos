'use strict';

/**
 * facturacion.routes.js — Facturación de servicios.
 * Factura desde: directa · cotización · (M2) orden/proyecto.
 * Comprobante: NCF tradicional (consume ncf_authorized_sequences) o e-CF
 * (secuencias del módulo e-CF: la venta espejo se firma y se envía a la DGII
 * con el mismo motor que el POS, después de guardar la factura).
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
const { getDocumentType } = require('../../../modules/ecf/config/document-types');
const { validateBuyerForEcf, validateCertificateForEcf } = require('../../../modules/ecf/validators/document-validator');

// e-CF con los que se le factura a un cliente (los equivalentes de B01, B02,
// B14 y B15). Notas de crédito/débito, compras, gastos menores, exportaciones
// y pagos al exterior tienen su propio flujo.
const ECF_TIPOS_FACTURA = ['E31', 'E32', 'E44', 'E45'];

// Misma regla que el motor e-CF (getNextAvailableSequence): activa, sin vencer,
// con números, y Global o de la sucursal/caja de la factura.
function secuenciaEcfSirve(s, { tipo, branchId, cashRegisterId }) {
  const t = String(s.tipoComprobante || '').toUpperCase();
  if (!ECF_TIPOS_FACTURA.includes(t) || (tipo && t !== tipo)) return false;
  if (!s.activo || s.isExpired || s.isExhausted) return false;
  if (s.branchId && Number(s.branchId) !== Number(branchId || 0)) return false;
  if (s.cashRegisterId && Number(s.cashRegisterId) !== Number(cashRegisterId || 0)) return false;
  return true;
}

function fechaSql(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

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
    // e-CF: el estado vivo es el de la venta espejo (lo actualiza el módulo
    // e-CF también cuando se reenvía desde Facturación Electrónica).
    ncf: (row.fiscal_mode === 'ecf' && row.sale_encf) || row.ncf || '',
    qrUrl: row.sale_qr_data || '',
    ncfTipo: row.ncf_tipo || '',
    ncfVencimiento: row.ncf_vencimiento || null,
    ecfStatus: (row.fiscal_mode === 'ecf' && row.sale_ecf_estado) || row.ecf_status || null,
    ecfError: row.fiscal_mode === 'ecf' ? (row.sale_ecf_error || null) : null,
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
    metodo: payments.find((p) => !p.anulado_at)?.metodo || 'efectivo',
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
    ecfService, isInternetOffline = () => false,
  } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();

  router.use(guard.requireService());
  router.use(async (_req, _res, next) => {
    try { await ensureSchema(query); next(); } catch (e) { next(e); }
  });

  async function fetchFull(id) {
    const [row] = await query(
      `SELECT i.*, b.nombre AS branch_name, c.email AS client_email,
              s.encf AS sale_encf, s.ecf_estado AS sale_ecf_estado, s.ecf_error AS sale_ecf_error,
              s.qr_data AS sale_qr_data
       FROM svc_invoices i
       LEFT JOIN branches b ON b.id = i.branch_id
       LEFT JOIN clients c ON c.id = i.client_id
       LEFT JOIN sales s ON s.id = i.sale_id
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
  async function buildDocPayload(full, cfg, { wantSign = false } = {}) {
    let contact = {};
    if (full.clientId) {
      const [c] = await query('SELECT email, telefono, direccion FROM clients WHERE id = ? LIMIT 1', [full.clientId]);
      if (c) contact = { clientEmail: c.email || '', clientTel: c.telefono || '', clientDir: c.direccion || '' };
    }
    let correo = '';
    let firma = '';
    let autosign = false;
    let terminos = '';
    try {
      const [mc] = await query('SELECT service_mail_from, service_mail_user, service_signature, service_autosign, service_terms FROM config WHERE id = 1 LIMIT 1');
      correo = (mc && (mc.service_mail_user || '')) || '';
      firma = (mc && (mc.service_signature || '')) || '';
      autosign = Boolean(Number(mc && mc.service_autosign));
      terminos = (mc && mc.service_terms) || '';
    } catch (_) { /* columnas aún no migradas */ }
    const digitalSign = await resolveDigitalSign(cfg, autosign || wantSign);
    const seguridadEcf = full.fiscalMode === 'ecf' ? await datosSeguridadEcf(full.id) : {};
    return {
      empresa: {
        nombre: cfg.nombre || 'Tecno Caja', rnc: cfg.rnc || '', direccion: cfg.direccion || '',
        telefono: cfg.telefono || '', correo, logo: cfg.logo || '', firma,
      },
      invoice: { ...full, ...contact, ...seguridadEcf, docType: 'factura', digitalSign },
      items: full.items,
      // Plantilla y color de Configuración → Impresora de Recibos (factura A4).
      diseno: { plantilla: cfg.invoiceTemplate, color: cfg.invoiceAccentColor },
      // Términos y condiciones de Ajustes de Empresa de Servicios.
      terminos,
    };
  }

  // e-CF: QR, código de seguridad y fecha de firma para la representación
  // impresa. Salen de la URL del QR que el módulo e-CF guardó en la venta
  // espejo (sales.qr_data, igual que en el recibo del POS).
  async function datosSeguridadEcf(invoiceId) {
    try {
      const [row] = await query(
        'SELECT s.qr_data FROM svc_invoices i INNER JOIN sales s ON s.id = i.sale_id WHERE i.id = ? LIMIT 1', [invoiceId]
      );
      const qrUrl = String(row?.qr_data || '').trim();
      if (!qrUrl) return {};
      const url = new URL(qrUrl);
      const QRCode = require('qrcode');
      return {
        ecfQrDataUrl: await QRCode.toDataURL(qrUrl, { margin: 1, width: 220 }),
        ecfCodigoSeguridad: url.searchParams.get('CodigoSeguridad') || '',
        ecfFechaFirma: url.searchParams.get('FechaFirma') || '',
      };
    } catch (_) { return {}; }
  }

  // Devuelve { nombre, rnc, fecha } si el PDF se va a firmar (auto-firma activa o
  // el llamador lo pidió) y hay un certificado .p12 vigente; si no, null.
  async function resolveDigitalSign(cfg, want) {
    if (!want || !ecfService || typeof ecfService.getCertificateStatus !== 'function') return null;
    try {
      if (typeof ecfService.ensureReady === 'function') await ecfService.ensureReady().catch(() => {});
      const st = await ecfService.getCertificateStatus();
      if (!st || !st.hasCertificate || st.isExpired || st.status === 'error') return null;
      return {
        nombre: cfg.nombre || 'Tecno Caja',
        rnc: String(cfg.rnc || '').replace(/\D/g, ''),
        fecha: new Date(),
      };
    } catch (_) { return null; }
  }

  async function listarSecuenciasEcf() {
    if (!ecfService || typeof ecfService.listSequences !== 'function') return [];
    if (typeof ecfService.ensureReady === 'function') await ecfService.ensureReady().catch(() => {});
    // Solo las del ambiente activo: en producción no se factura con rangos de pruebas.
    return ecfService.listSequences({ onlyActiveEnvironment: true }).catch(() => []);
  }

  // Antes de guardar una factura e-CF: que el módulo esté activo y completo,
  // que haya secuencia del tipo y que el comprador cumpla (RNC/nombre). Así
  // no queda guardada una factura que después no se puede emitir.
  // `reusaNumero`: reintento que usará el e-NCF ya apartado (no hace falta
  // número libre en la secuencia).
  async function prepararEcf(p, { branchId, cashRegisterId, reusaNumero = false }) {
    if (!ecfService || typeof ecfService.processSaleForElectronicInvoicing !== 'function') {
      throw httpError('La facturación electrónica no está disponible en esta instalación.', 500);
    }
    const tipo = p.ncfTipo || (String(p.clientRnc || '').replace(/\D/g, '') ? 'E31' : 'E32');
    if (!ECF_TIPOS_FACTURA.includes(tipo)) {
      throw httpError(`El e-CF ${tipo} no se emite desde Facturación de servicios. Usa ${ECF_TIPOS_FACTURA.join(', ')}.`);
    }
    const status = await ecfService.getSystemStatus();
    if (!status.isActive) {
      throw httpError('La facturación electrónica está desactivada. Actívala en Configuración → Facturación Electrónica DGII → Estado.', 409);
    }
    const faltan = (status.checklist?.items || []).filter((i) => i.key !== 'sequences' && i.status !== 'ok').map((i) => i.message);
    const certificado = typeof ecfService.getCertificateStatus === 'function' ? await ecfService.getCertificateStatus() : null;
    if (certificado) faltan.push(...validateCertificateForEcf(certificado));
    if (faltan.length) throw httpError(`No se puede emitir el e-CF: ${[...new Set(faltan)].join(' ')}`, 409);
    const secuencias = reusaNumero ? [] : await listarSecuenciasEcf();
    if (!reusaNumero && !secuencias.some((s) => secuenciaEcfSirve(s, { tipo, branchId, cashRegisterId }))) {
      throw httpError(`No hay una secuencia e-CF ${tipo} activa con números disponibles. Regístrala en Configuración → Ventas y Facturación → Secuencias de Comprobantes Electrónicos (e-NCF).`, 409);
    }
    const rfceUmbral = Number(ecfService?.config?.DGII_RFCE_THRESHOLD_DOP || 250000) || 250000;
    if (tipo === 'E32' && p.totals.total >= rfceUmbral) {
      const digits = String(p.clientRnc || '').replace(/\D/g, '');
      if (!p.clientName || ![9, 11].includes(digits.length)) {
        throw httpError(`Para emitir un e-CF E32 de RD$${rfceUmbral.toLocaleString('es-DO')} o más, indica el nombre y el RNC/cédula del comprador.`);
      }
    }
    const comprador = validateBuyerForEcf({ tipoEcf: tipo, buyerTaxId: p.clientRnc, buyerName: p.clientName });
    if (comprador.length) throw httpError(comprador.join(' '));
    return tipo;
  }

  // Después del commit: firma y envía la venta espejo con el motor del POS (el
  // e-NCF lo reserva el módulo e-CF de su secuencia) y deja el resultado en la
  // factura. Si la DGII falla, la factura queda guardada con su error y el
  // documento se reintenta desde Facturación Electrónica → Documentos.
  // `reenviarDocumentoId`: reintento de un e-CF ya firmado (solo se reenvía).
  // Sin él se emite; si un intento anterior apartó el e-NCF pero no llegó a
  // firmar, el módulo e-CF reusa ese mismo número.
  async function emitirEcf({ invoiceId, saleId, tipo, actor, reenviarDocumentoId = null }) {
    let result = null;
    let error = null;
    try {
      result = reenviarDocumentoId
        ? await ecfService.resendDocument(reenviarDocumentoId)
        : await ecfService.processSaleForElectronicInvoicing(saleId, {
          userId: actor.id || null,
          userName: actorName(actor),
          userRole: roleCodeOf(actor),
          requestedType: tipo,
          internetOffline: isInternetOffline(),
        });
    } catch (e) {
      error = e.message;
      console.warn('[servicios] e-CF de la factura #%s falló: %s', invoiceId, e.message);
      // Que el error quede a la vista en la lista (si falla antes de firmar, el
      // módulo e-CF no llega a anotarlo en la venta).
      await query('UPDATE sales SET ecf_estado = ?, ecf_error = ? WHERE id = ?', ['error', String(e.message).slice(0, 500), saleId]).catch(() => {});
    }
    const [doc] = await query(
      `SELECT d.encf, d.tipo_ecf, d.estado_dgii, d.error_message, s.fecha_vencimiento
       FROM ecf_documents d LEFT JOIN ecf_sequences s ON s.id = d.sequence_id
       WHERE d.sale_id = ? ORDER BY d.id DESC LIMIT 1`, [saleId]
    ).catch(() => []);
    const encf = result?.encf || doc?.encf || null;
    const estado = String(result?.estado || (error ? 'error' : doc?.estado_dgii) || 'pendiente').slice(0, 20);
    await query(
      'UPDATE svc_invoices SET ncf = ?, ncf_tipo = ?, ncf_vencimiento = ?, ecf_status = ? WHERE id = ?',
      [encf, result?.tipoEcf || doc?.tipo_ecf || tipo, fechaSql(doc?.fecha_vencimiento), estado, invoiceId]
    );
    const pendiente = Boolean(result?.pending);
    const ok = Boolean(result?.ok);
    return {
      ok, pendiente, encf, estado,
      mensaje: result?.mensaje || null,
      error: ok || pendiente ? null : (error || doc?.error_message || 'La DGII no aceptó el comprobante.'),
    };
  }

  // Consume el comprobante fiscal según el modo. Corre dentro de la transacción.
  // El e-CF no se numera aquí: lo hace el módulo e-CF al emitir (emitirEcf).
  async function assignFiscal(conn, { fiscalMode, ncfTipo, branchId }) {
    const mode = ['ncf', 'ecf', 'consumidor'].includes(fiscalMode) ? fiscalMode : 'ncf';
    if (mode === 'consumidor') return { fiscal_mode: 'consumidor', ncf: null, ncf_tipo: null, ncf_vencimiento: null, ecf_status: null };
    if (mode === 'ecf') {
      return { fiscal_mode: 'ecf', ncf: null, ncf_tipo: ncfTipo, ncf_vencimiento: null, ecf_status: 'pendiente' };
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
    const esEcf = p.fiscalMode === 'ecf';
    if (esEcf) p.ncfTipo = await prepararEcf(p, { branchId, cashRegisterId });
    const tipoNcf = String(p.ncfTipo || 'B02').toUpperCase();
    const tipoConsumo = (p.fiscalMode === 'ncf' && /^B0?2$/.test(tipoNcf))
      || (p.fiscalMode === 'ecf' && p.ncfTipo === 'E32');
    const umbralConsumo = Number(ecfService?.config?.DGII_RFCE_THRESHOLD_DOP || 250000) || 250000;
    if (tipoConsumo && p.totals.total < umbralConsumo && !p.clientName) p.clientName = 'Consumidor Final';
    if (p.fiscalMode === 'ncf' && /^B0?2$/.test(tipoNcf) && p.totals.total >= umbralConsumo) {
      const digits = String(p.clientRnc || '').replace(/\D/g, '');
      if (!p.clientName || ![9, 11].includes(digits.length)) {
        throw httpError(`Para comprobantes B02 de RD$${umbralConsumo.toLocaleString('es-DO')} o más, indica el nombre y el RNC/cédula del comprador.`);
      }
    }

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
      // tumbar la emisión de la factura, salvo en e-CF: lo que se firma y se
      // envía a la DGII es justamente esa venta.
      let saleId = null;
      try {
        saleId = await mirrorInvoiceToSales(conn, {
          numero, ncf: fiscal.ncf, fiscalMode: fiscal.fiscal_mode, ncfTipo: fiscal.ncf_tipo,
          actor, branchId, cashRegisterId, p, cobrarAhora, metodoPago,
        });
        if (saleId) await conn.query('UPDATE svc_invoices SET sale_id = ? WHERE id = ?', [saleId, invoiceId]);
      } catch (mirrorErr) {
        if (esEcf) throw mirrorErr;
        console.warn('[servicios] espejo en sales falló:', mirrorErr.message);
      }

      return { invoiceId, numero, ncf: fiscal.ncf, saleId };
    });

    const ecf = esEcf ? await emitirEcf({ invoiceId: saved.invoiceId, saleId: saved.saleId, tipo: p.ncfTipo, actor }) : null;
    if (ecf?.encf) saved.ncf = ecf.encf;

    await writeAuditLog({
      userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
      moduleName: 'Facturación', actionName: 'Factura de servicios emitida',
      detail: `${saved.numero}${saved.ncf ? ' · ' + saved.ncf : ''} · RD$ ${p.totals.total.toFixed(2)}${cobrarAhora ? ' · pagada (' + metodoPago + ')' : ''}`,
      branchId, clientId: p.clientId, documentType: 'factura', documentRef: saved.numero,
      amount: p.totals.total, paymentMethod: cobrarAhora ? metodoPago : null,
    });
    const full = await fetchFull(saved.invoiceId);
    return ecf ? { ...full, ecf } : full;
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
  router.get('/comprobantes', async (req, res) => {
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

      // e-CF: las secuencias del módulo de Facturación Electrónica, un tipo por
      // opción. `ecfFueraDeAlcance`: hay activas, pero de otra sucursal/caja.
      let branchId = null;
      try { branchId = resolveBranch(req.authUser, req.query.branchId, deps); } catch (_) { /* sin sucursal */ }
      const secuencias = await listarSecuenciasEcf();
      const porTipo = new Map();
      for (const s of secuencias.filter((x) => secuenciaEcfSirve(x, { branchId, cashRegisterId: null }))) {
        const tipo = String(s.tipoComprobante).toUpperCase();
        const prev = porTipo.get(tipo);
        porTipo.set(tipo, {
          tipo,
          nombre: getDocumentType(tipo)?.label || NCF_LABELS[tipo] || tipo,
          vencimiento: prev?.vencimiento || fechaSql(s.fechaVencimiento),
          disponibles: (prev?.disponibles || 0) + Math.max(0, Number(s.remaining || 0)),
        });
      }
      const electronicos = ECF_TIPOS_FACTURA.filter((t) => porTipo.has(t)).map((t) => porTipo.get(t));
      const ecfFueraDeAlcance = !electronicos.length
        && secuencias.some((s) => secuenciaEcfSirve(s, { branchId: s.branchId, cashRegisterId: s.cashRegisterId }));
      let ecfActivo = false;
      if (electronicos.length && ecfService && typeof ecfService.getSystemStatus === 'function') {
        ecfActivo = Boolean((await ecfService.getSystemStatus().catch(() => null))?.isActive);
      }
      res.json({ comprobantes: items, necesitaActivar, electronicos, ecfActivo, ecfFueraDeAlcance });
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
        // parcial, o un e-CF que la DGII todavía no aceptó). Las pagadas y
        // anuladas ya viven en Reportes. ?todas=1 las trae.
        cond.push(`(i.estado IN ('pendiente', 'parcial')
          OR (i.fiscal_mode = 'ecf' AND i.estado <> 'anulada'
              AND COALESCE(s.ecf_estado, i.ecf_status, '') NOT IN ('aceptado', 'aceptado_condicional')))`);
      }
      if (req.query.clientId) { cond.push('i.client_id = ?'); params.push(Number(req.query.clientId)); }
      if (req.query.desde) { cond.push('i.fecha >= ?'); params.push(String(req.query.desde)); }
      if (req.query.hasta) { cond.push('i.fecha <= ?'); params.push(String(req.query.hasta)); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(
        `SELECT i.*, b.nombre AS branch_name,
                s.encf AS sale_encf, s.ecf_estado AS sale_ecf_estado, s.ecf_error AS sale_ecf_error
         FROM svc_invoices i
         LEFT JOIN branches b ON b.id = i.branch_id
         LEFT JOIN sales s ON s.id = i.sale_id
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
      const wantSign = ['1', 'true', 'yes'].includes(String(req.query.firmar || '').toLowerCase());
      const html = renderInvoiceDoc(await buildDocPayload(full, cfg, { wantSign }), formato);
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

  // ── Reintentar el e-CF (falló al armar, firmar o enviar) ─────────────────
  // Ya firmado → se reenvía. Sin firmar (el XML falló) → se emite otra vez con
  // el mismo e-NCF apartado. Sin documento (facturas numeradas con el contador
  // viejo, p. ej. "ECF0000000001") → se emite como nueva con su secuencia.
  const ECF_YA_ENVIADO = new Set(['aceptado', 'aceptado_condicional', 'enviado', 'en_proceso', 'procesando']);
  router.post('/:id/reintentar-ecf', guard.requirePerm('servicios.facturar'), async (req, res) => {
    const id = Number(req.params.id);
    try {
      const [inv] = await query(
        `SELECT id, numero, fiscal_mode, ncf, ncf_tipo, sale_id, estado, client_name, client_rnc, branch_id, cash_register_id, total
         FROM svc_invoices WHERE id = ?`, [id]
      );
      if (!inv) throw httpError('Factura no encontrada.', 404);
      if (inv.fiscal_mode !== 'ecf') throw httpError('Esta factura no es un e-CF.');
      if (inv.estado === 'anulada') throw httpError('La factura está anulada.', 409);
      if (!inv.sale_id) throw httpError('La factura no tiene la venta con la que se emite el e-CF.', 409);
      const [doc] = await query(
        `SELECT id, encf, tipo_ecf, estado_dgii, environment, CASE WHEN signed_xml_content IS NULL THEN 0 ELSE 1 END AS firmado
         FROM ecf_documents WHERE sale_id = ? ORDER BY id DESC LIMIT 1`, [inv.sale_id]
      ).catch(() => []);
      if (doc && ECF_YA_ENVIADO.has(String(doc.estado_dgii || '').toLowerCase())) {
        throw httpError(`El e-CF ${doc.encf} ya fue enviado a la DGII (${doc.estado_dgii}).`, 409);
      }
      // Una factura empezada en pruebas (TesteCF/CerteCF) no se manda como
      // comprobante fiscal real después de pasar a producción, ni al revés.
      const ambiente = String((await ecfService.getSystemStatus().catch(() => null))?.environment || '').toLowerCase();
      if (doc && ambiente && String(doc.environment || '').toLowerCase() !== ambiente) {
        throw httpError(`Esta factura se hizo en el ambiente ${doc.environment} y ahora estás en ${ambiente}. Anúlala y hazla de nuevo.`, 409);
      }
      const firmado = Boolean(Number(doc?.firmado || 0));
      if (firmado && isInternetOffline()) {
        throw httpError(`Sin Internet: el e-CF ${doc.encf} ya está firmado y se enviará solo cuando vuelva la conexión.`, 409);
      }
      const tipo = String((doc && doc.tipo_ecf) || inv.ncf_tipo || '').toUpperCase() || null;
      if (!firmado) {
        await prepararEcf(
          { ncfTipo: tipo, clientRnc: inv.client_rnc, clientName: inv.client_name, totals: { total: Number(inv.total || 0) } },
          { branchId: inv.branch_id, cashRegisterId: inv.cash_register_id, reusaNumero: Boolean(doc) }
        );
      }
      const ecf = await emitirEcf({ invoiceId: id, saleId: inv.sale_id, tipo, actor: req.authUser, reenviarDocumentoId: firmado ? doc.id : null });
      // Número viejo inventado (p. ej. "ECF0000000001") que quedó en la venta espejo.
      if (ecf.encf && inv.ncf && inv.ncf !== ecf.encf) {
        await query('UPDATE sales SET ncf = NULL, ncf_type = NULL WHERE id = ? AND ncf = ?', [inv.sale_id, inv.ncf]).catch(() => {});
      }
      res.json({ ...(await fetchFull(id)), ecf });
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
           anulada_by_user_name = ?, signed_pdf = NULL, signed_at = NULL, updated_at = datetime('now')
         WHERE id = ? AND estado <> 'anulada'`,
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

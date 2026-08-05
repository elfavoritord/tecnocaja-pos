'use strict';

/**
 * facturacion.routes.js — Facturación de servicios de Tecno Caja
 * Facturas que Emilio emite a sus clientes de Tecno Caja POS (licencia,
 * mensualidad, instalación, soporte, etc.). No tiene relación con DGII/e-CF:
 * esas rutas son para las ventas de los clientes en sus propios negocios.
 *
 * GET    /api/facturas               — lista (filtros: estado, negocioId, q)
 * GET    /api/facturas/:id           — detalle
 * POST   /api/facturas               — crear
 * PUT    /api/facturas/:id           — editar (solo pendiente/parcial)
 * POST   /api/facturas/:id/pagos     — registrar abono
 * POST   /api/facturas/:id/anular    — anular (requiere motivo, nunca se borra)
 * GET    /api/facturas/:id/html      — vista previa HTML (A4)
 * GET    /api/facturas/:id/pdf       — PDF descargable (A4, vía puppeteer)
 */

const express = require('express');
const QRCode = require('qrcode');

const COL_FACTURAS = 'facturas';
const METODOS_PAGO = ['efectivo', 'transferencia', 'tarjeta', 'otro'];
const ESTADOS_EDITABLES = ['pendiente', 'parcial'];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateOnly(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-DO');
}

function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw new Error('La factura debe tener al menos un ítem.');
  return rawItems.map((it, idx) => {
    const descripcion = String(it.descripcion || '').trim();
    const cantidad = Number(it.cantidad);
    const precioUnitario = Number(it.precioUnitario);
    if (!descripcion) throw new Error(`El ítem ${idx + 1} necesita una descripción.`);
    if (!Number.isFinite(cantidad) || cantidad <= 0) throw new Error(`El ítem ${idx + 1} necesita una cantidad válida.`);
    if (!Number.isFinite(precioUnitario) || precioUnitario < 0) throw new Error(`El ítem ${idx + 1} necesita un precio válido.`);
    return { descripcion, cantidad, precioUnitario, monto: cantidad * precioUnitario };
  });
}

function computeTotals(items, { aplicaItbis, tasaItbis, descuento }) {
  const subtotal = items.reduce((sum, it) => sum + it.monto, 0);
  const desc = Math.max(0, Number(descuento) || 0);
  const base = Math.max(0, subtotal - desc);
  const itbis = aplicaItbis ? base * (Number(tasaItbis) || 0) : 0;
  return { subtotal, itbis, total: base + itbis };
}

const COL_ADMIN_CONFIG = 'admin_config';
const LOGO_DOC_ID = 'facturacion';
const LOGO_MAX_LENGTH = 700_000; // ~700KB de texto base64 — margen bajo el límite de 1MB por doc de Firestore

async function getEmisorConfig(col) {
  let logoDataUrl = null;
  try {
    const doc = await col(COL_ADMIN_CONFIG).doc(LOGO_DOC_ID).get();
    if (doc.exists) logoDataUrl = doc.data().logoDataUrl || null;
  } catch (_) { /* si Firestore falla, la factura se genera igual, sin logo */ }

  return {
    nombre: process.env.ADMIN_COMPANY_NAME || 'Tecno Caja',
    rnc: process.env.ADMIN_COMPANY_RNC || '',
    direccion: process.env.ADMIN_COMPANY_ADDRESS || '',
    telefono: process.env.ADMIN_COMPANY_PHONE || '',
    correo: process.env.ADMIN_COMPANY_EMAIL || '',
    logoDataUrl,
  };
}

async function nextInvoiceNumber(col) {
  const ref = col('admin_meta').doc('facturacion_counter');
  const prefix = process.env.ADMIN_INVOICE_PREFIX || 'FAC';
  return ref.firestore.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const next = (doc.exists ? Number(doc.data().next) : 1) || 1;
    tx.set(ref, { next: next + 1 }, { merge: true });
    return `${prefix}-${String(next).padStart(6, '0')}`;
  });
}

async function buildInvoiceHtml(factura, col) {
  const emisor = await getEmisorConfig(col);
  const estadoLabel = { pendiente: 'PENDIENTE', parcial: 'PAGO PARCIAL', pagada: 'PAGADA', anulada: 'ANULADA' }[factura.estado] || factura.estado;

  const qrDataUrl = await QRCode.toDataURL(
    `Factura ${factura.numero} — ${emisor.nombre} — RD$ ${fmtMoney(factura.total)}`,
    { width: 140, margin: 1, color: { dark: '#000', light: '#fff' } }
  );

  const itemsHtml = (factura.items || []).map(it => `
    <tr>
      <td class="num">${escapeHtml(it.cantidad)}</td>
      <td>${escapeHtml(it.descripcion)}</td>
      <td class="num">RD$ ${fmtMoney(it.precioUnitario)}</td>
      <td class="num">RD$ ${fmtMoney(it.monto)}</td>
    </tr>`).join('');

  // logoDataUrl es un data: URI generado por nosotros (base64), no texto de
  // usuario — no se escapa para no corromper el base64.
  const logoHtml = emisor.logoDataUrl ? `<img src="${emisor.logoDataUrl}" class="logo" />` : '';
  const saldoPendiente = factura.total - (factura.montoPagado || 0);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(factura.numero)} — Factura</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; background: #fff; }
  .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 14mm 16mm 12mm; }
  .top { display: grid; grid-template-columns: 1fr 0.8fr; gap: 15mm; align-items: start; margin-bottom: 7mm; }
  .emitter-box { min-height: 32mm; border: 2px solid #22c55e; padding: 3mm; }
  .logo { max-height: 14mm; max-width: 60mm; margin-bottom: 2mm; display: block; }
  .biz-name { font-size: 15px; font-weight: 900; text-transform: uppercase; color: #1236a3; margin-bottom: 2mm; }
  .biz-line { font-size: 10.5px; line-height: 1.35; font-weight: 600; }
  .doc-box { min-height: 28mm; border: 2px solid #22c55e; padding: 4mm; }
  .doc-type { font-size: 17px; font-weight: 700; margin-bottom: 3mm; }
  .doc-meta { font-size: 10.5px; line-height: 1.5; font-weight: 700; }
  .status-pill { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 10px; font-weight: 700; margin-top: 2mm; }
  .status-pendiente, .status-parcial { background: #fef3c7; color: #92400e; }
  .status-pagada { background: #dcfce7; color: #166534; }
  .status-anulada { background: #fee2e2; color: #991b1b; }
  .buyer-box { border: 2px solid #22c55e; padding: 2.5mm 3mm; margin-bottom: 4mm; font-size: 10.5px; line-height: 1.45; font-weight: 700; }
  .items-table { width: 100%; border-collapse: collapse; border: 2px solid #22c55e; font-size: 10px; }
  .items-table th { background: #0476c9; color: #fff; border: 1px solid #0476c9; padding: 5px 6px; text-align: left; font-weight: 800; text-transform: uppercase; }
  .items-table td { border: 1px solid #d5d5d5; padding: 5px 6px; vertical-align: top; }
  .items-table tbody tr:nth-child(even) { background: #ededed; }
  td.num { text-align: right; white-space: nowrap; }
  .totals { display: flex; justify-content: flex-end; margin-top: 6px; }
  .totals-table { width: 55%; border-collapse: collapse; }
  .totals-table td { padding: 3px 7px; border: 0; }
  .totals-table .label { text-align: right; font-weight: 700; color: #555; white-space: nowrap; }
  .totals-table .value { text-align: right; white-space: nowrap; }
  .grand-total td { font-size: 13px; font-weight: 900; border-top: 2px solid #000; padding-top: 5px; }
  .bottom { display: grid; grid-template-columns: 42mm 1fr; gap: 10mm; align-items: start; margin-top: 8mm; }
  .qr-box { border: 2px solid #22c55e; padding: 3mm; width: 38mm; text-align: left; }
  .qr-box img { width: 30mm; height: 30mm; display: block; }
  .notes { font-size: 10px; line-height: 1.5; max-width: 100mm; }
  @media print { .page { box-shadow: none; } }
</style>
</head>
<body>
<div class="page">
  <div class="top">
    <div class="emitter-box">
      ${logoHtml}
      <div class="biz-name">${escapeHtml(emisor.nombre)}</div>
      ${emisor.rnc ? `<div class="biz-line">RNC: ${escapeHtml(emisor.rnc)}</div>` : ''}
      ${emisor.direccion ? `<div class="biz-line">${escapeHtml(emisor.direccion)}</div>` : ''}
      ${emisor.telefono ? `<div class="biz-line">Tel: ${escapeHtml(emisor.telefono)}</div>` : ''}
      ${emisor.correo ? `<div class="biz-line">${escapeHtml(emisor.correo)}</div>` : ''}
    </div>
    <div class="doc-box">
      <div class="doc-type">FACTURA</div>
      <div class="doc-meta">No. ${escapeHtml(factura.numero)}</div>
      <div class="doc-meta">Emisión: ${escapeHtml(formatDateOnly(factura.fechaEmision))}</div>
      ${factura.fechaVencimiento ? `<div class="doc-meta">Vencimiento: ${escapeHtml(formatDateOnly(factura.fechaVencimiento))}</div>` : ''}
      <div><span class="status-pill status-${factura.estado}">${escapeHtml(estadoLabel)}</span></div>
    </div>
  </div>

  <div class="buyer-box">
    <div>Cliente: ${escapeHtml(factura.clienteNombre)}</div>
    ${factura.clienteRnc ? `<div>RNC/Cédula: ${escapeHtml(factura.clienteRnc)}</div>` : ''}
    ${factura.clienteTelefono ? `<div>Teléfono: ${escapeHtml(factura.clienteTelefono)}</div>` : ''}
    ${factura.clienteDireccion ? `<div>Dirección: ${escapeHtml(factura.clienteDireccion)}</div>` : ''}
  </div>

  <table class="items-table">
    <thead><tr><th style="width:50px">Cant.</th><th>Descripción</th><th style="width:90px">Precio Unit.</th><th style="width:100px">Monto</th></tr></thead>
    <tbody>${itemsHtml}</tbody>
  </table>

  <div class="totals">
    <table class="totals-table">
      <tr><td class="label">Subtotal:</td><td class="value">RD$ ${fmtMoney(factura.subtotal)}</td></tr>
      ${factura.descuento ? `<tr><td class="label">Descuento:</td><td class="value">- RD$ ${fmtMoney(factura.descuento)}</td></tr>` : ''}
      ${factura.aplicaItbis ? `<tr><td class="label">ITBIS (${Math.round(factura.tasaItbis * 100)}%):</td><td class="value">RD$ ${fmtMoney(factura.itbis)}</td></tr>` : ''}
      <tr class="grand-total"><td class="label">TOTAL:</td><td class="value">RD$ ${fmtMoney(factura.total)}</td></tr>
      ${factura.montoPagado ? `<tr><td class="label">Pagado:</td><td class="value">RD$ ${fmtMoney(factura.montoPagado)}</td></tr>
      <tr><td class="label">Saldo:</td><td class="value">RD$ ${fmtMoney(saldoPendiente)}</td></tr>` : ''}
    </table>
  </div>

  <div class="bottom">
    <div class="qr-box"><img src="${qrDataUrl}" alt="QR" /></div>
    <div class="notes">${factura.notas ? escapeHtml(factura.notas) : ''}</div>
  </div>
</div>
</body>
</html>`;
}

function createFacturacionRouter({ col, docData, isoNow, audit, requireAuth, licenciasCollection }) {
  const router = express.Router();

  router.get('/', requireAuth, async (req, res) => {
    try {
      let query = col(COL_FACTURAS);
      if (req.query.negocioId) query = query.where('negocioId', '==', req.query.negocioId);
      if (req.query.estado) query = query.where('estado', '==', req.query.estado);
      const snap = await query.get();
      let list = snap.docs.map(docData);

      const q = String(req.query.q || '').trim().toLowerCase();
      if (q) {
        list = list.filter(f =>
          (f.numero || '').toLowerCase().includes(q) ||
          (f.clienteNombre || '').toLowerCase().includes(q)
        );
      }

      list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

      const now = Date.now();
      list = list.map(f => ({
        ...f,
        estadoVisual: (['pendiente', 'parcial'].includes(f.estado) && f.fechaVencimiento && new Date(f.fechaVencimiento).getTime() < now)
          ? 'vencida'
          : f.estado,
      }));

      res.json(list);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Logo del emisor — usado en el encabezado de cada factura. Va antes de
  // '/:id' para que Express no lo confunda con una factura de id "config".
  router.get('/config/logo', requireAuth, async (_req, res) => {
    try {
      const doc = await col(COL_ADMIN_CONFIG).doc(LOGO_DOC_ID).get();
      res.json({ logoDataUrl: doc.exists ? (doc.data().logoDataUrl || null) : null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/config/logo', requireAuth, async (req, res) => {
    try {
      const dataUrl = String(req.body?.dataUrl || '');
      if (!/^data:image\/(png|jpe?g|webp);base64,/.test(dataUrl)) {
        return res.status(400).json({ error: 'La imagen debe enviarse como data URI (png/jpg/webp).' });
      }
      if (dataUrl.length > LOGO_MAX_LENGTH) {
        return res.status(400).json({ error: 'La imagen es demasiado grande. Usa una más liviana.' });
      }
      await col(COL_ADMIN_CONFIG).doc(LOGO_DOC_ID).set(
        { logoDataUrl: dataUrl, updatedAt: isoNow(), updatedBy: req.adminUser.email },
        { merge: true }
      );
      await audit(req.adminUser.email, 'facturacion.logo.actualizar', LOGO_DOC_ID, null);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.delete('/config/logo', requireAuth, async (req, res) => {
    try {
      await col(COL_ADMIN_CONFIG).doc(LOGO_DOC_ID).set(
        { logoDataUrl: null, updatedAt: isoNow(), updatedBy: req.adminUser.email },
        { merge: true }
      );
      await audit(req.adminUser.email, 'facturacion.logo.quitar', LOGO_DOC_ID, null);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/:id', requireAuth, async (req, res) => {
    try {
      const doc = await col(COL_FACTURAS).doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: 'Factura no encontrada.' });
      res.json(docData(doc));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/', requireAuth, async (req, res) => {
    try {
      const { negocioId, clienteNombre, clienteRnc, clienteTelefono, clienteDireccion,
        items, aplicaItbis, tasaItbis, descuento, metodoPago, fechaVencimiento, notas } = req.body;

      if (!negocioId) return res.status(400).json({ error: 'Selecciona un negocio/cliente.' });
      if (!String(clienteNombre || '').trim()) return res.status(400).json({ error: 'El nombre del cliente es obligatorio.' });

      const negDoc = await col(licenciasCollection).doc(negocioId).get();
      if (!negDoc.exists) return res.status(404).json({ error: 'El negocio seleccionado no existe.' });

      const normItems = normalizeItems(items);
      const aplicaItbisBool = aplicaItbis !== false;
      const tasa = Number.isFinite(Number(tasaItbis)) ? Number(tasaItbis) : 0.18;
      const desc = Number(descuento) || 0;
      const { subtotal, itbis, total } = computeTotals(normItems, { aplicaItbis: aplicaItbisBool, tasaItbis: tasa, descuento: desc });

      const numero = await nextInvoiceNumber(col);
      const now = isoNow();

      const data = {
        numero, negocioId,
        clienteNombre: String(clienteNombre).trim(),
        clienteRnc: clienteRnc || null,
        clienteTelefono: clienteTelefono || null,
        clienteDireccion: clienteDireccion || null,
        items: normItems,
        aplicaItbis: aplicaItbisBool, tasaItbis: tasa,
        subtotal, descuento: desc, itbis, total,
        metodoPago: METODOS_PAGO.includes(metodoPago) ? metodoPago : 'efectivo',
        estado: 'pendiente',
        montoPagado: 0,
        pagos: [],
        fechaEmision: now,
        fechaVencimiento: fechaVencimiento || null,
        notas: notas || null,
        createdBy: req.adminUser.email,
        createdAt: now, updatedAt: now,
      };

      const ref = await col(COL_FACTURAS).add(data);
      await audit(req.adminUser.email, 'factura.crear', ref.id, `${numero} — ${data.clienteNombre} — RD$ ${fmtMoney(total)}`);
      const doc = await ref.get();
      res.status(201).json(docData(doc));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.put('/:id', requireAuth, async (req, res) => {
    try {
      const ref = col(COL_FACTURAS).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Factura no encontrada.' });
      const existing = doc.data();
      if (!ESTADOS_EDITABLES.includes(existing.estado)) {
        return res.status(400).json({ error: `No se puede editar una factura en estado "${existing.estado}".` });
      }

      const { clienteNombre, clienteRnc, clienteTelefono, clienteDireccion,
        items, aplicaItbis, tasaItbis, descuento, metodoPago, fechaVencimiento, notas } = req.body;

      const normItems = normalizeItems(items);
      const aplicaItbisBool = aplicaItbis !== false;
      const tasa = Number.isFinite(Number(tasaItbis)) ? Number(tasaItbis) : 0.18;
      const desc = Number(descuento) || 0;
      const { subtotal, itbis, total } = computeTotals(normItems, { aplicaItbis: aplicaItbisBool, tasaItbis: tasa, descuento: desc });

      const montoPagado = Number(existing.montoPagado || 0);
      if (total < montoPagado) {
        return res.status(400).json({ error: 'El nuevo total no puede ser menor al monto ya pagado.' });
      }

      const update = {
        clienteNombre: clienteNombre ? String(clienteNombre).trim() : existing.clienteNombre,
        clienteRnc: clienteRnc ?? existing.clienteRnc,
        clienteTelefono: clienteTelefono ?? existing.clienteTelefono,
        clienteDireccion: clienteDireccion ?? existing.clienteDireccion,
        items: normItems,
        aplicaItbis: aplicaItbisBool, tasaItbis: tasa,
        subtotal, descuento: desc, itbis, total,
        metodoPago: METODOS_PAGO.includes(metodoPago) ? metodoPago : existing.metodoPago,
        fechaVencimiento: fechaVencimiento ?? existing.fechaVencimiento,
        notas: notas ?? existing.notas,
        estado: montoPagado >= total ? 'pagada' : (montoPagado > 0 ? 'parcial' : 'pendiente'),
        updatedAt: isoNow(),
      };

      await ref.update(update);
      await audit(req.adminUser.email, 'factura.editar', req.params.id, existing.numero);
      const updated = await ref.get();
      res.json(docData(updated));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/:id/pagos', requireAuth, async (req, res) => {
    try {
      const ref = col(COL_FACTURAS).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Factura no encontrada.' });
      const existing = doc.data();
      if (existing.estado === 'anulada') return res.status(400).json({ error: 'No se puede registrar pagos en una factura anulada.' });
      if (existing.estado === 'pagada') return res.status(400).json({ error: 'Esta factura ya está pagada en su totalidad.' });

      const monto = Number(req.body.monto);
      if (!Number.isFinite(monto) || monto <= 0) return res.status(400).json({ error: 'Ingresa un monto de pago válido.' });

      const metodo = METODOS_PAGO.includes(req.body.metodo) ? req.body.metodo : 'efectivo';
      const now = isoNow();
      const montoPagadoNuevo = Number(existing.montoPagado || 0) + monto;

      if (montoPagadoNuevo - existing.total > 0.01) {
        return res.status(400).json({ error: `El pago excede el saldo pendiente (RD$ ${fmtMoney(existing.total - existing.montoPagado)}).` });
      }

      const pago = { monto, fecha: now, metodo, nota: req.body.nota || null, registradoPor: req.adminUser.email };
      const estado = montoPagadoNuevo >= existing.total - 0.01 ? 'pagada' : 'parcial';

      await ref.update({
        pagos: [...(existing.pagos || []), pago],
        montoPagado: montoPagadoNuevo,
        estado,
        updatedAt: now,
      });

      await audit(req.adminUser.email, 'factura.pago', req.params.id, `${existing.numero} — RD$ ${fmtMoney(monto)} (${metodo})`);
      const updated = await ref.get();
      res.json(docData(updated));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/:id/anular', requireAuth, async (req, res) => {
    try {
      const motivo = String(req.body.motivo || '').trim();
      if (!motivo) return res.status(400).json({ error: 'Indica el motivo de anulación.' });

      const ref = col(COL_FACTURAS).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Factura no encontrada.' });
      const existing = doc.data();
      if (existing.estado === 'anulada') return res.status(400).json({ error: 'Esta factura ya está anulada.' });

      const now = isoNow();
      await ref.update({
        estado: 'anulada',
        motivoAnulacion: motivo,
        anuladaPor: req.adminUser.email,
        anuladaEn: now,
        updatedAt: now,
      });

      await audit(req.adminUser.email, 'factura.anular', req.params.id, `${existing.numero} — ${motivo}`);
      const updated = await ref.get();
      res.json(docData(updated));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.get('/:id/html', requireAuth, async (req, res) => {
    try {
      const doc = await col(COL_FACTURAS).doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: 'Factura no encontrada.' });
      const html = await buildInvoiceHtml(docData(doc), col);
      res.type('text/html').send(html);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/:id/pdf', requireAuth, async (req, res) => {
    let browser;
    try {
      const doc = await col(COL_FACTURAS).doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: 'Factura no encontrada.' });
      const factura = docData(doc);
      const html = await buildInvoiceHtml(factura, col);

      const puppeteer = require('puppeteer');
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
      await browser.close();
      browser = null;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${factura.numero}.pdf"`);
      res.send(pdf);
    } catch (e) {
      if (browser) { try { await browser.close(); } catch (_) {} }
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createFacturacionRouter };

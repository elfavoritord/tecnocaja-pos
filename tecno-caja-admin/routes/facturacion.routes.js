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
const { isConfigured: isMailerConfigured, fromAddress: mailerFrom, sendMail } = require('./mailer');

// Genera el PDF A4 de una factura con puppeteer. Reutilizado por /:id/pdf,
// /:id/enviar y el envío automático de suscripciones.
async function renderInvoicePdf(factura, col) {
  const html = await buildInvoiceHtml(factura, col);
  const puppeteer = require('puppeteer');
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
    return pdf;
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
}

const COL_FACTURAS = 'facturas';
const COL_NCF_SEQ = 'ncf_sequences';
const METODOS_PAGO = ['efectivo', 'transferencia', 'tarjeta', 'otro'];
const ESTADOS_EDITABLES = ['pendiente', 'parcial'];

// Tipos de NCF (comprobante fiscal) que Emilio le emite a sus clientes del POS.
const NCF_TIPOS = {
  B01: 'Crédito Fiscal',
  B02: 'Consumo',
  B04: 'Nota de Crédito',
  B15: 'Gubernamental',
};
// Tipos que exigen RNC/Cédula del receptor según DGII.
const NCF_TIPOS_REQUIEREN_RNC = ['B01', 'B15'];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// NCF moderno (11 posiciones): letra + 2 dígitos de tipo + 8 dígitos secuenciales.
function formatNcf(prefijo, num) {
  return `${prefijo}${String(num).padStart(8, '0')}`;
}

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

const METODO_LABEL = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia bancaria',
  tarjeta: 'Tarjeta',
  otro: 'Otro',
};

// Monto en letras — estilo formal dominicano ("MIL QUINIENTOS PESOS DOMINICANOS CON 00/100").
function numeroALetras(num) {
  const UNIDADES = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ',
    'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE'];
  const DECENAS = ['', '', 'VEINTI', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  const CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

  function seccion(n) { // 0..999
    if (n === 0) return '';
    if (n === 100) return 'CIEN';
    let t = '';
    const c = Math.floor(n / 100);
    const resto = n % 100;
    if (c) t += CENTENAS[c] + ' ';
    if (resto <= 20) {
      t += UNIDADES[resto];
    } else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      if (d === 2) t += 'VEINTI' + (u ? UNIDADES[u] : '');
      else t += DECENAS[d] + (u ? ' Y ' + UNIDADES[u] : '');
    }
    return t.trim();
  }

  function convert(n) {
    n = Math.floor(n);
    if (n === 0) return 'CERO';
    let out = '';
    const millones = Math.floor(n / 1e6);
    const miles = Math.floor((n % 1e6) / 1000);
    const cientos = n % 1000;
    if (millones) out += (millones === 1 ? 'UN MILLÓN ' : seccion(millones) + ' MILLONES ');
    if (miles) out += (miles === 1 ? 'MIL ' : seccion(miles) + ' MIL ');
    if (cientos) out += seccion(cientos);
    return out.trim().replace(/\s+/g, ' ');
  }

  const entero = Math.floor(Math.abs(Number(num) || 0));
  const centavos = Math.round((Math.abs(Number(num) || 0) - entero) * 100);
  return `${convert(entero)} PESOS DOMINICANOS CON ${String(centavos).padStart(2, '0')}/100`;
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

// Asigna atómicamente el próximo NCF disponible del tipo indicado.
// Lanza error si no hay una secuencia vigente con números libres — el NCF es
// obligatorio para poder emitir la factura.
async function assignNextNcf(col, tipo) {
  const t = String(tipo || '').toUpperCase().trim();
  if (!/^B\d{2}$/.test(t)) throw new Error('Selecciona un tipo de comprobante fiscal (NCF) válido.');

  const hoy = todayIso();
  const snap = await col(COL_NCF_SEQ).where('tipo', '==', t).get();
  const candidatas = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => s.activa !== false
      && (!s.vencimiento || String(s.vencimiento).slice(0, 10) >= hoy)
      && (Number(s.siguiente) || Number(s.desde) || 1) <= (Number(s.hasta) || 0))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  if (!candidatas.length) {
    throw new Error(`No hay una secuencia NCF ${t} vigente con comprobantes disponibles. Regístrala en Configuración → Comprobantes fiscales (NCF).`);
  }

  const ref = col(COL_NCF_SEQ).doc(candidatas[0].id);
  return ref.firestore.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const s = doc.data();
    const num = Number(s.siguiente) || Number(s.desde) || 1;
    if (num > (Number(s.hasta) || 0)) {
      throw new Error(`La secuencia NCF ${t} se agotó. Registra una nueva autorización de DGII.`);
    }
    const ncf = formatNcf(s.prefijo || t, num);
    const agotada = num >= (Number(s.hasta) || 0);
    tx.update(ref, {
      siguiente: num + 1,
      ...(agotada ? { activa: false, agotadaAt: new Date().toISOString() } : {}),
    });
    return { ncf, ncfTipo: t, ncfVencimiento: s.vencimiento ? String(s.vencimiento).slice(0, 10) : null, ncfSecuenciaId: candidatas[0].id };
  });
}

async function buildInvoiceHtml(factura, col, { print = false } = {}) {
  const emisor = await getEmisorConfig(col);
  const estadoLabel = { pendiente: 'PENDIENTE DE PAGO', parcial: 'PAGO PARCIAL', pagada: 'PAGADA', anulada: 'ANULADA' }[factura.estado] || String(factura.estado || '').toUpperCase();

  // El QR abre el correo del cliente con una reclamación/duda del pago ya
  // redactada (mailto:). Si no hay correo de destino configurado, cae en el
  // texto de verificación de siempre.
  const claimsEmail = emisor.correo || process.env.ADMIN_CLAIMS_EMAIL || process.env.GMAIL_USER || '';
  const mailSubject = `Duda de pago - Factura ${factura.numero}`;
  const mailBody = [
    `Factura: ${factura.numero}`,
    `NCF: ${factura.ncf || '-'}`,
    `Total: RD$ ${fmtMoney(factura.total)}`,
    ``,
    `Escriba su duda o reclamacion sobre este pago:`,
    ``,
  ].join('\r\n');
  const qrTarget = claimsEmail
    ? `mailto:${claimsEmail}?subject=${encodeURIComponent(mailSubject)}&body=${encodeURIComponent(mailBody)}`
    : `Factura ${factura.numero} | ${emisor.nombre} | RD$ ${fmtMoney(factura.total)} | ${formatDateOnly(factura.fechaEmision)}`;
  const qrDataUrl = await QRCode.toDataURL(qrTarget, {
    width: 220, margin: 0, errorCorrectionLevel: 'L', color: { dark: '#111827', light: '#ffffff' },
  });

  const itemsHtml = (factura.items || []).map((it, i) => `
    <tr>
      <td class="c-idx">${i + 1}</td>
      <td class="c-desc">${escapeHtml(it.descripcion)}</td>
      <td class="c-num">${escapeHtml(it.cantidad)}</td>
      <td class="c-num">${fmtMoney(it.precioUnitario)}</td>
      <td class="c-num">${fmtMoney(it.monto)}</td>
    </tr>`).join('');

  // logoDataUrl es un data: URI generado por nosotros (base64), no texto de
  // usuario — no se escapa para no corromper el base64.
  const logoHtml = emisor.logoDataUrl
    ? `<img src="${emisor.logoDataUrl}" class="logo" alt="${escapeHtml(emisor.nombre)}" />`
    : `<div class="brand-fallback">${escapeHtml(emisor.nombre)}</div>`;

  const saldoPendiente = factura.total - (factura.montoPagado || 0);
  const metodoLabel = METODO_LABEL[factura.metodoPago] || 'Efectivo';
  const printScript = print ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},250)});</scr' + 'ipt>' : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(factura.numero)} — Factura</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #eef1f4; }
  body { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 10.5px; color: #1f2937; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page {
    position: relative; width: 210mm; min-height: 297mm; margin: 0 auto;
    padding: 16mm 18mm; background: #fff; overflow: hidden;
  }
  .watermark {
    position: absolute; top: 45%; left: 50%; transform: translate(-50%,-50%) rotate(-24deg);
    font-size: 118px; font-weight: 800; letter-spacing: 6px; white-space: nowrap;
    color: rgba(220,38,38,.08); pointer-events: none; z-index: 0;
  }
  .content { position: relative; z-index: 1; }

  /* ── Encabezado ── */
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 14mm; padding-bottom: 6mm; }
  .logo { max-height: 32mm; max-width: 85mm; display: block; margin-bottom: 3mm; }
  .brand-fallback { font-size: 24px; font-weight: 800; color: #15803d; letter-spacing: .5px; margin-bottom: 3mm; }
  .emitter-line { font-size: 9.5px; line-height: 1.5; color: #4b5563; }
  .emitter-line strong { color: #1f2937; }
  .doc { text-align: right; min-width: 62mm; }
  .doc-title { font-size: 25px; font-weight: 800; letter-spacing: 4px; color: #15803d; line-height: 1; }
  .ncf-chip { display: inline-block; margin-top: 3mm; padding: 2mm 3mm; border: 1.5px solid #15803d; border-radius: 3px; font-size: 12px; font-weight: 800; letter-spacing: .5px; color: #111827; }
  .ncf-chip span { color: #15803d; font-weight: 700; letter-spacing: 1px; margin-right: 1.5mm; }
  .doc-meta { margin-top: 4mm; font-size: 10px; line-height: 1.7; color: #374151; }
  .doc-meta b { color: #111827; }
  .stamp {
    display: inline-block; margin-top: 3mm; padding: 3px 12px; border: 2px solid; border-radius: 3px;
    font-size: 10px; font-weight: 800; letter-spacing: 1.5px; transform: rotate(-3deg);
  }
  .stamp.pendiente, .stamp.parcial { color: #b45309; border-color: #b45309; }
  .stamp.pagada { color: #15803d; border-color: #15803d; }
  .stamp.anulada { color: #b91c1c; border-color: #b91c1c; }

  .rule { height: 2.5px; background: #15803d; margin: 0 0 6mm; }

  /* ── Datos cliente / pago ── */
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 12mm; margin-bottom: 7mm; }
  .block-label { font-size: 8.5px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: #6b7280; padding-bottom: 2mm; border-bottom: 1px solid #e5e7eb; margin-bottom: 2.5mm; }
  .party-name { font-size: 12px; font-weight: 700; color: #111827; margin-bottom: 1mm; }
  .party-line { font-size: 9.5px; line-height: 1.6; color: #4b5563; }
  .pay-row { display: flex; justify-content: space-between; font-size: 9.5px; line-height: 1.9; color: #4b5563; }
  .pay-row span:last-child { color: #111827; font-weight: 600; }

  /* ── Ítems ── */
  .items { width: 100%; border-collapse: collapse; margin-bottom: 4mm; }
  .items thead th {
    background: #f4f7f5; color: #374151; font-size: 8.5px; font-weight: 700; letter-spacing: .6px;
    text-transform: uppercase; text-align: right; padding: 3mm 2.5mm;
    border-top: 1.5px solid #15803d; border-bottom: 1.5px solid #15803d;
  }
  .items thead th.h-idx { text-align: center; width: 9mm; }
  .items thead th.h-desc { text-align: left; }
  .items tbody td { padding: 2.6mm 2.5mm; font-size: 10px; border-bottom: 1px solid #edf0f2; vertical-align: top; }
  .items tbody tr:last-child td { border-bottom: 1px solid #d1d5db; }
  .c-idx { text-align: center; color: #9ca3af; }
  .c-desc { text-align: left; color: #1f2937; }
  .c-num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }

  /* ── Totales ── */
  .totals-wrap { display: flex; justify-content: flex-end; }
  .totals { width: 78mm; }
  .totals .t-row { display: flex; justify-content: space-between; padding: 1.6mm 0; font-size: 10px; color: #4b5563; }
  .totals .t-row .val { color: #111827; font-variant-numeric: tabular-nums; }
  .totals .t-total { border-top: 2px solid #111827; margin-top: 1mm; padding-top: 2.5mm; font-size: 14px; font-weight: 800; color: #111827; }
  .totals .t-paid { color: #15803d; }
  .totals .t-due { font-weight: 700; color: #b45309; }

  .amount-words { margin: 5mm 0 0; padding: 2.5mm 3mm; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 3px; font-size: 9.5px; line-height: 1.5; color: #374151; }
  .amount-words b { color: #111827; letter-spacing: .3px; }

  .notes { margin-top: 6mm; }
  .notes .block-label { display: inline-block; }
  .notes p { font-size: 9.5px; line-height: 1.6; color: #4b5563; margin-top: 2mm; white-space: pre-wrap; }

  /* ── Pie ── */
  .foot { display: grid; grid-template-columns: 32mm 1fr; gap: 8mm; align-items: center; margin-top: 12mm; padding-top: 5mm; border-top: 1px solid #e5e7eb; }
  .foot img { width: 30mm; height: 30mm; display: block; }
  .foot .qr-cap { font-size: 8px; line-height: 1.3; color: #9ca3af; margin-top: 1.5mm; text-align: center; width: 30mm; }
  .foot .terms { font-size: 8.5px; line-height: 1.6; color: #6b7280; }
  .foot .terms b { display: block; color: #15803d; font-size: 10px; margin-bottom: 1mm; letter-spacing: .3px; }

  @page { size: A4; margin: 0; }
  @media print { html, body { background: #fff; } .page { margin: 0; box-shadow: none; } }
</style>
</head>
<body>
<div class="page">
  ${factura.estado === 'anulada' ? '<div class="watermark">ANULADA</div>' : ''}
  <div class="content">

    <div class="head">
      <div class="emitter">
        ${logoHtml}
        ${emisor.rnc ? `<div class="emitter-line"><strong>RNC:</strong> ${escapeHtml(emisor.rnc)}</div>` : ''}
        ${emisor.direccion ? `<div class="emitter-line">${escapeHtml(emisor.direccion)}</div>` : ''}
        ${emisor.telefono ? `<div class="emitter-line"><strong>Tel:</strong> ${escapeHtml(emisor.telefono)}</div>` : ''}
        ${emisor.correo ? `<div class="emitter-line">${escapeHtml(emisor.correo)}</div>` : ''}
      </div>
      <div class="doc">
        <div class="doc-title">FACTURA</div>
        ${factura.ncf ? `<div class="ncf-chip"><span>NCF</span> ${escapeHtml(factura.ncf)}</div>` : ''}
        <div class="doc-meta">
          ${factura.ncf ? `<div><b>Tipo de comprobante:</b> ${escapeHtml((NCF_TIPOS[factura.ncfTipo] || factura.ncfTipo || '') + (factura.ncfTipo ? ' (' + factura.ncfTipo + ')' : ''))}</div>` : ''}
          <div><b>No. interno:</b> ${escapeHtml(factura.numero)}</div>
          <div><b>Fecha de emisión:</b> ${escapeHtml(formatDateOnly(factura.fechaEmision))}</div>
          ${factura.fechaVencimiento ? `<div><b>Vencimiento:</b> ${escapeHtml(formatDateOnly(factura.fechaVencimiento))}</div>` : ''}
          ${factura.ncfVencimiento ? `<div><b>NCF válido hasta:</b> ${escapeHtml(formatDateOnly(factura.ncfVencimiento))}</div>` : ''}
        </div>
        <div class="stamp ${factura.estado}">${escapeHtml(estadoLabel)}</div>
      </div>
    </div>

    <div class="rule"></div>

    <div class="parties">
      <div>
        <div class="block-label">Facturar a</div>
        <div class="party-name">${escapeHtml(factura.clienteNombre)}</div>
        ${factura.clienteRnc ? `<div class="party-line">RNC / Cédula: ${escapeHtml(factura.clienteRnc)}</div>` : ''}
        ${factura.clienteDireccion ? `<div class="party-line">${escapeHtml(factura.clienteDireccion)}</div>` : ''}
        ${factura.clienteTelefono ? `<div class="party-line">Tel: ${escapeHtml(factura.clienteTelefono)}</div>` : ''}
        ${factura.clienteEmail ? `<div class="party-line">${escapeHtml(factura.clienteEmail)}</div>` : ''}
      </div>
      <div>
        <div class="block-label">Detalles de pago</div>
        <div class="pay-row"><span>Método de pago</span><span>${escapeHtml(metodoLabel)}</span></div>
        <div class="pay-row"><span>Estado</span><span>${escapeHtml(estadoLabel)}</span></div>
        ${factura.montoPagado ? `<div class="pay-row"><span>Pagado a la fecha</span><span>RD$ ${fmtMoney(factura.montoPagado)}</span></div>` : ''}
        ${saldoPendiente > 0.01 && factura.estado !== 'anulada' ? `<div class="pay-row"><span>Saldo pendiente</span><span>RD$ ${fmtMoney(saldoPendiente)}</span></div>` : ''}
      </div>
    </div>

    <table class="items">
      <thead>
        <tr>
          <th class="h-idx">#</th>
          <th class="h-desc">Descripción</th>
          <th>Cant.</th>
          <th>Precio unit.</th>
          <th>Importe</th>
        </tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>

    <div class="totals-wrap">
      <div class="totals">
        <div class="t-row"><span>Subtotal</span><span class="val">RD$ ${fmtMoney(factura.subtotal)}</span></div>
        ${factura.descuento ? `<div class="t-row"><span>Descuento</span><span class="val">- RD$ ${fmtMoney(factura.descuento)}</span></div>` : ''}
        ${factura.aplicaItbis ? `<div class="t-row"><span>ITBIS (${Math.round((factura.tasaItbis || 0) * 100)}%)</span><span class="val">RD$ ${fmtMoney(factura.itbis)}</span></div>` : ''}
        <div class="t-row t-total"><span>TOTAL</span><span class="val">RD$ ${fmtMoney(factura.total)}</span></div>
        ${factura.montoPagado ? `<div class="t-row t-paid"><span>Pagado</span><span class="val">RD$ ${fmtMoney(factura.montoPagado)}</span></div>` : ''}
        ${saldoPendiente > 0.01 && factura.estado !== 'anulada' ? `<div class="t-row t-due"><span>Saldo pendiente</span><span class="val">RD$ ${fmtMoney(saldoPendiente)}</span></div>` : ''}
      </div>
    </div>

    <div class="amount-words"><b>Son:</b> ${escapeHtml(numeroALetras(factura.total))}</div>

    ${factura.notas ? `<div class="notes"><span class="block-label">Notas</span><p>${escapeHtml(factura.notas)}</p></div>` : ''}

    <div class="foot">
      <div>
        <img src="${qrDataUrl}" alt="QR — enviar duda o reclamación" />
        <div class="qr-cap">¿Dudas con el pago?<br>Escanee para escribirnos</div>
      </div>
      <div class="terms">
        <b>${escapeHtml(emisor.nombre)}</b>
        Esta factura ampara servicios de la plataforma Tecno Caja (licencias, suscripciones, instalación y soporte). Documento generado electrónicamente; válido sin firma ni sello. Gracias por su preferencia.
      </div>
    </div>

  </div>
</div>
${printScript}
</body>
</html>`;
}

// Crea una factura (valida, asigna NCF, guarda, audita). Reutilizada por el
// POST /api/facturas y por el generador de suscripciones recurrentes.
// Lanza Error con `.status` (400/404) ante datos inválidos.
async function crearFactura({ col, isoNow, audit, licenciasCollection, docData }, body, actorEmail) {
  const { negocioId, clienteNombre, clienteRnc, clienteTelefono, clienteDireccion, clienteEmail,
    items, aplicaItbis, tasaItbis, descuento, metodoPago, fechaVencimiento, notas, tipoNcf,
    origen, suscripcionId, periodo } = body;

  const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };

  if (!negocioId) throw fail('Selecciona un negocio/cliente.');
  if (!String(clienteNombre || '').trim()) throw fail('El nombre del cliente es obligatorio.');

  const tipo = String(tipoNcf || '').toUpperCase().trim();
  if (!NCF_TIPOS[tipo]) throw fail('Selecciona el tipo de comprobante fiscal (NCF).');
  if (NCF_TIPOS_REQUIEREN_RNC.includes(tipo) && !String(clienteRnc || '').trim()) {
    throw fail(`El comprobante ${tipo} (${NCF_TIPOS[tipo]}) exige el RNC/Cédula del cliente.`);
  }

  const negDoc = await col(licenciasCollection).doc(negocioId).get();
  if (!negDoc.exists) throw fail('El negocio seleccionado no existe.', 404);

  const normItems = normalizeItems(items);
  const aplicaItbisBool = aplicaItbis !== false;
  const tasa = Number.isFinite(Number(tasaItbis)) ? Number(tasaItbis) : 0.18;
  const desc = Number(descuento) || 0;
  const { subtotal, itbis, total } = computeTotals(normItems, { aplicaItbis: aplicaItbisBool, tasaItbis: tasa, descuento: desc });

  // Asigna el NCF ANTES de crear la factura: si no hay secuencia vigente, aborta
  // y no se crea nada (NCF obligatorio).
  const ncfInfo = await assignNextNcf(col, tipo);

  const numero = await nextInvoiceNumber(col);
  const now = isoNow();

  const data = {
    numero, negocioId,
    ncf: ncfInfo.ncf,
    ncfTipo: ncfInfo.ncfTipo,
    ncfVencimiento: ncfInfo.ncfVencimiento,
    ncfSecuenciaId: ncfInfo.ncfSecuenciaId,
    clienteNombre: String(clienteNombre).trim(),
    clienteRnc: clienteRnc || null,
    clienteTelefono: clienteTelefono || null,
    clienteDireccion: clienteDireccion || null,
    clienteEmail: clienteEmail || null,
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
    origen: origen || 'manual',
    ...(suscripcionId ? { suscripcionId } : {}),
    ...(periodo ? { periodo } : {}),
    createdBy: actorEmail,
    createdAt: now, updatedAt: now,
  };

  const ref = await col(COL_FACTURAS).add(data);
  await audit(actorEmail, 'factura.crear', ref.id,
    `${numero} — NCF ${ncfInfo.ncf} — ${data.clienteNombre} — RD$ ${fmtMoney(total)}${origen === 'suscripcion' ? ' (recurrente)' : ''}`);
  const doc = await ref.get();
  return docData(doc);
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

  // Estado de la configuración de envío por correo (para mostrar/ocultar el botón).
  router.get('/config/email', requireAuth, (_req, res) => {
    res.json({ configured: isMailerConfigured(), from: isMailerConfigured() ? mailerFrom() : null });
  });

  // ── Secuencias de NCF autorizadas por la DGII ────────────────────────────
  // Van antes de '/:id' para que Express no interprete "config" como id.
  router.get('/config/ncf', requireAuth, async (_req, res) => {
    try {
      const snap = await col(COL_NCF_SEQ).get();
      const hoy = todayIso();
      const list = snap.docs.map(d => {
        const s = { id: d.id, ...d.data() };
        const siguiente = Number(s.siguiente) || Number(s.desde) || 1;
        const disponibles = Math.max(0, (Number(s.hasta) || 0) - siguiente + 1);
        const vencida = s.vencimiento && String(s.vencimiento).slice(0, 10) < hoy;
        return {
          ...s,
          siguiente,
          disponibles,
          vencida,
          usable: s.activa !== false && !vencida && disponibles > 0,
          proximoNcf: disponibles > 0 ? formatNcf(s.prefijo || s.tipo, siguiente) : null,
          tipoLabel: NCF_TIPOS[s.tipo] || s.tipo,
        };
      }).sort((a, b) => String(a.tipo).localeCompare(String(b.tipo)) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      res.json(list);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/config/ncf', requireAuth, async (req, res) => {
    try {
      const tipo = String(req.body.tipo || '').toUpperCase().trim();
      const prefijo = String(req.body.prefijo || tipo).toUpperCase().trim();
      const desde = parseInt(req.body.desde, 10);
      const hasta = parseInt(req.body.hasta, 10);
      const vencimiento = String(req.body.vencimiento || '').slice(0, 10);

      if (!/^B\d{2}$/.test(tipo)) return res.status(400).json({ error: 'Tipo de NCF inválido (ej. B01, B02, B04, B15).' });
      if (!/^B\d{2}$/.test(prefijo)) return res.status(400).json({ error: 'Prefijo de NCF inválido.' });
      if (!Number.isInteger(desde) || desde < 1) return res.status(400).json({ error: 'El número "desde" debe ser un entero mayor a 0.' });
      if (!Number.isInteger(hasta) || hasta < desde) return res.status(400).json({ error: 'El número "hasta" debe ser mayor o igual a "desde".' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimiento)) return res.status(400).json({ error: 'Indica la fecha de vencimiento de la autorización.' });

      const now = isoNow();
      const ref = await col(COL_NCF_SEQ).add({
        tipo, prefijo, desde, hasta, siguiente: desde, vencimiento,
        activa: true, createdBy: req.adminUser.email, createdAt: now, updatedAt: now,
      });
      await audit(req.adminUser.email, 'ncf.secuencia.crear', ref.id, `${tipo} ${desde}-${hasta} vence ${vencimiento}`);
      res.status(201).json({ ok: true, id: ref.id });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.put('/config/ncf/:id', requireAuth, async (req, res) => {
    try {
      const ref = col(COL_NCF_SEQ).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Secuencia no encontrada.' });
      const cur = doc.data();
      const usados = (Number(cur.siguiente) || Number(cur.desde) || 1) - 1;
      const update = { updatedAt: isoNow() };

      if (req.body.hasta != null && req.body.hasta !== '') {
        const hasta = parseInt(req.body.hasta, 10);
        if (!Number.isInteger(hasta) || hasta < usados) {
          return res.status(400).json({ error: `El nuevo "hasta" no puede ser menor a los ${usados} comprobantes ya emitidos.` });
        }
        update.hasta = hasta;
        if (cur.activa === false && hasta >= (Number(cur.siguiente) || cur.desde)) update.activa = true;
      }
      if (req.body.vencimiento != null && req.body.vencimiento !== '') {
        const v = String(req.body.vencimiento).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return res.status(400).json({ error: 'Fecha de vencimiento inválida.' });
        update.vencimiento = v;
      }
      if (req.body.activa != null) update.activa = Boolean(req.body.activa);

      await ref.update(update);
      await audit(req.adminUser.email, 'ncf.secuencia.editar', req.params.id, JSON.stringify(update));
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.delete('/config/ncf/:id', requireAuth, async (req, res) => {
    try {
      const ref = col(COL_NCF_SEQ).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Secuencia no encontrada.' });
      const s = doc.data();
      if ((Number(s.siguiente) || Number(s.desde) || 1) > (Number(s.desde) || 1)) {
        return res.status(400).json({ error: 'No se puede eliminar una secuencia que ya emitió comprobantes. Desactívala en su lugar.' });
      }
      await ref.delete();
      await audit(req.adminUser.email, 'ncf.secuencia.eliminar', req.params.id, `${s.tipo} ${s.desde}-${s.hasta}`);
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
      const factura = await crearFactura(
        { col, isoNow, audit, licenciasCollection, docData },
        req.body,
        req.adminUser.email
      );
      res.status(201).json(factura);
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
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

      const { clienteNombre, clienteRnc, clienteTelefono, clienteDireccion, clienteEmail,
        items, aplicaItbis, tasaItbis, descuento, metodoPago, fechaVencimiento, notas } = req.body;

      // El NCF ya asignado no cambia al editar. Pero un comprobante B01/B15 no
      // puede quedar sin RNC del cliente.
      const rncFinal = clienteRnc ?? existing.clienteRnc;
      if (NCF_TIPOS_REQUIEREN_RNC.includes(existing.ncfTipo) && !String(rncFinal || '').trim()) {
        return res.status(400).json({ error: `El comprobante ${existing.ncfTipo} exige el RNC/Cédula del cliente.` });
      }

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
        clienteEmail: clienteEmail ?? existing.clienteEmail ?? null,
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
      const html = await buildInvoiceHtml(docData(doc), col, { print: req.query.print === '1' });
      res.type('text/html').send(html);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/:id/pdf', requireAuth, async (req, res) => {
    try {
      const doc = await col(COL_FACTURAS).doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: 'Factura no encontrada.' });
      const factura = docData(doc);
      const pdf = await renderInvoicePdf(factura, col);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${factura.numero}.pdf"`);
      res.send(pdf);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Enviar la factura por correo (Gmail SMTP) con el PDF adjunto.
  router.post('/:id/enviar', requireAuth, async (req, res) => {
    try {
      if (!isMailerConfigured()) {
        return res.status(503).json({ error: 'El envío por correo no está configurado. Agrega GMAIL_USER y GMAIL_APP_PASSWORD en tecno-caja-admin/.env' });
      }
      const ref = col(COL_FACTURAS).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Factura no encontrada.' });
      const factura = docData(doc);

      const to = String(req.body.to || factura.clienteEmail || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return res.status(400).json({ error: 'Indica un correo de destino válido (el cliente no tiene correo guardado).' });
      }

      const emisor = await getEmisorConfig(col);
      const pdf = await renderInvoicePdf(factura, col);

      const saldo = factura.total - (factura.montoPagado || 0);
      const mensajeExtra = String(req.body.mensaje || '').trim();
      const lineas = [
        `Estimado(a) ${factura.clienteNombre},`,
        '',
        `Adjuntamos la factura ${factura.numero}${factura.ncf ? ` (NCF ${factura.ncf})` : ''} por un total de RD$ ${fmtMoney(factura.total)}.`,
        factura.fechaVencimiento ? `Fecha de vencimiento: ${formatDateOnly(factura.fechaVencimiento)}.` : '',
        saldo > 0.01 && factura.estado !== 'anulada' ? `Saldo pendiente: RD$ ${fmtMoney(saldo)}.` : '',
        mensajeExtra ? `\n${mensajeExtra}` : '',
        '',
        `Gracias por su preferencia.`,
        emisor.nombre,
        emisor.telefono || '',
        emisor.correo || '',
      ].filter(Boolean);
      const text = lineas.join('\n');
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;line-height:1.6">
        ${lineas.map(l => l === '' ? '<br>' : `<p style="margin:0 0 6px">${escapeHtml(l)}</p>`).join('')}
      </div>`;

      const subject = `Factura ${factura.numero}${factura.ncf ? ` · NCF ${factura.ncf}` : ''} — ${emisor.nombre}`;
      const result = await sendMail({ to, subject, text, html, attachmentBuffer: pdf, attachmentName: `${factura.numero}.pdf` });

      const now = isoNow();
      const registro = { to, fecha: now, por: req.adminUser.email, messageId: result.messageId || null };
      await ref.update({
        emailsEnviados: [...(factura.emailsEnviados || []), registro],
        ultimoEmailA: to,
        ultimoEmailEn: now,
        updatedAt: now,
      });
      await audit(req.adminUser.email, 'factura.enviar_correo', req.params.id, `${factura.numero} → ${to}`);

      res.json({ ok: true, to, messageId: result.messageId || null });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  return router;
}

// Genérico: renderiza cualquier HTML a PDF A4 (para reportes fuera de facturas).
async function htmlToPdf(html) {
  const puppeteer = require('puppeteer');
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
}

module.exports = {
  createFacturacionRouter, buildInvoiceHtml, numeroALetras, crearFactura,
  renderInvoicePdf, htmlToPdf, getEmisorConfig, escapeHtml, fmtMoney, formatDateOnly,
};

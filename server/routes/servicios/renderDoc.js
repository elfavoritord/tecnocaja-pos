'use strict';

/**
 * renderDoc.js — Documentos formales del modo Empresas de Servicios.
 *   A4  → factura y cotización con diseño formal (logo, sello, "Son:" en letras).
 *   80mm / 58mm → ticket térmico.
 * El envío por correo usa SIEMPRE A4.
 */

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(n) {
  return 'RD$ ' + (Number(n) || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fdate(v) {
  if (!v) return '';
  // Acepta Date, "2026-09-02", "2026-09-02T04:00:00.000Z", timestamps, etc.
  let iso;
  if (v instanceof Date) {
    iso = Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  } else {
    const str = String(v).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
    if (m) iso = `${m[1]}-${m[2]}-${m[3]}`;
    else {
      const d = new Date(str);
      iso = Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
    }
  }
  if (!iso) return String(v);
  const [y, mo, da] = iso.split('-');
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return `${Number(da)} de ${MESES[Number(mo) - 1] || mo} de ${y}`;
}

const U = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ',
  'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE'];
const D = ['', '', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const C = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];
function seccion(n) {
  if (n === 0) return '';
  if (n < 20) return U[n];
  if (n < 100) {
    const d = Math.floor(n / 10); const u = n % 10;
    if (n === 20) return 'VEINTE';
    if (d === 2) return 'VEINTI' + U[u];
    return D[d] + (u ? ' Y ' + U[u] : '');
  }
  if (n === 100) return 'CIEN';
  const c = Math.floor(n / 100); const r = n % 100;
  return C[c] + (r ? ' ' + seccion(r) : '');
}
function numeroALetras(valor) {
  const num = Math.floor(Math.abs(Number(valor) || 0));
  const cent = Math.round((Math.abs(Number(valor) || 0) - num) * 100);
  let palabras;
  if (num === 0) palabras = 'CERO';
  else {
    const mill = Math.floor(num / 1000000);
    const miles = Math.floor((num % 1000000) / 1000);
    const resto = num % 1000;
    const p = [];
    if (mill) p.push(mill === 1 ? 'UN MILLÓN' : seccion(mill) + ' MILLONES');
    if (miles) p.push(miles === 1 ? 'MIL' : seccion(miles) + ' MIL');
    if (resto) p.push(seccion(resto));
    palabras = p.join(' ').trim() || 'CERO';
  }
  return `${palabras} PESOS DOMINICANOS CON ${String(cent).padStart(2, '0')}/100`;
}

// ── A4 formal (factura / cotización) ──────────────────────────────────────
function renderFormalA4(doc) {
  const { empresa = {}, invoice = {}, items = [] } = doc;
  const isCot = invoice.docType === 'cotizacion';
  const titulo = isCot ? 'COTIZACIÓN' : 'FACTURA';
  const estado = String(invoice.estado || '').toLowerCase();
  const estadoLabel = {
    borrador: 'BORRADOR', enviada: 'ENVIADA', aprobada: 'APROBADA', rechazada: 'RECHAZADA',
    vencida: 'VENCIDA', convertida: 'CONVERTIDA EN FACTURA',
    pendiente: 'PENDIENTE DE PAGO', parcial: 'PAGO PARCIAL', pagada: 'PAGADA', anulada: 'ANULADA',
  }[estado] || (invoice.estado || '').toUpperCase();
  const stampClass = ['pagada', 'aprobada', 'convertida'].includes(estado) ? 'ok'
    : ['anulada', 'rechazada', 'vencida'].includes(estado) ? 'bad' : 'warn';
  const anulada = estado === 'anulada' || estado === 'rechazada';
  const logoHtml = empresa.logo
    ? `<img src="${empresa.logo}" class="logo" alt="logo">`
    : `<div class="brand-fallback">${esc(empresa.nombre || 'Empresa')}</div>`;

  const rows = items.map((it, i) => `
    <tr>
      <td class="c-idx">${i + 1}</td>
      <td class="c-desc">${esc(it.descripcion)}</td>
      <td class="c-num">${Number(it.cantidad || 0)}</td>
      <td class="c-num">${money(it.precio)}</td>
      <td class="c-num">${Number(it.descuentoPct || 0) ? Number(it.descuentoPct).toFixed(0) + '%' : '—'}</td>
      <td class="c-num">${Number(it.itbisPct || 0) ? Number(it.itbisPct).toFixed(0) + '%' : '—'}</td>
      <td class="c-num">${money(it.total)}</td>
    </tr>`).join('');

  const footerNote = isCot
    ? 'Cotización sin valor fiscal. Precios sujetos a cambio después de la fecha de validez. Documento generado electrónicamente.'
    : 'Factura por servicios profesionales. Documento generado electrónicamente; válido sin firma ni sello. Gracias por su preferencia.';

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>${esc(invoice.numero)} — ${titulo}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { background:#eef1f4; }
  body { font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif; font-size:10.5px; color:#1f2937; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .page { position:relative; width:210mm; min-height:297mm; margin:0 auto; padding:16mm 18mm; background:#fff; overflow:hidden; }
  .watermark { position:absolute; top:45%; left:50%; transform:translate(-50%,-50%) rotate(-24deg); font-size:110px; font-weight:800; letter-spacing:6px; white-space:nowrap; color:rgba(220,38,38,.08); pointer-events:none; z-index:0; }
  .content { position:relative; z-index:1; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; gap:14mm; padding-bottom:6mm; }
  .logo { max-height:30mm; max-width:80mm; display:block; margin-bottom:3mm; }
  .brand-fallback { font-size:22px; font-weight:800; color:#15803d; letter-spacing:.5px; margin-bottom:3mm; }
  .emitter-line { font-size:9.5px; line-height:1.5; color:#4b5563; }
  .emitter-line strong { color:#1f2937; }
  .doc { text-align:right; min-width:62mm; }
  .doc-title { font-size:24px; font-weight:800; letter-spacing:4px; color:#15803d; line-height:1; }
  .ncf-chip { display:inline-block; margin-top:3mm; padding:2mm 3mm; border:1.5px solid #15803d; border-radius:3px; font-size:12px; font-weight:800; letter-spacing:.5px; color:#111827; }
  .ncf-chip span { color:#15803d; font-weight:700; letter-spacing:1px; margin-right:1.5mm; }
  .doc-meta { margin-top:4mm; font-size:10px; line-height:1.7; color:#374151; }
  .doc-meta b { color:#111827; }
  .stamp { display:inline-block; margin-top:3mm; padding:3px 12px; border:2px solid; border-radius:3px; font-size:10px; font-weight:800; letter-spacing:1.5px; transform:rotate(-3deg); }
  .stamp.warn { color:#b45309; border-color:#b45309; }
  .stamp.ok { color:#15803d; border-color:#15803d; }
  .stamp.bad { color:#b91c1c; border-color:#b91c1c; }
  .rule { height:2.5px; background:#15803d; margin:0 0 6mm; }
  .parties { display:grid; grid-template-columns:1fr 1fr; gap:12mm; margin-bottom:7mm; }
  .block-label { font-size:8.5px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:#6b7280; padding-bottom:2mm; border-bottom:1px solid #e5e7eb; margin-bottom:2.5mm; }
  .party-name { font-size:12px; font-weight:700; color:#111827; margin-bottom:1mm; }
  .party-line { font-size:9.5px; line-height:1.6; color:#4b5563; }
  .pay-row { display:flex; justify-content:space-between; font-size:9.5px; line-height:1.9; color:#4b5563; }
  .pay-row span:last-child { color:#111827; font-weight:600; }
  .items { width:100%; border-collapse:collapse; margin-bottom:4mm; }
  .items thead th { background:#f4f7f5; color:#374151; font-size:8.5px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; text-align:right; padding:3mm 2.5mm; border-top:1.5px solid #15803d; border-bottom:1.5px solid #15803d; }
  .items thead th.h-idx { text-align:center; width:9mm; }
  .items thead th.h-desc { text-align:left; }
  .items tbody td { padding:2.6mm 2.5mm; font-size:10px; border-bottom:1px solid #edf0f2; vertical-align:top; }
  .items tbody tr:last-child td { border-bottom:1px solid #d1d5db; }
  .c-idx { text-align:center; color:#9ca3af; }
  .c-desc { text-align:left; color:#1f2937; }
  .c-num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .totals-wrap { display:flex; justify-content:flex-end; }
  .totals { width:78mm; }
  .totals .t-row { display:flex; justify-content:space-between; padding:1.6mm 0; font-size:10px; color:#4b5563; }
  .totals .t-row .val { color:#111827; font-variant-numeric:tabular-nums; }
  .totals .t-total { border-top:2px solid #111827; margin-top:1mm; padding-top:2.5mm; font-size:14px; font-weight:800; color:#111827; }
  .totals .t-paid { color:#15803d; }
  .totals .t-due { font-weight:700; color:#b45309; }
  .amount-words { margin:5mm 0 0; padding:2.5mm 3mm; background:#f9fafb; border:1px solid #e5e7eb; border-radius:3px; font-size:9.5px; line-height:1.5; color:#374151; }
  .amount-words b { color:#111827; letter-spacing:.3px; }
  .notes { margin-top:6mm; }
  .notes p { font-size:9.5px; line-height:1.6; color:#4b5563; margin-top:2mm; white-space:pre-wrap; }
  .foot { margin-top:12mm; padding-top:5mm; border-top:1px solid #e5e7eb; font-size:8.5px; line-height:1.6; color:#6b7280; }
  .foot b { display:block; color:#15803d; font-size:10px; margin-bottom:1mm; letter-spacing:.3px; }
  .sign { display:grid; grid-template-columns:1fr 1fr; gap:20mm; margin-top:14mm; }
  .sign .line { border-top:1px solid #9ca3af; padding-top:1.5mm; text-align:center; font-size:9px; color:#6b7280; }
  @page { size:A4; margin:0; }
  @media print { html, body { background:#fff; } .page { margin:0; box-shadow:none; } }
</style></head>
<body><div class="page">
  ${anulada ? `<div class="watermark">${estado === 'rechazada' ? 'RECHAZADA' : 'ANULADA'}</div>` : ''}
  <div class="content">
    <div class="head">
      <div class="emitter">
        ${logoHtml}
        ${empresa.rnc ? `<div class="emitter-line"><strong>RNC:</strong> ${esc(empresa.rnc)}</div>` : ''}
        ${empresa.direccion ? `<div class="emitter-line">${esc(empresa.direccion)}</div>` : ''}
        ${empresa.telefono ? `<div class="emitter-line"><strong>Tel:</strong> ${esc(empresa.telefono)}</div>` : ''}
        ${empresa.correo ? `<div class="emitter-line">${esc(empresa.correo)}</div>` : ''}
      </div>
      <div class="doc">
        <div class="doc-title">${titulo}</div>
        ${invoice.ncf ? `<div class="ncf-chip"><span>${invoice.fiscalMode === 'ecf' ? 'e-NCF' : 'NCF'}</span> ${esc(invoice.ncf)}</div>` : ''}
        <div class="doc-meta">
          <div><b>No.:</b> ${esc(invoice.numero)}</div>
          <div><b>Fecha:</b> ${esc(fdate(invoice.fecha))}</div>
          ${isCot && invoice.validezDias ? `<div><b>Válida por:</b> ${esc(invoice.validezDias)} días</div>` : ''}
          ${!isCot && invoice.vencimiento ? `<div><b>Vencimiento:</b> ${esc(fdate(invoice.vencimiento))}</div>` : ''}
          ${invoice.ncfVencimiento ? `<div><b>NCF válido hasta:</b> ${esc(fdate(invoice.ncfVencimiento))}</div>` : ''}
        </div>
        <div class="stamp ${stampClass}">${esc(estadoLabel)}</div>
      </div>
    </div>
    <div class="rule"></div>
    <div class="parties">
      <div>
        <div class="block-label">${isCot ? 'Cliente' : 'Facturar a'}</div>
        <div class="party-name">${esc(invoice.clientName || 'Consumidor final')}</div>
        ${invoice.clientRnc ? `<div class="party-line">RNC / Cédula: ${esc(invoice.clientRnc)}</div>` : ''}
        ${invoice.clientDir ? `<div class="party-line">${esc(invoice.clientDir)}</div>` : ''}
        ${invoice.clientTel ? `<div class="party-line">Tel: ${esc(invoice.clientTel)}</div>` : ''}
        ${invoice.clientEmail ? `<div class="party-line">${esc(invoice.clientEmail)}</div>` : ''}
      </div>
      <div>
        <div class="block-label">${isCot ? 'Condiciones' : 'Detalles de pago'}</div>
        ${isCot ? `
          <div class="pay-row"><span>Validez</span><span>${esc(invoice.validezDias || 15)} días</span></div>
          ${invoice.condiciones ? `<div class="party-line" style="margin-top:2mm">${esc(invoice.condiciones)}</div>` : ''}
        ` : `
          <div class="pay-row"><span>Condición</span><span>${esc(invoice.condicionPago || 'contado')}</span></div>
          <div class="pay-row"><span>Estado</span><span>${esc(estadoLabel)}</span></div>
          ${Number(invoice.pagado) ? `<div class="pay-row"><span>Pagado a la fecha</span><span>${money(invoice.pagado)}</span></div>` : ''}
          ${Number(invoice.balance) > 0.01 && !anulada ? `<div class="pay-row"><span>Saldo pendiente</span><span>${money(invoice.balance)}</span></div>` : ''}
        `}
      </div>
    </div>
    <table class="items">
      <thead><tr>
        <th class="h-idx">#</th><th class="h-desc">Descripción</th>
        <th>Cant.</th><th>Precio unit.</th><th>Desc.</th><th>ITBIS</th><th>Importe</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals-wrap"><div class="totals">
      <div class="t-row"><span>Subtotal</span><span class="val">${money(invoice.subtotal)}</span></div>
      ${Number(invoice.descuento) ? `<div class="t-row"><span>Descuento</span><span class="val">- ${money(invoice.descuento)}</span></div>` : ''}
      <div class="t-row"><span>ITBIS</span><span class="val">${money(invoice.itbis)}</span></div>
      <div class="t-row t-total"><span>TOTAL</span><span class="val">${money(invoice.total)}</span></div>
      ${Number(invoice.pagado) ? `<div class="t-row t-paid"><span>Pagado</span><span class="val">${money(invoice.pagado)}</span></div>` : ''}
      ${Number(invoice.balance) > 0.01 && !anulada && !isCot ? `<div class="t-row t-due"><span>Saldo pendiente</span><span class="val">${money(invoice.balance)}</span></div>` : ''}
    </div></div>
    <div class="amount-words"><b>Son:</b> ${esc(numeroALetras(invoice.total))}</div>
    ${invoice.notas ? `<div class="notes"><span class="block-label">Notas</span><p>${esc(invoice.notas)}</p></div>` : ''}
    ${isCot ? `<div class="sign"><div class="line">Firma y sello ${esc(empresa.nombre || '')}</div><div class="line">Aceptación del cliente</div></div>` : ''}
    <div class="foot"><b>${esc(empresa.nombre || '')}</b>${footerNote}</div>
  </div>
</div></body></html>`;
}

// ── Térmico 80 / 58 mm ───────────────────────────────────────────────────
function renderThermal(doc, width) {
  const { empresa = {}, invoice = {}, items = [] } = doc;
  const isCot = invoice.docType === 'cotizacion';
  const w = width === '58mm' ? '58mm' : '80mm';
  const pad = width === '58mm' ? 4 : 6;
  const rows = items.map((it) => (
    `<tr><td colspan="2">${esc(it.descripcion)}</td></tr>` +
    `<tr><td>${Number(it.cantidad || 0)} x ${money(it.precio)}</td><td style="text-align:right">${money(it.total)}</td></tr>`
  )).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(invoice.numero)}</title>
<style>
  @page { size:${w} auto; margin:0; }
  body { font:11px/1.35 "Courier New",monospace; width:${w}; margin:0; padding:${pad}px; color:#000; }
  h1 { font-size:13px; text-align:center; margin:0 0 2px; }
  .c { text-align:center; } .hr { border-top:1px dashed #000; margin:5px 0; }
  table { width:100%; border-collapse:collapse; } td { padding:1px 0; vertical-align:top; }
  .tot td { font-weight:bold; } .big { font-size:12px; }
</style></head><body>
  <h1>${esc(empresa.nombre || '')}</h1>
  <div class="c">${empresa.rnc ? 'RNC: ' + esc(empresa.rnc) + '<br>' : ''}${empresa.telefono ? 'Tel.: ' + esc(empresa.telefono) : ''}</div>
  <div class="hr"></div>
  <div>${isCot ? 'Cotización' : 'Factura'}: ${esc(invoice.numero)}</div>
  <div>Fecha: ${esc(fdate(invoice.fecha))}</div>
  ${invoice.ncf ? `<div>${invoice.fiscalMode === 'ecf' ? 'e-NCF' : 'NCF'}: ${esc(invoice.ncf)}</div>` : ''}
  <div>Cliente: ${esc(invoice.clientName || 'Consumidor final')}</div>
  ${invoice.clientRnc ? `<div>RNC/Céd.: ${esc(invoice.clientRnc)}</div>` : ''}
  <div class="hr"></div>
  <table><tbody>${rows}</tbody></table>
  <div class="hr"></div>
  <table>
    <tr><td>Subtotal</td><td style="text-align:right">${money(invoice.subtotal)}</td></tr>
    <tr><td>Descuento</td><td style="text-align:right">- ${money(invoice.descuento)}</td></tr>
    <tr><td>ITBIS</td><td style="text-align:right">${money(invoice.itbis)}</td></tr>
    <tr class="tot big"><td>TOTAL</td><td style="text-align:right">${money(invoice.total)}</td></tr>
    ${Number(invoice.pagado) ? `<tr><td>Pagado</td><td style="text-align:right">${money(invoice.pagado)}</td></tr><tr><td>Balance</td><td style="text-align:right">${money(invoice.balance)}</td></tr>` : ''}
  </table>
  <div class="hr"></div>
  <div class="c">Son: ${esc(numeroALetras(invoice.total))}</div>
  ${['anulada', 'rechazada'].includes(String(invoice.estado || '').toLowerCase()) ? '<div class="c big">*** ' + esc(String(invoice.estado).toUpperCase()) + ' ***</div>' : ''}
  <div class="hr"></div>
  <div class="c">${isCot ? 'Cotización sin valor fiscal' : '¡Gracias por su preferencia!'}</div>
</body></html>`;
}

function renderInvoiceDoc(doc, formato) {
  const f = String(formato || 'a4').toLowerCase();
  if (f === '80mm') return renderThermal(doc, '80mm');
  if (f === '58mm') return renderThermal(doc, '58mm');
  return renderFormalA4(doc);
}

// Cuerpo del correo: HTML simple y compatible con clientes de correo (tabla con
// estilos inline, ancho 600px). El documento formal A4 va SOLO como PDF adjunto.
function renderEmailBody(doc, mensaje) {
  const { empresa = {}, invoice = {} } = doc;
  const isCot = invoice.docType === 'cotizacion';
  const kind = isCot ? 'Cotización' : 'Factura';
  const rows = (invoice.items || []).map((it) => (
    `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px">${esc(it.descripcion)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right">${Number(it.cantidad || 0)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right">${money(it.total)}</td>
    </tr>`
  )).join('');
  const linea = (l, v, bold) => `<tr><td style="padding:3px 8px;font-size:13px${bold ? ';font-weight:700' : ''}">${l}</td><td style="padding:3px 8px;font-size:13px;text-align:right${bold ? ';font-weight:700' : ''}">${v}</td></tr>`;
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2937;max-width:600px;margin:0 auto">
    <div style="border-bottom:3px solid #15803d;padding-bottom:10px;margin-bottom:16px">
      <div style="font-size:18px;font-weight:800;color:#15803d">${esc(empresa.nombre || '')}</div>
      ${empresa.rnc ? `<div style="font-size:12px;color:#6b7280">RNC: ${esc(empresa.rnc)}</div>` : ''}
    </div>
    <p style="font-size:14px;line-height:1.5">${esc(mensaje).replace(/\n/g, '<br>')}</p>
    <table style="width:100%;border-collapse:collapse;margin:14px 0">
      <thead><tr>
        <th style="padding:6px 8px;border-bottom:2px solid #15803d;font-size:11px;text-transform:uppercase;text-align:left;color:#6b7280">Detalle</th>
        <th style="padding:6px 8px;border-bottom:2px solid #15803d;font-size:11px;text-align:right;color:#6b7280">Cant.</th>
        <th style="padding:6px 8px;border-bottom:2px solid #15803d;font-size:11px;text-align:right;color:#6b7280">Importe</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table style="width:100%;border-collapse:collapse;max-width:280px;margin-left:auto">
      ${linea('Subtotal', money(invoice.subtotal))}
      ${Number(invoice.descuento) ? linea('Descuento', '- ' + money(invoice.descuento)) : ''}
      ${linea('ITBIS', money(invoice.itbis))}
      ${linea('TOTAL', money(invoice.total), true)}
      ${!isCot && Number(invoice.balance) > 0.01 ? linea('Saldo pendiente', money(invoice.balance)) : ''}
    </table>
    <p style="font-size:13px;color:#374151;margin-top:16px"><b>${kind} ${esc(invoice.numero)}</b>${invoice.ncf ? ' &middot; NCF ' + esc(invoice.ncf) : ''}${isCot && invoice.validezDias ? ' &middot; válida por ' + esc(invoice.validezDias) + ' días' : ''}</p>
    <p style="font-size:12px;color:#9ca3af;margin-top:8px">Se adjunta el documento completo en PDF (A4). ${esc(empresa.nombre || '')}.</p>
  </div>`;
}

module.exports = { renderInvoiceDoc, renderFormalA4, renderEmailBody, numeroALetras };

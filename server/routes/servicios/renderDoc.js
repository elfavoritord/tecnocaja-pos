'use strict';

/**
 * renderDoc.js — Documentos formales del modo Empresas de Servicios.
 *   A4  → factura y cotización con la plantilla y el color elegidos en
 *         Configuración → Impresora de Recibos (js/factura-plantillas.js, la
 *         misma de la factura A4 del POS). doc.diseno = { plantilla, color }.
 *         renderFormalA4 (diseño propio) queda de respaldo si la plantilla falla.
 *   80mm / 58mm → ticket térmico.
 * El envío por correo usa SIEMPRE A4.
 */

let FacturaPlantillas = null;
try {
  FacturaPlantillas = require('../../../js/factura-plantillas');
} catch (_) { /* sin plantillas: renderFormalA4 */ }

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(n) {
  return 'RD$ ' + (Number(n) || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Notas del documento: escapa y resalta en negrita lo importante — títulos en
// MAYÚSCULAS, montos "RD$ 1,234.56", porcentajes "75%" y el prefijo "Monto total:".
// Devuelve párrafos compactos (colapsa líneas en blanco múltiples) para no
// desperdiciar alto de página.
function formatNotas(raw) {
  const fmtLine = (ln) => {
    const t = ln.trim();
    if (t && /[A-ZÁÉÍÓÚÑ]/.test(t) && t === t.toUpperCase() && !/\d/.test(t.replace(/[.,%$/\s-]/g, ''))) {
      return `<strong>${esc(ln)}</strong>`;
    }
    let s = esc(ln);
    s = s.replace(/^(\s*monto\s+total[^:]*:)/i, '<strong>$1</strong>');
    s = s.replace(/(RD\$\s?\d[\d,]*(?:\.\d{2})?)/g, '<strong>$1</strong>');
    s = s.replace(/(\d+(?:[.,]\d+)?\s?%)/g, '<strong>$1</strong>');
    return s;
  };
  return String(raw == null ? '' : raw)
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n+/)                       // párrafos = bloques separados por líneas en blanco
    .map((par) => par.split('\n').map(fmtLine).join('<br>'))
    .filter((p) => p.trim())
    .map((p) => `<span class="np">${p}</span>`)
    .join('');
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

const ESTADO_LABEL = {
  borrador: 'BORRADOR', enviada: 'ENVIADA', aprobada: 'APROBADA', rechazada: 'RECHAZADA',
  vencida: 'VENCIDA', convertida: 'CONVERTIDA EN FACTURA',
  pendiente: 'PENDIENTE DE PAGO', parcial: 'PAGO PARCIAL', pagada: 'PAGADA', anulada: 'ANULADA',
};
function estadoDe(invoice) {
  const estado = String(invoice.estado || '').toLowerCase();
  return {
    estado,
    label: ESTADO_LABEL[estado] || (invoice.estado || '').toUpperCase(),
    sello: ['pagada', 'aprobada', 'convertida'].includes(estado) ? 'ok'
      : ['anulada', 'rechazada', 'vencida'].includes(estado) ? 'bad' : 'warn',
    anulada: estado === 'anulada' || estado === 'rechazada',
  };
}
function pieDe(isCot, conFirma) {
  return isCot
    ? 'Cotización sin valor fiscal. Precios sujetos a cambio después de la fecha de validez. Documento generado electrónicamente.'
    : `Factura por servicios profesionales. Documento generado electrónicamente${conFirma ? '' : '; válido sin firma ni sello'}. Gracias por su preferencia.`;
}
function fechaFirma(ds) {
  if (!ds || !ds.fecha) return '';
  const dt = ds.fecha instanceof Date ? ds.fecha : new Date(ds.fecha);
  return isNaN(dt) ? '' : dt.toLocaleString('es-DO', { dateStyle: 'medium', timeStyle: 'short' });
}

// ── A4 con las plantillas de Configuración ────────────────────────────────
const TIPOS_NCF = {
  B01: 'Crédito Fiscal', B02: 'Consumo', B14: 'Régimen Especial', B15: 'Gubernamental',
  E31: 'Crédito Fiscal Electrónico', E32: 'Consumo Electrónico',
  E44: 'Régimen Especial Electrónico', E45: 'Gubernamental Electrónico',
};
const METODOS = {
  efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta: 'Tarjeta',
  deposito: 'Depósito', cheque: 'Cheque', otro: 'Otro',
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function isoDe(v) {
  if (!v) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
function sumarDias(v, dias) {
  const iso = isoDe(v);
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + (Number(dias) || 0))).toISOString().slice(0, 10);
}

// Factura/cotización de servicios → datos que espera FacturaPlantillas.render
// (mismos campos que ventaToFormalDoc del POS, más notas, firmas y nota por línea).
function aDocumentoPlantilla({ empresa = {}, invoice = {}, items = [], terminos = '' }) {
  const isCot = invoice.docType === 'cotizacion';
  const st = estadoDe(invoice);
  const tipo = String(invoice.ncfTipo || '').toUpperCase();
  const pago = (invoice.pagos || []).find((p) => !p.anuladoAt);
  const credito = !isCot && invoice.condicionPago === 'credito';
  const ds = invoice.digitalSign || null;
  const validez = Number(invoice.validezDias || 15);
  return {
    isCot,
    anulada: st.anulada,
    marcaAgua: st.estado === 'rechazada' ? 'RECHAZADA' : 'ANULADA',
    selloClase: st.sello,
    estadoLabel: st.label,
    pagado: isCot ? 0 : Number(invoice.pagado || 0),
    balance: isCot ? 0 : Number(invoice.balance || 0),
    empresa: {
      nombre: empresa.nombre || '', rnc: empresa.rnc || '', direccion: empresa.direccion || '',
      telefono: empresa.telefono || '', logo: empresa.logo || '',
    },
    numero: invoice.numero || '',
    ncf: invoice.ncf || '',
    fiscalMode: invoice.fiscalMode || '',
    ncfTipoLabel: !isCot && TIPOS_NCF[tipo] ? `${tipo} — ${TIPOS_NCF[tipo]}` : '',
    // e-CF: bloque de seguridad de la DGII (QR, código y fecha de firma).
    qrDataUrl: invoice.ecfQrDataUrl || '',
    codigoSeguridad: invoice.ecfCodigoSeguridad || '',
    fechaFirma: invoice.ecfFechaFirma || '',
    fechaTexto: fdate(invoice.fecha),
    vencimientoTexto: isCot ? fdate(sumarDias(invoice.fecha, validez)) : fdate(invoice.ncfVencimiento),
    metodoPago: isCot || !pago ? '' : (METODOS[pago.metodo] || String(pago.metodo || '')),
    condicionPago: isCot ? `Válida por ${validez} días`
      : (credito ? `Crédito${invoice.vencimiento ? ' · vence ' + fdate(invoice.vencimiento) : ''}` : 'Contado'),
    cliente: {
      nombre: invoice.clientName || 'Consumidor final', rnc: invoice.clientRnc || '',
      tel: invoice.clientTel || '', dir: invoice.clientDir || '',
    },
    // Importe = cantidad × precio (suma = Subtotal). El descuento de la línea
    // va como nota debajo de la descripción y en el total como "Descuento".
    items: items.map((it) => {
      const bruto = Number(it.cantidad || 0) * Number(it.precio || 0);
      const dPct = Number(it.descuentoPct || 0);
      const desc = bruto * dPct / 100;
      const iPct = Number(it.itbisPct || 0);
      return {
        descripcion: it.descripcion,
        cantidad: Number(it.cantidad || 0),
        precio: Number(it.precio || 0),
        itbisPct: iPct,
        itbisMonto: r2((bruto - desc) * iPct / 100),
        total: r2(bruto),
        nota: dPct ? `Descuento ${r2(dPct)}% (- ${money(desc)})` : '',
      };
    }),
    subtotal: Number(invoice.subtotal || 0),
    descuento: Number(invoice.descuento || 0),
    itbis: Number(invoice.itbis || 0),
    total: Number(invoice.total || 0),
    redondeo: 0,
    notas: [invoice.condiciones, invoice.notas].map((x) => String(x || '').trim()).filter(Boolean).join('\n\n'),
    terminos: String(terminos || '').trim(),
    firmas: (isCot || empresa.firma || ds) ? {
      imagen: empresa.firma || '',
      digital: ds ? { nombre: ds.nombre || empresa.nombre || '', rnc: ds.rnc || '', fecha: fechaFirma(ds) } : null,
      etiqueta: `Firma y sello ${empresa.nombre || ''}`.trim(),
      cliente: isCot ? 'Aceptación del cliente' : '',
    } : null,
    pie: pieDe(isCot, !!(empresa.firma || ds)),
  };
}

function renderPlantillaA4(doc) {
  const d = aDocumentoPlantilla(doc);
  const diseno = doc.diseno || {};
  const hoja = FacturaPlantillas.render(d, { plantilla: diseno.plantilla, color: diseno.color });
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>${esc(d.numero)} — ${d.isCot ? 'COTIZACIÓN' : 'FACTURA'}</title>
<style>@page{size:A4;margin:0}html,body{margin:0;padding:0;background:#eef1f4}@media print{html,body{background:#fff}}</style>
</head><body>${hoja}${FacturaPlantillas.scriptUnaHoja()}</body></html>`;
}

// ── A4 formal propio (respaldo si las plantillas no cargan) ─────────────────
function renderFormalA4(doc) {
  const { empresa = {}, invoice = {}, items = [] } = doc;
  const isCot = invoice.docType === 'cotizacion';
  const titulo = isCot ? 'COTIZACIÓN' : 'FACTURA';
  const st = estadoDe(invoice);
  const estado = st.estado;
  const estadoLabel = st.label;
  const stampClass = st.sello;
  const anulada = st.anulada;
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

  const firmaImg = empresa.firma
    ? `<img src="${empresa.firma}" class="sign-img" alt="Firma y sello">`
    : '';
  // Bloque visible de firma digital — va donde antes iba "Firma y sello".
  const ds = invoice.digitalSign;
  const dsFecha = fechaFirma(ds);
  const dsigHtml = ds ? `<div class="dsig">
      <div class="dsig-h">✔ FIRMADO DIGITALMENTE</div>
      <div class="dsig-n">${esc(ds.nombre || empresa.nombre || '')}</div>
      ${ds.rnc ? `<div class="dsig-x">RNC ${esc(ds.rnc)}</div>` : ''}
      ${dsFecha ? `<div class="dsig-x">${esc(dsFecha)}</div>` : ''}
    </div>` : '';
  const footerNote = pieDe(isCot, !!(firmaImg || ds));

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>${esc(invoice.numero)} — ${titulo}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { background:#eef1f4; }
  body { font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif; font-size:10px; color:#1f2937; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .page { position:relative; width:210mm; min-height:270mm; margin:0 auto; padding:9mm 18mm 6mm; background:#fff; overflow:hidden; }
  .watermark { position:absolute; top:45%; left:50%; transform:translate(-50%,-50%) rotate(-24deg); font-size:110px; font-weight:800; letter-spacing:6px; white-space:nowrap; color:rgba(220,38,38,.08); pointer-events:none; z-index:0; }
  .content { position:relative; z-index:1; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; gap:14mm; padding-bottom:3.5mm; }
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
  .rule { height:2.5px; background:#15803d; margin:0 0 3.5mm; }
  .parties { display:grid; grid-template-columns:1fr 1fr; gap:12mm; margin-bottom:4mm; }
  .block-label { font-size:8.5px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:#6b7280; padding-bottom:2mm; border-bottom:1px solid #e5e7eb; margin-bottom:2.5mm; }
  .party-name { font-size:12px; font-weight:700; color:#111827; margin-bottom:1mm; }
  .party-line { font-size:9px; line-height:1.5; color:#4b5563; }
  .pay-row { display:flex; justify-content:space-between; font-size:9px; line-height:1.7; color:#4b5563; }
  .pay-row span:last-child { color:#111827; font-weight:600; }
  .items { width:100%; border-collapse:collapse; margin-bottom:3mm; }
  .items thead th { background:#f4f7f5; color:#374151; font-size:8px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; text-align:right; padding:1.8mm 2.5mm; border-top:1.5px solid #15803d; border-bottom:1.5px solid #15803d; }
  .items thead th.h-idx { text-align:center; width:9mm; }
  .items thead th.h-desc { text-align:left; }
  .items tbody td { padding:1.5mm 2.5mm; font-size:9px; line-height:1.35; border-bottom:1px solid #edf0f2; vertical-align:top; }
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
  .amount-words { margin:3mm 0 0; padding:1.8mm 3mm; background:#f9fafb; border:1px solid #e5e7eb; border-radius:3px; font-size:9px; line-height:1.35; color:#374151; }
  .amount-words b { color:#111827; letter-spacing:.3px; }
  .notes { margin-top:3mm; }
  .notes p { font-size:9px; line-height:1.35; color:#4b5563; margin-top:1mm; }
  .notes .np { display:block; }
  .notes .np + .np { margin-top:1.2mm; }
  .notes p strong { color:#1f2937; font-weight:700; }
  .foot { margin-top:3.5mm; padding-top:2mm; border-top:1px solid #e5e7eb; font-size:8px; line-height:1.4; color:#6b7280; }
  .foot b { display:block; color:#15803d; font-size:9.5px; margin-bottom:.6mm; letter-spacing:.3px; }
  .sign { display:grid; grid-template-columns:1fr 1fr; gap:16mm; margin-top:5mm; align-items:end; page-break-inside:avoid; break-inside:avoid; }
  .notes, .foot { page-break-inside:avoid; break-inside:avoid; }
  .sign.sign-solo { grid-template-columns:74mm; }
  .sign .cell { display:flex; flex-direction:column; justify-content:flex-end; }
  .sign .sign-img { max-height:18mm; max-width:56mm; object-fit:contain; align-self:center; margin-bottom:1mm; }
  .sign .line { border-top:1px solid #9ca3af; padding-top:1.5mm; text-align:center; font-size:9px; color:#6b7280; }
  .dsig { border:1px solid #15803d; border-radius:3px; background:#f0fdf4; padding:1.6mm 2.4mm; }
  .dsig-h { font-size:7.5px; font-weight:800; letter-spacing:.5px; color:#15803d; }
  .dsig-n { font-size:9px; font-weight:700; color:#111827; margin-top:.5mm; }
  .dsig-x { font-size:8px; color:#4b5563; line-height:1.3; }
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
    ${invoice.notas ? `<div class="notes"><span class="block-label">Notas</span><p>${formatNotas(invoice.notas)}</p></div>` : ''}
    ${doc.terminos ? `<div class="notes"><span class="block-label">Términos y condiciones</span><p>${formatNotas(doc.terminos)}</p></div>` : ''}
    ${(isCot || firmaImg || ds) ? `<div class="sign${isCot ? '' : ' sign-solo'}">
      <div class="cell">${firmaImg}${dsigHtml || `<div class="line">Firma y sello ${esc(empresa.nombre || '')}</div>`}</div>
      ${isCot ? '<div class="cell"><div class="line">Aceptación del cliente</div></div>' : ''}
    </div>` : ''}
    ${invoice.ecfQrDataUrl ? `<div style="display:flex;align-items:center;gap:4mm;margin-top:5mm;font-size:9px;line-height:1.6;break-inside:avoid">
      <img src="${esc(invoice.ecfQrDataUrl)}" alt="QR" style="width:28mm;height:28mm">
      <div>${invoice.ecfCodigoSeguridad ? `<div><b>Código de seguridad:</b> ${esc(invoice.ecfCodigoSeguridad)}</div>` : ''}${invoice.ecfFechaFirma ? `<div><b>Fecha de firma digital:</b> ${esc(invoice.ecfFechaFirma)}</div>` : ''}</div>
    </div>` : ''}
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
  ${invoice.ecfQrDataUrl ? `<div class="hr"></div><div class="c"><img src="${esc(invoice.ecfQrDataUrl)}" alt="QR" style="width:${width === '58mm' ? 30 : 36}mm"></div>
  ${invoice.ecfCodigoSeguridad ? `<div class="c">Código de seguridad: ${esc(invoice.ecfCodigoSeguridad)}</div>` : ''}
  ${invoice.ecfFechaFirma ? `<div class="c">Fecha de firma: ${esc(invoice.ecfFechaFirma)}</div>` : ''}` : ''}
  ${['anulada', 'rechazada'].includes(String(invoice.estado || '').toLowerCase()) ? '<div class="c big">*** ' + esc(String(invoice.estado).toUpperCase()) + ' ***</div>' : ''}
  <div class="hr"></div>
  ${empresa.firma ? `<div class="c"><img src="${empresa.firma}" style="max-width:${width === '58mm' ? '38mm' : '50mm'};max-height:16mm"></div><div class="c">Firma y sello ${esc(empresa.nombre || '')}</div><div class="hr"></div>` : ''}
  ${invoice.digitalSign ? `<div class="c" style="font-weight:bold">FIRMADO DIGITALMENTE</div><div class="c">${esc(invoice.digitalSign.nombre || empresa.nombre || '')}${invoice.digitalSign.rnc ? ' - RNC ' + esc(invoice.digitalSign.rnc) : ''}</div><div class="hr"></div>` : ''}
  ${doc.terminos ? `<div style="font-size:9px;line-height:1.3"><b>Términos y condiciones</b><br>${esc(String(doc.terminos).trim()).replace(/\r?\n/g, '<br>')}</div><div class="hr"></div>` : ''}
  <div class="c">${isCot ? 'Cotización sin valor fiscal' : '¡Gracias por su preferencia!'}</div>
</body></html>`;
}

function renderInvoiceDoc(doc, formato) {
  const f = String(formato || 'a4').toLowerCase();
  if (f === '80mm') return renderThermal(doc, '80mm');
  if (f === '58mm') return renderThermal(doc, '58mm');
  if (FacturaPlantillas) {
    try { return renderPlantillaA4(doc); } catch (e) {
      console.warn('[servicios] plantilla A4 falló, uso el diseño propio:', e.message);
    }
  }
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

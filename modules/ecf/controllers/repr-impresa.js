'use strict';

const QRCode = require('qrcode');
const { resolveEnvironmentConfig } = require('../config/ecf.config');

const ECF_TYPE_LABELS = {
  '31': 'FACTURA DE CRÉDITO FISCAL ELECTRÓNICA',
  '32': 'FACTURA DE CONSUMO ELECTRÓNICA',
  '33': 'NOTA DE DÉBITO ELECTRÓNICA',
  '34': 'NOTA DE CRÉDITO ELECTRÓNICA',
  '41': 'COMPROBANTE PARA COMPRAS ELECTRÓNICO',
  '43': 'COMPROBANTE PARA GASTOS MENORES ELECTRÓNICO',
  '44': 'COMPROBANTE PARA REGÍMENES ESPECIALES ELECTRÓNICO',
  '45': 'COMPROBANTE PARA GUBERNAMENTALES ELECTRÓNICO',
  '46': 'COMPROBANTE PARA EXPORTACIONES ELECTRÓNICO',
  '47': 'COMPROBANTE PARA PAGOS AL EXTERIOR ELECTRÓNICO',
};

function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function xmlAll(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1]);
  return results;
}

function parseEcfXml(xml) {
  // El XML firmado siempre trae la declaración <?xml ...?> antes de la raíz,
  // así que hay que quitarla antes de probar si la raíz es <RFCE> — de lo
  // contrario esta prueba nunca coincide y todo RFCE se trata como no-RFCE,
  // generando un QR que apunta al portal equivocado (ecf.dgii.gov.do en vez
  // de fc.dgii.gov.do/ConsultaTimbreFC) y DGII responde "No fue encontrada
  // la factura (e-CF)" al escanearlo.
  const xmlSinDeclaracion = xml.trim().replace(/^<\?xml[^>]*\?>\s*/i, '');
  const isRfce = /^<RFCE[\s>]/i.test(xmlSinDeclaracion);
  const enc = (xml.match(/<Encabezado>([\s\S]*?)<\/Encabezado>/i) || [])[1] || '';
  const idDoc = (enc.match(/<IdDoc>([\s\S]*?)<\/IdDoc>/i) || [])[1] || '';
  const emisor = (enc.match(/<Emisor>([\s\S]*?)<\/Emisor>/i) || [])[1] || '';
  const comprador = (enc.match(/<Comprador>([\s\S]*?)<\/Comprador>/i) || [])[1] || '';
  const totales = (enc.match(/<Totales>([\s\S]*?)<\/Totales>/i) || [])[1] || '';
  const referencia = (xml.match(/<InformacionReferencia>([\s\S]*?)<\/InformacionReferencia>/i) || [])[1] || '';
  const itemsSection = (xml.match(/<DetallesItems>([\s\S]*?)<\/DetallesItems>/i) || [])[1] || '';

  const items = xmlAll(itemsSection, 'Item').map((itemXml) => ({
    linea: xmlText(itemXml, 'NumeroLinea'),
    nombre: xmlText(itemXml, 'NombreItem'),
    cantidad: xmlText(itemXml, 'CantidadItem'),
    unidad: xmlText(itemXml, 'UnidadMedida'),
    precioUnit: xmlText(itemXml, 'PrecioUnitarioItem'),
    itbis: xmlText(itemXml, 'ITBISItem') || xmlText(itemXml, 'MontoITBISItem') || '',
    monto: xmlText(itemXml, 'MontoItem'),
  }));

  const sigVal = ((xml.match(/<SignatureValue[^>]*>([^<]+)<\/SignatureValue>/i) || [])[1] || '').trim();
  const codigoSeguridadRfce = xmlText(enc, 'CodigoSeguridadeCF');

  return {
    isRfce,
    tipoEcf: xmlText(idDoc, 'TipoeCF'),
    encf: xmlText(idDoc, 'eNCF'),
    fechaEmision: xmlText(emisor, 'FechaEmision'),
    fechaVencimiento: xmlText(idDoc, 'FechaVencimientoSecuencia'),
    limitePago: xmlText(idDoc, 'FechaLimitePago'),
    fechaHoraFirma: xmlText(xml, 'FechaHoraFirma'),
    rncEmisor: xmlText(emisor, 'RNCEmisor'),
    razonSocial: xmlText(emisor, 'RazonSocialEmisor'),
    nombreComercial: xmlText(emisor, 'NombreComercial'),
    direccion: xmlText(emisor, 'DireccionEmisor'),
    telefonos: xmlAll(emisor, 'TelefonoEmisor'),
    correo: xmlText(emisor, 'CorreoEmisor'),
    web: xmlText(emisor, 'WebSite'),
    numFacturaInterna: xmlText(emisor, 'NumeroFacturaInterna'),
    rncComprador: xmlText(comprador, 'RNCComprador'),
    razonSocialComprador:
      xmlText(comprador, 'RazonSocialComprador') ||
      xmlText(comprador, 'NombreConsumidor') ||
      'Consumidor Final',
    direccionComprador: xmlText(comprador, 'DireccionComprador'),
    contacto: xmlText(comprador, 'ContactoComprador'),
    montoTotal: xmlText(totales, 'MontoTotal'),
    montoExento: xmlText(totales, 'MontoExento'),
    montoGravado1: xmlText(totales, 'MontoGravadoI1') || xmlText(totales, 'MontoGravadoTotal'),
    totalItbis: xmlText(totales, 'TotalITBIS1') || xmlText(totales, 'TotalITBIS'),
    montoImpuestoAdicional: xmlText(totales, 'MontoImpuestoAdicional'),
    ncfModificado: xmlText(referencia, 'NCFModificado'),
    fechaNcfModificado: xmlText(referencia, 'FechaNCFModificado'),
    items,
    codigoSeguridad: isRfce ? codigoSeguridadRfce : sigVal.slice(0, 6),
  };
}

function fmt(n) {
  const v = parseFloat(String(n || '').replace(',', '.') || '0');
  if (isNaN(v)) return '0.00';
  return v.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function generateReprImpresaHtml(signedXml, opts = {}) {
  const d = parseEcfXml(signedXml);
  const typeLabel =
    (d.isRfce ? 'FACTURA DE CONSUMO ELECTRÓNICA (RFCE) < RD$250,000' : ECF_TYPE_LABELS[d.tipoEcf]) ||
    `COMPROBANTE ELECTRÓNICO TIPO ${d.tipoEcf}`;
  const codigoSeguridad = d.codigoSeguridad || '------';
  const env = opts.env || 'certecf';

  // opts.emitter permite sobreescribir los datos del emisor del XML con los
  // datos reales configurados (RNC, RazonSocial, NombreComercial, etc.).
  // Requerido por DGII Norma General 06-2018: la RI debe mostrar la razón
  // social tal como figura en el RNC del contribuyente, no datos del set de pruebas.
  const emitterOverride = opts.emitter || null;
  const issuerRnc = emitterOverride?.rnc || d.rncEmisor || '';
  const issuerRazonSocial = emitterOverride?.razon_social || d.razonSocial || '';
  const issuerNombreComercial = emitterOverride
    ? (emitterOverride.nombre_comercial ?? '')
    : d.nombreComercial || '';
  const issuerDireccion = emitterOverride?.direccion || d.direccion || '';
  const issuerTelefonos = emitterOverride?.telefono
    ? [emitterOverride.telefono].filter(Boolean)
    : d.telefonos.filter(Boolean);
  const issuerCorreo = emitterOverride?.correo || d.correo || '';
  const issuerName = issuerRazonSocial || issuerNombreComercial || 'TECNO CAJA';

  // opts.buyer permite sobreescribir la Razón Social del comprador con el
  // nombre REAL registrado en el padrón RNC de DGII (mismo principio de la
  // Norma General 06-2018 aplicado al emisor arriba). El set de pruebas de
  // certificación reutiliza un mismo RNC comprador en varios comprobantes con
  // nombres inconsistentes entre sí (ej. RNC 131880681 aparece como "DE 02",
  // "DE 03", "DE 04" y "ZONA FRANCA LOI" en distintos documentos) — DGII marcó
  // esto en el log del Paso 5 ("revisar la Razón Social... del comprador").
  const buyerRazonSocial = opts.buyer?.razon_social || d.razonSocialComprador;

  // La base debe coincidir EXACTO con la que usa el resto del sistema para hablar
  // con DGII (ecf.config.js) — un typo de mayúsculas aquí genera un QR que apunta
  // a una URL que no existe ("La URL no abre" en el log de DGII, Paso 5).
  const { baseUrl } = resolveEnvironmentConfig(env);
  const envSegment = baseUrl.split('/').pop();
  const fechaFirma = d.fechaHoraFirma || d.fechaEmision || '';

  // Un RFCE (Factura de Consumo < RD$250mil) usa un portal de verificación
  // DISTINTO: dominio fc.dgii.gov.do, endpoint ConsultaTimbreFC, y solo 4
  // parámetros — no lleva RncComprador/FechaEmision/FechaFirma porque un RFCE
  // por diseño no tiene FechaHoraFirma (ver rfce-xsd.util.js: "Un RFCE no debe
  // incluir FechaHoraFirma; solo firma XMLDSig"). Verificado en vivo contra
  // fc.dgii.gov.do/CerteCF/ConsultaTimbreFC. Cualquier otro tipo de e-CF exige
  // los 7 parámetros del portal ecf.dgii.gov.do/CerteCF/ConsultaTimbre
  // (verificado en vivo también) — faltaban RncComprador, FechaEmision y
  // FechaFirma, por eso el validador de DGII marcaba la URL como inválida.
  // Solo el espacio de FechaFirma se codifica (como '+'); ':' y '-' se dejan
  // tal cual porque son válidos sin escapar en un query string y así aparecen
  // en el enlace real de DGII.
  const qrUrl = d.isRfce
    ? `https://fc.dgii.gov.do/${envSegment}/ConsultaTimbreFC?` +
      `RncEmisor=${encodeURIComponent(issuerRnc)}` +
      `&ENCF=${encodeURIComponent(d.encf)}` +
      `&MontoTotal=${encodeURIComponent(d.montoTotal || '')}` +
      `&CodigoSeguridad=${encodeURIComponent(codigoSeguridad)}`
    : `${baseUrl}/ConsultaTimbre?` +
      `RncEmisor=${encodeURIComponent(issuerRnc)}` +
      `&RncComprador=${encodeURIComponent(d.rncComprador || '')}` +
      `&ENCF=${encodeURIComponent(d.encf)}` +
      `&FechaEmision=${encodeURIComponent(d.fechaEmision || '')}` +
      `&MontoTotal=${encodeURIComponent(d.montoTotal || '')}` +
      `&FechaFirma=${fechaFirma.replace(/ /g, '+')}` +
      `&CodigoSeguridad=${encodeURIComponent(codigoSeguridad)}`;

  const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 160, margin: 1, color: { dark: '#000', light: '#fff' } });
  const branchLine = d.numFacturaInterna ? `Sucursal / Punto emisión: ${d.numFacturaInterna}` : '';
  const referenceBlock = d.ncfModificado
    ? `<div class="reference-line"><strong>NCF modificado:</strong> ${escapeHtml(d.ncfModificado)}${d.fechaNcfModificado ? ` &nbsp; <strong>Fecha NCF modificado:</strong> ${escapeHtml(d.fechaNcfModificado)}` : ''}</div>`
    : '';

  const itemsHtml =
    d.items.length > 0
      ? `<table class="items-table">
      <thead>
        <tr>
          <th style="width:58px">Cantidad</th>
          <th>Descripción</th>
          <th style="width:76px">ITBIS</th>
          <th style="width:92px">Valor</th>
        </tr>
      </thead>
      <tbody>
        ${d.items.map((item) => `<tr>
          <td class="num">${escapeHtml(item.cantidad || '1')}</td>
          <td>
            ${escapeHtml(item.nombre)}
            ${item.unidad ? `<div class="item-meta">Unidad: ${escapeHtml(item.unidad)}</div>` : ''}
            ${item.precioUnit ? `<div class="item-meta">Precio unitario: RD$ ${fmt(item.precioUnit)}</div>` : ''}
          </td>
          <td class="num">${item.itbis ? `RD$ ${fmt(item.itbis)}` : '0.00'}</td>
          <td class="num">RD$ ${fmt(item.monto)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`
      : '<div class="empty-items">Sin detalle de ítems en el XML usado para esta representación.</div>';

  const totalsRows = [
    d.montoGravado1 && parseFloat(d.montoGravado1) > 0
      ? `<tr><td class="label">Subtotal Gravado:</td><td class="value">RD$ ${fmt(d.montoGravado1)}</td></tr>`
      : '',
    d.montoExento && parseFloat(d.montoExento) > 0
      ? `<tr><td class="label">Monto Exento:</td><td class="value">RD$ ${fmt(d.montoExento)}</td></tr>`
      : '',
    d.totalItbis && parseFloat(d.totalItbis) > 0
      ? `<tr><td class="label">ITBIS:</td><td class="value">RD$ ${fmt(d.totalItbis)}</td></tr>`
      : '',
    d.montoImpuestoAdicional && parseFloat(d.montoImpuestoAdicional) > 0
      ? `<tr><td class="label">Imp. Adicional (ISC):</td><td class="value">RD$ ${fmt(d.montoImpuestoAdicional)}</td></tr>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${d.encf} — Representación Impresa</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; background: #fff; }
  .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 14mm 16mm 12mm; }
  .top { display: grid; grid-template-columns: 1fr 0.88fr; gap: 15mm; align-items: start; margin-bottom: 7mm; }
  .emitter-box { min-height: 35mm; border: 2px solid #63b500; padding: 3mm; }
  .biz-name { font-size: 15px; line-height: 1.12; font-weight: 900; text-transform: uppercase; color: #1236a3; margin-bottom: 2mm; }
  .biz-line { font-size: 10.5px; line-height: 1.35; font-weight: 600; }
  .doc-box { min-height: 30mm; border: 2px solid #63b500; padding: 4mm 4mm 3mm; margin-top: 9mm; }
  .doc-type { font-size: 19px; line-height: 1.08; font-weight: 500; margin-bottom: 3mm; }
  .doc-meta { font-size: 10.5px; line-height: 1.45; font-weight: 700; }
  .buyer-box { width: 55%; border: 2px solid #63b500; padding: 2.5mm 3mm; margin-bottom: 4mm; font-size: 10.5px; line-height: 1.45; font-weight: 700; }
  .reference-line { margin: -1mm 0 4mm; font-size: 10px; line-height: 1.4; }
  .items-table { width: 100%; border-collapse: collapse; border: 2px solid #63b500; font-size: 10px; margin-top: 0; }
  .items-table th { background: #0476c9; color: #fff; border: 1px solid #0476c9; padding: 5px 6px; text-align: left; font-weight: 800; text-transform: uppercase; }
  .items-table td { border: 1px solid #d5d5d5; padding: 5px 6px; vertical-align: top; }
  .items-table tbody tr:nth-child(even) { background: #ededed; }
  .item-meta { margin-top: 2px; color: #444; font-size: 9px; }
  .empty-items { border: 2px solid #63b500; padding: 8mm; text-align: center; color: #555; }
  td.num { text-align: right; white-space: nowrap; }
  .totals { display: flex; justify-content: flex-end; margin-top: 6px; }
  .totals-table { width: 48%; border-collapse: collapse; }
  .totals-table td { padding: 3px 7px; border: 0; }
  .totals-table .label { text-align: right; font-weight: 700; color: #555; white-space: nowrap; }
  .totals-table .value { text-align: right; white-space: nowrap; }
  .grand-total td { font-size: 13px; font-weight: 900; border-top: 2px solid #000; padding-top: 5px; }
  .bottom { display: grid; grid-template-columns: 46mm 1fr; gap: 10mm; align-items: start; margin-top: 8mm; page-break-inside: avoid; break-inside: avoid; }
  .qr-box { border: 2px solid #63b500; padding: 3mm; width: 42mm; text-align: left; page-break-inside: avoid; break-inside: avoid; }
  .qr-box img { width: 30mm; height: 30mm; display: block; margin-bottom: 2mm; }
  .qr-line { font-size: 9.5px; line-height: 1.35; font-weight: 700; word-break: break-word; }
  .copy-note { font-size: 10px; line-height: 1.45; max-width: 80mm; margin-top: 3mm; }
  .rfce-badge { font-size: 10px; font-weight: 700; }
  @media print {
    body { background: #fff; }
    .page { padding: 14mm 16mm 12mm; width: 100%; box-shadow: none; }
  }
</style>
</head>
<body>
<div class="page">

  <div class="top">
    <div class="emitter-box">
      <div class="biz-name">${escapeHtml(issuerName)}</div>
      ${issuerNombreComercial && issuerNombreComercial !== issuerRazonSocial ? `<div class="biz-line">${escapeHtml(issuerNombreComercial)}</div>` : ''}
      <div class="biz-line">RNC: ${escapeHtml(issuerRnc)}</div>
      ${issuerDireccion ? `<div class="biz-line">${escapeHtml(issuerDireccion)}</div>` : ''}
      ${issuerTelefonos.length ? `<div class="biz-line">Tel: ${escapeHtml(issuerTelefonos.join(' / '))}</div>` : ''}
      ${issuerCorreo ? `<div class="biz-line">${escapeHtml(issuerCorreo)}</div>` : ''}
      ${branchLine ? `<div class="biz-line">${escapeHtml(branchLine)}</div>` : ''}
      <div class="biz-line">Fecha de Emisión: ${escapeHtml(d.fechaEmision)}</div>
    </div>

    <div class="doc-box">
      <div class="doc-type">${escapeHtml(typeLabel)}${d.isRfce ? ' <span class="rfce-badge">RFCE</span>' : ''}</div>
      <div class="doc-meta">e-NCF: ${escapeHtml(d.encf)}</div>
      ${d.fechaVencimiento ? `<div class="doc-meta">Vencimiento Secuencia: ${escapeHtml(d.fechaVencimiento)}</div>` : ''}
      ${d.limitePago ? `<div class="doc-meta">Fecha Límite de Pago: ${escapeHtml(d.limitePago)}</div>` : ''}
    </div>
  </div>

  <div class="buyer-box">
    <div>Razón Social Cliente: ${escapeHtml(buyerRazonSocial)}</div>
    ${d.rncComprador ? `<div>RNC Cliente: ${escapeHtml(d.rncComprador)}</div>` : ''}
    ${d.direccionComprador ? `<div>Dirección: ${escapeHtml(d.direccionComprador)}</div>` : ''}
    ${d.contacto ? `<div>Contacto: ${escapeHtml(d.contacto)}</div>` : ''}
  </div>
  ${referenceBlock}

  ${itemsHtml}

  <div class="totals">
    <table class="totals-table">
      ${totalsRows}
      <tr class="grand-total">
        <td class="label">TOTAL:</td>
        <td class="value">RD$ ${fmt(d.montoTotal)}</td>
      </tr>
    </table>
  </div>

  <div class="bottom">
    <div class="qr-box">
      <img src="${qrDataUrl}" alt="QR Timbre DGII" />
      <div class="qr-line">Código de Seguridad: ${escapeHtml(codigoSeguridad)}</div>
      <div class="qr-line">Fecha Firma Digital: ${escapeHtml(fechaFirma)}</div>
    </div>
    <div class="copy-note">
      Original: Cliente<br>
      Copia: Vendedor
    </div>
  </div>

</div>
</body>
</html>`;
}

module.exports = { generateReprImpresaHtml, parseEcfXml };

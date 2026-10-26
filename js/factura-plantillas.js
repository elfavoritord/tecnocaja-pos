'use strict';
/* global DB */

/* ═══════════════════════════════════════════════════════════════════════════
   TECNO CAJA — Plantillas de la factura A4

   Con el papel "Carta / A4" (Configuración → Impresora de Recibos) cada venta
   sale como factura A4. ventas.js arma los datos de la venta
   (ventaToFormalDoc) y aquí se dibujan con la plantilla y el color elegidos.
   La misma salida sirve para la ventana del comprobante, la impresión, el PDF
   y la imagen que se copia para WhatsApp. El modo Empresa de Servicios la usa
   también, desde el servidor (server/routes/servicios/renderDoc.js), para sus
   facturas y cotizaciones A4; esos documentos agregan notas, términos y
   condiciones, firmas y nota por línea (d.notas, d.terminos, d.firmas,
   it.nota), que en el POS no vienen. El portal de contadores
   (tecno-caja-contadores) usa una copia de este archivo para sus facturas
   (la copia la hace tecno-caja-contadores/scripts/vendor-sync.js); allí el
   NCF es el número (d.numero vacío) y salen los correos (empresa.correo,
   cliente.correo).

   - Todos los selectores CSS cuelgan de .tcfac-root: el bloque se inyecta por
     innerHTML sin filtrar estilos al resto del app.
   - Los tonos del color se calculan aquí en hex porque html2canvas (imagen
     para WhatsApp) no entiende color-mix().
   - "Clásica" es la factura A4 de v1.3.29 tal cual y es la plantilla por
     defecto: nadie ve un cambio sin haberlo elegido.
   - Los colores de estado (PAGADA verde, PENDIENTE ámbar, ANULADA rojo) no
     cambian con el color elegido: un "PAGADA" en rojo se leería mal.
   - La sombra de la hoja es filter:drop-shadow y no box-shadow: html2canvas
     pinta el box-shadow encima del fondo y la hoja salía gris en la imagen.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  const PLANTILLAS = [
    { id: 'clasica', nombre: 'Clásica', descripcion: 'Sello de estado y detalles de pago', color: '#15803d' },
    { id: 'ejecutiva', nombre: 'Ejecutiva', descripcion: 'Encabezado limpio y tabla con franja de color', color: '#1e4e8c' },
    { id: 'recuadro', nombre: 'Recuadro', descripcion: 'Datos fiscales en recuadro y líneas de firma', color: '#dc2626' },
    { id: 'banner', nombre: 'Banner', descripcion: 'Franja de color arriba y datos en tarjetas', color: '#2c3e50' }
  ];
  const PLANTILLA_POR_DEFECTO = 'clasica';

  // Tonos que se leen bien impresos en papel blanco.
  const PALETA = [
    { nombre: 'Verde', color: '#15803d' },
    { nombre: 'Esmeralda', color: '#0f766e' },
    { nombre: 'Azul', color: '#1e4e8c' },
    { nombre: 'Azul cielo', color: '#0369a1' },
    { nombre: 'Índigo', color: '#4338ca' },
    { nombre: 'Morado', color: '#7e22ce' },
    { nombre: 'Rosa', color: '#be185d' },
    { nombre: 'Rojo', color: '#dc2626' },
    { nombre: 'Naranja', color: '#c2410c' },
    { nombre: 'Dorado', color: '#a16207' },
    { nombre: 'Grafito', color: '#2c3e50' },
    { nombre: 'Negro', color: '#111827' }
  ];

  // ── Texto y números ───────────────────────────────────────────────────────
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const UNIDADES = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ',
    'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE'];
  const DECENAS = ['', '', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  const CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

  function seccionEnLetras(n) {
    if (n === 0) return '';
    if (n < 20) return UNIDADES[n];
    if (n < 100) {
      const d = Math.floor(n / 10); const u = n % 10;
      if (n === 20) return 'VEINTE';
      if (d === 2) return 'VEINTI' + UNIDADES[u];
      return DECENAS[d] + (u ? ' Y ' + UNIDADES[u] : '');
    }
    if (n === 100) return 'CIEN';
    const c = Math.floor(n / 100); const r = n % 100;
    return CENTENAS[c] + (r ? ' ' + seccionEnLetras(r) : '');
  }

  function montoEnLetras(valor) {
    const num = Math.floor(Math.abs(Number(valor) || 0));
    const cent = Math.round((Math.abs(Number(valor) || 0) - num) * 100);
    let palabras;
    if (num === 0) palabras = 'CERO';
    else {
      const mill = Math.floor(num / 1000000);
      const miles = Math.floor((num % 1000000) / 1000);
      const resto = num % 1000;
      const p = [];
      if (mill) p.push(mill === 1 ? 'UN MILLÓN' : seccionEnLetras(mill) + ' MILLONES');
      if (miles) p.push(miles === 1 ? 'MIL' : seccionEnLetras(miles) + ' MIL');
      if (resto) p.push(seccionEnLetras(resto));
      palabras = p.join(' ').trim() || 'CERO';
    }
    return `${palabras} PESOS DOMINICANOS CON ${String(cent).padStart(2, '0')}/100`;
  }

  function dinero(n) {
    return 'RD$ ' + (Number(n) || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function capital(texto) {
    const s = String(texto || '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function iniciales(nombre) {
    const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean);
    return ((partes[0] || 'T').charAt(0) + (partes[1] || '').charAt(0)).toUpperCase();
  }

  // ── Colores ───────────────────────────────────────────────────────────────
  function normalizarPlantilla(id) {
    const limpio = String(id || '').trim().toLowerCase();
    return PLANTILLAS.some((p) => p.id === limpio) ? limpio : PLANTILLA_POR_DEFECTO;
  }

  function normalizarColor(valor) {
    const limpio = String(valor || '').trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(limpio) ? limpio : '';
  }

  function plantillaPorId(id) {
    return PLANTILLAS.find((p) => p.id === normalizarPlantilla(id));
  }

  function aRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function aHex(rgb) {
    return '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
  }

  function mezclar(a, b, peso) {
    const x = aRgb(a); const y = aRgb(b);
    return aHex(x.map((c, i) => c + (y[i] - c) * peso));
  }

  function luminancia(hex) {
    const pesos = [0.2126, 0.7152, 0.0722];
    return aRgb(hex).reduce((total, c, i) => {
      const v = c / 255;
      return total + pesos[i] * (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    }, 0);
  }

  function contraste(a, b) {
    const [l1, l2] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  }

  // acc: rellenos y líneas. ink: texto en color sobre blanco (se oscurece si
  // el color elegido es muy claro). tint: fondo suave. onAcc: texto sobre acc.
  function resolverColores(plantillaId, color) {
    const acc = normalizarColor(color) || plantillaPorId(plantillaId).color;
    let ink = acc;
    for (let i = 0; i < 14 && contraste(ink, '#ffffff') < 4.5; i++) ink = mezclar(ink, '#000000', 0.12);
    return {
      acc,
      ink,
      tint: mezclar(acc, '#ffffff', 0.94),
      onAcc: contraste(acc, '#ffffff') >= 4.5 ? '#ffffff' : '#111827'
    };
  }

  // ── Piezas comunes ────────────────────────────────────────────────────────
  function celdaItbis(it) {
    if (Number(it.itbisMonto) > 0.005) return dinero(it.itbisMonto);
    if (Number(it.itbisPct) > 0) return Number(it.itbisPct).toFixed(0) + '%';
    return 'Exento';
  }

  // Descripción con una nota chica opcional debajo (en servicios: el descuento
  // de la línea, que estas plantillas no tienen como columna).
  function celdaDescripcion(it) {
    return esc(it.descripcion) + (it.nota ? `<small class="tcf-inote">${esc(it.nota)}</small>` : '');
  }

  // Notas largas (condiciones de una cotización, alcance de un servicio): en
  // párrafos, con títulos en MAYÚSCULAS, montos RD$ y porcentajes en negrita.
  function notasHtml(raw) {
    const linea = (ln) => {
      const t = ln.trim();
      if (t && /[A-ZÁÉÍÓÚÑ]/.test(t) && t === t.toUpperCase() && !/\d/.test(t.replace(/[.,%$/\s-]/g, ''))) {
        return `<strong>${esc(ln)}</strong>`;
      }
      return esc(ln)
        .replace(/^(\s*monto\s+total[^:]*:)/i, '<strong>$1</strong>')
        .replace(/(RD\$\s?\d[\d,]*(?:\.\d{2})?)/g, '<strong>$1</strong>')
        .replace(/(\d+(?:[.,]\d+)?\s?%)/g, '<strong>$1</strong>');
    };
    return String(raw ?? '')
      .replace(/\r\n/g, '\n')
      .split(/\n\s*\n+/)
      .map((par) => par.split('\n').map(linea).join('<br>'))
      .filter((p) => p.trim())
      .map((p) => `<span class="tcf-np">${p}</span>`)
      .join('');
  }

  function bloqueTexto(texto, titulo, cls = '') {
    const html = notasHtml(texto);
    return html ? `<div class="tcf-notas${cls ? ' ' + cls : ''}"><div class="tcf-notas-t">${esc(titulo)}</div>${html}</div>` : '';
  }

  // Notas del documento y, aparte, los términos y condiciones fijos del
  // negocio (d.terminos: en servicios salen en todas las cotizaciones y facturas).
  function bloqueNotas(d) {
    return bloqueTexto(d.notas, d.notasTitulo || 'Notas')
      + bloqueTexto(d.terminos, 'Términos y condiciones', 'tcf-terminos');
  }

  // Firma y sello (imagen), firma digital y línea de aceptación del cliente.
  // Solo si el documento trae d.firmas (facturas y cotizaciones de servicios).
  function bloqueFirmas(d) {
    const f = d.firmas;
    if (!f) return '';
    const dg = f.digital;
    const propia = `<div class="tcf-firma">
        ${f.imagen ? `<img src="${esc(f.imagen)}" alt="Firma y sello">` : ''}
        ${dg ? `<div class="tcf-dsig">
            <div class="tcf-dsig-h">✔ FIRMADO DIGITALMENTE</div>
            <div class="tcf-dsig-n">${esc(dg.nombre)}</div>
            ${dg.rnc ? `<div class="tcf-dsig-x">RNC ${esc(dg.rnc)}</div>` : ''}
            ${dg.fecha ? `<div class="tcf-dsig-x">${esc(dg.fecha)}</div>` : ''}
          </div>` : `<div class="tcf-firma-l">${esc(f.etiqueta || 'Firma autorizada')}</div>`}
      </div>`;
    const cliente = f.cliente ? `<div class="tcf-firma"><div class="tcf-firma-l">${esc(f.cliente)}</div></div>` : '';
    return `<div class="tcf-firmas${cliente ? '' : ' solo'}">${propia}${cliente}</div>`;
  }

  // Lo que va después del monto en letras en todas las plantillas.
  function cierre(d) {
    return bloqueNotas(d) + bloqueFirmas(d);
  }

  function lineasTotales(d) {
    const out = [['Subtotal', dinero(d.subtotal), '']];
    if (Number(d.descuento)) out.push(['Descuento', '- ' + dinero(d.descuento), '']);
    if (Number(d.itbis)) out.push(['ITBIS', dinero(d.itbis), '']);
    if (Math.abs(Number(d.redondeo || 0)) >= 0.01) out.push(['Redondeo', dinero(d.redondeo), '']);
    return out;
  }

  // d.lineasPago (opcional): filas propias debajo del TOTAL, p. ej. las
  // retenciones y el neto de un gasto. [[etiqueta, valor ya formateado, clase]]
  function lineasPago(d) {
    if (Array.isArray(d.lineasPago)) return d.lineasPago;
    const out = [];
    if (Number(d.pagado)) out.push(['Pagado', dinero(d.pagado), 'paid']);
    if (Number(d.balance) > 0.01 && !d.anulada && !d.isCot) out.push(['Saldo pendiente', dinero(d.balance), 'due']);
    return out;
  }

  function filasResumen(lineas) {
    return lineas.map(([label, valor, cls]) =>
      `<div class="r${cls ? ' ' + cls : ''}"><span>${esc(label)}</span><span>${esc(valor)}</span></div>`).join('');
  }

  // e-CF: QR, código de seguridad y fecha de firma, como pide la DGII para la
  // representación impresa. Salen de la URL del QR que el backend arma con el
  // XML firmado (venta.qrUrl), así coinciden con lo que DGII tiene registrado.
  function bloqueSeguridad(d) {
    if (d.fiscalMode !== 'ecf' || !(d.qrDataUrl || d.codigoSeguridad)) return '';
    return `<div class="tcf-qr">
        ${d.qrDataUrl ? `<img src="${esc(d.qrDataUrl)}" alt="QR">` : ''}
        <div class="tcf-qr-txt">
          ${d.codigoSeguridad ? `<div><b>Código de seguridad:</b> <span class="tcf-qr-code">${esc(d.codigoSeguridad)}</span></div>` : ''}
          ${d.fechaFirma ? `<div><b>Fecha de firma digital:</b> ${esc(d.fechaFirma)}</div>` : ''}
          ${d.qrDataUrl ? '<small>Verificación DGII &middot; escanee el código para validar este comprobante fiscal electrónico.</small>' : ''}
        </div>
      </div>`;
  }

  // d.selloClase, d.pie y d.marcaAgua son opcionales (los manda servicios);
  // d.titulo y d.etiquetaCliente, para otros documentos (comprobante de gasto).
  function textosComunes(d) {
    return {
      titulo: d.titulo ? esc(d.titulo) : (d.isCot ? 'COTIZACIÓN' : 'FACTURA'),
      cliente: esc(d.etiquetaCliente || (d.isCot ? 'Cliente' : 'Facturar a')),
      etiquetaNcf: d.fiscalMode === 'ecf' ? 'e-NCF' : 'NCF',
      sello: ['ok', 'warn', 'bad'].includes(d.selloClase) ? d.selloClase
        : (d.anulada ? 'bad' : ((d.isCot || Number(d.balance) <= 0.01) ? 'ok' : 'warn')),
      fecha: d.fechaTexto || '',
      vence: d.vencimientoTexto || '',
      etiquetaVence: d.isCot ? 'Válida hasta' : 'Válido hasta',
      letras: montoEnLetras(d.total),
      seguridad: bloqueSeguridad(d),
      pie: d.pie ? esc(d.pie) : (d.isCot
        ? 'Cotización sin valor fiscal. Precios sujetos a cambio después de la fecha de validez. Documento generado electrónicamente.'
        : 'Documento generado electrónicamente por Tecno Caja POS. Válido sin firma ni sello. Gracias por su compra.')
    };
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  const BASE_CSS = `
.tcfac-root{ display:block; background:#eef1f4; padding:14px; overflow:visible;
  font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif; color:#1f2937; }
.tcfac-root *{ margin:0; padding:0; box-sizing:border-box; }
.tcfac-root .tcf-page{ position:relative; zoom:var(--tcf-zoom, 1);
  width:calc(210mm / var(--tcf-zoom, 1)); min-height:calc(297mm / var(--tcf-zoom, 1)); margin:0 auto;
  padding:16mm 18mm; background:#fff; overflow:hidden; font-size:10.5px; color:#1f2937;
  -webkit-print-color-adjust:exact; print-color-adjust:exact; filter:drop-shadow(0 1px 5px rgba(0,0,0,.16)); }
.tcfac-root .tcf-wm{ position:absolute; top:45%; left:50%;
  transform:translate(-50%,-50%) rotate(-24deg); font-size:110px; font-weight:800;
  letter-spacing:6px; white-space:nowrap; color:rgba(220,38,38,.09); pointer-events:none; z-index:2; }
.tcfac-root .tcf-content{ position:relative; z-index:1; }
.tcfac-root tr{ break-inside:avoid; }
.tcfac-root .tcf-stamp{ display:inline-block; margin-top:3mm; padding:3px 12px; border:2px solid;
  border-radius:3px; font-size:10px; font-weight:800; letter-spacing:1.5px; transform:rotate(-3deg); }
.tcfac-root .tcf-stamp.warn{ color:#b45309; border-color:#b45309; }
.tcfac-root .tcf-stamp.ok{ color:#15803d; border-color:#15803d; }
.tcfac-root .tcf-stamp.bad{ color:#b91c1c; border-color:#b91c1c; }
.tcfac-root .tcf-qr{ margin-top:6mm; display:flex; align-items:center; gap:4mm; break-inside:avoid; }
.tcfac-root .tcf-qr img{ width:30mm; height:30mm; flex:none; }
.tcfac-root .tcf-qr-txt{ font-size:9.5px; line-height:1.75; color:#374151; }
.tcfac-root .tcf-qr-txt b{ color:#111827; }
.tcfac-root .tcf-qr-code{ font-family:Consolas,"Courier New",monospace; font-size:12px; font-weight:700;
  letter-spacing:2px; color:#111827; }
.tcfac-root .tcf-qr-txt small{ display:block; margin-top:1mm; font-size:8.5px; line-height:1.5; color:#6b7280; }
.tcfac-root .tcf-page :is(.tcf-tot, .tce-tot, .tcr-tot, .tcb-tot){ width:94mm; }
.tcfac-root .tcf-page :is(.tcf-tot, .tce-tot, .tcr-tot, .tcb-tot) .r{ gap:5mm; }
.tcfac-root .tcf-page :is(.tcf-tot, .tce-tot, .tcr-tot, .tcb-tot) .r span{ white-space:nowrap; }
.tcfac-root .tcf-page .tcr-box{ width:94mm; }
.tcfac-root .tcf-page .tcf-head{ gap:10mm; }
.tcfac-root .tcf-page .tcf-doc{ flex:0 1 100mm; min-width:0; }
.tcfac-root .tcf-inote{ display:block; margin-top:.6mm; font-size:8.5px; font-weight:400; color:#6b7280; white-space:normal; }
.tcfac-root .tcf-notas{ margin-top:6mm; break-inside:avoid; }
.tcfac-root .tcf-notas-t{ font-size:8.5px; font-weight:800; letter-spacing:1px; text-transform:uppercase;
  color:var(--acc-ink); margin-bottom:1.5mm; }
.tcfac-root .tcf-np{ display:block; font-size:9.5px; line-height:1.5; color:#4b5563; }
.tcfac-root .tcf-np + .tcf-np{ margin-top:1.5mm; }
.tcfac-root .tcf-np strong{ color:#1f2937; font-weight:700; }
.tcfac-root .tcf-terminos{ padding-top:4mm; border-top:1px solid #e5e7eb; break-inside:auto; }
.tcfac-root .tcf-terminos .tcf-np{ font-size:8.5px; }
.tcfac-root .tcf-firmas{ display:grid; grid-template-columns:1fr 1fr; gap:20mm; margin:14mm 6mm 0; align-items:end; break-inside:avoid; }
.tcfac-root .tcf-firmas.solo{ grid-template-columns:74mm; }
.tcfac-root .tcf-firma{ display:flex; flex-direction:column; justify-content:flex-end; }
.tcfac-root .tcf-firma img{ max-height:18mm; max-width:56mm; object-fit:contain; align-self:center; margin-bottom:1mm; }
.tcfac-root .tcf-firma-l{ border-top:1px solid #6b7280; padding-top:1.8mm; text-align:center; font-size:9px; color:#4b5563; }
.tcfac-root .tcf-dsig{ border:1px solid var(--acc); border-radius:1.5mm; background:var(--acc-tint); padding:2mm 3mm; }
.tcfac-root .tcf-dsig-h{ font-size:8px; font-weight:800; letter-spacing:.5px; color:var(--acc-ink); }
.tcfac-root .tcf-dsig-n{ font-size:9.5px; font-weight:700; color:#111827; margin-top:.5mm; }
.tcfac-root .tcf-dsig-x{ font-size:8.5px; line-height:1.35; color:#4b5563; }
@media print{
  .tcfac-root{ background:#fff; padding:0; overflow:visible; }
  .tcfac-root .tcf-page{ margin:0; filter:none; width:auto; min-height:auto;
    -webkit-box-decoration-break:clone; box-decoration-break:clone; }
}
@media screen and (max-width:820px){
  .tcfac-root .tcf-page{ transform:scale(.6); transform-origin:top left; }
}
`;

  const CSS = {
    clasica: `
.tcfac-root .tcf-head{ display:flex; justify-content:space-between; align-items:flex-start; gap:14mm; padding-bottom:6mm; }
.tcfac-root .tcf-logo{ max-height:26mm; max-width:70mm; display:block; margin-bottom:3mm; }
.tcfac-root .tcf-brand-fallback{ font-size:20px; font-weight:800; color:var(--acc-ink); letter-spacing:.5px; margin-bottom:3mm; }
.tcfac-root .tcf-em{ font-size:9.5px; line-height:1.5; color:#4b5563; }
.tcfac-root .tcf-em strong{ color:#1f2937; }
.tcfac-root .tcf-doc{ text-align:right; min-width:62mm; }
.tcfac-root .tcf-title{ font-size:24px; font-weight:800; letter-spacing:4px; color:var(--acc-ink); line-height:1; }
.tcfac-root .tcf-chip{ display:inline-block; margin-top:3mm; padding:2mm 3mm; border:1.5px solid var(--acc);
  border-radius:3px; font-size:12px; font-weight:800; letter-spacing:.5px; color:#111827; }
.tcfac-root .tcf-chip span{ color:var(--acc-ink); font-weight:700; letter-spacing:1px; margin-right:1.5mm; }
.tcfac-root .tcf-meta{ margin-top:4mm; font-size:10px; line-height:1.7; color:#374151; }
.tcfac-root .tcf-meta b{ color:#111827; }
.tcfac-root .tcf-rule{ height:2.5px; background:var(--acc); margin:0 0 6mm; }
.tcfac-root .tcf-parties{ display:grid; grid-template-columns:1fr 1fr; gap:12mm; margin-bottom:7mm; }
.tcfac-root .tcf-blabel{ font-size:8.5px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase;
  color:#6b7280; padding-bottom:2mm; border-bottom:1px solid #e5e7eb; margin-bottom:2.5mm; }
.tcfac-root .tcf-pname{ font-size:12px; font-weight:700; color:#111827; margin-bottom:1mm; }
.tcfac-root .tcf-pline{ font-size:9.5px; line-height:1.6; color:#4b5563; }
.tcfac-root .tcf-pay{ display:flex; justify-content:space-between; font-size:9.5px; line-height:1.9; color:#4b5563; }
.tcfac-root .tcf-pay span:last-child{ color:#111827; font-weight:600; }
.tcfac-root .tcf-items{ width:100%; border-collapse:collapse; margin-bottom:4mm; }
.tcfac-root .tcf-items thead th{ background:var(--acc-tint); color:#374151; font-size:8.5px; font-weight:700;
  letter-spacing:.6px; text-transform:uppercase; text-align:right; padding:3mm 2.5mm;
  border-top:1.5px solid var(--acc); border-bottom:1.5px solid var(--acc); }
.tcfac-root .tcf-items thead th.i{ text-align:center; width:9mm; }
.tcfac-root .tcf-items thead th.d{ text-align:left; }
.tcfac-root .tcf-items tbody td{ padding:2.6mm 2.5mm; font-size:10px; border-bottom:1px solid #edf0f2; vertical-align:top; }
.tcfac-root .tcf-items tbody tr:last-child td{ border-bottom:1px solid #d1d5db; }
.tcfac-root .tcf-ci{ text-align:center; color:#9ca3af; }
.tcfac-root .tcf-cd{ text-align:left; color:#1f2937; }
.tcfac-root .tcf-cn{ text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
.tcfac-root .tcf-tw{ display:flex; justify-content:flex-end; }
.tcfac-root .tcf-tot{ width:78mm; }
.tcfac-root .tcf-tot .r{ display:flex; justify-content:space-between; padding:1.6mm 0; font-size:10px; color:#4b5563; }
.tcfac-root .tcf-tot .r span:last-child{ color:#111827; font-variant-numeric:tabular-nums; }
.tcfac-root .tcf-tot .r.grand{ border-top:2px solid #111827; margin-top:1mm; padding-top:2.5mm;
  font-size:14px; font-weight:800; color:#111827; }
.tcfac-root .tcf-tot .r.paid{ color:#15803d; }
.tcfac-root .tcf-tot .r.due{ font-weight:700; color:#b45309; }
.tcfac-root .tcf-words{ margin:5mm 0 0; padding:2.5mm 3mm; background:#f9fafb; border:1px solid #e5e7eb;
  border-radius:3px; font-size:9.5px; line-height:1.5; color:#374151; }
.tcfac-root .tcf-words b{ color:#111827; letter-spacing:.3px; }
.tcfac-root .tcf-note{ margin-top:6mm; font-size:9.5px; line-height:1.6; color:#4b5563; white-space:pre-wrap; }
.tcfac-root .tcf-foot{ margin-top:12mm; padding-top:5mm; border-top:1px solid #e5e7eb;
  font-size:8.5px; line-height:1.6; color:#6b7280; }
.tcfac-root .tcf-foot b{ display:block; color:var(--acc-ink); font-size:10px; margin-bottom:1mm; letter-spacing:.3px; }
`,
    ejecutiva: `
.tcfac-root .tce-head{ display:flex; justify-content:space-between; align-items:flex-start; gap:12mm; padding-bottom:5mm; }
.tcfac-root .tce-brand{ display:flex; align-items:flex-start; gap:4mm; min-width:0; }
.tcfac-root .tce-logo{ max-height:20mm; max-width:42mm; display:block; flex:none; }
.tcfac-root .tce-mark{ width:15mm; height:15mm; flex:none; border-radius:2mm; background:var(--acc); color:var(--on-acc);
  display:flex; align-items:center; justify-content:center; font-size:17px; font-weight:800; letter-spacing:.5px; }
.tcfac-root .tce-name{ font-size:15px; font-weight:800; color:var(--acc-ink); line-height:1.2; margin-bottom:1.2mm; }
.tcfac-root .tce-em{ font-size:9.5px; line-height:1.55; color:#6b7280; }
.tcfac-root .tce-doc{ text-align:right; min-width:60mm; flex:none; }
.tcfac-root .tce-title{ font-size:30px; font-weight:800; color:var(--acc-ink); letter-spacing:1px; line-height:1; }
.tcfac-root .tce-num{ margin-top:2mm; font-size:10px; color:#6b7280; }
.tcfac-root .tce-ncf{ margin-top:2.5mm; font-size:11.5px; font-weight:700; color:#111827; letter-spacing:.3px; }
.tcfac-root .tce-ncf span{ color:var(--acc-ink); font-weight:800; margin-right:1.5mm; }
.tcfac-root .tce-docline{ font-size:9.5px; line-height:1.6; color:#4b5563; }
.tcfac-root .tce-rule{ height:2px; background:var(--acc); margin:0 0 6mm; }
.tcfac-root .tce-grid{ display:grid; grid-template-columns:1fr 1fr; gap:5mm 12mm; margin-bottom:7mm; }
.tcfac-root .tce-label{ font-size:8.5px; font-weight:800; letter-spacing:1px; text-transform:uppercase;
  color:var(--acc-ink); margin-bottom:1.5mm; }
.tcfac-root .tce-val{ font-size:10.5px; line-height:1.55; color:#374151; }
.tcfac-root .tce-val b{ color:#111827; font-weight:700; }
.tcfac-root .tce-items{ width:100%; border-collapse:collapse; margin-bottom:5mm; }
.tcfac-root .tce-items th{ background:var(--acc); color:var(--on-acc); font-size:9px; font-weight:700;
  letter-spacing:.3px; text-align:right; padding:2.8mm 3mm; }
.tcfac-root .tce-items td{ padding:2.6mm 3mm; font-size:10px; color:#1f2937; text-align:right; white-space:nowrap;
  border-bottom:1px solid #e5e7eb; vertical-align:top; font-variant-numeric:tabular-nums; }
.tcfac-root .tce-items tbody tr:nth-child(even) td{ background:var(--acc-tint); }
.tcfac-root .tce-items .d{ text-align:left; white-space:normal; }
.tcfac-root .tce-bottom{ display:flex; justify-content:space-between; align-items:flex-start; gap:10mm; }
.tcfac-root .tce-words{ flex:1; min-width:0; padding-top:1.5mm; }
.tcfac-root .tce-tot{ width:74mm; flex:none; }
.tcfac-root .tce-tot .r{ display:flex; justify-content:space-between; padding:1.4mm 0; font-size:10px; color:#4b5563; }
.tcfac-root .tce-tot .r span:last-child{ color:#111827; font-variant-numeric:tabular-nums; }
.tcfac-root .tce-tot .r.grand{ margin-top:1.5mm; padding-top:2.5mm; border-top:2px solid var(--acc);
  font-size:17px; font-weight:800; }
.tcfac-root .tce-tot .r.grand span{ color:var(--acc-ink); }
.tcfac-root .tce-tot .r.paid span:first-child{ color:#15803d; }
.tcfac-root .tce-tot .r.due span{ color:#b45309; font-weight:700; }
.tcfac-root .tce-note{ margin-top:6mm; font-size:9.5px; line-height:1.6; color:#4b5563; white-space:pre-wrap; }
.tcfac-root .tce-foot{ margin-top:10mm; padding-top:4mm; border-top:1px solid #e5e7eb;
  font-size:8.5px; line-height:1.6; color:#6b7280; }
.tcfac-root .tce-foot b{ color:var(--acc-ink); }
`,
    recuadro: `
.tcfac-root .tcr-head{ display:flex; justify-content:space-between; align-items:flex-start; gap:12mm; margin-bottom:7mm; }
.tcfac-root .tcr-brand{ min-width:0; padding-top:1mm; }
.tcfac-root .tcr-logo{ max-height:22mm; max-width:55mm; display:block; margin-bottom:3mm; }
.tcfac-root .tcr-circle{ width:17mm; height:17mm; border-radius:50%; background:var(--acc); color:var(--on-acc);
  display:flex; align-items:center; justify-content:center; font-size:17px; font-weight:800; margin-bottom:3mm; }
.tcfac-root .tcr-name{ font-size:14px; font-weight:800; color:var(--acc-ink); text-transform:uppercase;
  letter-spacing:.4px; margin-bottom:1mm; }
.tcfac-root .tcr-em{ font-size:9.5px; line-height:1.6; color:#6b7280; }
.tcfac-root .tcr-box{ width:80mm; flex:none; border:1.5px solid var(--acc); border-radius:1.5mm; overflow:hidden; }
.tcfac-root .tcr-boxtitle{ background:var(--acc); color:var(--on-acc); font-size:13px; font-weight:800;
  letter-spacing:3px; text-align:center; padding:2.2mm 0; }
.tcfac-root .tcr-rows{ padding:2.5mm 4mm 3mm; }
.tcfac-root .tcr-row{ display:flex; justify-content:space-between; align-items:baseline; gap:4mm; padding:1.1mm 0;
  font-size:10px; color:#111827; }
.tcfac-root .tcr-row span:first-child{ font-size:8.5px; font-weight:800; letter-spacing:.8px; text-transform:uppercase;
  color:var(--acc-ink); white-space:nowrap; }
.tcfac-root .tcr-row span:last-child{ text-align:right; font-weight:600; }
.tcfac-root .tcr-client{ display:grid; grid-template-columns:1.3fr 1fr; gap:10mm; background:#f7f7f8;
  border:1px solid #e5e7eb; border-radius:1.5mm; padding:4mm 5mm; margin-bottom:7mm; }
.tcfac-root .tcr-label{ font-size:8.5px; font-weight:800; letter-spacing:1px; text-transform:uppercase;
  color:var(--acc-ink); margin-bottom:1.5mm; }
.tcfac-root .tcr-cname{ font-size:12px; font-weight:700; color:#111827; margin-bottom:1mm; }
.tcfac-root .tcr-line{ font-size:9.5px; line-height:1.6; color:#4b5563; }
.tcfac-root .tcr-pair{ display:flex; justify-content:space-between; gap:4mm; font-size:9.5px; line-height:1.85; color:#4b5563; }
.tcfac-root .tcr-pair span:last-child{ color:#111827; font-weight:600; text-align:right; }
.tcfac-root .tcr-items{ width:100%; border-collapse:collapse; margin-bottom:4mm; }
.tcfac-root .tcr-items th,
.tcfac-root .tcr-items td{ border:1px solid #d1d5db; padding:2.4mm 3mm; font-size:10px; text-align:right;
  vertical-align:top; white-space:nowrap; }
.tcfac-root .tcr-items th{ background:#f3f4f6; color:#111827; font-size:9px; font-weight:700; }
.tcfac-root .tcr-items td{ color:#1f2937; font-variant-numeric:tabular-nums; }
.tcfac-root .tcr-items .d{ text-align:left; white-space:normal; }
.tcfac-root .tcr-tw{ display:flex; justify-content:flex-end; }
.tcfac-root .tcr-tot{ width:74mm; }
.tcfac-root .tcr-tot .r{ display:flex; justify-content:space-between; padding:1.2mm 0; font-size:10px; color:#4b5563; }
.tcfac-root .tcr-tot .r span:last-child{ color:#111827; font-variant-numeric:tabular-nums; }
.tcfac-root .tcr-tot .r.grand{ margin-top:1.5mm; padding-top:2.5mm; border-top:1.5px solid #111827;
  font-size:18px; font-weight:800; }
.tcfac-root .tcr-tot .r.grand span{ color:var(--acc-ink); }
.tcfac-root .tcr-tot .r.paid span:first-child{ color:#15803d; }
.tcfac-root .tcr-tot .r.due span{ color:#b45309; font-weight:700; }
.tcfac-root .tcr-words{ margin-top:4mm; font-size:9.5px; line-height:1.5; color:#374151; }
.tcfac-root .tcr-words b{ color:#111827; }
.tcfac-root .tcr-note{ margin-top:5mm; font-size:9.5px; line-height:1.6; font-weight:700; text-transform:uppercase;
  color:var(--acc-ink); white-space:pre-wrap; }
.tcfac-root .tcr-firmas{ display:grid; grid-template-columns:1fr 1fr; gap:24mm; margin:18mm 8mm 0; break-inside:avoid; }
.tcfac-root .tcr-firmas div{ border-top:1px solid #6b7280; padding-top:1.8mm; text-align:center; font-size:9px; color:#4b5563; }
.tcfac-root .tcr-foot{ margin-top:9mm; font-size:8.5px; line-height:1.6; color:#9ca3af; text-align:center; }
`,
    banner: `
.tcfac-root .tcb-band{ margin:-16mm -18mm 8mm; padding:12mm 18mm 10mm; background:var(--acc); color:var(--on-acc);
  display:flex; justify-content:space-between; align-items:center; gap:10mm; }
.tcfac-root .tcb-brand{ display:flex; align-items:center; gap:5mm; min-width:0; }
.tcfac-root .tcb-logo{ flex:none; background:#fff; border-radius:2mm; padding:1.8mm; }
.tcfac-root .tcb-logo img{ max-height:16mm; max-width:34mm; display:block; }
.tcfac-root .tcb-mark{ flex:none; width:16mm; height:16mm; border-radius:2mm; background:rgba(255,255,255,.16);
  border:1px solid rgba(255,255,255,.35); display:flex; align-items:center; justify-content:center;
  font-size:17px; font-weight:800; }
.tcfac-root .tcb-bname{ font-size:10px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase;
  opacity:.85; margin-bottom:1.5mm; }
.tcfac-root .tcb-title{ font-size:30px; font-weight:800; letter-spacing:1.5px; line-height:1; }
.tcfac-root .tcb-meta{ text-align:right; font-size:10px; line-height:1.75; flex:none; }
.tcfac-root .tcb-meta b{ font-weight:700; opacity:.8; margin-right:1.5mm; }
.tcfac-root .tcb-cards{ display:grid; grid-template-columns:1fr 1fr; gap:4mm 5mm; margin-bottom:8mm; }
.tcfac-root .tcb-card{ background:#f4f5f7; border-left:3px solid var(--acc); border-radius:1.5mm; padding:3.5mm 4.5mm; }
.tcfac-root .tcb-ctitle{ font-size:9px; font-weight:800; color:#111827; letter-spacing:.3px; margin-bottom:1.8mm; }
.tcfac-root .tcb-cname{ font-size:11.5px; font-weight:700; color:#111827; margin-bottom:.8mm; }
.tcfac-root .tcb-line{ font-size:9.5px; line-height:1.6; color:#4b5563; }
.tcfac-root .tcb-items{ width:100%; border-collapse:collapse; margin-bottom:5mm; }
.tcfac-root .tcb-items th{ font-size:9px; font-weight:800; color:#111827; text-align:right; padding:2.5mm 3mm;
  border-bottom:2px solid var(--acc); }
.tcfac-root .tcb-items td{ font-size:10px; color:#1f2937; text-align:right; padding:2.8mm 3mm; white-space:nowrap;
  border-bottom:1px solid #eceef1; vertical-align:top; font-variant-numeric:tabular-nums; }
.tcfac-root .tcb-items .d{ text-align:left; white-space:normal; }
.tcfac-root .tcb-bottom{ display:flex; justify-content:space-between; align-items:flex-start; gap:10mm; }
.tcfac-root .tcb-words{ flex:1; min-width:0; }
.tcfac-root .tcb-wlabel{ font-size:9px; font-weight:800; color:#111827; margin-bottom:1.5mm; }
.tcfac-root .tcb-wtext{ font-size:10.5px; line-height:1.5; color:#374151; }
.tcfac-root .tcb-tot{ width:74mm; flex:none; }
.tcfac-root .tcb-tot .r{ display:flex; justify-content:space-between; padding:1.3mm 0; font-size:10px; color:#4b5563; }
.tcfac-root .tcb-tot .r span:last-child{ color:#111827; font-variant-numeric:tabular-nums; }
.tcfac-root .tcb-tot .r.grand{ align-items:center; margin-top:1.5mm; padding-top:2.5mm; border-top:1px solid #d1d5db;
  font-size:19px; font-weight:800; }
.tcfac-root .tcb-tot .r.grand span{ color:var(--acc-ink); }
.tcfac-root .tcb-tot .r.grand span:first-child{ font-size:11px; color:#4b5563; }
.tcfac-root .tcb-tot .r.paid span:first-child{ color:#15803d; }
.tcfac-root .tcb-tot .r.due span{ color:#b45309; font-weight:700; }
.tcfac-root .tcb-note{ margin-top:6mm; font-size:9.5px; line-height:1.6; color:#4b5563; white-space:pre-wrap; }
.tcfac-root .tcb-foot{ margin-top:10mm; padding-top:4mm; border-top:1px solid #e5e7eb;
  font-size:8.5px; line-height:1.6; color:#6b7280; }
.tcfac-root .tcb-foot b{ color:var(--acc-ink); }
`
  };

  // ── Plantillas ────────────────────────────────────────────────────────────
  function dibujarClasica(d, t) {
    const rows = d.items.map((it, i) => `
      <tr>
        <td class="tcf-ci">${i + 1}</td>
        <td class="tcf-cd">${celdaDescripcion(it)}</td>
        <td class="tcf-cn">${Number(it.cantidad || 0)}</td>
        <td class="tcf-cn">${dinero(it.precio)}</td>
        <td class="tcf-cn">${esc(celdaItbis(it))}</td>
        <td class="tcf-cn">${dinero(it.total)}</td>
      </tr>`).join('');
    const logo = d.empresa.logo
      ? `<img src="${esc(d.empresa.logo)}" class="tcf-logo" alt="logo">`
      : `<div class="tcf-brand-fallback">${esc(d.empresa.nombre)}</div>`;

    return `
      <div class="tcf-head">
        <div>
          ${logo}
          ${d.empresa.rnc ? `<div class="tcf-em"><strong>RNC:</strong> ${esc(d.empresa.rnc)}</div>` : ''}
          ${d.empresa.direccion ? `<div class="tcf-em">${esc(d.empresa.direccion)}</div>` : ''}
          ${d.empresa.telefono ? `<div class="tcf-em"><strong>Tel:</strong> ${esc(d.empresa.telefono)}</div>` : ''}
          ${d.empresa.correo ? `<div class="tcf-em">${esc(d.empresa.correo)}</div>` : ''}
        </div>
        <div class="tcf-doc">
          <div class="tcf-title">${t.titulo}</div>
          ${d.ncf ? `<div class="tcf-chip"><span>${t.etiquetaNcf}</span> ${esc(d.ncf)}</div>` : ''}
          <div class="tcf-meta">
            ${d.ncfTipoLabel ? `<div><b>Tipo de comprobante:</b> ${esc(d.ncfTipoLabel)}</div>` : ''}
            ${d.numero ? `<div><b>No.:</b> ${esc(d.numero)}</div>` : ''}
            <div><b>Fecha de emisión:</b> ${esc(t.fecha)}</div>
            ${t.vence ? `<div><b>${d.isCot ? 'Válida hasta' : 'NCF válido hasta'}:</b> ${esc(t.vence)}</div>` : ''}
          </div>
          <div class="tcf-stamp ${t.sello}">${esc(d.estadoLabel)}</div>
        </div>
      </div>
      <div class="tcf-rule"></div>
      <div class="tcf-parties">
        <div>
          <div class="tcf-blabel">${t.cliente}</div>
          <div class="tcf-pname">${esc(d.cliente.nombre)}</div>
          ${d.cliente.rnc ? `<div class="tcf-pline">RNC / Cédula: ${esc(d.cliente.rnc)}</div>` : ''}
          ${d.cliente.dir ? `<div class="tcf-pline">${esc(d.cliente.dir)}</div>` : ''}
          ${d.cliente.tel ? `<div class="tcf-pline">Tel: ${esc(d.cliente.tel)}</div>` : ''}
          ${d.cliente.correo ? `<div class="tcf-pline">${esc(d.cliente.correo)}</div>` : ''}
        </div>
        <div>
          <div class="tcf-blabel">${d.isCot ? 'Condiciones' : 'Detalles de pago'}</div>
          <div class="tcf-pay"><span>Condición</span><span>${esc(d.condicionPago)}</span></div>
          ${d.metodoPago ? `<div class="tcf-pay"><span>Método de pago</span><span>${esc(d.metodoPago)}</span></div>` : ''}
          <div class="tcf-pay"><span>Estado</span><span>${esc(d.estadoLabel)}</span></div>
          ${Number(d.pagado) ? `<div class="tcf-pay"><span>Pagado</span><span>${dinero(d.pagado)}</span></div>` : ''}
          ${(Number(d.balance) > 0.01 && !d.isCot) ? `<div class="tcf-pay"><span>Saldo pendiente</span><span>${dinero(d.balance)}</span></div>` : ''}
          ${d.cajero ? `<div class="tcf-pay"><span>Cajero</span><span>${esc(d.cajero)}</span></div>` : ''}
        </div>
      </div>
      <table class="tcf-items">
        <thead><tr>
          <th class="i">#</th><th class="d">Descripción</th>
          <th>Cant.</th><th>Precio unit.</th><th>ITBIS</th><th>Importe</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="tcf-tw"><div class="tcf-tot">
        ${filasResumen(lineasTotales(d))}
        ${filasResumen([['TOTAL', dinero(d.total), 'grand']])}
        ${filasResumen(lineasPago(d))}
      </div></div>
      <div class="tcf-words"><b>Son:</b> ${esc(t.letras)}</div>
      ${t.seguridad}
      ${d.mensaje ? `<div class="tcf-note">${esc(d.mensaje)}</div>` : ''}
      ${cierre(d)}
      <div class="tcf-foot"><b>${esc(d.empresa.nombre)}</b>${t.pie}</div>`;
  }

  function dibujarEjecutiva(d, t) {
    const rows = d.items.map((it) => `
      <tr>
        <td class="d">${celdaDescripcion(it)}</td>
        <td>${Number(it.cantidad || 0)}</td>
        <td>${dinero(it.precio)}</td>
        <td>${esc(celdaItbis(it))}</td>
        <td>${dinero(it.total)}</td>
      </tr>`).join('');
    const marca = d.empresa.logo
      ? `<img src="${esc(d.empresa.logo)}" class="tce-logo" alt="logo">`
      : `<div class="tce-mark">${esc(iniciales(d.empresa.nombre))}</div>`;
    const cliente = [
      `<b>${esc(d.cliente.nombre)}</b>`,
      d.cliente.rnc ? `RNC / Cédula: ${esc(d.cliente.rnc)}` : '',
      d.cliente.tel ? `Tel: ${esc(d.cliente.tel)}` : '',
      d.cliente.correo ? esc(d.cliente.correo) : '',
      d.cliente.dir ? esc(d.cliente.dir) : ''
    ].filter(Boolean).join('<br>');

    return `
      <div class="tce-head">
        <div class="tce-brand">
          ${marca}
          <div>
            <div class="tce-name">${esc(d.empresa.nombre)}</div>
            ${d.empresa.rnc ? `<div class="tce-em">RNC: ${esc(d.empresa.rnc)}</div>` : ''}
            ${d.empresa.direccion ? `<div class="tce-em">${esc(d.empresa.direccion)}</div>` : ''}
            ${d.empresa.telefono ? `<div class="tce-em">Tel: ${esc(d.empresa.telefono)}</div>` : ''}
            ${d.empresa.correo ? `<div class="tce-em">${esc(d.empresa.correo)}</div>` : ''}
          </div>
        </div>
        <div class="tce-doc">
          <div class="tce-title">${t.titulo}</div>
          ${d.numero ? `<div class="tce-num">Nº ${esc(d.numero)}</div>` : ''}
          ${d.ncf ? `<div class="tce-ncf"><span>${t.etiquetaNcf}</span>${esc(d.ncf)}</div>` : ''}
          ${d.ncfTipoLabel ? `<div class="tce-docline">${esc(d.ncfTipoLabel)}</div>` : ''}
          ${t.vence ? `<div class="tce-docline">${t.etiquetaVence}: ${esc(t.vence)}</div>` : ''}
          <div class="tcf-stamp ${t.sello}">${esc(d.estadoLabel)}</div>
        </div>
      </div>
      <div class="tce-rule"></div>
      <div class="tce-grid">
        <div>
          <div class="tce-label">${t.cliente}</div>
          <div class="tce-val">${cliente}</div>
        </div>
        <div>
          <div class="tce-label">Fecha de emisión</div>
          <div class="tce-val">${esc(t.fecha)}</div>
        </div>
        ${d.metodoPago ? `<div>
          <div class="tce-label">Método de pago</div>
          <div class="tce-val">${esc(d.metodoPago)}</div>
        </div>` : ''}
        <div>
          <div class="tce-label">Condición</div>
          <div class="tce-val">${esc(capital(d.condicionPago))}${d.cajero ? ` &middot; Cajero: ${esc(d.cajero)}` : ''}</div>
        </div>
      </div>
      <table class="tce-items">
        <thead><tr>
          <th class="d">Descripción</th><th>Cantidad</th><th>Precio unit.</th><th>ITBIS</th><th>Importe</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="tce-bottom">
        <div class="tce-words">
          <div class="tce-label">Son</div>
          <div class="tce-val">${esc(t.letras)}</div>
        </div>
        <div class="tce-tot">
          ${filasResumen(lineasTotales(d))}
          ${filasResumen([['TOTAL', dinero(d.total), 'grand']])}
          ${filasResumen(lineasPago(d))}
        </div>
      </div>
      ${t.seguridad}
      ${d.mensaje ? `<div class="tce-note">${esc(d.mensaje)}</div>` : ''}
      ${cierre(d)}
      <div class="tce-foot"><b>${esc(d.empresa.nombre)}</b> &middot; ${t.pie}</div>`;
  }

  function dibujarRecuadro(d, t) {
    const rows = d.items.map((it) => `
      <tr>
        <td class="d">${celdaDescripcion(it)}</td>
        <td>${Number(it.cantidad || 0)}</td>
        <td>${dinero(it.precio)}</td>
        <td>${esc(celdaItbis(it))}</td>
        <td>${dinero(it.total)}</td>
      </tr>`).join('');
    const marca = d.empresa.logo
      ? `<img src="${esc(d.empresa.logo)}" class="tcr-logo" alt="logo">`
      : `<div class="tcr-circle">${esc(iniciales(d.empresa.nombre))}</div>`;
    const fila = (label, valor) => `<div class="tcr-row"><span>${esc(label)}</span><span>${esc(valor)}</span></div>`;
    const par = (label, valor) => `<div class="tcr-pair"><span>${esc(label)}</span><span>${esc(valor)}</span></div>`;

    return `
      <div class="tcr-head">
        <div class="tcr-brand">
          ${marca}
          <div class="tcr-name">${esc(d.empresa.nombre)}</div>
          ${d.empresa.telefono ? `<div class="tcr-em">Tel: ${esc(d.empresa.telefono)}</div>` : ''}
          ${d.empresa.direccion ? `<div class="tcr-em">${esc(d.empresa.direccion)}</div>` : ''}
          ${d.empresa.correo ? `<div class="tcr-em">${esc(d.empresa.correo)}</div>` : ''}
        </div>
        <div class="tcr-box">
          <div class="tcr-boxtitle">${t.titulo}</div>
          <div class="tcr-rows">
            ${d.empresa.rnc ? fila('RNC', d.empresa.rnc) : ''}
            ${d.ncf ? fila(t.etiquetaNcf, d.ncf) : ''}
            ${d.ncfTipoLabel ? fila('Tipo', d.ncfTipoLabel) : ''}
            ${d.numero ? fila('Número', d.numero) : ''}
            ${fila('Fecha', t.fecha)}
            ${t.vence ? fila(t.etiquetaVence, t.vence) : ''}
            ${fila('Estado', d.estadoLabel)}
          </div>
        </div>
      </div>
      <div class="tcr-client">
        <div>
          <div class="tcr-label">${d.etiquetaCliente ? t.cliente : 'Señor(es)'}</div>
          <div class="tcr-cname">${esc(d.cliente.nombre)}</div>
          ${d.cliente.rnc ? `<div class="tcr-line">RNC / Cédula: ${esc(d.cliente.rnc)}</div>` : ''}
          ${d.cliente.tel ? `<div class="tcr-line">Tel: ${esc(d.cliente.tel)}</div>` : ''}
          ${d.cliente.correo ? `<div class="tcr-line">${esc(d.cliente.correo)}</div>` : ''}
          ${d.cliente.dir ? `<div class="tcr-line">${esc(d.cliente.dir)}</div>` : ''}
        </div>
        <div>
          <div class="tcr-label">Condiciones</div>
          ${par('Condición', capital(d.condicionPago))}
          ${d.metodoPago ? par('Método de pago', d.metodoPago) : ''}
          ${d.cajero ? par('Cajero', d.cajero) : ''}
        </div>
      </div>
      <table class="tcr-items">
        <thead><tr>
          <th class="d">Descripción</th><th>Cant.</th><th>Precio</th><th>ITBIS</th><th>Valor</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="tcr-tw"><div class="tcr-tot">
        ${filasResumen(lineasTotales(d))}
        ${filasResumen([['TOTAL', dinero(d.total), 'grand']])}
        ${filasResumen(lineasPago(d))}
      </div></div>
      <div class="tcr-words"><b>Son:</b> ${esc(t.letras)}</div>
      ${d.mensaje ? `<div class="tcr-note">${esc(d.mensaje)}</div>` : ''}
      ${t.seguridad}
      ${d.firmas ? cierre(d) : `${bloqueNotas(d)}<div class="tcr-firmas"><div>Firma autorizada</div><div>Firma recibido</div></div>`}
      <div class="tcr-foot">${t.pie}</div>`;
  }

  function dibujarBanner(d, t) {
    const rows = d.items.map((it) => `
      <tr>
        <td class="d">${celdaDescripcion(it)}</td>
        <td>${Number(it.cantidad || 0)}</td>
        <td>${dinero(it.precio)}</td>
        <td>${esc(celdaItbis(it))}</td>
        <td>${dinero(it.total)}</td>
      </tr>`).join('');
    const marca = d.empresa.logo
      ? `<div class="tcb-logo"><img src="${esc(d.empresa.logo)}" alt="logo"></div>`
      : `<div class="tcb-mark">${esc(iniciales(d.empresa.nombre))}</div>`;
    const meta = (label, valor) => `<div><b>${esc(label)}:</b>${esc(valor)}</div>`;
    const linea = (texto) => `<div class="tcb-line">${texto}</div>`;

    return `
      <div class="tcb-band">
        <div class="tcb-brand">
          ${marca}
          <div>
            <div class="tcb-bname">${esc(d.empresa.nombre)}</div>
            <div class="tcb-title">${t.titulo}</div>
          </div>
        </div>
        <div class="tcb-meta">
          ${d.numero ? meta('Nº', d.numero) : ''}
          ${d.ncf ? meta(t.etiquetaNcf, d.ncf) : ''}
          ${d.ncfTipoLabel ? meta('Tipo', d.ncfTipoLabel) : ''}
          ${meta('Fecha', t.fecha)}
          ${t.vence ? meta(t.etiquetaVence, t.vence) : ''}
          ${meta('Estado', d.estadoLabel)}
        </div>
      </div>
      <div class="tcb-cards">
        <div class="tcb-card">
          <div class="tcb-ctitle">${t.cliente}</div>
          <div class="tcb-cname">${esc(d.cliente.nombre)}</div>
          ${d.cliente.rnc ? linea(`RNC / Cédula: ${esc(d.cliente.rnc)}`) : ''}
          ${d.cliente.tel ? linea(`Tel: ${esc(d.cliente.tel)}`) : ''}
          ${d.cliente.correo ? linea(esc(d.cliente.correo)) : ''}
          ${d.cliente.dir ? linea(esc(d.cliente.dir)) : ''}
        </div>
        <div class="tcb-card">
          <div class="tcb-ctitle">Información del negocio</div>
          ${d.empresa.rnc ? linea(`RNC: ${esc(d.empresa.rnc)}`) : ''}
          ${d.empresa.direccion ? linea(esc(d.empresa.direccion)) : ''}
          ${d.empresa.telefono ? linea(`Tel: ${esc(d.empresa.telefono)}`) : ''}
          ${d.empresa.correo ? linea(esc(d.empresa.correo)) : ''}
        </div>
        ${d.metodoPago ? `<div class="tcb-card">
          <div class="tcb-ctitle">Método de pago</div>
          ${linea(esc(d.metodoPago))}
          ${d.cajero ? linea(`Cajero: ${esc(d.cajero)}`) : ''}
        </div>` : ''}
        <div class="tcb-card">
          <div class="tcb-ctitle">${d.isCot ? 'Condiciones' : 'Condición de venta'}</div>
          ${linea(esc(capital(d.condicionPago)))}
        </div>
      </div>
      <table class="tcb-items">
        <thead><tr>
          <th class="d">Descripción</th><th>Cantidad</th><th>Precio unit.</th><th>ITBIS</th><th>Importe</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="tcb-bottom">
        <div class="tcb-words">
          <div class="tcb-wlabel">Monto en palabras</div>
          <div class="tcb-wtext">${esc(t.letras)}</div>
        </div>
        <div class="tcb-tot">
          ${filasResumen(lineasTotales(d))}
          ${filasResumen([['TOTAL', dinero(d.total), 'grand']])}
          ${filasResumen(lineasPago(d))}
        </div>
      </div>
      ${t.seguridad}
      ${d.mensaje ? `<div class="tcb-note">${esc(d.mensaje)}</div>` : ''}
      ${cierre(d)}
      <div class="tcb-foot"><b>${esc(d.empresa.nombre)}</b> &middot; ${t.pie}</div>`;
  }

  const DIBUJOS = {
    clasica: dibujarClasica,
    ejecutiva: dibujarEjecutiva,
    recuadro: dibujarRecuadro,
    banner: dibujarBanner
  };

  // ── Tamaño de letra ───────────────────────────────────────────────────────
  // Los font-size del CSS de arriba son la escala original (texto normal de
  // 10 px, que impreso se leía muy chico). Aquí se agrandan en un solo lugar:
  // el texto normal queda en 16 px y los títulos (más de 12 px) crecen menos
  // para que el encabezado siga cabiendo. Para ajustar, cambiar ESCALA_LETRA.
  const ESCALA_LETRA = 1.6;
  // Reducción máxima para que quepa en una hoja: 0.62 × 16 px ≈ los 10 px originales.
  const ESCALA_MINIMA = 0.62;
  function tamanoLetra(px) {
    const t = px <= 12 ? px * ESCALA_LETRA : 12 * ESCALA_LETRA + (px - 12) * 0.9;
    return Math.round(t * 10) / 10;
  }
  const cssCache = {};
  function cssDe(plantilla) {
    if (!cssCache[plantilla]) {
      cssCache[plantilla] = (BASE_CSS + CSS[plantilla])
        .replace(/font-size:\s*(\d+(?:\.\d+)?)px/g, (_, n) => `font-size:${tamanoLetra(Number(n))}px`);
    }
    return cssCache[plantilla];
  }

  // Representación Impresa e-CF: conserva los campos fiscales y permite que
  // la RI adopte la plantilla comercial seleccionada para la factura A4.
  function dibujarEcfRi(d, plantilla, color) {
    const tema = resolverColores(plantilla, color);
    const prefijo = String(d.ncf || '').match(/^E(\d{2})/)?.[1] || '';
    const titulos = { '31': 'Factura de Crédito Fiscal Electrónica', '32': 'Factura de Consumo Electrónica',
      '33': 'Nota de Débito Electrónica', '34': 'Nota de Crédito Electrónica',
      '41': 'Compras Electrónico', '43': 'Gastos Menores Electrónico',
      '44': 'Regímenes Especiales Electrónico', '45': 'Gubernamental Electrónico', '46': 'Exportaciones Electrónico', '47': 'Pagos al Exterior Electrónico' };
    const titulo = titulos[prefijo] || 'Comprobante Fiscal Electrónico';
    const cliente = d.cliente || {};
    const consumidor = prefijo === '32' && Number(d.total || 0) < 250000;
    const rows = (d.items || []).map((it) => {
      const qty = Number(it.cantidad || 0);
      const tax = Number(it.itbisMonto || 0);
      const valor = Number(it.total || (Number(it.precio || 0) * qty));
      return `<tr><td class="q">${esc(qty)}</td><td>${esc(it.descripcion || '')}</td><td>${esc(it.unidad || 'Unidad')}</td><td class="n">${dinero(it.precio)}</td><td class="n">${dinero(tax)}</td><td class="n">${dinero(valor)}</td></tr>`;
    }).join('');
    return `<style>${BASE_CSS}${CSS[plantilla]}
.tcfac-ecf-ri{font:${tamanoLetra(10)}px Arial,sans-serif;color:#202b36;background:#fff;--ri-accent:var(--acc);--ri-ink:var(--acc-ink);--ri-tint:var(--acc-tint);--ri-on-accent:var(--on-acc)}
.tcfac-ecf-ri *{box-sizing:border-box}.tcfac-ecf-ri .head{display:flex;justify-content:space-between;gap:12mm;border-bottom:2px solid var(--ri-accent);padding:0 0 5mm;margin-bottom:7mm}
.tcfac-ecf-ri h1{font-size:${tamanoLetra(15)}px;color:var(--ri-ink);margin:0 0 3mm}.tcfac-ecf-ri p{margin:1.5mm 0;line-height:1.35}.tcfac-ecf-ri .ident{text-align:right;min-width:65mm}
.tcfac-ecf-ri .ident strong{font-size:${tamanoLetra(13)}px;color:var(--ri-ink)}.tcfac-ecf-ri .box{border:1px solid var(--ri-accent);border-radius:2mm;padding:3mm;margin-bottom:5mm}
.tcfac-ecf-ri .buyer{display:grid;grid-template-columns:1fr 1fr;gap:2mm 8mm}.tcfac-ecf-ri table{width:100%;border-collapse:collapse;margin-top:4mm;font-size:${tamanoLetra(9)}px}
.tcfac-ecf-ri th{background:var(--ri-tint);color:var(--ri-ink);text-align:left;border-top:1px solid var(--ri-accent);border-bottom:1px solid var(--ri-accent);padding:2.5mm 1.5mm}
.tcfac-ecf-ri td{border-bottom:1px solid #d7e1e7;padding:2.5mm 1.5mm;vertical-align:top}.tcfac-ecf-ri .n{text-align:right;white-space:nowrap}.tcfac-ecf-ri .q{text-align:center}
.tcfac-ecf-ri .bottom{display:flex;justify-content:space-between;align-items:flex-end;gap:8mm;margin-top:8mm}.tcfac-ecf-ri .qr-block{width:72mm;display:flex;flex-direction:column;align-items:flex-start;gap:1.5mm}.tcfac-ecf-ri .qr{width:38mm;height:38mm;object-fit:contain}.tcfac-ecf-ri .totals{width:72mm}.tcfac-ecf-ri .totals div{display:flex;justify-content:space-between;padding:1.5mm 0;border-bottom:1px solid #d7e1e7}.tcfac-ecf-ri .grand{font-weight:bold;font-size:${tamanoLetra(13)}px;color:var(--ri-ink);border-top:2px solid var(--ri-accent)}.tcfac-ecf-ri .security{font-size:${tamanoLetra(8.5)}px;line-height:1.4}.tcfac-ecf-ri .watermark{text-align:center;color:#ad2828;font-weight:bold;margin-top:6mm}
.tcf-tpl-ejecutiva .tcfac-ecf-ri .head{background:var(--ri-tint);border-left:3mm solid var(--ri-accent);padding:5mm}.tcf-tpl-ejecutiva .tcfac-ecf-ri th{background:var(--ri-accent);color:var(--ri-on-accent)}
.tcf-tpl-recuadro .tcfac-ecf-ri .head{border:1px solid var(--ri-accent);border-radius:2mm;padding:5mm}.tcf-tpl-recuadro .tcfac-ecf-ri th{background:#fff;border-bottom:2px solid var(--ri-accent)}
.tcf-tpl-banner .tcfac-ecf-ri .head{background:var(--ri-accent);border:0;padding:6mm;color:var(--ri-on-accent)}.tcf-tpl-banner .tcfac-ecf-ri .head h1,.tcf-tpl-banner .tcfac-ecf-ri .head p,.tcf-tpl-banner .tcfac-ecf-ri .head .ident strong{color:var(--ri-on-accent)}.tcf-tpl-banner .tcfac-ecf-ri th{background:var(--ri-tint)}
@media print{.tcfac-ecf-ri{padding:0;min-height:0}}
</style><div class="tcfac-root tcf-tpl-${plantilla}" style="--acc:${tema.acc};--acc-ink:${tema.ink};--acc-tint:${tema.tint};--on-acc:${tema.onAcc}"><div class="tcf-page"><div class="tcf-content"><div class="tcfac-ecf-ri"><div class="head"><div>${d.empresa.logo ? `<img src="${esc(d.empresa.logo)}" alt="Logo" style="max-width:48mm;max-height:22mm;object-fit:contain;margin-bottom:2mm">` : ''}<h1>${esc(d.empresa.nombre || '')}</h1><p>RNC: ${esc(d.empresa.rnc || '')}</p><p>${esc(d.empresa.direccion || '')}</p><p>${esc(d.empresa.telefono || '')}</p></div><div class="ident"><strong>${esc(titulo)}</strong><p>e-NCF: ${esc(d.ncf || '')}</p><p>Fecha de emisión: ${esc(d.fechaTexto || '')}</p>${d.ncfVencimiento ? `<p>Fecha de vencimiento: ${esc(d.vencimientoTexto || d.ncfVencimiento)}</p>` : ''}</div></div>
${consumidor ? '' : `<div class="box"><b>Datos del cliente</b><div class="buyer"><span>Razón social: ${esc(cliente.nombre || 'Consumidor Final')}</span><span>RNC/Cédula: ${esc(cliente.rnc || '')}</span><span>Dirección: ${esc(cliente.dir || '')}</span><span>Teléfono: ${esc(cliente.tel || '')}</span></div></div>`}
<table><thead><tr><th>Cantidad</th><th>Descripción</th><th>Unidad de Medida</th><th class="n">Precio</th><th class="n">ITBIS</th><th class="n">Valor</th></tr></thead><tbody>${rows}</tbody></table>
<div class="bottom"><div class="qr-block">${d.qrDataUrl ? `<img class="qr" src="${esc(d.qrDataUrl)}" alt="Código QR DGII">` : ''}<div class="security">${d.codigoSeguridad ? `<p><b>Código de seguridad:</b> ${esc(d.codigoSeguridad)}</p>` : ''}${d.fechaFirma ? `<p><b>Fecha de firma digital:</b> ${esc(d.fechaFirma)}</p>` : ''}</div></div><div class="totals"><div><span>Monto gravado</span><b>${dinero(Number(d.subtotal || 0) - Number(d.descuento || 0))}</b></div>${Number(d.descuento) ? `<div><span>Descuento</span><b>${dinero(d.descuento)}</b></div>` : ''}<div><span>ITBIS</span><b>${dinero(d.itbis)}</b></div><div class="grand"><span>Total</span><b>${dinero(d.total)}</b></div></div></div>${d.anulada ? '<div class="watermark">ANULADA</div>' : ''}</div></div></div></div>`;
  }

  // Una sola hoja: si el documento no cabe en una A4, reduce la hoja entera
  // (letra y espacios por igual, con --tcf-zoom) lo justo para que quepa. Si
  // haría falta reducir más de ESCALA_MINIMA (muchas líneas), lo deja en
  // tamaño normal y salen las hojas que hagan falta.
  // offsetTop/offsetHeight vienen sin la reducción (coordenadas de la hoja):
  // el alto impreso es esa medida × zoom.
  // Sin variables de afuera: scriptUnaHoja() la copia tal cual dentro de los
  // documentos que se imprimen o se pasan a PDF.
  function ajustarAUnaHoja(contenedor, minimo) {
    var limite = 295 * 96 / 25.4; // alto A4 con 2 mm de holgura, en px
    var raices = contenedor && contenedor.querySelectorAll ? contenedor.querySelectorAll('.tcfac-root') : [];
    for (var i = 0; i < raices.length; i++) {
      var raiz = raices[i];
      var hoja = raiz.querySelector('.tcf-page');
      var cont = raiz.querySelector('.tcf-content');
      if (!hoja || !cont) continue;
      var vista = raiz.ownerDocument.defaultView;
      var cabe = function (z) {
        raiz.style.setProperty('--tcf-zoom', String(z));
        // offsetTop ya cuenta el margen de arriba de la hoja (y la franja del Banner).
        var alto = cont.offsetTop + cont.offsetHeight + parseFloat(vista.getComputedStyle(hoja).paddingBottom || 0);
        return alto * z <= limite;
      };
      if (cabe(1)) continue;
      var ok = false;
      for (var z = 0.98; z >= minimo - 0.001; z -= 0.02) {
        if (cabe(Math.round(z * 100) / 100)) { ok = true; break; }
      }
      if (!ok) raiz.style.setProperty('--tcf-zoom', '1');
    }
  }

  // <script> para los documentos completos (PDF, impresión, ventana de
  // servicios). Corre al cargar y otra vez con las imágenes (logo) ya cargadas.
  function scriptUnaHoja() {
    return '<script>(function(){var f=' + ajustarAUnaHoja.toString()
      + ';var r=function(){f(document,' + ESCALA_MINIMA + ');};r();window.addEventListener("load",r);})();</' + 'script>';
  }

  /**
   * Factura A4 completa (con su CSS) lista para innerHTML.
   * @param {object} d  datos de ventaToFormalDoc() (js/ventas.js) o documentoDeMuestra()
   * @param {{plantilla?: string, color?: string}} opciones  '' = color de la plantilla
   */
  function render(d, opciones = {}) {
    const plantilla = normalizarPlantilla(opciones.plantilla);
    const c = resolverColores(plantilla, opciones.color);
    const doc = {
      ...d,
      empresa: d.empresa || {},
      cliente: d.cliente || {},
      items: Array.isArray(d.items) ? d.items : []
    };
    if (doc.fiscalMode === 'ecf') return dibujarEcfRi(doc, plantilla, opciones.color);
    const cuerpo = DIBUJOS[plantilla](doc, textosComunes(doc));
    const vars = `--acc:${c.acc};--acc-ink:${c.ink};--acc-tint:${c.tint};--on-acc:${c.onAcc}`;
    return `<div class="tcfac-root tcf-tpl-${plantilla}" style="${vars}">
  <style>${cssDe(plantilla)}</style>
  <div class="tcf-page">
    ${doc.anulada ? `<div class="tcf-wm">${esc(doc.marcaAgua || 'ANULADA')}</div>` : ''}
    <div class="tcf-content">${cuerpo}</div>
  </div>
</div>`;
  }

  // Venta de ejemplo para las miniaturas de Configuración.
  function documentoDeMuestra(empresa = {}) {
    const hoy = new Date();
    const dosDigitos = (n) => String(n).padStart(2, '0');
    return {
      isCot: false,
      anulada: false,
      estadoLabel: 'PAGADA',
      pagado: 657.7,
      balance: 0,
      empresa: {
        nombre: empresa.nombre || 'Mi Negocio',
        rnc: empresa.rnc || '',
        direccion: empresa.direccion || '',
        telefono: empresa.telefono || '',
        logo: empresa.logo || ''
      },
      numero: 'FAC-0001016',
      ncf: 'B0200000123',
      fiscalMode: 'ncf',
      ncfTipoLabel: 'B02 — Consumidor Final',
      fechaTexto: `${dosDigitos(hoy.getDate())}/${dosDigitos(hoy.getMonth() + 1)}/${hoy.getFullYear()}`,
      vencimientoTexto: `31/12/${hoy.getFullYear() + 1}`,
      cajero: 'Cajero',
      metodoPago: 'Efectivo',
      condicionPago: 'contado',
      cliente: { nombre: 'Cliente de muestra', rnc: '001-0000000-1', tel: '809-555-1234', dir: '' },
      items: [
        { descripcion: 'Agua Dasani 500 ml', cantidad: 2, precio: 25, itbisPct: 0, itbisMonto: 0, total: 50 },
        { descripcion: 'Café molido 1 lb', cantidad: 1, precio: 395, itbisPct: 18, itbisMonto: 71.1, total: 395 },
        { descripcion: 'Galletas surtidas', cantidad: 3, precio: 40, itbisPct: 18, itbisMonto: 21.6, total: 120 }
      ],
      subtotal: 565,
      descuento: 0,
      itbis: 92.7,
      redondeo: 0,
      total: 657.7,
      mensaje: empresa.mensaje || '¡Gracias por su compra!',
      qrDataUrl: '',
      codigoSeguridad: '',
      fechaFirma: ''
    };
  }

  // ── Selector en Configuración → Impresora de Recibos ──────────────────────
  // La elección vive en dos campos ocultos (#cfg-invoice-template y
  // #cfg-invoice-color) que getConfigPreviewValues() (app.js) lee al guardar y
  // al abrir la vista previa. syncConfigForm() llama sincronizarSelector(cfg).
  // El bloque solo se ve con el papel "Carta / A4". El portal de contadores
  // usa el mismo selector con los mismos id, sin selector de papel (siempre
  // A4) y con su propia factura de muestra (opciones.muestra).
  const ICONO_CHECK = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  let selectorListo = false;
  let miniaturasPendientes = false;
  let muestraPropia = null;

  function porId(id) {
    return global.document ? global.document.getElementById(id) : null;
  }

  function eleccionActual() {
    return {
      plantilla: normalizarPlantilla(porId('cfg-invoice-template')?.value),
      color: normalizarColor(porId('cfg-invoice-color')?.value)
    };
  }

  function empresaParaMuestra() {
    const cfg = (typeof DB !== 'undefined' && DB?.config) || {};
    return {
      nombre: porId('cfg-nombre')?.value || cfg.nombre,
      rnc: porId('cfg-rnc')?.value || cfg.rnc,
      direccion: porId('cfg-dir')?.value || cfg.direccion,
      telefono: porId('cfg-tel')?.value || cfg.telefono,
      logo: porId('cfg-logo-input')?.dataset.logoData || cfg.logo,
      mensaje: porId('cfg-msg')?.value || cfg.mensaje
    };
  }

  function pintarMiniaturas() {
    const cont = porId('cfg-invoice-templates');
    if (!cont) return;
    const { plantilla, color } = eleccionActual();
    const muestra = muestraPropia ? muestraPropia() : documentoDeMuestra(empresaParaMuestra());
    cont.innerHTML = PLANTILLAS.map((p) => `
      <div class="tc-fp-card" role="radio" tabindex="0" aria-checked="${p.id === plantilla}" data-plantilla="${p.id}">
        <div class="tc-fp-thumb"><div class="tc-fp-thumb-inner">${render(muestra, { plantilla: p.id, color })}</div></div>
        <div class="tc-fp-card__name">${esc(p.nombre)}</div>
        <div class="tc-fp-card__desc">${esc(p.descripcion)}</div>
      </div>`).join('');
  }

  // Al arrastrar el selector de color llegan muchos eventos seguidos: una sola
  // repintada por cuadro.
  function programarMiniaturas() {
    if (miniaturasPendientes) return;
    miniaturasPendientes = true;
    const raf = global.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    raf(() => {
      miniaturasPendientes = false;
      pintarMiniaturas();
    });
  }

  function pintarColores() {
    const cont = porId('cfg-invoice-colors');
    if (!cont) return;
    const { plantilla, color } = eleccionActual();
    const propio = color && !PALETA.some((c) => c.color === color);
    cont.innerHTML = `
      <button type="button" class="tc-fp-auto" role="radio" aria-checked="${!color}" data-color="">
        <span class="tc-fp-auto__dot" style="background:${plantillaPorId(plantilla).color}"></span>
        Color de la plantilla
      </button>
      ${PALETA.map((c) => `
        <button type="button" class="tc-fp-swatch" role="radio" aria-checked="${c.color === color}"
          data-color="${c.color}" title="${esc(c.nombre)}" aria-label="${esc(c.nombre)}"
          style="background:${c.color};color:${resolverColores(plantilla, c.color).onAcc}">${ICONO_CHECK}</button>`).join('')}
      <label class="tc-fp-custom${propio ? ' is-active' : ''}" title="Elegir otro color">
        <input type="color" id="cfg-invoice-color-custom" value="${propio ? color : plantillaPorId(plantilla).color}">
        <span>Otro color</span>
      </label>`;
  }

  // Solo marca la opción elegida, sin volver a crear los botones: si se
  // repinta mientras el selector de color está abierto, Windows lo cierra.
  function marcarColores() {
    const cont = porId('cfg-invoice-colors');
    if (!cont) return;
    const { plantilla, color } = eleccionActual();
    const propio = color && !PALETA.some((c) => c.color === color);
    cont.querySelectorAll('[data-color]').forEach((boton) => {
      boton.setAttribute('aria-checked', String(boton.dataset.color === color));
    });
    cont.querySelector('.tc-fp-custom')?.classList.toggle('is-active', Boolean(propio));
    const punto = cont.querySelector('.tc-fp-auto__dot');
    if (punto) punto.style.background = plantillaPorId(plantilla).color;
  }

  function marcarPlantillas() {
    const { plantilla } = eleccionActual();
    porId('cfg-invoice-templates')?.querySelectorAll('[data-plantilla]').forEach((card) => {
      card.setAttribute('aria-checked', String(card.dataset.plantilla === plantilla));
    });
  }

  function actualizarVisibilidad() {
    const bloque = porId('cfg-invoice-design');
    if (!bloque) return;
    const papel = porId('cfg-paper-size');
    const esA4 = !papel || String(papel.value || '').toLowerCase() === 'a4';
    bloque.style.display = esA4 ? '' : 'none';
    return esA4;
  }

  function elegirPlantilla(id) {
    const campo = porId('cfg-invoice-template');
    if (!campo) return;
    campo.value = normalizarPlantilla(id);
    marcarPlantillas();
    marcarColores();
  }

  function elegirColor(valor) {
    const campo = porId('cfg-invoice-color');
    if (!campo) return;
    campo.value = normalizarColor(valor);
    marcarColores();
    programarMiniaturas();
  }

  function iniciarSelector() {
    if (selectorListo) return;
    const plantillas = porId('cfg-invoice-templates');
    const colores = porId('cfg-invoice-colors');
    if (!plantillas || !colores) return;
    selectorListo = true;

    plantillas.addEventListener('click', (event) => {
      const card = event.target.closest('[data-plantilla]');
      if (card) elegirPlantilla(card.dataset.plantilla);
    });
    plantillas.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('[data-plantilla]');
      if (!card) return;
      event.preventDefault();
      elegirPlantilla(card.dataset.plantilla);
    });
    colores.addEventListener('click', (event) => {
      const boton = event.target.closest('button[data-color]');
      if (boton) elegirColor(boton.dataset.color);
    });
    colores.addEventListener('input', (event) => {
      if (event.target.id === 'cfg-invoice-color-custom') elegirColor(event.target.value);
    });
    porId('cfg-paper-size')?.addEventListener('change', () => {
      if (actualizarVisibilidad()) pintarMiniaturas();
    });
  }

  // opciones.muestra: función que devuelve el documento de las miniaturas
  // (si no viene, la venta de ejemplo con los datos de Configuración).
  function sincronizarSelector(cfg = {}, opciones = {}) {
    const campoPlantilla = porId('cfg-invoice-template');
    const campoColor = porId('cfg-invoice-color');
    if (!campoPlantilla || !campoColor) return;
    if (typeof opciones.muestra === 'function') muestraPropia = opciones.muestra;
    iniciarSelector();
    // Igual que los demás campos de syncConfigForm(): no se pisa lo que el
    // usuario está tocando en este momento.
    const bloque = porId('cfg-invoice-design');
    if (bloque && bloque.contains(global.document.activeElement)) return;
    campoPlantilla.value = normalizarPlantilla(cfg.invoiceTemplate);
    campoColor.value = normalizarColor(cfg.invoiceAccentColor);
    actualizarVisibilidad();
    pintarMiniaturas();
    pintarColores();
  }

  const api = {
    PLANTILLAS,
    PALETA,
    PLANTILLA_POR_DEFECTO,
    render,
    ajustarAUnaHoja,
    scriptUnaHoja,
    ESCALA_MINIMA,
    documentoDeMuestra,
    resolverColores,
    normalizarPlantilla,
    normalizarColor,
    montoEnLetras,
    sincronizarSelector
  };

  global.FacturaPlantillas = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

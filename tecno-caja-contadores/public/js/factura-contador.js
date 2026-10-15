'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Factura y cotización del contador (Facturación y Cotizaciones) →
   plantillas A4 del POS (public/js/factura-plantillas.js, copia de
   js/factura-plantillas.js).

   - La plantilla y el color se eligen en Configuración → Diseño de la factura
     y se guardan en el perfil (factura_plantilla, factura_color).
   - Los datos del emisor salen de la factura (contador_*, guardados al
     emitirla). Las facturas viejas no traen contador_direccion: esa cae a la
     del perfil.
   - El NCF es el número de la factura: d.numero va vacío.
   - Importe = cantidad × precio (la suma da el Subtotal); el descuento de la
     línea va como nota debajo de la descripción, igual que en el modo Empresa
     de Servicios (server/routes/servicios/renderDoc.js).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  function plantillas() {
    if (global.FacturaPlantillas) return global.FacturaPlantillas;
    return typeof require === 'function' ? require('./factura-plantillas.js') : null;
  }

  const ESTADOS = { pendiente: 'PENDIENTE DE PAGO', parcial: 'PAGO PARCIAL', pagada: 'PAGADA', anulada: 'ANULADA' };
  const ESTADOS_COT = { aprobada: 'APROBADA', rechazada: 'RECHAZADA', vencida: 'VENCIDA', convertida: 'CONVERTIDA EN FACTURA' };
  const METODOS = {
    efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta: 'Tarjeta',
    cheque: 'Cheque', deposito: 'Depósito', otro: 'Otro',
  };
  const CONDICIONES = { contado: 'Contado', credito: 'Crédito', adelanto: 'Adelanto' };
  const TITULOS = { B03: 'NOTA DE DÉBITO', B04: 'NOTA DE CRÉDITO' };
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const PIE = 'Factura por servicios profesionales. Documento generado electrónicamente; válido sin firma ni sello. Gracias por su preferencia.';
  const PIE_COT = 'Cotización de servicios profesionales. Documento generado electrónicamente; válido sin firma ni sello. Precios sujetos a cambio después de la fecha de vencimiento.';

  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function dinero(n) {
    return 'RD$ ' + (Number(n) || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // "B0100000123" → "B01-00000123", como en la pantalla de Facturación.
  function ncfTexto(ncf) {
    const s = String(ncf || '');
    return s.length >= 11 ? s.slice(0, 3) + '-' + s.slice(3) : s;
  }

  // "2026-10-14" → "14 de octubre de 2026", sin corrimiento por zona horaria.
  function fechaLarga(v) {
    if (!v) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
    if (m) return `${Number(m[3])} de ${MESES[Number(m[2]) - 1]} de ${m[1]}`;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;
  }

  function fechaIsoLocal(d) {
    const dos = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
  }

  // Valor guardado en la factura; si la factura no lo trae (null/undefined), el del perfil.
  const dato = (deFactura, dePerfil) => String(deFactura ?? dePerfil ?? '');

  // Emisor, cliente, líneas y totales: iguales en la factura y la cotización
  // (las dos se guardan con los mismos campos y computeFacturaItems).
  function partesComunes(f, perfil) {
    const cli = f.cliente || {};
    return {
      empresa: {
        nombre: dato(f.contador_nombre, perfil.nombre_firma),
        rnc: dato(f.contador_rnc, perfil.rnc),
        direccion: dato(f.contador_direccion, perfil.direccion),
        telefono: dato(f.contador_tel, perfil.telefono),
        correo: dato(f.contador_correo, perfil.correo),
        logo: dato(f.contador_logo, perfil.logo_url),
      },
      fiscalMode: 'ncf',
      fechaTexto: fechaLarga(f.fecha),
      cajero: '',
      cliente: {
        nombre: cli.nombre || '—',
        rnc: cli.rnc || '',
        tel: cli.telefono || '',
        dir: cli.direccion || '',
        correo: cli.correo || '',
      },
      items: (f.items || []).map((it) => {
        const cantidad = Number(it.cantidad) || 0;
        const precio = Number(it.precio) || 0;
        const bruto = cantidad * precio;
        const dPct = Number(it.descuento) || 0;
        const desc = bruto * dPct / 100;
        const iPct = Number(it.itbis_rate) || 0;
        return {
          descripcion: it.descripcion || '—',
          cantidad,
          precio,
          itbisPct: iPct,
          itbisMonto: it.itbis != null ? Number(it.itbis) : r2((bruto - desc) * iPct / 100),
          total: r2(bruto),
          nota: dPct ? `Descuento ${r2(dPct)}% (- ${dinero(desc)})` : '',
        };
      }),
      subtotal: Number(f.subtotal || 0),
      descuento: Number(f.descuento_total || 0),
      itbis: Number(f.itbis_total || 0),
      redondeo: 0,
      total: Number(f.total || 0),
      mensaje: '',
      firmas: null,
    };
  }

  /**
   * Factura → datos que espera FacturaPlantillas.render.
   * @param {object} f       factura de GET /api/facturacion/facturas/:id
   * @param {object} perfil  perfil del contador (para lo que la factura no trae)
   */
  function aDocumento(f = {}, perfil = {}) {
    const estado = String(f.estado || 'pendiente').toLowerCase();
    const anulada = estado === 'anulada';
    const total = Number(f.total || 0);
    const pagado = Number(f.monto_pagado || 0);
    const tipo = String(f.tipo_ncf || '').toUpperCase();
    const condicion = CONDICIONES[f.condicion_pago] || String(f.condicion_pago || 'Contado');
    return {
      ...partesComunes(f, perfil),
      titulo: TITULOS[tipo] || '',
      isCot: false,
      anulada,
      selloClase: anulada ? 'bad' : (estado === 'pagada' ? 'ok' : 'warn'),
      estadoLabel: ESTADOS[estado] || estado.toUpperCase(),
      pagado,
      balance: f.balance != null ? Number(f.balance) : Math.max(0, r2(total - pagado)),
      numero: '',
      ncf: ncfTexto(f.ncf),
      ncfTipoLabel: tipo ? `${tipo}${f.tipo_ncf_label ? ' — ' + f.tipo_ncf_label : ''}` : '',
      vencimientoTexto: fechaLarga(f.ncf_vencimiento),
      metodoPago: METODOS[f.metodo_pago] || String(f.metodo_pago || ''),
      condicionPago: condicion + (f.fecha_vencimiento ? ` · vence ${fechaLarga(f.fecha_vencimiento)}` : ''),
      notasTitulo: 'Observación',
      notas: String(f.observacion || '').trim(),
      pie: PIE,
    };
  }

  /**
   * Cotización (módulo Cotizaciones) → datos de FacturaPlantillas.render.
   * Sin NCF: el número es el de la cotización (COT-…). Una rechazada sale con
   * marca de agua, como en el modo Empresa de Servicios.
   */
  function aCotizacion(c = {}, perfil = {}) {
    const estado = String(c.estado || 'aprobada').toLowerCase();
    const dias = Number(c.validez_dias) || 0;
    const condicion = CONDICIONES[c.condicion_pago] || String(c.condicion_pago || 'Contado');
    return {
      ...partesComunes(c, perfil),
      isCot: true,
      anulada: estado === 'rechazada',
      marcaAgua: 'RECHAZADA',
      selloClase: ['rechazada', 'vencida'].includes(estado) ? 'bad' : 'ok',
      estadoLabel: ESTADOS_COT[estado] || estado.toUpperCase(),
      pagado: 0,
      balance: 0,
      numero: String(c.numero || ''),
      ncf: '',
      ncfTipoLabel: '',
      vencimientoTexto: fechaLarga(c.fecha_vencimiento),
      metodoPago: '',
      condicionPago: condicion + (dias ? ` · válida por ${dias} días` : ''),
      notasTitulo: 'Condiciones / Notas',
      notas: [c.notas, c.observacion].map((x) => String(x || '').trim()).filter(Boolean).join('\n\n'),
      pie: PIE_COT,
    };
  }

  function disenoDe(perfil = {}) {
    return { plantilla: perfil.factura_plantilla, color: perfil.factura_color };
  }

  // Documento HTML completo (vista previa, impresión, PDF y adjunto del
  // correo). @page sin márgenes: la hoja de la plantilla ya trae los suyos.
  function hojaCompleta(titulo, datos, perfil) {
    const FP = plantillas();
    const hoja = FP.render(datos, disenoDe(perfil));
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>${esc(titulo)}</title>
<style>@page{size:A4;margin:0}html,body{margin:0;padding:0;background:#eef1f4}@media print{html,body{background:#fff}}</style>
</head><body>${hoja}${FP.scriptUnaHoja()}</body></html>`;
  }

  function documentoHtml(f, perfil = {}) {
    return hojaCompleta(`Factura ${ncfTexto(f.ncf)}`, aDocumento(f, perfil), perfil);
  }

  function cotizacionHtml(c, perfil = {}) {
    return hojaCompleta(`Cotización ${c.numero || ''}`, aCotizacion(c, perfil), perfil);
  }

  // Factura de ejemplo para las miniaturas de Configuración (servicios
  // contables) con los datos de la firma que se están editando.
  function documentoDeMuestra(empresa = {}) {
    const hoy = new Date();
    const items = [
      { descripcion: 'Contabilidad mensual', cantidad: 1, precio: 8000 },
      { descripcion: 'Declaraciones IT-1 e IR-17', cantidad: 1, precio: 2500 },
      { descripcion: 'Formatos 606 y 607', cantidad: 2, precio: 1200 },
    ].map((it) => ({ ...it, descuento: 0, itbis_rate: 18, itbis: r2(it.cantidad * it.precio * 0.18) }));
    const subtotal = items.reduce((a, it) => a + it.cantidad * it.precio, 0);
    const itbis = r2(items.reduce((a, it) => a + it.itbis, 0));
    const total = r2(subtotal + itbis);
    return aDocumento({
      ncf: 'B0100000123', tipo_ncf: 'B01', tipo_ncf_label: 'Crédito Fiscal',
      ncf_vencimiento: `${hoy.getFullYear() + 1}-12-31`,
      fecha: fechaIsoLocal(hoy),
      estado: 'pagada', monto_pagado: total, balance: 0,
      condicion_pago: 'contado', metodo_pago: 'transferencia',
      cliente: { nombre: 'Cliente de muestra, SRL', rnc: '131-00000-1', telefono: '809-555-1234' },
      items, subtotal, descuento_total: 0, itbis_total: itbis, total,
      contador_nombre: empresa.nombre || 'Mi Firma Contable',
      contador_rnc: empresa.rnc || '',
      contador_direccion: empresa.direccion || '',
      contador_tel: empresa.telefono || '',
      contador_correo: empresa.correo || '',
      contador_logo: empresa.logo || '',
    });
  }

  const api = { aDocumento, aCotizacion, documentoHtml, cotizacionHtml, documentoDeMuestra, ncfTexto, fechaLarga };

  global.FacturaContador = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

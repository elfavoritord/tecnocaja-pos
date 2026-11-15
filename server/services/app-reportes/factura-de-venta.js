'use strict';

/**
 * La factura A4 de una venta, para mandarla desde la app de reportes.
 *
 * Es la misma hoja que imprime el POS en «Carta / A4»: los datos salen de
 * /api/sales/:factura/receipt (mapSaleRows + QR y firma del e-CF) y la dibuja
 * js/factura-plantillas.js con la plantilla y el color del negocio
 * (Configuración → Impresora de Recibos). Esto es la copia, para el servidor,
 * de ventaToFormalDoc (js/ventas.js): si se cambia uno, revisar el otro.
 */

const FacturaPlantillas = require('../../../js/factura-plantillas');

const METODOS = {
  efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', mixto: 'Pago mixto',
  credito: 'Crédito', contra_entrega: 'Contra entrega', usd: 'Dólares (USD)',
};
const NCF_TIPOS = {
  B01: 'Crédito Fiscal', B02: 'Consumidor Final', B03: 'Nota de Débito', B04: 'Nota de Crédito',
  B14: 'Régimen Especial', B15: 'Gubernamental',
};

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function textoLimpio(valor) {
  // eslint-disable-next-line no-control-regex
  return String(valor == null ? '' : valor).normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function esElectronica(v) {
  const tipoDoc = String(v?.tipoComprobante || '').trim().toLowerCase();
  const encf = String(v?.encf || v?.ncf || '').trim().toUpperCase();
  const tipoEcf = String(v?.tipoEcf || '').trim().toUpperCase();
  return Boolean(v?.esElectronica || tipoDoc === 'factura-electronica' || tipoEcf.startsWith('E') || /^E\d{2}/.test(encf));
}

// formatReceiptDateForPaper(valor, 'a4'): "dd/mm/aaaa hh:mm" o "dd/mm/aaaa".
// Las fechas del POS son de la hora de RD guardada sin zona («2026-11-10 08:15:00»).
function fechaPapel(valor) {
  if (valor instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(valor.getDate())}/${p(valor.getMonth() + 1)}/${valor.getFullYear()} ${p(valor.getHours())}:${p(valor.getMinutes())}`;
  }
  const t = textoLimpio(valor);
  if (!t) return '';
  // ISO con zona («…T12:15:00.000Z»): como el POS, en la hora de esta PC.
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(t)) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return fechaPapel(d);
  }
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = t.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (m) return m[4] ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}` : `${m[1]}/${m[2]}/${m[3]}`;
  return t;
}

// getReceiptSummaryBreakdown: subtotal, descuento, ITBIS y el redondeo que se
// deriva del total cobrado.
function desglose(v) {
  const subtotal = r2(v.subtotal);
  const descuento = r2(v.descuento);
  const itbis = r2(v.itbis);
  const total = r2(v.total);
  const redondeo = r2(total - (subtotal - descuento + itbis + Number(v.propinaLegal || 0)));
  return { subtotal, descuento, itbis, total, redondeo };
}

function lineasDeCombo(item, cfg) {
  if ((cfg.comboInvoiceDisplay || 'agrupado') !== 'desglosado') return [];
  const comp = item?.combo?.componentes;
  if (!Array.isArray(comp) || !comp.length) return [];
  const veces = Number(item.qty || 1) || 1;
  return comp.map((c) => `${Math.round(Number(c.cantidad || 0) * veces * 1000) / 1000} x ${textoLimpio(c.nombre)}`);
}

// Combo personalizado: sus líneas salen juntas en una sola fila, a su precio
// final con el ITBIS incluido (groupCustomComboReceiptItems de js/ventas.js).
function agruparCombosPersonalizados(items) {
  if (!items.some((it) => it.comboPersonalizado?.clave)) return items;
  const salida = [];
  const grupos = new Map();
  for (const it of items) {
    const clave = it.comboPersonalizado?.clave;
    if (!clave) { salida.push(it); continue; }
    if (!grupos.has(clave)) {
      const g = { combo: it.comboPersonalizado, lineas: [] };
      grupos.set(clave, g);
      salida.push(g);
    }
    grupos.get(clave).lineas.push(it);
  }
  return salida.map((e) => {
    if (!e.lineas) return e;
    const c = (n) => Math.round(Number(n || 0) * 100);
    const sub = e.lineas.reduce((a, it) => a + c(it.subtotal), 0);
    const itbis = e.lineas.reduce((a, it) => a + c(it.lineTax), 0);
    const cantidades = new Map();
    for (const it of e.lineas) cantidades.set(textoLimpio(it.nombre), (cantidades.get(textoLimpio(it.nombre)) || 0) + Number(it.qty || 0));
    return {
      nombre: textoLimpio(e.combo.nombre || 'Combo personalizado'), qty: 1, precio: (sub + itbis) / 100,
      subtotal: (sub + itbis) / 100, total: (sub + itbis) / 100, itbisRate: 0, lineTax: itbis / 100,
      impuestoIncluido: itbis / 100, comboContenido: [...cantidades.entries()].map(([n, q]) => `${q} x ${n}`),
    };
  });
}

// Código de seguridad y fecha de firma del e-CF (getReceiptEcfSecurityData).
function seguridadEcf(v) {
  try {
    const url = new URL(String(v?.qrUrl || ''));
    return {
      codigoSeguridad: url.searchParams.get('CodigoSeguridad') || '',
      fechaFirma: fechaPapel(url.searchParams.get('FechaFirma') || v?.fechaFirmaFiscal || v?.fiscalFechaIso || ''),
    };
  } catch (_) {
    return { codigoSeguridad: '', fechaFirma: fechaPapel(v?.fechaFirmaFiscal || v?.fiscalFechaIso || '') };
  }
}

/** Venta de /api/sales/:factura/receipt → documento de js/factura-plantillas.js. */
function ventaAFactura(venta, cfg = {}, { qrDataUrl = '' } = {}) {
  const v = venta || {};
  const elec = esElectronica(v);
  const ncf = elec ? String(v.encf || v.ncf || v.id || '').trim() : (v.ncf || '');
  const bd = desglose(v);
  const total = Number(bd.total || v.total || 0);
  const recibido = Number(v.recibido || 0);
  const esCredito = v.metodo === 'credito' || Number(v.montoCredito || 0) > 0;
  const pagado = esCredito ? recibido : (recibido > 0 ? Math.min(recibido, total) : total);
  const balance = Math.max(0, Number((total - pagado).toFixed(2)));
  const anulada = v.anulada === true || v.cancelada === true || /anul|cancel/i.test(String(v.estadoDgii || v.estadoFiscal || ''));
  let estadoLabel;
  if (anulada) estadoLabel = 'ANULADA';
  else if (balance <= 0.01) estadoLabel = 'PAGADA';
  else if (pagado > 0.01) estadoLabel = 'PAGO PARCIAL';
  else estadoLabel = 'PENDIENTE DE PAGO';

  const normales = (Array.isArray(v.items) ? v.items : []).map((it) => {
    const qty = Number(it.qty || 0);
    const precio = Number(it.precio || 0);
    const rate = Number(it.itbis || 0);
    const sub = r2(it.subtotal ?? it.total ?? qty * precio);
    return { ...it, nombre: textoLimpio(it.nombre), qty, precio, subtotal: sub, total: sub, itbisRate: rate, lineTax: r2(it.impuestoMonto ?? sub * (rate / 100)) };
  });
  const lineas = agruparCombosPersonalizados(normales);

  // Muchas ventas guardan la tasa por línea en 0 y solo el ITBIS de la venta:
  // se reparte proporcional para que la columna no quede vacía.
  const sumaSub = lineas.reduce((a, it) => a + Number(it.subtotal || it.total || 0), 0);
  const itbisVenta = Number(bd.itbis || 0);
  const repartir = itbisVenta > 0.01 && lineas.every((it) => !(Number(it.itbisRate || 0) > 0) && !(Number(it.lineTax || 0) > 0));
  let acumulado = 0;
  const items = lineas.map((it, idx) => {
    const sub = Number(it.subtotal || it.total || 0);
    let rate = Number(it.itbisRate || 0);
    let monto = Number(it.lineTax || 0);
    if (repartir && sumaSub > 0) {
      monto = idx === lineas.length - 1 ? r2(itbisVenta - acumulado) : r2(itbisVenta * (sub / sumaSub));
      acumulado = r2(acumulado + monto);
      if (rate <= 0 && sub > 0) rate = Math.round((monto / sub) * 100);
    } else if (rate > 0 && monto <= 0 && sub > 0) {
      monto = r2(sub * (rate / 100));
    }
    if (it.comboContenido) {
      return {
        descripcion: `${it.nombre} · Impuesto incluido`,
        nota: `ITBIS incluido: RD$ ${r2(it.impuestoIncluido).toFixed(2)}${it.comboContenido.length ? ` · Incluye: ${it.comboContenido.join(', ')}` : ''}`,
        cantidad: 1, unidad: 'Combo', precio: it.precio, itbisPct: 0, itbisMonto: monto, total: Number(it.total || 0),
      };
    }
    const combo = lineasDeCombo(it, cfg);
    return {
      descripcion: it.nombre,
      ...(combo.length ? { nota: `Incluye: ${combo.join(', ')}` } : {}),
      cantidad: it.qty, unidad: it.unitLabel || 'Unidad', precio: it.precio, itbisPct: rate, itbisMonto: monto, total: Number(it.total || 0),
    };
  });

  const ncfTipoLabel = v.ncfType
    ? `${v.ncfType} — ${v.ncfLabel || NCF_TIPOS[v.ncfType] || ''}`.replace(/ — $/, '')
    : (v.tipoEcf ? `e-CF ${v.tipoEcf}` : '');

  return {
    isCot: false, anulada, estadoLabel, pagado, balance,
    empresa: {
      nombre: cfg.nombre || 'Tecno Caja', rnc: cfg.rnc || '', direccion: cfg.direccion || '',
      telefono: cfg.telefono || '', logo: cfg.logo || '',
    },
    numero: v.id || 'Sin número',
    ncf,
    fiscalMode: elec ? 'ecf' : 'ncf',
    ncfTipoLabel,
    ncfVencimiento: (v.ncf || v.encf) ? (v.ncfVencimiento || '') : '',
    fecha: v.fecha,
    fechaEmision: v.fechaEmisionFiscal || v.fiscalFechaIso || '',
    cajero: v.cajero || '',
    metodoPago: METODOS[v.metodo] || v.metodo || 'Efectivo',
    condicionPago: esCredito ? 'crédito' : 'contado',
    cliente: {
      nombre: v.razonSocialCliente || v.cliente || 'Consumidor Final',
      rnc: v.clienteRncCedula || '',
      tel: v.clienteTelefono || v.telefonoDelivery || '',
      dir: v.direccionDelivery || '',
    },
    items,
    subtotal: bd.subtotal,
    descuento: bd.descuento,
    itbis: bd.itbis,
    propinaLegal: Number(v.propinaLegal || 0),
    redondeo: bd.redondeo,
    total,
    mensaje: cfg.mensaje || '',
    qrDataUrl: elec && qrDataUrl ? qrDataUrl : '',
    ...(elec ? seguridadEcf(v) : { codigoSeguridad: '', fechaFirma: '' }),
    fechaTexto: fechaPapel(v.fecha),
    vencimientoTexto: (v.ncf || v.encf) && v.ncfVencimiento ? fechaPapel(v.ncfVencimiento) : '',
  };
}

/** HTML completo de la hoja A4 (igual que buildFormalInvoiceDocumentHtml). */
function htmlFactura(venta, cfg = {}, opciones = {}) {
  const doc = ventaAFactura(venta, cfg, opciones);
  const titulo = textoLimpio(doc.numero).replace(/[<>&"]/g, '');
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${titulo}</title>`
    + '<style>@page{size:A4;margin:0}html,body{margin:0;padding:0;background:#fff}</style></head>'
    + `<body style="margin:0">${FacturaPlantillas.render(doc, { plantilla: cfg.invoiceTemplate, color: cfg.invoiceAccentColor })}`
    + `${FacturaPlantillas.scriptUnaHoja()}</body></html>`;
}

module.exports = { ventaAFactura, htmlFactura, esElectronica, fechaPapel };

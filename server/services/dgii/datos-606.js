'use strict';

// Datos del Formato 606 de un mes, leídos de Compras y Gastos. Una sola fuente
// para el TXT del POS (server/routes/formatos-dgii.routes.js) y para el archivo
// que el negocio exporta al Portal de Contadores (exportar-contador en server.js).
//
// Reglas (instructivo 606 de la DGII, feb. 2026):
// - Monto en servicios / en bienes sin impuestos, por línea de la compra.
// - Fecha de pago = el día en que de verdad quedó pagada (pagos al suplidor), no
//   el vencimiento. Sin pagar → vacía y forma de pago «compra a crédito».
// - Los e-CF que emite el propio negocio (E41, E43, E47) solo van si la DGII los
//   aceptó; los demás quedan en «excluidos» con su motivo.
// - Compras y gastos anulados no van.

const { EXPENSE_CATEGORY_TO_DGII_CODE } = require('../../routes/gastos.routes');

const AUTOEMITIDOS = new Set(['E41', 'E43', 'E47']);
const ACEPTADOS = new Set(['aceptado', 'aceptado_condicional']);

const digitos = (v) => String(v ?? '').replace(/\D/g, '');
const dia = (v) => {
  if (!v) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const cent = (v) => Math.round(Number(v || 0) * 100);

// Método de pago escrito (pagos al suplidor) → código de la DGII.
function formaDeMetodo(metodo) {
  const m = String(metodo || '').toLowerCase();
  if (!m) return null;
  if (m.includes('efectivo')) return 1;
  if (m.includes('cheque') || m.includes('transfer') || m.includes('dep')) return 2;
  if (m.includes('tarjeta')) return 3;
  if (m.includes('permuta')) return 5;
  if (m.includes('nota')) return 6;
  if (m.includes('mixto')) return 7;
  return null;
}

function rangoDelMes(periodo) {
  const a = Number(String(periodo).slice(0, 4));
  const m = Number(String(periodo).slice(4, 6));
  const p = (n) => String(n).padStart(2, '0');
  const ultimo = new Date(a, m, 0).getDate();
  return { desde: `${a}-${p(m)}-01`, hasta: `${a}-${p(m)}-${p(ultimo)}` };
}

function crearDatos606({ query }) {
  async function estadosEcf(encfs) {
    const lista = [...new Set(encfs.filter(Boolean))];
    if (!lista.length) return new Map();
    try {
      const filas = await query(
        `SELECT encf, estado_dgii FROM ecf_documents WHERE encf IN (${lista.map(() => '?').join(', ')}) ORDER BY id`,
        lista
      );
      // El último documento con ese número manda (un reenvío reemplaza al anterior).
      return new Map(filas.map((f) => [String(f.encf), String(f.estado_dgii || '').toLowerCase()]));
    } catch (_) {
      return new Map();
    }
  }

  async function compras(desde, hasta) {
    const filas = await query(
      `SELECT p.*, s.rnc AS supplier_rnc, s.nombre AS supplier_name,
              si.pending_amount AS factura_pendiente, si.status AS factura_estado
       FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN supplier_invoices si ON si.id = p.supplier_invoice_id
       WHERE p.estado = 'activa' AND p.ncf IS NOT NULL AND p.ncf <> ''
         AND (p.fecha_comprobante BETWEEN ? AND ?
              OR p.id IN (SELECT sp.purchase_id FROM supplier_payments sp WHERE sp.purchase_id IS NOT NULL AND sp.fecha_pago BETWEEN ? AND ?))
       ORDER BY p.fecha_comprobante, p.id`,
      [desde, hasta, desde, hasta]
    ).catch(() => []);
    if (!filas.length) return [];
    const ids = filas.map((f) => f.id);
    const marcas = ids.map(() => '?').join(', ');
    const items = await query(
      `SELECT purchase_id, tipo_linea, subtotal FROM purchase_items WHERE purchase_id IN (${marcas})`, ids
    ).catch(() => []);
    const pagos = await query(
      `SELECT invoice_id, purchase_id, fecha_pago, metodo_pago FROM supplier_payments
       WHERE purchase_id IN (${marcas}) OR invoice_id IN (${filas.map(() => '?').join(', ')})`,
      [...ids, ...filas.map((f) => f.supplier_invoice_id || 0)]
    ).catch(() => []);
    return filas.map((p) => ({
      p,
      items: items.filter((i) => Number(i.purchase_id) === Number(p.id)),
      pagos: pagos.filter((x) => Number(x.purchase_id) === Number(p.id) || (p.supplier_invoice_id && Number(x.invoice_id) === Number(p.supplier_invoice_id))),
    }));
  }

  async function gastos(desde, hasta) {
    return query(
      `SELECT e.*, s.rnc AS supplier_rnc, s.nombre AS supplier_name
       FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id
       WHERE e.estado <> 'anulado' AND e.ncf IS NOT NULL AND e.ncf <> ''
         AND (e.fecha BETWEEN ? AND ? OR e.fecha_pago BETWEEN ? AND ?)
       ORDER BY e.fecha, e.id`,
      [desde, hasta, desde, hasta]
    ).catch(() => []);
  }

  /**
   * @param {string} periodo AAAAMM
   * @returns {Promise<{ registros: object[], excluidos: object[], avisos: object[] }>}
   */
  async function leer(periodo) {
    const { desde, hasta } = rangoDelMes(periodo);
    const registros = [];
    const excluidos = [];
    const avisos = [];
    const listaCompras = await compras(desde, hasta);
    const listaGastos = await gastos(desde, hasta);
    const estados = await estadosEcf([
      ...listaCompras.map(({ p }) => p.ncf), ...listaGastos.map((e) => e.ncf),
    ].filter((n) => AUTOEMITIDOS.has(String(n).slice(0, 3).toUpperCase())));

    const autoemitidoAceptado = (ncf, origen) => {
      const tipo = String(ncf).slice(0, 3).toUpperCase();
      if (!AUTOEMITIDOS.has(tipo)) return true;
      const estado = estados.get(String(ncf));
      if (ACEPTADOS.has(estado)) return true;
      excluidos.push({ origen, ncf, motivo: estado ? `${tipo} ${estado.replace(/_/g, ' ')} en la DGII: solo van los aceptados.` : `${tipo} sin respuesta de la DGII: solo van los aceptados.` });
      return false;
    };

    for (const { p, items, pagos } of listaCompras) {
      const origen = `Compra #${p.id}${p.supplier_name ? ` · ${p.supplier_name}` : ''}`;
      if (!autoemitidoAceptado(p.ncf, origen)) continue;
      const fechaComp = dia(p.fecha_comprobante);
      // Bienes / servicios por línea; el descuento general se reparte en proporción.
      const base = cent(p.subtotal) - cent(p.descuento);
      const serv = items.filter((i) => i.tipo_linea === 'servicio_gasto').reduce((t, i) => t + cent(i.subtotal), 0);
      const todo = items.reduce((t, i) => t + cent(i.subtotal), 0);
      const montoServicios = todo > 0 ? Math.round(base * (serv / todo)) : 0;
      const montoBienes = base - montoServicios;

      const pagada = p.supplier_invoice_id
        ? Number(p.factura_pendiente || 0) <= 0 && String(p.factura_estado || '').toLowerCase() !== 'anulada'
        : String(p.condicion_pago || 'contado') === 'contado';
      const fechasPago = pagos.map((x) => dia(x.fecha_pago)).filter(Boolean).sort();
      const fechaPago = pagada ? (fechasPago[fechasPago.length - 1] || fechaComp) : null;
      // Reportada otra vez solo por la retención pagada este mes (instructivo: misma fecha original).
      if (fechaComp < desde && !(fechaPago && fechaPago >= desde && (Number(p.itbis_retenido) > 0 || Number(p.isr_monto_retencion) > 0))) continue;

      const metodos = [...new Set(pagos.map((x) => formaDeMetodo(x.metodo_pago)).filter(Boolean))];
      let formaPago = Number(p.forma_pago) || null;
      if (!formaPago) {
        formaPago = !pagada ? 4 : metodos.length > 1 ? 7 : (metodos[0] || null);
        if (!formaPago) {
          formaPago = 1;
          avisos.push({ origen, ncf: p.ncf, mensaje: 'Sin forma de pago registrada: se puso «Efectivo». Corrígela en la compra si no fue así.' });
        }
      }
      registros.push({
        origen, referencia: { tipo: 'compra', id: Number(p.id) },
        rncCedula: digitos(p.supplier_rnc), tipoBienesServicios: Number(p.tipo_bienes_servicios) || 9,
        ncf: p.ncf, ncfModificado: p.ncf_modificado || '', fechaComprobante: fechaComp, fechaPago,
        montoServicios: (montoServicios / 100).toFixed(2), montoBienes: (montoBienes / 100).toFixed(2),
        itbisFacturado: Number(p.itbis || 0), itbisRetenido: Number(p.itbis_retenido || 0),
        tipoRetencionIsr: p.isr_tipo_retencion || null, montoRetencionRenta: Number(p.isr_monto_retencion || 0),
        formaPago,
      });
    }

    for (const e of listaGastos) {
      const origen = `Gasto #${e.id} · ${e.categoria || ''}${e.descripcion ? ` · ${String(e.descripcion).slice(0, 40)}` : ''}`;
      if (!autoemitidoAceptado(e.ncf, origen)) continue;
      const fechaComp = dia(e.fecha);
      const fechaPago = String(e.estado) === 'pagado' ? (dia(e.fecha_pago) || fechaComp) : null;
      if (fechaComp < desde && !(fechaPago && fechaPago >= desde && (Number(e.retencion_itbis) > 0 || Number(e.retencion_isr) > 0))) continue;
      let formaPago = Number(e.forma_pago) || null;
      if (!formaPago) {
        formaPago = String(e.estado) === 'pagado' ? 1 : 4;
        if (formaPago === 1) avisos.push({ origen, ncf: e.ncf, mensaje: 'Sin forma de pago registrada: se puso «Efectivo». Corrígela en el gasto si no fue así.' });
      }
      registros.push({
        origen, referencia: { tipo: 'gasto', id: Number(e.id) },
        rncCedula: digitos(e.supplier_rnc), tipoBienesServicios: EXPENSE_CATEGORY_TO_DGII_CODE[e.categoria] || 6,
        ncf: e.ncf, ncfModificado: e.ncf_modificado || '', fechaComprobante: fechaComp, fechaPago,
        // Un gasto se informa como servicio (si es mercancía, va como compra).
        montoServicios: Number(e.subtotal || 0), montoBienes: 0,
        itbisFacturado: Number(e.itbis || 0), itbisRetenido: Number(e.retencion_itbis || 0),
        tipoRetencionIsr: e.isr_tipo_retencion || null, montoRetencionRenta: Number(e.retencion_isr || 0),
        formaPago,
      });
    }
    registros.sort((a, b) => String(a.fechaComprobante).localeCompare(String(b.fechaComprobante)));
    return { registros, excluidos, avisos, desde, hasta };
  }

  return { leer, rangoDelMes };
}

module.exports = { crearDatos606, rangoDelMes, formaDeMetodo };

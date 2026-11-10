'use strict';

// Datos del e-CF (comprador, líneas, totales y retenciones) leídos de una compra o
// un gasto ya guardados. Un solo lugar para armarlos: al registrar, al volver a
// pedir el comprobante y en las pruebas.
//
// - E41 (compras): el «comprador» del XML es el vendedor (RNC o cédula
//   obligatorio); cada línea lleva su retención (ITBIS e ISR repartidos).
// - E43 / E47: van exentos en el XML (su XSD), así que la línea lleva su total
//   con ITBIS; el E47 lleva la retención ISR y el identificador del extranjero.

const { repartir } = require('./comprobantes-compra.service');

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const digitos = (v) => String(v ?? '').replace(/\D/g, '');
const n = (v) => Number(v || 0);

function crearConstructoresComprobante({ query }) {
  async function deCompra(purchaseId, tipoEcf = 'E41') {
    if (tipoEcf !== 'E41') throw fail('Una compra solo lleva comprobante de compras (E41).');
    const [p] = await query(
      `SELECT p.*, s.nombre AS supplier_name, s.rnc AS supplier_rnc FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ? LIMIT 1`,
      [Number(purchaseId)]
    );
    if (!p) throw fail('Compra no encontrada.', 404);
    if (String(p.estado) !== 'activa') throw fail('La compra está anulada.', 409);
    if (p.ncf && !/^E41/.test(String(p.ncf))) throw fail(`La compra ya tiene comprobante (${p.ncf}).`, 409);
    const rnc = digitos(p.supplier_rnc);
    if (![9, 11].includes(rnc.length)) throw fail('Para el E41 el proveedor debe tener RNC o cédula (9 u 11 dígitos).');
    const items = await query('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id', [p.id]);
    if (!items.length) throw fail('La compra no tiene líneas.');
    const bases = items.map((i) => Math.max(0, n(i.cantidad) * n(i.costo_unitario) - n(i.descuento)));
    const itbisLineas = items.map((i, k) => bases[k] * (n(i.itbis_pct) / 100));
    const isr = repartir(p.isr_monto_retencion, bases);
    const itbisRet = repartir(p.itbis_retenido, itbisLineas.some((x) => x > 0) ? itbisLineas : bases);
    return {
      tipoEcf, branchId: p.branch_id,
      datos: {
        customer: { rnc, nombre: p.supplier_name || '' },
        items: items.map((i, k) => ({
          name: i.nombre || i.descripcion || i.codigo || 'Producto',
          quantity: n(i.cantidad), unitPrice: n(i.costo_unitario),
          discount: n(i.descuento) + (k === 0 ? n(p.descuento) : 0),
          taxRate: n(i.itbis_pct), isService: i.tipo_linea === 'servicio_gasto',
          withholdingAmount: isr[k], itbisRetenido: itbisRet[k],
        })),
        document: { totalItbisRetenido: n(p.itbis_retenido) },
      },
      resumen: { beneficiario: p.supplier_name || '', rnc, total: n(p.total) },
    };
  }

  async function deGasto(expenseId, tipoEcf, { identificadorExtranjero = '' } = {}) {
    if (!['E41', 'E43', 'E47'].includes(tipoEcf)) throw fail('Un gasto lleva E41, E43 o E47.');
    const [g] = await query(
      `SELECT e.*, s.nombre AS supplier_name, s.rnc AS supplier_rnc FROM expenses e
       LEFT JOIN suppliers s ON s.id = e.supplier_id WHERE e.id = ? LIMIT 1`,
      [Number(expenseId)]
    );
    if (!g) throw fail('Gasto no encontrado.', 404);
    if (String(g.estado) === 'anulado') throw fail('El gasto está anulado.', 409);
    if (g.ncf && !/^E4[137]/.test(String(g.ncf))) throw fail(`El gasto ya tiene comprobante (${g.ncf}).`, 409);
    const lineas = await query('SELECT * FROM expense_items WHERE expense_id = ? ORDER BY orden, id', [g.id]).catch(() => []);

    if (tipoEcf === 'E41') {
      const rnc = digitos(g.supplier_rnc);
      if (![9, 11].includes(rnc.length)) throw fail('Para el E41 elige un proveedor que tenga RNC o cédula.');
      // Sin líneas: un solo concepto; la tasa se deduce del ITBIS (18 %, 16 % o sin ITBIS).
      const tasaUnica = n(g.subtotal) > 0 ? n(g.itbis) / n(g.subtotal) : 0;
      const filas = lineas.length ? lineas.map((l) => ({ descripcion: l.descripcion, cantidad: n(l.cantidad), precio: n(l.precio), pct: n(l.itbis_pct) }))
        : [{ descripcion: g.descripcion, cantidad: 1, precio: n(g.subtotal), pct: Math.abs(tasaUnica - 0.18) < 0.005 ? 18 : Math.abs(tasaUnica - 0.16) < 0.005 ? 16 : 0 }];
      const bases = filas.map((l) => l.cantidad * l.precio);
      const isr = repartir(g.retencion_isr, bases);
      const itbisLineas = filas.map((l, k) => bases[k] * (l.pct / 100));
      const itbisRet = repartir(g.retencion_itbis, itbisLineas.some((x) => x > 0) ? itbisLineas : bases);
      return {
        tipoEcf, branchId: g.branch_id,
        datos: {
          customer: { rnc, nombre: g.supplier_name || '' },
          items: filas.map((l, k) => ({
            name: l.descripcion || g.descripcion, quantity: l.cantidad || 1, unitPrice: l.precio, discount: 0, taxRate: l.pct,
            withholdingAmount: isr[k], itbisRetenido: itbisRet[k],
          })),
          document: { totalItbisRetenido: n(g.retencion_itbis) },
        },
        resumen: { beneficiario: g.supplier_name || '', rnc, total: n(g.total) },
      };
    }

    const filas = lineas.length ? lineas.map((l) => ({ descripcion: l.descripcion, total: n(l.total) })) : [{ descripcion: g.descripcion, total: n(g.total) }];
    const isr = tipoEcf === 'E47' ? repartir(g.retencion_isr, filas.map((l) => l.total)) : filas.map(() => 0);
    const beneficiario = g.beneficiario || g.supplier_name || g.descripcion;
    return {
      tipoEcf, branchId: g.branch_id,
      datos: {
        customer: { nombre: beneficiario, identificadorExtranjero: String(identificadorExtranjero || '').trim() },
        items: filas.map((l, k) => ({
          name: l.descripcion || g.descripcion, quantity: 1, unitPrice: l.total, discount: 0, taxRate: 0,
          isService: tipoEcf === 'E47', withholdingAmount: isr[k],
        })),
        document: tipoEcf === 'E47' ? { totalIsrRetencion: n(g.retencion_isr) } : {},
      },
      resumen: { beneficiario, rnc: '', total: n(g.total) },
    };
  }

  return { deCompra, deGasto };
}

module.exports = { crearConstructoresComprobante };

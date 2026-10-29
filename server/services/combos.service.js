'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  combos.service.js — Tecno Caja
//  Combos promocionales: un combo es una fila de `products` (product_type
//  'combo', tracks_stock 0) más su composición en `product_combo_items`. Así
//  aparece solo en el catálogo, la búsqueda, el carrito, la factura y el e-CF.
//  Al venderse NUNCA descuenta su propia fila: descuenta sus componentes reales,
//  según la foto (combo_snapshot) que se guarda en la línea de la venta. Las
//  cancelaciones y devoluciones leen esa foto, no la composición actual, para
//  que editar un combo no cambie ventas pasadas.
// ══════════════════════════════════════════════════════════════════════════════

const COMBO_PRODUCT_TYPE = 'combo';
const COMBO_INVOICE_DISPLAY_MODES = ['agrupado', 'desglosado'];

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundQty(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function normalizeComboInvoiceDisplay(value) {
  return COMBO_INVOICE_DISPLAY_MODES.includes(value) ? value : 'agrupado';
}

async function ensureCombosSchema({ query, addColumnIfMissing }) {
  await query(`
    CREATE TABLE IF NOT EXISTS product_combo_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      combo_product_id INT NOT NULL,
      component_product_id INT NOT NULL,
      quantity DECIMAL(12,3) NOT NULL DEFAULT 1.000,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query('CREATE INDEX idx_combo_items_combo ON product_combo_items (combo_product_id)').catch(() => {});
  await query('CREATE INDEX idx_combo_items_component ON product_combo_items (component_product_id)').catch(() => {});
  // Foto del combo al momento de venderlo (nombre, precio, componentes, costos).
  await addColumnIfMissing('sale_items', 'combo_snapshot', 'LONGTEXT DEFAULT NULL');
  // Presentación de combos en las facturas: 'agrupado' o 'desglosado'.
  await addColumnIfMissing('config', 'combo_invoice_display', `VARCHAR(20) NOT NULL DEFAULT 'agrupado'`);
}

// Componentes de varios combos a la vez, con los datos actuales de cada producto.
async function loadComponentsByCombo(runQuery, comboIds = []) {
  const ids = [...new Set(comboIds.map((id) => Number(id)).filter((id) => id > 0))];
  const byCombo = new Map();
  if (!ids.length) return byCombo;
  const rows = await runQuery(
    `SELECT ci.combo_product_id, ci.component_product_id, ci.quantity, ci.sort_order,
            p.codigo, p.nombre, p.precio_venta, p.precio_compra, p.tracks_stock, p.estado,
            p.aplica_itbis, p.image_local, p.image_url, p.barcode
       FROM product_combo_items ci
       JOIN products p ON p.id = ci.component_product_id
      WHERE ci.combo_product_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY ci.combo_product_id, ci.sort_order, ci.id`,
    ids
  );
  for (const row of rows) {
    const comboId = Number(row.combo_product_id);
    if (!byCombo.has(comboId)) byCombo.set(comboId, []);
    byCombo.get(comboId).push({
      id: Number(row.component_product_id),
      codigo: String(row.codigo || ''),
      barcode: String(row.barcode || row.codigo || ''),
      nombre: String(row.nombre || ''),
      cantidad: roundQty(row.quantity),
      precioVenta: roundMoney(row.precio_venta),
      precioCompra: roundMoney(row.precio_compra),
      controlaStock: Number(row.tracks_stock ?? 1) !== 0,
      aplicaItbis: Boolean(Number(row.aplica_itbis || 0)),
      estado: String(row.estado || 'Activo'),
      imagen: row.image_local || row.image_url || '',
    });
  }
  return byCombo;
}

// Precio normal (suma de componentes), costo estimado, ahorro y margen.
function computeComboTotals(componentes = [], precioCombo = 0) {
  const precioNormal = roundMoney(componentes.reduce((sum, c) => sum + Number(c.precioVenta || 0) * Number(c.cantidad || 0), 0));
  const costo = roundMoney(componentes.reduce((sum, c) => sum + Number(c.precioCompra || 0) * Number(c.cantidad || 0), 0));
  const precio = roundMoney(precioCombo);
  const ahorro = roundMoney(Math.max(0, precioNormal - precio));
  const ganancia = roundMoney(precio - costo);
  const margenPct = precio > 0 ? Math.round((ganancia / precio) * 10000) / 100 : 0;
  // ITBIS de los componentes: si mezclan gravados y exentos, una sola línea
  // fiscal (la del combo) no puede representar los dos tratamientos.
  const gravados = componentes.filter((c) => c.aplicaItbis).length;
  const itbisMixto = gravados > 0 && gravados < componentes.length;
  return { precioNormal, costo, precio, ahorro, ganancia, margenPct, itbisMixto, todosGravados: componentes.length > 0 && gravados === componentes.length };
}

// Cuántos combos se pueden armar con la existencia de sus componentes.
// stockById: Map id → existencia; cartNeeds (opcional): Map id → lo ya apartado.
function computeComboAvailability(componentes = [], stockById = new Map(), cartNeeds = new Map()) {
  let disponible = Infinity;
  for (const c of componentes) {
    if (!c.controlaStock) continue;
    const qty = Number(c.cantidad || 0);
    if (!(qty > 0)) continue;
    const stock = Number(stockById.get(Number(c.id)) || 0) - Number(cartNeeds.get(Number(c.id)) || 0);
    disponible = Math.min(disponible, Math.floor(roundQty(stock / qty) + 1e-9));
  }
  return disponible === Infinity ? null : Math.max(0, disponible);
}

// Foto que se guarda en sale_items.combo_snapshot.
function buildSaleSnapshot(comboRow, componentes = []) {
  return {
    comboId: Number(comboRow.id),
    codigo: String(comboRow.codigo || ''),
    nombre: String(comboRow.nombre || ''),
    precio: roundMoney(comboRow.precio_venta ?? comboRow.precioVenta),
    componentes: componentes.map((c) => ({
      id: Number(c.id),
      codigo: String(c.codigo || ''),
      nombre: String(c.nombre || ''),
      cantidad: roundQty(c.cantidad),
      costoUnitario: roundMoney(c.precioCompra),
      precioUnitario: roundMoney(c.precioVenta),
      controlaStock: Boolean(c.controlaStock),
    })),
  };
}

function parseComboSnapshot(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && Array.isArray(parsed.componentes) ? parsed : null;
  } catch (_) {
    return null;
  }
}

// Qué mover en inventario por `qty` unidades de una línea guardada en sale_items.
// Línea normal: el propio producto. Línea de combo: cada componente × qty, con su
// costo y su "controla stock" de cuando se vendió.
function inventoryLinesForSaleItem(item, qty = item?.qty) {
  const units = Number(qty || 0);
  const snapshot = parseComboSnapshot(item?.combo_snapshot ?? item?.comboSnapshot);
  if (snapshot) {
    return snapshot.componentes.map((c) => ({
      productId: Number(c.id),
      qty: roundQty(units * Number(c.cantidad || 0)),
      unitCost: roundMoney(c.costoUnitario),
      tracksStock: Boolean(c.controlaStock),
      productName: String(c.nombre || ''),
      comboName: String(snapshot.nombre || ''),
    }));
  }
  if (!item?.product_id) return [];
  return [{
    productId: Number(item.product_id),
    qty: units,
    unitCost: roundMoney(item.precio_compra),
    tracksStock: Number(item.tracks_stock ?? 1) !== 0,
    productName: String(item.product_name || ''),
    comboName: '',
  }];
}

// Suma lo que pide todo el carrito por producto (directo + dentro de combos),
// solo de lo que controla existencia. lines: [{ productId, qty, componentes? }].
function aggregateStockNeeds(lines = []) {
  const needs = new Map();
  const add = (id, qty) => {
    const key = Number(id);
    needs.set(key, roundQty((needs.get(key) || 0) + Number(qty || 0)));
  };
  for (const line of lines) {
    const qty = Number(line.qty || 0);
    if (Array.isArray(line.componentes)) {
      for (const c of line.componentes) {
        if (c.controlaStock) add(c.id, qty * Number(c.cantidad || 0));
      }
    } else if (line.tracksStock) {
      add(line.productId, qty);
    }
  }
  return needs;
}

// Valida lo que llega del formulario de combos. Devuelve { errores, datos }.
function validateComboPayload(body = {}) {
  const errores = [];
  const nombre = String(body.nombre || '').trim().slice(0, 160);
  const codigo = String(body.codigo || '').trim().slice(0, 40);
  const precio = Number(body.precio);
  if (!nombre) errores.push('El combo necesita un nombre.');
  if (!codigo) errores.push('El combo necesita un código o referencia.');
  if (!Number.isFinite(precio) || precio <= 0) errores.push('El precio del combo debe ser mayor que cero.');
  const vistos = new Set();
  const componentes = [];
  for (const raw of Array.isArray(body.componentes) ? body.componentes : []) {
    const id = Number(raw?.id || raw?.productId || 0);
    const cantidad = roundQty(raw?.cantidad ?? raw?.qty);
    if (!(id > 0)) continue;
    if (!(cantidad > 0)) {
      errores.push('Cada producto del combo debe tener una cantidad mayor que cero.');
      continue;
    }
    if (vistos.has(id)) {
      errores.push('Un producto está repetido en el combo: súmale la cantidad en una sola línea.');
      continue;
    }
    vistos.add(id);
    componentes.push({ id, cantidad });
  }
  if (!componentes.length) errores.push('Agrega al menos un producto al combo.');
  return {
    errores,
    datos: {
      nombre,
      codigo,
      precio: roundMoney(precio),
      descripcion: String(body.descripcion || '').trim().slice(0, 500),
      activo: body.activo !== false,
      categoria: String(body.categoria || 'Combos').trim().slice(0, 60) || 'Combos',
      aplicaItbis: body.aplicaItbis === undefined ? null : Boolean(body.aplicaItbis),
      componentes,
    },
  };
}

module.exports = {
  COMBO_PRODUCT_TYPE,
  COMBO_INVOICE_DISPLAY_MODES,
  normalizeComboInvoiceDisplay,
  ensureCombosSchema,
  loadComponentsByCombo,
  computeComboTotals,
  computeComboAvailability,
  buildSaleSnapshot,
  parseComboSnapshot,
  inventoryLinesForSaleItem,
  aggregateStockNeeds,
  validateComboPayload,
  roundMoney,
  roundQty,
};

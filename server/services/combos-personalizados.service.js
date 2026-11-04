'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  combos-personalizados.service.js — Tecno Caja
//  Combos personalizados (se activan en Configuración → Apariencia).
//
//  El cajero elige el PRECIO del combo (libre, con ITBIS incluido) y los
//  productos que lleva. El combo no es un producto: cada producto entra a la
//  venta como su propia línea de sale_items, con su cantidad real, y el precio
//  del combo se reparte entre esas líneas (js/combos-personalizados-motor.js):
//  cada línea queda con su base y su ITBIS según la tasa del producto, y la
//  suma de todas da el precio elegido. Así el inventario, la cancelación, la
//  devolución, los reportes y el e-CF (una línea por producto) funcionan igual
//  que siempre. Las líneas del mismo combo llevan la misma marca
//  (custom_combo_key) y la foto del combo (nombre y precio); original_price
//  guarda el precio de catálogo de cada producto (trazabilidad).
//
//  El servidor NUNCA confía en el reparto que manda la pantalla: lo vuelve a
//  calcular con los precios de la base y el mismo motor, y si no coincide
//  rechaza la venta.
// ══════════════════════════════════════════════════════════════════════════════

const motor = require('../../js/combos-personalizados-motor');

const CONFIG_COLUMNS = {
  activo: 'custom_combos_enabled',
  mostrarImagenes: 'custom_combos_show_images',
  permitirCantidades: 'custom_combos_allow_qty',
};

const CONFIG_DEFAULTS = {
  activo: false,
  mostrarImagenes: true,
  permitirCantidades: true,
};

const PRECIO_MAXIMO_CENTAVOS = 9999999999; // RD$ 99,999,999.99 (DECIMAL(12,2))
const NOMBRE_POR_DEFECTO = 'Combo personalizado';

// Solo productos que se venden por unidad: los de peso o medida no tienen una
// cantidad entera que se pueda armar en un combo.
const TIPOS_NO_PERMITIDOS = ['combo'];

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function dinero(valor) {
  return motor.redondearDinero(valor);
}

function fmt(valor) {
  return `RD$ ${Number(valor || 0).toFixed(2)}`;
}

async function ensureCustomCombosSchema({ query, addColumnIfMissing }) {
  // Combos sugeridos (opcionales): un nombre y un precio que el cajero puede
  // usar de punto de partida. El precio de cada venta lo elige el cajero.
  await query(`
    CREATE TABLE IF NOT EXISTS custom_combos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre VARCHAR(150) NOT NULL,
      descripcion VARCHAR(500) DEFAULT NULL,
      precio DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
      color VARCHAR(20) DEFAULT NULL,
      image_local VARCHAR(255) DEFAULT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_by_user_id INT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await addColumnIfMissing('config', 'custom_combos_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('config', 'custom_combos_show_images', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('config', 'custom_combos_allow_qty', 'TINYINT(1) NOT NULL DEFAULT 1');
  // "Disponible para combos": por defecto apagado en todos los productos.
  await addColumnIfMissing('products', 'combo_personalizado', 'TINYINT(1) NOT NULL DEFAULT 0');
  // Marca del combo en cada línea de la venta (foto: no cambia si luego se
  // edita o se borra el combo sugerido).
  await addColumnIfMissing('sale_items', 'custom_combo_key', 'VARCHAR(40) DEFAULT NULL');
  await addColumnIfMissing('sale_items', 'custom_combo_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sale_items', 'custom_combo_name', 'VARCHAR(150) DEFAULT NULL');
  await addColumnIfMissing('sale_items', 'custom_combo_price', 'DECIMAL(12,2) DEFAULT NULL');
  await query('CREATE INDEX idx_sale_items_custom_combo ON sale_items (custom_combo_id)').catch(() => {});
}

function leerBool(valor, porDefecto) {
  if (valor === undefined || valor === null) return porDefecto;
  return Number(valor) !== 0 && valor !== false;
}

function leerConfig(row = {}) {
  const config = {};
  for (const [clave, columna] of Object.entries(CONFIG_COLUMNS)) {
    config[clave] = leerBool(row?.[columna], CONFIG_DEFAULTS[clave]);
  }
  return config;
}

// Lo que llega de la pantalla de Apariencia → columnas de config (solo lo que vino).
function configParaGuardar(body = {}) {
  const cambios = {};
  for (const [clave, columna] of Object.entries(CONFIG_COLUMNS)) {
    if (Object.prototype.hasOwnProperty.call(body, clave)) cambios[columna] = body[clave] ? 1 : 0;
  }
  return cambios;
}

function mapCombo(row = {}, ventas = 0) {
  return {
    id: Number(row.id),
    nombre: String(row.nombre || ''),
    descripcion: String(row.descripcion || ''),
    precio: dinero(row.precio),
    estado: String(row.estado || 'Activo'),
    activo: String(row.estado || 'Activo') !== 'Inactivo',
    color: String(row.color || ''),
    imagen: row.image_local || '',
    orden: Number(row.sort_order || 0),
    ventas: Number(ventas || 0),
  };
}

// Combo sugerido: nombre obligatorio; el precio sugerido es opcional (0 = el
// cajero lo escribe en cada venta).
function validarComboPayload(body = {}) {
  const errores = [];
  const nombre = String(body.nombre || '').trim().slice(0, 150);
  const precio = body.precio === undefined || body.precio === null || body.precio === '' ? 0 : Number(body.precio);
  if (!nombre) errores.push('El combo necesita un nombre.');
  if (!Number.isFinite(precio) || precio < 0) errores.push('El precio sugerido no es válido.');
  else if (motor.aCentavos(precio) > PRECIO_MAXIMO_CENTAVOS) errores.push('El precio sugerido es demasiado alto.');
  const color = String(body.color || '').trim();
  return {
    errores,
    datos: {
      nombre,
      descripcion: String(body.descripcion || '').trim().slice(0, 500),
      precio: Number.isFinite(precio) ? dinero(Math.max(0, precio)) : 0,
      activo: body.activo !== false,
      color: /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '',
      orden: Number.isFinite(Number(body.orden)) ? Math.trunc(Number(body.orden)) : 0,
    },
  };
}

// ¿Este producto se puede habilitar para combos? Devuelve el motivo si no.
function motivoNoHabilitable(row = {}) {
  const modo = String(row.sale_mode || 'unidad').trim().toLowerCase() || 'unidad';
  if (modo !== 'unidad') return 'solo se pueden usar productos que se venden por unidad (no por peso ni por medida)';
  if (TIPOS_NO_PERMITIDOS.includes(String(row.product_type || '').trim().toLowerCase())) {
    return 'un combo promocional no puede ir dentro de un combo personalizado';
  }
  return '';
}

async function cargarEstado(runQuery, { soloActivos = false } = {}) {
  const [configRows, comboRows, productoRows] = await Promise.all([
    runQuery('SELECT * FROM config WHERE id = 1 LIMIT 1'),
    runQuery(`SELECT * FROM custom_combos${soloActivos ? " WHERE COALESCE(estado, 'Activo') <> 'Inactivo'" : ''} ORDER BY sort_order ASC, precio ASC, id ASC`),
    runQuery('SELECT id FROM products WHERE combo_personalizado = 1'),
  ]);
  return {
    config: leerConfig(configRows[0] || {}),
    tasaItbis: Number(configRows[0]?.tax_rate ?? 18),
    combos: comboRows.map((row) => mapCombo(row)),
    productoIds: productoRows.map((row) => Number(row.id)),
  };
}

function esLineaDeCombo(item) {
  return Boolean(item && item.comboPersonalizado && String(item.comboPersonalizado.clave || '').trim());
}

function normalizarClave(valor) {
  return String(valor || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}

// Nombre del combo para la factura: sin caracteres de control ni < >.
function nombreDeCombo(valor) {
  const limpio = [...String(valor || '')]
    .filter((c) => c.charCodeAt(0) >= 32 && c !== '<' && c !== '>')
    .join('')
    .trim()
    .slice(0, 150);
  return limpio || NOMBRE_POR_DEFECTO;
}

// Valida los combos de una venta dentro de su transacción (después del lock de
// config). items: los del body de POST /api/sales (o de una venta en pausa).
// Devuelve null si la venta no trae combos (no hace ninguna consulta: la venta
// tradicional queda idéntica), o { lineas: Map(índice → datos de la línea),
// grupos: [{ clave, nombre, precio, normal }] }.
async function prepararVenta(runQuery, { items = [], config = {}, ventaSinItbis = false } = {}) {
  const indices = [];
  (Array.isArray(items) ? items : []).forEach((item, idx) => {
    if (esLineaDeCombo(item)) indices.push(idx);
  });
  if (!indices.length) return null;

  const opciones = leerConfig(config);
  if (!opciones.activo) {
    throw fail('Los combos personalizados están desactivados en este negocio. Quita el combo del pedido.', 409);
  }
  if (ventaSinItbis) {
    throw fail('El precio de un combo personalizado incluye ITBIS: no se puede facturar como E44 o E46. Quita el combo o cambia el comprobante.', 409);
  }

  const comboIds = [...new Set(indices.map((idx) => Number(items[idx].comboPersonalizado.comboId || 0)).filter((id) => id > 0))];
  const productIds = [...new Set(indices.map((idx) => Number(items[idx].id || 0)).filter((id) => id > 0))];
  const sugeridosById = new Map();
  if (comboIds.length) {
    const rows = await runQuery(`SELECT id, nombre FROM custom_combos WHERE id IN (${comboIds.map(() => '?').join(', ')})`, comboIds);
    for (const row of rows) sugeridosById.set(Number(row.id), row);
  }
  const productosById = new Map();
  if (productIds.length) {
    const rows = await runQuery(
      `SELECT id, nombre, precio_venta, aplica_itbis, itbis_modo, itbis_monto, estado, sale_mode, product_type, combo_personalizado
         FROM products WHERE id IN (${productIds.map(() => '?').join(', ')})`,
      productIds
    );
    for (const row of rows) productosById.set(Number(row.id), row);
  }

  const tasaGeneral = Number(config.tax_rate ?? 18);
  const grupos = new Map();
  for (const idx of indices) {
    const item = items[idx];
    const datos = item.comboPersonalizado;
    const clave = normalizarClave(datos.clave);
    if (!clave) throw fail('Un combo del pedido no tiene identificador. Vuelve a armarlo.', 409);
    if (item.quickSale === true || !Number(item.id || 0)) {
      throw fail('Un producto rápido no puede ir dentro de un combo personalizado.', 409);
    }
    const precioCentavos = motor.aCentavos(datos.precio);
    if (!Number.isFinite(Number(datos.precio)) || precioCentavos <= 0 || precioCentavos > PRECIO_MAXIMO_CENTAVOS) {
      throw fail('El precio de un combo del pedido no es válido. Vuelve a armarlo.', 409);
    }
    const producto = productosById.get(Number(item.id));
    if (!producto) throw fail(`El producto ID ${item.id} del combo no existe.`, 409);
    if (String(producto.estado || '') === 'Inactivo') {
      throw fail(`"${producto.nombre}" está desactivado y no puede ir en un combo.`, 409);
    }
    if (!Number(producto.combo_personalizado || 0)) {
      throw fail(`"${producto.nombre}" no está disponible para combos.`, 409);
    }
    const motivo = motivoNoHabilitable(producto);
    if (motivo) throw fail(`"${producto.nombre}" no puede ir en un combo: ${motivo}.`, 409);
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw fail(`La cantidad de "${producto.nombre}" en el combo debe ser un número entero.`, 409);
    }
    if (Number(item.descuento || 0) !== 0) {
      throw fail(`"${producto.nombre}" no puede llevar descuento propio dentro de un combo.`, 409);
    }

    if (!grupos.has(clave)) {
      const sugerido = sugeridosById.get(Number(datos.comboId || 0)) || null;
      grupos.set(clave, {
        clave,
        precioCentavos,
        comboId: sugerido ? Number(sugerido.id) : null,
        nombre: nombreDeCombo(sugerido ? sugerido.nombre : datos.nombre),
        filas: [],
      });
    }
    const grupo = grupos.get(clave);
    if (grupo.precioCentavos !== precioCentavos) throw fail('Un combo del pedido trae dos precios distintos. Vuelve a armarlo.', 409);
    grupo.filas.push({ idx, id: Number(producto.id), qty, precioCentavos: motor.aCentavos(item.precio), tasa: Number(item.itbis || 0), producto });
  }

  const lineas = new Map();
  const resumen = [];
  for (const grupo of grupos.values()) {
    // Lo elegido por producto (las filas de un mismo producto se juntan).
    const porProducto = new Map();
    for (const fila of grupo.filas) {
      const previa = porProducto.get(fila.id);
      if (previa) previa.qty += fila.qty;
      else {
        porProducto.set(fila.id, {
          id: fila.id,
          qty: fila.qty,
          precio: Number(fila.producto.precio_venta || 0),
          aplicaItbis: Boolean(Number(fila.producto.aplica_itbis || 0)),
          itbisModo: String(fila.producto.itbis_modo || '') === 'monto' ? 'monto' : 'porcentaje',
          itbisMonto: Number(fila.producto.itbis_monto || 0),
        });
      }
    }
    const seleccion = [...porProducto.values()];
    if (!opciones.permitirCantidades && seleccion.some((p) => p.qty > 1)) {
      throw fail('En los combos de este negocio va una unidad de cada producto.', 409);
    }
    const esperado = motor.repartirCombo({ precio: grupo.precioCentavos / 100, seleccion, tasa: tasaGeneral });
    const coincide = esperado.filas.length === grupo.filas.length && esperado.filas.every((f, i) => {
      const recibida = grupo.filas[i];
      return f.id === recibida.id && f.qty === recibida.qty
        && motor.aCentavos(f.precio) === recibida.precioCentavos
        && Math.abs(f.tasa - recibida.tasa) < 0.001;
    });
    if (!coincide) {
      throw fail(`El combo "${grupo.nombre}" no cuadra con los precios actuales de sus productos. Edítalo o vuelve a armarlo.`, 409);
    }
    const foto = { clave: grupo.clave, comboId: grupo.comboId, nombre: grupo.nombre, precio: grupo.precioCentavos / 100 };
    esperado.filas.forEach((f, i) => {
      lineas.set(grupo.filas[i].idx, { ...foto, precioLinea: f.precio, tasa: f.tasa, precioOriginal: f.precioOriginal });
    });
    resumen.push({
      clave: grupo.clave,
      nombre: grupo.nombre,
      precio: esperado.sumaCentavos / 100,
      normal: esperado.normalCentavos / 100,
    });
  }
  return { lineas, grupos: resumen };
}

// Para mapSaleRows: la marca del combo de una línea guardada.
function comboDeLineaGuardada(row = {}) {
  const clave = String(row.custom_combo_key || '').trim();
  if (!clave) return {};
  return {
    comboPersonalizado: {
      clave,
      comboId: row.custom_combo_id === null || row.custom_combo_id === undefined ? null : Number(row.custom_combo_id),
      nombre: String(row.custom_combo_name || ''),
      precio: dinero(row.custom_combo_price),
    },
  };
}

// Reporte: combos vendidos, ingresos, valor normal de lo que llevaron, por
// combo, por cajero, por sucursal y productos consumidos. Ventas canceladas
// fuera; devoluciones restadas.
async function construirReporte(runQuery, { desde = null, hasta = null } = {}) {
  const params = [];
  let fecha = '';
  if (desde) { fecha += ' AND s.created_at >= ?'; params.push(`${desde} 00:00:00`); }
  if (hasta) { fecha += ' AND s.created_at <= ?'; params.push(`${hasta} 23:59:59`); }
  const lineas = await runQuery(
    `SELECT si.id, si.sale_id, si.product_id, COALESCE(si.item_name, p.nombre, 'Producto') AS product_name,
            si.qty, si.line_total, si.tax_rate, si.tax_amount, si.original_price, si.custom_combo_key, si.custom_combo_id,
            si.custom_combo_name, si.custom_combo_price, s.created_at, s.branch_id,
            u.nombre AS cajero, b.nombre AS sucursal
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN products p ON p.id = si.product_id
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN branches b ON b.id = s.branch_id
      WHERE si.custom_combo_key IS NOT NULL
        AND COALESCE(s.fiscal_status, '') <> 'cancelada'${fecha}
      ORDER BY s.created_at DESC, si.id ASC`,
    params
  );
  const devueltas = new Map();
  if (lineas.length) {
    const ids = lineas.map((l) => Number(l.id));
    for (let i = 0; i < ids.length; i += 500) {
      const lote = ids.slice(i, i + 500);
      const rows = await runQuery(
        `SELECT sale_item_id, SUM(qty_returned) AS qty FROM sale_return_items
          WHERE sale_item_id IN (${lote.map(() => '?').join(', ')}) GROUP BY sale_item_id`,
        lote
      ).catch(() => []);
      for (const r of rows) devueltas.set(Number(r.sale_item_id), Number(r.qty || 0));
    }
  }

  const ventas = new Map(); // sale_id|clave → combo vendido
  const porCombo = new Map();
  const porCajero = new Map();
  const porSucursal = new Map();
  const productos = new Map();
  const sumar = (mapa, clave, base, ingreso, itbis, normal, nuevo) => {
    if (!mapa.has(clave)) mapa.set(clave, { ...base, combos: 0, ingresos: 0, itbis: 0, valorNormal: 0 });
    const acc = mapa.get(clave);
    if (nuevo) acc.combos += 1;
    acc.ingresos = dinero(acc.ingresos + ingreso);
    acc.itbis = dinero(acc.itbis + itbis);
    acc.valorNormal = dinero(acc.valorNormal + normal);
  };

  for (const linea of lineas) {
    const qtyVendida = Number(linea.qty || 0);
    const qty = Math.max(0, qtyVendida - (devueltas.get(Number(linea.id)) || 0));
    const proporcion = qtyVendida > 0 ? qty / qtyVendida : 0;
    const tasa = Number(linea.tax_rate || 0);
    // Líneas sin tax_amount guardado: el ITBIS sale de su tasa.
    const itbisLinea = Number(linea.tax_amount || 0) > 0
      ? Number(linea.tax_amount)
      : Number(linea.line_total || 0) * (tasa / 100);
    const itbis = dinero(itbisLinea * proporcion);
    const ingreso = dinero((Number(linea.line_total || 0) * proporcion) + itbis);
    // Valor normal: el precio de catálogo de lo que llevó, con su ITBIS.
    const netoNormal = dinero(Number(linea.original_price ?? 0) * qty);
    const normal = linea.original_price === null || linea.original_price === undefined
      ? ingreso
      : dinero(netoNormal + dinero(netoNormal * (tasa / 100)));
    const claveVenta = `${linea.sale_id}|${linea.custom_combo_key}`;
    const nuevo = !ventas.has(claveVenta);
    if (nuevo) ventas.set(claveVenta, true);
    const nombre = String(linea.custom_combo_name || NOMBRE_POR_DEFECTO);
    sumar(porCombo, nombre.toLowerCase(), { comboId: Number(linea.custom_combo_id || 0) || null, nombre }, ingreso, itbis, normal, nuevo);
    sumar(porCajero, String(linea.cajero || 'Sin cajero'), { cajero: String(linea.cajero || 'Sin cajero') }, ingreso, itbis, normal, nuevo);
    sumar(porSucursal, Number(linea.branch_id || 0), { sucursalId: Number(linea.branch_id || 0) || null, sucursal: String(linea.sucursal || 'Principal') }, ingreso, itbis, normal, nuevo);
    const prodKey = Number(linea.product_id || 0);
    if (!productos.has(prodKey)) productos.set(prodKey, { productoId: prodKey || null, nombre: String(linea.product_name || ''), cantidad: 0, devueltas: 0, ingresos: 0 });
    const prod = productos.get(prodKey);
    prod.cantidad = Math.round((prod.cantidad + qty) * 1000) / 1000;
    prod.devueltas = Math.round((prod.devueltas + (qtyVendida - qty)) * 1000) / 1000;
    prod.ingresos = dinero(prod.ingresos + ingreso);
  }

  const lista = (mapa) => [...mapa.values()].sort((a, b) => b.ingresos - a.ingresos);
  const filasCombo = lista(porCombo).map((f) => ({ ...f, precioPromedio: f.combos ? dinero(f.ingresos / f.combos) : 0 }));
  const ingresos = dinero(filasCombo.reduce((acc, f) => acc + f.ingresos, 0));
  const valorNormal = dinero(filasCombo.reduce((acc, f) => acc + f.valorNormal, 0));
  return {
    desde,
    hasta,
    combosVendidos: ventas.size,
    ingresos,
    itbis: dinero(filasCombo.reduce((acc, f) => acc + f.itbis, 0)),
    valorNormal,
    diferencia: dinero(ingresos - valorNormal),
    porCombo: filasCombo,
    porCajero: lista(porCajero),
    porSucursal: lista(porSucursal),
    productos: [...productos.values()].sort((a, b) => b.cantidad - a.cantidad),
  };
}

module.exports = {
  CONFIG_COLUMNS,
  CONFIG_DEFAULTS,
  NOMBRE_POR_DEFECTO,
  ensureCustomCombosSchema,
  leerConfig,
  configParaGuardar,
  mapCombo,
  validarComboPayload,
  motivoNoHabilitable,
  cargarEstado,
  esLineaDeCombo,
  normalizarClave,
  prepararVenta,
  comboDeLineaGuardada,
  construirReporte,
  fmt,
};

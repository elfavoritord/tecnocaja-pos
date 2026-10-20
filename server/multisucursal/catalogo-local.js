'use strict';

/**
 * server/multisucursal/catalogo-local.js — El catálogo y los usuarios de la
 * empresa vistos desde ESTA base (Fase 4).
 *
 *  - La sucursal PRINCIPAL publica: un producto con alcance 'global' o
 *    'sucursales' y un usuario con sucursales asignadas suben a la central
 *    (los detecta sincronizacion.js por su huella).
 *  - Las demás sucursales reciben: un producto que llegó de la central
 *    (origen_catalogo = 'central') conserva aquí su precio, costo, existencia
 *    y disponibilidad, pero sus datos maestros (nombre, código, categoría,
 *    impuesto…) los manda la central. Lo mismo con los usuarios de la empresa.
 *
 * Estas funciones las llaman las rutas de productos y usuarios de server.js
 * (una línea cada una) para que la regla se cumpla en el backend y no solo
 * escondiendo botones.
 */

const crypto = require('crypto');

const ALCANCES = Object.freeze(['local', 'global', 'sucursales']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function huella(objeto) {
  return crypto.createHash('sha256').update(JSON.stringify(objeto), 'utf8').digest('hex');
}

function listaJson(valor) {
  if (Array.isArray(valor)) return valor;
  try {
    const v = JSON.parse(valor || 'null');
    return Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

// Datos maestros de un producto (lo que manda la central) a partir de su fila.
function maestroProducto(row) {
  return {
    codigo: String(row.codigo || ''),
    barcode: String(row.barcode || row.codigo || ''),
    nombre: String(row.nombre || ''),
    categoria: String(row.categoria || 'General'),
    marca: row.marca ? String(row.marca) : null,
    unidad: String(row.unidad || 'Unidad'),
    saleMode: String(row.sale_mode || 'unidad'),
    productType: String(row.product_type || 'general'),
    aplicaItbis: Boolean(Number(row.aplica_itbis || 0)),
    itbisModo: row.itbis_modo === 'monto' ? 'monto' : 'porcentaje',
    itbisMonto: Math.round(Number(row.itbis_monto || 0) * 100) / 100,
    tracksStock: Number(row.tracks_stock ?? 1) !== 0,
    estado: row.estado === 'Inactivo' ? 'Inactivo' : 'Activo',
  };
}

// Incluye el precio y el costo de la principal: son el precio SUGERIDO con el
// que arranca una sucursal nueva (a las que ya lo tienen no les cambia nada).
function huellaProducto(row) {
  return huella({
    ...maestroProducto(row),
    precioSugerido: Math.round(Number(row.precio_venta || 0) * 100) / 100,
    costoSugerido: Math.round(Number(row.precio_compra || 0) * 100) / 100,
    alcance: row.alcance_empresa,
    sucursales: row.alcance_empresa === 'sucursales' ? (listaJson(row.sucursales_empresa) || []).slice().sort() : [],
  });
}

function maestroUsuario(row, roleCode) {
  return {
    usuario: String(row.usuario || ''),
    nombre: String(row.nombre || ''),
    email: row.email ? String(row.email) : null,
    roleCode: String(roleCode || ''),
    rol: String(row.rol || ''),
    tipoFacturacion: row.tipo_facturacion ? String(row.tipo_facturacion) : null,
    passwordHash: String(row.password_hash || ''),
    estado: row.estado === 'Inactivo' ? 'Inactivo' : 'Activo',
  };
}

function huellaUsuario(row, roleCode) {
  return huella({ ...maestroUsuario(row, roleCode), sucursales: (listaJson(row.sucursales_empresa) || []).slice().sort() });
}

class ErrorCatalogo extends Error {
  constructor(mensaje, codigo, status = 409) {
    super(mensaje);
    this.code = codigo;
    this.statusCode = status;
  }
}

function createCatalogoLocal({ query, enlace, alCambiar = () => {} }) {
  async function rolEnlace() {
    const e = await enlace.estado().catch(() => null);
    const vinculado = Boolean(e?.vinculado);
    return { vinculado, esPrincipal: vinculado && Boolean(e?.sucursal?.esPrincipal) };
  }

  function validarSucursales(valor, { permitirTodas = false } = {}) {
    const lista = (Array.isArray(valor) ? valor : []).map((v) => String(v || '').toLowerCase());
    if (permitirTodas && lista.includes('*')) return ['*'];
    const limpias = [...new Set(lista.filter((v) => UUID.test(v)))];
    if (limpias.length !== lista.length) throw new ErrorCatalogo('Lista de sucursales inválida.', 'DATOS_INVALIDOS', 400);
    return limpias;
  }

  // Lee una fila con las columnas multisucursal; null si no existen (migración
  // apagada con TECNO_CAJA_MULTISUCURSAL_DESACTIVAR) o si no hay fila.
  async function fila(tabla, id) {
    const rows = await query(`SELECT * FROM ${tabla === 'users' ? 'users' : 'products'} WHERE id = ? LIMIT 1`, [Number(id)]).catch(() => []);
    return rows[0] || null;
  }

  // Antes de guardar el producto: que el alcance que manda la pantalla sea válido.
  function validarAlcanceProducto(data = {}) {
    if (!Object.prototype.hasOwnProperty.call(data, 'alcanceEmpresa')) return null;
    const alcance = ALCANCES.includes(data.alcanceEmpresa) ? data.alcanceEmpresa : 'local';
    const sucursales = alcance === 'sucursales' ? validarSucursales(data.sucursalesEmpresa) : null;
    if (alcance === 'sucursales' && !sucursales.length) {
      throw new ErrorCatalogo('Elige al menos una sucursal para el producto.', 'DATOS_INVALIDOS', 400);
    }
    return { alcance, sucursales };
  }

  // POST/PUT /api/products: el alcance en la empresa solo lo fija la principal.
  // `nuevo`: un producto recién creado sin alcance elegido (portal del
  // contador, app de reportes, la API) en la principal enlazada es de TODA la
  // empresa: el catálogo es uno solo y llega a las sucursales. "Solo esta
  // sucursal" hay que elegirlo.
  async function guardarAlcanceProducto(productId, data = {}, { nuevo = false } = {}) {
    const elegido = validarAlcanceProducto(data);
    const valido = elegido || (nuevo ? { alcance: 'global', sucursales: null } : null);
    if (!valido) return false;
    const { esPrincipal } = await rolEnlace();
    if (!esPrincipal) return false;
    const { alcance, sucursales } = valido;
    await query(
      "UPDATE products SET alcance_empresa = ?, sucursales_empresa = ? WHERE id = ? AND origen_catalogo = 'local'",
      [alcance, sucursales ? JSON.stringify(sucursales) : null, Number(productId)]
    );
    alCambiar();
    return true;
  }

  // PUT /api/products/:id en una sucursal que no es la principal: los datos
  // maestros de un producto de la empresa no se cambian aquí (gana la central).
  // Precio, costo, existencia y disponibilidad sí son de la sucursal.
  async function protegerMaestroProducto(productId, data) {
    if (!data || typeof data !== 'object') return data;
    const previo = await fila('products', productId);
    if (!previo || previo.origen_catalogo !== 'central') return data;
    const { vinculado, esPrincipal } = await rolEnlace();
    if (!vinculado || esPrincipal) return data;
    const m = maestroProducto(previo);
    return {
      ...data,
      codigo: m.codigo,
      barcode: m.barcode,
      nombre: m.nombre,
      categoria: m.categoria,
      marca: m.marca,
      unidad: m.unidad,
      saleMode: m.saleMode,
      tipoProducto: m.productType,
      aplicaItbis: m.aplicaItbis,
      itbisModo: m.itbisModo,
      itbisMonto: m.itbisMonto,
      tracksStock: m.tracksStock,
    };
  }

  // DELETE /api/products/:id: un producto de la empresa no se borra; se pone
  // inactivo (así las ventas viejas de todas las sucursales lo conservan).
  async function validarEliminarProducto(productId) {
    const row = await fila('products', productId);
    if (!row) return;
    const deLaEmpresa = row.origen_catalogo === 'central' || (row.alcance_empresa && row.alcance_empresa !== 'local');
    if (!deLaEmpresa) return;
    const { vinculado } = await rolEnlace();
    if (!vinculado) return;
    throw new ErrorCatalogo('Este producto es del catálogo de la empresa: ponlo inactivo en vez de eliminarlo.', 'PRODUCTO_DE_EMPRESA');
  }

  // POST/PUT /api/users: en qué sucursales de la empresa puede entrar (solo la principal).
  async function guardarSucursalesUsuario(userId, data = {}) {
    if (!Object.prototype.hasOwnProperty.call(data, 'sucursalesEmpresa')) return false;
    const { esPrincipal } = await rolEnlace();
    if (!esPrincipal) return false;
    const lista = data.sucursalesEmpresa == null ? null : validarSucursales(data.sucursalesEmpresa, { permitirTodas: true });
    await query(
      "UPDATE users SET sucursales_empresa = ? WHERE id = ? AND origen_usuario = 'local'",
      [lista && lista.length ? JSON.stringify(lista) : null, Number(userId)]
    );
    alCambiar();
    return true;
  }

  // PUT/DELETE /api/users/:id: un usuario de la empresa se administra en la principal.
  async function validarEditarUsuario(userId) {
    const row = await fila('users', userId);
    if (!row || row.origen_usuario !== 'central') return;
    const { vinculado, esPrincipal } = await rolEnlace();
    if (!vinculado || esPrincipal) return;
    throw new ErrorCatalogo('Este usuario es de la empresa: se administra en la sucursal principal.', 'USUARIO_DE_EMPRESA', 403);
  }

  // Producto que pidió el contador desde su portal (productos_pendientes): a
  // qué sucursales de la empresa va. Sin elegir (o "todas") = toda la empresa.
  function alcanceDeSolicitud(solicitud = {}) {
    const lista = Array.isArray(solicitud.sucursalesEmpresa)
      ? solicitud.sucursalesEmpresa.map((v) => String(v || '').toLowerCase()).filter((v) => UUID.test(v))
      : [];
    return lista.length ? { alcanceEmpresa: 'sucursales', sucursalesEmpresa: lista } : {};
  }

  return {
    rolEnlace,
    validarAlcanceProducto,
    guardarAlcanceProducto,
    alcanceDeSolicitud,
    protegerMaestroProducto,
    validarEliminarProducto,
    guardarSucursalesUsuario,
    validarEditarUsuario,
  };
}

module.exports = {
  createCatalogoLocal,
  ErrorCatalogo,
  maestroProducto,
  huellaProducto,
  maestroUsuario,
  huellaUsuario,
  listaJson,
  huella,
  ALCANCES,
};

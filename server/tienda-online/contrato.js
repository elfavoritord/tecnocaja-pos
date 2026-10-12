'use strict';

/**
 * server/tienda-online/contrato.js
 *
 * Contrato de datos de la Tienda Online entre el POS y el servicio en la nube
 * (cloud/tienda-online, que copia este archivo con scripts/vendor-sync.js).
 * Si cambias algo aquí, corre el vendor-sync y las pruebas de ambos lados.
 *
 * Todo vive en Firestore bajo la licencia del negocio (businesses/{licencia}),
 * así el formateo de un negocio lo borra completo y ningún negocio ve lo de
 * otro. La única colección global es tienda_slugs (nombre público → licencia).
 *
 *   tienda_slugs/{slug}                        { licenseId, sucursalId }
 *   businesses/{lic}/tiendaOnline/perfil       datos públicos de la tienda
 *   businesses/{lic}/tiendaOnline/catalogo     índice del catálogo (páginas)
 *   businesses/{lic}/tiendaOnline/catalogo_p{n} productos publicados
 *   businesses/{lic}/tiendaOnline/stock        existencia publicada (s) y
 *                                              reservada por pedidos abiertos (r)
 *                                              + contador de pedidos
 *   businesses/{lic}/tiendaImagenes/{clave}    imágenes livianas (webp base64)
 *   businesses/{lic}/pedidosOnline/{id}        pedidos (los crea la nube)
 *   businesses/{lic}/pedidosOnlineClaves/{h}   idempotencia del checkout
 */

const ESTADOS = Object.freeze({
  NUEVO: 'nuevo',
  CONFIRMADO: 'confirmado',
  EN_PREPARACION: 'en_preparacion',
  LISTO: 'listo',
  EN_CAMINO: 'en_camino',
  ENTREGADO: 'entregado',
  CANCELADO: 'cancelado',
  RECHAZADO: 'rechazado',
});

const ESTADO_ETIQUETAS = Object.freeze({
  nuevo: 'Nuevo',
  confirmado: 'Confirmado',
  en_preparacion: 'En preparación',
  listo: 'Listo',
  en_camino: 'En camino',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
  rechazado: 'Rechazado',
});

const ESTADOS_FINALES = Object.freeze(['entregado', 'cancelado', 'rechazado']);

// Estados desde los que un pedido todavía se puede convertir en venta.
const ESTADOS_CONVERTIBLES = Object.freeze(['nuevo', 'confirmado', 'en_preparacion', 'listo']);

const METODOS_PAGO = Object.freeze({
  efectivo: 'Efectivo',
  transferencia: 'Transferencia bancaria',
  tarjeta: 'Tarjeta (al recibir)',
  contra_entrega: 'Pago contra entrega',
  otro: 'Otro método',
});

const PAGINA_CATALOGO = 300;
const NUMERO_PEDIDO_INICIAL = 1001;
const MAX_ITEMS_PEDIDO = 60;
const MAX_CANTIDAD_LINEA = 999;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const SLUGS_RESERVADOS = new Set([
  'api', 'admin', 't', 'tienda', 'tiendas', 'health', 'img', 'static', 'assets', 'public',
  'pedido', 'pedidos', 'www', 'app', 'tecnocaja', 'tecno-caja', 'soporte', 'login',
]);

function normalizarSlug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

function slugValido(slug) {
  return SLUG_RE.test(String(slug || '')) && !SLUGS_RESERVADOS.has(String(slug));
}

/** Clave de producto dentro de los mapas de Firestore (un nombre de campo válido). */
function claveProducto(productId) {
  return `p${Number(productId)}`;
}

// Fotos de un producto en la tienda: la principal (la del POS) + hasta 5 más.
const MAX_FOTOS_PRODUCTO = 6;

/** Clave de la foto n del producto en tiendaImagenes (0 = la principal). */
function claveFotoProducto(productId, n = 0) {
  return Number(n) > 0 ? `${claveProducto(productId)}_${Number(n)}` : claveProducto(productId);
}

/** Claves válidas en tiendaImagenes. */
const CLAVE_IMAGEN_RE = /^(p\d{1,10}(?:_[1-5])?|_logo|_banner)$/;

const rutas = Object.freeze({
  slug: (slug) => `tienda_slugs/${slug}`,
  tienda: (lic) => `businesses/${lic}/tiendaOnline`,
  perfil: (lic) => `businesses/${lic}/tiendaOnline/perfil`,
  catalogo: (lic) => `businesses/${lic}/tiendaOnline/catalogo`,
  catalogoPagina: (lic, n) => `businesses/${lic}/tiendaOnline/catalogo_p${n}`,
  stock: (lic) => `businesses/${lic}/tiendaOnline/stock`,
  imagenes: (lic) => `businesses/${lic}/tiendaImagenes`,
  imagen: (lic, clave) => `businesses/${lic}/tiendaImagenes/${clave}`,
  pedidos: (lic) => `businesses/${lic}/pedidosOnline`,
  pedido: (lic, id) => `businesses/${lic}/pedidosOnline/${id}`,
  claves: (lic) => `businesses/${lic}/pedidosOnlineClaves`,
  clave: (lic, hash) => `businesses/${lic}/pedidosOnlineClaves/${hash}`,
});

/** Mensaje para el cliente cuando su pedido cambia de estado. */
const MENSAJES_CLIENTE = Object.freeze({
  nuevo: 'Hemos recibido tu pedido #{numero}. Te avisaremos cuando lo confirmemos.',
  confirmado: 'Tu pedido #{numero} fue confirmado.',
  en_preparacion: 'Estamos preparando tu pedido #{numero}.',
  listo: 'Tu pedido #{numero} está listo.',
  listo_retiro: 'Tu pedido #{numero} está listo. Puedes pasar a retirarlo.',
  en_camino: '🚚 Tu pedido #{numero} está en camino.',
  entregado: '✅ Tu pedido #{numero} fue entregado. ¡Gracias por comprar!',
  cancelado: 'Tu pedido #{numero} fue cancelado.',
  rechazado: 'Lo sentimos, no pudimos aceptar tu pedido #{numero}.',
});

function mensajeCliente(estado, { numero, tipoEntrega = 'retiro', motivo = '' } = {}) {
  const clave = estado === 'listo' && tipoEntrega === 'retiro' ? 'listo_retiro' : estado;
  const base = MENSAJES_CLIENTE[clave] || '';
  const texto = base.replace('{numero}', String(numero || ''));
  return motivo && (estado === 'cancelado' || estado === 'rechazado') ? `${texto} Motivo: ${motivo}` : texto;
}

module.exports = {
  ESTADOS,
  ESTADO_ETIQUETAS,
  ESTADOS_FINALES,
  ESTADOS_CONVERTIBLES,
  METODOS_PAGO,
  PAGINA_CATALOGO,
  NUMERO_PEDIDO_INICIAL,
  MAX_ITEMS_PEDIDO,
  MAX_CANTIDAD_LINEA,
  SLUGS_RESERVADOS,
  normalizarSlug,
  slugValido,
  claveProducto,
  MAX_FOTOS_PRODUCTO,
  claveFotoProducto,
  CLAVE_IMAGEN_RE,
  rutas,
  mensajeCliente,
};

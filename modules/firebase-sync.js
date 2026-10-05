'use strict';

let _db = null;
let _FieldValue = null;
let _initAttempted = false;

function _normalizeNullableCoordinate(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function _normalizeOptionalText(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  if (!text || text.toLowerCase() === 'null' || text.toLowerCase() === 'undefined') {
    return '';
  }
  return text;
}

function _tryInit() {
  if (_initAttempted) return _db !== null;
  _initAttempted = true;
  try {
    const { getFirestore } = require('./firebase-admin');
    const admin = require('firebase-admin');
    _db = getFirestore();
    _FieldValue = admin.firestore.FieldValue;
    return true;
  } catch (err) {
    console.warn('[firebase-sync] Firebase no disponible, sync desactivado:', err.message);
    return false;
  }
}

// Identidad de ESTE negocio en Firestore: la licencia de la instalación.
// El proyecto Firebase es el mismo para todos los clientes, así que nunca se
// usa FIREBASE_PROJECT_ID ni un nombre fijo como respaldo: eso juntaba los
// datos de todos los negocios en el mismo documento.
function getTenantId() {
  return String(process.env.TECNO_CAJA_LICENSE_UID || '').trim();
}

function _safeDocIdPart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * ID del pedido en pedidos_delivery. Lleva la licencia porque la numeración de
 * facturas se repite entre negocios (todos empiezan en FAC-00001001) y con el
 * ID viejo `pos_{factura}` un negocio pisaba el pedido de otro.
 */
function buildPedidoDocId(invoiceNumber, tenantId = getTenantId()) {
  if (!tenantId || !invoiceNumber) return null;
  return `pos_${_safeDocIdPart(tenantId)}_${_safeDocIdPart(invoiceNumber)}`;
}

function _getBusinessId() {
  const raw = String(process.env.TECNO_CAJA_BUSINESS_ID || getTenantId()).trim();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || null;
}

// Sin licencia vinculada no se sube nada: mejor no sincronizar que mezclar.
function _negocioRef() {
  const businessId = _getBusinessId();
  return businessId ? _db.collection('negocios').doc(businessId) : null;
}

function _todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function _metodoPagoKey(metodo) {
  const m = String(metodo || '').toLowerCase();
  if (m.includes('tarjeta')) return 'tarjeta';
  if (m.includes('transfer')) return 'transferencia';
  if (m.includes('credito') || m.includes('crédito')) return 'credito';
  if (m.includes('contra')) return 'contra_entrega';
  return 'efectivo';
}

/**
 * Acumula el total de una venta en el documento diario de Firestore.
 * Usa FieldValue.increment para que las escrituras concurrentes sean seguras.
 */
async function syncVentaDia({ total, metodoPago, sucursalId, sucursalNombre }) {
  if (!_tryInit()) return;
  const negocio = _negocioRef();
  if (!negocio) return;
  try {
    const fecha = _todayStr();
    const sid = String(sucursalId || '1');
    const metodoKey = _metodoPagoKey(metodoPago);
    await negocio
      .collection('ventas_dia')
      .doc(fecha)
      .set(
        {
          [`sucursales.${sid}.nombre`]: sucursalNombre || `Sucursal ${sid}`,
          [`sucursales.${sid}.total`]: _FieldValue.increment(Number(total) || 0),
          [`sucursales.${sid}.ventas`]: _FieldValue.increment(1),
          [`sucursales.${sid}.${metodoKey}`]: _FieldValue.increment(Number(total) || 0),
          total_global: _FieldValue.increment(Number(total) || 0),
          ventas_count: _FieldValue.increment(1),
          fecha,
          updatedAt: _FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  } catch (err) {
    console.warn('[firebase-sync] syncVentaDia error:', err.message);
  }
}

/**
 * Crea o actualiza un pedido delivery en Firestore.
 */
async function syncDeliveryOrder(order) {
  if (!_tryInit()) return;
  if (!order?.invoice_number) return;
  const negocio = _negocioRef();
  if (!negocio) return;
  try {
    const invoiceNumber = String(order.invoice_number);
    await negocio
      .collection('delivery_orders')
      .doc(invoiceNumber)
      .set(
        {
          invoice_number: invoiceNumber,
          client_name: order.client_name || order.client_name_snapshot || 'Consumidor Final',
          client_phone: order.client_phone || order.delivery_phone_snapshot || order.client_phone_snapshot || '',
          address: order.delivery_address_snapshot || '',
          reference: order.delivery_reference_snapshot || '',
          location_link: order.delivery_location_link_snapshot || '',
          total: Number(order.total) || 0,
          payment_method: order.payment_method || 'efectivo',
          status: order.kitchen_status || 'pendiente',
          delivery_user_id: order.delivery_user_id || null,
          delivery_nombre: order.delivery_name_snapshot || '',
          sucursal_id: order.branch_id || null,
          items_count: Number(order.items_count) || 0,
          notes: order.order_notes || '',
          updatedAt: _FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  } catch (err) {
    console.warn('[firebase-sync] syncDeliveryOrder error:', err.message);
  }
}

/**
 * Actualiza el estado de una caja en Firestore (apertura o cierre).
 */
async function syncEstadoCaja({ cajaId, cajaNombre, sucursalId, sucursalNombre, estado, cajeroNombre, montoActual }) {
  if (!_tryInit()) return;
  const negocio = _negocioRef();
  if (!negocio) return;
  try {
    await negocio
      .collection('estado_cajas')
      .doc(String(cajaId))
      .set(
        {
          id: Number(cajaId),
          nombre: cajaNombre || `Caja ${cajaId}`,
          sucursal_id: Number(sucursalId) || null,
          sucursal_nombre: sucursalNombre || '',
          estado: estado || 'cerrada',
          cajero_nombre: cajeroNombre || '',
          monto_actual: Number(montoActual) || 0,
          updatedAt: _FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  } catch (err) {
    console.warn('[firebase-sync] syncEstadoCaja error:', err.message);
  }
}

/**
 * Crea o elimina una alerta de stock bajo.
 * Si stockActual > stockMinimo, elimina la alerta (ya no aplica).
 */
async function syncAlertaStock({ productId, nombre, codigo, stockActual, stockMinimo, sucursalId }) {
  if (!_tryInit()) return;
  const negocio = _negocioRef();
  if (!negocio) return;
  const docId = `${productId}_${sucursalId || '0'}`;
  try {
    if (Number(stockActual) > Number(stockMinimo)) {
      await negocio.collection('stock_alertas').doc(docId).delete().catch(() => {});
      return;
    }
    await negocio
      .collection('stock_alertas')
      .doc(docId)
      .set(
        {
          product_id: Number(productId),
          nombre: nombre || '',
          codigo: codigo || '',
          stock_actual: Number(stockActual) || 0,
          stock_minimo: Number(stockMinimo) || 0,
          sucursal_id: Number(sucursalId) || null,
          updatedAt: _FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  } catch (err) {
    console.warn('[firebase-sync] syncAlertaStock error:', err.message);
  }
}

/**
 * Crea un pedido en la colección pedidos_delivery (schema de la app Flutter).
 * Requiere firebase_uid del repartidor (no el ID local del POS).
 */
async function syncPedidoDelivery({
  invoiceNumber,
  repartidorId,
  repartidorNombre,
  clienteNombre,
  clienteTelefono,
  clienteDireccion,
  clienteReferencia,
  clienteLocationLink,
  clienteLat,
  clienteLng,
  negocioNombre,
  total,
  productos,
  notasInternas,
  montoClienteEntrega,
  cambioRepartidor,
}) {
  if (!_tryInit()) return;
  if (!invoiceNumber || !repartidorId) return;
  const tenantId = getTenantId();
  const docId = buildPedidoDocId(invoiceNumber, tenantId);
  if (!docId) {
    console.warn('[firebase-sync] Pedido delivery no enviado: este equipo no tiene licencia vinculada.');
    return;
  }
  try {
    const now = _FieldValue.serverTimestamp();
    const clienteLatNormalized = _normalizeNullableCoordinate(clienteLat);
    const clienteLngNormalized = _normalizeNullableCoordinate(clienteLng);
    const clienteDireccionNormalized = _normalizeOptionalText(clienteDireccion);
    const clienteReferenciaNormalized = _normalizeOptionalText(clienteReferencia);
    const clienteLocationLinkNormalized = _normalizeOptionalText(clienteLocationLink);
    const montoClienteEntregaNormalized = montoClienteEntrega === null || montoClienteEntrega === undefined ? null : Number(montoClienteEntrega);
    const cambioRepartidorNormalized = cambioRepartidor === null || cambioRepartidor === undefined ? null : Number(cambioRepartidor);
    await _db.collection('pedidos_delivery').doc(docId).set({
      licenseId: tenantId,
      numeroFactura: String(invoiceNumber),
      repartidorId: String(repartidorId),
      repartidorNombre: _normalizeOptionalText(repartidorNombre),
      clienteNombre: _normalizeOptionalText(clienteNombre) || 'Consumidor Final',
      clienteTelefono: _normalizeOptionalText(clienteTelefono),
      clienteDireccion: clienteDireccionNormalized,
      clienteReferencia: clienteReferenciaNormalized,
      clienteLocationLink: clienteLocationLinkNormalized,
      clienteLat: clienteLatNormalized,
      clienteLng: clienteLngNormalized,
      negocioNombre: _normalizeOptionalText(negocioNombre),
      total: Number(total) || 0,
      productos: (productos || []).map((p) => ({
        nombre: _normalizeOptionalText(p.nombre),
        cantidad: Number(p.cantidad || 1),
        precio: Number(p.precio || 0),
      })),
      notasInternas: _normalizeOptionalText(notasInternas) || null,
      montoClienteEntrega: montoClienteEntregaNormalized,
      cambioRepartidor: cambioRepartidorNormalized,
      incidencias: [],
      estado: 'asignado',
      creadoEn: now,
      actualizadoEn: now,
      entregadoEn: null,
    });
  } catch (err) {
    console.warn('[firebase-sync] syncPedidoDelivery error:', err.message);
  }
}

async function patchPedidoDeliveryMetadata({
  invoiceNumber,
  clienteNombre,
  clienteTelefono,
  clienteDireccion,
  clienteReferencia,
  clienteLocationLink,
  clienteLat,
  clienteLng,
  negocioNombre,
}) {
  if (!_tryInit()) return false;
  // Solo se corrige el pedido propio (ID con la licencia). Los pedidos viejos
  // `pos_{factura}` no se tocan: ese ID lo comparten todos los negocios y
  // escribir ahí cambiaba los datos del pedido de otro cliente.
  const docId = buildPedidoDocId(invoiceNumber);
  if (!docId) return false;
  try {
    // update() y no set(merge): si el pedido no existe no se crea uno vacío.
    await _db.collection('pedidos_delivery').doc(docId).update({
      clienteNombre: _normalizeOptionalText(clienteNombre) || 'Consumidor Final',
      clienteTelefono: _normalizeOptionalText(clienteTelefono),
      clienteDireccion: _normalizeOptionalText(clienteDireccion),
      clienteReferencia: _normalizeOptionalText(clienteReferencia),
      clienteLocationLink: _normalizeOptionalText(clienteLocationLink),
      clienteLat: _normalizeNullableCoordinate(clienteLat),
      clienteLng: _normalizeNullableCoordinate(clienteLng),
      negocioNombre: _normalizeOptionalText(negocioNombre),
      actualizadoEn: _FieldValue.serverTimestamp(),
    });
    return true;
  } catch (err) {
    if (Number(err?.code) !== 5) { // 5 = NOT_FOUND: pedido sin enviar, nada que corregir
      console.warn('[firebase-sync] patchPedidoDeliveryMetadata error:', err.message);
    }
    return false;
  }
}

module.exports = {
  getTenantId,
  buildPedidoDocId,
  syncVentaDia,
  syncDeliveryOrder,
  syncEstadoCaja,
  syncAlertaStock,
  syncPedidoDelivery,
  patchPedidoDeliveryMetadata,
};

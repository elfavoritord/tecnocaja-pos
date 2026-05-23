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

function _getBusinessId() {
  const raw = String(
    process.env.TECNO_CAJA_BUSINESS_ID ||
    process.env.FIREBASE_PROJECT_ID ||
    'tecnocaja'
  ).trim();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tecnocaja';
}

function _negocioRef() {
  return _db.collection('negocios').doc(_getBusinessId());
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
  try {
    const fecha = _todayStr();
    const sid = String(sucursalId || '1');
    const metodoKey = _metodoPagoKey(metodoPago);
    await _negocioRef()
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
  try {
    const invoiceNumber = String(order.invoice_number);
    await _negocioRef()
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
  try {
    await _negocioRef()
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
  const docId = `${productId}_${sucursalId || '0'}`;
  try {
    if (Number(stockActual) > Number(stockMinimo)) {
      await _negocioRef().collection('stock_alertas').doc(docId).delete().catch(() => {});
      return;
    }
    await _negocioRef()
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
}) {
  if (!_tryInit()) return;
  if (!invoiceNumber || !repartidorId) return;
  try {
    const docId = `pos_${String(invoiceNumber).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const now = _FieldValue.serverTimestamp();
    const clienteLatNormalized = _normalizeNullableCoordinate(clienteLat);
    const clienteLngNormalized = _normalizeNullableCoordinate(clienteLng);
    const clienteDireccionNormalized = _normalizeOptionalText(clienteDireccion);
    const clienteReferenciaNormalized = _normalizeOptionalText(clienteReferencia);
    const clienteLocationLinkNormalized = _normalizeOptionalText(clienteLocationLink);
    await _db.collection('pedidos_delivery').doc(docId).set({
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
  if (!invoiceNumber) return false;
  try {
    const docId = `pos_${String(invoiceNumber).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    await _db.collection('pedidos_delivery').doc(docId).set(
      {
        numeroFactura: String(invoiceNumber),
        clienteNombre: _normalizeOptionalText(clienteNombre) || 'Consumidor Final',
        clienteTelefono: _normalizeOptionalText(clienteTelefono),
        clienteDireccion: _normalizeOptionalText(clienteDireccion),
        clienteReferencia: _normalizeOptionalText(clienteReferencia),
        clienteLocationLink: _normalizeOptionalText(clienteLocationLink),
        clienteLat: _normalizeNullableCoordinate(clienteLat),
        clienteLng: _normalizeNullableCoordinate(clienteLng),
        negocioNombre: _normalizeOptionalText(negocioNombre),
        actualizadoEn: _FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  } catch (err) {
    console.warn('[firebase-sync] patchPedidoDeliveryMetadata error:', err.message);
    return false;
  }
}

module.exports = {
  syncVentaDia,
  syncDeliveryOrder,
  syncEstadoCaja,
  syncAlertaStock,
  syncPedidoDelivery,
  patchPedidoDeliveryMetadata,
};

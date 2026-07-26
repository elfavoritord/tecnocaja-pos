'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const syncSales = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const sales = Array.isArray(request.data?.sales) ? request.data.sales : [];
  if (sales.length === 0 || sales.length > 100) {
    throw new HttpsError(
      'invalid-argument',
      'Envía entre 1 y 100 ventas por sincronización.'
    );
  }

  const db = admin.firestore();
  const profileDoc = await db.collection('users').doc(uid).get();
  const profile = profileDoc.data() || {};
  const businessId = String(profile.businessId || '').trim();
  if (!profileDoc.exists || profile.isActive === false || !businessId) {
    throw new HttpsError('permission-denied', 'Tu cuenta no tiene una empresa activa.');
  }

  const collection = db.collection('businesses').doc(businessId).collection('sales');
  const counterRef = db.collection('businesses').doc(businessId)
    .collection('counters').doc('sales');
  const existingSales = await collection.select('invoiceNumber').get();
  const existingMaximum = existingSales.docs.reduce((maximum, document) => {
    const match = String(document.data()?.invoiceNumber || '').match(/^FAC-(\d+)$/i);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  let written = 0;
  const invoiceNumbers = {};
  for (const raw of sales) {
    const sale = raw && typeof raw === 'object' ? raw : {};
    const saleId = String(sale.id || '').trim();
    const total = Number(sale.total || 0);
    if (!saleId || !Number.isFinite(total) || !Array.isArray(sale.items)) {
      throw new HttpsError('invalid-argument', 'Una venta contiene datos inválidos.');
    }
    const createdAt = new Date(String(sale.createdAt || ''));
    const updatedAt = new Date(String(sale.updatedAt || sale.createdAt || ''));
    if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())) {
      throw new HttpsError('invalid-argument', 'La fecha de una venta no es válida.');
    }
    const saleRef = collection.doc(saleId);
    await db.runTransaction(async (transaction) => {
      const [saleDoc, counterDoc] = await Promise.all([
        transaction.get(saleRef),
        transaction.get(counterRef),
      ]);
      const savedNumber = String(saleDoc.data()?.invoiceNumber || '');
      const canonicalSaved = /^(FAC|ECF)-\d+$/i.test(savedNumber);
      const next = Math.max(
        Number(counterDoc.data()?.nextNumber || 1),
        existingMaximum + 1
      );
      const invoiceNumber = canonicalSaved
        ? savedNumber
        : `FAC-${String(next).padStart(8, '0')}`;
      if (!canonicalSaved) {
        transaction.set(counterRef, {
          nextNumber: next + 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      transaction.set(saleRef, {
        businessId,
        sourceSaleId: saleId,
        origin: 'app_movil',
        origen: 'app_movil',
        syncStatus: saleDoc.exists && saleDoc.data()?.posSaleId
          ? 'synced'
          : 'pending_pos',
        synced: Boolean(saleDoc.data()?.posSaleId),
        invoiceNumber,
        invoiceType: String(sale.invoiceType || 'ticket'),
        customerId: sale.customerId ? String(sale.customerId) : null,
        cashierId: sale.cashierId ? String(sale.cashierId) : null,
        cashierName: sale.cashierName ? String(sale.cashierName) : null,
        branchId: sale.branchId ? String(sale.branchId) : null,
        cashRegisterId: sale.cashRegisterId ? String(sale.cashRegisterId) : null,
        cashSessionId: sale.cashSessionId ? String(sale.cashSessionId) : null,
        subtotal: Number(sale.subtotal || 0),
        discount: Number(sale.discount || 0),
        tax: Number(sale.tax || 0),
        total,
        currency: String(sale.currency || 'DOP'),
        paymentMethod: String(sale.paymentMethod || 'efectivo'),
        status: String(sale.status || 'completada') === 'anulada'
          ? 'cancelled'
          : 'completed',
        cancelReason: sale.cancelReason ? String(sale.cancelReason) : null,
        items: sale.items.map((item) => ({
          productId: String(item.productId || ''),
          productName: String(item.productName || 'Producto'),
          quantity: Number(item.quantity || 0),
          price: Number(item.price || 0),
          discount: Number(item.discount || 0),
          taxRate: Number(item.taxRate || 0),
          total: Number(item.total || 0),
        })),
        createdBy: uid,
        createdAt: admin.firestore.Timestamp.fromDate(createdAt),
        updatedAt: admin.firestore.Timestamp.fromDate(updatedAt),
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      invoiceNumbers[saleId] = invoiceNumber;
      written++;
    });
  }
  return {
    synced: written,
    saleIds: sales.map((sale) => String(sale.id)),
    invoiceNumbers,
  };
});

module.exports = { syncSales };

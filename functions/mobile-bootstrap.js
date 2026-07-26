'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

/**
 * Devuelve la configuración mínima que Flutter necesita para abrir offline
 * una empresa del POS ya sincronizada con Firebase. La relación se resuelve
 * exclusivamente desde users/{uid}; nunca se acepta un businessId enviado
 * por el cliente.
 */
const getMyCompanyBootstrap = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const db = admin.firestore();
  const userSnapshot = await db.collection('users').doc(uid).get();
  if (!userSnapshot.exists) {
    return { linked: false };
  }

  const user = userSnapshot.data() || {};
  if (user.isActive === false) {
    throw new HttpsError('permission-denied', 'Este usuario está inactivo.');
  }

  const businessId = String(user.businessId || '').trim();
  if (!businessId) {
    return { linked: false };
  }

  const businessRef = db.collection('businesses').doc(businessId);
  const [businessSnapshot, branchesSnapshot, registersSnapshot, productsSnapshot] = await Promise.all([
    businessRef.get(),
    businessRef.collection('branches').get(),
    businessRef.collection('cashRegisters').get(),
    businessRef.collection('products').get(),
  ]);

  if (!businessSnapshot.exists) {
    throw new HttpsError(
      'failed-precondition',
      'La cuenta está vinculada, pero la empresa todavía no terminó de sincronizarse con la nube.'
    );
  }

  const business = businessSnapshot.data() || {};
  const allowedBranches = Array.isArray(user.branchIds)
    ? new Set(user.branchIds.map((id) => String(id)))
    : null;
  let branches = branchesSnapshot.docs
    .filter((doc) => !allowedBranches || allowedBranches.size === 0 || allowedBranches.has(doc.id))
    .map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        name: String(data.name || data.nombre || 'Sucursal'),
        code: data.code || data.codigo || null,
        address: data.address || data.direccion || null,
        phone: data.phone || data.telefono || null,
      };
    });

  // Los perfiles de administradores antiguos pueden tener branchIds vacío.
  if (branches.length === 0 && !branchesSnapshot.empty) {
    branches = branchesSnapshot.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        name: String(data.name || data.nombre || 'Sucursal'),
        code: data.code || data.codigo || null,
        address: data.address || data.direccion || null,
        phone: data.phone || data.telefono || null,
      };
    });
  }

  const branchIds = new Set(branches.map((branch) => branch.id));
  const registers = registersSnapshot.docs
    .map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        branchId: String(data.branchId || ''),
        name: String(data.name || data.nombre || 'Caja'),
        code: data.code || data.codigo || null,
      };
    })
    .filter((register) => !register.branchId || branchIds.has(register.branchId));

  // El catálogo pertenece a la empresa. Un cajero puede vender productos
  // creados desde otra sucursal; el inventario por sucursal se mantiene
  // separado, pero nunca se debe entregar una pantalla de venta vacía.
  const products = productsSnapshot.docs
    .map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        name: String(data.name || data.nombre || '').trim(),
        sku: data.sku == null ? null : String(data.sku),
        barcode: data.barcode == null ? null : String(data.barcode),
        brand: data.brand == null ? null : String(data.brand),
        unit: String(data.unit || 'unidad'),
        cost: Number(data.cost || 0),
        price: Number(data.price || 0),
        taxRate: Number(data.taxRate ?? 0.18),
        taxIncluded: data.taxIncluded !== false,
        imageUrl: data.imageUrl || null,
        minStock: Number(data.minStock || 0),
        stock: Number(data.stock || 0),
        branchId: data.branchId == null ? null : String(data.branchId),
        isActive: data.isActive !== false,
      };
    })
    .filter((product) => product.name && product.isActive);

  return {
    linked: true,
    businessId,
    business: {
      name: String(business.name || business.nombreComercial || business.razonSocial || 'Mi negocio'),
      rnc: business.rnc || business.rncCedula || null,
      address: business.address || business.direccion || null,
      phone: business.phone || business.telefono || null,
      currency: String(business.currency || business.monedaPrincipal || 'DOP'),
      taxRate: Number(business.taxRate ?? business.tasaItbis ?? 0.18),
    },
    user: {
      uid,
      displayName: String(user.displayName || request.auth.token.name || user.email || 'Usuario'),
      email: String(user.email || request.auth.token.email || ''),
      role: String(user.role || 'employee'),
      posUserId: user.posUserId == null ? null : String(user.posUserId),
    },
    branches,
    registers,
    products,
  };
});

module.exports = { getMyCompanyBootstrap };

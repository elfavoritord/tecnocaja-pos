'use strict';

const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

/**
 * companies.js — Creación de empresa 100% móvil (cliente exclusivamente móvil).
 *
 * No depende de Tecno Caja POS Windows en absoluto: crea todo lo mínimo para
 * operar (empresa, dueño, sucursal, caja, ajustes, dispositivo, licencia de
 * prueba) en un solo batch atómico contra Firestore. Reusa el MISMO
 * `businesses/{businessId}` que ya usa Windows (ver firestore.rules) — no se
 * crea una colección "companies" aparte para evitar tener dos raíces de
 * negocio distintas. `businessId` es un UUID nuevo para instalaciones
 * exclusivamente móviles; para instalaciones vinculadas a Windows, el mismo
 * campo sigue siendo el `TECNO_CAJA_LICENSE_UID` que Windows ya usa hoy (ver
 * server.js:14565) — mismo esquema, dos orígenes posibles de la clave.
 *
 * "Almacén" y "lista de precios" no existen como entidades separadas en
 * ningún otro punto del sistema (ni Windows/MariaDB ni la app Flutter) — el
 * modelo real de este proyecto usa la sucursal como alcance de inventario
 * (`inventory_by_branch`/`inventario_sucursal`) y un solo precio por
 * producto. Para no inventar un subsistema que nada más lee, "almacén
 * principal" se modela como la sucursal principal, y "lista de precios
 * principal" como un documento de settings con el nombre de la lista y la
 * moneda/ITBIS por defecto.
 */

const ALL_MODULES = [
  'dashboard', 'productos', 'categorias', 'inventario', 'clientes', 'proveedores',
  'ventas', 'cotizaciones', 'facturas', 'devoluciones', 'caja', 'cuentasPorCobrar',
  'cuentasPorPagar', 'compras', 'reportes', 'usuarios', 'sucursales', 'cajas',
  'configuracion', 'configuracionFiscal', 'sincronizacion', 'auditoria',
  'respaldos', 'licencia',
];

const TRIAL_DAYS = 14;

function requireString(value, field, { min = 1, max = 200 } = {}) {
  const v = String(value ?? '').trim();
  if (v.length < min || v.length > max) {
    throw new HttpsError('invalid-argument', `Campo inválido o faltante: ${field}.`);
  }
  return v;
}

function isValidRncCedula(value) {
  return /^\d{9}$|^\d{11}$/.test(String(value || '').replace(/\D/g, ''));
}

const createMobileCompany = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Debes iniciar sesión antes de crear una empresa.');
  }

  const db = admin.firestore();

  // Evita que la misma identidad cree una segunda empresa por accidente
  // (doble tap, reintento de red) — ver Fase 0/1 del plan de sincronización.
  const existingUser = await db.collection('users').doc(uid).get();
  if (existingUser.exists && existingUser.data()?.businessId) {
    throw new HttpsError(
      'already-exists',
      'Esta cuenta ya está vinculada a una empresa. Usa "Conectar con Tecno Caja POS" o cierra sesión para crear otra cuenta.'
    );
  }

  const d = request.data || {};

  const ownerNombre = requireString(d.ownerNombre, 'nombre del propietario');
  const ownerApellido = requireString(d.ownerApellido, 'apellido del propietario');
  const email = requireString(d.email, 'correo electrónico').toLowerCase();
  const telefono = requireString(d.telefono, 'teléfono');
  const nombreComercial = requireString(d.nombreComercial, 'nombre comercial');
  const razonSocial = requireString(d.razonSocial, 'razón social');
  const rncCedula = requireString(d.rncCedula, 'RNC o cédula');
  const direccion = requireString(d.direccion, 'dirección');
  const provincia = requireString(d.provincia, 'provincia');
  const municipio = requireString(d.municipio, 'municipio');
  const tipoNegocio = requireString(d.tipoNegocio, 'tipo de negocio');
  const monedaPrincipal = requireString(d.monedaPrincipal, 'moneda principal', { max: 10 });
  const tasaItbis = Number.isFinite(Number(d.tasaItbis)) ? Number(d.tasaItbis) : 0.18;
  const usaComprobantesFiscales = Boolean(d.usaComprobantesFiscales);
  const logoUrl = d.logoUrl ? String(d.logoUrl).trim() : null;
  const deviceId = requireString(d.deviceId, 'identificador del dispositivo');
  const deviceName = d.deviceName ? String(d.deviceName).trim() : null;
  const platform = d.platform ? String(d.platform).trim() : 'android';

  if (usaComprobantesFiscales && !isValidRncCedula(rncCedula)) {
    throw new HttpsError(
      'invalid-argument',
      'El RNC/cédula no tiene un formato válido (9 u 11 dígitos) — requerido para emitir comprobantes fiscales.'
    );
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const nowDate = new Date();
  const businessId = crypto.randomUUID();
  const branchId = crypto.randomUUID();
  const registerId = crypto.randomUUID();
  const trialEndsAt = new Date(nowDate.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  const allowedModules = ALL_MODULES;
  const branchIds = [branchId];

  const businessRef = db.collection('businesses').doc(businessId);
  const batch = db.batch();

  // Raíz de la empresa — perfil legal/comercial. Antes de esto ningún código
  // del proyecto escribe este documento (Windows solo escribe subcolecciones),
  // así que no hay riesgo de colisión con datos existentes.
  batch.set(businessRef, {
    businessId,
    ownerUid: uid,
    ownerNombre,
    ownerApellido,
    email,
    telefono,
    nombreComercial,
    razonSocial,
    rncCedula,
    direccion,
    provincia,
    municipio,
    tipoNegocio,
    monedaPrincipal,
    tasaItbis,
    usaComprobantesFiscales,
    logoUrl,
    source: 'mobile',
    planType: 'mobile_only',
    legacyLicenseUid: null,
    createdAt: now,
    createdBy: uid,
  });

  // Perfil de usuario espejo dentro del negocio (mismo shape que
  // modules/firebase-admin.js syncStaffToReportsApp escribe para Windows).
  batch.set(businessRef.collection('users').doc(uid), {
    displayName: `${ownerNombre} ${ownerApellido}`.trim(),
    email,
    role: 'businessOwner',
    isActive: true,
    businessId,
    businessIds: [businessId],
    branchIds,
    allowedModules,
    posRole: null,
    posUserId: null,
    source: 'mobile',
    createdAt: now,
    updatedAt: now,
  });

  // Perfil top-level /users/{uid} — es el que las reglas de Firestore leen
  // (función me() en firestore.rules) para resolver businessId/rol.
  batch.set(db.collection('users').doc(uid), {
    displayName: `${ownerNombre} ${ownerApellido}`.trim(),
    email,
    role: 'businessOwner',
    isActive: true,
    businessId,
    businessIds: [businessId],
    branchIds,
    allowedModules,
    source: 'mobile',
    createdAt: now,
    updatedAt: now,
  });

  // Sucursal principal (hace también de "almacén principal" — ver nota arriba).
  batch.set(businessRef.collection('branches').doc(branchId), {
    branchId,
    businessId,
    nombre: 'Sucursal Principal',
    codigo: 'SUC-001',
    direccion,
    telefono,
    activa: true,
    createdAt: now,
    createdBy: uid,
  });

  // Caja principal.
  batch.set(businessRef.collection('cashRegisters').doc(registerId), {
    registerId,
    businessId,
    branchId,
    nombre: 'Caja Principal',
    codigo: 'CAJA-001',
    activa: true,
    createdAt: now,
    createdBy: uid,
  });

  // Configuración comercial ("lista de precios principal" = precio único por
  // producto bajo esta moneda, no hay subsistema de listas múltiples hoy).
  batch.set(businessRef.collection('settings').doc('comercial'), {
    listaPrecioPrincipal: 'General',
    monedaPrincipal,
    tasaItbis,
    redondeoActivo: false,
    redondeoPaso: 1.0,
    updatedAt: now,
    updatedBy: uid,
  });

  // Configuración fiscal inicial — conservadora a propósito: e-CF nunca
  // arranca activo, requiere pasar el asistente de configuración fiscal
  // (certificado, secuencias autorizadas, prueba de firma) antes de emitir.
  batch.set(businessRef.collection('settings').doc('fiscal'), {
    usaComprobantesFiscales,
    modoComprobante: usaComprobantesFiscales ? 'ncf_tradicional' : 'sin_comprobantes',
    eCfActivo: false,
    eCfValidado: false,
    ambiente: 'certificacion',
    updatedAt: now,
    updatedBy: uid,
  });

  // Dispositivo que crea la empresa queda autorizado de una vez.
  batch.set(businessRef.collection('devices').doc(deviceId), {
    deviceId,
    businessId,
    ownerUid: uid,
    deviceName,
    platform,
    linkedAt: now,
    revokedAt: null,
  });

  // Licencia de prueba — mismo vocabulario de estados que
  // server/licensing/license-service.js (trial/active/expired/suspended),
  // para que si esta empresa más adelante instala Windows, el POS pueda
  // reconocer y extender la MISMA licencia en vez de crear otra.
  batch.set(db.collection('licencias').doc(businessId), {
    licenseUid: businessId,
    businessId,
    planCode: 'mobile_trial',
    status: 'trial',
    trialEndsAt,
    maxUsers: 3,
    maxDevices: 3,
    maxBranches: 1,
    modules: allowedModules,
    source: 'mobile',
    createdAt: now,
  });

  await batch.commit();

  return {
    businessId,
    branchId,
    registerId,
    trialEndsAt: trialEndsAt.toISOString(),
  };
});

module.exports = { createMobileCompany };

'use strict';

// Firestore del proyecto de Tecno Caja (el mismo del POS y del gateway e-CF).
// En Cloud Run usa la cuenta de servicio del servicio (Application Default
// Credentials). Las pruebas inyectan un Firestore en memoria.

let singleton = null;

function createFirestoreBackend() {
  // firebase-admin v13+: API modular.
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  const existing = getApps();
  const app = existing.length
    ? existing[0]
    : initializeApp({ projectId: process.env.FIRESTORE_PROJECT_ID || 'reporte-sistema-pos' });
  return { db: getFirestore(app), FieldValue };
}

function getBackend() {
  if (!singleton) singleton = createFirestoreBackend();
  return singleton;
}

module.exports = { getBackend, createFirestoreBackend };

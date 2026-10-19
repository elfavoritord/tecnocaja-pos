'use strict';

// Firestore del proyecto de Tecno Caja (el mismo del POS, la tienda y el
// gateway e-CF). En Cloud Run usa la cuenta de servicio del servicio
// (Application Default Credentials): el POS nunca tiene esta llave.

let singleton = null;

function createFirestoreBackend() {
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const { getAuth } = require('firebase-admin/auth');
  const existing = getApps();
  const app = existing.length
    ? existing[0]
    : initializeApp({ projectId: process.env.FIRESTORE_PROJECT_ID || 'reporte-sistema-pos' });
  return {
    db: getFirestore(app),
    // Cuenta del dueño (asistente de una PC de sucursal). `true`: una sesión
    // cerrada a la fuerza (cambio de contraseña) ya no vale.
    verificarIdToken: (idToken) => getAuth(app).verifyIdToken(idToken, true),
  };
}

function getBackend() {
  if (!singleton) singleton = createFirestoreBackend();
  return singleton;
}

module.exports = { getBackend, createFirestoreBackend };

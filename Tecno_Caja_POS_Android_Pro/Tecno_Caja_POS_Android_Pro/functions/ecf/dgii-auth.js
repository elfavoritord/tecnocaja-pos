'use strict';

/**
 * Autenticación DGII (semilla -> firma -> token), con caché en Firestore
 * (`privateFiscal/dgiiToken`, misma partición ya bloqueada por
 * `allow read,write: if false` que el certificado) porque las instancias de
 * Cloud Functions v2 son efímeras -- cachear solo en memoria de proceso no
 * es confiable, y pedir token nuevo en cada factura duplicaría llamadas a
 * DGII innecesariamente.
 */

const admin = require('firebase-admin');
const { resolveEnvironmentConfig } = require('./config');
const dgiiClient = require('./dgii-client');
const { signXml } = require('./signing');

const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

function tokenRef(db, businessId) {
  return db.collection('businesses').doc(businessId).collection('privateFiscal').doc('dgiiToken');
}

async function getAuthToken(db, businessId, certificate, ambiente) {
  const { dgiiEnvKey, semillaUrl, validarSemillaUrl } = resolveEnvironmentConfig(ambiente);
  const ref = tokenRef(db, businessId);
  const snap = await ref.get();
  if (snap.exists) {
    const data = snap.data();
    const expiraEn = data.expiraEn?.toDate ? data.expiraEn.toDate() : new Date(data.expiraEn || 0);
    if (data.dgiiEnvKey === dgiiEnvKey && data.token && expiraEn.getTime() - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return data.token;
    }
  }

  const seed = await dgiiClient.getSeed(semillaUrl);
  if (!String(seed?.xml || '').trim()) {
    throw new Error('DGII no devolvió una semilla válida.');
  }
  const signedSeed = signXml(seed.xml, certificate);
  const auth = await dgiiClient.validateSeed(validarSemillaUrl, signedSeed);
  if (!auth.token) {
    throw new Error(`DGII no devolvió un token de autenticación (HTTP ${auth.httpStatus}).`);
  }

  const issuedAt = auth.expedido ? new Date(auth.expedido) : new Date();
  const expiresAt = auth.expira ? new Date(auth.expira) : new Date(Date.now() + 3600 * 1000);

  await ref.set({
    token: auth.token,
    dgiiEnvKey,
    issuedAt: admin.firestore.Timestamp.fromDate(issuedAt),
    expiraEn: admin.firestore.Timestamp.fromDate(expiresAt),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return auth.token;
}

module.exports = { getAuthToken };

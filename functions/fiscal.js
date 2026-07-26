'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

/**
 * fiscal.js — Servicio fiscal central: único árbitro de NCF/e-CF.
 *
 * Puerto a Firestore del mismo patrón ya usado y probado en
 * server.js:getNextNcfFromSequence (lock + tope máximo + increment atómico) y
 * modules/ecf/models/ecf.repository.js (misma idea para e-CF). La garantía
 * de "nunca dos NCF iguales" viene de que TODO pasa por una transacción de
 * Firestore sobre el mismo documento contador — Firestore reintenta la
 * transacción completa si detecta una escritura concurrente en esos
 * documentos, así que dos llamadas simultáneas nunca leen el mismo número.
 *
 * IMPORTANTE — alcance real de esta primera versión: `requestNcf` solo
 * RESERVA el número de comprobante de forma atómica y a prueba de
 * duplicados. NO genera el XML, NO firma con el certificado digital, NO
 * envía a la DGII ni genera el QR — esa parte (`signAndSend`, portada de
 * `modules/ecf/`) depende de tener un certificado .p12 real cargado en
 * Secret Manager, que todavía no existe en este proyecto (ver plan). Por eso
 * un NCF tradicional (`usaComprobantesFiscales` sin e-CF) queda en estado
 * ASIGNADO (ya es válido para imprimir, no requiere firma/envío), pero un
 * e-CF queda en PENDIENTE_FIRMA — asignado y reservado, pero todavía no es
 * un comprobante fiscal electrónico aceptado. No inventar lo contrario.
 */

const ESTADOS = {
  BORRADOR: 'BORRADOR',
  PENDIENTE_FISCAL: 'PENDIENTE_FISCAL',
  ASIGNADO: 'ASIGNADO', // NCF tradicional: el número YA es el comprobante final.
  PENDIENTE_FIRMA: 'PENDIENTE_FIRMA', // e-CF: numerado, falta firmar+enviar (no implementado aún).
  ERROR_FISCAL: 'ERROR_FISCAL',
};

const E_CF_TYPES = new Set(['E31', 'E32', 'E33', 'E34', 'E41', 'E43', 'E44', 'E45']);

async function loadCallerProfile(db, uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return null;
  return snap.data();
}

function assertBelongsToBusiness(profile, businessId) {
  if (!profile) {
    throw new HttpsError('permission-denied', 'No tienes un perfil de usuario asociado a ninguna empresa.');
  }
  const ids = profile.businessIds || (profile.businessId ? [profile.businessId] : []);
  if (!ids.includes(businessId)) {
    throw new HttpsError('permission-denied', 'No perteneces a esta empresa.');
  }
}

function isOwnerOrAdmin(profile) {
  const role = String(profile?.role || '');
  return ['superadmin', 'businessOwner', 'admin', 'administrador', 'Administrador', 'Administrador General']
    .includes(role);
}

/**
 * requestNcf — reserva atómica de un NCF/e-CF para una venta.
 * Input: { businessId, branchId, saleId, ncfType, ambiente }
 *   - saleId es el sale_uuid, doc id bajo businesses/{businessId}/sales/{saleId}.
 *   - ambiente: 'certificacion' | 'produccion' (secuencias separadas, nunca se mezclan).
 */
const requestNcf = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const db = admin.firestore();
  const d = request.data || {};
  const businessId = String(d.businessId || '').trim();
  const branchId = String(d.branchId || '').trim();
  const saleId = String(d.saleId || '').trim();
  const ncfType = String(d.ncfType || '').trim().toUpperCase();
  const ambiente = String(d.ambiente || 'certificacion').trim().toLowerCase();

  if (!businessId || !saleId || !ncfType) {
    throw new HttpsError('invalid-argument', 'Faltan businessId, saleId o ncfType.');
  }
  if (!['certificacion', 'produccion'].includes(ambiente)) {
    throw new HttpsError('invalid-argument', 'ambiente debe ser "certificacion" o "produccion".');
  }

  const profile = await loadCallerProfile(db, uid);
  assertBelongsToBusiness(profile, businessId);

  const businessRef = db.collection('businesses').doc(businessId);
  const saleRef = businessRef.collection('sales').doc(saleId);
  const sequenceRef = businessRef.collection('ncfSequences').doc(`${ncfType}_${ambiente}`);
  const fiscalSettingsRef = businessRef.collection('settings').doc('fiscal');

  const fiscalSettingsSnap = await fiscalSettingsRef.get();
  const fiscalSettings = fiscalSettingsSnap.exists ? fiscalSettingsSnap.data() : {};
  if (!fiscalSettings.usaComprobantesFiscales) {
    throw new HttpsError(
      'failed-precondition',
      'Esta empresa no tiene comprobantes fiscales activados (Configuración fiscal).'
    );
  }
  const esECF = E_CF_TYPES.has(ncfType);
  if (esECF && !fiscalSettings.eCfValidado) {
    throw new HttpsError(
      'failed-precondition',
      'La facturación electrónica (e-CF) todavía no fue validada para esta empresa — completa el asistente de configuración fiscal primero.'
    );
  }

  return db.runTransaction(async (tx) => {
    // Idempotencia: si esta venta ya tiene NCF asignado (reintento de red,
    // doble tap, replay de la cola de sync), se devuelve el mismo, nunca se
    // genera un segundo.
    const saleSnap = await tx.get(saleRef);
    if (!saleSnap.exists) {
      throw new HttpsError('not-found', 'La venta no existe en el servidor todavía — sincronízala antes de pedir NCF.');
    }
    const saleData = saleSnap.data();
    if (saleData.ncf) {
      return { ncf: saleData.ncf, estadoFiscal: saleData.estadoFiscal, reused: true };
    }

    const seqSnap = await tx.get(sequenceRef);
    if (!seqSnap.exists) {
      throw new HttpsError(
        'failed-precondition',
        `No hay secuencia configurada para ${ncfType} (${ambiente}). Un administrador debe configurarla primero.`
      );
    }
    const seq = seqSnap.data();
    if (!seq.activa) {
      throw new HttpsError('failed-precondition', `La secuencia ${ncfType} (${ambiente}) está inactiva.`);
    }
    if (seq.siguienteNumero > seq.maximo) {
      throw new HttpsError(
        'resource-exhausted',
        `La secuencia ${ncfType} (${ambiente}) alcanzó su límite (${seq.maximo}). Solicita un nuevo rango a la DGII.`
      );
    }

    const ncfNumber = seq.siguienteNumero;
    const ncf = `${ncfType}${String(ncfNumber).padStart(8, '0')}`;
    const estadoFiscal = esECF ? ESTADOS.PENDIENTE_FIRMA : ESTADOS.ASIGNADO;
    const now = admin.firestore.FieldValue.serverTimestamp();

    tx.update(sequenceRef, {
      siguienteNumero: admin.firestore.FieldValue.increment(1),
      updatedAt: now,
    });
    tx.update(saleRef, {
      ncf,
      ncfType,
      ambiente,
      estadoFiscal,
      ncfAssignedAt: now,
      ncfAssignedBy: uid,
    });

    return { ncf, estadoFiscal, reused: false };
  });
});

/**
 * configureNcfSequence — alta/edición de una secuencia autorizada por la
 * DGII. Solo dueño/admin. Sin esto `requestNcf` nunca tiene de dónde asignar
 * (a propósito: nadie más que un administrador humano puede inventar un
 * rango autorizado).
 */
const configureNcfSequence = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const db = admin.firestore();
  const d = request.data || {};
  const businessId = String(d.businessId || '').trim();
  const ncfType = String(d.ncfType || '').trim().toUpperCase();
  const ambiente = String(d.ambiente || 'certificacion').trim().toLowerCase();
  const desde = Number(d.desde);
  const maximo = Number(d.maximo);

  if (!businessId || !ncfType || !Number.isFinite(desde) || !Number.isFinite(maximo) || desde < 1 || maximo < desde) {
    throw new HttpsError('invalid-argument', 'businessId, ncfType, desde y maximo (desde <= maximo) son requeridos.');
  }

  const profile = await loadCallerProfile(db, uid);
  assertBelongsToBusiness(profile, businessId);
  if (!isOwnerOrAdmin(profile)) {
    throw new HttpsError('permission-denied', 'Solo un administrador puede configurar secuencias fiscales.');
  }

  const sequenceRef = db
    .collection('businesses').doc(businessId)
    .collection('ncfSequences').doc(`${ncfType}_${ambiente}`);

  const now = admin.firestore.FieldValue.serverTimestamp();
  await sequenceRef.set({
    ncfType,
    ambiente,
    siguienteNumero: desde,
    maximo,
    activa: true,
    updatedAt: now,
    updatedBy: uid,
  }, { merge: true });

  return { ok: true };
});

module.exports = { requestNcf, configureNcfSequence, ESTADOS };

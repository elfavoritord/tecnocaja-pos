'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

async function assertOperationalLicense(db, businessId) {
  const licenseDoc = await db.collection('licencias').doc(businessId).get();
  if (!licenseDoc.exists) {
    throw new HttpsError('failed-precondition', 'La empresa no tiene una licencia válida.');
  }
  const license = licenseDoc.data() || {};
  const status = String(license.status || 'expired').toLowerCase();
  const now = new Date();
  const trialEndsAt = license.trialEndsAt?.toDate?.();
  const expiresAt = (license.expiresAt || license.expirationDate)?.toDate?.();
  const expiredByDate =
    (status === 'trial' && trialEndsAt && trialEndsAt <= now) ||
    (status === 'active' && expiresAt && expiresAt <= now);
  if (expiredByDate || status === 'expired' || status === 'suspended') {
    throw new HttpsError(
      'failed-precondition',
      status === 'suspended' ? 'La licencia está suspendida.' : 'La licencia está expirada.'
    );
  }
}

const acquireCashRegister = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const registerId = String(request.data?.registerId || '').trim();
  const deviceId = String(request.data?.deviceId || '').trim();
  const openingAmount = Number(request.data?.openingAmount || 0);
  if (!registerId || !deviceId || !Number.isFinite(openingAmount)) {
    throw new HttpsError('invalid-argument', 'Caja, dispositivo y monto son obligatorios.');
  }

  const db = admin.firestore();
  const profileDoc = await db.collection('users').doc(uid).get();
  const profile = profileDoc.data() || {};
  const businessId = String(profile.businessId || '').trim();
  if (!profileDoc.exists || profile.isActive === false || !businessId) {
    throw new HttpsError('permission-denied', 'Tu cuenta no tiene una empresa activa.');
  }
  await assertOperationalLicense(db, businessId);

  const lockRef = db.collection('businesses').doc(businessId)
    .collection('cashRegisterLocks').doc(registerId);
  await db.runTransaction(async (transaction) => {
    const currentDoc = await transaction.get(lockRef);
    const current = currentDoc.data() || {};
    if (currentDoc.exists && current.status === 'open') {
      // El mismo usuario puede recuperar su propio turno cuando cambió el
      // identificador local (limpieza del navegador, reinstalación o cambio
      // de equipo). No crea otra caja: transfiere la reserva existente.
      if (current.userUid === uid) {
        transaction.set(lockRef, {
          ...current,
          deviceId,
          resumedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return;
      }
      throw new HttpsError(
        'already-exists',
        `Esta caja ya está abierta por ${current.userName || 'otro usuario'}.`
      );
    }
    transaction.set(lockRef, {
      status: 'open',
      businessId,
      registerId,
      userUid: uid,
      userName: profile.displayName || profile.email || 'Usuario',
      deviceId,
      openingAmount,
      openedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  return { acquired: true, businessId, registerId };
});

const releaseCashRegister = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');
  const registerId = String(request.data?.registerId || '').trim();
  if (!registerId) throw new HttpsError('invalid-argument', 'La caja es obligatoria.');

  const db = admin.firestore();
  const profileDoc = await db.collection('users').doc(uid).get();
  const profile = profileDoc.data() || {};
  const businessId = String(profile.businessId || '').trim();
  const adminRoles = new Set([
    'superadmin', 'owner', 'businessOwner', 'business_owner',
    'admin', 'administrador', 'administradorGeneral',
    'administrador_general',
    'Administrador', 'Administrador General', 'branchAdmin', 'branch_admin',
  ]);
  const locksCollection = db.collection('businesses').doc(businessId)
    .collection('cashRegisterLocks');
  const locksSnapshot = await locksCollection.get();
  // Además del ID solicitado se incluyen todos los turnos abiertos por este
  // usuario. Esto limpia reservas huérfanas creadas con un ID local anterior
  // cuando la caja recibió después su remoto_id.
  const candidateRefs = new Map();
  candidateRefs.set(registerId, locksCollection.doc(registerId));
  for (const document of locksSnapshot.docs) {
    const lock = document.data() || {};
    if (lock.status === 'open' && lock.userUid === uid) {
      candidateRefs.set(document.id, document.ref);
    }
  }
  const closedRegisterIds = [];
  await db.runTransaction(async (transaction) => {
    const documents = [];
    for (const ref of candidateRefs.values()) {
      documents.push(await transaction.get(ref));
    }
    for (const lockDoc of documents) {
      if (!lockDoc.exists || lockDoc.data()?.status !== 'open') continue;
      const lock = lockDoc.data();
      if (lock.userUid !== uid && !adminRoles.has(String(profile.role || ''))) {
        throw new HttpsError(
          'permission-denied',
          'Solo quien abrió la caja o un administrador puede cerrarla.'
        );
      }
      transaction.set(lockDoc.ref, {
        ...lock,
        status: 'closed',
        closedBy: uid,
        closedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      closedRegisterIds.push(lockDoc.id);
    }
  });
  return {
    released: true,
    registerId,
    closedRegisterIds,
    closedCount: closedRegisterIds.length,
  };
});

const getMyOpenCashRegister = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const db = admin.firestore();
  const profileDoc = await db.collection('users').doc(uid).get();
  const profile = profileDoc.data() || {};
  const businessId = String(profile.businessId || '').trim();
  if (!profileDoc.exists || profile.isActive === false || !businessId) {
    throw new HttpsError('permission-denied', 'Tu cuenta no tiene una empresa activa.');
  }

  // Son pocas cajas por empresa. Leer la colección evita requerir un índice
  // compuesto y permite recuperar el turno incluso tras limpiar el navegador.
  const snapshot = await db.collection('businesses').doc(businessId)
    .collection('cashRegisterLocks').get();
  const document = snapshot.docs.find((doc) => {
    const lock = doc.data() || {};
    return lock.status === 'open' && lock.userUid === uid;
  });
  if (!document) return { open: false, businessId };

  const lock = document.data() || {};
  return {
    open: true,
    businessId,
    registerId: String(lock.registerId || document.id),
    openingAmount: Number(lock.openingAmount || 0),
    openedAt: lock.openedAt?.toDate?.().toISOString() || null,
    userName: String(lock.userName || profile.displayName || profile.email || 'Usuario'),
    deviceId: String(lock.deviceId || ''),
  };
});

module.exports = {
  acquireCashRegister,
  releaseCashRegister,
  getMyOpenCashRegister,
};

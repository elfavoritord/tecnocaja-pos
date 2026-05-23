/**
 * firebase-identity.js
 *
 * Gestión de identidades Firebase para Tecno Caja:
 *  - Numeración secuencial de usuarios (pos_user_1, pos_user_2 …)
 *  - Deduplicación por email o localUserId
 *  - Migración de documentos de licencia con ID hash legado → ID canónico legible
 */

'use strict';

/**
 * Incrementa atómicamente el contador de usuarios del negocio en Firestore.
 * Path: businesses/{businessId}/counters/users → { userCounter: N }
 * @returns {Promise<number>} El siguiente número disponible
 */
async function getNextUserNumber(firestore, businessId) {
  const counterRef = firestore
    .collection('businesses')
    .doc(businessId)
    .collection('counters')
    .doc('users');

  return firestore.runTransaction(async (t) => {
    const doc = await t.get(counterRef);
    const current = doc.exists ? (doc.data().userCounter || 0) : 0;
    const next = current + 1;
    t.set(counterRef, { userCounter: next, updatedAt: new Date() }, { merge: true });
    return next;
  });
}

/**
 * Actualiza el contador de usuarios al valor máximo existente en Firestore.
 * Se llama al final de syncPosAccountsToFirestore para que el contador
 * refleje exactamente cuántos usuarios pos_user_N ya existen.
 *
 * @param {FirebaseFirestore.Firestore} firestore
 * @param {string} businessId  - ID canónico del negocio (pos:tecno-caja-nombre)
 * @param {FirebaseFirestore.CollectionReference} usersCollection
 */
async function syncUserCounter(firestore, businessId, usersCollection) {
  try {
    const snapshot = await usersCollection
      .where('businessKey', '==', businessId)
      .where('source', '==', 'pos')
      .get();

    let maxNum = 0;
    for (const doc of snapshot.docs) {
      const match = doc.id.match(/^pos_user_(\d+)$/);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }

    if (maxNum === 0) return;

    const counterRef = firestore
      .collection('businesses')
      .doc(businessId)
      .collection('counters')
      .doc('users');

    const existing = await counterRef.get();
    const current = existing.exists ? (existing.data().userCounter || 0) : 0;

    if (current < maxNum) {
      await counterRef.set({ userCounter: maxNum, updatedAt: new Date() }, { merge: true });
      console.log(`[firebase-identity] Contador usuarios actualizado: ${current} → ${maxNum} (businessId: ${businessId})`);
    }
  } catch (err) {
    console.warn('[firebase-identity] No se pudo actualizar el contador de usuarios:', err.message);
  }
}

/**
 * Busca el doc ID de Firestore que corresponde a un usuario del POS.
 *
 * Orden de búsqueda:
 *  1. pos_user_{localUserId}  (mapeo directo, el más común)
 *  2. Cualquier doc con el mismo email y businessKey
 *
 * Si no existe ninguno devuelve null (el llamador creará pos_user_{localId}).
 *
 * @param {FirebaseFirestore.CollectionReference} usersCollection
 * @param {string} businessId
 * @param {{ email: string, localUserId: string|number }} opts
 * @returns {Promise<string|null>}
 */
async function findExistingUserDocId(usersCollection, businessId, { email, localUserId }) {
  // 1. Prueba el mapeo directo
  if (localUserId) {
    const candidateId = `pos_user_${localUserId}`;
    const doc = await usersCollection.doc(candidateId).get();
    if (doc.exists) return candidateId;
  }

  // 2. Busca por email + businessKey (detecta docs huérfanos con otro ID)
  if (email) {
    const normalizedEmail = String(email).trim().toLowerCase();
    const snapshot = await usersCollection
      .where('emailNormalized', '==', normalizedEmail)
      .where('businessKey', '==', businessId)
      .limit(1)
      .get();
    if (!snapshot.empty) return snapshot.docs[0].id;
  }

  return null;
}

/**
 * Determina el ID de documento de Firestore para un usuario.
 * Primero intenta reutilizar un doc existente; si no existe, usa pos_user_{localId}.
 * El localId del POS es auto-incremental desde 1, así que los IDs resultantes
 * son naturalmente secuenciales sin necesidad de un contador separado.
 *
 * @param {FirebaseFirestore.CollectionReference} usersCollection
 * @param {string} businessId
 * @param {{ email: string, localUserId: string|number }} opts
 * @returns {Promise<string>}
 */
async function resolveUserDocId(usersCollection, businessId, { email, localUserId }) {
  const existing = await findExistingUserDocId(usersCollection, businessId, { email, localUserId });
  if (existing) return existing;
  // Fallback: usar el ID local (siempre disponible, ya es secuencial)
  return `pos_user_${localUserId}`;
}

/**
 * Migra un documento de licencia desde el ID hash legado al ID canónico legible.
 *
 * - Si el doc legado no existe: no hace nada.
 * - Si el doc canónico no existe: copia los datos del legado y lo elimina.
 * - Si ambos existen: elimina el legado (el canónico ya tiene los datos correctos).
 *
 * @param {FirebaseFirestore.CollectionReference} licensesCollection
 * @param {string} legacyDocId  - Ej: "pos_b606ab549250"
 * @param {string} canonicalId  - Ej: "pos:tecno-caja-colmado-juan"
 * @returns {Promise<void>}
 */
async function migrateLegacyLicenseDoc(licensesCollection, legacyDocId, canonicalId) {
  if (!legacyDocId || legacyDocId === canonicalId) return;

  try {
    const [legacyDoc, canonicalDoc] = await Promise.all([
      licensesCollection.doc(legacyDocId).get(),
      licensesCollection.doc(canonicalId).get(),
    ]);

    if (!legacyDoc.exists) return; // Nada que migrar

    if (!canonicalDoc.exists) {
      // Copiar datos al doc canónico con los campos de identidad actualizados
      const legacyData = legacyDoc.data();
      await licensesCollection.doc(canonicalId).set({
        ...legacyData,
        licenseId:       canonicalId,
        principalUid:    canonicalId,
        migratedFromId:  legacyDocId,
        migratedAt:      new Date(),
      });
      console.log(`[firebase-identity] Licencia copiada: ${legacyDocId} → ${canonicalId}`);
    }

    // Eliminar doc legado
    await licensesCollection.doc(legacyDocId).delete();
    console.log(`[firebase-identity] Doc legado eliminado: ${legacyDocId}`);
  } catch (err) {
    console.warn(`[firebase-identity] No se pudo migrar licencia ${legacyDocId} → ${canonicalId}:`, err.message);
  }
}

/**
 * Elimina documentos de usuario duplicados en Firestore que tienen el mismo email
 * pero un ID diferente al canonical (pos_user_{localId}).
 *
 * Se llama al final de syncPosAccountsToFirestore para limpiar docs huérfanos.
 *
 * @param {FirebaseFirestore.CollectionReference} usersCollection
 * @param {string} businessId
 * @param {Set<string>} desiredDocIds - IDs que deben mantenerse
 * @returns {Promise<number>} Cantidad de docs eliminados
 */
async function cleanupOrphanUserDocs(usersCollection, businessId, desiredDocIds) {
  let deleted = 0;
  try {
    const snapshot = await usersCollection
      .where('businessKey', '==', businessId)
      .where('source', '==', 'pos')
      .get();

    const batch = usersCollection.firestore.batch();
    for (const doc of snapshot.docs) {
      if (!desiredDocIds.has(doc.id)) {
        batch.delete(doc.ref);
        deleted++;
      }
    }
    if (deleted > 0) {
      await batch.commit();
      console.log(`[firebase-identity] ${deleted} docs de usuario huérfanos eliminados.`);
    }
  } catch (err) {
    console.warn('[firebase-identity] Error limpiando docs huérfanos:', err.message);
  }
  return deleted;
}

module.exports = {
  getNextUserNumber,
  syncUserCounter,
  resolveUserDocId,
  findExistingUserDocId,
  migrateLegacyLicenseDoc,
  cleanupOrphanUserDocs,
};

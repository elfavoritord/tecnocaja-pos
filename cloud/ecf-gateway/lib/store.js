'use strict';

// Almacén de documentos recibidos. En producción usa Firestore (proyecto
// reporte-sistema-pos, ya activo para Tecno Caja). En tests usa memoria para
// no depender de credenciales GCP.

function createMemoryStore() {
  const collections = new Map();

  function collection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  return {
    async findByKey(collectionName, key) {
      return collection(collectionName).get(key) || null;
    },
    async save(collectionName, key, doc) {
      collection(collectionName).set(key, doc);
      return doc;
    },
    async list(collectionName, { limit = 50 } = {}) {
      const docs = Array.from(collection(collectionName).values());
      docs.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
      return docs.slice(0, limit);
    },
  };
}

function createFirestoreStore() {
  // firebase-admin v13+ ya no expone admin.apps/admin.firestore() en el
  // export por defecto — hay que usar la API modular.
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const existing = getApps();
  const app = existing.length
    ? existing[0]
    : initializeApp({ projectId: process.env.FIRESTORE_PROJECT_ID || 'reporte-sistema-pos' });
  const db = getFirestore(app);

  return {
    async findByKey(collectionName, key) {
      const snap = await db.collection(collectionName).doc(key).get();
      return snap.exists ? snap.data() : null;
    },
    async save(collectionName, key, doc) {
      await db.collection(collectionName).doc(key).set(doc);
      return doc;
    },
    async list(collectionName, { limit = 50 } = {}) {
      const snap = await db
        .collection(collectionName)
        .orderBy('receivedAt', 'desc')
        .limit(limit)
        .get();
      return snap.docs.map((d) => d.data());
    },
  };
}

let singleton = null;

function getStore() {
  if (singleton) return singleton;
  singleton = process.env.NODE_ENV === 'test' ? createMemoryStore() : createFirestoreStore();
  return singleton;
}

module.exports = { getStore, createMemoryStore, createFirestoreStore };

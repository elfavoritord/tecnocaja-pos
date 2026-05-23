/**
 * scripts/check-firebase-sync.js
 *
 * Smoke test para verificar la conexión Firebase y el estado de la cola.
 * Correr con:
 *   node scripts/check-firebase-sync.js
 *
 * Carga .env automáticamente, verifica DNS, intenta inicializar Firebase
 * Admin con la credencial configurada y reporta el estado de la cola.
 * No modifica datos.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const dns = require('dns').promises;

const PROBE = 'firestore.googleapis.com';

async function checkInternet() {
  try {
    const r = await dns.lookup(PROBE);
    return { ok: true, ip: r.address };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkFirebaseAdmin() {
  try {
    const fb = require('../modules/firebase-admin');
    const firestore = fb.getFirestore();
    // Hacer un read trivial para confirmar credencial válida.
    // OJO: Firestore reserva nombres con doble underscore — usar uno normal.
    const snap = await firestore.collection('healthcheck').limit(1).get();
    // Además leemos el projectId real con el que el SDK se autenticó (puede
    // diferir de FIREBASE_PROJECT_ID si la key apunta a otro proyecto).
    let actualProjectId = '(desconocido)';
    try {
      const app = require('firebase-admin').app();
      actualProjectId = app.options.credential?.projectId || app.options.projectId || actualProjectId;
    } catch (_) {}
    return {
      ok: true,
      projectIdEnv: process.env.FIREBASE_PROJECT_ID,
      projectIdInUse: actualProjectId,
      docsRead: snap.size,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkQueue() {
  try {
    const { FirebaseSyncQueue } = require('../server/sync/firebase-sync-queue');
    await FirebaseSyncQueue.init();
    const stats = await FirebaseSyncQueue.getStats();
    return { ok: true, stats };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

(async () => {
  console.log('=== Tecno Caja Firebase Sync Healthcheck ===\n');

  console.log('Variables relevantes:');
  console.log('  FIREBASE_PROJECT_ID         =', process.env.FIREBASE_PROJECT_ID || '(vacío)');
  console.log('  FIREBASE_SERVICE_ACCOUNT_PATH=', process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '(vacío)');
  console.log('  FIREBASE_SERVICE_ACCOUNT_JSON=', process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? '(definido)' : '(vacío)');
  console.log('  DB_CLIENT                   =', process.env.DB_CLIENT || '(default)');
  console.log('');

  console.log('1) Internet (DNS lookup a', PROBE + ')...');
  const net = await checkInternet();
  console.log('   ', net.ok ? `OK → ${net.ip}` : `FALLA → ${net.error}`);

  console.log('\n2) Firebase Admin SDK...');
  const fb = await checkFirebaseAdmin();
  console.log('   ', fb.ok
    ? `OK → projectId(env)=${fb.projectIdEnv}, projectId(en uso)=${fb.projectIdInUse}, read=${fb.docsRead}`
    : `FALLA → ${fb.error}`);

  console.log('\n3) Cola local (firebase_sync_queue)...');
  const q = await checkQueue();
  console.log('   ', q.ok ? `OK → ${JSON.stringify(q.stats)}` : `FALLA → ${q.error}`);

  console.log('\n=== Resumen ===');
  const allGood = net.ok && fb.ok && q.ok;
  console.log(allGood ? '✅ Todo listo. La sync debería funcionar.' : '❌ Hay problemas. Revisa lo que falló arriba.');

  process.exit(allGood ? 0 : 1);
})().catch(err => {
  console.error('Error fatal:', err);
  process.exit(2);
});

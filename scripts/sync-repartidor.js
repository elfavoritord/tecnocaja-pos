/**
 * sync-repartidor.js
 * Crea/actualiza el documento de repartidor en Firestore usando Firebase Admin.
 *
 * Uso:
 *   node scripts/sync-repartidor.js <email> [nombre] [telefono]
 *
 * Ejemplo:
 *   node scripts/sync-repartidor.js deli@gmail.com "Deli Repartidor" "8091234567"
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const email = process.argv[2];
const nombre = process.argv[3] || 'Repartidor';
const telefono = process.argv[4] || '';

if (!email) {
  console.error('Uso: node scripts/sync-repartidor.js <email> [nombre] [telefono]');
  process.exit(1);
}

// Inicializar Firebase Admin
const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
if (!keyPath || !fs.existsSync(keyPath)) {
  console.error('No se encontró firebase-key.json en:', keyPath);
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const auth = admin.auth();
const db = admin.firestore();

async function run() {
  console.log(`\nBuscando usuario en Firebase Auth: ${email}...`);

  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(email);
    console.log(`✓ Usuario encontrado. UID: ${userRecord.uid}`);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      console.error(`✗ No existe ningún usuario con el email "${email}" en Firebase Authentication.`);
      console.error('  Primero usa "Sincronizar Firebase" en el módulo Usuarios del POS para crear el acceso.');
    } else {
      console.error('✗ Error buscando usuario:', err.message);
    }
    process.exit(1);
  }

  const uid = userRecord.uid;
  const docRef = db.collection('repartidores').doc(uid);

  console.log(`\nEscribiendo documento repartidores/${uid}...`);

  await docRef.set(
    {
      uid,
      nombre,
      email: email.toLowerCase().trim(),
      telefono,
      activo: true,
      rol: 'repartidor',
      ultimaUbicacion: null,
      pedidoActual: null,
      actualizadoEn: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  console.log('✓ Documento creado/actualizado correctamente.');
  console.log('\n─────────────────────────────────────────────');
  console.log('Datos del repartidor en Firestore:');
  console.log(`  uid:      ${uid}`);
  console.log(`  nombre:   ${nombre}`);
  console.log(`  email:    ${email}`);
  console.log(`  rol:      repartidor`);
  console.log(`  activo:   true`);
  console.log('─────────────────────────────────────────────');
  console.log('\n✓ Ahora el repartidor puede iniciar sesión en la app.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Error inesperado:', err.message);
  process.exit(1);
});

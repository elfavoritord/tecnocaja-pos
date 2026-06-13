#!/usr/bin/env node
/**
 * setup-admin.js — Crea el SuperAdmin inicial en Firebase Auth + Firestore
 *
 * Uso:
 *   cd tecno-caja-admin
 *   node setup-admin.js
 *
 * Requerido en tecno-caja-admin/.env:
 *   FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
 *   FIREBASE_PROJECT_ID=tu-proyecto-firebase
 */
'use strict';

const path     = require('path');
const readline = require('readline');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const ROOT = path.resolve(__dirname, '..');
require('module').globalPaths.push(path.join(ROOT, 'node_modules'));

// ── Helpers de consola ─────────────────────────────────────────────────────
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function promptHidden(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    let value = '';

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      const onData = (char) => {
        if (char === '\n' || char === '\r' || char === '') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
        } else if (char === '') {
          process.stdout.write('\n');
          process.exit(1);
        } else if (char === '' || char === '\b') {
          if (value.length > 0) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
        } else {
          value += char;
          process.stdout.write('*');
        }
      };
      process.stdin.on('data', onData);
    } else {
      // Entorno sin TTY (CI, PowerShell redirigido)
      const rl = readline.createInterface({ input: process.stdin, output: null });
      rl.question('', ans => { rl.close(); process.stdout.write('\n'); resolve(ans); });
    }
  });
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║     Tecno Caja Admin — Configurar SuperAdmin     ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // Validar service account
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!saPath) {
    console.error('❌  FIREBASE_SERVICE_ACCOUNT_PATH no está definido en .env');
    process.exit(1);
  }
  const absPath = path.isAbsolute(saPath) ? saPath : path.resolve(__dirname, saPath);
  let serviceAccount;
  try {
    serviceAccount = require(absPath);
  } catch {
    console.error('❌  No se encontró el archivo:', absPath);
    console.error('    Descárgalo desde Firebase Console → Configuración → Cuentas de servicio');
    process.exit(1);
  }

  // Solicitar datos
  const defaultEmail = 'emiliomanaurys@gmail.com';
  const defaultName  = 'Emilio Manaurys';

  const emailInput = await prompt(`Correo electrónico [${defaultEmail}]: `);
  const email      = emailInput || defaultEmail;

  const nameInput  = await prompt(`Nombre completo [${defaultName}]: `);
  const fullName   = nameInput || defaultName;

  // Contraseña con confirmación
  let password = '';
  for (;;) {
    password = await promptHidden('Ingrese contraseña inicial: ');
    if (password.length < 8) { console.log('❌  La contraseña debe tener al menos 8 caracteres. Intenta de nuevo.'); continue; }
    const confirm = await promptHidden('Confirmar contraseña: ');
    if (password !== confirm) { console.log('❌  Las contraseñas no coinciden. Intenta de nuevo.'); continue; }
    break;
  }

  // Conectar Firebase
  const admin = require('firebase-admin');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId:  process.env.FIREBASE_PROJECT_ID,
  });
  const db = admin.firestore();
  console.log('\n🔥 Conectado a Firebase —', process.env.FIREBASE_PROJECT_ID);

  // Crear o actualizar en Firebase Auth
  let userRecord;
  try {
    userRecord = await admin.auth().getUserByEmail(email);
    console.log('ℹ️  Usuario ya existe en Firebase Auth:', userRecord.uid);
    await admin.auth().updateUser(userRecord.uid, { password, displayName: fullName });
    console.log('✅  Contraseña y nombre actualizados.');
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      userRecord = await admin.auth().createUser({ email, password, displayName: fullName, disabled: false });
      console.log('✅  Usuario creado en Firebase Auth:', userRecord.uid);
    } else {
      throw e;
    }
  }

  // Crear o actualizar documento en Firestore
  const uid  = userRecord.uid;
  const now  = new Date().toISOString();
  const ref  = db.collection('platform_admins').doc(uid);
  const snap = await ref.get();

  const docData = {
    uid,
    email,
    fullName,
    role:        'super_admin_platform',
    status:      'active',
    permissions: ['*'],
    updatedAt:   now,
  };

  if (snap.exists) {
    await ref.update(docData);
    console.log('✅  Documento en Firestore actualizado.');
  } else {
    await ref.set({ ...docData, createdAt: now, lastLoginAt: null });
    console.log('✅  Documento creado en Firestore: platform_admins/' + uid);
  }

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║        SuperAdmin configurado correctamente       ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('  Email:       ' + email);
  console.log('  Nombre:      ' + fullName);
  console.log('  Rol:         super_admin_platform');
  console.log('  Permisos:    ["*"] — acceso total');
  console.log('  UID:         ' + uid);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('\n  ⚠️  Cambia la contraseña desde Configuración → Seguridad');
  console.log('     después de tu primer acceso.\n');

  process.exit(0);
}

main().catch(e => {
  console.error('\n❌  Error inesperado:', e.message);
  process.exit(1);
});

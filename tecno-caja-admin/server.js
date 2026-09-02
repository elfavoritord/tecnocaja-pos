'use strict';
/**
 * Tecno Caja Admin — Express server
 * Login 100% Firebase Authentication.
 * Datos en Firestore (mismas colecciones que el POS).
 * NO usa MariaDB.
 */
const path    = require('path');
const express = require('express');
const { createFacturacionRouter } = require('./routes/facturacion.routes');
const { createSuscripcionesRouter } = require('./routes/suscripciones.routes');
const { createComprasRouter } = require('./routes/compras.routes');
const { createGastosRouter } = require('./routes/gastos.routes');
const { createAdjuntosRouter } = require('./routes/adjuntos.routes');
const { createFlujoFinancieroRouter } = require('./routes/flujo-financiero.routes');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── Firebase Admin SDK ─────────────────────────────────────────────────────
let adminSdk   = null;
let db         = null;
let bucket     = null;
let fbReady    = false;
let fbError    = null;

function initFirebase() {
  try {
    const admin = require('firebase-admin');

    if (admin.apps.length) {
      adminSdk = admin;
      db = admin.apps[0].firestore();
      try { bucket = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET); } catch { bucket = null; }
      fbReady = true;
      return;
    }

    let credential;
    const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

    if (saJson) {
      credential = admin.credential.cert(JSON.parse(saJson));
    } else if (saPath) {
      const absPath = path.isAbsolute(saPath) ? saPath : path.resolve(__dirname, saPath);
      credential = admin.credential.cert(require(absPath));
    } else {
      fbError = 'Configura FIREBASE_SERVICE_ACCOUNT_PATH en tecno-caja-admin/.env';
      console.error('[admin]', fbError);
      return;
    }

    admin.initializeApp({
      credential,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
    adminSdk = admin;
    db = admin.firestore();
    try { bucket = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET); } catch { bucket = null; }
    fbReady = true;
    console.log('[admin] Firebase Admin conectado — proyecto:', process.env.FIREBASE_PROJECT_ID);
  } catch (e) {
    fbError = e.message;
    console.error('[admin] Firebase init error:', e.message);
  }
}

initFirebase();

// ── Colecciones (alineadas con el POS) ────────────────────────────────────
const COL_ADMINS      = 'platform_admins';
const COL_LICENCIAS   = process.env.FIREBASE_ADMIN_LICENSES_COLLECTION || 'licencias';
const COL_USUARIOS    = process.env.FIREBASE_ADMIN_USERS_COLLECTION     || 'usuarios';
const COL_CONTADORES  = 'contadores';
const COL_SOLICITUDES = 'support_requests';
const COL_HISTORIAL   = 'license_history';
const COL_AUDITORIA   = 'audit_logs';
const COL_VERSIONES   = 'app_versions';

// ── Express ────────────────────────────────────────────────────────────────
const app = express();
// 15mb (no 10mb): /api/adjuntos manda el archivo como dataBase64 dentro del
// JSON — base64 infla ~33% el tamaño real, así que un límite global de
// exactamente 10mb rechazaría (413) cualquier adjunto de más de ~7.5MB reales
// antes de que la ruta llegara a validar su propio tope de 10MB decodificado.
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ────────────────────────────────────────────────────────────────
function col(name) {
  if (!fbReady) throw new Error('Firebase no configurado. Revisa el .env del admin.');
  return db.collection(name);
}
function docData(doc) { return { id: doc.id, ...doc.data() }; }
function isoNow() { return new Date().toISOString(); }

async function audit(actor, action, target, detail) {
  if (!fbReady) return;
  await col(COL_AUDITORIA).add({ actor, action, target: target || null, detail: detail || null, created_at: isoNow() }).catch(() => {});
}

// ── Auth middleware — verifica ID token de Firebase ────────────────────────
async function requireAuth(req, res, next) {
  if (!fbReady) return res.status(503).json({ error: fbError || 'Firebase no disponible.' });

  const header = String(req.headers.authorization || '').trim();
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado.' });

  try {
    const decoded = await adminSdk.auth().verifyIdToken(header.slice(7));
    const uid = decoded.uid;

    const userDoc = await col(COL_ADMINS).doc(uid).get();
    if (!userDoc.exists) {
      return res.status(403).json({ error: 'Esta cuenta no tiene permisos para acceder a Tecno Caja Admin.' });
    }

    const userData = userDoc.data();
    if (userData.role !== 'super_admin_platform') {
      return res.status(403).json({ error: 'Esta cuenta no tiene permisos para acceder a Tecno Caja Admin.' });
    }
    if (userData.status !== 'active') {
      return res.status(403).json({ error: 'Esta cuenta está inactiva o suspendida.' });
    }

    // Actualizar lastLoginAt
    await col(COL_ADMINS).doc(uid).update({ lastLoginAt: isoNow() }).catch(() => {});

    req.adminUser = { uid, email: decoded.email, fullName: userData.fullName, role: userData.role, permissions: userData.permissions || ['*'] };
    next();
  } catch (e) {
    const msg = e?.code === 'auth/id-token-expired'
      ? 'Sesión expirada. Inicia sesión nuevamente.'
      : 'Token inválido.';
    res.status(401).json({ error: msg });
  }
}

// ── Rutas públicas ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/status', (_req, res) => res.json({
  fbReady,
  fbError,
  projectId: process.env.FIREBASE_PROJECT_ID || null,
}));

// Config Firebase para el cliente (sin exponer service account)
app.get('/api/firebase-config', (_req, res) => {
  const cfg = {
    apiKey:            process.env.FIREBASE_API_KEY            || null,
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN        || null,
    projectId:         process.env.FIREBASE_PROJECT_ID         || null,
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET     || null,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || null,
    appId:             process.env.FIREBASE_APP_ID             || null,
  };
  const missing = Object.entries(cfg).filter(([,v]) => !v).map(([k]) => k);
  if (missing.length) {
    return res.status(503).json({
      error: `Variables de entorno Firebase faltantes en .env: ${missing.join(', ')}`,
    });
  }
  res.json(cfg);
});

// Logo de la empresa para el branding del panel (sidebar + pantalla de login) —
// público a propósito: el login se ve ANTES de autenticarse, y un logo no es
// información sensible.
app.get('/api/branding/logo', async (_req, res) => {
  try {
    const doc = await col('admin_config').doc('facturacion').get();
    res.json({ logoDataUrl: doc.exists ? (doc.data().logoDataUrl || null) : null });
  } catch (_e) {
    res.json({ logoDataUrl: null });
  }
});

// Verificar token + perfil (llamado después del login de Firebase en el cliente)
// UIDs de emergencia configurables vía env (separados por coma)
const FALLBACK_ADMIN_UIDS = String(process.env.ADMIN_FALLBACK_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);

function isFirebaseAdminError(e) {
  return e?.code?.startsWith('auth/') || String(e?.message || '').includes('UNAUTHENTICATED')
    || String(e?.message || '').includes('PERMISSION_DENIED') || String(e?.code || '').includes('grpc');
}

app.post('/api/auth/verify', async (req, res) => {
  if (!fbReady) return res.status(503).json({ error: 'El servidor admin no está conectado a Firebase. Reinicia el servicio.' });
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken es requerido.' });

  try {
    const decoded = await adminSdk.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = decoded.email || '';

    // Intenta leer perfil desde Firestore
    let profileData = null;
    try {
      const userDoc = await col(COL_ADMINS).doc(uid).get();
      if (userDoc.exists) {
        profileData = userDoc.data();
        if (profileData.role !== 'super_admin_platform') {
          return res.status(403).json({ error: 'Esta cuenta no tiene permisos de administrador.' });
        }
        if (profileData.status !== 'active') {
          return res.status(403).json({ error: 'Esta cuenta está inactiva o suspendida.' });
        }
        col(COL_ADMINS).doc(uid).update({ lastLoginAt: isoNow() }).catch(() => {});
      }
    } catch (firestoreErr) {
      console.error('[admin] Firestore no disponible en verify:', firestoreErr.message);
      // Firestore no disponible — si el UID está en la lista de fallback, permitir entrada
      if (!FALLBACK_ADMIN_UIDS.includes(uid) && !FALLBACK_ADMIN_UIDS.includes(email)) {
        return res.status(503).json({ error: 'Base de datos del panel no disponible. Contacta al soporte técnico.' });
      }
    }

    if (!profileData && !FALLBACK_ADMIN_UIDS.includes(uid) && !FALLBACK_ADMIN_UIDS.includes(email)) {
      return res.status(403).json({ error: 'Esta cuenta no está registrada como administrador del panel.' });
    }

    res.json({
      ok: true, uid, email,
      fullName: profileData?.fullName || email,
      role: profileData?.role || 'super_admin_platform',
      permissions: profileData?.permissions || ['*'],
    });
  } catch (e) {
    const msg = isFirebaseAdminError(e)
      ? 'Error de autenticación con Firebase. Verifica que el servidor esté bien configurado.'
      : (e.code === 'auth/id-token-expired' ? 'Sesión expirada. Vuelve a iniciar sesión.' : 'No se pudo verificar la sesión.');
    console.error('[admin] verify error:', e.message);
    res.status(401).json({ error: msg });
  }
});

// Enviar correo de recuperación de contraseña
app.post('/api/auth/forgot-password', async (req, res) => {
  if (!fbReady) return res.status(503).json({ error: fbError });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido.' });
  try {
    const link = await adminSdk.auth().generatePasswordResetLink(email);
    // En producción se enviaría por correo; aquí confirmamos que se generó
    console.log('[admin] Password reset link generado para:', email);
    res.json({ ok: true, message: 'Correo de recuperación enviado.' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Dashboard ──────────────────────────────────────────────────────────────
app.get('/api/dashboard', requireAuth, async (_req, res) => {
  try {
    const [licSnap, contSnap, solSnap] = await Promise.all([
      col(COL_LICENCIAS).get(),
      col(COL_CONTADORES).where('estado', '==', 'activo').get(),
      col(COL_SOLICITUDES).where('status', '==', 'pendiente').get(),
    ]);

    const negocios = licSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const licMap = {};
    negocios.forEach(n => { const s = n.status || 'trial'; licMap[s] = (licMap[s] || 0) + 1; });

    const recientes = [...negocios]
      .sort((a, b) => String(b.syncedAt || b.updatedAt || '').localeCompare(String(a.syncedAt || a.updatedAt || '')))
      .slice(0, 10);

    res.json({
      totales: {
        negocios:    negocios.length,
        contadores:  contSnap.size,
        activas:     licMap.active    || 0,
        prueba:      licMap.trial     || 0,
        pendientes:  licMap.pending   || 0,
        vencidas:    (licMap.expired  || 0) + (licMap.cancelled || 0),
        suspendidas: licMap.suspended || 0,
        solicitudesPendientes: solSnap.size,
      },
      ultimosNegocios: recientes,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Perfil del admin autenticado ───────────────────────────────────────────
app.get('/api/perfil', requireAuth, async (req, res) => {
  try {
    const doc = await col(COL_ADMINS).doc(req.adminUser.uid).get();
    res.json(docData(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Negocios (colección licencias del POS) ─────────────────────────────────
app.get('/api/negocios', requireAuth, async (req, res) => {
  try {
    const snap = req.query.status
      ? await col(COL_LICENCIAS).where('status', '==', req.query.status).get()
      : await col(COL_LICENCIAS).get();

    // Resolver nombres de contadores para docs que tengan contadorId pero no contadorNombre
    const negocios = snap.docs.map(docData);
    const sinNombre = negocios.filter(n => n.contadorId && !n.contadorNombre);

    if (sinNombre.length > 0) {
      const ids = [...new Set(sinNombre.map(n => n.contadorId))];
      const contMap = {};
      await Promise.all(ids.map(async id => {
        try {
          const d = await col(COL_CONTADORES).doc(String(id)).get();
          if (d.exists) contMap[id] = d.data().nombre_firma || null;
        } catch {}
      }));
      negocios.forEach(n => {
        if (n.contadorId && !n.contadorNombre && contMap[n.contadorId]) {
          n.contadorNombre = contMap[n.contadorId];
        }
      });
    }

    res.json(negocios);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Asignar contador a un negocio directamente desde el admin
app.post('/api/negocios/:id/asignar-contador', requireAuth, async (req, res) => {
  const { contadorId } = req.body;
  if (!contadorId) return res.status(400).json({ error: 'contadorId requerido.' });
  try {
    const cDoc = await col(COL_CONTADORES).doc(String(contadorId)).get();
    if (!cDoc.exists) return res.status(404).json({ error: 'Contador no encontrado.' });
    const contadorNombre = cDoc.data().nombre_firma || null;
    await col(COL_LICENCIAS).doc(req.params.id).update({
      contadorId: String(contadorId),
      contadorNombre,
      businessStructureMode: 'accountant_client',
    });
    await audit(req.adminUser.email, 'negocio.asignar_contador', req.params.id, contadorNombre);
    res.json({ ok: true, contadorNombre });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/negocios/:id', requireAuth, async (req, res) => {
  try {
    const doc = await col(COL_LICENCIAS).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Negocio no encontrado.' });
    const neg = docData(doc);
    if (neg.contadorId && !neg.contadorNombre) {
      try {
        const cDoc = await col(COL_CONTADORES).doc(String(neg.contadorId)).get();
        if (cDoc.exists) neg.contadorNombre = cDoc.data().nombre_firma || null;
      } catch {}
    }
    res.json(neg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/negocios/:id/usuarios', requireAuth, async (req, res) => {
  try {
    const licDoc = await col(COL_LICENCIAS).doc(req.params.id).get();
    if (!licDoc.exists) return res.status(404).json({ error: 'Negocio no encontrado.' });
    const businessKey = licDoc.data().businessKey || req.params.id;
    const snap = await col(COL_USUARIOS).where('businessKey', '==', businessKey).get();
    res.json(snap.docs.map(docData));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Licencias ──────────────────────────────────────────────────────────────
app.post('/api/negocios/:id/licencia', requireAuth, async (req, res) => {
  const ACCIONES = ['activar', 'suspender', 'cancelar', 'renovar', 'trial', 'pendiente'];
  const { accion, plan, dias, notas } = req.body;
  if (!ACCIONES.includes(accion)) return res.status(400).json({ error: 'Acción inválida.' });

  try {
    const ref = col(COL_LICENCIAS).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Negocio no encontrado.' });

    const biz = doc.data();
    const now = new Date();
    const update = { updatedAt: now, syncedAt: now };
    if (plan) { update.planCode = plan; update.plan_code = plan; }

    switch (accion) {
      case 'activar':
        // "Activar" siempre deja la licencia sin fecha de vencimiento —
        // queda activa hasta que se suspenda/cancele a mano, sin importar
        // el plan. Decisión explícita de Emilio (2026-08-04): si algún
        // negocio necesita vencer en una fecha concreta, usar "Confirmar
        // renovación" (accion:'renovar'), que sí fija expiresAt.
        update.status          = 'active';
        update.expiresAt       = null;
        update.trialEndsAt     = null;
        update.trialStartedAt  = null;
        break;
      case 'suspender': update.status = 'suspended'; break;
      case 'cancelar':  update.status = 'cancelled'; break;
      case 'pendiente': update.status = 'pending'; break;
      case 'trial':
        update.status        = 'trial';
        update.trialStartedAt = now;
        update.trialEndsAt    = new Date(now.getTime() + 30 * 86400000);
        break;
      case 'renovar':
        update.status    = 'active';
        update.expiresAt = new Date(now.getTime() + (Number(dias) || 365) * 86400000);
        break;
    }

    await ref.update(update);

    await col(COL_HISTORIAL).add({
      business_id: req.params.id, businessKey: biz.businessKey || req.params.id,
      businessName: biz.businessName || '—', plan: plan || biz.planCode || '—',
      status: update.status, action: accion,
      activated_by: req.adminUser.email, notes: notas || null, created_at: isoNow(),
    }).catch(() => {});

    await audit(req.adminUser.email, `licencia.${accion}`, req.params.id, `Plan: ${plan || biz.planCode}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Gestión de dispositivos registrados en la licencia
app.get('/api/negocios/:id/dispositivos', requireAuth, async (req, res) => {
  try {
    const doc = await col(COL_LICENCIAS).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Negocio no encontrado.' });
    const d = doc.data();
    const devices = d.devices || {};
    const list = Object.values(devices).map(dv => ({
      deviceId:    dv.deviceId,
      hostname:    dv.hostname || '—',
      platform:    dv.platform || '—',
      status:      dv.status || 'active',
      firstSeenAt: dv.firstSeenAt?.toDate?.()?.toISOString() || dv.firstSeenAt || null,
      lastSeenAt:  dv.lastSeenAt?.toDate?.()?.toISOString()  || dv.lastSeenAt  || null,
    }));
    res.json({ deviceLimit: d.deviceLimit || 1, devices: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/negocios/:id/dispositivos/:deviceId', requireAuth, async (req, res) => {
  try {
    const ref = col(COL_LICENCIAS).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Negocio no encontrado.' });
    const fieldPath = `devices.${req.params.deviceId}`;
    const { FieldValue } = require('firebase-admin/firestore');
    await ref.update({ [fieldPath]: FieldValue.delete(), updatedAt: new Date() });
    await audit(req.adminUser.email, 'dispositivo.eliminado', req.params.id, `Device: ${req.params.deviceId}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/negocios/:id/device-limit', requireAuth, async (req, res) => {
  const limit = Number(req.body.limit);
  if (!Number.isFinite(limit) || limit < 1 || limit > 50) {
    return res.status(400).json({ error: 'Límite debe ser entre 1 y 50.' });
  }
  try {
    const ref = col(COL_LICENCIAS).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Negocio no encontrado.' });
    await ref.update({ deviceLimit: limit, updatedAt: new Date() });
    await audit(req.adminUser.email, 'licencia.device_limit', req.params.id, `Nuevo límite: ${limit}`);
    res.json({ ok: true, deviceLimit: limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Borrado suave: mueve el negocio a la papelera (no borra de verdad).
// La instalación POS detecta deleted:true y genera un UID nuevo en el próximo arranque.
app.delete('/api/negocios/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const licRef = col(COL_LICENCIAS).doc(id);
    const licDoc = await licRef.get();
    if (!licDoc.exists) return res.status(404).json({ error: 'Negocio no encontrado.' });

    const data = licDoc.data() || {};
    const db   = admin.firestore();

    // Guardar copia en papelera ANTES de marcar como eliminado
    const snapshot = { ...data, _papeleraId: id, _papeleraFecha: new Date().toISOString(), _papeleraPor: req.adminUser.email };
    await db.collection('papelera').doc(id).set(snapshot);

    // Marcar como eliminado (el POS lo detecta y genera nuevo UID)
    await licRef.update({ deleted: true, deletedAt: new Date(), deletedBy: req.adminUser.email });

    await audit(req.adminUser.email, 'negocio.papelera', id, `businessKey: ${data.businessKey || id}`);
    res.json({ ok: true, inPapelera: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Restaurar negocio desde la papelera
app.post('/api/negocios/:id/restaurar', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const db        = admin.firestore();
    const trashRef  = db.collection('papelera').doc(id);
    const trashDoc  = await trashRef.get();
    if (!trashDoc.exists) return res.status(404).json({ error: 'No se encontró en la papelera.' });

    const snapshot = trashDoc.data() || {};
    delete snapshot._papeleraId; delete snapshot._papeleraFecha; delete snapshot._papeleraPor;

    // Restaurar documento de licencia sin el flag deleted
    delete snapshot.deleted; delete snapshot.deletedAt; delete snapshot.deletedBy;
    await col(COL_LICENCIAS).doc(id).set(snapshot, { merge: true });

    // Borrar de la papelera
    await trashRef.delete();

    await audit(req.adminUser.email, 'negocio.restaurado', id, `Restaurado desde papelera`);
    res.json({ ok: true, restaurado: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Listar papelera
app.get('/api/papelera', requireAuth, async (req, res) => {
  try {
    const snap = await admin.firestore().collection('papelera').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Eliminar permanentemente desde papelera (borra licencia, usuarios y businesses)
app.delete('/api/papelera/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const db       = admin.firestore();
    const trashDoc = await db.collection('papelera').doc(id).get();
    const bKey     = trashDoc.exists ? (trashDoc.data().businessKey || id) : id;

    const batch = db.batch();

    // Borrar licencia (puede que ya esté marcada, la borramos definitivamente)
    const licRef = col(COL_LICENCIAS).doc(id);
    if ((await licRef.get()).exists) batch.delete(licRef);

    // Borrar usuarios relacionados
    const usersSnap = await col(COL_USUARIOS).where('businessKey', '==', bKey).get();
    usersSnap.docs.forEach(d => batch.delete(d.ref));

    // Borrar businesses
    const bizRef = db.collection('businesses').doc(bKey);
    if ((await bizRef.get()).exists) batch.delete(bizRef);

    // Borrar de papelera
    batch.delete(db.collection('papelera').doc(id));

    await batch.commit();
    await audit(req.adminUser.email, 'negocio.eliminado_permanente', id, `businessKey: ${bKey}`);
    res.json({ ok: true, eliminado: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Borrar documentos huérfanos en businesses y usuarios (sin licencia activa)
app.delete('/api/cleanup/huerfanos', requireAuth, async (req, res) => {
  try {
    const db = admin.firestore();
    const licSnap = await col(COL_LICENCIAS).get();
    const licIds = new Set(licSnap.docs.map(d => d.id));
    // Obtener todos los businessKey válidos de las licencias
    const licKeys = new Set(licSnap.docs.map(d => d.data().businessKey).filter(Boolean));

    let deleted = 0;
    const batch = db.batch();

    // Limpiar businesses huérfanos
    const bizSnap = await db.collection('businesses').get();
    bizSnap.docs.forEach(d => {
      if (!licIds.has(d.id) && !licKeys.has(d.id)) {
        batch.delete(d.ref);
        deleted++;
      }
    });

    // Limpiar usuarios huérfanos
    const usrSnap = await col(COL_USUARIOS).get();
    usrSnap.docs.forEach(d => {
      const bk = d.data().businessKey || d.id;
      if (!licIds.has(d.id) && !licKeys.has(bk) && !licIds.has(bk)) {
        batch.delete(d.ref);
        deleted++;
      }
    });

    if (deleted > 0) await batch.commit();
    await audit(req.adminUser.email, 'cleanup.huerfanos', 'system', `${deleted} documentos eliminados`);
    res.json({ ok: true, deleted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/licencias/:businessId', requireAuth, async (req, res) => {
  try {
    const snap = await col(COL_HISTORIAL)
      .where('business_id', '==', req.params.businessId).get();
    const sorted = snap.docs.map(docData).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 50);
    res.json(sorted);
  } catch (_e) { res.json([]); }
});

app.get('/api/licencias-resumen', requireAuth, async (_req, res) => {
  try {
    const snap = await col(COL_LICENCIAS).get();
    const m = {};
    snap.docs.forEach(d => { const s = d.data().status || 'trial'; m[s] = (m[s] || 0) + 1; });
    res.json(m);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Contadores ─────────────────────────────────────────────────────────────
app.get('/api/contadores', requireAuth, async (req, res) => {
  try {
    const snap = await col(COL_CONTADORES).get();
    let list = snap.docs.map(docData).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) {
      list = list.filter(c =>
        (c.nombre_firma || '').toLowerCase().includes(q) ||
        (c.rnc          || '').toLowerCase().includes(q) ||
        (c.correo       || '').toLowerCase().includes(q)
      );
    }
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contadores', requireAuth, async (req, res) => {
  const { nombre_firma, responsable, rnc, telefono, correo, email_acceso, password_acceso } = req.body;
  if (!nombre_firma || !email_acceso || !password_acceso)
    return res.status(400).json({ error: 'Nombre, correo y contraseña son requeridos.' });
  try {
    // Crear en Firebase Auth
    const userRecord = await adminSdk.auth().createUser({
      email: email_acceso, password: password_acceso,
      displayName: responsable || nombre_firma, disabled: false,
    });

    // Guardar en Firestore
    const now = isoNow();
    await col(COL_ADMINS).doc(userRecord.uid).set({
      uid: userRecord.uid, email: email_acceso,
      fullName: responsable || nombre_firma,
      role: 'contador_asociado', status: 'active', created_at: now,
    });

    const contRef = await col(COL_CONTADORES).add({
      firebase_uid: userRecord.uid, nombre_firma, responsable: responsable || null,
      rnc: rnc || null, telefono: telefono || null, correo: correo || email_acceso,
      estado: 'activo', created_at: now, updated_at: now,
    });

    await audit(req.adminUser.email, 'contador.crear', contRef.id, nombre_firma);
    const doc = await contRef.get();
    res.status(201).json(docData(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contadores/:id/suspender', requireAuth, async (req, res) => {
  try {
    const doc = await col(COL_CONTADORES).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Contador no encontrado.' });
    const data = doc.data();
    await col(COL_CONTADORES).doc(req.params.id).update({ estado: 'suspendido', updated_at: isoNow() });
    if (data.firebase_uid) {
      await adminSdk.auth().updateUser(data.firebase_uid, { disabled: true }).catch(() => {});
      await col(COL_ADMINS).doc(data.firebase_uid).update({ status: 'inactive' }).catch(() => {});
    }
    await audit(req.adminUser.email, 'contador.suspender', req.params.id, data.nombre_firma);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contadores/:id/reactivar', requireAuth, async (req, res) => {
  try {
    const doc = await col(COL_CONTADORES).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Contador no encontrado.' });
    const data = doc.data();
    await col(COL_CONTADORES).doc(req.params.id).update({ estado: 'activo', updated_at: isoNow() });
    if (data.firebase_uid) {
      await adminSdk.auth().updateUser(data.firebase_uid, { disabled: false }).catch(() => {});
      await col(COL_ADMINS).doc(data.firebase_uid).update({ status: 'active' }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/contadores/:id', requireAuth, async (req, res) => {
  const { nombre_firma, responsable, rnc, telefono, correo } = req.body;
  if (!nombre_firma) return res.status(400).json({ error: 'El nombre de la firma es obligatorio.' });
  try {
    const ref = col(COL_CONTADORES).doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'Contador no encontrado.' });
    const update = { nombre_firma, responsable: responsable || null, rnc: rnc || null, telefono: telefono || null, correo: correo || null, updated_at: isoNow() };
    await ref.update(update);
    await audit(req.adminUser.email, 'contador.actualizado', req.params.id, nombre_firma);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/contadores/:id', requireAuth, async (req, res) => {
  try {
    const doc = await col(COL_CONTADORES).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Contador no encontrado.' });
    const data = doc.data();
    await col(COL_CONTADORES).doc(req.params.id).delete();
    if (data.firebase_uid) {
      await adminSdk.auth().deleteUser(data.firebase_uid).catch(() => {});
      await col(COL_ADMINS).doc(data.firebase_uid).delete().catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Solicitudes ────────────────────────────────────────────────────────────
app.get('/api/solicitudes', requireAuth, async (req, res) => {
  try {
    const snap = req.query.status
      ? await col(COL_SOLICITUDES).where('status', '==', req.query.status).get()
      : await col(COL_SOLICITUDES).get();
    const sorted = snap.docs.map(docData).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 200);
    res.json(sorted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/solicitudes/:id', requireAuth, async (req, res) => {
  const { status, respuesta } = req.body;
  try {
    await col(COL_SOLICITUDES).doc(req.params.id).update({
      status, respuesta: respuesta || null, updated_at: isoNow(), responded_by: req.adminUser.email,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Actualizaciones ────────────────────────────────────────────────────────
app.get('/api/actualizaciones', requireAuth, async (_req, res) => {
  try {
    const snap = await col(COL_VERSIONES).get();
    const sorted = snap.docs.map(docData).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 50);
    res.json(sorted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/actualizaciones', requireAuth, async (req, res) => {
  const { version, descripcion, url_descarga, es_obligatoria } = req.body;
  if (!version) return res.status(400).json({ error: 'Versión es requerida.' });
  try {
    const ref = await col(COL_VERSIONES).add({
      version, descripcion: descripcion || null, url_descarga: url_descarga || null,
      es_obligatoria: Boolean(es_obligatoria), estado: 'publicado',
      publicado_por: req.adminUser.email, created_at: isoNow(),
    });
    await audit(req.adminUser.email, 'version.publicar', ref.id, version);
    const doc = await ref.get();
    res.status(201).json(docData(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auditoría ──────────────────────────────────────────────────────────────
app.get('/api/auditoria', requireAuth, async (_req, res) => {
  try {
    const snap = await col(COL_AUDITORIA).get();
    const sorted = snap.docs.map(docData).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 200);
    res.json(sorted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Facturación de servicios ───────────────────────────────────────────────
app.use('/api/facturas', createFacturacionRouter({
  col, docData, isoNow, audit, requireAuth,
  licenciasCollection: COL_LICENCIAS,
}));

// ── Suscripciones / pagos recurrentes mensuales ───────────────────────────
app.use('/api/suscripciones', createSuscripcionesRouter({
  col, docData, isoNow, audit, requireAuth,
  licenciasCollection: COL_LICENCIAS,
}));

// ── Compras y gastos de la empresa ─────────────────────────────────────────
app.use('/api/compras', createComprasRouter({ col, docData, isoNow, audit, requireAuth }));
app.use('/api/gastos', createGastosRouter({ col, docData, isoNow, audit, requireAuth }));
app.use('/api/adjuntos', createAdjuntosRouter({ col, docData, isoNow, requireAuth, getBucket: () => bucket }));
app.use('/api/flujo-financiero', createFlujoFinancieroRouter({ col, docData, requireAuth }));

// ── RNC / Cédula lookup (DGII) ────────────────────────────────────────────
let _rncHandler = null;
let _rncReady   = false;

function getRncHandler() {
  if (_rncHandler) return _rncHandler;
  try {
    const mod = require('dgii-rnc');
    _rncHandler = new mod.RNCHandler();
    _rncHandler.checkFile().then(() => { _rncReady = true; }).catch(() => {});
  } catch (_) {}
  return _rncHandler;
}
getRncHandler(); // pre-cargar al iniciar

app.get('/api/rnc/lookup', requireAuth, async (req, res) => {
  const raw = String(req.query.id || '').replace(/\D/g, '');
  if (!raw || raw.length < 9) return res.status(400).json({ error: 'RNC inválido.' });
  const h = getRncHandler();
  if (!h || !_rncReady) return res.status(503).json({ error: 'Servicio RNC no disponible aún, espera unos segundos.' });
  try {
    const candidates = [raw];
    if (raw.length === 10) candidates.push('0' + raw);
    let record = null;
    for (const id of candidates) {
      const results = await h.search({ ID: id });
      if (results && results.length > 0) { record = results[0]; break; }
    }
    if (!record) return res.json({ found: false });
    res.json({
      found: true,
      rnc: record.ID || raw,
      nombre: record.NOMBRE || '',
      nombreComercial: record.NOMBRE_COMERCIAL || record.NOMBRE || '',
      estado: record.ESTADO || '',
      tipo: record.TIPO || '',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback ───────────────────────────────────────────────────────────
app.get(/(.*)/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;

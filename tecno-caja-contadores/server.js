'use strict';
/**
 * Tecno Caja Contadores — Express server
 * Auth: Firebase Authentication (platform_admins con role='contador_asociado').
 * Datos: Firestore (colecciones compartidas con POS + Admin).
 * Aislamiento: todos los datos filtrados por contadorDocId del uid autenticado.
 */
const path    = require('path');
const express = require('express');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── Firebase Admin SDK ─────────────────────────────────────────────────────
let adminSdk = null;
let db       = null;
let bucket   = null;
let fbReady  = false;
let fbError  = null;

function initFirebase() {
  try {
    const admin = require('firebase-admin');

    if (admin.apps.length) {
      adminSdk = admin;
      db = admin.apps[0].firestore();
      bucket = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET);
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
      fbError = 'Configura FIREBASE_SERVICE_ACCOUNT_PATH en tecno-caja-contadores/.env';
      console.error('[contadores]', fbError);
      return;
    }

    admin.initializeApp({
      credential,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
    adminSdk = admin;
    db = admin.firestore();
    bucket = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET);
    fbReady = true;
    console.log('[contadores] Firebase Admin conectado — proyecto:', process.env.FIREBASE_PROJECT_ID);
  } catch (e) {
    fbError = e.message;
    console.error('[contadores] Firebase init error:', e.message);
  }
}

initFirebase();

// ── RNC / DGII — dataset local (dgii-rnc) ─────────────────────────────────
let _rncHandler    = null;
let _rncReady      = false;
let _rncError      = null;

function getRncHandler() {
  if (_rncHandler) return _rncHandler;
  try {
    const mod = require('dgii-rnc');
    _rncHandler = new mod.RNCHandler();
    if (mod.scheduleUpdates) {
      mod.scheduleUpdates({ handler: _rncHandler, intervalMs: 24 * 60 * 60 * 1000 });
    }
    _rncHandler.checkFile()
      .then(() => { _rncReady = true; console.log('[rnc] Dataset DGII listo.'); })
      .catch(e  => { _rncError = e.message; console.warn('[rnc] Dataset no disponible:', e.message); });
  } catch (e) {
    _rncError = 'Módulo dgii-rnc no disponible: ' + e.message;
    console.warn('[rnc]', _rncError);
  }
  return _rncHandler;
}

// Iniciar carga en background al arrancar
getRncHandler();

// ── Colecciones ────────────────────────────────────────────────────────────
const COL_ADMINS      = 'platform_admins';
const COL_CONTADORES  = 'contadores';
const COL_LICENCIAS   = process.env.FIREBASE_ADMIN_LICENSES_COLLECTION || 'licencias';
const COL_SOLICITUDES = 'support_requests';
const COL_VERSIONES   = 'app_versions';
const COL_HISTORIAL   = 'license_history';
const SUB_COLABORADORES = 'colaboradores'; // subcol de contadores/{id}/colaboradores

// ── Express ────────────────────────────────────────────────────────────────
const app = express();
// 15mb (no 10mb): /adjuntos manda el archivo como dataBase64 dentro del JSON
// — base64 infla ~33% el tamaño real, así que un límite global de exactamente
// 10mb rechazaba (413) cualquier adjunto de más de ~7.5MB reales antes de que
// la ruta llegara a validar su propio tope de 10MB de contenido decodificado.
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// SheetJS (xlsx) — exportar Excel real desde Reportes. Solo se expone el dist, no todo node_modules.
app.use('/vendor/xlsx', express.static(path.join(__dirname, 'node_modules', 'xlsx', 'dist')));

// ── Helpers ────────────────────────────────────────────────────────────────
function col(name) {
  if (!fbReady) throw new Error('Firebase no configurado.');
  return db.collection(name);
}
// Convierte cualquier Firestore Timestamp nativo (trialEndsAt, expiresAt,
// issuedAt, etc.) a ISO string antes de mandarlo al cliente — si no, llega
// como {_seconds,_nanoseconds} y el frontend (fmtDate/vencimientoFecha) no
// sabe interpretarlo, aunque el cálculo de días restantes en el servidor sí
// funcione (daysFromNow ya maneja ambos casos con date.toDate?.()).
function docData(doc) {
  const raw = doc.data() || {};
  const out = { id: doc.id };
  for (const [k, v] of Object.entries(raw)) {
    out[k] = (v && typeof v.toDate === 'function') ? v.toDate().toISOString() : v;
  }
  return out;
}
function isoNow() { return new Date().toISOString(); }
function daysFromNow(date) {
  if (!date) return null;
  const d = date.toDate ? date.toDate() : new Date(date);
  return Math.ceil((d - Date.now()) / 86_400_000);
}

// Para licencias activas, trialEndsAt ya no aplica — solo expiresAt.
// Para trial/otras, usar trialEndsAt primero.
function vencimientoDate(c) {
  const s = String(c.status || '').toLowerCase();
  if (s === 'active') return c.expiresAt || null;
  return c.trialEndsAt || c.expiresAt || null;
}

// ── Auth middleware ────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  if (!fbReady) return res.status(503).json({ error: fbError || 'Firebase no disponible.' });

  const header = String(req.headers.authorization || '').trim();
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado.' });

  try {
    const decoded = await adminSdk.auth().verifyIdToken(header.slice(7));
    const uid = decoded.uid;

    const adminDoc = await col(COL_ADMINS).doc(uid).get();
    if (!adminDoc.exists) {
      return res.status(403).json({ error: 'Esta cuenta no tiene acceso a Tecno Caja Contadores.' });
    }

    const adminData = adminDoc.data();

    if (adminData.status !== 'active') {
      return res.status(403).json({ error: 'Esta cuenta está inactiva o suspendida.' });
    }

    // ── Colaborador ──────────────────────────────────────────────────────────
    if (adminData.role === 'colaborador') {
      const parentId = adminData.parentContadorId;
      if (!parentId) return res.status(403).json({ error: 'Colaborador sin contador principal asignado.' });

      const [colabDoc, parentDoc] = await Promise.all([
        col(COL_CONTADORES).doc(parentId).collection(SUB_COLABORADORES).doc(uid).get(),
        col(COL_CONTADORES).doc(parentId).get(),
      ]);

      if (!colabDoc.exists) return res.status(403).json({ error: 'Perfil de colaborador no encontrado.' });

      const colabData = colabDoc.data();
      if (colabData.estado !== 'activo') return res.status(403).json({ error: 'Colaborador inactivo o suspendido.' });

      const parentData = parentDoc.data() || {};
      col(COL_ADMINS).doc(uid).update({ lastLoginAt: isoNow() }).catch(() => {});

      req.contador = {
        uid,
        contadorDocId: parentId,
        email:        decoded.email || adminData.email || '',
        fullName:     colabData.nombre || '',
        nombre_firma: parentData.nombre_firma || '',
        responsable:  colabData.nombre || '',
        rnc:          colabData.rnc || parentData.rnc || '',
        telefono:     colabData.telefono || '',
        correo:       colabData.email || decoded.email || '',
        logo_url:     parentData.logo_url || null,
      };
      req.colaborador = {
        uid,
        tipo:              colabData.tipo || 'dependiente',
        estado:            colabData.estado,
        clientesAsignados: colabData.clientesAsignados || [],
        parentContadorId:  parentId,
        esColaborador:     true,
        esDependiente:     (colabData.tipo || 'dependiente') === 'dependiente',
      };
      return next();
    }

    // ── Contador principal ───────────────────────────────────────────────────
    if (adminData.role !== 'contador_asociado') {
      return res.status(403).json({ error: 'Esta cuenta no tiene acceso a Tecno Caja Contadores.' });
    }

    const contSnap = await col(COL_CONTADORES).where('firebase_uid', '==', uid).limit(1).get();
    if (contSnap.empty) {
      return res.status(403).json({ error: 'No se encontró el perfil de contador. Contacta al administrador.' });
    }

    const contDoc = contSnap.docs[0];
    const contData = contDoc.data();

    if ((contData.estado || '').toLowerCase() === 'suspendido') {
      return res.status(403).json({ error: 'Tu firma contable está suspendida. Contacta al administrador.' });
    }

    col(COL_ADMINS).doc(uid).update({ lastLoginAt: isoNow() }).catch(() => {});

    req.contador = {
      uid,
      contadorDocId: contDoc.id,
      email:       decoded.email || adminData.email || '',
      fullName:    adminData.fullName || contData.responsable || contData.nombre_firma || '',
      nombre_firma: contData.nombre_firma || '',
      responsable: contData.responsable || '',
      rnc:         contData.rnc || '',
      telefono:    contData.telefono || '',
      correo:      contData.correo || decoded.email || '',
      logo_url:    contData.logo_url || null,
    };
    req.colaborador = null;

    next();
  } catch (e) {
    const msg = e?.code === 'auth/id-token-expired'
      ? 'Sesión expirada. Inicia sesión nuevamente.'
      : 'Token inválido.';
    res.status(401).json({ error: msg });
  }
}

// ══════════════════════════════════════════════════════════════════════
// RUTAS PÚBLICAS
// ══════════════════════════════════════════════════════════════════════

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/status', (_req, res) => res.json({
  fbReady, fbError, projectId: process.env.FIREBASE_PROJECT_ID || null,
}));

app.get('/api/firebase-config', (_req, res) => {
  const cfg = {
    apiKey:            process.env.FIREBASE_API_KEY             || null,
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN         || null,
    projectId:         process.env.FIREBASE_PROJECT_ID          || null,
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET      || null,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || null,
    appId:             process.env.FIREBASE_APP_ID              || null,
  };
  const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    return res.status(503).json({ error: `Variables Firebase faltantes en .env: ${missing.join(', ')}` });
  }
  res.json(cfg);
});

// Verificar token + perfil de contador
app.post('/api/auth/verify', async (req, res) => {
  if (!fbReady) return res.status(503).json({ error: fbError });
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken requerido.' });

  try {
    const decoded = await adminSdk.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const adminDoc = await col(COL_ADMINS).doc(uid).get();
    if (!adminDoc.exists) {
      return res.status(403).json({ error: 'Esta cuenta no tiene acceso a Tecno Caja Contadores.' });
    }

    const adminData = adminDoc.data();

    if (adminData.status !== 'active') {
      return res.status(403).json({ error: 'Cuenta inactiva o suspendida.' });
    }

    // ── Colaborador login ────────────────────────────────────────────────────
    if (adminData.role === 'colaborador') {
      const parentId = adminData.parentContadorId;
      if (!parentId) return res.status(403).json({ error: 'Colaborador sin contador principal asignado.' });

      const [colabDoc, parentDoc] = await Promise.all([
        col(COL_CONTADORES).doc(parentId).collection(SUB_COLABORADORES).doc(uid).get(),
        col(COL_CONTADORES).doc(parentId).get(),
      ]);

      if (!colabDoc.exists) return res.status(403).json({ error: 'Perfil de colaborador no encontrado.' });

      const colabData = colabDoc.data();
      if (colabData.estado !== 'activo') return res.status(403).json({ error: 'Colaborador inactivo o suspendido.' });

      const parentData = parentDoc.data() || {};
      col(COL_ADMINS).doc(uid).update({ lastLoginAt: isoNow() }).catch(() => {});

      return res.json({
        ok: true, uid,
        email:        decoded.email,
        fullName:     colabData.nombre,
        nombre_firma: parentData.nombre_firma || '',
        responsable:  colabData.nombre || '',
        rnc:          colabData.rnc || parentData.rnc || '',
        telefono:     colabData.telefono || '',
        correo:       colabData.email || decoded.email || '',
        logo_url:     parentData.logo_url || null,
        contadorDocId: parentId,
        // Campos exclusivos de colaborador
        isColaborador:     true,
        colaboradorId:     uid,
        tipo:              colabData.tipo || 'dependiente',
        estado:            colabData.estado,
        clientesAsignados: colabData.clientesAsignados || [],
      });
    }

    // ── Contador principal ───────────────────────────────────────────────────
    if (adminData.role !== 'contador_asociado') {
      return res.status(403).json({ error: 'Esta cuenta no es de tipo contador asociado.' });
    }

    const contSnap = await col(COL_CONTADORES).where('firebase_uid', '==', uid).limit(1).get();
    if (contSnap.empty) {
      return res.status(403).json({ error: 'Perfil de contador no encontrado. Contacta al administrador.' });
    }

    const contDoc = contSnap.docs[0];
    const contData = contDoc.data();

    col(COL_ADMINS).doc(uid).update({ lastLoginAt: isoNow() }).catch(() => {});

    res.json({
      ok: true, uid,
      email:        decoded.email,
      fullName:     adminData.fullName || contData.responsable || '',
      nombre_firma: contData.nombre_firma || '',
      responsable:  contData.responsable  || '',
      rnc:          contData.rnc          || '',
      telefono:     contData.telefono     || '',
      correo:       contData.correo       || decoded.email || '',
      logo_url:     contData.logo_url     || null,
      contadorDocId: contDoc.id,
      isColaborador: false,
    });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  if (!fbReady) return res.status(503).json({ error: fbError });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido.' });
  try {
    await adminSdk.auth().generatePasswordResetLink(email);
    res.json({ ok: true, message: 'Correo de recuperación enviado.' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════

app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const [licSnap, solSnap] = await Promise.all([
      col(COL_LICENCIAS).where('contadorId', '==', req.contador.contadorDocId).get(),
      col(COL_SOLICITUDES).where('contadorId', '==', req.contador.contadorDocId).get(),
    ]);

    const clientes = licSnap.docs.map(docData);
    const now = Date.now();

    const stats = {
      total: clientes.length,
      activas: 0, prueba: 0, vencidas: 0, suspendidas: 0,
      proximosVencer: [],
      solicitudesPendientes: 0,
    };

    clientes.forEach(c => {
      const status = (c.status || 'trial').toLowerCase();
      if (status === 'active')    stats.activas++;
      else if (status === 'trial') stats.prueba++;
      else if (status === 'expired' || status === 'cancelled') stats.vencidas++;
      else if (status === 'suspended') stats.suspendidas++;

      const vence = c.trialEndsAt || c.expiresAt;
      if (vence) {
        const d = vence.toDate ? vence.toDate() : new Date(vence);
        const dias = Math.ceil((d - now) / 86_400_000);
        if (dias >= 0 && dias <= 30) {
          stats.proximosVencer.push({
            id: c.id,
            businessName: c.businessName || c.businessKey || c.id,
            diasRestantes: dias,
            status,
            venceEn: d.toISOString(),
          });
        }
      }
    });

    stats.proximosVencer.sort((a, b) => a.diasRestantes - b.diasRestantes);

    solSnap.docs.forEach(d => {
      if ((d.data().status || '') === 'pendiente') stats.solicitudesPendientes++;
    });

    const recientes = [...clientes]
      .sort((a, b) => {
        const da = a.syncedAt?.toDate?.() || a.createdAt?.toDate?.() || new Date(0);
        const db2 = b.syncedAt?.toDate?.() || b.createdAt?.toDate?.() || new Date(0);
        return db2 - da;
      })
      .slice(0, 8)
      .map(c => ({
        id: c.id,
        businessName: c.businessName || c.businessKey || '—',
        status: c.status || 'trial',
        planCode: c.planCode || c.plan_code || '—',
        syncedAt: c.syncedAt || c.createdAt || null,
      }));

    res.json({ stats, recientes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// CLIENTES
// ══════════════════════════════════════════════════════════════════════

app.get('/api/clientes', requireAuth, async (req, res) => {
  try {
    const snap = await col(COL_LICENCIAS)
      .where('contadorId', '==', req.contador.contadorDocId)
      .get();

    const list = snap.docs.map(docData).map(c => ({
      ...c,
      diasRestantes: daysFromNow(vencimientoDate(c)),
    })).sort((a, b) => String(a.businessName || '').localeCompare(String(b.businessName || '')));

    const q = String(req.query.q || '').trim().toLowerCase();
    const filtered = q
      ? list.filter(c =>
          (c.businessName || '').toLowerCase().includes(q) ||
          (c.rnc          || '').toLowerCase().includes(q) ||
          (c.propietario  || '').toLowerCase().includes(q) ||
          (c.correo       || '').toLowerCase().includes(q)
        )
      : list;

    res.json(filtered);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clientes/:id', requireAuth, async (req, res) => {
  try {
    const doc = await col(COL_LICENCIAS).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const data = docData(doc);
    if (data.contadorId !== req.contador.contadorDocId) {
      return res.status(403).json({ error: 'No tienes acceso a este cliente.' });
    }
    data.diasRestantes = daysFromNow(data.trialEndsAt || data.expiresAt);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ══════════════════════════════════════════════════════════════════════
// LICENCIAS (historial, solo lectura)
// ══════════════════════════════════════════════════════════════════════

app.get('/api/licencias/:businessId', requireAuth, async (req, res) => {
  try {
    // Verificar que el cliente pertenece al contador
    const bizDoc = await col(COL_LICENCIAS).doc(req.params.businessId).get();
    if (!bizDoc.exists || bizDoc.data().contadorId !== req.contador.contadorDocId) {
      return res.status(403).json({ error: 'No tienes acceso a este cliente.' });
    }

    const snap = await col(COL_HISTORIAL).where('business_id', '==', req.params.businessId).get();
    const sorted = snap.docs.map(docData)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 50);
    res.json(sorted);
  } catch (_e) { res.json([]); }
});

// ══════════════════════════════════════════════════════════════════════
// SOLICITUDES
// ══════════════════════════════════════════════════════════════════════

app.get('/api/solicitudes', requireAuth, async (req, res) => {
  try {
    const snap = await col(COL_SOLICITUDES)
      .where('contadorId', '==', req.contador.contadorDocId)
      .get();
    const sorted = snap.docs.map(docData)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 100);

    const q = req.query.status;
    res.json(q ? sorted.filter(s => s.status === q) : sorted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/solicitudes', requireAuth, async (req, res) => {
  const TIPOS = [
    'activar_licencia', 'renovar_licencia', 'cambiar_plan', 'soporte_tecnico',
    'error_sistema', 'actualizacion', 'facturacion_electronica', 'solicitud_especial',
  ];
  const { tipo, businessId, businessName, descripcion } = req.body;
  if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de solicitud inválido.' });
  if (!descripcion)          return res.status(400).json({ error: 'Descripción es requerida.' });

  try {
    if (businessId) {
      const bizDoc = await col(COL_LICENCIAS).doc(businessId).get();
      if (!bizDoc.exists || bizDoc.data().contadorId !== req.contador.contadorDocId) {
        return res.status(403).json({ error: 'No tienes acceso a ese negocio.' });
      }
    }

    const ref = await col(COL_SOLICITUDES).add({
      contadorId:    req.contador.contadorDocId,
      contadorNombre: req.contador.nombre_firma,
      businessId:    businessId    || null,
      businessName:  businessName  || null,
      tipo,
      status:        'pendiente',
      descripcion,
      created_at:    isoNow(),
      updated_at:    isoNow(),
    });

    const doc = await ref.get();
    res.status(201).json(docData(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cancelar solicitud propia
app.put('/api/solicitudes/:id/cancelar', requireAuth, async (req, res) => {
  try {
    const doc = await col(COL_SOLICITUDES).doc(req.params.id).get();
    if (!doc.exists || doc.data().contadorId !== req.contador.contadorDocId) {
      return res.status(403).json({ error: 'No puedes modificar esta solicitud.' });
    }
    if (doc.data().status !== 'pendiente') {
      return res.status(400).json({ error: 'Solo puedes cancelar solicitudes pendientes.' });
    }
    await col(COL_SOLICITUDES).doc(req.params.id).update({ status: 'cancelada', updated_at: isoNow() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// PRODUCTOS PENDIENTES
// El contador agrega un producto nuevo aquí, pero el POS del cliente corre
// local en su propia computadora — no hay forma de escribirle directo. Esto
// queda en cola bajo el propio doc de licencias del negocio
// (licencias/{businessId}/productos_pendientes) y lo aplica el POS del
// cliente la próxima vez que sincronice (abrir/cerrar caja o una venta —
// ver server/sync/apply-pending-products.js del POS). Solo "agregar
// producto nuevo" por ahora — no edición/eliminación en esta primera
// versión. branchId es opcional (vacío = global, visible en todas las
// sucursales); las opciones de sucursal vienen del campo `sucursales` que
// el POS ya sincroniza en el doc de licencias (server/sync/sync-pos-stats.js).
// ══════════════════════════════════════════════════════════════════════

app.get('/api/productos-pendientes/:businessId', requireAuth, async (req, res) => {
  try {
    const bizDoc = await col(COL_LICENCIAS).doc(req.params.businessId).get();
    if (!bizDoc.exists || bizDoc.data().contadorId !== req.contador.contadorDocId) {
      return res.status(403).json({ error: 'No tienes acceso a ese negocio.' });
    }
    const snap = await col(COL_LICENCIAS).doc(req.params.businessId).collection('productos_pendientes').get();
    // No mandar imagenData completa en la lista (payload pesado, innecesario
    // para la tabla de estado) — solo si tiene o no.
    const sorted = snap.docs.map((d) => {
      const row = docData(d);
      row.tieneImagen = Boolean(row.imagenData);
      delete row.imagenData;
      return row;
    }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json(sorted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/productos-pendientes', requireAuth, async (req, res) => {
  const { businessId, codigo, nombre, categoria, marca, unidad, saleMode,
          precioCompra, precioVenta, stock, stockMin, aplicaItbis, branchId, imagenData } = req.body;

  if (!businessId) return res.status(400).json({ error: 'Selecciona un negocio.' });
  if (!codigo || !String(codigo).trim())   return res.status(400).json({ error: 'El código es obligatorio.' });
  if (!nombre || !String(nombre).trim())   return res.status(400).json({ error: 'El nombre es obligatorio.' });
  // Firestore rechaza documentos de más de 1 MB — el navegador ya redimensiona
  // a 900px/JPEG antes de mandarla, así que si aun así pasa de ~700KB (base64
  // infla ~33% el tamaño real) algo salió mal; mejor avisar claro que dejar
  // que falle la escritura entera sin explicación.
  if (imagenData && String(imagenData).length > 700_000) {
    return res.status(400).json({ error: 'La imagen es demasiado grande. Intenta con otra más pequeña.' });
  }

  try {
    const bizDoc = await col(COL_LICENCIAS).doc(businessId).get();
    if (!bizDoc.exists || bizDoc.data().contadorId !== req.contador.contadorDocId) {
      return res.status(403).json({ error: 'No tienes acceso a ese negocio.' });
    }

    // Si eligieron sucursal, validar contra la lista real sincronizada por el
    // POS (no confiar en lo que mande el navegador) — evita guardar un
    // branchId inventado o de una sucursal ya eliminada.
    let branchNombre = null;
    const normalizedBranchId = branchId ? Number(branchId) : null;
    if (normalizedBranchId) {
      const sucursales = Array.isArray(bizDoc.data().sucursales) ? bizDoc.data().sucursales : [];
      const match = sucursales.find((s) => Number(s.id) === normalizedBranchId);
      if (!match) return res.status(400).json({ error: 'Esa sucursal ya no existe o no está sincronizada. Refresca e intenta de nuevo.' });
      branchNombre = match.nombre;
    }

    const ref = await col(COL_LICENCIAS).doc(businessId).collection('productos_pendientes').add({
      codigo:        String(codigo).trim(),
      nombre:        String(nombre).trim(),
      categoria:     categoria || 'General',
      marca:         marca || '',
      unidad:        unidad || 'Unidad',
      saleMode:      saleMode || 'unidad',
      precioCompra:  Number(precioCompra || 0),
      precioVenta:   Number(precioVenta || 0),
      stock:         Number(stock || 0),
      stockMin:      Number(stockMin || 0),
      aplicaItbis:   Boolean(aplicaItbis),
      branchId:      normalizedBranchId,
      branchNombre,
      imagenData:    imagenData || null,
      status:        'pendiente',
      contadorId:    req.contador.contadorDocId,
      contadorNombre: req.contador.nombre_firma,
      createdAt:     isoNow(),
      updatedAt:     isoNow(),
    });

    const doc = await ref.get();
    res.status(201).json(docData(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// PERFIL
// ══════════════════════════════════════════════════════════════════════

app.get('/api/perfil', requireAuth, async (req, res) => {
  try {
    const snap = await col(COL_CONTADORES).where('firebase_uid', '==', req.contador.uid).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'Perfil no encontrado.' });
    res.json(docData(snap.docs[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/perfil', requireAuth, async (req, res) => {
  const CAMPOS_PERMITIDOS = ['nombre_firma', 'responsable', 'direccion', 'correo', 'telefono', 'whatsapp', 'logo_url'];
  const updates = {};
  for (const campo of CAMPOS_PERMITIDOS) {
    if (req.body[campo] !== undefined) updates[campo] = req.body[campo] || null;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No hay campos válidos para actualizar.' });
  updates.updated_at = isoNow();

  try {
    await col(COL_CONTADORES).doc(req.contador.contadorDocId).update(updates);
    if (updates.nombre_firma) {
      col(COL_ADMINS).doc(req.contador.uid).update({ fullName: updates.nombre_firma }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// ACTUALIZACIONES (solo lectura)
// ══════════════════════════════════════════════════════════════════════

app.get('/api/actualizaciones', requireAuth, async (_req, res) => {
  try {
    const GITHUB_OWNER = process.env.GITHUB_OWNER || 'elfavoritord';
    const GITHUB_REPO  = process.env.GITHUB_REPO_CONTADORES || 'tecnocaja-contadores';
    const ghUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=20`;

    const https = require('https');
    const data  = await new Promise((resolve, reject) => {
      const opts = {
        headers: {
          'User-Agent': 'TecnoCajaContadores',
          Accept: 'application/vnd.github.v3+json',
          ...(process.env.GH_TOKEN ? { Authorization: `token ${process.env.GH_TOKEN}` } : {}),
        },
      };
      https.get(ghUrl, opts, (r) => {
        let raw = '';
        r.on('data', c => { raw += c; });
        r.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch { resolve([]); }
        });
      }).on('error', reject);
    });

    if (!Array.isArray(data)) return res.json([]);

    const releases = data.map(r => ({
      version:       r.tag_name?.replace(/^v/, '') || r.name,
      tag:           r.tag_name,
      descripcion:   r.body?.split('\n').slice(0, 3).join(' ').trim() || '',
      created_at:    r.published_at || r.created_at,
      url:           r.html_url,
      es_obligatoria: false,
      prerelease:    r.prerelease || false,
    }));

    res.json(releases);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// REPORTES (solo lectura — datos sincronizados desde el POS)
// ══════════════════════════════════════════════════════════════════════

app.get('/api/reportes/:businessId', requireAuth, async (req, res) => {
  try {
    const doc = await col(COL_LICENCIAS).doc(req.params.businessId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Negocio no encontrado.' });
    const data = docData(doc);
    if (data.contadorId !== req.contador.contadorDocId) {
      return res.status(403).json({ error: 'No tienes acceso a este negocio.' });
    }

    // Extraer stats sincronizados desde el POS (campo 'posStats' en el doc de licencias)
    const stats = data.posStats || {};

    res.json({
      negocio: {
        id:           data.id,
        businessName: data.businessName || data.businessKey || '—',
        rnc:          data.rnc          || '—',
        propietario:  data.propietario  || '—',
        correo:       data.correo       || '—',
        telefono:     data.telefono     || '—',
        status:       data.status       || 'trial',
        planCode:     data.planCode     || data.plan_code || '—',
        syncedAt:     data.syncedAt     || data.updatedAt || null,
        hasPosData:   !!data.posStats,
        sucursales:   Array.isArray(data.sucursales) ? data.sucursales : [],
      },
      stats: {
        ventasHoy:       stats.ventasHoy       ?? 0,
        ventasMes:       stats.ventasMes       ?? 0,
        facturasEmitidas: stats.facturasEmitidas ?? 0,
        itbisMes:        stats.itbisMes        ?? 0,
        productosActivos: stats.productosActivos ?? 0,
        bajoInventario:  stats.bajoInventario  ?? 0,
        cxcPendiente:    stats.cxcPendiente    ?? 0,
        ultimaSync:      stats.ultimaSync      || data.syncedAt || null,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reportes/:businessId/datos', requireAuth, async (req, res) => {
  try {
    const doc = await col(COL_LICENCIAS).doc(req.params.businessId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Negocio no encontrado.' });
    const data = docData(doc);
    if (data.contadorId !== req.contador.contadorDocId) {
      return res.status(403).json({ error: 'No tienes acceso a este negocio.' });
    }

    const tab    = String(req.query.tab   || 'ventas');
    const desde  = req.query.desde  ? String(req.query.desde)  : null;
    const hasta  = req.query.hasta  ? String(req.query.hasta)  : null;
    const metodo = req.query.metodo ? String(req.query.metodo) : null;
    const ncf    = req.query.ncf    ? String(req.query.ncf)    : null;

    // Leer desde sub-colección reportes/{tab} (escrita por sync-pos-stats.js del POS)
    const tabDoc = await col(COL_LICENCIAS)
      .doc(req.params.businessId)
      .collection('reportes')
      .doc(tab)
      .get();

    const hasPosData = data.posStats || tabDoc.exists;
    let rows = tabDoc.exists ? (tabDoc.data().rows || []) : [];

    // Aplicar filtros del cliente
    if (desde) rows = rows.filter(r => r.fecha && r.fecha >= desde);
    if (hasta) rows = rows.filter(r => r.fecha && r.fecha <= hasta + 'T23:59:59');
    if (metodo && tab === 'ventas')   rows = rows.filter(r => r.metodo_pago === metodo);
    if (ncf    && tab === 'facturas') rows = rows.filter(r => (r.ncf || '').startsWith(ncf));

    res.json({ tab, total: rows.length, rows, hasPosData: !!hasPosData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// CONTABILIDAD — Sistema Contable (Fase 1)
// ══════════════════════════════════════════════════════════════════════
// Genera asientos automáticamente a partir de licencias/{businessId}/contabilidad_raw/{tab}
// (escrito por sync-pos-stats.js del POS en cada venta / apertura / cierre de
// caja). Cada negocio tiene su propio Plan de Cuentas y libro de asientos,
// anidados igual que licencias/{id}/reportes/{tab}.
//
// Reglas de mapeo automático (documentadas aquí porque no son obvias):
//  - Venta: Debe Caja/CxC según método de pago; Haber Ventas + Haber ITBIS
//    por Pagar; si hay costo de venta, Debe Costo de Ventas / Haber Inventario.
//  - Compra: Debe Inventario + Debe ITBIS Adelantado, Haber Cuentas por Pagar
//    (el pago real al suplidor no se seguimiento aparte en esta fase).
//  - Gasto: depende del tipo — "Pago suplidor" reduce Cuentas por Pagar,
//    "Retiro de efectivo" es Retiros del Propietario, "Devolución" es contra
//    Ventas; el resto (sin categoría contable real en el POS) va a "Gastos
//    por Clasificar" para que el contador lo reclasifique una vez.
//  - Cierre de caja: solo genera asiento si hay sobrante/faltante
//    (difference_amount ≠ 0) — las ventas ya generaron su propio asiento.

const CTB_ACCOUNT_TYPES = ['activo', 'pasivo', 'capital', 'ingreso', 'costo', 'gasto'];
const CTB_DEBIT_NORMAL = new Set(['activo', 'costo', 'gasto']);

const CTB_STARTER_CHART = [
  { code: '1000', name: 'ACTIVOS', type: 'activo' },
  { code: '1100', name: 'Caja General', type: 'activo', parent: '1000', corriente: true },
  { code: '1110', name: 'Bancos', type: 'activo', parent: '1000', corriente: true },
  { code: '1200', name: 'Cuentas por Cobrar Clientes', type: 'activo', parent: '1000', corriente: true },
  { code: '1300', name: 'Inventario de Mercancías', type: 'activo', parent: '1000', corriente: true },
  { code: '1400', name: 'ITBIS Adelantado (Crédito Fiscal)', type: 'activo', parent: '1000', corriente: true },
  { code: '1700', name: 'Mobiliario y Equipo', type: 'activo', parent: '1000', corriente: false },
  { code: '1710', name: 'Depreciación Acumulada Mobiliario y Equipo', type: 'activo', parent: '1000', corriente: false },

  { code: '2000', name: 'PASIVOS', type: 'pasivo' },
  { code: '2100', name: 'Cuentas por Pagar Suplidores', type: 'pasivo', parent: '2000', corriente: true },
  { code: '2200', name: 'ITBIS por Pagar (Débito Fiscal)', type: 'pasivo', parent: '2000', corriente: true },
  { code: '2300', name: 'Impuesto Sobre la Renta por Pagar (IR-17)', type: 'pasivo', parent: '2000', corriente: true },
  { code: '2400', name: 'Prestaciones Laborales por Pagar', type: 'pasivo', parent: '2000', corriente: true },
  { code: '2500', name: 'Préstamos por Pagar a Largo Plazo', type: 'pasivo', parent: '2000', corriente: false },

  { code: '3000', name: 'CAPITAL', type: 'capital' },
  { code: '3100', name: 'Capital Social', type: 'capital', parent: '3000' },
  { code: '3200', name: 'Utilidades Retenidas', type: 'capital', parent: '3000' },
  { code: '3300', name: 'Superávit por Revaluación', type: 'capital', parent: '3000' },
  { code: '3400', name: 'Retiros del Propietario', type: 'capital', parent: '3000' },

  { code: '4000', name: 'INGRESOS', type: 'ingreso' },
  { code: '4100', name: 'Ventas de Contado', type: 'ingreso', parent: '4000' },
  { code: '4150', name: 'Ventas a Crédito', type: 'ingreso', parent: '4000' },
  { code: '4200', name: 'Devoluciones y Descuentos en Ventas', type: 'ingreso', parent: '4000' },
  { code: '4900', name: 'Otros Ingresos (Sobrante de Caja)', type: 'ingreso', parent: '4000' },

  { code: '5000', name: 'COSTOS', type: 'costo' },
  { code: '5100', name: 'Costo de Ventas', type: 'costo', parent: '5000' },

  { code: '6000', name: 'GASTOS OPERATIVOS', type: 'gasto' },
  { code: '6100', name: 'Sueldos y Salarios', type: 'gasto', parent: '6000' },
  { code: '6200', name: 'Alquiler', type: 'gasto', parent: '6000' },
  { code: '6300', name: 'Servicios (Luz, Agua, Teléfono)', type: 'gasto', parent: '6000' },
  { code: '6600', name: 'Gasto de Depreciación', type: 'gasto', parent: '6000' },
  { code: '6700', name: 'Pérdida en Baja de Activos', type: 'gasto', parent: '6000' },
  { code: '6800', name: 'Pérdida por Deterioro de Activos', type: 'gasto', parent: '6000' },
  { code: '6900', name: 'Faltante de Caja', type: 'gasto', parent: '6000' },
  { code: '6990', name: 'Gastos por Clasificar', type: 'gasto', parent: '6000' },
  { code: '4800', name: 'Ganancia en Venta de Activos', type: 'ingreso', parent: '4000' },
];

function ctbRound2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }

async function ctbCheckAccess(req, businessId) {
  const doc = await col(COL_LICENCIAS).doc(businessId).get();
  if (!doc.exists) { const e = new Error('Negocio no encontrado.'); e.status = 404; throw e; }
  const data = docData(doc);
  if (data.contadorId !== req.contador.contadorDocId) {
    const e = new Error('No tienes acceso a este negocio.'); e.status = 403; throw e;
  }
  // Colaborador "dependiente": aunque el negocio sea del mismo despacho
  // contable, solo puede tocar la contabilidad de los clientes que tiene
  // asignados explícitamente (clientesAsignados) — no todo el despacho.
  const colab = req.colaborador;
  if (colab?.esColaborador && colab.esDependiente && !(colab.clientesAsignados || []).includes(businessId)) {
    const e = new Error('No tienes acceso a la contabilidad de este negocio.'); e.status = 403; throw e;
  }
  return data;
}

async function ctbEnsureCuentas(businessId) {
  const cuentasCol = col(COL_LICENCIAS).doc(businessId).collection('cuentas');
  const snap = await cuentasCol.get();
  const existentes = new Set(snap.docs.map((d) => d.id));
  // Siembra cualquier cuenta del catálogo base que todavía falte — no solo la
  // primera vez, para que negocios ya sembrados reciban cuentas agregadas
  // después (ej. 3300/6800) sin tocar ninguna cuenta que el contador ya tenga.
  const faltantes = CTB_STARTER_CHART.filter((acc) => !existentes.has(acc.code));
  if (!faltantes.length) return;
  const batch = db.batch();
  for (const acc of faltantes) {
    batch.set(cuentasCol.doc(acc.code), {
      code: acc.code, name: acc.name, accountType: acc.type,
      parentCode: acc.parent || null, corriente: acc.corriente ?? true,
      isSystem: true, isActive: true,
    });
  }
  await batch.commit();
}

function ctbCashOrArAccount(metodoPago) {
  const m = String(metodoPago || '').toLowerCase();
  if (m === 'credito' || m === 'contra_entrega') return '1200'; // Cuentas por Cobrar
  return '1100'; // Caja General (efectivo, tarjeta, transferencia, usd, mixto)
}

// Genera las líneas de un asiento a partir de una fila cruda. Devuelve null
// si la fila no debe generar asiento (ej. cierre sin diferencia).
function ctbBuildEntryFromRaw(tab, row) {
  if (tab === 'ventas') {
    const subtotal = ctbRound2(row.subtotal);
    const itbis = ctbRound2(row.itbis);
    const total = ctbRound2(row.total);
    const costoVenta = ctbRound2(row.costo_venta);
    const esCredito = String(row.metodo_pago || '').toLowerCase() === 'credito';
    const lineas = [
      { cuenta: ctbCashOrArAccount(row.metodo_pago), debe: total, haber: 0 },
      { cuenta: esCredito ? '4150' : '4100', debe: 0, haber: subtotal },
    ];
    if (itbis > 0) lineas.push({ cuenta: '2200', debe: 0, haber: itbis });
    if (costoVenta > 0) {
      lineas.push({ cuenta: '5100', debe: costoVenta, haber: 0 });
      lineas.push({ cuenta: '1300', debe: 0, haber: costoVenta });
    }
    return { fecha: row.fecha, descripcion: `Venta factura ${row.factura || row.id}`, lineas };
  }

  if (tab === 'compras') {
    const total = ctbRound2(row.total);
    const itbis = ctbRound2(row.itbis);
    const neto = ctbRound2(total - itbis);
    return {
      fecha: row.fecha, descripcion: `Compra factura ${row.numero || row.id} — ${row.proveedor || ''}`,
      lineas: [
        { cuenta: '1300', debe: neto, haber: 0 },
        ...(itbis > 0 ? [{ cuenta: '1400', debe: itbis, haber: 0 }] : []),
        { cuenta: '2100', debe: 0, haber: total },
      ],
    };
  }

  if (tab === 'gastos') {
    const monto = ctbRound2(row.monto);
    const categoria = String(row.categoria || '');
    let cuentaDebe = '6990'; // Gastos por Clasificar (default)
    if (categoria === 'Pago suplidor') cuentaDebe = '2100';
    else if (categoria === 'Retiro de efectivo') cuentaDebe = '3400';
    else if (categoria === 'Devolución') cuentaDebe = '4200';
    return {
      fecha: row.fecha, descripcion: row.descripcion || categoria || 'Gasto',
      lineas: [
        { cuenta: cuentaDebe, debe: monto, haber: 0 },
        { cuenta: '1100', debe: 0, haber: monto },
      ],
    };
  }

  if (tab === 'cierres') {
    const diff = ctbRound2(row.differenceAmount);
    if (diff === 0) return null; // cuadró exacto, nada que asentar
    const lineas = diff > 0
      ? [{ cuenta: '1100', debe: diff, haber: 0 }, { cuenta: '4900', debe: 0, haber: diff }]
      : [{ cuenta: '6900', debe: Math.abs(diff), haber: 0 }, { cuenta: '1100', debe: 0, haber: Math.abs(diff) }];
    return {
      fecha: row.closedAt || row.openedAt,
      descripcion: `Arqueo de caja — sesión #${row.sessionId} (${diff > 0 ? 'sobrante' : 'faltante'})`,
      lineas,
    };
  }

  return null;
}

app.post('/api/contabilidad/:businessId/generar', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    await ctbEnsureCuentas(businessId);

    const licRef = col(COL_LICENCIAS).doc(businessId);
    const rawCol = licRef.collection('contabilidad_raw');
    const metaRef = licRef.collection('contabilidad_meta').doc('estado');

    const [rawSnaps, metaDoc, periodosSnap] = await Promise.all([
      Promise.all(['ventas', 'compras', 'gastos', 'cierres'].map((tab) => rawCol.doc(tab).get())),
      metaRef.get(),
      licRef.collection('periodos').where('estado', '==', 'cerrado').get(),
    ]);
    const procesados = metaDoc.exists ? (metaDoc.data().procesados || {}) : {};
    const periodosCerrados = new Set(periodosSnap.docs.map((d) => d.id));

    const asientosCol = licRef.collection('asientos');
    let creados = 0;
    let omitidosPorPeriodoCerrado = 0;
    let omitidosPorDesbalance = 0;
    const nuevoProcesados = { ...procesados };

    for (let i = 0; i < 4; i++) {
      const tab = ['ventas', 'compras', 'gastos', 'cierres'][i];
      const doc = rawSnaps[i];
      if (!doc.exists) continue;
      const rows = doc.data().rows || [];
      const yaProcesados = new Set(procesados[tab] || []);
      const idsVisibles = [];

      for (const row of rows) {
        const rawId = tab === 'cierres' ? row.sessionId : row.id;
        const fechaRow = tab === 'cierres' ? (row.closedAt || row.openedAt) : row.fecha;
        const yaProcesado = yaProcesados.has(rawId);

        // Si el período ya está cerrado y la fila NUNCA se había procesado,
        // ni se procesa ni se marca como procesada — así que al reabrir el
        // período, se vuelve a considerar en la próxima generación. Pero si
        // la fila YA tenía un asiento generado antes de que el período se
        // cerrara, se debe seguir recordando como procesada aunque el
        // período esté cerrado — perder ese rastro es lo que duplicaba
        // asientos al reabrir un período ya contabilizado.
        if (periodosCerrados.has(String(fechaRow || '').slice(0, 7)) && !yaProcesado) {
          omitidosPorPeriodoCerrado++;
          continue;
        }

        if (yaProcesado) { idsVisibles.push(rawId); continue; }

        const built = ctbBuildEntryFromRaw(tab, row);
        if (!built) { idsVisibles.push(rawId); continue; }

        const sumDebe = ctbRound2(built.lineas.reduce((s, l) => s + (l.debe || 0), 0));
        const sumHaber = ctbRound2(built.lineas.reduce((s, l) => s + (l.haber || 0), 0));
        if (sumDebe !== sumHaber) {
          // Partida doble rota (ej. redondeo del POS) — no se guarda el
          // asiento desbalanceado ni se marca la fila como procesada, para
          // poder reintentar automáticamente en la próxima generación una
          // vez se corrija el dato de origen.
          omitidosPorDesbalance++;
          ctbAuditLog(businessId, req, 'asiento_automatico_desbalanceado',
            `${tab}#${rawId}: debe ${sumDebe} distinto de haber ${sumHaber} — asiento NO generado.`);
          continue;
        }

        idsVisibles.push(rawId);
        await asientosCol.add({
          fecha: built.fecha, descripcion: built.descripcion,
          origen: 'automatico', origenTab: tab, origenId: rawId,
          estado: 'contabilizado', lineas: built.lineas,
          totalDebe: sumDebe, totalHaber: sumHaber,
          createdAt: isoNow(),
        });
        creados++;
      }
      // Cada fila visible ya quedó procesada (venía de antes o se generó
      // arriba) — al guardar solo lo visible, lo que sale de la ventana de
      // 30 días del feed crudo deja de ocupar espacio en el set.
      nuevoProcesados[tab] = idsVisibles;
    }

    await metaRef.set({ procesados: nuevoProcesados, ultimaGeneracion: isoNow() }, { merge: true });
    if (creados > 0) ctbAuditLog(businessId, req, 'generar_asientos_automaticos', `${creados} asiento(s) nuevo(s)`);
    res.json({ ok: true, asientosCreados: creados, omitidosPorPeriodoCerrado, omitidosPorDesbalance });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/contabilidad/:businessId/cuentas', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    await ctbEnsureCuentas(businessId);
    const snap = await col(COL_LICENCIAS).doc(businessId).collection('cuentas').orderBy('code').get();
    res.json(snap.docs.map((d) => d.data()));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/contabilidad/:businessId/asientos', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { fecha, descripcion, lineas } = req.body || {};
    if (!fecha || !descripcion) return res.status(400).json({ error: 'Fecha y descripción son requeridas.' });
    if (!Array.isArray(lineas) || lineas.length < 2) {
      return res.status(400).json({ error: 'Un asiento necesita al menos dos líneas.' });
    }
    for (const l of lineas) {
      if ((Number(l.debe) > 0) === (Number(l.haber) > 0)) {
        return res.status(400).json({ error: 'Cada línea debe tener Debe o Haber, no ambos ni ninguno.' });
      }
    }
    const sumDebe = ctbRound2(lineas.reduce((s, l) => s + (Number(l.debe) || 0), 0));
    const sumHaber = ctbRound2(lineas.reduce((s, l) => s + (Number(l.haber) || 0), 0));
    if (sumDebe !== sumHaber) {
      return res.status(400).json({ error: `El asiento no está balanceado: Debe RD$${sumDebe.toFixed(2)} vs Haber RD$${sumHaber.toFixed(2)}.` });
    }
    const yyyymm = String(fecha).slice(0, 7);
    const periodoDoc = await col(COL_LICENCIAS).doc(businessId).collection('periodos').doc(yyyymm).get();
    if (periodoDoc.exists && periodoDoc.data().estado === 'cerrado') {
      return res.status(400).json({ error: `El período ${yyyymm} está cerrado. Reábrelo primero si necesitas contabilizar en esta fecha.` });
    }
    const ref = await col(COL_LICENCIAS).doc(businessId).collection('asientos').add({
      fecha, descripcion, origen: 'manual', estado: 'contabilizado',
      lineas: lineas.map((l) => ({ cuenta: l.cuenta, debe: ctbRound2(l.debe), haber: ctbRound2(l.haber), descripcion: l.descripcion || '', centroCosto: l.centroCosto || null })),
      totalDebe: sumDebe, totalHaber: sumHaber,
      creadoPor: req.contador.fullName || req.contador.email, createdAt: isoNow(),
    });
    ctbAuditLog(businessId, req, 'crear_asiento_manual', `${descripcion} (${fecha}) — ID ${ref.id}`);
    res.status(201).json({ ok: true, id: ref.id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.put('/api/contabilidad/:businessId/asientos/:id/anular', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    await col(COL_LICENCIAS).doc(businessId).collection('asientos').doc(req.params.id).update({
      estado: 'anulado', anuladoEn: isoNow(), motivoAnulacion: req.body?.motivo || null,
    });
    ctbAuditLog(businessId, req, 'anular_asiento', `ID ${req.params.id} — motivo: ${req.body?.motivo || 'sin especificar'}`);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/contabilidad/:businessId/diario', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { desde, hasta } = req.query;
    const snap = await col(COL_LICENCIAS).doc(businessId).collection('asientos').orderBy('fecha').get();
    let asientos = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => a.estado !== 'anulado');
    if (desde) asientos = asientos.filter((a) => a.fecha >= desde);
    if (hasta) asientos = asientos.filter((a) => a.fecha <= hasta + 'T23:59:59');
    res.json(asientos);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/contabilidad/:businessId/mayor/:cuentaCodigo', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { desde, hasta } = req.query;
    const cuentaCodigo = req.params.cuentaCodigo;

    const [cuentaDoc, asientosSnap] = await Promise.all([
      col(COL_LICENCIAS).doc(businessId).collection('cuentas').doc(cuentaCodigo).get(),
      col(COL_LICENCIAS).doc(businessId).collection('asientos').orderBy('fecha').get(),
    ]);
    if (!cuentaDoc.exists) return res.status(404).json({ error: 'Cuenta no encontrada.' });
    const cuenta = cuentaDoc.data();
    const esDebeNormal = CTB_DEBIT_NORMAL.has(cuenta.accountType);

    let openingBalance = 0;
    const filas = [];
    for (const doc of asientosSnap.docs) {
      const a = doc.data();
      if (a.estado === 'anulado') continue;
      for (const l of a.lineas || []) {
        if (l.cuenta !== cuentaCodigo) continue;
        const delta = esDebeNormal ? (Number(l.debe) - Number(l.haber)) : (Number(l.haber) - Number(l.debe));
        if (desde && a.fecha < desde) { openingBalance = ctbRound2(openingBalance + delta); continue; }
        if (hasta && a.fecha > hasta + 'T23:59:59') continue;
        filas.push({ id: doc.id, fecha: a.fecha, descripcion: a.descripcion, debe: l.debe, haber: l.haber, delta });
      }
    }
    let running = openingBalance;
    const rows = filas.map((f) => { running = ctbRound2(running + f.delta); return { ...f, saldo: running }; });
    res.json({ cuenta, openingBalance, rows, closingBalance: running });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/contabilidad/:businessId/balance-comprobacion', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { desde, hasta } = req.query;

    const [cuentasSnap, asientosSnap] = await Promise.all([
      col(COL_LICENCIAS).doc(businessId).collection('cuentas').orderBy('code').get(),
      col(COL_LICENCIAS).doc(businessId).collection('asientos').get(),
    ]);
    const cuentas = cuentasSnap.docs.map((d) => d.data());
    const totales = new Map(cuentas.map((c) => [c.code, { debe: 0, haber: 0 }]));

    for (const doc of asientosSnap.docs) {
      const a = doc.data();
      if (a.estado === 'anulado') continue;
      if (desde && a.fecha < desde) continue;
      if (hasta && a.fecha > hasta + 'T23:59:59') continue;
      for (const l of a.lineas || []) {
        const t = totales.get(l.cuenta);
        if (!t) continue;
        t.debe = ctbRound2(t.debe + Number(l.debe || 0));
        t.haber = ctbRound2(t.haber + Number(l.haber || 0));
      }
    }

    const rows = [];
    let totalDebe = 0, totalHaber = 0;
    for (const c of cuentas) {
      const t = totales.get(c.code);
      if (!t || (t.debe === 0 && t.haber === 0)) continue;
      const saldo = CTB_DEBIT_NORMAL.has(c.accountType) ? ctbRound2(t.debe - t.haber) : ctbRound2(t.haber - t.debe);
      rows.push({ code: c.code, name: c.name, accountType: c.accountType, totalDebe: t.debe, totalHaber: t.haber, saldo });
      totalDebe = ctbRound2(totalDebe + t.debe);
      totalHaber = ctbRound2(totalHaber + t.haber);
    }
    res.json({ rows, totales: { totalDebe, totalHaber } });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Helpers compartidos por Estado de Resultados / Balance General / Flujo ──

async function ctbFetchCuentasYAsientos(businessId) {
  const [cuentasSnap, asientosSnap] = await Promise.all([
    col(COL_LICENCIAS).doc(businessId).collection('cuentas').orderBy('code').get(),
    col(COL_LICENCIAS).doc(businessId).collection('asientos').orderBy('fecha').get(),
  ]);
  return {
    cuentas: cuentasSnap.docs.map((d) => d.data()),
    asientos: asientosSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => a.estado !== 'anulado'),
  };
}

function ctbSumPorCuenta(asientos, { desde, hasta } = {}) {
  const totales = new Map();
  for (const a of asientos) {
    if (desde && a.fecha < desde) continue;
    if (hasta && a.fecha > hasta + 'T23:59:59') continue;
    for (const l of a.lineas || []) {
      if (!totales.has(l.cuenta)) totales.set(l.cuenta, { debe: 0, haber: 0 });
      const t = totales.get(l.cuenta);
      t.debe = ctbRound2(t.debe + Number(l.debe || 0));
      t.haber = ctbRound2(t.haber + Number(l.haber || 0));
    }
  }
  return totales;
}

// Saldo neto (con signo correcto según si la cuenta es normal-débito o
// normal-crédito) de un grupo de códigos de cuenta específicos.
function ctbSaldoCuentas(cuentas, totales, codigos) {
  const set = new Set(codigos);
  let saldo = 0;
  for (const c of cuentas) {
    if (!set.has(c.code)) continue;
    const t = totales.get(c.code) || { debe: 0, haber: 0 };
    saldo += CTB_DEBIT_NORMAL.has(c.accountType) ? (t.debe - t.haber) : (t.haber - t.debe);
  }
  return ctbRound2(saldo);
}

// Utilidad neta del período (Estado de Resultados) reutilizada por el
// Balance General para plegar el resultado del ejercicio en el patrimonio.
function ctbCalcularUtilidadNeta(cuentas, totales) {
  const ventasNetas = ctbSaldoCuentas(cuentas, totales, ['4100', '4150', '4200']);
  const costoVentas = ctbSaldoCuentas(cuentas, totales, ['5100']);
  const utilidadBruta = ctbRound2(ventasNetas - costoVentas);
  const gastosOperativos = ctbSaldoCuentas(
    cuentas, totales,
    cuentas.filter((c) => c.accountType === 'gasto' && c.code !== '6900').map((c) => c.code)
  );
  const utilidadOperativa = ctbRound2(utilidadBruta - gastosOperativos);
  const otrosIngresos = ctbSaldoCuentas(cuentas, totales, ['4900']);
  const otrosGastos = ctbSaldoCuentas(cuentas, totales, ['6900']);
  const utilidadNeta = ctbRound2(utilidadOperativa + otrosIngresos - otrosGastos);
  return { ventasNetas, costoVentas, utilidadBruta, gastosOperativos, utilidadOperativa, otrosIngresos, otrosGastos, utilidadNeta };
}

app.get('/api/contabilidad/:businessId/estado-resultados', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { desde, hasta } = req.query;
    const { cuentas, asientos } = await ctbFetchCuentasYAsientos(businessId);
    const totales = ctbSumPorCuenta(asientos, { desde, hasta });
    res.json(ctbCalcularUtilidadNeta(cuentas, totales));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/contabilidad/:businessId/balance-general', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const hasta = req.query.hasta || new Date().toISOString().slice(0, 10);
    const { cuentas, asientos } = await ctbFetchCuentasYAsientos(businessId);

    // Saldos acumulados desde el inicio del negocio hasta la fecha de corte
    // (un balance general es una foto en el tiempo, no un rango).
    const totales = ctbSumPorCuenta(asientos, { hasta });

    function grupo(tipo, corriente) {
      return cuentas
        .filter((c) => c.accountType === tipo && (corriente === undefined || !!c.corriente === corriente))
        .map((c) => ({ code: c.code, name: c.name, saldo: ctbSaldoCuentas(cuentas, totales, [c.code]) }))
        .filter((c) => c.saldo !== 0);
    }

    const activosCorrientes = grupo('activo', true);
    const activosNoCorrientes = grupo('activo', false);
    const pasivosCorrientes = grupo('pasivo', true);
    const pasivosLargoPlazo = grupo('pasivo', false);
    const patrimonio = cuentas
      .filter((c) => c.accountType === 'capital')
      .map((c) => ({ code: c.code, name: c.name, saldo: ctbSaldoCuentas(cuentas, totales, [c.code]) }))
      .filter((c) => c.saldo !== 0);

    // Utilidad del ejercicio: resultado del año fiscal en curso (desde el 1
    // de enero del año de `hasta`), se pliega en el patrimonio para que
    // Activos = Pasivos + Patrimonio cuadre igual que en un balance real.
    const inicioAnio = `${hasta.slice(0, 4)}-01-01`;
    const totalesAnio = ctbSumPorCuenta(asientos, { desde: inicioAnio, hasta });
    const { utilidadNeta } = ctbCalcularUtilidadNeta(cuentas, totalesAnio);
    if (utilidadNeta !== 0) patrimonio.push({ code: '3900', name: 'Utilidad (Pérdida) del Ejercicio', saldo: utilidadNeta });

    const sum = (rows) => ctbRound2(rows.reduce((s, r) => s + r.saldo, 0));
    const totalActivos = ctbRound2(sum(activosCorrientes) + sum(activosNoCorrientes));
    const totalPasivos = ctbRound2(sum(pasivosCorrientes) + sum(pasivosLargoPlazo));
    const totalPatrimonio = sum(patrimonio);

    res.json({
      hasta,
      activos: { corrientes: activosCorrientes, noCorrientes: activosNoCorrientes, total: totalActivos },
      pasivos: { corrientes: pasivosCorrientes, largoPlazo: pasivosLargoPlazo, total: totalPasivos },
      patrimonio: { cuentas: patrimonio, total: totalPatrimonio },
      totalPasivoPatrimonio: ctbRound2(totalPasivos + totalPatrimonio),
      cuadra: Math.abs(totalActivos - ctbRound2(totalPasivos + totalPatrimonio)) < 0.01,
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/contabilidad/:businessId/flujo-efectivo', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { desde, hasta } = req.query;
    const { asientos } = await ctbFetchCuentasYAsientos(businessId);

    // Clasificación por el patrón de la contraparte del asiento — no hay
    // categorización explícita de actividad en el POS, así que se infiere
    // por qué otra cuenta se movió junto con Caja/Bancos en el mismo asiento.
    const CUENTAS_CAJA = new Set(['1100', '1110']);
    const CUENTAS_INVERSION = new Set(['1700', '1710']);
    const CUENTAS_FINANCIAMIENTO = new Set(['2500', '3100', '3400']);

    let operacion = 0, inversion = 0, financiamiento = 0;
    for (const a of asientos) {
      if (desde && a.fecha < desde) continue;
      if (hasta && a.fecha > hasta + 'T23:59:59') continue;
      const lineasCaja = (a.lineas || []).filter((l) => CUENTAS_CAJA.has(l.cuenta));
      if (!lineasCaja.length) continue;
      const otrasCuentas = (a.lineas || []).filter((l) => !CUENTAS_CAJA.has(l.cuenta)).map((l) => l.cuenta);
      let categoria = 'operacion';
      if (otrasCuentas.some((c) => CUENTAS_INVERSION.has(c))) categoria = 'inversion';
      else if (otrasCuentas.some((c) => CUENTAS_FINANCIAMIENTO.has(c))) categoria = 'financiamiento';

      for (const l of lineasCaja) {
        const monto = ctbRound2(Number(l.debe || 0) - Number(l.haber || 0));
        if (categoria === 'inversion') inversion = ctbRound2(inversion + monto);
        else if (categoria === 'financiamiento') financiamiento = ctbRound2(financiamiento + monto);
        else operacion = ctbRound2(operacion + monto);
      }
    }

    res.json({ operacion, inversion, financiamiento, neto: ctbRound2(operacion + inversion + financiamiento) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Indicadores Financieros (Reportes Gerenciales) ──────────────────────────
// Todo se deriva de cuentas/asientos ya existentes (mismos helpers que Balance
// General y Estado de Resultados) — no agrega ningún concepto de datos nuevo.
app.get('/api/contabilidad/:businessId/indicadores', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const hasta = req.query.hasta || new Date().toISOString().slice(0, 10);
    const { cuentas, asientos } = await ctbFetchCuentasYAsientos(businessId);

    // Saldos de Balance General a la fecha de corte (misma lógica que /balance-general)
    const totalesCorte = ctbSumPorCuenta(asientos, { hasta });
    const totalGrupo = (tipo, corriente) => ctbRound2(cuentas
      .filter((c) => c.accountType === tipo && (corriente === undefined || !!c.corriente === corriente))
      .reduce((s, c) => s + ctbSaldoCuentas(cuentas, totalesCorte, [c.code]), 0));

    const activoCorriente = totalGrupo('activo', true);
    const activoTotal = ctbRound2(activoCorriente + totalGrupo('activo', false));
    const pasivoCorriente = totalGrupo('pasivo', true);
    const pasivoTotal = ctbRound2(pasivoCorriente + totalGrupo('pasivo', false));
    const inventario = ctbSaldoCuentas(cuentas, totalesCorte, ['1300']);

    // Utilidad neta año-a-la-fecha (mismo criterio que Balance General para plegar el ejercicio)
    const inicioAnio = `${hasta.slice(0, 4)}-01-01`;
    const totalesAnio = ctbSumPorCuenta(asientos, { desde: inicioAnio, hasta });
    const pl = ctbCalcularUtilidadNeta(cuentas, totalesAnio);
    const patrimonioCuentas = totalGrupo('capital');
    const patrimonioTotal = ctbRound2(patrimonioCuentas + pl.utilidadNeta);

    const div = (a, b) => (b ? ctbRound2(a / b) : null);
    const liquidez = {
      razonCorriente: div(activoCorriente, pasivoCorriente),
      pruebaAcida: div(ctbRound2(activoCorriente - inventario), pasivoCorriente),
      capitalTrabajo: ctbRound2(activoCorriente - pasivoCorriente),
    };
    const rentabilidad = {
      margenBruto: div(pl.utilidadBruta, pl.ventasNetas),
      margenOperativo: div(pl.utilidadOperativa, pl.ventasNetas),
      margenNeto: div(pl.utilidadNeta, pl.ventasNetas),
      roa: div(pl.utilidadNeta, activoTotal),
      roe: div(pl.utilidadNeta, patrimonioTotal),
    };
    const endeudamiento = {
      razonEndeudamiento: div(pasivoTotal, activoTotal),
      deudaPatrimonio: div(pasivoTotal, patrimonioTotal),
      autonomia: div(patrimonioTotal, activoTotal),
    };

    // Comparativo mensual: un solo recorrido de asientos, agrupando por mes (YYYY-MM).
    // CUENTAS_CAJA replica la definición de /flujo-efectivo (Caja General + Bancos).
    const CUENTAS_CAJA = new Set(['1100', '1110']);
    const porMes = new Map();
    for (const a of asientos) {
      const mes = String(a.fecha).slice(0, 7);
      if (!porMes.has(mes)) porMes.set(mes, { totales: new Map(), flujoNeto: 0 });
      const bucket = porMes.get(mes);
      for (const l of a.lineas || []) {
        if (!bucket.totales.has(l.cuenta)) bucket.totales.set(l.cuenta, { debe: 0, haber: 0 });
        const t = bucket.totales.get(l.cuenta);
        t.debe = ctbRound2(t.debe + Number(l.debe || 0));
        t.haber = ctbRound2(t.haber + Number(l.haber || 0));
        if (CUENTAS_CAJA.has(l.cuenta)) bucket.flujoNeto = ctbRound2(bucket.flujoNeto + Number(l.debe || 0) - Number(l.haber || 0));
      }
    }
    const mesesOrdenados = [...porMes.keys()].sort().slice(-12);
    const comparativoMensual = mesesOrdenados.map((mes) => {
      const { totales, flujoNeto } = porMes.get(mes);
      const plMes = ctbCalcularUtilidadNeta(cuentas, totales);
      return {
        mes, flujoNeto,
        ventasNetas: plMes.ventasNetas,
        gastosOperativos: plMes.gastosOperativos,
        utilidadNeta: plMes.utilidadNeta,
      };
    });

    // Comparativo anual: agrupa el comparativo mensual ya calculado, sin recorrer de nuevo.
    const porAnio = new Map();
    for (const m of comparativoMensual) {
      const anio = m.mes.slice(0, 4);
      if (!porAnio.has(anio)) porAnio.set(anio, { anio, ventasNetas: 0, gastosOperativos: 0, utilidadNeta: 0 });
      const acc = porAnio.get(anio);
      acc.ventasNetas = ctbRound2(acc.ventasNetas + m.ventasNetas);
      acc.gastosOperativos = ctbRound2(acc.gastosOperativos + m.gastosOperativos);
      acc.utilidadNeta = ctbRound2(acc.utilidadNeta + m.utilidadNeta);
    }
    const comparativoAnual = [...porAnio.values()].sort((a, b) => a.anio.localeCompare(b.anio));

    // Flujo de caja proyectado: promedio simple del flujo neto de los últimos 3 meses con datos.
    const ultimosMeses = comparativoMensual.slice(-3);
    const flujoProyectado = ultimosMeses.length
      ? ctbRound2(ultimosMeses.reduce((s, m) => s + m.flujoNeto, 0) / ultimosMeses.length)
      : 0;

    res.json({
      hasta, liquidez, rentabilidad, endeudamiento,
      base: { activoCorriente, activoTotal, pasivoCorriente, pasivoTotal, patrimonioTotal, inventario },
      comparativoMensual, comparativoAnual, flujoProyectado,
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Períodos Contables y Cierre ─────────────────────────────────────────────
// Un período cerrado bloquea nuevos asientos (manuales o automáticos) con
// fecha dentro de ese mes — ver el chequeo en POST /asientos y en /generar.

app.get('/api/contabilidad/:businessId/periodos', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const snap = await col(COL_LICENCIAS).doc(businessId).collection('periodos').orderBy('__name__', 'desc').get();
    res.json(snap.docs.map((d) => ({ periodo: d.id, ...d.data() })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/contabilidad/:businessId/periodos/:yyyymm/cerrar', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const yyyymm = req.params.yyyymm;
    if (!/^\d{4}-\d{2}$/.test(yyyymm)) return res.status(400).json({ error: 'Período inválido, usa formato AAAA-MM.' });

    const desde = `${yyyymm}-01`;
    const hasta = `${yyyymm}-31`;
    const { cuentas, asientos } = await ctbFetchCuentasYAsientos(businessId);
    const totales = ctbSumPorCuenta(asientos, { desde, hasta });
    let totalDebe = 0, totalHaber = 0;
    for (const c of cuentas) {
      const t = totales.get(c.code) || { debe: 0, haber: 0 };
      totalDebe = ctbRound2(totalDebe + t.debe);
      totalHaber = ctbRound2(totalHaber + t.haber);
    }
    if (Math.abs(totalDebe - totalHaber) >= 0.01) {
      return res.status(400).json({ error: `No se puede cerrar: el período no cuadra (Debe ${totalDebe.toFixed(2)} vs Haber ${totalHaber.toFixed(2)}).` });
    }

    await col(COL_LICENCIAS).doc(businessId).collection('periodos').doc(yyyymm).set({
      estado: 'cerrado', tipo: 'mensual',
      cerradoEn: isoNow(), cerradoPor: req.contador.fullName || req.contador.email,
    });
    ctbAuditLog(businessId, req, 'cerrar_periodo', yyyymm);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/contabilidad/:businessId/periodos/:yyyymm/reabrir', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    await col(COL_LICENCIAS).doc(businessId).collection('periodos').doc(req.params.yyyymm).set({
      estado: 'abierto', reabiertoEn: isoNow(), reabiertoPor: req.contador.fullName || req.contador.email,
    }, { merge: true });
    ctbAuditLog(businessId, req, 'reabrir_periodo', req.params.yyyymm);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/contabilidad/:businessId/cierres', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const snap = await col(COL_LICENCIAS).doc(businessId).collection('cierres').orderBy('__name__', 'desc').get();
    res.json(snap.docs.map((d) => d.data()));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/contabilidad/:businessId/cierre-anual/:year', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const year = req.params.year;
    if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: 'Año inválido.' });

    const licRef = col(COL_LICENCIAS).doc(businessId);
    const yaExiste = await licRef.collection('cierres').doc(year).get();
    if (yaExiste.exists) {
      return res.status(400).json({ error: `El año ${year} ya fue cerrado el ${String(yaExiste.data().cerradoEn || '').slice(0, 10)}.` });
    }

    const { cuentas, asientos } = await ctbFetchCuentasYAsientos(businessId);
    const desde = `${year}-01-01`, hasta = `${year}-12-31`;
    const totales = ctbSumPorCuenta(asientos, { desde, hasta });
    const pl = ctbCalcularUtilidadNeta(cuentas, totales);

    // Asiento de cierre: salda cada cuenta temporal (ingreso/costo/gasto) a
    // cero y transfiere el resultado neto a Utilidades Retenidas (3200) —
    // el cierre clásico de partida doble, para que el año nuevo arranque
    // con las cuentas de resultado en cero.
    const lineasCierre = [];
    for (const c of cuentas) {
      if (!['ingreso', 'costo', 'gasto'].includes(c.accountType)) continue;
      const t = totales.get(c.code) || { debe: 0, haber: 0 };
      const saldo = CTB_DEBIT_NORMAL.has(c.accountType) ? ctbRound2(t.debe - t.haber) : ctbRound2(t.haber - t.debe);
      if (saldo === 0) continue;
      if (CTB_DEBIT_NORMAL.has(c.accountType)) lineasCierre.push({ cuenta: c.code, debe: 0, haber: Math.abs(saldo) });
      else lineasCierre.push({ cuenta: c.code, debe: Math.abs(saldo), haber: 0 });
    }
    if (!lineasCierre.length) {
      return res.status(400).json({ error: `No hay movimientos en cuentas de resultado para cerrar el año ${year}.` });
    }
    if (pl.utilidadNeta > 0) lineasCierre.push({ cuenta: '3200', debe: 0, haber: pl.utilidadNeta });
    else if (pl.utilidadNeta < 0) lineasCierre.push({ cuenta: '3200', debe: Math.abs(pl.utilidadNeta), haber: 0 });

    const sumDebe = ctbRound2(lineasCierre.reduce((s, l) => s + (l.debe || 0), 0));
    const sumHaber = ctbRound2(lineasCierre.reduce((s, l) => s + (l.haber || 0), 0));

    const asientoRef = await licRef.collection('asientos').add({
      fecha: `${year}-12-31`, descripcion: `Asiento de cierre del ejercicio ${year}`,
      origen: 'cierre_anual', estado: 'contabilizado', lineas: lineasCierre,
      totalDebe: sumDebe, totalHaber: sumHaber, createdAt: isoNow(),
    });

    const batch = db.batch();
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      batch.set(licRef.collection('periodos').doc(`${year}-${mm}`), {
        estado: 'cerrado', tipo: 'anual',
        cerradoEn: isoNow(), cerradoPor: req.contador.fullName || req.contador.email,
      });
    }
    batch.set(licRef.collection('cierres').doc(year), {
      year, utilidadNeta: pl.utilidadNeta, asientoCierreId: asientoRef.id,
      cerradoEn: isoNow(), cerradoPor: req.contador.fullName || req.contador.email,
    });
    await batch.commit();

    ctbAuditLog(businessId, req, 'cierre_anual', `Año ${year} — utilidad neta ${pl.utilidadNeta.toFixed(2)}`);
    res.json({ ok: true, utilidadNeta: pl.utilidadNeta, asientoCierreId: asientoRef.id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Activos Fijos y Depreciaciones ──────────────────────────────────────────
// Fase 1: solo línea recta. La depreciación empieza el mes SIGUIENTE a la
// fecha de compra (convención común) y nunca pasa de la vida útil ni deja el
// activo por debajo del valor residual.

function ctbPrimerMesDepreciacion(fechaCompra) {
  const [y, m] = String(fechaCompra).slice(0, 7).split('-').map(Number);
  const mm = m === 12 ? 1 : m + 1;
  const yy = m === 12 ? y + 1 : y;
  return `${yy}-${String(mm).padStart(2, '0')}`;
}
function ctbMesesEntre(desdeYYYYMM, hastaYYYYMM) {
  const [ya, ma] = desdeYYYYMM.split('-').map(Number);
  const [yb, mb] = hastaYYYYMM.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma) + 1;
}

app.get('/api/contabilidad/:businessId/activos-fijos', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const snap = await col(COL_LICENCIAS).doc(businessId).collection('activos_fijos').orderBy('fechaCompra', 'desc').get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/contabilidad/:businessId/activos-fijos', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { nombre, fechaCompra, costo, valorResidual, vidaUtilMeses, metodoDepreciacion } = req.body || {};
    if (!nombre || !fechaCompra || !(Number(costo) > 0) || !(Number(vidaUtilMeses) > 0)) {
      return res.status(400).json({ error: 'Nombre, fecha de compra, costo y vida útil (meses) son requeridos.' });
    }
    const ref = await col(COL_LICENCIAS).doc(businessId).collection('activos_fijos').add({
      nombre, fechaCompra, costo: ctbRound2(costo), valorResidual: ctbRound2(valorResidual || 0),
      vidaUtilMeses: Number(vidaUtilMeses),
      metodoDepreciacion: metodoDepreciacion === 'saldo_decreciente' ? 'saldo_decreciente' : 'linea_recta',
      mesesDepreciados: 0, depreciacionAcumulada: 0, estado: 'activo', createdAt: isoNow(),
    });
    ctbAuditLog(businessId, req, 'crear_activo_fijo', `${nombre} — costo ${ctbRound2(costo).toFixed(2)}`);
    res.status(201).json({ ok: true, id: ref.id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/contabilidad/:businessId/activos-fijos/:id/baja', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const licRef = col(COL_LICENCIAS).doc(businessId);
    const activoRef = licRef.collection('activos_fijos').doc(req.params.id);
    const activoDoc = await activoRef.get();
    if (!activoDoc.exists) return res.status(404).json({ error: 'Activo no encontrado.' });
    const activo = activoDoc.data();
    if (activo.estado === 'dado_de_baja') return res.status(400).json({ error: 'Este activo ya fue dado de baja.' });

    const { fecha, valorVenta, motivo } = req.body || {};
    if (!fecha) return res.status(400).json({ error: 'Fecha de baja requerida.' });

    // Prefiere el acumulado guardado (correcto también para saldo decreciente);
    // el cálculo con mesesDepreciados es solo respaldo para activos creados
    // antes de que este campo existiera (siempre línea recta).
    const depreciacionAcumulada = activo.depreciacionAcumulada != null
      ? activo.depreciacionAcumulada
      : ctbRound2((activo.mesesDepreciados || 0) * ((activo.costo - activo.valorResidual) / activo.vidaUtilMeses));
    const valorLibros = ctbRound2(activo.costo - depreciacionAcumulada);
    const venta = ctbRound2(valorVenta || 0);
    const resultado = ctbRound2(venta - valorLibros); // positivo = ganancia, negativo = pérdida

    const lineas = [
      { cuenta: '1710', debe: depreciacionAcumulada, haber: 0 }, // limpia la depreciación acumulada
    ];
    if (venta > 0) lineas.push({ cuenta: '1100', debe: venta, haber: 0 });
    if (resultado > 0) lineas.push({ cuenta: '4800', debe: 0, haber: resultado });
    else if (resultado < 0) lineas.push({ cuenta: '6700', debe: Math.abs(resultado), haber: 0 });
    lineas.push({ cuenta: '1700', debe: 0, haber: activo.costo }); // saca el activo al costo original

    const sumDebe = ctbRound2(lineas.reduce((s, l) => s + (l.debe || 0), 0));
    const sumHaber = ctbRound2(lineas.reduce((s, l) => s + (l.haber || 0), 0));

    const asientoRef = await licRef.collection('asientos').add({
      fecha, descripcion: `Baja de activo: ${activo.nombre}`,
      origen: 'baja_activo', estado: 'contabilizado', lineas,
      totalDebe: sumDebe, totalHaber: sumHaber, createdAt: isoNow(),
    });
    await activoRef.update({
      estado: 'dado_de_baja', fechaBaja: fecha, motivoBaja: motivo || null,
      valorVentaBaja: venta, resultadoBaja: resultado, asientoBajaId: asientoRef.id,
    });
    ctbAuditLog(businessId, req, 'baja_activo_fijo', `${activo.nombre} — resultado ${resultado.toFixed(2)}`);
    res.json({ ok: true, resultado, asientoBajaId: asientoRef.id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Doble saldo decreciente: tasa mensual = 2 / vida útil, aplicada al valor en
// libros vigente — a diferencia de línea recta, el monto cambia cada mes, así
// que hay que recorrer mes a mes desde el inicio para saber cuánto ya se había
// depreciado (mesesDesde) y cuánto es nuevo (mesesDesde, mesesHasta].
function ctbDepreciacionSaldoDecreciente(costo, valorResidual, vidaUtilMeses, mesesDesde, mesesHasta) {
  const tasaMensual = 2 / vidaUtilMeses;
  let valorLibros = costo;
  let acumuladoPrevio = 0;
  let montoNuevo = 0;
  for (let mes = 1; mes <= mesesHasta; mes++) {
    let dep = ctbRound2(valorLibros * tasaMensual);
    if (ctbRound2(valorLibros - dep) < valorResidual) dep = Math.max(0, ctbRound2(valorLibros - valorResidual));
    valorLibros = ctbRound2(valorLibros - dep);
    if (mes <= mesesDesde) acumuladoPrevio = ctbRound2(acumuladoPrevio + dep);
    else montoNuevo = ctbRound2(montoNuevo + dep);
  }
  return { montoNuevo, depreciacionAcumuladaTotal: ctbRound2(acumuladoPrevio + montoNuevo) };
}

app.post('/api/contabilidad/:businessId/activos-fijos/depreciar', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const hasta = req.body?.hasta || new Date().toISOString().slice(0, 7);

    const licRef = col(COL_LICENCIAS).doc(businessId);
    const snap = await licRef.collection('activos_fijos').where('estado', '==', 'activo').get();

    const lineasPorActivo = [];
    let totalDepreciacion = 0;
    const actualizaciones = [];

    for (const doc of snap.docs) {
      const a = doc.data();
      // fechaBaseDepreciacion existe solo si el activo fue revalorizado — la
      // revalorización "reinicia" el cálculo con el nuevo costo y la vida útil
      // restante, así que el mes de arranque también debe reiniciarse a la
      // fecha de la revalorización, no seguir contando desde la compra
      // original (eso disparaba toda la depreciación restante de un golpe).
      const primerMes = ctbPrimerMesDepreciacion(a.fechaBaseDepreciacion || a.fechaCompra);
      const mesesElegibles = Math.max(0, Math.min(a.vidaUtilMeses, ctbMesesEntre(primerMes, hasta)));
      const mesesPendientes = mesesElegibles - (a.mesesDepreciados || 0);
      if (mesesPendientes <= 0) continue;

      let monto, depreciacionAcumuladaTotal;
      if (a.metodoDepreciacion === 'saldo_decreciente') {
        const r = ctbDepreciacionSaldoDecreciente(a.costo, a.valorResidual, a.vidaUtilMeses, a.mesesDepreciados || 0, mesesElegibles);
        monto = r.montoNuevo;
        depreciacionAcumuladaTotal = r.depreciacionAcumuladaTotal;
      } else {
        const depreciacionMensual = ctbRound2((a.costo - a.valorResidual) / a.vidaUtilMeses);
        monto = ctbRound2(mesesPendientes * depreciacionMensual);
        depreciacionAcumuladaTotal = ctbRound2(((a.mesesDepreciados || 0) + mesesPendientes) * depreciacionMensual);
      }
      if (monto <= 0) continue;
      lineasPorActivo.push({ cuenta: '1710', debe: 0, haber: monto, descripcion: a.nombre });
      totalDepreciacion = ctbRound2(totalDepreciacion + monto);
      actualizaciones.push({ ref: doc.ref, mesesDepreciados: (a.mesesDepreciados || 0) + mesesPendientes, depreciacionAcumulada: depreciacionAcumuladaTotal });
    }

    if (!lineasPorActivo.length) {
      return res.json({ ok: true, asientoCreado: false, mensaje: 'No hay depreciación pendiente hasta este mes.' });
    }

    const lineas = [{ cuenta: '6600', debe: totalDepreciacion, haber: 0 }, ...lineasPorActivo];
    const asientoRef = await licRef.collection('asientos').add({
      fecha: `${hasta}-28`, descripcion: `Depreciación de activos fijos hasta ${hasta}`,
      origen: 'depreciacion', estado: 'contabilizado', lineas,
      totalDebe: totalDepreciacion, totalHaber: totalDepreciacion, createdAt: isoNow(),
    });

    const batch = db.batch();
    for (const u of actualizaciones) batch.update(u.ref, { mesesDepreciados: u.mesesDepreciados, depreciacionAcumulada: u.depreciacionAcumulada });
    await batch.commit();

    ctbAuditLog(businessId, req, 'generar_depreciacion', `Hasta ${hasta} — total ${totalDepreciacion.toFixed(2)} (${actualizaciones.length} activo(s))`);
    res.json({ ok: true, asientoCreado: true, totalDepreciacion, activosActualizados: actualizaciones.length, asientoId: asientoRef.id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/contabilidad/:businessId/activos-fijos/:id/revalorizar', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const licRef = col(COL_LICENCIAS).doc(businessId);
    const activoRef = licRef.collection('activos_fijos').doc(req.params.id);
    const activoDoc = await activoRef.get();
    if (!activoDoc.exists) return res.status(404).json({ error: 'Activo no encontrado.' });
    const activo = activoDoc.data();
    if (activo.estado !== 'activo') return res.status(400).json({ error: 'Solo se pueden revalorizar activos activos (no dados de baja).' });

    const { fecha, valorNuevo, motivo } = req.body || {};
    if (!fecha || !(Number(valorNuevo) > 0)) return res.status(400).json({ error: 'Fecha y nuevo valor son requeridos.' });
    if (Number(valorNuevo) <= activo.valorResidual) {
      return res.status(400).json({ error: `El nuevo valor debe ser mayor al valor residual (${Number(activo.valorResidual).toFixed(2)}).` });
    }

    const depreciacionAcumulada = activo.depreciacionAcumulada != null
      ? activo.depreciacionAcumulada
      : ctbRound2((activo.mesesDepreciados || 0) * ((activo.costo - activo.valorResidual) / activo.vidaUtilMeses));
    const valorLibrosActual = ctbRound2(activo.costo - depreciacionAcumulada);
    const nuevoValor = ctbRound2(valorNuevo);
    const ajuste = ctbRound2(nuevoValor - valorLibrosActual);
    if (ajuste === 0) return res.status(400).json({ error: 'El nuevo valor es igual al valor en libros actual; no hay ajuste que registrar.' });

    // Superávit por revaluación (alza) o pérdida por deterioro (baja) — tratamiento
    // simplificado, razonable para pymes: no distingue revaluaciones previas.
    const lineas = ajuste > 0
      ? [{ cuenta: '1700', debe: ajuste, haber: 0 }, { cuenta: '3300', debe: 0, haber: ajuste }]
      : [{ cuenta: '6800', debe: Math.abs(ajuste), haber: 0 }, { cuenta: '1700', debe: 0, haber: Math.abs(ajuste) }];

    const asientoRef = await licRef.collection('asientos').add({
      fecha, descripcion: `Revalorización de activo: ${activo.nombre} (${ajuste > 0 ? '+' : ''}${ajuste.toFixed(2)})`,
      origen: 'revalorizacion_activo', estado: 'contabilizado', lineas,
      totalDebe: Math.abs(ajuste), totalHaber: Math.abs(ajuste), createdAt: isoNow(),
    });

    // A partir de hoy, el activo "reinicia" con el nuevo valor como costo y se
    // sigue depreciando solo sobre lo que le queda de vida útil (no desde cero) —
    // así la misma fórmula de línea recta/saldo decreciente sigue funcionando sin
    // cambios, solo con una base y un denominador nuevos.
    const mesesRestantes = Math.max(1, activo.vidaUtilMeses - (activo.mesesDepreciados || 0));
    await activoRef.update({
      costo: nuevoValor, vidaUtilMeses: mesesRestantes, mesesDepreciados: 0, depreciacionAcumulada: 0,
      // Reinicia también el punto de partida que usa /activos-fijos/depreciar
      // (ctbPrimerMesDepreciacion) — sin esto, la próxima corrida de
      // depreciación calculaba los meses transcurridos desde la fechaCompra
      // ORIGINAL, que ya superaba la nueva vida útil restante, y depreciaba
      // todo el valor en libros de un solo golpe. fechaCompra se deja intacta
      // porque la tabla de activos la muestra como fecha de compra real.
      fechaBaseDepreciacion: fecha,
      ultimaRevalorizacion: { fecha, valorAnterior: valorLibrosActual, valorNuevo: nuevoValor, ajuste, motivo: motivo || null, asientoId: asientoRef.id },
    });

    ctbAuditLog(businessId, req, 'revalorizar_activo', `${activo.nombre} — ${valorLibrosActual.toFixed(2)} → ${nuevoValor.toFixed(2)} (ajuste ${ajuste.toFixed(2)})`);
    res.json({ ok: true, ajuste, asientoId: asientoRef.id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Auditoría ────────────────────────────────────────────────────────────
// Log de solo-lectura de acciones clave. Aislado a propósito (try/catch
// silencioso): nunca debe impedir que la acción real se complete.
async function ctbAuditLog(businessId, req, accion, detalle) {
  try {
    await col(COL_LICENCIAS).doc(businessId).collection('auditoria').add({
      accion, detalle: detalle || null,
      usuario: req.contador?.fullName || req.contador?.email || 'desconocido',
      fecha: isoNow(),
    });
  } catch (_e) { /* no debe romper la operación real */ }
}

app.get('/api/contabilidad/:businessId/auditoria', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const snap = await col(COL_LICENCIAS).doc(businessId).collection('auditoria').orderBy('fecha', 'desc').limit(200).get();
    res.json(snap.docs.map((d) => d.data()));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Centros de Costo ─────────────────────────────────────────────────────
// Dimensión opcional para asientos manuales (departamentos/sucursales/
// proyectos) — los asientos automáticos del POS no tienen esta noción, así
// que solo aplica a asientos creados a mano.

app.get('/api/contabilidad/:businessId/centros-costo', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const snap = await col(COL_LICENCIAS).doc(businessId).collection('centros_costo').orderBy('nombre').get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/contabilidad/:businessId/centros-costo', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { nombre, tipo } = req.body || {};
    if (!nombre) return res.status(400).json({ error: 'El nombre es requerido.' });
    const ref = await col(COL_LICENCIAS).doc(businessId).collection('centros_costo').add({
      nombre, tipo: tipo || 'departamento', createdAt: isoNow(),
    });
    res.status(201).json({ ok: true, id: ref.id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/contabilidad/:businessId/centros-costo/comparativo', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { desde, hasta } = req.query;
    const { asientos } = await ctbFetchCuentasYAsientos(businessId);
    const porCentro = new Map();
    for (const a of asientos) {
      if (desde && a.fecha < desde) continue;
      if (hasta && a.fecha > hasta + 'T23:59:59') continue;
      for (const l of a.lineas || []) {
        const centro = l.centroCosto || 'Sin asignar';
        if (!porCentro.has(centro)) porCentro.set(centro, { debe: 0, haber: 0 });
        const t = porCentro.get(centro);
        t.debe = ctbRound2(t.debe + Number(l.debe || 0));
        t.haber = ctbRound2(t.haber + Number(l.haber || 0));
      }
    }
    res.json(Array.from(porCentro.entries()).map(([centro, t]) => ({ centro, ...t })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Presupuesto ──────────────────────────────────────────────────────────
// Presupuesto anual por cuenta, prorrateado en partes iguales por mes para
// el comparativo — suficiente para un negocio pequeño sin estacionalidad
// compleja modelada aparte.

app.get('/api/contabilidad/:businessId/presupuesto/:year', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const snap = await col(COL_LICENCIAS).doc(businessId).collection('presupuestos').doc(req.params.year).get();
    res.json(snap.exists ? snap.data() : { year: req.params.year, cuentas: {} });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.put('/api/contabilidad/:businessId/presupuesto/:year', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { cuentas } = req.body || {}; // { '4100': 120000, '6200': 24000, ... } montos anuales
    if (!cuentas || typeof cuentas !== 'object') return res.status(400).json({ error: 'cuentas es requerido.' });
    await col(COL_LICENCIAS).doc(businessId).collection('presupuestos').doc(req.params.year).set({
      year: req.params.year, cuentas, updatedAt: isoNow(),
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/contabilidad/:businessId/presupuesto/:year/comparativo', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const year = req.params.year;
    const { desde, hasta } = req.query; // rango dentro del año a comparar (default: año completo)
    const rangoDesde = desde || `${year}-01-01`;
    const rangoHasta = hasta || `${year}-12-31`;

    const [presDoc, { cuentas, asientos }] = await Promise.all([
      col(COL_LICENCIAS).doc(businessId).collection('presupuestos').doc(year).get(),
      ctbFetchCuentasYAsientos(businessId),
    ]);
    const presupuestoCuentas = presDoc.exists ? (presDoc.data().cuentas || {}) : {};
    const totales = ctbSumPorCuenta(asientos, { desde: rangoDesde, hasta: rangoHasta });

    // Proporción del año cubierta por el rango, para prorratear el
    // presupuesto anual (ej. si se compara solo enero-marzo, 3/12 del total).
    const mesesEnRango = ctbMesesEntre(rangoDesde.slice(0, 7), rangoHasta.slice(0, 7));
    const proporcion = Math.min(1, mesesEnRango / 12);

    const rows = Object.entries(presupuestoCuentas).map(([code, montoAnual]) => {
      const cuenta = cuentas.find((c) => c.code === code);
      const real = ctbSaldoCuentas(cuentas, totales, [code]);
      const presupuestado = ctbRound2(Number(montoAnual) * proporcion);
      return {
        code, name: cuenta?.name || code, presupuestado, real,
        variacion: ctbRound2(real - presupuestado),
      };
    });
    res.json({ year, rangoDesde, rangoHasta, rows });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Configuración Contable ───────────────────────────────────────────────
app.get('/api/contabilidad/:businessId/configuracion', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const doc = await col(COL_LICENCIAS).doc(businessId).collection('contabilidad_config').doc('general').get();
    res.json(doc.exists ? doc.data() : { moneda: 'DOP', inicioAnioFiscal: 1 });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.put('/api/contabilidad/:businessId/configuracion', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { inicioAnioFiscal } = req.body || {};
    await col(COL_LICENCIAS).doc(businessId).collection('contabilidad_config').doc('general').set({
      moneda: 'DOP', // fijo por ahora — el sistema contable trabaja solo en pesos dominicanos
      inicioAnioFiscal: Number(inicioAnioFiscal) || 1,
      updatedAt: isoNow(),
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Conciliación Bancaria ────────────────────────────────────────────────
// Fase 1: una sola cuenta bancaria por negocio (1110 Bancos, ya existe en el
// Plan de Cuentas). La conciliación es un overlay que referencia asientos
// existentes por {asientoId, lineaIndex} — nunca modifica la colección
// `asientos`, para no tocar el motor contable ya verificado.
const CTB_CUENTA_BANCO = '1110';

// Movimientos del Mayor para la cuenta bancaria, con lineaIndex (a diferencia
// del endpoint /mayor/:cuentaCodigo que no lo necesita porque no empareja).
async function ctbMovimientosLibroBanco(businessId, desde, hasta) {
  const asientosSnap = await col(COL_LICENCIAS).doc(businessId).collection('asientos').orderBy('fecha').get();
  let openingBalance = 0;
  const rows = [];
  for (const doc of asientosSnap.docs) {
    const a = doc.data();
    if (a.estado === 'anulado') continue;
    (a.lineas || []).forEach((l, lineaIndex) => {
      if (l.cuenta !== CTB_CUENTA_BANCO) return;
      const delta = ctbRound2(Number(l.debe || 0) - Number(l.haber || 0)); // 1110 es cuenta de activo: debe suma
      if (desde && a.fecha < desde) { openingBalance = ctbRound2(openingBalance + delta); return; }
      if (hasta && a.fecha > hasta + 'T23:59:59') return;
      rows.push({ asientoId: doc.id, lineaIndex, fecha: a.fecha, descripcion: a.descripcion, debe: l.debe || 0, haber: l.haber || 0, monto: delta });
    });
  }
  const closingBalance = ctbRound2(openingBalance + rows.reduce((s, r) => s + r.monto, 0));
  return { rows, openingBalance, closingBalance };
}

async function ctbGetOrCreateConciliacion(businessId, yyyymm) {
  const ref = col(COL_LICENCIAS).doc(businessId).collection('conciliaciones').doc(yyyymm);
  const doc = await ref.get();
  if (doc.exists) return { ref, data: doc.data() };
  const data = {
    mes: yyyymm, cuentaCodigo: CTB_CUENTA_BANCO,
    saldoInicialBanco: 0, saldoFinalBanco: 0, estado: 'abierta',
    fechaCierre: null, cerradoPor: null,
  };
  await ref.set(data);
  return { ref, data };
}

app.get('/api/contabilidad/:businessId/conciliacion/:yyyymm', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const yyyymm = req.params.yyyymm;
    if (!/^\d{4}-\d{2}$/.test(yyyymm)) return res.status(400).json({ error: 'Mes inválido, usa formato AAAA-MM.' });

    const { data: conciliacion } = await ctbGetOrCreateConciliacion(businessId, yyyymm);
    const desde = `${yyyymm}-01`, hasta = `${yyyymm}-31`;
    const [{ rows: movimientosLibro }, movBancoSnap, matchesSnap] = await Promise.all([
      ctbMovimientosLibroBanco(businessId, desde, hasta),
      col(COL_LICENCIAS).doc(businessId).collection('conciliaciones').doc(yyyymm).collection('movimientos_banco').orderBy('fecha').get(),
      col(COL_LICENCIAS).doc(businessId).collection('conciliaciones').doc(yyyymm).collection('matches').get(),
    ]);
    const matches = matchesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const libroConciliado = new Set(matches.map((m) => `${m.asientoId}:${m.lineaIndex}`));
    const movimientosLibroConEstado = movimientosLibro.map((r) => ({
      ...r, conciliado: libroConciliado.has(`${r.asientoId}:${r.lineaIndex}`),
    }));
    const movimientosBanco = movBancoSnap.docs.map(docData);

    res.json({ conciliacion, movimientosLibro: movimientosLibroConEstado, movimientosBanco, matches });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.put('/api/contabilidad/:businessId/conciliacion/:yyyymm', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const yyyymm = req.params.yyyymm;
    const { ref, data } = await ctbGetOrCreateConciliacion(businessId, yyyymm);
    if (data.estado === 'cerrada') return res.status(400).json({ error: `La conciliación de ${yyyymm} ya está cerrada.` });
    const { saldoInicialBanco, saldoFinalBanco } = req.body || {};
    await ref.set({
      saldoInicialBanco: Number(saldoInicialBanco) || 0,
      saldoFinalBanco: Number(saldoFinalBanco) || 0,
    }, { merge: true });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/contabilidad/:businessId/conciliacion/:yyyymm/movimientos', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const yyyymm = req.params.yyyymm;
    const { data: conciliacion } = await ctbGetOrCreateConciliacion(businessId, yyyymm);
    if (conciliacion.estado === 'cerrada') return res.status(400).json({ error: `La conciliación de ${yyyymm} ya está cerrada.` });
    const { fecha, descripcion, monto, tipo } = req.body || {};
    if (!fecha || !descripcion) return res.status(400).json({ error: 'Fecha y descripción son requeridas.' });
    if (!(Number(monto) > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a cero.' });
    if (!['deposito', 'retiro'].includes(tipo)) return res.status(400).json({ error: "Tipo debe ser 'deposito' o 'retiro'." });
    const ref = await col(COL_LICENCIAS).doc(businessId).collection('conciliaciones').doc(yyyymm).collection('movimientos_banco').add({
      fecha, descripcion, monto: ctbRound2(monto), tipo, conciliado: false, createdAt: isoNow(),
    });
    res.status(201).json({ ok: true, id: ref.id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/contabilidad/:businessId/conciliacion/:yyyymm/movimientos/:movId', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { yyyymm, movId } = req.params;
    const movRef = col(COL_LICENCIAS).doc(businessId).collection('conciliaciones').doc(yyyymm).collection('movimientos_banco').doc(movId);
    const movDoc = await movRef.get();
    if (!movDoc.exists) return res.status(404).json({ error: 'Movimiento no encontrado.' });
    if (movDoc.data().conciliado) return res.status(400).json({ error: 'No se puede eliminar un movimiento ya conciliado — desemparéjalo primero.' });
    await movRef.delete();
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/contabilidad/:businessId/conciliacion/:yyyymm/sugerencias', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const yyyymm = req.params.yyyymm;
    const desde = `${yyyymm}-01`, hasta = `${yyyymm}-31`;

    const [{ rows: movimientosLibro }, movBancoSnap, matchesSnap] = await Promise.all([
      ctbMovimientosLibroBanco(businessId, desde, hasta),
      col(COL_LICENCIAS).doc(businessId).collection('conciliaciones').doc(yyyymm).collection('movimientos_banco').where('conciliado', '==', false).get(),
      col(COL_LICENCIAS).doc(businessId).collection('conciliaciones').doc(yyyymm).collection('matches').get(),
    ]);
    const matches = matchesSnap.docs.map((d) => d.data());
    const libroConciliado = new Set(matches.map((m) => `${m.asientoId}:${m.lineaIndex}`));
    const librosPendientes = movimientosLibro.filter((r) => !libroConciliado.has(`${r.asientoId}:${r.lineaIndex}`));

    const sugerencias = movBancoSnap.docs.map((d) => {
      const mb = { id: d.id, ...d.data() };
      const montoSigno = mb.tipo === 'deposito' ? mb.monto : -mb.monto;
      const fechaBanco = new Date(mb.fecha).getTime();
      const candidatos = librosPendientes
        .filter((l) => Math.abs(l.monto - montoSigno) < 0.01)
        .map((l) => ({ ...l, diasDiferencia: Math.round(Math.abs(new Date(l.fecha).getTime() - fechaBanco) / 86400000) }))
        .sort((a, b) => a.diasDiferencia - b.diasDiferencia)
        .slice(0, 3);
      return { movimientoBanco: mb, candidatos };
    }).filter((s) => s.candidatos.length > 0);

    res.json({ sugerencias });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/contabilidad/:businessId/conciliacion/:yyyymm/emparejar', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const yyyymm = req.params.yyyymm;
    const { movimientoBancoId, asientoId, lineaIndex } = req.body || {};
    if (!movimientoBancoId || !asientoId || lineaIndex === undefined) {
      return res.status(400).json({ error: 'movimientoBancoId, asientoId y lineaIndex son requeridos.' });
    }
    const conciliacionRef = col(COL_LICENCIAS).doc(businessId).collection('conciliaciones').doc(yyyymm);
    const movRef = conciliacionRef.collection('movimientos_banco').doc(movimientoBancoId);
    const movDoc = await movRef.get();
    if (!movDoc.exists) return res.status(404).json({ error: 'Movimiento de banco no encontrado.' });
    if (movDoc.data().conciliado) return res.status(400).json({ error: 'Este movimiento ya está conciliado.' });

    const matchRef = await conciliacionRef.collection('matches').add({
      movimientoBancoId, asientoId, lineaIndex: Number(lineaIndex), fecha: isoNow(),
    });
    await movRef.set({ conciliado: true }, { merge: true });
    res.status(201).json({ ok: true, id: matchRef.id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/contabilidad/:businessId/conciliacion/:yyyymm/desemparejar/:matchId', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { yyyymm, matchId } = req.params;
    const conciliacionRef = col(COL_LICENCIAS).doc(businessId).collection('conciliaciones').doc(yyyymm);
    const matchRef = conciliacionRef.collection('matches').doc(matchId);
    const matchDoc = await matchRef.get();
    if (!matchDoc.exists) return res.status(404).json({ error: 'Match no encontrado.' });
    await conciliacionRef.collection('movimientos_banco').doc(matchDoc.data().movimientoBancoId).set({ conciliado: false }, { merge: true });
    await matchRef.delete();
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/contabilidad/:businessId/conciliacion/:yyyymm/cerrar', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const yyyymm = req.params.yyyymm;
    const { ref, data: conciliacion } = await ctbGetOrCreateConciliacion(businessId, yyyymm);
    if (conciliacion.estado === 'cerrada') return res.status(400).json({ error: `La conciliación de ${yyyymm} ya está cerrada.` });

    const desde = `${yyyymm}-01`, hasta = `${yyyymm}-31`;
    const [{ rows: movimientosLibro, closingBalance: saldoLibroCierre }, movBancoSnap, matchesSnap] = await Promise.all([
      ctbMovimientosLibroBanco(businessId, desde, hasta),
      col(COL_LICENCIAS).doc(businessId).collection('conciliaciones').doc(yyyymm).collection('movimientos_banco').get(),
      col(COL_LICENCIAS).doc(businessId).collection('conciliaciones').doc(yyyymm).collection('matches').get(),
    ]);
    const matches = matchesSnap.docs.map((d) => d.data());
    const libroConciliado = new Set(matches.map((m) => `${m.asientoId}:${m.lineaIndex}`));
    const movBanco = movBancoSnap.docs.map(docData);

    // Depósitos en tránsito / cheques pendientes: movimientos del libro que el
    // banco todavía no refleja — ajustan el saldo del banco.
    const ajusteLibroSinBanco = movimientosLibro
      .filter((l) => !libroConciliado.has(`${l.asientoId}:${l.lineaIndex}`))
      .reduce((s, l) => s + l.monto, 0);
    // Cargos/créditos del banco que el contador aún no registró en libros —
    // ajustan el saldo según libros.
    const ajusteBancoSinLibro = movBanco
      .filter((m) => !m.conciliado)
      .reduce((s, m) => s + (m.tipo === 'deposito' ? m.monto : -m.monto), 0);

    const saldoAjustadoBanco = ctbRound2(Number(conciliacion.saldoFinalBanco || 0) + ajusteLibroSinBanco);
    const saldoAjustadoLibros = ctbRound2(saldoLibroCierre + ajusteBancoSinLibro);

    if (Math.abs(saldoAjustadoBanco - saldoAjustadoLibros) >= 0.01) {
      return res.status(400).json({
        error: `La conciliación no cuadra: saldo ajustado banco RD$${saldoAjustadoBanco.toFixed(2)} vs saldo ajustado libros RD$${saldoAjustadoLibros.toFixed(2)}.`,
        saldoAjustadoBanco, saldoAjustadoLibros,
      });
    }

    await ref.set({
      estado: 'cerrada', fechaCierre: isoNow(),
      cerradoPor: req.contador.fullName || req.contador.email,
    }, { merge: true });
    ctbAuditLog(businessId, req, 'cerrar_conciliacion', yyyymm);
    res.json({ ok: true, saldoAjustadoBanco, saldoAjustadoLibros });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/contabilidad/:businessId/conciliacion/:yyyymm/reabrir', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const yyyymm = req.params.yyyymm;
    await col(COL_LICENCIAS).doc(businessId).collection('conciliaciones').doc(yyyymm).set({
      estado: 'abierta', reabiertoEn: isoNow(), reabiertoPor: req.contador.fullName || req.contador.email,
    }, { merge: true });
    ctbAuditLog(businessId, req, 'reabrir_conciliacion', yyyymm);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Adjuntos ─────────────────────────────────────────────────────────────
// Compartido entre asientos (Diario General) y movimientos de banco
// (Conciliación) — misma colección, mismo par de endpoints.
app.post('/api/contabilidad/:businessId/adjuntos', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    if (!bucket) return res.status(500).json({ error: 'Firebase Storage no está configurado.' });
    const { entidadTipo, entidadId, nombre, contentType, dataBase64 } = req.body || {};
    if (!['asiento', 'movimiento_banco'].includes(entidadTipo)) return res.status(400).json({ error: 'entidadTipo inválido.' });
    if (!entidadId || !nombre || !dataBase64) return res.status(400).json({ error: 'entidadId, nombre y dataBase64 son requeridos.' });

    const buffer = Buffer.from(dataBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buffer.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'El archivo no puede superar 10MB.' });

    const storagePath = `contadores/${businessId}/${entidadTipo}s/${entidadId}/${Date.now()}-${nombre}`;
    await bucket.file(storagePath).save(buffer, { contentType: contentType || 'application/octet-stream' });

    const ref = await col(COL_LICENCIAS).doc(businessId).collection('adjuntos').add({
      entidadTipo, entidadId, nombre, contentType: contentType || 'application/octet-stream',
      size: buffer.length, storagePath,
      subidoPor: req.contador.fullName || req.contador.email, fecha: isoNow(),
    });
    res.status(201).json({ ok: true, id: ref.id });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/contabilidad/:businessId/adjuntos', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const { entidadTipo, entidadId } = req.query;
    if (!entidadTipo || !entidadId) return res.status(400).json({ error: 'entidadTipo y entidadId son requeridos.' });
    const snap = await col(COL_LICENCIAS).doc(businessId).collection('adjuntos')
      .where('entidadTipo', '==', entidadTipo).where('entidadId', '==', entidadId).get();
    const items = await Promise.all(snap.docs.map(async (d) => {
      const data = docData(d);
      let url = null;
      if (bucket) {
        try {
          const [signedUrl] = await bucket.file(data.storagePath).getSignedUrl({ action: 'read', expires: Date.now() + 15 * 60 * 1000 });
          url = signedUrl;
        } catch { /* archivo pudo haber sido borrado directamente en Storage */ }
      }
      return { ...data, url };
    }));
    res.json(items);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/contabilidad/:businessId/adjuntos/:id', requireAuth, async (req, res) => {
  try {
    const businessId = req.params.businessId;
    await ctbCheckAccess(req, businessId);
    const ref = col(COL_LICENCIAS).doc(businessId).collection('adjuntos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Adjunto no encontrado.' });
    if (bucket) {
      try { await bucket.file(doc.data().storagePath).delete(); } catch { /* ya no existía en Storage */ }
    }
    await ref.delete();
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// FACTURACIÓN — Clientes del contador
// ══════════════════════════════════════════════════════════════════════

app.get('/api/facturacion/clientes', requireAuth, async (req, res) => {
  try {
    const snap = await col(COL_CONTADORES)
      .doc(req.contador.contadorDocId)
      .collection('clientes_fac')
      .orderBy('nombre')
      .get();
    res.json(snap.docs.map(docData));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/facturacion/clientes', requireAuth, async (req, res) => {
  try {
    const { nombre, rnc, direccion, telefono, correo } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
    const data = {
      nombre: nombre.trim(), rnc: (rnc||'').trim(),
      direccion: (direccion||'').trim(), telefono: (telefono||'').trim(),
      correo: (correo||'').trim(), createdAt: isoNow(), updatedAt: isoNow(),
    };
    const ref = await col(COL_CONTADORES)
      .doc(req.contador.contadorDocId).collection('clientes_fac').add(data);
    res.json({ id: ref.id, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/facturacion/clientes/:id', requireAuth, async (req, res) => {
  try {
    const { nombre, rnc, direccion, telefono, correo } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
    const ref = col(COL_CONTADORES)
      .doc(req.contador.contadorDocId).collection('clientes_fac').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const data = {
      nombre: nombre.trim(), rnc: (rnc||'').trim(),
      direccion: (direccion||'').trim(), telefono: (telefono||'').trim(),
      correo: (correo||'').trim(), updatedAt: isoNow(),
    };
    await ref.update(data);
    res.json({ id: req.params.id, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/facturacion/clientes/:id', requireAuth, async (req, res) => {
  try {
    await col(COL_CONTADORES)
      .doc(req.contador.contadorDocId).collection('clientes_fac').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// FACTURACIÓN — Facturas
// ══════════════════════════════════════════════════════════════════════

const NCF_TIPOS = {
  B01: 'Crédito Fiscal',
  B02: 'Consumidor Final',
  B14: 'Régimen Especial',
  B15: 'Gubernamental',
  B16: 'Exportación',
};

async function getNextNcf(contadorRef, tipo) {
  const field = `ncf_seq.${tipo}`;
  let seq = 1;
  await db.runTransaction(async t => {
    const snap = await t.get(contadorRef);
    seq = (snap.data()?.ncf_seq?.[tipo] || 0) + 1;
    t.update(contadorRef, { [field]: seq });
  });
  return `${tipo}${String(seq).padStart(8, '0')}`;
}

app.get('/api/facturacion/stats', requireAuth, async (req, res) => {
  try {
    const snap = await col(COL_CONTADORES)
      .doc(req.contador.contadorDocId).collection('facturas').get();
    const mes = new Date().toISOString().slice(0, 7);
    let totalMes = 0, pendientes = 0, pagadas = 0, totalGeneral = 0;
    for (const d of snap.docs) {
      const f = d.data();
      if (f.estado === 'anulada') continue;
      totalGeneral += f.total || 0;
      if ((f.fecha || '').startsWith(mes)) totalMes += f.total || 0;
      if (f.estado === 'pendiente') pendientes++;
      if (f.estado === 'pagada')    pagadas++;
    }
    const r = v => Math.round(v * 100) / 100;
    res.json({ totalMes: r(totalMes), totalGeneral: r(totalGeneral), pendientes, pagadas, totalFacturas: snap.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/facturacion/facturas', requireAuth, async (req, res) => {
  try {
    const snap = await col(COL_CONTADORES)
      .doc(req.contador.contadorDocId).collection('facturas')
      .orderBy('createdAt', 'desc').get();
    let list = snap.docs.map(docData);
    const { estado, tipo, desde, hasta } = req.query;
    if (estado) list = list.filter(f => f.estado === estado);
    if (tipo)   list = list.filter(f => f.tipo_ncf === tipo);
    if (desde)  list = list.filter(f => (f.fecha || '') >= desde);
    if (hasta)  list = list.filter(f => (f.fecha || '') <= hasta);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/facturacion/facturas', requireAuth, async (req, res) => {
  try {
    const { cliente, tipo_ncf, fecha, items, condicion_pago, metodo_pago, observacion } = req.body;
    if (!cliente?.nombre?.trim()) return res.status(400).json({ error: 'Nombre del cliente requerido.' });
    if (!NCF_TIPOS[tipo_ncf])     return res.status(400).json({ error: 'Tipo de comprobante inválido.' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Debe agregar al menos un ítem.' });

    const contadorRef = col(COL_CONTADORES).doc(req.contador.contadorDocId);
    const ncf = await getNextNcf(contadorRef, tipo_ncf);

    const r = v => Math.round(v * 100) / 100;
    let subtotal = 0, descuento_total = 0, itbis_total = 0;
    const itemsCalc = items.map(item => {
      const precio    = Math.max(0, Number(item.precio)   || 0);
      const cantidad  = Math.max(1, Number(item.cantidad) || 1);
      const pct_desc  = Math.min(100, Math.max(0, Number(item.descuento)  || 0));
      const itbis_rate = Number(item.itbis_rate) || 0;
      const base       = precio * cantidad;
      const desc_amt   = base * (pct_desc / 100);
      const gravable   = base - desc_amt;
      const itbis_amt  = gravable * (itbis_rate / 100);
      subtotal        += base;
      descuento_total += desc_amt;
      itbis_total     += itbis_amt;
      return {
        descripcion: String(item.descripcion || '').trim(),
        cantidad, precio, descuento: pct_desc, itbis_rate,
        itbis: r(itbis_amt), total: r(gravable + itbis_amt),
      };
    });

    const total_general = subtotal - descuento_total + itbis_total;
    const data = {
      ncf, tipo_ncf, tipo_ncf_label: NCF_TIPOS[tipo_ncf],
      fecha: fecha || new Date().toISOString().slice(0, 10),
      cliente: {
        nombre:    cliente.nombre.trim(), rnc:      cliente.rnc       || '',
        direccion: cliente.direccion || '',  telefono: cliente.telefono || '',
        correo:    cliente.correo    || '',
      },
      items: itemsCalc,
      subtotal: r(subtotal), descuento_total: r(descuento_total),
      itbis_total: r(itbis_total), total: r(total_general),
      monto_pagado: 0, balance: r(total_general),
      condicion_pago: condicion_pago || 'contado',
      metodo_pago:    metodo_pago    || 'efectivo',
      observacion:    observacion    || '',
      estado: 'pendiente',
      contador_nombre: req.contador.nombre_firma || req.contador.fullName,
      contador_rnc:    req.contador.rnc,
      contador_tel:    req.contador.telefono,
      contador_correo: req.contador.correo,
      createdAt: isoNow(), updatedAt: isoNow(),
    };

    const ref = await contadorRef.collection('facturas').add(data);
    res.json({ id: ref.id, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/facturacion/facturas/:id', requireAuth, async (req, res) => {
  try {
    const doc = await col(COL_CONTADORES)
      .doc(req.contador.contadorDocId).collection('facturas').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Factura no encontrada.' });
    res.json(docData(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/facturacion/facturas/:id', requireAuth, async (req, res) => {
  try {
    const ref = col(COL_CONTADORES)
      .doc(req.contador.contadorDocId).collection('facturas').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Factura no encontrada.' });
    const cur = snap.data();
    if (cur.estado === 'anulada') return res.status(400).json({ error: 'No se puede modificar una factura anulada.' });
    const { estado, monto_pagado } = req.body;
    const upd = { updatedAt: isoNow() };
    if (estado) upd.estado = estado;
    if (monto_pagado !== undefined) {
      upd.monto_pagado = Math.max(0, Number(monto_pagado));
      upd.balance = Math.max(0, (cur.total || 0) - upd.monto_pagado);
      if (upd.balance === 0) upd.estado = 'pagada';
    }
    await ref.update(upd);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// RNC / DGII — proxy hacia dataset local
// ══════════════════════════════════════════════════════════════════════

app.get('/api/rnc/status', (_req, res) => {
  res.json({ ready: _rncReady, error: _rncError });
});

// GET /api/rnc/lookup?id=XXXXXXXXX
app.get('/api/rnc/lookup', requireAuth, async (req, res) => {
  const raw = String(req.query.id || '').replace(/\D/g, '');
  if (!raw || raw.length < 9) {
    return res.status(400).json({ error: 'RNC/Cédula debe tener 9-11 dígitos.' });
  }
  const h = getRncHandler();
  if (!h) {
    return res.status(503).json({ error: _rncError || 'Módulo DGII no disponible.' });
  }
  try {
    // El dataset guarda cédulas con ceros a la izquierda (11 dígitos).
    // Si el usuario escribe 10 dígitos (le falta el cero inicial), probar también con padding.
    const candidates = [raw.slice(0, 11)];
    if (raw.length === 10) candidates.push('0' + raw);

    let record = null;
    // Ruta rápida: buscar en memoria si el dataset ya está listo
    if (_rncReady && h.df && h.df.length > 0) {
      for (const id of candidates) {
        record = h.df.find(r => r.ID === id) || null;
        if (record) break;
      }
    } else {
      // Fallback: h.search() carga el dataset on-demand si es necesario
      for (const id of candidates) {
        const results = await h.search({ ID: id });
        if (results && results.length > 0) { record = results[0]; break; }
      }
      _rncReady = h.df && h.df.length > 0; // marcar listo tras la carga
    }

    if (!record) return res.json({ found: false, rnc: raw });
    return res.json({
      found:          true,
      rnc:            record.ID || raw,
      nombre:         record.NOMBRE          || '',
      nombreComercial:record.NOMBRE_COMERCIAL || record.NOMBRE || '',
      estado:         record.ESTADO          || '',
      tipo:           (record.ID || '').length === 11 ? 'Persona Física' : 'Persona Jurídica',
      categoria:      record.CATEGORIA       || '',
      regimen:        record.REGIMEN_PAGO    || '',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/rnc/search?q=banco+popular&limit=8
app.get('/api/rnc/search', requireAuth, async (req, res) => {
  const q     = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 8, 50);
  if (!q || q.length < 3) {
    return res.status(400).json({ error: 'Escribe al menos 3 caracteres para buscar.' });
  }
  const h = getRncHandler();
  if (!h) {
    return res.status(503).json({ error: _rncError || 'Módulo DGII no disponible.' });
  }
  try {
    const qUpper = q.toUpperCase();
    let rows;
    if (_rncReady && h.df && h.df.length > 0) {
      rows = [];
      for (const r of h.df) {
        if (r.NOMBRE.includes(qUpper) || (r.NOMBRE_COMERCIAL && r.NOMBRE_COMERCIAL.includes(qUpper))) {
          rows.push(r);
          if (rows.length >= limit) break;
        }
      }
    } else {
      const results = await h.search({ NOMBRE: q });
      rows = (results || []).slice(0, limit);
    }
    res.json({
      results: rows.map(r => ({
        rnc:            r.ID || '',
        nombre:         r.NOMBRE           || '',
        nombreComercial:r.NOMBRE_COMERCIAL || r.NOMBRE || '',
        estado:         r.ESTADO           || '',
        tipo:           (r.ID || '').length === 11 ? 'Persona Física' : 'Persona Jurídica',
        categoria:      r.CATEGORIA        || '',
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// COLABORADORES
// ══════════════════════════════════════════════════════════════════════

// Middleware: solo el contador principal (o colaborador completo) puede gestionar
function requirePrincipalOrCompleto(req, res, next) {
  const colab = req.colaborador;
  if (colab?.esColaborador && colab.esDependiente) {
    return res.status(403).json({ error: 'No tienes permisos para gestionar colaboradores.' });
  }
  next();
}

function colabsRef(contadorDocId) {
  return col(COL_CONTADORES).doc(contadorDocId).collection(SUB_COLABORADORES);
}

// GET /api/colaboradores — listado
app.get('/api/colaboradores', requireAuth, requirePrincipalOrCompleto, async (req, res) => {
  try {
    const snap = await colabsRef(req.contador.contadorDocId)
      .orderBy('createdAt', 'desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/colaboradores — crear
app.post('/api/colaboradores', requireAuth, requirePrincipalOrCompleto, async (req, res) => {
  try {
    const { nombre, cedula, rnc, telefono, whatsapp, correo, direccion, tipo, password } = req.body;
    if (!nombre?.trim())  return res.status(400).json({ error: 'Nombre requerido.' });
    if (!correo?.trim())  return res.status(400).json({ error: 'Correo requerido.' });
    if (!password || String(password).length < 6)
      return res.status(400).json({ error: 'Contraseña mínima de 6 caracteres.' });

    const tipoVal = tipo === 'completo' ? 'completo' : 'dependiente';

    // 1. Firebase Auth
    const userRecord = await adminSdk.auth().createUser({
      email:       correo.trim(),
      password,
      displayName: nombre.trim(),
    });
    const uid = userRecord.uid;
    const now = isoNow();

    // 2. platform_admins
    await col(COL_ADMINS).doc(uid).set({
      role:             'colaborador',
      status:           'active',
      email:            correo.trim(),
      fullName:         nombre.trim(),
      parentContadorId: req.contador.contadorDocId,
      tipo:             tipoVal,
      createdAt:        now,
      lastLoginAt:      null,
    });

    // 3. Documento colaborador
    const colabData = {
      uid,
      email:       correo.trim(),
      nombre:      nombre.trim(),
      cedula:      cedula    || '',
      rnc:         rnc       || '',
      telefono:    telefono  || '',
      whatsapp:    whatsapp  || '',
      direccion:   direccion || '',
      foto_url:    '',
      tipo:        tipoVal,
      estado:      'activo',
      clientesAsignados: [],
      parentContadorId:  req.contador.contadorDocId,
      createdBy:   req.contador.uid,
      createdAt:   now,
      updatedAt:   now,
    };
    await colabsRef(req.contador.contadorDocId).doc(uid).set(colabData);

    res.json({ id: uid, ...colabData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/colaboradores/:id — detalle
app.get('/api/colaboradores/:id', requireAuth, async (req, res) => {
  try {
    const doc = await colabsRef(req.contador.contadorDocId).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Colaborador no encontrado.' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/colaboradores/:id — editar
app.put('/api/colaboradores/:id', requireAuth, requirePrincipalOrCompleto, async (req, res) => {
  try {
    const ref = colabsRef(req.contador.contadorDocId).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Colaborador no encontrado.' });

    const { nombre, cedula, rnc, telefono, whatsapp, correo, direccion, tipo, estado } = req.body;
    const upd = { updatedAt: isoNow() };
    if (nombre    !== undefined) upd.nombre    = String(nombre).trim();
    if (cedula    !== undefined) upd.cedula    = cedula;
    if (rnc       !== undefined) upd.rnc       = rnc;
    if (telefono  !== undefined) upd.telefono  = telefono;
    if (whatsapp  !== undefined) upd.whatsapp  = whatsapp;
    if (correo    !== undefined) upd.correo    = String(correo).trim();
    if (direccion !== undefined) upd.direccion = direccion;
    if (tipo      !== undefined) upd.tipo      = tipo === 'completo' ? 'completo' : 'dependiente';
    if (estado    !== undefined) upd.estado    = estado;

    await ref.update(upd);

    // Sync a platform_admins
    const adminUpd = { updatedAt: isoNow() };
    if (nombre)  adminUpd.fullName = String(nombre).trim();
    if (estado) {
      adminUpd.status = estado === 'activo' ? 'active'
        : estado === 'suspendido' ? 'suspended' : 'inactive';
      // Si se suspende, deshabilitar Firebase Auth
      if (estado !== 'activo') {
        adminSdk.auth().updateUser(req.params.id, { disabled: true }).catch(() => {});
      } else {
        adminSdk.auth().updateUser(req.params.id, { disabled: false }).catch(() => {});
      }
    }
    if (tipo) adminUpd.tipo = tipo;
    await col(COL_ADMINS).doc(req.params.id).update(adminUpd).catch(() => {});

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/colaboradores/:id — eliminar (soft)
app.delete('/api/colaboradores/:id', requireAuth, requirePrincipalOrCompleto, async (req, res) => {
  try {
    const ref = colabsRef(req.contador.contadorDocId).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Colaborador no encontrado.' });

    await ref.update({ estado: 'eliminado', updatedAt: isoNow() });
    await col(COL_ADMINS).doc(req.params.id).update({ status: 'inactive' }).catch(() => {});
    await adminSdk.auth().updateUser(req.params.id, { disabled: true }).catch(() => {});

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/colaboradores/:id/asignar — asignar un negocio
app.post('/api/colaboradores/:id/asignar', requireAuth, requirePrincipalOrCompleto, async (req, res) => {
  try {
    const { businessId } = req.body;
    if (!businessId) return res.status(400).json({ error: 'businessId requerido.' });

    const ref = colabsRef(req.contador.contadorDocId).doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'Colaborador no encontrado.' });

    await ref.update({
      clientesAsignados: adminSdk.firestore.FieldValue.arrayUnion(businessId),
      updatedAt: isoNow(),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/colaboradores/:id/clientes/:businessId — quitar asignación
app.delete('/api/colaboradores/:id/clientes/:businessId', requireAuth, requirePrincipalOrCompleto, async (req, res) => {
  try {
    const ref = colabsRef(req.contador.contadorDocId).doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'Colaborador no encontrado.' });

    await ref.update({
      clientesAsignados: adminSdk.firestore.FieldValue.arrayRemove(req.params.businessId),
      updatedAt: isoNow(),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/colaboradores/:id/clientes — negocios asignados a un colaborador
app.get('/api/colaboradores/:id/clientes', requireAuth, async (req, res) => {
  try {
    const doc = await colabsRef(req.contador.contadorDocId).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Colaborador no encontrado.' });

    const asignados = doc.data().clientesAsignados || [];
    if (!asignados.length) return res.json([]);

    const results = [];
    for (let i = 0; i < asignados.length; i += 10) {
      const chunk = asignados.slice(i, i + 10);
      const snap = await col(COL_LICENCIAS)
        .where(adminSdk.firestore.FieldPath.documentId(), 'in', chunk)
        .get();
      snap.docs.forEach(d => results.push({
        id: d.id,
        businessName: d.data().businessName || d.data().businessKey || '—',
        rnc:          d.data().rnc    || '—',
        status:       d.data().status || 'trial',
        planCode:     d.data().planCode || '—',
        propietario:  d.data().propietario || '—',
      }));
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/colaboradores/:id/cambiar-password — cambiar contraseña
app.post('/api/colaboradores/:id/cambiar-password', requireAuth, requirePrincipalOrCompleto, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || String(password).length < 6)
      return res.status(400).json({ error: 'Contraseña mínima de 6 caracteres.' });

    const doc = await colabsRef(req.contador.contadorDocId).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Colaborador no encontrado.' });

    await adminSdk.auth().updateUser(req.params.id, { password });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// ANÁLISIS GLOBAL — Agregados de toda la cartera del contador
// ══════════════════════════════════════════════════════════════════════

app.get('/api/analisis-global', requireAuth, async (req, res) => {
  try {
    const snap = await col(COL_LICENCIAS)
      .where('contadorId', '==', req.contador.contadorDocId)
      .get();

    const clientes = snap.docs.map(docData);
    const ahora = Date.now();

    let totalVentasMes = 0, totalVentasHoy = 0, totalItbisMes = 0;
    let totalFacturasEmitidas = 0, totalCxcPendiente = 0;
    let clientesSinSync7dias = 0, clientesConPosData = 0;
    const topClientes = [];

    for (const c of clientes) {
      const stats = c.posStats || {};
      totalVentasMes        += Number(stats.ventasMes        || 0);
      totalVentasHoy        += Number(stats.ventasHoy        || 0);
      totalItbisMes         += Number(stats.itbisMes         || 0);
      totalFacturasEmitidas += Number(stats.facturasEmitidas || 0);
      totalCxcPendiente     += Number(stats.cxcPendiente     || 0);
      if (stats.ventasMes !== undefined) clientesConPosData++;

      if (c.syncedAt) {
        const d = c.syncedAt.toDate ? c.syncedAt.toDate() : new Date(c.syncedAt);
        if ((ahora - d.getTime()) / 86400000 > 7) clientesSinSync7dias++;
      } else {
        clientesSinSync7dias++;
      }

      topClientes.push({
        id:           c.id,
        businessName: c.businessName || c.businessKey || '—',
        ventasMes:    Number(stats.ventasMes  || 0),
        itbisMes:     Number(stats.itbisMes   || 0),
        facturas:     Number(stats.facturasEmitidas || 0),
        status:       c.status || 'trial',
        syncedAt:     c.syncedAt || null,
      });
    }

    topClientes.sort((a, b) => b.ventasMes - a.ventasMes);

    res.json({
      resumen: {
        totalClientes: clientes.length,
        totalVentasMes, totalVentasHoy, totalItbisMes,
        totalFacturasEmitidas, totalCxcPendiente,
        clientesSinSync7dias, clientesConPosData,
      },
      topClientes: topClientes.slice(0, 10),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// CENTRO FISCAL — Calendario DGII RD + tareas de cumplimiento
// ══════════════════════════════════════════════════════════════════════

const _OBL_MESES = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const _OBL_BASE = [];

// IT-1 (ITBIS) — vence el 20 de cada mes
for (let m = 1; m <= 12; m++) {
  _OBL_BASE.push({ mes: m, dia: 20, form: 'IT-1', desc: `ITBIS — mes de ${_OBL_MESES[m]}`, tipo: 'mensual' });
}
// TSS — vence el 30 de cada mes
for (let m = 1; m <= 12; m++) {
  _OBL_BASE.push({ mes: m, dia: 30, form: 'TSS', desc: `TSS Seguridad Social — ${_OBL_MESES[m]}`, tipo: 'mensual' });
}
// 606/607 trimestral
_OBL_BASE.push(
  { mes: 4,  dia: 30, form: '606', desc: '606 Compras (Trim. 1 Ene-Mar)', tipo: 'trimestral' },
  { mes: 7,  dia: 31, form: '606', desc: '606 Compras (Trim. 2 Abr-Jun)', tipo: 'trimestral' },
  { mes: 10, dia: 31, form: '606', desc: '606 Compras (Trim. 3 Jul-Sep)', tipo: 'trimestral' },
  { mes: 1,  dia: 31, form: '606', desc: '606 Compras (Trim. 4 Oct-Dic)', tipo: 'trimestral' },
  { mes: 4,  dia: 30, form: '607', desc: '607 Ventas NCF (Trim. 1 Ene-Mar)', tipo: 'trimestral' },
  { mes: 7,  dia: 31, form: '607', desc: '607 Ventas NCF (Trim. 2 Abr-Jun)', tipo: 'trimestral' },
  { mes: 10, dia: 31, form: '607', desc: '607 Ventas NCF (Trim. 3 Jul-Sep)', tipo: 'trimestral' },
  { mes: 1,  dia: 31, form: '607', desc: '607 Ventas NCF (Trim. 4 Oct-Dic)', tipo: 'trimestral' }
);
// IR anuales
_OBL_BASE.push(
  { mes: 3, dia: 31, form: 'IR-2', desc: 'IR-2 Renta Personas Jurídicas (año anterior)', tipo: 'anual' },
  { mes: 3, dia: 31, form: 'IR-1', desc: 'IR-1 Renta Personas Físicas (año anterior)',    tipo: 'anual' }
);
// Pagos a cuenta IR
_OBL_BASE.push(
  { mes: 5,  dia: 15, form: 'IR-PA', desc: 'Pago a Cuenta Renta — 1er pago', tipo: 'trimestral' },
  { mes: 8,  dia: 15, form: 'IR-PA', desc: 'Pago a Cuenta Renta — 2do pago', tipo: 'trimestral' },
  { mes: 11, dia: 15, form: 'IR-PA', desc: 'Pago a Cuenta Renta — 3er pago', tipo: 'trimestral' }
);

function _obligacionesAnio(anio) {
  const now = new Date();
  return _OBL_BASE.map((o, i) => {
    const fecha = new Date(anio, o.mes - 1, o.dia);
    const diasRestantes = Math.ceil((fecha - now) / 86400000);
    return {
      id: `${anio}-${String(o.mes).padStart(2,'0')}-${o.dia}-${o.form}-${i}`,
      fecha: fecha.toISOString().slice(0, 10),
      form: o.form, desc: o.desc, tipo: o.tipo, mes: o.mes, dia: o.dia,
      diasRestantes,
      estado: diasRestantes < 0 ? 'vencida'
            : diasRestantes <= 7  ? 'urgente'
            : diasRestantes <= 30 ? 'proxima' : 'pendiente',
    };
  }).sort((a, b) => a.fecha.localeCompare(b.fecha));
}

app.get('/api/centro-fiscal/obligaciones', requireAuth, (req, res) => {
  const anio = parseInt(req.query.anio) || new Date().getFullYear();
  res.json(_obligacionesAnio(anio));
});

app.get('/api/centro-fiscal/tareas', requireAuth, async (req, res) => {
  try {
    const snap = await col(COL_CONTADORES)
      .doc(req.contador.contadorDocId)
      .collection('tareas_fiscales')
      .orderBy('created_at', 'desc')
      .limit(200)
      .get();
    res.json(snap.docs.map(docData));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/centro-fiscal/tareas', requireAuth, async (req, res) => {
  const { titulo, businessId, businessName, fecha_vencimiento, tipo, notas } = req.body;
  if (!titulo?.trim()) return res.status(400).json({ error: 'El título es requerido.' });
  try {
    const ref = await col(COL_CONTADORES)
      .doc(req.contador.contadorDocId)
      .collection('tareas_fiscales')
      .add({
        titulo: titulo.trim(),
        businessId:        businessId        || null,
        businessName:      businessName      || null,
        fecha_vencimiento: fecha_vencimiento || null,
        tipo:  tipo  || 'general',
        notas: notas || null,
        estado:     'pendiente',
        created_at: isoNow(),
        updated_at: isoNow(),
      });
    res.json({ ok: true, id: ref.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/centro-fiscal/tareas/:id/completar', requireAuth, async (req, res) => {
  try {
    await col(COL_CONTADORES).doc(req.contador.contadorDocId)
      .collection('tareas_fiscales').doc(req.params.id)
      .update({ estado: 'completada', completado_at: isoNow(), updated_at: isoNow() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/centro-fiscal/tareas/:id/reabrir', requireAuth, async (req, res) => {
  try {
    await col(COL_CONTADORES).doc(req.contador.contadorDocId)
      .collection('tareas_fiscales').doc(req.params.id)
      .update({ estado: 'pendiente', completado_at: null, updated_at: isoNow() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/centro-fiscal/tareas/:id', requireAuth, async (req, res) => {
  try {
    await col(COL_CONTADORES).doc(req.contador.contadorDocId)
      .collection('tareas_fiscales').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// ALERTAS — Centro de alertas de toda la cartera
// ══════════════════════════════════════════════════════════════════════

app.get('/api/alertas', requireAuth, async (req, res) => {
  try {
    const [licSnap, solSnap] = await Promise.all([
      col(COL_LICENCIAS).where('contadorId', '==', req.contador.contadorDocId).get(),
      col(COL_SOLICITUDES).where('contadorId', '==', req.contador.contadorDocId)
        .where('status', '==', 'pendiente').get(),
    ]);

    const alertas = [];
    const ahora = Date.now();

    licSnap.docs.forEach(doc => {
      const c = docData(doc);
      const vence = vencimientoDate(c);
      if (vence) {
        const d = vence.toDate ? vence.toDate() : new Date(vence);
        const dias = Math.ceil((d - ahora) / 86400000);
        const bname = c.businessName || c.businessKey || '—';
        if (dias < 0) {
          alertas.push({ tipo: 'licencia_vencida', nivel: 'critico', businessId: c.id, businessName: bname, msg: `Licencia vencida hace ${Math.abs(dias)} día(s)`, dias });
        } else if (dias <= 7) {
          alertas.push({ tipo: 'licencia_proxima', nivel: 'urgente', businessId: c.id, businessName: bname, msg: `Licencia vence en ${dias} día(s)`, dias });
        } else if (dias <= 30) {
          alertas.push({ tipo: 'licencia_proxima', nivel: 'advertencia', businessId: c.id, businessName: bname, msg: `Licencia vence en ${dias} días`, dias });
        }
      }
      if (c.syncedAt) {
        const s = c.syncedAt.toDate ? c.syncedAt.toDate() : new Date(c.syncedAt);
        const diasSinSync = (ahora - s.getTime()) / 86400000;
        if (diasSinSync > 7) {
          alertas.push({ tipo: 'sin_sync', nivel: 'info', businessId: c.id, businessName: c.businessName || c.businessKey || '—', msg: `Sin sincronización: ${Math.floor(diasSinSync)} días sin enviar datos` });
        }
      }
    });

    solSnap.docs.forEach(doc => {
      const s = docData(doc);
      alertas.push({ tipo: 'solicitud_pendiente', nivel: 'info', businessId: s.businessId, businessName: s.businessName || '—', msg: `Solicitud pendiente: ${s.tipo || 'sin tipo'}` });
    });

    const orden = { critico: 0, urgente: 1, advertencia: 2, info: 3 };
    alertas.sort((a, b) => (orden[a.nivel] ?? 9) - (orden[b.nivel] ?? 9));

    res.json({
      alertas, total: alertas.length,
      critico:     alertas.filter(a => a.nivel === 'critico').length,
      urgente:     alertas.filter(a => a.nivel === 'urgente').length,
      advertencia: alertas.filter(a => a.nivel === 'advertencia').length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback ───────────────────────────────────────────────────────────
app.get(/(.*)/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;

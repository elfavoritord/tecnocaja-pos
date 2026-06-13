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
let fbReady  = false;
let fbError  = null;

function initFirebase() {
  try {
    const admin = require('firebase-admin');

    if (admin.apps.length) {
      adminSdk = admin;
      db = admin.apps[0].firestore();
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

    admin.initializeApp({ credential, projectId: process.env.FIREBASE_PROJECT_ID });
    adminSdk = admin;
    db = admin.firestore();
    fbReady = true;
    console.log('[contadores] Firebase Admin conectado — proyecto:', process.env.FIREBASE_PROJECT_ID);
  } catch (e) {
    fbError = e.message;
    console.error('[contadores] Firebase init error:', e.message);
  }
}

initFirebase();

// ── Colecciones ────────────────────────────────────────────────────────────
const COL_ADMINS      = 'platform_admins';
const COL_CONTADORES  = 'contadores';
const COL_LICENCIAS   = process.env.FIREBASE_ADMIN_LICENSES_COLLECTION || 'licencias';
const COL_SOLICITUDES = 'support_requests';
const COL_VERSIONES   = 'app_versions';
const COL_HISTORIAL   = 'license_history';

// ── Express ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ────────────────────────────────────────────────────────────────
function col(name) {
  if (!fbReady) throw new Error('Firebase no configurado.');
  return db.collection(name);
}
function docData(doc) { return { id: doc.id, ...doc.data() }; }
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
    if (adminData.role !== 'contador_asociado') {
      return res.status(403).json({ error: 'Esta cuenta no es de tipo contador asociado.' });
    }
    if (adminData.status !== 'active') {
      return res.status(403).json({ error: 'Esta cuenta está inactiva o suspendida.' });
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
    if (adminData.role !== 'contador_asociado') {
      return res.status(403).json({ error: 'Esta cuenta no es de tipo contador asociado.' });
    }
    if (adminData.status !== 'active') {
      return res.status(403).json({ error: 'Cuenta inactiva o suspendida.' });
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

// ── SPA fallback ───────────────────────────────────────────────────────────
app.get(/(.*)/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;

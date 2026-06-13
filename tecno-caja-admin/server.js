'use strict';
/**
 * Tecno Caja Admin — Express server
 *
 * Usa la MISMA base de datos MariaDB/SQLite del POS (sin necesidad de Firebase).
 * Ambas apps comparten datos porque corren en el mismo equipo.
 * Firebase se puede agregar después para sincronización multi-instalación.
 */
const path    = require('path');
const crypto  = require('crypto');
const express = require('express');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── Conectar a la misma DB del POS ────────────────────────────────────────
// Usamos mysql2 directamente apuntando al mismo MariaDB del POS (puerto 3399 interno)
const ROOT = path.resolve(__dirname, '..');

let query;
let dbReady = false;
let dbError = null;

// Leer el .env del POS para obtener los parámetros de MariaDB
try {
  require('dotenv').config({ path: path.join(ROOT, '.env'), override: false });
} catch (_e) {}

try {
  const mysql2 = require('mysql2/promise');
  const pool = mysql2.createPool({
    host:            process.env.DB_HOST     || '127.0.0.1',
    port:     Number(process.env.DB_PORT)    || 3306,
    user:            process.env.DB_USER     || 'root',
    // El POS usa DB_PASSWORD (no DB_PASS)
    password:        process.env.DB_PASSWORD || process.env.DB_PASS || '',
    database:        process.env.DB_NAME     || 'novapos',
    waitForConnections: true,
    connectionLimit: 5,
    charset: 'utf8mb4',
  });

  query = async (sql, params = []) => {
    const [rows] = await pool.execute(sql, params);
    // SELECT devuelve array de rows
    // INSERT/UPDATE/DELETE devuelve ResultSetHeader — lo envolvemos en array
    if (Array.isArray(rows)) return rows;
    return [rows];
  };

  // Verificar conexión
  pool.getConnection()
    .then(conn => { conn.release(); dbReady = true; console.log('[admin] Conectado a MariaDB del POS.'); })
    .catch(e => { dbError = e.message; console.error('[admin] No se pudo conectar a MariaDB:', e.message); });

} catch (e) {
  dbError = 'mysql2 no disponible: ' + e.message;
  console.error('[admin]', dbError);
  // query dummy para que el servidor arranque igual
  query = async () => { throw new Error('Base de datos no disponible: ' + dbError); };
}

// ── JWT ────────────────────────────────────────────────────────────────────
const { SignJWT, jwtVerify } = require('jose');
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'tecnocaja-admin-secret-change-me';
const JWT_KEY    = Buffer.from(JWT_SECRET, 'utf8');

async function signToken(payload) {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('12h').sign(JWT_KEY);
}
async function verifyToken(token) {
  const { payload } = await jwtVerify(token, JWT_KEY);
  return payload;
}

// ── Passwords ──────────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt    = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 32).toString('hex');
  return `scrypt:${salt}:${derived}`;
}
function checkPassword(password, hash) {
  try {
    const [, salt, stored] = hash.split(':');
    const derived = crypto.scryptSync(password, salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(derived, 'hex'));
  } catch { return false; }
}

// ── Express ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const header = String(req.headers.authorization || '').trim();
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado.' });
  try {
    req.adminUser = await verifyToken(header.slice(7));
    next();
  } catch {
    res.status(401).json({ error: 'Sesión expirada. Inicia sesión nuevamente.' });
  }
}

// ── Garantizar tablas del admin ────────────────────────────────────────────
async function ensureAdminTables() {
  await query(`CREATE TABLE IF NOT EXISTS platform_admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    nombre VARCHAR(200) NOT NULL,
    password_hash VARCHAR(500) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'superadmin',
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  await query(`CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    actor VARCHAR(255),
    action VARCHAR(100),
    target VARCHAR(200),
    detail TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  await query(`CREATE TABLE IF NOT EXISTS admin_versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    version VARCHAR(50) NOT NULL,
    descripcion TEXT,
    url_descarga VARCHAR(500),
    es_obligatoria TINYINT(1) NOT NULL DEFAULT 0,
    estado VARCHAR(30) NOT NULL DEFAULT 'publicado',
    publicado_por VARCHAR(255),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});
}

async function ensureFirstAdmin() {
  const [existing] = await query(`SELECT id FROM platform_admins LIMIT 1`).catch(() => []);
  if (existing) return;
  const defaultPass = process.env.ADMIN_DEFAULT_PASSWORD || 'TecnoAdmin2026!';
  const hash = hashPassword(defaultPass);
  await query(`INSERT IGNORE INTO platform_admins (email, nombre, password_hash, role, status) VALUES (?, 'Super Admin', ?, 'superadmin', 'active')`,
    ['admin@tecnocaja.app', hash]).catch(() => {});
  console.log(`[admin] Admin creado — email: admin@tecnocaja.app  pass: ${defaultPass}`);
  console.log('[admin] Cambia la contraseña desde el panel o define ADMIN_DEFAULT_PASSWORD en .env');
}

async function auditLog(actor, action, target, detail) {
  await query(`INSERT INTO admin_audit_log (actor, action, target, detail) VALUES (?,?,?,?)`,
    [actor, action, target || null, detail || null]).catch(() => {});
}

// ── Init ───────────────────────────────────────────────────────────────────
(async () => {
  await ensureAdminTables();
  await ensureFirstAdmin();
})();

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/status', (_req, res) => res.json({ ok: true, mode: 'local-mariadb', dbReady, dbError }));

// ── Auth ───────────────────────────────────────────────────────────────────
app.get('/api/auth/first-run', async (_req, res) => {
  if (!dbReady) {
    return res.json({ firstRun: false, dbReady: false, dbError: dbError || 'Conectando a la base de datos...' });
  }
  try {
    const rows = await query(`SELECT id FROM platform_admins LIMIT 1`);
    res.json({ firstRun: rows.length === 0, dbReady: true });
  } catch (e) {
    res.json({ firstRun: false, dbReady: false, dbError: e.message });
  }
});

app.post('/api/auth/setup', async (req, res) => {
  const { email, password, nombre } = req.body;
  if (!email || !password || !nombre) return res.status(400).json({ error: 'email, password y nombre son requeridos.' });
  try {
    const [existing] = await query(`SELECT id FROM platform_admins LIMIT 1`).catch(() => []);
    if (existing) return res.status(403).json({ error: 'Ya existe un administrador. Inicia sesión.' });
    await query(`INSERT INTO platform_admins (email, nombre, password_hash) VALUES (?,?,?)`,
      [email, nombre, hashPassword(password)]);
    const token = await signToken({ email, nombre, role: 'superadmin' });
    res.json({ ok: true, token, nombre });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Correo y contraseña son requeridos.' });
  try {
    const [admin] = await query(`SELECT * FROM platform_admins WHERE email=? AND status='active' LIMIT 1`, [email]).catch(() => []);
    if (!admin || !checkPassword(password, admin.password_hash))
      return res.status(401).json({ error: 'Credenciales incorrectas.' });
    const token = await signToken({ email: admin.email, nombre: admin.nombre, role: admin.role });
    res.json({ ok: true, token, nombre: admin.nombre });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard ──────────────────────────────────────────────────────────────
app.get('/api/dashboard', requireAuth, async (_req, res) => {
  try {
    const [negocios]   = await query(`SELECT COUNT(*) as total FROM cloud_businesses`).catch(() => [{ total: 0 }]);
    const [contadores] = await query(`SELECT COUNT(*) as total FROM contadores WHERE estado='activo'`).catch(() => [{ total: 0 }]);
    const [solicitudes]= await query(`SELECT COUNT(*) as total FROM solicitudes WHERE status='pendiente'`).catch(() => [{ total: 0 }]);

    const licStats = await query(`SELECT license_status, COUNT(*) as cnt FROM cloud_businesses GROUP BY license_status`).catch(() => []);
    const licMap = {};
    licStats.forEach(r => { licMap[r.license_status] = r.cnt; });

    const recientes = await query(`SELECT * FROM cloud_businesses ORDER BY created_at DESC LIMIT 10`).catch(() => []);

    res.json({
      totales: {
        negocios:    negocios?.total  || 0,
        contadores:  contadores?.total || 0,
        activas:     licMap.active    || 0,
        prueba:      licMap.trial     || 0,
        pendientes:  licMap.pending   || 0,
        vencidas:    (licMap.expired  || 0) + (licMap.cancelled || 0),
        suspendidas: licMap.suspended || 0,
        solicitudesPendientes: solicitudes?.total || 0,
      },
      ultimosNegocios: recientes,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Negocios (tabla cloud_businesses del POS) ──────────────────────────────
app.get('/api/negocios', requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const rows = status
      ? await query(`SELECT cb.*, c.nombre_firma as contador_nombre FROM cloud_businesses cb LEFT JOIN contadores c ON c.id=cb.accountant_id WHERE cb.license_status=? ORDER BY cb.created_at DESC`, [status])
      : await query(`SELECT cb.*, c.nombre_firma as contador_nombre FROM cloud_businesses cb LEFT JOIN contadores c ON c.id=cb.accountant_id ORDER BY cb.created_at DESC`);
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/negocios/:id', requireAuth, async (req, res) => {
  try {
    const [row] = await query(`SELECT cb.*, c.nombre_firma as contador_nombre FROM cloud_businesses cb LEFT JOIN contadores c ON c.id=cb.accountant_id WHERE cb.id=?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Negocio no encontrado.' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Licencias ──────────────────────────────────────────────────────────────
app.post('/api/negocios/:id/licencia', requireAuth, async (req, res) => {
  const ACCIONES = ['activar', 'suspender', 'cancelar', 'renovar', 'trial', 'pendiente'];
  const { accion, plan, dias, notas } = req.body;
  if (!ACCIONES.includes(accion)) return res.status(400).json({ error: 'Acción inválida.' });

  try {
    const [biz] = await query(`SELECT * FROM cloud_businesses WHERE id=?`, [req.params.id]);
    if (!biz) return res.status(404).json({ error: 'Negocio no encontrado.' });

    const now = new Date();
    const isoNow = now.toISOString().slice(0, 19).replace('T', ' ');

    let newStatus, expiresAt = null, trialStart = null, trialEnd = null;
    switch (accion) {
      case 'activar':   newStatus = 'active'; break;
      case 'suspender': newStatus = 'suspended'; break;
      case 'cancelar':  newStatus = 'cancelled'; break;
      case 'pendiente': newStatus = 'pending'; break;
      case 'trial':
        newStatus   = 'trial';
        trialStart  = isoNow;
        trialEnd    = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
        break;
      case 'renovar':
        newStatus   = 'active';
        expiresAt   = new Date(now.getTime() + (Number(dias) || 365) * 86400000).toISOString().slice(0, 19).replace('T', ' ');
        break;
    }

    await query(`UPDATE cloud_businesses SET license_status=?, plan=COALESCE(?,plan), updated_at=? WHERE id=?`,
      [newStatus, plan || null, isoNow, req.params.id]);

    if (trialStart)  await query(`UPDATE cloud_businesses SET trial_start_date=?, trial_end_date=? WHERE id=?`, [trialStart, trialEnd, req.params.id]);
    if (expiresAt)   await query(`UPDATE cloud_businesses SET license_expires_at=? WHERE id=?`, [expiresAt, req.params.id]);

    // Historial en tabla licencias
    await query(`INSERT INTO licencias (cloud_business_id, plan, status, activated_by, notes) VALUES (?,?,?,?,?)`,
      [req.params.id, plan || biz.plan || null, newStatus, req.adminUser.email, notas || null]
    ).catch(() => {});

    await auditLog(req.adminUser.email, `licencia.${accion}`, String(req.params.id), `Plan: ${plan || biz.plan}, Notas: ${notas || '—'}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/licencias/:businessId', requireAuth, async (req, res) => {
  try {
    const rows = await query(`SELECT * FROM licencias WHERE business_id=? ORDER BY created_at DESC LIMIT 50`, [req.params.businessId]).catch(() => []);
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Contadores ─────────────────────────────────────────────────────────────
app.get('/api/contadores', requireAuth, async (_req, res) => {
  try {
    const rows = await query(`SELECT c.*, u.usuario, u.email FROM contadores c LEFT JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC`).catch(() => []);
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contadores', requireAuth, async (req, res) => {
  const { nombre_firma, responsable, rnc, telefono, correo, email_acceso, password_acceso } = req.body;
  if (!nombre_firma || !email_acceso || !password_acceso)
    return res.status(400).json({ error: 'Nombre, correo de acceso y contraseña son requeridos.' });
  try {
    const [existingUser] = await query(`SELECT id FROM users WHERE email=? OR usuario=?`, [email_acceso, email_acceso]);
    if (existingUser) return res.status(409).json({ error: 'Ese correo ya está registrado en el sistema.' });

    const [roleRow] = await query(`SELECT id FROM roles WHERE codigo='contador_asociado' LIMIT 1`).catch(() => []);
    const roleId = roleRow?.id || 7;
    const hash = require(path.join(ROOT, 'server.js')) ? null : null; // usamos la misma función del servidor

    // Usar el formato de hash del POS (scrypt)
    const passHash = hashPassword(password_acceso);
    const [result] = await query(
      `INSERT INTO users (usuario, email, password_hash, nombre, rol, role_id, estado, auth_provider) VALUES (?,?,?,?,?,?,'Activo','local')`,
      [email_acceso, email_acceso, passHash, responsable || nombre_firma, 'Contador Asociado', roleId]
    );
    const userId = result?.insertId;

    const [contResult] = await query(
      `INSERT INTO contadores (user_id, nombre_firma, responsable, rnc, telefono, correo, estado) VALUES (?,?,?,?,?,?,'activo')`,
      [userId, nombre_firma, responsable || null, rnc || null, telefono || null, correo || email_acceso]
    );

    await auditLog(req.adminUser.email, 'contador.crear', String(contResult?.insertId), nombre_firma);
    const [nuevo] = await query(`SELECT * FROM contadores WHERE id=?`, [contResult?.insertId]);
    res.status(201).json(nuevo || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contadores/:id/suspender', requireAuth, async (req, res) => {
  try {
    const [cont] = await query(`SELECT * FROM contadores WHERE id=?`, [req.params.id]);
    if (!cont) return res.status(404).json({ error: 'Contador no encontrado.' });
    await query(`UPDATE contadores SET estado='suspendido' WHERE id=?`, [req.params.id]);
    if (cont.user_id) await query(`UPDATE users SET estado='Inactivo' WHERE id=?`, [cont.user_id]).catch(() => {});
    await auditLog(req.adminUser.email, 'contador.suspender', req.params.id, cont.nombre_firma);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contadores/:id/reactivar', requireAuth, async (req, res) => {
  try {
    const [cont] = await query(`SELECT * FROM contadores WHERE id=?`, [req.params.id]);
    if (!cont) return res.status(404).json({ error: 'Contador no encontrado.' });
    await query(`UPDATE contadores SET estado='activo' WHERE id=?`, [req.params.id]);
    if (cont.user_id) await query(`UPDATE users SET estado='Activo' WHERE id=?`, [cont.user_id]).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/contadores/:id', requireAuth, async (req, res) => {
  try {
    const [cont] = await query(`SELECT * FROM contadores WHERE id=?`, [req.params.id]);
    if (!cont) return res.status(404).json({ error: 'Contador no encontrado.' });
    await query(`DELETE FROM contadores WHERE id=?`, [req.params.id]);
    if (cont.user_id) await query(`DELETE FROM users WHERE id=?`, [cont.user_id]).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Solicitudes ────────────────────────────────────────────────────────────
app.get('/api/solicitudes', requireAuth, async (req, res) => {
  try {
    const rows = req.query.status
      ? await query(`SELECT s.*, cb.nombre_negocio FROM solicitudes s LEFT JOIN cloud_businesses cb ON cb.id=s.cloud_business_id WHERE s.status=? ORDER BY s.created_at DESC LIMIT 200`, [req.query.status])
      : await query(`SELECT s.*, cb.nombre_negocio FROM solicitudes s LEFT JOIN cloud_businesses cb ON cb.id=s.cloud_business_id ORDER BY s.created_at DESC LIMIT 200`);
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/solicitudes/:id', requireAuth, async (req, res) => {
  const { status, respuesta } = req.body;
  try {
    await query(`UPDATE solicitudes SET status=?, respuesta=?, responded_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [status, respuesta || null, req.adminUser.email, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Actualizaciones ────────────────────────────────────────────────────────
app.get('/api/actualizaciones', requireAuth, async (_req, res) => {
  try {
    const rows = await query(`SELECT * FROM admin_versions ORDER BY created_at DESC LIMIT 50`).catch(() => []);
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/actualizaciones', requireAuth, async (req, res) => {
  const { version, descripcion, url_descarga, es_obligatoria } = req.body;
  if (!version) return res.status(400).json({ error: 'Versión es requerida.' });
  try {
    const [result] = await query(
      `INSERT INTO admin_versions (version, descripcion, url_descarga, es_obligatoria, publicado_por) VALUES (?,?,?,?,?)`,
      [version, descripcion || null, url_descarga || null, es_obligatoria ? 1 : 0, req.adminUser.email]
    );
    const [row] = await query(`SELECT * FROM admin_versions WHERE id=?`, [result?.insertId]);
    res.status(201).json(row || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auditoría ──────────────────────────────────────────────────────────────
app.get('/api/auditoria', requireAuth, async (_req, res) => {
  try {
    const rows = await query(`SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT 200`).catch(() => []);
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Licencias overview (para módulo de licencias) ──────────────────────────
app.get('/api/licencias-resumen', requireAuth, async (_req, res) => {
  try {
    const stats = await query(`SELECT license_status, COUNT(*) as cnt FROM cloud_businesses GROUP BY license_status`).catch(() => []);
    const m = {};
    (stats || []).forEach(r => { m[r.license_status] = r.cnt; });
    res.json(m);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback ───────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;

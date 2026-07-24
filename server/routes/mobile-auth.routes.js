/**
 * mobile-auth.routes.js
 *
 * Vinculación de la app Android (Tecno_Caja_POS_Android_Pro) con esta
 * instalación de Tecno Caja Windows, usando el mismo Tecno Caja ID (Google)
 * que ya soporta `POST /api/login/google` en server.js.
 *
 * Flujo: el celular inicia sesión con Firebase (Google) igual que ya hace en
 * la app. Envía ese idToken aquí. Si el firebase_uid (o el correo) coincide
 * con un usuario activo de `users`, se vincula el dispositivo y se emiten
 * tokens propios (opacos, hash SHA-256 en BD, nunca JWT) -- separados de
 * `sesiones_activas` porque esa tabla invalida la sesión anterior del mismo
 * tipo en cada login nuevo (no sirve para multi-dispositivo real, ver
 * server/routes/mobile-sync.routes.js).
 *
 * Rutas registradas bajo /api/mobile-auth:
 *   POST /login       - Intercambia un idToken de Firebase por tokens móviles
 *   POST /login-local - Usuario/contraseña locales del POS (misma cuenta con la
 *                       que ese cajero ya entra en Windows, sin pasar por Firebase)
 *   POST /refresh     - Rota el access token usando el refresh token
 *   POST /logout      - Revoca los tokens del dispositivo actual
 */

const crypto = require('crypto');
const express = require('express');

const ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function generateOpaqueToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Mapea el rol libre de Windows (español) al enum RolBase de la app Flutter.
// Debe reflejar lib/core/constants/roles.dart -- si se agrega un rol nuevo
// allá, agregarlo aquí también.
function mapPosRoleToAppRole(rawRole) {
  const normalized = String(rawRole || '').trim().toLowerCase();
  if (normalized === 'administrador') return 'administradorGeneral';
  if (normalized === 'administrador sucursal') return 'administradorSucursal';
  if (normalized === 'supervisor') return 'supervisor';
  if (normalized === 'cajero') return 'cajero';
  return 'cajero';
}

let _tablesReady = false;
async function ensureMobileAuthTables(query) {
  if (_tablesReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS mobile_devices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      device_id VARCHAR(191) NOT NULL,
      device_name VARCHAR(160) DEFAULT NULL,
      platform VARCHAR(40) DEFAULT NULL,
      app_version VARCHAR(40) DEFAULT NULL,
      last_seen_at DATETIME DEFAULT NULL,
      revoked_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mobile_devices_user_device (user_id, device_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS mobile_access_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      device_id INT NOT NULL,
      access_token_hash VARCHAR(128) NOT NULL,
      refresh_token_hash VARCHAR(128) NOT NULL,
      access_expires_at DATETIME NOT NULL,
      refresh_expires_at DATETIME NOT NULL,
      revoked_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_mobile_tokens_device (device_id),
      KEY idx_mobile_tokens_access_hash (access_token_hash),
      KEY idx_mobile_tokens_refresh_hash (refresh_token_hash)
    )
  `);
  _tablesReady = true;
}

/**
 * Valida un access token móvil (Bearer opaco) y devuelve el usuario Windows
 * + el device asociado. Lo usa mobile-sync.routes.js como su propio
 * middleware de auth -- deliberadamente independiente del middleware de
 * `sesiones_activas` que usa el resto del POS.
 */
async function verifyMobileAccessToken(query, accessToken) {
  const token = String(accessToken || '').trim();
  if (!token) return null;

  await ensureMobileAuthTables(query);

  const rows = await query(
    `SELECT t.id AS token_id, t.device_id, t.access_expires_at,
            d.user_id, d.device_id AS device_public_id, d.revoked_at AS device_revoked_at,
            u.*
     FROM mobile_access_tokens t
     JOIN mobile_devices d ON d.id = t.device_id
     JOIN users u ON u.id = d.user_id
     WHERE t.access_token_hash = ? AND t.revoked_at IS NULL
     LIMIT 1`,
    [sha256(token)]
  );
  const row = rows[0];
  if (!row) return null;
  if (row.device_revoked_at) return null;
  if (new Date(row.access_expires_at).getTime() <= Date.now()) return null;
  if (String(row.estado || '').trim().toLowerCase() !== 'activo') return null;

  return { user: row, mobileDeviceId: row.device_id };
}

module.exports = function createMobileAuthRouter(deps) {
  const {
    query,
    verifyFirebaseIdToken,
    getFirebaseConfigStatus,
    writeAuditLog,
    userPasswordMatches,
    checkLoginRateLimit,
    resetLoginRateLimit,
  } = deps;
  const router = express.Router();

  async function buildBusinessPayload() {
    const configRows = await query('SELECT * FROM config WHERE id = 1 LIMIT 1');
    const config = configRows[0] || {};
    const branches = await query(
      "SELECT id, nombre, codigo, direccion, telefono FROM branches WHERE estado = 'Activa' ORDER BY nombre ASC"
    );
    const cashRegisters = await query(
      "SELECT id, branch_id, nombre, codigo FROM cash_registers WHERE estado = 'Activa' ORDER BY nombre ASC"
    );
    return {
      nombre: config.business_name || 'Mi negocio',
      rnc: config.rnc || null,
      direccion: config.address || null,
      telefono: config.phone || null,
      moneda: String(config.currency || 'RD$').toUpperCase().includes('US') ? 'USD' : 'DOP',
      tasaItbis: Number(config.tax_rate || 18) / 100,
      sucursales: branches.map((b) => ({
        id: String(b.id),
        nombre: b.nombre,
        codigo: b.codigo || null,
        direccion: b.direccion || null,
        telefono: b.telefono || null,
      })),
      cajas: cashRegisters.map((c) => ({
        id: String(c.id),
        sucursalId: String(c.branch_id),
        nombre: c.nombre,
        codigo: c.codigo || null,
      })),
    };
  }

  /**
   * Comun a /login (Google) y /login-local (usuario/contraseña): registra o
   * actualiza el `mobile_devices` de este device, revoca tokens moviles
   * previos del mismo device y emite unos nuevos. Ambas rutas ya validaron
   * `user` antes de llegar aqui.
   */
  async function issueMobileSession({ user, deviceId, deviceName, platform, appVersion, authMethod }) {
    const now = new Date();
    const existingDeviceRows = await query(
      'SELECT id FROM mobile_devices WHERE user_id = ? AND device_id = ? LIMIT 1',
      [user.id, deviceId]
    );
    let mobileDeviceId;

    if (existingDeviceRows.length) {
      mobileDeviceId = existingDeviceRows[0].id;
      await query(
        `UPDATE mobile_devices
         SET device_name = ?, platform = ?, app_version = ?, last_seen_at = ?, revoked_at = NULL
         WHERE id = ?`,
        [deviceName, platform, appVersion, now, mobileDeviceId]
      );
    } else {
      const insertResult = await query(
        `INSERT INTO mobile_devices (user_id, device_id, device_name, platform, app_version, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [user.id, deviceId, deviceName, platform, appVersion, now]
      );
      mobileDeviceId = insertResult.insertId;
    }

    // Un dispositivo, una sesion movil activa a la vez -- revocar tokens
    // previos de este mismo device antes de emitir los nuevos.
    await query('UPDATE mobile_access_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL', [
      now,
      mobileDeviceId,
    ]);

    const accessToken = generateOpaqueToken();
    const refreshToken = generateOpaqueToken();
    const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await query(
      `INSERT INTO mobile_access_tokens
         (device_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [mobileDeviceId, sha256(accessToken), sha256(refreshToken), accessExpiresAt, refreshExpiresAt]
    );

    const negocio = await buildBusinessPayload();

    await writeAuditLog({
      userId: user.id,
      userName: user.nombre,
      userRole: user.rol,
      moduleName: 'App móvil',
      actionName: 'Vinculación de dispositivo móvil',
      detail: `Dispositivo ${deviceName || deviceId} (${platform}) vinculado vía ${authMethod}`,
    });

    return {
      accessToken,
      refreshToken,
      accessExpiresAt: accessExpiresAt.toISOString(),
      refreshExpiresAt: refreshExpiresAt.toISOString(),
      negocio,
    };
  }

  function readDeviceFields(req) {
    return {
      deviceId: String(req.body?.deviceId || '').trim(),
      deviceName: String(req.body?.deviceName || '').trim() || null,
      platform: String(req.body?.platform || 'android').trim(),
      appVersion: String(req.body?.appVersion || '').trim() || null,
    };
  }

  router.post('/login', async (req, res, next) => {
    try {
      await ensureMobileAuthTables(query);

      const firebaseStatus = getFirebaseConfigStatus();
      if (!firebaseStatus.enabled) {
        return res.status(503).json({
          error: firebaseStatus.reason || 'Firebase no esta configurado en este POS.',
        });
      }

      const { deviceId, deviceName, platform, appVersion } = readDeviceFields(req);
      if (!deviceId) {
        return res.status(400).json({ error: 'Falta el identificador del dispositivo.' });
      }

      let decodedToken;
      try {
        decodedToken = await verifyFirebaseIdToken(String(req.body?.idToken || '').trim());
      } catch (_error) {
        return res.status(401).json({ error: 'Token de Google invalido o expirado.' });
      }

      const email = String(decodedToken.email || '').trim().toLowerCase();

      let rows = await query(
        `SELECT * FROM users
         WHERE firebase_uid = ? AND estado = 'Activo' AND COALESCE(account_type, 'staff') <> 'customer'
         LIMIT 1`,
        [decodedToken.uid]
      );
      if (!rows.length && email) {
        rows = await query(
          `SELECT * FROM users
           WHERE email = ? AND estado = 'Activo' AND COALESCE(account_type, 'staff') <> 'customer'
           LIMIT 1`,
          [email]
        );
      }

      const user = rows[0];
      if (!user) {
        return res.status(404).json({
          error: 'not_linked',
          message:
            'Tu cuenta de Google no esta vinculada a ningun usuario activo de este POS. ' +
            'Inicia sesion con esa misma cuenta de Google al menos una vez en la computadora, ' +
            'o pide al administrador que la vincule desde Usuarios.',
        });
      }

      if (!String(user.firebase_uid || '').trim() || user.firebase_uid !== decodedToken.uid) {
        await query('UPDATE users SET firebase_uid = ?, auth_provider = ? WHERE id = ?', [
          decodedToken.uid,
          'google',
          user.id,
        ]);
      }

      const sesion = await issueMobileSession({
        user,
        deviceId,
        deviceName,
        platform,
        appVersion,
        authMethod: 'Google',
      });

      res.json({
        ...sesion,
        usuario: {
          id: String(user.id),
          nombre: user.nombre,
          usuario: user.usuario,
          email: user.email || email || null,
          telefono: user.telefono || null,
          rol: mapPosRoleToAppRole(user.rol),
          sucursalId: user.sucursal_id || user.branch_id ? String(user.sucursal_id || user.branch_id) : null,
          cajaId: user.caja_id ? String(user.caja_id) : null,
          firebaseUid: decodedToken.uid,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Login con el mismo usuario/contraseña local que ese cajero ya usa para
   * entrar en Windows (tabla `users.password_hash`) -- para cuentas de POS
   * que nunca han iniciado sesion con Google. No toca `firebase_uid`: es un
   * camino de autenticacion totalmente separado del de /login.
   */
  router.post('/login-local', async (req, res, next) => {
    try {
      await ensureMobileAuthTables(query);

      const { deviceId, deviceName, platform, appVersion } = readDeviceFields(req);
      if (!deviceId) {
        return res.status(400).json({ error: 'Falta el identificador del dispositivo.' });
      }

      const usuario = String(req.body?.usuario || '').trim();
      const password = String(req.body?.password || '');
      if (!usuario || !password) {
        return res.status(400).json({ error: 'Usuario y contraseña son requeridos.' });
      }

      const rlKey = `mobile:${req.ip || ''}:${usuario}`;
      const rl = checkLoginRateLimit(rlKey);
      if (!rl.allowed) {
        return res.status(429).json({
          error: `Demasiados intentos fallidos. Espera ${Math.ceil(rl.retryAfter / 60)} minutos.`,
          retry_after: rl.retryAfter,
        });
      }

      const rows = await query(
        `SELECT * FROM users
         WHERE usuario = ? AND estado = 'Activo' AND COALESCE(account_type, 'staff') <> 'customer'
         LIMIT 1`,
        [usuario]
      );
      const user = rows[0];
      if (!user || !userPasswordMatches(user, password)) {
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
      }
      resetLoginRateLimit(rlKey);

      const sesion = await issueMobileSession({
        user,
        deviceId,
        deviceName,
        platform,
        appVersion,
        authMethod: 'usuario/contraseña',
      });

      res.json({
        ...sesion,
        usuario: {
          id: String(user.id),
          nombre: user.nombre,
          usuario: user.usuario,
          email: user.email || null,
          telefono: user.telefono || null,
          rol: mapPosRoleToAppRole(user.rol),
          sucursalId: user.sucursal_id || user.branch_id ? String(user.sucursal_id || user.branch_id) : null,
          cajaId: user.caja_id ? String(user.caja_id) : null,
          firebaseUid: String(user.firebase_uid || '').trim() || null,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/refresh', async (req, res, next) => {
    try {
      await ensureMobileAuthTables(query);
      const refreshToken = String(req.body?.refreshToken || '').trim();
      if (!refreshToken) {
        return res.status(400).json({ error: 'Falta el refresh token.' });
      }

      const rows = await query(
        `SELECT t.id AS token_id, t.device_id, t.refresh_expires_at
         FROM mobile_access_tokens t
         WHERE t.refresh_token_hash = ? AND t.revoked_at IS NULL
         LIMIT 1`,
        [sha256(refreshToken)]
      );
      const tokenRow = rows[0];
      if (!tokenRow || new Date(tokenRow.refresh_expires_at).getTime() <= Date.now()) {
        return res.status(401).json({ error: 'Refresh token invalido o expirado. Vuelve a iniciar sesión.' });
      }

      const now = new Date();
      await query('UPDATE mobile_access_tokens SET revoked_at = ? WHERE id = ?', [now, tokenRow.token_id]);

      const accessToken = generateOpaqueToken();
      const newRefreshToken = generateOpaqueToken();
      const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
      const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

      await query(
        `INSERT INTO mobile_access_tokens
           (device_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [tokenRow.device_id, sha256(accessToken), sha256(newRefreshToken), accessExpiresAt, refreshExpiresAt]
      );
      await query('UPDATE mobile_devices SET last_seen_at = ? WHERE id = ?', [now, tokenRow.device_id]);

      res.json({
        accessToken,
        refreshToken: newRefreshToken,
        accessExpiresAt: accessExpiresAt.toISOString(),
        refreshExpiresAt: refreshExpiresAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      await ensureMobileAuthTables(query);
      const authHeader = String(req.headers.authorization || '');
      const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (accessToken) {
        await query('UPDATE mobile_access_tokens SET revoked_at = ? WHERE access_token_hash = ?', [
          new Date(),
          sha256(accessToken),
        ]);
      }
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
};

module.exports.ensureMobileAuthTables = ensureMobileAuthTables;
module.exports.verifyMobileAccessToken = verifyMobileAccessToken;

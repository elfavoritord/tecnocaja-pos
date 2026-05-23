const os = require('os');
const crypto = require('crypto');
const firebaseSync = require('./firebase-sync');

function getPublicBaseUrl() {
  return String(
    process.env.POS_PUBLIC_BASE_URL ||
      process.env.MOBILE_POS_PUBLIC_URL ||
      ''
  )
    .trim()
    .replace(/\/$/, '');
}

function getPreferredMobileBaseUrl() {
  const publicBaseUrl = getPublicBaseUrl();
  if (publicBaseUrl) return publicBaseUrl;
  return `http://${getLocalIPv4()}:${process.env.PORT || 3000}`;
}

function buildMobileConnectionQrValue(connectionCode, preferredBaseUrl = '') {
  const normalizedCode = String(connectionCode || '').trim().toUpperCase();
  const normalizedBaseUrl = String(preferredBaseUrl || '').trim().replace(/\/$/, '');
  if (normalizedBaseUrl) {
    return `TECNO-CAJA-CONNECT:${normalizedCode}|${normalizedBaseUrl}`;
  }
  return `TECNO-CAJA-CONNECT:${normalizedCode}`;
}

function generateMobileConnectionCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let token = '';
  for (let index = 0; index < 8; index += 1) {
    token += chars[bytes[index] % chars.length];
  }
  return `POS-${token.slice(0, 4)}-${token.slice(4)}`;
}

function getLocalIPv4() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const item of addresses || []) {
      if (item.family === 'IPv4' && !item.internal) {
        return item.address;
      }
    }
  }
  return '127.0.0.1';
}

function mapMobileItemRow(row) {
  return {
    productId: row.product_id,
    codigo: row.codigo,
    nombre: row.nombre,
    precio: Number(row.precio_venta || 0),
    cantidad: Number(row.qty || 0),
    stock: Number(row.stock || 0),
    subtotal: Number(row.line_total || 0)
  };
}

function mapMobileSessionRow(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    userId: row.user_id,
    userName: row.user_name,
    userRole: row.user_role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    latitud: row.current_latitude === null ? null : Number(row.current_latitude),
    longitud: row.current_longitude === null ? null : Number(row.current_longitude),
    precisionMetros: row.location_accuracy_meters === null ? null : Number(row.location_accuracy_meters),
    lastLocationAt: row.last_location_at || null,
    itemCount: Number(row.item_count || 0),
    total: Number(row.total_amount || 0)
  };
}

function mapDeliveryOrderRow(row) {
  return {
    invoiceNumber: row.invoice_number,
    clientName: row.client_name_snapshot || row.client_name || 'Consumidor Final',
    clientPhone: row.client_phone_snapshot || row.client_phone || '',
    address: row.delivery_address_snapshot || '',
    reference: row.delivery_reference_snapshot || '',
    locationLink: row.delivery_location_link_snapshot || '',
    total: Number(row.total || 0),
    paymentMethod: row.payment_method || '',
    createdAt: row.created_at,
    status: row.kitchen_status || 'pendiente',
    itemsCount: Number(row.items_count || 0),
    notes: row.order_notes || ''
  };
}

async function ensureMobileTables(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS mobile_sessions (
      id VARCHAR(40) PRIMARY KEY,
      device_id VARCHAR(120) NOT NULL,
      device_name VARCHAR(160) NOT NULL,
      user_id INT NULL,
      user_name VARCHAR(160) NULL,
      user_role VARCHAR(80) NULL,
      current_latitude DECIMAL(10,7) NULL,
      current_longitude DECIMAL(10,7) NULL,
      location_accuracy_meters DECIMAL(10,2) NULL,
      last_location_at DATETIME NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query('ALTER TABLE mobile_sessions ADD COLUMN user_id INT NULL').catch(() => {});
  await query('ALTER TABLE mobile_sessions ADD COLUMN user_name VARCHAR(160) NULL').catch(() => {});
  await query('ALTER TABLE mobile_sessions ADD COLUMN user_role VARCHAR(80) NULL').catch(() => {});
  await query('ALTER TABLE mobile_sessions ADD COLUMN current_latitude DECIMAL(10,7) NULL').catch(() => {});
  await query('ALTER TABLE mobile_sessions ADD COLUMN current_longitude DECIMAL(10,7) NULL').catch(() => {});
  await query('ALTER TABLE mobile_sessions ADD COLUMN location_accuracy_meters DECIMAL(10,2) NULL').catch(() => {});
  await query('ALTER TABLE mobile_sessions ADD COLUMN last_location_at DATETIME NULL').catch(() => {});
  await query(`
    CREATE TABLE IF NOT EXISTS mobile_session_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id VARCHAR(40) NOT NULL,
      product_id INT NOT NULL,
      qty DECIMAL(10,2) NOT NULL DEFAULT 1,
      line_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_mobile_session_items_session FOREIGN KEY (session_id) REFERENCES mobile_sessions(id) ON DELETE CASCADE,
      CONSTRAINT fk_mobile_session_items_product FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_session_product
    ON mobile_session_items (session_id, product_id)
  `).catch(() => {});
}

async function ensureDeliveryLocationsTable(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS delivery_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id VARCHAR(40) DEFAULT NULL,
      user_id INT DEFAULT NULL,
      user_name VARCHAR(160) DEFAULT NULL,
      latitude DECIMAL(10,7) NOT NULL,
      longitude DECIMAL(10,7) NOT NULL,
      accuracy_meters DECIMAL(10,2) DEFAULT NULL,
      source VARCHAR(40) NOT NULL DEFAULT 'mobile',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function ensureMobileSettingsTable(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS mobile_pos_settings (
      id TINYINT PRIMARY KEY,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    INSERT OR IGNORE INTO mobile_pos_settings (id, enabled, updated_at)
    VALUES (1, 1, datetime('now'))
  `);
}

async function getMobileSettings(query) {
  await ensureMobileSettingsTable(query);
  const rows = await query('SELECT enabled, updated_at FROM mobile_pos_settings WHERE id = 1 LIMIT 1');
  return {
    enabled: Boolean(Number(rows[0]?.enabled ?? 1)),
    updatedAt: rows[0]?.updated_at || null
  };
}

async function ensureMobileAccessAllowed(query, sessionId = null) {
  const settings = await getMobileSettings(query);
  if (!settings.enabled) {
    const error = new Error('El acceso móvil está bloqueado desde el POS.');
    error.statusCode = 403;
    throw error;
  }

  if (!sessionId) return;

  const rows = await query('SELECT status FROM mobile_sessions WHERE id = ? LIMIT 1', [sessionId]);
  const status = String(rows[0]?.status || '').toLowerCase();
  if (status === 'blocked') {
    const error = new Error('Esta sesión móvil fue bloqueada desde el POS.');
    error.statusCode = 403;
    throw error;
  }
  if (status === 'closed') {
    const error = new Error('Esta sesión móvil ya fue cerrada.');
    error.statusCode = 403;
    throw error;
  }
}

function getMobileActor(req) {
  return {
    userId: req.body?.actorUserId || null,
    userName: req.body?.actorUserName || 'POS Movil',
    userRole: req.body?.actorUserRole || 'Movil'
  };
}

async function listSessions(query) {
  const rows = await query(`
    SELECT
      ms.*,
      COUNT(msi.id) AS item_count,
      COALESCE(SUM(msi.line_total), 0) AS total_amount
    FROM mobile_sessions ms
    LEFT JOIN mobile_session_items msi ON msi.session_id = ms.id
    GROUP BY ms.id
    ORDER BY ms.updated_at DESC
  `);
  return rows.map(mapMobileSessionRow);
}

async function getSessionDetail(query, sessionId) {
  const sessionRows = await query(`
    SELECT
      ms.*,
      COUNT(msi.id) AS item_count,
      COALESCE(SUM(msi.line_total), 0) AS total_amount
    FROM mobile_sessions ms
    LEFT JOIN mobile_session_items msi ON msi.session_id = ms.id
    WHERE ms.id = ?
    GROUP BY ms.id
    LIMIT 1
  `, [sessionId]);

  if (!sessionRows.length) return null;

  const itemRows = await query(`
    SELECT
      msi.*,
      p.codigo,
      p.nombre,
      p.precio_venta,
      p.stock
    FROM mobile_session_items msi
    INNER JOIN products p ON p.id = msi.product_id
    WHERE msi.session_id = ?
    ORDER BY msi.id
  `, [sessionId]);

  return {
    ...mapMobileSessionRow(sessionRows[0]),
    items: itemRows.map(mapMobileItemRow)
  };
}

async function broadcastSession(io, query, sessionId) {
  const detail = await getSessionDetail(query, sessionId);
  const sessions = await listSessions(query);
  io.to(`mobile-session:${sessionId}`).emit('mobile:session-updated', detail);
  io.emit('mobile:sessions-updated', sessions);
}

function registerMobilePos({
  app,
  io,
  query,
  withTransaction,
  getConfig,
  writeAuditLog,
  saveLatestSecureBackup,
  syncPosAccountsToFirebase = async () => ({ synced: false }),
  getFirebaseConfigStatus = () => ({ enabled: false, reason: 'Firebase no configurado.' }),
  verifyFirebaseIdToken = null,
}) {
  async function loginStaffWithFirebaseToken(req, res) {
    await ensureMobileTables(query);
    await ensureMobileAccessAllowed(query);
    const firebaseStatus = getFirebaseConfigStatus();
    if (!firebaseStatus.enabled || typeof verifyFirebaseIdToken !== 'function') {
      return res.status(503).json({
        error: firebaseStatus.reason || 'Firebase no esta configurado para el acceso móvil con Firebase.',
        collection: firebaseStatus.collection
      });
    }

    const decodedToken = await verifyFirebaseIdToken(String(req.body?.idToken || '').trim());
    const email = String(decodedToken.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'La cuenta Firebase debe tener un correo disponible.' });
    }

    let rows = await query(
      `SELECT * FROM users
       WHERE firebase_uid = ?
         AND estado = "Activo"
         AND COALESCE(account_type, "staff") <> "customer"
       LIMIT 1`,
      [decodedToken.uid]
    );

    if (!rows.length) {
      rows = await query(
        `SELECT * FROM users
         WHERE email = ?
           AND estado = "Activo"
           AND COALESCE(account_type, "staff") <> "customer"
         LIMIT 1`,
        [email]
      );
    }

    const user = rows[0];
    if (!user) {
      return res.status(403).json({
        error: 'Tu cuenta Firebase no está asignada a un usuario activo del POS.'
      });
    }

    const provider =
      String(decodedToken.firebase?.sign_in_provider || user.auth_provider || 'password').trim() ||
      'password';
    const displayName = String(decodedToken.name || user.nombre || '').trim() || user.nombre;
    const now = new Date().toLocaleString('sv-SE').replace(' ', ' ');
    await query(
      `UPDATE users
       SET email = ?, nombre = ?, firebase_uid = ?, auth_provider = ?, last_login = ?
       WHERE id = ?`,
      [email, displayName, decodedToken.uid, provider, now, user.id]
    );

    await writeAuditLog({
      userId: user.id,
      userName: displayName,
      userRole: user.rol,
      moduleName: 'POS Movil',
      actionName: 'Inicio de sesión móvil con Firebase',
      detail: `${provider} · ${email}`
    });

    const config = await getConfig();
    const currentUserRows = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [user.id]);
    const currentUser = currentUserRows[0];

    return res.json({
      user: {
        id: currentUser.id,
        usuario: currentUser.usuario,
        email: currentUser.email || '',
        nombre: currentUser.nombre,
        rol: currentUser.rol,
        estado: currentUser.estado,
        lastLogin: now,
        linkedClientId: currentUser.linked_client_id === null || currentUser.linked_client_id === undefined ? null : Number(currentUser.linked_client_id),
        accountType: currentUser.account_type || 'staff',
        authProvider: currentUser.auth_provider || provider
      },
      appName: config.nombre,
      enabled: true
    });
  }

  app.get('/flutter-mobile-pos', async (_req, res) => {
    const mobileBaseUrl = getPreferredMobileBaseUrl();
    const config = await getConfig();
    const connectionCode = String(config.mobileConnectionCode || '').trim().toUpperCase();
    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>POS Móvil</title>
        <style>
          body{font-family:Arial,sans-serif;background:#0f1117;color:#e8eaf0;padding:2rem;line-height:1.5}
          .card{max-width:680px;margin:auto;background:#161b27;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:2rem}
          code{background:#252d42;padding:.25rem .45rem;border-radius:8px}
        </style>
      </head>
      <body>
        <div class="card">
          <h1>POS Móvil por WiFi</h1>
          <p>Usa el código o QR del módulo POS Móvil para vincular esta app Flutter con tu negocio.</p>
          <p><code>${connectionCode || mobileBaseUrl}</code></p>
          <p>Luego podrás buscar productos, iniciar con tu correo asignado y sincronizar el carrito en tiempo real.</p>
        </div>
      </body>
      </html>
    `);
  });

  app.get('/api/mobile/config', async (_req, res) => {
    await ensureMobileTables(query);
    const settings = await getMobileSettings(query);
    const config = await getConfig();
    const firebaseStatus = getFirebaseConfigStatus();
    const publicBaseUrl = getPublicBaseUrl();
    const preferredBaseUrl = getPreferredMobileBaseUrl();
    const connectionCode = String(config.mobileConnectionCode || '').trim().toUpperCase();
    res.json({
      appName: config.nombre,
      currency: config.moneda,
      taxRate: Number(config.itbis || 0),
      host: getLocalIPv4(),
      port: process.env.PORT || 3000,
      publicBaseUrl,
      preferredBaseUrl,
      flutterMobileUrl: `${preferredBaseUrl}/flutter-mobile-pos`,
      connectionCode,
      qrConnectionValue: buildMobileConnectionQrValue(connectionCode, preferredBaseUrl),
      enabled: settings.enabled,
      customerAuthEnabled: firebaseStatus.enabled,
      customerAuthReason: firebaseStatus.reason || '',
      customerAuthCollection: firebaseStatus.collection || ''
    });
  });

  app.post('/api/mobile/login', async (req, res) => {
    await ensureMobileTables(query);
    await ensureMobileAccessAllowed(query);
    const usuario = String(req.body?.usuario || req.body?.email || '').trim();
    const password = String(req.body?.password || '');

    if (!usuario || !password) {
      return res.status(400).json({ error: 'Usuario o correo y contraseña son requeridos.' });
    }

    const rows = await query(
      `SELECT * FROM users
       WHERE (usuario = ? OR email = ?)
         AND password = ?
         AND estado = "Activo"
         AND COALESCE(account_type, "staff") <> "customer"
       LIMIT 1`,
      [usuario, usuario, password]
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    const config = await getConfig();
    const now = new Date().toLocaleString('sv-SE').replace(' ', ' ');
    await query('UPDATE users SET last_login = ? WHERE id = ?', [now, user.id]);
    await writeAuditLog({
      userId: user.id,
      userName: user.nombre,
      userRole: user.rol,
      moduleName: 'POS Movil',
      actionName: 'Inicio de sesión móvil',
      detail: `Acceso móvil con usuario ${user.usuario}`
    });

    res.json({
      user: {
        id: user.id,
        usuario: user.usuario,
        email: user.email || '',
        nombre: user.nombre,
        rol: user.rol,
        estado: user.estado,
        lastLogin: now,
        linkedClientId: user.linked_client_id === null || user.linked_client_id === undefined ? null : Number(user.linked_client_id),
        accountType: user.account_type || 'staff',
        authProvider: user.auth_provider || 'local'
      },
      appName: config.nombre,
      enabled: true
    });
  });

  app.post('/api/mobile/login/firebase', loginStaffWithFirebaseToken);
  app.post('/api/mobile/login/google', loginStaffWithFirebaseToken);

  app.post('/api/mobile/backup/auto-save', async (req, res) => {
    const actor = getMobileActor(req);
    if (!['Administrador', 'Supervisor'].includes(actor.userRole)) {
      return res.status(403).json({ error: 'Solo Administrador o Supervisor pueden crear copias desde el móvil.' });
    }
    const saved = await saveLatestSecureBackup();
    await writeAuditLog({
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      moduleName: 'POS Movil',
      actionName: 'Copia segura desde móvil',
      detail: `Se actualizó la copia segura ${saved.fileName}`
    });
    res.json(saved);
  });

  app.get('/api/mobile/settings', async (_req, res) => {
    res.json(await getMobileSettings(query));
  });

  app.patch('/api/mobile/settings', async (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    await ensureMobileSettingsTable(query);
    await query(
      `UPDATE mobile_pos_settings
       SET enabled = ?, updated_at = datetime('now')
       WHERE id = 1`,
      [enabled ? 1 : 0]
    );
    await writeAuditLog({
      userName: req.body?.actorUserName || 'Sistema',
      userRole: req.body?.actorUserRole || 'Sistema',
      userId: req.body?.actorUserId || null,
      moduleName: 'POS Movil',
      actionName: enabled ? 'POS móvil activado' : 'POS móvil bloqueado',
      detail: enabled ? 'Conexiones móviles habilitadas' : 'Conexiones móviles bloqueadas'
    });
    io.emit('mobile:settings-updated', await getMobileSettings(query));
    res.json(await getMobileSettings(query));
  });

  app.post('/api/mobile/connection-code/regenerate', async (req, res) => {
    await ensureMobileTables(query);
    const nextCode = generateMobileConnectionCode();
    await query('UPDATE config SET mobile_connection_code = ? WHERE id = 1', [nextCode]);
    const syncResult = await syncPosAccountsToFirebase().catch((error) => ({
      synced: false,
      reason: error.message || 'No se pudo resincronizar el código móvil en Firebase.',
    }));
    const config = await getConfig();
    const payload = {
      connectionCode: String(config.mobileConnectionCode || '').trim().toUpperCase(),
      qrConnectionValue: buildMobileConnectionQrValue(
        config.mobileConnectionCode || '',
        getPreferredMobileBaseUrl()
      ),
      publicBaseUrl: getPublicBaseUrl(),
      preferredBaseUrl: getPreferredMobileBaseUrl(),
      flutterMobileUrl: `${getPreferredMobileBaseUrl()}/flutter-mobile-pos`,
      syncResult,
    };
    await writeAuditLog({
      userName: req.body?.actorUserName || 'Sistema',
      userRole: req.body?.actorUserRole || 'Sistema',
      userId: req.body?.actorUserId || null,
      moduleName: 'POS Movil',
      actionName: 'Código móvil regenerado',
      detail: payload.connectionCode,
    });
    io.emit('mobile:settings-updated', {
      ...(await getMobileSettings(query)),
      ...payload,
    });
    res.json(payload);
  });

  app.get('/api/mobile/products', async (req, res) => {
    await ensureMobileTables(query);
    const q = String(req.query.q || '').trim();
    const barcode = String(req.query.barcode || '').trim();
    const search = barcode || q;
    const rows = await query(
      `
      SELECT id, codigo, nombre, categoria, marca, image_url, precio_venta, stock, unidad, estado
      FROM products
      WHERE estado = "Activo"
        AND (
          ? = ""
          OR LOWER(nombre) LIKE LOWER(?)
          OR LOWER(codigo) LIKE LOWER(?)
          OR LOWER(COALESCE(marca, "")) LIKE LOWER(?)
          OR LOWER(COALESCE(categoria, "")) LIKE LOWER(?)
        )
      ORDER BY nombre
      LIMIT 60
      `,
      [search, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`]
    );
    res.json(rows.map((row) => ({
      id: row.id,
      codigo: row.codigo,
      nombre: row.nombre,
      categoria: row.categoria,
      marca: row.marca,
      imagen: row.image_url || '',
      precio: Number(row.precio_venta || 0),
      stock: Number(row.stock || 0),
      unidad: row.unidad,
      estado: row.estado
    })));
  });

  app.get('/api/mobile/products/:id', async (req, res) => {
    const rows = await query(
      'SELECT id, codigo, nombre, categoria, marca, image_url, precio_venta, stock, unidad, estado FROM products WHERE id = ? LIMIT 1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado.' });
    const row = rows[0];
    res.json({
      id: row.id,
      codigo: row.codigo,
      nombre: row.nombre,
      categoria: row.categoria,
      marca: row.marca,
      imagen: row.image_url || '',
      precio: Number(row.precio_venta || 0),
      stock: Number(row.stock || 0),
      unidad: row.unidad,
      estado: row.estado
    });
  });

  app.get('/api/mobile/categories', async (_req, res) => {
    await query(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre VARCHAR(80) NOT NULL UNIQUE,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const rows = await query('SELECT id, nombre FROM categories ORDER BY nombre');
    res.json(rows.map((row) => ({
      id: row.id,
      nombre: row.nombre
    })));
  });

  app.get('/api/mobile/delivery/orders', async (req, res) => {
    await ensureMobileTables(query);
    const userId = Number(req.query.userId || 0);
    if (!userId) {
      return res.status(400).json({ error: 'El usuario delivery es requerido.' });
    }

    const rows = await query(
      `SELECT
        s.*,
        COALESCE(c.nombre, s.client_name_snapshot, 'Consumidor Final') AS client_name,
        COALESCE(c.telefono, '') AS client_phone,
        COUNT(si.id) AS items_count
       FROM sales s
       LEFT JOIN clients c ON c.id = s.client_id
       LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE s.order_type = 'delivery'
         AND s.delivery_user_id = ?
         AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
       GROUP BY s.id
       ORDER BY CASE s.kitchen_status
         WHEN 'pendiente' THEN 1
         WHEN 'en preparacion' THEN 2
         WHEN 'en horno' THEN 3
         WHEN 'lista' THEN 4
         WHEN 'entregada' THEN 5
         ELSE 99
       END, s.created_at DESC`,
      [userId]
    );

    res.json(rows.map(mapDeliveryOrderRow));
  });

  app.patch('/api/mobile/delivery/orders/:invoiceNumber/delivered', async (req, res) => {
    await ensureMobileTables(query);
    const invoiceNumber = String(req.params.invoiceNumber || '').trim();
    const actor = getMobileActor(req);
    if (!actor.userId) {
      return res.status(400).json({ error: 'El usuario delivery es requerido.' });
    }

    const result = await query(
      `UPDATE sales
       SET kitchen_status = 'entregada'
       WHERE invoice_number = ?
         AND order_type = 'delivery'
         AND delivery_user_id = ?
         AND COALESCE(fiscal_status, 'emitida') <> 'cancelada'`,
      [invoiceNumber, actor.userId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Pedido delivery no encontrado o no asignado.' });
    }

    await writeAuditLog({
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      moduleName: 'Delivery',
      actionName: 'Pedido entregado desde móvil',
      detail: invoiceNumber
    });

    const rows = await query(
      `SELECT
        s.*,
        COALESCE(c.nombre, s.client_name_snapshot, 'Consumidor Final') AS client_name,
        COALESCE(c.telefono, '') AS client_phone,
        COUNT(si.id) AS items_count
       FROM sales s
       LEFT JOIN clients c ON c.id = s.client_id
       LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE s.invoice_number = ?
       GROUP BY s.id
       LIMIT 1`,
      [invoiceNumber]
    );

    const updatedOrder = mapDeliveryOrderRow(rows[0]);
    firebaseSync.syncDeliveryOrder({ ...rows[0], kitchen_status: 'entregada' }).catch(() => {});
    res.json(updatedOrder);
  });

  app.post('/api/mobile/products', async (req, res) => {
    await ensureMobileTables(query);
    await query(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre VARCHAR(80) NOT NULL UNIQUE,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const actor = getMobileActor(req);
    if (!['Administrador', 'Supervisor'].includes(actor.userRole)) {
      return res.status(403).json({ error: 'Solo Administrador o Supervisor pueden crear productos desde el móvil.' });
    }
    const data = req.body || {};
    const codigo = String(data.codigo || '').trim();
    const nombre = String(data.nombre || '').trim();
    const categoria = String(data.categoria || 'General').trim() || 'General';
    const marca = String(data.marca || '').trim();
    const unidad = String(data.unidad || 'Unidad').trim() || 'Unidad';
    const precioCompra = Number(data.precioCompra || 0);
    const precioVenta = Number(data.precioVenta || 0);
    const stock = Number(data.stock || 0);
    const stockMin = Number(data.stockMin || 0);

    if (!codigo || !nombre) {
      return res.status(400).json({ error: 'Código y nombre son obligatorios.' });
    }

    const duplicateRows = await query('SELECT id FROM products WHERE LOWER(codigo) = LOWER(?) LIMIT 1', [codigo]);
    if (duplicateRows.length) {
      return res.status(409).json({ error: 'Ya existe un producto con ese código.' });
    }
    const duplicateNameRows = await query('SELECT id FROM products WHERE LOWER(nombre) = LOWER(?) LIMIT 1', [nombre]);
    if (duplicateNameRows.length) {
      return res.status(409).json({ error: 'Ya existe un producto con ese nombre.' });
    }

    await query('INSERT OR IGNORE INTO categories (nombre) VALUES (?)', [categoria]);
    const result = await query(
      `INSERT INTO products
        (codigo, nombre, categoria, marca, unidad, precio_compra, precio_venta, stock, stock_min, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, "Activo")`,
      [codigo, nombre, categoria, marca, unidad, precioCompra, precioVenta, stock, stockMin]
    );
    let rows = [];
    if (result.insertId) {
      rows = await query(
        'SELECT id, codigo, nombre, categoria, marca, precio_venta, stock, unidad, estado FROM products WHERE id = ? LIMIT 1',
        [result.insertId]
      );
    }
    if (!rows.length) {
      rows = await query(
        'SELECT id, codigo, nombre, categoria, marca, precio_venta, stock, unidad, estado FROM products WHERE LOWER(codigo) = LOWER(?) LIMIT 1',
        [codigo]
      );
    }

    await writeAuditLog({
      userName: actor.userName,
      userRole: actor.userRole,
      userId: actor.userId,
      moduleName: 'Productos',
      actionName: 'Producto creado desde app móvil',
      detail: `${codigo} · ${nombre}`
    });

    res.status(201).json({
      id: rows[0].id,
      codigo: rows[0].codigo,
      nombre: rows[0].nombre,
      categoria: rows[0].categoria,
      marca: rows[0].marca,
      imagen: rows[0].image_url || '',
      precio: Number(rows[0].precio_venta || 0),
      stock: Number(rows[0].stock || 0),
      unidad: rows[0].unidad,
      estado: rows[0].estado
    });
  });

  app.get('/api/mobile/sessions', async (_req, res) => {
    await ensureMobileTables(query);
    res.json(await listSessions(query));
  });

  app.post('/api/mobile/sessions/register', async (req, res) => {
    await ensureMobileTables(query);
    await ensureDeliveryLocationsTable(query);
    await ensureMobileAccessAllowed(query);
    const actor = getMobileActor(req);
    const deviceId = String(req.body?.deviceId || '').trim() || crypto.randomUUID();
    const deviceName = String(req.body?.deviceName || '').trim() || 'Telefono POS';
    const existingRows = await query('SELECT id FROM mobile_sessions WHERE device_id = ? LIMIT 1', [deviceId]);
    const sessionId = existingRows[0]?.id || crypto.randomUUID();

    if (existingRows.length) {
      await query(
        `UPDATE mobile_sessions
         SET device_name = ?, user_id = ?, user_name = ?, user_role = ?, status = "active",
             updated_at = datetime('now'), last_seen_at = datetime('now')
         WHERE id = ?`,
        [deviceName, actor.userId, actor.userName, actor.userRole, sessionId]
      );
    } else {
      await query(
        `INSERT INTO mobile_sessions
          (id, device_id, device_name, user_id, user_name, user_role, status, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, "active", datetime('now'), datetime('now'))`,
        [sessionId, deviceId, deviceName, actor.userId, actor.userName, actor.userRole]
      );
    }

    const detail = await getSessionDetail(query, sessionId);
    await writeAuditLog({
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      moduleName: 'POS Movil',
      actionName: 'Sesion móvil iniciada',
      detail: `${deviceName} · ${sessionId}`
    });
    io.emit('mobile:sessions-updated', await listSessions(query));
    res.status(201).json(detail);
  });

  app.get('/api/mobile/sessions/:id', async (req, res) => {
    await ensureMobileTables(query);
    const detail = await getSessionDetail(query, req.params.id);
    if (!detail) return res.status(404).json({ error: 'Sesion movil no encontrada.' });
    await query(
      `UPDATE mobile_sessions
       SET last_seen_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
      [req.params.id]
    );
    res.json(detail);
  });

  app.post('/api/mobile/sessions/:id/location', async (req, res) => {
    await ensureMobileTables(query);
    await ensureDeliveryLocationsTable(query);
    const sessionId = req.params.id;
    await ensureMobileAccessAllowed(query, sessionId);
    const actor = getMobileActor(req);
    const latitude = Number(req.body?.latitud);
    const longitude = Number(req.body?.longitud);
    const accuracy = req.body?.precisionMetros === undefined ? null : Number(req.body?.precisionMetros);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ error: 'Latitud y longitud son requeridas.' });
    }

    await query(
      `UPDATE mobile_sessions
       SET current_latitude = ?, current_longitude = ?, location_accuracy_meters = ?,
           last_location_at = datetime('now'), updated_at = datetime('now'), last_seen_at = datetime('now')
       WHERE id = ?`,
      [latitude, longitude, Number.isFinite(accuracy) ? accuracy : null, sessionId]
    );
    await query(
      `INSERT INTO delivery_locations
        (session_id, user_id, user_name, latitude, longitude, accuracy_meters, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, "mobile", datetime('now'))`,
      [sessionId, actor.userId || null, actor.userName || 'Delivery', latitude, longitude, Number.isFinite(accuracy) ? accuracy : null]
    );
    await broadcastSession(io, query, sessionId);
    io.emit('mobile:delivery-location-updated', {
      sessionId,
      userId: actor.userId || null,
      userName: actor.userName || 'Delivery',
      latitud: latitude,
      longitud: longitude,
      precisionMetros: Number.isFinite(accuracy) ? accuracy : null,
      actualizadaEn: new Date().toISOString()
    });
    res.json(await getSessionDetail(query, sessionId));
  });

  app.post('/api/mobile/sessions/:id/block', async (req, res) => {
    await ensureMobileTables(query);
    const sessionId = req.params.id;
    const nextStatus = String(req.body?.blocked).toLowerCase() === 'false' ? 'active' : 'blocked';
    const result = await query(
      `UPDATE mobile_sessions
       SET status = ?, updated_at = datetime('now'), last_seen_at = datetime('now')
       WHERE id = ?`,
      [nextStatus, sessionId]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Sesion movil no encontrada.' });
    }
    await writeAuditLog({
      userName: req.body?.actorUserName || 'Sistema',
      userRole: req.body?.actorUserRole || 'Sistema',
      userId: req.body?.actorUserId || null,
      moduleName: 'POS Movil',
      actionName: nextStatus === 'blocked' ? 'Sesion móvil bloqueada' : 'Sesion móvil reactivada',
      detail: sessionId
    });
    await broadcastSession(io, query, sessionId);
    res.json(await getSessionDetail(query, sessionId));
  });

  app.delete('/api/mobile/sessions/:id', async (req, res) => {
    await ensureMobileTables(query);
    const sessionId = req.params.id;
    const detail = await getSessionDetail(query, sessionId);
    if (!detail) return res.status(404).json({ error: 'Sesion movil no encontrada.' });
    await query('DELETE FROM mobile_sessions WHERE id = ?', [sessionId]);
    await writeAuditLog({
      userName: req.body?.actorUserName || 'Sistema',
      userRole: req.body?.actorUserRole || 'Sistema',
      userId: req.body?.actorUserId || null,
      moduleName: 'POS Movil',
      actionName: 'Sesion móvil eliminada',
      detail: `${detail.deviceName} · ${sessionId}`
    });
    io.emit('mobile:sessions-updated', await listSessions(query));
    res.status(204).end();
  });

  app.post('/api/mobile/sessions/:id/items', async (req, res) => {
    await ensureMobileTables(query);
    const sessionId = req.params.id;
    await ensureMobileAccessAllowed(query, sessionId);
    const actor = getMobileActor(req);
    const productId = Number(req.body?.productId || 0);
    const qty = Math.max(1, Number(req.body?.qty || 1));
    const productRows = await query('SELECT * FROM products WHERE id = ? LIMIT 1', [productId]);
    if (!productRows.length) return res.status(404).json({ error: 'Producto no encontrado.' });
    const product = productRows[0];

    await withTransaction(async (conn) => {
      const existingRows = await conn.query(
        'SELECT * FROM mobile_session_items WHERE session_id = ? AND product_id = ? LIMIT 1',
        [sessionId, productId]
      );
      const nextQty = Number(existingRows[0]?.qty || 0) + qty;
      const lineTotal = nextQty * Number(product.precio_venta || 0);
      if (existingRows.length) {
        await conn.query(
          `UPDATE mobile_session_items
           SET qty = ?, line_total = ?, updated_at = datetime('now')
           WHERE session_id = ? AND product_id = ?`,
          [nextQty, lineTotal, sessionId, productId]
        );
      } else {
        await conn.query(
          `INSERT INTO mobile_session_items
            (session_id, product_id, qty, line_total, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))`,
          [sessionId, productId, qty, qty * Number(product.precio_venta || 0)]
        );
      }
      await conn.query(
        `UPDATE mobile_sessions
         SET updated_at = datetime('now'), last_seen_at = datetime('now')
         WHERE id = ?`,
        [sessionId]
      );
    });

    await broadcastSession(io, query, sessionId);
    await writeAuditLog({
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      moduleName: 'POS Movil',
      actionName: 'Producto agregado al carrito móvil',
      detail: `${product.codigo} · ${product.nombre} · sesión ${sessionId}`
    });
    res.status(201).json(await getSessionDetail(query, sessionId));
  });

  app.patch('/api/mobile/sessions/:id/items/:productId', async (req, res) => {
    await ensureMobileTables(query);
    const sessionId = req.params.id;
    await ensureMobileAccessAllowed(query, sessionId);
    const actor = getMobileActor(req);
    const productId = Number(req.params.productId);
    const qty = Number(req.body?.qty || 0);

    if (qty <= 0) {
      await query('DELETE FROM mobile_session_items WHERE session_id = ? AND product_id = ?', [sessionId, productId]);
    } else {
      const productRows = await query('SELECT precio_venta FROM products WHERE id = ? LIMIT 1', [productId]);
      if (!productRows.length) return res.status(404).json({ error: 'Producto no encontrado.' });
      await query(
        `UPDATE mobile_session_items
         SET qty = ?, line_total = ?, updated_at = datetime('now')
         WHERE session_id = ? AND product_id = ?`,
        [qty, qty * Number(productRows[0].precio_venta || 0), sessionId, productId]
      );
    }

    await query(
      `UPDATE mobile_sessions
       SET updated_at = datetime('now'), last_seen_at = datetime('now')
       WHERE id = ?`,
      [sessionId]
    );
    await broadcastSession(io, query, sessionId);
    await writeAuditLog({
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      moduleName: 'POS Movil',
      actionName: 'Carrito móvil actualizado',
      detail: `Producto ${productId} · cantidad ${qty} · sesión ${sessionId}`
    });
    res.json(await getSessionDetail(query, sessionId));
  });

  app.delete('/api/mobile/sessions/:id/items/:productId', async (req, res) => {
    await ensureMobileTables(query);
    const sessionId = req.params.id;
    await ensureMobileAccessAllowed(query, sessionId);
    await query('DELETE FROM mobile_session_items WHERE session_id = ? AND product_id = ?', [sessionId, req.params.productId]);
    await query(
      `UPDATE mobile_sessions
       SET updated_at = datetime('now'), last_seen_at = datetime('now')
       WHERE id = ?`,
      [sessionId]
    );
    await broadcastSession(io, query, sessionId);
    res.status(204).end();
  });

  app.post('/api/mobile/sessions/:id/clear', async (req, res) => {
    await ensureMobileTables(query);
    const sessionId = req.params.id;
    await ensureMobileAccessAllowed(query, sessionId);
    const actor = getMobileActor(req);
    await query('DELETE FROM mobile_session_items WHERE session_id = ?', [sessionId]);
    await query(
      `UPDATE mobile_sessions
       SET updated_at = datetime('now'), last_seen_at = datetime('now')
       WHERE id = ?`,
      [sessionId]
    );
    await broadcastSession(io, query, sessionId);
    await writeAuditLog({
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      moduleName: 'POS Movil',
      actionName: 'Carrito móvil vaciado',
      detail: `Sesión ${sessionId}`
    });
    res.json(await getSessionDetail(query, sessionId));
  });

  app.post('/api/mobile/sessions/:id/close', async (req, res) => {
    await ensureMobileTables(query);
    const sessionId = req.params.id;
    await query(
      `UPDATE mobile_sessions
       SET status = "closed", updated_at = datetime('now'), last_seen_at = datetime('now')
       WHERE id = ?`,
      [sessionId]
    );
    await writeAuditLog({
      userName: req.body?.actorUserName || 'Sistema',
      userRole: req.body?.actorUserRole || 'Sistema',
      userId: req.body?.actorUserId || null,
      moduleName: 'POS Movil',
      actionName: 'Sesion movil cerrada',
      detail: sessionId
    });
    await broadcastSession(io, query, sessionId);
    res.json({ ok: true });
  });

  io.on('connection', (socket) => {
    socket.on('mobile:join-session', async (sessionId) => {
      if (!sessionId) return;
      await ensureMobileTables(query);
      socket.join(`mobile-session:${sessionId}`);
      const detail = await getSessionDetail(query, sessionId);
      socket.emit('mobile:session-updated', detail);
    });

    socket.on('mobile:heartbeat', async ({ sessionId }) => {
      if (!sessionId) return;
      await query(
        `UPDATE mobile_sessions
         SET last_seen_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
        [sessionId]
      );
      io.emit('mobile:sessions-updated', await listSessions(query));
    });

    socket.on('mobile:location', async ({ sessionId, latitud, longitud, precisionMetros, userId, userName }) => {
      if (!sessionId || !Number.isFinite(Number(latitud)) || !Number.isFinite(Number(longitud))) return;
      await ensureDeliveryLocationsTable(query);
      await query(
        `UPDATE mobile_sessions
         SET current_latitude = ?, current_longitude = ?, location_accuracy_meters = ?,
             last_location_at = datetime('now'), updated_at = datetime('now'), last_seen_at = datetime('now')
         WHERE id = ?`,
        [Number(latitud), Number(longitud), Number.isFinite(Number(precisionMetros)) ? Number(precisionMetros) : null, sessionId]
      );
      await query(
        `INSERT INTO delivery_locations
          (session_id, user_id, user_name, latitude, longitude, accuracy_meters, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, "socket", datetime('now'))`,
        [sessionId, userId || null, userName || 'Delivery', Number(latitud), Number(longitud), Number.isFinite(Number(precisionMetros)) ? Number(precisionMetros) : null]
      );
      io.emit('mobile:delivery-location-updated', {
        sessionId,
        userId: userId || null,
        userName: userName || 'Delivery',
        latitud: Number(latitud),
        longitud: Number(longitud),
        precisionMetros: Number.isFinite(Number(precisionMetros)) ? Number(precisionMetros) : null,
        actualizadaEn: new Date().toISOString()
      });
      io.emit('mobile:sessions-updated', await listSessions(query));
    });
  });
}

module.exports = {
  registerMobilePos,
  ensureMobileTables,
  getLocalIPv4,
  listSessions,
  getSessionDetail
};

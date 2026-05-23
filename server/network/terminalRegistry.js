// ══════════════════════════════════════════════════════════════════════════════
//  terminalRegistry.js  —  Tecno Caja
//  Registro central de terminales (cajas) en la BD compartida.
//  Compatible SQLite (dev) y MySQL/MariaDB (producción).
//  Cada terminal se auto-registra al arrancar via Socket.IO.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

function _isMySQL() {
  return String(process.env.DB_CLIENT || 'sqlite').trim().toLowerCase() === 'mysql';
}
function _pk()   { return _isMySQL() ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'; }
function _upd()  { return _isMySQL()
    ? 'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
    : 'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'; }

// ── Crear tabla si no existe ──────────────────────────────────────────────────
async function ensureNetworkExtensions(queryFn) {
  await queryFn(`
    CREATE TABLE IF NOT EXISTS terminal_registrations (
      id                ${_pk()},
      terminal_id       VARCHAR(32)  NOT NULL,
      terminal_name     VARCHAR(120) DEFAULT NULL,
      branch_id         INT          DEFAULT NULL,
      cash_register_id  INT          DEFAULT NULL,
      business_id       INT          DEFAULT NULL,
      ip_address        VARCHAR(45)  DEFAULT NULL,
      connection_type   VARCHAR(20)  NOT NULL DEFAULT 'lan',
      is_main           TINYINT(1)   NOT NULL DEFAULT 0,
      status            VARCHAR(20)  NOT NULL DEFAULT 'offline',
      socket_id         VARCHAR(60)  DEFAULT NULL,
      last_seen_at      DATETIME     DEFAULT NULL,
      registered_by     VARCHAR(80)  DEFAULT NULL,
      registered_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ${_upd()},
      UNIQUE (terminal_id)
    )
  `);
  // Para tablas existentes sin UNIQUE
  await queryFn(
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_terminal_id ON terminal_registrations (terminal_id)'
  ).catch(() => {});
}

// ── Registrar / actualizar terminal ──────────────────────────────────────────
async function registerTerminal(queryFn, {
  terminalId, terminalName, branchId, cashRegisterId, businessId,
  ipAddress, connectionType, isMain, registeredBy, socketId
}) {
  const existing = await queryFn(
    'SELECT id FROM terminal_registrations WHERE terminal_id = ? LIMIT 1',
    [terminalId]
  );

  const now = new Date();
  if (existing[0]) {
    await queryFn(`
      UPDATE terminal_registrations SET
        terminal_name    = COALESCE(?, terminal_name),
        branch_id        = ?,
        cash_register_id = ?,
        business_id      = COALESCE(?, business_id),
        ip_address       = COALESCE(?, ip_address),
        connection_type  = COALESCE(?, connection_type),
        is_main          = ?,
        status           = 'online',
        socket_id        = ?,
        last_seen_at     = ?,
        updated_at       = ?
      WHERE terminal_id = ?
    `, [
      terminalName || null,
      branchId     || null,
      cashRegisterId || null,
      businessId   || null,
      ipAddress    || null,
      connectionType || null,
      isMain ? 1 : 0,
      socketId     || null,
      now, now,
      terminalId
    ]);
  } else {
    await queryFn(`
      INSERT INTO terminal_registrations
        (terminal_id, terminal_name, branch_id, cash_register_id, business_id,
         ip_address, connection_type, is_main, status, socket_id, last_seen_at,
         registered_by, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?, ?)
    `, [
      terminalId,
      terminalName   || null,
      branchId       || null,
      cashRegisterId || null,
      businessId     || null,
      ipAddress      || null,
      connectionType || 'lan',
      isMain ? 1 : 0,
      socketId       || null,
      now,
      registeredBy   || null,
      now
    ]);
  }
}

// ── Marcar online / offline ───────────────────────────────────────────────────
async function markOnline(queryFn, terminalId, { socketId, ipAddress } = {}) {
  await queryFn(`
    UPDATE terminal_registrations SET
      status       = 'online',
      last_seen_at = ?,
      updated_at   = ?,
      socket_id    = COALESCE(?, socket_id),
      ip_address   = COALESCE(?, ip_address)
    WHERE terminal_id = ?
  `, [new Date(), new Date(), socketId || null, ipAddress || null, terminalId]).catch(() => {});
}

async function markOffline(queryFn, terminalId) {
  await queryFn(`
    UPDATE terminal_registrations SET
      status     = 'offline',
      socket_id  = NULL,
      updated_at = ?
    WHERE terminal_id = ?
  `, [new Date(), terminalId]).catch(() => {});
}

// También soporta buscar por socket_id (para el evento disconnect)
async function markOfflineBySocket(queryFn, socketId) {
  await queryFn(`
    UPDATE terminal_registrations SET
      status     = 'offline',
      socket_id  = NULL,
      updated_at = ?
    WHERE socket_id = ?
  `, [new Date(), socketId]).catch(() => {});
}

// ── Listar terminales ─────────────────────────────────────────────────────────
async function listTerminals(queryFn, businessId) {
  const rows = await queryFn(`
    SELECT tr.*,
           b.nombre   AS branch_name,
           b.codigo   AS branch_code,
           cr.nombre  AS cash_register_name,
           cr.codigo  AS cash_register_code
    FROM terminal_registrations tr
    LEFT JOIN branches       b  ON b.id  = tr.branch_id
    LEFT JOIN cash_registers cr ON cr.id = tr.cash_register_id
    WHERE tr.business_id = ? OR tr.business_id IS NULL
    ORDER BY tr.is_main DESC, tr.status DESC, tr.terminal_name ASC
  `, [businessId]);

  return rows.map(r => ({
    id:               r.id,
    terminalId:       r.terminal_id,
    terminalName:     r.terminal_name || r.terminal_id,
    branchId:         r.branch_id,
    branchName:       r.branch_name || '—',
    cashRegisterId:   r.cash_register_id,
    cashRegisterName: r.cash_register_name || '—',
    ipAddress:        r.ip_address,
    connectionType:   r.connection_type || 'lan',
    isMain:           !!r.is_main,
    status:           r.status || 'offline',
    lastSeenAt:       r.last_seen_at,
    registeredAt:     r.registered_at
  }));
}

// ── Reasignar terminal a otra sucursal/caja ───────────────────────────────────
async function assignBranch(queryFn, terminalId, { branchId, cashRegisterId }) {
  const rows = await queryFn(
    'SELECT id FROM terminal_registrations WHERE terminal_id = ? LIMIT 1',
    [terminalId]
  );
  if (!rows[0]) throw Object.assign(new Error('Terminal no encontrado.'), { statusCode: 404 });

  await queryFn(`
    UPDATE terminal_registrations SET
      branch_id        = ?,
      cash_register_id = ?,
      updated_at       = ?
    WHERE terminal_id = ?
  `, [branchId || null, cashRegisterId || null, new Date(), terminalId]);
}

// ── Eliminar terminal ─────────────────────────────────────────────────────────
async function removeTerminal(queryFn, terminalId) {
  await queryFn(
    'DELETE FROM terminal_registrations WHERE terminal_id = ?',
    [terminalId]
  );
}

// ── Obtener IPs locales disponibles ──────────────────────────────────────────
function getLocalIPs() {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(ifaces)) {
    for (const iface of list) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(iface.address)) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

module.exports = {
  ensureNetworkExtensions,
  registerTerminal,
  markOnline,
  markOffline,
  markOfflineBySocket,
  listTerminals,
  assignBranch,
  removeTerminal,
  getLocalIPs
};

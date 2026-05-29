'use strict';

/**
 * respaldos.routes.js — Sistema de respaldo local y nube para Tecno Caja POS
 * Factory pattern con inyección de dependencias.
 *
 * Rutas:
 *  GET  /api/respaldos/estado          — Estado y lista de respaldos
 *  POST /api/respaldos/crear-local      — Crear archivo .tcbak local
 *  POST /api/respaldos/subir-nube       — Subir .tcbak a Firebase Storage
 *  POST /api/respaldos/restaurar-local  — Restaurar desde archivo .tcbak
 *  POST /api/respaldos/restaurar-nube   — Restaurar desde Firebase Storage
 *  GET  /api/respaldos/lista-nube       — Historial de respaldos en la nube
 *  PUT  /api/respaldos/config           — Guardar configuración auto-respaldo
 *  POST /api/respaldos/subir-pendientes — Subir respaldos locales pendientes
 *  POST /api/respaldos/subir-archivo   — Subir .tcbak en base64 a R2 (import externo)
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const crypto = require('crypto');
const zlib   = require('zlib');
const { promisify } = require('util');

// Acceso directo a withTransaction y getDbClient para garantizar misma conexión
// durante la restauración (SET FOREIGN_KEY_CHECKS = 0 debe estar en la misma
// conexión que los INSERTs; con pool.query() cada llamada puede usar conexión distinta).
const { withTransaction: _withDbTransaction, getDbClient } = require('../../db');

const gzip   = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// ─── Constantes ─────────────────────────────────────────────────────────────
const BACKUP_MAGIC          = 'TECNOCAJA_BACKUP_V1';
const BACKUP_FORMAT_VERSION = '2';
const DEFAULT_BACKUP_RETENTION = 5; // cuántos .tcbak conservar automáticamente

// ─── Helper de dirs ──────────────────────────────────────────────────────────
function getDefaultBackupDir() {
  return path.join(os.homedir(), 'Documents', 'TecnoCaja', 'Backups');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Nombre de archivo .tcbak ────────────────────────────────────────────────
function generateFilename(businessName, version) {
  const tz  = 'America/Santo_Domingo';
  const now = new Date();
  const fecha = now.toLocaleDateString('es-DO', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz })
                   .replace(/\//g, '-');
  const hora  = now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
                   .replace(':', 'h');
  const safe  = (businessName || 'TecnoCaja')
                  .normalize('NFD').replace(/[̀-ͯ]/g, '') // quitar acentos
                  .replace(/[^a-zA-Z0-9\-_]/g, '_')
                  .replace(/_+/g, '_')
                  .slice(0, 30);
  const ver   = String(version || '1.0.0').replace(/[^0-9.]/g, '');
  return `TecnoCaja_Backup_${safe}_${fecha}_${hora}_v${ver}.tcbak`;
}

// ─── Construir payload completo ──────────────────────────────────────────────
async function buildFullPayload(query) {
  const safeQuery = async (sql, params = []) => {
    try { return await query(sql, params); }
    catch (_) { return []; }
  };

  const [
    config, users, categories, products, clients,
    suppliers, supplierInvoices,
    cashSessions, cashMovements,
    sales, saleItems,
    auditLogs, suspendedSales, quotations,
    ncfSequences, pendingSales,
    tables, paymentMethods, branches, cashRegisters,
    inventoryByBranch, inventoryMovements, branchTransfers, branchTransferItems,
  ] = await Promise.all([
    safeQuery('SELECT * FROM config'),
    safeQuery('SELECT * FROM users'),
    safeQuery('SELECT * FROM categories'),
    safeQuery('SELECT * FROM products'),
    safeQuery('SELECT * FROM clients'),
    safeQuery('SELECT * FROM suppliers LIMIT 5000'),
    safeQuery('SELECT * FROM supplier_invoices LIMIT 10000'),
    safeQuery('SELECT * FROM cash_sessions LIMIT 3000'),
    safeQuery('SELECT * FROM cash_movements LIMIT 50000'),
    safeQuery('SELECT * FROM sales LIMIT 200000'),
    safeQuery('SELECT * FROM sale_items LIMIT 500000'),
    safeQuery('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 5000'),
    safeQuery('SELECT * FROM suspended_sales LIMIT 1000'),
    safeQuery('SELECT * FROM quotations LIMIT 3000'),
    safeQuery('SELECT * FROM ncf_sequences LIMIT 1000'),
    safeQuery('SELECT * FROM pending_sales LIMIT 2000'),
    safeQuery('SELECT * FROM dining_tables LIMIT 500'),
    safeQuery('SELECT * FROM payment_methods'),
    safeQuery('SELECT * FROM branches'),
    safeQuery('SELECT * FROM cash_registers'),
    safeQuery('SELECT * FROM inventory_by_branch LIMIT 200000'),
    safeQuery('SELECT * FROM inventory_movements LIMIT 500000'),
    safeQuery('SELECT * FROM branch_transfers LIMIT 50000'),
    safeQuery('SELECT * FROM branch_transfer_items LIMIT 200000'),
  ]);

  // Config como mapa para metadatos
  const cfgMap = {};
  (config || []).forEach(r => {
    const k = r.clave || r.config_key || '';
    const v = r.valor || r.config_value || r.value || '';
    if (k) cfgMap[k] = v;
    // columnas directas del row (tabla config tiene columnas planas)
    Object.keys(r).forEach(col => { if (!cfgMap[col]) cfgMap[col] = r[col]; });
  });

  const businessName = cfgMap.business_name || cfgMap.nombre_negocio || cfgMap.businessName || 'TecnoCaja';
  const businessId   = cfgMap.business_id   || cfgMap.businessId    || '';
  const rnc          = cfgMap.rnc            || '';
  const sysVersion   = process.env.npm_package_version || '1.0.0';

  return {
    magic:          BACKUP_MAGIC,
    formatVersion:  BACKUP_FORMAT_VERSION,
    exportedAt:     new Date().toISOString(),
    timezone:       'America/Santo_Domingo',
    businessName,
    businessId,
    rnc,
    systemVersion:  sysVersion,
    stats: {
      productos:   (products    || []).length,
      clientes:    (clients     || []).length,
      ventas:      (sales       || []).length,
      usuarios:    (users       || []).length,
      categorias:  (categories  || []).length,
      facturas:    (saleItems   || []).length,
      proveedores: (suppliers   || []).length,
      inventario:  (inventoryByBranch || []).length,
      movimientosInventario: (inventoryMovements || []).length,
    },
    data: {
      config, users, categories, products, clients,
      suppliers, supplierInvoices,
      cashSessions, cashMovements,
      sales, saleItems,
      auditLogs, suspendedSales, quotations,
      ncfSequences, pendingSales,
      tables, paymentMethods, branches, cashRegisters,
      inventoryByBranch, inventoryMovements, branchTransfers, branchTransferItems,
    },
  };
}

// ─── Crear buffer .tcbak cifrado + comprimido ────────────────────────────────
async function createTcbakBuffer(payload, password) {
  const payloadJson = JSON.stringify(payload);
  const sha256      = crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');

  // 1. Comprimir
  const compressed  = await gzip(Buffer.from(payloadJson, 'utf8'));
  // 2. Cifrar (AES-256-GCM vía backup-crypto.js)
  const { encryptBackupPayload } = require('../security/backup-crypto');
  const encContent  = encryptBackupPayload(compressed.toString('base64'), password);

  const tcbak = {
    magic:         BACKUP_MAGIC,
    formatVersion: BACKUP_FORMAT_VERSION,
    sha256,
    createdAt:     payload.exportedAt,
    metadata: {
      businessName:  payload.businessName,
      businessId:    payload.businessId,
      rnc:           payload.rnc,
      systemVersion: payload.systemVersion,
      stats:         payload.stats,
    },
    encrypted: encContent,
  };

  return Buffer.from(JSON.stringify(tcbak), 'utf8');
}

// ─── Parsear y descifrar .tcbak ──────────────────────────────────────────────
async function parseTcbakBuffer(fileBuffer, password) {
  let tcbak;
  try {
    tcbak = JSON.parse(fileBuffer.toString('utf8'));
  } catch (_) {
    throw new Error('El archivo no es un respaldo válido de Tecno Caja (formato inválido).');
  }

  if (tcbak.magic !== BACKUP_MAGIC) {
    throw new Error('Este archivo no es un respaldo de Tecno Caja.');
  }

  // Descifrar
  const { decryptBackupPayload } = require('../security/backup-crypto');
  let decryptedBase64;
  try {
    decryptedBase64 = decryptBackupPayload(tcbak.encrypted, password);
  } catch (_) {
    throw new Error('Contraseña incorrecta o archivo corrupto. No se pudo descifrar el respaldo.');
  }

  // Descomprimir
  let payloadJson;
  try {
    const compressed = Buffer.from(decryptedBase64, 'base64');
    const decompressed = await gunzip(compressed);
    payloadJson = decompressed.toString('utf8');
  } catch (_) {
    throw new Error('Error al descomprimir el respaldo. El archivo puede estar dañado.');
  }

  // Verificar SHA-256
  const sha256Actual = crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');
  if (sha256Actual !== tcbak.sha256) {
    throw new Error('El respaldo está corrupto o fue modificado (SHA-256 no coincide). Restauración cancelada.');
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (_) {
    throw new Error('Error al procesar el contenido del respaldo.');
  }

  return { payload, metadata: tcbak.metadata, sha256: tcbak.sha256 };
}

// ─── R2 Storage helpers ───────────────────────────────────────────────────────
const r2 = require('../services/r2-storage');

/**
 * Devuelve el businessId canónico para paths en R2.
 * Prioridad: TECNO_CAJA_LICENSE_UID > config.business_id > 'default'
 * Siempre devuelve un string no vacío y limpio.
 */
async function resolveBusinessId(queryFn) {
  const envUid = (process.env.TECNO_CAJA_LICENSE_UID || '').trim();
  if (envUid) return envUid;

  try {
    const rows = await queryFn('SELECT business_id FROM config LIMIT 1');
    const raw  = rows[0]?.business_id;
    const str  = String(raw || '').trim();
    if (str && str !== '0') return str;
  } catch (_) {}

  return 'default';
}

/**
 * Token de sesión temporal para operaciones de nube (30 min).
 * No reemplaza el JWT de sesión — es solo para el flujo de respaldo/restaurar.
 */
const jwt = require('jsonwebtoken');
const CLOUD_TOKEN_SECRET = process.env.TECNO_CAJA_SECURITY_PASSWORD || 'TecnoCaja-cloud-backup-2026';

function signCloudToken(payload) {
  return jwt.sign(payload, CLOUD_TOKEN_SECRET, { expiresIn: '30m' });
}
function verifyCloudToken(token) {
  return jwt.verify(token, CLOUD_TOKEN_SECRET);
}

// ─── Listar archivos .tcbak en carpeta local ─────────────────────────────────
function listLocalBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.tcbak') || f.endsWith('.novaseguro'))
    .map(f => {
      const fp    = path.join(dir, f);
      const stats = fs.statSync(fp);
      return { name: f, path: fp, size: stats.size, mtime: stats.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// ─── Registrar en backup_history ─────────────────────────────────────────────
async function recordHistory(query, row) {
  try {
    await query(
      `INSERT INTO backup_history
       (file_name, file_path, storage_path, file_size, sha256, tipo, estado,
        business_name, business_id, system_version,
        productos_count, clientes_count, ventas_count,
        created_by, device_name, firestore_id, error_message, observacion, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        row.fileName     || '',
        row.filePath     || null,
        row.storagePath  || null,
        row.fileSize     || 0,
        row.sha256       || null,
        row.tipo         || 'local',
        row.estado       || 'completado',
        row.businessName || '',
        row.businessId   || '',
        row.version      || '',
        row.productos    || 0,
        row.clientes     || 0,
        row.ventas       || 0,
        row.createdBy    || 'sistema',
        row.device       || os.hostname(),
        row.firestoreId  || null,
        row.errorMsg     || null,
        row.observacion  || null,
      ]
    );
  } catch (_) { /* non-fatal */ }
}

function normalizeRetentionCount(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_BACKUP_RETENTION;
  return Math.min(50, Math.max(3, parsed));
}

async function getBackupRetentionCount(query) {
  const rows = await query(
    'SELECT config_value FROM installation_config WHERE config_key = ? LIMIT 1',
    ['backup_retener_cantidad']
  ).catch(() => []);
  return normalizeRetentionCount(rows[0]?.config_value);
}

// ─── Limpiar respaldos locales viejos ────────────────────────────────────────
function pruneLocalBackups(dir, keepCount = DEFAULT_BACKUP_RETENTION) {
  const files = listLocalBackups(dir).filter(f => f.name.endsWith('.tcbak'));
  const keep = normalizeRetentionCount(keepCount);
  if (files.length > keep) {
    files.slice(keep).forEach(f => {
      try { fs.unlinkSync(f.path); } catch (_) {}
    });
  }
}

async function pruneCloudBackups(businessId, keepCount = DEFAULT_BACKUP_RETENTION) {
  const keep = normalizeRetentionCount(keepCount);
  const prefix = r2.backupPrefix(businessId);
  const objects = await r2.listObjects(prefix);
  const backups = objects
    .filter(o => (o.Key || '').endsWith('.tcbak'))
    .sort((a, b) => new Date(b.LastModified || 0) - new Date(a.LastModified || 0));

  for (const old of backups.slice(keep)) {
    try { await r2.remove(old.Key); } catch (_) {}
  }
}

async function createAutomaticBackup({ query, trigger = 'manual', forceCloud = false } = {}) {
  const securityPwd = process.env.TECNO_CAJA_SECURITY_PASSWORD || 'Seguridad2026';

  // Verificar si auto-backup está habilitado. Los triggers críticos pueden
  // forzar respaldo aunque el respaldo diario esté apagado.
  const cfgRows = await query('SELECT config_value FROM installation_config WHERE config_key = ? LIMIT 1', ['backup_auto_diario']).catch(() => []);
  const autoEnabled = (cfgRows[0]?.config_value || '1') !== '0';
  if (!autoEnabled && !forceCloud && trigger === 'cierre_dia') {
    return { ok: true, skipped: true, reason: 'Auto-backup deshabilitado.' };
  }

  const payload    = await buildFullPayload(query);
  const retentionCount = await getBackupRetentionCount(query);
  const fileName   = generateFilename(payload.businessName + '_AUTO', payload.systemVersion);
  const fileBuffer = await createTcbakBuffer(payload, securityPwd);
  const sha256     = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const backupDir  = ensureDir(getDefaultBackupDir());
  const filePath   = path.join(backupDir, fileName);
  fs.writeFileSync(filePath, fileBuffer);
  pruneLocalBackups(backupDir, retentionCount);

  // Verificar si hay nube configurada y auto-subida habilitada.
  const nubeRows = await query('SELECT config_value FROM installation_config WHERE config_key = ? LIMIT 1', ['backup_nube_auto']).catch(() => []);
  const nubeAuto = forceCloud || (nubeRows[0]?.config_value || '0') === '1';

  let estado = 'completado';
  let storagePath = null;
  if (nubeAuto) {
    try {
      const businessId = await resolveBusinessId(query);
      storagePath = r2.backupKey(businessId, fileName);
      await r2.upload(storagePath, fileBuffer, {
        businessId,
        trigger,
        sha256,
        exportedAt: new Date().toISOString(),
      });
      await pruneCloudBackups(businessId, retentionCount);
      estado = 'completado';
    } catch (_) {
      // Sin internet o R2 no configurado: conservar local y marcar pendiente.
      estado = 'pendiente_nube';
      storagePath = null;
    }
  }

  await recordHistory(query, {
    fileName, filePath, storagePath, sha256,
    fileSize: fileBuffer.length,
    tipo: nubeAuto && storagePath ? 'local_cloud' : 'automatico',
    estado,
    businessName: payload.businessName,
    businessId:   payload.businessId,
    version:      payload.systemVersion,
    productos:    payload.stats.productos,
    clientes:     payload.stats.clientes,
    ventas:       payload.stats.ventas,
    createdBy:    'sistema-auto',
    observacion:  `Trigger: ${trigger}`,
  });

  return { ok: true, fileName, filePath, storagePath, sha256, estado, stats: payload.stats };
}

async function uploadPendingCloudBackups(query, limit = 5) {
  const pendientes = await query(
    `SELECT * FROM backup_history WHERE estado = 'pendiente_nube' ORDER BY created_at ASC LIMIT ?`,
    [limit]
  ).catch(() => []);

  const resultados = [];
  for (const row of pendientes) {
    if (!row.file_path || !fs.existsSync(row.file_path)) {
      resultados.push({ fileName: row.file_name, ok: false, error: 'Archivo local no encontrado.' });
      continue;
    }
    try {
      const fileBuffer = fs.readFileSync(row.file_path);
      const businessId = await resolveBusinessId(query);
      const storageKey = r2.backupKey(businessId, row.file_name);
      await r2.upload(storageKey, fileBuffer, { businessId, recoveredFromPending: true });
      await pruneCloudBackups(businessId, await getBackupRetentionCount(query));
      await query('UPDATE backup_history SET estado = ?, tipo = ?, storage_path = ? WHERE id = ?', ['completado', 'local_cloud', storageKey, row.id]);
      resultados.push({ fileName: row.file_name, ok: true, storageKey });
    } catch (uploadErr) {
      resultados.push({ fileName: row.file_name, ok: false, error: uploadErr.message });
    }
  }

  return resultados;
}

// ─── Restaurar payload en la base de datos ───────────────────────────────────
//
// IMPORTANTE: Para MySQL/MariaDB usamos withTransaction (misma conexión dedicada)
// para que SET FOREIGN_KEY_CHECKS = 0 aplique a TODOS los queries del proceso.
// Con pool.query() cada llamada puede obtener una conexión diferente del pool,
// lo que hace que el FK check deshabilita no tenga efecto en los INSERTs siguientes.
//
// Para SQLite (sql.js): insertamos fila a fila porque sql.js NO soporta el
// formato bulk VALUES ? con array 2D que usa mysql2.
/**
 * Normaliza un valor datetime al formato que acepta MariaDB/MySQL: 'YYYY-MM-DD HH:MM:SS'.
 * Los backups almacenan fechas como ISO 8601 ('2026-05-24T21:00:40.000Z') que MariaDB rechaza.
 */
function _normalizeDbDateTime(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  const text = String(value).trim();
  if (!text) return null;
  // Ya en formato SQL correcto
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return text;
  // Solo fecha
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  // ISO con T (con o sin Z / offset)
  if (text.includes('T')) return text.slice(0, 19).replace('T', ' ');
  return text;
}

/**
 * Aplica _normalizeDbDateTime a todos los valores de una fila que parezcan datetimes.
 * Los detectamos por: valor string que contiene 'T' + dígitos, o que coincida con
 * el patrón de fecha ISO, o que sea una instancia de Date.
 */
function _normalizeDateTimesInRow(row) {
  const normalized = {};
  for (const [key, val] of Object.entries(row)) {
    if (val instanceof Date) {
      normalized[key] = _normalizeDbDateTime(val);
    } else if (typeof val === 'string' && val.length >= 10 && (
      /^\d{4}-\d{2}-\d{2}[T ]/.test(val) ||  // ISO fecha-hora
      /^\d{4}-\d{2}-\d{2}$/.test(val)          // Solo fecha
    )) {
      normalized[key] = _normalizeDbDateTime(val);
    } else {
      normalized[key] = val;
    }
  }
  return normalized;
}

async function restorePayloadToDb(payload, query) {
  const { data } = payload;
  if (!data) throw new Error('El respaldo no contiene datos.');

  // Tablas a restaurar en orden (respetar FK)
  const tableOrder = [
    ['config',            data.config           || []],
    ['categories',        data.categories       || []],
    ['users',             data.users            || []],
    ['products',          data.products         || []],
    ['clients',           data.clients          || []],
    ['suppliers',         data.suppliers        || []],
    ['payment_methods',   data.paymentMethods   || []],
    ['branches',          data.branches         || []],
    ['cash_registers',    data.cashRegisters    || []],
    ['inventory_by_branch', data.inventoryByBranch || []],
    ['cash_sessions',     data.cashSessions     || []],
    ['cash_movements',    data.cashMovements    || []],
    ['sales',             data.sales            || []],
    ['sale_items',        data.saleItems        || []],
    ['inventory_movements', data.inventoryMovements || []],
    ['branch_transfers',  data.branchTransfers  || []],
    ['branch_transfer_items', data.branchTransferItems || []],
    ['supplier_invoices', data.supplierInvoices || []],
    ['suspended_sales',   data.suspendedSales   || []],
    ['quotations',        data.quotations       || []],
    ['ncf_sequences',     data.ncfSequences     || []],
    ['pending_sales',     data.pendingSales     || []],
    ['dining_tables',     data.tables           || []],
  ];

  const isMySQL = getDbClient() === 'mysql';

  // Función interna que ejecuta toda la restauración usando la función `q` dada.
  // `q` puede ser la txQuery de withTransaction (MySQL) o query directo (SQLite).
  async function _doRestore(q) {
    const safeQ = async (sql, params) => {
      try {
        return await q(sql, params);
      } catch (e) {
        console.warn(`[respaldos][restore] query omitida: ${String(sql).slice(0, 80)} — ${e.message}`);
      }
    };

    // Deshabilitar verificación de FK en esta conexión
    await safeQ('SET FOREIGN_KEY_CHECKS = 0', []);

    for (const [table, rows] of tableOrder) {
      if (!rows.length) continue;

      // Vaciar tabla
      await safeQ(`DELETE FROM \`${table}\``, []);

      // Normalizar datetimes en todas las filas antes de insertar.
      // MariaDB rechaza el formato ISO 8601 ('2026-05-24T21:00:40.000Z');
      // el formato correcto es 'YYYY-MM-DD HH:MM:SS'.
      const normalizedRows = rows.map(_normalizeDateTimesInRow);
      const cols = Object.keys(normalizedRows[0]);

      if (isMySQL) {
        // mysql2: bulk INSERT con VALUES ? y array 2D (más eficiente)
        const insert = `INSERT INTO \`${table}\` (${cols.map(c => `\`${c}\``).join(',')}) VALUES ?`;
        for (let i = 0; i < normalizedRows.length; i += 200) {
          const chunk = normalizedRows.slice(i, i + 200).map(r => cols.map(c => r[c] !== undefined ? r[c] : null));
          await safeQ(insert, [chunk]);
        }
      } else {
        // SQLite (sql.js): NO soporta VALUES ? con array 2D → fila a fila
        const placeholders = `(${cols.map(() => '?').join(',')})`;
        const insert = `INSERT INTO \`${table}\` (${cols.map(c => `\`${c}\``).join(',')}) VALUES ${placeholders}`;
        for (const row of normalizedRows) {
          const values = cols.map(c => row[c] !== undefined ? row[c] : null);
          await safeQ(insert, values);
        }
      }
    }

    // Re-habilitar FK
    await safeQ('SET FOREIGN_KEY_CHECKS = 1', []);

    // ── Garantizar setup_completed = 1 (SIEMPRE, sin importar el valor en el backup) ──
    // Un sistema restaurado debe arrancar en modo "configurado", no en modo wizard.
    await safeQ('UPDATE `config` SET `setup_completed` = 1 WHERE `id` = 1', []);

    // Fallback: si config quedó vacía (INSERT del backup falló silenciosamente)
    const cfgCheck = await safeQ('SELECT id FROM `config` WHERE id = 1 LIMIT 1');
    if (!cfgCheck || !cfgCheck.length) {
      console.warn('[respaldos][restore] config quedó vacía tras restauración; insertando fila mínima.');
      await safeQ("INSERT IGNORE INTO `config` (id, setup_completed) VALUES (1, 1)", []);
    }

    // Verificar usuarios restaurados
    const userCheck = await safeQ('SELECT COUNT(*) AS total FROM `users`');
    const userCount = Number(userCheck?.[0]?.total || 0);
    if (userCount === 0) {
      console.warn('[respaldos][restore] ¡ADVERTENCIA! La tabla users quedó vacía tras restauración.');
      // Si el backup no tiene usuarios, configurar setup_completed = 0 para que
      // el usuario vea el wizard de primer inicio en lugar del overlay "corrompido".
      // Esto permite hacer una instalación limpia sin quedar atrapado.
      await safeQ('UPDATE `config` SET `setup_completed` = 0 WHERE `id` = 1', []);
      console.warn('[respaldos][restore] setup_completed → 0 para evitar estado "corrompido". El usuario verá el wizard inicial.');
    } else {
      console.log(`[respaldos][restore] ✅ ${userCount} usuario(s) restaurado(s) correctamente.`);
    }
  }

  // Ejecutar restauración
  let restoreResult = { userCount: 0 };
  if (isMySQL) {
    // MySQL: withTransaction garantiza UNA SOLA conexión dedicada para todo el proceso.
    // safeQ captura errores individuales → withTransaction siempre hace COMMIT al final.
    await _withDbTransaction(async ({ query: txQ }) => {
      await _doRestore(txQ);
    });
  } else {
    // SQLite: single-threaded, no hay problema de conexiones distintas
    await _doRestore(query);
  }

  // Verificar el resultado final fuera de la transacción (para MySQL, asegura que el
  // COMMIT se completó correctamente antes de responder al cliente)
  try {
    const finalCheck = await query('SELECT COUNT(*) AS total FROM users');
    restoreResult.userCount = Number(finalCheck?.[0]?.total || 0);
  } catch (_) {}

  return restoreResult;
}

// ════════════════════════════════════════════════════════════════════════════
//  FACTORY PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════
module.exports = function createRespaldosRouter({ app, query, getActor, writeAuditLog, ensureAdministrator, isGlobalAdministratorUser, resolveRequestActorUser }) {
  app.locals.createAutomaticBackup = (options = {}) => createAutomaticBackup({ query, ...options });
  app.locals.uploadPendingCloudBackups = (limit = 5) => uploadPendingCloudBackups(query, limit);
  if (!app.locals.backupPendingUploadTimer) {
    app.locals.backupPendingUploadTimer = setInterval(() => {
      uploadPendingCloudBackups(query, 5).catch(() => {});
    }, 10 * 60 * 1000);
  }

  // ── Middleware de admin ──────────────────────────────────────────────────
  async function adminOnly(req, res, next) {
    try {
      const user = await resolveRequestActorUser(req, { required: true });
      if (!isGlobalAdministratorUser(user)) {
        return res.status(403).json({ ok: false, error: 'Solo el administrador puede realizar esta acción.' });
      }
      req.authUser = user;
      next();
    } catch (e) {
      res.status(401).json({ ok: false, error: e.message });
    }
  }

  async function anyStaff(req, res, next) {
    try {
      const user = await resolveRequestActorUser(req, { required: true });
      req.authUser = user;
      next();
    } catch (e) {
      res.status(401).json({ ok: false, error: e.message });
    }
  }

  // ── Asegurar tabla backup_history ────────────────────────────────────────
  async function ensureBackupHistoryTable() {
    await query(`
      CREATE TABLE IF NOT EXISTS backup_history (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        file_name      VARCHAR(255)  NOT NULL,
        file_path      TEXT          NULL,
        storage_path   TEXT          NULL,
        file_size      BIGINT        DEFAULT 0,
        sha256         VARCHAR(64)   NULL,
        tipo           VARCHAR(30)   DEFAULT 'local',
        estado         VARCHAR(30)   DEFAULT 'completado',
        business_name  VARCHAR(255)  DEFAULT '',
        business_id    VARCHAR(100)  DEFAULT '',
        system_version VARCHAR(20)   DEFAULT '',
        productos_count INT          DEFAULT 0,
        clientes_count  INT          DEFAULT 0,
        ventas_count    INT          DEFAULT 0,
        created_by     VARCHAR(120)  DEFAULT 'sistema',
        device_name    VARCHAR(120)  DEFAULT '',
        firestore_id   VARCHAR(100)  NULL,
        error_message  TEXT          NULL,
        observacion    TEXT          NULL,
        created_at     DATETIME      DEFAULT CURRENT_TIMESTAMP,
        updated_at     DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_bh_created  (created_at),
        INDEX idx_bh_tipo     (tipo),
        INDEX idx_bh_estado   (estado),
        INDEX idx_bh_business (business_id)
      ) DEFAULT CHARSET=utf8mb4
    `).catch(() => {
      // SQLite fallback (sin ON UPDATE, sin CHARSET)
      return query(`
        CREATE TABLE IF NOT EXISTS backup_history (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          file_name      TEXT    NOT NULL,
          file_path      TEXT,
          storage_path   TEXT,
          file_size      INTEGER DEFAULT 0,
          sha256         TEXT,
          tipo           TEXT    DEFAULT 'local',
          estado         TEXT    DEFAULT 'completado',
          business_name  TEXT    DEFAULT '',
          business_id    TEXT    DEFAULT '',
          system_version TEXT    DEFAULT '',
          productos_count INTEGER DEFAULT 0,
          clientes_count  INTEGER DEFAULT 0,
          ventas_count    INTEGER DEFAULT 0,
          created_by     TEXT    DEFAULT 'sistema',
          device_name    TEXT    DEFAULT '',
          firestore_id   TEXT,
          error_message  TEXT,
          observacion    TEXT,
          created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).catch(() => {});
    });
  }

  // Inicializar tabla al arrancar
  ensureBackupHistoryTable();

  // ══════════════════════════════════════════════════════════════════════
  //  GET /api/respaldos/estado
  // ══════════════════════════════════════════════════════════════════════
  app.get('/api/respaldos/estado', anyStaff, async (req, res) => {
    try {
      const customDir  = (await query('SELECT config_value FROM installation_config WHERE config_key = ? LIMIT 1', ['backup_dir_personalizado']).catch(() => []))[0]?.config_value || null;
      const backupDir  = customDir || getDefaultBackupDir();
      pruneLocalBackups(backupDir, await getBackupRetentionCount(query));
      const localFiles = listLocalBackups(backupDir);

      const historyRows = await query(
        'SELECT * FROM backup_history ORDER BY created_at DESC LIMIT 30'
      ).catch(() => []);

      // Config auto-respaldo
      const autoRows = await query(
        `SELECT config_key, config_value FROM installation_config
         WHERE config_key IN (
           'backup_auto_diario','backup_auto_semanal','backup_al_cerrar_caja',
           'backup_nube_auto','backup_antes_actualizar','backup_antes_restaurar',
           'backup_dir_personalizado','backup_retener_cantidad'
         )`
      ).catch(() => []);
      const autoConfig = {};
      autoRows.forEach(r => { autoConfig[r.config_key] = r.config_value; });

      // Info del plan (licencia)
      const licRows = await query('SELECT license_status FROM config LIMIT 1').catch(() => []);
      const plan    = licRows[0]?.license_status || 'trial';

      // Verificar si B2/R2 está disponible
      let nubeDisponible = false;
      let nubeError = null;
      try {
        nubeDisponible = await r2.isR2Available();
      } catch (e) {
        nubeError = e.message;
        console.error('[respaldos] R2/B2 no disponible:', e.message);
        nubeDisponible = false;
      }

      res.json({
        ok: true,
        backupDir,
        planActual: plan,
        nubeDisponible,
        nubeError,
        ultimoLocal: localFiles[0] || null,
        archivosLocales: localFiles.slice(0, 15),
        historial: historyRows,
        autoConfig,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  POST /api/respaldos/crear-local
  // ══════════════════════════════════════════════════════════════════════
  app.post('/api/respaldos/crear-local', adminOnly, async (req, res) => {
    const actor = getActor(req);
    try {
      const { carpetaDestino, password: pwdOverride } = req.body || {};
      const securityPwd = pwdOverride
        || process.env.TECNO_CAJA_SECURITY_PASSWORD
        || 'Seguridad2026';

      // 1. Construir payload
      const payload  = await buildFullPayload(query);
      const fileName = generateFilename(payload.businessName, payload.systemVersion);

      // 2. Crear buffer .tcbak
      const fileBuffer = await createTcbakBuffer(payload, securityPwd);
      const sha256     = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      // 3. Guardar en disco
      const customDir = carpetaDestino
        || (await query('SELECT config_value FROM installation_config WHERE config_key = ? LIMIT 1', ['backup_dir_personalizado']).catch(() => []))[0]?.config_value
        || null;
      const backupDir = ensureDir(customDir || getDefaultBackupDir());
      const filePath  = path.join(backupDir, fileName);
      fs.writeFileSync(filePath, fileBuffer);

      const fileSize = fs.statSync(filePath).size;

      // 4. Limpiar respaldos viejos
      pruneLocalBackups(backupDir, await getBackupRetentionCount(query));

      // 5. Historial
      await recordHistory(query, {
        fileName, filePath, sha256, fileSize,
        tipo: 'local', estado: 'completado',
        businessName: payload.businessName,
        businessId:   payload.businessId,
        version:      payload.systemVersion,
        productos:    payload.stats.productos,
        clientes:     payload.stats.clientes,
        ventas:       payload.stats.ventas,
        createdBy:    actor.userName || 'sistema',
      });

      // 6. Auditoría
      await writeAuditLog({
        userId: actor.userId, userName: actor.userName, userRole: actor.userRole,
        moduleName: 'respaldos', actionName: 'crear_local',
        detail: `Respaldo local creado: ${fileName} (${Math.round(fileSize / 1024)} KB)`,
      });

      res.json({ ok: true, fileName, filePath, fileSize, sha256, stats: payload.stats });
    } catch (e) {
      await recordHistory(query, {
        fileName: 'error', tipo: 'local', estado: 'fallido',
        errorMsg: e.message, createdBy: actor.userName || 'sistema',
      });
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  POST /api/respaldos/cloud/auth
  //  Autenticación con email+contraseña para operaciones en la nube.
  //  Body: { email, password }
  //  Retorna: { cloudToken, businessId, email, nubeDisponible }
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Verifica la contraseña contra el hash almacenado por server.js
   * (formato: "scrypt:<salt-hex>:<derived-hex>")
   */
  function _verifyPassword(plaintext, storedHash) {
    const raw  = String(plaintext  || '');
    const hash = String(storedHash || '').trim();
    if (!raw || !hash) return false;
    const parts = hash.split(':');
    if (parts.length === 3 && parts[0] === 'scrypt') {
      const [, salt, expectedHex] = parts;
      try {
        const expected = Buffer.from(expectedHex, 'hex');
        const derived  = crypto.scryptSync(raw, salt, expected.length);
        return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
      } catch (_) { return false; }
    }
    // Fallback: plaintext legacy
    return hash === raw;
  }

  app.post('/api/respaldos/cloud/auth', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'Email y contraseña requeridos.' });
      }

      const rows = await query(
        'SELECT id, email, password_hash, password, role FROM users WHERE email = ? LIMIT 1',
        [email.toLowerCase().trim()]
      ).catch(() => []);

      if (!rows.length) {
        return res.status(401).json({ ok: false, error: 'Credenciales incorrectas.' });
      }
      const user  = rows[0];
      // Intentar password_hash primero; caer en password legado
      const hash  = user.password_hash || user.password || '';
      const valid = _verifyPassword(password, hash);
      if (!valid) {
        return res.status(401).json({ ok: false, error: 'Credenciales incorrectas.' });
      }

      const businessId = await resolveBusinessId(query);
      const cloudToken = signCloudToken({
        email:      user.email,
        userId:     user.id,
        businessId,
        role:       user.role,
      });

      const nubeDisponible = await r2.isR2Available();

      res.json({ ok: true, cloudToken, businessId, email: user.email, nubeDisponible });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  POST /api/respaldos/subir-nube
  // ══════════════════════════════════════════════════════════════════════
  app.post('/api/respaldos/subir-nube', adminOnly, async (req, res) => {
    const actor = getActor(req);
    try {
      const { filePath: existingPath, password: pwdOverride } = req.body || {};
      const securityPwd = pwdOverride
        || process.env.TECNO_CAJA_SECURITY_PASSWORD
        || 'Seguridad2026';

      let fileBuffer, fileName, sha256, payload;

      if (existingPath && fs.existsSync(existingPath)) {
        // Subir archivo .tcbak existente
        fileBuffer = fs.readFileSync(existingPath);
        fileName   = path.basename(existingPath);
        sha256     = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        const parsed = await parseTcbakBuffer(fileBuffer, securityPwd);
        payload = parsed.payload;
      } else {
        // Crear nuevo .tcbak y subir
        payload    = await buildFullPayload(query);
        fileName   = generateFilename(payload.businessName, payload.systemVersion);
        fileBuffer = await createTcbakBuffer(payload, securityPwd);
        sha256     = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        // Guardar copia local también
        const backupDir = ensureDir(getDefaultBackupDir());
        const localPath = path.join(backupDir, fileName);
        fs.writeFileSync(localPath, fileBuffer);
        pruneLocalBackups(backupDir, await getBackupRetentionCount(query));
      }

      // Subir a Cloudflare R2
      const businessId = await resolveBusinessId(query);
      const storageKey = r2.backupKey(businessId, fileName);
      await r2.upload(storageKey, fileBuffer, {
        businessId,
        businessName:  payload.businessName,
        systemVersion: payload.systemVersion,
        sha256,
        exportedAt:    payload.exportedAt || new Date().toISOString(),
      });
      await pruneCloudBackups(businessId, await getBackupRetentionCount(query));

      // Actualizar índice email → businessId en R2
      try {
        const emailRows = await query(
          'SELECT email FROM users WHERE role = ? LIMIT 1', ['admin']
        ).catch(() => []);
        if (emailRows[0]?.email) {
          const idxKey  = r2.emailIndexKey(emailRows[0].email);
          const current = (await r2.getJson(idxKey)) || { businessIds: [] };
          if (!current.businessIds.includes(businessId)) {
            current.businessIds.push(businessId);
            await r2.putJson(idxKey, current);
          }
        }
      } catch (_) { /* non-fatal */ }

      // Historial local
      await recordHistory(query, {
        fileName,
        storagePath: storageKey,
        sha256,
        fileSize:    fileBuffer.length,
        tipo:        'local_cloud',
        estado:      'completado',
        businessName: payload.businessName,
        businessId:   String(payload.businessId || businessId),
        version:      payload.systemVersion,
        productos:    payload.stats?.productos || 0,
        clientes:     payload.stats?.clientes  || 0,
        ventas:       payload.stats?.ventas    || 0,
        createdBy:    actor.userName || 'sistema',
      });

      await writeAuditLog({
        userId: actor.userId, userName: actor.userName, userRole: actor.userRole,
        moduleName: 'respaldos', actionName: 'subir_nube',
        detail: `Respaldo subido a R2: ${storageKey}`,
      });

      res.json({ ok: true, fileName, storageKey, sha256, fileSize: fileBuffer.length });
    } catch (e) {
      await recordHistory(query, {
        fileName: 'error-nube', tipo: 'cloud', estado: 'fallido',
        errorMsg: e.message, createdBy: actor.userName || 'sistema',
      });
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  GET /api/respaldos/lista-nube
  // ══════════════════════════════════════════════════════════════════════
  app.get('/api/respaldos/lista-nube', anyStaff, async (req, res) => {
    try {
      const businessId = await resolveBusinessId(query);
      await pruneCloudBackups(businessId, await getBackupRetentionCount(query));
      const prefix     = r2.backupPrefix(businessId);
      const objects    = await r2.listObjects(prefix);

      const backups = objects
        .filter(o => (o.Key || '').endsWith('.tcbak'))
        .map(o => ({
          key:          o.Key,
          storageKey:   o.Key,
          fileName:     path.basename(o.Key),
          size:         o.Size,
          lastModified: o.LastModified,
        }))
        .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
        .slice(0, 30);

      res.json({ ok: true, backups, businessId });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, backups: [] });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  POST /api/respaldos/restaurar-local
  //  Body: { base64: '<base64 del .tcbak>', fileName, password }
  //  O:    { filePath: '/ruta/al/archivo.tcbak', password }
  // ══════════════════════════════════════════════════════════════════════
  app.post('/api/respaldos/restaurar-local', adminOnly, async (req, res) => {
    const actor = getActor(req);
    try {
      const { base64, filePath: fp, fileName, password: pwdOverride } = req.body || {};
      const securityPwd = pwdOverride
        || process.env.TECNO_CAJA_SECURITY_PASSWORD
        || 'Seguridad2026';

      let fileBuffer;
      if (base64) {
        fileBuffer = Buffer.from(base64, 'base64');
      } else if (fp && fs.existsSync(fp)) {
        fileBuffer = fs.readFileSync(fp);
      } else {
        return res.status(400).json({ ok: false, error: 'Proporciona el archivo de respaldo.' });
      }

      // Parsear y validar
      const { payload, metadata } = await parseTcbakBuffer(fileBuffer, securityPwd);

      // Crear respaldo del estado actual ANTES de restaurar
      const currentPayload = await buildFullPayload(query);
      const currentBuf     = await createTcbakBuffer(currentPayload, securityPwd);
      const preRestoreName = generateFilename(currentPayload.businessName + '_PRE-RESTAURACION', currentPayload.systemVersion);
      const backupDir      = ensureDir(getDefaultBackupDir());
      fs.writeFileSync(path.join(backupDir, preRestoreName), currentBuf);

      // Restaurar
      await restorePayloadToDb(payload, query);

      await writeAuditLog({
        userId: actor.userId, userName: actor.userName, userRole: actor.userRole,
        moduleName: 'respaldos', actionName: 'restaurar_local',
        detail: `Restauración desde: ${fileName || fp}. Pre-backup: ${preRestoreName}`,
      });

      res.json({
        ok: true,
        mensaje: 'Restauración completada. Reinicia la aplicación para aplicar los cambios.',
        metadata,
        preBackup: preRestoreName,
        reiniciarRequerido: true,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  POST /api/respaldos/restaurar-nube
  //  Body: { storageKey, sha256Esperado, password }
  // ══════════════════════════════════════════════════════════════════════
  app.post('/api/respaldos/restaurar-nube', adminOnly, async (req, res) => {
    const actor = getActor(req);
    try {
      const { storageKey, sha256Esperado, password: pwdOverride } = req.body || {};
      if (!storageKey) return res.status(400).json({ ok: false, error: 'storageKey requerido.' });

      const securityPwd = pwdOverride
        || process.env.TECNO_CAJA_SECURITY_PASSWORD
        || 'Seguridad2026';

      // Descargar desde Cloudflare R2
      const fileBuffer = await r2.download(storageKey);

      // Verificar hash si se proporcionó
      if (sha256Esperado) {
        const sha256Real = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        if (sha256Real !== sha256Esperado) {
          return res.status(400).json({ ok: false, error: 'El archivo descargado no coincide con el hash esperado.' });
        }
      }

      // Parsear y validar
      const { payload, metadata } = await parseTcbakBuffer(fileBuffer, securityPwd);

      // Pre-backup del estado actual
      const currentPayload = await buildFullPayload(query);
      const currentBuf     = await createTcbakBuffer(currentPayload, securityPwd);
      const preRestoreName = generateFilename(currentPayload.businessName + '_PRE-REST-NUBE', currentPayload.systemVersion);
      const backupDir      = ensureDir(getDefaultBackupDir());
      fs.writeFileSync(path.join(backupDir, preRestoreName), currentBuf);

      // Restaurar
      await restorePayloadToDb(payload, query);

      await writeAuditLog({
        userId: actor.userId, userName: actor.userName, userRole: actor.userRole,
        moduleName: 'respaldos', actionName: 'restaurar_nube',
        detail: `Restauración desde R2: ${storageKey}. Pre-backup: ${preRestoreName}`,
      });

      res.json({
        ok: true,
        mensaje: 'Restauración desde nube completada. Reinicia la aplicación.',
        metadata,
        preBackup: preRestoreName,
        reiniciarRequerido: true,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  PUT /api/respaldos/config
  // ══════════════════════════════════════════════════════════════════════
  app.put('/api/respaldos/config', adminOnly, async (req, res) => {
    const actor = getActor(req);
    try {
      const keys = [
        'backup_auto_diario', 'backup_auto_semanal', 'backup_al_cerrar_caja',
        'backup_nube_auto', 'backup_antes_actualizar', 'backup_antes_restaurar',
        'backup_dir_personalizado', 'backup_retener_cantidad',
      ];
      for (const k of keys) {
        if (req.body[k] !== undefined) {
          await query(
            `INSERT INTO installation_config (config_key, config_value)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [k, String(req.body[k])]
          ).catch(() =>
            query(`UPDATE installation_config SET config_value = ? WHERE config_key = ?`, [String(req.body[k]), k])
          );
        }
      }
      await writeAuditLog({
        userId: actor.userId, userName: actor.userName, userRole: actor.userRole,
        moduleName: 'respaldos', actionName: 'configurar_auto',
        detail: 'Configuración de respaldo automático actualizada.',
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  POST /api/respaldos/subir-pendientes
  // ══════════════════════════════════════════════════════════════════════
  app.post('/api/respaldos/subir-pendientes', adminOnly, async (req, res) => {
    const actor = getActor(req);
    try {
      const pendientes = await query(
        `SELECT * FROM backup_history WHERE estado = 'pendiente_nube' ORDER BY created_at DESC LIMIT 5`
      ).catch(() => []);

      const resultados = [];
      for (const row of pendientes) {
        if (!row.file_path || !fs.existsSync(row.file_path)) {
          resultados.push({ fileName: row.file_name, ok: false, error: 'Archivo local no encontrado.' });
          continue;
        }
        try {
          const fileBuffer = fs.readFileSync(row.file_path);
          const businessId = await resolveBusinessId(query);
          const storageKey = r2.backupKey(businessId, row.file_name);
          await r2.upload(storageKey, fileBuffer, { businessId });
          await pruneCloudBackups(businessId, await getBackupRetentionCount(query));
          await query('UPDATE backup_history SET estado = ?, tipo = ?, storage_path = ? WHERE id = ?', ['completado', 'local_cloud', storageKey, row.id]);
          resultados.push({ fileName: row.file_name, ok: true, storageKey });
        } catch (uploadErr) {
          resultados.push({ fileName: row.file_name, ok: false, error: uploadErr.message });
        }
      }

      res.json({ ok: true, resultados, subidos: resultados.filter(r => r.ok).length });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  POST /api/respaldos/subir-archivo
  //  Acepta un .tcbak en base64 desde el cliente y lo sube a R2 directamente.
  //  Útil para importar backups de otra máquina sin ruta local.
  //  Body: { base64: '<base64 del .tcbak>', fileName }
  // ══════════════════════════════════════════════════════════════════════
  app.post('/api/respaldos/subir-archivo', adminOnly, async (req, res) => {
    const actor = getActor(req);
    try {
      const { base64, fileName: rawFileName } = req.body || {};
      if (!base64) {
        return res.status(400).json({ ok: false, error: 'base64 requerido.' });
      }

      const fileBuffer = Buffer.from(base64, 'base64');
      if (!fileBuffer.length) {
        return res.status(400).json({ ok: false, error: 'El archivo está vacío.' });
      }

      // Validación mínima: el buffer debe parsear como JSON con el magic correcto
      try {
        const parsed = JSON.parse(fileBuffer.toString('utf8'));
        if (parsed.magic !== BACKUP_MAGIC) {
          return res.status(400).json({ ok: false, error: 'El archivo no es un respaldo válido de Tecno Caja.' });
        }
      } catch (_) {
        return res.status(400).json({ ok: false, error: 'El archivo de respaldo está corrupto o tiene un formato inválido.' });
      }

      const fileName  = rawFileName || `TecnoCaja_Upload_${Date.now()}.tcbak`;
      const sha256    = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      // Subir a R2
      const businessId = await resolveBusinessId(query);
      const storageKey = r2.backupKey(businessId, fileName);
      await r2.upload(storageKey, fileBuffer, {
        businessId,
        sha256,
        uploadedAt:  new Date().toISOString(),
        source:      'manual-upload',
        uploadedBy:  actor.userName || 'sistema',
      });
      await pruneCloudBackups(businessId, await getBackupRetentionCount(query));

      // Actualizar índice email → businessId en R2 (igual que subir-nube)
      // Necesario para que el wizard de restauración pueda encontrar el backup por email.
      try {
        const emailRows = await query(
          'SELECT email FROM users WHERE role = ? LIMIT 1', ['admin']
        ).catch(() => []);
        if (emailRows[0]?.email) {
          const idxKey  = r2.emailIndexKey(emailRows[0].email);
          const current = (await r2.getJson(idxKey)) || { businessIds: [] };
          if (!current.businessIds.includes(businessId)) {
            current.businessIds.push(businessId);
            await r2.putJson(idxKey, current);
          }
        }
      } catch (_) { /* non-fatal — no impide el upload */ }

      // Registrar en historial
      await recordHistory(query, {
        fileName,
        storagePath: storageKey,
        sha256,
        fileSize:    fileBuffer.length,
        tipo:        'cloud',
        estado:      'completado',
        createdBy:   actor.userName || 'sistema',
        observacion: 'Subido manualmente desde archivo externo',
      });

      await writeAuditLog({
        userId: actor.userId, userName: actor.userName, userRole: actor.userRole,
        moduleName: 'respaldos', actionName: 'subir_archivo_externo',
        detail: `Archivo subido a R2: ${storageKey} (${Math.round(fileBuffer.length / 1024)} KB)`,
      });

      res.json({ ok: true, fileName, storageKey, sha256, fileSize: fileBuffer.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  POST /api/respaldos/auto
  //  Llamado internamente al cerrar caja / cierre del app
  // ══════════════════════════════════════════════════════════════════════
  app.post('/api/respaldos/auto', async (req, res) => {
    try {
      const { trigger = 'manual', forceCloud = false } = req.body || {};
      const result = await app.locals.createAutomaticBackup({ trigger, forceCloud: Boolean(forceCloud) });
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  console.log('[respaldos] ✅ Rutas de respaldo registradas en /api/respaldos');

  // ══════════════════════════════════════════════════════════════════════
  //  RUTAS DE SETUP — activas SOLO mientras setup NO está completado
  //  No requieren sesión de usuario (el wizard aún no tiene DB configurada)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Middleware: permite acceso solo cuando el setup NO está completado,
   * O cuando el sistema está en estado "corrompido" (setup_completed=1 pero sin usuarios).
   *
   * Estado corrompido = se permite restaurar de nuevo para reparar la instalación.
   * Estado normal completado = bloqueado (usar rutas /api/respaldos/* con auth de admin).
   */
  async function setupOnly(req, res, next) {
    try {
      const [cfgRows, userRows] = await Promise.all([
        query('SELECT setup_completed FROM config WHERE id = 1 LIMIT 1').catch(() => []),
        query('SELECT COUNT(*) AS total FROM users').catch(() => [{ total: 1 }]),
      ]);
      const done     = cfgRows[0]?.setup_completed;
      const hasUsers = Number(userRows[0]?.total || 0) > 0;
      const isSetupDone = done === 1 || done === '1' || done === true;

      if (isSetupDone && hasUsers) {
        // Sistema completamente configurado — bloquear rutas de setup
        return res.status(403).json({ ok: false, error: 'El sistema ya está configurado.' });
      }

      // Permitir si: setup no completado (primera instalación)
      //          O: setup marcado como completado pero sin usuarios (estado corrompido/restauración incompleta)
      next();
    } catch (_) {
      next(); // tabla inexistente = primera instalación, permitir
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  //  POST /api/respaldos/setup/leer-tcbak
  //  Lee metadatos del archivo sin restaurar nada.
  //  Body: { base64: '<base64 del .tcbak>' }
  // ──────────────────────────────────────────────────────────────────────
  app.post('/api/respaldos/setup/leer-tcbak', setupOnly, async (req, res) => {
    try {
      const { base64 } = req.body || {};
      if (!base64) return res.status(400).json({ ok: false, error: 'base64 requerido.' });

      const fileBuffer = Buffer.from(base64, 'base64');
      let tcbak;
      try {
        tcbak = JSON.parse(fileBuffer.toString('utf8'));
      } catch (_) {
        return res.status(400).json({ ok: false, error: 'El archivo no es un respaldo válido de Tecno Caja (formato inválido).' });
      }

      if (tcbak.magic !== BACKUP_MAGIC) {
        return res.status(400).json({ ok: false, error: 'Este archivo no es un respaldo de Tecno Caja.' });
      }

      res.json({
        ok:        true,
        metadata:  tcbak.metadata  || {},
        createdAt: tcbak.createdAt || null,
        sha256:    tcbak.sha256    || null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  //  Helper: guardar metadata de restauración en installation_config
  //  y asegurarse de que setup_completed = 1 quedó grabado.
  // ──────────────────────────────────────────────────────────────────────
  async function _saveRestorationMetadata(metadata, tipo) {
    const now = new Date().toISOString();
    const safeSet = async (k, v) => {
      try {
        await query(
          `INSERT INTO installation_config (config_key, config_value) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
          [k, String(v)]
        );
      } catch (_) {
        // installation_config puede no existir; ignorar
      }
    };
    await safeSet('restoration_tipo',         tipo);
    await safeSet('restoration_at',           now);
    await safeSet('restoration_business_id',  metadata?.businessId   || '');
    await safeSet('restoration_business_name',metadata?.businessName || '');
    await safeSet('restoration_version',      metadata?.systemVersion || '');

    // Doble garantía: setup_completed = 1 directamente en config
    try {
      await query('UPDATE `config` SET `setup_completed` = 1 WHERE `id` = 1');
      // Si por alguna razón config está vacía, insertar fila mínima
      const rows = await query('SELECT id FROM `config` WHERE id = 1 LIMIT 1');
      if (!rows || !rows.length) {
        await query("INSERT IGNORE INTO `config` (id, setup_completed) VALUES (1, 1)");
      }
    } catch (_) {}

    console.log(`[respaldos][setup] Restauración tipo="${tipo}" guardada. Business: "${metadata?.businessName}" — ${now}`);
  }

  // ──────────────────────────────────────────────────────────────────────
  //  POST /api/respaldos/setup/restaurar-local
  //  Restaura desde un archivo .tcbak en base64 sin sesión de usuario.
  //  Body: { base64, fileName, password }
  // ──────────────────────────────────────────────────────────────────────
  app.post('/api/respaldos/setup/restaurar-local', setupOnly, async (req, res) => {
    try {
      const { base64 } = req.body || {};
      if (!base64) return res.status(400).json({ ok: false, error: 'base64 requerido.' });

      // Siempre usa la contraseña del .env (el campo de contraseña en UI ya no se usa
      // para el cifrado — se reserva para verificación de identidad futura).
      const securityPwd = process.env.TECNO_CAJA_SECURITY_PASSWORD || 'Seguridad2026';

      const fileBuffer = Buffer.from(base64, 'base64');
      const { payload, metadata } = await parseTcbakBuffer(fileBuffer, securityPwd);

      // Verificación preventiva: si el backup no tiene usuarios, avisarlo antes de restaurar
      const backupUserCount = Array.isArray(payload?.data?.users) ? payload.data.users.length : 0;
      console.log(`[respaldos][setup] Restaurando backup: ${backupUserCount} usuario(s), ${payload?.stats?.productos || 0} producto(s), ${payload?.stats?.ventas || 0} venta(s)`);

      const restoreResult = await restorePayloadToDb(payload, query);

      if (restoreResult.userCount === 0) {
        // El backup no tenía usuarios (o la restauración de usuarios falló).
        // setup_completed ya fue puesto a 0 dentro de restorePayloadToDb, así que
        // el usuario verá el wizard de primera instalación en lugar del overlay "corrompido".
        const motivo = backupUserCount === 0
          ? 'Este respaldo no contiene usuarios registrados.'
          : `El respaldo tiene ${backupUserCount} usuario(s) en el archivo pero no se pudieron restaurar.`;

        return res.status(422).json({
          ok:    false,
          code:  'NO_USERS_IN_BACKUP',
          error: `${motivo} La aplicación se reiniciará en modo de configuración inicial para que puedas comenzar desde cero.`,
          reiniciarRequerido: true,
          setupReset: true,   // el frontend puede reiniciar la app igualmente
        });
      }

      // Guardar metadata de restauración (audit + setup_completed garantizado)
      await _saveRestorationMetadata(metadata, 'local');

      res.json({
        ok:                true,
        mensaje:           'Restauración completada. Reinicia la aplicación para aplicar los cambios.',
        metadata,
        usersRestored:     restoreResult.userCount,
        reiniciarRequerido: true,
      });
    } catch (e) {
      console.error('[respaldos][setup] Error en restaurar-local:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  //  POST /api/respaldos/setup/cloud/auth
  //  Busca backups en R2 por email (sin sesión — wizard de primera instalación).
  //  Body: { email }
  //  Retorna: { businessId, businessIds, backups, email }
  // ──────────────────────────────────────────────────────────────────────
  app.post('/api/respaldos/setup/cloud/auth', setupOnly, async (req, res) => {
    try {
      const { email } = req.body || {};
      if (!email) return res.status(400).json({ ok: false, error: 'Email requerido.' });

      // Verificar R2 disponible
      const nubeOk = await r2.isR2Available();
      if (!nubeOk) {
        return res.status(503).json({ ok: false, error: 'La nube no está disponible o no está configurada en este dispositivo.' });
      }

      // ── Paso 1: Buscar businessId en índice R2 por email ────────────────
      const idxKey = r2.emailIndexKey(email);
      const idx    = await r2.getJson(idxKey);

      let resolvedBusinessIds = idx?.businessIds?.length ? idx.businessIds : null;

      // ── Paso 2: Fallback por TECNO_CAJA_LICENSE_UID ──────────────────────
      // El índice email→businessId se crea solo cuando se sube un backup desde
      // este dispositivo. Si el backup fue subido en otro dispositivo o la
      // primera instalación nunca creó el índice, el lookup por email falla.
      // En ese caso intentamos directamente con la UID de licencia del .env.
      if (!resolvedBusinessIds) {
        const envUid = (process.env.TECNO_CAJA_LICENSE_UID || '').trim();
        if (envUid) {
          console.log(`[respaldos][setup/cloud/auth] Índice email no encontrado. Probando fallback con TECNO_CAJA_LICENSE_UID="${envUid}"`);
          try {
            const fallbackObjects = await r2.listObjects(r2.backupPrefix(envUid));
            const fallbackBackups = fallbackObjects.filter(o => (o.Key || '').endsWith('.tcbak'));
            if (fallbackBackups.length > 0) {
              console.log(`[respaldos][setup/cloud/auth] Fallback exitoso: ${fallbackBackups.length} respaldo(s) encontrado(s) con UID de licencia.`);
              resolvedBusinessIds = [envUid];
              // Registrar el índice en R2 para futuros lookups por email
              try {
                const newIdx = { businessIds: [envUid], createdByFallback: true, createdAt: new Date().toISOString() };
                await r2.putJson(idxKey, newIdx);
                console.log(`[respaldos][setup/cloud/auth] Índice email actualizado en R2 para futuros lookups.`);
              } catch (_) { /* non-fatal */ }
            }
          } catch (fallbackErr) {
            console.warn(`[respaldos][setup/cloud/auth] Fallback con UID de licencia también falló: ${fallbackErr.message}`);
          }
        }
      }

      if (!resolvedBusinessIds) {
        return res.status(404).json({
          ok: false,
          error: 'No se encontraron respaldos en la nube para este correo. Si subiste el respaldo desde otro dispositivo, asegúrate de usar el mismo correo con el que creaste la cuenta en ese dispositivo.',
        });
      }

      // ── Paso 3: Listar backups del primer businessId (el principal) ──────
      const businessId = resolvedBusinessIds[0];
      const prefix     = r2.backupPrefix(businessId);
      const objects    = await r2.listObjects(prefix);
      const backups    = objects
        .filter(o => (o.Key || '').endsWith('.tcbak'))
        .map(o => ({
          key:          o.Key,
          storageKey:   o.Key,
          fileName:     path.basename(o.Key),
          size:         o.Size,
          lastModified: o.LastModified,
        }))
        .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
        .slice(0, 20);

      res.json({ ok: true, businessId, businessIds: resolvedBusinessIds, backups, email });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  //  GET /api/respaldos/setup/lista-nube
  //  Lista respaldos en R2 por businessId (sin sesión — wizard).
  //  Query: ?businessId=xxx
  // ──────────────────────────────────────────────────────────────────────
  app.get('/api/respaldos/setup/lista-nube', setupOnly, async (req, res) => {
    try {
      const businessId = (req.query.businessId || '').trim();
      if (!businessId) return res.status(400).json({ ok: false, error: 'businessId requerido.' });

      const prefix  = r2.backupPrefix(businessId);
      const objects = await r2.listObjects(prefix);
      const backups = objects
        .filter(o => (o.Key || '').endsWith('.tcbak'))
        .map(o => ({
          key:          o.Key,
          storageKey:   o.Key,
          fileName:     path.basename(o.Key),
          size:         o.Size,
          lastModified: o.LastModified,
        }))
        .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
        .slice(0, 20);

      res.json({ ok: true, backups, businessId });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, backups: [] });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  //  POST /api/respaldos/setup/restaurar-nube
  //  Descarga y restaura un respaldo de R2 sin sesión (wizard).
  //  Body: { storageKey, loginEmail, loginPassword, sha256Esperado }
  //
  //  Autenticación: verifica loginEmail + loginPassword contra los usuarios
  //  almacenados en el propio backup antes de restaurar.
  //  El cifrado del backup usa TECNO_CAJA_SECURITY_PASSWORD del .env.
  // ──────────────────────────────────────────────────────────────────────
  app.post('/api/respaldos/setup/restaurar-nube', setupOnly, async (req, res) => {
    try {
      const {
        storageKey,
        sha256Esperado,
        loginEmail,
        loginPassword,
        // campo legacy (ignorado en nueva versión; el cifrado usa siempre la env var)
        password: _legacyPwd,
      } = req.body || {};

      if (!storageKey) return res.status(400).json({ ok: false, error: 'storageKey requerido.' });

      // Contraseña de cifrado del .env (nunca la del usuario — son cosas distintas)
      const securityPwd = process.env.TECNO_CAJA_SECURITY_PASSWORD || 'Seguridad2026';

      // Descargar desde R2
      const fileBuffer = await r2.download(storageKey);

      // Verificar hash si se proporcionó
      if (sha256Esperado) {
        const sha256Real = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        if (sha256Real !== sha256Esperado) {
          return res.status(400).json({ ok: false, error: 'El archivo descargado no coincide con el hash esperado. Puede estar corrupto.' });
        }
      }

      // Descifrar y parsear backup
      const { payload, metadata } = await parseTcbakBuffer(fileBuffer, securityPwd);

      // ── Verificar identidad del usuario contra datos del backup ──────────
      // Solo si se proporcionan credenciales (requeridas si el backup tiene usuarios)
      const backupUsers = (payload?.data?.users) || [];
      if (backupUsers.length > 0) {
        if (!loginEmail || !loginPassword) {
          return res.status(401).json({
            ok:    false,
            error: 'Ingresa tu correo y contraseña de TecnoCaja para confirmar tu identidad.',
          });
        }
        const emailNorm = loginEmail.toLowerCase().trim();
        const userMatch = backupUsers.find(u =>
          (u.email || '').toLowerCase().trim() === emailNorm
        );
        if (!userMatch) {
          return res.status(401).json({
            ok:    false,
            error: 'No se encontró un usuario con ese correo en el respaldo. Verifica el correo.',
          });
        }
        const storedHash = userMatch.password_hash || userMatch.password || '';
        if (!_verifyPassword(loginPassword, storedHash)) {
          return res.status(401).json({
            ok:    false,
            error: 'Contraseña incorrecta para este usuario. Usa la contraseña con la que accedes a TecnoCaja.',
          });
        }
      }

      // Restaurar
      const backupUserCount = Array.isArray(payload?.data?.users) ? payload.data.users.length : 0;
      console.log(`[respaldos][setup] Restaurando backup nube: ${backupUserCount} usuario(s), ${payload?.stats?.productos || 0} producto(s)`);

      const restoreResult = await restorePayloadToDb(payload, query);

      if (restoreResult.userCount === 0) {
        const motivo = backupUserCount === 0
          ? 'Este respaldo no contiene usuarios registrados.'
          : `El respaldo tiene ${backupUserCount} usuario(s) pero no se pudieron restaurar.`;
        return res.status(422).json({
          ok:    false,
          code:  'NO_USERS_IN_BACKUP',
          error: `${motivo} La aplicación se reiniciará en modo de configuración inicial.`,
          reiniciarRequerido: true,
          setupReset: true,
        });
      }

      // Guardar metadata de restauración (audit + setup_completed garantizado)
      await _saveRestorationMetadata(metadata, 'nube');

      res.json({
        ok:                true,
        mensaje:           'Restauración desde la nube completada. Reinicia la aplicación.',
        metadata,
        usersRestored:     restoreResult.userCount,
        reiniciarRequerido: true,
      });
    } catch (e) {
      console.error('[respaldos][setup] Error en restaurar-nube:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};

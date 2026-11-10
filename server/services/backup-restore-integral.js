'use strict';
const catalog = require('./backup-catalog');
const files = require('./backup-components');
const ID = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;
const quote = (s) => { if (!ID.test(s)) throw new Error('Identificador SQL inválido.'); return '`' + s + '`'; };
const SECRET = /(^|_)(password|secret|token|private_key|api_key|access_key)(_|$)/i;
async function validarIdentidad(payload, query, expectedLicenseUid = '') {
  const rows = await query('SELECT * FROM config WHERE id = 1');
  const current = rows[0] || {};
  if (!Number(current.setup_completed)) return current;
  const pares = [
    [payload.companyUuid, current.business_uuid],
    [payload.licenseUid, expectedLicenseUid],
    [String(payload.rnc || '').replace(/\D/g, ''), String(current.rnc || '').replace(/\D/g, '')],
  ].filter(([a, b]) => a && b);
  if (!pares.length) throw new Error('No se puede comprobar que el respaldo pertenece a esta empresa. Requiere recuperación con identidad original autorizada.');
  if (pares.some(([a, b]) => String(a) !== String(b))) throw new Error('El respaldo pertenece a otra empresa. Restauración cancelada.');
  return current;
}
async function prevalidar(payload, query, { expectedLicenseUid = '', components } = {}) {
  const contenido = catalog.validarCatalogo(payload);
  files.validar(payload.archivos, components);
  const current = await validarIdentidad(payload, query, expectedLicenseUid);
  const destino = [];
  for (const entrada of contenido.manifiesto) {
    const table = entrada.nombre, rows = contenido.tablas[table];
    const columns = await query(`PRAGMA table_info(${quote(table)})`);
    if (!columns.length) { if (!rows.length) continue; throw new Error(`Falta el módulo o la migración de ${table}. Actualiza el sistema antes de restaurar.`); }
    const nombres = new Set(columns.map((c) => c.name));
    for (const row of rows) for (const key of Object.keys(row)) {
      if (!nombres.has(key)) throw new Error(`La columna ${table}.${key} no existe en esta versión. No se ha modificado la base.`);
    }
    destino.push({ table, rows, columns });
  }
  if (!contenido.tablas.config?.some((c) => Number(c.id) === 1) || !contenido.tablas.users?.length) throw new Error('El respaldo carece de empresa o usuarios recuperables.');
  return { destino, current, backupId: payload.backupId, empresaId: payload.companyUuid || payload.licenseUid || null,
    capturedAt: payload.snapshot?.capturedAt || payload.exportedAt, requiresReconfiguration: contenido.requiereReconfiguracion || [] };
}
function valorDb(value, type) {
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.__tcbak_binary === 'string') return Buffer.from(value.__tcbak_binary, 'base64');
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof value === 'string' && /^(DATE|DATETIME|TIMESTAMP)\b/i.test(type) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 19).replace('T', ' ');
  return value === undefined ? null : value;
}
async function restaurar(payload, query, { withTransaction, dialect = 'sqlite', expectedLicenseUid = '', components = files.defaultComponents() } = {}) {
  if (typeof withTransaction !== 'function') throw new Error('La restauración integral necesita una transacción dedicada.');
  await prevalidar(payload, query, { expectedLicenseUid, components });
  const staged = await files.preparar(payload.archivos, { components });
  let result;
  try { result = await withTransaction(async ({ query: q }) => {
    // Revalida dentro del corte transaccional; no ejecuta SQL guardado en el archivo.
    const plan = await prevalidar(payload, q, { expectedLicenseUid, components });
    if (dialect === 'mysql') await q('SET FOREIGN_KEY_CHECKS = 0');
    else await q('PRAGMA defer_foreign_keys = ON');
    try {
      const rowsProtegidas = new Map();
      for (const { table } of plan.destino) {
        if (table === 'installation_config') rowsProtegidas.set(table, (await q('SELECT * FROM installation_config')).filter((r) => SECRET.test(String(r.config_key || ''))));
      }
      // Vaciar antes de insertar: ON DELETE CASCADE/SET NULL nunca debe tocar
      // filas que ya se recuperaron en esta misma transacción.
      for (const { table } of [...plan.destino].reverse()) await q(`DELETE FROM ${quote(table)}`);
      for (const { table, rows, columns } of plan.destino) {
        const protegidas = rowsProtegidas.get(table) || [];
        for (const source of [...rows, ...protegidas]) {
          const row = { ...source };
          // Los enlaces absolutos de adjuntos se adaptan a las carpetas de esta PC.
          for (const [key, value] of Object.entries(row)) {
            if (typeof value !== 'string') continue;
            for (const c of payload.archivos?.componentes || []) {
              const target = components.find((item) => item.id === c.id);
              if (!target || !c.sourceRoot) continue;
              const oldRoot = String(c.sourceRoot).replace(/\\/g, '/').replace(/\/$/, '');
              const normalized = value.replace(/\\/g, '/');
              if (normalized.toLowerCase().startsWith(oldRoot.toLowerCase() + '/')) row[key] = files.rutaSegura(target.root, normalized.slice(oldRoot.length + 1));
            }
          }
          if (table === 'config' && Number(row.id) === 1) {
            for (const col of columns) if (SECRET.test(col.name) && plan.current[col.name] !== undefined) row[col.name] = plan.current[col.name];
            if (!row.business_uuid && plan.current.business_uuid) row.business_uuid = plan.current.business_uuid;
          }
          const cols = columns.filter((c) => Object.prototype.hasOwnProperty.call(row, c.name));
          if (!cols.length) throw new Error(`Fila sin columnas recuperables en ${table}.`);
          await q(`INSERT INTO ${quote(table)} (${cols.map((c) => quote(c.name)).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => valorDb(row[c.name], c.type || '')));
        }
      }
      for (const { table, rows } of plan.destino) {
        const count = await q(`SELECT COUNT(*) AS total FROM ${quote(table)}`);
        if (Number(count[0]?.total) !== rows.length + (rowsProtegidas.get(table)?.length || 0)) throw new Error(`La cantidad restaurada no coincide en ${table}.`);
      }
      if (dialect === 'sqlite') {
        const errores = await q('PRAGMA foreign_key_check');
        if (errores.length) throw new Error(`Integridad referencial incorrecta: ${errores[0].table}.`);
      } else {
        const relaciones = await q(`SELECT TABLE_NAME AS tabla, COLUMN_NAME AS columna, REFERENCED_TABLE_NAME AS padre, REFERENCED_COLUMN_NAME AS clave, CONSTRAINT_NAME AS restriccion, ORDINAL_POSITION AS orden
          FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`);
        const grupos = new Map();
        for (const r of relaciones) { const key = `${r.tabla}:${r.restriccion}`; if (!grupos.has(key)) grupos.set(key, []); grupos.get(key).push(r); }
        for (const cols of grupos.values()) {
          const r = cols[0];
          const noNulos = cols.map((c) => `h.${quote(c.columna)} IS NOT NULL`).join(' AND ');
          const join = cols.map((c) => `p.${quote(c.clave)} = h.${quote(c.columna)}`).join(' AND ');
          const errores = await q(`SELECT 1 AS error FROM ${quote(r.tabla)} h WHERE ${noNulos} AND NOT EXISTS (SELECT 1 FROM ${quote(r.padre)} p WHERE ${join}) LIMIT 1`);
          if (errores.length) throw new Error(`Integridad referencial incorrecta: ${r.tabla}.`);
        }
      }
      const existing = await q("SELECT name, sql FROM sqlite_master WHERE type = 'table'");
      for (const sessionTable of ['auth_sessions', 'sesiones_activas']) {
        if (existing.some((t) => t.name === sessionTable)) await q(`DELETE FROM ${quote(sessionTable)}`);
      }
      await staged.commit();
      return { userCount: payload.catalogo.tablas.users.length, backupId: plan.backupId, empresaId: plan.empresaId, restoredAt: new Date().toISOString(), capturedAt: plan.capturedAt, requiresReconfiguration: plan.requiresReconfiguration };
    } finally { if (dialect === 'mysql') await q('SET FOREIGN_KEY_CHECKS = 1'); }
  }); } catch (e) { await staged.revertir(); throw e; }
  // Una limpieza fallida no debe fingir que la transacción confirmada falló.
  await staged.terminar().catch(() => console.warn('[backup] Quedaron archivos temporales anteriores para limpieza.'));
  return result;
}
module.exports = { prevalidar, restaurar, validarIdentidad };

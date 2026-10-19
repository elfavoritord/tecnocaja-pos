'use strict';

/**
 * server/migrations/runner.js — Migraciones numeradas y reversibles.
 *
 * Convive con runCoreSchemaMigrations() de server.js: usa la misma tabla
 * schema_migrations (migration_key) pero cada migración tiene su propia clave
 * ("ms-0001-…") en vez de una sola versión para todo el esquema.
 *
 * Reglas:
 *  - Cada `up` es idempotente: en MariaDB el DDL hace commit implícito y una
 *    migración puede quedar a medias si se corta la luz; al reintentar debe
 *    terminar sin error.
 *  - `verificar` es estructural (columnas/tablas existen). Se consulta aunque
 *    la clave ya esté registrada: el migrador SQLite→MySQL copia
 *    schema_migrations y la clave puede llegar sin el esquema.
 *  - En MariaDB, GET_LOCK impide que dos servidores (principal + terminal
 *    completa) migren a la vez la misma base.
 *  - Antes de aplicar se llama a `beforeApply` (respaldo). Si devuelve false,
 *    no se migra en este arranque y la app sigue como antes.
 */

const IDENTIFICADOR = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name) {
  if (!IDENTIFICADOR.test(String(name || ''))) {
    throw new Error(`Identificador SQL no permitido: ${name}`);
  }
  return name;
}

const UUID_SQLITE = "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || "
  + "substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || "
  + "substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))";

// Expresión SQL que genera un UUID distinto por fila (v1 en MariaDB, v4 en SQLite).
function uuidSqlExpression(dialect) {
  return dialect === 'mysql' ? 'UUID()' : `(${UUID_SQLITE})`;
}

// Ayudantes que cada migración recibe. SQL explícito por motor: no dependen
// de las traducciones de db.js, así sirven igual con una conexión mysql2
// cruda (migrador SQLite→MySQL).
function createMigrationContext({ query, dialect, options = {} }) {
  const isMysql = dialect === 'mysql';

  async function hasTable(table) {
    assertIdentifier(table);
    const rows = isMysql
      ? await query(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
        [table]
      )
      : await query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
    return Number(rows[0]?.n || 0) > 0;
  }

  async function hasColumn(table, column) {
    assertIdentifier(table);
    assertIdentifier(column);
    if (isMysql) {
      const rows = await query(
        'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
        [table, column]
      );
      return Number(rows[0]?.n || 0) > 0;
    }
    const rows = await query(`PRAGMA table_info(${table})`);
    return rows.some((row) => String(row.name || '').toLowerCase() === column.toLowerCase());
  }

  async function hasIndex(table, indexName) {
    assertIdentifier(table);
    assertIdentifier(indexName);
    const rows = isMysql
      ? await query(
        'SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
        [table, indexName]
      )
      : await query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?", [indexName]);
    return Number(rows[0]?.n || 0) > 0;
  }

  async function addColumn(table, column, definition) {
    if (await hasColumn(table, column)) return false;
    await query(`ALTER TABLE ${table} ADD COLUMN \`${column}\` ${definition}`);
    return true;
  }

  async function dropColumn(table, column) {
    if (!(await hasTable(table)) || !(await hasColumn(table, column))) return false;
    await query(`ALTER TABLE ${table} DROP COLUMN \`${column}\``);
    return true;
  }

  async function createIndex(table, indexName, columns, { unique = false } = {}) {
    assertIdentifier(table);
    assertIdentifier(indexName);
    const cols = columns.map((c) => `\`${assertIdentifier(c)}\``).join(', ');
    await query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${indexName} ON ${table} (${cols})`);
  }

  async function dropIndex(table, indexName) {
    assertIdentifier(table);
    assertIdentifier(indexName);
    if (!(await hasIndex(table, indexName))) return false;
    await query(isMysql ? `DROP INDEX ${indexName} ON ${table}` : `DROP INDEX IF EXISTS ${indexName}`);
    return true;
  }

  async function dropTable(table) {
    assertIdentifier(table);
    await query(`DROP TABLE IF EXISTS ${table}`);
  }

  async function countRows(table, where = '1 = 1', params = []) {
    assertIdentifier(table);
    const rows = await query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params);
    return Number(rows[0]?.n || 0);
  }

  return {
    query,
    dialect,
    isMysql,
    options,
    hasTable,
    hasColumn,
    hasIndex,
    addColumn,
    dropColumn,
    createIndex,
    dropIndex,
    dropTable,
    countRows,
    uuidSql: () => uuidSqlExpression(dialect),
    types: {
      pk: isMysql ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT',
      longText: isMysql ? 'LONGTEXT' : 'TEXT',
      text: 'TEXT',
    },
  };
}

function createMigrationRunner({
  query,
  withTransaction,
  dialect,
  migrations,
  beforeApply = null,
  logger = console,
  lockName = 'tecnocaja_migraciones',
  lockTimeoutSeconds = 60,
  options = {},
}) {
  if (!Array.isArray(migrations)) throw new Error('migrations debe ser un arreglo');
  const ids = new Set();
  for (const m of migrations) {
    if (!m || !m.id || typeof m.up !== 'function') throw new Error('Migración inválida: falta id o up()');
    if (ids.has(m.id)) throw new Error(`Migración duplicada: ${m.id}`);
    ids.add(m.id);
  }
  const isMysql = dialect === 'mysql';
  const runInTransaction = typeof withTransaction === 'function'
    ? withTransaction
    : async (work) => work({ query });

  async function ensureMigrationsTable(q) {
    await q(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_key VARCHAR(120) PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async function loadAppliedKeys(q) {
    const rows = await q('SELECT migration_key FROM schema_migrations');
    return new Set(rows.map((row) => String(row.migration_key)));
  }

  async function isApplied(q, migration, appliedKeys) {
    if (!appliedKeys.has(migration.id)) return false;
    if (typeof migration.verificar !== 'function') return true;
    return Boolean(await migration.verificar(createMigrationContext({ query: q, dialect, options })));
  }

  async function withLock(q, work) {
    if (!isMysql) return work();
    const rows = await q('SELECT GET_LOCK(?, ?) AS ok', [lockName, lockTimeoutSeconds]);
    if (Number(rows[0]?.ok) !== 1) {
      return { applied: [], skipped: true, reason: 'otra PC está migrando esta base' };
    }
    try {
      return await work();
    } finally {
      await q('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
    }
  }

  async function status() {
    await ensureMigrationsTable(query);
    const appliedKeys = await loadAppliedKeys(query);
    const result = [];
    for (const m of migrations) {
      result.push({
        id: m.id,
        descripcion: m.descripcion || '',
        aplicada: await isApplied(query, m, appliedKeys),
        registrada: appliedKeys.has(m.id),
      });
    }
    return result;
  }

  async function runPending() {
    await ensureMigrationsTable(query);
    const appliedKeys = await loadAppliedKeys(query);
    const pending = [];
    for (const m of migrations) {
      if (!(await isApplied(query, m, appliedKeys))) pending.push(m);
    }
    if (!pending.length) return { applied: [], skipped: false };

    if (typeof beforeApply === 'function') {
      const ready = await beforeApply(pending.map((m) => m.id));
      if (ready === false) {
        return { applied: [], skipped: true, reason: 'no se pudo hacer el respaldo previo' };
      }
    }

    return runInTransaction(async (conn) => {
      const q = conn.query;
      return withLock(q, async () => {
        // Releer bajo el lock: otra PC pudo terminar mientras esperábamos.
        const keysNow = await loadAppliedKeys(q);
        const applied = [];
        for (const m of pending) {
          if (await isApplied(q, m, keysNow)) continue;
          const startedAt = Date.now();
          const ctx = createMigrationContext({ query: q, dialect, options });
          await m.up(ctx);
          if (typeof m.verificar === 'function' && !(await m.verificar(ctx))) {
            throw new Error(`La migración ${m.id} terminó pero su esquema no quedó completo.`);
          }
          if (!keysNow.has(m.id)) {
            await q('INSERT INTO schema_migrations (migration_key) VALUES (?)', [m.id]);
            keysNow.add(m.id);
          }
          applied.push({ id: m.id, ms: Date.now() - startedAt });
          logger.log?.(`[migraciones] ${m.id} aplicada en ${Date.now() - startedAt} ms`);
        }
        return { applied, skipped: false };
      });
    });
  }

  // Revierte UNA migración. Solo se permite revertir de la última hacia atrás:
  // si una posterior sigue aplicada, se niega (dependen unas de otras).
  async function revert(id) {
    const index = migrations.findIndex((m) => m.id === id);
    if (index < 0) throw new Error(`No existe la migración ${id}`);
    const migration = migrations[index];
    if (typeof migration.down !== 'function') throw new Error(`La migración ${id} no tiene reversión`);

    await ensureMigrationsTable(query);
    const appliedKeys = await loadAppliedKeys(query);
    const later = migrations.slice(index + 1).filter((m) => appliedKeys.has(m.id));
    if (later.length) {
      throw new Error(`Primero revierte: ${later.map((m) => m.id).reverse().join(', ')}`);
    }

    return runInTransaction(async (conn) => {
      const q = conn.query;
      return withLock(q, async () => {
        await migration.down(createMigrationContext({ query: q, dialect, options }));
        await q('DELETE FROM schema_migrations WHERE migration_key = ?', [id]);
        logger.log?.(`[migraciones] ${id} revertida`);
        return { reverted: id };
      });
    });
  }

  return { runPending, revert, status };
}

module.exports = { createMigrationRunner, createMigrationContext, assertIdentifier, uuidSqlExpression };

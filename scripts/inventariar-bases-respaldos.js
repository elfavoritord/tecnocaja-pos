'use strict';
// Solo SELECT/SHOW sobre conexiones existentes: no inicializa ni migra bases.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const root = path.resolve(__dirname, '..');
const env = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
async function main() {
  const conn = await mysql.createConnection({ host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD, connectTimeout: 5000 });
  const result = [];
  try {
    const [schemas] = await conn.query('SHOW DATABASES');
    for (const row of schemas) {
      const schema = row.Database;
      if (['information_schema', 'mysql', 'performance_schema', 'sys'].includes(schema)) continue;
      const quoted = '`' + schema.replace(/`/g, '``') + '`';
      try {
        const [exists] = await conn.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [schema, 'config']);
        if (!exists.length) continue;
        const [rows] = await conn.query(`SELECT * FROM ${quoted}.config WHERE id = 1`);
        const c = rows[0]; if (!c) continue;
        const counts = {};
        const [tables] = await conn.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [schema]);
        for (const table of ['users', 'products', 'sales', 'service_invoices', 'backup_history']) {
          if (!tables.some((t) => t.TABLE_NAME === table)) continue;
          const [r] = await conn.query(`SELECT COUNT(*) AS n FROM ${quoted}.\`${table}\``); counts[table] = Number(r[0].n);
        }
        let backupConfig = [];
        if (tables.some((t) => t.TABLE_NAME === 'installation_config')) [backupConfig] = await conn.query(`SELECT config_key, config_value FROM ${quoted}.installation_config WHERE config_key LIKE 'backup_%'`);
        let history = [];
        if (tables.some((t) => t.TABLE_NAME === 'backup_history')) [history] = await conn.query(`SELECT file_name, file_path, storage_path, estado, sha256, created_at FROM ${quoted}.backup_history ORDER BY created_at DESC LIMIT 5`);
        result.push({ schema, name: c.business_name, uuid: c.business_uuid || null, businessId: c.business_id, rncPresent: Boolean(c.rnc), setupCompleted: Boolean(c.setup_completed), businessType: c.business_type, tables: tables.length, counts, backupConfig, history });
      } catch (e) { result.push({ schema, error: e.message }); }
    }
  } finally { await conn.end(); }
  const output = path.join(root, 'runtime-data', 'auditoria-respaldos', 'bases-locales.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, databases: result.map((r) => ({ schema: r.schema, name: r.name, uuid: r.uuid, setupCompleted: r.setupCompleted, counts: r.counts, lastBackup: r.history?.[0], error: r.error })) }, null, 2));
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });

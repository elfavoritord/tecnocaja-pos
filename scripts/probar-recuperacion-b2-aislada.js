'use strict';
// Recupera la copia verificada de la empresa local en una base temporal nueva.
// No usa db.js/server.js ni ejecuta SQL de creación almacenado en el respaldo.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const ROOT = path.resolve(__dirname, '..');
const env = dotenv.parse(fs.readFileSync(path.join(ROOT, '.env')));
for (const [k,v] of Object.entries(env)) if (v) process.env[k] = v;
const evidencePath = path.join(ROOT, 'runtime-data', 'auditoria-respaldos', 'respaldo-local-nuevo.json');
const original = JSON.parse(fs.readFileSync(evidencePath));
const targetName = 'tc_backup_verify_' + crypto.randomBytes(6).toString('hex');
const ownedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-backup-restore-'));
const qid = (v) => '`' + String(v).replace(/`/g, '``') + '`';
const report = { startedAt: new Date().toISOString(), sourceDatabase: env.DB_NAME, temporaryDatabase: targetName, sourceDatabaseModified: false, restored: false, cleanedDatabase: false };
const save = () => fs.writeFileSync(path.join(ROOT, 'runtime-data', 'auditoria-respaldos', 'recuperacion-real-aislada.json'), JSON.stringify(report, null, 2));
async function main() {
  if (!original.cloudVerified || original.database !== env.DB_NAME || !/^tc_backup_verify_[a-f0-9]{12}$/.test(targetName) || targetName === env.DB_NAME) throw new Error('No se pudo comprobar el aislamiento.');
  const storage = require('../server/services/r2-storage');
  const bytes = await storage.download(original.storageKey);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== original.sha256) throw new Error('La copia de B2 cambió desde su verificación.');
  const { payload } = await require('../server/services/backup-format').parseTcbakBuffer(bytes, env.TECNO_CAJA_SECURITY_PASSWORD);
  if (payload.licenseUid !== original.licenseUid) throw new Error('La identidad de la copia no coincide.');
  const conn = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, dateStrings: true });
  let created = false;
  try {
    // Copia el esquema ACTUAL del servidor, nunca sentencias proporcionadas por el archivo.
    const [tables] = await conn.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [env.DB_NAME]);
    await conn.query(`CREATE DATABASE ${qid(targetName)} CHARACTER SET utf8mb4`); created = true;
    await conn.query(`USE ${qid(targetName)}`);
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const { TABLE_NAME: table } of tables) {
      const [ddl] = await conn.query(`SHOW CREATE TABLE ${qid(env.DB_NAME)}.${qid(table)}`);
      let sql = ddl[0]['Create Table'];
      // Las referencias calificadas también deben apuntar al laboratorio.
      sql = sql.split(qid(env.DB_NAME) + '.').join(qid(targetName) + '.');
      await conn.query(sql);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    const query = async (sql, params = []) => {
      if (/^\s*PRAGMA table_info\(/i.test(sql)) {
        const table = sql.match(/\((?:`)?([a-zA-Z_][a-zA-Z0-9_]*)(?:`)?\)/)?.[1];
        if (!table) throw new Error('Identificador de tabla inválido.');
        const [cols] = await conn.query(`SHOW COLUMNS FROM ${qid(table)}`);
        return cols.map((c) => ({ name: c.Field, type: c.Type, notnull: c.Null === 'NO' ? 1 : 0, pk: c.Key === 'PRI' ? 1 : 0 }));
      }
      if (/sqlite_master/.test(sql)) return tables.map((t) => ({ name: t.TABLE_NAME, sql: '' }));
      return (await conn.query(sql, params))[0];
    };
    const withTransaction = async (work) => { await conn.beginTransaction(); try { const result = await work({ query }); await conn.commit(); return result; } catch (e) { await conn.rollback(); throw e; } };
    const components = (payload.archivos?.componentes || []).map((c) => ({ id: c.id, root: path.join(ownedDirectory, c.id), ...(c.id === 'fiscal-control' ? { files: ['ecf-sequence-high-watermarks.json'] } : {}) }));
    const result = await require('../server/services/backup-restore-integral').restaurar(payload, query, { dialect: 'mysql', withTransaction, components });
    const [config] = await conn.query('SELECT * FROM config WHERE id = 1');
    if (config[0]?.business_name !== original.name) throw new Error('La recuperación no conserva la empresa.');
    const sourceConfig = payload.catalogo.tablas.config.find((c) => Number(c.id) === 1);
    for (const field of ['setup_completed_at', 'trial_started_at', 'trial_ends_at']) {
      if (sourceConfig[field] !== config[0][field]) throw new Error(`La fecha ${field} no se conservó exactamente.`);
    }
    report.datesPreserved = true;
    report.restored = true; report.tables = payload.catalogo.manifiesto.length; report.users = result.userCount; report.files = payload.archivos?.archivos?.length || 0;
    report.licenseUid = payload.licenseUid; report.name = original.name; report.completedAt = new Date().toISOString();
    save();
  } finally {
    if (created) {
      if (!/^tc_backup_verify_[a-f0-9]{12}$/.test(targetName) || targetName === env.DB_NAME) throw new Error('Se canceló la limpieza por identidad inválida.');
      await conn.query(`DROP DATABASE ${qid(targetName)}`); report.cleanedDatabase = true;
    }
    await conn.end(); save();
  }
}
main().catch((e) => { report.error = e.message; process.exitCode = 1; }).finally(() => {
  const resolved = path.resolve(ownedDirectory);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && /^tc-backup-restore-/.test(path.basename(resolved))) { fs.rmSync(resolved, { recursive: true, force: true }); report.cleanedFiles = true; }
  save(); console.log(JSON.stringify(report, null, 2));
});

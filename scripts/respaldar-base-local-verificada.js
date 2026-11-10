'use strict';
// Copia adicional sin migraciones, sin rotación y sin cambiar configuración o licencia.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const admin = require('firebase-admin');
const ROOT = path.resolve(__dirname, '..');
const env = dotenv.parse(fs.readFileSync(path.join(ROOT, '.env')));
const ae = dotenv.parse(fs.readFileSync(path.join(ROOT, 'tecno-caja-admin', '.env')));
for (const [k,v] of Object.entries(env)) if (v) process.env[k] = v;
const format = require('../server/services/backup-format');
const catalog = require('../server/services/backup-catalog');
const storage = require('../server/services/r2-storage');
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function main() {
  const report = { startedAt: new Date().toISOString(), database: env.DB_NAME, localVerified: false, cloudVerified: false, databaseModified: false };
  const evidence = path.join(ROOT, 'runtime-data', 'auditoria-respaldos', 'respaldo-local-nuevo.json');
  const save = () => { fs.mkdirSync(path.dirname(evidence), { recursive: true }); fs.writeFileSync(evidence, JSON.stringify(report, null, 2)); };
  const conn = await mysql.createConnection({ host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, connectTimeout: 5000, dateStrings: true });
  let app;
  try {
    await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('SET TRANSACTION READ ONLY');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const [engines] = await conn.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND ENGINE <> 'InnoDB'");
    if (engines.length) throw new Error('Existen tablas sin instantánea InnoDB. No se generó un paquete inconsistente.');
    const [cfg] = await conn.query('SELECT * FROM config WHERE id = 1');
    const c = cfg[0]; if (!c?.setup_completed) throw new Error('La base no corresponde a una empresa configurada.');
    const [licenses] = await conn.query('SELECT DISTINCT license_id FROM license_cache WHERE license_id IS NOT NULL');
    if (licenses.length !== 1) throw new Error('La autorización local no determina una empresa única.');
    const uid = String(licenses[0].license_id);
    app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(path.resolve(ROOT, 'tecno-caja-admin', ae.FIREBASE_SERVICE_ACCOUNT_PATH)))), projectId: ae.FIREBASE_PROJECT_ID }, 'validacion-copia-local');
    const doc = await app.firestore().collection(ae.FIREBASE_ADMIN_LICENSES_COLLECTION || 'licencias').doc(uid).get();
    if (!doc.exists) throw new Error('La empresa de la autorización local no existe en el inventario.');
    const license = doc.data();
    if (String(license.businessName || '').trim().toLowerCase() !== String(c.business_name).trim().toLowerCase()) throw new Error('La autorización y la base tienen nombres de empresa diferentes; requiere revisión de identidad.');
    const aRnc = String(license.rnc || license.businessRnc || '').replace(/\D/g, ''), bRnc = String(c.rnc || '').replace(/\D/g, '');
    if (aRnc && bRnc && aRnc !== bRnc) throw new Error('La autorización y la base tienen RNC diferentes.');
    report.licenseUid = uid; report.name = c.business_name;
    report.projectEnvIdentityMismatch = Boolean(env.TECNO_CAJA_LICENSE_UID && env.TECNO_CAJA_LICENSE_UID !== uid);
    const query = async (sql, params = []) => {
      if (!/^\s*(SELECT|SHOW)\b/i.test(sql)) throw new Error('La herramienta solo admite lecturas de la base.');
      if (/sqlite_master/.test(sql)) {
        const [tables] = await conn.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
        return tables.map((r) => ({ name: Object.values(r)[0], sql: '' }));
      }
      return (await conn.query(sql, params))[0];
    };
    process.env.TECNO_CAJA_USER_DATA = path.join(process.env.APPDATA, 'Tecno Caja');
    process.env.npm_package_version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version;
    const payload = await require('../server/services/backup-builder').buildFullPayload(query, { inSnapshot: true, licenseUid: uid });
    await conn.commit();
    if (payload.licenseUid !== uid || !payload.catalogo.tablas.users?.length) throw new Error('El paquete no conserva la identidad o los usuarios.');
    const password = env.TECNO_CAJA_SECURITY_PASSWORD;
    if (!password) throw new Error('No hay contraseña de respaldo configurada.');
    const bytes = await format.createTcbakBuffer(payload, password);
    await format.parseTcbakBuffer(bytes, password); catalog.validarCatalogo(payload);
    const fileName = `TecnoCaja_Verificado_${uid}_${new Date().toISOString().replace(/[:.]/g, '-')}.tcbak`;
    const dir = path.join(os.homedir(), 'Documents', 'TecnoCaja', 'Backups-Verificados', encodeURIComponent(uid)); fs.mkdirSync(dir, { recursive: true });
    const localPath = path.join(dir, fileName); fs.writeFileSync(localPath, bytes, { flag: 'wx' });
    if (hash(fs.readFileSync(localPath)) !== hash(bytes)) throw new Error('Falló la comprobación del archivo local.');
    Object.assign(report, { localVerified: true, localPath, capturedAt: payload.snapshot.capturedAt, tables: payload.catalogo.manifiesto.length, files: payload.archivos.archivos.length, sha256: hash(bytes) }); save();
    const key = storage.backupKey(uid, fileName); await storage.upload(key, bytes, { businessId: uid, sha256: report.sha256, diagnosticOrigin: 'respaldo-verificado' });
    const downloaded = await storage.download(key);
    if (hash(downloaded) !== report.sha256) throw new Error('El archivo recuperado de B2 difiere del local.');
    const parsed = await format.parseTcbakBuffer(downloaded, password);
    if (parsed.payload.backupId !== payload.backupId || parsed.payload.licenseUid !== uid) throw new Error('El archivo descargado no conserva identidad y versión.');
    Object.assign(report, { cloudVerified: true, storageKey: key, verifiedAt: new Date().toISOString() }); save();
    console.log(JSON.stringify({ ...report, evidence }, null, 2));
  } catch (e) { await conn.rollback().catch(() => {}); report.error = e.message; save(); throw e; }
  finally { await conn.end(); if (app) await app.delete(); }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });

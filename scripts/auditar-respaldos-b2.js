'use strict';
// No importa db.js ni server.js: inventariar archivos no debe iniciar o migrar una empresa.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dotenv = require('dotenv');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'runtime-data', 'auditoria-respaldos', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(OUTPUT, { recursive: true });
const readEnv = (file) => fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
const appEnv = readEnv(path.join(ROOT, '.env'));
const adminEnv = readEnv(path.join(ROOT, 'tecno-caja-admin', '.env'));
for (const [k, v] of Object.entries(appEnv)) if (v) process.env[k] = v;
const storage = require('../server/services/r2-storage');
const format = require('../server/services/backup-format');
const report = { startedAt: new Date().toISOString(), businesses: [], scopes: {}, localFiles: [], issues: [], cloudObjects: [] };
const save = () => fs.writeFileSync(path.join(OUTPUT, 'resultado.json'), JSON.stringify(report, null, 2));
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const date = (x) => x?.toDate?.()?.toISOString() || (x ? new Date(x).toISOString() : null);
const cleanError = (e) => String(e?.message || e).replace(/(key|token|password|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[oculto]').slice(0, 400);
async function testRoundTrip() {
  const runId = crypto.randomUUID();
  const uid = appEnv.TECNO_CAJA_LICENSE_UID;
  if (!uid) throw new Error('No se eligió un prefijo autorizado para la prueba.');
  const key = `${storage.backupPrefix(uid)}__verificacion_${runId}.probe`;
  const password = crypto.randomBytes(32).toString('hex');
  const catalog = require('../server/services/backup-catalog');
  const tables = { config: [{ id: 1, business_name: 'DIAGNOSTICO AISLADO', business_uuid: runId, setup_completed: 1 }],
    users: [{ id: 1, usuario: 'fixture', password: null, nombre: 'Prueba', rol: 'Administrador' }],
    movimientos_prueba: [{ id: 1, valor: runId }] };
  const payload = { formatVersion: '3', backupId: runId, companyUuid: runId, licenseUid: null, businessName: 'DIAGNOSTICO AISLADO', exportedAt: new Date().toISOString(),
    catalogo: { tablas: tables, manifiesto: Object.entries(tables).map(([nombre, rows]) => ({ nombre, registros: rows.length, sha256: catalog.hash(rows) })), requiereReconfiguracion: [] } };
  const original = await format.createTcbakBuffer(payload, password);
  const result = report.roundTrip = { key, syntheticDataOnly: true, uploaded: false, downloaded: false, restoredInMemory: false, cleaned: false };
  try {
    await storage.upload(key, original, { diagnostic: 'true' }); result.uploaded = true; save();
    const received = await storage.download(key);
    if (hash(original) !== hash(received)) throw new Error('El archivo descargado no coincide byte por byte.');
    const parsed = await format.parseTcbakBuffer(received, password); result.downloaded = true;
    const SQL = await require('sql.js')(); const db = new SQL.Database();
    db.exec('CREATE TABLE config (id INTEGER PRIMARY KEY, business_name TEXT, business_uuid TEXT, setup_completed INTEGER); CREATE TABLE users (id INTEGER PRIMARY KEY, usuario TEXT, password TEXT, nombre TEXT, rol TEXT); CREATE TABLE movimientos_prueba (id INTEGER PRIMARY KEY, valor TEXT)');
    const query = async (sql, params = []) => { const s = db.prepare(sql); try { s.bind(params); const rows = []; while (s.step()) rows.push(s.getAsObject()); return rows; } finally { s.free(); } };
    const withTransaction = async (work) => { db.exec('BEGIN'); try { const value = await work({ query }); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } };
    try {
      await require('../server/services/backup-restore-integral').restaurar(parsed.payload, query, { withTransaction, components: [] });
      if ((await query('SELECT valor FROM movimientos_prueba WHERE id = 1'))[0]?.valor !== runId) throw new Error('La recuperación aislada no conservó el movimiento.');
      result.restoredInMemory = true;
    } finally { db.close(); }
    result.sha256 = hash(received); result.verifiedAt = new Date().toISOString();
  } finally {
    if (result.uploaded) try { await storage.remove(key); result.cleaned = !(await storage.listObjects(key)).some((o) => o.Key === key); } catch (e) { result.cleanupError = cleanError(e); }
    save();
  }
}
async function verifyCloud() {
  const centralRoot = path.join(os.homedir(), 'Documents', 'TecnoCaja', 'Backups-Verificados');
  report.centralLocalDirectory = centralRoot;
  for (const item of report.cloudObjects.filter((o) => /\.tcbak$/i.test(o.key))) {
    try {
      const buffer = await storage.download(item.key);
      if (buffer.length !== item.size) throw new Error('El tamaño descargado no coincide con B2.');
      const parsed = await format.parseTcbakBuffer(buffer, appEnv.TECNO_CAJA_SECURITY_PASSWORD || 'Seguridad2026');
      const content = parsed.payload;
      const prefixId = item.key.split('/')[1];
      const dir = path.join(centralRoot, encodeURIComponent(prefixId).replace(/\./g, '%2E')); fs.mkdirSync(dir, { recursive: true });
      const basename = path.basename(item.key);
      if (/[<>:"|?*\x00-\x1f]/.test(basename)) throw new Error('Nombre de archivo no compatible con Windows.');
      const target = path.join(dir, basename);
      // Si existe una copia distinta, conservar ambas para revisión.
      const localPath = fs.existsSync(target) && hash(fs.readFileSync(target)) !== hash(buffer) ? target.replace(/\.tcbak$/, `_${hash(buffer).slice(0, 12)}.tcbak`) : target;
      const temp = localPath + '.tmp-' + process.pid;
      if (!fs.existsSync(localPath)) { fs.writeFileSync(temp, buffer, { flag: 'wx' }); fs.renameSync(temp, localPath); }
      if (hash(fs.readFileSync(localPath)) !== hash(buffer)) throw new Error('La copia local no coincide con B2.');
      Object.assign(item, { verified: true, localPath, sha256: hash(buffer), backupBusinessName: content.businessName, backupBusinessId: content.businessId,
        licenseUid: content.licenseUid || null, companyUuid: content.companyUuid || null, rnc: content.rnc || null,
        capturedAt: content.snapshot?.capturedAt || content.exportedAt, version: content.formatVersion || 'legacy', integral: String(content.formatVersion) === '3', verifiedAt: new Date().toISOString() });
      const tableData = content.catalogo?.tablas || content.data || {};
      item.users = tableData.users?.length || 0;
      item.hasCompany = Boolean(tableData.config?.length);
      item.recoverableCore = item.users > 0 && item.hasCompany;
      if (!item.recoverableCore) item.contentWarning = 'No contiene empresa y usuarios suficientes para una recuperación operativa.';
      const b = report.businesses.find((b) => b.id === prefixId);
      if (b) {
        if (content.licenseUid && content.licenseUid !== b.id) item.identityWarning = 'La identidad interna no coincide con el prefijo B2.';
        b.cloudVerified.push({ key: item.key, capturedAt: item.capturedAt, version: item.version, sha256: item.sha256, identityWarning: item.identityWarning || null });
        b.centralLocalVerified ||= []; b.centralLocalVerified.push({ path: localPath, capturedAt: item.capturedAt, sha256: item.sha256 });
      } else item.identityWarning = 'El prefijo no corresponde a una licencia actual; no se reasigna automáticamente.';
    } catch (e) { item.verified = false; item.error = cleanError(e); }
    save();
  }
}
async function inventory() {
  const admin = require('firebase-admin');
  const config = adminEnv.FIREBASE_SERVICE_ACCOUNT_PATH || adminEnv.FIREBASE_SERVICE_ACCOUNT_JSON ? adminEnv : appEnv;
  const configRoot = config === adminEnv ? path.join(ROOT, 'tecno-caja-admin') : ROOT;
  let credential;
  if (config.FIREBASE_SERVICE_ACCOUNT_JSON) credential = JSON.parse(config.FIREBASE_SERVICE_ACCOUNT_JSON);
  else if (config.FIREBASE_SERVICE_ACCOUNT_PATH) credential = JSON.parse(fs.readFileSync(path.resolve(configRoot, config.FIREBASE_SERVICE_ACCOUNT_PATH)));
  if (credential) {
    const instance = admin.initializeApp({ credential: admin.credential.cert(credential), projectId: config.FIREBASE_PROJECT_ID }, 'auditoria-backups');
    try {
      const snapshot = await instance.firestore().collection(config.FIREBASE_ADMIN_LICENSES_COLLECTION || 'licencias').get();
      report.businesses = snapshot.docs.map((doc) => {
        const d = doc.data();
        return { id: doc.id, name: d.businessName || d.nombreNegocio || d.nombre || doc.id, status: d.status || null, rnc: d.rnc || d.businessRnc || d.rncCedula || null,
          parentId: d.sucursalDe || null, businessKey: d.businessKey || null,
          devices: Object.values(d.devices || {}).map((v) => ({ hostname: v.hostname || null, lastSeenAt: date(v.lastSeenAt), active: v.active !== false })),
          localClientBackup: 'no_verificable_desde_esta_pc', localVerified: [], cloudVerified: [] };
      });
      report.scopes.firebase = { ok: true, licenses: report.businesses.length };
    } catch (e) { report.scopes.firebase = { ok: false, error: cleanError(e) }; }
    finally { await instance.delete(); }
  } else report.scopes.firebase = { ok: false, error: 'No hay credencial de inventario disponible.' };
  save();
  try {
    report.cloudObjects = (await storage.listObjects('backups/')).map((o) => ({ key: o.Key, size: Number(o.Size), modifiedAt: date(o.LastModified) }));
    report.scopes.b2 = { ok: true, scope: 'backups/', objects: report.cloudObjects.length };
  } catch (e) {
    report.scopes.b2 = { ok: false, error: cleanError(e), scope: 'backups/' };
    // Una llave de cliente puede listar únicamente su prefijo.
    if (appEnv.TECNO_CAJA_LICENSE_UID) try {
      const prefix = storage.backupPrefix(appEnv.TECNO_CAJA_LICENSE_UID);
      report.cloudObjects = (await storage.listObjects(prefix)).map((o) => ({ key: o.Key, size: Number(o.Size), modifiedAt: date(o.LastModified) }));
      report.scopes.b2Restricted = { ok: true, scope: prefix, objects: report.cloudObjects.length };
    } catch (err) { report.scopes.b2Restricted = { ok: false, error: cleanError(err) }; }
  }
  const localDirs = [path.join(os.homedir(), 'Documents', 'TecnoCaja', 'Backups'), path.join(os.homedir(), 'Documents', 'TecnoCaja', 'Backups-Verificados'),
    ...['Tecno Caja', 'TecnoCaja'].flatMap((name) => ['backups', 'secure-backups'].map((dir) => path.join(process.env.APPDATA || '', name, dir))),
    path.join(ROOT, 'runtime-data', 'secure-backups')];
  const seen = new Set();
  async function scan(dir, depth = 0) {
    if (seen.has(path.resolve(dir).toLowerCase()) || !fs.existsSync(dir) || depth > 3) return;
    seen.add(path.resolve(dir).toLowerCase());
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await scan(file, depth + 1); continue; }
      if (!/\.(tcbak|novaseguro)$/i.test(entry.name)) continue;
      const stat = await fs.promises.stat(file);
      const item = { path: file, size: stat.size, modifiedAt: stat.mtime.toISOString() };
      try {
        const buffer = await fs.promises.readFile(file), parsed = await format.parseTcbakBuffer(buffer, appEnv.TECNO_CAJA_SECURITY_PASSWORD || 'Seguridad2026');
        Object.assign(item, { verified: true, sha256: hash(buffer), name: parsed.payload.businessName,
          licenseUid: parsed.payload.licenseUid || null, companyUuid: parsed.payload.companyUuid || null, rnc: parsed.payload.rnc || null,
          capturedAt: parsed.payload.snapshot?.capturedAt || parsed.payload.exportedAt, version: parsed.payload.formatVersion,
          tables: parsed.payload.catalogo?.manifiesto?.length || Object.keys(parsed.payload.data || {}).length });
      } catch (e) { item.verified = false; item.error = cleanError(e); }
      report.localFiles.push(item);
    }
  }
  for (const dir of localDirs) await scan(dir);
  for (const business of report.businesses) {
    business.cloudObjects = report.cloudObjects.filter((o) => o.key.startsWith(storage.backupPrefix(business.id)) && /\.tcbak$/i.test(o.key)).sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
    business.localVerified = report.localFiles.filter((f) => f.verified && f.licenseUid === business.id).map((f) => ({ path: f.path, capturedAt: f.capturedAt, sha256: f.sha256 }));
    business.nameOnlyLocalCandidates = report.localFiles.filter((f) => f.verified && !f.licenseUid && f.name === business.name).map((f) => ({ path: f.path, capturedAt: f.capturedAt }));
  }
  if (process.argv.includes('--probar-escritura')) await testRoundTrip();
  if (process.argv.includes('--verificar-b2')) await verifyCloud();
  for (const business of report.businesses) {
    const rnc = String(business.rnc || '').replace(/\D/g, '');
    business.historicalCandidates = report.cloudObjects.filter((o) => o.verified && !o.key.startsWith(storage.backupPrefix(business.id)) &&
      ((rnc.length >= 9 && rnc === String(o.rnc || '').replace(/\D/g, '')) || String(o.backupBusinessName || '').trim().toLowerCase() === business.name.trim().toLowerCase()))
      .map((o) => ({ key: o.key, name: o.backupBusinessName, capturedAt: o.capturedAt, needsIdentityReview: true }));
  }
  report.completedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ output: OUTPUT, scopes: report.scopes, roundTrip: report.roundTrip,
    cloudVerified: report.cloudObjects.filter((o) => o.verified).length, cloudFailed: report.cloudObjects.filter((o) => o.verified === false).map((o) => ({ key: o.key, error: o.error })),
    businessesWithCloud: report.businesses.filter((b) => b.cloudVerified.length).length,
    registeredWithoutCloud: report.businesses.filter((b) => !b.cloudObjects.length).map((b) => ({ id: b.id, name: b.name, parent: Boolean(b.parentId) })) }, null, 2));
}
inventory().catch((e) => { report.issues.push(cleanError(e)); save(); console.error(cleanError(e)); process.exitCode = 1; });

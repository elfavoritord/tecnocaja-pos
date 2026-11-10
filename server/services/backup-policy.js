'use strict';
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
async function context(query, env = process.env) {
  const config = (await query('SELECT * FROM config WHERE id = 1'))[0] || {};
  let licenses = [];
  try { licenses = await query('SELECT DISTINCT license_id FROM license_cache WHERE license_id IS NOT NULL'); }
  catch (e) { if (!/no such table|doesn't exist|does not exist/i.test(e.message || '')) throw e; }
  const ids = [...new Set(licenses.map((r) => String(r.license_id || '').trim()).filter(Boolean))];
  const requested = String(env.TECNO_CAJA_LICENSE_UID || '').trim();
  const conflict = ids.length > 1 || Boolean(ids.length === 1 && requested && requested !== ids[0]);
  const licenseUid = ids.length === 1 ? ids[0] : requested || null;
  const companyUuid = String(config.business_uuid || '').trim() || null;
  const cloudId = licenseUid || companyUuid;
  const localId = companyUuid || licenseUid || `${config.business_id || ''}:${config.business_name || ''}:${config.rnc || ''}`;
  return { config, licenseUid, companyUuid, cloudId, conflict, localScope: sha(localId).slice(0, 20) };
}
function assertCloudIdentity(c) {
  if (c.conflict) throw Object.assign(new Error('La identidad configurada y la licencia guardada no coinciden. Revisa la empresa antes de subir respaldos.'), { code: 'BACKUP_IDENTITY_CONFLICT' });
  if (!c.cloudId) throw new Error('Falta una identidad estable de empresa para usar B2.');
  return c.cloudId;
}
async function baseDirectory(query) {
  let custom;
  try { custom = (await query('SELECT config_value FROM installation_config WHERE config_key = ? LIMIT 1', ['backup_dir_personalizado']))[0]?.config_value; }
  catch (e) { if (!/no such table|doesn't exist|does not exist/i.test(e.message || '')) throw e; }
  return custom || path.join(os.homedir(), 'Documents', 'TecnoCaja', 'Backups');
}
async function directory(query) {
  const c = await context(query);
  return path.join(await baseDirectory(query), 'Empresas', c.localScope);
}
function assertPayload(payload, c) {
  const sourceConfig = (payload.catalogo?.tablas?.config || payload.data?.config || []).find((r) => Number(r.id) === 1) || {};
  const pairs = [[payload.licenseUid, c.licenseUid], [payload.companyUuid || sourceConfig.business_uuid, c.companyUuid]].filter(([a,b]) => a && b);
  const sourceRnc = String(payload.rnc || sourceConfig.rnc || '').replace(/\D/g, ''), targetRnc = String(c.config.rnc || '').replace(/\D/g, '');
  if (!pairs.length || pairs.some(([a,b]) => String(a) !== String(b)) || (sourceRnc && targetRnc && sourceRnc !== targetRnc)) {
    throw Object.assign(new Error('No se comprobó que el archivo pertenece a esta empresa. Requiere revisión de identidad.'), { code: 'BACKUP_IDENTITY_UNVERIFIED' });
  }
}
function remember(file, metadataPath, payload) {
  if (!metadataPath) return;
  const record = { directory: path.dirname(file), licenseUid: payload.licenseUid || null, companyUuid: payload.companyUuid || null, rnc: payload.rnc || null, needsReview: Boolean(payload.identityNeedsReview) };
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  const temp = metadataPath + '.tmp-' + crypto.randomUUID();
  fs.writeFileSync(temp, JSON.stringify(record), { flag: 'wx' });
  fs.renameSync(temp, metadataPath);
}
module.exports = { context, assertCloudIdentity, baseDirectory, directory, assertPayload, remember };

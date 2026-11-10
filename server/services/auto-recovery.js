'use strict';

/**
 * auto-recovery.js — Restauración automática al detectar que la base de datos
 * local se corrompió (típicamente por un corte de luz) y tuvo que recrearse
 * en blanco.
 *
 * Se invoca una sola vez desde prepareServerRuntime() en server.js, solo
 * cuando el arranque detectó que el archivo de BD existente no tenía un
 * esquema válido (ver `dbWasCorruptAndRebuilt` en server.js). Nunca corre en
 * una instalación nueva legítima (archivo de BD inexistente desde el inicio).
 *
 * Estrategia: probar el .tcbak local más reciente primero (no depende de
 * internet); si no hay ninguno utilizable, probar el más reciente en la nube
 * (Backblaze B2 / Cloudflare R2) usando TECNO_CAJA_LICENSE_UID como businessId.
 * Se detiene en el primer respaldo que logra desencriptarse/verificarse — no
 * garantiza el más reciente en términos absolutos, solo el más reciente
 * disponible y verificable.
 */

const fs   = require('fs');
const path = require('path');
const backupCore = require('./backup-core');
const r2 = require('./r2-storage');
const policy = require('./backup-policy');

async function tryRestoreFromBuffer(fileBuffer, password, query, source, fileName, recoveryIdentity) {
  const { payload } = await backupCore.parseTcbakBuffer(fileBuffer, password);
  policy.assertPayload(payload, recoveryIdentity);
  await backupCore.restorePayloadToDb(payload, query);
  return { restored: true, source, fileName, stats: payload.stats };
}

async function attemptAutoRestoreFromBackup({ query }) {
  const password = process.env.TECNO_CAJA_SECURITY_PASSWORD || 'Seguridad2026';
  let hint = {};
  try { hint = JSON.parse(fs.readFileSync(path.join(process.env.TECNO_CAJA_USER_DATA || '', 'config', 'backup-location.json'), 'utf8')); } catch (_) {}
  const uid = String(process.env.TECNO_CAJA_LICENSE_UID || '').trim();
  if (hint.needsReview || (uid && hint.licenseUid && uid !== hint.licenseUid)) return { restored: false, reason: 'La identidad de recuperación requiere revisión.' };
  const recoveryIdentity = { licenseUid: uid || hint.licenseUid, companyUuid: hint.companyUuid, config: { rnc: hint.rnc } };
  if (!recoveryIdentity.licenseUid && !recoveryIdentity.companyUuid) return { restored: false, reason: 'Falta identificar la empresa original. Usa la recuperación guiada.' };

  // 1. Respaldos locales, más reciente primero — no dependen de internet.
  const backupDir = backupCore.getDefaultBackupDir();
  const dirs = [...new Set([hint.directory, backupDir].filter(Boolean))];
  const localBackups = dirs.flatMap((dir) => backupCore.listLocalBackups(dir)).filter(f => f.name.endsWith('.tcbak')).sort((a,b) => new Date(b.mtime) - new Date(a.mtime));
  for (const file of localBackups) {
    try {
      const buffer = fs.readFileSync(file.path);
      return await tryRestoreFromBuffer(buffer, password, query, 'local', file.name, recoveryIdentity);
    } catch (e) {
      console.warn(`[auto-recovery] Respaldo local "${file.name}" no se pudo usar: ${e.message}`);
    }
  }

  // 2. Sin nada usable localmente: probar el más reciente en la nube.
  try {
    const businessId = recoveryIdentity.licenseUid || recoveryIdentity.companyUuid || '';
    if (businessId) {
      const prefix = r2.backupPrefix(businessId);
      await r2.isR2Available(false, prefix);
      const objects = (await r2.listObjects(prefix))
        .filter(o => (o.Key || '').endsWith('.tcbak'))
        .sort((a, b) => new Date(b.LastModified || 0) - new Date(a.LastModified || 0));

      for (const obj of objects) {
        try {
          const buffer = await r2.download(obj.Key);
          return await tryRestoreFromBuffer(buffer, password, query, 'nube', path.basename(obj.Key), recoveryIdentity);
        } catch (e) {
          console.warn(`[auto-recovery] Respaldo en nube "${obj.Key}" no se pudo usar: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.warn('[auto-recovery] No se pudo consultar la nube para recuperación automática:', e.message);
  }

  return { restored: false };
}

module.exports = { attemptAutoRestoreFromBackup };

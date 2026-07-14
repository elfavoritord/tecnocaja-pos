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

async function tryRestoreFromBuffer(fileBuffer, password, query, source, fileName) {
  const { payload } = await backupCore.parseTcbakBuffer(fileBuffer, password);
  await backupCore.restorePayloadToDb(payload, query);
  return { restored: true, source, fileName, stats: payload.stats };
}

async function attemptAutoRestoreFromBackup({ query }) {
  const password = process.env.TECNO_CAJA_SECURITY_PASSWORD || 'Seguridad2026';

  // 1. Respaldos locales, más reciente primero — no dependen de internet.
  const backupDir = backupCore.getDefaultBackupDir();
  const localBackups = backupCore.listLocalBackups(backupDir).filter(f => f.name.endsWith('.tcbak'));
  for (const file of localBackups) {
    try {
      const buffer = fs.readFileSync(file.path);
      return await tryRestoreFromBuffer(buffer, password, query, 'local', file.name);
    } catch (e) {
      console.warn(`[auto-recovery] Respaldo local "${file.name}" no se pudo usar: ${e.message}`);
    }
  }

  // 2. Sin nada usable localmente: probar el más reciente en la nube.
  try {
    const businessId = (process.env.TECNO_CAJA_LICENSE_UID || '').trim();
    if (businessId) {
      await r2.isR2Available();
      const prefix = r2.backupPrefix(businessId);
      const objects = (await r2.listObjects(prefix))
        .filter(o => (o.Key || '').endsWith('.tcbak'))
        .sort((a, b) => new Date(b.LastModified || 0) - new Date(a.LastModified || 0));

      for (const obj of objects) {
        try {
          const buffer = await r2.download(obj.Key);
          return await tryRestoreFromBuffer(buffer, password, query, 'nube', path.basename(obj.Key));
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

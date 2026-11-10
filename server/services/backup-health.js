'use strict';
const fs = require('fs');
const { parseTcbakBuffer } = require('./backup-format');
const policy = require('./backup-policy');
async function inspect({ query, files, cloudConfigured, cloudAvailable, verifyCloud, now = Date.now() }) {
  const identity = await policy.context(query);
  const errors = []; let local = null;
  for (const file of files.slice(0, 5)) {
    try {
      const { payload } = await parseTcbakBuffer(fs.readFileSync(file.path), process.env.TECNO_CAJA_SECURITY_PASSWORD || 'Seguridad2026');
      policy.assertPayload(payload, identity);
      const data = payload.catalogo?.tablas || payload.data || {};
      if (!data.users?.length || !data.config?.length) throw new Error('La copia no contiene empresa y usuarios recuperables.');
      const captured = payload.snapshot?.capturedAt || payload.exportedAt;
      if (!Number.isFinite(new Date(captured).getTime()) || new Date(captured).getTime() > now + 300000) throw new Error('La copia no tiene una fecha de corte válida.');
      local = { fileName: file.name, capturedAt: payload.snapshot?.capturedAt || payload.exportedAt, verifiedAt: new Date(now).toISOString(), formatVersion: String(payload.formatVersion), integral: String(payload.formatVersion) === '3' };
      break;
    } catch (e) { errors.push({ fileName: file.name, error: e.message }); }
  }
  const rows = await query("SELECT file_name, created_at, storage_path, sha256, file_size, observacion FROM backup_history WHERE estado = 'completado' AND storage_path IS NOT NULL AND storage_path <> '' ORDER BY created_at DESC LIMIT 30");
  const cloud = identity.cloudId && rows.find((r) => String(r.storage_path).startsWith(`backups/${identity.cloudId}/`));
  let cloudVerified = false;
  if (cloud && cloudConfigured && cloudAvailable && !identity.conflict && verifyCloud) {
    try { await verifyCloud(cloud.storage_path, { sha256: cloud.sha256, size: cloud.file_size }); cloudVerified = true; }
    catch (_) { /* la comprobación fallida no convierte un historial anterior en éxito actual */ }
  }
  const pending = (await query("SELECT COUNT(*) AS total FROM backup_history WHERE estado IN ('pendiente_nube', 'pendiente_configuracion')"))[0]?.total || 0;
  let cloudCutoff = null;
  try { cloudCutoff = JSON.parse(cloud?.observacion || '').capturedAt || null; } catch (_) {}
  const ageHours = local?.capturedAt ? Math.max(0, (now - new Date(local.capturedAt).getTime()) / 3600000) : null;
  const messages = [];
  if (!local) messages.push('Falta una copia local íntegra de esta empresa.');
  if (errors.length) messages.push('Hay archivos que necesitan revisión; se conservan en disco.');
  if (ageHours > 48) messages.push('La última copia local tiene más de 48 horas.');
  if (local && !local.integral) messages.push('La copia es de un formato anterior; crea un respaldo nuevo.');
  if (identity.conflict) messages.push('La identidad configurada y la licencia local no coinciden; las subidas quedan bloqueadas.');
  if (!cloudConfigured) messages.push('B2 necesita una llave propia de este negocio. La actualización no incluye ni comparte llaves de otros clientes.');
  else if (!cloudAvailable) messages.push('B2 no está disponible ahora; la copia local permanece y los envíos pendientes se reintentan.');
  if (!cloud) messages.push('Todavía no consta una copia confirmada en la nube en este equipo.');
  else if (!cloudVerified) messages.push('No se pudo comprobar ahora el tamaño y la huella de la copia en B2.');
  if (cloud && (!cloudCutoff || !Number.isFinite(new Date(cloudCutoff).getTime()))) messages.push('La copia anterior en B2 no registra su corte verificable. Crea un respaldo nuevo.');
  if (cloudCutoff && (now - new Date(cloudCutoff).getTime()) > 48 * 3600000) messages.push('Los datos respaldados en B2 tienen más de 48 horas.');
  if (pending) messages.push(`${pending} envío(s) pendientes de confirmar en B2.`);
  return { status: messages.length ? 'atencion' : 'verificado', local, ageHours, cloud: cloud ? { fileName: cloud.file_name, confirmedAt: cloud.created_at, capturedAt: cloudCutoff } : null,
    cloudConfigured, cloudVerified, pending: Number(pending), identityNeedsReview: identity.conflict, errors, messages };
}
module.exports = { inspect };

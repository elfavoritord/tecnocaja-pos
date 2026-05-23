// ═════════════════════════════════���═══════════════════════════��════════════════
//  fiscalModeService.js  —  Tecno Caja e-CF / DGII
//  Activación / desactivación del modo de facturación electrónica por empresa.
//  Valida todos los pre-requisitos antes de permitir la activación.
// ═════════════════════════════��══════════════════════════��═════════════════════

'use strict';

const { writeFiscalAuditLog, upsertOne } = require('./fiscalExtensions');

/**
 * Obtiene el estado fiscal actual de una empresa.
 */
async function getFiscalMode(queryFn, businessId) {
  const configRows = await queryFn(
    'SELECT * FROM fiscal_config WHERE business_id = ? LIMIT 1',
    [businessId]
  );
  const certRows = await queryFn(
    `SELECT id, subject, valid_from, valid_to, status FROM fiscal_certificate
     WHERE business_id = ? LIMIT 1`,
    [businessId]
  );
  const today   = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const seqRows = await queryFn(
    `SELECT COUNT(*) AS total FROM fiscal_sequences
     WHERE business_id = ? AND activo = 1
       AND proximo <= hasta
       AND (fecha_vencimiento IS NULL OR fecha_vencimiento >= ?)`,
    [businessId, today]
  );
  const businessRows = await queryFn(
    'SELECT rnc, razon_social, nombre FROM businesses WHERE id = ? LIMIT 1',
    [businessId]
  );

  const config  = configRows[0] || {};
  const cert    = certRows[0]   || null;
  const seqCount = Number(seqRows[0]?.total || 0);
  const business = businessRows[0] || {};

  const now     = new Date();
  const certExpired = cert && cert.valid_to && new Date(cert.valid_to) < now;

  return {
    isActive:         !!config.is_active,
    status:           config.status || 'no_configurado',
    environment:      config.environment || 'test',
    lastConnStatus:   config.last_conn_status || null,
    lastConnMsg:      config.last_conn_msg || null,
    tokenExpiresAt:   config.token_expires_at || null,
    activatedAt:      config.activated_at || null,
    deactivatedAt:    config.deactivated_at || null,
    hasCertificate:   !!cert,
    certificateStatus: cert ? (certExpired ? 'vencido' : (cert.status || 'valido')) : null,
    certValidTo:      cert?.valid_to || null,
    hasRnc:           !!(business.rnc),
    activeSequences:  seqCount,
    hasActiveSequences: seqCount > 0,
    businessRnc:      business.rnc || null,
    businessName:     business.razon_social || business.nombre || null
  };
}

/**
 * Valida si la empresa puede activar la facturación electrónica.
 * @returns {{ canActivate, reasons }}
 */
async function validateCanActivate(queryFn, businessId) {
  const state   = await getFiscalMode(queryFn, businessId);
  const reasons = [];

  if (!state.hasRnc) {
    reasons.push('El negocio no tiene RNC configurado.');
  }
  if (!state.hasCertificate) {
    reasons.push('No hay certificado digital (.p12) cargado.');
  } else if (state.certificateStatus === 'vencido') {
    reasons.push('El certificado digital está vencido. Carga un certificado vigente.');
  }
  if (!state.hasActiveSequences) {
    reasons.push('No hay secuencias e-NCF activas y disponibles. Crea al menos una.');
  }
  if (!state.environment) {
    reasons.push('No se ha seleccionado el ambiente DGII (Test / Certificación / Producción).');
  }
  if (state.environment === 'produccion' && !state.lastConnStatus) {
    reasons.push('Para usar Producción debes probar la conexión con DGII primero.');
  }

  return { canActivate: reasons.length === 0, reasons };
}

/**
 * Activa la facturación electrónica para una empresa.
 */
async function activateFiscalMode(queryFn, businessId, { userId, ipAddress } = {}) {
  const { canActivate, reasons } = await validateCanActivate(queryFn, businessId);
  if (!canActivate) {
    const err = new Error('No se puede activar la facturación electrónica: ' + reasons.join(' | '));
    err.statusCode = 422;
    err.reasons = reasons;
    throw err;
  }

  const now = new Date();
  await upsertOne(queryFn, 'fiscal_config', 'business_id', {
    business_id:  businessId,
    is_active:    1,
    status:       'listo',
    activated_at: now
  });

  await writeFiscalAuditLog(queryFn, {
    businessId, userId,
    action: 'facturacion_electronica_activada',
    description: 'Facturación electrónica e-CF activada.',
    ipAddress
  });

  return { ok: true, isActive: true };
}

/**
 * Desactiva la facturación electrónica.
 * NO borra datos: certificado, secuencias, ni documentos emitidos se conservan.
 */
async function deactivateFiscalMode(queryFn, businessId, { userId, ipAddress } = {}) {
  await queryFn(`
    UPDATE fiscal_config
    SET is_active      = 0,
        status         = 'inactivo',
        token_encrypted  = NULL,
        token_expires_at = NULL,
        deactivated_at  = CURRENT_TIMESTAMP,
        updated_at      = CURRENT_TIMESTAMP
    WHERE business_id = ?
  `, [businessId]);

  await writeFiscalAuditLog(queryFn, {
    businessId, userId,
    action: 'facturacion_electronica_desactivada',
    description: 'Facturación electrónica e-CF desactivada. Historial preservado.',
    ipAddress
  });

  return { ok: true, isActive: false };
}

/**
 * Cambia el ambiente DGII.
 */
async function setEnvironment(queryFn, businessId, environment, { userId, ipAddress } = {}) {
  const validEnvs = ['test', 'certificacion', 'produccion'];
  if (!validEnvs.includes(environment)) {
    throw Object.assign(new Error(`Ambiente inválido: ${environment}`), { statusCode: 400 });
  }

  // No permitir produccion sin validación previa
  if (environment === 'produccion') {
    const state = await getFiscalMode(queryFn, businessId);
    if (!state.hasCertificate || !state.hasActiveSequences || !state.hasRnc) {
      throw Object.assign(
        new Error('Para activar Producción necesitas: certificado válido, RNC y secuencias activas.'),
        { statusCode: 422 }
      );
    }
  }

  const oldRows = await queryFn('SELECT environment FROM fiscal_config WHERE business_id = ? LIMIT 1', [businessId]);
  const oldEnv  = oldRows[0]?.environment || 'no_configurado';

  await upsertOne(queryFn, 'fiscal_config', 'business_id', {
    business_id:      businessId,
    environment,
    token_encrypted:  null,
    token_expires_at: null,
    last_conn_status: null
  });

  await writeFiscalAuditLog(queryFn, {
    businessId, userId,
    action: 'ambiente_dgii_cambiado',
    description: `Ambiente cambiado de "${oldEnv}" a "${environment}".`,
    oldValue: oldEnv,
    newValue: environment,
    ipAddress
  });

  return { ok: true, environment };
}

/**
 * Verifica si se puede emitir un e-CF ahora mismo.
 */
async function validateCanIssueEcf(queryFn, businessId) {
  const state = await getFiscalMode(queryFn, businessId);
  if (!state.isActive) {
    return { canIssue: false, reason: 'Facturación electrónica inactiva.' };
  }
  if (!state.hasCertificate || state.certificateStatus === 'vencido') {
    return { canIssue: false, reason: 'Certificado digital inválido o vencido.' };
  }
  if (!state.hasActiveSequences) {
    return { canIssue: false, reason: 'Sin secuencias e-NCF disponibles.' };
  }
  return { canIssue: true };
}

module.exports = {
  getFiscalMode,
  validateCanActivate,
  activateFiscalMode,
  deactivateFiscalMode,
  setEnvironment,
  validateCanIssueEcf
};

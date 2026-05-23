'use strict';

const REPORTS_BOOTSTRAP_CONFIG_KEY = 'firebase_reports_bootstrap_completed_at';

async function getInstallationConfigValue(query, configKey) {
  const rows = await query(
    `SELECT config_value
     FROM installation_config
     WHERE config_key = ?
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
    [configKey]
  ).catch(() => []);
  return rows[0]?.config_value || null;
}

async function setInstallationConfigValue(query, configKey, configValue) {
  await query('DELETE FROM installation_config WHERE config_key = ?', [configKey]).catch(() => {});
  await query(
    `INSERT INTO installation_config (config_key, config_value, updated_at)
     VALUES (?, ?, datetime('now'))`,
    [configKey, String(configValue == null ? '' : configValue)]
  );
  return String(configValue == null ? '' : configValue);
}

async function ensureInitialReportsBootstrap(options = {}) {
  const {
    query,
    getConfig,
    isEnabled,
    bootstrapAll,
    logger = console,
  } = options;

  if (typeof query !== 'function') {
    throw new Error('query es requerido');
  }
  if (typeof getConfig !== 'function') {
    throw new Error('getConfig es requerido');
  }
  if (typeof isEnabled !== 'function') {
    throw new Error('isEnabled es requerido');
  }
  if (typeof bootstrapAll !== 'function') {
    throw new Error('bootstrapAll es requerido');
  }

  if (!isEnabled()) {
    return { ok: false, skipped: true, reason: 'firebase_not_configured' };
  }

  const completedAt = await getInstallationConfigValue(query, REPORTS_BOOTSTRAP_CONFIG_KEY);
  if (completedAt) {
    return {
      ok: true,
      skipped: true,
      reason: 'already_bootstrapped',
      completedAt,
    };
  }

  const config = await getConfig();
  const report = await bootstrapAll({ query }, config);
  if (!report || report.ok === false) {
    return {
      ok: false,
      skipped: false,
      reason: report?.reason || 'bootstrap_failed',
      report: report || null,
    };
  }

  const nextCompletedAt = new Date().toISOString();
  await setInstallationConfigValue(query, REPORTS_BOOTSTRAP_CONFIG_KEY, nextCompletedAt);
  logger.log(
    `[firebase-reports] Bootstrap inicial completado: business=${report.businessId || 'n/a'} sales=${report.sales || 0} products=${report.products || 0} customers=${report.customers || 0}`
  );

  return {
    ok: true,
    skipped: false,
    completedAt: nextCompletedAt,
    report,
  };
}

module.exports = {
  REPORTS_BOOTSTRAP_CONFIG_KEY,
  ensureInitialReportsBootstrap,
  getInstallationConfigValue,
  setInstallationConfigValue,
};

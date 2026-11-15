'use strict';

const { computeTrialWindow, parseUtcDbDateTime, toUtcDbDateTime } = require('./trial-window');

// Recuperar fechas antiguas no revoca la autorización, ligada a este equipo.
// LicenseService sigue comprobando la firma, el vencimiento y la caché.
async function repairTrialDates({ query, now = new Date() }) {
  const [config] = await query('SELECT setup_completed_at, trial_started_at, trial_ends_at, license_status FROM config WHERE id = 1 LIMIT 1');
  if (!config || String(config.license_status || '').toLowerCase() !== 'trial') return { repaired: false };
  const anchor = config.setup_completed_at instanceof Date
    ? config.setup_completed_at
    : parseUtcDbDateTime(config.setup_completed_at || config.trial_started_at);
  if (!anchor || Number.isNaN(anchor.getTime())) return { repaired: false };
  const expected = computeTrialWindow({ startedAt: anchor, now });
  const started = parseUtcDbDateTime(config.trial_started_at);
  const ends = parseUtcDbDateTime(config.trial_ends_at);
  const drift = Math.max(started ? Math.abs(started.getTime() - expected.startedAt.getTime()) : Infinity,
    ends ? Math.abs(ends.getTime() - expected.endsAt.getTime()) : Infinity);
  if (drift <= 60 * 60 * 1000) return { repaired: false };
  await query('UPDATE config SET trial_started_at = ?, trial_ends_at = ? WHERE id = 1',
    [toUtcDbDateTime(expected.startedAt), toUtcDbDateTime(expected.endsAt)]);
  return { repaired: true, daysLeft: expected.daysLeft };
}

module.exports = { repairTrialDates };

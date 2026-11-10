'use strict';
async function ensure(query) {
  await query(`CREATE TABLE IF NOT EXISTS backup_upload_retry (
    backup_id INT PRIMARY KEY, attempts INT NOT NULL DEFAULT 0,
    next_attempt_at VARCHAR(32), last_error TEXT)`);
}
async function fail(query, id, error, now = Date.now()) {
  const old = (await query('SELECT attempts FROM backup_upload_retry WHERE backup_id = ?', [id]))[0];
  const attempts = Number(old?.attempts || 0) + 1;
  const next = new Date(now + Math.min(6 * 60 * 60 * 1000, 60000 * 2 ** Math.min(attempts - 1, 9))).toISOString();
  const message = String(error.message || error).slice(0, 600);
  if (old) await query('UPDATE backup_upload_retry SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE backup_id = ?', [attempts, next, message, id]);
  else await query('INSERT INTO backup_upload_retry (backup_id, attempts, next_attempt_at, last_error) VALUES (?, ?, ?, ?)', [id, attempts, next, message]);
  return { attempts, nextAttemptAt: next };
}
module.exports = { ensure, fail };

/**
 * currency.routes.js
 *
 * Endpoints REST del módulo "Configuración de Monedas" (Fase 1 de la extensión
 * multi-moneda USD/DOP). Usa factory pattern con dependencias inyectadas, igual
 * que offline.routes.js, para evitar imports circulares con server.js.
 *
 * Rutas registradas bajo /api/currency:
 *   GET /exchange-rate          - Tasa vigente + metadata del último cambio
 *   GET /exchange-rate/history  - Historial de cambios (más reciente primero)
 *   PUT /exchange-rate          - Cambiar la tasa (solo administrador_general), con auditoría
 */

const express = require('express');

/**
 * @param {object} deps - Dependencias inyectadas desde server.js
 * @param {Function} deps.query - query() de db.js
 * @param {Function} deps.resolveRequestActorUser - resolveRequestActorUser() de server.js
 * @param {Function} deps.ensureAdministrator - ensureAdministrator() de server.js (lanza 403)
 * @param {Function} deps.getActor - getActor() de server.js
 * @param {Function} deps.writeAuditLog - writeAuditLog() de server.js
 * @param {Function} deps.ensureCurrencyExtensions - ensureCurrencyExtensions() de server.js
 * @param {Function} deps.ensureExchangeRateHistoryTable - ensureExchangeRateHistoryTable() de server.js
 * @param {Function} deps.recordExchangeRate - recordExchangeRate() de server.js
 */
module.exports = function createCurrencyRouter(deps) {
  const {
    query,
    resolveRequestActorUser,
    ensureAdministrator,
    getActor,
    writeAuditLog,
    ensureCurrencyExtensions,
    ensureExchangeRateHistoryTable,
    recordExchangeRate,
  } = deps;

  const router = express.Router();

  router.get('/exchange-rate', async (req, res) => {
    await ensureCurrencyExtensions();
    const rows = await query(
      `SELECT exchange_rate_usd_dop, exchange_rate_updated_at,
              exchange_rate_updated_by_user_id, exchange_rate_updated_by_user_name
       FROM config WHERE id = 1 LIMIT 1`
    );
    const row = rows[0] || {};
    res.json({
      rate: row.exchange_rate_usd_dop !== null && row.exchange_rate_usd_dop !== undefined
        ? Number(row.exchange_rate_usd_dop) : null,
      updatedAt: row.exchange_rate_updated_at || null,
      updatedByUserId: row.exchange_rate_updated_by_user_id || null,
      updatedByUserName: row.exchange_rate_updated_by_user_name || null,
    });
  });

  router.get('/exchange-rate/history', async (req, res) => {
    await ensureExchangeRateHistoryTable();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const rows = await query(
      `SELECT id, previous_rate, new_rate, changed_by_user_id, changed_by_user_name,
              changed_by_user_role, source, change_reason, created_at
       FROM exchange_rate_history ORDER BY id DESC LIMIT ?`,
      [limit]
    );
    res.json({ items: rows });
  });

  router.put('/exchange-rate', async (req, res) => {
    await ensureCurrencyExtensions();
    await ensureExchangeRateHistoryTable();
    ensureAdministrator(req); // solo administrador_general — lanza 403 (Express 5 lo propaga solo)

    const actorUser = await resolveRequestActorUser(req, { required: true });
    const actor = getActor(req);
    const newRate = Number(req.body?.rate);
    const reason = String(req.body?.reason || '').trim() || null;
    if (!Number.isFinite(newRate) || newRate <= 0) {
      return res.status(400).json({ error: 'La tasa debe ser un número mayor que cero.' });
    }

    const currentRows = await query('SELECT exchange_rate_usd_dop FROM config WHERE id = 1 LIMIT 1');
    const previousRate = currentRows[0]?.exchange_rate_usd_dop !== null && currentRows[0]?.exchange_rate_usd_dop !== undefined
      ? Number(currentRows[0].exchange_rate_usd_dop) : null;

    await recordExchangeRate({
      newRate,
      previousRate,
      actor,
      actorUser,
      source: 'manual',
      reason,
    });

    await writeAuditLog({
      ...actor,
      moduleName: 'Configuración de Monedas',
      actionName: 'Cambio de tipo de cambio USD→DOP',
      detail: `Tasa anterior: ${previousRate !== null ? previousRate.toFixed(4) : 'sin definir'} · Tasa nueva: ${newRate.toFixed(4)}${reason ? ' · Motivo: ' + reason : ''}`
    });

    res.json({ ok: true, rate: newRate, previousRate });
  });

  return router;
};

/**
 * sync.routes.js
 *
 * Endpoints REST para sincronización Firebase.
 */

const express = require('express');
const { getInstance } = require('../sync/firebase-sync-service');
const { FirebaseSyncQueue } = require('../sync/firebase-sync-queue');
const { syncNewSales } = require('../sync/sync-sales');
const { syncCashClosings } = require('../sync/sync-cash-closings');
const { generateAndSyncDailyReport, syncLastNDays } = require('../sync/sync-daily-reports');
const { syncBranchInventory } = require('../sync/sync-inventory');
const { syncPosStatsToFirestore } = require('../sync/sync-pos-stats');
const { query } = require('../../db');

const router = express.Router();
const syncService = getInstance();

/**
 * GET /api/sync/status
 * Obtiene estado actual de la sincronización.
 */
router.get('/status', async (req, res) => {
  try {
    const status = await syncService.getStatus();

    // Devolver estructura con isOnline + diagnóstico
    return res.json({
      isOnline: status.isOnline === true, // true sólo si hay internet Y Firebase listo
      hasInternet: status.hasInternet === true,
      firebaseReady: status.firebaseReady === true,
      isSyncing: status.isSyncing === true,
      lastSyncAt: status.lastSyncAt || null,
      lastError: status.lastError || null,
      queue: status.queue || { total: 0, pending: 0, synced: 0, error: 0 }
    });
  } catch (err) {
    console.error('❌ ERROR en /api/sync/status:', err.message);
    return res.json({
      isOnline: false,
      hasInternet: false,
      firebaseReady: false,
      isSyncing: false,
      lastSyncAt: null,
      lastError: err.message || 'unknown',
      queue: { total: 0, pending: 0, synced: 0, error: 0 }
    });
  }
});

/**
 * POST /api/sync/now
 * Fuerza una sincronización manual.
 */
router.post('/now', async (req, res) => {
  try {
    const result = await syncService.syncNow();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function requireBizBranch(req, res) {
  const businessId = Number(req.body?.businessId);
  const branchId   = Number(req.body?.branchId);
  if (!businessId || !branchId || businessId <= 0 || branchId <= 0) {
    res.status(400).json({ error: 'businessId y branchId deben ser números positivos.' });
    return null;
  }
  return { businessId, branchId };
}

/**
 * POST /api/sync/sales
 * Sincroniza ventas de una sucursal.
 * Body: { businessId, branchId }
 */
router.post('/sales', async (req, res) => {
  try {
    const ids = requireBizBranch(req, res);
    if (!ids) return;
    const { businessId, branchId } = ids;

    await syncNewSales(businessId, branchId);
    res.json({ status: 'syncing' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sync/cash-closings
 * Sincroniza cierres de caja.
 * Body: { businessId, branchId }
 */
router.post('/cash-closings', async (req, res) => {
  try {
    const ids = requireBizBranch(req, res);
    if (!ids) return;
    const { businessId, branchId } = ids;

    await syncCashClosings(businessId, branchId);
    res.json({ status: 'syncing' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sync/daily-report
 * Sincroniza reporte diario.
 * Body: { businessId, branchId, reportDate }
 */
router.post('/daily-report', async (req, res) => {
  try {
    const ids = requireBizBranch(req, res);
    if (!ids) return;
    const { businessId, branchId } = ids;

    const rawDate = String(req.body?.reportDate || '').trim();
    const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : new Date().toISOString().split('T')[0];

    await generateAndSyncDailyReport(businessId, branchId, date);
    res.json({ status: 'syncing' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sync/inventory
 * Sincroniza inventario.
 * Body: { businessId, branchId }
 */
router.post('/inventory', async (req, res) => {
  try {
    const ids = requireBizBranch(req, res);
    if (!ids) return;
    const { businessId, branchId } = ids;

    await syncBranchInventory(businessId, branchId);
    res.json({ status: 'syncing' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sync/last-n-days
 * Sincroniza reportes de los últimos N días.
 * Body: { businessId, branchId, days }
 */
router.post('/last-n-days', async (req, res) => {
  try {
    const ids = requireBizBranch(req, res);
    if (!ids) return;
    const { businessId, branchId } = ids;

    const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 90);
    await syncLastNDays(businessId, branchId, days);
    res.json({ status: 'syncing', days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sync/queue
 * Obtiene estado de la cola de sincronización.
 */
router.get('/queue', async (req, res) => {
  try {
    const stats = await FirebaseSyncQueue.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sync/pending
 * Lista items pendientes.
 */
router.get('/pending', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 200);
    const pending = await FirebaseSyncQueue.getPending(limit);
    res.json(pending);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sync/pos-stats
 * Sincroniza KPIs y datos recientes del POS al Portal de Contadores via Firestore,
 * y de paso aplica cualquier producto pendiente que el contador haya agregado
 * desde el Portal (en vez de esperar a la próxima apertura/cierre de caja o venta).
 * No requiere body — usa TECNO_CAJA_LICENSE_UID del .env.
 */
router.post('/pos-stats', async (req, res) => {
  try {
    const result = await syncPosStatsToFirestore();

    let productosPendientes = null;
    if (typeof req.app.locals.applyPendingProductRequests === 'function') {
      productosPendientes = await req.app.locals.applyPendingProductRequests()
        .catch((e) => ({ ok: false, reason: e.message }));
    }

    if (result.ok) {
      res.json({
        ok: true,
        message: 'KPIs sincronizados al Portal de Contadores.',
        posStats: result.posStats,
        productosPendientes,
      });
    } else {
      res.status(503).json({ ok: false, error: result.reason });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sync/diagnostic
 * Panel de diagnóstico completo de sincronización.
 * Devuelve: estado, últimos errores, pendientes por tipo, latencia estimada.
 */
router.get('/diagnostic', async (req, res) => {
  try {
    const status = await syncService.getStatus();

    // Últimos 20 items con error
    const errors = await query(
      `SELECT entity_type, entity_id, error_message, retry_count, last_retry_at, created_at
       FROM firebase_sync_queue
       WHERE status = 'error'
       ORDER BY last_retry_at DESC
       LIMIT 20`
    ).catch(() => []);

    // Pendientes agrupados por tipo
    const byType = await query(
      `SELECT entity_type, COUNT(*) as total
       FROM firebase_sync_queue
       WHERE status IN ('pending','error')
       GROUP BY entity_type
       ORDER BY total DESC`
    ).catch(() => []);

    // Última sincronización exitosa por tipo
    const lastSynced = await query(
      `SELECT entity_type, MAX(synced_at) as last_synced_at, COUNT(*) as total_synced
       FROM firebase_sync_queue
       WHERE status = 'synced'
       GROUP BY entity_type`
    ).catch(() => []);

    // Total histórico
    const totals = await query(
      `SELECT status, COUNT(*) as count FROM firebase_sync_queue GROUP BY status`
    ).catch(() => []);

    res.json({
      status: {
        isOnline:     status.isOnline,
        hasInternet:  status.hasInternet,
        firebaseReady: status.firebaseReady,
        isSyncing:    status.isSyncing,
        lastSyncAt:   status.lastSyncAt,
        lastError:    status.lastError,
      },
      queue:       status.queue,
      pendingByType: Array.isArray(byType) ? byType : [],
      lastSynced:   Array.isArray(lastSynced) ? lastSynced : [],
      totals:       Array.isArray(totals) ? totals : [],
      recentErrors: Array.isArray(errors) ? errors : [],
      checkedAt:    new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sync/retry-errors
 * Reintenta todos los items con error (resetea next_retry_at).
 */
router.post('/retry-errors', async (req, res) => {
  try {
    const result = await query(
      `UPDATE firebase_sync_queue
       SET status = 'pending', next_retry_at = NULL, error_message = NULL
       WHERE status = 'error'`
    );
    const affected = result.affectedRows || result.changes || 0;
    // Lanza procesamiento inmediato
    syncService.processPendingItems().catch(() => {});
    res.json({ ok: true, retried: affected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

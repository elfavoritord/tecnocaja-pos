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

/**
 * POST /api/sync/sales
 * Sincroniza ventas de una sucursal.
 * Body: { businessId, branchId }
 */
router.post('/sales', async (req, res) => {
  try {
    const { businessId, branchId } = req.body;

    if (!businessId || !branchId) {
      return res.status(400).json({ error: 'businessId y branchId requeridos' });
    }

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
    const { businessId, branchId } = req.body;

    if (!businessId || !branchId) {
      return res.status(400).json({ error: 'businessId y branchId requeridos' });
    }

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
    const { businessId, branchId, reportDate } = req.body;

    if (!businessId || !branchId) {
      return res.status(400).json({ error: 'businessId y branchId requeridos' });
    }

    const date = reportDate || new Date().toISOString().split('T')[0];
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
    const { businessId, branchId } = req.body;

    if (!businessId || !branchId) {
      return res.status(400).json({ error: 'businessId y branchId requeridos' });
    }

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
    const { businessId, branchId, days = 7 } = req.body;

    if (!businessId || !branchId) {
      return res.status(400).json({ error: 'businessId y branchId requeridos' });
    }

    await syncLastNDays(businessId, branchId, days);
    res.json({ status: 'syncing' });
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
    const limit = parseInt(req.query.limit) || 20;
    const pending = await FirebaseSyncQueue.getPending(limit);
    res.json(pending);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

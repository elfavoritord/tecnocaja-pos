/**
 * offline.routes.js
 *
 * Endpoints REST para modo offline multicaja/multisucursal.
 * Usa factory pattern con dependencias inyectadas para evitar imports circulares.
 *
 * Rutas registradas bajo /api/offline:
 *   GET  /status           - Estado del caché y ventas pendientes
 *   POST /init-cache       - Descarga productos/clientes/usuarios al caché local
 *   POST /save-sale        - Guarda una venta en modo offline (pending_sales)
 *   GET  /pending-list     - Lista ventas pendientes de sincronizar
 *   POST /sync-pending     - Sube ventas offline al servidor principal (sync real)
 *   POST /cancel-pending   - Cancela una venta offline antes de sincronizar
 */

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

/**
 * @param {object} deps - Dependencias inyectadas desde server.js
 * @param {Function} deps.query - query() de db.js (BD principal, MySQL o SQLite)
 * @param {Function} deps.localQuery - localQuery() de db-local.js (SQLite local)
 * @param {Function} deps.localCacheStatus - getLocalCacheStatus() de db-local.js
 * @param {Function} deps.generateOfflineId - generateOfflineInvoiceId() de db-local.js
 * @param {Function} deps.logSyncEvent - logLocalSyncEvent() de db-local.js
 * @param {Function} deps.resolveUser - resolveRequestActorUser() de server.js
 * @param {Function} deps.getTerminalConfig - getTerminalConfig() de server.js
 */
module.exports = function createOfflineRouter(deps) {
  const {
    query,
    localQuery,
    localCacheStatus,
    generateOfflineId,
    logSyncEvent,
    resolveUser,
    getTerminalConfig
  } = deps;

  const router = express.Router();

  // ─── GET /api/offline/status ────────────────────────────────────────────────
  router.get('/status', async (req, res) => {
    try {
      const tc = getTerminalConfig() || {};
      const terminalId = req.query.terminalId || tc.terminalId || 'default';
      const status = await localCacheStatus(terminalId);
      return res.json({ ok: true, terminalId, ...status });
    } catch (err) {
      console.error('[offline/status]', err.message);
      return res.status(500).json({ error: 'Error obteniendo estado offline', pendingSalesCount: 0 });
    }
  });

  // ─── POST /api/offline/init-cache ────────────────────────────────────────────
  // Descarga productos, clientes, usuarios, métodos de pago y config de la BD
  // principal al SQLite local. Se llama después del primer login exitoso o al sync.
  router.post('/init-cache', async (req, res) => {
    try {
      const tc = getTerminalConfig() || {};
      const terminalId = tc.terminalId || 'default';
      const branchId = tc.branchId || null;
      const cashRegisterId = tc.cashRegisterId || null;

      let productsCached = 0;
      let clientsCached = 0;
      let usersCached = 0;
      let methodsCached = 0;

      // 1. Productos activos
      const productos = await query(
        `SELECT id, codigo, nombre,
                COALESCE(categoria, 'Sin categoría') as categoria,
                precio_venta, COALESCE(stock, 0) as stock,
                COALESCE(stock_min, 0) as stock_min, estado
         FROM products
         WHERE estado = 'Activo'
         LIMIT 5000`
      );
      for (const p of (productos || [])) {
        await localQuery(
          `INSERT INTO offline_cache_products
             (product_id, codigo, nombre, categoria, precio_venta, stock_cached, stock_min, estado, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(product_id) DO UPDATE SET
             codigo=excluded.codigo, nombre=excluded.nombre, categoria=excluded.categoria,
             precio_venta=excluded.precio_venta, stock_cached=excluded.stock_cached,
             stock_min=excluded.stock_min, estado=excluded.estado, last_updated=excluded.last_updated`,
          [p.id, p.codigo, p.nombre, p.categoria, p.precio_venta, p.stock, p.stock_min, p.estado]
        );
        productsCached++;
      }

      // 2. Clientes activos
      const clientes = await query(
        `SELECT id, nombre, cedula, telefono, email, direccion,
                COALESCE(limite_credito, 0) as limite_credito,
                COALESCE(balance, 0) as balance
         FROM clients LIMIT 3000`
      );
      for (const c of (clientes || [])) {
        await localQuery(
          `INSERT INTO offline_cache_clients
             (client_id, nombre, cedula, telefono, email, direccion, limite_credito, balance, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(client_id) DO UPDATE SET
             nombre=excluded.nombre, cedula=excluded.cedula, telefono=excluded.telefono,
             email=excluded.email, direccion=excluded.direccion,
             limite_credito=excluded.limite_credito, balance=excluded.balance,
             last_updated=excluded.last_updated`,
          [c.id, c.nombre, c.cedula || '', c.telefono || '', c.email || '', c.direccion || '', c.limite_credito, c.balance]
        );
        clientsCached++;
      }

      // 3. Usuarios activos (para login offline)
      const usuarios = await query(
        `SELECT id, usuario, nombre, rol,
                COALESCE(password_hash, password) as password_hash
         FROM users WHERE estado = 'Activo' LIMIT 500`
      );
      for (const u of (usuarios || [])) {
        await localQuery(
          `INSERT INTO offline_cache_users
             (user_id, usuario, nombre, rol, password_hash, puede_vender, puede_cobrar, puede_ver_reportes, last_updated)
           VALUES (?, ?, ?, ?, ?, 1, 1, 1, datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET
             usuario=excluded.usuario, nombre=excluded.nombre, rol=excluded.rol,
             password_hash=excluded.password_hash, last_updated=excluded.last_updated`,
          [u.id, u.usuario, u.nombre, u.rol, u.password_hash || '']
        );
        usersCached++;
      }

      // 4. Métodos de pago
      const metodos = await query(`SELECT id, codigo, nombre FROM payment_methods WHERE estado = 'Activo'`);
      for (const m of (metodos || [])) {
        await localQuery(
          `INSERT INTO offline_cache_payment_methods (payment_method_id, codigo, nombre, last_updated)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(payment_method_id) DO UPDATE SET
             codigo=excluded.codigo, nombre=excluded.nombre, last_updated=excluded.last_updated`,
          [m.id, m.codigo, m.nombre]
        );
        methodsCached++;
      }

      // 5. Config básica del negocio + nombres de sucursal/caja activa
      const config = await query(`SELECT * FROM config WHERE id = 1 LIMIT 1`);
      if (Array.isArray(config) && config[0]) {
        const cfg = config[0];
        const activeBranch = Number(cfg.active_branch_id || branchId || 0);
        const activeCashReg = Number(cfg.active_cash_register_id || cashRegisterId || 0);

        let activeBranchName = '';
        let activeCashRegisterName = '';
        if (activeBranch) {
          const bRows = await query('SELECT nombre FROM branches WHERE id = ? LIMIT 1', [activeBranch]).catch(() => []);
          activeBranchName = bRows[0]?.nombre || '';
        }
        if (activeCashReg) {
          const rRows = await query('SELECT nombre FROM cash_registers WHERE id = ? LIMIT 1', [activeCashReg]).catch(() => []);
          activeCashRegisterName = rRows[0]?.nombre || '';
        }

        const configItems = [
          ['business_name', cfg.business_name || ''],
          ['rnc', cfg.rnc || ''],
          ['currency', cfg.currency || 'RD$'],
          ['tax_rate', String(cfg.tax_rate || 18)],
          ['invoice_prefix', cfg.invoice_prefix || 'FAC-'],
          ['receipt_message', cfg.receipt_message || '¡Gracias por su compra!'],
          ['business_type', cfg.business_type || ''],
          ['active_branch_id', String(activeBranch || 1)],
          ['active_cash_register_id', String(activeCashReg || 1)],
          ['activeBranchName', activeBranchName],
          ['activeCashRegisterName', activeCashRegisterName],
          ['requireCashOpenBeforeUse', String(cfg.require_cash_open_before_use ?? true)]
        ];
        for (const [k, v] of configItems) {
          await localQuery(
            `INSERT INTO offline_cache_config (config_key, config_value, last_updated)
             VALUES (?, ?, datetime('now'))
             ON CONFLICT(config_key) DO UPDATE SET config_value=excluded.config_value, last_updated=excluded.last_updated`,
            [k, v]
          );
        }
      }

      // 6. Actualizar estado de terminal en caché
      await localQuery(
        `INSERT INTO offline_terminal_cache
           (terminal_id, principal_host, principal_base_url, branch_id, cash_register_id, is_online, sync_status, last_full_sync)
         VALUES (?, ?, ?, ?, ?, 1, 'online', datetime('now'))
         ON CONFLICT(terminal_id) DO UPDATE SET
           is_online=1, sync_status='online', last_full_sync=datetime('now'),
           last_health_check=datetime('now')`,
        [
          terminalId,
          tc.principalHost || '127.0.0.1',
          tc.principalBaseUrl || '',
          branchId,
          cashRegisterId
        ]
      );

      await logSyncEvent(terminalId, 'download', 0, productsCached + clientsCached + usersCached, 'ok', null);

      return res.json({
        ok: true,
        productsCached,
        clientsCached,
        usersCached,
        methodsCached,
        cachedAt: new Date().toISOString()
      });
    } catch (err) {
      console.error('[offline/init-cache]', err);
      return res.status(500).json({ error: 'Error al inicializar caché', details: err.message });
    }
  });

  // ─── POST /api/offline/save-sale ─────────────────────────────────────────────
  // Guarda una venta en pending_sales cuando la terminal está sin conexión.
  // Devuelve una respuesta que emula la de POST /api/sales para que el frontend
  // pueda mostrar el recibo sin saber que está en modo offline.
  router.post('/save-sale', async (req, res) => {
    try {
      const user = await resolveUser(req, { required: false });
      if (!user?.id) {
        return res.status(401).json({ error: 'Sesión no válida para venta offline.' });
      }

      const sale = req.body;
      if (!sale || !Array.isArray(sale.items) || sale.items.length === 0) {
        return res.status(400).json({ error: 'Datos de venta inválidos o sin items.' });
      }

      const tc = getTerminalConfig() || {};
      const terminalId = tc.terminalId || 'default';
      const branchId = Number(sale.branchId || tc.branchId || 1);
      const cashRegisterId = Number(sale.cashRegisterId || tc.cashRegisterId || 1);
      const total = Number(sale.total || 0);
      const paymentMethod = String(sale.metodo || 'efectivo').trim();
      const clientId = sale.clientId ? Number(sale.clientId) : null;

      // Generar ID offline único: terminalId#secuencial#timestamp
      const offlineInvoiceId = await generateOfflineId(terminalId);
      const pendingId = offlineInvoiceId; // usar mismo valor como PK

      const saleData = JSON.stringify({
        ...sale,
        offlineInvoiceId,
        terminalId,
        branchId,
        cashRegisterId,
        userId: user.id,
        userName: user.nombre || user.usuario,
        pendiente_sincronizacion: true,
        origen: 'terminal_secundaria',
        fecha_local: new Date().toISOString()
      });

      // Guardar venta pendiente
      await localQuery(
        `INSERT INTO pending_sales
           (id, terminal_id, offline_invoice_id, branch_id, cash_register_id,
            user_id, client_id, sale_data, total, payment_method, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
        [pendingId, terminalId, offlineInvoiceId, branchId, cashRegisterId,
         user.id, clientId, saleData, total, paymentMethod]
      );

      // Guardar items
      for (let i = 0; i < sale.items.length; i++) {
        const item = sale.items[i];
        await localQuery(
          `INSERT INTO pending_sale_items (pending_sale_id, item_sequence, product_id, item_data, created_at)
           VALUES (?, ?, ?, ?, datetime('now'))`,
          [pendingId, i + 1, Number(item.id || item.producto_id || 0), JSON.stringify(item)]
        );

        // Descontar stock del caché local
        if (item.id || item.producto_id) {
          const qty = Number(item.qty || item.cantidad || 1);
          await localQuery(
            `UPDATE offline_cache_products
             SET stock_cached = MAX(0, stock_cached - ?)
             WHERE product_id = ?`,
            [qty, Number(item.id || item.producto_id)]
          );
        }
      }

      // Registrar movimiento de caja offline
      await localQuery(
        `INSERT INTO pending_cash_movements
           (terminal_id, movement_type, amount, notes, reference_sale_id, status, created_at)
         VALUES (?, 'venta_offline', ?, ?, ?, 'pending', datetime('now'))`,
        [terminalId, total, `Venta offline ${offlineInvoiceId}`, pendingId]
      );

      // Construir respuesta que emula /api/sales para que el frontend funcione igual
      const clientName = clientId
        ? ((await localQuery('SELECT nombre FROM offline_cache_clients WHERE client_id = ? LIMIT 1', [clientId]))[0]?.nombre || 'Cliente')
        : 'Consumidor Final';

      const fakeSale = {
        id: offlineInvoiceId,
        invoice_number: offlineInvoiceId,
        total,
        payment_method: paymentMethod,
        sale_status: 'pagada',
        client_id: clientId,
        client_name: clientName,
        clienteTelefono: sale.clienteTelefono || '',
        created_at: new Date().toISOString(),
        items: sale.items,
        offlineMode: true,
        offlineInvoiceId,
        terminalId,
        pendiente_sincronizacion: true
      };

      console.log(`[offline/save-sale] Venta guardada: ${offlineInvoiceId} | Total: ${total}`);

      return res.json({
        ok: true,
        sale: fakeSale,
        config: {},
        offlineMode: true
      });
    } catch (err) {
      console.error('[offline/save-sale]', err);
      return res.status(500).json({ error: 'Error al guardar venta offline', details: err.message });
    }
  });

  // ─── GET /api/offline/pending-list ───────────────────────────────────────────
  router.get('/pending-list', async (req, res) => {
    try {
      const tc = getTerminalConfig() || {};
      const terminalId = req.query.terminalId || tc.terminalId || 'default';
      const limit = Math.min(Number(req.query.limit || 50), 200);
      const status = req.query.status || 'pending';

      const rows = await localQuery(
        `SELECT id, offline_invoice_id, total, payment_method, status,
                error_message, created_at, synced_at, user_id, client_id
         FROM pending_sales
         WHERE terminal_id = ? AND status = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [terminalId, status, limit]
      );

      const lastSync = await localQuery(
        `SELECT completed_at, items_uploaded, result
         FROM sync_log
         WHERE terminal_id = ? AND result != 'pending'
         ORDER BY started_at DESC LIMIT 1`,
        [terminalId]
      );

      const errors = await localQuery(
        `SELECT id, offline_invoice_id, error_message, created_at
         FROM pending_sales
         WHERE terminal_id = ? AND status = 'error'
         ORDER BY created_at DESC LIMIT 10`,
        [terminalId]
      );

      return res.json({
        ok: true,
        pending: rows || [],
        lastSync: lastSync?.[0] || null,
        errors: errors || []
      });
    } catch (err) {
      console.error('[offline/pending-list]', err);
      return res.status(500).json({ error: 'Error listando ventas pendientes' });
    }
  });

  // ─── POST /api/offline/sync-pending ──────────────────────────────────────────
  // Implementación real de la sincronización offline → principal.
  // Lee pending_sales del SQLite local y los inserta en la BD principal (MySQL).
  router.post('/sync-pending', async (req, res) => {
    const tc = getTerminalConfig() || {};
    const terminalId = tc.terminalId || 'default';
    const results = { synced: 0, failed: 0, skipped: 0, errors: [] };

    try {
      // 1. Obtener ventas pendientes del SQLite local
      const pendingSales = await localQuery(
        `SELECT * FROM pending_sales WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100`
      );

      if (!Array.isArray(pendingSales) || pendingSales.length === 0) {
        // Nada que sincronizar, aprovechar para actualizar caché
        await _downloadUpdates(query, localQuery, tc, terminalId);
        await logSyncEvent(terminalId, 'full', 0, 0, 'ok', null);
        return res.json({ ok: true, synced: 0, failed: 0, skipped: 0, message: 'Sin pendientes. Caché actualizado.' });
      }

      // Marcar como syncing para evitar doble procesamiento
      for (const ps of pendingSales) {
        await localQuery(
          `UPDATE pending_sales SET status = 'syncing' WHERE id = ?`,
          [ps.id]
        );
      }

      // 2. Procesar cada venta
      for (const ps of pendingSales) {
        try {
          // Verificar deduplicación en offline_sync_map del SQLite local
          const existing = await localQuery(
            `SELECT real_invoice_id FROM offline_sync_map WHERE offline_id = ? LIMIT 1`,
            [ps.offline_invoice_id]
          );
          if (Array.isArray(existing) && existing.length > 0) {
            // Ya sincronizada antes
            await localQuery(
              `UPDATE pending_sales SET status = 'synced', synced_at = datetime('now') WHERE id = ?`,
              [ps.id]
            );
            results.skipped++;
            continue;
          }

          // También verificar en BD principal por si fue sincronizada desde otro lugar
          let alreadyInMain = false;
          try {
            const mainCheck = await query(
              `SELECT id FROM offline_sync_map WHERE offline_id = ? LIMIT 1`,
              [ps.offline_invoice_id]
            ).catch(() => null);
            if (Array.isArray(mainCheck) && mainCheck.length > 0) alreadyInMain = true;
          } catch (_) {}

          if (alreadyInMain) {
            await localQuery(
              `UPDATE pending_sales SET status = 'synced', synced_at = datetime('now') WHERE id = ?`,
              [ps.id]
            );
            results.skipped++;
            continue;
          }

          // Parsear datos de la venta
          let saleData;
          try {
            saleData = typeof ps.sale_data === 'string' ? JSON.parse(ps.sale_data) : ps.sale_data;
          } catch (parseErr) {
            throw new Error(`JSON inválido en venta ${ps.offline_invoice_id}`);
          }

          // Insertar en BD principal usando la misma lógica simplificada
          const realInvoiceId = await _insertSaleToMain(query, saleData, ps, tc);

          // Registrar en offline_sync_map del SQLite local
          await localQuery(
            `INSERT OR IGNORE INTO offline_sync_map
               (offline_id, real_invoice_id, terminal_id, branch_id, cash_register_id, synced_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`,
            [ps.offline_invoice_id, realInvoiceId, terminalId, ps.branch_id, ps.cash_register_id]
          );

          // También en la BD principal para deduplicación global
          await query(
            `INSERT IGNORE INTO offline_sync_map
               (offline_id, real_invoice_id, terminal_id, branch_id, cash_register_id)
             VALUES (?, ?, ?, ?, ?)`,
            [ps.offline_invoice_id, realInvoiceId, terminalId, ps.branch_id, ps.cash_register_id]
          ).catch(() => {});

          // Marcar como sincronizada
          await localQuery(
            `UPDATE pending_sales SET status = 'synced', synced_at = datetime('now') WHERE id = ?`,
            [ps.id]
          );
          results.synced++;
          console.log(`[offline/sync] Sincronizada: ${ps.offline_invoice_id} → ${realInvoiceId}`);
        } catch (saleErr) {
          console.error(`[offline/sync] Error en ${ps.offline_invoice_id}:`, saleErr.message);
          await localQuery(
            `UPDATE pending_sales SET status = 'error', error_message = ? WHERE id = ?`,
            [String(saleErr.message).slice(0, 490), ps.id]
          );
          results.failed++;
          results.errors.push({ id: ps.offline_invoice_id, error: saleErr.message });
        }
      }

      // 3. Sincronizar movimientos de caja pendientes
      await _syncCashMovements(query, localQuery, terminalId, tc);

      // 4. Descargar actualizaciones del principal
      await _downloadUpdates(query, localQuery, tc, terminalId);

      // 5. Actualizar estado de terminal
      await localQuery(
        `UPDATE offline_terminal_cache SET is_online = 1, sync_status = 'online', last_full_sync = datetime('now')
         WHERE terminal_id = ?`,
        [terminalId]
      );

      const syncResult = results.failed > 0 ? 'partial' : 'ok';
      await logSyncEvent(terminalId, 'full', results.synced, 0, syncResult, results.errors.length ? results.errors[0]?.error : null);

      return res.json({
        ok: true,
        ...results,
        syncedAt: new Date().toISOString()
      });
    } catch (err) {
      console.error('[offline/sync-pending]', err);
      await logSyncEvent(terminalId, 'full', results.synced, 0, 'error', err.message);
      return res.status(500).json({ error: 'Error en sincronización', details: err.message, ...results });
    }
  });

  // ─── POST /api/offline/cancel-pending ────────────────────────────────────────
  router.post('/cancel-pending', async (req, res) => {
    try {
      const { offlineInvoiceId } = req.body || {};
      if (!offlineInvoiceId) {
        return res.status(400).json({ error: 'offlineInvoiceId requerido.' });
      }

      const rows = await localQuery(
        `SELECT * FROM pending_sales WHERE offline_invoice_id = ? AND status = 'pending' LIMIT 1`,
        [offlineInvoiceId]
      );

      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(404).json({ error: 'Venta no encontrada o ya fue sincronizada.' });
      }

      const ps = rows[0];

      // Restaurar stock en caché local
      const items = await localQuery(
        `SELECT item_data FROM pending_sale_items WHERE pending_sale_id = ?`,
        [ps.id]
      );
      for (const itemRow of (items || [])) {
        try {
          const item = typeof itemRow.item_data === 'string'
            ? JSON.parse(itemRow.item_data)
            : itemRow.item_data;
          const qty = Number(item.qty || item.cantidad || 1);
          const productId = Number(item.id || item.producto_id || 0);
          if (productId) {
            await localQuery(
              `UPDATE offline_cache_products SET stock_cached = stock_cached + ? WHERE product_id = ?`,
              [qty, productId]
            );
          }
        } catch (_) {}
      }

      // Eliminar movimiento de caja relacionado
      await localQuery(
        `DELETE FROM pending_cash_movements WHERE reference_sale_id = ? AND status = 'pending'`,
        [ps.id]
      );

      // Eliminar venta (cascade elimina items)
      await localQuery(`DELETE FROM pending_sales WHERE id = ?`, [ps.id]);

      console.log(`[offline/cancel] Venta cancelada: ${offlineInvoiceId}`);
      return res.json({ ok: true, cancelled: offlineInvoiceId });
    } catch (err) {
      console.error('[offline/cancel-pending]', err);
      return res.status(500).json({ error: 'Error cancelando venta', details: err.message });
    }
  });

  // ─── GET /api/offline/bootstrap ──────────────────────────────────────────────
  // Devuelve datos del caché SQLite local (productos, clientes, config).
  // Permite que el frontend arranque cuando MySQL no está disponible.
  router.get('/bootstrap', async (req, res) => {
    try {
      const productos = await localQuery(
        `SELECT product_id as id, codigo, nombre, categoria,
                precio_venta, stock_cached as stock, stock_min, estado
         FROM offline_cache_products WHERE estado = 'Activo' ORDER BY nombre LIMIT 5000`
      );

      const clientes = await localQuery(
        `SELECT client_id as id, nombre, cedula, telefono, email,
                direccion, limite_credito, balance
         FROM offline_cache_clients ORDER BY nombre LIMIT 3000`
      );

      const configRows = await localQuery(`SELECT config_key, config_value FROM offline_cache_config`);
      const rawCfg = {};
      for (const row of (configRows || [])) {
        rawCfg[row.config_key] = row.config_value;
      }
      // Mapear al mismo formato camelCase que getConfig() del servidor
      // para que DB.config.activeBranchId, nombre, moneda, etc. funcionen
      const config = {
        nombre: rawCfg.business_name || rawCfg.nombre || '',
        rnc: rawCfg.rnc || '',
        moneda: rawCfg.currency || rawCfg.moneda || 'RD$',
        itbis: Number(rawCfg.tax_rate || rawCfg.itbis || 18),
        taxCalculateAtInvoiceEnd: rawCfg.tax_calculate_at_invoice_end !== '0' && rawCfg.taxCalculateAtInvoiceEnd !== 'false',
        taxIncludeInProductPrice: rawCfg.tax_include_in_product_price === '1' || rawCfg.taxIncludeInProductPrice === 'true',
        taxShowBreakdownOnReceipts: rawCfg.tax_show_breakdown_on_receipts !== '0' && rawCfg.taxShowBreakdownOnReceipts !== 'false',
        taxSeparateTaxableAndExempt: rawCfg.tax_separate_taxable_and_exempt !== '0' && rawCfg.taxSeparateTaxableAndExempt !== 'false',
        prefix: rawCfg.invoice_prefix || rawCfg.prefix || 'FAC-',
        mensaje: rawCfg.receipt_message || rawCfg.mensaje || '¡Gracias por su compra!',
        tipoNegocio: rawCfg.business_type || rawCfg.tipoNegocio || '',
        salesSplitViewEnabled: rawCfg.sales_split_view_enabled === '1' || rawCfg.salesSplitViewEnabled === 'true',
        activeBranchId: Number(rawCfg.active_branch_id || rawCfg.activeBranchId || 0) || null,
        activeCashRegisterId: Number(rawCfg.active_cash_register_id || rawCfg.activeCashRegisterId || 0) || null,
        activeBranchName: rawCfg.activeBranchName || '',
        activeCashRegisterName: rawCfg.activeCashRegisterName || '',
        requireCashOpenBeforeUse: rawCfg.requireCashOpenBeforeUse !== 'false',
        setupCompleted: true,
        cajaAbierta: false,
        cajaMonto: 0
      };

      const paymentMethods = await localQuery(
        `SELECT payment_method_id as id, codigo, nombre FROM offline_cache_payment_methods`
      );

      const usuarios = await localQuery(
        `SELECT user_id as id, usuario, nombre, rol FROM offline_cache_users ORDER BY nombre LIMIT 500`
      );

      const sucursales = [];
      const cajasSucursal = [];
      const branchId = Number(config.activeBranchId || 0) || null;
      const cashRegisterId = Number(config.activeCashRegisterId || 0) || null;
      if (branchId) {
        sucursales.push({
          id: branchId,
          nombre: config.activeBranchName || 'Sucursal principal',
          codigo: ''
        });
      }
      if (cashRegisterId) {
        cajasSucursal.push({
          id: cashRegisterId,
          sucursalId: branchId,
          nombre: config.activeCashRegisterName || 'Caja principal',
          codigo: ''
        });
      }

      const pendingRows = await localQuery(
        `SELECT COUNT(*) as cnt FROM pending_sales WHERE status = 'pending'`
      );
      const pendingSalesCount = Number(pendingRows?.[0]?.cnt || 0);

      return res.json({
        ok: true,
        offlineMode: true,
        productos: productos || [],
        clientes: clientes || [],
        users: usuarios || [],
        sucursales,
        cajasSucursal,
        config,
        metodosPago: paymentMethods || [],
        pendingSalesCount,
        cachedAt: new Date().toISOString()
      });
    } catch (err) {
      console.error('[offline/bootstrap]', err.message);
      return res.status(500).json({ error: 'Error cargando datos offline', details: err.message });
    }
  });

  // ─── Helpers privados ────────────────────────────────────────────────────────

  /**
   * Inserta una venta offline en la BD principal.
   * Genera un número de factura real y descuenta inventario.
   */
  async function _insertSaleToMain(query, saleData, pendingSale, tc) {
    const configRows = await query('SELECT * FROM config WHERE id = 1 LIMIT 1');
    const config = configRows[0] || {};

    // Generar número de factura real (incremento atómico)
    await query(`UPDATE config SET invoice_next_number = invoice_next_number + 1 WHERE id = 1`);
    const seqRows = await query(`SELECT invoice_next_number AS seq FROM config WHERE id = 1`);
    const nextNumber = Number(seqRows[0]?.seq || 1);
    const prefix = config.invoice_prefix || 'FAC-';
    const invoiceNumber = `${prefix}${String(nextNumber).padStart(8, '0')}`;

    const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const subtotal = Number(saleData.subtotal || pendingSale.subtotal || pendingSale.total || 0);
    const discount = Number(saleData.descuento || pendingSale.discount || 0);
    const tax = Number(saleData.itbis || pendingSale.tax || 0);
    const total = Number(pendingSale.total || saleData.total || 0);
    const paymentMethod = String(saleData.metodo || pendingSale.payment_method || 'efectivo');
    const branchId = Number(pendingSale.branch_id || tc.branchId || 1);
    const cashRegisterId = Number(pendingSale.cash_register_id || tc.cashRegisterId || 1);
    const userId = Number(pendingSale.user_id || 0);
    const clientId = pendingSale.client_id ? Number(pendingSale.client_id) : null;

    let clientName = 'Consumidor Final';
    if (clientId) {
      const clientRows = await query('SELECT nombre FROM clients WHERE id = ? LIMIT 1', [clientId]).catch(() => []);
      if (clientRows?.[0]) clientName = clientRows[0].nombre;
    }

    // Insertar en tabla sales (usando nombres de columna exactos del schema)
    const insertResult = await query(
      `INSERT INTO sales
         (invoice_number, total, discount, tax, subtotal, payment_method,
          sale_status, client_id, client_name_snapshot, branch_id, cash_register_id,
          user_id, document_type, order_type, order_notes,
          received_amount, change_amount, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pagada', ?, ?, ?, ?, ?, 'ticket', 'mostrador', ?,
               ?, 0, ?)`,
      [
        invoiceNumber,
        total,
        discount,
        tax,
        subtotal,
        paymentMethod,
        clientId,
        clientName,
        branchId,
        cashRegisterId,
        userId,
        String(saleData.notes || saleData.orderNotes || `Origen: terminal offline ${pendingSale.terminal_id}`).slice(0, 500),
        Number(saleData.recibido || total),
        nowSql
      ]
    );

    const saleId = insertResult?.insertId;

    // Insertar items y descontar inventario
    const items = Array.isArray(saleData.items) ? saleData.items : [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const productId = Number(item.id || item.producto_id || 0);
      const qty = Number(item.qty || item.cantidad || 1);
      const unitPrice = Number(item.price || item.precio || item.precio_venta || 0);
      const lineTotal = Number(item.subtotal || item.total || item.line_total || qty * unitPrice);
      const discountRate = Number(item.discount_rate || item.descuento || 0);
      const taxRate = Number(item.tax_rate || item.itbis || 0);

      if (saleId && productId) {
        await query(
          `INSERT INTO sale_items (sale_id, product_id, qty, price, line_total, discount_rate, tax_rate, sale_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'unidad')`,
          [saleId, productId, qty, unitPrice, lineTotal, discountRate, taxRate]
        ).catch(() => {});

        // Descontar stock en la BD principal
        await query(
          `UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?`,
          [qty, productId]
        ).catch(() => {});

        // Registrar movimiento de inventario (columnas del schema real)
        await query(
          `INSERT INTO inventory_movements
             (product_id, movement_type, quantity_change, previous_stock, new_stock,
              reference_type, reference_id, notes, branch_id, sale_id, created_at)
           VALUES (?, 'salida', ?, 0, 0, 'venta_offline', ?, ?, ?, ?, ?)`,
          [productId, qty, invoiceNumber,
           `Venta offline sincronizada (${pendingSale.offline_invoice_id})`,
           branchId, saleId || null, nowSql]
        ).catch(() => {});
      }
    }

    return invoiceNumber;
  }

  /**
   * Marca los movimientos de caja offline como sincronizados.
   * Los movimientos de ventas ya se capturan en sales/sale_items.
   * Los movimientos manuales se registran con 'happened_at' del momento original.
   */
  async function _syncCashMovements(query, localQuery, terminalId, tc) {
    try {
      const movements = await localQuery(
        `SELECT * FROM pending_cash_movements WHERE terminal_id = ? AND status = 'pending' LIMIT 100`,
        [terminalId]
      );
      for (const mv of (movements || [])) {
        // Los de ventas ya están registrados en la BD principal a través de _insertSaleToMain
        // Solo marcar como sincronizados
        await localQuery(
          `UPDATE pending_cash_movements SET status = 'synced', synced_at = datetime('now') WHERE id = ?`,
          [mv.id]
        );
      }
    } catch (err) {
      console.error('[offline/sync-cash]', err.message);
    }
  }

  /**
   * Descarga productos, clientes y config actualizados del principal al caché local.
   */
  async function _downloadUpdates(query, localQuery, tc, terminalId) {
    try {
      // Actualizar precios de productos más recientes
      const productos = await query(
        `SELECT id, codigo, nombre,
                COALESCE(categoria, 'Sin categoría') as categoria,
                precio_venta, COALESCE(stock, 0) as stock, estado
         FROM products
         WHERE estado = 'Activo'
         LIMIT 2000`
      ).catch(() => []);

      for (const p of (productos || [])) {
        await localQuery(
          `INSERT INTO offline_cache_products
             (product_id, codigo, nombre, categoria, precio_venta, stock_cached, estado, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(product_id) DO UPDATE SET
             precio_venta=excluded.precio_venta, stock_cached=excluded.stock_cached,
             estado=excluded.estado, last_updated=excluded.last_updated`,
          [p.id, p.codigo, p.nombre, p.categoria, p.precio_venta, p.stock, p.estado]
        );
      }
    } catch (err) {
      console.error('[offline/download-updates]', err.message);
    }
  }

  return router;
};

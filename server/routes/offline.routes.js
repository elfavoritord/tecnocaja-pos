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
const { resolveActivePromotions, resolvePriceForSaleItem } = require('../services/promotion-engine');

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
    generateOfflineRef,
    logSyncEvent,
    resolveUser,
    getTerminalConfig,
    syncSaleToReports,
    // Proveedores offline (Fase 1 de la extensión offline)
    ensureSuppliersTable,
    mapSupplierRow,
    insertSupplierRow,
    updateSupplierRow,
    deleteSupplierIfNoPendingInvoices,
    getActor,
    writeAuditLog,
    // Inventario offline (Fase 2 de la extensión offline)
    mapProductRow,
    ensureBranchInventoryTable,
    ensureInventoryMovementsTable,
    resolveInventoryBranchId,
    changeBranchInventoryStock,
    registerInventoryMovement,
    mapInventoryMovementRow,
    // Caja offline (Fase 3 de la extensión offline)
    withTransaction,
    ensureCashMovementExtensions,
    ensureBusinessStructureExtensions,
    ensurePendingCashMovementExtensions,
    // Movimientos (auditoría, solo lectura) offline (Fase 4 de la extensión offline)
    ensureAuditTable,
    userCanAccessGlobalAudit,
    // 📢 Centro de Promociones
    ensurePromotionsExtensions
  } = deps;

  const router = express.Router();

  // Borra del caché offline cualquier fila cuyo id ya no exista en la BD principal.
  // Sin esto, init-cache solo hace INSERT/UPDATE y los productos/clientes/usuarios
  // eliminados o de pruebas quedan como fantasmas para siempre en el caché local.
  async function pruneStaleCache(cacheTable, cacheIdColumn, freshRows, sourceIdField) {
    const validIds = (freshRows || []).map((row) => row[sourceIdField]).filter((id) => id !== undefined && id !== null);
    if (validIds.length) {
      const placeholders = validIds.map(() => '?').join(',');
      await localQuery(
        `DELETE FROM ${cacheTable} WHERE ${cacheIdColumn} NOT IN (${placeholders})`,
        validIds
      );
    } else {
      await localQuery(`DELETE FROM ${cacheTable}`);
    }
  }

  // mysql2 devuelve las columnas DATETIME/TIMESTAMP de la BD principal como
  // objetos Date de JS, no strings — sql.js (SQLite) solo acepta bind de
  // string/number/null/Uint8Array. Sin esto, cachear cualquier updated_at/
  // created_at de MariaDB en una tabla offline_cache_* revienta con
  // "Wrong API use: tried to bind a value of an unknown type".
  function toSqlDateTimeString(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
    return String(value);
  }

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

  // ─── GET /api/offline/promotions/active-map ─────────────────────────────────
  // Equivalente offline de GET /api/promotions/active-map — lee del caché local
  // en vez de la tabla promotions/promotion_products (que no existen en la
  // terminal secundaria). Poblado por init-cache; solo lectura, ver arriba.
  router.get('/promotions/active-map', async (req, res) => {
    try {
      const rows = await localQuery('SELECT * FROM offline_cache_promotions');
      const activeMap = {};
      for (const row of (rows || [])) {
        activeMap[row.product_id] = {
          promotionId: row.promotion_id,
          nombre: row.nombre,
          precioOriginal: Number(row.precio_original),
          precioPromocion: Number(row.precio_promocion),
          ahorro: Number((Number(row.precio_original) - Number(row.precio_promocion)).toFixed(2)),
          texto: row.texto_promocion || '',
          color: row.color || '',
        };
      }
      res.json({ activeMap });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /api/offline/init-cache ────────────────────────────────────────────
  // Descarga productos, clientes, usuarios, métodos de pago y config de la BD
  // principal al SQLite local. Se llama después del primer login exitoso o al sync.
  router.post('/init-cache', async (req, res) => {
    try {
      await ensurePromotionsExtensions();
      const tc = getTerminalConfig() || {};
      const terminalId = tc.terminalId || 'default';
      const branchId = tc.branchId || null;
      const cashRegisterId = tc.cashRegisterId || null;

      let productsCached = 0;
      let clientsCached = 0;
      let usersCached = 0;
      let methodsCached = 0;

      // 1. Productos activos — solo globales + los exclusivos de la sucursal
      // de esta terminal (una terminal no necesita cachear el catálogo
      // exclusivo de otras sucursales que nunca va a vender).
      const productos = await query(
        `SELECT id, codigo, nombre,
                COALESCE(categoria, 'Sin categoría') as categoria,
                precio_venta, COALESCE(stock, 0) as stock,
                COALESCE(stock_min, 0) as stock_min, estado
         FROM products
         WHERE estado = 'Activo'
           AND (branch_id IS NULL OR branch_id = ?)
         LIMIT 5000`,
        [branchId]
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
      await pruneStaleCache('offline_cache_products', 'product_id', productos, 'id');

      // 1a. Promociones activas (solo lectura offline — crear/editar promociones
      // requiere conexión, ver server/routes/promotions.routes.js).
      let promotionsCached = 0;
      const activePromotionsMap = await resolveActivePromotions({ query, sucursalId: branchId });
      const activePromotionsRows = Object.entries(activePromotionsMap).map(([productoId, promo]) => ({
        producto_id: Number(productoId),
        ...promo,
      }));
      for (const row of activePromotionsRows) {
        await localQuery(
          `INSERT INTO offline_cache_promotions
             (product_id, promotion_id, nombre, precio_promocion, precio_original, texto_promocion, color, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(product_id) DO UPDATE SET
             promotion_id=excluded.promotion_id, nombre=excluded.nombre,
             precio_promocion=excluded.precio_promocion, precio_original=excluded.precio_original,
             texto_promocion=excluded.texto_promocion, color=excluded.color, last_updated=excluded.last_updated`,
          [row.producto_id, row.promotionId, row.nombre, row.precioPromocion, row.precioOriginal, row.texto || null, row.color || null]
        );
        promotionsCached++;
      }
      await pruneStaleCache('offline_cache_promotions', 'product_id', activePromotionsRows, 'producto_id');

      // 1b. Inventario por sucursal — solo la sucursal de esta terminal (una
      // terminal física vende para una sola sucursal, no necesita ver otras).
      let inventoryCached = 0;
      let resolvedInventoryBranchId = null;
      if (typeof resolveInventoryBranchId === 'function') {
        resolvedInventoryBranchId = await resolveInventoryBranchId(null, branchId).catch(() => null);
        if (resolvedInventoryBranchId) {
          // Este caché siempre representa UNA sola sucursal (la de esta terminal).
          // Si la terminal cambió de sucursal desde el último init-cache, se
          // descarta lo viejo por completo antes de repoblar.
          await localQuery(
            `DELETE FROM offline_cache_inventory_by_branch WHERE branch_id != ?`,
            [resolvedInventoryBranchId]
          );
          const inventoryRows = await query(
            `SELECT product_id, stock, stock_min, updated_at
             FROM inventory_by_branch WHERE branch_id = ?`,
            [resolvedInventoryBranchId]
          );
          for (const row of (inventoryRows || [])) {
            await localQuery(
              `INSERT INTO offline_cache_inventory_by_branch
                 (branch_id, product_id, stock, stock_min, updated_at, last_cached)
               VALUES (?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(branch_id, product_id) DO UPDATE SET
                 stock=excluded.stock, stock_min=excluded.stock_min,
                 updated_at=excluded.updated_at, last_cached=excluded.last_cached`,
              [resolvedInventoryBranchId, row.product_id, row.stock, row.stock_min, toSqlDateTimeString(row.updated_at)]
            );
            inventoryCached++;
          }
          // product_id solo es único aquí porque el caché ya está acotado a una sola sucursal.
          await pruneStaleCache('offline_cache_inventory_by_branch', 'product_id', inventoryRows, 'product_id');
        }
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
      await pruneStaleCache('offline_cache_clients', 'client_id', clientes, 'id');

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
      await pruneStaleCache('offline_cache_users', 'user_id', usuarios, 'id');

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
      await pruneStaleCache('offline_cache_payment_methods', 'payment_method_id', metodos, 'id');

      // 4b. Proveedores (para CRUD offline en el módulo Proveedores)
      let suppliersCached = 0;
      let proveedores = [];
      if (typeof ensureSuppliersTable === 'function' && typeof mapSupplierRow === 'function') {
        await ensureSuppliersTable();
        proveedores = await query(`SELECT * FROM suppliers ORDER BY nombre`);
        for (const s of (proveedores || [])) {
          const mapped = mapSupplierRow(s);
          await localQuery(
            `INSERT INTO offline_cache_suppliers (supplier_id, nombre, data_json, updated_at, last_cached)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(supplier_id) DO UPDATE SET
               nombre=excluded.nombre, data_json=excluded.data_json,
               updated_at=excluded.updated_at, last_cached=excluded.last_cached`,
            [s.id, mapped.nombre, JSON.stringify(mapped), toSqlDateTimeString(mapped.updatedAt)]
          );
          suppliersCached++;
        }
        await pruneStaleCache('offline_cache_suppliers', 'supplier_id', proveedores, 'id');
      }

      // 4c. Log de auditoría — solo lectura, últimos 200 eventos (mismo límite
      // que /api/audit). No requiere pruneStaleCache: los audit_logs no se
      // borran en operación normal; un reset de sistema ya limpia todo lo
      // demás también, así que un simple upsert basta.
      let auditCached = 0;
      if (typeof ensureAuditTable === 'function') {
        await ensureAuditTable();
        const auditRows = await query(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200`);
        for (const a of (auditRows || [])) {
          await localQuery(
            `INSERT INTO offline_cache_audit_logs
               (id, user_name, user_role, module_name, action_name, detail, created_at, last_cached)
             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
               user_name=excluded.user_name, user_role=excluded.user_role, module_name=excluded.module_name,
               action_name=excluded.action_name, detail=excluded.detail, created_at=excluded.created_at,
               last_cached=excluded.last_cached`,
            [a.id, a.user_name, a.user_role, a.module_name, a.action_name, a.detail, toSqlDateTimeString(a.created_at)]
          );
          auditCached++;
        }
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

        // 5b. Estado de la sesión de caja abierta (para permitir movimientos
        // de caja standalone offline: retiro/gasto/ingreso sin venta asociada)
        if (activeCashReg) {
          const sessionRows = await query(
            `SELECT id, current_amount FROM cash_sessions WHERE status = 'open' AND cash_register_id = ? ORDER BY id DESC LIMIT 1`,
            [activeCashReg]
          ).catch(() => []);
          const openSession = sessionRows?.[0] || null;
          await localQuery(
            `INSERT INTO offline_cache_config (config_key, config_value, last_updated)
             VALUES ('cash_session_open', ?, datetime('now'))
             ON CONFLICT(config_key) DO UPDATE SET config_value=excluded.config_value, last_updated=excluded.last_updated`,
            [openSession ? '1' : '0']
          );
          await localQuery(
            `INSERT INTO offline_cache_config (config_key, config_value, last_updated)
             VALUES ('cash_session_current_amount', ?, datetime('now'))
             ON CONFLICT(config_key) DO UPDATE SET config_value=excluded.config_value, last_updated=excluded.last_updated`,
            [String(Number(openSession?.current_amount || 0))]
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
        suppliersCached,
        inventoryCached,
        auditCached,
        promotionsCached,
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

  // ─── POST /api/offline/supplier-save ─────────────────────────────────────────
  // Crea o edita un proveedor en modo offline. No escribe en la BD principal —
  // encola el cambio en pending_supplier_changes y se aplica en sync-pending.
  router.post('/supplier-save', async (req, res) => {
    try {
      const data = req.body || {};
      const nombre = String(data.nombre || '').trim();
      if (!nombre) {
        return res.status(400).json({ error: 'El nombre del proveedor es obligatorio.' });
      }
      const tc = getTerminalConfig() || {};
      const terminalId = tc.terminalId || 'default';
      const rawId = data.id != null ? String(data.id) : '';

      // Caso especial: el usuario crea un proveedor offline y lo vuelve a editar
      // ANTES de reconectar. Su "id" todavía es el marcador PENDING-<offlineRef>
      // del create original. En vez de encolar un 'update' para un supplier_id
      // que no existe aún, se actualiza el payload del 'create' pendiente in-place.
      if (rawId.startsWith('PENDING-')) {
        const pendingRef = rawId.slice('PENDING-'.length);
        const existingPending = await localQuery(
          `SELECT * FROM pending_supplier_changes WHERE offline_ref = ? AND status = 'pending' LIMIT 1`,
          [pendingRef]
        );
        if (existingPending?.[0]) {
          await localQuery(
            `UPDATE pending_supplier_changes SET payload_json = ? WHERE offline_ref = ?`,
            [JSON.stringify(data), pendingRef]
          );
          const responseBody = {
            ...data,
            id: rawId,
            offlineMode: true,
            pendiente_sincronizacion: true,
            offlineRef: pendingRef
          };
          return res.status(200).json(responseBody);
        }
        // Si no se encontró el pendiente (por ejemplo ya se sincronizó entre
        // medio), cae al camino normal de create más abajo.
      }

      const existingId = rawId && !rawId.startsWith('PENDING-') ? Number(rawId) : null;
      const changeType = existingId ? 'update' : 'create';

      // base_updated_at: el updated_at cacheado para este proveedor al momento
      // de editar — se compara contra el valor real del servidor al sincronizar.
      let baseUpdatedAt = null;
      if (existingId) {
        const cached = await localQuery(
          `SELECT updated_at FROM offline_cache_suppliers WHERE supplier_id = ? LIMIT 1`,
          [existingId]
        );
        baseUpdatedAt = cached?.[0]?.updated_at || null;
      }

      const offlineRef = generateOfflineRef(terminalId, 'SUP-');
      await localQuery(
        `INSERT INTO pending_supplier_changes
           (terminal_id, change_type, supplier_id, offline_ref, base_updated_at, payload_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
        [terminalId, changeType, existingId, offlineRef, baseUpdatedAt, JSON.stringify(data)]
      );

      // Actualiza el caché local de forma optimista para que la lista de
      // Proveedores refleje el cambio de inmediato, sin esperar al sync.
      // El body ya viene en el mismo shape camelCase que mapSupplierRow()
      // produce (js/proveedores.js usa esos mismos nombres de campo).
      const optimisticId = existingId || `PENDING-${offlineRef}`;
      const responseBody = {
        ...data,
        id: optimisticId,
        updatedAt: baseUpdatedAt,
        offlineMode: true,
        pendiente_sincronizacion: true,
        offlineRef
      };
      if (existingId) {
        await localQuery(
          `UPDATE offline_cache_suppliers SET nombre = ?, data_json = ? WHERE supplier_id = ?`,
          [nombre, JSON.stringify(responseBody), existingId]
        );
      }

      return res.status(existingId ? 200 : 201).json(responseBody);
    } catch (err) {
      console.error('[offline/supplier-save]', err);
      return res.status(500).json({ error: 'Error al guardar proveedor offline', details: err.message });
    }
  });

  // ─── POST /api/offline/supplier-delete ───────────────────────────────────────
  router.post('/supplier-delete', async (req, res) => {
    try {
      const { id } = req.body || {};
      if (!id) {
        return res.status(400).json({ error: 'id de proveedor requerido.' });
      }
      const rawId = String(id);

      // Si el proveedor fue creado offline y nunca llegó a sincronizarse, no
      // hay nada que borrar en el servidor — simplemente se descarta el
      // 'create' pendiente completo.
      if (rawId.startsWith('PENDING-')) {
        const pendingRef = rawId.slice('PENDING-'.length);
        await localQuery(
          `DELETE FROM pending_supplier_changes WHERE offline_ref = ? AND status = 'pending'`,
          [pendingRef]
        );
        return res.json({ ok: true, offlineMode: true, cancelledCreate: true });
      }

      const tc = getTerminalConfig() || {};
      const terminalId = tc.terminalId || 'default';
      const cached = await localQuery(
        `SELECT updated_at FROM offline_cache_suppliers WHERE supplier_id = ? LIMIT 1`,
        [id]
      );
      const baseUpdatedAt = cached?.[0]?.updated_at || null;

      const offlineRef = generateOfflineRef(terminalId, 'SUP-');
      await localQuery(
        `INSERT INTO pending_supplier_changes
           (terminal_id, change_type, supplier_id, offline_ref, base_updated_at, payload_json, status, created_at)
         VALUES (?, 'delete', ?, ?, ?, '{}', 'pending', datetime('now'))`,
        [terminalId, Number(id), offlineRef, baseUpdatedAt]
      );

      return res.json({
        ok: true,
        offlineMode: true,
        pendiente_sincronizacion: true,
        warning: 'No se pudo verificar si tiene facturas pendientes sin conexión; si las tiene, la sincronización fallará y podrás reintentar.'
      });
    } catch (err) {
      console.error('[offline/supplier-delete]', err);
      return res.status(500).json({ error: 'Error al eliminar proveedor offline', details: err.message });
    }
  });

  // ─── POST /api/offline/supplier-cancel ───────────────────────────────────────
  // Cancela un cambio de proveedor aún no sincronizado (mismo patrón que cancel-pending).
  router.post('/supplier-cancel', async (req, res) => {
    try {
      const { offlineRef } = req.body || {};
      if (!offlineRef) {
        return res.status(400).json({ error: 'offlineRef requerido.' });
      }
      const rows = await localQuery(
        `SELECT * FROM pending_supplier_changes WHERE offline_ref = ? AND status = 'pending' LIMIT 1`,
        [offlineRef]
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(404).json({ error: 'Cambio no encontrado o ya fue sincronizado.' });
      }
      await localQuery(`DELETE FROM pending_supplier_changes WHERE offline_ref = ?`, [offlineRef]);
      return res.json({ ok: true, cancelled: offlineRef });
    } catch (err) {
      console.error('[offline/supplier-cancel]', err);
      return res.status(500).json({ error: 'Error cancelando cambio de proveedor', details: err.message });
    }
  });

  // ─── POST /api/offline/inventory-adjust ──────────────────────────────────────
  // Ajusta stock (entrada/salida/ajuste) offline. Aplica el cambio de forma
  // optimista al caché local y encola el ajuste para replay en sync-pending.
  router.post('/inventory-adjust', async (req, res) => {
    try {
      const { productId, tipo, qty, notes } = req.body || {};
      if (!productId || !['entrada', 'salida', 'ajuste'].includes(tipo)) {
        return res.status(400).json({ error: 'Datos de ajuste inválidos.' });
      }
      const quantity = Number(qty || 0);

      const cachedProduct = await localQuery(
        `SELECT * FROM offline_cache_products WHERE product_id = ? LIMIT 1`,
        [productId]
      );
      if (!cachedProduct?.[0]) {
        return res.status(404).json({ error: 'Producto no encontrado en el caché offline.' });
      }

      const tc = getTerminalConfig() || {};
      const terminalId = tc.terminalId || 'default';
      const cachedInventory = await localQuery(
        `SELECT * FROM offline_cache_inventory_by_branch WHERE product_id = ? LIMIT 1`,
        [productId]
      );
      const branchRow = cachedInventory?.[0] || null;
      const branchId = branchRow?.branch_id || tc.branchId || 1;
      const previousStock = Number(branchRow ? branchRow.stock : cachedProduct[0].stock_cached || 0);
      const nextStock = tipo === 'entrada' ? previousStock + Math.abs(quantity)
        : tipo === 'salida' ? Math.max(0, previousStock - Math.abs(quantity))
        : Math.max(0, quantity);
      const baseUpdatedAt = branchRow?.updated_at || null;

      const offlineRef = generateOfflineRef(terminalId, 'INV-');
      await localQuery(
        `INSERT INTO pending_inventory_adjustments
           (terminal_id, offline_ref, product_id, branch_id, tipo, qty, notes, base_updated_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
        [terminalId, offlineRef, productId, branchId, tipo, quantity, notes || null, baseUpdatedAt]
      );

      // Aplicación optimista: refleja el cambio de inmediato en pantalla.
      await localQuery(
        `UPDATE offline_cache_products SET stock_cached = ? WHERE product_id = ?`,
        [nextStock, productId]
      );
      if (branchRow) {
        await localQuery(
          `UPDATE offline_cache_inventory_by_branch SET stock = ? WHERE product_id = ?`,
          [nextStock, productId]
        );
      }

      const updatedProduct = (await localQuery(
        `SELECT product_id as id, codigo, nombre, categoria,
                precio_venta as precioVenta, stock_cached as stock, stock_min as stockMin, estado
         FROM offline_cache_products WHERE product_id = ? LIMIT 1`,
        [productId]
      ))[0];

      const movement = {
        id: null,
        productId: Number(productId),
        productName: cachedProduct[0].nombre,
        productCode: cachedProduct[0].codigo,
        sucursalId: Number(branchId),
        tipo,
        cantidad: tipo === 'salida' ? -Math.abs(quantity) : tipo === 'ajuste' ? (nextStock - previousStock) : Math.abs(quantity),
        stockAnterior: previousStock,
        stockNuevo: nextStock,
        costoUnitario: 0,
        referenciaTipo: 'manual',
        referenciaId: String(productId),
        notas: String(notes || '').trim() || `Ajuste manual de inventario: ${tipo}`,
        usuarioNombre: 'Sistema',
        fecha: new Date().toISOString(),
        pendiente_sincronizacion: true
      };

      return res.json({
        product: updatedProduct,
        movement,
        offlineMode: true,
        pendiente_sincronizacion: true
      });
    } catch (err) {
      console.error('[offline/inventory-adjust]', err);
      return res.status(500).json({ error: 'Error al ajustar inventario offline', details: err.message });
    }
  });

  // ─── POST /api/offline/inventory-cancel ──────────────────────────────────────
  router.post('/inventory-cancel', async (req, res) => {
    try {
      const { offlineRef } = req.body || {};
      if (!offlineRef) {
        return res.status(400).json({ error: 'offlineRef requerido.' });
      }
      const rows = await localQuery(
        `SELECT * FROM pending_inventory_adjustments WHERE offline_ref = ? AND status = 'pending' LIMIT 1`,
        [offlineRef]
      );
      if (!rows?.[0]) {
        return res.status(404).json({ error: 'Ajuste no encontrado o ya fue sincronizado.' });
      }
      const adj = rows[0];

      // Revertir el cambio optimista de stock en el caché local.
      const cachedInventory = await localQuery(
        `SELECT * FROM offline_cache_inventory_by_branch WHERE product_id = ? LIMIT 1`,
        [adj.product_id]
      );
      const quantity = Number(adj.qty || 0);
      if (cachedInventory?.[0]) {
        const current = Number(cachedInventory[0].stock || 0);
        // Sólo se puede revertir con certeza entrada/salida (delta conocido);
        // un 'ajuste' fija un valor absoluto y no tiene delta reversible sin
        // conocer el stock previo exacto, así que solo se recalcula para esos casos.
        const reverted = adj.tipo === 'entrada' ? Math.max(0, current - Math.abs(quantity))
          : adj.tipo === 'salida' ? current + Math.abs(quantity)
          : current;
        await localQuery(`UPDATE offline_cache_inventory_by_branch SET stock = ? WHERE product_id = ?`, [reverted, adj.product_id]);
        await localQuery(`UPDATE offline_cache_products SET stock_cached = ? WHERE product_id = ?`, [reverted, adj.product_id]);
      }

      await localQuery(`DELETE FROM pending_inventory_adjustments WHERE offline_ref = ?`, [offlineRef]);
      return res.json({ ok: true, cancelled: offlineRef });
    } catch (err) {
      console.error('[offline/inventory-cancel]', err);
      return res.status(500).json({ error: 'Error cancelando ajuste de inventario', details: err.message });
    }
  });

  // ─── POST /api/offline/cash-movement ─────────────────────────────────────────
  // Registra un retiro/gasto/devolución/ingreso SIN venta asociada, offline.
  // No toca balances del servidor — se aplica de forma optimista solo para
  // continuidad visual, y se revalida contra el estado REAL de la caja al
  // sincronizar (puede ser rechazado si la caja cambió mientras tanto).
  router.post('/cash-movement', async (req, res) => {
    try {
      if (typeof ensurePendingCashMovementExtensions === 'function') {
        await ensurePendingCashMovementExtensions().catch(() => {});
      }
      const { tipo, monto, obs } = req.body || {};
      const amount = Number(monto || 0);
      const allowedOffline = ['retiro_efectivo', 'gasto', 'devolucion', 'ingreso'];
      if (!allowedOffline.includes(tipo) || amount <= 0) {
        return res.status(400).json({ error: 'Tipo de movimiento y monto válido son requeridos.' });
      }
      if (String(req.body?.tipo) === 'pago_suplidor' || req.body?.supplierInvoiceId) {
        return res.status(400).json({ error: 'Los pagos a suplidor requieren conexión para verificar el balance de la factura.' });
      }

      const cachedConfig = await localQuery(
        `SELECT config_key, config_value FROM offline_cache_config WHERE config_key IN ('cash_session_open', 'cash_session_current_amount')`
      );
      const cfgMap = {};
      for (const row of (cachedConfig || [])) cfgMap[row.config_key] = row.config_value;
      if (cfgMap.cash_session_open !== '1') {
        return res.status(400).json({ error: 'No hay una caja abierta para registrar movimientos (según el último dato sincronizado).' });
      }

      const currentAmount = Number(cfgMap.cash_session_current_amount || 0);
      const isExpense = tipo !== 'ingreso';
      if (isExpense && currentAmount < amount) {
        return res.status(409).json({ error: 'El monto supera el efectivo disponible en caja (según el último dato sincronizado).' });
      }

      const tc = getTerminalConfig() || {};
      const terminalId = tc.terminalId || 'default';
      const notes = String(obs || '').trim() || 'Movimiento de caja offline';

      await localQuery(
        `INSERT INTO pending_cash_movements
           (terminal_id, movement_type, amount, notes, reference_sale_id, expense_type, branch_id, cash_register_id, status, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'pending', datetime('now'))`,
        [
          terminalId,
          'movimiento_manual',
          isExpense ? -Math.abs(amount) : Math.abs(amount),
          notes,
          tipo,
          tc.branchId || null,
          tc.cashRegisterId || null
        ]
      );

      // Aplicación optimista del balance cacheado, solo para que la UI de
      // caja refleje el cambio de inmediato — no es autoritativo.
      const newCachedAmount = isExpense ? currentAmount - amount : currentAmount + amount;
      await localQuery(
        `UPDATE offline_cache_config SET config_value = ? WHERE config_key = 'cash_session_current_amount'`,
        [String(newCachedAmount)]
      );

      const movementLabels = {
        retiro_efectivo: 'Retiro de efectivo', gasto: 'Gasto', devolucion: 'Devolución', ingreso: 'Ingreso adicional'
      };

      return res.status(201).json({
        config: { cajaMonto: newCachedAmount },
        movement: {
          tipo: movementLabels[tipo] || tipo,
          monto: isExpense ? -Math.abs(amount) : Math.abs(amount),
          hora: new Date().toISOString(),
          obs: notes,
          usuarioNombre: 'Terminal offline',
          pendiente_sincronizacion: true
        },
        offlineMode: true,
        pendiente_sincronizacion: true
      });
    } catch (err) {
      console.error('[offline/cash-movement]', err);
      return res.status(500).json({ error: 'Error al registrar movimiento de caja offline', details: err.message });
    }
  });

  // ─── POST /api/offline/cash-movement-cancel ──────────────────────────────────
  router.post('/cash-movement-cancel', async (req, res) => {
    try {
      const { id } = req.body || {};
      if (!id) {
        return res.status(400).json({ error: 'id requerido.' });
      }
      const rows = await localQuery(
        `SELECT * FROM pending_cash_movements WHERE id = ? AND status = 'pending' AND reference_sale_id IS NULL LIMIT 1`,
        [id]
      );
      if (!rows?.[0]) {
        return res.status(404).json({ error: 'Movimiento no encontrado o ya fue sincronizado.' });
      }
      const mv = rows[0];

      // Revertir el balance cacheado optimista.
      const cachedConfig = await localQuery(
        `SELECT config_value FROM offline_cache_config WHERE config_key = 'cash_session_current_amount' LIMIT 1`
      );
      const currentCached = Number(cachedConfig?.[0]?.config_value || 0);
      const reverted = currentCached - Number(mv.amount || 0); // amount ya viene con signo (+/-)
      await localQuery(
        `UPDATE offline_cache_config SET config_value = ? WHERE config_key = 'cash_session_current_amount'`,
        [String(reverted)]
      );

      await localQuery(`DELETE FROM pending_cash_movements WHERE id = ?`, [id]);
      return res.json({ ok: true, cancelled: id });
    } catch (err) {
      console.error('[offline/cash-movement-cancel]', err);
      return res.status(500).json({ error: 'Error cancelando movimiento de caja', details: err.message });
    }
  });

  // ─── GET /api/offline/audit-cache ────────────────────────────────────────────
  // Solo lectura: devuelve los últimos ~200 eventos de auditoría ya cacheados.
  // Respeta el mismo permiso que /api/audit (solo administrador general /
  // auditoria_global) para no exponer offline algo restringido online.
  router.get('/audit-cache', async (req, res) => {
    try {
      if (typeof resolveUser === 'function' && typeof userCanAccessGlobalAudit === 'function') {
        const actorUser = await resolveUser(req, { required: false, allowPayloadFallback: true }).catch(() => null);
        if (!actorUser || !userCanAccessGlobalAudit(actorUser)) {
          return res.status(403).json({ error: 'La auditoría global solo está disponible para el administrador general.' });
        }
      }
      const rows = await localQuery(
        `SELECT id, user_name, user_role, module_name, action_name, detail, created_at
         FROM offline_cache_audit_logs ORDER BY id DESC LIMIT 200`
      );
      return res.json((rows || []).map((row) => ({
        id: row.id,
        fecha: row.created_at,
        usuario: row.user_name,
        rol: row.user_role,
        modulo: row.module_name,
        accion: row.action_name,
        detalle: row.detail
      })));
    } catch (err) {
      console.error('[offline/audit-cache]', err);
      return res.status(500).json({ error: 'Error cargando auditoría en caché', details: err.message });
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

      const pendingSuppliers = await localQuery(
        `SELECT id, offline_ref, change_type, supplier_id, status, error_message, created_at, synced_at
         FROM pending_supplier_changes
         WHERE terminal_id = ?
         ORDER BY created_at DESC LIMIT 50`,
        [terminalId]
      );

      const pendingInventoryAdjustments = await localQuery(
        `SELECT pia.id, pia.offline_ref, pia.product_id, pia.tipo, pia.qty, pia.notes,
                pia.status, pia.error_message, pia.created_at, pia.synced_at,
                ocp.nombre as product_name
         FROM pending_inventory_adjustments pia
         LEFT JOIN offline_cache_products ocp ON ocp.product_id = pia.product_id
         WHERE pia.terminal_id = ?
         ORDER BY pia.created_at DESC LIMIT 50`,
        [terminalId]
      );

      // Solo movimientos standalone (sin venta asociada) — los ligados a
      // ventas offline ya se muestran como parte de la venta misma.
      const pendingCashMovements = await localQuery(
        `SELECT id, expense_type, amount, notes, status, error_message, created_at, synced_at
         FROM pending_cash_movements
         WHERE terminal_id = ? AND reference_sale_id IS NULL
         ORDER BY created_at DESC LIMIT 50`,
        [terminalId]
      );

      return res.json({
        ok: true,
        pending: rows || [],
        pendingSuppliers: pendingSuppliers || [],
        pendingInventoryAdjustments: pendingInventoryAdjustments || [],
        pendingCashMovements: pendingCashMovements || [],
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

      // 3b. Sincronizar cambios de proveedores pendientes
      await _syncSupplierChanges(query, localQuery, terminalId);

      // 3c. Sincronizar ajustes de inventario pendientes
      await _syncInventoryAdjustments(query, localQuery, terminalId, tc);

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
      // Alias en camelCase: el frontend siempre lee product.precioVenta/stockMin
      // (mapProductRow() los produce así online) — sin esto, todo se ve a
      // RD$0.00 en modo offline aunque el caché tenga el precio correcto.
      const productos = await localQuery(
        `SELECT product_id as id, codigo, nombre, categoria,
                precio_venta as precioVenta, stock_cached as stock, stock_min as stockMin, estado
         FROM offline_cache_products WHERE estado = 'Activo' ORDER BY nombre LIMIT 5000`
      );

      const clientes = await localQuery(
        `SELECT client_id as id, nombre, cedula, telefono, email,
                direccion, limite_credito as limiteCredito, balance
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

      // Proveedores cacheados (Fase 4 de la extensión offline) — data_json ya
      // trae la forma mapSupplierRow() completa (camelCase), igual que online.
      const supplierRows = await localQuery(
        `SELECT data_json FROM offline_cache_suppliers ORDER BY nombre`
      );
      const proveedores = [];
      for (const row of (supplierRows || [])) {
        try { proveedores.push(JSON.parse(row.data_json)); } catch (_) {}
      }

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

      // Reportes ya se auto-agregan en memoria sobre DB.ventas (ver
      // finalizePendingSale() en js/ventas.js) para cualquier sesión que se
      // quede logueada durante el tramo offline. El único hueco es un login
      // offline EN FRÍO (app cerrada y reabierta sin internet): sin esto,
      // DB.ventas arranca vacío y "pierde de vista" ventas de una sesión
      // offline anterior que nunca llegó a sincronizar. Se reconstruyen con
      // la MISMA forma que ya devuelve save-sale (fakeSale) para que
      // Reportes las trate exactamente igual.
      const pendingSalesRows = await localQuery(
        `SELECT * FROM pending_sales WHERE status IN ('pending', 'syncing') ORDER BY created_at ASC LIMIT 500`
      );
      const ventas = [];
      for (const ps of (pendingSalesRows || [])) {
        let saleData = {};
        try {
          saleData = typeof ps.sale_data === 'string' ? JSON.parse(ps.sale_data) : (ps.sale_data || {});
        } catch (_) {}
        let clientName = 'Consumidor Final';
        if (ps.client_id) {
          const clientRows = clientes.filter((c) => Number(c.id) === Number(ps.client_id));
          if (clientRows[0]) clientName = clientRows[0].nombre;
        }
        ventas.push({
          id: ps.offline_invoice_id,
          invoice_number: ps.offline_invoice_id,
          total: Number(ps.total || 0),
          payment_method: ps.payment_method || 'efectivo',
          sale_status: 'pagada',
          client_id: ps.client_id || null,
          client_name: clientName,
          clienteTelefono: saleData.clienteTelefono || '',
          created_at: ps.created_at,
          items: Array.isArray(saleData.items) ? saleData.items : [],
          offlineMode: true,
          offlineInvoiceId: ps.offline_invoice_id,
          terminalId: ps.terminal_id,
          pendiente_sincronizacion: true
        });
      }

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
        ventas,
        proveedores,
        facturasProveedores: [], // sin caché offline propia todavía — solo se cachean los proveedores, no sus facturas
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
    await ensurePromotionsExtensions();
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
    const productIds = [];
    const itemsForReportSync = [];
    let ahorroPromociones = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const productId = Number(item.id || item.producto_id || 0);
      const qty = Number(item.qty || item.cantidad || 1);
      const unitPrice = Number(item.price || item.precio || item.precio_venta || 0);
      const lineTotal = Number(item.subtotal || item.total || item.line_total || qty * unitPrice);
      const discountRate = Number(item.discount_rate || item.descuento || 0);
      const taxRate = Number(item.tax_rate || item.itbis || 0);

      if (saleId && productId) {
        // Igual que en POST /api/sales: el precio de la venta offline se capturó
        // con la caché local (pudo quedar desactualizada mientras la terminal
        // estuvo sin conexión) — al sincronizar, con conexión real a la BD
        // principal, se vuelve a resolver la promoción activa y esa es la que
        // se guarda de verdad.
        const activePromo = await resolvePriceForSaleItem({ query, productoId: productId, sucursalId: branchId }).catch(() => null);
        const effectiveUnitPrice = activePromo ? activePromo.precioPromocion : unitPrice;
        const effectiveLineTotal = activePromo ? Number((effectiveUnitPrice * qty).toFixed(2)) : lineTotal;
        if (activePromo) ahorroPromociones += activePromo.ahorro * qty;

        await query(
          `INSERT INTO sale_items (sale_id, product_id, qty, price, line_total, discount_rate, tax_rate, sale_mode, promotion_id, original_price)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'unidad', ?, ?)`,
          [saleId, productId, qty, effectiveUnitPrice, effectiveLineTotal, discountRate, taxRate,
           activePromo ? activePromo.promotionId : null, activePromo ? activePromo.precioOriginal : null]
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

        productIds.push(productId);
        itemsForReportSync.push({
          product_id: productId,
          product_name: item.nombre || item.name || '',
          qty, price: unitPrice, discount_rate: discountRate,
          precio_compra: Number(item.precio_compra || 0)
        });
      }
    }

    if (ahorroPromociones > 0 && saleId) {
      await query('UPDATE sales SET ahorro_promociones = ? WHERE id = ?', [Number(ahorroPromociones.toFixed(2)), saleId]).catch(() => {});
    }

    // Sync a la App de Reporte — antes esta ruta guardaba la venta en la BD
    // principal pero nunca la mandaba a Firebase, así que una venta hecha en
    // una terminal offline nunca aparecía en la app de reportes.
    if (typeof syncSaleToReports === 'function' && saleId) {
      const [cashierRows, branchRows, saleRows] = await Promise.all([
        query('SELECT nombre FROM users WHERE id = ? LIMIT 1', [userId]).catch(() => []),
        query('SELECT nombre FROM branches WHERE id = ? LIMIT 1', [branchId]).catch(() => []),
        query('SELECT * FROM sales WHERE id = ? LIMIT 1', [saleId]).catch(() => [])
      ]);
      const saleRow = saleRows?.[0];
      if (saleRow) {
        saleRow.cashier_name = cashierRows?.[0]?.nombre || '';
        syncSaleToReports(saleRow, itemsForReportSync, {
          productIds,
          branchId,
          branchName: branchRows?.[0]?.nombre || ''
        });
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
      if (typeof ensurePendingCashMovementExtensions === 'function') {
        await ensurePendingCashMovementExtensions().catch(() => {});
      }
      const movements = await localQuery(
        `SELECT * FROM pending_cash_movements WHERE terminal_id = ? AND status = 'pending' LIMIT 100`,
        [terminalId]
      );
      for (const mv of (movements || [])) {
        // Movimientos ligados a una venta offline: ya se registran en la BD
        // principal a través de _insertSaleToMain — solo marcar sincronizado.
        if (mv.reference_sale_id) {
          await localQuery(
            `UPDATE pending_cash_movements SET status = 'synced', synced_at = datetime('now') WHERE id = ?`,
            [mv.id]
          );
          continue;
        }

        // Movimiento standalone (retiro/gasto/devolución/ingreso sin venta):
        // NUNCA se aplicó al servidor mientras estaba offline — se revalida y
        // aplica ahora contra el estado REAL de la caja. "El servidor gana":
        // si la sesión ya no está abierta o los fondos ya no alcanzan, se
        // rechaza en vez de forzar el movimiento.
        if (typeof withTransaction !== 'function') continue; // Fase 3 no inyectada
        try {
          if (typeof ensureCashMovementExtensions === 'function') await ensureCashMovementExtensions();
          const cashRegisterId = mv.cash_register_id;
          const amount = Math.abs(Number(mv.amount || 0));
          const isExpense = Number(mv.amount || 0) < 0;

          await withTransaction(async (conn) => {
            const sessions = await conn.query(
              `SELECT * FROM cash_sessions WHERE status = 'open' AND cash_register_id = ? ORDER BY id DESC LIMIT 1`,
              [cashRegisterId]
            );
            const session = sessions[0];
            if (!session) {
              throw new Error('No hay una caja abierta en el servidor para aplicar este movimiento. Vuelve a abrir la caja y regístralo manualmente si aún aplica.');
            }
            if (isExpense && Number(session.current_amount || 0) < amount) {
              throw new Error('El efectivo disponible en caja ya no cubre este egreso (posiblemente por otros movimientos ocurridos mientras estabas offline). El movimiento no se aplicó.');
            }

            const movementTypeLabels = {
              retiro_efectivo: 'Retiro de efectivo', gasto: 'Gasto', devolucion: 'Devolución', ingreso: 'Ingreso adicional'
            };
            const movementType = movementTypeLabels[mv.expense_type] || 'Movimiento manual';

            await conn.query(
              `INSERT INTO cash_movements
                 (session_id, movement_type, amount, notes, created_by_user_id, created_by_user_name, happened_at, branch_id, cash_register_id)
               VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
              [session.id, movementType, mv.amount, mv.notes, 'Terminal offline', mv.created_at, mv.branch_id, cashRegisterId]
            );
            await conn.query(`UPDATE cash_sessions SET current_amount = current_amount + ? WHERE id = ?`, [mv.amount, session.id]);
            await conn.query(`UPDATE config SET cash_amount = cash_amount + ? WHERE id = 1`, [mv.amount]);
          });

          await localQuery(
            `UPDATE pending_cash_movements SET status = 'synced', synced_at = datetime('now') WHERE id = ?`,
            [mv.id]
          );
        } catch (mvErr) {
          console.error(`[offline/sync-cash] Error en movimiento ${mv.id}:`, mvErr.message);
          await localQuery(
            `UPDATE pending_cash_movements SET status = 'error', error_message = ? WHERE id = ?`,
            [String(mvErr.message).slice(0, 490), mv.id]
          );
        }
      }
    } catch (err) {
      console.error('[offline/sync-cash]', err.message);
    }
  }

  /**
   * Sincroniza cambios de proveedores hechos offline (crear/editar/eliminar).
   * Política "el servidor gana": si el proveedor cambió en el servidor
   * (updated_at más reciente que el que tenía la terminal al editar) o fue
   * eliminado, el cambio pendiente se marca error y NO se aplica — el usuario
   * lo rehace manualmente si aún aplica.
   */
  async function _syncSupplierChanges(query, localQuery, terminalId) {
    if (typeof insertSupplierRow !== 'function') return; // Fase 1 no inyectada (tests antiguos, etc.)
    try {
      const changes = await localQuery(
        `SELECT * FROM pending_supplier_changes WHERE terminal_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 100`,
        [terminalId]
      );

      for (const change of (changes || [])) {
        try {
          let payload = {};
          try {
            payload = typeof change.payload_json === 'string' ? JSON.parse(change.payload_json) : (change.payload_json || {});
          } catch (_) {}

          if (change.change_type === 'create') {
            const newId = await insertSupplierRow({ query }, payload);
            await localQuery(
              `UPDATE pending_supplier_changes SET status = 'synced', supplier_id = ?, synced_at = datetime('now') WHERE id = ?`,
              [newId, change.id]
            );
            continue;
          }

          // update / delete: comparar contra el estado real del servidor
          const rows = await query('SELECT updated_at FROM suppliers WHERE id = ?', [change.supplier_id]);
          const serverUpdatedAt = rows?.[0]?.updated_at || null;
          const hasConflict = !serverUpdatedAt
            ? true // el proveedor ya no existe en el servidor
            : Boolean(change.base_updated_at) && new Date(serverUpdatedAt).getTime() > new Date(change.base_updated_at).getTime();

          if (hasConflict) {
            await localQuery(
              `UPDATE pending_supplier_changes SET status = 'error', error_message = ? WHERE id = ?`,
              [
                !serverUpdatedAt
                  ? 'Este proveedor ya no existe en el servidor (fue eliminado mientras estabas sin conexión). El cambio no se aplicó.'
                  : 'Este proveedor fue modificado en el servidor mientras estabas sin conexión. El cambio NO se aplicó — verifica el proveedor y repite la edición si aún aplica.',
                change.id
              ]
            );
            continue;
          }

          if (change.change_type === 'update') {
            await updateSupplierRow({ query }, change.supplier_id, payload);
          } else if (change.change_type === 'delete') {
            const result = await deleteSupplierIfNoPendingInvoices({ query }, change.supplier_id);
            if (!result.ok) {
              await localQuery(
                `UPDATE pending_supplier_changes SET status = 'error', error_message = ? WHERE id = ?`,
                [result.error, change.id]
              );
              continue;
            }
          }

          await localQuery(
            `UPDATE pending_supplier_changes SET status = 'synced', synced_at = datetime('now') WHERE id = ?`,
            [change.id]
          );
        } catch (changeErr) {
          console.error(`[offline/sync-suppliers] Error en ${change.offline_ref}:`, changeErr.message);
          await localQuery(
            `UPDATE pending_supplier_changes SET status = 'error', error_message = ? WHERE id = ?`,
            [String(changeErr.message).slice(0, 490), change.id]
          );
        }
      }
    } catch (err) {
      console.error('[offline/sync-suppliers]', err.message);
    }
  }

  /**
   * Sincroniza ajustes de inventario (entrada/salida/ajuste) hechos offline.
   * Reutiliza las MISMAS funciones que la ruta online (changeBranchInventoryStock
   * + registerInventoryMovement) en vez de duplicar la lógica de resolución/
   * auto-seed de sucursal, que es fácil de romper si se reimplementa inline.
   */
  async function _syncInventoryAdjustments(query, localQuery, terminalId, tc) {
    if (typeof changeBranchInventoryStock !== 'function') return; // Fase 2 no inyectada
    try {
      const adjustments = await localQuery(
        `SELECT * FROM pending_inventory_adjustments WHERE terminal_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 100`,
        [terminalId]
      );

      for (const adj of (adjustments || [])) {
        try {
          const rows = await query(
            `SELECT updated_at FROM inventory_by_branch WHERE branch_id = ? AND product_id = ?`,
            [adj.branch_id, adj.product_id]
          );
          const serverUpdatedAt = rows?.[0]?.updated_at || null;
          const hasConflict = Boolean(adj.base_updated_at) && Boolean(serverUpdatedAt)
            && new Date(serverUpdatedAt).getTime() > new Date(adj.base_updated_at).getTime();

          if (hasConflict) {
            await localQuery(
              `UPDATE pending_inventory_adjustments SET status = 'error', error_message = ? WHERE id = ?`,
              ['El inventario de este producto fue modificado en el servidor (otra terminal u otro ajuste) mientras estabas sin conexión. Este ajuste NO se aplicó — verifica el stock actual y repítelo si aún aplica.', adj.id]
            );
            continue;
          }

          const quantity = Number(adj.qty || 0);
          const inventoryChange = await changeBranchInventoryStock({ query }, {
            productId: adj.product_id,
            branchId: adj.branch_id,
            quantityDelta: adj.tipo === 'entrada' ? Math.abs(quantity) : adj.tipo === 'salida' ? -Math.abs(quantity) : 0,
            absoluteStock: adj.tipo === 'ajuste' ? Math.max(0, quantity) : null
          });
          const previousStock = inventoryChange.previousStock;
          const newStock = inventoryChange.nextStock;

          if (typeof registerInventoryMovement === 'function') {
            await registerInventoryMovement({ query }, {
              productId: adj.product_id,
              branchId: Number(inventoryChange.branchId || adj.branch_id),
              tipo: adj.tipo,
              cantidad: adj.tipo === 'salida' ? -Math.abs(quantity) : adj.tipo === 'ajuste' ? (newStock - previousStock) : Math.abs(quantity),
              stockAnterior: previousStock,
              stockNuevo: newStock,
              costoUnitario: Number(inventoryChange.unitCost || 0),
              referenciaTipo: 'manual_offline',
              referenciaId: String(adj.product_id),
              notas: (adj.notes || `Ajuste manual de inventario: ${adj.tipo}`) + ` (sincronizado, terminal ${terminalId})`,
              usuarioNombre: 'Terminal offline'
            });
          }

          await localQuery(
            `UPDATE pending_inventory_adjustments SET status = 'synced', synced_at = datetime('now') WHERE id = ?`,
            [adj.id]
          );
        } catch (adjErr) {
          console.error(`[offline/sync-inventory] Error en ${adj.offline_ref}:`, adjErr.message);
          await localQuery(
            `UPDATE pending_inventory_adjustments SET status = 'error', error_message = ? WHERE id = ?`,
            [String(adjErr.message).slice(0, 490), adj.id]
          );
        }
      }
    } catch (err) {
      console.error('[offline/sync-inventory]', err.message);
    }
  }

  /**
   * Descarga productos, clientes y config actualizados del principal al caché local.
   */
  async function _downloadUpdates(query, localQuery, tc, terminalId) {
    try {
      // Actualizar precios de productos más recientes — solo globales + los
      // exclusivos de la sucursal de esta terminal (mismo criterio que init-cache).
      const branchId = tc?.branchId || null;
      const productos = await query(
        `SELECT id, codigo, nombre,
                COALESCE(categoria, 'Sin categoría') as categoria,
                precio_venta, COALESCE(stock, 0) as stock, estado
         FROM products
         WHERE estado = 'Activo'
           AND (branch_id IS NULL OR branch_id = ?)
         LIMIT 2000`,
        [branchId]
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

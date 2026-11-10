'use strict';
// Construcción reutilizable sobre una conexión de lectura proporcionada por el llamador.
const crypto = require('crypto');
const catalog = require('./backup-catalog');
const BACKUP_MAGIC = 'TECNOCAJA_BACKUP_V1';
const BACKUP_FORMAT_VERSION = catalog.VERSION;

async function buildFullPayload(query, options = {}) {
  const capturedAt = new Date().toISOString();
  // Tablas cuyo fallo de lectura NO debe producir un respaldo "exitoso" con
  // datos vacíos. Si una de estas falla (pool cerrándose, conexión caída al
  // cerrar la app, etc.), abortamos en vez de subir/guardar un .tcbak vacío
  // que luego reemplaza respaldos buenos por rotación (pruneCloudBackups).
  const CRITICAL_TABLES = new Set(['config', 'users', 'products', 'clients']);
  const failedCritical = [];

  const safeQuery = async (sql, params = [], tableLabel = '') => {
    try { return await query(sql, params); }
    catch (e) {
      if (CRITICAL_TABLES.has(tableLabel)) failedCritical.push({ table: tableLabel, error: e.message });
      return [];
    }
  };

  const [
    config, users, categories, products, clients,
    suppliers, supplierInvoices,
    cashSessions, cashMovements,
    sales, saleItems,
    auditLogs, suspendedSales, quotations,
    ncfSequences, pendingSales,
    tables, paymentMethods, branches, cashRegisters,
    inventoryByBranch, inventoryMovements, branchTransfers, branchTransferItems,
    syncOutbox, syncCursors, syncConflictos, ncfRangosCentral,
    productComboItems, customCombos,
  ] = await Promise.all([
    safeQuery('SELECT * FROM config', [], 'config'),
    safeQuery('SELECT * FROM users', [], 'users'),
    safeQuery('SELECT * FROM categories'),
    safeQuery('SELECT * FROM products', [], 'products'),
    safeQuery('SELECT * FROM clients', [], 'clients'),
    safeQuery('SELECT * FROM suppliers LIMIT 5000'),
    safeQuery('SELECT * FROM supplier_invoices LIMIT 10000'),
    safeQuery('SELECT * FROM cash_sessions LIMIT 3000'),
    safeQuery('SELECT * FROM cash_movements LIMIT 50000'),
    safeQuery('SELECT * FROM sales LIMIT 200000'),
    safeQuery('SELECT * FROM sale_items LIMIT 500000'),
    safeQuery('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 5000'),
    safeQuery('SELECT * FROM suspended_sales LIMIT 1000'),
    safeQuery('SELECT * FROM quotations LIMIT 3000'),
    safeQuery('SELECT * FROM ncf_sequences LIMIT 1000'),
    safeQuery('SELECT * FROM pending_sales LIMIT 2000'),
    safeQuery('SELECT * FROM dining_tables LIMIT 500'),
    safeQuery('SELECT * FROM payment_methods'),
    safeQuery('SELECT * FROM branches'),
    safeQuery('SELECT * FROM cash_registers'),
    safeQuery('SELECT * FROM inventory_by_branch LIMIT 200000'),
    safeQuery('SELECT * FROM inventory_movements LIMIT 500000'),
    safeQuery('SELECT * FROM branch_transfers LIMIT 50000'),
    safeQuery('SELECT * FROM branch_transfer_items LIMIT 200000'),
    // Multisucursal: lo que todavía no confirmó la central, por dónde va cada
    // descarga, lo que espera "Vincular" y los rangos NCF que asignó la central.
    safeQuery("SELECT * FROM sync_outbox WHERE status <> 'sincronizado' LIMIT 200000"),
    safeQuery('SELECT * FROM sync_cursors'),
    safeQuery("SELECT * FROM sync_conflictos WHERE estado = 'pendiente' LIMIT 50000"),
    safeQuery('SELECT * FROM ncf_rangos_central'),
    // Combos promocionales: qué productos lleva cada combo.
    safeQuery('SELECT * FROM product_combo_items'),
    // Combos personalizados de precio fijo (las ventas guardan su foto en sale_items).
    safeQuery('SELECT * FROM custom_combos'),
  ]);

  if (failedCritical.length) {
    const detail = failedCritical.map(f => `${f.table}: ${f.error}`).join(' | ');
    throw new Error(`Respaldo abortado — no se pudieron leer tablas críticas (${detail}). No se guardó ningún archivo para evitar un respaldo vacío.`);
  }

  // Config como mapa para metadatos
  const cfgMap = {};
  (config || []).forEach(r => {
    const k = r.clave || r.config_key || '';
    const v = r.valor || r.config_value || r.value || '';
    if (k) cfgMap[k] = v;
    // columnas directas del row (tabla config tiene columnas planas)
    Object.keys(r).forEach(col => { if (!cfgMap[col]) cfgMap[col] = r[col]; });
  });

  const businessName = cfgMap.business_name || cfgMap.nombre_negocio || cfgMap.businessName || 'TecnoCaja';
  const businessId   = cfgMap.business_id   || cfgMap.businessId    || '';
  const rnc          = cfgMap.rnc            || '';
  const sysVersion   = process.env.npm_package_version || '1.0.0';

  const payload = {
    magic:          BACKUP_MAGIC,
    formatVersion:  BACKUP_FORMAT_VERSION,
    exportedAt:     capturedAt,
    timezone:       'America/Santo_Domingo',
    businessName,
    businessId,
    rnc,
    systemVersion:  sysVersion,
    stats: {
      productos:   (products    || []).length,
      clientes:    (clients     || []).length,
      ventas:      (sales       || []).length,
      usuarios:    (users       || []).length,
      categorias:  (categories  || []).length,
      facturas:    (saleItems   || []).length,
      proveedores: (suppliers   || []).length,
      inventario:  (inventoryByBranch || []).length,
      movimientosInventario: (inventoryMovements || []).length,
    },
    data: {
      config, users, categories, products, clients,
      suppliers, supplierInvoices,
      cashSessions, cashMovements,
      sales, saleItems,
      auditLogs, suspendedSales, quotations,
      ncfSequences, pendingSales,
      tables, paymentMethods, branches, cashRegisters,
      inventoryByBranch, inventoryMovements, branchTransfers, branchTransferItems,
      syncOutbox, syncCursors, syncConflictos, ncfRangosCentral,
      productComboItems, customCombos,
    },
  };
  payload.catalogo = await catalog.capturarCatalogo(query);
  payload.archivos = await require('./backup-components').capturar({ components: options.components || (options.inSnapshot ? require('./backup-components').defaultComponents() : []) });
  payload.backupId = crypto.randomUUID();
  const identity = await require('./backup-policy').context(query);
  payload.licenseUid = String(options.licenseUid ?? identity.licenseUid ?? '').trim() || null;
  payload.identityNeedsReview = identity.conflict;
  payload.companyUuid = String(cfgMap.business_uuid || '').trim() || null;
  payload.snapshot = { capturedAt, finishedAt: new Date().toISOString(), consistent: Boolean(options.inSnapshot), strategy: options.inSnapshot ? 'database_snapshot' : 'caller_managed' };
  const pendientes = new Set(payload.catalogo.requiereReconfiguracion);
  // Los aliases mantienen el importador anterior; tampoco deben contener claves.
  for (const [key, rows] of Object.entries(payload.data)) {
    if (Array.isArray(rows)) payload.data[key] = rows.map((r) => catalog.limpiarFila(key === 'users' ? 'users' : key, r, pendientes)).filter(Boolean);
  }
  payload.catalogo.requiereReconfiguracion = [...pendientes].sort();
  return payload;
}


module.exports = { buildFullPayload };

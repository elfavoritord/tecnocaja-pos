'use strict';

/**
 * compras.routes.js — Compras de proveedores y cuentas por pagar.
 * Factory con dependencias inyectadas, igual que tesoreria.routes.js/rrhh.routes.js.
 *
 * Toda compra se registra por server/services/compras/compras.service.js
 * (pantalla clásica, «Preparar compra» y, en el futuro, el Portal de
 * Contadores): idempotente por uuid, sin facturas duplicadas, con productos
 * nuevos creados solos, inventario solo para lo que lo controla y según la
 * modalidad de recepción del negocio. Genera su cuenta por pagar en
 * supplier_invoices/supplier_payments como siempre.
 *
 * La contabilidad NO vive aquí (es del Portal de Contadores). Una compra al
 * contado se marca pagada sin descontar Tesorería/Caja General.
 *
 * Rutas:
 *  POST   /api/purchases                         registrar (formulario clásico o líneas nuevas)
 *  GET    /api/purchases?supplierId=&branchId=&desde=&hasta=&estado=
 *  GET    /api/purchases/accounts-payable?supplierId=
 *  GET    /api/purchases/config | PUT /api/purchases/config
 *  POST   /api/purchases/import                  XML e-CF, Excel/CSV, foto o PDF → borradores
 *  GET    /api/purchases/drafts | POST /api/purchases/drafts
 *  GET    /api/purchases/drafts/:id | PUT | DELETE
 *  POST   /api/purchases/drafts/:id/registrar
 *  GET    /api/purchases/documents/:id
 *  GET    /api/purchases/receipts/pending
 *  POST   /api/purchases/:id/receipts            recibir mercancía (total o parcial)
 *  GET    /api/purchases/:id
 *  POST   /api/purchases/:id/void
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { getDbClient } = require('../../db');
const { ensureComprasFaseA } = require('../services/compras/esquema');
const { crearServicioCompras } = require('../services/compras/compras.service');
const { leerXmlEcf } = require('../services/compras/lector-xml-ecf');
const { leerTabla } = require('../services/compras/lector-tabla');

const MAX_ARCHIVO = 5 * 1024 * 1024;
const TIPOS_ADJUNTO = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' };

function syncContabilidadFireAndForget(reason) {
  try {
    require('../sync/sync-pos-stats').syncPosStatsToFirestore()
      .catch((error) => console.warn(`[compras][sync-contable] ${reason}:`, error.message));
  } catch (error) {
    console.warn(`[compras][sync-contable] ${reason}:`, error.message);
  }
}

async function hasColumn(query, tableName, columnName) {
  // PRAGMA table_info() es solo de SQLite; en MySQL/MariaDB se usa SHOW COLUMNS.
  const rows = getDbClient() === 'mysql'
    ? await query(`SHOW COLUMNS FROM \`${tableName}\``).catch(() => [])
    : await query(`PRAGMA table_info(${tableName})`).catch(() => []);
  return rows.some((row) => String(row.name || row.Field || '').toLowerCase() === String(columnName).toLowerCase());
}

// Defensivo: la creación "oficial" de esta tabla vive en server.js
// (ensureSupplierPaymentsTable); si esa cadena no corrió completa, una compra
// al contado tronaba con "no such table: supplier_payments".
async function ensureSupplierPaymentsTableLocal(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS supplier_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INT NOT NULL,
      invoice_id INT DEFAULT NULL,
      monto DECIMAL(12,2) NOT NULL,
      metodo_pago VARCHAR(50) NOT NULL DEFAULT 'Efectivo',
      fecha_pago DATE NOT NULL,
      notas VARCHAR(255) DEFAULT NULL,
      created_by VARCHAR(120) DEFAULT NULL,
      purchase_id INT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_sp_supplier (supplier_id),
      CONSTRAINT fk_sp_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
    )
  `).catch(() => {});
  await addColumnIfMissing(query, 'supplier_payments', 'purchase_id', 'INT DEFAULT NULL');
}

async function addColumnIfMissing(query, tableName, columnName, definition) {
  try {
    if (await hasColumn(query, tableName, columnName)) return;
    await query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    // Dos peticiones a la vez pueden agregar la misma columna: la segunda no es un error.
    const seIgnora = message.includes('no such table') || message.includes("doesn't exist") || message.includes('duplicate column');
    if (!seIgnora) throw error;
  }
}

async function ensureSchema(query, { withTransaction = null } = {}) {
  await query(`
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INT NOT NULL,
      supplier_invoice_id INT DEFAULT NULL,
      branch_id INT NOT NULL,
      numero_documento VARCHAR(60) NOT NULL,
      ncf VARCHAR(30) DEFAULT NULL,
      tipo_ncf VARCHAR(10) DEFAULT NULL,
      fecha_comprobante DATE NOT NULL,
      fecha_recepcion DATE NOT NULL,
      condicion_pago VARCHAR(20) NOT NULL DEFAULT 'contado',
      fecha_vencimiento DATE DEFAULT NULL,
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      descuento DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      itbis DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      estado VARCHAR(20) NOT NULL DEFAULT 'activa',
      notas VARCHAR(255) DEFAULT NULL,
      motivo_anulacion VARCHAR(255) DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      anulada_at DATETIME DEFAULT NULL,
      anulada_by_user_id INT DEFAULT NULL,
      anulada_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_purchases_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT,
      CONSTRAINT fk_purchases_invoice FOREIGN KEY (supplier_invoice_id) REFERENCES supplier_invoices(id) ON DELETE SET NULL
    )
  `);

  // product_id es opcional: una línea de servicio o gasto no es un producto.
  await query(`
    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INT NOT NULL,
      product_id INT DEFAULT NULL,
      codigo VARCHAR(60) NOT NULL,
      nombre VARCHAR(160) NOT NULL,
      cantidad DECIMAL(10,2) NOT NULL,
      costo_unitario DECIMAL(12,2) NOT NULL,
      itbis_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      subtotal DECIMAL(12,2) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_purchase_items_purchase FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
      CONSTRAINT fk_purchase_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
    )
  `);

  // Enlace de vuelta desde la cuenta por pagar/pago hacia la compra que los generó.
  await addColumnIfMissing(query, 'supplier_invoices', 'purchase_id', 'INT DEFAULT NULL');
  await addColumnIfMissing(query, 'supplier_payments', 'purchase_id', 'INT DEFAULT NULL');

  // Campos del Formato 606 de la DGII (server.js /api/reports/advanced/dgii/exportar-contador).
  // tipo_bienes_servicios: código 1-11 del 606 — 9 por defecto (costo de venta).
  await addColumnIfMissing(query, 'purchases', 'tipo_bienes_servicios', 'INT NOT NULL DEFAULT 9');
  await addColumnIfMissing(query, 'purchases', 'forma_pago', 'INT DEFAULT NULL');
  await addColumnIfMissing(query, 'purchases', 'itbis_retenido', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00');
  await addColumnIfMissing(query, 'purchases', 'isr_tipo_retencion', 'INT DEFAULT NULL');
  await addColumnIfMissing(query, 'purchases', 'isr_monto_retencion', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00');
  await addColumnIfMissing(query, 'purchases', 'ncf_modificado', 'VARCHAR(30) DEFAULT NULL');

  // Fase A: borradores, documentos, recepciones, equivalencias, historial de costo.
  await ensureComprasFaseA(query, { getDbClient, withTransaction });
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function mapPurchaseRow(row) {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    proveedor: row.supplier_name || '',
    supplierInvoiceId: row.supplier_invoice_id,
    branchId: row.branch_id,
    sucursal: row.branch_name || '',
    numeroDocumento: row.numero_documento,
    ncf: row.ncf || '',
    tipoNcf: row.tipo_ncf || '',
    fechaComprobante: row.fecha_comprobante,
    fechaRecepcion: row.fecha_recepcion,
    condicionPago: row.condicion_pago,
    fechaVencimiento: row.fecha_vencimiento,
    subtotal: Number(row.subtotal || 0),
    descuento: Number(row.descuento || 0),
    itbis: Number(row.itbis || 0),
    total: Number(row.total || 0),
    // Formato 606 DGII
    tipoBienesServicios: row.tipo_bienes_servicios != null ? Number(row.tipo_bienes_servicios) : 9,
    formaPago: row.forma_pago != null ? Number(row.forma_pago) : null,
    itbisRetenido: Number(row.itbis_retenido || 0),
    isrTipoRetencion: row.isr_tipo_retencion != null ? Number(row.isr_tipo_retencion) : null,
    isrMontoRetencion: Number(row.isr_monto_retencion || 0),
    ncfModificado: row.ncf_modificado || '',
    estado: row.estado,
    estadoInventario: row.estado_inventario || 'recibido_total',
    documentoOrigen: row.documento_origen || 'manual',
    encfProveedor: row.encf_proveedor || '',
    ajusteRedondeo: Number(row.ajuste_redondeo || 0),
    uuid: row.uuid || null,
    notas: row.notas || '',
    motivoAnulacion: row.motivo_anulacion || '',
    creadoPor: row.created_by_user_name || '',
    createdAt: row.created_at,
  };
}

function mapPurchaseItemRow(row) {
  return {
    id: row.id,
    productId: row.product_id,
    codigo: row.codigo,
    nombre: row.nombre,
    descripcion: row.descripcion || '',
    tipoLinea: row.tipo_linea || 'inventario',
    unidad: row.unidad || '',
    codigoProveedor: row.codigo_proveedor || '',
    cantidad: Number(row.cantidad || 0),
    cantidadRecibida: row.cantidad_recibida === null || row.cantidad_recibida === undefined ? null : Number(row.cantidad_recibida),
    costoUnitario: Number(row.costo_unitario || 0),
    descuento: Number(row.descuento || 0),
    itbisPct: Number(row.itbis_pct || 0),
    subtotal: Number(row.subtotal || 0),
    productoCreado: Boolean(Number(row.producto_creado || 0)),
  };
}

function mapDraftRow(row, { conPayload = false } = {}) {
  let payload = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch (_) { payload = {}; }
  const e = payload.encabezado || {};
  return {
    id: row.id, branchId: row.branch_id === null ? null : Number(row.branch_id), origen: row.origen, estado: row.estado,
    titulo: row.titulo || '', version: Number(row.version || 0), purchaseId: row.purchase_id ? Number(row.purchase_id) : null,
    proveedor: e.proveedor?.nombre || '', rnc: e.proveedor?.rnc || '', ncf: e.ncf || e.numeroDocumento || '', fecha: e.fechaComprobante || '',
    lineas: Array.isArray(payload.lineas) ? payload.lineas.length : 0, total: Number(payload.resumen?.total || 0),
    creadoPor: row.created_by_user_name || '', createdAt: row.created_at, updatedAt: row.updated_at,
    ...(conPayload ? { payload } : {}),
  };
}

// Formulario clásico de «Nueva compra» (productos ya existentes) → compra del servicio.
function payloadDesdeClasico(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) throw httpError('Agrega al menos un producto a la compra.');
  for (const it of items) {
    if (!it.productId) throw httpError('Todos los renglones deben tener un producto seleccionado.');
    if (!(Number(it.cantidad) > 0)) throw httpError(`Cantidad inválida para "${it.nombre || it.codigo || 'producto'}".`);
    if (!(Number(it.costoUnitario) >= 0)) throw httpError(`Costo inválido para "${it.nombre || it.codigo || 'producto'}".`);
  }
  return {
    uuid: data.uuid || null,
    encabezado: {
      proveedor: { id: Number(data.supplierId || 0) || null },
      numeroDocumento: String(data.numeroDocumento || '').trim(), ncf: String(data.ncf || '').trim(), tipoComprobante: String(data.tipoNcf || '').trim(),
      fechaComprobante: String(data.fechaComprobante || '').trim(), fechaRecepcion: String(data.fechaRecepcion || '').trim(),
      condicionPago: data.condicionPago === 'credito' ? 'credito' : 'contado', fechaVencimiento: String(data.fechaVencimiento || '').trim(),
      descuento: Math.max(0, Number(data.descuento || 0)), notas: data.notas || '',
      tipoBienesServicios: data.tipoBienesServicios, formaPago: data.formaPago, itbisRetenido: data.itbisRetenido,
      isrTipoRetencion: data.isrTipoRetencion, isrMontoRetencion: data.isrMontoRetencion, ncfModificado: data.ncfModificado,
      emitirE41: data.emitirE41 === true, documentoOrigen: 'manual',
    },
    lineas: items.map((it) => ({
      productoId: Number(it.productId), accion: 'existente', decision: 'usuario', descripcion: it.nombre || '', codigo: it.codigo || '',
      cantidad: Number(it.cantidad), costoUnitario: Number(it.costoUnitario), itbisPct: Number(it.itbisPct || 0),
    })),
  };
}

function createComprasRouter({
  query, withTransaction, resolveRequestActorUser, userRoleHasPermission, writeAuditLog, getUserScopeBranchId,
  changeBranchInventoryStock, registerInventoryMovement, mapSupplierInvoiceRow, resolveSupplierInvoiceStatus,
  isMysqlDeployment,
  // Fase A (server.js): crear productos, suplidores, caché de catálogo y firma del XML.
  createProductInTransaction = null, prepararProductos = async () => {}, insertSupplierRow = null, getConfig = async () => ({}),
  afterProductsChanged = async () => {}, alCrearProducto = async () => {}, resolverAlcanceCatalogo = () => null,
  puedeGestionarProductos = () => false, verificarFirmaXml = null, getTerminalBranchId = () => null, getNextNcf = null,
  // Fase D: E41 con estados y aprobación (comprobantes-compra.service.js).
  comprobantesCompra = null, puedeAprobarComprobantes = () => false,
}) {
  const router = express.Router();
  const servicio = crearServicioCompras({
    query, withTransaction, getDbClient, isMysqlDeployment, changeBranchInventoryStock, registerInventoryMovement,
    createProductInTransaction, prepararProductos, insertSupplierRow, resolveSupplierInvoiceStatus, writeAuditLog,
    getConfig, afterProductsChanged, alCrearProducto, resolverAlcanceCatalogo, getNextNcf,
  });
  let esquemaListo = null;
  const asegurarEsquema = () => {
    if (!esquemaListo) {
      esquemaListo = ensureSchema(query, { withTransaction })
        .then(() => ensureSupplierPaymentsTableLocal(query))
        .catch((e) => { esquemaListo = null; throw e; });
    }
    return esquemaListo;
  };

  function roleCodeOf(actor) {
    return String(actor?.role_code || actor?.rol || '').trim().toLowerCase();
  }
  function isAdminGeneral(actor) {
    return roleCodeOf(actor) === 'administrador_general';
  }
  function actorName(actor) {
    return actor?.nombre || actor?.usuario || 'Sistema';
  }

  // Sucursal a la que queda limitada la consulta/acción; null = todas (consolidado).
  function resolveBranchScope(actor, requestedBranchId) {
    if (isAdminGeneral(actor)) {
      return requestedBranchId ? Number(requestedBranchId) : null;
    }
    const scopedBranchId = getUserScopeBranchId(actor);
    if (!scopedBranchId) {
      throw httpError('Tu usuario no tiene una sucursal asignada.', 403);
    }
    if (requestedBranchId && Number(requestedBranchId) !== Number(scopedBranchId)) {
      throw httpError('No puedes operar con otra sucursal.', 403);
    }
    return Number(scopedBranchId);
  }
  // Un recurso cargado por id debe ser de la sucursal del actor (los ids son adivinables).
  function assertBranchAccess(actor, branchId) {
    resolveBranchScope(actor, branchId ? Number(branchId) : null);
  }
  // Sucursal donde se trabaja (la elegida, la del usuario o la de esta terminal).
  function sucursalDeTrabajo(actor, pedida) {
    const b = resolveBranchScope(actor, pedida ? Number(pedida) : null) || Number(getTerminalBranchId() || 0) || null;
    if (!b) throw httpError('Indica la sucursal de la compra.');
    return b;
  }
  const contextoRegistro = (actor, branchId, extra = {}) => ({
    actor, branchId, puedeCrearProductos: true,
    puedeCambiarProductos: isAdminGeneral(actor) || Boolean(puedeGestionarProductos(actor)), ...extra,
  });
  const responderError = (res, e) => res.status(e.statusCode || 500).json({ error: e.message, ...(e.bloqueos ? { bloqueos: e.bloqueos } : {}) });

  async function requireCompras(req, res, next) {
    try {
      const actor = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
      if (!isAdminGeneral(actor) && !userRoleHasPermission(actor, 'compras.ver')) {
        return res.status(403).json({ error: 'No tienes permiso para acceder a Compras.' });
      }
      req.authUser = actor;
      await asegurarEsquema();
      next();
    } catch (e) {
      res.status(e.statusCode || 401).json({ error: e.message || 'Sesión inválida o expirada.' });
    }
  }
  router.use(requireCompras);

  function requirePermission(...permissions) {
    return (req, res, next) => {
      if (isAdminGeneral(req.authUser) || userRoleHasPermission(req.authUser, ...permissions)) return next();
      res.status(403).json({ error: 'No tienes permiso para realizar esta acción en Compras.' });
    };
  }

  async function filaCompra(purchaseId) {
    const [row] = await query(
      `SELECT p.*, s.nombre AS supplier_name, b.nombre AS branch_name FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN branches b ON b.id = p.branch_id WHERE p.id = ?`,
      [purchaseId]
    );
    return row;
  }

  // La compra ya quedó: el E41 se pide aparte (server/services/comprobantes-compra.service.js)
  // y sigue su propio estado. Con la modalidad «con aprobación» espera al administrador;
  // el e-NCF pasa a la compra solo cuando la DGII lo acepta. Si falla, se avisa sin deshacerla.
  async function emitirE41SiCorresponde(r, encabezado, actor) {
    if (r.repetida || !encabezado?.emitirE41 || !comprobantesCompra) return null;
    const pedido = await comprobantesCompra.solicitarDe({
      tipo: 'compra', id: r.purchaseId, tipoEcf: 'E41', actor, puedeAprobar: puedeAprobarComprobantes(actor),
    });
    return pedido.ecf;
  }

  // ── Crear compra (formulario clásico o líneas de «Preparar compra») ──────
  router.post('/', requirePermission('compras.crear'), async (req, res) => {
    const data = req.body || {};
    const actor = req.authUser;
    try {
      const payload = Array.isArray(data.lineas)
        ? { uuid: data.uuid || null, encabezado: data.encabezado || {}, lineas: data.lineas }
        : payloadDesdeClasico(data);
      if (!payload.encabezado?.proveedor?.id && !payload.encabezado?.proveedor?.nombre && !payload.encabezado?.proveedor?.rnc) {
        throw httpError('Selecciona un proveedor.');
      }
      const branchId = resolveBranchScope(actor, data.branchId ? Number(data.branchId) : null);
      if (!branchId) throw httpError('Indica la sucursal de la compra.');
      const r = await servicio.registrar(payload, contextoRegistro(actor, branchId));
      const ecf = r.repetida ? null : await emitirE41SiCorresponde(r, r.encabezado || payload.encabezado, actor, branchId);
      if (!r.repetida) syncContabilidadFireAndForget('compra registrada');
      const fila = await filaCompra(r.purchaseId);
      res.status(r.repetida ? 200 : 201).json({ ...mapPurchaseRow(fila), ecf, repetida: r.repetida, productosCreados: r.productosCreados?.length || 0 });
    } catch (e) {
      responderError(res, e);
    }
  });

  // ── Listar compras ───────────────────────────────────────────────────────
  router.get('/', requirePermission('compras.ver'), async (req, res) => {
    try {
      const branchScope = resolveBranchScope(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      const conditions = [];
      const params = [];
      if (branchScope) { conditions.push('p.branch_id = ?'); params.push(branchScope); }
      if (req.query.supplierId) { conditions.push('p.supplier_id = ?'); params.push(Number(req.query.supplierId)); }
      if (req.query.estado) { conditions.push('p.estado = ?'); params.push(String(req.query.estado)); }
      if (req.query.desde) { conditions.push('p.fecha_comprobante >= ?'); params.push(String(req.query.desde)); }
      if (req.query.hasta) { conditions.push('p.fecha_comprobante <= ?'); params.push(String(req.query.hasta)); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await query(
        `SELECT p.*, s.nombre AS supplier_name, b.nombre AS branch_name
         FROM purchases p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN branches b ON b.id = p.branch_id
         ${where}
         ORDER BY p.fecha_comprobante DESC, p.id DESC
         LIMIT 500`,
        params
      );
      res.json(rows.map(mapPurchaseRow));
    } catch (e) {
      responderError(res, e);
    }
  });

  // ── Cuentas por pagar (vista global cross-proveedor) ────────────────────
  // pending_amount es la fuente de verdad (Tesorería escribe 'pagada'/'parcial').
  router.get('/accounts-payable', requirePermission('cuentas_por_pagar.ver'), async (req, res) => {
    try {
      const conditions = ['si.pending_amount > 0'];
      const params = [];
      if (req.query.supplierId) { conditions.push('si.supplier_id = ?'); params.push(Number(req.query.supplierId)); }
      const rows = await query(
        `SELECT si.*, s.nombre AS supplier_name, s.telefono, s.limite_credito
         FROM supplier_invoices si
         INNER JOIN suppliers s ON s.id = si.supplier_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY si.due_at ASC, si.id DESC`,
        params
      );
      const today = servicio.hoyLocal();
      let totalPendiente = 0;
      let totalVencido = 0;
      let totalPorVencer7dias = 0;
      const cuentas = rows.map((row) => {
        const mapped = mapSupplierInvoiceRow(row);
        const dueAt = String(row.due_at || '').slice(0, 10);
        const vencida = Boolean(dueAt) && dueAt < today;
        const diasVencido = vencida ? Math.floor((new Date(today) - new Date(dueAt)) / 86400000) : 0;
        const diasParaVencer = dueAt && !vencida ? Math.ceil((new Date(dueAt) - new Date(today)) / 86400000) : null;
        totalPendiente += mapped.montoPendiente;
        if (vencida) totalVencido += mapped.montoPendiente;
        if (diasParaVencer !== null && diasParaVencer <= 7) totalPorVencer7dias += mapped.montoPendiente;
        return { ...mapped, vencida, diasVencido, diasParaVencer };
      });
      res.json({
        cuentas,
        resumen: {
          totalPendiente: Number(totalPendiente.toFixed(2)),
          totalVencido: Number(totalVencido.toFixed(2)),
          totalPorVencer7dias: Number(totalPorVencer7dias.toFixed(2)),
          cantidadFacturas: cuentas.length,
        },
      });
    } catch (e) {
      responderError(res, e);
    }
  });

  // ── Configuración de compras (por empresa) ───────────────────────────────
  const puedeConfigurar = (actor) => isAdminGeneral(actor) || userRoleHasPermission(actor, 'gestionar_configuracion_global');
  router.get('/config', async (req, res) => {
    try {
      res.json({ ...(await servicio.leerConfig()), puedeConfigurar: puedeConfigurar(req.authUser),
        puedeCambiarProductos: contextoRegistro(req.authUser, 0).puedeCambiarProductos,
        puedeRecibir: isAdminGeneral(req.authUser) || userRoleHasPermission(req.authUser, 'compras.recibir') });
    } catch (e) { responderError(res, e); }
  });
  router.put('/config', async (req, res) => {
    try {
      if (!puedeConfigurar(req.authUser)) throw httpError('Solo quien administra la configuración cambia esto.', 403);
      const antes = await servicio.leerConfig();
      const cfg = await servicio.guardarConfig(req.body || {});
      await Promise.resolve(writeAuditLog({ userId: req.authUser.id, userName: actorName(req.authUser), moduleName: 'Compras', actionName: 'Configuración de compras',
        before: antes, after: cfg, detail: `Recepción: ${cfg.modoRecepcion} · margen ${cfg.margenDefecto ?? 'manual'} (${cfg.tipoMargen}) · precio ${cfg.precioModo}` })).catch(() => {});
      res.json(cfg);
    } catch (e) { responderError(res, e); }
  });

  // Plantilla de Excel para importar compras (la arma la pantalla con estas filas).
  router.get('/plantilla', (req, res) => {
    res.json({ filas: require('../services/compras/lector-tabla').plantillaFilas() });
  });

  // ── Borradores «Preparar compra» ─────────────────────────────────────────
  async function cargarBorrador(id, actor) {
    const [row] = await query('SELECT * FROM purchase_drafts WHERE id = ?', [String(id)]);
    if (!row) throw httpError('Borrador no encontrado.', 404);
    assertBranchAccess(actor, row.branch_id);
    return row;
  }
  const tituloDe = (p) => {
    const e = p?.encabezado || {};
    return [e.proveedor?.nombre || e.proveedor?.rnc || 'Proveedor sin nombre', e.ncf || e.numeroDocumento].filter(Boolean).join(' · ').slice(0, 200);
  };
  async function crearBorrador({ actor, branchId, origen, payload, cache }) {
    const prep = await servicio.preparar(payload, { branchId, cache });
    const id = crypto.randomUUID();
    const guardado = { ...prep.payload, resumen: prep.resumen };
    await query(
      `INSERT INTO purchase_drafts (id, branch_id, origen, estado, titulo, payload_json, avisos_json, version, created_by_user_id, created_by_user_name, updated_by_user_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [id, branchId, origen, prep.bloqueos.length ? 'requiere_revision' : 'borrador', tituloDe(guardado), JSON.stringify(guardado),
        JSON.stringify({ avisos: prep.avisos, bloqueos: prep.bloqueos }), actor.id || null, actorName(actor), actorName(actor), new Date().toISOString(), new Date().toISOString()]
    );
    const [row] = await query('SELECT * FROM purchase_drafts WHERE id = ?', [id]);
    return { ...mapDraftRow(row), avisos: prep.avisos.length, bloqueos: prep.bloqueos.length };
  }

  router.get('/drafts', requirePermission('compras.ver'), async (req, res) => {
    try {
      const branchScope = resolveBranchScope(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      const estados = req.query.estado === 'todos' ? ['borrador', 'requiere_revision', 'registrada', 'descartada'] : ['borrador', 'requiere_revision'];
      const rows = await query(
        `SELECT * FROM purchase_drafts WHERE estado IN (${estados.map(() => '?').join(', ')})${branchScope ? ' AND branch_id = ?' : ''}
         ORDER BY updated_at DESC LIMIT 500`,
        [...estados, ...(branchScope ? [branchScope] : [])]
      );
      res.json(rows.map((r) => mapDraftRow(r)));
    } catch (e) { responderError(res, e); }
  });

  router.post('/drafts', requirePermission('compras.crear'), async (req, res) => {
    try {
      const branchId = sucursalDeTrabajo(req.authUser, req.body?.branchId);
      const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload
        : { encabezado: { fechaComprobante: servicio.hoyLocal(), condicionPago: 'contado', documentoOrigen: 'manual' }, lineas: [] };
      res.status(201).json(await crearBorrador({ actor: req.authUser, branchId, origen: 'manual', payload }));
    } catch (e) { responderError(res, e); }
  });

  router.get('/drafts/:id', requirePermission('compras.ver'), async (req, res) => {
    try {
      const row = await cargarBorrador(req.params.id, req.authUser);
      const draft = mapDraftRow(row, { conPayload: true });
      const prep = ['borrador', 'requiere_revision'].includes(row.estado) ? await servicio.preparar(draft.payload, { branchId: Number(row.branch_id) }) : null;
      const docs = await query('SELECT id, nombre, tipo, tamano, created_at FROM purchase_documents WHERE draft_id = ? OR id = ?', [row.id, String(draft.payload?.documentoId || '')]);
      res.json({ ...draft, ...(prep ? { payload: { ...prep.payload, resumen: prep.resumen }, resumen: prep.resumen, avisos: prep.avisos, bloqueos: prep.bloqueos, config: prep.config } : {}),
        documentos: docs.map((d) => ({ id: d.id, nombre: d.nombre, tipo: d.tipo, tamano: Number(d.tamano || 0), fecha: d.created_at })) });
    } catch (e) { responderError(res, e); }
  });

  router.put('/drafts/:id', requirePermission('compras.crear'), async (req, res) => {
    try {
      const row = await cargarBorrador(req.params.id, req.authUser);
      const version = Number(req.body?.version);
      if (!Number.isInteger(version)) throw httpError('Versión del borrador no válida.');
      const payload = req.body?.payload;
      if (!payload || typeof payload !== 'object') throw httpError('Faltan los datos del borrador.');
      const prep = await servicio.preparar({ ...payload, documentoId: payload.documentoId || JSON.parse(row.payload_json || '{}').documentoId }, { branchId: Number(row.branch_id) });
      const guardado = { ...prep.payload, resumen: prep.resumen };
      const r = await query(
        `UPDATE purchase_drafts SET payload_json = ?, avisos_json = ?, estado = ?, titulo = ?, version = version + 1, updated_at = ?, updated_by_user_name = ?
         WHERE id = ? AND version = ? AND estado IN ('borrador', 'requiere_revision')`,
        [JSON.stringify(guardado), JSON.stringify({ avisos: prep.avisos, bloqueos: prep.bloqueos }), prep.bloqueos.length ? 'requiere_revision' : 'borrador',
          tituloDe(guardado), new Date().toISOString(), actorName(req.authUser), row.id, version]
      );
      if (Number(r?.affectedRows ?? r?.rowsAffected ?? 0) !== 1) throw httpError('El borrador cambió en otra caja o ya se registró. Recárgalo.', 409);
      res.json({ id: row.id, version: version + 1, estado: prep.bloqueos.length ? 'requiere_revision' : 'borrador', payload: guardado,
        resumen: prep.resumen, avisos: prep.avisos, bloqueos: prep.bloqueos, config: prep.config });
    } catch (e) { responderError(res, e); }
  });

  router.delete('/drafts/:id', requirePermission('compras.crear'), async (req, res) => {
    try {
      const row = await cargarBorrador(req.params.id, req.authUser);
      const r = await query("UPDATE purchase_drafts SET estado = 'descartada', version = version + 1, updated_at = ?, updated_by_user_name = ? WHERE id = ? AND estado IN ('borrador', 'requiere_revision')",
        [new Date().toISOString(), actorName(req.authUser), row.id]);
      if (Number(r?.affectedRows ?? r?.rowsAffected ?? 0) !== 1) throw httpError('Ese borrador ya no está pendiente.', 409);
      await Promise.resolve(writeAuditLog({ userId: req.authUser.id, userName: actorName(req.authUser), moduleName: 'Compras', actionName: 'Borrador de compra descartado',
        detail: row.titulo || row.id })).catch(() => {});
      res.json({ ok: true });
    } catch (e) { responderError(res, e); }
  });

  router.post('/drafts/:id/registrar', requirePermission('compras.crear'), async (req, res) => {
    const actor = req.authUser;
    try {
      const row = await cargarBorrador(req.params.id, actor);
      if (row.estado === 'registrada' && row.purchase_id) {
        const fila = await filaCompra(row.purchase_id);
        return res.json({ ...mapPurchaseRow(fila), repetida: true });
      }
      if (!['borrador', 'requiere_revision'].includes(row.estado)) throw httpError('Ese borrador ya no está pendiente.', 409);
      const version = Number(req.body?.version ?? row.version);
      const guardado = JSON.parse(row.payload_json || '{}');
      const payload = req.body?.payload && typeof req.body.payload === 'object'
        ? { ...req.body.payload, documentoId: req.body.payload.documentoId || guardado.documentoId }
        : guardado;
      const branchId = Number(row.branch_id);
      const r = await servicio.registrar({ ...payload, uuid: row.id }, contextoRegistro(actor, branchId, { draftId: row.id, draftVersion: version }));
      const ecf = r.repetida ? null : await emitirE41SiCorresponde(r, r.encabezado || payload.encabezado, actor, branchId);
      if (!r.repetida) syncContabilidadFireAndForget('compra registrada (borrador)');
      const fila = await filaCompra(r.purchaseId);
      res.status(r.repetida ? 200 : 201).json({ ...mapPurchaseRow(fila), ecf, repetida: r.repetida, productosCreados: r.productosCreados?.length || 0 });
    } catch (e) { responderError(res, e); }
  });

  // ── Subir factura: XML e-CF, Excel/CSV, foto o PDF → borradores ─────────
  router.post('/import', requirePermission('compras.crear'), async (req, res) => {
    const actor = req.authUser;
    try {
      const nombre = path.basename(String(req.body?.nombre || 'archivo')).slice(0, 200);
      const ext = path.extname(nombre).toLowerCase();
      const buffer = Buffer.from(String(req.body?.contenido || ''), 'base64');
      if (!buffer.length) throw httpError('El archivo está vacío.');
      if (buffer.length > MAX_ARCHIVO) throw httpError('El archivo pasa de 5 MB.', 413);
      const sha = crypto.createHash('sha256').update(buffer).digest('hex');
      const branchId = sucursalDeTrabajo(actor, req.body?.branchId);
      const esTabla = ['.csv', '.txt', '.xlsx', '.xls'].includes(ext);
      const esXml = ext === '.xml';
      const adjunto = TIPOS_ADJUNTO[ext];
      if (!esTabla && !esXml && !adjunto) throw httpError('Formato no admitido. Sube XML, Excel/CSV, JPG, PNG o PDF.', 415);

      // El mismo archivo otra vez: no se duplica (XML, foto o PDF son una sola factura).
      if (!esTabla) {
        const previos = await query('SELECT id, draft_id, purchase_id FROM purchase_documents WHERE sha256 = ?', [sha]);
        const registrado = previos.find((d) => d.purchase_id);
        if (registrado) throw httpError(`Este archivo ya se registró en la compra #${registrado.purchase_id}.`, 409);
        for (const d of previos.filter((x) => x.draft_id)) {
          const [b] = await query("SELECT * FROM purchase_drafts WHERE id = ? AND estado IN ('borrador', 'requiere_revision')", [d.draft_id]);
          if (b) return res.json({ borradores: [{ ...mapDraftRow(b), repetido: true }], errores: [] });
        }
      }

      const documentoId = crypto.randomUUID();
      const guardarDocumento = (draftId, extraccion, version) => query(
        `INSERT INTO purchase_documents (id, draft_id, nombre, tipo, tamano, sha256, contenido, extraccion_json, version_extractor, created_by_user_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [documentoId, draftId, nombre, adjunto || (esXml ? 'application/xml' : 'text/tabla'), buffer.length, sha, buffer.toString('base64'),
          extraccion ? JSON.stringify(extraccion).slice(0, 500000) : null, version || null, actorName(actor), new Date().toISOString()]
      );
      const cfg = await servicio.leerConfig();
      const borradores = [];
      let errores = [];

      if (esXml) {
        const lectura = leerXmlEcf(buffer.toString('utf8'), { rncNegocio: cfg.rncNegocio, verificarFirma: verificarFirmaXml });
        const b = await crearBorrador({ actor, branchId, origen: 'xml', payload: { encabezado: lectura.encabezado, lineas: lectura.lineas, avisos: lectura.avisos, documentoId, firma: lectura.firma } });
        await guardarDocumento(b.id, lectura, lectura.version);
        borradores.push(b);
      } else if (esTabla) {
        const lectura = leerTabla(buffer, nombre);
        errores = lectura.errores;
        await guardarDocumento(null, { facturas: lectura.facturas.length, errores: lectura.errores }, 'tabla-1');
        const cache = {};
        for (const factura of lectura.facturas) {
          borradores.push(await crearBorrador({ actor, branchId, origen: ext === '.csv' || ext === '.txt' ? 'csv' : 'xlsx',
            payload: { encabezado: factura.encabezado, lineas: factura.lineas, avisos: factura.avisos, documentoId }, cache }));
        }
      } else {
        const b = await crearBorrador({ actor, branchId, origen: 'adjunto', payload: {
          encabezado: { fechaComprobante: servicio.hoyLocal(), condicionPago: 'contado', documentoOrigen: 'manual' }, lineas: [], documentoId,
          avisos: [{ nivel: 'aviso', texto: 'La lectura automática de fotos y PDF llega en la próxima versión: completa los datos mirando el documento.' }],
        } });
        await guardarDocumento(b.id, null, null);
        borradores.push(b);
      }
      await Promise.resolve(writeAuditLog({ userId: actor.id, userName: actorName(actor), moduleName: 'Compras', actionName: 'Factura de proveedor subida',
        branchId, detail: `${nombre} · ${borradores.length} borrador(es)${errores.length ? ` · ${errores.length} fila(s) con error` : ''}` })).catch(() => {});
      res.status(201).json({ borradores, errores });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message, errores: e.errores || [] });
    }
  });

  router.get('/documents/:id', requirePermission('compras.ver'), async (req, res) => {
    try {
      const [doc] = await query('SELECT d.*, p.branch_id AS compra_branch, b.branch_id AS borrador_branch FROM purchase_documents d LEFT JOIN purchases p ON p.id = d.purchase_id LEFT JOIN purchase_drafts b ON b.id = d.draft_id WHERE d.id = ?', [String(req.params.id)]);
      if (!doc) throw httpError('Documento no encontrado.', 404);
      const branch = doc.compra_branch || doc.borrador_branch;
      if (branch) assertBranchAccess(req.authUser, branch);
      res.json({ id: doc.id, nombre: doc.nombre, tipo: doc.tipo, tamano: Number(doc.tamano || 0), contenido: doc.contenido || '' });
    } catch (e) { responderError(res, e); }
  });

  // ── Recepción de mercancía ───────────────────────────────────────────────
  router.get('/receipts/pending', requirePermission('compras.ver'), async (req, res) => {
    try {
      const branchScope = resolveBranchScope(req.authUser, req.query.branchId ? Number(req.query.branchId) : null);
      const compras = await query(
        `SELECT p.*, s.nombre AS supplier_name, b.nombre AS branch_name FROM purchases p
         LEFT JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN branches b ON b.id = p.branch_id
         WHERE p.estado = 'activa' AND p.estado_inventario IN ('pendiente_recepcion', 'recibido_parcial')${branchScope ? ' AND p.branch_id = ?' : ''}
         ORDER BY p.fecha_comprobante, p.id LIMIT 300`,
        branchScope ? [branchScope] : []
      );
      const ids = compras.map((p) => Number(p.id));
      const items = ids.length
        ? await query(`SELECT * FROM purchase_items WHERE tipo_linea = 'inventario' AND purchase_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`, ids)
        : [];
      res.json(compras.map((p) => ({ ...mapPurchaseRow(p), items: items.filter((i) => Number(i.purchase_id) === Number(p.id)).map(mapPurchaseItemRow) })));
    } catch (e) { responderError(res, e); }
  });

  router.post('/:id/receipts', requirePermission('compras.recibir'), async (req, res) => {
    try {
      const r = await servicio.confirmarRecepcion(Number(req.params.id), req.body || {}, {
        actor: req.authUser, assertBranch: (branchId) => assertBranchAccess(req.authUser, branchId),
      });
      const fila = await filaCompra(Number(req.params.id));
      res.status(r.repetida ? 200 : 201).json({ ...mapPurchaseRow(fila), repetida: Boolean(r.repetida), diferencias: Boolean(r.diferencias) });
    } catch (e) { responderError(res, e); }
  });

  // ── Detalle de compra (con renglones) ───────────────────────────────────
  router.get('/:id', requirePermission('compras.ver'), async (req, res) => {
    try {
      const purchaseId = Number(req.params.id);
      const row = await filaCompra(purchaseId);
      if (!row) return res.status(404).json({ error: 'Compra no encontrada.' });
      assertBranchAccess(req.authUser, row.branch_id);
      const items = await query('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id', [purchaseId]);
      const documentos = await query('SELECT id, nombre, tipo, tamano FROM purchase_documents WHERE purchase_id = ?', [purchaseId]).catch(() => []);
      const recepciones = await query('SELECT * FROM purchase_receipts WHERE purchase_id = ? ORDER BY id', [purchaseId]).catch(() => []);
      res.json({ ...mapPurchaseRow(row), items: items.map(mapPurchaseItemRow),
        documentos: documentos.map((d) => ({ id: d.id, nombre: d.nombre, tipo: d.tipo, tamano: Number(d.tamano || 0) })),
        recepciones: recepciones.map((r) => ({ id: Number(r.id), notas: r.notas || '', usuario: r.created_by_user_name || '', fecha: r.created_at, cerrada: Boolean(Number(r.cierra_con_diferencia)) })) });
    } catch (e) {
      responderError(res, e);
    }
  });

  // ── Anular compra ────────────────────────────────────────────────────────
  router.post('/:id/void', requirePermission('compras.anular'), async (req, res) => {
    const actor = req.authUser;
    const purchaseId = Number(req.params.id);
    const motivo = String(req.body?.motivo || '').trim() || null;
    try {
      const productos = await withTransaction(async (conn) => {
        // FOR UPDATE (solo MySQL): dos anulaciones a la vez no revierten dos veces.
        const [purchase] = await conn.query(
          `SELECT * FROM purchases WHERE id = ?${isMysqlDeployment() ? ' FOR UPDATE' : ''}`,
          [purchaseId]
        );
        if (!purchase) throw httpError('Compra no encontrada.', 404);
        assertBranchAccess(actor, purchase.branch_id);
        if (purchase.estado !== 'activa') throw httpError('Esta compra ya fue anulada.', 409);

        const [invoice] = purchase.supplier_invoice_id
          ? await conn.query('SELECT * FROM supplier_invoices WHERE id = ?', [purchase.supplier_invoice_id])
          : [null];

        // A crédito con abonos aplicados: hay que reversar los abonos primero.
        if (invoice && purchase.condicion_pago === 'credito' && Number(invoice.paid_amount) > 0) {
          throw httpError('No se puede anular: la factura vinculada ya tiene abonos registrados. Reversa los abonos primero.', 409);
        }

        // Solo se revierte lo que entró al inventario (lo recibido).
        const items = await conn.query('SELECT * FROM purchase_items WHERE purchase_id = ?', [purchaseId]);
        const tocados = [];
        for (const item of items) {
          const cantidad = servicio.cantidadARevertir(item);
          if (!item.product_id || !(cantidad > 0)) continue;
          const stockChange = await changeBranchInventoryStock(conn, {
            productId: item.product_id, branchId: purchase.branch_id,
            quantityDelta: -Math.abs(cantidad), preventNegative: false,
          });
          await registerInventoryMovement(conn, {
            productId: item.product_id, branchId: purchase.branch_id, tipo: 'compra_anulada',
            cantidad: -Math.abs(cantidad),
            stockAnterior: stockChange.previousStock, stockNuevo: stockChange.nextStock, costoUnitario: item.costo_unitario,
            referenciaTipo: 'compra_anulada', referenciaId: String(purchaseId),
            notas: `Reverso por anulación de Compra #${purchaseId}`,
            usuarioId: actor.id, usuarioNombre: actorName(actor),
          });
          tocados.push(Number(item.product_id));
        }

        if (invoice) {
          await conn.query(
            `UPDATE supplier_invoices SET status = 'Anulada', pending_amount = 0, paid_amount = 0 WHERE id = ?`,
            [invoice.id]
          );
          // Borra solo el pago automático de la compra (contado).
          await conn.query('DELETE FROM supplier_payments WHERE purchase_id = ?', [purchaseId]);
        }

        await conn.query(
          `UPDATE purchases SET estado = 'anulada', motivo_anulacion = ?, anulada_at = CURRENT_TIMESTAMP,
             anulada_by_user_id = ?, anulada_by_user_name = ? WHERE id = ?`,
          [motivo, actor.id, actorName(actor), purchaseId]
        );
        return tocados;
      });

      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Compras', actionName: 'Compra anulada',
        detail: `Compra #${purchaseId}${motivo ? ' · ' + motivo : ''}`,
      });
      Promise.resolve(afterProductsChanged(productos, { motivo: 'compra_anulada' })).catch(() => {});
      syncContabilidadFireAndForget('compra anulada');
      res.json({ ok: true, message: `Compra #${purchaseId} anulada.` });
    } catch (e) {
      responderError(res, e);
    }
  });

  return router;
}

module.exports = { createComprasRouter, ensureSchema, payloadDesdeClasico, ensureSupplierPaymentsTableLocal };

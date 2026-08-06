'use strict';
/**
 * sync-pos-stats.js
 *
 * Agrega KPIs y datos recientes del POS (MariaDB) y los escribe directamente
 * en Firestore `licencias/{licenseUid}` para que el Portal de Contadores
 * los lea en tiempo real.
 *
 * Estructura Firestore:
 *   licencias/{licenseUid}.posStats        — KPIs agregados (campo en el doc)
 *   licencias/{licenseUid}/reportes/{tab}  — Filas tabulares recientes
 */

const { query } = require('../../db');
const { mapSequence } = require('../routes/fiscal-sequences.routes');

const MAX_ROWS = 150;

function getLicenseUid() {
  return String(process.env.TECNO_CAJA_LICENSE_UID || '').trim();
}

function getDb() {
  const { getFirestore } = require('../../modules/firebase-admin');
  return getFirestore();
}

function safeNum(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function isoDate(d) {
  if (!d) return null;
  try { return new Date(d).toISOString(); } catch { return null; }
}

function normalize(rows) {
  return rows.map(r => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = v instanceof Date ? v.toISOString() : (v === undefined ? null : v);
    }
    return out;
  });
}

// ── Perfil del negocio (RNC, propietario, teléfono) ─────────────────────────
// registerPosLicenseInFirestore() solo escribe el doc una vez al completar el
// asistente inicial y no incluye RNC/propietario — por eso el Portal del
// Contador los mostraba en blanco. Se sincroniza aquí también, en cada venta,
// para que se autocorrija sin tener que rehacer el asistente.

async function buildBusinessProfile() {
  const [cfgRow, adminRow, branchRows, cashRegisterRows] = await Promise.all([
    query(`
      SELECT business_name, rnc, razon_social, address, provincia, phone, business_type,
             trial_started_at, trial_ends_at, license_status, plan_expires_at
      FROM config WHERE id = 1 LIMIT 1
    `),
    query(`
      SELECT u.nombre, u.email FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.codigo = 'administrador_general' AND u.estado = 'Activo'
      ORDER BY u.id ASC LIMIT 1
    `).catch(() => []),
    // Lista de sucursales — el Portal del Contador la usa para dejar elegir
    // sucursal destino al agregar un producto (ver apply-pending-products.js).
    query(`SELECT id, nombre, codigo, direccion, telefono, encargado, estado FROM branches WHERE estado <> 'Eliminada' ORDER BY nombre`).catch(() => []),
    query(`
      SELECT cr.id, cr.branch_id, cr.nombre, cr.codigo, cr.estado, cr.tipo_caja
      FROM cash_registers cr
      INNER JOIN branches b ON b.id = cr.branch_id
      WHERE cr.estado <> 'Eliminada' AND b.estado <> 'Eliminada'
      ORDER BY cr.branch_id, cr.nombre
    `).catch(() => []),
  ]);
  const cfg = cfgRow?.[0] || {};
  const admin = adminRow?.[0] || {};
  // Firestore rechaza valores `undefined` en un .set(merge:true) — se omite
  // la clave por completo (en vez de mandar null) para no pisar un valor
  // bueno que ya estuviera en Firestore si localmente viniera vacío.
  const profile = {};
  if (cfg.business_name) profile.businessName = cfg.business_name;
  if (cfg.rnc) profile.rnc = cfg.rnc;
  if (cfg.razon_social) profile.razon_social = cfg.razon_social;
  if (cfg.address) profile.direccion = cfg.address;
  if (cfg.provincia) profile.provincia = cfg.provincia;
  // trialEndsAt/expiresAt: solo se escribieron una vez, al completar el
  // asistente inicial (registerPosLicenseInFirestore) — instalaciones más
  // viejas que esa función pueden no tenerlos. Se resincronizan aquí en cada
  // venta para autocorregirse sin tener que rehacer el asistente.
  // OJO: son dos fechas distintas — trialEndsAt es el fin de la PRUEBA
  // (usado por el Portal solo cuando status='trial'), expiresAt es el
  // vencimiento de una licencia PAGA/activa (plan_expires_at, usado solo
  // cuando status='active'). Reusar trial_ends_at para expiresAt generaba
  // una alerta falsa de "licencia vence en N días" en negocios que ya
  // estaban en status='active' con licencia perpetua (plan_expires_at NULL).
  if (cfg.trial_started_at) profile.trialStartedAt = isoDate(cfg.trial_started_at);
  if (cfg.trial_ends_at) profile.trialEndsAt = isoDate(cfg.trial_ends_at);
  // A diferencia de los demás campos, expiresAt SÍ se manda explícitamente en
  // null cuando no hay plan_expires_at (en vez de omitir la clave) — una
  // sincronización anterior con un bug ya escribió un valor incorrecto aquí
  // (reusaba trial_ends_at) y hay que poder limpiarlo, no solo evitar que se
  // repita.
  profile.expiresAt = cfg.plan_expires_at ? isoDate(cfg.plan_expires_at) : null;
  // NO sincronizar cfg.license_status hacia Firestore: el flujo correcto es
  // Firestore (fuente de verdad, controlada desde el panel admin) → POS local,
  // nunca al revés. Si el POS resuelve mal su propio estado (bug local,
  // condición de carrera entre terminales, etc.) y lo empuja aquí, contamina
  // el documento maestro para SIEMPRE — cada sync posterior (de cualquier
  // terminal) vuelve a leer el estado ya envenenado y lo re-confirma, sin
  // forma de autocorregirse. Ver server/licensing/license-service.js para el
  // único camino legítimo que debe decidir el status remoto.
  if (cfg.business_type) profile.tipo_negocio = cfg.business_type;
  const cashRegistersByBranch = new Map();
  for (const cashRegister of cashRegisterRows || []) {
    const branchId = Number(cashRegister.branch_id || 0);
    if (!cashRegistersByBranch.has(branchId)) cashRegistersByBranch.set(branchId, []);
    cashRegistersByBranch.get(branchId).push({
      id: Number(cashRegister.id),
      branchId,
      nombre: cashRegister.nombre,
      codigo: cashRegister.codigo || '',
      estado: cashRegister.estado || 'Activa',
      tipoCaja: cashRegister.tipo_caja || 'mixta',
    });
  }
  profile.sucursales = (branchRows || []).map((b) => ({
    id: Number(b.id),
    nombre: b.nombre,
    codigo: b.codigo || '',
    direccion: b.direccion || '',
    telefono: b.telefono || '',
    encargado: b.encargado || '',
    estado: b.estado || 'Activa',
    cajas: cashRegistersByBranch.get(Number(b.id)) || [],
  }));
  profile.cashRegisters = (cashRegisterRows || []).map((cashRegister) => ({
    id: Number(cashRegister.id),
    branchId: Number(cashRegister.branch_id),
    nombre: cashRegister.nombre,
    codigo: cashRegister.codigo || '',
    estado: cashRegister.estado || 'Activa',
    tipoCaja: cashRegister.tipo_caja || 'mixta',
  }));
  if (cfg.phone) profile.telefono = cfg.phone;
  if (admin.nombre) profile.propietario = admin.nombre;
  if (admin.email) profile.correo = admin.email;
  return profile;
}

// ── KPIs agregados ─────────────────────────────────────────────────────────

async function buildPosStats() {
  // Usar date('now') (sintaxis SQLite canónica del proyecto — db.js la traduce
  // a CURDATE()/DATE_FORMAT() automáticamente cuando dbClient='mysql', ver
  // normalizeMySqlSql()) en vez de calcular la fecha en JS, para que "hoy" lo
  // calcule siempre la base de datos y no el proceso Node.js.

  const [
    [ventasHoyRow],
    [ventasMesRow],
    [facturasRow],
    [itbisRow],
    [productosRow],
    [bajoInvRow],
    [cxcRow],
  ] = await Promise.all([

    // Ventas hoy — usa date('now') de la BD, no fecha JS/UTC
    query(
      `SELECT COALESCE(SUM(total),0) AS total
       FROM sales
       WHERE sale_status = 'pagada'
         AND COALESCE(fiscal_status,'emitida') <> 'cancelada'
         AND DATE(created_at) = date('now')`
    ),

    // Ventas mes — primer día del mes según MariaDB
    query(
      `SELECT COALESCE(SUM(total),0) AS total
       FROM sales
       WHERE sale_status = 'pagada'
         AND COALESCE(fiscal_status,'emitida') <> 'cancelada'
         AND DATE(created_at) >= date('now','start of month')`
    ),

    // Facturas mes
    query(
      `SELECT COUNT(*) AS cnt
       FROM sales
       WHERE sale_status = 'pagada'
         AND COALESCE(fiscal_status,'emitida') <> 'cancelada'
         AND DATE(created_at) >= date('now','start of month')`
    ),

    // ITBIS mes
    query(
      `SELECT COALESCE(SUM(tax),0) AS total
       FROM sales
       WHERE sale_status = 'pagada'
         AND COALESCE(fiscal_status,'emitida') <> 'cancelada'
         AND DATE(created_at) >= date('now','start of month')`
    ),

    // Productos activos (usa estado con capital A según schema)
    query(`SELECT COUNT(*) AS cnt FROM products WHERE LOWER(estado) = 'activo'`),

    // Bajo inventario (stock <= stock_min, cuando stock_min > 0)
    query(
      `SELECT COUNT(*) AS cnt
       FROM products
       WHERE LOWER(estado) = 'activo'
         AND stock_min > 0
         AND stock <= stock_min`
    ),

    // CxC: ventas a crédito con saldo pendiente (total - lo ya cobrado, no
    // el total completo — mismo criterio que buildReportesTabs()'s tab
    // 'cxc'; delivery_cash_status es de otro flujo, no refleja pagos
    // parciales/abonos hechos vía client_credit_payments).
    query(
      `SELECT COALESCE(SUM(total - received_amount),0) AS total
       FROM sales
       WHERE payment_method = 'credito'
         AND sale_status = 'pagada'
         AND COALESCE(fiscal_status,'emitida') <> 'cancelada'
         AND COALESCE(total,0) > COALESCE(received_amount,0)`
    ),
  ]);

  return {
    ventasHoy:        safeNum(ventasHoyRow?.total),
    ventasMes:        safeNum(ventasMesRow?.total),
    facturasEmitidas: safeNum(facturasRow?.cnt),
    itbisMes:         safeNum(itbisRow?.total),
    productosActivos: safeNum(productosRow?.cnt),
    bajoInventario:   safeNum(bajoInvRow?.cnt),
    cxcPendiente:     safeNum(cxcRow?.total),
    ultimaSync:       new Date().toISOString(),
  };
}

// ── Datos tabulares por tab ────────────────────────────────────────────────

async function buildReportesTabs() {
  // Usar date('now','-30 days') en las queries en lugar de
  // calcular la fecha en JS/UTC, para respetar la zona horaria del servidor.
  const since30 = null; // se usa date('now','-30 days') inline

  const [ventas, productos, inventario, cxc, clientes, cierres] = await Promise.all([

    // Tab ventas — últimos 30 días según fecha local de MariaDB
    query(
      `SELECT
         s.created_at                                                   AS fecha,
         s.invoice_number                                               AS factura,
         s.branch_id,
         s.branch_id                                                    AS branchId,
         b.nombre                                                        AS sucursal,
         u.nombre                                                       AS cajero,
         COALESCE(s.client_name_snapshot, c.nombre, 'Consumidor Final') AS cliente,
         s.payment_method                                               AS metodo_pago,
         s.discount                                                     AS descuento,
         s.discount_items_amount                                        AS descuento_productos,
         s.discount_global_amount                                       AS descuento_global,
         s.total,
         s.tax                                                          AS itbis
       FROM sales s
       LEFT JOIN users   u ON s.user_id   = u.id
       LEFT JOIN clients c ON s.client_id = c.id
       LEFT JOIN branches b ON b.id = s.branch_id
       WHERE s.sale_status = 'pagada'
         AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'
         AND DATE(s.created_at) >= date('now','-30 days')
       ORDER BY s.created_at DESC
       LIMIT ${MAX_ROWS}`
    ),

    // Tab productos (top vendidos en últimos 30 días)
    query(
      `SELECT
         p.codigo                       AS codigo,
         p.nombre                       AS nombre,
         p.branch_id,
         p.branch_id                     AS branchId,
         b.nombre                       AS sucursal,
         p.categoria                    AS categoria,
         p.precio_venta                 AS precio,
         p.precio_compra                AS costo,
         p.stock                        AS stock,
         COALESCE(SUM(si.qty), 0)       AS vendidos
       FROM products p
       LEFT JOIN branches b ON b.id = p.branch_id
       LEFT JOIN sale_items si ON si.product_id = p.id
       LEFT JOIN sales s ON si.sale_id = s.id
         AND s.sale_status = 'pagada'
         AND DATE(s.created_at) >= date('now','-30 days')
       WHERE LOWER(p.estado) = 'activo'
       GROUP BY p.id, p.codigo, p.nombre, p.branch_id, b.nombre, p.categoria, p.precio_venta, p.precio_compra, p.stock
       ORDER BY vendidos DESC
       LIMIT ${MAX_ROWS}`
    ),

    // Tab inventario
    query(
      `SELECT
         p.codigo                                               AS codigo,
         p.nombre                                               AS nombre,
         p.branch_id,
         p.branch_id                                             AS branchId,
         b.nombre                                                AS sucursal,
         p.stock                                                AS stock,
         p.stock_min                                            AS minimo,
         CASE
           WHEN p.stock <= 0           THEN 'Sin stock'
           WHEN p.stock_min > 0
            AND p.stock <= p.stock_min THEN 'Bajo'
           ELSE 'Normal'
         END                                                    AS estado
       FROM products p
       LEFT JOIN branches b ON b.id = p.branch_id
       WHERE LOWER(p.estado) = 'activo'
       ORDER BY p.stock ASC
       LIMIT ${MAX_ROWS}`
    ),

    // Tab CxC — deuda real es total - received_amount (lo que el cliente ya
    // pagó vía client_credit_payments actualiza received_amount, ver
    // server/routes/clientes-creditos.routes.js). El filtro anterior usaba
    // delivery_cash_status (un campo de logística de delivery, no de cobro
    // de crédito) y sumaba s.total completo sin restar los pagos — por eso
    // un cliente ya saldado seguía apareciendo con la deuda íntegra aquí,
    // aunque el propio POS (Fase 1 de créditos) ya lo mostraba en $0.
    query(
      `SELECT
         COALESCE(s.client_name_snapshot, c.nombre, '—')       AS cliente,
         COALESCE(s.client_tax_id_snapshot, c.cedula, '—')     AS rnc,
         COALESCE(s.client_phone_snapshot, c.telefono, '—')    AS telefono,
         s.branch_id,
         s.branch_id                                             AS branchId,
         b.nombre                                              AS sucursal,
         SUM(COALESCE(s.total,0) - COALESCE(s.received_amount,0)) AS deuda,
         MAX(s.created_at)                                      AS ultima_compra,
         'Pendiente'                                            AS estado
       FROM sales s
       LEFT JOIN clients c ON s.client_id = c.id
       LEFT JOIN branches b ON b.id = s.branch_id
       WHERE s.payment_method = 'credito'
         AND s.sale_status = 'pagada'
         AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'
         AND COALESCE(s.total,0) > COALESCE(s.received_amount,0)
       GROUP BY s.client_id, s.client_name_snapshot, s.client_tax_id_snapshot, s.client_phone_snapshot, s.branch_id, b.nombre
       ORDER BY deuda DESC
       LIMIT ${MAX_ROWS}`
    ),

    // Tab clientes
    query(
      `SELECT
         c.nombre                       AS nombre,
         COALESCE(c.cedula,'—')         AS rnc,
         COALESCE(c.telefono,'—')       AS telefono,
         COALESCE(c.email,'—')          AS correo,
         COUNT(s.id)                    AS compras,
         MAX(s.created_at)              AS ultima_visita
       FROM clients c
       LEFT JOIN sales s ON s.client_id = c.id
         AND s.sale_status = 'pagada'
         AND DATE(s.created_at) >= date('now','-30 days')
       GROUP BY c.id, c.nombre, c.cedula, c.telefono, c.email
       ORDER BY compras DESC
       LIMIT ${MAX_ROWS}`
    ),

    // Tab cierres de caja — usa cash_sessions (tiene apertura + cierre)
    query(
      `SELECT
         cs.opened_at                                                 AS fecha_apertura,
         COALESCE(cs.closed_at, NULL)                                 AS fecha_cierre,
         cs.branch_id,
         cs.branch_id                                                 AS branchId,
         b.nombre                                                     AS sucursal,
         COALESCE(cr.nombre, 'Caja')                                  AS caja,
         COALESCE(cs.opened_by_user_name, '—')                        AS cajero_apertura,
         COALESCE(cs.closed_by_user_name, '—')                        AS cajero_cierre,
         cs.opened_amount                                             AS monto_apertura,
         COALESCE(cs.expected_amount, 0)                              AS total_ventas,
         COALESCE(cs.counted_amount, 0)                               AS monto_contado,
         COALESCE(cs.difference_amount, 0)                            AS diferencia,
         CASE cs.status
           WHEN 'open'   THEN 'Abierta'
           WHEN 'closed' THEN
             CASE WHEN ABS(COALESCE(cs.difference_amount,0)) < 5
                  THEN 'Cerrada ✓' ELSE 'Cerrada ⚠' END
           ELSE cs.status
         END                                                          AS estado
       FROM cash_sessions cs
       LEFT JOIN cash_registers cr ON cs.cash_register_id = cr.id
       LEFT JOIN branches b ON b.id = cs.branch_id
       WHERE DATE(cs.opened_at) >= date('now','-30 days')
       ORDER BY cs.opened_at DESC
       LIMIT ${MAX_ROWS}`
    ),
  ]);

  // Facturas = mismas filas de ventas con layout diferente
  const facturas = ventas.map(v => ({
    fecha:    v.fecha,
    ncf:      v.factura,
    tipo_ncf: null,
    branch_id: v.branch_id,
    branchId: v.branch_id ? Number(v.branch_id) : null,
    sucursal: v.sucursal || '',
    cliente:  v.cliente,
    rnc:      null,
    descuento: v.descuento || 0,
    descuento_productos: v.descuento_productos || 0,
    descuento_global: v.descuento_global || 0,
    total:    v.total,
    itbis:    v.itbis,
    estado:   'Emitida',
  }));

  // ITBIS = desglose de cada venta
  const itbis = ventas.map(v => ({
    fecha:          v.fecha,
    ncf:            v.factura,
    tipo_ncf:       null,
    branch_id:      v.branch_id,
    branchId:       v.branch_id ? Number(v.branch_id) : null,
    sucursal:       v.sucursal || '',
    descuento:      v.descuento || 0,
    descuento_productos: v.descuento_productos || 0,
    descuento_global: v.descuento_global || 0,
    base_imponible: safeNum(v.total) - safeNum(v.itbis),
    itbis:          v.itbis,
    total:          v.total,
  }));

  // Mensual — agrupado por mes desde ventas
  const byMonth = {};
  for (const v of ventas) {
    const mes = isoDate(v.fecha)?.slice(0, 7) || '—';
    const branchId = v.branch_id ? Number(v.branch_id) : null;
    const key = `${mes}::${branchId || 'global'}`;
    if (!byMonth[key]) byMonth[key] = { mes, branch_id: branchId, branchId, sucursal: v.sucursal || 'Global', ventas: 0, descuentos: 0, facturas: 0, itbis: 0, clientes_nuevos: 0 };
    byMonth[key].ventas   += safeNum(v.total);
    byMonth[key].descuentos += safeNum(v.descuento);
    byMonth[key].facturas += 1;
    byMonth[key].itbis    += safeNum(v.itbis);
  }
  const mensual = Object.values(byMonth).sort((a, b) => b.mes.localeCompare(a.mes) || String(a.sucursal || '').localeCompare(String(b.sucursal || '')));

  return {
    ventas:     normalize(ventas),
    facturas:   normalize(facturas),
    productos:  normalize(productos),
    inventario: normalize(inventario),
    itbis:      normalize(itbis),
    cxc:        normalize(cxc),
    clientes:   normalize(clientes),
    cierres:    normalize(cierres),
    mensual:    normalize(mensual),
  };
}

// ── Datos crudos para el Sistema Contable (Portal del Contador) ────────────
// A diferencia de buildReportesTabs() (solo KPIs de negocio), esto trae el
// detalle necesario para que tecno-caja-contadores genere asientos contables
// automáticamente: costo de venta por factura, método de pago a suplidor,
// y desglose de cada cierre de caja por método de pago.

async function buildContabilidadFeed() {
  const [ventas, compras, gastos, cierres] = await Promise.all([

    // Ventas con costo de venta (COGS) vía inventory_movements.sale_id.
    // quantity_change es negativo en una venta (baja de stock), de ahí el *-1.
    query(
      `SELECT
         s.id,
         s.created_at                                                   AS fecha,
         s.invoice_number                                               AS factura,
         s.payment_method                                                AS metodo_pago,
         s.branch_id,
         b.nombre                                                        AS sucursal,
         s.cash_session_id                                               AS cash_session_id,
         s.subtotal,
         s.discount                                                       AS descuento,
         s.discount_items_amount                                          AS descuento_productos,
         s.discount_global_amount                                         AS descuento_global,
         s.tax                                                          AS itbis,
         s.total,
         COALESCE(s.client_name_snapshot, c.nombre, 'Consumidor Final') AS cliente,
         COALESCE(SUM(im.quantity_change * im.unit_cost), 0) * -1        AS costo_venta
       FROM sales s
       LEFT JOIN clients c ON s.client_id = c.id
       LEFT JOIN branches b ON b.id = s.branch_id
       LEFT JOIN inventory_movements im ON im.sale_id = s.id AND im.movement_type = 'venta'
       WHERE s.sale_status = 'pagada'
         AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'
         AND DATE(s.created_at) >= date('now','-30 days')
       GROUP BY s.id, s.created_at, s.invoice_number, s.payment_method, s.branch_id, b.nombre, s.cash_session_id, s.subtotal, s.discount, s.discount_items_amount, s.discount_global_amount, s.tax, s.total, cliente
       ORDER BY s.created_at DESC
       LIMIT ${MAX_ROWS}`
    ),

    // Compras (facturas de suplidor) con el método de pago más reciente registrado.
    query(
      `SELECT
         si.id,
         si.issued_at                                                   AS fecha,
         si.invoice_number                                              AS numero,
         si.ncf,
         p.branch_id,
         b.nombre                                                        AS sucursal,
         si.total_amount                                                AS total,
         si.itbis_amount                                                AS itbis,
         sup.nombre                                                     AS proveedor,
         (SELECT sp.metodo_pago FROM supplier_payments sp
           WHERE sp.invoice_id = si.id ORDER BY sp.fecha_pago DESC LIMIT 1)    AS metodo_pago
       FROM supplier_invoices si
       LEFT JOIN suppliers sup ON si.supplier_id = sup.id
       LEFT JOIN purchases p ON p.supplier_invoice_id = si.id
       LEFT JOIN branches b ON b.id = p.branch_id
       WHERE si.issued_at >= date('now','-30 days')
       ORDER BY si.issued_at DESC
       LIMIT ${MAX_ROWS}`
    ).catch(() => []),

    // Gastos — dos fuentes distintas que se combinan porque no se solapan:
    // (a) retiros/salidas de la caja operativa (cash_movements), sin NCF ni
    //     categoría fiscal real, solo texto libre — el sistema contable los
    //     clasifica en "Gastos por Clasificar";
    // (b) el registro FISCAL de Gastos (server/routes/gastos.routes.js,
    //     tabla `expenses`) con categoría real, NCF, ITBIS y retenciones —
    //     antes NO viajaba a Firestore, así que el 606 del contador quedaba
    //     incompleto (Compras sí llegaba vía supplier_invoices, Gastos no).
    Promise.all([
      query(
        `SELECT
           cm.id,
           cm.happened_at                                                 AS fecha,
           cm.movement_type                                                AS categoria,
           cm.branch_id,
           b.nombre                                                        AS sucursal,
           cm.notes                                                       AS descripcion,
           ABS(cm.amount)                                                  AS monto,
           cm.created_by_user_name                                        AS registrado_por,
           'caja_operativa'                                                AS origen
         FROM cash_movements cm
         LEFT JOIN branches b ON b.id = cm.branch_id
         WHERE cm.movement_type IN ('Gasto','Pago suplidor','Devolución','Retiro de efectivo','Egreso','salida','gasto','expense')
           AND DATE(cm.happened_at) >= date('now','-30 days')
         ORDER BY cm.happened_at DESC
         LIMIT ${MAX_ROWS}`
      ).catch(() => []),
      query(
        `SELECT
           e.id,
           e.fecha                                                        AS fecha,
           e.categoria                                                    AS categoria,
           e.branch_id                                                     AS branchId,
           b.nombre                                                        AS sucursal,
           e.descripcion                                                  AS descripcion,
           e.total                                                        AS monto,
           e.created_by_user_name                                         AS registrado_por,
           'gastos_fiscal'                                                AS origen,
           e.ncf, e.tipo_ncf AS tipoNcf, e.ncf_modificado AS ncfModificado,
           e.subtotal, e.itbis, e.retencion_isr AS retencionIsr, e.retencion_itbis AS retencionItbis,
           e.forma_pago AS formaPago, e.isr_tipo_retencion AS isrTipoRetencion,
           sup.rnc AS proveedorRnc
         FROM expenses e
         LEFT JOIN suppliers sup ON sup.id = e.supplier_id
         LEFT JOIN branches b ON b.id = e.branch_id
         WHERE e.estado <> 'anulado'
           AND DATE(e.fecha) >= date('now','-30 days')
         ORDER BY e.fecha DESC
         LIMIT ${MAX_ROWS}`
      ).catch(() => []),
    ]).then(([cajaOperativa, gastosFiscal]) =>
      [...cajaOperativa, ...gastosFiscal]
        .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
        .slice(0, MAX_ROWS)
    ),

    // Cierres de caja — una fila por (sesión, método de pago) para poder
    // aislar cuánto efectivo real vs. tarjeta/transferencia se cobró.
    query(
      `SELECT
         cs.id                                                          AS session_id,
         cs.branch_id,
         b.nombre                                                       AS sucursal,
         cs.cash_register_id,
         cr.nombre                                                      AS caja,
         cs.opened_at, cs.closed_at, cs.status,
         cs.expected_amount, cs.counted_amount, cs.difference_amount,
         s.payment_method                                                AS metodo_pago,
         COALESCE(SUM(s.total), 0)                                       AS total_metodo
       FROM cash_sessions cs
       LEFT JOIN sales s ON s.cash_session_id = cs.id
         AND s.sale_status = 'pagada'
         AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'
       LEFT JOIN branches b ON b.id = cs.branch_id
       LEFT JOIN cash_registers cr ON cr.id = cs.cash_register_id
       WHERE cs.status = 'closed'
         AND DATE(cs.opened_at) >= date('now','-30 days')
       GROUP BY cs.id, cs.branch_id, b.nombre, cs.cash_register_id, cr.nombre, cs.opened_at, cs.closed_at, cs.status, cs.expected_amount, cs.counted_amount, cs.difference_amount, s.payment_method
       ORDER BY cs.opened_at DESC
       LIMIT ${MAX_ROWS}`
    ),
  ]);

  // Reagrupar cierres: de filas planas (sesión, método) a un objeto por sesión
  // con el desglose de métodos de pago adentro — más fácil de consumir para
  // generar el asiento de arqueo (Debe Caja por lo contado, Haber Ventas por
  // método, reconociendo sobrante/faltante).
  const cierresPorSesion = new Map();
  for (const row of cierres) {
    if (!cierresPorSesion.has(row.session_id)) {
      cierresPorSesion.set(row.session_id, {
        sessionId: row.session_id,
        branchId: row.branch_id ? Number(row.branch_id) : null,
        sucursal: row.sucursal || '',
        cashRegisterId: row.cash_register_id ? Number(row.cash_register_id) : null,
        caja: row.caja || '',
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        expectedAmount: safeNum(row.expected_amount),
        countedAmount: safeNum(row.counted_amount),
        differenceAmount: safeNum(row.difference_amount),
        porMetodo: {},
      });
    }
    if (row.metodo_pago) {
      cierresPorSesion.get(row.session_id).porMetodo[row.metodo_pago] = safeNum(row.total_metodo);
    }
  }

  return {
    ventas:   normalize(ventas),
    compras:  normalize(compras),
    gastos:   normalize(gastos),
    cierres:  normalize(Array.from(cierresPorSesion.values())),
  };
}

// ── Espejo de secuencias NCF (solo lectura para el Portal del Contador) ────
// Nunca es la fuente de verdad — el contador la usa para ver el estado real
// antes de pedir una edición/suspensión (ver server/sync/apply-pending-ncf.js
// y las acciones 'edit'/'suspend' de licencias/{uid}/ncf_pendientes).
async function buildNcfSequencesSnapshot() {
  const rows = await query(
    `SELECT fs.*, b.nombre AS branch_name FROM ncf_authorized_sequences fs
     LEFT JOIN branches b ON b.id = fs.branch_id
     WHERE fs.deleted_at IS NULL
     ORDER BY fs.document_type, fs.branch_id`
  );
  return rows.map(mapSequence);
}

// ── Escritura a Firestore ──────────────────────────────────────────────────

async function syncPosStatsToFirestore() {
  const licenseUid = getLicenseUid();
  if (!licenseUid) {
    console.warn('[sync-pos-stats] TECNO_CAJA_LICENSE_UID no configurado — sync omitido.');
    return { ok: false, reason: 'TECNO_CAJA_LICENSE_UID no configurado' };
  }

  let db;
  try {
    db = getDb();
  } catch (e) {
    console.warn('[sync-pos-stats] Firebase no disponible:', e.message);
    return { ok: false, reason: e.message };
  }

  try {
    console.log('[sync-pos-stats] Calculando KPIs...');
    const [posStats, tabs, contabilidad, businessProfile, ncfSequences] = await Promise.all([
      buildPosStats(),
      buildReportesTabs(),
      buildContabilidadFeed(),
      buildBusinessProfile().catch((e) => {
        console.warn('[sync-pos-stats] Perfil de negocio falló (no bloquea el resto):', e.message);
        return {};
      }),
      buildNcfSequencesSnapshot().catch((e) => {
        console.warn('[sync-pos-stats] Espejo de secuencias NCF falló (no bloquea el resto):', e.message);
        return null;
      }),
    ]);

    const licRef = db.collection('licencias').doc(licenseUid);

    // 1. Escribir posStats + perfil del negocio en el doc principal (merge
    // para no pisar otros campos como contadorId)
    await licRef.set({ posStats, ...businessProfile }, { merge: true });

    // 2. Escribir filas tabulares en sub-colección reportes/{tab}
    const repCol = licRef.collection('reportes');
    const batch  = db.batch();
    for (const [tab, rows] of Object.entries(tabs)) {
      batch.set(repCol.doc(tab), { rows, updatedAt: new Date().toISOString() });
    }
    await batch.commit();

    // 3. Escribir el detalle crudo para el Sistema Contable en
    //    contabilidad_raw/{tab} — lo consume tecno-caja-contadores para
    //    generar asientos automáticamente. Si esto falla, el sync completo
    //    debe reportar error para no aparentar datos contables frescos.
    const ctbCol = licRef.collection('contabilidad_raw');
    const ctbBatch = db.batch();
    for (const [tab, rows] of Object.entries(contabilidad)) {
      ctbBatch.set(ctbCol.doc(tab), { rows, updatedAt: new Date().toISOString() });
    }
    await ctbBatch.commit();

    // 4. Espejo de secuencias NCF aplicadas — un doc por secuencia, keyed por
    // su id local (así el Portal referencia `targetLocalSequenceId` directo
    // al pedir una edición/suspensión). Se sincroniza el set completo: los
    // docs de secuencias eliminadas localmente desde la última vez se borran
    // del espejo también, para no dejar basura obsoleta que confunda al contador.
    if (ncfSequences) {
      const ncfCol = licRef.collection('ncf_aplicadas');
      const [existingSnap, ncfBatch] = await Promise.all([ncfCol.get(), Promise.resolve(db.batch())]);
      const currentIds = new Set(ncfSequences.map((s) => String(s.id)));
      for (const doc of existingSnap.docs) {
        if (!currentIds.has(doc.id)) ncfBatch.delete(doc.ref);
      }
      for (const seq of ncfSequences) {
        ncfBatch.set(ncfCol.doc(String(seq.id)), { ...seq, updatedAt: new Date().toISOString() });
      }
      await ncfBatch.commit();
    }

    console.log(`[sync-pos-stats] ✅ OK — ${licenseUid} | hoy: RD$${posStats.ventasHoy.toFixed(2)} | mes: RD$${posStats.ventasMes.toFixed(2)}`);
    return { ok: true, licenseUid, posStats };
  } catch (e) {
    console.error('[sync-pos-stats] Error:', e.message);
    return { ok: false, reason: e.message };
  }
}

module.exports = { syncPosStatsToFirestore };

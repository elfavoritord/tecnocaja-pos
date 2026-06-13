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

// ── KPIs agregados ─────────────────────────────────────────────────────────

async function buildPosStats() {
  // Usar CURDATE() y DATE_FORMAT de MariaDB para que la comparación de fechas
  // ocurra en la zona horaria del servidor (DR, UTC-4), no en UTC del proceso Node.js.
  // Esto evita el bug donde ventas de la tarde no aparecen como "hoy".

  const [
    [ventasHoyRow],
    [ventasMesRow],
    [facturasRow],
    [itbisRow],
    [productosRow],
    [bajoInvRow],
    [cxcRow],
  ] = await Promise.all([

    // Ventas hoy — usa CURDATE() de MariaDB, no fecha JS/UTC
    query(
      `SELECT COALESCE(SUM(total),0) AS total
       FROM sales
       WHERE sale_status = 'pagada'
         AND COALESCE(fiscal_status,'emitida') <> 'cancelada'
         AND DATE(created_at) = CURDATE()`
    ),

    // Ventas mes — primer día del mes según MariaDB
    query(
      `SELECT COALESCE(SUM(total),0) AS total
       FROM sales
       WHERE sale_status = 'pagada'
         AND COALESCE(fiscal_status,'emitida') <> 'cancelada'
         AND DATE(created_at) >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`
    ),

    // Facturas mes
    query(
      `SELECT COUNT(*) AS cnt
       FROM sales
       WHERE sale_status = 'pagada'
         AND COALESCE(fiscal_status,'emitida') <> 'cancelada'
         AND DATE(created_at) >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`
    ),

    // ITBIS mes
    query(
      `SELECT COALESCE(SUM(tax),0) AS total
       FROM sales
       WHERE sale_status = 'pagada'
         AND COALESCE(fiscal_status,'emitida') <> 'cancelada'
         AND DATE(created_at) >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`
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

    // CxC: ventas a crédito sin cobrar
    query(
      `SELECT COALESCE(SUM(total),0) AS total
       FROM sales
       WHERE payment_method = 'credito'
         AND sale_status = 'pagada'
         AND delivery_cash_status IN ('pendiente','na')`
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
  // Usar DATE_SUB(CURDATE(), INTERVAL 30 DAY) en las queries en lugar de
  // calcular la fecha en JS/UTC, para respetar la zona horaria del servidor.
  const since30 = null; // se usa DATE_SUB(CURDATE(), INTERVAL 30 DAY) inline

  const [ventas, productos, inventario, cxc, clientes, cierres] = await Promise.all([

    // Tab ventas — últimos 30 días según fecha local de MariaDB
    query(
      `SELECT
         s.created_at                                                   AS fecha,
         s.invoice_number                                               AS factura,
         u.nombre                                                       AS cajero,
         COALESCE(s.client_name_snapshot, c.nombre, 'Consumidor Final') AS cliente,
         s.payment_method                                               AS metodo_pago,
         s.total,
         s.tax                                                          AS itbis
       FROM sales s
       LEFT JOIN users   u ON s.user_id   = u.id
       LEFT JOIN clients c ON s.client_id = c.id
       WHERE s.sale_status = 'pagada'
         AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'
         AND DATE(s.created_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       ORDER BY s.created_at DESC
       LIMIT ${MAX_ROWS}`
    ),

    // Tab productos (top vendidos en últimos 30 días)
    query(
      `SELECT
         p.codigo                       AS codigo,
         p.nombre                       AS nombre,
         p.categoria                    AS categoria,
         p.precio_venta                 AS precio,
         p.precio_compra                AS costo,
         p.stock                        AS stock,
         COALESCE(SUM(si.qty), 0)       AS vendidos
       FROM products p
       LEFT JOIN sale_items si ON si.product_id = p.id
       LEFT JOIN sales s ON si.sale_id = s.id
         AND s.sale_status = 'pagada'
         AND DATE(s.created_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       WHERE LOWER(p.estado) = 'activo'
       GROUP BY p.id, p.codigo, p.nombre, p.categoria, p.precio_venta, p.precio_compra, p.stock
       ORDER BY vendidos DESC
       LIMIT ${MAX_ROWS}`
    ),

    // Tab inventario
    query(
      `SELECT
         p.codigo                                               AS codigo,
         p.nombre                                               AS nombre,
         p.stock                                                AS stock,
         p.stock_min                                            AS minimo,
         CASE
           WHEN p.stock <= 0           THEN 'Sin stock'
           WHEN p.stock_min > 0
            AND p.stock <= p.stock_min THEN 'Bajo'
           ELSE 'Normal'
         END                                                    AS estado
       FROM products p
       WHERE LOWER(p.estado) = 'activo'
       ORDER BY p.stock ASC
       LIMIT ${MAX_ROWS}`
    ),

    // Tab CxC
    query(
      `SELECT
         COALESCE(s.client_name_snapshot, c.nombre, '—')       AS cliente,
         COALESCE(s.client_tax_id_snapshot, c.cedula, '—')     AS rnc,
         COALESCE(s.client_phone_snapshot, c.telefono, '—')    AS telefono,
         SUM(s.total)                                           AS deuda,
         MAX(s.created_at)                                      AS ultima_compra,
         'Pendiente'                                            AS estado
       FROM sales s
       LEFT JOIN clients c ON s.client_id = c.id
       WHERE s.payment_method = 'credito'
         AND s.sale_status = 'pagada'
         AND s.delivery_cash_status IN ('pendiente','na')
       GROUP BY s.client_id, s.client_name_snapshot, s.client_tax_id_snapshot, s.client_phone_snapshot
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
         AND DATE(s.created_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY c.id, c.nombre, c.cedula, c.telefono, c.email
       ORDER BY compras DESC
       LIMIT ${MAX_ROWS}`
    ),

    // Tab cierres de caja — usa cash_sessions (tiene apertura + cierre)
    query(
      `SELECT
         cs.opened_at                                                 AS fecha_apertura,
         COALESCE(cs.closed_at, NULL)                                 AS fecha_cierre,
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
       WHERE DATE(cs.opened_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       ORDER BY cs.opened_at DESC
       LIMIT ${MAX_ROWS}`
    ),
  ]);

  // Facturas = mismas filas de ventas con layout diferente
  const facturas = ventas.map(v => ({
    fecha:    v.fecha,
    ncf:      v.factura,
    tipo_ncf: null,
    cliente:  v.cliente,
    rnc:      null,
    total:    v.total,
    itbis:    v.itbis,
    estado:   'Emitida',
  }));

  // ITBIS = desglose de cada venta
  const itbis = ventas.map(v => ({
    fecha:          v.fecha,
    ncf:            v.factura,
    tipo_ncf:       null,
    base_imponible: safeNum(v.total) - safeNum(v.itbis),
    itbis:          v.itbis,
    total:          v.total,
  }));

  // Mensual — agrupado por mes desde ventas
  const byMonth = {};
  for (const v of ventas) {
    const mes = isoDate(v.fecha)?.slice(0, 7) || '—';
    if (!byMonth[mes]) byMonth[mes] = { mes, ventas: 0, facturas: 0, itbis: 0, clientes_nuevos: 0 };
    byMonth[mes].ventas   += safeNum(v.total);
    byMonth[mes].facturas += 1;
    byMonth[mes].itbis    += safeNum(v.itbis);
  }
  const mensual = Object.values(byMonth).sort((a, b) => b.mes.localeCompare(a.mes));

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
    const [posStats, tabs] = await Promise.all([buildPosStats(), buildReportesTabs()]);

    const licRef = db.collection('licencias').doc(licenseUid);

    // 1. Escribir posStats en el doc principal (merge para no pisar otros campos)
    await licRef.set({ posStats }, { merge: true });

    // 2. Escribir filas tabulares en sub-colección reportes/{tab}
    const repCol = licRef.collection('reportes');
    const batch  = db.batch();
    for (const [tab, rows] of Object.entries(tabs)) {
      batch.set(repCol.doc(tab), { rows, updatedAt: new Date().toISOString() });
    }
    await batch.commit();

    console.log(`[sync-pos-stats] ✅ OK — ${licenseUid} | hoy: RD$${posStats.ventasHoy.toFixed(2)} | mes: RD$${posStats.ventasMes.toFixed(2)}`);
    return { ok: true, licenseUid, posStats };
  } catch (e) {
    console.error('[sync-pos-stats] Error:', e.message);
    return { ok: false, reason: e.message };
  }
}

module.exports = { syncPosStatsToFirestore };

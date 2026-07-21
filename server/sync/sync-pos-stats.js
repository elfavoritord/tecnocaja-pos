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

// ── Perfil del negocio (RNC, propietario, teléfono) ─────────────────────────
// registerPosLicenseInFirestore() solo escribe el doc una vez al completar el
// asistente inicial y no incluye RNC/propietario — por eso el Portal del
// Contador los mostraba en blanco. Se sincroniza aquí también, en cada venta,
// para que se autocorrija sin tener que rehacer el asistente.

async function buildBusinessProfile() {
  const [cfgRow, adminRow, branchRows] = await Promise.all([
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
    query(`SELECT id, nombre FROM branches WHERE estado <> 'Eliminada' ORDER BY nombre`).catch(() => []),
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
  profile.sucursales = (branchRows || []).map((b) => ({ id: Number(b.id), nombre: b.nombre }));
  if (cfg.phone) profile.telefono = cfg.phone;
  if (admin.nombre) profile.propietario = admin.nombre;
  if (admin.email) profile.correo = admin.email;
  return profile;
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
         s.cash_session_id                                               AS cash_session_id,
         s.subtotal,
         s.tax                                                          AS itbis,
         s.total,
         COALESCE(s.client_name_snapshot, c.nombre, 'Consumidor Final') AS cliente,
         COALESCE(SUM(im.quantity_change * im.unit_cost), 0) * -1        AS costo_venta
       FROM sales s
       LEFT JOIN clients c ON s.client_id = c.id
       LEFT JOIN inventory_movements im ON im.sale_id = s.id AND im.movement_type = 'venta'
       WHERE s.sale_status = 'pagada'
         AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'
         AND DATE(s.created_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY s.id, s.created_at, s.invoice_number, s.payment_method, s.cash_session_id, s.subtotal, s.tax, s.total, cliente
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
         si.total_amount                                                AS total,
         si.itbis_amount                                                AS itbis,
         sup.nombre                                                     AS proveedor,
         (SELECT sp.metodo_pago FROM supplier_payments sp
           WHERE sp.invoice_id = si.id ORDER BY sp.fecha_pago DESC LIMIT 1)    AS metodo_pago
       FROM supplier_invoices si
       LEFT JOIN suppliers sup ON si.supplier_id = sup.id
       WHERE si.issued_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       ORDER BY si.issued_at DESC
       LIMIT ${MAX_ROWS}`
    ).catch(() => []),

    // Gastos — mismo origen que /api/reports/advanced/gastos del POS. No hay
    // categoría contable real (Alquiler/Sueldos/etc.), solo 4 tipos genéricos
    // + texto libre — el sistema contable los clasifica en "Gastos por Clasificar".
    query(
      `SELECT
         cm.id,
         cm.happened_at                                                 AS fecha,
         cm.movement_type                                                AS categoria,
         cm.notes                                                       AS descripcion,
         ABS(cm.amount)                                                  AS monto,
         cm.created_by_user_name                                        AS registrado_por
       FROM cash_movements cm
       WHERE cm.movement_type IN ('Gasto','Pago suplidor','Devolución','Retiro de efectivo','Egreso','salida','gasto','expense')
         AND DATE(cm.happened_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       ORDER BY cm.happened_at DESC
       LIMIT ${MAX_ROWS}`
    ).catch(() => []),

    // Cierres de caja — una fila por (sesión, método de pago) para poder
    // aislar cuánto efectivo real vs. tarjeta/transferencia se cobró.
    query(
      `SELECT
         cs.id                                                          AS session_id,
         cs.opened_at, cs.closed_at, cs.status,
         cs.expected_amount, cs.counted_amount, cs.difference_amount,
         s.payment_method                                                AS metodo_pago,
         COALESCE(SUM(s.total), 0)                                       AS total_metodo
       FROM cash_sessions cs
       LEFT JOIN sales s ON s.cash_session_id = cs.id
         AND s.sale_status = 'pagada'
         AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'
       WHERE cs.status = 'closed'
         AND DATE(cs.opened_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY cs.id, cs.opened_at, cs.closed_at, cs.status, cs.expected_amount, cs.counted_amount, cs.difference_amount, s.payment_method
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
    const [posStats, tabs, contabilidad, businessProfile] = await Promise.all([
      buildPosStats(),
      buildReportesTabs(),
      buildContabilidadFeed().catch((e) => {
        console.warn('[sync-pos-stats] Feed contable falló (no bloquea el resto):', e.message);
        return null;
      }),
      buildBusinessProfile().catch((e) => {
        console.warn('[sync-pos-stats] Perfil de negocio falló (no bloquea el resto):', e.message);
        return {};
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
    //    generar asientos automáticamente. Si falló el cálculo, no se toca
    //    (los otros dos bloques ya se guardaron igual).
    if (contabilidad) {
      const ctbCol = licRef.collection('contabilidad_raw');
      const ctbBatch = db.batch();
      for (const [tab, rows] of Object.entries(contabilidad)) {
        ctbBatch.set(ctbCol.doc(tab), { rows, updatedAt: new Date().toISOString() });
      }
      await ctbBatch.commit();
    }

    console.log(`[sync-pos-stats] ✅ OK — ${licenseUid} | hoy: RD$${posStats.ventasHoy.toFixed(2)} | mes: RD$${posStats.ventasMes.toFixed(2)}`);
    return { ok: true, licenseUid, posStats };
  } catch (e) {
    console.error('[sync-pos-stats] Error:', e.message);
    return { ok: false, reason: e.message };
  }
}

module.exports = { syncPosStatsToFirestore };

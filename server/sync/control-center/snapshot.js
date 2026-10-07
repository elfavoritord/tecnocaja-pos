'use strict';

/**
 * server/sync/control-center/snapshot.js
 *
 * Junta todo lo que publica el Centro de Control:
 *   collectSnapshot() → lee la BD (solo lectura) y arma hechos + estado.
 *   buildScopeDocuments() → los documentos de un alcance (negocio o sucursal).
 *   buildDayDocuments() → los documentos dailyStats de los días pedidos.
 *
 * Una consulta que falle (tabla que no existe en esa instalación, columna
 * vieja…) deja su sección vacía y se reporta en `warnings`; nunca tumba el
 * resto. Solo los totales de ventas son obligatorios.
 */

const queries = require('./queries');
const periodsLib = require('./periods');
const factsLib = require('./facts');
const state = require('./state');
const { buildAlerts } = require('./alerts');

const SCHEMA_VERSION = 1;

async function safe(warnings, label, fn, fallback = []) {
  try {
    const result = await fn();
    return result === undefined || result === null ? fallback : result;
  } catch (error) {
    warnings.push(`${label}: ${String(error?.message || error).slice(0, 160)}`);
    return fallback;
  }
}

/**
 * Hechos diarios de un rango (lo que más pesa). `withCustomers` agrega la
 * consulta de primeras compras (recorre toda la tabla de ventas; solo en las
 * corridas completas).
 */
async function collectFacts(query, { fromDay, toDay }, { warnings = [], customerFirsts = null } = {}) {
  const from = `${fromDay} 00:00:00`;
  const to = `${toDay} 23:59:59`;
  const [totals, dims, hours, items, cancelled, returns, collections, expenses, outflows] = await Promise.all([
    queries.salesTotalsByDay(query, from, to),
    safe(warnings, 'ventas por dimensión', () => queries.salesDimsByDay(query, from, to)),
    safe(warnings, 'ventas por hora', () => queries.salesHoursByDay(query, from, to)),
    safe(warnings, 'productos vendidos', () => queries.itemsByDay(query, from, to)),
    safe(warnings, 'anulaciones', () => queries.cancelledByDay(query, from, to)),
    safe(warnings, 'devoluciones', () => queries.returnsByDay(query, from, to)),
    safe(warnings, 'cobros de crédito', () => queries.collectionsByDay(query, from, to)),
    safe(warnings, 'gastos', () => queries.expensesByDay(query, fromDay, toDay)),
    safe(warnings, 'salidas de caja', () => queries.outflowsByDay(query, from, to)),
  ]);
  return factsLib.buildFacts(
    { totals, dims, hours, items, cancelled, returns, collections, expenses, outflows, customerFirsts },
    { fromDay, toDay }
  );
}

async function collectSnapshot({
  query,
  now = new Date(),
  cachedFacts = null,
  cachedMonths = null,
  full = true,
  mapSequence = null,
  syncInfo = null,
}) {
  const warnings = [];
  const p = periodsLib.buildPeriods(now);
  const today = p.today;

  const [configRows, branchRows, registerRows, userRows, paymentRows] = await Promise.all([
    safe(warnings, 'configuración', () => queries.businessConfig(query)),
    safe(warnings, 'sucursales', () => queries.branches(query)),
    safe(warnings, 'cajas', () => queries.cashRegisters(query)),
    safe(warnings, 'usuarios', () => queries.staffUsers(query)),
    safe(warnings, 'métodos de pago', () => queries.paymentMethods(query)),
  ]);
  const config = configRows[0] || {};
  const catalog = state.buildCatalog({ branches: branchRows, registers: registerRows, users: userRows, paymentMethods: paymentRows });

  // Hechos: en corrida rápida solo se recalcula HOY y se reusan los días
  // anteriores ya calculados; en corrida completa, toda la ventana.
  let facts;
  let customerFirsts = null;
  if (full || !cachedFacts) {
    customerFirsts = await safe(warnings, 'clientes nuevos', () => queries.customerFirstPurchases(query), null);
    facts = await collectFacts(query, { fromDay: p.facts.fromDay, toDay: today }, { warnings, customerFirsts });
  } else {
    facts = new Map(cachedFacts);
    const todayFacts = await collectFacts(query, { fromDay: today, toDay: today }, { warnings });
    // Los clientes nuevos de hoy se recalculan en la próxima corrida completa;
    // se conserva el valor ya calculado para no perderlo.
    const previous = cachedFacts.get(today);
    const fresh = todayFacts.get(today) || new Map();
    if (previous) {
      for (const [branchKey, value] of fresh.entries()) {
        const old = previous.get(branchKey);
        if (old) {
          value.newCustomers = old.newCustomers;
          if (old.newCustomersBranch) value.newCustomersBranch = old.newCustomersBranch;
        }
      }
    }
    facts.set(today, fresh);
    // Quitar días que ya salieron de la ventana.
    for (const day of [...facts.keys()]) {
      if (day < p.facts.fromDay) facts.delete(day);
    }
  }

  const monthsFrom = `${periodsLib.lastMonths(today, 13)[0]}-01 00:00:00`;
  const recentFrom = periodsLib.addDays(today, -30);
  const [
    compareToday, compareYesterday, compareWeek, compareMonth,
    months, pendingCharge,
    productRows, branchInventory, categoryRows,
    openSessions, closedSessions,
    openReceivables, recentCollections, clientsCountRows, activity90, activityMonth,
    ecfCounts, ecfOpen, ecfDocuments, ncfUsage, ncfSequences, ncfLegacy,
    deliveryStatus, deliveryClients, deliveryDrivers, deliveryActive, deliveryCash,
    lanTerminals,
  ] = await Promise.all([
    safe(warnings, 'comparación hoy', () => queries.rangeTotals(query, p.compare.today.from, p.compare.today.to), {}),
    safe(warnings, 'comparación ayer', () => queries.rangeTotals(query, p.compare.yesterday.from, p.compare.yesterday.to), {}),
    safe(warnings, 'comparación semana', () => queries.rangeTotals(query, p.compare.week.from, p.compare.week.to), {}),
    safe(warnings, 'comparación mes', () => queries.rangeTotals(query, p.compare.month.from, p.compare.month.to), {}),
    full || !cachedMonths
      ? safe(warnings, 'ventas por mes', () => queries.salesByMonth(query, monthsFrom), null)
      : Promise.resolve(cachedMonths),
    safe(warnings, 'ventas pendientes de cobro', () => queries.pendingChargeSales(query)),
    // null = la consulta falló: así no se publica un catálogo vacío encima del bueno.
    safe(warnings, 'productos', () => queries.products(query), null),
    safe(warnings, 'inventario por sucursal', () => queries.branchInventory(query)),
    safe(warnings, 'categorías', () => queries.categories(query)),
    safe(warnings, 'cajas abiertas', () => queries.openCashSessions(query)),
    safe(warnings, 'cierres de caja', () => queries.recentClosedSessions(query, 60)),
    safe(warnings, 'cuentas por cobrar', () => queries.openReceivables(query)),
    safe(warnings, 'abonos recientes', () => queries.recentCollections(query, 40)),
    safe(warnings, 'total de clientes', () => queries.clientsCount(query)),
    safe(warnings, 'clientes 90 días', () => queries.customerActivity(query, p.last90.from, p.last90.to)),
    safe(warnings, 'clientes del mes', () => queries.customerActivity(query, p.periods.month.from, p.periods.month.to)),
    safe(warnings, 'e-CF', () => queries.ecfCounts(query, `${[p.periods.month.fromDay, recentFrom].sort()[0]} 00:00:00`)),
    safe(warnings, 'e-CF abiertos', () => queries.ecfOpenCounts(query)),
    safe(warnings, 'e-CF recientes', () => queries.ecfRecentDocuments(query, `${recentFrom} 00:00:00`, 60)),
    safe(warnings, 'NCF', () => queries.ncfUsage(query, p.periods.month.from, p.periods.month.to)),
    safe(warnings, 'secuencias NCF', () => queries.ncfAuthorizedSequences(query)),
    safe(warnings, 'secuencias NCF (antiguas)', () => queries.ncfLegacySequences(query)),
    safe(warnings, 'delivery', () => queries.deliveryByStatus(query, p.periods.month.from, p.periods.month.to)),
    safe(warnings, 'clientes delivery', () => queries.deliveryClients(query, p.periods.month.from, p.periods.month.to)),
    safe(warnings, 'repartidores', () => queries.deliveryByDriver(query, p.periods.month.from, p.periods.month.to)),
    safe(warnings, 'pedidos activos', () => queries.deliveryActiveOrders(query, `${p.yesterday} 00:00:00`, 40)),
    safe(warnings, 'cobros contra entrega', () => queries.deliveryPendingCash(query)),
    safe(warnings, 'terminales LAN', () => queries.lanTerminals(query)),
  ]);

  const openIds = openSessions.map((s) => Number(s.id)).filter((id) => id > 0);
  const [sessionSales, sessionMovements, sessionCollections] = await Promise.all([
    safe(warnings, 'ventas del turno', () => queries.sessionSales(query, openIds)),
    safe(warnings, 'movimientos del turno', () => queries.sessionMovements(query, openIds)),
    safe(warnings, 'cobros del turno', () => queries.sessionCollections(query, openIds)),
  ]);

  const activeBranches = [...catalog.branches.values()].filter((b) => b.active);
  const multiBranch = activeBranches.length > 1;

  return {
    schemaVersion: SCHEMA_VERSION,
    periods: p,
    today,
    nowText: p.nowText,
    full,
    warnings,
    config,
    catalog,
    multiBranch,
    branchKeys: multiBranch ? activeBranches.map((b) => b.id) : [],
    facts,
    compare: {
      today: factsLib.rangeTotalsByBranch(compareToday),
      yesterday: factsLib.rangeTotalsByBranch(compareYesterday),
      week: factsLib.rangeTotalsByBranch(compareWeek),
      month: factsLib.rangeTotalsByBranch(compareMonth),
    },
    months,
    pendingCharge,
    products: productRows || [],
    productsLoaded: productRows !== null,
    categories: categoryRows,
    branchInventory,
    openSessions,
    closedSessions,
    sessionSales,
    sessionMovements,
    sessionCollections,
    openReceivables,
    recentCollections,
    clientsCount: Number(clientsCountRows[0]?.n || 0),
    activity90,
    activityMonth,
    ecfCounts,
    ecfOpen,
    ecfDocuments,
    ncfUsage,
    ncfSequences,
    ncfLegacy,
    mapSequence,
    deliveryStatus,
    deliveryClients,
    deliveryDrivers,
    deliveryActive,
    deliveryCash,
    lanTerminals,
    syncInfo,
  };
}

// ── Documentos por alcance ──────────────────────────────────────────────────

function itemsForDays(facts, days, branchKey) {
  const merged = factsLib.mergeFacts(facts, days, branchKey);
  return merged.items;
}

function lastSoldByProduct(facts, days, branchKey) {
  const out = {};
  for (const day of [...days].sort().reverse()) {
    const branches = facts.get(day);
    if (!branches) continue;
    for (const [key, value] of branches.entries()) {
      if (branchKey !== null && key !== branchKey) continue;
      for (const [pid, item] of Object.entries(value.items || {})) {
        if (!out[pid] && Number(item.qty) > 0) out[pid] = day;
      }
    }
  }
  return out;
}

function monthsSeries(rows, branchKey, today) {
  if (!Array.isArray(rows)) return null;
  const keys = periodsLib.lastMonths(today, 13);
  const map = new Map(keys.map((k) => [k, { key: k, sales: 0, invoices: 0, tax: 0 }]));
  for (const r of rows) {
    if (branchKey !== null && factsLib.idKey(r.b) !== branchKey) continue;
    const key = String(r.m || '').slice(0, 7);
    const acc = map.get(key);
    if (!acc) continue;
    acc.sales += factsLib.num(r.total);
    acc.invoices += factsLib.num(r.n);
    acc.tax += factsLib.num(r.tax);
  }
  return [...map.values()].map((m) => ({ ...m, sales: factsLib.round2(m.sales), tax: factsLib.round2(m.tax) }));
}

function scopeMeta(snapshot, scopeKey, kind) {
  const branchIds = scopeKey === null
    ? [...snapshot.catalog.branches.values()].map((b) => b.id)
    : [scopeKey];
  return {
    schemaVersion: snapshot.schemaVersion,
    kind,
    scope: scopeKey === null ? 'all' : 'branch',
    branchId: scopeKey,
    branchIds,
    day: snapshot.today,
    asOf: snapshot.nowText,
  };
}

/**
 * Documentos de un alcance. `scopeKey` null = todo el negocio.
 * Devuelve { summary, sales, inventory, cash, customers, fiscal, delivery,
 * catalog, catalog_p0…catalog_pN }.
 */
function buildScopeDocuments(snapshot, scopeKey = null) {
  const { periods: p, facts, catalog, today } = snapshot;
  const daysOf = (range) => periodsLib.listDays(range.fromDay, range.toDay);
  const paymentCatalog = {
    paymentLabels: catalog.paymentLabels,
    registers: catalog.registers,
    users: catalog.users,
    branches: catalog.branches,
  };

  const periodDays = {
    today: daysOf(p.periods.today),
    yesterday: daysOf(p.periods.yesterday),
    week: daysOf(p.periods.week),
    month: daysOf(p.periods.month),
  };

  const salesPeriods = {};
  for (const [key, days] of Object.entries(periodDays)) {
    const merged = factsLib.mergeFacts(facts, days, scopeKey);
    const series = key === 'today' || key === 'yesterday' ? null : factsLib.dailySeries(facts, days, scopeKey);
    const block = factsLib.salesBlock(merged, paymentCatalog, { topN: key === 'today' || key === 'yesterday' ? 10 : 15, series });
    block.label = periodsLib.PERIOD_LABELS[key];
    block.from = p.periods[key].fromDay;
    block.to = p.periods[key].toDay;
    if (scopeKey === null && snapshot.multiBranch) {
      block.byBranch = [...factsLib.factsByBranch(facts, days).entries()]
        .map(([branchKey, f]) => {
          const totals = factsLib.totalsBlock(f);
          return {
            id: branchKey,
            name: catalog.branches.get(branchKey)?.name || (branchKey === factsLib.NO_BRANCH ? 'Sin sucursal' : `Sucursal ${branchKey}`),
            sales: totals.sales,
            invoices: totals.invoices,
            avgTicket: totals.avgTicket,
            profit: totals.profit,
            costCoverage: totals.costCoverage,
            returns: totals.returns,
            cancelled: totals.cancelled,
            expenses: totals.expenses,
            newCustomers: totals.newCustomers,
          };
        })
        .sort((a, b) => b.sales - a.sales);
    }
    salesPeriods[key] = block;
  }

  const compare = {};
  for (const key of Object.keys(periodDays)) {
    compare[key] = {
      ...factsLib.compareBlock(snapshot.compare[key] || new Map(), scopeKey),
      from: p.compare[key].from,
      to: p.compare[key].to,
    };
  }

  const pendingCharge = snapshot.pendingCharge
    .filter((r) => scopeKey === null || factsLib.idKey(r.b) === scopeKey)
    .reduce((acc, r) => ({ count: acc.count + factsLib.num(r.n), amount: factsLib.round2(acc.amount + factsLib.num(r.total)) }), { count: 0, amount: 0 });

  const last30Days = daysOf(p.last30);
  const inventory = state.buildInventory({
    products: snapshot.products,
    branchInventory: snapshot.branchInventory,
    catalog,
    branchKey: scopeKey,
    items30: itemsForDays(facts, last30Days, scopeKey),
    lastSold: lastSoldByProduct(facts, daysOf(p.facts), scopeKey),
  });

  const cash = state.buildCash({
    catalog,
    branchKey: scopeKey,
    openSessions: snapshot.openSessions,
    sessionSales: snapshot.sessionSales,
    sessionMovements: snapshot.sessionMovements,
    sessionCollections: snapshot.sessionCollections,
    closedSessions: snapshot.closedSessions,
    todayByRegister: salesPeriods.today.byRegister,
    today,
    nowText: snapshot.nowText,
  });
  cash.outflowsToday = salesPeriods.today.outflowsByType;
  cash.outflowsMonth = salesPeriods.month.outflowsByType;

  const receivables = state.buildReceivables({
    openReceivables: snapshot.openReceivables,
    recentCollections: snapshot.recentCollections,
    catalog,
    branchKey: scopeKey,
    today,
  });
  receivables.collections = {
    today: salesPeriods.today.totals.collections,
    week: salesPeriods.week.totals.collections,
    month: salesPeriods.month.totals.collections,
    monthByMethod: salesPeriods.month.collectionsByMethod,
  };

  const customers = state.buildCustomers({
    clientsCount: snapshot.clientsCount,
    activity90: snapshot.activity90,
    activityMonth: snapshot.activityMonth,
    branchKey: scopeKey,
  });
  customers.newCustomers = {
    today: salesPeriods.today.totals.newCustomers,
    week: salesPeriods.week.totals.newCustomers,
    month: salesPeriods.month.totals.newCustomers,
  };
  customers.withDebt = receivables.debtorsCount;
  customers.totalReceivable = receivables.total;

  const fiscal = state.buildFiscal({
    ecfCounts: snapshot.ecfCounts,
    ecfOpen: snapshot.ecfOpen,
    ecfDocuments: snapshot.ecfDocuments,
    ncfUsage: snapshot.ncfUsage,
    sequences: snapshot.ncfSequences,
    legacySequences: snapshot.ncfLegacy,
    mapSequence: snapshot.mapSequence,
    eInvoiceEnabled: snapshot.config.e_invoice_enabled,
    branchKey: scopeKey,
    today,
    monthFrom: p.periods.month.fromDay,
  });
  fiscal.byNcfTypeMonth = salesPeriods.month.byNcfType;
  fiscal.byDocTypeMonth = salesPeriods.month.byDocType;

  const delivery = state.buildDelivery({
    byStatus: snapshot.deliveryStatus,
    clients: snapshot.deliveryClients,
    drivers: snapshot.deliveryDrivers,
    active: snapshot.deliveryActive,
    pendingCash: snapshot.deliveryCash,
    catalog,
    branchKey: scopeKey,
    today,
    monthFrom: p.periods.month.fromDay,
  });

  const sync = snapshot.syncInfo ? {
    ...snapshot.syncInfo,
    lanTerminals: (snapshot.lanTerminals || [])
      .filter((t) => scopeKey === null || !t.branch_id || String(t.branch_id) === scopeKey)
      .map((t) => ({
        id: String(t.terminal_id || ''),
        name: t.terminal_name || null,
        branchId: t.branch_id ? String(t.branch_id) : null,
        registerId: t.cash_register_id ? String(t.cash_register_id) : null,
        isMain: Number(t.is_main || 0) === 1,
        status: t.status || null,
        lastSeenAt: periodsLib.toWallText(t.last_seen_at),
      })),
    warnings: snapshot.warnings.slice(0, 10),
  } : null;

  const alerts = buildAlerts({
    inventory, cash, receivables, fiscal, delivery, sync,
    today, nowText: snapshot.nowText, branchKey: scopeKey,
  });

  const business = {
    name: snapshot.config.business_name || null,
    rnc: snapshot.config.rnc || null,
    currency: snapshot.config.currency || 'RD$',
    structureMode: snapshot.config.business_structure_mode || 'monocaja',
    businessType: snapshot.config.business_type || null,
    eInvoiceEnabled: Boolean(Number(snapshot.config.e_invoice_enabled || 0)),
    multiBranch: snapshot.multiBranch,
    branchCount: [...catalog.branches.values()].filter((b) => b.active).length,
    registerCount: [...catalog.registers.values()].filter((r) => r.active).length,
  };

  const light = (block) => ({
    totals: block.totals,
    byPayment: block.byPayment,
    series: block.series && block.series.length ? block.series : block.byHour,
    topProducts: block.topProducts.slice(0, 5),
  });

  const summary = {
    ...scopeMeta(snapshot, scopeKey, 'summary'),
    business,
    catalog: state.catalogForDoc(catalog, scopeKey),
    periods: {
      today: light(salesPeriods.today),
      yesterday: light(salesPeriods.yesterday),
      week: light(salesPeriods.week),
      month: light(salesPeriods.month),
    },
    compare,
    pendingCharge,
    inventory: {
      products: inventory.products,
      units: inventory.units,
      costValue: inventory.costValue,
      retailValue: inventory.retailValue,
      outOfStockCount: inventory.outOfStockCount,
      lowStockCount: inventory.lowStockCount,
      noMovementCount: inventory.noMovementCount,
      perBranchInventory: inventory.perBranchInventory,
    },
    receivables: {
      total: receivables.total,
      debtorsCount: receivables.debtorsCount,
      overdueDebtorsCount: receivables.overdueDebtorsCount,
      overdueAmount: receivables.overdueAmount,
    },
    customers: {
      totalClients: customers.totalClients,
      newToday: customers.newCustomers.today,
      newMonth: customers.newCustomers.month,
    },
    cash: {
      totalRegisters: cash.totalRegisters,
      openCount: cash.openCount,
      staleOpenCount: cash.staleOpenCount,
      expectedCashOpen: cash.expectedCashOpen,
      registers: cash.registers.map((r) => ({
        id: r.id,
        name: r.name,
        branchId: r.branchId,
        status: r.status,
        openedBy: r.session?.openedBy || null,
        openedAt: r.session?.openedAt || null,
        sessionSales: r.session?.sales ?? null,
        todaySales: r.today.sales,
      })),
    },
    fiscal: {
      eInvoiceEnabled: fiscal.eInvoiceEnabled,
      hasEcfData: fiscal.hasEcfData,
      today: fiscal.today,
      month: fiscal.month,
      open: fiscal.open,
      sequencesAttention: fiscal.sequences.filter((s) => s.status !== 'activo').length,
    },
    delivery: {
      used: delivery.used,
      today: delivery.today,
      pendingCash: delivery.pendingCash,
      active: delivery.active.length,
    },
    sync,
    alerts,
  };

  const salesDoc = {
    ...scopeMeta(snapshot, scopeKey, 'sales'),
    periods: salesPeriods,
    compare,
    months: monthsSeries(snapshot.months, scopeKey, today) || [],
    pendingCharge,
  };

  const docs = {
    summary,
    sales: salesDoc,
    inventory: { ...scopeMeta(snapshot, scopeKey, 'inventory'), ...inventory },
    cash: { ...scopeMeta(snapshot, scopeKey, 'cash'), ...cash },
    customers: { ...scopeMeta(snapshot, scopeKey, 'customers'), customers, receivables },
    fiscal: { ...scopeMeta(snapshot, scopeKey, 'fiscal'), ...fiscal },
    delivery: { ...scopeMeta(snapshot, scopeKey, 'delivery'), ...delivery },
  };
  Object.assign(docs, buildCatalogDocuments(snapshot, scopeKey));
  return docs;
}

/**
 * catalog (índice: cantidad, páginas, categorías del POS) y catalog_p{n}
 * (los productos). Sin `day` en la cabecera: una página solo se vuelve a
 * escribir cuando cambia un producto suyo, no cada día.
 */
function buildCatalogDocuments(snapshot, scopeKey) {
  if (!snapshot.productsLoaded) return {};
  const { day: _day, ...meta } = scopeMeta(snapshot, scopeKey, 'catalog');
  const productCatalog = state.buildProductCatalog({
    products: snapshot.products,
    branchInventory: snapshot.branchInventory,
    categories: snapshot.categories || [],
    catalog: snapshot.catalog,
    branchKey: scopeKey,
  });
  const docs = { catalog: { ...meta, ...productCatalog.index } };
  productCatalog.pages.forEach((items, page) => {
    docs[`catalog_p${page}`] = { ...meta, kind: 'catalogPage', page, items };
  });
  return docs;
}

/** dailyStats/{día}[_b{sucursal}] para los días pedidos. */
function buildDayDocuments(snapshot, days, scopeKey = null, facts = snapshot.facts) {
  const { catalog } = snapshot;
  const paymentCatalog = {
    paymentLabels: catalog.paymentLabels,
    registers: catalog.registers,
    users: catalog.users,
    branches: catalog.branches,
  };
  const branchIds = scopeKey === null ? [...catalog.branches.values()].map((b) => b.id) : [scopeKey];
  return days.map((day) => {
    const merged = factsLib.mergeFacts(facts, [day], scopeKey);
    const block = factsLib.salesBlock(merged, paymentCatalog, { topN: 30 });
    if (scopeKey === null && snapshot.multiBranch) {
      block.byBranch = [...factsLib.factsByBranch(facts, [day]).entries()].map(([branchKey, f]) => {
        const totals = factsLib.totalsBlock(f);
        return {
          id: branchKey,
          name: catalog.branches.get(branchKey)?.name || `Sucursal ${branchKey}`,
          sales: totals.sales,
          invoices: totals.invoices,
          itemsRevenue: totals.itemsRevenue,
          coveredRevenue: totals.coveredRevenue,
          coveredCost: totals.coveredCost,
          discount: totals.discount,
          expenses: totals.expenses,
        };
      });
    }
    return {
      id: scopeKey === null ? day : `${day}_b${scopeKey}`,
      data: {
        schemaVersion: snapshot.schemaVersion,
        kind: 'day',
        date: day,
        scope: scopeKey === null ? 'all' : 'branch',
        branchId: scopeKey,
        branchIds,
        ...block,
      },
    };
  });
}

function collectCustomerFirsts(query) {
  return queries.customerFirstPurchases(query);
}

module.exports = {
  SCHEMA_VERSION,
  collectFacts,
  collectCustomerFirsts,
  collectSnapshot,
  buildScopeDocuments,
  buildDayDocuments,
};

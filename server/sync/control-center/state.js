'use strict';

/**
 * server/sync/control-center/state.js
 *
 * Secciones de "estado actual" del Centro de Control: inventario, cajas,
 * clientes y cuentas por cobrar, fiscal (e-CF/NCF), delivery y catálogos.
 * Funciones puras: reciben filas de queries.js y devuelven objetos listos
 * para Firestore. `branchKey` null = todo el negocio.
 */

const { toDayKey, toWallText, diffDays } = require('./periods');
const labels = require('./labels');
const { NO_BRANCH, num, round2, idKey } = require('./facts');

const LOW_SEQUENCE_THRESHOLD = 50;

function isActiveText(value, active = ['activo', 'activa', 'active']) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return true;
  return active.includes(text);
}

function inScope(branchKey, rowBranch) {
  return branchKey === null || idKey(rowBranch) === branchKey;
}

function sortBy(list, fn) {
  return list.sort(fn);
}

// ── Catálogos ───────────────────────────────────────────────────────────────

function buildCatalog({ branches = [], registers = [], users = [], paymentMethods = [] }) {
  const branchMap = new Map();
  for (const b of branches) {
    if (String(b.estado || '').toLowerCase() === 'eliminada') continue;
    branchMap.set(String(b.id), {
      id: String(b.id),
      name: String(b.nombre || `Sucursal ${b.id}`),
      code: b.codigo || null,
      active: isActiveText(b.estado, ['activa', 'activo', 'active']),
    });
  }
  const registerMap = new Map();
  for (const r of registers) {
    if (String(r.estado || '').toLowerCase() === 'eliminada') continue;
    registerMap.set(String(r.id), {
      id: String(r.id),
      name: String(r.nombre || `Caja ${r.id}`),
      code: r.codigo || null,
      branchId: r.branch_id === null || r.branch_id === undefined ? null : String(r.branch_id),
      active: isActiveText(r.estado, ['activa', 'activo', 'active']),
      type: r.tipo_caja || null,
    });
  }
  const userMap = new Map();
  for (const u of users) {
    userMap.set(String(u.id), {
      id: String(u.id),
      name: String(u.nombre || u.usuario || `Usuario ${u.id}`),
      role: u.rol || null,
      active: isActiveText(u.estado),
      branchId: u.branch_id || u.sucursal_id ? String(u.branch_id || u.sucursal_id) : null,
    });
  }
  const paymentLabels = {};
  const paymentList = [];
  for (const m of paymentMethods) {
    const code = String(m.codigo || '').trim();
    if (!code) continue;
    paymentLabels[code] = String(m.nombre || code);
    paymentList.push({ code, label: paymentLabels[code], active: isActiveText(m.estado) });
  }
  return { branches: branchMap, registers: registerMap, users: userMap, paymentLabels, paymentList };
}

function catalogForDoc(catalog, branchKey = null) {
  const branches = [...catalog.branches.values()];
  const registers = [...catalog.registers.values()]
    .filter((r) => branchKey === null || r.branchId === branchKey);
  return {
    branches: branchKey === null ? branches : branches.filter((b) => b.id === branchKey),
    registers,
    users: [...catalog.users.values()].map(({ id, name, role, active, branchId }) => ({ id, name, role, active, branchId })),
    paymentMethods: catalog.paymentList,
  };
}

// ── Inventario ──────────────────────────────────────────────────────────────

/**
 * `items30` = hechos de productos de los últimos 30 días (por producto):
 * { [productId]: { qty, rev, covCost } }. `lastSold` = { [productId]: 'YYYY-MM-DD' }.
 */
function buildInventory({
  products = [],
  branchInventory = [],
  catalog,
  branchKey = null,
  items30 = {},
  lastSold = {},
  listLimit = 40,
}) {
  const activeBranchIds = [...catalog.branches.values()].filter((b) => b.active).map((b) => b.id);
  const byBranchRows = new Map();
  for (const row of branchInventory) {
    const key = String(row.branch_id);
    if (!byBranchRows.has(key)) byBranchRows.set(key, new Map());
    byBranchRows.get(key).set(String(row.product_id), row);
  }
  const perBranchInventory = byBranchRows.size > 0 && activeBranchIds.length > 1;

  const tracked = products.filter((p) => isActiveText(p.estado) && Number(p.tracks_stock ?? 1) !== 0);

  // Una "entrada" es un producto en una sucursal (o el producto completo).
  const entries = [];
  const pushEntry = (p, branchId, stock, stockMin) => {
    const id = String(p.id);
    const sold = items30[id] || { qty: 0, rev: 0 };
    const sold30 = num(sold.qty);
    entries.push({
      id,
      code: p.codigo || '',
      name: String(p.nombre || 'Producto'),
      category: String(p.categoria || '') || 'Sin categoría',
      unit: p.unidad || '',
      price: round2(p.precio_venta),
      cost: round2(p.precio_compra),
      stock: round2(stock),
      minStock: round2(stockMin),
      branchId,
      branchName: branchId ? (catalog.branches.get(branchId)?.name || `Sucursal ${branchId}`) : null,
      sold30: round2(sold30),
      revenue30: round2(sold.rev),
      lastSoldDay: lastSold[id] || null,
      daysOfStock: sold30 > 0 && stock > 0 ? Math.round(stock / (sold30 / 30)) : null,
    });
  };

  for (const p of tracked) {
    const id = String(p.id);
    if (branchKey !== null) {
      const row = byBranchRows.get(branchKey)?.get(id);
      if (row) pushEntry(p, branchKey, num(row.stock), num(row.stock_min ?? p.stock_min));
      else if (!byBranchRows.size) pushEntry(p, branchKey, num(p.stock), num(p.stock_min));
    } else if (perBranchInventory) {
      for (const branchId of activeBranchIds) {
        const row = byBranchRows.get(branchId)?.get(id);
        if (row) pushEntry(p, branchId, num(row.stock), num(row.stock_min ?? p.stock_min));
      }
    } else {
      pushEntry(p, null, num(p.stock), num(p.stock_min));
    }
  }

  // Totales por producto (en la vista global multisucursal, sumando sucursales).
  const perProduct = new Map();
  for (const e of entries) {
    const acc = perProduct.get(e.id) || { ...e, stock: 0, branches: 0 };
    acc.stock += Math.max(0, e.stock);
    acc.branches += 1;
    perProduct.set(e.id, acc);
  }

  let units = 0;
  let costValue = 0;
  let retailValue = 0;
  let missingCost = 0;
  for (const e of entries) {
    const stock = Math.max(0, e.stock);
    units += stock;
    retailValue += stock * e.price;
    if (e.cost > 0) costValue += stock * e.cost;
    else if (stock > 0) missingCost += 1;
  }

  const outEntries = entries.filter((e) => e.stock <= 0);
  const lowEntries = entries.filter((e) => e.stock > 0 && e.minStock > 0 && e.stock <= e.minStock);
  const noMovement = [...perProduct.values()].filter((p) => p.stock > 0 && !(p.sold30 > 0));

  const byCategory = new Map();
  for (const e of entries) {
    const key = e.category;
    const acc = byCategory.get(key) || { name: key, products: new Set(), units: 0, costValue: 0, retailValue: 0, outOfStock: 0, lowStock: 0, sold30: 0 };
    const stock = Math.max(0, e.stock);
    acc.products.add(e.id);
    acc.units += stock;
    acc.retailValue += stock * e.price;
    if (e.cost > 0) acc.costValue += stock * e.cost;
    if (e.stock <= 0) acc.outOfStock += 1;
    else if (e.minStock > 0 && e.stock <= e.minStock) acc.lowStock += 1;
    byCategory.set(key, acc);
  }
  for (const p of perProduct.values()) {
    const acc = byCategory.get(p.category);
    if (acc) acc.sold30 += p.sold30;
  }

  let byBranch = [];
  if (branchKey === null && perBranchInventory) {
    const map = new Map();
    for (const e of entries) {
      const acc = map.get(e.branchId) || { branchId: e.branchId, name: e.branchName, products: 0, units: 0, costValue: 0, retailValue: 0, outOfStock: 0, lowStock: 0 };
      const stock = Math.max(0, e.stock);
      acc.products += 1;
      acc.units += stock;
      acc.retailValue += stock * e.price;
      if (e.cost > 0) acc.costValue += stock * e.cost;
      if (e.stock <= 0) acc.outOfStock += 1;
      else if (e.minStock > 0 && e.stock <= e.minStock) acc.lowStock += 1;
      map.set(e.branchId, acc);
    }
    byBranch = [...map.values()].map((b) => ({
      ...b, units: round2(b.units), costValue: round2(b.costValue), retailValue: round2(b.retailValue),
    }));
  }

  const cogs30 = Object.values(items30).reduce((s, i) => s + num(i.covCost), 0);
  const rotation = costValue > 0 && cogs30 > 0
    ? {
      cogs30: round2(cogs30),
      turnsPerMonth: round2(cogs30 / costValue),
      daysOfInventory: Math.round(costValue / (cogs30 / 30)),
    }
    : null;

  const slim = (e) => ({
    id: e.id, code: e.code, name: e.name, category: e.category, unit: e.unit,
    price: e.price, cost: e.cost, stock: round2(e.stock), minStock: e.minStock,
    branchId: e.branchId, branchName: e.branchName,
    sold30: e.sold30, lastSoldDay: e.lastSoldDay, daysOfStock: e.daysOfStock,
  });

  const sellers = [...perProduct.values()].filter((p) => p.sold30 > 0);

  return {
    perBranchInventory,
    products: perProduct.size,
    trackedEntries: entries.length,
    units: round2(units),
    costValue: round2(costValue),
    retailValue: round2(retailValue),
    potentialProfit: round2(retailValue - costValue),
    missingCostProducts: missingCost,
    outOfStockCount: outEntries.length,
    lowStockCount: lowEntries.length,
    noMovementCount: noMovement.length,
    outOfStock: sortBy(outEntries, (a, b) => b.sold30 - a.sold30 || a.name.localeCompare(b.name)).slice(0, listLimit).map(slim),
    lowStock: sortBy(lowEntries, (a, b) => (a.stock / a.minStock) - (b.stock / b.minStock) || b.sold30 - a.sold30).slice(0, listLimit).map(slim),
    noMovement: sortBy(noMovement, (a, b) => (b.stock * (b.cost || b.price)) - (a.stock * (a.cost || a.price))).slice(0, listLimit).map(slim),
    topSellers: sortBy([...sellers], (a, b) => b.sold30 - a.sold30).slice(0, 20).map(slim),
    slowSellers: sortBy([...sellers], (a, b) => a.sold30 - b.sold30).slice(0, 20).map(slim),
    byCategory: [...byCategory.values()]
      .map((c) => ({
        name: c.name,
        products: c.products.size,
        units: round2(c.units),
        costValue: round2(c.costValue),
        retailValue: round2(c.retailValue),
        outOfStock: c.outOfStock,
        lowStock: c.lowStock,
        sold30: round2(c.sold30),
      }))
      .sort((a, b) => b.retailValue - a.retailValue),
    byBranch,
    rotation,
  };
}

// ── Catálogo de productos ───────────────────────────────────────────────────

const CATALOG_PAGE_SIZE = 400;

/**
 * Lista completa de productos para la app (buscar, ver y editar), en páginas
 * de `pageSize` ordenadas por ID: una venta solo cambia la página de los
 * productos vendidos. La existencia es la del alcance: la de la sucursal, o
 * la suma de sucursales cuando cada una lleva su propio inventario.
 * `categories` son las categorías del POS (las únicas que acepta al recibir
 * un producto creado en la app).
 */
function buildProductCatalog({
  products = [],
  branchInventory = [],
  categories = [],
  catalog,
  branchKey = null,
  pageSize = CATALOG_PAGE_SIZE,
}) {
  const activeBranchIds = [...catalog.branches.values()].filter((b) => b.active).map((b) => b.id);
  const rowsByProduct = new Map();
  for (const row of branchInventory) {
    const pid = String(row.product_id);
    if (!rowsByProduct.has(pid)) rowsByProduct.set(pid, new Map());
    rowsByProduct.get(pid).set(String(row.branch_id), row);
  }
  const perBranchInventory = branchInventory.length > 0 && activeBranchIds.length > 1;

  const items = [];
  for (const p of products) {
    const id = String(p.id);
    const rows = rowsByProduct.get(id);
    let stock = num(p.stock);
    let minStock = num(p.stock_min);
    let stockByBranch = null;
    if (perBranchInventory && branchKey !== null) {
      const row = rows?.get(branchKey);
      stock = row ? num(row.stock) : 0;
      if (row && row.stock_min !== null && row.stock_min !== undefined) minStock = num(row.stock_min);
    } else if (perBranchInventory) {
      stock = 0;
      stockByBranch = {};
      for (const branchId of activeBranchIds) {
        const row = rows?.get(branchId);
        if (!row) continue;
        stockByBranch[branchId] = round2(row.stock);
        stock += num(row.stock);
      }
    }
    const item = {
      id,
      code: String(p.codigo || ''),
      name: String(p.nombre || 'Producto'),
      category: String(p.categoria || ''),
      unit: String(p.unidad || ''),
      price: round2(p.precio_venta),
      cost: round2(p.precio_compra),
      stock: round2(stock),
      minStock: round2(minStock),
      active: isActiveText(p.estado),
    };
    // Lo opcional solo si existe: documentos más livianos.
    const barcode = String(p.barcode || '').trim();
    if (barcode && barcode !== item.code) item.barcode = barcode;
    if (p.marca) item.brand = String(p.marca);
    if (p.aplica_itbis !== undefined && p.aplica_itbis !== null) item.tax = Number(p.aplica_itbis) === 1;
    if (p.tracks_stock !== undefined && p.tracks_stock !== null && Number(p.tracks_stock) === 0) item.tracksStock = false;
    if (p.image_url) item.imageUrl = String(p.image_url);
    if (stockByBranch) item.stockByBranch = stockByBranch;
    items.push(item);
  }

  items.sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
  const pages = [];
  for (let i = 0; i < items.length; i += pageSize) pages.push(items.slice(i, i + pageSize));
  const categoryNames = [...new Set(categories.map((c) => String(c.nombre || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es'));

  return {
    index: {
      count: items.length,
      activeCount: items.filter((i) => i.active).length,
      pageSize,
      pages: pages.length,
      perBranchInventory,
      categories: categoryNames,
      units: [...new Set(items.map((i) => i.unit).filter(Boolean))].sort(),
    },
    pages,
  };
}

// ── Caja ────────────────────────────────────────────────────────────────────

function hoursBetween(fromText, toText) {
  const from = Date.parse(String(fromText || '').replace(' ', 'T'));
  const to = Date.parse(String(toText || '').replace(' ', 'T'));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return round2((to - from) / 3600000);
}

function buildCash({
  catalog,
  branchKey = null,
  openSessions = [],
  sessionSales = [],
  sessionMovements = [],
  sessionCollections = [],
  closedSessions = [],
  todayByRegister = [],
  today,
  nowText,
  closingsLimit = 30,
}) {
  const salesBySession = new Map();
  for (const r of sessionSales) {
    const key = String(r.sid);
    const acc = salesBySession.get(key) || { sales: 0, invoices: 0, pay: [] };
    acc.sales += num(r.total);
    acc.invoices += num(r.n);
    acc.pay.push({ code: String(r.pm), label: labels.paymentLabel(r.pm, catalog.paymentLabels), sales: round2(r.total), invoices: num(r.n) });
    salesBySession.set(key, acc);
  }
  const movementsBySession = new Map();
  for (const r of sessionMovements) {
    const key = String(r.sid);
    const list = movementsBySession.get(key) || [];
    list.push({ type: String(r.t || ''), kind: labels.outflowKind(r.t), count: num(r.n), amount: round2(r.total) });
    movementsBySession.set(key, list);
  }
  const collectionsBySession = new Map();
  for (const r of sessionCollections) {
    const key = String(r.sid);
    const acc = collectionsBySession.get(key) || { amount: 0, byMethod: [] };
    acc.amount += num(r.total);
    acc.byMethod.push({ code: String(r.pm), label: labels.paymentLabel(r.pm, catalog.paymentLabels), amount: round2(r.total) });
    collectionsBySession.set(key, acc);
  }

  const registerName = (id) => catalog.registers.get(String(id))?.name || `Caja ${id}`;
  const branchName = (id) => (id ? (catalog.branches.get(String(id))?.name || `Sucursal ${id}`) : null);

  const openByRegister = new Map();
  for (const s of openSessions) {
    if (!inScope(branchKey, s.branch_id)) continue;
    const openedAt = toWallText(s.opened_at);
    const operativeDate = toDayKey(s.operative_date) || (openedAt ? openedAt.slice(0, 10) : null);
    const sales = salesBySession.get(String(s.id)) || { sales: 0, invoices: 0, pay: [] };
    const collections = collectionsBySession.get(String(s.id)) || { amount: 0, byMethod: [] };
    openByRegister.set(String(s.cash_register_id), {
      id: String(s.id),
      openedAt,
      openedBy: s.opened_by_user_name || null,
      openingAmount: round2(s.opened_amount),
      expectedCash: round2(s.current_amount ?? s.expected_amount),
      operativeDate,
      hoursOpen: hoursBetween(openedAt, nowText),
      staleOpen: Boolean(operativeDate && today && operativeDate < today),
      sales: round2(sales.sales),
      invoices: sales.invoices,
      byPayment: sales.pay.sort((a, b) => b.sales - a.sales),
      movements: movementsBySession.get(String(s.id)) || [],
      collections: round2(collections.amount),
      collectionsByMethod: collections.byMethod,
    });
  }

  const closings = closedSessions
    .filter((s) => inScope(branchKey, s.branch_id))
    .map((s) => {
      const openedAt = toWallText(s.opened_at);
      const closedAt = toWallText(s.closed_at);
      const expected = round2(s.expected_amount);
      const counted = s.counted_amount === null || s.counted_amount === undefined ? null : round2(s.counted_amount);
      const difference = s.difference_amount === null || s.difference_amount === undefined
        ? (counted === null ? null : round2(counted - expected))
        : round2(s.difference_amount);
      return {
        id: String(s.id),
        registerId: s.cash_register_id ? String(s.cash_register_id) : null,
        registerName: s.cash_register_id ? registerName(s.cash_register_id) : 'Caja',
        branchId: s.branch_id ? String(s.branch_id) : null,
        branchName: branchName(s.branch_id),
        openedAt,
        closedAt,
        openedBy: s.opened_by_user_name || null,
        closedBy: s.closed_by_user_name || null,
        openingAmount: round2(s.opened_amount),
        expected,
        counted,
        difference,
        hours: s.duration_hours !== null && s.duration_hours !== undefined ? round2(s.duration_hours) : hoursBetween(openedAt, closedAt),
      };
    })
    .slice(0, closingsLimit);

  const lastClosingByRegister = new Map();
  for (const c of closings) {
    if (c.registerId && !lastClosingByRegister.has(c.registerId)) lastClosingByRegister.set(c.registerId, c);
  }
  const todayMap = new Map(todayByRegister.map((r) => [String(r.id), r]));

  const registers = [...catalog.registers.values()]
    .filter((r) => branchKey === null || r.branchId === branchKey)
    .map((r) => {
      const session = openByRegister.get(r.id) || null;
      const last = lastClosingByRegister.get(r.id) || null;
      const todayStats = todayMap.get(r.id);
      return {
        id: r.id,
        name: r.name,
        code: r.code,
        branchId: r.branchId,
        branchName: branchName(r.branchId),
        active: r.active,
        type: r.type,
        status: session ? 'open' : (r.active ? 'closed' : 'inactive'),
        session,
        lastClosing: last
          ? { closedAt: last.closedAt, closedBy: last.closedBy, expected: last.expected, counted: last.counted, difference: last.difference }
          : null,
        today: { sales: round2(todayStats?.sales || 0), invoices: num(todayStats?.invoices || 0) },
      };
    })
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || a.name.localeCompare(b.name));

  // Sesiones abiertas de cajas que ya no están en el catálogo (eliminadas).
  for (const [registerId, session] of openByRegister.entries()) {
    if (registers.some((r) => r.id === registerId)) continue;
    registers.push({
      id: registerId, name: registerName(registerId), code: null, branchId: null, branchName: null,
      active: true, type: null, status: 'open', session, lastClosing: null, today: { sales: 0, invoices: 0 },
    });
  }

  const closedToday = closings.filter((c) => c.closedAt && c.closedAt.slice(0, 10) === today);
  return {
    totalRegisters: registers.length,
    activeRegisters: registers.filter((r) => r.active).length,
    openCount: registers.filter((r) => r.status === 'open').length,
    staleOpenCount: registers.filter((r) => r.session?.staleOpen).length,
    expectedCashOpen: round2(registers.reduce((s, r) => s + num(r.session?.expectedCash), 0)),
    closedTodayCount: closedToday.length,
    differenceToday: round2(closedToday.reduce((s, c) => s + num(c.difference), 0)),
    registers,
    closings,
  };
}

// ── Clientes y cuentas por cobrar ───────────────────────────────────────────

function agingBucket(days) {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

function buildReceivables({ openReceivables = [], recentCollections = [], catalog, branchKey = null, today, debtorsLimit = 50 }) {
  const buckets = { '0-30': { amount: 0, invoices: 0 }, '31-60': { amount: 0, invoices: 0 }, '61-90': { amount: 0, invoices: 0 }, '90+': { amount: 0, invoices: 0 } };
  const debtors = new Map();
  let total = 0;
  let invoices = 0;
  for (const r of openReceivables) {
    if (!inScope(branchKey, r.b)) continue;
    const balance = Math.max(0, num(r.total) - num(r.paid));
    if (balance <= 0.009) continue;
    const day = toDayKey(r.created_at);
    const age = day && today ? Math.max(0, diffDays(day, today)) : 0;
    const bucket = agingBucket(age);
    buckets[bucket].amount += balance;
    buckets[bucket].invoices += 1;
    total += balance;
    invoices += 1;
    const key = r.client_id ? String(r.client_id) : `nombre:${r.name}`;
    const d = debtors.get(key) || {
      clientId: r.client_id ? String(r.client_id) : null,
      name: String(r.name || 'Cliente'),
      phone: r.phone || null,
      balance: 0,
      invoices: 0,
      oldestDay: day,
      lastInvoiceDay: day,
    };
    d.balance += balance;
    d.invoices += 1;
    if (day && (!d.oldestDay || day < d.oldestDay)) d.oldestDay = day;
    if (day && (!d.lastInvoiceDay || day > d.lastInvoiceDay)) d.lastInvoiceDay = day;
    debtors.set(key, d);
  }
  const debtorList = [...debtors.values()].map((d) => ({
    ...d,
    balance: round2(d.balance),
    oldestDays: d.oldestDay && today ? Math.max(0, diffDays(d.oldestDay, today)) : null,
  })).sort((a, b) => b.balance - a.balance);
  const overdue = debtorList.filter((d) => num(d.oldestDays) > 30);

  return {
    total: round2(total),
    invoices,
    debtorsCount: debtorList.length,
    overdueDebtorsCount: overdue.length,
    overdueAmount: round2(overdue.reduce((s, d) => s + d.balance, 0)),
    aging: Object.entries(buckets).map(([key, v]) => ({ key, amount: round2(v.amount), invoices: v.invoices })),
    debtors: debtorList.slice(0, debtorsLimit),
    recentCollections: recentCollections
      .filter((c) => inScope(branchKey, c.b))
      .map((c) => ({
        id: String(c.id),
        at: toWallText(c.created_at),
        customer: c.name || 'Cliente',
        amount: round2(c.amount),
        method: labels.paymentLabel(c.pm, catalog.paymentLabels),
        methodCode: String(c.pm || ''),
        user: c.user_name || null,
      })),
    dueDatesAvailable: false,
  };
}

function buildCustomers({ clientsCount = 0, activity90 = [], activityMonth = [], branchKey = null, listLimit = 20 }) {
  const aggregate = (rows) => {
    const map = new Map();
    for (const r of rows) {
      if (!inScope(branchKey, r.b)) continue;
      const key = String(r.c);
      const acc = map.get(key) || { id: key, name: String(r.name || 'Cliente'), phone: r.phone || null, invoices: 0, sales: 0, lastDay: null };
      acc.invoices += num(r.n);
      acc.sales += num(r.total);
      const day = toDayKey(r.last_at);
      if (day && (!acc.lastDay || day > acc.lastDay)) acc.lastDay = day;
      map.set(key, acc);
    }
    return [...map.values()].map((c) => ({ ...c, sales: round2(c.sales), avgTicket: c.invoices > 0 ? round2(c.sales / c.invoices) : 0 }));
  };
  const last90 = aggregate(activity90);
  const month = aggregate(activityMonth);
  const topSpenders = [...month].sort((a, b) => b.sales - a.sales).slice(0, listLimit);
  return {
    totalClients: num(clientsCount),
    active90: last90.length,
    activeMonth: month.length,
    frequent: [...last90].sort((a, b) => b.invoices - a.invoices || b.sales - a.sales).slice(0, listLimit),
    topSpenders,
    topCustomer: topSpenders[0] || null,
  };
}

// ── Fiscal ──────────────────────────────────────────────────────────────────

function emptyEcfCounts() {
  return { issued: 0, accepted: 0, rejected: 0, pending: 0, inProcess: 0, error: 0, cancelled: 0, other: 0, amount: 0 };
}

function mapLegacySequence(row, today) {
  const available = Math.max(0, num(row.maximo) - num(row.siguiente_numero) + 1);
  const expiration = toDayKey(row.fecha_vencimiento) || null;
  let status = 'activo';
  if (expiration && today && expiration < today) status = 'vencido';
  else if (available <= 0) status = 'agotado';
  else if (available <= LOW_SEQUENCE_THRESHOLD) status = 'proximo_agotarse';
  return {
    type: String(row.ncf_type || ''),
    label: labels.ncfTypeLabel(row.ncf_type),
    branchId: row.branch_id ? String(row.branch_id) : null,
    available,
    percentUsed: null,
    expirationDate: expiration,
    status,
  };
}

function buildFiscal({
  ecfCounts = [],
  ecfOpen = [],
  ecfDocuments = [],
  ncfUsage = [],
  sequences = [],
  legacySequences = [],
  mapSequence = null,
  eInvoiceEnabled = false,
  branchKey = null,
  today,
  monthFrom,
  docsLimit = 60,
}) {
  const todayCounts = emptyEcfCounts();
  const monthCounts = emptyEcfCounts();
  const byType = new Map();
  const byStatus = new Map();
  for (const r of ecfCounts) {
    if (!inScope(branchKey, r.b)) continue;
    const day = toDayKey(r.d);
    const group = labels.ecfGroup(r.st);
    const n = num(r.n);
    const amount = num(r.total);
    if (day && monthFrom && day >= monthFrom) {
      monthCounts.issued += n;
      monthCounts[group] = num(monthCounts[group]) + n;
      monthCounts.amount += amount;
      const type = String(r.tp || '');
      const t = byType.get(type) || { code: type, label: labels.ncfTypeLabel(type), issued: 0, accepted: 0, rejected: 0, amount: 0 };
      t.issued += n;
      if (group === 'accepted') t.accepted += n;
      if (group === 'rejected') t.rejected += n;
      t.amount += amount;
      byType.set(type, t);
      const st = String(r.st || 'pendiente');
      const s = byStatus.get(st) || { code: st, label: labels.ecfStatusLabel(st), group, count: 0 };
      s.count += n;
      byStatus.set(st, s);
    }
    if (day && day === today) {
      todayCounts.issued += n;
      todayCounts[group] = num(todayCounts[group]) + n;
      todayCounts.amount += amount;
    }
  }

  const open = { pending: 0, inProcess: 0, error: 0, oldestAt: null };
  for (const r of ecfOpen) {
    if (!inScope(branchKey, r.b)) continue;
    const group = labels.ecfGroup(r.st);
    if (group === 'pending' || group === 'inProcess' || group === 'error') open[group] += num(r.n);
    const oldest = toWallText(r.oldest);
    if (oldest && (!open.oldestAt || oldest < open.oldestAt)) open.oldestAt = oldest;
  }

  const documents = ecfDocuments
    .filter((d) => inScope(branchKey, d.b))
    .slice(0, docsLimit)
    .map((d) => ({
      id: String(d.id),
      encf: d.encf || null,
      type: String(d.tipo_ecf || ''),
      typeLabel: labels.ncfTypeLabel(d.tipo_ecf),
      status: String(d.estado_dgii || 'pendiente'),
      statusLabel: labels.ecfStatusLabel(d.estado_dgii),
      group: labels.ecfGroup(d.estado_dgii),
      createdAt: toWallText(d.created_at),
      sentAt: toWallText(d.sent_at),
      customer: d.nombre_comprador || null,
      total: round2(d.monto_total),
      invoice: d.invoice_number || null,
      error: d.error_message ? String(d.error_message).slice(0, 200) : null,
      branchId: d.b ? String(d.b) : null,
    }));

  const ncfByType = new Map();
  let ncfCancelled = 0;
  for (const r of ncfUsage) {
    if (!inScope(branchKey, r.b)) continue;
    const code = String(r.nt || '').toUpperCase() || 'Otro';
    const acc = ncfByType.get(code) || { code, label: labels.ncfTypeLabel(code), count: 0, amount: 0, tax: 0, cancelled: 0 };
    if (String(r.fs) === 'cancelada') {
      acc.cancelled += num(r.n);
      ncfCancelled += num(r.n);
    } else {
      acc.count += num(r.n);
      acc.amount += num(r.total);
      acc.tax += num(r.tax);
    }
    ncfByType.set(code, acc);
  }

  let sequenceList = [];
  if (sequences.length && typeof mapSequence === 'function') {
    sequenceList = sequences
      .filter((s) => branchKey === null || !s.branch_id || String(s.branch_id) === branchKey)
      .map((row) => {
        const m = mapSequence(row);
        return {
          type: m.documentType,
          label: labels.ncfTypeLabel(m.documentType),
          branchId: m.branchId ? String(m.branchId) : null,
          branchName: m.branchName || null,
          available: num(m.totalAvailable),
          percentUsed: num(m.percentUsed),
          expirationDate: m.expirationDate ? toDayKey(m.expirationDate) : null,
          status: m.effectiveStatus || m.status,
        };
      })
      .filter((s) => s.status !== 'anulado' && s.status !== 'inactivo');
  } else {
    sequenceList = legacySequences
      .filter((s) => branchKey === null || !s.branch_id || String(s.branch_id) === branchKey)
      .map((row) => mapLegacySequence(row, today));
  }

  const round = (c) => ({ ...c, amount: round2(c.amount) });
  return {
    eInvoiceEnabled: Boolean(Number(eInvoiceEnabled)),
    hasEcfData: monthCounts.issued > 0 || open.pending + open.inProcess + open.error > 0 || documents.length > 0,
    today: round(todayCounts),
    month: round(monthCounts),
    open,
    byType: [...byType.values()].map(round).sort((a, b) => b.issued - a.issued),
    byStatus: [...byStatus.values()].sort((a, b) => b.count - a.count),
    documents,
    ncf: {
      byType: [...ncfByType.values()].map((t) => ({ ...t, amount: round2(t.amount), tax: round2(t.tax) })).sort((a, b) => b.count - a.count),
      cancelledCount: ncfCancelled,
    },
    sequences: sequenceList,
  };
}

// ── Delivery ────────────────────────────────────────────────────────────────

function buildDelivery({
  byStatus = [],
  clients = [],
  drivers = [],
  active = [],
  pendingCash = [],
  catalog,
  branchKey = null,
  today,
  monthFrom,
}) {
  const empty = () => ({ orders: 0, sales: 0, delivered: 0, pending: 0, onTheWay: 0, incidents: 0, cancelled: 0 });
  const todayStats = empty();
  const monthStats = empty();
  const statusMap = new Map();
  const apply = (acc, st, cancelled, n, total) => {
    if (cancelled) {
      acc.cancelled += n;
      return;
    }
    acc.orders += n;
    acc.sales += total;
    if (st === 'entregado') acc.delivered += n;
    else if (st === 'en_camino') acc.onTheWay += n;
    else if (st === 'incidencia') acc.incidents += n;
    else acc.pending += n;
  };
  for (const r of byStatus) {
    if (!inScope(branchKey, r.b)) continue;
    const day = toDayKey(r.d);
    const st = String(r.st || 'pendiente');
    const cancelled = Number(r.cancelled) === 1;
    const n = num(r.n);
    const total = num(r.total);
    if (day && monthFrom && day >= monthFrom) {
      apply(monthStats, st, cancelled, n, total);
      const code = cancelled ? 'cancelado' : st;
      const s = statusMap.get(code) || { code, label: labels.deliveryStatusLabel(code), count: 0, amount: 0 };
      s.count += n;
      s.amount += total;
      statusMap.set(code, s);
    }
    if (day === today) apply(todayStats, st, cancelled, n, total);
  }
  const customerIds = new Set(clients.filter((r) => inScope(branchKey, r.b)).map((r) => String(r.c)));
  const driverMap = new Map();
  for (const r of drivers) {
    if (!inScope(branchKey, r.b)) continue;
    const key = r.u ? String(r.u) : 'sin';
    const d = driverMap.get(key) || { id: r.u ? String(r.u) : null, name: r.name || catalog.users.get(key)?.name || 'Sin repartidor', orders: 0, sales: 0 };
    d.orders += num(r.n);
    d.sales += num(r.total);
    driverMap.set(key, d);
  }
  const cash = pendingCash.filter((r) => inScope(branchKey, r.b))
    .reduce((acc, r) => ({ count: acc.count + num(r.n), amount: acc.amount + num(r.total) }), { count: 0, amount: 0 });

  const fix = (s) => ({ ...s, sales: round2(s.sales) });
  return {
    used: monthStats.orders + monthStats.cancelled > 0 || active.length > 0,
    today: fix(todayStats),
    month: { ...fix(monthStats), customers: customerIds.size },
    byStatus: [...statusMap.values()].map((s) => ({ ...s, amount: round2(s.amount) })).sort((a, b) => b.count - a.count),
    drivers: [...driverMap.values()].map((d) => ({ ...d, sales: round2(d.sales) })).sort((a, b) => b.orders - a.orders),
    active: active.filter((r) => inScope(branchKey, r.b)).map((r) => ({
      invoice: r.invoice_number,
      createdAt: toWallText(r.created_at),
      customer: r.client_name || 'Cliente',
      driver: r.driver || null,
      total: round2(r.total),
      status: String(r.st || 'pendiente'),
      statusLabel: labels.deliveryStatusLabel(r.st),
      payment: labels.paymentLabel(r.pm, catalog.paymentLabels),
      cashPending: String(r.cash_st) === 'pendiente',
    })),
    pendingCash: { count: cash.count, amount: round2(cash.amount) },
  };
}

module.exports = {
  NO_BRANCH,
  buildCatalog,
  catalogForDoc,
  buildInventory,
  buildProductCatalog,
  CATALOG_PAGE_SIZE,
  buildCash,
  buildReceivables,
  buildCustomers,
  buildFiscal,
  buildDelivery,
};

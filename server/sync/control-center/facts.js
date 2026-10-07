'use strict';

/**
 * server/sync/control-center/facts.js
 *
 * "Hechos" diarios de ventas por sucursal, armados a partir de las filas de
 * queries.js. Todo valor es sumable: así se arma cualquier período (hoy,
 * semana, mes, o un rango del usuario en la app) sumando días, sin volver a
 * la base de datos. Funciones puras (sin BD ni Firestore) para poder probarlas.
 */

const { toDayKey, listDays } = require('./periods');
const labels = require('./labels');

const NO_BRANCH = '0';

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(num(value) * 100) / 100;
}

function idKey(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? String(n) : NO_BRANCH;
}

function emptyFacts() {
  return {
    invoices: 0,
    sales: 0,
    tax: 0,
    discount: 0,
    pay: {},
    reg: {},
    usr: {},
    ot: {},
    dt: {},
    nt: {},
    hours: {},
    items: {},
    cancelled: { n: 0, total: 0, usr: {} },
    returns: { n: 0, total: 0, usr: {} },
    collections: { n: 0, total: 0, pay: {}, usr: {}, reg: {} },
    expenses: { n: 0, total: 0, cat: {} },
    outflows: { kind: {}, type: {} },
    newCustomers: 0,
  };
}

/** Suma `source` dentro de `target` (números se suman; textos: el primero no vacío). */
function addInto(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (typeof value === 'number') {
      target[key] = num(target[key]) + value;
    } else if (typeof value === 'string') {
      if (!target[key]) target[key] = value;
    } else if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      addInto(target[key], value);
    }
  }
  return target;
}

function bump(map, key, n, total) {
  const k = String(key);
  if (!map[k]) map[k] = { n: 0, total: 0 };
  map[k].n += n;
  map[k].total += total;
  return map[k];
}

function ensureDay(facts, day, branchKey) {
  if (!facts.has(day)) facts.set(day, new Map());
  const branches = facts.get(day);
  if (!branches.has(branchKey)) branches.set(branchKey, emptyFacts());
  return branches.get(branchKey);
}

/**
 * Arma Map(día → Map(sucursal → hechos)) con las filas crudas.
 * `rows` = { totals, dims, hours, items, cancelled, returns, collections,
 *            expenses, outflows, customerFirsts }
 */
function buildFacts(rows, { fromDay, toDay } = {}) {
  const facts = new Map();
  for (const day of listDays(fromDay, toDay)) facts.set(day, new Map());

  const inWindow = (day) => day && (!fromDay || day >= fromDay) && (!toDay || day <= toDay);

  for (const r of rows.totals || []) {
    const day = toDayKey(r.d);
    if (!inWindow(day)) continue;
    const f = ensureDay(facts, day, idKey(r.b));
    f.invoices += num(r.n);
    f.sales += num(r.total);
    f.tax += num(r.tax);
    f.discount += num(r.discount);
  }

  for (const r of rows.dims || []) {
    const day = toDayKey(r.d);
    if (!inWindow(day)) continue;
    const f = ensureDay(facts, day, idKey(r.b));
    const n = num(r.n);
    const total = num(r.total);
    const pm = String(r.pm || 'efectivo');
    const reg = idKey(r.r);
    const usr = idKey(r.u);
    bump(f.pay, pm, n, total);
    const regEntry = bump(f.reg, reg, n, total);
    regEntry.pay = regEntry.pay || {};
    regEntry.pay[pm] = num(regEntry.pay[pm]) + total;
    const usrEntry = bump(f.usr, usr, n, total);
    usrEntry.pay = usrEntry.pay || {};
    usrEntry.pay[pm] = num(usrEntry.pay[pm]) + total;
    usrEntry.regs = usrEntry.regs || {};
    usrEntry.regs[reg] = num(usrEntry.regs[reg]) + n;
    bump(f.ot, String(r.ot || 'mostrador'), n, total);
    bump(f.dt, String(r.dt || 'ticket'), n, total);
    const ncf = String(r.nt || '').trim().toUpperCase();
    if (ncf) bump(f.nt, ncf, n, total);
  }

  for (const r of rows.hours || []) {
    const day = toDayKey(r.d);
    if (!inWindow(day)) continue;
    const hour = String(r.h || '').slice(0, 5);
    if (!hour) continue;
    bump(ensureDay(facts, day, idKey(r.b)).hours, hour, num(r.n), num(r.total));
  }

  for (const r of rows.items || []) {
    const day = toDayKey(r.d);
    if (!inWindow(day)) continue;
    const f = ensureDay(facts, day, idKey(r.b));
    const pid = r.pid === null || r.pid === undefined ? 'rapida' : String(r.pid);
    if (!f.items[pid]) {
      f.items[pid] = {
        name: pid === 'rapida' ? 'Ventas rápidas (sin producto)' : String(r.name || 'Producto'),
        cat: String(r.cat || ''),
        qty: 0, rev: 0, covRev: 0, covCost: 0,
      };
    }
    const item = f.items[pid];
    item.qty += num(r.qty);
    item.rev += num(r.rev);
    item.covRev += num(r.cov_rev);
    item.covCost += num(r.cov_cost);
  }

  for (const r of rows.cancelled || []) {
    const day = toDayKey(r.d);
    if (!inWindow(day)) continue;
    const c = ensureDay(facts, day, idKey(r.b)).cancelled;
    c.n += num(r.n);
    c.total += num(r.total);
    bump(c.usr, idKey(r.u), num(r.n), num(r.total));
  }

  for (const r of rows.returns || []) {
    const day = toDayKey(r.d);
    if (!inWindow(day)) continue;
    const ret = ensureDay(facts, day, idKey(r.b)).returns;
    ret.n += num(r.n);
    ret.total += num(r.total);
    bump(ret.usr, idKey(r.u), num(r.n), num(r.total));
  }

  for (const r of rows.collections || []) {
    const day = toDayKey(r.d);
    if (!inWindow(day)) continue;
    const col = ensureDay(facts, day, idKey(r.b)).collections;
    const total = num(r.total);
    col.n += num(r.n);
    col.total += total;
    const pm = String(r.pm || 'efectivo');
    col.pay[pm] = num(col.pay[pm]) + total;
    const usr = idKey(r.u);
    col.usr[usr] = num(col.usr[usr]) + total;
    const reg = idKey(r.r);
    col.reg[reg] = num(col.reg[reg]) + total;
  }

  for (const r of rows.expenses || []) {
    const day = toDayKey(r.d);
    if (!inWindow(day)) continue;
    const exp = ensureDay(facts, day, idKey(r.b)).expenses;
    const total = num(r.total);
    exp.n += num(r.n);
    exp.total += total;
    const cat = String(r.cat || 'Otros');
    exp.cat[cat] = num(exp.cat[cat]) + total;
  }

  for (const r of rows.outflows || []) {
    const day = toDayKey(r.d);
    if (!inWindow(day)) continue;
    const f = ensureDay(facts, day, idKey(r.b));
    const total = num(r.total);
    const type = String(r.t || 'Salida');
    const kind = labels.outflowKind(type);
    f.outflows.type[type] = num(f.outflows.type[type]) + total;
    f.outflows.kind[kind] = num(f.outflows.kind[kind]) + total;
    // Un egreso de caja tipo "Gasto" también es gasto del negocio.
    if (kind === 'expense') {
      f.expenses.n += num(r.n);
      f.expenses.total += total;
      f.expenses.cat['Gastos de caja'] = num(f.expenses.cat['Gastos de caja']) + total;
    }
  }

  // Clientes nuevos: el día de su primera compra en el negocio (global) o en
  // la sucursal (por sucursal). La suma por sucursal puede ser mayor que el
  // total del negocio: un cliente puede estrenarse en dos sucursales.
  if (Array.isArray(rows.customerFirsts)) {
    const globalFirst = new Map();
    for (const r of rows.customerFirsts) {
      const day = toDayKey(r.first_at);
      if (!day) continue;
      const client = String(r.c);
      if (!globalFirst.has(client) || day < globalFirst.get(client).day) {
        globalFirst.set(client, { day, branch: idKey(r.b) });
      }
      if (inWindow(day)) {
        ensureDay(facts, day, idKey(r.b)).newCustomersBranch =
          num(ensureDay(facts, day, idKey(r.b)).newCustomersBranch) + 1;
      }
    }
    for (const { day, branch } of globalFirst.values()) {
      if (!inWindow(day)) continue;
      ensureDay(facts, day, branch).newCustomers += 1;
    }
  }

  return facts;
}

/** Suma los hechos de varios días; `branchKey` null = todas las sucursales. */
function mergeFacts(facts, days, branchKey = null) {
  const out = emptyFacts();
  for (const day of days) {
    const branches = facts.get(day);
    if (!branches) continue;
    for (const [key, value] of branches.entries()) {
      if (branchKey !== null && key !== branchKey) continue;
      addInto(out, value);
    }
  }
  // "Clientes nuevos" por sucursal usa la primera compra EN la sucursal.
  if (branchKey !== null) {
    out.newCustomers = num(out.newCustomersBranch);
  }
  delete out.newCustomersBranch;
  return out;
}

/** Hechos de un rango por sucursal (para "comparar sucursales"). */
function factsByBranch(facts, days) {
  const keys = new Set();
  for (const day of days) {
    for (const key of (facts.get(day) || new Map()).keys()) keys.add(key);
  }
  const out = new Map();
  for (const key of keys) out.set(key, mergeFacts(facts, days, key));
  return out;
}

// ── De hechos a bloques legibles ────────────────────────────────────────────

function sortDesc(list, field = 'sales') {
  return list.sort((a, b) => num(b[field]) - num(a[field]));
}

function profitFrom(f) {
  const itemsRevenue = Object.values(f.items).reduce((s, i) => s + num(i.rev), 0);
  const coveredRevenue = Object.values(f.items).reduce((s, i) => s + num(i.covRev), 0);
  const coveredCost = Object.values(f.items).reduce((s, i) => s + num(i.covCost), 0);
  const itemsQty = Object.values(f.items).reduce((s, i) => s + num(i.qty), 0);
  return { itemsRevenue, coveredRevenue, coveredCost, itemsQty };
}

/**
 * Ganancia estimada SOLO sobre lo vendido que tiene costo registrado. El
 * descuento de la factura se reparte en proporción. `costCoverage` le dice a
 * la app qué parte de la venta respalda el cálculo (no se inventa ganancia).
 */
function computeProfit({ itemsRevenue, coveredRevenue, coveredCost, discount }) {
  if (!(itemsRevenue > 0) || !(coveredRevenue > 0)) {
    return { costCoverage: 0, profit: null, margin: null, cost: null };
  }
  const coverage = Math.min(1, coveredRevenue / itemsRevenue);
  const discountShare = num(discount) * coverage;
  const netCovered = coveredRevenue - discountShare;
  const profit = netCovered - coveredCost;
  return {
    costCoverage: round2(coverage * 100) / 100,
    profit: round2(profit),
    margin: netCovered > 0 ? round2((profit / netCovered) * 100) : null,
    cost: round2(coveredCost),
  };
}

function totalsBlock(f) {
  const { itemsRevenue, coveredRevenue, coveredCost, itemsQty } = profitFrom(f);
  const profit = computeProfit({ itemsRevenue, coveredRevenue, coveredCost, discount: f.discount });
  return {
    sales: round2(f.sales),
    invoices: num(f.invoices),
    avgTicket: f.invoices > 0 ? round2(f.sales / f.invoices) : 0,
    tax: round2(f.tax),
    discount: round2(f.discount),
    netSales: round2(f.sales - f.tax),
    itemsQty: round2(itemsQty),
    itemsRevenue: round2(itemsRevenue),
    coveredRevenue: round2(coveredRevenue),
    coveredCost: round2(coveredCost),
    ...profit,
    cancelled: { count: num(f.cancelled.n), amount: round2(f.cancelled.total) },
    returns: { count: num(f.returns.n), amount: round2(f.returns.total) },
    collections: { count: num(f.collections.n), amount: round2(f.collections.total) },
    expenses: round2(f.expenses.total),
    newCustomers: num(f.newCustomers),
  };
}

/**
 * Bloque completo de ventas de un período. `catalog` trae nombres:
 * { paymentLabels, registers: Map, users: Map, branches: Map }.
 */
function salesBlock(f, catalog, { topN = 15, series = null } = {}) {
  const total = num(f.sales);
  const share = (v) => (total > 0 ? round2((num(v) / total) * 100) : 0);
  const regName = (id) => catalog.registers.get(id)?.name || (id === NO_BRANCH ? 'Sin caja' : `Caja ${id}`);
  const userName = (id) => catalog.users.get(id)?.name || (id === NO_BRANCH ? 'Sin usuario' : `Usuario ${id}`);
  const payList = (map) => sortDesc(Object.entries(map || {}).map(([code, v]) => ({
    code,
    label: labels.paymentLabel(code, catalog.paymentLabels),
    sales: round2(typeof v === 'number' ? v : v.total),
    ...(typeof v === 'number' ? {} : { invoices: num(v.n) }),
  })));

  const byPayment = payList(f.pay).map((p) => ({ ...p, share: share(p.sales) }));

  const byRegister = sortDesc(Object.entries(f.reg).map(([id, v]) => ({
    id,
    name: regName(id),
    branchId: catalog.registers.get(id)?.branchId || null,
    sales: round2(v.total),
    invoices: num(v.n),
    avgTicket: v.n > 0 ? round2(v.total / v.n) : 0,
    collections: round2(f.collections.reg[id] || 0),
    byPayment: payList(v.pay),
  })));

  const userIds = new Set([
    ...Object.keys(f.usr),
    ...Object.keys(f.cancelled.usr),
    ...Object.keys(f.returns.usr),
    ...Object.keys(f.collections.usr),
  ]);
  const byUser = sortDesc([...userIds].map((id) => {
    const v = f.usr[id] || { n: 0, total: 0, pay: {}, regs: {} };
    const cancelled = f.cancelled.usr[id] || { n: 0, total: 0 };
    const returns = f.returns.usr[id] || { n: 0, total: 0 };
    return {
      id,
      name: userName(id),
      sales: round2(v.total),
      invoices: num(v.n),
      avgTicket: v.n > 0 ? round2(v.total / v.n) : 0,
      cancelled: { count: num(cancelled.n), amount: round2(cancelled.total) },
      returns: { count: num(returns.n), amount: round2(returns.total) },
      collections: round2(f.collections.usr[id] || 0),
      byPayment: payList(v.pay),
      registers: Object.keys(v.regs || {}).map((rid) => ({ id: rid, name: regName(rid), invoices: num(v.regs[rid]) })),
    };
  }));

  const simpleList = (map, labelFn) => sortDesc(Object.entries(map || {}).map(([code, v]) => ({
    code,
    label: labelFn(code),
    sales: round2(v.total),
    invoices: num(v.n),
    share: share(v.total),
  })));

  const products = Object.entries(f.items).map(([id, v]) => {
    const profit = computeProfit({ itemsRevenue: v.rev, coveredRevenue: v.covRev, coveredCost: v.covCost, discount: 0 });
    return {
      id,
      name: v.name,
      category: v.cat,
      qty: round2(v.qty),
      sales: round2(v.rev),
      profit: profit.profit,
      margin: profit.margin,
    };
  });

  const categories = {};
  for (const p of products) {
    const key = p.category || 'Sin categoría';
    if (!categories[key]) categories[key] = { name: key, sales: 0, qty: 0, products: 0 };
    categories[key].sales += p.sales;
    categories[key].qty += p.qty;
    categories[key].products += 1;
  }

  const byHour = Object.entries(f.hours)
    .map(([key, v]) => ({ key, sales: round2(v.total), invoices: num(v.n) }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const collectionsByMethod = payList(f.collections.pay);
  const expensesByCategory = sortDesc(Object.entries(f.expenses.cat)
    .map(([name, amount]) => ({ name, amount: round2(amount) })), 'amount');
  const outflowsByType = sortDesc(Object.entries(f.outflows.type)
    .map(([type, amount]) => ({ type, kind: labels.outflowKind(type), amount: round2(amount) })), 'amount');

  return {
    totals: totalsBlock(f),
    byPayment,
    byRegister,
    byUser,
    byOrderType: simpleList(f.ot, labels.orderTypeLabel),
    byDocType: simpleList(f.dt, labels.docTypeLabel),
    byNcfType: simpleList(f.nt, labels.ncfTypeLabel),
    byCategory: sortDesc(Object.values(categories).map((c) => ({ ...c, sales: round2(c.sales), qty: round2(c.qty) }))),
    topProducts: sortDesc([...products]).slice(0, topN),
    topProductsByQty: [...products].sort((a, b) => b.qty - a.qty).slice(0, Math.min(10, topN)),
    byHour,
    series: series || [],
    collectionsByMethod,
    expensesByCategory,
    outflowsByType,
  };
}

/** Serie diaria (para gráficos) de un rango. */
function dailySeries(facts, days, branchKey = null) {
  return days.map((day) => {
    const f = mergeFacts(facts, [day], branchKey);
    return { key: day, sales: round2(f.sales), invoices: num(f.invoices) };
  });
}

/** Totales por sucursal de un rango exacto (rangeTotals de queries.js). */
function rangeTotalsByBranch({ totals = [], items = [] } = {}) {
  const out = new Map();
  const ensure = (key) => {
    if (!out.has(key)) out.set(key, { invoices: 0, sales: 0, tax: 0, discount: 0, itemsRevenue: 0, coveredRevenue: 0, coveredCost: 0 });
    return out.get(key);
  };
  for (const r of totals) {
    const e = ensure(idKey(r.b));
    e.invoices += num(r.n);
    e.sales += num(r.total);
    e.tax += num(r.tax);
    e.discount += num(r.discount);
  }
  for (const r of items) {
    const e = ensure(idKey(r.b));
    e.itemsRevenue += num(r.rev);
    e.coveredRevenue += num(r.cov_rev);
    e.coveredCost += num(r.cov_cost);
  }
  return out;
}

function compareBlock(byBranch, branchKey = null) {
  const acc = { invoices: 0, sales: 0, tax: 0, discount: 0, itemsRevenue: 0, coveredRevenue: 0, coveredCost: 0 };
  for (const [key, value] of byBranch.entries()) {
    if (branchKey !== null && key !== branchKey) continue;
    addInto(acc, value);
  }
  const profit = computeProfit(acc);
  return {
    sales: round2(acc.sales),
    invoices: num(acc.invoices),
    avgTicket: acc.invoices > 0 ? round2(acc.sales / acc.invoices) : 0,
    tax: round2(acc.tax),
    profit: profit.profit,
    costCoverage: profit.costCoverage,
  };
}

module.exports = {
  NO_BRANCH,
  num,
  round2,
  idKey,
  emptyFacts,
  addInto,
  buildFacts,
  mergeFacts,
  factsByBranch,
  computeProfit,
  totalsBlock,
  salesBlock,
  dailySeries,
  rangeTotalsByBranch,
  compareBlock,
};

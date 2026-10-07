'use strict';

/**
 * Centro de Control (app de reportes): consultas reales sobre SQLite en
 * memoria (sql.js) con un negocio de 2 sucursales y 3 cajas, más el
 * publicador contra un Firestore falso.
 *
 * "Ahora" fijo: lunes 5-oct-2026 14:30 hora RD (18:30 UTC).
 */

const periods = require('../../server/sync/control-center/periods');
const facts = require('../../server/sync/control-center/facts');
const snapshotLib = require('../../server/sync/control-center/snapshot');
const state = require('../../server/sync/control-center/state');
const queries = require('../../server/sync/control-center/queries');
const { createControlCenterPublisher, stableHash } = require('../../server/sync/control-center/publisher');
const { mapSequence } = require('../../server/routes/fiscal-sequences.routes');

const { NOW, createDb, fakeFirestore } = require('./control-center.fixture');

describe('periods (hora RD)', () => {
  test('rangos de hoy, semana, mes y comparaciones al mismo tramo', () => {
    const p = periods.buildPeriods(NOW);
    expect(p.today).toBe('2026-10-05');
    expect(p.time).toBe('14:30:00');
    expect(p.periods.week.fromDay).toBe('2026-10-05'); // lunes
    expect(p.periods.month.fromDay).toBe('2026-10-01');
    expect(p.compare.today).toMatchObject({ from: '2026-10-04 00:00:00', to: '2026-10-04 14:30:00' });
    expect(p.compare.week).toMatchObject({ from: '2026-09-28 00:00:00', to: '2026-09-28 14:30:00' });
    expect(p.compare.month).toMatchObject({ from: '2026-09-01 00:00:00', to: '2026-09-05 14:30:00' });
    expect(p.facts.fromDay).toBe('2026-09-01'); // al menos 35 días
  });

  test('mismo día del mes anterior se recorta al último día', () => {
    expect(periods.sameDayPreviousMonth('2026-03-31')).toBe('2026-02-28');
    expect(periods.sameDayPreviousMonth('2026-01-15')).toBe('2025-12-15');
    expect(periods.lastMonths('2026-02-10', 3)).toEqual(['2025-12', '2026-01', '2026-02']);
  });

  test('normaliza fechas de mysql2 (Date) y SQLite (texto)', () => {
    expect(periods.toDayKey(new Date(2026, 9, 5))).toBe('2026-10-05');
    expect(periods.toDayKey('2026-10-05 09:15:00')).toBe('2026-10-05');
    expect(periods.toWallText('2026-10-05T09:15:00')).toBe('2026-10-05 09:15:00');
  });
});

describe('ganancia estimada (sin inventar)', () => {
  test('sin costos registrados no hay ganancia', () => {
    expect(facts.computeProfit({ itemsRevenue: 100, coveredRevenue: 0, coveredCost: 0, discount: 0 }))
      .toEqual({ costCoverage: 0, profit: null, margin: null, cost: null });
  });

  test('reparte el descuento en proporción a lo que tiene costo', () => {
    const r = facts.computeProfit({ itemsRevenue: 200, coveredRevenue: 100, coveredCost: 60, discount: 20 });
    expect(r.costCoverage).toBe(0.5);
    expect(r.profit).toBe(30); // 100 - 10 de descuento - 60
  });
});

describe('snapshot del Centro de Control (SQLite real)', () => {
  let ctx;
  let snapshot;
  let all;
  let norte;

  beforeAll(async () => {
    ctx = await createDb();
    snapshot = await snapshotLib.collectSnapshot({
      query: ctx.query,
      now: NOW,
      full: true,
      mapSequence,
      syncInfo: { cloud: { pending: 0, errors: 2, lastError: 'timeout' }, pendingEcf: 1 },
    });
    all = snapshotLib.buildScopeDocuments(snapshot, null);
    norte = snapshotLib.buildScopeDocuments(snapshot, '2');
  });

  afterAll(() => ctx.db.close());

  test('las consultas corren sin errores, salvo la tabla que no existe', () => {
    expect(snapshot.warnings.every((w) => w.startsWith('secuencias NCF (antiguas)'))).toBe(true);
    expect(snapshot.multiBranch).toBe(true);
    expect(snapshot.branchKeys).toEqual(['1', '2']);
  });

  test('ventas de hoy con las reglas del POS', () => {
    const t = all.sales.periods.today.totals;
    expect(t.invoices).toBe(5); // la anulada no cuenta
    expect(t.sales).toBe(888);
    expect(t.cancelled).toEqual({ count: 1, amount: 100 });
    expect(t.returns).toEqual({ count: 1, amount: 50 });
    expect(t.collections).toEqual({ count: 1, amount: 200 });
    expect(t.expenses).toBe(1150); // gasto registrado + egreso tipo Gasto (el anulado no)
    expect(t.newCustomers).toBe(1); // Pedro compró por primera vez hoy
    expect(t.avgTicket).toBeCloseTo(177.6, 2);
  });

  test('métodos de pago dinámicos, con el nombre configurado en el POS', () => {
    const methods = Object.fromEntries(all.sales.periods.today.byPayment.map((m) => [m.code, m]));
    expect(methods.subsidio.label).toBe('Tarjeta de Subsidio');
    expect(methods.subsidio.sales).toBe(150);
    expect(methods.efectivo).toMatchObject({ sales: 198, invoices: 2 });
    expect(methods.credito.label).toBe('Crédito');
    const shares = all.sales.periods.today.byPayment.reduce((s, m) => s + m.share, 0);
    expect(shares).toBeCloseTo(100, 0);
  });

  test('ganancia solo sobre lo que tiene costo', () => {
    const t = all.sales.periods.today.totals;
    expect(t.itemsRevenue).toBe(870);
    expect(t.coveredRevenue).toBe(750);
    expect(t.profit).toBe(260);
    expect(t.costCoverage).toBeCloseTo(0.8621, 3);
  });

  test('por caja y por usuario, sin cajas fijas', () => {
    const regs = Object.fromEntries(all.sales.periods.today.byRegister.map((r) => [r.id, r]));
    expect(Object.keys(regs).sort()).toEqual(['1', '2', '3']);
    expect(regs['1']).toMatchObject({ name: 'Caja 1', sales: 698, invoices: 3, collections: 200 });
    const users = Object.fromEntries(all.sales.periods.today.byUser.map((u) => [u.id, u]));
    expect(users['2']).toMatchObject({ name: 'Luis', invoices: 4, returns: { count: 1, amount: 50 } });
    expect(users['1'].cancelled).toEqual({ count: 1, amount: 100 });
    expect(users['2'].registers.map((r) => r.id).sort()).toEqual(['1', '2']);
  });

  test('comparación contra ayer a la misma hora', () => {
    expect(all.sales.compare.today).toMatchObject({ sales: 200, invoices: 1 });
    expect(all.summary.compare.yesterday.sales).toBe(0); // anteayer sin ventas
  });

  test('la sucursal Norte solo ve lo suyo', () => {
    expect(norte.summary.scope).toBe('branch');
    expect(norte.summary.branchIds).toEqual(['2']);
    expect(norte.sales.periods.today.totals).toMatchObject({ sales: 40, invoices: 1 });
    expect(norte.cash.registers.map((r) => r.id)).toEqual(['3']);
    expect(norte.inventory.outOfStockCount).toBe(0);
    expect(norte.inventory.lowStockCount).toBe(1); // Arroz 8 de mínimo 10
  });

  test('inventario por sucursal sin mezclar existencias', () => {
    const inv = all.inventory;
    expect(inv.perBranchInventory).toBe(true);
    expect(inv.outOfStockCount).toBe(1); // Arroz en Principal
    expect(inv.outOfStock[0]).toMatchObject({ name: 'Arroz', branchName: 'Principal' });
    expect(inv.lowStockCount).toBe(2);
    expect(inv.noMovement.map((p) => p.name)).toEqual(['Velas']); // la venta anulada no cuenta
    expect(inv.products).toBe(4); // la recarga no maneja inventario
    expect(inv.byBranch.map((b) => b.branchId).sort()).toEqual(['1', '2']);
  });

  test('cajas abiertas, cierre con diferencia y caja de ayer sin cerrar', () => {
    const cash = all.cash;
    expect(cash.openCount).toBe(2);
    expect(cash.staleOpenCount).toBe(1);
    const caja1 = cash.registers.find((r) => r.id === '1');
    expect(caja1.session).toMatchObject({ openedBy: 'Luis', expectedCash: 1500, invoices: 3, collections: 200 });
    expect(caja1.session.movements.map((m) => m.kind).sort()).toEqual(['expense', 'withdrawal']);
    expect(cash.closings[0]).toMatchObject({ registerName: 'Caja 2', difference: -50 });
  });

  test('cuentas por cobrar con antigüedad (el POS no guarda vencimientos)', () => {
    const r = all.customers.receivables;
    expect(r.total).toBe(600);
    expect(r.debtorsCount).toBe(1);
    expect(r.debtors[0]).toMatchObject({ name: 'Juan Pérez', balance: 600, invoices: 2, oldestDays: 46 });
    expect(r.aging.find((a) => a.key === '31-60').amount).toBe(300);
    expect(r.overdueDebtorsCount).toBe(1);
    expect(r.dueDatesAvailable).toBe(false);
  });

  test('e-CF: sin documentos de certificación', () => {
    const f = all.fiscal;
    expect(f.month).toMatchObject({ issued: 3, accepted: 1, rejected: 1, pending: 1 });
    expect(f.open.pending).toBe(1);
    expect(f.documents.some((d) => d.encf === 'E310000000099')).toBe(false);
    expect(f.sequences[0]).toMatchObject({ type: 'B02', status: 'proximo_agotarse', available: 21 });
  });

  test('delivery activo y cobro contra entrega pendiente', () => {
    const d = all.delivery;
    expect(d.today).toMatchObject({ orders: 1, sales: 80, onTheWay: 1 });
    expect(d.pendingCash).toEqual({ count: 1, amount: 80 });
    expect(d.active[0]).toMatchObject({ customer: 'Pedro Gómez', statusLabel: 'En camino' });
  });

  test('alertas accionables', () => {
    const ids = all.summary.alerts.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([
      'inventory-out', 'inventory-low', 'ecf-rejected', 'ecf-pending', 'ncf-B02-1',
      'cash-diff-3', 'cash-stale-open', 'receivables-overdue', 'delivery-cash', 'sync-errors',
    ]));
    expect(all.summary.alerts[0].severity).toBe('critical');
    expect(all.summary.alerts.every((a) => a.module)).toBe(true);
  });

  test('documento diario sumable para rangos libres', () => {
    const [day] = snapshotLib.buildDayDocuments(snapshot, ['2026-10-05'], null);
    expect(day.id).toBe('2026-10-05');
    expect(day.data).toMatchObject({ scope: 'all', date: '2026-10-05' });
    expect(day.data.totals.sales).toBe(888);
    expect(day.data.byBranch.map((b) => b.id).sort()).toEqual(['1', '2']);
    const [branchDay] = snapshotLib.buildDayDocuments(snapshot, ['2026-10-05'], '2');
    expect(branchDay.id).toBe('2026-10-05_b2');
  });

  test('catálogo completo de productos para la app', () => {
    expect(all.catalog).toMatchObject({ kind: 'catalog', count: 6, activeCount: 5, pages: 1, perBranchInventory: true });
    expect(all.catalog.categories).toEqual(['Aceites', 'Granos', 'Hogar', 'Limpieza', 'Servicios']);
    expect(all.catalog.day).toBeUndefined(); // no se reescribe cada día
    const items = all.catalog_p0.items;
    expect(items.map((p) => p.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(items.find((p) => p.id === '2')).toMatchObject({
      name: 'Aceite', code: 'A2', barcode: '7460001000022', brand: 'Crisol', tax: true,
      price: 150, cost: 100, stock: 13, stockByBranch: { 1: 3, 2: 10 }, imageUrl: 'https://img.example/aceite.jpg',
    });
    expect(items.find((p) => p.id === '3').imageUrl).toBeUndefined(); // la foto en base64 no viaja
    expect(items.find((p) => p.id === '5').tracksStock).toBe(false);
    expect(items.find((p) => p.id === '6').active).toBe(false);
    // Norte ve la existencia de su sucursal.
    expect(norte.catalog_p0.branchIds).toEqual(['2']);
    expect(norte.catalog_p0.items.find((p) => p.id === '1').stock).toBe(8);
    expect(norte.catalog_p0.items.find((p) => p.id === '4').stock).toBe(0); // Velas no está en Norte
    expect(norte.catalog_p0.items[0].stockByBranch).toBeUndefined();
  });

  test('el catálogo va en páginas estables por ID', () => {
    const { index, pages } = state.buildProductCatalog({
      products: snapshot.products, branchInventory: [], categories: [], catalog: snapshot.catalog, pageSize: 4,
    });
    expect(index).toMatchObject({ count: 6, pages: 2, pageSize: 4, perBranchInventory: false });
    expect(pages.map((p) => p.map((i) => i.id))).toEqual([['1', '2', '3', '4'], ['5', '6']]);
  });

  test('el resumen del tablero es liviano', () => {
    const size = JSON.stringify(all.summary).length;
    expect(size).toBeLessThan(60000);
    expect(all.summary.catalog.users.some((u) => u.name === 'Cliente Web')).toBe(false);
    expect(JSON.stringify(all.summary)).not.toMatch(/password/i);
  });
});

describe('base vieja', () => {
  test('productos sin barcode, marca, ITBIS ni imagen siguen publicando', async () => {
    const ctx = await createDb();
    for (const column of ['barcode', 'marca', 'aplica_itbis', 'image_url']) {
      ctx.db.run(`ALTER TABLE products DROP COLUMN ${column}`);
    }
    ctx.db.run('DROP TABLE categories');
    const rows = await queries.products(ctx.query);
    expect(rows).toHaveLength(6);
    const snapshot = await snapshotLib.collectSnapshot({ query: ctx.query, now: NOW, full: true, mapSequence });
    const docs = snapshotLib.buildScopeDocuments(snapshot, null);
    expect(docs.catalog).toMatchObject({ count: 6, categories: [] });
    expect(docs.catalog_p0.items[1].tax).toBeUndefined();
    expect(docs.inventory.products).toBe(4);
    ctx.db.close();
  });

  test('si la consulta de productos falla no se publica un catálogo vacío', async () => {
    const ctx = await createDb();
    ctx.db.run('DROP TABLE products');
    const snapshot = await snapshotLib.collectSnapshot({ query: ctx.query, now: NOW, full: true, mapSequence });
    const docs = snapshotLib.buildScopeDocuments(snapshot, null);
    expect(docs.catalog).toBeUndefined();
    expect(docs.catalog_p0).toBeUndefined();
    expect(docs.summary).toBeDefined();
    ctx.db.close();
  });
});

describe('publicador', () => {
  function makePublisher(ctx, firestore, overrides = {}) {
    return createControlCenterPublisher({
      query: ctx.query,
      getFirestore: () => firestore,
      getBusinessId: () => 'pos_test1234',
      now: () => NOW,
      mapSequence,
      appVersion: '9.9.9',
      getServerId: () => 'srv_main',
      logger: { warn: () => {}, log: () => {} },
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
      options: { backfillDays: 60, backfillPauseMs: 0 },
      ...overrides,
    });
  }

  test('publica resúmenes, días e histórico; luego solo lo que cambió', async () => {
    const ctx = await createDb();
    const firestore = fakeFirestore();
    const publisher = makePublisher(ctx, firestore).start();

    const first = await publisher.runOnce({ full: true });
    await publisher.whenIdle();
    expect(first.mode).toBe('full');
    const base = 'businesses/pos_test1234';
    expect(firestore.store.get(`${base}/controlCenter/summary`).business.name).toBe('Colmado La Fe');
    expect(firestore.store.has(`${base}/controlCenter/sales_b2`)).toBe(true);
    expect(firestore.store.get(`${base}/dailyStats/2026-10-05`).totals.sales).toBe(888);
    expect(firestore.store.has(`${base}/dailyStats/2026-10-05_b1`)).toBe(true);
    // Histórico: el crédito del 20-ago está fuera de la ventana de 35 días,
    // lo escribe el histórico; los días sin movimiento no se escriben.
    expect(firestore.store.has(`${base}/dailyStats/2026-08-20`)).toBe(true);
    expect(firestore.store.has(`${base}/dailyStats/2026-08-19`)).toBe(false);
    expect(firestore.store.get(`${base}/controlCenter/meta`).backfill.version).toBe(1);
    expect(firestore.store.get(`${base}/terminals/srv_main`)).toMatchObject({ role: 'principal', appVersion: '9.9.9' });
    expect(firestore.store.get(`${base}/controlCenter/catalog`)).toMatchObject({ count: 6, pages: 1 });
    expect(firestore.store.get(`${base}/controlCenter/catalog_p0`).items).toHaveLength(6);
    expect(firestore.store.has(`${base}/controlCenter/catalog_p0_b2`)).toBe(true);

    const second = await publisher.runOnce({ full: false });
    expect(second.mode).toBe('quick');
    // Nada cambió: solo la señal de vida.
    expect(second.writes).toBe(1);

    ctx.db.run(`INSERT INTO sales (id, invoice_number, user_id, branch_id, cash_register_id, billed_branch_id,
      billed_cash_register_id, billed_by_user_id, payment_method, subtotal, total, created_at)
      VALUES (50, 'FAC-00000050', 2, 1, 2, 1, 2, 2, 'transferencia', 75, 75, '2026-10-05 14:00:00')`);
    const third = await publisher.runOnce({ full: false });
    expect(third.writes).toBeGreaterThan(1);
    expect(firestore.store.get(`${base}/controlCenter/summary`).periods.today.totals.sales).toBe(963);

    // Una existencia que cambia llega al catálogo en la corrida rápida.
    ctx.db.run('UPDATE inventory_by_branch SET stock = 2 WHERE branch_id = 1 AND product_id = 2');
    await publisher.runOnce({ full: false });
    const aceite = firestore.store.get(`${base}/controlCenter/catalog_p0`).items.find((p) => p.id === '2');
    expect(aceite).toMatchObject({ stock: 12, stockByBranch: { 1: 2, 2: 10 } });
    publisher.stop();
    ctx.db.close();
  });

  test('sin Internet no intenta publicar y queda pendiente', async () => {
    const ctx = await createDb();
    const firestore = fakeFirestore();
    const handlers = [];
    const monitor = {
      isKnownOffline: () => true,
      getStatus: () => ({ online: false }),
      on: (event, fn) => handlers.push(fn),
      off: () => {},
    };
    const publisher = makePublisher(ctx, firestore, { monitor }).start();
    const result = await publisher.runOnce({ full: true });
    expect(result).toEqual({ skipped: 'offline' });
    expect(firestore.store.size).toBe(0);
    expect(publisher.getStatus().pendingWhileOffline).toBe(true);
    publisher.stop();
    ctx.db.close();
  });

  test('una caja terminal solo manda su señal de vida', async () => {
    const ctx = await createDb();
    const firestore = fakeFirestore();
    const publisher = makePublisher(ctx, firestore, {
      isMain: () => false,
      getServerId: () => 'srv_caja2',
      getTerminalScope: () => ({ branchId: 2, cashRegisterId: 3 }),
      countContingencySales: async () => 4,
    }).start();
    const result = await publisher.runOnce({ full: true });
    expect(result.mode).toBe('heartbeat');
    const keys = [...firestore.store.keys()];
    expect(keys).toEqual(['businesses/pos_test1234/terminals/srv_caja2']);
    expect(firestore.store.get(keys[0])).toMatchObject({ role: 'terminal', cashRegisterId: '3', mode: 'contingencia', contingencySales: 4 });
    publisher.stop();
    ctx.db.close();
  });

  test('sin negocio identificable no publica nada', async () => {
    const ctx = await createDb();
    const firestore = fakeFirestore();
    const publisher = makePublisher(ctx, firestore, { getBusinessId: () => null }).start();
    const result = await publisher.runOnce({ full: true });
    expect(result).toEqual({ skipped: 'business' });
    expect(firestore.store.size).toBe(0);
    publisher.stop();
    ctx.db.close();
  });

  test('la huella ignora campos que cambian en cada corrida', () => {
    expect(stableHash({ a: 1, asOf: 'x', nested: { hoursOpen: 1, b: 2 } }))
      .toBe(stableHash({ nested: { b: 2, hoursOpen: 9 }, asOf: 'y', a: 1 }));
  });
});

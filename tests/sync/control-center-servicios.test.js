'use strict';

/**
 * Empresa de servicios en el Centro de Control: la app no ve inventario ni
 * cajas, sino lo cobrado, lo que se debe y el trabajo de su tipo de servicio.
 * SQLite en memoria con el esquema real de las tablas svc_*.
 */

const snapshotLib = require('../../server/sync/control-center/snapshot');
const { perfilDelNegocio } = require('../../server/sync/control-center/servicios');
const { NOW, createDb, createServiceDb } = require('./control-center.fixture');

describe('Centro de Control — empresa de servicios', () => {
  let db;
  let snapshot;

  beforeAll(async () => {
    const created = await createServiceDb();
    db = created.db;
    snapshot = await snapshotLib.collectSnapshot({ query: created.query, now: NOW, full: true });
  });

  afterAll(() => db.close());

  test('el negocio se publica como empresa de servicios con los módulos del menú del POS', () => {
    const { summary } = snapshotLib.buildScopeDocuments(snapshot, null);
    expect(summary.business).toMatchObject({
      businessType: 'srv_tecnologia',
      appMode: 'servicios',
      vertical: 'srv_tecnologia',
      verticalLabel: 'Empresa de Tecnología',
    });
    // Mismo orden que js/business-config.js; sin campañas (no son de Tecnología).
    expect(summary.business.modules).toEqual(['cotizaciones', 'proyectos', 'ordenes', 'contratos']);
    expect(snapshot.warnings.filter((w) => w.startsWith('servicios'))).toEqual([]);
  });

  test('cobros reales de servicios por período y método (sin los anulados)', () => {
    const { services } = snapshotLib.buildScopeDocuments(snapshot, null);
    expect(services.collections.today).toEqual({ count: 1, amount: 1000 });
    expect(services.collections.yesterday).toEqual({ count: 1, amount: 1200 });
    expect(services.collections.week).toEqual({ count: 1, amount: 1000 }); // lunes 5-oct
    expect(services.collections.month).toEqual({ count: 3, amount: 2500 });
    expect(services.collections.monthByMethod).toEqual([
      { code: 'efectivo', label: 'Efectivo', amount: 1500, count: 2 },
      { code: 'transferencia', label: 'Transferencia', amount: 1000, count: 1 },
    ]);
    expect(services.recentPayments[0]).toMatchObject({ amount: 1000, method: 'Transferencia', invoice: 'FS-0001', client: 'Farmacia Central' });
  });

  test('por cobrar: saldo de cada factura, vencidas primero y por cliente', () => {
    const { services, summary } = snapshotLib.buildScopeDocuments(snapshot, null);
    const r = services.receivables;
    expect(r).toMatchObject({ total: 6500, invoices: 2, overdueCount: 1, overdueAmount: 4000, debtorsCount: 2 });
    expect(r.items[0]).toMatchObject({ number: 'FS-0001', balance: 4000, late: true, daysOverdue: 10, statusLabel: 'Pago parcial' });
    expect(r.items[1]).toMatchObject({ number: 'FS-0002', late: false, daysOverdue: 0 });
    expect(r.debtors[0]).toMatchObject({ name: 'Farmacia Central', invoices: 1, balance: 4000, overdue: true, oldestDays: 25 });
    expect(summary.services.receivables).toEqual({ total: 6500, invoices: 2, overdueCount: 1, overdueAmount: 4000, debtorsCount: 2 });
  });

  test('cotizaciones, órdenes, proyectos y contratos con lo que necesita atención', () => {
    const { services, summary } = snapshotLib.buildScopeDocuments(snapshot, null);
    const m = Object.fromEntries(services.modules.map((x) => [x.key, x]));
    expect(m.cotizaciones).toMatchObject({ open: 2, attention: 1, amount: 11000 });
    expect(m.cotizaciones.items[0]).toMatchObject({ number: 'COT-0002', late: true, date: '2026-09-16', statusLabel: 'Abierta' });
    expect(m.ordenes).toMatchObject({ open: 2, attention: 1 });
    expect(m.ordenes.items[0]).toMatchObject({ number: 'OT-0001', title: 'Instalar red', late: true, note: 'Carlos · Prioridad alta' });
    expect(m.proyectos).toMatchObject({ open: 2, attention: 1, amount: 85000 });
    expect(m.proyectos.items[0]).toMatchObject({ number: 'PRY-0001', progress: 40, late: true });
    expect(m.contratos).toMatchObject({ open: 2, attention: 1, amount: 5000 });
    // El resumen lleva los números sin las listas.
    expect(summary.services.modules.find((x) => x.key === 'ordenes')).toEqual({
      key: 'ordenes', label: 'Órdenes de trabajo', open: 2, openLabel: 'abiertas', attention: 1, attentionLabel: 'atrasadas', amount: null, amountLabel: null,
    });
  });

  test('alertas de servicios; sin inventario, cajas ni el fiado del POS', () => {
    const { summary } = snapshotLib.buildScopeDocuments(snapshot, null);
    const ids = summary.alerts.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['services-overdue', 'services-cotizaciones', 'services-ordenes', 'services-proyectos', 'services-contratos']));
    expect(ids.some((id) => /^(inventory|cash|receivables)-/.test(id))).toBe(false);
    const ordenes = summary.alerts.find((a) => a.id === 'services-ordenes');
    expect(ordenes).toMatchObject({ module: 'services:ordenes', title: '1 orden de trabajo atrasada', message: 'Instalar red' });
  });

  test('lo más facturado va por servicio, no como "ventas rápidas"', () => {
    const { summary } = snapshotLib.buildScopeDocuments(snapshot, null);
    expect(summary.periods.month.topProducts.map((p) => [p.name, p.sales])).toEqual([
      ['Soporte técnico', 1200],
      ['Instalación de red', 1000],
    ]);
  });

  test('una sucursal solo ve lo suyo', () => {
    const { services } = snapshotLib.buildScopeDocuments(snapshot, '2');
    expect(services.receivables).toMatchObject({ total: 2500, invoices: 1, overdueCount: 0 });
    expect(services.collections.month).toEqual({ count: 1, amount: 300 });
    expect(services.modules.find((x) => x.key === 'ordenes').items.map((i) => i.number)).toEqual(['OT-0002']);
    expect(services.branchIds).toEqual(['2']);
  });
});

describe('Centro de Control — punto de venta y casos raros', () => {
  test('un colmado sigue igual: modo pos, sin documento de servicios', async () => {
    const { db, query } = await createDb();
    try {
      const snapshot = await snapshotLib.collectSnapshot({ query, now: NOW, full: true });
      const docs = snapshotLib.buildScopeDocuments(snapshot, null);
      expect(docs.summary.business).toMatchObject({ appMode: 'pos', vertical: null, modules: [] });
      expect(docs.summary.services).toBeUndefined();
      expect(docs.services).toBeUndefined();
      expect(docs.summary.alerts.some((a) => a.id === 'inventory-out')).toBe(true);
    } finally {
      db.close();
    }
  });

  test('empresa de servicios sin las tablas svc_* todavía: publica en cero y avisa', async () => {
    const { db, query } = await createServiceDb({ withServiceTables: false });
    try {
      const snapshot = await snapshotLib.collectSnapshot({ query, now: NOW, full: true });
      const { services, summary } = snapshotLib.buildScopeDocuments(snapshot, null);
      expect(summary.business.appMode).toBe('servicios');
      expect(services.receivables.total).toBe(0);
      expect(services.modules.every((x) => x.open === 0)).toBe(true);
      expect(snapshot.warnings.some((w) => w.startsWith('servicios'))).toBe(true);
    } finally {
      db.close();
    }
  });

  test('perfil por tipo de servicio', () => {
    expect(perfilDelNegocio({ business_type: 'srv_seguridad' }).modules).toEqual(['contratos', 'seguridad']);
    expect(perfilDelNegocio({ business_type: 'srv_viajes' }).modules).toEqual(['cotizaciones', 'reservaciones']);
    expect(perfilDelNegocio({ business_type: 'farmacia' }).appMode).toBe('pos');
    // Marcada como de servicios aunque el tipo diga otra cosa.
    expect(perfilDelNegocio({ business_type: 'colmado' }, { service_company: 1, service_vertical: 'srv_limpieza' }))
      .toMatchObject({ appMode: 'servicios', vertical: 'srv_limpieza', modules: ['contratos', 'ordenes', 'calendario'] });
  });
});

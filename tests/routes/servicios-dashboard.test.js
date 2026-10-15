'use strict';

/**
 * Panel del modo Empresa de Servicios (server/routes/servicios/dashboard.routes.js)
 * con SQLite real: cotizaciones abiertas (antes salía NaN), facturas sin
 * sucursal en el rendimiento por sucursal, vencidas con fecha como parámetro y
 * gastos por categoría (las líneas cuentan con su propia categoría).
 */

jest.mock('../../server/sync/sync-pos-stats', () => ({ syncPosStatsToFirestore: () => Promise.resolve() }));

const express = require('express');
const request = require('supertest');
const { createSqlitePos } = require('../helpers/sqlite-pos');
const { createServiciosRouter } = require('../../server/routes/servicios');
const { ensureSchema: ensureGastosSchema } = require('../../server/routes/gastos.routes');

async function armar() {
  const pos = await createSqlitePos();
  await ensureGastosSchema(pos.query);
  const app = express();
  app.use(express.json());
  app.use('/api/servicios', createServiciosRouter({
    query: pos.query,
    withTransaction: pos.withTransaction,
    resolveRequestActorUser: async () => ({ id: 1, usuario: 'admin', role_code: 'administrador_general' }),
    userRoleHasPermission: () => true,
    writeAuditLog: async () => {},
    getUserScopeBranchId: () => null,
    isGlobalAdministratorUser: () => true,
    isBranchAdministratorUser: () => false,
    getConfig: async () => ({ serviceCompany: true, serviceFiscalMode: 'ncf' }),
    getNextNcfFromSequence: async () => ({ ncf: 'B0200000001', fechaVencimiento: '2026-12-31' }),
  }));
  // Primer pedido: crea el esquema de servicios.
  await request(app).get('/api/servicios/dashboard?desde=2026-10-01&hasta=2026-10-31');
  return { app, q: pos.query };
}

test('panel: números del período, cotizaciones, sucursal, vencidas y gastos por categoría', async () => {
  const { app, q } = await armar();
  // Dos facturas sin sucursal (pagadas) y una pendiente vencida.
  await q(`INSERT INTO svc_invoices (numero, fecha, total, pagado, balance, estado, branch_id) VALUES
    ('FAC-1', '2026-10-14', 2950, 2950, 0, 'pagada', NULL),
    ('FAC-2', '2026-10-14', 1770, 1770, 0, 'pagada', NULL),
    ('FAC-3', '2026-10-02', 1000, 0, 1000, 'pendiente', NULL)`);
  await q("UPDATE svc_invoices SET vencimiento = '2026-10-05', client_name = 'ACME' WHERE numero = 'FAC-3'");
  // Cotizaciones: una aprobada de este mes, una enviada de septiembre (sigue abierta) y una convertida.
  await q(`INSERT INTO svc_quotations (numero, fecha, estado, total) VALUES
    ('COT-1', '2026-10-10', 'aprobada', 500), ('COT-2', '2026-09-20', 'enviada', 300), ('COT-3', '2026-10-11', 'convertida', 900)`);
  // Gasto con dos líneas de categorías distintas + uno de un solo monto.
  await q(`INSERT INTO expenses (id, branch_id, categoria, descripcion, fecha, subtotal, itbis, total, estado) VALUES
    (1, 1, 'Mantenimiento', 'Factura ferretería', '2026-10-03', 6000, 810, 6810, 'pagado'),
    (2, 1, 'Nómina', 'Pago nómina', '2026-10-14', 30000, 0, 30000, 'pagado')`);
  await q(`INSERT INTO expense_items (expense_id, orden, descripcion, categoria, cantidad, precio, itbis_pct, subtotal, itbis, total) VALUES
    (1, 0, 'Cemento', 'Mantenimiento', 10, 450, 18, 4500, 810, 5310),
    (1, 1, 'Gasolina', 'Combustible', 1, 1500, 0, 1500, 0, 1500)`);

  const res = await request(app).get('/api/servicios/dashboard?desde=2026-10-01&hasta=2026-10-31');
  expect(res.status).toBe(200);
  const d = res.body;
  expect(d.serviciosFacturados).toEqual({ monto: 5720, cantidad: 3 });
  expect(d.cotizaciones).toMatchObject({ aprobada: 1, convertida: 1, enviada: 0, abiertas: 2, montoAbiertas: 800 });
  expect(d.facturasVencidas).toBe(1);
  // Las facturas sin sucursal ya no desaparecen del rendimiento por sucursal.
  expect(d.porSucursal).toEqual([{ branchId: null, sucursal: 'Sin sucursal asignada', facturado: 5720, porCobrar: 1000 }]);
  expect(d.porCobrar).toHaveLength(1);
  expect(d.porCobrar[0]).toMatchObject({ numero: 'FAC-3', cliente: 'ACME', balance: 1000, vencida: true });
  expect(d.gastosPeriodo).toBe(36810);
  expect(d.gastosPorCategoria).toEqual([
    { categoria: 'Nómina', monto: 30000 },
    { categoria: 'Mantenimiento', monto: 5310 },
    { categoria: 'Combustible', monto: 1500 },
  ]);
  expect(d.gananciaEstimada).toBe(5720 - 36810);
});

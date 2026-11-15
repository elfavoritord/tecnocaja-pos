'use strict';
// Contrato app → POS: el JSON que arma la app de reportes para una compra
// (reporte app/test/fixtures/app_requests/compra_app.json, lo genera y lo
// verifica su prueba de Flutter) se registra tal cual con la ruta real de compras.
jest.mock('../../db', () => ({ getDbClient: () => 'sqlite' }));
const fs = require('fs');
const path = require('path');
const { firestoreFalso, baseCompras, usuariosPos } = require('./helpers');
const { createColaComprasApp } = require('../../server/services/compras/cola-app');

const CONTRATO = path.join(__dirname, '..', '..', 'reporte app', 'test', 'fixtures', 'app_requests', 'compra_app.json');
const NEG = 'pos_negocio1';

const hayContrato = fs.existsSync(CONTRATO);
(hayContrato ? test : test.skip)('la compra que manda la app se registra completa', async () => {
  const payload = JSON.parse(fs.readFileSync(CONTRATO, 'utf8'));
  const { query, servicio } = await baseCompras();
  const id = '4f0c2a8e-1b2c-4d3e-8f90-123456789abc';
  const db = firestoreFalso({
    'users/uEmilio': { role: 'admin', posUserId: 1, businessId: NEG, businessIds: [NEG] },
    [`businesses/${NEG}/appCompras/${id}`]: { ...payload, status: 'pendiente', createdBy: 'uEmilio', createdAt: new Date(), appVersion: '1.5.0' },
  });
  const cola = createColaComprasApp({
    servicio, query, getDb: () => db, getBusinessId: async () => NEG, getBranchId: async () => 1,
    usuarioApp: usuariosPos([{ id: 1, nombre: 'Emilio', estado: 'Activo', role_code: 'administrador_general' }]),
    logger: { warn: () => {} },
  });
  await cola.procesar();
  const d = db._docs.get(`businesses/${NEG}/appCompras/${id}`);
  expect({ status: d.status, mensaje: d.mensaje, bloqueos: d.bloqueos }).toEqual({ status: 'registrada', mensaje: '', bloqueos: [] });
  expect(d.totalRegistrado).toBeCloseTo(payload.encabezado.totalesDocumento.total, 2);
  expect(d.productosCreados).toBe(1);
  const [compra] = await query('SELECT p.*, s.rnc AS proveedor_rnc FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id');
  expect(compra).toMatchObject({ uuid: id, proveedor_rnc: '101000002', documento_origen: 'app_reportes' });
  const [nuevo] = await query("SELECT * FROM products WHERE nombre = 'Habichuelas Rojas 1 lb'");
  expect(nuevo).toMatchObject({ barcode: payload.lineas[1].codigoBarras, estado: 'Activo' });
  const [factura] = await query('SELECT * FROM supplier_invoices');
  // A crédito: queda la cuenta por pagar completa, con su vencimiento.
  expect(Number(factura.pending_amount)).toBeCloseTo(payload.encabezado.totalesDocumento.total, 2);
  expect(String(factura.due_at)).toMatch(/^2026-12-09/);
});

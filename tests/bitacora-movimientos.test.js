'use strict';
// Bitácora de Movimientos (pedido de Emilio, 2026-11-16): la hora salía 4 horas
// adelantada con MariaDB, el corte se veía como JSON crudo y faltaban aperturas
// de la gaveta (al cobrar y al probarla) y el cierre de sesión.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { auditCreatedAtIso } = require('../server/utils/fecha-auditoria');

describe('hora de la bitácora', () => {
  test('MariaDB: el Date que arma mysql2 con la hora UTC guardada vuelve a ser UTC', () => {
    // mysql2 lee "2026-11-16 16:02:05" como hora local de la PC.
    const deMysql = new Date(2026, 10, 16, 16, 2, 5);
    expect(auditCreatedAtIso(deMysql)).toBe('2026-11-16T16:02:05.000Z');
    // En RD (UTC−4) eso se muestra 12:02 p. m., no 04:02 p. m.
  });

  test('SQLite: el texto se marca como UTC', () => {
    expect(auditCreatedAtIso('2026-11-16 16:02:05')).toBe('2026-11-16T16:02:05Z');
    expect(auditCreatedAtIso('2026-11-16T16:02:05Z')).toBe('2026-11-16T16:02:05Z');
    expect(auditCreatedAtIso('')).toBeNull();
  });
});

describe('detalle legible en Movimientos', () => {
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'js', 'movimientos.js'), 'utf8');
  const contexto = { window: {}, console };
  vm.createContext(contexto);
  vm.runInContext(fuente, contexto);
  const formatear = contexto.window.formatMovementDetail;

  test('un detalle JSON viejo se lee de corrido', () => {
    const viejo = JSON.stringify({ cajero: 'prueba test', horaApertura: '12:02 p. m.', ventas: 0, efectivo: 150.5, sucursal: 'Principal', caja: 'Caja Principal' });
    expect(formatear(viejo)).toBe('Cajero: prueba test · Apertura: 12:02 p. m. · Ventas: 0.00 · Efectivo: 150.50 · Sucursal: Principal · Caja: Caja Principal');
  });

  test('un detalle normal no cambia', () => {
    expect(formatear('Sucursal Principal · Caja Principal · Cierre de caja')).toBe('Sucursal Principal · Caja Principal · Cierre de caja');
    expect(formatear('{no es json')).toBe('{no es json');
  });
});

describe('lo que ahora llega a la bitácora', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'caja-segura.routes.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

  test('toda apertura de gaveta se audita, también la del cobro y la prueba', () => {
    expect(rutas).toMatch(/const YA_ABIERTA = new Set\(\['venta', 'prueba'\]\)/);
    expect(rutas).not.toMatch(/if \(motivo !== 'venta'\) \{\s*await auditar/);
    expect(app).toMatch(/testCashDrawer\(cfg\);[\s\S]{0,200}registrarAperturaPrueba/);
  });

  test('cerrar sesión llama al servidor y queda en la bitácora', () => {
    expect(server).toMatch(/actionName: 'Cierre de sesión'/);
    expect(app).toMatch(/api\.request\('\/api\/logout'/);
  });

  test('el corte ya no guarda el detalle como JSON', () => {
    const corte = server.slice(server.indexOf("actionName: 'Corte de caja'"), server.indexOf("actionName: 'Corte de caja'") + 2500);
    expect(corte).not.toMatch(/detail: JSON\.stringify/);
  });
});

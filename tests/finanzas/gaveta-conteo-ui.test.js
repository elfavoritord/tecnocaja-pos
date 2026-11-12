'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../../js/caja-segura.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../../js/app.js'), 'utf8');

function pantalla({ permisos = true, abierta = true, configurada = true, hardwareOk = true, puedeCerrar = true } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { dataset: {}, classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn() }, focus() {} });
    return elements.get(id);
  };
  const openCashDrawer = jest.fn(async () => ({ ok: hardwareOk, error: hardwareOk ? '' : 'Impresora desconectada' }));
  const request = jest.fn(async (url) => {
    if (url.includes('/cierre/verificar')) return { puedeCerrar, mesas: [] };
    if (url === '/api/caja/config') return { cierreSeguro: true };
    if (url === '/api/caja/gaveta') return { eventUuid: 'evento-conteo-1234', abrirGaveta: true };
    return {};
  });
  const ctx = vm.createContext({ window: { crypto: { randomUUID: () => 'evento-conteo-1234' }, novaDesktop: { openCashDrawer } },
    DB: { config: { cajaAbierta: abierta } }, cajaAbierta: abierta,
    document: { getElementById: element, querySelector: () => null },
    api: { request }, currentUserCan: () => permisos, showToast: jest.fn(),
    getCashDrawerOpenConfig: () => configurada ? { printerName: 'Impresora Caja 1', pin: 0 } : null,
    getPendingDeliveryCashSales: () => [], getBusinessStructurePayload: () => ({ branchId: 1, cashRegisterId: 2 }),
    getActorPayload: () => ({ userId: 7 }), setTimeout: () => {}, URLSearchParams,
    closeCashCierreModal: () => {}, _getCorteData: () => ({}), fmt: () => '0.00', console,
  });
  vm.runInContext(source, ctx);
  // Ejecutar los botones clásicos reales sin cargar el resto de app.js.
  for (const name of ['openCashCorteModal', 'openCashCierreModal']) {
    const start = appSource.indexOf(`async function ${name}(`);
    const end = appSource.indexOf('\nfunction closeCash', start);
    vm.runInContext(appSource.slice(start, end), ctx);
  }
  return { ctx, caja: ctx.window.CajaSegura, request, openCashDrawer };
}

describe('apertura de gaveta antes de contar el efectivo', () => {
  test.each([
    ['cierre seguro', 'cierre', (p) => p.caja.abrirCierre()],
    ['corte ciego', 'arqueo', (p) => p.caja.abrirCorteCiego()],
    ['cierre clásico', 'cierre', (p) => p.ctx.openCashCierreModal()],
    ['corte clásico', 'arqueo', (p) => p.ctx.openCashCorteModal()],
  ])('%s registra el motivo y abre una vez la gaveta configurada', async (_label, motivo, abrir) => {
    const p = pantalla();
    await abrir(p);
    const event = p.request.mock.calls.find(([url]) => url === '/api/caja/gaveta');
    expect(JSON.parse(event[1].body)).toMatchObject({ motivo, branchId: 1, cashRegisterId: 2 });
    expect(p.openCashDrawer).toHaveBeenCalledTimes(1);
    expect(p.openCashDrawer).toHaveBeenCalledWith({ printerName: 'Impresora Caja 1', pin: 0 });
    expect(p.request).toHaveBeenCalledWith('/api/caja/gaveta/evento-conteo-1234/resultado', expect.objectContaining({ body: JSON.stringify({ estado: 'abierta', error: '' }) }));
  });

  test.each([{ permisos: false }, { abierta: false }, { puedeCerrar: false }])('no abre en un cierre bloqueado: %j', async (opciones) => {
    const p = pantalla(opciones);
    await p.caja.abrirCierre();
    expect(p.openCashDrawer).not.toHaveBeenCalled();
  });

  test('sin gaveta configurada permite mostrar el conteo', async () => {
    const p = pantalla({ configurada: false });
    await p.caja.abrirCierre();
    expect(p.openCashDrawer).not.toHaveBeenCalled();
    expect(p.ctx.document.getElementById('modal-body').innerHTML).toContain('cs-den-2000');
  });

  test('si falla la impresora registra el fallo y avisa al cajero', async () => {
    const p = pantalla({ hardwareOk: false });
    await p.caja.abrirCierre();
    expect(p.ctx.showToast).toHaveBeenCalledWith(expect.stringContaining('Impresora desconectada'), 'warning');
    const patch = p.request.mock.calls.find(([url]) => url.endsWith('/resultado'));
    expect(JSON.parse(patch[1].body).estado).toBe('fallo');
  });

  test('dos órdenes simultáneas envían un único pulso', async () => {
    const p = pantalla();
    await Promise.all([p.caja.abrirGavetaParaConteo('cierre'), p.caja.abrirGavetaParaConteo('cierre')]);
    expect(p.openCashDrawer).toHaveBeenCalledTimes(1);
  });
});

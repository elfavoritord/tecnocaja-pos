'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function harness(signedReceipt) {
  const state = { currentStep: 9, completedSteps: [1,2,3,4,5,6,7,8], steps: {}, progress: 53 };
  const elements = {
    'ecf-cert-wz-css': {}, 'fiscal-tab-homologation': {},
    'ecf-wz-sidebar': {}, 'ecf-wz-content': { style: {} },
    'ecf-wz-reception-retry': {},
    'ecf-wz-gateway-status': {}, 'ecf-wz-step9-list': { getClientRects: () => [{}] },
  };
  const calls = [];
  const context = { console, Date, setTimeout: jest.fn(), clearTimeout: jest.fn(),
    requestAnimationFrame: callback => callback(),
    document: { getElementById: id => elements[id] || null },
    localStorage: { getItem: () => null, setItem: jest.fn() },
    showFiscalToast: jest.fn(),
    fiscalApi: jest.fn(async (method, url, data) => {
      calls.push({ method, url, data });
      if (url === '/wizard/state') return { state };
      if (url === '/reception/received') return { items: [{ type: 'recepcion-ecf', receivedAt: '2026-11-15T04:00:00Z', meta: { encf: 'E310000000004', signedReceipt } }] };
      return { ok: true };
    }),
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ecf-cert-wizard.js'), 'utf8') + '\nglobalThis.wizard = ECF_CERT_WIZARD;', context);
  return { context, elements, calls, wizard: context.wizard };
}

test('el paso 9 espera y actualiza la recepción sin intentar conectar la nube', async () => {
  const h = harness(true);
  await h.wizard.init();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.calls).toContainEqual({ method: 'GET', url: '/reception/received', data: undefined });
  expect(h.calls).not.toContainEqual({ method: 'POST', url: '/reception/connect-gateway', data: {} });
  expect(h.elements['ecf-wz-step9-list'].innerHTML).toContain('Acuse firmado');
  expect(h.context.setTimeout).toHaveBeenCalledWith(expect.any(Function), 8000);
});
test('un comprobante antiguo con acuse sin firma no completa la prueba', async () => {
  const h = harness(false);
  await h.wizard.init();
  await h.wizard._pollStep9();
  await h.wizard.runStep9ecf();
  expect(h.elements['ecf-wz-step9-list'].innerHTML).toContain('acuse sin firma');
  expect(h.calls.filter(c => c.method === 'POST' && c.url === '/wizard/state')).toHaveLength(0);
  expect(h.context.showFiscalToast).toHaveBeenCalled();
});
test('con acuse firmado permite confirmar la validación realizada por DGII', async () => {
  const h = harness(true);
  await h.wizard.init();
  await h.wizard.runStep9ecf();
  const saved = h.calls.find(c => c.method === 'POST' && c.url === '/wizard/state');
  expect(saved.data.state.currentStep).toBe(10);
  expect(saved.data.state.completedSteps).toContain(9);
});

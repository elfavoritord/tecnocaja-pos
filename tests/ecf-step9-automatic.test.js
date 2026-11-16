'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function harness(signedReceipt, { confirmAnswer = false, items } = {}) {
  const state = { currentStep: 9, completedSteps: [1,2,3,4,5,6,7,8], steps: {}, progress: 53 };
  const elements = {
    'ecf-cert-wz-css': {}, 'fiscal-tab-homologation': {},
    'ecf-wz-sidebar': {}, 'ecf-wz-content': { style: {} },
    'ecf-wz-reception-retry': {}, 'ecf-wz-gateway-code': { value: '' },
    'ecf-wz-gateway-status': {}, 'ecf-wz-step9-list': { getClientRects: () => [{}] },
  };
  const calls = [];
  const received = items || [{ type: 'recepcion-ecf', receivedAt: '2026-11-15T04:00:00Z', meta: { encf: 'E310000000004', signedReceipt } }];
  const context = { console, Date, setTimeout: jest.fn(), clearTimeout: jest.fn(),
    requestAnimationFrame: callback => callback(),
    document: { getElementById: id => elements[id] || null },
    localStorage: { getItem: () => null, setItem: jest.fn() },
    showFiscalToast: jest.fn(),
    confirm: jest.fn(() => confirmAnswer),
    fiscalApi: jest.fn(async (method, url, data) => {
      calls.push({ method, url, data });
      if (url === '/wizard/state') return { state };
      if (url === '/reception/received') return { items: received };
      return { ok: true };
    }),
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ecf-cert-wizard.js'), 'utf8') + '\nglobalThis.wizard = ECF_CERT_WIZARD;', context);
  return { context, elements, calls, wizard: context.wizard };
}

const savedState = (h) => h.calls.filter(c => c.method === 'POST' && c.url === '/wizard/state');

test('el paso 9 conecta la recepción solo (sin código) y actualiza la lista', async () => {
  const h = harness(true);
  await h.wizard.init();
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  expect(h.calls).toContainEqual({ method: 'GET', url: '/reception/received', data: undefined });
  // Paso 9 automático: se conecta con el certificado de la empresa, sin código.
  expect(h.calls).toContainEqual({ method: 'POST', url: '/reception/connect-gateway', data: {} });
  expect(h.elements['ecf-wz-gateway-status'].textContent).toContain('Recepción conectada');
  expect(h.elements['ecf-wz-step9-list'].innerHTML).toContain('ARECF firmado');
  expect(h.context.setTimeout).toHaveBeenCalledWith(expect.any(Function), 8000);
});

test('el botón conecta sin código (automático) o con el código de soporte', async () => {
  const h = harness(false);
  await h.wizard.init();
  h.calls.length = 0;
  await h.wizard.connectReceptionGateway();
  expect(h.calls).toContainEqual({ method: 'POST', url: '/reception/connect-gateway', data: {} });
  expect(h.elements['ecf-wz-gateway-status'].textContent).toContain('Recepción conectada');

  // Acepta la línea del archivo de soporte tal cual.
  h.elements['ecf-wz-gateway-code'].value = '  ECF_GATEWAY_TOKEN=132967161.abc123  ';
  await h.wizard.connectReceptionGateway();
  expect(h.calls).toContainEqual({ method: 'POST', url: '/reception/connect-gateway', data: { token: '132967161.abc123' } });
  expect(h.elements['ecf-wz-gateway-code'].value).toBe('');
  expect(h.elements['ecf-wz-gateway-status'].textContent).toContain('Recepción conectada');
});

test('un acuse sin firma se marca y pide confirmar antes de completar', async () => {
  const h = harness(false, { confirmAnswer: false });
  await h.wizard.init();
  await h.wizard._pollStep9();
  expect(h.elements['ecf-wz-step9-list'].innerHTML).toContain('ARECF sin firma');
  await h.wizard.runStep9ecf();
  expect(h.context.confirm).toHaveBeenCalled();
  expect(savedState(h)).toHaveLength(0);
});

test('si la DGII ya lo aprobó se puede continuar con el acuse sin firma', async () => {
  const h = harness(false, { confirmAnswer: true });
  await h.wizard.init();
  await h.wizard.runStep9ecf();
  const saved = savedState(h).pop();
  expect(saved.data.state.currentStep).toBe(10);
  expect(saved.data.state.completedSteps).toContain(9);
});

test('con acuse firmado completa sin preguntar', async () => {
  const h = harness(true);
  await h.wizard.init();
  await h.wizard.runStep9ecf();
  expect(h.context.confirm).not.toHaveBeenCalled();
  const saved = savedState(h).pop();
  expect(saved.data.state.currentStep).toBe(10);
  expect(saved.data.state.completedSteps).toContain(9);
});

test('sin nada recibido avisa y no completa', async () => {
  const h = harness(true, { items: [] });
  await h.wizard.init();
  await h.wizard.runStep9ecf();
  expect(h.context.showFiscalToast).toHaveBeenCalled();
  expect(savedState(h)).toHaveLength(0);
});

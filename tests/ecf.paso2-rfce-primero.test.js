'use strict';
// Paso 2 ("Procesar y enviar comprobantes"): los 4 RFCE salen PRIMERO (decisión de
// Emilio, 2026-11-16). Si la DGII rechaza uno ("El e-NCF de este Resumen de Factura
// de Consumo ya ha sido utilizado previamente") y reinicia la prueba, no se mandan
// los 21 comprobantes; antes se mandaban primero y se perdían.
jest.mock('../modules/ecf/services/certification-importer', () => ({
  importCertificationSet: jest.fn(async () => ({ ok: 25, total: 25, results: [] })),
  previewCertificationSet: jest.fn(() => ({})),
}));

const { PassThrough } = require('stream');
const { createEcfService } = require('../modules/ecf/services/ecf.service');

function peticion({ background = false } = {}) {
  const limite = '----tc-paso2';
  const cuerpo = Buffer.from(
    (background ? `--${limite}\r\nContent-Disposition: form-data; name="background"\r\n\r\ntrue\r\n` : '')
    + `--${limite}\r\nContent-Disposition: form-data; name="environment"\r\n\r\ncertecf\r\n`
    + `--${limite}\r\nContent-Disposition: form-data; name="forceReset"\r\n\r\ntrue\r\n`
    + `--${limite}\r\nContent-Disposition: form-data; name="excel"; filename="133607336-16112026144000.xlsx"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\nset\r\n'
    + `--${limite}--\r\n`
  );
  const req = new PassThrough();
  req.headers = { 'content-type': `multipart/form-data; boundary=${limite}`, 'content-length': String(cuerpo.length) };
  req.method = 'POST';
  req.end(cuerpo);
  return req;
}

function servicio({ rfce }) {
  const s = createEcfService({
    query: async () => [],
    withTransaction: async (work) => work({ query: async () => [] }),
    resolveRequestActorUser: async () => ({ id: 1, nombre: 'Admin', role_code: 'administrador_general' }),
  });
  const orden = [];
  s.ensureReady = async () => {};
  s.getCurrentActor = async () => ({ id: 1, nombre: 'Admin' });
  s.resolveCertificate = async () => ({});
  s.applyRuntimeConfig = () => {};
  s.repository.getResolvedEmitter = async () => ({ rnc: '133607336' });
  s.repository.saveTestRun = async () => {};
  s.repository.saveAudit = async () => {};
  s.repository.query = async (sql) => {
    if (/^DELETE/.test(sql.trim())) return { affectedRows: 0 };
    if (/submission_mode = 'rfce'/.test(sql)) return [{ cnt: 4 }];
    if (/COUNT\(\*\)/.test(sql)) return [{ cnt: 25 }];
    return [];
  };
  s.certificationCenterStatus = async () => ({ counts: { accepted: 0, total: 25, sent: 0, rejected: 0, blocked: 0 } });
  s.markCertificationBlockedEncfs = async () => {};
  s.step4RfceSubmit = jest.fn(async () => { orden.push('rfce'); return rfce; });
  s.step4RfcePollStatuses = async () => ({ ok: true });
  s.pollCertificationStatuses = async () => ({ ok: true });
  const pendientes = [{ id: 1, encf: 'E310000000001' }, { id: 2, encf: 'E330000000001' }];
  s.repository.getNextPendingCertificationDocument = async () => pendientes.shift() || null;
  s.sendCertificationCase = jest.fn(async (id) => { orden.push(`ecf-${id}`); return { ok: true, id }; });
  return { s, orden };
}

jest.setTimeout(60000);

test('RFCE rechazado por la DGII: se para sin mandar los 21', async () => {
  const { s, orden } = servicio({
    rfce: {
      ok: false, rechazados: 1, batchInvalidated: true,
      results: [
        { encf: 'E320000000011', ok: false, estado: 'rechazado', mensaje: 'El e-NCF de este Resumen de Factura de Consumo ya ha sido utilizado previamente.' },
        { encf: 'E320000000012', ok: false, skipped: true, batchInvalidated: true, estado: 'generado' },
      ],
    },
  });
  const r = await s.certificationCenterProcess(peticion());
  expect(orden).toEqual(['rfce']);
  expect(s.sendCertificationCase).not.toHaveBeenCalled();
  expect(r.rfceFirstRejected).toBe(true);
  expect(r.message).toMatch(/ya ha sido utilizado previamente/);
  expect(r.message).toMatch(/No se envió ninguno de los 21/);
});

test('RFCE aceptados: van primero y después los comprobantes', async () => {
  const { s, orden } = servicio({
    rfce: { ok: true, aceptados: 4, rechazados: 0, results: [1, 2, 3, 4].map((n) => ({ encf: `E32000000001${n}`, ok: true, estado: 'aceptado' })) },
  });
  const r = await s.certificationCenterProcess(peticion());
  expect(orden).toEqual(['rfce', 'ecf-1', 'ecf-2']);
  expect(r.rfceFirstRejected).toBeUndefined();
  expect(r.rfceProcessResult.aceptados).toBe(4);
});

// Con la DGII real, 4 RFCE + 21 e-CF tardan minutos. El asistente lo pide en segundo
// plano: la respuesta llega apenas se importa y el avance queda en processRun.
async function esperarFin(s) {
  for (let i = 0; i < 300 && s._certificationProcessRunView().active; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return s._certificationProcessRunView();
}

test('En segundo plano: responde enseguida y el avance queda en processRun', async () => {
  const { s, orden } = servicio({
    rfce: { ok: true, aceptados: 4, rechazados: 0, results: [1, 2, 3, 4].map((n) => ({ encf: `E32000000001${n}`, ok: true, estado: 'aceptado' })) },
  });
  let soltar;
  const espera = new Promise((resolve) => { soltar = resolve; });
  s.sendCertificationCase = jest.fn(async (id) => { await espera; orden.push(`ecf-${id}`); return { ok: true, id }; });
  const r = await s.certificationCenterProcess(peticion({ background: true }));
  expect(r.processing).toBe(true);
  expect(r.processRun).toMatchObject({ active: true, rfceTotal: 4, ecfTotal: 21 });

  // Mientras envía: no deja arrancar otro ni reiniciar el lote.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(s._certificationProcessRunView()).toMatchObject({ active: true, phase: 'ecf', ecfSent: 1 });
  await expect(s.certificationCenterProcess(peticion())).rejects.toMatchObject({ statusCode: 409 });
  await expect(s.certificationCenterReset({})).rejects.toMatchObject({ statusCode: 409 });

  soltar();
  const fin = await esperarFin(s);
  expect(fin.active).toBe(false);
  expect(fin.error).toBeNull();
  expect(fin.result).toMatchObject({ rfceFirstRejected: false, sent: 2, rfceProcessResult: { aceptados: 4 } });
  expect(orden).toEqual(['rfce', 'ecf-1', 'ecf-2']);
  expect(s.runtimeState.certificationProcessInFlight).toBe(false);
});

test('En segundo plano con RFCE rechazado: el resultado lo dice y no salen los 21', async () => {
  const { s } = servicio({
    rfce: { ok: false, rechazados: 1, results: [{ encf: 'E320000000011', ok: false, estado: 'rechazado', mensaje: 'ya ha sido utilizado previamente' }] },
  });
  await s.certificationCenterProcess(peticion({ background: true }));
  const fin = await esperarFin(s);
  expect(fin.result.rfceFirstRejected).toBe(true);
  expect(fin.result.message).toMatch(/No se envió ninguno de los 21/);
  expect(s.sendCertificationCase).not.toHaveBeenCalled();
});

test('Si falla antes de enviar, se suelta el candado', async () => {
  const { s } = servicio({ rfce: { ok: true, results: [] } });
  s.repository.getResolvedEmitter = async () => { throw new Error('sin emisor'); };
  await expect(s.certificationCenterProcess(peticion({ background: true }))).rejects.toThrow('sin emisor');
  expect(s.runtimeState.certificationProcessInFlight).toBe(false);
});

'use strict';

/**
 * tests/ecf.rfce-envio-unico.test.js
 *
 * Paso 2 de la certificación: cada RFCE va a la DGII una sola vez por lote. Si la DGII
 * recibe el mismo e-NCF dos veces lo cuenta como enviado dos veces y reinicia la prueba.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEcfService } = require('../modules/ecf/services/ecf.service');

const ENCFS = ['E320000000005', 'E320000000006', 'E320000000007', 'E320000000008'];

function buildService({ respuestas = {}, historialQuemado = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rfce-unico-'));
  const docs = new Map(ENCFS.map((encf, i) => [encf, { id: 100 + i, encf, estado_dgii: 'firmado', sent_at: null }]));
  const eventos = [];
  let state = {
    items: ENCFS.map((encf) => {
      const localPath = path.join(tmp, `${encf}.xml`);
      fs.writeFileSync(localPath, `<RFCE><eNCF>${encf}</eNCF></RFCE>`, 'utf8');
      return { encf, localPath, fileName: `${encf}.xml`, estado: 'generado', certificationTestType: 'set-RFCE-1' };
    }),
  };

  const query = jest.fn(async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (/SELECT id, encf, estado_dgii, sent_at FROM ecf_documents/.test(text)) {
      const row = docs.get(params[0]);
      return row ? [{ ...row }] : [];
    }
    if (historialQuemado && /FROM ecf_sequence_usage/.test(text)) {
      return [{ status: 'BLOCKED_DGII_USED', dgii_message: 'ya ha sido utilizado previamente' }];
    }
    if (/^ ?UPDATE ecf_documents SET sent_at = CURRENT_TIMESTAMP/.test(text)) {
      const row = [...docs.values()].find((doc) => doc.id === params[0]);
      row.sent_at = new Date();
      eventos.push(`marca ${row.encf}`);
      return { affectedRows: 1 };
    }
    if (/^ ?UPDATE ecf_documents SET sent_at = NULL/.test(text)) {
      [...docs.values()].find((doc) => doc.id === params[0]).sent_at = null;
      return { affectedRows: 1 };
    }
    if (/UPDATE ecf_documents SET estado_dgii = \?/.test(text)) {
      const encf = params[params.length - 1];
      docs.get(encf).estado_dgii = params[0];
      return { affectedRows: 1 };
    }
    if (/UPDATE ecf_documents SET estado_dgii = '(error|rechazado)'/.test(text)) {
      const encf = params[params.length - 1];
      docs.get(encf).estado_dgii = text.includes("'error'") ? 'error' : 'rechazado';
      return { affectedRows: 1 };
    }
    return [];
  });

  const service = createEcfService({ query: jest.fn(async () => []), withTransaction: jest.fn(), resolveRequestActorUser: jest.fn() });
  service.repository = { query, recordSequenceUsage: jest.fn(async () => ({})) };
  service.ensureReady = jest.fn(async () => {});
  service._step4RfceReadState = () => JSON.parse(JSON.stringify(state));
  service._step4RfceWriteState = (next) => { state = JSON.parse(JSON.stringify(next)); };
  service.step4RfceGenerate = jest.fn(async () => ({ ok: true }));
  service.fcService = {
    // Igual que el real: valida y autentica, luego beforeSubmit, luego el POST.
    sendConsumptionSummary: jest.fn(async ({ filename, beforeSubmit }) => {
      const encf = filename.replace('.xml', '');
      const respuesta = respuestas[encf];
      if (respuesta?.antesDelPost) throw respuesta.antesDelPost;
      if (beforeSubmit) await beforeSubmit();
      eventos.push(`envia ${encf}`);
      if (respuesta instanceof Error) throw respuesta;
      return respuesta || { codigo: 1, estado: 'Aceptado', encf };
    }),
  };
  return { service, docs, eventos, getState: () => state };
}

describe('RFCE del Paso 2: un solo envío por lote', () => {
  test('marca el documento como enviado ANTES de llamar a la DGII', async () => {
    const { service, eventos } = buildService();
    const result = await service.step4RfceSubmit(null);
    expect(service.fcService.sendConsumptionSummary).toHaveBeenCalledTimes(4);
    expect(result.aceptados).toBe(4);
    for (const encf of ENCFS) {
      expect(eventos.indexOf(`marca ${encf}`)).toBeLessThan(eventos.indexOf(`envia ${encf}`));
    }
  });

  test('presionar "Enviar RFCE" otra vez no reenvía lo ya enviado, aunque no esté aceptado', async () => {
    const { service, getState } = buildService({
      respuestas: Object.fromEntries(ENCFS.map((encf) => [encf, { codigo: 3, estado: 'En Proceso', encf }])),
    });
    await service.step4RfceSubmit(null);
    expect(service.fcService.sendConsumptionSummary).toHaveBeenCalledTimes(4);

    // Simula lo que hacía "Generar": el estado local vuelve a "generado".
    const state = getState();
    state.items = state.items.map((item) => ({ ...item, estado: 'generado', securityCodeChanged: true }));
    service._step4RfceWriteState(state);

    const second = await service.step4RfceSubmit(null);
    expect(service.fcService.sendConsumptionSummary).toHaveBeenCalledTimes(4);
    expect(second.results.every((r) => r.alreadySent)).toBe(true);
  });

  test('si la DGII dice "ya utilizado" no se regenera ni se reenvía solo', async () => {
    const { service } = buildService({
      respuestas: {
        E320000000005: { codigo: 2, estado: 'Rechazado', mensajes: [{ valor: 'El resumen ya ha sido utilizado previamente' }] },
      },
    });
    const result = await service.step4RfceSubmit(null);
    expect(service.step4RfceGenerate).not.toHaveBeenCalled();
    // El primero se rechazó: los demás no se mandan en ese lote.
    expect(service.fcService.sendConsumptionSummary).toHaveBeenCalledTimes(1);
    expect(result.rechazados).toBe(1);
  });

  test('un fallo de red no se reintenta: no se sabe si la DGII lo recibió', async () => {
    const { service, docs } = buildService({
      respuestas: { E320000000005: new Error('Tiempo de espera agotado al consumir DGII') },
    });
    const first = await service.step4RfceSubmit(null);
    expect(first.results[0].error).toMatch(/no se reenvía/);
    expect(docs.get('E320000000005').sent_at).not.toBeNull();
    const callsAfterFirst = service.fcService.sendConsumptionSummary.mock.calls.length;

    await service.step4RfceSubmit(null);
    const reenviados = service.fcService.sendConsumptionSummary.mock.calls
      .slice(callsAfterFirst)
      .filter(([arg]) => arg.filename === 'E320000000005.xml');
    expect(reenviados).toHaveLength(0);
  });

  test('si falla la autenticación antes del POST, el RFCE se puede enviar después', async () => {
    const respuestas = { E320000000005: { antesDelPost: new Error('No se pudo autenticar con la DGII') } };
    const { service, docs } = buildService({ respuestas });
    const first = await service.step4RfceSubmit(null);
    expect(first.results[0].error).toMatch(/puedes enviarlo de nuevo/);
    expect(docs.get('E320000000005').sent_at).toBeNull();

    delete respuestas.E320000000005;
    await service.step4RfceSubmit(null);
    const envios = service.fcService.sendConsumptionSummary.mock.calls
      .filter(([arg]) => arg.filename === 'E320000000005.xml');
    expect(envios).toHaveLength(2);
    expect(docs.get('E320000000005').sent_at).not.toBeNull();
  });

  test('si la conexión ni se abrió (ECONNREFUSED), se quita la marca', async () => {
    const sinConexion = Object.assign(new Error('Fallo de red con DGII: connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } });
    const { service, docs } = buildService({ respuestas: { E320000000005: sinConexion } });
    const first = await service.step4RfceSubmit(null);
    expect(first.results[0].error).toMatch(/No llegó a la DGII/);
    expect(docs.get('E320000000005').sent_at).toBeNull();
  });

  // Decisión de Emilio (2026-10-29): el set del Paso 2 sale aunque un intento anterior
  // haya quedado "ya utilizado". Solo cuenta la marca de envío del lote actual.
  test('con un set nuevo, el RFCE se envía aunque un intento anterior quedara "ya utilizado"', async () => {
    const { service } = buildService({ historialQuemado: true });
    const result = await service.step4RfceSubmit(null);
    expect(service.fcService.sendConsumptionSummary).toHaveBeenCalledTimes(4);
    expect(result.aceptados).toBe(4);
  });

  test('reenviar a mano un RFCE de certificación ya enviado se rechaza', () => {
    const { service } = buildService();
    expect(() => service._assertCertificationRfceNotSent({
      certification_case_key: 'caso-1', submission_mode: 'rfce', sent_at: new Date(), encf: 'E320000000005',
    })).toThrow(/ya se envió a la DGII/);
    expect(() => service._assertCertificationRfceNotSent({
      certification_case_key: 'caso-1', submission_mode: 'rfce', sent_at: null, encf: 'E320000000005',
    })).not.toThrow();
    expect(() => service._assertCertificationRfceNotSent({
      certification_case_key: 'caso-1', submission_mode: 'normal', sent_at: new Date(), encf: 'E310000000001',
    })).not.toThrow();
  });
});

describe('otros caminos que reenviaban RFCE de certificación', () => {
  const repoSrc = fs.readFileSync(path.join(__dirname, '..', 'modules', 'ecf', 'models', 'ecf.repository.js'), 'utf8');

  function bodyOf(name) {
    const start = repoSrc.indexOf(`async ${name}(`);
    return repoSrc.slice(start, repoSrc.indexOf('\n  async ', start + 10));
  }

  test('"Reintentar pendientes" no toca casos de certificación', () => {
    expect(bodyOf('getRetryableDocuments')).toContain('certification_case_key IS NULL');
  });

  test('"Resetear y reintentar" del Paso 2 no borra el envío de los RFCE', () => {
    expect(bodyOf('resetSentCertificationCasesToFirmado')).toContain("submission_mode != 'rfce'");
  });
});

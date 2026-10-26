'use strict';

/**
 * Certificación en CerteCF con el ambiente guardado en TesteCF: las consultas
 * de TrackID y el envío de RFCE iban a TesteCF (el ambiente en memoria o el
 * guardado), y un botón de diagnóstico ("Obtener semilla") dejaba cambiado el
 * ambiente en medio del proceso. Cada documento va a su ambiente y los
 * diagnósticos no dejan el ambiente cambiado.
 */

const { createEcfService } = require('../modules/ecf/services/ecf.service');

function buildService() {
  const service = createEcfService({
    query: async () => [],
    withTransaction: async (work) => work({ query: async () => [] }),
    resolveRequestActorUser: async () => ({ id: 1, role_code: 'administrador_general' }),
  });
  service.ensureReady = async () => {};
  service.repository.getResolvedEmitter = async () => ({ environment: 'testecf' });
  service.repository.saveTestRun = async () => {};
  service.applyRuntimeConfig('testecf');
  return service;
}

describe('ambiente de cada documento e-CF', () => {
  test('la consulta de TrackID usa el ambiente del documento (CerteCF), no el de memoria', async () => {
    const service = buildService();
    service.repository.getDocument = async () => ({ id: 7, track_id: 'tk-1', environment: 'certecf', encf: 'E310000000006', certification_case_key: 'c1' });
    service.repository.markDocumentStatus = async () => {};
    let ambienteAlConsultar = null;
    service.statusService.getTrackStatus = async () => { ambienteAlConsultar = service.config.DGII_ENV; return { estado: 'Aceptado' }; };
    await service.queryDocumentStatus(7);
    expect(ambienteAlConsultar).toBe('certecf');
  });

  test('"Obtener semilla" en TesteCF no deja el ambiente cambiado', async () => {
    const service = buildService();
    service.applyRuntimeConfig('certecf'); // p. ej. la certificación en curso
    let ambienteSemilla = null;
    service.authService.requestSeed = async () => { ambienteSemilla = service.config.DGII_ENV; return { value: 'abc', xml: '<x/>' }; };
    const res = await service.testSeed({ body: { environment: 'testecf' } });
    expect(ambienteSemilla).toBe('testecf');
    expect(res.seedUrl).toMatch(/TesteCF/);
    expect(service.config.DGII_ENV).toBe('certecf');
  });

  test('el RFCE se envía al ambiente del documento aunque el guardado sea TesteCF', async () => {
    const service = buildService();
    service.repository.getDocument = async () => ({ id: 9, encf: 'E320000000011', submission_mode: 'rfce', estado_dgii: 'pendiente', signed_xml_content: '<RFCE/>', environment: 'certecf' });
    let ambienteEnvio = null;
    service.fcService.sendConsumptionSummary = async () => { ambienteEnvio = service.config.DGII_ENV; throw new Error('corte de la prueba'); };
    await service._rfceSendById(9, { body: {} }).catch(() => {});
    expect(ambienteEnvio).toBe('certecf');
  });

  test('el servicio de RFCE registra la URL del ambiente activo (producción no dice CerteCF)', () => {
    const service = buildService();
    service.applyRuntimeConfig('ecf');
    expect(service.fcService.config.DGII_ENV).toBe('ecf');
    expect(service.fcService.config.DGII_FC_URL).toBe(service.dgiiClient.config.DGII_FC_URL);
    expect(service.fcService.config.DGII_FC_URL).toMatch(/\/eCF\/RecepcionFC\//);
  });
});

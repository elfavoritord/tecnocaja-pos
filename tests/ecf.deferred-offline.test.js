'use strict';

/**
 * tests/ecf.deferred-offline.test.js
 *
 * Sin Internet el e-CF se firma y queda guardado (pendiente, sin marcar como
 * enviado: conserva su e-NCF). Cuando vuelve Internet se envía el XML exacto
 * que se firmó, con el mismo tratamiento de la respuesta que el envío en línea.
 */

const fs = require('fs');
const path = require('path');
const { createEcfService } = require('../modules/ecf/services/ecf.service');
const { startEcfDeferredDispatch } = require('../server/sync/ecf-deferred-dispatch');
const { EventEmitter } = require('events');

function buildService() {
  const service = createEcfService({ query: jest.fn(async () => []), withTransaction: jest.fn(), resolveRequestActorUser: jest.fn() });
  const repository = {
    markDocumentDeferred: jest.fn(async () => {}),
    attachSaleSummary: jest.fn(async () => {}),
    saveAudit: jest.fn(async () => {}),
    getDeferredDocuments: jest.fn(async () => []),
    countDeferredDocuments: jest.fn(async () => 0),
    clearDocumentDeferred: jest.fn(async () => {}),
    getSaleScope: jest.fn(async () => ({ id: 9, branch_id: 1, cash_register_id: 2 })),
    markDocumentSent: jest.fn(async () => {}),
    advanceSequenceAfterUse: jest.fn(async () => {}),
  };
  service.repository = repository;
  service.ensureReady = jest.fn(async () => {});
  service.getSystemStatus = jest.fn(async () => ({ isActive: true }));
  service.resolveCertificate = jest.fn(async () => ({ cert: true }));
  service.receptionService = { sendSignedEcf: jest.fn(async () => ({ trackId: 'TRK-1', estado: 'Aceptado' })) };
  service.fcService = { sendConsumptionSummary: jest.fn(async () => ({ trackId: 'TRK-2', estado: 'Aceptado' })) };
  return { service, repository };
}

const payload = {
  reservation: { documentId: 77, encf: 'E310000000123', sequence: { id: 5 } },
  tipoEcf: 'E31',
  sale: { branch_id: 1, cash_register_id: 2 },
};

describe('e-CF sin Internet', () => {
  test('se firma y queda pendiente, sin marcarse como enviado', async () => {
    const { service, repository } = buildService();
    const result = await service.deferSaleDocumentOffline(9, payload, { signedXml: '<ECF firmado/>', submissionMode: 'normal', context: { userId: 1 } });
    expect(result).toMatchObject({ ok: false, pending: true, offline: true, estado: 'pendiente', encf: 'E310000000123' });
    expect(repository.markDocumentDeferred).toHaveBeenCalledWith(77, expect.objectContaining({ signedXml: '<ECF firmado/>' }));
    expect(repository.attachSaleSummary).toHaveBeenCalledWith(9, expect.objectContaining({ estado: 'pendiente', encf: 'E310000000123' }));
    expect(repository.markDocumentSent).not.toHaveBeenCalled();
    expect(service.receptionService.sendSignedEcf).not.toHaveBeenCalled();
  });

  test('processSaleForElectronicInvoicing difiere el envío cuando no hay Internet', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'ecf', 'services', 'ecf.service.js'), 'utf8');
    const start = src.indexOf('async processSaleForElectronicInvoicing(saleId, context = {}) {');
    const block = src.slice(start, src.indexOf('async listDocuments', start));
    const signIdx = block.indexOf('signatureService.signXML(payload.generated.xml, certificate)');
    const deferIdx = block.indexOf('this.deferSaleDocumentOffline(saleId, payload, { signedXml, submissionMode, context })');
    const sendIdx = block.indexOf('this.receptionService.sendSignedEcf({');
    expect(signIdx).toBeGreaterThan(-1);
    expect(deferIdx).toBeGreaterThan(signIdx);
    expect(deferIdx).toBeLessThan(sendIdx);
    expect(block).toContain('this.deferSaleDocumentOffline(saleId, payload, { signedXml: signedRfce, submissionMode, context })');
  });
});

describe('envío al volver Internet', () => {
  test('envía el XML guardado y actualiza documento, secuencia y venta', async () => {
    const { service, repository } = buildService();
    repository.getDeferredDocuments.mockResolvedValue([
      { id: 77, sale_id: 9, encf: 'E310000000123', tipo_ecf: 'E31', sequence_id: 5, submission_mode: 'normal', deferred_signed_xml: '<ECF firmado/>' },
    ]);
    const result = await service.sendDeferredDocuments();
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(service.receptionService.sendSignedEcf).toHaveBeenCalledWith({ signedXml: '<ECF firmado/>', filename: 'E310000000123.xml' });
    expect(repository.clearDocumentDeferred).toHaveBeenCalledWith(77);
    expect(repository.advanceSequenceAfterUse).toHaveBeenCalledWith(5, 'E310000000123');
    expect(repository.markDocumentSent).toHaveBeenCalledWith(77, expect.objectContaining({ track_id: 'TRK-1' }));
    expect(repository.attachSaleSummary).toHaveBeenCalledWith(9, expect.objectContaining({ trackId: 'TRK-1' }));
  });

  test('un RFCE se envía como resumen de consumo con su XML firmado', async () => {
    const { service, repository } = buildService();
    repository.getDeferredDocuments.mockResolvedValue([
      { id: 78, sale_id: 10, encf: 'E320000000050', tipo_ecf: 'E32', sequence_id: 6, submission_mode: 'rfce', deferred_signed_xml: '<RFCE firmado/>' },
    ]);
    await service.sendDeferredDocuments();
    expect(service.fcService.sendConsumptionSummary).toHaveBeenCalledWith({ signedXml: '<RFCE firmado/>', filename: 'E320000000050-rfce.xml', localEcfPath: null });
    expect(service.receptionService.sendSignedEcf).not.toHaveBeenCalled();
  });

  test('si se cae otra vez la conexión, el documento sigue pendiente y no se insiste', async () => {
    const { service, repository } = buildService();
    service.receptionService.sendSignedEcf.mockRejectedValue(new Error('No se pudo enviar el e-CF a DGII: getaddrinfo ENOTFOUND ecf.dgii.gov.do'));
    repository.getDeferredDocuments.mockResolvedValue([
      { id: 1, sale_id: 1, encf: 'E310000000001', submission_mode: 'normal', deferred_signed_xml: '<a/>' },
      { id: 2, sale_id: 2, encf: 'E310000000002', submission_mode: 'normal', deferred_signed_xml: '<b/>' },
    ]);
    const result = await service.sendDeferredDocuments();
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(service.receptionService.sendSignedEcf).toHaveBeenCalledTimes(1);
    expect(repository.clearDocumentDeferred).not.toHaveBeenCalled();
    expect(repository.markDocumentSent).not.toHaveBeenCalled();
  });

  test('un error que no es de red queda registrado como error (como en línea)', async () => {
    const { service, repository } = buildService();
    service.receptionService.sendSignedEcf.mockRejectedValue(new Error('XML inválido según el XSD'));
    repository.getDeferredDocuments.mockResolvedValue([
      { id: 3, sale_id: 3, encf: 'E310000000003', tipo_ecf: 'E31', submission_mode: 'normal', deferred_signed_xml: '<c/>' },
    ]);
    const result = await service.sendDeferredDocuments();
    expect(result.failed).toBe(1);
    expect(repository.clearDocumentDeferred).toHaveBeenCalledWith(3);
    expect(repository.markDocumentSent).toHaveBeenCalledWith(3, expect.objectContaining({ estado_dgii: 'error' }));
  });
});

describe('despachador de e-CF diferidos', () => {
  function fakeMonitor(online) {
    const monitor = new EventEmitter();
    monitor.online = online;
    monitor.isOnline = () => monitor.online;
    return monitor;
  }

  test('envía al volver Internet, solo en la PC principal y sin duplicar corridas', async () => {
    const service = {
      countDeferredDocuments: jest.fn(async () => 2),
      sendDeferredDocuments: jest.fn(async () => ({ sent: 2, failed: 0 })),
    };
    const monitor = fakeMonitor(false);
    const dispatch = startEcfDeferredDispatch({ service, monitor, logger: { log() {}, warn() {} }, startupDelayMs: 3600000, intervalMs: 3600000 });
    await expect(dispatch.run('prueba')).resolves.toBeNull(); // sin Internet no hace nada
    monitor.online = true;
    const [a, b] = await Promise.all([dispatch.run('a'), dispatch.run('b')]);
    dispatch.stop();
    expect(service.sendDeferredDocuments).toHaveBeenCalledTimes(1);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  test('en una caja terminal no envía (lo hace la principal)', async () => {
    const service = { countDeferredDocuments: jest.fn(async () => 1), sendDeferredDocuments: jest.fn() };
    const dispatch = startEcfDeferredDispatch({ service, monitor: fakeMonitor(true), isMain: () => false, logger: { log() {}, warn() {} }, startupDelayMs: 3600000, intervalMs: 3600000 });
    await dispatch.run('prueba');
    dispatch.stop();
    expect(service.sendDeferredDocuments).not.toHaveBeenCalled();
  });
});

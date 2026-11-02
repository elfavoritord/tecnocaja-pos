'use strict';

/**
 * e-CF que no nacen de una venta: notas (E33/E34) y los de compras y gastos (E41, E43, E47).
 * También los arreglos del generador: un exento salía gravado y exento a la vez (DGII 3205),
 * el E31 no llevaba la fecha que el XSD exige, y el 16% salía con el indicador del 0%.
 */

jest.mock('../modules/ecf/signature/signature.service', () => ({
  signXML: jest.fn((xml) => xml.replace('</ECF>', '<ds:Signature><ds:SignatureValue>ABC123XYZ</ds:SignatureValue></ds:Signature></ECF>')),
  verifySignature: jest.fn(() => ({ ok: true, signatureValue: 'ABC123XYZ' })),
  loadCertificate: jest.fn(),
  validateCertificate: jest.fn(),
}));

const { createEcfService } = require('../modules/ecf/services/ecf.service');
const { generateEcfXml } = require('../modules/ecf/services/ecf-generator');

const ACEPTADO = { id: 55, encf: 'E310000000009', rnc_comprador: '131880681', nombre_comprador: 'Cliente SRL', created_at: new Date() };

function preparar({ original = ACEPTADO, respuesta = { codigo: 1, estado: 'Aceptado', trackId: 'T1' }, activo = true, existing = null, sequence = { id: 3, fecha_vencimiento: '2027-12-31' } } = {}) {
  const service = createEcfService({ query: jest.fn(async () => []), withTransaction: jest.fn(), resolveRequestActorUser: jest.fn() });
  const guardado = {};
  service.ensureReady = jest.fn(async () => {});
  service.getEmitterForXml = jest.fn(async () => ({ rnc: '132839676', razonSocial: 'Farmacia SRL', direccion: 'Calle 1' }));
  service.getCertificateStatus = jest.fn(async () => ({ hasCertificate: true, isExpired: false, status: 'ok' }));
  service.resolveCertificate = jest.fn(async () => ({}));
  service.getCurrentActor = jest.fn(async () => ({ id: 1, nombre: 'Admin', rol: 'administrador_general' }));
  service.receptionService = { sendSignedEcf: jest.fn(async () => { if (respuesta instanceof Error) throw respuesta; return respuesta; }) };
  service.repository = {
    getResolvedEmitter: jest.fn(async () => ({ is_active: activo, environment: 'ecf', rnc: '132839676', razon_social: 'Farmacia SRL' })),
    query: jest.fn(async (sql) => (/FROM ecf_documents/.test(sql) && original ? [original] : [])),
    getSaleWithItems: jest.fn(async () => ({
      sale: { id: 9, created_at: new Date(), branch_id: 1, cash_register_id: 2, client_name: 'Cliente SRL' },
      items: [{ product_name: 'Producto', qty: 2, price: 100, tax_rate: 18 }],
    })),
    reserveStandaloneDocument: jest.fn(async () => ({ documentId: 77, sequence, encf: 'E340000000001', existing })),
    updateDocumentPayload: jest.fn(async (_id, data) => { Object.assign(guardado, data); }),
    markDocumentSent: jest.fn(async () => {}),
    markDocumentDeferred: jest.fn(async () => {}),
    advanceSequenceAfterUse: jest.fn(async () => {}),
    saveAudit: jest.fn(async () => {}),
    getDocument: jest.fn(async () => ({ id: 55, sale_id: 9 })),
  };
  return { service, guardado };
}

describe('generador: lo que el XSD de la DGII exige', () => {
  const base = { emitter: { rnc: '132839676', razonSocial: 'X', direccion: 'Calle' }, customer: { rnc: '131880681', nombre: 'Y' } };
  const generar = (tipoeCF, items, extra = {}) => generateEcfXml({
    ...base, items, document: { eNCF: `${tipoeCF}0000000001`, tipoeCF, fechaVencimientoSecuencia: '2027-12-31', ...extra },
  }).xml;
  const exento = [{ name: 'Exento', quantity: 1, unitPrice: 650, taxRate: 0 }];
  const gravado = [{ name: 'Gravado', quantity: 1, unitPrice: 100, taxRate: 18 }];

  test('un exento va solo como exento (caso real: 3205 MontoTotal no es correcto)', () => {
    const xml = generar('E32', exento);
    expect(xml).toContain('<MontoExento>650.00</MontoExento>');
    expect(xml).not.toContain('<MontoGravadoTotal>');
    expect(xml).toContain('<IndicadorFacturacion>4</IndicadorFacturacion>');
  });

  test('los ítems no llevan campos que el XSD no tiene', () => {
    const xml = generar('E31', gravado);
    for (const campo of ['MontoItemMasITBIS', 'TasaITBIS', 'ITBISItem']) expect(xml).not.toContain(`<${campo}>`);
    expect(xml).toContain('<TotalITBIS>18.00</TotalITBIS>');
  });

  test('E31 lleva la fecha de la secuencia, y sin fecha no se genera', () => {
    expect(generar('E31', gravado)).toContain('<FechaVencimientoSecuencia>31-12-2027</FechaVencimientoSecuencia>');
    expect(() => generar('E31', gravado, { fechaVencimientoSecuencia: null })).toThrow(/fecha de vencimiento/);
  });

  test('el 16% usa el indicador 2', () => {
    expect(generar('E31', [{ name: 'A', quantity: 1, unitPrice: 100, taxRate: 16 }])).toContain('<IndicadorFacturacion>2</IndicadorFacturacion>');
  });

  test('E41 lleva Retencion en cada ítem y no lleva TipoIngresos', () => {
    const xml = generar('E41', [{ ...gravado[0], withholdingAmount: 5 }]);
    expect(xml).toContain('<IndicadorAgenteRetencionoPercepcion>1</IndicadorAgenteRetencionoPercepcion>');
    expect(xml).toContain('<TotalISRRetencion>5.00</TotalISRRetencion>');
    expect(xml).not.toContain('<TipoIngresos>');
  });

  test('E43 no lleva Comprador', () => {
    expect(generar('E43', exento)).not.toContain('<Comprador>');
  });

  test('E46 va gravado al 0%, sin MontoExento', () => {
    const xml = generar('E46', exento);
    expect(xml).toContain('<MontoGravadoI3>650.00</MontoGravadoI3>');
    expect(xml).toContain('<ITBIS3>0</ITBIS3>');
    expect(xml).toContain('<IndicadorFacturacion>3</IndicadorFacturacion>');
    expect(xml).not.toContain('<MontoExento>');
  });
});

describe('notas ligadas a una venta', () => {
  const nota = (extra = {}) => ({ saleId: 9, tipoEcf: 'E34', codigoModificacion: '1', razon: 'Devolución', origen: 'return:1', ...extra });

  test('sin e-CF aceptado no hay nada que modificar', async () => {
    const { service } = preparar({ original: null });
    await expect(service.emitNoteForSale(nota())).resolves.toMatchObject({ skipped: true });
    expect(service.repository.reserveStandaloneDocument).not.toHaveBeenCalled();
  });

  test('con el e-CF inactivo no hace nada', async () => {
    const { service } = preparar({ activo: false });
    await expect(service.emitNoteForSale(nota())).resolves.toMatchObject({ skipped: true });
  });

  test('referencia la factura original y usa sus líneas', async () => {
    const { service, guardado } = preparar();
    const r = await service.emitNoteForSale(nota());
    expect(r).toMatchObject({ ok: true, encf: 'E340000000001', estado: 'aceptado' });
    expect(guardado.xml_content).toContain('<NCFModificado>E310000000009</NCFModificado>');
    expect(guardado.xml_content).toContain('<CodigoModificacion>1</CodigoModificacion>');
    expect(guardado.xml_content).toContain('<RazonModificacion>Devolución</RazonModificacion>');
    expect(guardado.xml_content).toContain('<IndicadorNotaCredito>0</IndicadorNotaCredito>');
    expect(guardado.monto_total).toBe(236);
    expect(service.repository.reserveStandaloneDocument).toHaveBeenCalledWith(expect.objectContaining({ documentoOrigenId: 55 }));
  });

  test('más de 30 días después, el indicador es 1', async () => {
    const { service, guardado } = preparar();
    service.repository.getSaleWithItems = jest.fn(async () => ({
      sale: { id: 9, created_at: new Date(Date.now() - 40 * 86400000) },
      items: [{ product_name: 'P', qty: 1, price: 100, tax_rate: 18 }],
    }));
    await service.emitNoteForSale(nota());
    expect(guardado.xml_content).toContain('<IndicadorNotaCredito>1</IndicadorNotaCredito>');
  });

  test('un reintento de lo que ya salió no se envía otra vez', async () => {
    const { service } = preparar({ existing: { signed_xml_content: '<ECF/>', estado_dgii: 'aceptado' } });
    await expect(service.emitNoteForSale(nota())).resolves.toMatchObject({ ok: true, existing: true });
    expect(service.receptionService.sendSignedEcf).not.toHaveBeenCalled();
  });

  test('sin Internet queda firmada para enviarse después', async () => {
    const { service } = preparar();
    const r = await service.emitNoteForSale(nota({ context: { internetOffline: true } }));
    expect(r).toMatchObject({ ok: true, pending: true });
    expect(service.repository.markDocumentDeferred).toHaveBeenCalled();
    expect(service.receptionService.sendSignedEcf).not.toHaveBeenCalled();
  });

  test('si la DGII la rechaza, lo dice sin lanzar', async () => {
    const { service } = preparar({ respuesta: { codigo: 2, estado: 'Rechazado', mensaje: 'No' } });
    await expect(service.emitNoteForSale(nota())).resolves.toMatchObject({ ok: false, error: 'No' });
    expect(service.repository.advanceSequenceAfterUse).not.toHaveBeenCalled();
  });

  test('caso real: la DGII recibe con TrackID y al consultar rechaza; el usuario ve el motivo', async () => {
    const { service } = preparar({ respuesta: { trackId: 'T9', estado: 'ENVIADO', error: null, raw: '{"error":null,"trackId":"T9"}' } });
    service.queryDocumentStatus = jest.fn(async () => ({ estado: 'rechazado', mensaje: 'No existen rangos de secuencias disponibles.' }));
    const r = await service.emitNoteForSale(nota());
    expect(service.repository.markDocumentSent).toHaveBeenCalledWith(77, expect.objectContaining({ estado_dgii: 'enviado', track_id: 'T9' }));
    expect(r).toMatchObject({ ok: false, estado: 'rechazado', error: 'No existen rangos de secuencias disponibles.' });
  });

  test('si la consulta no responde, queda enviado, no como error', async () => {
    const { service } = preparar({ respuesta: { trackId: 'T9', estado: 'ENVIADO', raw: '{"error":null}' } });
    service.queryDocumentStatus = jest.fn(async () => { throw new Error('sin red'); });
    await expect(service.emitNoteForSale(nota())).resolves.toMatchObject({ ok: true, estado: 'enviado' });
  });

  test('uno ya enviado con TrackID no se vuelve a enviar, aunque quedara marcado como error', async () => {
    const { service } = preparar({ existing: { signed_xml_content: '<ECF/>', estado_dgii: 'error', track_id: 'T1' } });
    await expect(service.emitNoteForSale(nota())).resolves.toMatchObject({ existing: true });
    expect(service.receptionService.sendSignedEcf).not.toHaveBeenCalled();
  });

  test('si no hay secuencia E34, emitSafely devuelve el motivo: la devolución no se cae', async () => {
    const { service } = preparar();
    service.repository.reserveStandaloneDocument = jest.fn(async () => { throw new Error('No hay una secuencia E34 de producción.'); });
    await expect(service.emitSafely('emitNoteForSale', nota())).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/E34/) });
  });
});

describe('nota hecha a mano', () => {
  const pedir = (service, body) => service.emitManualNote({ body: { documentId: 55, ...body } });

  test('anular toda la factura', async () => {
    const { service, guardado } = preparar();
    await expect(pedir(service, { tipoEcf: 'E34', anular: true, razon: 'Error' })).resolves.toMatchObject({ ok: true });
    expect(guardado.xml_content).toContain('<CodigoModificacion>1</CodigoModificacion>');
    expect(service.repository.reserveStandaloneDocument).toHaveBeenCalledWith(expect.objectContaining({ origen: 'sale:9:anulacion' }));
  });

  test('E33 por un monto, con su fecha de secuencia', async () => {
    const { service, guardado } = preparar();
    await pedir(service, { tipoEcf: 'E33', monto: 100, itbis: 18, razon: 'Cargo extra' });
    expect(guardado.monto_total).toBe(118);
    expect(guardado.xml_content).toContain('<CodigoModificacion>3</CodigoModificacion>');
    expect(guardado.xml_content).toContain('<FechaVencimientoSecuencia>');
  });

  test('pide motivo y monto', async () => {
    const { service } = preparar();
    await expect(pedir(service, { tipoEcf: 'E34', monto: 10 })).rejects.toThrow(/motivo/);
    await expect(pedir(service, { tipoEcf: 'E33', razon: 'x' })).rejects.toThrow(/monto/);
  });

  test('a un e-CF sin aceptar no se le hace nota', async () => {
    const { service } = preparar({ original: null });
    await expect(pedir(service, { tipoEcf: 'E34', anular: true, razon: 'x' })).rejects.toThrow(/aceptado/);
  });
});

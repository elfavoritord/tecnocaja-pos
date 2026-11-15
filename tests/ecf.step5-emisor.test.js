'use strict';

const express = require('express');
const request = require('supertest');
const fs = require('fs');

jest.mock('qrcode', () => ({ toDataURL: async () => 'data:image/png;base64,AA==' }));
jest.mock('../modules/ecf/services/ecf.service', () => ({ createEcfService: jest.fn() }));
jest.mock('../modules/ecf/utils/dgii-live-check.util', () => ({ checkQrResolves: jest.fn() }));
jest.mock('../modules/ecf/utils/qr-diagnostic.util', () => ({ recordQrDiagnostic: jest.fn() }));
jest.mock('../modules/ecf/utils/pdf-browser.util', () => ({ launchPdfBrowser: jest.fn() }));

const { createEcfService } = require('../modules/ecf/services/ecf.service');
const { launchPdfBrowser } = require('../modules/ecf/utils/pdf-browser.util');
const { createEcfRouter } = require('../modules/ecf/controllers/router');
const { checkQrResolves } = require('../modules/ecf/utils/dgii-live-check.util');

function xml(tipo, encf, summary = false) {
  const root = summary ? 'RFCE' : 'ECF';
  return `<${root}><Encabezado><IdDoc><TipoeCF>${tipo}</TipoeCF><eNCF>${encf}</eNCF></IdDoc>
    <Emisor><RNCEmisor>133607336</RNCEmisor>
      <RazonSocialEmisor>DOCUMENTOS ELECTRONICOS PRUEBA FACTURA DE CONSUMO MENOR 250MIL</RazonSocialEmisor>
      <NombreComercial>DOCUMENTOS ELECTRONICOS</NombreComercial><FechaEmision>10-11-2026</FechaEmision>
    </Emisor><Totales><MontoTotal>40120.00</MontoTotal></Totales>
    ${summary ? '<CodigoSeguridadeCF>ABCDEF</CodigoSeguridadeCF>' : ''}</Encabezado>
    ${summary ? '' : '<DetallesItems><Item><NumeroLinea>1</NumeroLinea><NombreItem>Cargador</NombreItem><CantidadItem>1</CantidadItem><MontoItem>34000.00</MontoItem></Item></DetallesItems>'}
    <FechaHoraFirma>10-11-2026 20:30:30</FechaHoraFirma><Signature><SignatureValue>ABCDEF123456789</SignatureValue></Signature></${root}>`;
}

describe('Paso 5: empresa emisora en vista previa, PDF y ZIP', () => {
  let app;
  let setContent;
  let getEmitterForXml;
  let rows;

  beforeEach(() => {
    checkQrResolves.mockReset().mockResolvedValue({ indexed: true, valid: true, estado: 'Aceptado' });
    const types = ['31', '32', '32', '33', '34', '41', '43', '44', '45', '46', '47'];
    rows = types.map((tipo, index) => {
      const summary = index === 2;
      const encf = `E${tipo}${String(index + 1).padStart(10, '0')}`;
      return { encf, tipo_ecf: tipo, submission_mode: summary ? 'rfce' : 'normal',
        estado_dgii: 'aceptado', environment: 'certecf', certification_batch_id: 'lote-1',
        signed_xml_content: xml(tipo, encf, summary) };
    });
    const originalRead = fs.readFileSync;
    const originalExists = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((file) =>
      String(file).includes('ecf-originales-locales') || originalExists(file));
    jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) =>
      String(file).includes('ecf-originales-locales') ? xml('32', rows[2].encf) : originalRead(file, ...args));

    getEmitterForXml = jest.fn(async () => ({ rnc: '133607336',
      razon_social: 'SURTIDORA SUAREZ HERRERA SRL', nombre_comercial: 'DOCUMENTOS ELECTRONICOS' }));
    createEcfService.mockReturnValue({ getCurrentActor: async () => ({ id: 1 }), getEmitterForXml });
    setContent = jest.fn(async () => {});
    launchPdfBrowser.mockResolvedValue({ newPage: async () => ({ setContent, pdf: async () => Buffer.from('%PDF-test') }), close: async () => {} });
    const query = async (_sql, params) => params ? rows.filter((row) => row.encf === params[0]) : rows;
    app = express();
    app.use('/api/ecf', createEcfRouter({ query }).router);
  });

  afterEach(() => jest.restoreAllMocks());

  function expectHeader(html) {
    expect(html).toContain('<div class="biz-name">SURTIDORA SUAREZ HERRERA SRL</div>');
    expect(html).toContain('RNC: 133607336');
    expect(html).not.toContain('DOCUMENTOS ELECTRONICOS');
  }

  test.each([['mayor', 1], ['menor', 2]])('la vista previa de consumo %s usa la empresa configurada', async (_label, index) => {
    const response = await request(app).get(`/api/ecf/print/repr-impresa/${rows[index].encf}`);
    expect(response.status).toBe(200);
    expectHeader(response.text);
    expect(getEmitterForXml).toHaveBeenCalledWith(1);
    if (index === 2) {
      expect(response.text).toContain('Cargador');
      expect(response.text).toContain(`e-NCF: ${rows[index].encf}`);
      expect(response.text).toContain('ABCDEF');
    }
  });

  test('la descarga individual de consumo menor aplica el mismo encabezado', async () => {
    const response = await request(app).get(`/api/ecf/print/repr-impresa/${rows[2].encf}/pdf`);
    expect(response.status).toBe(200);
    expectHeader(setContent.mock.calls[0][0]);
  });

  test('los once PDF del ZIP comparten la empresa configurada', async () => {
    const response = await request(app).get('/api/ecf/print/step5-pdf-bundle');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/zip/);
    expect(setContent).toHaveBeenCalledTimes(11);
    for (const [html] of setContent.mock.calls) expectHeader(html);
    expect(setContent.mock.calls[2][0]).toContain('Cargador');
  });

  test.each(['45', '47'])('E%s rechazado en el QR impide preparar el lote aunque la recepción local figure aceptada', async (tipo) => {
    checkQrResolves.mockImplementation(async (url) => url.includes(`ENCF=E${tipo}`)
      ? { indexed: true, valid: false, estado: 'Rechazado' }
      : { indexed: true, valid: true, estado: 'Aceptado' });
    const list = await request(app).get('/api/ecf/print/step5-docs');
    const doc = list.body.docs.find((item) => item.tipo === tipo);
    expect(doc.dgiiVerificado).toBe(false);
    expect(doc.representationReady).toBe(false);
    expect(list.body.complete).toBe(false);
    const bundle = await request(app).get('/api/ecf/print/step5-pdf-bundle');
    expect(bundle.status).toBe(409);
    expect(bundle.body.error).toContain('Rechazado');
  });

  test('selecciona otro E47 aceptado cuando el primer QR aparece rechazado', async () => {
    const original = rows.find((row) => row.tipo_ecf === '47');
    const encf = 'E470000000099';
    rows.push({ ...original, encf, signed_xml_content: xml('47', encf) });
    checkQrResolves.mockImplementation(async (url) => url.includes(`ENCF=${original.encf}`)
      ? { indexed: true, valid: false, estado: 'Rechazado' }
      : { indexed: true, valid: true, estado: 'Aceptado' });
    const list = await request(app).get('/api/ecf/print/step5-docs');
    expect(list.body.docs.find((item) => item.tipo === '47')).toMatchObject({ encf, dgiiVerificado: true, representationReady: true });
  });

  test.each(['45', '47'])('E%s no encontrado en el QR bloquea el ZIP y permite abrir el enlace exacto para diagnóstico', async (tipo) => {
    checkQrResolves.mockImplementation(async (url) => url.includes(`ENCF=E${tipo}`)
      ? { indexed: false, valid: false, estado: null, reason: 'not_found' }
      : { indexed: true, valid: true, estado: 'Aceptado' });
    const list = await request(app).get('/api/ecf/print/step5-docs');
    expect(list.body.docs.find((item) => item.tipo === tipo)).toMatchObject({
      dgiiVerificado: false, representationReady: false, dgiiEstadoPublico: 'No encontrado',
      qrVerificationUrl: expect.stringContaining(`ENCF=E${tipo}`),
    });
    const bundle = await request(app).get('/api/ecf/print/step5-pdf-bundle');
    expect(bundle.status).toBe(409);
    expect(bundle.body.error).toContain('No encontrado');
  });
});

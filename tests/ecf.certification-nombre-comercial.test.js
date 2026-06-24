'use strict';

const { createEcfService } = require('../modules/ecf/services/ecf.service');

function buildService() {
  return createEcfService({
    query: async () => [],
    withTransaction: async (work) => work({ query: async () => [] }),
    resolveRequestActorUser: async () => ({ id: 1 }),
  });
}

function buildDocument(nombreComercialXml, nombreComercialDataset) {
  const nombreComercialTag = nombreComercialXml
    ? `<NombreComercial>${nombreComercialXml}</NombreComercial>`
    : '';
  return {
    encf: 'E410000000001',
    tipo_ecf: 'E41',
    submission_mode: 'normal',
    signed_xml_content: `<?xml version="1.0" encoding="UTF-8"?>
<ECF>
  <Encabezado>
    <IdDoc><TipoeCF>41</TipoeCF><eNCF>E410000000001</eNCF></IdDoc>
    <Emisor>
      <RNCEmisor>40211932609</RNCEmisor>
      <RazonSocialEmisor>DOCUMENTOS ELECTRONICOS DE 02</RazonSocialEmisor>
      ${nombreComercialTag}
      <FechaEmision>01-04-2020</FechaEmision>
    </Emisor>
    <Comprador>
      <RNCComprador>131880681</RNCComprador>
      <RazonSocialComprador>DOCUMENTOS ELECTRONICOS DE 02</RazonSocialComprador>
    </Comprador>
    <Totales><MontoTotal>0.00</MontoTotal></Totales>
  </Encabezado>
</ECF>`,
    _certificationValidationRow: {
      TipoeCF: '41',
      RNCEmisor: '40211932609',
      RazonSocialEmisor: 'DOCUMENTOS ELECTRONICOS DE 02',
      NombreComercial: nombreComercialDataset,
      FechaEmision: '01-04-2020',
      RNCComprador: '131880681',
      RazonSocialComprador: 'DOCUMENTOS ELECTRONICOS DE 02',
      MontoTotal: '0.00',
    },
  };
}

describe('validacion NombreComercial por caso de certificacion', () => {
  test('rechaza localmente un valor cuando el dataset espera campo ausente', () => {
    const result = buildService().validateCertificationDocumentBeforeSend(
      buildDocument('DOCUMENTOS ELECTRONICOS DE 02', '#e')
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/NombreComercial inválido/);
    expect(result.logs.nombreComercialEsperado).toBe('');
  });

  test('acepta el campo ausente cuando el dataset usa #e', () => {
    const result = buildService().validateCertificationDocumentBeforeSend(
      buildDocument('', '#e')
    );

    expect(result.ok).toBe(true);
  });
});

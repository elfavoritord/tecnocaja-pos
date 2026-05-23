'use strict';

const { parseXmlTestCase } = require('../modules/ecf/services/certification-importer');

describe('certification-importer', () => {
  test('parseXmlTestCase extrae metadata básica del XML DGII', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ECF xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Encabezado>
    <IdDoc>
      <TipoeCF>47</TipoeCF>
      <eNCF>E470000000029</eNCF>
      <TipoPago>1</TipoPago>
    </IdDoc>
    <Emisor>
      <RNCEmisor>40211932609</RNCEmisor>
    </Emisor>
    <Comprador>
      <RazonSocialComprador>Consumidor Final</RazonSocialComprador>
    </Comprador>
    <Totales>
      <MontoTotal>3000.00</MontoTotal>
    </Totales>
  </Encabezado>
</ECF>`;

    const result = parseXmlTestCase(xml, 'prueba-e47.xml');

    expect(result.tipoEcf).toBe('E47');
    expect(result.encf).toBe('E470000000029');
    expect(result.totalAmount).toBe(3000);
    expect(result.customerName).toBe('Consumidor Final');
    expect(result.buyerMode).toBe('consumer_final');
    expect(result.rncEmisor).toBe('40211932609');
  });
});

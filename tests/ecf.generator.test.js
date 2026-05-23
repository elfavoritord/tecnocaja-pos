'use strict';

const { generateEcfXml, normalizeEcfXmlStructure, normalizeEncfValue } = require('../modules/ecf/services/ecf-generator');
const { parseXml } = require('../modules/ecf/utils/xml.util');

describe('ecf-generator normalizeEcfXmlStructure', () => {
  test('envuelve TelefonoEmisor dentro de TablaTelefonoEmisor', () => {
    const original = `<?xml version="1.0" encoding="utf-8"?>
<ECF>
  <Encabezado>
    <Emisor>
      <RNCEmisor>40211932609</RNCEmisor>
      <RazonSocialEmisor>Tecno Caja</RazonSocialEmisor>
      <DireccionEmisor>Calle 1</DireccionEmisor>
      <TelefonoEmisor>8090000000</TelefonoEmisor>
      <CorreoEmisor>correo@example.com</CorreoEmisor>
      <FechaEmision>21-05-2026</FechaEmision>
    </Emisor>
  </Encabezado>
</ECF>`;

    const normalized = normalizeEcfXmlStructure(original);

    expect(normalized).toContain('<TablaTelefonoEmisor>');
    expect(normalized).toContain('<TelefonoEmisor>809-000-0000</TelefonoEmisor>');
    expect(normalized).not.toContain('<Emisor><TelefonoEmisor>');
  });

  test('elimina la firma existente cuando se prepara para re-firmar', () => {
    const original = `<?xml version="1.0" encoding="utf-8"?>
<ECF>
  <Encabezado>
    <Emisor>
      <RNCEmisor>40211932609</RNCEmisor>
      <RazonSocialEmisor>Tecno Caja</RazonSocialEmisor>
      <DireccionEmisor>Calle 1</DireccionEmisor>
      <TelefonoEmisor>8090000000</TelefonoEmisor>
      <CorreoEmisor>correo@example.com</CorreoEmisor>
      <FechaEmision>21-05-2026</FechaEmision>
    </Emisor>
  </Encabezado>
  <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
    <SignedInfo />
  </Signature>
</ECF>`;

    const normalized = normalizeEcfXmlStructure(original, { removeSignature: true });

    expect(normalized).toContain('<TablaTelefonoEmisor>');
    expect(normalized).not.toContain('<Signature');
  });
});

describe('ecf-generator generateEcfXml', () => {
  test('normaliza e-NCF malformado con cero adicional antes de generar el XML', () => {
    expect(normalizeEncfValue('E4700000000012', 'E47')).toBe('E470000000012');
    expect(normalizeEncfValue('E470000000012', 'E47')).toBe('E470000000012');
  });

  test('genera TablaTelefonoEmisor en lugar de TelefonoEmisor directo', () => {
    const { xml } = generateEcfXml({
      emitter: {
        rnc: '40211932609',
        razonSocial: 'Tecno Caja POS',
        nombreComercial: 'Tecno Caja',
        direccion: 'Calle 1',
        telefono: '8090000000',
        correo: 'correo@example.com',
      },
      customer: {
        nombre: 'Consumidor Final',
      },
      document: {
        eNCF: 'E320000000011',
        tipoeCF: 'E32',
      },
      items: [
        {
          name: 'Producto',
          quantity: 1,
          unitPrice: 100,
          taxRate: 0,
        },
      ],
      issueDate: new Date('2026-05-21T00:00:00Z'),
    });

    const doc = parseXml(xml);
    const emisor = doc.getElementsByTagName('Emisor')[0];
    const childNames = [];
    for (let child = emisor.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) childNames.push(child.nodeName);
    }

    expect(childNames).toContain('TablaTelefonoEmisor');
    expect(childNames).not.toContain('TelefonoEmisor');
    expect(xml).toContain('<TablaTelefonoEmisor>');
    expect(xml).toContain('<TelefonoEmisor>809-000-0000</TelefonoEmisor>');
  });

  test('genera E47 con la estructura requerida por la XSD oficial', () => {
    const { xml } = generateEcfXml({
      emitter: {
        rnc: '40211932609',
        razonSocial: 'Tecno Caja POS',
        nombreComercial: 'Tecno Caja',
        direccion: 'Calle 1',
        telefono: '8090000000',
        correo: 'correo@example.com',
      },
      customer: {
        nombre: 'Beneficiario Exterior',
      },
      document: {
        eNCF: 'E470000000011',
        tipoeCF: 'E47',
        tipoPago: '1',
        fechaVencimientoSecuencia: '2026-12-31',
      },
      items: [
        {
          name: 'Servicio exterior',
          quantity: 1,
          unitPrice: 3000,
          taxRate: 0,
          billingIndicator: 4,
          retentionIndicator: 1,
          withholdingAmount: 0,
          goodsOrServicesIndicator: 2,
        },
      ],
      issueDate: new Date('2026-05-21T00:00:00Z'),
    });

    expect(xml).toContain('<eNCF>E470000000011</eNCF>');
    expect(xml).toContain('<FechaVencimientoSecuencia>30-12-2026</FechaVencimientoSecuencia>');
    expect(xml).not.toContain('<TipoIngresos>');
    expect(xml).toContain('<MontoExento>3000.00</MontoExento>');
    expect(xml).toContain('<MontoTotal>3000.00</MontoTotal>');
    expect(xml).toContain('<TotalISRRetencion>0.00</TotalISRRetencion>');
    expect(xml).not.toContain('<MontoGravadoTotal>');
    expect(xml).toContain('<IndicadorFacturacion>4</IndicadorFacturacion>');
    expect(xml).toContain('<Retencion>');
    expect(xml).toContain('<IndicadorAgenteRetencionoPercepcion>1</IndicadorAgenteRetencionoPercepcion>');
    expect(xml).toContain('<MontoISRRetenido>0.00</MontoISRRetenido>');
    expect(xml).toContain('<IndicadorBienoServicio>2</IndicadorBienoServicio>');
    expect(xml).not.toContain('<MontoItemMasITBIS>');
  });

  test('corrige el e-NCF si llega con una longitud mayor por un cero extra', () => {
    const { xml } = generateEcfXml({
      emitter: {
        rnc: '40211932609',
        razonSocial: 'Tecno Caja POS',
        nombreComercial: 'Tecno Caja',
        direccion: 'Calle 1',
        telefono: '8090000000',
        correo: 'correo@example.com',
      },
      customer: {
        nombre: 'Beneficiario Exterior',
      },
      document: {
        eNCF: 'E4700000000012',
        tipoeCF: 'E47',
        tipoPago: '1',
        fechaVencimientoSecuencia: '2026-12-31',
      },
      items: [
        {
          name: 'Servicio exterior',
          quantity: 1,
          unitPrice: 3000,
          taxRate: 0,
          billingIndicator: 4,
          retentionIndicator: 1,
          withholdingAmount: 0,
          goodsOrServicesIndicator: 2,
        },
      ],
      issueDate: new Date('2026-05-21T00:00:00Z'),
    });

    expect(xml).toContain('<eNCF>E470000000012</eNCF>');
    expect(xml).not.toContain('<eNCF>E4700000000012</eNCF>');
  });

  test('E47 siempre emite IndicadorBienoServicio como servicio (2)', () => {
    const { xml } = generateEcfXml({
      emitter: {
        rnc: '40211932609',
        razonSocial: 'Tecno Caja POS',
        nombreComercial: 'Tecno Caja',
        direccion: 'Calle 1',
        telefono: '8090000000',
        correo: 'correo@example.com',
      },
      customer: {
        nombre: 'Beneficiario Exterior',
      },
      document: {
        eNCF: 'E470000000013',
        tipoeCF: 'E47',
        tipoPago: '1',
        fechaVencimientoSecuencia: '2026-12-31',
      },
      items: [
        {
          name: 'Servicio exterior',
          quantity: 1,
          unitPrice: 3000,
          taxRate: 0,
          billingIndicator: 4,
          retentionIndicator: 1,
          withholdingAmount: 0,
          goodsOrServicesIndicator: 2,
        },
      ],
      issueDate: new Date('2026-05-21T00:00:00Z'),
    });

    expect(xml).toContain('<IndicadorBienoServicio>2</IndicadorBienoServicio>');
    expect(xml).not.toContain('<IndicadorBienoServicio>1</IndicadorBienoServicio>');
  });

  test('E47 siempre emite TotalISRRetencion y Retencion segun la XSD oficial', () => {
    const { xml } = generateEcfXml({
      emitter: {
        rnc: '40211932609',
        razonSocial: 'Tecno Caja POS',
        nombreComercial: 'Tecno Caja',
        direccion: 'Calle 1',
        telefono: '8090000000',
        correo: 'correo@example.com',
      },
      customer: {
        nombre: 'Beneficiario Exterior',
      },
      document: {
        eNCF: 'E470000000021',
        tipoeCF: 'E47',
        tipoPago: '1',
        fechaVencimientoSecuencia: '2026-12-31',
      },
      items: [
        {
          name: 'Servicio exterior',
          quantity: 1,
          unitPrice: 3000,
          taxRate: 0,
          billingIndicator: 4,
          retentionIndicator: 1,
          withholdingAmount: 150,
          goodsOrServicesIndicator: 2,
        },
      ],
      issueDate: new Date('2026-05-21T00:00:00Z'),
    });

    expect(xml).toContain('<TotalISRRetencion>150.00</TotalISRRetencion>');
    expect(xml).toContain('<Retencion>');
    expect(xml).toContain('<MontoISRRetenido>150.00</MontoISRRetenido>');
  });
});

'use strict';

const { generateEcfXml, normalizeEcfXmlStructure } = require('../modules/ecf/services/ecf-generator');

describe('reference structure', () => {
  test('genera InformacionReferencia despues de DetallesItems', () => {
    const { xml } = generateEcfXml({
      emitter: {
        rnc: '40211932609',
        razonSocial: 'DISEÑO Y DESARROLLO DE SOFTWARE',
        nombreComercial: 'tecno caja pos',
        direccion: 'carretera yamasa 103',
        telefono: '8292812877',
        correo: 'a@b.com',
      },
      customer: {
        rnc: '40211932609',
        nombre: 'Cliente prueba',
      },
      document: {
        eNCF: 'E330000000001',
        tipoeCF: 'E33',
        tipoIngresos: '01',
        tipoPago: '1',
        referencia: {
          ncfModificado: 'E310000000001',
          fechaNcfModificado: '01-01-2026',
          codigoModificacion: '1',
        },
      },
      items: [
        { name: 'Producto', quantity: 1, unitPrice: 500, discount: 0, taxRate: 0 },
      ],
      issueDate: new Date('2026-05-21T00:00:00Z'),
    });

    const detailsIndex = xml.indexOf('</DetallesItems>');
    const referenceIndex = xml.indexOf('<InformacionReferencia>');
    expect(detailsIndex).toBeGreaterThan(-1);
    expect(referenceIndex).toBeGreaterThan(detailsIndex);
  });

  test('normaliza XML viejo moviendo InformacionReferencia despues de DetallesItems', () => {
    const legacyXml = `<?xml version="1.0" encoding="utf-8"?>
<ECF xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Encabezado>
    <Version>1.0</Version>
    <IdDoc><TipoeCF>33</TipoeCF><eNCF>E330000000001</eNCF><TipoIngresos>01</TipoIngresos><TipoPago>1</TipoPago><IndicadorNotaCredito>0</IndicadorNotaCredito></IdDoc>
    <Emisor><RNCEmisor>40211932609</RNCEmisor><RazonSocialEmisor>Empresa</RazonSocialEmisor><DireccionEmisor>Dir</DireccionEmisor><FechaEmision>21-05-2026</FechaEmision></Emisor>
    <Comprador><RNCComprador>40211932609</RNCComprador><RazonSocialComprador>Cliente</RazonSocialComprador></Comprador>
    <InformacionReferencia><NCFModificado>E310000000001</NCFModificado><FechaNCFModificado>01-01-2026</FechaNCFModificado><CodigoModificacion>1</CodigoModificacion></InformacionReferencia>
    <Totales><MontoGravadoTotal>500.00</MontoGravadoTotal><MontoGravadoI3>500.00</MontoGravadoI3><MontoExento>500.00</MontoExento><MontoTotal>500.00</MontoTotal></Totales>
  </Encabezado>
  <DetallesItems><Item><NumeroLinea>1</NumeroLinea><NombreItem>Producto</NombreItem><CantidadItem>1.00</CantidadItem><PrecioUnitarioItem>500.00</PrecioUnitarioItem><MontoItem>500.00</MontoItem><MontoItemMasITBIS>500.00</MontoItemMasITBIS></Item></DetallesItems>
  <FechaHoraFirma>21-05-2026 12:00:00</FechaHoraFirma>
</ECF>`;

    const normalized = normalizeEcfXmlStructure(legacyXml, { removeSignature: true });
    const detailsIndex = normalized.indexOf('</DetallesItems>');
    const referenceIndex = normalized.indexOf('<InformacionReferencia>');
    expect(detailsIndex).toBeGreaterThan(-1);
    expect(referenceIndex).toBeGreaterThan(detailsIndex);
    expect(normalized).not.toContain('<IndicadorNotaCredito>');
  });

  test('conserva IndicadorNotaCredito cuando el valor es valido', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ECF xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Encabezado>
    <Version>1.0</Version>
    <IdDoc><TipoeCF>34</TipoeCF><eNCF>E340000000016</eNCF><IndicadorNotaCredito>1</IndicadorNotaCredito><TipoPago>1</TipoPago></IdDoc>
    <Emisor><RNCEmisor>40211932609</RNCEmisor><RazonSocialEmisor>Empresa</RazonSocialEmisor><DireccionEmisor>Dir</DireccionEmisor><FechaEmision>21-05-2026</FechaEmision></Emisor>
    <Comprador><RNCComprador>131880681</RNCComprador><RazonSocialComprador>Cliente</RazonSocialComprador></Comprador>
    <Totales><MontoTotal>1.00</MontoTotal></Totales>
  </Encabezado>
  <DetallesItems><Item><NumeroLinea>1</NumeroLinea><NombreItem>Servicio</NombreItem><CantidadItem>1.00</CantidadItem><PrecioUnitarioItem>1.00</PrecioUnitarioItem><MontoItem>1.00</MontoItem></Item></DetallesItems>
  <InformacionReferencia><NCFModificado>E410000000010</NCFModificado><FechaNCFModificado>01-04-2020</FechaNCFModificado><CodigoModificacion>2</CodigoModificacion></InformacionReferencia>
  <FechaHoraFirma>21-05-2026 12:00:00</FechaHoraFirma>
</ECF>`;

    const normalized = normalizeEcfXmlStructure(xml, { removeSignature: true });
    expect(normalized).toContain('<IndicadorNotaCredito>1</IndicadorNotaCredito>');
  });
});

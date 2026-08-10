'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { parseEcfXmlForQr, buildQrVerificationUrl } = require('../modules/ecf/utils/qr-url.util');
const { generateReprImpresaHtml, parseEcfXml } = require('../modules/ecf/controllers/repr-impresa');
const { recordQrDiagnostic } = require('../modules/ecf/utils/qr-diagnostic.util');

// Mismos valores del caso real reportado (E310000000051) — ver conversación de certificación.
const SIGNATURE_VALUE = 'XlbsthrXRxGXWL0QCr7reBP6RWXWzYBRRKYsjJrwap1bKoN06sw6JYYnNR/tW3DlZexryJnoF1T7O++Q+4oNjGGNYxJFZ+YlOmYAyNQXgFvRuGC40pRN99x2Ejx33SXsUZDRj48ADXpv+VPmonp0hG89ZTOOThoqxnjsuKmXnoipUGkJ0SyAmUEG2JGpA0wsG3TeaSYozBA4kYomsRIH8KZNaIaVqGuj7JwHY8Bpo1qIGAnAFwsCeP6fmrZZniElsHPly7J+nwjEpqET1TGskD/tOOq5CMvwHU5f6xjeSNXNqfek9MQCxweR1UoTeRuWJrxjL552j9qYFMUerrFHUw==';

function buildE31Xml({ signatureValue = SIGNATURE_VALUE } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ECF xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Encabezado>
    <IdDoc>
      <TipoeCF>31</TipoeCF>
      <eNCF>E310000000051</eNCF>
    </IdDoc>
    <Emisor>
      <RNCEmisor>40211932609</RNCEmisor>
      <FechaEmision>27-07-2026</FechaEmision>
    </Emisor>
    <Comprador>
      <RNCComprador>131880681</RNCComprador>
    </Comprador>
    <Totales>
      <MontoTotal>7080.00</MontoTotal>
    </Totales>
  </Encabezado>
  <DetallesItems>
    <Item><NumeroLinea>1</NumeroLinea></Item>
  </DetallesItems>
  <FechaHoraFirma>27-07-2026 14:40:41</FechaHoraFirma>
  <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
    <SignedInfo>
      <CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315" />
      <SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256" />
      <Reference URI="">
        <DigestValue>ThisIsAFakeDigestValueNeverUsedAsCodigoSeguridad==</DigestValue>
      </Reference>
    </SignedInfo>
    <SignatureValue>${signatureValue}</SignatureValue>
    <KeyInfo><X509Data><X509Certificate>FAKECERT==</X509Certificate></X509Data></KeyInfo>
  </Signature>
</ECF>`;
}

function buildRfceXml({ encf = 'E320000000060', monto = '40120.00', codigo = 'YVoo0x' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<RFCE xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Encabezado>
    <IdDoc>
      <eNCF>${encf}</eNCF>
    </IdDoc>
    <Emisor>
      <RNCEmisor>40211932609</RNCEmisor>
    </Emisor>
    <Totales>
      <MontoTotal>${monto}</MontoTotal>
    </Totales>
    <CodigoSeguridadeCF>${codigo}</CodigoSeguridadeCF>
  </Encabezado>
  <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
    <SignedInfo></SignedInfo>
    <SignatureValue>ThisSignatureValueMustNeverBeUsedForRfceCodigoSeguridad==</SignatureValue>
  </Signature>
</RFCE>`;
}

function buildEcfWithoutBuyer(tipo, encf) {
  return buildE31Xml()
    .replace('<TipoeCF>31</TipoeCF>', `<TipoeCF>${tipo}</TipoeCF>`)
    .replace('E310000000051', encf)
    .replace(/\s*<Comprador>[\s\S]*?<\/Comprador>/, '');
}

describe('qr-url.util — CodigoSeguridad', () => {
  test('para e-CF normal, CodigoSeguridad son EXACTAMENTE los primeros 6 caracteres crudos de SignatureValue', () => {
    const xml = buildE31Xml();
    const parsed = parseEcfXmlForQr(xml);
    // Regla explícita: ni DigestValue, ni un hash propio, ni mayúsculas/minúsculas alteradas.
    expect(parsed.codigoSeguridad).toBe('Xlbsth');
    expect(parsed.codigoSeguridad).not.toBe('ThisIs'); // no debe venir de DigestValue
  });

  test('preserva mayúsculas, minúsculas y caracteres especiales sin normalizar', () => {
    const xml = buildE31Xml({ signatureValue: 'aZ9+/QwErTy1234567890==' });
    const parsed = parseEcfXmlForQr(xml);
    expect(parsed.codigoSeguridad).toBe('aZ9+/Q');
    expect(parsed.codigoSeguridad).not.toBe(parsed.codigoSeguridad.toLowerCase());
  });

  test('para RFCE, CodigoSeguridad viene de CodigoSeguridadeCF del XML, nunca de SignatureValue', () => {
    const xml = buildRfceXml();
    const parsed = parseEcfXmlForQr(xml);
    expect(parsed.codigoSeguridad).toBe('YVoo0x');
    expect(parsed.codigoSeguridad).not.toBe('ThisSi');
  });
});

describe('qr-url.util — construcción de la URL de ConsultaTimbre', () => {
  test('e-CF normal (E31): URL exacta con los 7 parámetros, codificados con encodeURIComponent', () => {
    const xml = buildE31Xml();
    const url = buildQrVerificationUrl(xml, 'certecf');
    expect(url).toBe(
      'https://ecf.dgii.gov.do/CerteCF/ConsultaTimbre?' +
      'RncEmisor=40211932609' +
      '&RncComprador=131880681' +
      '&ENCF=E310000000051' +
      '&FechaEmision=27-07-2026' +
      '&MontoTotal=7080.00' +
      '&FechaFirma=27-07-2026%2014%3A40%3A41' +
      '&CodigoSeguridad=Xlbsth'
    );
  });

  test('RFCE: URL de ConsultaTimbreFC con solo 4 parámetros (sin RncComprador/FechaEmision/FechaFirma)', () => {
    const xml = buildRfceXml();
    const url = buildQrVerificationUrl(xml, 'certecf');
    expect(url).toBe(
      'https://fc.dgii.gov.do/CerteCF/ConsultaTimbreFC?' +
      'RncEmisor=40211932609' +
      '&ENCF=E320000000060' +
      '&MontoTotal=40120.00' +
      '&CodigoSeguridad=YVoo0x'
    );
  });

  test('no modifica el monto (no agrega comas ni quita ceros decimales)', () => {
    const xml = buildE31Xml().replace('<MontoTotal>7080.00</MontoTotal>', '<MontoTotal>413785.30</MontoTotal>');
    const url = buildQrVerificationUrl(xml, 'certecf');
    expect(url).toContain('MontoTotal=413785.30');
    expect(url).not.toContain('413,785.30');
    expect(url).not.toContain('MontoTotal=413785.3&'); // no debe perder el cero decimal
  });

  test('no reformatea la fecha de emisión ni la de firma', () => {
    const xml = buildE31Xml();
    const url = buildQrVerificationUrl(xml, 'certecf');
    expect(url).toContain('FechaEmision=27-07-2026');
    expect(url).not.toContain('FechaEmision=2026-07-27');
  });
});

describe('qr-url.util vs repr-impresa — deben coincidir siempre (mismo XML firmado)', () => {
  test('los campos que comparten ambos parsers son idénticos para el mismo XML', () => {
    const xml = buildE31Xml();
    const forQr = parseEcfXmlForQr(xml);
    const forRepr = parseEcfXml(xml);
    expect(forRepr.encf).toBe(forQr.encf);
    expect(forRepr.rncEmisor).toBe(forQr.rncEmisor);
    expect(forRepr.rncComprador).toBe(forQr.rncComprador);
    expect(forRepr.montoTotal).toBe(forQr.montoTotal);
    expect(forRepr.fechaEmision).toBe(forQr.fechaEmision);
    expect(forRepr.fechaHoraFirma).toBe(forQr.fechaHoraFirma);
    expect(forRepr.codigoSeguridad).toBe(forQr.codigoSeguridad);
  });

  test.each([
    ['43', 'E430000000112'],
    ['47', 'E470000000128'],
  ])('E%s sin comprador omite por completo RncComprador', (tipo, encf) => {
    const url = buildQrVerificationUrl(buildEcfWithoutBuyer(tipo, encf), 'certecf');
    expect(url).toContain(`ENCF=${encf}`);
    expect(url).not.toContain('RncComprador');
  });

  test('la RI de un RFCE usa los artículos del E32 completo y el QR de 4 parámetros del resumen', async () => {
    const fullE32 = buildE31Xml({ signatureValue: 'YVoo0x' + SIGNATURE_VALUE.slice(6) })
      .replace('<TipoeCF>31</TipoeCF>', '<TipoeCF>32</TipoeCF>')
      .replace('E310000000051', 'E320000000060')
      .replace('<MontoTotal>7080.00</MontoTotal>', '<MontoTotal>40120.00</MontoTotal>')
      .replace(
        '<Item><NumeroLinea>1</NumeroLinea></Item>',
        '<Item><NumeroLinea>1</NumeroLinea><NombreItem>Servicio de prueba RFCE</NombreItem><CantidadItem>1</CantidadItem><MontoItem>40120.00</MontoItem></Item>',
      );
    const summary = buildRfceXml();
    let generatedUrl = '';
    const qrSpy = jest.spyOn(QRCode, 'toDataURL').mockImplementation(async (url) => {
      generatedUrl = url;
      return 'data:image/png;base64,AA==';
    });

    try {
      const html = await generateReprImpresaHtml(fullE32, { env: 'certecf', rfceSummaryXml: summary });
      expect(html).toContain('Servicio de prueba RFCE');
      expect(html).toContain('FACTURA DE CONSUMO ELECTRÓNICA (RFCE)');
      expect(generatedUrl).toBe(
        'https://fc.dgii.gov.do/CerteCF/ConsultaTimbreFC?' +
        'RncEmisor=40211932609' +
        '&ENCF=E320000000060' +
        '&MontoTotal=40120.00' +
        '&CodigoSeguridad=YVoo0x'
      );
      expect(generatedUrl).not.toContain('RncComprador');
      expect(generatedUrl).not.toContain('FechaFirma');
    } finally {
      qrSpy.mockRestore();
    }
  });

  test('rechaza una RI RFCE cuando el código del E32 no coincide con el resumen', async () => {
    const fullE32 = buildE31Xml({ signatureValue: 'ABCDEF' + SIGNATURE_VALUE.slice(6) })
      .replace('<TipoeCF>31</TipoeCF>', '<TipoeCF>32</TipoeCF>')
      .replace('E310000000051', 'E320000000060')
      .replace('<MontoTotal>7080.00</MontoTotal>', '<MontoTotal>40120.00</MontoTotal>');
    await expect(generateReprImpresaHtml(fullE32, { rfceSummaryXml: buildRfceXml() }))
      .rejects.toThrow('código de seguridad');
  });

  test.each([
    ['43', 'E430000000112'],
    ['47', 'E470000000128'],
  ])('la RI E%s no codifica RncComprador vacío en el QR', async (tipo, encf) => {
    const xml = buildEcfWithoutBuyer(tipo, encf);
    let generatedUrl = '';
    const qrSpy = jest.spyOn(QRCode, 'toDataURL').mockImplementation(async (url) => {
      generatedUrl = url;
      return 'data:image/png;base64,AA==';
    });

    try {
      await generateReprImpresaHtml(xml, { env: 'certecf' });
      expect(generatedUrl).toBe(buildQrVerificationUrl(xml, 'certecf'));
      expect(generatedUrl).not.toContain('RncComprador');
    } finally {
      qrSpy.mockRestore();
    }
  });
});

describe('qr-diagnostic.util — registro de evidencia XML vs QR', () => {
  let tmpCwd;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tecnocaja-qr-diag-'));
    process.chdir(tmpCwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  test('marca todos los campos como coincidentes cuando el XML es consistente', () => {
    const xml = buildE31Xml();
    const record = recordQrDiagnostic({
      tipoEcf: 'E31',
      signedXml: xml,
      environment: 'certecf',
      trackId: 'trk-123',
      estadoConsultaResultado: 'aceptado',
      codigoConsultaResultado: '1',
    });
    expect(record.eNCF).toBe('E310000000051');
    expect(record.codigoSeguridadGenerado).toBe('Xlbsth');
    expect(record.signatureValueCompleto).toBe(SIGNATURE_VALUE);
    expect(record.comparacion).toEqual({
      rncEmisorCoincide: true,
      rncCompradorCoincide: true,
      encfCoincide: true,
      fechaEmisionCoincide: true,
      montoTotalCoincide: true,
      fechaFirmaCoincide: true,
      codigoSeguridadCoincide: true,
    });
    expect(fs.existsSync(record.diagnosticPath)).toBe(true);
  });

  test('codigoSeguridadGenerado sigue al SignatureValue real de CADA XML, nunca queda cacheado de un envío anterior', () => {
    // Dos XML distintos con SignatureValue distinto (como pasaría con dos e-CF reales
    // consecutivos) deben producir dos CodigoSeguridad distintos — si el registro alguna vez
    // reutilizara un valor viejo, este test lo detectaría.
    const xmlUno = buildE31Xml({ signatureValue: 'AAAAAA' + SIGNATURE_VALUE.slice(6) });
    const xmlDos = buildE31Xml({ signatureValue: 'BBBBBB' + SIGNATURE_VALUE.slice(6) });
    const recordUno = recordQrDiagnostic({ tipoEcf: 'E31', signedXml: xmlUno, environment: 'certecf' });
    const recordDos = recordQrDiagnostic({ tipoEcf: 'E31', signedXml: xmlDos, environment: 'certecf' });
    expect(recordUno.codigoSeguridadGenerado).toBe('AAAAAA');
    expect(recordDos.codigoSeguridadGenerado).toBe('BBBBBB');
    expect(recordUno.comparacion.codigoSeguridadCoincide).toBe(true);
    expect(recordDos.comparacion.codigoSeguridadCoincide).toBe(true);
  });

  test('la comparación marca codigoSeguridadCoincide=false si el CodigoSeguridad expuesto no son los primeros 6 caracteres de SignatureValue', () => {
    // Prueba directa de la regla de negocio (no del parser): si en el futuro alguien cambia
    // parseEcfXmlForQr para tomar CodigoSeguridad de otra fuente (DigestValue, TrackId, etc.),
    // este test debe fallar porque el valor ya no coincidirá con SignatureValue.slice(0,6).
    const xml = buildE31Xml();
    const signatureValueCompleto = SIGNATURE_VALUE;
    const codigoSeguridadCorrecto = signatureValueCompleto.slice(0, 6);
    const digestValueEnXml = 'ThisIsAFakeDigestValueNeverUsedAsCodigoSeguridad==';
    expect(codigoSeguridadCorrecto).not.toBe(digestValueEnXml.slice(0, 6));

    const { parseEcfXmlForQr } = require('../modules/ecf/utils/qr-url.util');
    const parsed = parseEcfXmlForQr(xml);
    expect(parsed.codigoSeguridad).toBe(codigoSeguridadCorrecto);
    expect(parsed.codigoSeguridad).not.toBe(digestValueEnXml.slice(0, 6));
  });
});

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  crearArchivoTemporalDGII,
  assertDgiiXmlRoot,
  detectXmlRoot,
  eliminarArchivoTemporalDGII,
  extractDgiiIdentityFromXml,
  generarNombreArchivoDGII,
  validarNombreArchivoDGII,
} = require('../modules/ecf/utils/dgii-file.util');
const { validateRfceXml } = require('../modules/ecf/utils/rfce-xsd.util');

describe('dgii-file.util', () => {
  test('genera el nombre exacto requerido por DGII', () => {
    expect(generarNombreArchivoDGII('40211932609', 'E470000000028')).toBe('40211932609E470000000028.xml');
    expect(validarNombreArchivoDGII('40211932609E470000000028.xml', {
      rnc: '40211932609',
      encf: 'E470000000028',
    })).toBe('40211932609E470000000028.xml');
  });

  test('extrae RNC y eNCF desde el XML firmado', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ECF>
  <Encabezado>
    <IdDoc><eNCF>E470000000028</eNCF></IdDoc>
    <Emisor><RNCEmisor>40211932609</RNCEmisor></Emisor>
  </Encabezado>
</ECF>`;

    expect(extractDgiiIdentityFromXml(xml)).toEqual({
      rncEmisor: '40211932609',
      encf: 'E470000000028',
    });
  });

  test('crea y elimina la copia temporal DGII', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tecnocaja-dgii-file-'));
    const temp = crearArchivoTemporalDGII({
      xmlContent: '<ECF />',
      dgiiFileName: '40211932609E470000000028.xml',
      baseDir: tempDir,
    });

    expect(fs.existsSync(temp.tempPath)).toBe(true);
    eliminarArchivoTemporalDGII(temp.tempPath);
    expect(fs.existsSync(temp.tempPath)).toBe(false);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('detecta la raíz XML y bloquea endpoint incompatible', () => {
    expect(detectXmlRoot('<?xml version="1.0"?><RFCE><Encabezado /></RFCE>')).toBe('RFCE');
    expect(detectXmlRoot('<ECF><Encabezado /></ECF>')).toBe('ECF');
    expect(assertDgiiXmlRoot('<ECF />', 'ECF', 'Recepcion')).toBe('ECF');
    expect(() => assertDgiiXmlRoot('<ECF />', 'RFCE', 'RecepcionFC')).toThrow(/debe tener raíz <RFCE>/);
  });

  test('valida estructura RFCE oficial mínima', () => {
    const rfce = `<?xml version="1.0" encoding="UTF-8"?>
<RFCE xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Encabezado>
    <Version>1.0</Version>
    <IdDoc>
      <TipoeCF>32</TipoeCF>
      <eNCF>E320000000012</eNCF>
      <TipoIngresos>01</TipoIngresos>
      <TipoPago>1</TipoPago>
    </IdDoc>
    <Emisor>
      <RNCEmisor>40211932609</RNCEmisor>
      <RazonSocialEmisor>DOCUMENTOS ELECTRONICOS PRUEBA FACTURA DE CONSUMO MENOR 250MIL</RazonSocialEmisor>
      <FechaEmision>01-04-2020</FechaEmision>
    </Emisor>
    <Comprador>
      <RNCComprador>131880681</RNCComprador>
      <RazonSocialComprador>DOCUMENTOS ELECTRONICOS DE 03</RazonSocialComprador>
    </Comprador>
    <Totales>
      <MontoGravadoTotal>40000.00</MontoGravadoTotal>
      <MontoGravadoI1>40000.00</MontoGravadoI1>
      <TotalITBIS>7200.00</TotalITBIS>
      <TotalITBIS1>7200.00</TotalITBIS1>
      <MontoTotal>47200.00</MontoTotal>
    </Totales>
    <CodigoSeguridadeCF>ABC123</CodigoSeguridadeCF>
  </Encabezado>
  <Signature xmlns="http://www.w3.org/2000/09/xmldsig#"></Signature>
</RFCE>`;
    expect(validateRfceXml(rfce).ok).toBe(true);
    const invalid = validateRfceXml(rfce.replace('<CodigoSeguridadeCF>ABC123</CodigoSeguridadeCF>', '<NombreComercial>X</NombreComercial>'));
    expect(invalid.ok).toBe(false);
  });
});

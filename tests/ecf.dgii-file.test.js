'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  crearArchivoTemporalDGII,
  eliminarArchivoTemporalDGII,
  extractDgiiIdentityFromXml,
  generarNombreArchivoDGII,
  validarNombreArchivoDGII,
} = require('../modules/ecf/utils/dgii-file.util');

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
});

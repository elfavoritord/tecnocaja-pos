'use strict';

const XLSX = require('xlsx');
const { buildTransmissionFromSpreadsheetRow, importTestSet, parseTestSetBuffer } = require('../modules/ecf/services/test-set-importer');

describe('ecf test-set importer', () => {
  test('parsea archivos CSV del set DGII', () => {
    const buffer = Buffer.from(
      'Caso,ENCF,Fecha Vencimiento,Monto Gravado,TipoPago,TipoIngresos\n' +
      'Caso 1,E310000000001,20-05-2027,1,01,01\n',
      'utf8'
    );

    const cases = parseTestSetBuffer(buffer, 'set.csv');
    expect(cases).toHaveLength(1);
    expect(cases[0].encf).toBe('E310000000001');
    expect(cases[0].tipoEcf).toBe('E31');
    expect(cases[0].fechaVencimiento).toBe('2027-05-20');
  });

  test('importa set XLSX y crea documentos listos para homologacion', async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([
      {
        Caso: 'Caso 2',
        ENCF: 'E320000000001',
        'Fecha Vencimiento': '20-05-2027',
        'Monto Gravado': 1,
        TipoPago: '01',
        TipoIngresos: '01',
      },
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'DGII');
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

    const repository = {
      withTransaction: jest.fn(async (work) => work({ query: jest.fn() })),
      ensureSequenceCoverage: jest.fn(async (_conn, _businessId, payload) => ({
        id: 5,
        tipo_comprobante: payload.tipoComprobante,
      })),
      saveImportedDocument: jest.fn(async (_conn, _businessId, payload) => ({
        documentId: 17,
        updated: false,
        payload,
      })),
    };

    const result = await importTestSet({
      repository,
      businessId: 1,
      buffer,
      filename: 'set.xlsx',
      emitter: {
        rnc: '101010101',
        razon_social: 'Tecno Caja SRL',
        nombre_comercial: 'Tecno Caja',
        direccion: 'Santo Domingo',
        telefono: '8090000000',
        correo: 'facturas@tecnocaja.do',
      },
      environment: 'testecf',
      certificateContext: null,
      userId: 99,
    });

    expect(result.total).toBe(1);
    expect(result.ok).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.hasCert).toBe(false);
    expect(result.results[0].submissionMode).toBe('rfce');
    expect(repository.ensureSequenceCoverage).toHaveBeenCalledTimes(1);
    expect(repository.saveImportedDocument).toHaveBeenCalledTimes(1);
  });

  test('genera E34 de certificacion usando los valores exactos del set DGII', () => {
    const transmission = buildTransmissionFromSpreadsheetRow({
      testCase: {
        encf: 'E340000000016',
        tipoEcf: 'E34',
        rawRow: {
          Version: '1.0',
          TipoeCF: '34',
          ENCF: 'E340000000016',
          IndicadorNotaCredito: '1',
          TipoPago: '1',
          TipoIngresos: '#e',
          RNCEmisor: '40211932609',
          RazonSocialEmisor: 'DOCUMENTOS ELECTRONICOS DE 02',
          DireccionEmisor: 'DOCUMENTOS ELECTRONICOS DE 02',
          CorreoEmisor: '#e',
          FechaEmision: '01-12-2020',
          RNCComprador: '131880681',
          RazonSocialComprador: 'DOCUMENTOS ELECTRONICOS DE 02',
          TelefonoAdicional: '#e',
          DireccionComprador: '#e',
          MontoTotal: '0.00',
          MontoNoFacturable: '1.00',
          'NumeroLinea[1]': '1',
          'IndicadorFacturacion[1]': '0',
          'NombreItem[1]': 'Servicio Profesional Legislativo Actualizado',
          'IndicadorBienoServicio[1]': '2',
          'CantidadItem[1]': '1.00',
          'PrecioUnitarioItem[1]': '1.00',
          'MontoItem[1]': '1.00',
          NCFModificado: 'E410000000010',
          FechaNCFModificado: '01-04-2020',
          CodigoModificacion: '2',
        },
        sourceSheet: 'ECF',
      },
      issueDate: new Date('2026-05-21T00:00:00Z'),
    });

    expect(transmission.submissionMode).toBe('normal');
    expect(transmission.xml).toContain('<IndicadorNotaCredito>1</IndicadorNotaCredito>');
    expect(transmission.xml).not.toContain('<TipoIngresos>');
    expect(transmission.xml).not.toContain('<TelefonoComprador>');
    expect(transmission.xml).toContain('<RazonSocialEmisor>DOCUMENTOS ELECTRONICOS DE 02</RazonSocialEmisor>');
    expect(transmission.xml).toContain('<MontoNoFacturable>1.00</MontoNoFacturable>');
    expect(transmission.xml).toContain('<NombreItem>Servicio Profesional Legislativo Actualizado</NombreItem>');
    expect(transmission.xml).toContain('<NCFModificado>E410000000010</NCFModificado>');
  });

  test('genera RFCE desde la hoja RFCE del set DGII', () => {
    const transmission = buildTransmissionFromSpreadsheetRow({
      testCase: {
        encf: 'E320000000011',
        tipoEcf: 'E32',
        sourceSheet: 'RFCE',
        submissionMode: 'rfce',
        rawRow: {
          Version: '1.0',
          TipoeCF: '32',
          ENCF: 'E320000000011',
          TipoIngresos: '01',
          TipoPago: '1',
          RNCEmisor: '40211932609',
          RazonSocialEmisor: 'DOCUMENTOS ELECTRONICOS PRUEBA FACTURA DE CONSUMO MENOR 250MIL',
          FechaEmision: '01-04-2020',
          RNCComprador: '131880681',
          RazonSocialComprador: 'DOCUMENTOS ELECTRONICOS DE 03',
          MontoGravadoTotal: '34000.00',
          MontoGravadoI1: '34000.00',
          TotalITBIS: '6120.00',
          TotalITBIS1: '6120.00',
          MontoTotal: '40120.00',
        },
      },
      issueDate: new Date('2026-05-21T00:00:00Z'),
    });

    expect(transmission.submissionMode).toBe('rfce');
    expect(transmission.xml).toContain('<RFCE');
    expect(transmission.xml).toContain('<eNCF>E320000000011</eNCF>');
    expect(transmission.xml).toContain('<MontoTotal>40120.00</MontoTotal>');
  });

  test('preserva la razon social del set DGII al reconstruir RFCE', () => {
    const transmission = buildTransmissionFromSpreadsheetRow({
      testCase: {
        encf: 'E320000000012',
        tipoEcf: 'E32',
        sourceSheet: 'RFCE',
        submissionMode: 'rfce',
        rawRow: {
          Version: '1.0',
          TipoeCF: '32',
          ENCF: 'E320000000012',
          TipoIngresos: '01',
          TipoPago: '1',
          RNCEmisor: '40211932609',
          RazonSocialEmisor: 'DOCUMENTOS ELECTRONICOS PRUEBA FACTURA DE CONSUMO MENOR 250MIL',
          FechaEmision: '01-04-2020',
          MontoGravadoTotal: '40000.00',
          MontoGravadoI1: '40000.00',
          TotalITBIS: '7200.00',
          TotalITBIS1: '7200.00',
          MontoTotal: '47200.00',
        },
      },
      emitter: {
        rnc: '40211932609',
        razonSocial: 'EMILIO MANAURYS CABRERA',
        nombreComercial: '',
      },
      issueDate: new Date('2026-05-21T00:00:00Z'),
    });

    expect(transmission.xml).toContain('<RazonSocialEmisor>DOCUMENTOS ELECTRONICOS PRUEBA FACTURA DE CONSUMO MENOR 250MIL</RazonSocialEmisor>');
    expect(transmission.xml).not.toContain('EMILIO MANAURYS CABRERA');
  });

  test('no sobrescribe el emisor del set aunque se soliciten overrides locales', () => {
    const transmission = buildTransmissionFromSpreadsheetRow({
      testCase: {
        encf: 'E320000000015',
        tipoEcf: 'E32',
        sourceSheet: 'RFCE',
        submissionMode: 'rfce',
        rawRow: {
          Version: '1.0',
          TipoeCF: '32',
          ENCF: 'E320000000015',
          TipoIngresos: '01',
          TipoPago: '1',
          RNCEmisor: '40211932609',
          RazonSocialEmisor: 'DOCUMENTOS ELECTRONICOS PRUEBA FACTURA DE CONSUMO MENOR 250MIL',
          FechaEmision: '01-04-2020',
          MontoGravadoTotal: '40000.00',
          MontoGravadoI1: '40000.00',
          TotalITBIS: '7200.00',
          TotalITBIS1: '7200.00',
          MontoTotal: '47200.00',
        },
      },
      emitter: {
        rnc: '40211932609',
        razonSocial: 'EMILIO MANURYS CABRERA',
        nombreComercial: 'DOCUMENTOS ELECTRONICOS',
      },
      overrideEmitterFromConfig: true,
      issueDate: new Date('2026-05-21T00:00:00Z'),
    });

    expect(transmission.xml).toContain('<RazonSocialEmisor>DOCUMENTOS ELECTRONICOS PRUEBA FACTURA DE CONSUMO MENOR 250MIL</RazonSocialEmisor>');
    expect(transmission.xml).not.toContain('EMILIO MANURYS CABRERA');
    expect(transmission.xml).not.toContain('<NombreComercial>');
  });

  test('omite NombreComercial vacio y respeta TotalITBIS1 del dataset DGII', () => {
    const transmission = buildTransmissionFromSpreadsheetRow({
      testCase: {
        encf: 'E310000000002',
        tipoEcf: 'E31',
        sourceSheet: 'ECF',
        rawRow: {
          Version: '1.0',
          TipoeCF: '31',
          ENCF: 'E310000000002',
          TipoIngresos: '01',
          TipoPago: '1',
          RNCEmisor: '40211932609',
          RazonSocialEmisor: 'DOCUMENTOS ELECTRONICOS DE 02',
          NombreComercial: '',
          FechaEmision: '01-04-2020',
          RNCComprador: '131880681',
          RazonSocialComprador: 'DOCUMENTOS ELECTRONICOS DE 03',
          MontoGravadoTotal: '3230.00',
          MontoGravadoI1: '3230.00',
          ITBIS1: '18',
          TotalITBIS: '713.04',
          TotalITBIS1: '713.04',
          MontoTotal: '3943.04',
          'NumeroLinea[1]': '1',
          'IndicadorFacturacion[1]': '1',
          'NombreItem[1]': 'Producto con total DGII',
          'CantidadItem[1]': '1',
          'PrecioUnitarioItem[1]': '3230.00',
          'MontoItem[1]': '3230.00',
        },
      },
      issueDate: new Date('2026-05-21T00:00:00Z'),
    });

    expect(transmission.xml).not.toContain('<NombreComercial>');
    expect(transmission.xml).toContain('<TotalITBIS>713.04</TotalITBIS>');
    expect(transmission.xml).toContain('<TotalITBIS1>713.04</TotalITBIS1>');
  });

  test('calcula TotalITBIS1 solo si el dataset no lo trae', () => {
    const transmission = buildTransmissionFromSpreadsheetRow({
      testCase: {
        encf: 'E320000000012',
        tipoEcf: 'E32',
        sourceSheet: 'ECF',
        rawRow: {
          Version: '1.0',
          TipoeCF: '32',
          ENCF: 'E320000000012',
          RNCEmisor: '40211932609',
          RazonSocialEmisor: 'DOCUMENTOS ELECTRONICOS PRUEBA FACTURA DE CONSUMO MENOR 250MIL',
          NombreComercial: '',
          MontoGravadoTotal: '40000.00',
          MontoGravadoI1: '40000.00',
          ITBIS1: '18',
          MontoTotal: '47200.00',
        },
      },
      issueDate: new Date('2026-05-21T00:00:00Z'),
    });

    expect(transmission.xml).toContain('<TotalITBIS>7200.00</TotalITBIS>');
    expect(transmission.xml).toContain('<TotalITBIS1>7200.00</TotalITBIS1>');
  });
});

'use strict';

jest.mock('../server/fiscal/ecfXmlService', () => ({
  buildEcfJsonFromSale: jest.fn(() => ({ ECF: { Encabezado: { IdDoc: { eNCF: 'E3100000000001', TipoeCF: '31' } } } })),
  validateEcfStructure: jest.fn(() => ({ valid: true, errors: [] })),
  convertJsonToXml: jest.fn(() => '<ECF><Encabezado /></ECF>'),
  saveXmlFiles: jest.fn(async () => ({
    xmlPath: 'C:\\dgii\\1\\test\\2026\\05\\E3100000000001.xml',
    signedXmlPath: 'C:\\dgii\\1\\test\\2026\\05\\E3100000000001.signed.xml'
  })),
  generateSecurityCodeFromSignedXml: jest.fn(() => 'ABC123'),
  generateQrDataUrl: jest.fn(async () => ({
    qrUrl: 'https://ecf.dgii.gov.do/testecf/ConsultaTimbre?RNC=101234567&eNCF=E3100000000001&Codigo=ABC123',
    qrDataUrl: 'data:image/png;base64,AAA'
  }))
}));

jest.mock('../server/fiscal/ncfSequenceService', () => ({
  reserveNextENCF: jest.fn(async () => ({ encf: 'E3100000000001', sequenceId: 9, proximo: 1 })),
  preventDuplicateENCF: jest.fn(async () => {}),
  selectEcfType: jest.fn(() => 'E31')
}));

jest.mock('../server/fiscal/fiscalModeService', () => ({
  validateCanIssueEcf: jest.fn(async () => ({ canIssue: true }))
}));

jest.mock('../server/fiscal/ecfSenderService', () => ({
  sendElectronicDocument: jest.fn(async () => ({ ok: true, estado: 'aceptado', mensaje: 'Aceptado' }))
}));

jest.mock('../server/fiscal/ecfSigningService', () => ({
  signXmlWithBusinessCertificate: jest.fn(async () => ({
    signedXml: '<ECF><SignatureValue>ABCDEF123456</SignatureValue></ECF>',
    securityCode: 'ABC123'
  }))
}));

jest.mock('../server/fiscal/fiscalExtensions', () => ({
  writeFiscalAuditLog: jest.fn(async () => {})
}));

const xmlSvc = require('../server/fiscal/ecfXmlService');
const seqSvc = require('../server/fiscal/ncfSequenceService');
const senderSvc = require('../server/fiscal/ecfSenderService');

const createEcfSaleFlowService = require('../server/fiscal/ecfSaleFlowService');

function buildServiceContext(overrides = {}) {
  const topLevelState = {
    existingSale: overrides.existingSale || {
      id: 77,
      sale_status: 'pagada',
      es_electronica: 1,
      ecf_document_id: null,
      ecf_estado: null,
      branch_id: 2,
      cash_register_id: 5,
      ncf_type: 'B01',
      ncf: null,
      client_tax_id_snapshot: '101998877',
      total: 1180
    },
    documentSummary: overrides.documentSummary || {
      id: 41,
      sale_id: 77,
      encf: 'E3100000000001',
      tipo_ecf: 'E31',
      estado_dgii: 'aceptado',
      codigo_seguridad: 'ABC123',
      rnc_emisor: '101234567',
      track_id: 'TRK-001',
      ambiente: 'test',
      invoice_number: 'FAC-00000077'
    }
  };

  const query = jest.fn(async (sql, params = []) => {
    if (sql.includes('SELECT s.id, s.sale_status, s.es_electronica, s.ecf_document_id')) {
      return [topLevelState.existingSale];
    }
    if (sql.includes('SELECT s.id, s.sale_status, s.client_tax_id_snapshot')) {
      return [{
        id: 77,
        sale_status: 'pagada',
        client_tax_id_snapshot: '101998877',
        ncf_type: 'B01',
        client_id: 10,
        client_rnc: '101998877',
        is_active: 1,
        environment: 'test'
      }];
    }
    if (sql.includes('SELECT d.*, s.invoice_number')) {
      return [topLevelState.documentSummary];
    }
    if (sql.startsWith('UPDATE ecf_documents')) {
      return { rowsAffected: 1 };
    }
    if (sql.startsWith('UPDATE sales')) {
      return { rowsAffected: 1 };
    }
    return [];
  });

  const connQuery = jest.fn(async (sql, params = []) => {
    if (sql.includes('SELECT s.*,') && sql.includes('FROM sales s')) {
      return [{
        id: 77,
        invoice_number: 'FAC-00000077',
        sale_status: 'pagada',
        branch_id: 2,
        cash_register_id: 5,
        client_id: 10,
        client_tax_id_snapshot: '101998877',
        client_rnc: '101998877',
        client_cedula: '00112345678',
        client_razon_social: 'Cliente Demo SRL',
        client_name_snapshot: 'Cliente Demo',
        client_name: 'Cliente Demo',
        delivery_address_snapshot: 'Santo Domingo',
        subtotal: 1000,
        discount: 0,
        tax: 180,
        total: 1180,
        payment_method: 'efectivo',
        created_at: '2026-05-16 10:00:00',
        fecha_emision_fiscal: '2026-05-16 10:00:00',
        business_id: 1,
        business_row_id: 1,
        business_nombre: 'Tecno Caja POS',
        business_razon_social: 'Tecno Caja POS SRL',
        business_nombre_comercial: 'Tecno Caja',
        business_rnc: '101234567',
        business_direccion: 'Santo Domingo',
        business_telefono: '8090000000',
        business_correo: 'demo@tecnocaja.do',
        branch_name: 'Principal',
        cash_register_name: 'Caja 1',
        fiscal_environment: 'test',
        fiscal_payload: null,
        ncf_referencia: null,
        razon_social_cliente: 'Cliente Demo SRL',
        ncf_type: 'B01'
      }];
    }
    if (sql.includes('FROM sale_items si')) {
      return [{
        id: 1,
        product_id: 90,
        qty: 2,
        price: 500,
        discount_rate: 0,
        tax_rate: 18,
        product_name: 'Laptop Demo',
        codigo: 'LP-01'
      }];
    }
    if (sql.includes('SELECT fecha_vencimiento FROM fiscal_sequences')) {
      return [{ fecha_vencimiento: '2026-12-31' }];
    }
    if (sql.includes('INSERT INTO ecf_documents')) {
      return { insertId: 41, rowsAffected: 1 };
    }
    if (sql.startsWith('UPDATE sales')) {
      return { rowsAffected: 1 };
    }
    return [];
  });

  const withTransaction = jest.fn(async (handler) => handler({ query: connQuery }));

  return {
    service: createEcfSaleFlowService({ query, withTransaction }),
    query,
    connQuery,
    withTransaction
  };
}

describe('ecfSaleFlowService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('prepara, firma y envía un e-CF desde una venta pagada', async () => {
    const { service, connQuery } = buildServiceContext();

    const result = await service.processSaleForElectronicInvoicing(77, {
      userId: 12,
      ipAddress: '127.0.0.1'
    });

    expect(result.skipped).toBe(false);
    expect(result.documentId).toBe(41);
    expect(result.encf).toBe('E3100000000001');
    expect(result.tipoEcf).toBe('E31');
    expect(result.sendResult.estado).toBe('aceptado');
    expect(seqSvc.reserveNextENCF).toHaveBeenCalled();
    expect(xmlSvc.buildEcfJsonFromSale).toHaveBeenCalled();
    expect(senderSvc.sendElectronicDocument).toHaveBeenCalledWith(expect.any(Function), 41);

    const insertCall = connQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO ecf_documents'));
    expect(insertCall).toBeDefined();
    expect(insertCall[1][0]).toBe(1);
    expect(insertCall[1][6]).toBe('E3100000000001');
    expect(insertCall[1][23]).toBe('ecf');

    const saleUpdateCall = connQuery.mock.calls.find(([sql]) => sql.includes('document_type = \'comprobante-fiscal\''));
    expect(saleUpdateCall).toBeDefined();
  });

  test('reintenta un documento existente sin recrearlo', async () => {
    const { service, withTransaction } = buildServiceContext({
      existingSale: {
        id: 77,
        sale_status: 'pagada',
        es_electronica: 1,
        ecf_document_id: 41,
        ecf_estado: 'pendiente',
        branch_id: 2,
        cash_register_id: 5,
        ncf_type: 'B01',
        ncf: 'E3100000000001',
        client_tax_id_snapshot: '101998877',
        total: 1180
      }
    });

    const result = await service.processSaleForElectronicInvoicing(77);

    expect(result.retriedExistingDocument).toBe(true);
    expect(result.documentId).toBe(41);
    expect(senderSvc.sendElectronicDocument).toHaveBeenCalledWith(expect.any(Function), 41);
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

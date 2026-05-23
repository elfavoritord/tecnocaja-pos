'use strict';

const xmlSvc = require('./ecfXmlService');
const seqSvc = require('./ncfSequenceService');
const modeSvc = require('./fiscalModeService');
const senderSvc = require('./ecfSenderService');
const { signXmlWithBusinessCertificate } = require('./ecfSigningService');
const { writeFiscalAuditLog } = require('./fiscalExtensions');
const { normalizeEnvironment } = require('./dgiiEndpointService');

function createEcfSaleFlowService(deps) {
  const {
    query,
    withTransaction
  } = deps || {};

  if (typeof query !== 'function' || typeof withTransaction !== 'function') {
    throw new Error('createEcfSaleFlowService requiere query y withTransaction.');
  }

  async function processSaleForElectronicInvoicing(saleId, options = {}) {
    if (!saleId) throw new Error('saleId es obligatorio para emitir e-CF.');

    const existingRows = await query(
      `SELECT s.id, s.sale_status, s.es_electronica, s.ecf_document_id, s.ecf_estado, s.branch_id,
              s.cash_register_id, s.ncf_type, s.ncf, s.client_tax_id_snapshot, s.total
       FROM sales s
       WHERE s.id = ? LIMIT 1`,
      [saleId]
    );
    const existingSale = existingRows[0];
    if (!existingSale) throw Object.assign(new Error('La venta no existe.'), { statusCode: 404 });

    if (existingSale.ecf_document_id) {
      const resend = await senderSvc.sendElectronicDocument(query, Number(existingSale.ecf_document_id));
      const refreshed = await getDocumentSummary(Number(existingSale.ecf_document_id));
      return {
        skipped: false,
        retriedExistingDocument: true,
        saleId: Number(saleId),
        documentId: Number(existingSale.ecf_document_id),
        sendResult: resend,
        document: refreshed
      };
    }

    const state = await resolveSaleFiscalContext(saleId);
    if (!state.shouldIssue) {
      return {
        skipped: true,
        saleId: Number(saleId),
        reason: state.reason
      };
    }

    const prepared = await withTransaction(async (conn) => {
      const sale = await loadSaleAggregate(conn.query, saleId);
      const validation = await modeSvc.validateCanIssueEcf(conn.query, sale.businessId);
      if (!validation.canIssue) {
        return {
          skipped: true,
          saleId: Number(saleId),
          reason: validation.reason
        };
      }

      const tipoEcf = determineElectronicDocumentType(sale);
      const legacyNcfType = determineLegacyNcfType(sale, tipoEcf);
      const customer = buildCustomerSnapshot(sale);
      const business = sale.business;
      const environment = normalizeEnvironment(sale.environment || 'test');

      validatePreparedSaleData(sale, { business, customer, tipoEcf });

      const reservation = await seqSvc.reserveNextENCF(conn, {
        businessId: sale.businessId,
        branchId: sale.sale.branch_id,
        cashRegisterId: sale.sale.cash_register_id,
        tipoComprobante: tipoEcf
      });
      await seqSvc.preventDuplicateENCF(conn.query, sale.businessId, reservation.encf);

      const sequenceRows = await conn.query(
        'SELECT fecha_vencimiento FROM fiscal_sequences WHERE id = ? LIMIT 1',
        [reservation.sequenceId]
      );
      const sequence = sequenceRows[0] || {};

      const xmlJson = xmlSvc.buildEcfJsonFromSale({
        sale: {
          total: sale.sale.total,
          subtotal: sale.sale.subtotal,
          descuento: sale.sale.discount,
          discount: sale.sale.discount,
          payment_method: sale.sale.payment_method,
          branch_name: sale.branchName,
          sale_status: sale.sale.sale_status
        },
        items: sale.items.map(normalizeSaleItemForEcf),
        business,
        customer,
        sequence: { fechaVencimiento: sequence.fecha_vencimiento || null },
        tipoEcf,
        encf: reservation.encf,
        ambiente: environment
      });

      const validationResult = xmlSvc.validateEcfStructure(xmlJson);
      if (!validationResult.valid) {
        throw Object.assign(
          new Error(`El e-CF generado no pasó la validación mínima: ${validationResult.errors.join(' | ')}`),
          { statusCode: 422 }
        );
      }

      const xmlOriginal = xmlSvc.convertJsonToXml(xmlJson);
      const signed = await signXmlWithBusinessCertificate(conn.query, sale.businessId, xmlOriginal);
      const securityCode = signed.securityCode || xmlSvc.generateSecurityCodeFromSignedXml(signed.signedXml);
      const archive = await xmlSvc.saveXmlFiles(
        reservation.encf,
        xmlOriginal,
        signed.signedXml,
        sale.businessId,
        {
          environment,
          date: sale.sale.fecha_emision_fiscal || sale.sale.created_at || new Date()
        }
      );

      const submissionMode = tipoEcf === 'E32' && Number(sale.sale.total || 0) < Number(process.env.DGII_RFCE_THRESHOLD_DOP || 250000)
        ? 'rfce'
        : 'ecf';

      const insertResult = await conn.query(
        `INSERT INTO ecf_documents
           (business_id, branch_id, cash_register_id, sale_id, customer_id, tipo_ecf, encf,
            rnc_emisor, rnc_comprador, nombre_comprador, monto_total, itbis_total,
            fecha_emision, fecha_firma, codigo_seguridad, qr_url, xml_path, signed_xml_path,
            xml_content, signed_xml_content, estado_dgii, mensajes_dgii, ambiente, is_sent,
            retry_count, encf_referencia, submission_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, CURRENT_TIMESTAMP)`,
        [
          sale.businessId,
          sale.sale.branch_id || null,
          sale.sale.cash_register_id || null,
          sale.sale.id,
          sale.sale.client_id || null,
          tipoEcf,
          reservation.encf,
          business.rnc || null,
          customer.rnc || null,
          customer.razon_social || customer.nombre || 'CONSUMIDOR FINAL',
          Number(sale.sale.total || 0),
          Number(sale.sale.tax || 0),
          sale.sale.fecha_emision_fiscal || sale.sale.created_at || new Date().toISOString(),
          securityCode || null,
          null,
          archive.xmlPath,
          archive.signedXmlPath,
          xmlOriginal,
          signed.signedXml,
          'pendiente',
          submissionMode === 'rfce'
            ? 'TODO profesional: implementar RFCE firmado para E32 menores a RD$250,000.'
            : 'Documento generado y firmado localmente. Pendiente de envío.',
          environment,
          sale.sale.ncf_referencia || null,
          submissionMode
        ]
      );

      const documentId = Number(insertResult.insertId || 0);
      const fiscalPayload = buildUpdatedFiscalPayload(sale.sale.fiscal_payload, {
        numero: reservation.encf,
        tipo: `${tipoEcf} - ${describeEcfType(tipoEcf)}`,
        estado: 'pendiente',
        cliente: customer.razon_social || customer.nombre || sale.sale.client_name_snapshot || 'Consumidor Final',
        clienteRncCedula: customer.rnc || customer.cedula || sale.sale.client_tax_id_snapshot || '',
        total: Number(sale.sale.total || 0),
        itbis: Number(sale.sale.tax || 0),
        fecha: sale.sale.fecha_emision_fiscal || sale.sale.created_at || new Date().toISOString(),
        codigoSeguridad: securityCode,
        rncEmisor: business.rnc || '',
        tipoEcf,
        encf: reservation.encf,
        ecfEstado: 'pendiente',
        ecfTrackId: null,
        ecfXmlPath: archive.signedXmlPath,
        ecfSubmissionMode: submissionMode
      });

      await conn.query(
        `UPDATE sales
         SET ncf = ?,
             ncf_type = ?,
             encf = ?,
             tipo_ecf = ?,
             ecf_document_id = ?,
             ecf_estado = 'pendiente',
             ecf_track_id = NULL,
             es_electronica = 1,
             document_type = 'comprobante-fiscal',
             fiscal_payload = ?,
             qr_data = NULL
         WHERE id = ?`,
        [
          reservation.encf,
          legacyNcfType,
          reservation.encf,
          tipoEcf,
          documentId,
          JSON.stringify(fiscalPayload),
          sale.sale.id
        ]
      );

      await writeFiscalAuditLog(conn.query, {
        businessId: sale.businessId,
        userId: options.userId || null,
        action: 'ecf_generado_desde_venta',
        description: `Venta ${sale.sale.invoice_number} preparada para e-CF ${reservation.encf} (${tipoEcf}).`,
        ipAddress: options.ipAddress || null
      }).catch(() => {});

      return {
        skipped: false,
        saleId: Number(sale.sale.id),
        documentId,
        encf: reservation.encf,
        tipoEcf,
        legacyNcfType,
        businessId: sale.businessId,
        environment,
        securityCode,
        submissionMode
      };
    });

    if (prepared.skipped) {
      return prepared;
    }

    let sendResult;
    try {
      sendResult = await senderSvc.sendElectronicDocument(query, prepared.documentId);
    } catch (error) {
      await query(
        `UPDATE ecf_documents
         SET estado_dgii = 'error',
             mensajes_dgii = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [String(error.message || 'Error inesperado al enviar a DGII.').slice(0, 500), prepared.documentId]
      ).catch(() => {});
      await query(
        `UPDATE sales
         SET ecf_estado = 'error'
         WHERE id = ?`,
        [saleId]
      ).catch(() => {});
      sendResult = {
        ok: false,
        estado: 'error',
        mensaje: error.message
      };
    }

    const summary = await getDocumentSummary(prepared.documentId);
    await finalizeQrIfApplicable(summary);

    return {
      ...prepared,
      sendResult,
      document: await getDocumentSummary(prepared.documentId)
    };
  }

  async function resolveSaleFiscalContext(saleId) {
    const rows = await query(
      `SELECT s.id, s.sale_status, s.client_tax_id_snapshot, s.ncf_type, s.client_id,
              c.rnc AS client_rnc, fc.is_active, fc.environment
       FROM sales s
       LEFT JOIN clients c ON c.id = s.client_id
       LEFT JOIN config cfg ON cfg.id = 1
       LEFT JOIN fiscal_config fc ON fc.business_id = cfg.business_id
       WHERE s.id = ? LIMIT 1`,
      [saleId]
    );
    const row = rows[0];
    if (!row) return { shouldIssue: false, reason: 'La venta no existe.' };
    if (!row.is_active) return { shouldIssue: false, reason: 'La facturación electrónica está desactivada para la empresa.' };
    if (!['pagada', 'pendiente_cobro'].includes(String(row.sale_status || '').trim().toLowerCase())) {
      return { shouldIssue: false, reason: 'La venta todavía no está en estado emitible para e-CF.' };
    }
    return { shouldIssue: true, reason: null };
  }

  async function getDocumentSummary(documentId) {
    const rows = await query(
      `SELECT d.*, s.invoice_number
       FROM ecf_documents d
       LEFT JOIN sales s ON s.id = d.sale_id
       WHERE d.id = ? LIMIT 1`,
      [documentId]
    );
    return rows[0] || null;
  }

  async function finalizeQrIfApplicable(document) {
    if (!document) return null;
    if (!['aceptado', 'aceptado_condicional'].includes(String(document.estado_dgii || '').trim().toLowerCase())) {
      return null;
    }
    if (!document.codigo_seguridad || !document.rnc_emisor || !document.encf) {
      return null;
    }

    const qr = await xmlSvc.generateQrDataUrl(
      document.rnc_emisor,
      document.encf,
      document.codigo_seguridad,
      normalizeEnvironment(document.ambiente || 'test')
    );

    await query(
      `UPDATE ecf_documents
       SET qr_url = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [qr.qrUrl, document.id]
    ).catch(() => {});
    await query(
      `UPDATE sales
       SET qr_data = ?,
           ecf_estado = ?
       WHERE id = ?`,
      [qr.qrUrl, document.estado_dgii, document.sale_id]
    ).catch(() => {});

    return qr;
  }

  return {
    processSaleForElectronicInvoicing,
    resolveSaleFiscalContext,
    finalizeQrIfApplicable
  };
}

async function loadSaleAggregate(queryFn, saleId) {
  const saleRows = await queryFn(
    `SELECT s.*,
            cfg.business_id,
            b.nombre AS branch_name,
            cr.nombre AS cash_register_name,
            c.nombre AS client_name,
            c.telefono AS client_phone,
            c.rnc AS client_rnc,
            c.cedula AS client_cedula,
            c.razon_social AS client_razon_social,
            biz.id AS business_row_id,
            biz.nombre AS business_nombre,
            biz.razon_social AS business_razon_social,
            biz.nombre_comercial AS business_nombre_comercial,
            biz.rnc AS business_rnc,
            biz.direccion AS business_direccion,
            biz.telefono AS business_telefono,
            biz.correo AS business_correo,
            fc.environment AS fiscal_environment
     FROM sales s
     LEFT JOIN config cfg ON cfg.id = 1
     LEFT JOIN clients c ON c.id = s.client_id
     LEFT JOIN branches b ON b.id = s.branch_id
     LEFT JOIN cash_registers cr ON cr.id = s.cash_register_id
     LEFT JOIN businesses biz ON biz.id = cfg.business_id
     LEFT JOIN fiscal_config fc ON fc.business_id = cfg.business_id
     WHERE s.id = ? LIMIT 1`,
    [saleId]
  );
  const sale = saleRows[0];
  if (!sale) throw Object.assign(new Error('Venta no encontrada.'), { statusCode: 404 });

  const items = await queryFn(
    `SELECT si.*, p.codigo, p.nombre AS product_name, p.tipo_producto
     FROM sale_items si
     LEFT JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ?
     ORDER BY si.id ASC`,
    [saleId]
  );

  return {
    sale,
    items,
    businessId: Number(sale.business_id || sale.business_row_id || 1) || 1,
    branchName: sale.branch_name || '',
    cashRegisterName: sale.cash_register_name || '',
    environment: sale.fiscal_environment || 'test',
    business: {
      id: Number(sale.business_row_id || sale.business_id || 1) || 1,
      nombre: sale.business_nombre || '',
      razon_social: sale.business_razon_social || sale.business_nombre || '',
      nombre_comercial: sale.business_nombre_comercial || sale.business_nombre || '',
      rnc: sale.business_rnc || '',
      direccion: sale.business_direccion || '',
      telefono: sale.business_telefono || '',
      correo: sale.business_correo || ''
    }
  };
}

function determineElectronicDocumentType(aggregate) {
  const legacy = String(aggregate.sale.ncf_type || '').trim().toUpperCase();
  if (legacy === 'B03') return 'E33';
  if (legacy === 'B04') return 'E34';
  if (legacy === 'B14') return 'E44';
  if (legacy === 'B15') return 'E45';
  if (legacy === 'B01') return 'E31';
  if (legacy === 'B02') return 'E32';

  return seqSvc.selectEcfType({
    clientRnc: aggregate.sale.client_rnc || aggregate.sale.client_tax_id_snapshot || '',
    isDebitNote: false,
    isCreditNote: false,
    isReturn: false,
    isPurchase: false
  });
}

function determineLegacyNcfType(aggregate, tipoEcf) {
  const current = String(aggregate.sale.ncf_type || '').trim().toUpperCase();
  if (current) return current;
  if (tipoEcf === 'E31') return 'B01';
  if (tipoEcf === 'E32') return 'B02';
  if (tipoEcf === 'E33') return 'B03';
  if (tipoEcf === 'E34') return 'B04';
  if (tipoEcf === 'E44') return 'B14';
  if (tipoEcf === 'E45') return 'B15';
  return current || null;
}

function buildCustomerSnapshot(aggregate) {
  const taxIdSnapshot = String(aggregate.sale.client_tax_id_snapshot || '').trim();
  const clientRnc = String(aggregate.sale.client_rnc || '').trim();
  const clientCedula = String(aggregate.sale.client_cedula || taxIdSnapshot || '').trim();
  const reason = String(aggregate.sale.client_razon_social || aggregate.sale.razon_social_cliente || '').trim();
  const name = String(aggregate.sale.client_name_snapshot || aggregate.sale.client_name || 'Consumidor Final').trim();

  return {
    rnc: clientRnc || (taxIdSnapshot.length >= 9 ? taxIdSnapshot : ''),
    cedula: clientCedula,
    nombre: name,
    razon_social: reason || name,
    direccion: aggregate.sale.delivery_address_snapshot || null
  };
}

function normalizeSaleItemForEcf(item) {
  return {
    codigo: item.codigo || null,
    nombre: item.product_name || 'Producto',
    cantidad: Number(item.qty || 0),
    precio_unitario: Number(item.price || 0),
    descuento: Number(item.discount_rate || 0),
    itbis: Number(item.tax_rate || 0)
  };
}

function buildUpdatedFiscalPayload(rawPayload, updates) {
  let current = {};
  try {
    current = rawPayload ? JSON.parse(rawPayload) : {};
  } catch (_) {
    current = {};
  }
  return { ...current, ...updates };
}

function validatePreparedSaleData(aggregate, { business, customer, tipoEcf }) {
  const errors = [];
  const items = Array.isArray(aggregate.items) ? aggregate.items : [];
  const total = Number(aggregate.sale?.total || 0);

  if (!String(business?.rnc || '').trim()) {
    errors.push('La empresa no tiene RNC configurado para emitir e-CF.');
  }
  if (!String(business?.razon_social || business?.nombre || '').trim()) {
    errors.push('La empresa no tiene razón social configurada.');
  }
  if (!items.length) {
    errors.push('La venta no tiene items para emitir.');
  }
  if (!(total > 0)) {
    errors.push('El total de la venta debe ser mayor que 0.');
  }

  items.forEach((item, index) => {
    const line = index + 1;
    if (!(Number(item.qty || 0) > 0)) {
      errors.push(`El item ${line} tiene cantidad inválida.`);
    }
    if (!(Number(item.price || 0) >= 0)) {
      errors.push(`El item ${line} tiene precio inválido.`);
    }
    if (!String(item.product_name || item.nombre || '').trim()) {
      errors.push(`El item ${line} no tiene descripción.`);
    }
  });

  if (tipoEcf === 'E31' && !String(customer?.rnc || '').trim()) {
    errors.push('El e-CF fiscal E31 requiere RNC del cliente.');
  }
  if (['E33', 'E34'].includes(tipoEcf) && !String(aggregate.sale?.ncf_referencia || '').trim()) {
    errors.push(`El documento ${tipoEcf} requiere un NCF/e-NCF de referencia.`);
  }

  if (errors.length) {
    throw Object.assign(
      new Error(`La venta no cumple los requisitos mínimos para generar e-CF: ${errors.join(' | ')}`),
      { statusCode: 422 }
    );
  }
}

function describeEcfType(tipoEcf) {
  const labels = {
    E31: 'Crédito Fiscal',
    E32: 'Consumidor Final',
    E33: 'Nota de Débito',
    E34: 'Nota de Crédito',
    E41: 'Compras',
    E43: 'Gastos Menores',
    E44: 'Regímenes Especiales',
    E45: 'Gubernamental',
    E46: 'Exportaciones',
    E47: 'Pagos al Exterior'
  };
  return labels[tipoEcf] || tipoEcf;
}

module.exports = createEcfSaleFlowService;

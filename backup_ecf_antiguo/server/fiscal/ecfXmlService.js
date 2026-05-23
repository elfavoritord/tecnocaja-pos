// ══════════════════════════════════════════════════════════════════════════════
//  ecfXmlService.js  —  Tecno Caja e-CF / DGII
//  Construcción, validación y firma digital de documentos XML e-CF
//  conforme al esquema oficial de la DGII (República Dominicana).
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const crypto  = require('crypto');
const forge   = require('node-forge');
const builder = require('xmlbuilder');
const QRCode  = require('qrcode');
const path    = require('path');
const fs      = require('fs');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

// ── Constantes ────────────────────────────────────────────────────────────────
const ECF_VERSION = '1.0';
const DGII_QR_BASE = {
  test:          'https://ecf.dgii.gov.do/testecf/ConsultaTimbre',
  certificacion: 'https://ecf.dgii.gov.do/CertificacioneCF/ConsultaTimbre',
  produccion:    'https://ecf.dgii.gov.do/ecf/ConsultaTimbre'
};

/**
 * Construye el objeto JSON del e-CF a partir de una venta del POS.
 * Normaliza y mapea los datos al formato requerido por la DGII.
 */
function buildEcfJsonFromSale({ sale, items, business, customer, sequence, tipoEcf, encf, ambiente }) {
  const now        = new Date();
  const fechaHora  = formatDGIIDate(now);
  const totalITBIS = calcITBIS(items);
  const totalVenta = Number(sale.total || 0);

  return {
    ECF: {
      Encabezado: {
        Version:     ECF_VERSION,
        IdDoc: {
          TipoeCF:    tipoEcf.replace('E', ''),
          eNCF:       encf,
          FechaVencimientoSecuencia: sequence?.fechaVencimiento || null,
          IndicadorMontoGravado: 1,
          TipoIngresos: '01',
          TipoPago: mapPaymentType(sale.payment_method || sale.metodo_pago || 'efectivo'),
          FechaLimitePago: null,
          TotalPaginas: 1
        },
        Emisor: {
          RNCEmisor:           business.rnc,
          RazonSocialEmisor:   business.razon_social || business.nombre,
          NombreComercial:     business.nombre_comercial || business.nombre,
          Sucursal:            sale.branch_name || null,
          DireccionEmisor:     business.direccion,
          FechaEmision:        fechaHora,
          CodigoVendedor:      null,
          NombreVendedor:      null
        },
        Comprador: buildComprador(customer, tipoEcf),
        Totales: buildTotales(items, totalVenta, totalITBIS, tipoEcf),
        OtraInformacion: {
          FechaHoraEmision: now.toISOString()
        }
      },
      DetallesItems: {
        Item: items.map((item, idx) => buildItem(item, idx + 1))
      },
      SubTotalesInformacion: buildSubTotales(items, totalITBIS),
      DescuentosRecargos:    buildDescuentos(sale),
      Paginacion: {
        Pagina: {
          PaginaItems:   items.length,
          TotalItemsPagina: items.length,
          SubtotalMontoImponible: sumImponible(items),
          SubtotalITBIS1:         totalITBIS,
          SubtotalExento:         sumExento(items),
          SubtotalMonto:          totalVenta
        }
      }
    }
  };
}

/**
 * Convierte el objeto JSON e-CF a XML.
 */
function convertJsonToXml(ecfJson) {
  const root = builder.begin({ encoding: 'UTF-8', standalone: true });
  jsonToXmlNode(root, ecfJson);
  return root.end({ pretty: true });
}

function jsonToXmlNode(parent, obj) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      const node = parent.ele(key);
      jsonToXmlNode(node, value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        const node = parent.ele(key);
        if (typeof item === 'object') jsonToXmlNode(node, item);
        else node.txt(String(item));
      }
    } else {
      parent.ele(key).txt(String(value));
    }
  }
}

/**
 * Firma el XML con el certificado digital del negocio.
 * Usa XML Digital Signature (XMLDSig) según requerimientos DGII.
 *
 * Proceso XMLDSig correcto (conforme a lo que valida DGII):
 *   1. DigestValue  = SHA-256(C14N(documento sin <Signature>))
 *      C14N elimina la declaración <?xml?> antes de hashear.
 *   2. SignedInfo   = XML con DigestValue + transforms c14n explícito
 *   3. SignatureValue = RSA-SHA256-PKCS1v15(C14N(<SignedInfo>))
 */
function signXml(xmlString, forgeCert, forgePrivateKey) {
  const xmlDoc = parseXmlDocument(xmlString);
  const digestInput = canonicalizeNode(xmlDoc.documentElement, { excludeSignature: true });
  const digestMd = forge.md.sha256.create();
  digestMd.update(digestInput, 'utf8');
  const digestB64 = forge.util.encode64(digestMd.digest().getBytes());

  const signedInfoTemplate =
    '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">' +
    '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>' +
    '<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>' +
    '<Reference URI="">' +
    '<Transforms>' +
    '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>' +
    '</Transforms>' +
    '<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>' +
    `<DigestValue>${digestB64}</DigestValue>` +
    '</Reference>' +
    '</SignedInfo>';
  const signedInfoXml = canonicalizeNode(parseXmlDocument(signedInfoTemplate).documentElement);

  const signMd = forge.md.sha256.create();
  signMd.update(signedInfoXml, 'utf8');
  const signatureB64 = forge.util.encode64(forgePrivateKey.sign(signMd));

  const certPem = forge.pki.certificateToPem(forgeCert);
  const certB64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----\n?/, '')
    .replace(/-----END CERTIFICATE-----\n?/, '')
    .replace(/\n/g, '');

  const signatureDoc = parseXmlDocument(
    '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">' +
      signedInfoXml +
      `<SignatureValue>${signatureB64}</SignatureValue>` +
      `<KeyInfo><X509Data><X509Certificate>${certB64}</X509Certificate></X509Data></KeyInfo>` +
    '</Signature>'
  );
  xmlDoc.documentElement.appendChild(xmlDoc.importNode(signatureDoc.documentElement, true));

  const serializer = new XMLSerializer();
  const serialized = serializer.serializeToString(xmlDoc)
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, '');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
}

/**
 * Genera el código de seguridad (timbre) del e-CF.
 * Basado en RNC emisor + e-NCF + fecha + monto.
 */
function generateSecurityCode(rncEmisor, encf, fechaEmision, montoTotal) {
  const raw  = `${rncEmisor}${encf}${fechaEmision}${Number(montoTotal).toFixed(2)}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return hash.slice(0, 10).toUpperCase();
}

function extractSignatureValue(xmlString) {
  const match = String(xmlString || '').match(/<SignatureValue>([\s\S]*?)<\/SignatureValue>/i);
  return match?.[1] ? match[1].replace(/\s+/g, '') : '';
}

function generateSecurityCodeFromSignedXml(xmlString, length = 6) {
  const signatureValue = extractSignatureValue(xmlString);
  if (!signatureValue) return '';
  const hash = crypto.createHash('sha256').update(signatureValue, 'utf8').digest('hex').toUpperCase();
  return hash.slice(0, Math.max(1, Number(length) || 6));
}

/**
 * Genera la URL del QR para el timbre DGII.
 */
async function generateQrDataUrl(rncEmisor, encf, codigoSeguridad, ambiente = 'test') {
  const base  = DGII_QR_BASE[ambiente] || DGII_QR_BASE.test;
  const qrUrl = `${base}?RNC=${rncEmisor}&eNCF=${encf}&Codigo=${codigoSeguridad}`;
  const dataUrl = await QRCode.toDataURL(qrUrl, { width: 200, margin: 1 });
  return { qrUrl, qrDataUrl: dataUrl };
}

/**
 * Valida la estructura básica del e-CF JSON antes de convertir.
 */
function validateEcfStructure(ecfJson) {
  const errors = [];
  const enc    = ecfJson?.ECF?.Encabezado;
  if (!enc) { errors.push('Falta ECF.Encabezado'); return { valid: false, errors }; }
  if (!enc.IdDoc?.eNCF)        errors.push('Falta eNCF');
  if (!enc.IdDoc?.TipoeCF)     errors.push('Falta TipoeCF');
  if (!enc.Emisor?.RNCEmisor)  errors.push('Falta RNCEmisor');
  if (!enc.Emisor?.RazonSocialEmisor) errors.push('Falta RazonSocialEmisor');
  if (!enc.Emisor?.FechaEmision)      errors.push('Falta FechaEmision');
  if (!enc.Totales?.MontoGravadoTotal && enc.Totales?.MontoGravadoTotal !== 0) {
    errors.push('Falta MontoGravadoTotal');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Guarda los archivos XML en disco (si está configurada la ruta).
 */
async function saveXmlFiles(encf, xmlOriginal, xmlFirmado, businessId, options = {}) {
  const baseDir = process.env.FISCAL_XML_DIR
    || path.join(process.env.TECNO_CAJA_USER_DATA || '', 'fiscal', 'xml');
  const date = options.date instanceof Date
    ? options.date
    : (options.date ? new Date(options.date) : new Date());
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = String(safeDate.getFullYear());
  const month = String(safeDate.getMonth() + 1).padStart(2, '0');
  const environment = String(options.environment || 'test').trim().toLowerCase();

  const dir = path.join(baseDir, String(businessId), environment, year, month);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const xmlPath       = path.join(dir, `${encf}.xml`);
  const signedXmlPath = path.join(dir, `${encf}.signed.xml`);

  fs.writeFileSync(xmlPath, xmlOriginal, 'utf8');
  fs.writeFileSync(signedXmlPath, xmlFirmado, 'utf8');

  return { xmlPath, signedXmlPath };
}

// ── Helpers internos ─────────────────────────────────────────────────────────

function formatDGIIDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mapPaymentType(method) {
  const map = {
    efectivo: '01', tarjeta: '02', credito: '03', transferencia: '04',
    cheque: '05', mixto: '06', permuta: '07', credito_por_consumo: '08'
  };
  return map[String(method || '').toLowerCase()] || '01';
}

function buildComprador(customer, tipoEcf) {
  if (tipoEcf === 'E32' && !customer?.rnc) {
    return {
      RNCComprador: null,
      NombreComprador: 'CONSUMIDOR FINAL'
    };
  }
  return {
    RNCComprador:    customer?.rnc || null,
    NombreComprador: customer?.razon_social || customer?.nombre || 'CONSUMIDOR FINAL',
    DireccionComprador: customer?.direccion || null
  };
}

function buildTotales(items, totalVenta, totalITBIS, tipoEcf) {
  const totalImponible = items
    .filter((item) => Number(getItemTaxRate(item)) > 0)
    .reduce((sum, item) => sum + getItemNetSubtotal(item), 0);
  const totalExento = items
    .filter((item) => Number(getItemTaxRate(item)) <= 0)
    .reduce((sum, item) => sum + getItemNetSubtotal(item), 0);
  return {
    MontoGravadoTotal:    round2(totalImponible),
    MontoGravadoI1:       round2(totalImponible),
    MontoExento:          round2(totalExento),
    ITBIS1:               round2(totalITBIS),
    TotalITBISRetenido:   0,
    MontoTotal:           round2(totalVenta),
    MontoNoFacturable:    0,
    MontoPeriodo:         round2(totalVenta),
    SaldoAnterior:        0,
    MontoAvancesPagos:    0,
    ValorPagar:           round2(totalVenta)
  };
}

function buildItem(item, lineNum) {
  const qty   = Number(item.cantidad || item.qty || 1);
  const price = Number(item.precio_unitario || item.price || 0);
  const desc  = Number(item.descuento ?? item.discount ?? item.discount_rate ?? 0) || 0;
  const subtotal = getItemNetSubtotal(item);
  const taxRate  = getItemTaxRate(item);

  return {
    NumeroLinea:          lineNum,
    TablaSubDescuento:    null,
    TablaDescuentoRecargo: null,
    CodigoProducto:       item.codigo || item.product_code || null,
    CodigoProductoISO:    null,
    Descripcion:          item.nombre || item.product_name || item.description || 'Producto',
    IndicadorFacturacion: taxRate > 0 ? 1 : 2,
    Cantidad:             round4(qty),
    UnidadMedida:         1,
    TablaIndicadorBienesOServicios: '1',
    PrecioUnitarioItemOriginal:     round2(price),
    TablaDescuentos:                null,
    PrecioUnitarioItem:             round2(price * (1 - Number(desc) / 100)),
    DescuentoMonto:                 round2(price * qty * Number(desc) / 100),
    SubtotalItem:                   subtotal,
    TablaRegalos:                   null,
    OtraMonedaDetalle:              null,
    TablaImpuestosAdicionales:      null,
    MontoItem:                      subtotal
  };
}

function buildSubTotales(items, totalITBIS) {
  const imponible = items
    .filter((item) => Number(getItemTaxRate(item)) > 0)
    .reduce((sum, item) => sum + getItemNetSubtotal(item), 0);
  const exento = items
    .filter((item) => Number(getItemTaxRate(item)) <= 0)
    .reduce((sum, item) => sum + getItemNetSubtotal(item), 0);
  return {
    SubtotalMontoImponible: round2(imponible),
    SubtotalITBIS1:         round2(totalITBIS),
    SubtotalExento:         round2(exento)
  };
}

function buildDescuentos(sale) {
  if (!sale.descuento && !sale.discount) return null;
  return {
    Descuento: {
      TipoAjuste: '01',
      DescripcionAjuste: 'Descuento',
      PorcentajeAjuste: null,
      MontoAjuste: round2(Number(sale.descuento || sale.discount || 0))
    }
  };
}

function calcITBIS(items) {
  return items.reduce((sum, item) => {
    const taxRate = getItemTaxRate(item);
    if (!taxRate) return sum;
    const subtotal = getItemNetSubtotal(item);
    return sum + subtotal * (taxRate / 100);
  }, 0);
}

function sumImponible(items) {
  return round2(items
    .filter((item) => Number(getItemTaxRate(item)) > 0)
    .reduce((sum, item) => sum + getItemNetSubtotal(item), 0));
}

function sumExento(items) {
  return round2(items
    .filter((item) => Number(getItemTaxRate(item)) <= 0)
    .reduce((sum, item) => sum + getItemNetSubtotal(item), 0));
}

function getItemTaxRate(item) {
  const taxRate = Number(item.itbis ?? item.tax_rate ?? item.taxRate ?? 0);
  return Number.isFinite(taxRate) ? taxRate : 0;
}

function getItemNetSubtotal(item) {
  const qty = Number(item.cantidad || item.qty || 1);
  const price = Number(item.precio_unitario || item.price || 0);
  const discountRate = Number(item.descuento ?? item.discount ?? item.discount_rate ?? 0) || 0;
  const gross = qty * price;
  return round2(gross - (gross * discountRate / 100));
}

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function round4(n) { return Math.round(Number(n || 0) * 10000) / 10000; }

function parseXmlDocument(xmlString) {
  const parser = new DOMParser({
    errorHandler: {
      warning: function() {},
      error: function(message) { throw new Error(`XML inválido: ${message}`); },
      fatalError: function(message) { throw new Error(`XML inválido: ${message}`); }
    }
  });
  const doc = parser.parseFromString(String(xmlString || ''), 'text/xml');
  if (!doc?.documentElement) {
    throw new Error('No se pudo parsear el XML a firmar.');
  }
  return doc;
}

function canonicalizeNode(node, options = {}) {
  if (!node) return '';

  switch (node.nodeType) {
    case 9: // DOCUMENT_NODE
      return canonicalizeNode(node.documentElement, options);
    case 1: { // ELEMENT_NODE
      if (options.excludeSignature && isSignatureElement(node)) return '';
      const attrs = [];
      for (let i = 0; i < node.attributes.length; i += 1) {
        attrs.push(node.attributes.item(i));
      }
      attrs.sort(compareCanonicalAttributes);

      let xml = `<${node.nodeName}`;
      for (const attr of attrs) {
        xml += ` ${attr.nodeName}="${escapeAttributeValue(attr.nodeValue)}"`;
      }
      xml += '>';

      for (let child = node.firstChild; child; child = child.nextSibling) {
        xml += canonicalizeNode(child, options);
      }

      xml += `</${node.nodeName}>`;
      return xml;
    }
    case 3: // TEXT_NODE
    case 4: // CDATA_SECTION_NODE
      return escapeTextValue(node.data);
    case 7: { // PROCESSING_INSTRUCTION_NODE
      const data = String(node.data || '').trim();
      return data ? `<?${node.target} ${data}?>` : `<?${node.target}?>`;
    }
    case 8: // COMMENT_NODE
      return '';
    default:
      return '';
  }
}

function isSignatureElement(node) {
  return node?.nodeType === 1
    && String(node.localName || node.nodeName || '').toLowerCase() === 'signature'
    && String(node.namespaceURI || 'http://www.w3.org/2000/09/xmldsig#') === 'http://www.w3.org/2000/09/xmldsig#';
}

function compareCanonicalAttributes(left, right) {
  const leftIsNs = isNamespaceAttribute(left);
  const rightIsNs = isNamespaceAttribute(right);
  if (leftIsNs !== rightIsNs) return leftIsNs ? -1 : 1;

  const leftName = leftIsNs ? namespaceAttributeSortKey(left) : String(left.nodeName || '');
  const rightName = rightIsNs ? namespaceAttributeSortKey(right) : String(right.nodeName || '');
  return leftName.localeCompare(rightName);
}

function isNamespaceAttribute(attr) {
  const name = String(attr?.nodeName || '');
  return name === 'xmlns' || name.startsWith('xmlns:');
}

function namespaceAttributeSortKey(attr) {
  const name = String(attr?.nodeName || '');
  return name === 'xmlns' ? '' : name.slice('xmlns:'.length);
}

function escapeAttributeValue(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

function escapeTextValue(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;');
}

module.exports = {
  buildEcfJsonFromSale,
  convertJsonToXml,
  signXml,
  generateSecurityCode,
  generateSecurityCodeFromSignedXml,
  generateQrDataUrl,
  validateEcfStructure,
  saveXmlFiles,
  extractSignatureValue,
  _internals: {
    parseXmlDocument,
    canonicalizeNode
  }
};

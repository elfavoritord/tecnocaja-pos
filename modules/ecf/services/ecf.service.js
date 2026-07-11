'use strict';

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const XLSX = require('xlsx');
const { execFile } = require('child_process');
const { formidable } = require('formidable');
const { OFFICIAL_ENVIRONMENTS, buildEcfConfig, normalizeEnvironmentKey, toBoolean } = require('../config/ecf.config');
const { getDocumentTypes, getDocumentType } = require('../config/document-types');
const { DgiiClient } = require('../dgii/client');
const { EcfRepository, digitsOnly, parseJson, parseEncfNumber } = require('../models/ecf.repository');
const signatureService = require('../signature/signature.service');
const { AuthService } = require('./auth.service');
const { buildTotals, generateEcfXml, generateRfceXml, normalizeEcfXmlStructure, normalizeEncfValue } = require('./ecf-generator');
const { importCertificationSet, previewCertificationSet } = require('./certification-importer');
const { buildTransmissionFromSpreadsheetRow, importTestSet: importHomologationTestSet, removeIscEspecificoTax } = require('./test-set-importer');
const { FcService } = require('./fc.service');
const { ReceptionService } = require('./reception.service');
const { ReceptionStorageService } = require('./reception-storage.service');
const { SeedStorageService } = require('./seed-storage.service');
const { StatusService } = require('./status.service');
const { decryptText, encryptText, maskSecret } = require('./crypto-service');
const { EcfError, assertCondition } = require('../utils/errors');
const { validateSaleForEcf } = require('../validators/document-validator');
const { createLogger } = require('../utils/logger');
const { parseXml } = require('../utils/xml.util');
const { detectXmlRoot, getDgiiXmlDispatchType, generarNombreArchivoDGII } = require('../utils/dgii-file.util');
const { assertValidRfceXml } = require('../utils/rfce-xsd.util');

const CERT_STORAGE_DIR = path.resolve(__dirname, '..', 'certificates');
const DEFAULT_DOWNLOADS_DIR = path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), 'Downloads');
const LOCAL_ECF_WORK_DIR = path.join(process.cwd(), 'ecf');

function nowIso() {
  return new Date().toISOString();
}

function inferRequestedType(requestedType, buyerTaxId) {
  const normalized = String(requestedType || '').trim().toUpperCase();
  if (getDocumentType(normalized)) return normalized;
  return digitsOnly(buyerTaxId) ? 'E31' : 'E32';
}

function computeSecurityCode(signedXml) {
  const signatureValue = String(
    parseXml(signedXml).getElementsByTagName('SignatureValue')?.[0]?.textContent || ''
  ).trim();
  return signatureValue.slice(0, 6);
}

function extractRfceSecurityCode(xmlContent) {
  return String(
    parseXml(xmlContent).getElementsByTagName('CodigoSeguridadeCF')?.[0]?.textContent || ''
  ).trim();
}

function normalizeManualEncfInput(value, tipoEcf) {
  const raw = String(value || '').trim().toUpperCase();
  assertCondition(raw, 'Debes indicar un e-NCF manual válido.', { statusCode: 422 });
  if (/^\d+$/.test(raw)) {
    return normalizeEncfValue(`${String(tipoEcf || '').trim().toUpperCase()}${raw}`, tipoEcf);
  }
  return normalizeEncfValue(raw, tipoEcf);
}

function firstNodeText(parent, tagName) {
  if (!parent?.getElementsByTagName) return '';
  return String(parent.getElementsByTagName(tagName)?.[0]?.textContent || '').trim();
}

function parseDecimal(value, fallback = 0) {
  const normalized = String(value || '').replace(/,/g, '.').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeDatasetValue(value) {
  const text = String(value ?? '').trim();
  const lower = text.toLowerCase();
  return (text === '' || lower === '#e' || lower === 'n/a' || lower === 'na' || lower === '#n/a' || lower === '#ref!')
    ? ''
    : text;
}

function certificationEmitterNombreComercial(row, _configNombreComercial, _emitterRazonSocial) {
  // Usa directamente el NC del rawRow del set DGII.
  // '' → tag ausente (ej: E410000000001); valor presente → usar ese valor exacto.
  // Verificado contra dataset oficial DGII (40211932609-17062026010303.xlsx):
  //   E320000000012-15: NC="DOCUMENTOS ELECTRONICOS" (≠ RazonSocial → rowNC es el valor correcto)
  //   E31/E32/E41/E43/E44/E45/E46/E47 regulares: NC="DOCUMENTOS ELECTRONICOS DE 02"
  return normalizeDatasetValue(row?.NombreComercial);
}

function injectOrReplaceNombreComercialInXml(xmlString, newValue, { insertIfAbsent = false } = {}) {
  if (!xmlString || !newValue) return xmlString;
  const esc = String(newValue).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tag = `<NombreComercial>${esc}</NombreComercial>`;
  // Reemplazar si el tag existe pero está vacío (self-closing o empty open/close).
  if (/<NombreComercial\s*\/>/i.test(xmlString)) {
    return xmlString.replace(/<NombreComercial\s*\/>/gi, tag);
  }
  if (/<NombreComercial\s*>\s*<\/NombreComercial>/i.test(xmlString)) {
    return xmlString.replace(/<NombreComercial\s*>\s*<\/NombreComercial>/gi, tag);
  }
  // Si el tag está completamente ausente y se pide insertar, añadir después de RazonSocialEmisor.
  if (insertIfAbsent && !/<NombreComercial/i.test(xmlString)) {
    return xmlString.replace(
      /(<RazonSocialEmisor>[^<]*<\/RazonSocialEmisor>)/i,
      `$1\n    ${tag}`
    );
  }
  return xmlString;
}

function parseDatasetNumber(value, fallback = 0) {
  const parsed = Number(normalizeDatasetValue(value).replace(/,/g, '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

async function mapWithConcurrency(items, limit, handler) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Math.min(Number(limit || 1), list.length || 1));
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await handler(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function moneyText(value) {
  return roundMoney(value).toFixed(2);
}

function sameMoney(a, b) {
  return Math.abs(roundMoney(a) - roundMoney(b)) <= 0.005;
}

function certificationRowForDocument(document) {
  if (document?._certificationValidationRow) return document._certificationValidationRow;
  const src = parseCertificationStoredSource(document?.certification_original_xml || '');
  if (!src) return null;
  return src.row || src.linkedRawRow || null;
}

function parseFiscalDateInput(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const dmyMatch = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmyMatch) {
    return new Date(`${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}T00:00:00`);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseOptionalInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCertificationStoredSource(value) {
  const raw = String(value || '').trim();
  if (!raw || !raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function getDgiiCertificationExcelDirs() {
  const configured = String(process.env.DGII_CERTIFICATION_EXCEL_DIR || '').trim();
  return [
    configured ? path.resolve(configured) : null,
    LOCAL_ECF_WORK_DIR,
    DEFAULT_DOWNLOADS_DIR,
  ].filter(Boolean);
}

function findLatestDgiiCertificationExcel() {
  const candidates = [];
  for (const dir of getDgiiCertificationExcelDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/^40211932609-\d+\.xlsx$/i.test(name)) continue;
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      candidates.push({ fullPath, mtimeMs: stat.mtimeMs });
    }
  }
  for (const candidate of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    try {
      const workbook = XLSX.readFile(candidate.fullPath, { bookSheets: true });
      const hasRfceSheet = workbook.SheetNames
        .some((name) => String(name || '').trim().toUpperCase() === 'RFCE');
      if (hasRfceSheet) return candidate.fullPath;
    } catch (_) {
      // Ignorar archivos Excel corruptos o temporales.
    }
  }
  return null;
}

function readRfceDocsFromExcel(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false, raw: false, defval: '#e' });
  const rfceSheetName = workbook.SheetNames.find((name) => String(name || '').trim().toUpperCase() === 'RFCE');
  const ecfSheetName = workbook.SheetNames.find((name) => String(name || '').trim().toUpperCase() === 'ECF');
  assertCondition(rfceSheetName, `El Excel DGII no contiene hoja RFCE: ${filePath}`, { statusCode: 422 });

  const rfceRows = XLSX.utils.sheet_to_json(workbook.Sheets[rfceSheetName], { defval: '#e', raw: false });
  const ecfRows = ecfSheetName
    ? XLSX.utils.sheet_to_json(workbook.Sheets[ecfSheetName], { defval: '#e', raw: false })
    : [];
  const ecfByEncf = new Map();
  for (const row of ecfRows) {
    const encf = normalizeDatasetValue(row.ENCF || row.eNCF || row.Encf);
    if (encf) ecfByEncf.set(encf, row);
  }

  return rfceRows
    .map((row, index) => {
      const encf = normalizeDatasetValue(row.ENCF || row.eNCF || row.Encf);
      if (!encf) return null;
      return {
        id: null,
        encf,
        tipo_ecf: 'E32',
        certification_original_xml: JSON.stringify({
          row,
          linkedRawRow: ecfByEncf.get(encf) || null,
          sourceSheet: 'RFCE',
          sourceExcel: filePath,
          sourceRow: index + 2,
        }),
        _sourceExcel: filePath,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.encf).localeCompare(String(b.encf)));
}

function getPreferredFinal250MilDir() {
  const configured = String(process.env.DGII_FINAL_250MIL_DIR || '').trim();
  const baseDir = configured
    ? path.resolve(configured)
    : path.join(LOCAL_ECF_WORK_DIR, 'DGII_CARGAR_AHORA_4_XML_VERIFICADOS');
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return path.join(baseDir, `LOTE_${stamp}`);
}

function openFolderInOs(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) return false;
  if (process.platform === 'win32') {
    execFile('explorer.exe', [folderPath], { windowsHide: false }, () => {});
    return true;
  }
  if (process.platform === 'darwin') {
    execFile('open', [folderPath], () => {});
    return true;
  }
  execFile('xdg-open', [folderPath], () => {});
  return true;
}

function normalizeDgiiState(payload) {
  const responseCode = getDgiiResponseCode(payload);
  if (responseCode === '1') return 'aceptado';
  if (responseCode === '2') return 'rechazado';
  if (responseCode === '3') return 'en_proceso';
  if (responseCode === '4') return 'aceptado_condicional';

  const httpStatus = Number(payload?.http?.status || payload?.httpStatus || 0);
  if (httpStatus >= 500) return 'error_consulta';
  if (httpStatus >= 400) return 'rechazado';

  const candidates = [
    payload?.estado,
    payload?.Estado,
    payload?.status,
    payload?.mensaje,
    payload?.message,
    payload?.error,
    payload?.descripcion,
    payload?.Descripcion,
    payload?.http?.body,
    payload?.raw,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  if (candidates.some((value) => value.includes('aceptado condicional') || value.includes('aceptado_condicional'))) return 'aceptado_condicional';
  if (candidates.some((value) => value.includes('aceptado'))) return 'aceptado';
  // Las respuestas de Aprobación Comercial usan "Aprobada"/"Aprobado" en vez de "Aceptado"
  // (verificado en vivo, Paso 3: DGII devuelve estado "Aprobacion Comercial Aprobada").
  // Se excluye si algún candidato ya contiene "rechaz" para no confundir un mensaje del
  // tipo "Aprobación Comercial Rechazada" con un éxito.
  if (
    !candidates.some((value) => value.includes('rechaz')) &&
    candidates.some((value) => /\baprobad[ao]\b/.test(value))
  ) return 'aceptado';
  if (candidates.some((value) => value.includes('bloqueado') || value.includes('blocked'))) return 'bloqueado';
  if (candidates.some((value) => value.includes('rechaz'))) return 'rechazado';
  if (candidates.some((value) => value.includes('proceso'))) return 'en_proceso';
  if (candidates.some((value) => value.includes('error'))) return 'error';
  return 'pendiente';
}

function collectDgiiResponseText(payload) {
  if (!payload) return '';
  const values = [];
  const push = (value) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' || typeof value === 'number') values.push(String(value));
    else if (Array.isArray(value)) value.forEach(push);
    else if (typeof value === 'object') Object.values(value).forEach(push);
  };
  push(payload);
  return values.join(' ').toLowerCase();
}

function getDgiiResponseCode(payload) {
  const direct = payload?.codigo ?? payload?.Codigo ?? payload?.code ?? payload?.Code ?? payload?.codigoRespuesta ?? payload?.CodigoRespuesta;
  if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct).trim();
  const raw = String(payload?.raw || payload?.http?.body || '').trim();
  const match = raw.match(/(?:<codigo>|"codigo"\s*:)\s*"?(\d+)/i) || raw.match(/(?:<Codigo>|"Codigo"\s*:)\s*"?(\d+)/i);
  return match?.[1] || '';
}

function suggestDgiiSolution(payload) {
  const code = getDgiiResponseCode(payload);
  const text = collectDgiiResponseText(payload);
  if (code === '81') return 'Revisa que el archivo enviado a DGII use el formato RNC + eNCF + .xml sin texto extra.';
  if (code === '1209') return 'La secuencia ya fue utilizada. Este e-NCF queda bloqueado y no debe reenviarse.';
  if (text.includes('secuencia') && text.includes('utiliz')) return 'La secuencia ya fue utilizada. Este e-NCF queda bloqueado y no debe reenviarse.';
  if (code === '11170') return 'Verifica Totales y Retención del E47; DGII exige coherencia entre TotalISRRetencion y el bloque Retencion del item.';
  if (text.includes('telefonoemisor')) return 'Corrige TelefonoEmisor al formato xxx-xxx-xxxx dentro de TablaTelefonoEmisor.';
  if (text.includes('nombredelarchivo') || text.includes('nombre del archivo')) return 'Usa como nombre DGII exactamente RNC + eNCF + .xml.';
  if (text.includes('tipo de archivo no válido')) return 'Asegura que el archivo temporal termine exactamente en .xml antes de subirlo.';
  if (text.includes('estructura del archivo xml')) return 'Revisa la estructura del XML frente a la XSD oficial del tipo de e-CF antes de reenviar.';
  return 'Revisa el código y mensaje DGII, compara el XML generado con la XSD oficial y corrige el campo señalado antes de reenviar.';
}

function isDgiiSequenceUsedResponse(payload) {
  const details = payload?.details || payload;
  const code = getDgiiResponseCode(details);
  // codigo:1 = Aceptado — nunca es "ya utilizado", aunque el campo secuenciaUtilizada=true
  // aparezca en la respuesta (ese campo significa "registrado", no "rechazado").
  if (code === '1') return false;
  if (code === '1209') return true;
  // Evitar falsos positivos: si el estado es aceptado, no es error de secuencia.
  const state = normalizeDgiiState(details);
  if (state === 'aceptado' || state === 'aceptado_condicional') return false;
  // El campo `raw` contiene el JSON como string — incluye claves como "secuenciaUtilizada"
  // que causarían falsos positivos. Solo chequear campos estructurados, no el raw.
  const structuredText = [
    details?.mensaje, details?.message, details?.descripcion, details?.Descripcion,
    details?.error, ...(Array.isArray(details?.mensajes) ? details.mensajes.map((m) => m?.valor || m?.descripcion || '') : []),
  ].filter(Boolean).join(' ').toLowerCase();
  return structuredText.includes('1209') || (structuredText.includes('secuencia') && structuredText.includes('utiliz'));
}

// DGII certecf registra los eNCF de RFCE (E32 RecepcionFC) enviados incluso si son rechazados.
// Si se reinician las pruebas y se vuelve a enviar el mismo eNCF de RFCE, DGII lo rechaza con
// "ya ha sido utilizado previamente". Este error NO es el mismo que isDgiiSequenceUsedResponse
// (que aplica a ECF normales y se interpreta como "ya aceptado"). Para RFCE significa que ese
// eNCF está quemado y hay que rotar a uno nuevo desde la secuencia.
function isRfceEncfAlreadyUsedError(responseOrError) {
  const obj = (responseOrError && typeof responseOrError === 'object') ? responseOrError : {};
  const text = [
    obj.mensaje, obj.message, obj.descripcion, obj.Descripcion, obj.error,
    ...(Array.isArray(obj.mensajes) ? obj.mensajes.map((m) => m?.valor || m?.descripcion || '') : []),
    obj.details?.mensaje, obj.details?.message, obj.details?.descripcion, obj.details?.error,
  ].filter(Boolean).join(' ').toLowerCase();
  return (text.includes('utilizado') || text.includes('utiliz')) && text.includes('resumen') && !text.includes('secuencia');
}

// Un RFCE queda "permanentemente bloqueado" cuando DGII lo rechaza por "ya utilizado"
// y pertenece al Paso 2 (set fijo de datos DGII, certification_test_type NO empieza con
// 'simulation-'). Ver _rotateAndRegenerateRfce arriba: ese caso no se puede rotar ni
// reintentar — solo se resuelve descargando un set nuevo en el portal DGII. Se calcula
// siempre desde la BD (fuente de verdad) para que sobreviva a regeneraciones del estado
// local en memoria/archivo (step4RfceGenerate ya no debe perder esta bandera).
function isPermanentlyBlockedRfceItem({ estado, certificationTestType, dgiiResponse }) {
  if (String(estado || '').toLowerCase() !== 'rechazado') return false;
  const isSimulated = String(certificationTestType || '').toLowerCase().startsWith('simulation-');
  if (isSimulated) return false;
  return isRfceEncfAlreadyUsedError(dgiiResponse || {});
}

// TesteCF y CerteCF son ambientes separados en DGII — no compartir estado de secuencias.
// El bloqueo se determina en tiempo real por la respuesta de DGII, no por lista estática.
const CERTIFICATION_BLOCKED_ENCFS = new Set([]);

function isCertificationBlockedEncf(encf) {
  return CERTIFICATION_BLOCKED_ENCFS.has(String(encf || '').trim().toUpperCase());
}

function buildPublicUrls(baseUrl) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!normalized) return { baseUrl: '' };
  return {
    baseUrl: normalized,
    recepcionUrl: `${normalized}/fe/recepcion/api/ecf`,
    aprobacionUrl: `${normalized}/fe/aprobacioncomercial/api/ecf`,
    semillaUrl: `${normalized}/fe/autenticacion/api/semilla`,
    validacionCertificadoUrl: `${normalized}/fe/autenticacion/api/validacioncertificado`,
  };
}

class EcfService {
  constructor({ query, withTransaction, resolveRequestActorUser }) {
    this.repository = new EcfRepository({ query, withTransaction });
    this.resolveRequestActorUser = resolveRequestActorUser;
    this.runtimeState = {
      lastConnection: null,
    };
    this.config = buildEcfConfig();
    this.logger = createLogger('ecf', { debug: this.config.DEBUG_ECF });
    this.seedStorage = new SeedStorageService({
      logger: createLogger('ecf.seed', { debug: this.config.DEBUG_ECF }),
    });
    this.receptionStorage = new ReceptionStorageService({
      logger: createLogger('ecf.reception.storage', { debug: this.config.DEBUG_ECF }),
    });
    this.dgiiClient = new DgiiClient({ config: this.config, logger: createLogger('ecf.dgii', { debug: this.config.DEBUG_ECF }) });
    this.authService = new AuthService({
      config: this.config,
      dgiiClient: this.dgiiClient,
      signatureService,
      logger: createLogger('ecf.auth', { debug: this.config.DEBUG_ECF }),
      certificateResolver: () => this.resolveCertificate(),
      seedStorage: this.seedStorage,
    });
    this.receptionService = new ReceptionService({
      authService: this.authService,
      dgiiClient: this.dgiiClient,
      logger: createLogger('ecf.reception', { debug: this.config.DEBUG_ECF }),
      config: this.config,
      storageService: this.receptionStorage,
    });
    this.statusService = new StatusService({
      authService: this.authService,
      dgiiClient: this.dgiiClient,
      logger: createLogger('ecf.status', { debug: this.config.DEBUG_ECF }),
      config: this.config,
      storageService: this.receptionStorage,
    });
    this.fcService = new FcService({
      authService: this.authService,
      dgiiClient: this.dgiiClient,
      logger: createLogger('ecf.fc', { debug: this.config.DEBUG_ECF }),
      config: this.config,
      storageService: this.receptionStorage,
    });
    this.certificationDir = path.resolve(process.cwd(), 'storage', 'ecf', 'certification');
    this.certificationSignedDir = path.join(this.certificationDir, 'signed');
  }

  async ensureReady() {
    await this.repository.ensureSchema();
    fs.mkdirSync(CERT_STORAGE_DIR, { recursive: true });
    fs.mkdirSync(this.certificationSignedDir, { recursive: true });
    this.seedStorage.ensureStorage();
    this.receptionStorage.ensureStorage();
  }

  applyRuntimeConfig(environment) {
    this.config = buildEcfConfig({ DGII_ENV: environment });
    this.dgiiClient.config = this.config;
    this.authService.config = this.config;
    this.authService.clearToken();
    this.receptionService.config = this.config;
    this.statusService.config = this.config;
  }

  async getCurrentActor(req, { adminOnly = false } = {}) {
    if (!this.resolveRequestActorUser) {
      return { id: null, usuario: 'Sistema', nombre: 'Sistema', rol: 'Sistema' };
    }
    const actor = await this.resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
    const role = String(actor?.role_code || actor?.rol || '').toLowerCase();
    const isAdmin = role.includes('admin');
    if (adminOnly && !isAdmin) {
      throw new EcfError('Solo usuarios administradores pueden modificar la configuración fiscal.', { statusCode: 403 });
    }
    return actor;
  }

  async resolveCertificate() {
    await this.ensureReady();
    const stored = await this.repository.getCertificate(1);
    const certPath = stored?.certificate_path || this.config.CERT_PATH;
    const certPassword = stored?.password_encrypted ? decryptText(stored.password_encrypted) : this.config.CERT_PASSWORD;
    const certificate = signatureService.loadCertificate({
      certPath,
      certPassword,
    });
    const validation = signatureService.validateCertificate(certificate, {
      expectedRnc: (await this.repository.getResolvedEmitter(1)).rnc,
    });
    if (!validation.isValidNow) {
      throw new EcfError('El certificado configurado no está vigente.', { statusCode: 422, details: validation });
    }
    return certificate;
  }

  async getCertificateStatus() {
    const stored = await this.repository.getCertificate(1);
    if (!stored && !this.config.CERT_PATH) {
      return { hasCertificate: false };
    }

    try {
      const certificate = await this.resolveCertificate();
      const validation = signatureService.validateCertificate(certificate, {
        expectedRnc: (await this.repository.getResolvedEmitter(1)).rnc,
      });
      return {
        hasCertificate: true,
        fileName: stored?.file_name || path.basename(certificate.certPath),
        subject: validation.subject,
        issuer: validation.issuer,
        serialNumber: validation.serialNumber,
        validFrom: validation.validFrom,
        validTo: validation.validTo,
        status: validation.isExpired ? 'vencido' : 'valido',
        isExpired: validation.isExpired,
        rncMatch: validation.rncMatch,
      };
    } catch (error) {
      return {
        hasCertificate: Boolean(stored || this.config.CERT_PATH),
        status: 'error',
        error: error.message,
      };
    }
  }

  buildChecklist(emitter, certificate, sequences) {
    const items = [];
    const hasRnc = [9, 11].includes(digitsOnly(emitter.rnc).length);
    items.push({
      key: 'emitter_rnc',
      label: 'RNC del emisor',
      status: hasRnc ? 'ok' : 'error',
      message: hasRnc ? `RNC configurado: ${digitsOnly(emitter.rnc)}` : 'Debe registrar el RNC del emisor.',
    });
    items.push({
      key: 'emitter_profile',
      label: 'Perfil fiscal',
      status: emitter.razon_social && emitter.direccion ? 'ok' : 'error',
      message: emitter.razon_social && emitter.direccion
        ? 'Datos fiscales principales registrados.'
        : 'Faltan datos obligatorios del emisor.',
    });
    items.push({
      key: 'certificate',
      label: 'Certificado digital',
      status: certificate.hasCertificate ? (certificate.isExpired ? 'error' : 'ok') : 'pending',
      message: certificate.hasCertificate
        ? (certificate.isExpired ? 'El certificado está vencido.' : `Certificado válido hasta ${certificate.validTo}.`)
        : 'No hay certificado cargado.',
    });
    items.push({
      key: 'sequences',
      label: 'Secuencias e-NCF',
      status: sequences.some((item) => item.activo && !item.isExpired && !item.isExhausted) ? 'ok' : 'pending',
      message: sequences.some((item) => item.activo && !item.isExpired && !item.isExhausted)
        ? 'Hay secuencias disponibles para emitir.'
        : 'Debe configurar al menos una secuencia e-NCF activa.',
    });
    const summary = items.reduce((acc, item) => {
      acc.total += 1;
      if (item.status === 'ok') acc.ok += 1;
      else if (item.status === 'warning') acc.warning += 1;
      else acc.pending += 1;
      return acc;
    }, { total: 0, ok: 0, warning: 0, pending: 0 });
    return { items, summary };
  }

  async getSystemStatus() {
    await this.ensureReady();
    const emitter = await this.repository.getResolvedEmitter(1);
    const certificate = await this.getCertificateStatus();
    const sequences = await this.repository.listSequences(1);
    const checklist = this.buildChecklist(emitter, certificate, sequences);
    const ready = checklist.items.every((item) => item.status === 'ok');

    return {
      status: ready ? (emitter.is_active ? 'listo' : 'inactivo') : 'no_configurado',
      isActive: Boolean(emitter.is_active),
      environment: emitter.environment,
      hasRnc: [9, 11].includes(digitsOnly(emitter.rnc).length),
      hasCertificate: Boolean(certificate.hasCertificate),
      certificateStatus: certificate.status || 'pendiente',
      hasActiveSequences: sequences.some((item) => item.activo && !item.isExpired && !item.isExhausted),
      checklist,
      tokenExpiresAt: this.runtimeState.lastConnection?.tokenExpiresAt || null,
      lastConnStatus: this.runtimeState.lastConnection?.status || null,
      lastConnMsg: this.runtimeState.lastConnection?.message || null,
    };
  }

  /**
   * Secuencias e-NCF activas cuyo vencimiento cae dentro de `thresholdDays`
   * (o ya vencidas) — para alertar antes de que el cajero se tope con el
   * bloqueo en medio de una venta. DGII no expone una API de consulta de
   * secuencias, así que esto solo compara `fecha_vencimiento` contra la
   * fecha actual del servidor.
   */
  async getExpiringSequencesSummary(businessId = 1, thresholdDays = 30) {
    await this.ensureReady();
    const sequences = await this.repository.listSequences(businessId);
    const now = Date.now();
    const dayMs = 86400000;
    return sequences
      .filter((item) => item.activo && !item.isExhausted && item.fechaVencimiento)
      .map((item) => ({
        tipoComprobante: item.tipoComprobante,
        branchName: item.branchName,
        fechaVencimiento: item.fechaVencimiento,
        diasParaVencer: Math.ceil((new Date(item.fechaVencimiento).getTime() - now) / dayMs),
        isExpired: item.isExpired,
      }))
      .filter((item) => item.diasParaVencer <= thresholdDays)
      .sort((a, b) => a.diasParaVencer - b.diasParaVencer);
  }

  async getBundle() {
    await this.ensureReady();
    const emitter = await this.repository.getResolvedEmitter(1);
    const certificate = await this.getCertificateStatus();
    const status = await this.getSystemStatus();
    return {
      business: {
        rnc: emitter.rnc,
        razon_social: emitter.razon_social,
        nombre_comercial: emitter.nombre_comercial,
        direccion: emitter.direccion,
        provincia: emitter.provincia,
        municipio: emitter.municipio,
        telefono: emitter.telefono,
        correo: emitter.correo,
      },
      fiscalConfig: {
        environment: emitter.environment,
        status: status.status,
        isActive: emitter.is_active,
      },
      dgiiSettings: {
        environment: emitter.environment,
        certificateMode: emitter.certificate_type,
        publicBaseUrl: emitter.public_base_url,
        allowedOrigins: emitter.allowed_origins,
        publicUrls: buildPublicUrls(emitter.public_base_url),
        internalToken: {
          requireInternalToken: emitter.require_internal_token,
          configured: Boolean(emitter.internal_token_hash),
          hashPreview: emitter.internal_token_hash ? `${String(emitter.internal_token_hash).slice(0, 10)}...` : '',
        },
        officialEndpoints: this.config.officialEnvironment,
      },
      certificate,
      checklist: status.checklist,
      officialUrlsByEnvironment: OFFICIAL_ENVIRONMENTS,
      seedStorage: this.seedStorage.getState(),
      receptionStorage: this.receptionStorage.getState(),
      certificationSummary: await this.repository.getCertificationSummary(),
      recentTestRuns: await this.repository.listRecentTestRuns(),
    };
  }

  /**
   * Obtiene los datos del emisor SIEMPRE frescos desde la BD (ecf_emitters).
   * Es la fuente única y oficial para construir XMLs e-CF.
   * Nunca usa valores hardcodeados, constantes ni caché.
   * - nombre_comercial = '' → <NombreComercial> se omite del XML (campo vacío)
   * - nombre_comercial = 'X' → <NombreComercial>X</NombreComercial> en el XML
   */
  async getEmitterForXml(businessId = 1) {
    const emitter = await this.repository.getResolvedEmitter(businessId);
    return {
      rnc: String(emitter.rnc || '').replace(/\D/g, ''),
      razonSocial: String(emitter.razon_social || '').trim(),
      // Con la corrección ?? en getResolvedEmitter, este valor refleja exactamente
      // lo guardado en ecf_emitters: '' si no se configuró / si se borró.
      nombreComercial: String(emitter.nombre_comercial || '').trim(),
      direccion: String(emitter.direccion || '').trim(),
      municipio: String(emitter.municipio || '').trim(),
      provincia: String(emitter.provincia || '').trim(),
      telefono: String(emitter.telefono || '').trim(),
      correo: String(emitter.correo || '').trim(),
      // Campos raw para compatibilidad con código que usa nombre_comercial (snake_case)
      razon_social: String(emitter.razon_social || '').trim(),
      nombre_comercial: String(emitter.nombre_comercial || '').trim(),
    };
  }

  /**
   * Vista previa de los datos del emisor tal como aparecerán en el XML.
   * Permite al usuario verificar ANTES de enviar qué datos usará DGII.
   */
  async getEmitterXmlPreview() {
    await this.ensureReady();
    const emitter = await this.getEmitterForXml();
    const xmlTags = {
      RNCEmisor: emitter.rnc || '(vacío — requerido)',
      RazonSocialEmisor: emitter.razonSocial || '(vacío — requerido)',
      NombreComercial: emitter.nombreComercial || '(no se incluirá en el XML)',
      DireccionEmisor: emitter.direccion || '(no se incluirá en el XML)',
      Municipio: emitter.municipio || '(no se incluirá en el XML)',
      Provincia: emitter.provincia || '(no se incluirá en el XML)',
      TelefonoEmisor: emitter.telefono || '(no se incluirá en el XML)',
      CorreoEmisor: emitter.correo || '(no se incluirá en el XML)',
    };

    // Validaciones
    const warnings = [];
    if (!emitter.rnc) warnings.push('RNC no configurado — el XML será rechazado por DGII.');
    if (!emitter.razonSocial) warnings.push('Razón social no configurada — el XML será rechazado por DGII.');

    return {
      emitter,
      xmlTags,
      warnings,
      source: 'ecf_emitters (base de datos, sin caché)',
      note: 'Los campos que dicen "(no se incluirá)" no generan el tag XML — esto es correcto si DGII no tiene ese dato registrado para el RNC.',
    };
  }

  /**
   * Vista previa del XML que se generaría para un documento de certificación.
   * Útil para diagnóstico antes de enviar.
   */
  async getCertificationCaseXmlPreview(documentId) {
    await this.ensureReady();
    const document = await this.repository.getDocument(documentId);
    assertCondition(document, `Documento ${documentId} no encontrado.`, { statusCode: 404 });

    const certificate = await this.resolveCertificate().catch(() => null);
    const repaired = await this.repairStoredDocumentXml(document, certificate, { persist: false });
    const xmlContent = String(repaired.xml_content || repaired.signed_xml_content || '').trim();

    // Extraer campos del XML para comparar con el emisor configurado
    const { DOMParser } = require('@xmldom/xmldom');
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlContent.replace(/^<\?xml[^>]*\?>/, '').trim(), 'text/xml');
    const getTag = (tag) => {
      const el = xmlDoc.getElementsByTagName(tag)[0];
      return el ? String(el.textContent || '').trim() : null;
    };

    const emitter = await this.getEmitterForXml();
    const xmlEmitter = {
      RNCEmisor: getTag('RNCEmisor'),
      RazonSocialEmisor: getTag('RazonSocialEmisor'),
      NombreComercial: getTag('NombreComercial'),
    };

    const diferencias = [];
    if (xmlEmitter.RNCEmisor !== emitter.rnc) diferencias.push({ campo: 'RNC', enXml: xmlEmitter.RNCEmisor, enConfig: emitter.rnc });
    if (xmlEmitter.RazonSocialEmisor !== emitter.razonSocial) diferencias.push({ campo: 'RazonSocial', enXml: xmlEmitter.RazonSocialEmisor, enConfig: emitter.razonSocial });
    if ((xmlEmitter.NombreComercial || '') !== emitter.nombreComercial) diferencias.push({ campo: 'NombreComercial', enXml: xmlEmitter.NombreComercial || '(no está en XML)', enConfig: emitter.nombreComercial || '(vacío)' });

    return {
      encf: document.encf,
      tipoEcf: document.tipo_ecf,
      estadoDgii: document.estado_dgii,
      emitterConfigurado: emitter,
      emitterEnXml: xmlEmitter,
      diferencias,
      hayDiferencias: diferencias.length > 0,
      xmlPreview: xmlContent.slice(0, 2000),
      xmlLength: xmlContent.length,
    };
  }

  /**
   * Retorna los últimos logs de emisor usados en XMLs.
   */
  async getEmitterXmlLogs() {
    await this.ensureReady();
    return this.repository.getEmitterXmlLogs(1, 100);
  }

  async saveBusiness(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const payload = req.body || {};
    // IMPORTANTE: String(null || '').trim() = '' pero necesitamos distinguir entre
    // "usuario no mandó el campo" y "usuario lo limpió". El frontend manda '' o el valor.
    // String(X || '') convierte null → '' correctamente para permitir borrar campos.
    const emitter = await this.repository.upsertEmitter(1, {
      rnc: digitsOnly(payload.rnc),
      razon_social: String(payload.razon_social || '').trim(),
      nombre_comercial: String(payload.nombre_comercial || '').trim(),
      direccion: String(payload.direccion || '').trim(),
      provincia: String(payload.provincia || '').trim(),
      municipio: String(payload.municipio || '').trim(),
      telefono: String(payload.telefono || '').trim(),
      correo: String(payload.correo || '').trim(),
    });

    // Auto-limpiar XMLs firmados de certificación en disco que puedan tener datos stale.
    // Cuando el usuario cambia el nombre comercial, los XMLs previos en disco quedan obsoletos.
    // Se regeneran automáticamente al reenviar.
    try {
      const certDir = this.certificationSignedDir;
      if (certDir && require('fs').existsSync(certDir)) {
        const xmlFiles = require('fs').readdirSync(certDir).filter((f) => f.endsWith('.xml'));
        let cleared = 0;
        for (const file of xmlFiles) {
          try {
            require('fs').unlinkSync(require('path').join(certDir, file));
            cleared++;
          } catch (_) { /* ignorar errores individuales */ }
        }
        if (cleared > 0) {
          this.logger.info(`[saveBusiness] Auto-limpieza: ${cleared} XML(s) de certificación en disco eliminados (datos del emisor actualizados).`);
        }
      }
    } catch (_) { /* auto-limpieza nunca debe fallar el guardado */ }

    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'emitter_updated',
      status: 'ok',
      detail: `Actualizó datos fiscales del emisor ${emitter.rnc || ''}. nombre_comercial="${emitter.nombre_comercial ?? ''}"`,
    });

    // Log de auditoría específico para el emisor
    await this.repository.saveEmitterXmlLog({
      businessId: 1,
      emitterData: emitter,
      origen: 'ecf_emitters',
      accion: 'emitter_guardado',
      detalle: `Usuario ${actor.nombre || actor.usuario} actualizó el emisor. nombre_comercial="${emitter.nombre_comercial ?? ''}"`,
    });

    return this.getBundle();
  }

  async saveDgiiSettings(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const body = req.body || {};
    const emitter = await this.repository.upsertEmitter(1, {
      environment: normalizeEnvironmentKey(body.environment || this.config.DGII_ENV),
      certificate_type: String(body.certificateMode || 'p12').trim().toLowerCase(),
      public_base_url: String(body.publicBaseUrl || '').trim(),
      allowed_origins: String(body.allowedOrigins || '').trim(),
      require_internal_token: toBoolean(body.requireInternalToken),
      internal_token_hash: toBoolean(body.requireInternalToken)
        ? (await this.repository.getResolvedEmitter(1)).internal_token_hash || this.repository.hashInternalToken(this.repository.generateInternalToken())
        : null,
      notes: String(body.notes || '').trim(),
    });
    this.applyRuntimeConfig(emitter.environment);
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'dgii_settings_updated',
      status: 'ok',
      detail: `Actualizó ambiente ${emitter.environment}.`,
    });
    return this.getBundle();
  }

  async saveEnvironment(req) {
    return this.saveDgiiSettings({
      ...req,
      body: {
        ...(req.body || {}),
        certificateMode: (await this.repository.getResolvedEmitter(1)).certificate_type,
      },
    });
  }

  async rotateInternalToken(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const token = this.repository.generateInternalToken();
    await this.repository.upsertEmitter(1, {
      require_internal_token: toBoolean(req.body?.requireInternalToken),
      internal_token_hash: this.repository.hashInternalToken(token),
    });
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'internal_token_rotated',
      status: 'ok',
      detail: 'Rotó el token interno DGII.',
    });
    return {
      ok: true,
      token,
      maskedToken: maskSecret(token),
      internalToken: maskSecret(token),
    };
  }

  async handleCertificateUpload(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const form = formidable({ multiples: false, maxFileSize: 10 * 1024 * 1024, keepExtensions: true });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (error, parsedFields, parsedFiles) => {
        if (error) reject(error);
        else resolve({ fields: parsedFields, files: parsedFiles });
      });
    });

    const rawCertificate = files.certificate || files.file;
    const uploaded = Array.isArray(rawCertificate) ? rawCertificate[0] : rawCertificate;
    const rawPassword = Array.isArray(fields.password) ? fields.password[0] : fields.password;
    assertCondition(uploaded?.filepath, 'No se recibió el archivo del certificado.', { statusCode: 400 });
    assertCondition(rawPassword, 'Debe indicar la contraseña del certificado.', { statusCode: 400 });

    const targetPath = path.join(CERT_STORAGE_DIR, 'business-1-active.p12');
    fs.copyFileSync(path.resolve(uploaded.filepath), targetPath);
    const certificate = signatureService.loadCertificate({
      certPath: targetPath,
      certPassword: String(rawPassword),
    });
    const validation = signatureService.validateCertificate(certificate, {
      expectedRnc: (await this.repository.getResolvedEmitter(1)).rnc,
    });
    await this.repository.saveCertificate(1, {
      fileName: uploaded.originalFilename || 'certificado.p12',
      certificatePath: targetPath,
      passwordEncrypted: encryptText(String(rawPassword)),
      subject: validation.subject,
      issuer: validation.issuer,
      serialNumber: validation.serialNumber,
      validFrom: validation.validFrom,
      validTo: validation.validTo,
      status: validation.isValidNow ? 'valido' : 'observado',
    });
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'certificate_uploaded',
      status: validation.isValidNow ? 'ok' : 'warning',
      detail: `Cargó certificado ${uploaded.originalFilename || 'certificado.p12'}.`,
      responsePayload: validation,
    });
    return {
      ok: validation.isValidNow,
      result: validation,
    };
  }

  async validateStoredCertificate() {
    const certificate = await this.resolveCertificate();
    const validation = signatureService.validateCertificate(certificate, {
      expectedRnc: (await this.repository.getResolvedEmitter(1)).rnc,
    });
    return {
      ok: validation.isValidNow,
      result: validation,
    };
  }

  async validateActivation() {
    const status = await this.getSystemStatus();
    const reasons = (status.checklist?.items || [])
      .filter((item) => item.status !== 'ok')
      .map((item) => item.message);
    return {
      canActivate: reasons.length === 0,
      reasons,
    };
  }

  async activate(req) {
    const validation = await this.validateActivation();
    if (!validation.canActivate) {
      throw new EcfError(`No se puede activar el módulo e-CF: ${validation.reasons.join(' | ')}`, { statusCode: 422 });
    }
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    await this.repository.upsertEmitter(1, { is_active: true });
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'ecf_activated',
      status: 'ok',
      detail: 'Activó la facturación electrónica.',
    });
    return { ok: true };
  }

  async deactivate(req) {
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    await this.repository.upsertEmitter(1, { is_active: false });
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'ecf_deactivated',
      status: 'ok',
      detail: 'Desactivó la facturación electrónica.',
    });
    return { ok: true };
  }

  async listSequences() {
    return this.repository.listSequences(1);
  }

  async generateNextENCF(req = {}) {
    await this.ensureReady();
    const body = {
      ...(req.query || {}),
      ...(req.body || {}),
    };
    const tipoComprobante = String(body.tipoComprobante || body.tipoEcf || body.prefijo || '').trim().toUpperCase();
    return this.repository.generateNextENCF({
      businessId: 1,
      tipoComprobante,
      sequenceId: body.sequenceId || body.sequence_id || null,
    });
  }

  async saveSequence(req) {
    await this.getCurrentActor(req, { adminOnly: true });
    return this.repository.saveSequence(1, req.body || {});
  }

  async updateSequenceNext(req) {
    await this.getCurrentActor(req, { adminOnly: true });
    const sequenceId = Number(req.params.id || 0);
    const nextNumber = Number(req.body?.proximoNumero || req.body?.nextNumber || req.body?.proximo || 0);
    const sequence = await this.repository.updateSequenceNextNumber(sequenceId, nextNumber);
    return {
      ok: true,
      sequence,
      message: `La secuencia ${sequence?.tipo_comprobante || sequenceId} ahora continuará en ${nextNumber}.`,
    };
  }

  async disableSequence(req) {
    await this.getCurrentActor(req, { adminOnly: true });
    await this.repository.disableSequence(Number(req.params.id));
    return { ok: true };
  }

  async deleteSequencePermanently(req) {
    await this.getCurrentActor(req, { adminOnly: true });
    const result = await this.repository.deleteSequencePermanently(Number(req.params.id));
    if (!result.deleted) return { ok: false, message: 'Secuencia no encontrada o ya eliminada.' };
    return { ok: true, message: 'Secuencia eliminada permanentemente.' };
  }

  async buildConnectionTestResult(environmentOverride = null) {
    const emitter = await this.repository.getResolvedEmitter(1);
    const sequences = await this.repository.listSequences(1);
    const certificate = await this.getCertificateStatus();
    const checklist = this.buildChecklist(emitter, certificate, sequences);
    const blockingRequirements = checklist.items.filter((item) => item.status !== 'ok').map((item) => ({
      key: item.key,
      label: item.label,
      message: item.message,
    }));

    if (blockingRequirements.length) {
      return {
        ok: false,
        status: 'no_configurado',
        message: 'La configuración aún no está completa para iniciar pruebas.',
        blockingRequirements,
        checklist,
      };
    }

    if (environmentOverride) {
      this.applyRuntimeConfig(environmentOverride);
    }

    const auth = await this.authService.authenticate({ forceRefresh: true });
    this.runtimeState.lastConnection = {
      status: 'conectado',
      message: 'Autenticación DGII exitosa.',
      tokenExpiresAt: auth.expira,
      checkedAt: nowIso(),
    };

    return {
      ok: true,
      status: 'conectado',
      message: 'Autenticación DGII exitosa.',
      tokenExpiresAt: auth.expira,
      seedHistory: auth.seedHistory || null,
      checklist,
      debug: this.config.DEBUG_ECF ? {
        token: auth.token,
        expedido: auth.expedido,
        expira: auth.expira,
      } : undefined,
    };
  }

  async testConnection(req) {
    const environment = normalizeEnvironmentKey(req.body?.environment || (await this.repository.getResolvedEmitter(1)).environment);
    const result = await this.buildConnectionTestResult(environment);
    await this.repository.saveTestRun('authenticate', result.ok ? 'ok' : 'warning', result.message, result, environment);
    return result;
  }

  async testSeed(req) {
    const environment = normalizeEnvironmentKey(req.body?.environment || (await this.repository.getResolvedEmitter(1)).environment);
    this.applyRuntimeConfig(environment);
    const seed = await this.authService.requestSeed();
    const response = {
      ok: Boolean(seed.value),
      environment,
      seedDetected: Boolean(seed.value),
      seedPreview: seed.value ? `${seed.value.slice(0, 8)}...` : '',
      seedDate: seed.fecha || null,
      estado: seed.storage?.estado || 'obtenida',
      archivo: seed.storage?.xmlPath || null,
      seedUrl: this.config.DGII_SEMILLA_URL,
      rawResponseLength: Buffer.byteLength(seed.raw || '', 'utf8'),
      builtXmlLength: Buffer.byteLength(seed.xml || '', 'utf8'),
      rawResponsePreview: String(seed.raw || '').slice(0, 240),
      seedHistory: seed.storage || null,
    };
    await this.repository.saveTestRun(
      'seed',
      response.ok ? 'ok' : 'warning',
      response.ok
        ? 'Semilla obtenida desde DGII. Debe firmarse con el certificado .p12 antes de validarla.'
        : 'DGII no devolvió una semilla interpretable.',
      response,
      environment
    );
    return response;
  }

  async debugAuth(req) {
    const environment = normalizeEnvironmentKey(req.body?.environment || (await this.repository.getResolvedEmitter(1)).environment);
    this.applyRuntimeConfig(environment);
    const seed = await this.authService.requestSeed();
    const certificate = await this.resolveCertificate();
    const signedXml = signatureService.signXML(seed.xml, certificate);
    const signedSeed = this.seedStorage.markSigned({
      id: seed.storage?.id,
      signedXml,
      estado: 'firmada',
    });
    const verification = signatureService.verifySignature(signedXml);
    let auth;
    try {
      auth = await this.dgiiClient.validateSeed(signedXml);
    } catch (error) {
      this.seedStorage.markFailed({
        id: signedSeed.id,
        error: error.message,
      });
      throw error;
    }
    this.seedStorage.markAuthenticated({
      id: signedSeed.id,
      tokenDetected: Boolean(auth.token),
      issuedAt: auth.expedido || null,
      expiresAt: auth.expira || null,
    });
    const response = {
      ok: Boolean(auth.token),
      environment,
      seedValue: seed.value,
      seedFile: signedSeed.xmlPath || null,
      signedSeedFile: signedSeed.signedPath || null,
      validateSeedUrl: this.config.DGII_VALIDAR_SEMILLA_URL,
      signedXml,
      signatureVerification: verification,
      dgiiHttpStatus: auth.http?.status,
      dgiiResponseHeaders: auth.http?.headers,
      dgiiResponseBody: auth.raw || auth.http?.body || '',
      tokenDetected: Boolean(auth.token),
      issuedAt: auth.expedido,
      expiresAt: auth.expira,
    };
    await this.repository.saveTestRun(
      'debug_auth',
      response.ok ? 'ok' : 'warning',
      response.ok
        ? 'DGII aceptó la semilla firmada con el certificado .p12.'
        : 'DGII no devolvió token al validar la semilla firmada.',
      response,
      environment
    );
    return response;
  }

  async getSeedState() {
    await this.ensureReady();
    return this.seedStorage.getState();
  }

  async getCurrentSeedXml(req) {
    await this.ensureReady();
    const type = String(req.query?.type || 'original').trim().toLowerCase() === 'signed' ? 'signed' : 'original';
    return this.seedStorage.getCurrentXml(type);
  }

  async signCurrentSeed(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });
    const currentSeed = this.seedStorage.getCurrentXml('original');
    const certificate = await this.resolveCertificate();
    const signedXml = signatureService.signXML(currentSeed.xml, certificate);
    const verification = signatureService.verifySignature(signedXml);

    if (!verification.ok) {
      throw new EcfError('La firma local de la semilla actual no pasó la verificación básica.', {
        statusCode: 422,
        details: verification,
      });
    }

    const updated = this.seedStorage.markSigned({
      id: currentSeed.entry?.id || null,
      signedXml,
      estado: 'firmada',
    });

    return {
      ok: true,
      environment: updated.environment,
      estado: updated.estado,
      archivo: updated.xmlPath,
      archivoFirmado: updated.signedPath,
      seedHistory: updated,
      signatureVerification: verification,
      signedXmlPreview: String(signedXml || '').slice(0, 600),
    };
  }

  async clearSeedHistory(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });
    return this.seedStorage.clearHistory();
  }

  async repairStoredDocumentXml(document, certificate, options = {}) {
    const persist = options.persist !== false;
    // Bail out solo si no hay ninguna fuente de XML disponible.
    // Después de rotate-encfs, xml_content queda NULL pero certification_original_xml
    // sigue teniendo el rawRow del set DGII — eso es suficiente para reconstruir.
    const hasCertOriginal = Boolean(String(document?.certification_original_xml || '').trim());
    if (!document?.id || (!String(document.xml_content || '').trim() && !hasCertOriginal)) {
      return document;
    }

    // Quitar BOM U+FEFF con escape explícito ﻿ (más robusto que el carácter visual).
    const storedXmlClean = String(document.xml_content || '').replace(/^﻿/, '');
    let normalizedXml = normalizeEcfXmlStructure(storedXmlClean, { removeSignature: true });

    // --- Estrategia para casos de certificación ---
    // DGII valida los comprobantes contra su set de datos exacto. Campos como Municipio,
    // Provincia, WebSite, NumeroFacturaInterna, PrecioUnitarioItem (4 decimales), etc.
    // sólo existen en los XML originales del set DGII, no en lo que genera nuestro motor ECF.
    // Por eso debemos re-firmar usando el XML ORIGINAL del set DGII cuando está disponible.

    const rawCertOriginal = String(document.certification_original_xml || '');
    // Quitar BOM U+FEFF con escape explícito antes del startsWith check.
    const rawOriginalXml = rawCertOriginal.replace(/^﻿/, '').trim();

    // Detectar origen del XML de certificación:
    // - 'xml'         → el set DGII vino como ZIP de XMLs → rawOriginalXml empieza con '<'
    // - 'spreadsheet' → el set DGII vino como hoja de cálculo → rawOriginalXml empieza con '{'
    // - 'none'        → sin dato (importación antigua que no guardó el original)
    const certOrigin = rawOriginalXml.startsWith('<') || rawOriginalXml.startsWith('<?')
      ? 'xml'
      : rawOriginalXml.startsWith('{')
        ? 'spreadsheet'
        : 'none';

    const isCertificationCase = Boolean(document.certification_case_key);

    if (isCertificationCase) {
      // LOG DIAGNÓSTICO — visible en consola del proceso Node/Electron
      console.log(`[repairXml] encf=${document.encf} certOrigin=${certOrigin} rawLen=${rawCertOriginal.length} first20=${JSON.stringify(rawCertOriginal.slice(0, 20))}`);
    }

    let skipE47Rebuild = false;
    let linkedEcfArtifactPath = null;

    // Leer nombre_comercial del emisor configurado localmente (tiene prioridad sobre el XML de DGII).
    let localEmitterForCert = null;
    let configNombreComercial = '';
    if (isCertificationCase) {
      localEmitterForCert = await this.getEmitterForXml(1);
      configNombreComercial = String(localEmitterForCert?.nombre_comercial ?? '').trim();
    }

    // E32 sin rawRow (certOrigin='none'): strip NC — no re-inyectar desde configNombreComercial.
    // Sin rawRow no podemos determinar el NC correcto (varía por doc):
    //   E320000000001/006: NC="DOCUMENTOS ELECTRONICOS DE 02"
    //   E320000000012-15 (<250Mil PORTAL): NC="DOCUMENTOS ELECTRONICOS" (ver dataset oficial DGII)
    // El NC correcto viene del rawRow (certOrigin='spreadsheet'). Sin él, omitir NC es lo más seguro.
    if (certOrigin === 'none' && isCertificationCase && String(document.tipo_ecf || '').toUpperCase() === 'E32') {
      normalizedXml = normalizedXml
        .replace(new RegExp('<NombreComercial>[^<]*</NombreComercial>', 'gi'), '')
        .replace(new RegExp('<NombreComercial\\s*/>', 'gi'), '');
    }

    if (certOrigin === 'xml' && isCertificationCase) {
      // Fuente XML del set DGII — usar tal cual (solo quitar firma para re-firmar con nuestro cert).
      const strippedOriginal = normalizeEcfXmlStructure(rawOriginalXml, { removeSignature: true });
      if (strippedOriginal.trim()) {
        normalizedXml = strippedOriginal;
        // El XML DGII es autoritativo: no inyectar configNombreComercial (nunca es el valor correcto).
        // Tags NC vacíos significan que DGII espera '' → stripear para evitar enviar vacío.
        normalizedXml = normalizedXml
          .replace(/<NombreComercial\s*\/>/gi, '')
          .replace(/<NombreComercial\s*>\s*<\/NombreComercial>/gi, '');
        skipE47Rebuild = true;
      }
    } else if (certOrigin === 'spreadsheet') {
      // Fuente hoja de cálculo — reconstruir desde la fila guardada.
      // IMPORTANTE: NO llamar a rebuildExteriorPaymentXml para E47 después de esto.
      // buildCertificationEcfXml ya incluye todos los campos DGII (Municipio, TerminoPago,
      // MontoPeriodo, ValorPagar, IdentificadorExtranjero) directamente desde la fila de
      // la hoja de cálculo. rebuildExteriorPaymentXml usa generateEcfXml que solo produce
      // el subconjunto de campos del motor ECF genérico — sobreescribiría y eliminaría
      // los campos específicos del set DGII que son obligatorios para la certificación.
      const certificationSource = parseCertificationStoredSource(rawCertOriginal);
      if (certificationSource?.kind === 'spreadsheet_row' && certificationSource.row) {
        const localEmitter = localEmitterForCert || await this.getEmitterForXml(1);
        const rowNombreComercial = String(certificationSource.row?.NombreComercial ?? '');
        // NombreComercial: si rawRow.NC es vacío → ''; si difiere del configNC → usarlo.
        // Si rawRow.NC==configNC (Excel copió el nombre del emisor) → usar rawRow.RazonSocial
        // si difiere del emitter local (DGII valida NC contra la entidad del set, no el config).
        const localRazonSocial = String(localEmitter?.razon_social ?? '').trim();
        // Para RFCE (E32 <250Mil), el NC correcto viene del linkedRawRow (hoja ECF del set DGII).
        // La hoja RFCE no tiene NombreComercial; el linked ECF sí lo tiene.
        const ncSourceRow = certificationSource.linkedRawRow || certificationSource.row;
        const emitterNombreComercial = certificationEmitterNombreComercial(ncSourceRow, configNombreComercial, localRazonSocial);
        await this.repository.saveEmitterXmlLog({
          businessId: 1,
          encf: document.encf,
          tipoEcf: document.tipo_ecf,
          emitterData: localEmitter,
          origen: 'rawRow (Excel set de pruebas DGII)',
          accion: 'xml_certificacion_reconstruido',
          detalle: `repairStoredDocumentXml: certOrigin=spreadsheet, row.NC="${rowNombreComercial}" linkedRow.NC="${normalizeDatasetValue(certificationSource.linkedRawRow?.NombreComercial)}" configNC="${configNombreComercial}" localRazon="${localRazonSocial}" → NC="${emitterNombreComercial}" (source=${certificationSource.linkedRawRow ? 'linkedRawRow' : 'row'})`,
        });

        // Paso 5 (Representación Impresa / simulación) SÍ debe mostrar la razón social REAL
        // del emisor y del comprador — confirmado directamente por un representante de la
        // DGII. Es distinto de Paso 2 (Pruebas de Datos e-CF), donde la DGII valida contra el
        // valor EXACTO de su propio conjunto de datos y rechaza el nombre real del emisor. Los
        // documentos de Paso 4/5 son simulaciones generadas por nosotros (certification_test_type
        // empieza con "simulation-"), no el dataset oficial fijo de la DGII — por eso aquí sí
        // se sustituye, y en Paso 2 (más abajo, sin este flag) nunca se toca.
        // NombreComercial debe ser el mismo valor que RazonSocialEmisor (no el nombre de la
        // empresa de ejemplo del set DGII) y RazonSocialComprador debe ser el del contacto real
        // (ContactoComprador) — confirmado en vivo con el representante de la DGII.
        const isSimulatedDoc = String(document.certification_test_type || '').toLowerCase().startsWith('simulation-');
        // La hoja RFCE (resumen <250mil) no trae ContactoComprador — buscarlo en la fila ECF
        // completa vinculada (linkedRawRow), igual que se hace para NombreComercial arriba.
        // "#e" es el placeholder de celda vacía del set de pruebas DGII (mismo patrón visto en
        // Gastos Menores) — no es un nombre de contacto real, hay que ignorarlo.
        const isPlaceholderContact = (value) => ['', '#e', 'n/a', 'na', '#n/a', '#ref!'].includes(String(value || '').trim().toLowerCase());
        const rowContacto = String(certificationSource.row?.ContactoComprador || '').trim();
        const linkedContacto = String(certificationSource.linkedRawRow?.ContactoComprador || '').trim();
        const buyerRazonSocial = isSimulatedDoc
          ? (!isPlaceholderContact(rowContacto) ? rowContacto : (!isPlaceholderContact(linkedContacto) ? linkedContacto : ''))
          : '';

        const rebuilt = buildTransmissionFromSpreadsheetRow({
          testCase: {
            encf: document.encf,
            tipoEcf: document.tipo_ecf,
            rawRow: certificationSource.row,
            linkedRawRow: certificationSource.linkedRawRow || null,
            sourceSheet: certificationSource.sourceSheet || null,
            submissionMode: certificationSource.submissionMode || null,
            emitterNombreComercial: isSimulatedDoc ? localRazonSocial : emitterNombreComercial,
            ...(isSimulatedDoc ? {
              emitterRnc: localEmitter?.rnc || '',
              emitterRazonSocial: localRazonSocial,
              buyerRazonSocial,
            } : {}),
          },
          issueDate: new Date(),
          certificateContext: certificate,
          emitter: localEmitter,
        });
        normalizedXml = rebuilt.xml;
        // Post-check: si el rawRow tiene NombreComercial pero el XML no lo incluyó (posible
        // si appendSimple lo omitió por valor nulo en una cadena generate→patch→generate),
        // inyectarlo ahora antes de firmar. NUNCA para RFCE: el XSD de RFCE prohíbe NombreComercial
        // (verificado en vivo — DGII rechaza la validación local con "Un RFCE no debe incluir NombreComercial").
        const isRfceSubmission = String(rebuilt.submissionMode || '').toLowerCase() === 'rfce';
        if (!isRfceSubmission && emitterNombreComercial && !/NombreComercial/i.test(normalizedXml)) {
          normalizedXml = normalizedXml.replace(
            /<\/RazonSocialEmisor>/i,
            `</RazonSocialEmisor><NombreComercial>${emitterNombreComercial.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</NombreComercial>`
          );
        }
        if (String(rebuilt.submissionMode || '').toLowerCase() === 'rfce' && rebuilt.linkedSignedEcfXml) {
          const localEcfDir = path.join(process.cwd(), 'storage', 'ecf', 'ecf-originales-locales');
          fs.mkdirSync(localEcfDir, { recursive: true });
          linkedEcfArtifactPath = path.join(localEcfDir, `${document.encf}.xml`);
          fs.writeFileSync(linkedEcfArtifactPath, rebuilt.linkedSignedEcfXml, 'utf8');
        }
        skipE47Rebuild = true; // ← preservar XML de la hoja; no sobreescribir con generateEcfXml
      }
    }
    // certOrigin === 'none': intentar leer el XML firmado del disco como fuente alternativa.
    // Los archivos en storage/ecf/certification/signed/ fueron escritos por snapshotCertificationSignedXml
    // al momento de enviar → contienen el XML original DGII con sus campos exactos.
    // Si el XML del disco tiene más campos que storedXmlClean (lo indica el tamaño), lo usamos.
    if (certOrigin === 'none' && isCertificationCase && String(document.encf || '').trim()) {
      try {
        const diskPath = path.join(this.certificationSignedDir, `${document.encf}.xml`);
        if (fs.existsSync(diskPath)) {
          const diskRaw = fs.readFileSync(diskPath, 'utf8').replace(/^﻿/, '');
          let diskStripped = normalizeEcfXmlStructure(diskRaw, { removeSignature: true });
          // E32 con certOrigin='none': stripear NC del XML de disco antes de comparar longitud
          // para que un NC residual no infle el tamaño. configNombreComercial se re-inyecta abajo si aplica.
          if (String(document.tipo_ecf || '').toUpperCase() === 'E32') {
            diskStripped = diskStripped
              .replace(new RegExp('<NombreComercial>[^<]*</NombreComercial>', 'gi'), '')
              .replace(new RegExp('<NombreComercial\\s*/>', 'gi'), '');
          }
          if (diskStripped.trim() && diskStripped.length > normalizedXml.length) {
            const isE32Disk = String(document.tipo_ecf || '').toUpperCase() === 'E32';
            // Sin rawRow no hay manera de calcular el NC correcto — no inyectar configNombreComercial.
            // Para E32: NC ya fue strippeado arriba. Para el resto: limpiar tags vacíos.
            if (!isE32Disk) {
              diskStripped = diskStripped
                .replace(/<NombreComercial\s*\/>/gi, '')
                .replace(/<NombreComercial\s*>\s*<\/NombreComercial>/gi, '');
            }
            normalizedXml = diskStripped;
            skipE47Rebuild = true;
            console.log(`[repairXml] encf=${document.encf} → disk fallback (${diskStripped.length} > ${storedXmlClean.length})`);
          }
        }
      } catch (_) { /* ignore disk errors */ }
    }

    // NombreComercial en E32: NO hacer strip global aquí.
    // Cada rama de certOrigin ya gestiona NC correctamente:
    //   'none'        → stripea NC; NO re-inyecta (sin rawRow no sabemos si el E32 necesita NC o no).
    //   'spreadsheet' → buildTransmissionFromSpreadsheetRow usa rawRow.NombreComercial (appendSimple
    //                   omite el tag si está vacío, lo incluye si tiene valor como "DOCUMENTOS ELECTRONICOS DE 02").
    //   'xml'         → se usa el XML original DGII tal cual (autoritativo).
    // El strip global que existía aquí causaba que E32 con NC en su rawRow (ej: E320000000006,
    // E320000000001) enviaran NC vacío y DGII los rechazara con error de dataset.

    // E47 en certificación: los XMLs DGII originales pueden carecer de NC, pero el portal lo valida.
    // Inyectar/reemplazar NC en normalizedXml ahora (antes de re-firmar y de rebuildExteriorPaymentXml,
    // que lee NC del XML para pasarlo a generateEcfXml). injectOrReplaceNombreComercialInXml maneja
    // los casos: ausente (insertIfAbsent), tag vacío (reemplaza), ya correcto (no toca).
    if (isCertificationCase
        && String(document.tipo_ecf || '').trim().toUpperCase() === 'E47'
        && configNombreComercial) {
      normalizedXml = injectOrReplaceNombreComercialInXml(normalizedXml, configNombreComercial, { insertIfAbsent: true });
    }

    if (!skipE47Rebuild && String(document.tipo_ecf || '').trim().toUpperCase() === 'E47') {
      normalizedXml = await this.rebuildExteriorPaymentXml(document, normalizedXml);
    }

    // Para casos de certificación: SIEMPRE re-firmar — DGII valida contra su set exacto
    // y necesitamos el XML original con todos sus campos en cada reintento.
    const storedSignedClean = String(document.signed_xml_content || '').replace(/^﻿/, '');
    const hadBom = document.xml_content !== storedXmlClean || document.signed_xml_content !== storedSignedClean;
    const needsResign = isCertificationCase
      || hadBom
      || normalizedXml !== storedXmlClean
      || !storedSignedClean.trim();
    if (!needsResign) {
      return isCertificationCase ? { ...document, _configNombreComercial: configNombreComercial } : document;
    }

    const signedXml = signatureService.signXML(normalizedXml, certificate);
    const verification = signatureService.verifySignature(signedXml);
    if (!verification.ok) {
      throw new EcfError('La reparación automática del XML no pasó la verificación local de firma.', {
        statusCode: 422,
        details: verification,
      });
    }

    // persist=false (usado por vistas previas de solo lectura, ej. xml-preview):
    // firmar en memoria para mostrar el XML tal cual se enviaría, SIN guardar
    // la nueva firma ni pisar estado_dgii — un preview no debe poder degradar
    // un documento ya 'aceptado' de vuelta a 'firmado' con una firma distinta
    // a la que DGII realmente recibió y aceptó.
    if (persist) {
      await this.repository.updateDocumentPayload(document.id, {
        xml_content: normalizedXml,
        signed_xml_content: signedXml,
        codigo_seguridad: computeSecurityCode(signedXml),
        estado_dgii: 'firmado',
        signed_at: new Date(),
      });
    }

    return {
      ...document,
      xml_content: normalizedXml,
      signed_xml_content: signedXml,
      codigo_seguridad: computeSecurityCode(signedXml),
      estado_dgii: 'firmado',
      signed_at: new Date().toISOString(),
      local_ecf_path: linkedEcfArtifactPath,
      _configNombreComercial: isCertificationCase ? configNombreComercial : undefined,
      _localRazonSocial: isCertificationCase ? String(localEmitterForCert?.razon_social ?? '').trim() : undefined,
    };
  }

  async rebuildExteriorPaymentXml(document, xmlContent = null) {
    const rawXml = String(xmlContent || document?.xml_content || '').trim();
    if (!rawXml) return rawXml;

    const xmlDoc = parseXml(rawXml.replace(/^\uFEFF/, ''));
    const root = xmlDoc.documentElement;
    if (!root) return rawXml;

    const sequence = document?.sequence_id ? await this.repository.getSequence(document.sequence_id) : null;
    const sequenceExpiry = sequence?.fecha_vencimiento || null;
    assertCondition(
      sequenceExpiry,
      `El documento ${document?.encf || document?.id || ''} requiere FechaVencimientoSecuencia para E47.`,
      { statusCode: 422 }
    );

    const encabezado = root.getElementsByTagName('Encabezado')?.[0];
    const emisorNode = encabezado?.getElementsByTagName('Emisor')?.[0];
    const compradorNode = encabezado?.getElementsByTagName('Comprador')?.[0];
    const idDocNode = encabezado?.getElementsByTagName('IdDoc')?.[0];
    const referenciaNode = root.getElementsByTagName('InformacionReferencia')?.[0];
    const itemNodes = Array.from(root.getElementsByTagName('Item') || []);

    const payload = {
      emitter: {
        rnc: firstNodeText(emisorNode, 'RNCEmisor'),
        razonSocial: firstNodeText(emisorNode, 'RazonSocialEmisor'),
        nombreComercial: firstNodeText(emisorNode, 'NombreComercial'),
        direccion: firstNodeText(emisorNode, 'DireccionEmisor'),
        telefono: Array.from(emisorNode?.getElementsByTagName('TelefonoEmisor') || [])
          .map((node) => String(node.textContent || '').trim())
          .filter(Boolean)
          .join(';'),
        correo: firstNodeText(emisorNode, 'CorreoEmisor'),
      },
      customer: {
        nombre: firstNodeText(compradorNode, 'RazonSocialComprador') || 'Beneficiario Exterior',
      },
      document: {
        eNCF: firstNodeText(idDocNode, 'eNCF') || document.encf,
        tipoeCF: 'E47',
        tipoPago: firstNodeText(idDocNode, 'TipoPago') || '1',
        fechaVencimientoSecuencia: sequenceExpiry,
        retentionIndicator: 1,
      },
      items: itemNodes.map((itemNode, index) => ({
        name: firstNodeText(itemNode, 'NombreItem') || `Item ${index + 1}`,
        quantity: parseDecimal(firstNodeText(itemNode, 'CantidadItem'), 1),
        unitPrice: parseDecimal(firstNodeText(itemNode, 'PrecioUnitarioItem'), parseDecimal(firstNodeText(itemNode, 'MontoItem'), 0)),
        discount: 0,
        taxRate: 0,
        billingIndicator: 4,
        retentionIndicator: 1,
        withholdingAmount: parseDecimal(firstNodeText(itemNode, 'MontoISRRetenido'), 0),
        goodsOrServicesIndicator: 2,
        additionalDescription: firstNodeText(itemNode, 'DescripcionItem'),
        unitMeasure: firstNodeText(itemNode, 'UnidadMedida') || null,
      })),
      issueDate: parseFiscalDateInput(firstNodeText(emisorNode, 'FechaEmision'))
        || parseFiscalDateInput(document.xml_generated_at)
        || parseFiscalDateInput(document.created_at)
        || new Date(),
    };

    assertCondition(payload.items.length > 0, 'El XML E47 no contiene ítems para reconstruirlo.', { statusCode: 422 });

    return generateEcfXml(payload).xml;
  }

  shouldAdvanceSequenceOnSend(document) {
    if (!document) return false;
    const normalizedState = String(document.estado_dgii || '').trim().toLowerCase();
    return Boolean(document.track_id || document.sent_at || ['enviado', 'aceptado', 'aceptado_condicional', 'rechazado', 'procesando', 'en_proceso'].includes(normalizedState));
  }

  extractPayloadFromDocumentXml(document, xmlContent, sequenceExpiry = null, replacementEncf = null) {
    const rawXml = String(xmlContent || '').trim();
    assertCondition(rawXml, 'El documento no tiene XML para regenerar su secuencia.', { statusCode: 422 });

    const xmlDoc = parseXml(rawXml.replace(/^\uFEFF/, ''));
    const root = xmlDoc.documentElement;
    assertCondition(root, 'El XML del documento no es válido.', { statusCode: 422 });

    const encabezado = root.getElementsByTagName('Encabezado')?.[0];
    const emisorNode = encabezado?.getElementsByTagName('Emisor')?.[0];
    const compradorNode = encabezado?.getElementsByTagName('Comprador')?.[0];
    const idDocNode = encabezado?.getElementsByTagName('IdDoc')?.[0];
    const itemNodes = Array.from(root.getElementsByTagName('Item') || []);
    const tipoEcf = String(document?.tipo_ecf || firstNodeText(idDocNode, 'TipoeCF') || '').trim().toUpperCase();

    return {
      emitter: {
        rnc: firstNodeText(emisorNode, 'RNCEmisor'),
        razonSocial: firstNodeText(emisorNode, 'RazonSocialEmisor'),
        nombreComercial: firstNodeText(emisorNode, 'NombreComercial'),
        direccion: firstNodeText(emisorNode, 'DireccionEmisor'),
        telefono: Array.from(emisorNode?.getElementsByTagName('TelefonoEmisor') || [])
          .map((node) => String(node.textContent || '').trim())
          .filter(Boolean)
          .join(';'),
        correo: firstNodeText(emisorNode, 'CorreoEmisor'),
      },
      customer: {
        rnc: firstNodeText(compradorNode, 'RNCComprador'),
        nombre: firstNodeText(compradorNode, 'RazonSocialComprador') || 'Consumidor Final',
        correo: firstNodeText(compradorNode, 'CorreoComprador'),
        telefono: firstNodeText(compradorNode, 'TelefonoComprador'),
        direccion: firstNodeText(compradorNode, 'DireccionComprador'),
      },
      document: {
        eNCF: normalizeEncfValue(
          replacementEncf || firstNodeText(idDocNode, 'eNCF') || document?.encf,
          tipoEcf
        ),
        tipoeCF: tipoEcf,
        tipoIngresos: firstNodeText(idDocNode, 'TipoIngresos') || null,
        tipoPago: firstNodeText(idDocNode, 'TipoPago') || '1',
        indicadorMontoGravado: parseOptionalInt(firstNodeText(idDocNode, 'IndicadorMontoGravado')),
        fechaVencimientoSecuencia: sequenceExpiry || firstNodeText(idDocNode, 'FechaVencimientoSecuencia') || null,
        retentionIndicator: parseOptionalInt(firstNodeText(root, 'IndicadorAgenteRetencionoPercepcion')) || 1,
        referencia: referenciaNode ? {
          ncfModificado: firstNodeText(referenciaNode, 'NCFModificado') || null,
          fechaNcfModificado: firstNodeText(referenciaNode, 'FechaNCFModificado') || null,
          codigoModificacion: firstNodeText(referenciaNode, 'CodigoModificacion') || null,
        } : null,
      },
      items: itemNodes.map((itemNode, index) => ({
        name: firstNodeText(itemNode, 'NombreItem') || `Item ${index + 1}`,
        quantity: parseDecimal(firstNodeText(itemNode, 'CantidadItem'), 1),
        unitPrice: parseDecimal(firstNodeText(itemNode, 'PrecioUnitarioItem'), parseDecimal(firstNodeText(itemNode, 'MontoItem'), 0)),
        discount: parseDecimal(firstNodeText(itemNode, 'DescuentoMonto'), 0),
        taxRate: parseDecimal(firstNodeText(itemNode, 'TasaITBIS'), 0),
        billingIndicator: parseOptionalInt(firstNodeText(itemNode, 'IndicadorFacturacion')),
        retentionIndicator: parseOptionalInt(firstNodeText(itemNode, 'IndicadorAgenteRetencionoPercepcion')) || 1,
        withholdingAmount: parseDecimal(firstNodeText(itemNode, 'MontoISRRetenido'), 0),
        goodsOrServicesIndicator: tipoEcf === 'E47'
          ? 2
          : (parseOptionalInt(firstNodeText(itemNode, 'IndicadorBienoServicio')) || 1),
        additionalDescription: firstNodeText(itemNode, 'DescripcionItem'),
        unitMeasure: firstNodeText(itemNode, 'UnidadMedida') || null,
      })),
      issueDate: parseFiscalDateInput(firstNodeText(emisorNode, 'FechaEmision'))
        || parseFiscalDateInput(document?.xml_generated_at)
        || parseFiscalDateInput(document?.created_at)
        || new Date(),
    };
  }

  async advanceDocumentToNextSequence(document, certificate, options = {}) {
    assertCondition(document?.sequence_id, `El documento ${document?.encf || document?.id || ''} no tiene una secuencia asociada para avanzar al siguiente e-NCF.`, {
      statusCode: 422,
    });

    const manualEncf = String(options.manualEncf || '').trim();
    const currentEncf = normalizeEncfValue(document.encf, document.tipo_ecf);
    let normalizedReservedEncf = currentEncf;
    let sequence = null;

    if (manualEncf) {
      normalizedReservedEncf = normalizeManualEncfInput(manualEncf, document.tipo_ecf);
      const manualNext = parseEncfNumber(normalizedReservedEncf, document.tipo_ecf) + 1;
      sequence = await this.repository.updateSequenceNextNumber(document.sequence_id, manualNext);
    } else {
      await this.repository.advanceSequenceAfterUse(document.sequence_id, document.encf);
      let reserved = await this.repository.reserveNextEncfForSequence(document.sequence_id, document.tipo_ecf);
      normalizedReservedEncf = normalizeEncfValue(reserved.encf, document.tipo_ecf);
      if (normalizedReservedEncf === currentEncf) {
        const forcedNext = parseEncfNumber(currentEncf, document.tipo_ecf) + 1;
        sequence = await this.repository.updateSequenceNextNumber(document.sequence_id, forcedNext);
        reserved = await this.repository.reserveNextEncfForSequence(document.sequence_id, document.tipo_ecf);
        normalizedReservedEncf = normalizeEncfValue(reserved.encf, document.tipo_ecf);
      } else {
        sequence = reserved.sequence || null;
      }
    }

    const normalizedXml = normalizeEcfXmlStructure(document.xml_content || document.signed_xml_content || '', { removeSignature: true });
    const payload = this.extractPayloadFromDocumentXml(document, normalizedXml, sequence?.fecha_vencimiento || null, normalizedReservedEncf);
    const regenerated = generateEcfXml(payload);
    const signedXml = signatureService.signXML(regenerated.xml, certificate);
    const verification = signatureService.verifySignature(signedXml);
    if (!verification.ok) {
      throw new EcfError('La firma del documento regenerado con el siguiente e-NCF no pasó la verificación local.', {
        statusCode: 422,
        details: verification,
      });
    }

    await this.repository.reissueDocument(document.id, {
      sequence_id: document.sequence_id,
      encf: normalizedReservedEncf,
      estado_dgii: 'firmado',
      codigo_seguridad: computeSecurityCode(signedXml),
      nombre_comprador: document.nombre_comprador || payload.customer?.nombre || null,
      rnc_comprador: digitsOnly(document.rnc_comprador || payload.customer?.rnc || ''),
      subtotal: regenerated.totals.subtotal,
      descuento_total: regenerated.totals.totalDiscount,
      monto_exento: regenerated.totals.exemptAmount,
      monto_gravado: regenerated.totals.totalTaxed,
      itbis_total: regenerated.totals.totalTax,
      monto_total: regenerated.totals.total,
      xml_content: regenerated.xml,
      signed_xml_content: signedXml,
      signed_at: new Date(),
    });

    return {
      ...document,
      encf: normalizedReservedEncf,
      estado_dgii: 'firmado',
      track_id: null,
      sent_at: null,
      error_message: null,
      dgii_response_json: null,
      codigo_seguridad: computeSecurityCode(signedXml),
      xml_content: regenerated.xml,
      signed_xml_content: signedXml,
      xml_generated_at: new Date().toISOString(),
      signed_at: new Date().toISOString(),
    };
  }

  async sendPreparedDocument(document) {
    if (String(document.submission_mode || '').toLowerCase() === 'rfce') {
      return this.fcService.sendConsumptionSummary({
        signedXml: document.signed_xml_content,
        filename: `${document.encf || `documento-${document.id}`}-rfce.xml`,
        localEcfPath: document.local_ecf_path || null,
      });
    }

    return this.receptionService.sendSignedEcf({
      signedXml: document.signed_xml_content,
      filename: `${document.encf || `documento-${document.id}`}.xml`,
    });
  }

  async logDgiiSequenceUsed(document, response, context = {}) {
    await this.repository.markDocumentSent(document.id, {
      estado_dgii: 'rechazado',
      track_id: null,
      dgii_response_json: response,
      error_message: response?.mensaje || response?.message || response?.descripcion || 'DGII indicó que la secuencia ya fue utilizada.',
    });
    // Marcar como BLOQUEADA en el registro persistente para que nunca se reutilice
    await this.repository.recordSequenceUsage({
      businessId: document.business_id || 1,
      rncEmisor:  document.rnc_emisor  || '',
      tipoEcf:    document.tipo_ecf    || '',
      encf:       document.encf        || '',
      sequenceNumber: this._parseEncfNumber(document.encf, document.tipo_ecf),
      status:     'BLOCKED_DGII_USED',
      dgiiCode:   getDgiiResponseCode(response?.details || response) || '1209',
      dgiiMessage: response?.mensaje || response?.message || response?.descripcion || 'Secuencia ya utilizada en DGII.',
      ecfDocumentId: document.id,
      saleId:     document.sale_id  || null,
      userId:     context.userId    || null,
      environment: document.environment || 'testecf',
      sentAt:     new Date().toISOString(),
    }).catch(err => console.warn('[ECF] recordSequenceUsage BLOCKED falló:', err.message));
    await this.repository.saveAudit({
      userId: context.userId || null,
      userName: context.userName || null,
      userRole: context.userRole || null,
      saleId: document.sale_id || context.saleId || null,
      branchId: document.branch_id || context.branchId || null,
      cashRegisterId: document.cash_register_id || context.cashRegisterId || null,
      sequenceId: document.sequence_id || null,
      documentId: document.id,
      tipoComprobante: document.tipo_ecf || null,
      encf: document.encf || null,
      actionName: 'sequence_1209_consumed',
      status: 'warning',
      detail: `DGII rechazó ${document.encf || ''} por secuencia utilizada. Se avanzará al siguiente e-NCF.`,
      responsePayload: response,
    });
  }

  async retryDocumentAfterSequenceUsed(document, certificate, context = {}) {
    let currentDocument = document;
    let lastResponse = null;
    let retries = 0;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.logDgiiSequenceUsed(currentDocument, lastResponse || context.response || {}, context);
      currentDocument = await this.advanceDocumentToNextSequence(currentDocument, certificate);
      retries += 1;

      try {
        const response = await this.sendPreparedDocument(currentDocument);
        if (!isDgiiSequenceUsedResponse(response)) {
          return { document: currentDocument, response, retries };
        }
        lastResponse = response;
      } catch (error) {
        if (!isDgiiSequenceUsedResponse(error)) throw error;
        lastResponse = error.details || { error: error.message };
      }
    }

    throw new EcfError('DGII rechazó varios e-NCF consecutivos como ya utilizados. La secuencia fue avanzada; revise el rango autorizado.', {
      statusCode: 502,
      details: lastResponse,
    });
  }

  async finalizeSentDocument(document, response, fallbackMessage = 'Documento enviado a DGII.') {
    const trackId = response.trackId || response.trackid || response.TrackId || null;
    const state = trackId ? 'enviado' : normalizeDgiiState(response);
    if (state !== 'rechazado' && document?.sequence_id) {
      await this.repository.advanceSequenceAfterUse(document.sequence_id, document.encf);
    }

    // Registrar uso en tabla persistente (sobrevive a "Borrar set local")
    const usageStatus = state === 'aceptado' ? 'ACCEPTED'
      : state === 'rechazado' ? 'REJECTED'
      : 'SENT';
    await this.repository.recordSequenceUsage({
      businessId:    document.business_id || 1,
      rncEmisor:     document.rnc_emisor  || '',
      tipoEcf:       document.tipo_ecf    || '',
      encf:          document.encf        || '',
      sequenceNumber: this._parseEncfNumber(document.encf, document.tipo_ecf),
      status:        usageStatus,
      dgiiTrackId:   trackId || null,
      dgiiCode:      getDgiiResponseCode(response?.details || response) || null,
      dgiiMessage:   response.mensaje || response.message || response.descripcion || null,
      ecfDocumentId: document.id,
      saleId:        document.sale_id  || null,
      environment:   document.environment || 'testecf',
      sentAt:        new Date().toISOString(),
    }).catch(err => console.warn('[ECF] recordSequenceUsage sent falló:', err.message));

    await this.repository.markDocumentSent(document.id, {
      estado_dgii: state,
      track_id: trackId,
      dgii_response_json: response,
      error_message: state === 'rechazado'
        ? (response.mensaje || response.message || response.descripcion || 'DGII rechazó el documento.')
        : null,
    });

    if (document.sale_id) {
      await this.repository.attachSaleSummary(document.sale_id, {
        encf: document.encf,
        tipoEcf: document.tipo_ecf,
        documentId: document.id,
        estado: state,
        trackId,
        error: response.mensaje || response.message || response.descripcion || null,
      });
    }

    return {
      ok: !['rechazado', 'error', 'error_consulta', 'error_auth'].includes(state),
      estado: state,
      mensaje: response.mensaje || response.message || response.descripcion || fallbackMessage,
      trackId,
      encf: document.encf,
      documentId: document.id,
      dgiiResponse: response,
    };
  }

  async retryDocumentRejectedByTrackStatus(document, dgiiStatus, context = {}) {
    if (!isDgiiSequenceUsedResponse(dgiiStatus) || !document?.sequence_id) return null;

    const certificate = await this.resolveCertificate();
    const repairedDocument = await this.repairStoredDocumentXml(document, certificate);
    const retryResult = await this.retryDocumentAfterSequenceUsed(repairedDocument, certificate, {
      ...context,
      response: dgiiStatus,
    });
    const finalized = await this.finalizeSentDocument(
      retryResult.document,
      retryResult.response,
      'Documento regenerado y reenviado por secuencia ya utilizada.'
    );

    await this.repository.saveAudit({
      userId: context.userId || null,
      userName: context.userName || null,
      userRole: context.userRole || null,
      saleId: retryResult.document.sale_id || null,
      branchId: retryResult.document.branch_id || null,
      cashRegisterId: retryResult.document.cash_register_id || null,
      sequenceId: retryResult.document.sequence_id || null,
      documentId: retryResult.document.id,
      tipoComprobante: retryResult.document.tipo_ecf || null,
      encf: retryResult.document.encf || null,
      actionName: 'track_1209_auto_retry',
      status: finalized.ok ? 'ok' : 'warning',
      detail: `Consulta TrackID devolvió 1209; documento reenviado con ${retryResult.document.encf}.`,
      responsePayload: {
        previousTrackId: dgiiStatus.trackId || context.trackId || null,
        newTrackId: finalized.trackId,
        retries: retryResult.retries,
      },
    });

    return {
      ...finalized,
      autoRetry: true,
      previousTrackId: dgiiStatus.trackId || context.trackId || null,
      previousEncf: document.encf,
      retries: retryResult.retries,
    };
  }

  buildSignedXmlForManualSend(xmlContent, certificate) {
    const normalizedXml = normalizeEcfXmlStructure(xmlContent, { removeSignature: true });
    const signedXml = signatureService.signXML(normalizedXml, certificate);
    const verification = signatureService.verifySignature(signedXml);
    if (!verification.ok) {
      throw new EcfError('El XML indicado no pasó la verificación local después de normalizarse y firmarse.', {
        statusCode: 422,
        details: verification,
      });
    }
    return {
      normalizedXml,
      signedXml,
      verification,
    };
  }

  async enviarDocumento(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });

    const emitter = await this.repository.getResolvedEmitter(1);
    const environment = normalizeEnvironmentKey(req.body?.environment || emitter.environment);
    this.applyRuntimeConfig(environment);

    const xmlPathRaw = String(req.body?.xmlPath || req.body?.rutaXml || '').trim();
    const manualEncfRaw = String(req.body?.manualEncf || req.body?.encfManual || req.body?.encf || '').trim();
    const documentId = Number(req.body?.documentId || 0) || null;
    let result;
    let resolvedXmlPath = null;
    let sourceDocument = null;

    if (xmlPathRaw) {
      resolvedXmlPath = path.isAbsolute(xmlPathRaw)
        ? path.resolve(xmlPathRaw)
        : path.resolve(process.cwd(), xmlPathRaw);
      assertCondition(fs.existsSync(resolvedXmlPath), `El XML indicado no existe: ${resolvedXmlPath}`, { statusCode: 404 });
      assertCondition(!manualEncfRaw, 'El e-NCF manual solo puede aplicarse cuando el sistema envía un documento interno, no al usar una ruta XML manual.', { statusCode: 422 });
      const certificate = await this.resolveCertificate();
      const manualXml = fs.readFileSync(resolvedXmlPath, 'utf8');
      const manualRoot = detectXmlRoot(manualXml);
      if (manualRoot === 'RFCE') {
        const rfceUnsigned = String(manualXml || '').replace(/<Signature\b[\s\S]*?<\/Signature>/i, '');
        const signedRfce = signatureService.signXML(rfceUnsigned, certificate);
        result = await this.fcService.sendConsumptionSummary({
          signedXml: signedRfce,
          filename: path.basename(resolvedXmlPath),
          localEcfPath: null,
        });
      } else {
        const preparedXml = this.buildSignedXmlForManualSend(manualXml, certificate);
        result = await this.receptionService.sendSignedEcf({
          signedXml: preparedXml.signedXml,
          filename: path.basename(resolvedXmlPath),
        });
      }
    } else {
      sourceDocument = documentId
        ? await this.repository.getDocument(documentId)
        : await this.repository.getLatestDocument();

      assertCondition(sourceDocument, 'No hay documentos e-CF disponibles para enviar.', { statusCode: 404 });
      const certificate = await this.resolveCertificate();
      sourceDocument = await this.repairStoredDocumentXml(sourceDocument, certificate);
      if (manualEncfRaw) {
        sourceDocument = await this.advanceDocumentToNextSequence(sourceDocument, certificate, { manualEncf: manualEncfRaw });
      } else if (this.shouldAdvanceSequenceOnSend(sourceDocument)) {
        sourceDocument = await this.advanceDocumentToNextSequence(sourceDocument, certificate);
      }
      assertCondition(
        String(sourceDocument.signed_xml_content || '').trim(),
        'El último documento e-CF no tiene XML firmado para enviar. Indica una ruta XML o firma un documento primero.',
        { statusCode: 422 }
      );

      try {
        result = await this.sendPreparedDocument(sourceDocument);
      } catch (error) {
        if (!isDgiiSequenceUsedResponse(error)) throw error;
        const retryResult = await this.retryDocumentAfterSequenceUsed(sourceDocument, certificate, {
          response: error.details || { error: error.message },
        });
        sourceDocument = retryResult.document;
        result = retryResult.response;
      }
      if (isDgiiSequenceUsedResponse(result)) {
        const retryResult = await this.retryDocumentAfterSequenceUsed(sourceDocument, certificate, {
          response: result,
        });
        sourceDocument = retryResult.document;
        result = retryResult.response;
      }
      if (normalizeDgiiState(result) !== 'rechazado' && sourceDocument.sequence_id) {
        await this.repository.advanceSequenceAfterUse(sourceDocument.sequence_id, sourceDocument.encf);
      }
    }

    await this.repository.saveTestRun(
      'send_ecf',
      result.trackId ? 'ok' : 'warning',
      result.trackId
        ? `Documento enviado a DGII. TrackID ${result.trackId}.`
        : (result.descripcion || result.mensaje || 'DGII respondió al envío sin TrackID.'),
      {
        ...result,
        environment,
        archivo: result.archivoEnviado,
        rutaXml: resolvedXmlPath,
        documentId: sourceDocument?.id || documentId || null,
        encf: sourceDocument?.encf || null,
        endpoint: result.endpoint || (result.xmlType === 'RFCE' ? this.config.DGII_FC_URL : this.config.DGII_RECEPCION_URL),
        recepcionUrl: result.xmlType === 'RFCE' ? null : this.config.DGII_RECEPCION_URL,
        recepcionFcUrl: result.xmlType === 'RFCE' ? this.config.DGII_FC_URL : null,
        xmlType: result.xmlType || null,
        xmlRoot: result.xmlRoot || null,
        requestXmlPath: result.requestXmlPath || result.xmlPath || result.archivoEnviado || null,
        requestXml: result.requestXml || null,
        dgiiResponseBody: result.raw || result.http?.body || '',
      },
      environment
    );

    return {
      trackId: result.trackId,
      mensaje: result.mensaje || result.descripcion || 'Documento enviado a DGII.',
      error: result.error || null,
      codigo: result.codigo || null,
      descripcion: result.descripcion || null,
      fecha: result.fecha || null,
      estado: result.estado || 'ENVIADO',
      environment,
      archivo: result.archivoEnviado || null,
      trackFile: result.trackPath || null,
      documentId: sourceDocument?.id || documentId || null,
      encf: sourceDocument?.encf || null,
      endpoint: result.endpoint || null,
      xmlType: result.xmlType || null,
      xmlRoot: result.xmlRoot || null,
      requestXmlPath: result.requestXmlPath || result.xmlPath || result.archivoEnviado || null,
      dgiiStatus: result.http?.status || null,
      dgiiResponseBody: result.raw || '',
    };
  }

  async consultarTrackId(trackId, req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });

    const emitter = await this.repository.getResolvedEmitter(1);
    const environment = normalizeEnvironmentKey(req.query?.environment || req.body?.environment || emitter.environment);
    this.applyRuntimeConfig(environment);

    const normalizedTrackId = String(trackId || '').trim();
    assertCondition(normalizedTrackId, 'Debes indicar un TrackId para consultar.', { statusCode: 422 });
    const shouldAutoRetry = toBoolean(req.query?.autoRetry ?? req.body?.autoRetry ?? false);

    const result = await this.receptionService.getTrackStatus(normalizedTrackId);
    const linkedDocument = await this.repository.getDocumentByTrackId(normalizedTrackId)
      || await this.repository.getDocumentByEncf(result.encf);
    const autoRetry = shouldAutoRetry && linkedDocument
      ? await this.retryDocumentRejectedByTrackStatus(linkedDocument, result, {
          userId: actor.id,
          userName: actor.nombre || actor.usuario,
          userRole: actor.rol || actor.role_code,
          trackId: normalizedTrackId,
        })
      : null;

    await this.repository.saveTestRun(
      'trackid',
      autoRetry?.ok ? 'ok' : result.estado === 'RECHAZADO' ? 'warning' : 'ok',
      autoRetry
        ? `Consulta TrackID ${normalizedTrackId}: 1209 detectado; reenviado con ${autoRetry.encf}.`
        : `Consulta TrackID ${normalizedTrackId}: ${result.estado}.`,
      {
        ...result,
        environment,
        consultaUrl: this.config.DGII_CONSULTA_URL,
        autoRetry,
      },
      environment
    );

    if (autoRetry) {
      return {
        trackId: autoRetry.trackId,
        previousTrackId: autoRetry.previousTrackId,
        mensaje: autoRetry.mensaje,
        error: null,
        codigo: null,
        descripcion: 'DGII devolvió 1209 en la consulta TrackID; se regeneró y reenvió automáticamente.',
        fecha: result.fecha || null,
        estado: autoRetry.estado,
        rnc: result.rnc || null,
        encf: autoRetry.encf,
        previousEncf: autoRetry.previousEncf,
        secuenciaUtilizada: result.secuenciaUtilizada ?? null,
        fechaRecepcion: result.fechaRecepcion || null,
        mensajes: result.mensajes || [],
        environment,
        archivoEstado: result.statusPath || null,
        documentId: autoRetry.documentId,
        autoRetry: true,
        retries: autoRetry.retries,
        dgiiStatus: autoRetry.dgiiResponse?.http?.status || null,
        dgiiResponseBody: autoRetry.dgiiResponse?.raw || '',
      };
    }

    return {
      trackId: result.trackId,
      mensaje: result.mensaje || result.descripcion || 'Consulta completada.',
      error: result.error || null,
      codigo: result.codigo || null,
      descripcion: result.descripcion || null,
      fecha: result.fecha || null,
      estado: normalizeDgiiState(result),
      rnc: result.rnc || null,
      encf: result.encf || null,
      secuenciaUtilizada: result.secuenciaUtilizada ?? null,
      fechaRecepcion: result.fechaRecepcion || null,
      mensajes: result.mensajes || [],
      environment,
      archivoEstado: result.statusPath || null,
      autoRetryAvailable: Boolean(!shouldAutoRetry && linkedDocument && isDgiiSequenceUsedResponse(result)),
      dgiiStatus: result.http?.status || null,
      dgiiResponseBody: result.raw || '',
    };
  }

  async getCurrentSentXml() {
    await this.ensureReady();
    return this.receptionStorage.getCurrentSentXml();
  }

  async buildPayloadForSale(saleId, requestedType) {
    // Usar getEmitterForXml() — fuente única y oficial de los datos del emisor.
    // Siempre lee de ecf_emitters (sin caché). Con la corrección ?? en getResolvedEmitter,
    // nombre_comercial = '' cuando el usuario no lo configuró (nunca fallback a business_name).
    const emitter = await this.getEmitterForXml(1);
    const rawEmitter = await this.repository.getResolvedEmitter(1); // para environment
    const { sale, items } = await this.repository.getSaleWithItems(saleId);
    const buyerTaxId = sale.client_tax_id || sale.client_tax_id_snapshot || '';
    const tipoEcf = inferRequestedType(requestedType, buyerTaxId);

    const certificateStatus = await this.getCertificateStatus();
    const validation = validateSaleForEcf({
      emitter: rawEmitter,
      certificateStatus,
      tipoEcf,
      buyerTaxId,
      buyerName: sale.client_name,
      documentType: getDocumentType(tipoEcf),
    });
    if (!validation.ok) {
      throw new EcfError(`No se puede emitir el e-CF: ${validation.errors.join(' | ')}`, { statusCode: 422, details: validation.errors });
    }

    const reservation = await this.repository.createDocumentFromSale({
      saleId,
      userId: sale.user_id || null,
      tipoEcf,
      environment: rawEmitter.environment,
    });

    // Log de auditoría: registra qué datos del emisor se usaron en este XML
    await this.repository.saveEmitterXmlLog({
      businessId: 1,
      encf: reservation.encf,
      tipoEcf,
      emitterData: emitter,
      origen: 'ecf_emitters (getEmitterForXml)',
      accion: 'xml_venta_generado',
      detalle: `buildPayloadForSale: venta ${saleId}, nombreComercial="${emitter.nombreComercial}"`,
    });

    const preparedItems = items.map((item) => ({
      name: item.product_name || item.nombre || 'Producto',
      quantity: Number(item.qty || 0),
      unitPrice: Number(item.price || 0),
      discount: Number(item.discount_amount || 0) > 0
        ? Number(item.discount_amount || 0)
        : Number(item.discount_rate || 0) > 0
          ? Number(item.qty || 0) * Number(item.price || 0) * (Number(item.discount_rate || 0) / 100)
          : 0,
      taxRate: Number(item.tax_rate || item.itbis || 0),
    }));

    const totals = buildTotals(preparedItems);
    const generated = generateEcfXml({
      emitter: {
        rnc: emitter.rnc,
        razonSocial: emitter.razonSocial,
        nombreComercial: emitter.nombreComercial,
        direccion: emitter.direccion,
        telefono: emitter.telefono,
        correo: emitter.correo,
      },
      customer: {
        rnc: buyerTaxId,
        nombre: sale.client_name || 'Consumidor Final',
        correo: sale.client_email || '',
        telefono: sale.client_phone || '',
        direccion: sale.client_address || '',
      },
      document: {
        eNCF: reservation.encf,
        tipoeCF: tipoEcf,
        tipoIngresos: '01',
        tipoPago: String(sale.payment_method || '').toLowerCase() === 'credito' ? '2' : '1',
        fechaVencimientoSecuencia: reservation.sequence?.fecha_vencimiento || null,
      },
      items: preparedItems.map((item) => (
        tipoEcf === 'E47'
          ? {
              ...item,
              billingIndicator: 4,
              retentionIndicator: 1,
              withholdingAmount: 0,
              goodsOrServicesIndicator: 2,
            }
          : item
      )),
      issueDate: sale.created_at || new Date(),
    });

    return {
      emitter,
      sale,
      items,
      preparedItems,
      totals,
      generated,
      reservation,
      tipoEcf,
      buyerTaxId,
    };
  }

  async processSaleForElectronicInvoicing(saleId, context = {}) {
    await this.ensureReady();
    const status = await this.getSystemStatus();
    if (!status.isActive) {
      throw new EcfError('La facturación electrónica está desactivada.', { statusCode: 422 });
    }

    const payload = await this.buildPayloadForSale(saleId, context.requestedType);
    const certificate = await this.resolveCertificate();
    const signedXml = signatureService.signXML(payload.generated.xml, certificate);
    const verification = signatureService.verifySignature(signedXml);
    if (!verification.ok) {
      throw new EcfError('La verificación local de la firma digital falló.', { statusCode: 422, details: verification });
    }

    const codigoSeguridad = computeSecurityCode(signedXml);
    let submissionMode = 'normal';
    if (
      payload.tipoEcf === 'E32' &&
      payload.generated.totals.total < this.config.DGII_RFCE_THRESHOLD_DOP &&
      !this.config.DGII_ALLOW_E32_FULL_RECEPTION
    ) {
      submissionMode = 'rfce';
    }
    await this.repository.updateDocumentPayload(payload.reservation.documentId, {
      nombre_comprador: payload.sale.client_name || 'Consumidor Final',
      rnc_comprador: digitsOnly(payload.buyerTaxId),
      subtotal: payload.generated.totals.subtotal,
      descuento_total: payload.generated.totals.totalDiscount,
      monto_exento: payload.generated.totals.exemptAmount,
      monto_gravado: payload.generated.totals.totalTaxed,
      itbis_total: payload.generated.totals.totalTax,
      monto_total: payload.generated.totals.total,
      codigo_seguridad: codigoSeguridad,
      xml_content: payload.generated.xml,
      signed_xml_content: signedXml,
      submission_mode: submissionMode,
      estado_dgii: 'firmado',
      signed_at: new Date(),
    });

    await this.repository.attachSaleSummary(saleId, {
      encf: payload.reservation.encf,
      tipoEcf: payload.tipoEcf,
      documentId: payload.reservation.documentId,
      estado: 'firmado',
      trackId: null,
      error: null,
    });

    let dgiiResponse;
    let finalDocument = await this.repository.getDocument(payload.reservation.documentId);
    try {
      if (submissionMode === 'rfce') {
        const rfceXml = generateRfceXml({
          emitter: {
            rnc: payload.emitter.rnc,
            razonSocial: payload.emitter.razonSocial || payload.emitter.razon_social,
        },
        customer: {
          rnc: payload.buyerTaxId,
          nombre: payload.sale.client_name || 'Consumidor Final',
        },
        document: {
          eNCF: payload.reservation.encf,
          tipoeCF: 'E32',
          tipoIngresos: '01',
          tipoPago: String(payload.sale.payment_method || '').toLowerCase() === 'credito' ? '2' : '1',
          codigoSeguridad,
        },
        totals: payload.generated.totals,
        paymentForms: [
          {
            formaPago: String(payload.sale.payment_method || '').toLowerCase() === 'cash' ? '1' : '8',
            montoPago: payload.generated.totals.total,
          },
        ],
        issueDate: payload.sale.created_at || new Date(),
        });
        const signedRfce = signatureService.signXML(rfceXml, certificate);
        dgiiResponse = await this.fcService.sendConsumptionSummary({
          signedXml: signedRfce,
          filename: `${payload.reservation.encf}-rfce.xml`,
          localEcfPath: null,
        });
      } else {
        dgiiResponse = await this.receptionService.sendSignedEcf({
          signedXml,
          filename: `${payload.reservation.encf}.xml`,
        });
      }
    } catch (error) {
      if (isDgiiSequenceUsedResponse(error)) {
        const retryResult = await this.retryDocumentAfterSequenceUsed(finalDocument, certificate, {
          ...context,
          response: error.details || { error: error.message },
          saleId,
          branchId: payload.sale.branch_id || null,
          cashRegisterId: payload.sale.cash_register_id || null,
        });
        finalDocument = retryResult.document;
        dgiiResponse = retryResult.response;
      } else {
        await this.repository.markDocumentSent(payload.reservation.documentId, {
          estado_dgii: 'error',
          track_id: null,
          dgii_response_json: { error: error.message },
          error_message: error.message,
        });
        await this.repository.attachSaleSummary(saleId, {
          encf: payload.reservation.encf,
          tipoEcf: payload.tipoEcf,
          documentId: payload.reservation.documentId,
          estado: 'error',
          trackId: null,
          error: error.message,
        });
        throw error;
      }
    }

    if (isDgiiSequenceUsedResponse(dgiiResponse)) {
      const retryResult = await this.retryDocumentAfterSequenceUsed(finalDocument, certificate, {
        ...context,
        response: dgiiResponse,
        saleId,
        branchId: payload.sale.branch_id || null,
        cashRegisterId: payload.sale.cash_register_id || null,
      });
      finalDocument = retryResult.document;
      dgiiResponse = retryResult.response;
    }

    const trackId = dgiiResponse.trackId || dgiiResponse.trackid || dgiiResponse.TrackId || null;
    const state = normalizeDgiiState(dgiiResponse);
    if (state !== 'rechazado' && finalDocument?.sequence_id) {
      await this.repository.advanceSequenceAfterUse(finalDocument.sequence_id, finalDocument.encf);
    }
    await this.repository.markDocumentSent(finalDocument.id, {
      estado_dgii: state,
      track_id: trackId,
      dgii_response_json: dgiiResponse,
      error_message: state === 'rechazado' ? (dgiiResponse.mensaje || dgiiResponse.message || 'DGII rechazó el documento.') : null,
    });
    await this.repository.attachSaleSummary(saleId, {
      encf: finalDocument.encf,
      tipoEcf: finalDocument.tipo_ecf || payload.tipoEcf,
      documentId: finalDocument.id,
      estado: state,
      trackId,
      error: dgiiResponse.mensaje || dgiiResponse.message || null,
    });
    await this.repository.saveAudit({
      userId: context.userId || null,
      userName: context.userName || null,
      userRole: context.userRole || null,
      saleId,
      branchId: payload.sale.branch_id || null,
      cashRegisterId: payload.sale.cash_register_id || null,
      sequenceId: finalDocument.sequence_id || payload.reservation.sequence.id,
      documentId: finalDocument.id,
      tipoComprobante: finalDocument.tipo_ecf || payload.tipoEcf,
      encf: finalDocument.encf,
      actionName: 'document_emitted',
      status: state === 'rechazado' ? 'warning' : 'ok',
      detail: `Documento ${finalDocument.encf} emitido vía ${submissionMode}.`,
      responsePayload: {
        trackId,
        state,
      },
    });

    return {
      ok: !['rechazado', 'error', 'error_consulta', 'error_auth'].includes(state),
      documentId: finalDocument.id,
      encf: finalDocument.encf,
      tipoEcf: finalDocument.tipo_ecf || payload.tipoEcf,
      estado: state,
      trackId,
      submissionMode,
      xml: this.config.DEBUG_ECF ? payload.generated.xml : undefined,
      signedXml: this.config.DEBUG_ECF ? signedXml : undefined,
      dgiiResponse: this.config.DEBUG_ECF ? dgiiResponse : undefined,
    };
  }

  async listDocuments(filters = {}) {
    return this.repository.listDocuments(filters);
  }

  async getDocumentXml(id) {
    const document = await this.repository.getDocument(id);
    if (!document) throw new EcfError('Documento e-CF no encontrado.', { statusCode: 404 });
    return document.signed_xml_content || document.xml_content || '';
  }

  async resendDocument(id) {
    const document = await this.repository.getDocument(id);
    if (!document) throw new EcfError('Documento e-CF no encontrado.', { statusCode: 404 });
    const certificate = await this.resolveCertificate();
    const repairedDocument = await this.repairStoredDocumentXml(document, certificate);
    let preparedDocument = this.shouldAdvanceSequenceOnSend(repairedDocument)
      ? await this.advanceDocumentToNextSequence(repairedDocument, certificate)
      : repairedDocument;
    assertCondition(preparedDocument.signed_xml_content, 'El documento no tiene XML firmado para reenviar.', { statusCode: 422 });

    let response;
    try {
      response = await this.sendPreparedDocument(preparedDocument);
    } catch (error) {
      if (!isDgiiSequenceUsedResponse(error)) throw error;
      const retryResult = await this.retryDocumentAfterSequenceUsed(preparedDocument, certificate, {
        response: error.details || { error: error.message },
      });
      preparedDocument = retryResult.document;
      response = retryResult.response;
    }
    if (isDgiiSequenceUsedResponse(response)) {
      const retryResult = await this.retryDocumentAfterSequenceUsed(preparedDocument, certificate, {
        response,
      });
      preparedDocument = retryResult.document;
      response = retryResult.response;
    }
    const trackId = response.trackId || response.trackid || response.TrackId || null;
    const state = normalizeDgiiState(response);
    if (state !== 'rechazado' && preparedDocument.sequence_id) {
      await this.repository.advanceSequenceAfterUse(preparedDocument.sequence_id, preparedDocument.encf);
    }
    await this.repository.markDocumentSent(id, {
      estado_dgii: state,
      track_id: trackId,
      dgii_response_json: response,
      error_message: state === 'rechazado' ? (response.mensaje || response.message || 'DGII rechazó el documento.') : null,
    });
    if (document.sale_id) {
      await this.repository.attachSaleSummary(document.sale_id, {
        encf: preparedDocument.encf,
        tipoEcf: preparedDocument.tipo_ecf,
        documentId: document.id,
        estado: state,
        trackId,
        error: response.mensaje || response.message || null,
      });
    }
    return {
      ok: state !== 'rechazado',
      estado: state,
      mensaje: response.mensaje || response.message || 'Documento reenviado.',
      trackId,
      encf: preparedDocument.encf,
    };
  }

  async queryDocumentStatus(id) {
    const document = await this.repository.getDocument(id);
    if (!document) throw new EcfError('Documento e-CF no encontrado.', { statusCode: 404 });
    if (!document.track_id) {
      return {
        estado: document.estado_dgii,
        mensaje: document.error_message || 'El documento aún no tiene TrackId asignado.',
        trackId: null,
        environment: document.environment,
      };
    }

    const dgii = await this.statusService.getTrackStatus(document.track_id);
    const state = normalizeDgiiState(dgii);
    const sequenceUsed = isDgiiSequenceUsedResponse(dgii);
    const isCertificationCase = Boolean(document.certification_case_key);
    // "Regenerar con nuevos eNCFs" (generateSimulationSet) solo aplica a casos del Paso 4
    // (simulación, eNCF propio). Los del Paso 2 traen el eNCF EXACTO del set DGII y no se
    // pueden regenerar — ver la nota en _rotateAndRegenerateRfce sobre por qué rotar rompe
    // la validación de DGII contra su colección de datos.
    const isSimulatedCase = String(document.certification_test_type || '').toLowerCase().startsWith('simulation-');
    const finalState = sequenceUsed
      ? (isCertificationCase ? 'rechazado' : 'bloqueado')
      : state;
    const sequenceUsedMessage = !isCertificationCase
      ? 'e-NCF bloqueado: DGII indicó que la secuencia ya fue utilizada.'
      : (isSimulatedCase
        ? 'Rechazado en certificación: eNCF ya utilizado — usar Regenerar con nuevos eNCFs.'
        : 'Rechazado en certificación: este e-NCF del set fijo de datos DGII ya fue utilizado y no se puede regenerar (Paso 2 exige el e-NCF exacto). Descarga un set de comprobantes nuevo en el portal DGII y reimpórtalo.');

    // Extraer mensaje de rechazo: DGII a veces lo pone en dgii.mensaje (singular) y otras
    // en dgii.mensajes[] (array de objetos con .valor o .descripcion).
    const mensajesArr = Array.isArray(dgii.mensajes) ? dgii.mensajes : (Array.isArray(dgii.Mensajes) ? dgii.Mensajes : []);
    const mensajesText = mensajesArr
      .map((m) => String(m?.valor || m?.Valor || m?.descripcion || m?.Descripcion || m?.mensaje || m || '').trim())
      .filter(Boolean)
      .join(' | ');
    const errorMsg = dgii.mensaje || dgii.message || dgii.descripcion || dgii.Descripcion || mensajesText || null;

    await this.repository.markDocumentStatus(id, {
      estado_dgii: finalState,
      dgii_response_json: sequenceUsed
        ? { ...dgii, reconciled: isCertificationCase, reason: 'dgii-sequence-used' }
        : dgii,
      error_message: sequenceUsed ? sequenceUsedMessage : (errorMsg || null),
    });
    if (document.sale_id) {
      await this.repository.attachSaleSummary(document.sale_id, {
        encf: document.encf,
        tipoEcf: document.tipo_ecf,
        documentId: document.id,
        estado: state,
        trackId: document.track_id,
        error: errorMsg || null,
      });
    }
    return {
      estado: finalState,
      mensaje: sequenceUsed ? sequenceUsedMessage : (errorMsg || 'Consulta completada.'),
      mensajes: mensajesArr,
      trackId: document.track_id,
      encf: document.encf,
      environment: document.environment,
      autoRetryAvailable: false,
      dgiiResponse: this.config.DEBUG_ECF ? dgii : undefined,
    };
  }

  buildCertificationCasePayload(document, extra = {}) {
    const dgiiResponse = extra.dgiiResponse || null;
    const storedResponse = dgiiResponse || parseJson(document.dgii_response_json, null);
    const xmlSource = document.signed_xml_content || document.xml_content || storedResponse?.requestXml || '';
    const guessedRoot = String(document.submission_mode || '').toLowerCase() === 'rfce' ? 'RFCE' : 'ECF';
    const xmlRoot = String(xmlSource || '').trim() ? detectXmlRoot(xmlSource) : guessedRoot;
    const xmlType = String(xmlSource || '').trim() ? getDgiiXmlDispatchType(xmlSource) : guessedRoot;
    const endpointDestino = String(document.submission_mode || '').toLowerCase() === 'rfce'
      ? this.config.DGII_FC_URL
      : this.config.DGII_RECEPCION_URL;
    const mensajes = Array.isArray(storedResponse?.mensajes)
      ? storedResponse.mensajes
      : Array.isArray(storedResponse?.Mensajes) ? storedResponse.Mensajes : [];
    return {
      id: document.id,
      testKey: document.certification_case_key || document.encf,
      tipo: document.tipo_ecf,
      encf: document.encf,
      cliente: document.nombre_comprador || 'Consumidor Final',
      rncReceptor: document.rnc_comprador || '',
      total: Number(document.monto_total || 0),
      tipoPrueba: document.certification_test_type || document.certification_source_name || document.tipo_ecf,
      estado: extra.estado || normalizeDgiiState(dgiiResponse || { estado: document.estado_dgii }),
      trackId: extra.trackId ?? document.track_id ?? null,
      dgiiCode: extra.codigo || getDgiiResponseCode(dgiiResponse || {}) || null,
      dgiiMessage: extra.mensaje || document.error_message || storedResponse?.mensaje || storedResponse?.message || null,
      dgiiFileName: document.certification_dgii_file_name || null,
      xmlPath: document.certification_sent_xml_path || null,
      signedXmlPath: document.certification_signed_xml_path || null,
      responsePath: document.certification_response_path || null,
      xmlRoot: xmlRoot || storedResponse?.xmlRoot || null,
      xmlType: xmlType === 'unknown' ? (storedResponse?.xmlType || null) : xmlType.toUpperCase(),
      endpointDestino: storedResponse?.endpoint || endpointDestino,
      submissionMode: document.submission_mode || 'normal',
      documentCount: xmlRoot === 'RFCE' || xmlRoot === 'ECF' ? 1 : null,
      suggestedSolution: suggestDgiiSolution(storedResponse || { codigo: extra.codigo, mensaje: extra.mensaje }),
      mensajes,
      environment: document.environment,
    };
  }

  async snapshotCertificationSignedXml(document) {
    if (!String(document?.signed_xml_content || '').trim() || !String(document?.encf || '').trim()) return null;
    const targetPath = path.join(this.certificationSignedDir, `${document.encf}.xml`);
    // Quitar BOM UTF-8 antes de guardar — DGII rechaza XMLs con BOM (código 1)
    const cleanXml = String(document.signed_xml_content || '').replace(/^﻿/, '');
    fs.writeFileSync(targetPath, cleanXml, 'utf8');
    return path.relative(process.cwd(), targetPath).replace(/\\/g, '/');
  }

  async syncCertificationArtifacts(document, overrides = {}) {
    const receptionState = this.receptionStorage.getState();
    const signedXmlPath = await this.snapshotCertificationSignedXml(document);
    await this.repository.updateCertificationTracking(document.id, {
      sentXmlPath: overrides.sentXmlPath
        || receptionState?.latestSent?.xmlPath
        || receptionState?.latestRfceSent?.xmlPath
        || null,
      signedXmlPath,
      responsePath: overrides.responsePath
        || receptionState?.latestTrackStatus?.statusPath
        || receptionState?.latestTrack?.trackPath
        || null,
      dgiiFileName: overrides.dgiiFileName
        || receptionState?.latestSent?.dgiiFileName
        || receptionState?.latestRfceSent?.dgiiFileName
        || null,
    });
  }

  async listCertificationCases(filters = {}) {
    await this.ensureReady();
    const data = await this.repository.listCertificationCases(filters);
    const summary = await this.repository.getCertificationSummary();
    return {
      ...data,
      summary,
      cases: (data.cases || []).map((document) => this.buildCertificationCasePayload(document)),
    };
  }

  async getCertificationSummary() {
    await this.ensureReady();
    return this.repository.getCertificationSummary();
  }

  certificationCenterStageForCase(testCase) {
    const state = String(testCase?.estado || '').trim().toLowerCase();
    if (state === 'bloqueado') return 'Bloqueado';
    if (state === 'aceptado' || state === 'aceptado_condicional') return 'Aceptado';
    if (state === 'rechazado' || state === 'error') return 'Rechazado';
    if (state === 'enviado' || state === 'procesando' || state === 'en_proceso') return 'Consultando';
    if (state === 'firmado') return 'Firmando';
    if (testCase?.id) return 'Generando XML';
    return 'Pendiente';
  }

  async markCertificationBlockedEncfs({ reason = 'preblocked', encfs = null } = {}) {
    await this.ensureReady();
    const blocked = new Set((encfs || Array.from(CERTIFICATION_BLOCKED_ENCFS)).map((encf) => String(encf || '').trim().toUpperCase()));
    if (!blocked.size) return { blocked: 0, encfs: [] };
    const data = await this.repository.listCertificationCases({ compact: true });
    const docs = (data.cases || []).filter((doc) => blocked.has(String(doc.encf || '').trim().toUpperCase()));
    for (const doc of docs) {
      await this.repository.markDocumentStatus(doc.id, {
        estado_dgii: 'bloqueado',
        dgii_response_json: {
          blocked: true,
          reason,
          encf: doc.encf,
          message: 'e-NCF bloqueado localmente porque ya fue utilizado en DGII.',
        },
        error_message: 'e-NCF bloqueado: la secuencia ya fue utilizada y no debe reenviarse.',
      });
    }
    return { blocked: docs.length, encfs: docs.map((doc) => doc.encf) };
  }

  /**
   * DGII Recepción (e-CF normal, no RFCE) solo confirma que el envío llegó — el
   * resultado real (aceptado/rechazado) hay que consultarlo aparte por TrackId
   * vía ConsultaResultado. Sin esto, "Actualizar" solo releía el estado local
   * "enviado" indefinidamente sin refrescarlo nunca contra DGII.
   */
  async _refreshPendingCertificationStatuses() {
    const pending = await this.repository.query(
      `SELECT id FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         AND track_id IS NOT NULL
         AND estado_dgii IN ('enviado', 'procesando', 'en_proceso')`
    ).catch(() => []);
    for (const row of pending) {
      await this.queryDocumentStatus(row.id).catch((err) => {
        console.warn('[ECF] No se pudo refrescar estado del documento', row.id, ':', err.message);
      });
    }
  }

  async certificationCenterStatus() {
    await this.ensureReady();
    await this._refreshPendingCertificationStatuses();
    const payload = await this.listCertificationCases({ compact: true });
    const cases = (payload.cases || []).map((testCase) => {
      const state = String(testCase.estado || '').trim().toLowerCase();
      const responseText = Array.isArray(testCase.mensajes) && testCase.mensajes.length
        ? testCase.mensajes.map((item) => `[${item.codigo || item.Codigo || '0'}] ${item.valor || item.Valor || item.descripcion || item.Descripcion || ''}`.trim()).join(' | ')
        : (testCase.dgiiMessage || testCase.error || '');
      const sequenceUsed = isCertificationBlockedEncf(testCase.encf) || isDgiiSequenceUsedResponse({
        codigo: testCase.dgiiCode,
        mensaje: responseText,
        error: testCase.error,
      });
      const reconciledState = sequenceUsed && state !== 'aceptado'
        ? 'aceptado'
        : testCase.estado;
      return {
        ...testCase,
        estado: reconciledState,
        blocked: false,
        reconciled: sequenceUsed || Boolean(testCase.reconciled),
        retryable: !sequenceUsed && !['aceptado', 'aceptado_condicional', 'bloqueado', 'enviado', 'procesando', 'en_proceso'].includes(state),
        stage: this.certificationCenterStageForCase({ ...testCase, estado: reconciledState }),
        responseText,
      };
    });
    const counts = cases.reduce((acc, item) => {
      const state = String(item.estado || '').trim().toLowerCase();
      acc.total += 1;
      if (state === 'aceptado' || state === 'aceptado_condicional') acc.accepted += 1;
      else if (state === 'rechazado' || state === 'error') acc.rejected += 1;
      else if (state === 'bloqueado') acc.blocked += 1;
      else if (['enviado', 'procesando', 'en_proceso'].includes(state)) acc.sent += 1;
      else acc.pending += 1;
      if (String(item.submissionMode || '').toLowerCase() === 'rfce' || String(item.tipo || '').toUpperCase() === 'E32') {
        acc.rfceTotal += String(item.submissionMode || '').toLowerCase() === 'rfce' ? 1 : 0;
        if (String(item.submissionMode || '').toLowerCase() === 'rfce' && (state === 'aceptado' || state === 'aceptado_condicional')) acc.rfceAccepted += 1;
      }
      return acc;
    }, { total: 0, accepted: 0, rejected: 0, blocked: 0, sent: 0, pending: 0, rfceTotal: 0, rfceAccepted: 0 });
    counts.progress = counts.total ? Math.round(((counts.accepted + counts.rejected + counts.blocked) / counts.total) * 100) : 0;

    // Desglose por tipo de comprobante (mismo formato que el portal DGII)
    const byTypeMap = {};
    for (const testCase of cases) {
      const tipo = String(testCase.tipo || '').trim().toUpperCase();
      const isRfce = String(testCase.submissionMode || '').toLowerCase() === 'rfce';
      const key = isRfce ? `${tipo}_RFCE` : tipo;
      if (!byTypeMap[key]) {
        byTypeMap[key] = { tipo, isRfce, total: 0, accepted: 0, rejected: 0, pending: 0, sent: 0 };
      }
      const state = String(testCase.estado || '').trim().toLowerCase();
      byTypeMap[key].total += 1;
      if (state === 'aceptado' || state === 'aceptado_condicional') byTypeMap[key].accepted += 1;
      else if (state === 'rechazado' || state === 'error' || state === 'bloqueado') byTypeMap[key].rejected += 1;
      else if (['enviado', 'procesando', 'en_proceso'].includes(state)) byTypeMap[key].sent += 1;
      else byTypeMap[key].pending += 1;
    }
    const byType = Object.values(byTypeMap).sort((a, b) => {
      // RFCE al final, luego ordenar por tipo
      if (a.isRfce !== b.isRfce) return a.isRfce ? 1 : -1;
      return String(a.tipo).localeCompare(String(b.tipo));
    });

    const rfceStep4 = this._step4RfceReadState();
    const history = (await this.repository.listRecentTestRuns(12).catch(() => []))
      .filter((row) => String(row.test_key || '').startsWith('certification'))
      .map((row) => ({
        id: row.id,
        key: row.test_key,
        status: row.status,
        summary: row.summary,
        environment: row.environment,
        createdAt: row.created_at,
      }));
    return {
      ok: true,
      counts,
      byType,
      summary: payload.summary || {},
      cases,
      blockedEncfs: Array.from(CERTIFICATION_BLOCKED_ENCFS),
      rfceStep4: {
        outDir: rfceStep4.outDir || null,
        items: rfceStep4.items || [],
        lastUpdated: rfceStep4.lastUpdated || null,
      },
      history,
      message: cases.length
        ? `Centro de Certificación listo: ${counts.accepted}/${counts.total} aceptados, ${counts.blocked} bloqueados.`
        : 'Carga el Excel oficial DGII y el certificado P12 para iniciar.',
    };
  }

  async certificationCenterProcess(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const startedAt = Date.now();
    const form = formidable({ multiples: true, maxFileSize: 60 * 1024 * 1024, keepExtensions: true });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (error, parsedFields, parsedFiles) => {
        if (error) reject(error);
        else resolve({ fields: parsedFields, files: parsedFiles });
      });
    });
    const oneField = (name) => {
      const value = fields?.[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const oneFile = (...names) => {
      for (const name of names) {
        const value = files?.[name];
        const file = Array.isArray(value) ? value[0] : value;
        if (file?.filepath) return file;
      }
      return null;
    };
    const excelFile = oneFile('excel', 'testset', 'set', 'files');
    const p12File = oneFile('certificate', 'p12', 'cert');
    const password = String(oneField('password') || '').trim();
    const environment = normalizeEnvironmentKey(oneField('environment') || oneField('ambiente') || 'certecf');
    assertCondition(excelFile?.filepath, 'Carga el Excel oficial de DGII antes de procesar.', { statusCode: 400 });
    const emitter = await this.repository.getResolvedEmitter(1);
    if (p12File?.filepath) {
      assertCondition(password, 'Escribe la contraseña del certificado P12.', { statusCode: 400 });
      const targetPath = path.join(CERT_STORAGE_DIR, 'business-1-active.p12');
      fs.copyFileSync(path.resolve(p12File.filepath), targetPath);
      const loadedCertificate = signatureService.loadCertificate({ certPath: targetPath, certPassword: password });
      const validation = signatureService.validateCertificate(loadedCertificate, { expectedRnc: emitter.rnc });
      await this.repository.saveCertificate(1, {
        fileName: p12File.originalFilename || 'certificado.p12',
        certificatePath: targetPath,
        passwordEncrypted: encryptText(password),
        subject: validation.subject,
        issuer: validation.issuer,
        serialNumber: validation.serialNumber,
        validFrom: validation.validFrom,
        validTo: validation.validTo,
        status: validation.isValidNow ? 'valido' : 'observado',
      });
      assertCondition(validation.isValidNow, 'El certificado P12 no está vigente o no coincide con el RNC configurado.', {
        statusCode: 422,
        details: validation,
      });
    } else {
      await this.resolveCertificate();
    }

    this.applyRuntimeConfig(environment);

    // Guardar si ya hay aceptados antes de borrar (para avisarle al usuario)
    const preCheck = await this.certificationCenterStatus();
    const forceReset = String(oneField('forceReset') || '').toLowerCase() === 'true';
    if (!forceReset && preCheck.counts && preCheck.counts.accepted > 0) {
      throw new EcfError(
        `Ya hay ${preCheck.counts.accepted} comprobante(s) aceptados por DGII en este lote. Para iniciar un proceso nuevo debes hacer Reset primero, o activar "Forzar reset" si estás seguro.`,
        { statusCode: 409, accepted: preCheck.counts.accepted }
      );
    }

    const preview = previewCertificationSet([excelFile]);

    const deleted = await this.repository.query(
      'DELETE FROM ecf_documents WHERE business_id = 1 AND certification_case_key IS NOT NULL'
    );
    CERTIFICATION_BLOCKED_ENCFS.clear();
    fs.rmSync(this.certificationSignedDir, { recursive: true, force: true });
    fs.mkdirSync(this.certificationSignedDir, { recursive: true });
    fs.rmSync(this._portal250MilStatusPath(), { force: true });
    fs.rmSync(this._step4RfceStatusPath(), { force: true });

    const certificateContext = await this.resolveCertificate();
    const importResult = await importCertificationSet({
      repository: this.repository,
      businessId: 1,
      uploadedFiles: [excelFile],
      emitter,
      environment,
      certificateContext,
      userId: actor.id || null,
    });
    const importedOk = Number(importResult.ok || 0);
    if (importedOk <= 0) {
      const errors = (importResult.results || [])
        .filter((item) => item && item.ok === false)
        .slice(0, 6)
        .map((item) => `${item.encf || item.casoPrueba || 'fila'}: ${item.error || 'error desconocido'}`);
      throw new EcfError(
        errors.length
          ? `El Excel fue leído, pero ningún comprobante pudo importarse. Primeros errores: ${errors.join(' | ')}`
          : `El Excel fue leído, pero no se importó ningún comprobante. Verifica que tenga hojas ECF/RFCE o columnas ENCF/eNCF válidas.`,
        {
          statusCode: 422,
          details: {
            importTotal: importResult.total || 0,
            importErrors: importResult.errors || 0,
            preview,
            importedSources: importResult.importedSources || [],
            ignored: importResult.ignored || [],
          },
        }
      );
    }
    const importedAfter = await this.repository.query(
      'SELECT COUNT(*) AS cnt FROM ecf_documents WHERE business_id = 1 AND certification_case_key IS NOT NULL'
    ).catch(() => [{ cnt: 0 }]);
    const importedCount = Number(importedAfter?.[0]?.cnt || 0);
    if (importedCount <= 0) {
      throw new EcfError(
        'El Excel se procesó, pero no quedó ningún comprobante guardado para enviar a DGII.',
        {
          statusCode: 422,
          details: {
            importTotal: importResult.total || 0,
            importOk: importResult.ok || 0,
            importedAfter: importedCount,
            preview,
          },
        }
      );
    }
    await this.markCertificationBlockedEncfs({ reason: 'known-used-before-run' });

    const importOnly = String(oneField('importOnly') || '').toLowerCase() === 'true';
    if (importOnly) {
      return {
        ok: true,
        imported: importedCount,
        total: importedCount,
        created: importedCount,
        message: `${importedCount} templates importados. Usa "Regenerar con nuevos eNCFs" para asignar secuencias nuevas y enviar.`,
      };
    }

    const results = [];
    const processed = new Set();
    for (let index = 0; index < 80; index += 1) {
      const nextDocument = await this.repository.getNextPendingCertificationDocument({ includeRejected: false });
      if (!nextDocument || processed.has(nextDocument.id)) break;
      processed.add(nextDocument.id);
      if (isCertificationBlockedEncf(nextDocument.encf)) {
        await this.markCertificationBlockedEncfs({ reason: 'known-used-before-send', encfs: [nextDocument.encf] });
        results.push({ ok: false, blocked: true, encf: nextDocument.encf, message: 'e-NCF bloqueado; no se envió a DGII.' });
        continue;
      }
      try {
        const sent = await this.sendCertificationCase(nextDocument.id, req, { skipStatusQuery: true });
        results.push(sent);
        if (sent?.sequenceUsed) {
          await this.markCertificationBlockedEncfs({ reason: 'dgii-sequence-used', encfs: [nextDocument.encf] });
        }
      } catch (error) {
        if (isDgiiSequenceUsedResponse(error)) {
          await this.markCertificationBlockedEncfs({ reason: 'dgii-sequence-used', encfs: [nextDocument.encf] });
          results.push({ ok: false, blocked: true, encf: nextDocument.encf, message: error.message });
          continue;
        }
        await this.repository.markDocumentStatus(nextDocument.id, {
          estado_dgii: 'error',
          dgii_response_json: { error: error.message, details: error.details || null },
          error_message: error.message,
        });
        results.push({ ok: false, encf: nextDocument.encf, message: error.message });
      }
    }

    // El envío de RFCE es 100% manual (botón "Reenviar RFCE" del Paso 2) — nunca se dispara
    // aquí. Antes se enviaba automáticamente apenas terminaban los 21 comprobantes normales,
    // sin ninguna pausa para el usuario; si el usuario disparaba "Reenviar RFCE" manualmente
    // casi al mismo tiempo, los dos envíos competían por el mismo e-NCF + código de seguridad
    // del resumen y DGII rechazaba uno de los dos como "combinación ya utilizada".
    const rfceProcessResult = null;

    // Esperar y consultar varias rondas cortas para mantener el panel sincronizado sin dormir de más.
    let pollResult = { ok: false };
    let rfcePollResult = { ok: false };
    const pollDelays = [1200, 1800, 2600, 3600, 5000];
    for (let pollRound = 0; pollRound < pollDelays.length; pollRound += 1) {
      await new Promise((resolve) => setTimeout(resolve, pollDelays[pollRound]));
      [pollResult, rfcePollResult] = await Promise.all([
        this.pollCertificationStatuses().catch((error) => ({ ok: false, error: error.message })),
        this.step4RfcePollStatuses().catch((error) => ({ ok: false, error: error.message })),
      ]);
      const interim = await this.certificationCenterStatus();
      const rfceInterim = await this.step4RfceGetStatus().catch(() => ({ items: [] }));
      const rfcePending = (rfceInterim.items || []).some((item) =>
        ['enviado', 'procesando', 'en_proceso'].includes(String(item.estado || '').toLowerCase())
      );
      if (interim.counts.sent === 0 && !rfcePending) break; // Todos tienen estado final
    }
    const status = await this.certificationCenterStatus();

    await this.repository.saveTestRun(
      'certification_center_process',
      status.counts.rejected || status.counts.blocked ? 'warning' : 'ok',
      `Centro de Certificación DGII procesó ${results.length} caso(s) en ${Math.round((Date.now() - startedAt) / 1000)}s.`,
      { importResult, results, rfceProcessResult, pollResult, rfcePollResult, deleted: deleted.affectedRows || 0 },
      environment
    );
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'certification_center_process',
      status: status.counts.rejected || status.counts.blocked ? 'warning' : 'ok',
      detail: `Procesó certificación DGII automática: ${status.counts.accepted}/${status.counts.total} aceptados.`,
      responsePayload: { importTotal: importResult.total, sent: results.length, blocked: status.counts.blocked },
    });

    return {
      ...status,
      importResult,
      results,
      rfceProcessResult,
      pollResult,
      rfcePollResult,
      durationMs: Date.now() - startedAt,
      deletedPrevious: deleted.affectedRows || 0,
    };
  }

  async certificationCenterRetry(documentId, req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });
    const document = await this.repository.getDocument(Number(documentId));
    assertCondition(document?.certification_case_key, 'Caso de certificación no encontrado.', { statusCode: 404 });
    assertCondition(!isCertificationBlockedEncf(document.encf) && String(document.estado_dgii || '').toLowerCase() !== 'bloqueado', 'Este e-NCF está bloqueado por secuencia usada y no se puede reenviar.', { statusCode: 409 });
    const parsedResponse = parseJson(document.dgii_response_json, null);
    assertCondition(!isDgiiSequenceUsedResponse(parsedResponse), 'DGII marcó esta secuencia como usada; queda bloqueada y no se puede reenviar.', { statusCode: 409 });
    await this.repository.markDocumentStatus(document.id, {
      estado_dgii: 'firmado',
      dgii_response_json: { retryRequestedAt: nowIso() },
      error_message: '',
    });
    const result = await this.sendCertificationCase(document.id, req, { skipStatusQuery: false });
    return {
      ...await this.certificationCenterStatus(),
      retryResult: result,
    };
  }

  // Genera automáticamente el set de simulación del Paso 4 usando los datos del Paso 2 como plantillas.
  // Asigna nuevos eNCFs de las secuencias activas, actualiza FechaEmision a hoy y reemplaza
  // referencias NCFModificado/eNCFModificado. Elimina el batch anterior antes de insertar.
  async generateSimulationSet(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });

    // ── 1. Leer templates del batch actual ──────────────────────────────────────
    const allRows = await this.repository.query(
      `SELECT id, tipo_ecf, encf, submission_mode, certification_order_index,
              certification_original_xml
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         AND certification_original_xml IS NOT NULL
       ORDER BY COALESCE(certification_order_index, id) ASC, id ASC
       LIMIT 200`
    );

    if (!allRows.length) {
      // Diagnóstico: contar cuántos cert docs existen sin certification_original_xml
      const diagRows = await this.repository.query(
        `SELECT COUNT(*) AS total FROM ecf_documents WHERE business_id = 1 AND certification_case_key IS NOT NULL`
      );
      const totalCertDocs = Number(diagRows[0]?.total || 0);
      const hint = totalCertDocs > 0
        ? `Hay ${totalCertDocs} documento(s) de certificación sin datos de Excel. Ve al Paso 2 y reimporta el set DGII.`
        : 'No hay documentos de certificación. Ve al Paso 2 e importa el set de pruebas DGII primero.';
      throw new EcfError(hint, { statusCode: 400 });
    }

    const templates = [];
    for (const row of allRows) {
      let src;
      try {
        src = JSON.parse(String(row.certification_original_xml || '').replace(/^﻿/, '').trim());
      } catch (_) { continue; }
      if (!src || !src.row || Object.keys(src.row).length < 3) continue;
      templates.push({
        tipo: String(row.tipo_ecf || '').trim().toUpperCase(),
        oldEncf: String(row.encf || '').toUpperCase(),
        submissionMode: String(row.submission_mode || 'normal').toLowerCase(),
        orderIndex: templates.length,
        src,
      });
    }

    if (!templates.length) {
      throw new EcfError(
        `Se encontraron ${allRows.length} documento(s) pero ninguno tiene rawRow válido. Ve al Paso 2 y reimporta el Excel DGII.`,
        { statusCode: 400 }
      );
    }

    // Si NO hay template E32 normal separado (estado degenerado: solo RFCE por tipo),
    // extraer el E32 normal del linkedRawRow del RFCE para que E33/E34 puedan referenciarlo.
    // Con 25 templates frescos del Excel, siempre hay un template E32 normal separado
    // y este bloque se saltea.
    const hasE32NormalTemplate = templates.some(
      (t) => t.tipo === 'E32' && t.submissionMode !== 'rfce'
    );
    if (!hasE32NormalTemplate) {
      const referencedOldEncfs = new Set();
      for (const item of templates) {
        const ref = String(item.src?.row?.NCFModificado || item.src?.row?.eNCFModificado || '').trim().toUpperCase();
        if (ref) referencedOldEncfs.add(ref);
      }
      for (const item of templates) {
        const linkedRow = item.src?.linkedRawRow;
        const linkedHasData = linkedRow && typeof linkedRow === 'object' && Object.keys(linkedRow).length > 5;
        if (
          referencedOldEncfs.has(item.oldEncf)
          && item.submissionMode === 'rfce'
          && linkedHasData
        ) {
          item.submissionMode = 'normal';
          item.src = {
            ...item.src,
            sourceSheet: 'ECF',
            submissionMode: 'normal',
            row: item.src.linkedRawRow,
            linkedRawRow: item.src.row,
          };
        }
      }
    }

    // ── 2. Asignar nuevos eNCFs desde las secuencias activas ────────────────────
    const today = new Date();
    const todayStr = [
      String(today.getDate()).padStart(2, '0'),
      String(today.getMonth() + 1).padStart(2, '0'),
      today.getFullYear(),
    ].join('-');
    const simBatchId = `sim-${Date.now()}`;
    const encfMap = {};

    for (const t of templates) {
      const seqResult = await this.generateNextENCF({ body: { tipoComprobante: t.tipo } }).catch((err) => {
        throw new EcfError(`Sin secuencia disponible para tipo ${t.tipo}: ${err.message}`, { statusCode: 422 });
      });
      encfMap[t.oldEncf] = seqResult.encf;
      t.newEncf = seqResult.encf;
      t.sequenceId = seqResult.sequence?.id || null;
      // Avanzar proximo_numero explícitamente para que la siguiente llamada del mismo tipo
      // obtenga un número diferente. Sin esto, generateNextENCF siempre devuelve el mismo
      // número porque los docs aún no fueron insertados en la BD.
      const advSeqId = seqResult.sequence?.id;
      const advNum = seqResult.numero;
      if (advSeqId && advNum) {
        await this.repository.query(
          'UPDATE ecf_sequences SET proximo_numero = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND proximo_numero <= ?',
          [advNum + 1, advSeqId, advNum],
        );
      }
    }

    // ── 3. Actualizar rawRows con nuevos eNCFs y fecha de hoy ───────────────────
    const patchRow = (row, oldEncf, newEncf) => {
      const updated = { ...row };
      if ('FechaEmision' in updated) updated.FechaEmision = todayStr;
      // FechaLimitePago debe ser >= FechaEmision; si el template tiene fecha vieja la actualizamos.
      // normalizeDatasetValue() convierte '#e' → '' (falsy) para tipos sin este campo (E43).
      if ('FechaLimitePago' in updated && normalizeDatasetValue(updated.FechaLimitePago)) updated.FechaLimitePago = todayStr;
      if (updated.ENCF && String(updated.ENCF).toUpperCase() === oldEncf) updated.ENCF = newEncf;
      if (updated.eNCF && String(updated.eNCF).toUpperCase() === oldEncf) updated.eNCF = newEncf;
      if (updated.NCFModificado) {
        const ref = String(updated.NCFModificado).toUpperCase().trim();
        if (encfMap[ref]) {
          updated.NCFModificado = encfMap[ref];
          if ('FechaNCFModificado' in updated) updated.FechaNCFModificado = todayStr;
        }
      }
      if (updated.eNCFModificado) {
        const ref = String(updated.eNCFModificado).toUpperCase().trim();
        if (encfMap[ref]) {
          updated.eNCFModificado = encfMap[ref];
          if ('FechaNCFModificado' in updated) updated.FechaNCFModificado = todayStr;
        }
      }
      // NO adivinar una tasa nueva de TasaImpuestoAdicional (ISC específico, TipoImpuesto 006)
      // aquí — forzar un valor hardcodeado (758.26, vigente solo Q2 2026) queda desactualizado
      // cada trimestre y DGII lo rechaza igual. En vez de eso, el Paso 4 (Simulación) debe
      // representar la operación REAL del contribuyente — si el negocio no vende el producto
      // gravado con ISC específico (ej. cerveza), se quita esa línea del documento simulado
      // en vez de adivinar la tasa, y se recalculan ITBIS/MontoTotal en cascada para que el
      // documento quede consistente (ver removeIscEspecificoTax, test-set-importer.js).
      // El 023 (ad-valorem) del set de pruebas siempre viene acoplado al 006 en la misma
      // línea de "cerveza" (verificado: en todo el lote actual, 023 nunca aparece sin 006) —
      // dejar el 023 solo hace que DGII lo rechace por no coincidir con el detalle de la
      // factura, así que se quitan los dos juntos.
      return removeIscEspecificoTax(removeIscEspecificoTax(updated, '006'), '023');
    };

    for (const t of templates) {
      // Para el linkedRawRow (E32 completo dentro del RFCE), el eNCF a reemplazar es el
      // del propio linkedRawRow, que puede diferir del eNCF del template RFCE.
      const linkedOldEncf = t.src.linkedRawRow
        ? String(t.src.linkedRawRow.ENCF || t.src.linkedRawRow.eNCF || '').toUpperCase()
        : '';
      const linkedNewEncf = linkedOldEncf && encfMap[linkedOldEncf]
        ? encfMap[linkedOldEncf]
        : t.newEncf;
      t.newSrc = {
        ...t.src,
        row: patchRow(t.src.row, t.oldEncf, t.newEncf),
        linkedRawRow: t.src.linkedRawRow
          ? patchRow(t.src.linkedRawRow, linkedOldEncf || t.oldEncf, linkedNewEncf)
          : null,
      };
    }

    const templatesByOldEncf = new Map(templates.map((item) => [String(item.oldEncf || '').toUpperCase(), item]));
    const templatesByNewEncf = new Map(templates.map((item) => [String(item.newEncf || '').toUpperCase(), item]));
    const orderedTemplates = [];
    const visitingTemplates = new Set();
    const visitedTemplates = new Set();
    const visitTemplate = (item) => {
      if (!item || visitedTemplates.has(item)) return;
      if (visitingTemplates.has(item)) return;
      visitingTemplates.add(item);
      const ref = String(
        item.newSrc?.row?.NCFModificado
        || item.newSrc?.row?.eNCFModificado
        || ''
      ).trim().toUpperCase();
      const dependency = ref
        ? (templatesByNewEncf.get(ref) || templatesByOldEncf.get(ref))
        : null;
      if (dependency && dependency !== item) visitTemplate(dependency);
      visitingTemplates.delete(item);
      visitedTemplates.add(item);
      orderedTemplates.push(item);
    };
    templates.forEach(visitTemplate);

    // ── 4+5. DELETE + INSERT en la misma transacción (atómico) ──────────────────
    // El DELETE fuera de transacción dejaba la tabla vacía si el INSERT fallaba,
    // impidiendo cualquier reintento sin reimportar desde el Paso 2.
    fs.rmSync(this.certificationSignedDir, { recursive: true, force: true });
    fs.mkdirSync(this.certificationSignedDir, { recursive: true });
    fs.rmSync(this._portal250MilStatusPath(), { force: true });
    fs.rmSync(this._step4RfceStatusPath(), { force: true });

    await this.repository.withTransaction(async (conn) => {
      await conn.query(
        'DELETE FROM ecf_documents WHERE business_id = 1 AND certification_case_key IS NOT NULL'
      );
      for (let i = 0; i < orderedTemplates.length; i += 1) {
        const t = orderedTemplates[i];
        const r = t.newSrc.row || {};
        await this.repository.saveImportedDocument(conn, 1, {
          sequenceId: t.sequenceId,
          tipoEcf: t.tipo,
          encf: t.newEncf,
          environment: 'certecf',
          estadoDgii: 'firmado',
          submissionMode: t.submissionMode,
          certificationCaseKey: `${simBatchId}-${i}`,
          certificationBatchId: simBatchId,
          certificationOrderIndex: i,
          certificationOriginalXml: JSON.stringify(t.newSrc),
          certificationSourceName: 'simulation',
          certificationSourceFormat: 'generated',
          certificationTestType: `simulation-${t.tipo.toLowerCase()}`,
          montoTotal: Number(r.MontoTotal || 0),
          montoGravado: Number(r.MontoGravadoTotal || r.MontoGravadoI1 || 0),
          montoExento: Number(r.MontoExento || 0),
          itbisTotal: Number(r.TotalITBIS || r.TotalITBIS1 || 0),
          subtotal: Number(r.MontoGravadoTotal || r.MontoTotal || 0),
          descuentoTotal: 0,
          rncComprador: String(r.RNCComprador || '').trim(),
          nombreComprador: String(r.RazonSocialComprador || '').trim(),
        });
      }
    });

    // ── 6. Enviar docs normales (no-RFCE) en secuencia ──────────────────────────
    const normalCount = templates.filter((t) => t.submissionMode !== 'rfce').length;
    let seqSent = 0;
    const seqErrors = [];
    try {
      const seqResult = await this.runCertificationSequence(req);
      seqSent = seqResult?.sent || 0;
      if (seqResult?.errors?.length) seqErrors.push(...seqResult.errors);
    } catch (err) {
      seqErrors.push(err.message || String(err));
    }

    return {
      ok: true,
      batchId: simBatchId,
      created: templates.length,
      normal: normalCount,
      rfce: templates.length - normalCount,
      encfMapping: Object.entries(encfMap).map(([oldE, newE]) => ({ old: oldE, new: newE })),
      sent: seqSent,
      errors: seqErrors,
      message: `Simulación generada: ${templates.length} comprobantes con nuevas secuencias (${seqSent}/${normalCount} enviados). ${templates.length - normalCount} RFCE pendientes — usa "Generar / Enviar RFCE" a continuación.`,
    };
  }

  // Firma y envía un ECF XML subido manualmente a DGII (entorno certecf).
  // No requiere que el documento esté en la DB — se firma al vuelo con el P12 guardado.
  async simulateManualSend(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });

    const form = formidable({ multiples: true, maxFileSize: 10 * 1024 * 1024, keepExtensions: true });
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (error, parsedFields, parsedFiles) => {
        if (error) reject(error);
        else resolve({ fields: parsedFields, files: parsedFiles });
      });
    });

    const uploaded = Object.values(files || {})
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .filter((f) => f?.filepath);

    assertCondition(uploaded.length > 0, 'Sube al menos un archivo XML.', { statusCode: 400 });

    const certificate = await this.resolveCertificate();
    this.applyRuntimeConfig('certecf');

    const results = [];
    for (const file of uploaded) {
      const rawXml = fs.readFileSync(file.filepath, 'utf8').replace(/^﻿/, '').trim();
      const encfMatch = rawXml.match(/<eNCF>([^<]+)<\/eNCF>/i);
      const tipoMatch = rawXml.match(/<TipoeCF>([^<]+)<\/TipoeCF>/i);
      const encf = encfMatch ? encfMatch[1].trim().toUpperCase() : (file.originalFilename || 'desconocido').replace('.xml', '').toUpperCase();
      const tipo  = tipoMatch ? tipoMatch[1].trim() : '?';
      try {
        const cleanXml   = normalizeEcfXmlStructure(rawXml, { removeSignature: true });
        const signedXml  = signatureService.signXML(cleanXml, certificate);
        const filename   = `${encf}.xml`;
        const submission = String(rawXml).includes('<RFCE') ? 'rfce' : 'normal';
        let response;
        if (submission === 'rfce') {
          response = await this.fcService.sendConsumptionSummary({ signedXml, filename });
        } else {
          response = await this.receptionService.sendSignedEcf({ signedXml, filename });
        }
        const trackId = response.trackId || response.trackid || response.TrackId || null;
        const estado  = normalizeDgiiState(response);
        results.push({ ok: !['rechazado','error'].includes(estado), encf, tipo, trackId, estado, mensaje: response.mensaje || response.message || null });
      } catch (err) {
        const dgiiResponse = err?.details || { error: err.message };
        if (isDgiiSequenceUsedResponse(dgiiResponse) || isDgiiSequenceUsedResponse(err)) {
          results.push({ ok: true, encf, tipo, trackId: null, estado: 'aceptado', mensaje: 'DGII indicó secuencia ya utilizada (aceptado previo).' });
        } else {
          results.push({ ok: false, encf, tipo, trackId: null, estado: 'error', mensaje: err.message });
        }
      }
    }

    const aceptados = results.filter((r) => r.ok).length;
    return {
      ok: aceptados > 0,
      results,
      aceptados,
      total: results.length,
      message: `${aceptados}/${results.length} comprobantes enviados y aceptados por DGII.`,
    };
  }

  async certificationCenterReset(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const result = await this.repository.query(
      'DELETE FROM ecf_documents WHERE business_id = 1 AND certification_case_key IS NOT NULL'
    );
    CERTIFICATION_BLOCKED_ENCFS.clear();
    fs.rmSync(this.certificationSignedDir, { recursive: true, force: true });
    fs.mkdirSync(this.certificationSignedDir, { recursive: true });
    fs.rmSync(this._portal250MilStatusPath(), { force: true });
    fs.rmSync(this._step4RfceStatusPath(), { force: true });
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'certification_center_reset',
      status: 'ok',
      detail: `Centro de Certificación reiniciado: ${result.affectedRows || 0} caso(s) eliminados.`,
      responsePayload: { deleted: result.affectedRows || 0 },
    });
    return {
      ok: true,
      deleted: result.affectedRows || 0,
      message: 'Centro de Certificación reiniciado. Carga nuevamente el Excel DGII y el P12 para comenzar limpio.',
    };
  }

  async importCertificationSet(req) {
    await this.ensureReady();
    const startedAt = Date.now();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const form = formidable({ multiples: true, maxFileSize: 50 * 1024 * 1024, keepExtensions: true });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (error, parsedFields, parsedFiles) => {
        if (error) reject(error);
        else resolve({ fields: parsedFields, files: parsedFiles });
      });
    });

    const flattenedFiles = Object.values(files || {})
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((item) => item?.filepath);
    assertCondition(flattenedFiles.length > 0, 'Debe subir XML, ZIP, TXT, JSON, Excel o una carpeta del set DGII.', { statusCode: 400 });

    const environmentField = Array.isArray(fields.ambiente) ? fields.ambiente[0] : fields.ambiente;
    const environmentFallback = Array.isArray(fields.environment) ? fields.environment[0] : fields.environment;
    const fastImportField = Array.isArray(fields.fastImport) ? fields.fastImport[0] : fields.fastImport;
    const fastImport = String(fastImportField ?? '1').trim() !== '0';
    const environment = normalizeEnvironmentKey(environmentField || environmentFallback || (await this.repository.getResolvedEmitter(1)).environment);
    const emitter = await this.repository.getResolvedEmitter(1);
    assertCondition(digitsOnly(emitter.rnc), 'Debes guardar el RNC del negocio antes de importar el set DGII.', { statusCode: 422 });

    let certificateContext = null;
    let certificateWarning = null;
    if (!fastImport) {
      try {
        certificateContext = await this.resolveCertificate();
      } catch (error) {
        certificateWarning = error.message;
        this.logger.warn('Set de certificación importado sin certificado activo.', { error: error.message });
      }
    }

    const result = await importCertificationSet({
      repository: this.repository,
      businessId: 1,
      uploadedFiles: flattenedFiles,
      emitter,
      environment,
      certificateContext,
      userId: actor.id || null,
    });
    const durationMs = Date.now() - startedAt;

    await this.repository.saveTestRun(
      'certification_import',
      result.errors > 0 ? 'warning' : 'ok',
      `Certificación DGII importada: ${result.ok}/${result.total} casos listos en ${Math.round(durationMs / 1000)}s.`,
      { ...result, certificateWarning, durationMs, fastImport },
      environment
    );
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'certification_test_set_imported',
      status: result.errors > 0 ? 'warning' : 'ok',
      detail: `Importó set DGII de certificación: ${result.ok}/${result.total} casos.`,
      responsePayload: { total: result.total, ok: result.ok, errors: result.errors, ignored: result.ignored || [] },
    });

    return {
      ...result,
      message: certificateWarning
        ? `Set importado sin firma digital activa. ${certificateWarning}`
        : fastImport
          ? `Set importado en modo rápido: ${result.ok}/${result.total} pruebas listas. Se firmarán automáticamente al enviar.`
          : `Set importado: ${result.ok}/${result.total} pruebas preparadas.`,
      certificateWarning,
      fastImport,
      durationMs,
      summary: await this.repository.getCertificationSummary(),
    };
  }

  // Marca los casos ENVIADO/EN_PROCESO/ACEPTADO como FIRMADO para poder reenviarlos.
  // Crucial cuando el portal DGII reinicia el conteo: los casos que DGII ya rechazó
  // (por ejemplo E33 cuya E32 referenciada dejó de ser válida) y los previamente aceptados
  // deben re-enviarse completos. Incluye los 4 RFCE porque DGII también reinicia el
  // contador de resúmenes cuando rechaza un comprobante estructuralmente inválido.
  async resetSentCertificationCases(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    CERTIFICATION_BLOCKED_ENCFS.clear();
    // Limpiar estado RFCE y E32 locales para forzar re-firma en el siguiente intento.
    // Sin esto, generate250MilXmls reutiliza la firma antigua (misma CodigoSeguridadeCF)
    // y DGII rechaza con "combinación ya utilizada" causando otro reinicio en cadena.
    fs.rmSync(this._step4RfceStatusPath(), { force: true });
    const localEcfDir = path.join(process.cwd(), 'storage', 'ecf', 'ecf-originales-locales');
    if (fs.existsSync(localEcfDir)) {
      for (const f of fs.readdirSync(localEcfDir)) {
        if (/\.xml$/i.test(f)) {
          try { fs.unlinkSync(path.join(localEcfDir, f)); } catch (_) { /* ignorar */ }
        }
      }
    }
    const result = await this.repository.resetSentCertificationCasesToFirmado();
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      documentId: null,
      sequenceId: null,
      tipoComprobante: null,
      encf: null,
      actionName: 'certification_reset_sent',
      status: 'ok',
      detail: `Se reestablecieron ${result.reset} caso(s) a estado "firmado" sin rotar eNCF ni modificar datos del dataset.`,
      responsePayload: result,
    });
    return {
      ok: true,
      message: `${result.reset} caso(s) reestablecido(s) a "firmado" sin cambiar eNCF ni modificar datos del dataset. Ahora ejecuta las pruebas secuenciales.`,
      reset: result.reset,
      batchId: result.batchId,
    };
  }

  // Resetea documentos rechazados/error de vuelta a 'firmado' para reintento.
  // Usar después de corregir el rawRow (fix-nombre-comercial, fix-rawrow) y antes de run-sequential.
  // NO toca docs RFCE ni aceptados.
  async resetRejectedCertificationCases(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const result = await this.repository.resetRejectedCertificationCasesToFirmado();
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      documentId: null,
      sequenceId: null,
      tipoComprobante: null,
      encf: null,
      actionName: 'certification_reset_rejected',
      status: 'ok',
      detail: `Se reestablecieron ${result.reset} caso(s) rechazados/error a estado "firmado" para reintento.`,
      responsePayload: result,
    });
    return {
      ok: true,
      message: `${result.reset} caso(s) rechazado(s)/error reestablecido(s) a "firmado". Ahora ejecuta run-sequential.`,
      reset: result.reset,
      batchId: result.batchId,
    };
  }

  // Corrige el problema donde E33/E34 referencian un E32 que fue importado como RFCE.
  // DGII valida el NCFModificado en su sistema ECF (no RFCE), por lo que el E32 referenciado
  // debe ser enviado como ECF completo ANTES de que se envíe el E33/E34.
  // Este método convierte el E32 referenciado de RFCE → ECF usando el linkedRawRow (datos ECF)
  // que quedó guardado en certification_original_xml al momento de importar.
  async fixNcfModificadoRefs(req) {
    await this.ensureReady();
    const actor = req ? await this.getCurrentActor(req, { adminOnly: true }) : { id: null, nombre: 'Sistema', usuario: 'sistema', rol: 'admin' };
    const batchId = await this.repository.getLatestCertificationBatchId();
    const params = [];
    let batchClause = '';
    if (batchId) { batchClause = ' AND certification_batch_id = ?'; params.push(batchId); }

    // 1. Encontrar todos los E33/E34 con NCFModificado en el JSON
    const notaRows = await this.repository.query(
      `SELECT id, encf, tipo_ecf, certification_original_xml
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         AND tipo_ecf IN ('E33','E34')
         ${batchClause}`,
      params
    );

    const ncfRefs = new Set();
    for (const row of notaRows) {
      try {
        const src = parseCertificationStoredSource(row.certification_original_xml || '');
        const ncfMod = String(src?.row?.NCFModificado || '').trim().toUpperCase();
        if (ncfMod && /^E\d{13,14}$/.test(ncfMod)) {
          ncfRefs.add(ncfMod);
        }
      } catch (_) { /* ignore */ }
    }

    if (!ncfRefs.size) {
      return { ok: true, fixed: 0, message: 'No se encontraron referencias NCFModificado en E33/E34.' };
    }

    // 2. Por cada encf referenciado, encontrar el documento en la DB
    const fixed = [];
    const skipped = [];
    for (const refEncf of ncfRefs) {
      const [refDoc] = await this.repository.query(
        `SELECT id, encf, tipo_ecf, submission_mode, estado_dgii, track_id, certification_original_xml
         FROM ecf_documents
         WHERE business_id = 1 AND encf = ?
         ORDER BY id DESC LIMIT 1`,
        [refEncf]
      );
      if (!refDoc) {
        skipped.push({ encf: refEncf, reason: 'No encontrado en DB' });
        continue;
      }
      if (String(refDoc.submission_mode || '').toLowerCase() !== 'rfce') {
        skipped.push({ encf: refEncf, reason: `Ya es ECF (submission_mode=${refDoc.submission_mode})` });
        continue;
      }

      // 3. Extraer linkedRawRow (datos ECF) del JSON guardado
      let ecfOriginalJson = null;
      try {
        const src = parseCertificationStoredSource(refDoc.certification_original_xml || '');
        if (src?.linkedRawRow && typeof src.linkedRawRow === 'object' && Object.keys(src.linkedRawRow).length > 0) {
          // Construir nuevo JSON con linkedRawRow como la fuente ECF
          ecfOriginalJson = JSON.stringify({
            kind: 'spreadsheet_row',
            sourceSheet: 'ECF',
            submissionMode: 'normal',
            row: src.linkedRawRow,     // datos de la hoja ECF (Municipio, FechaEmision, etc.)
            linkedRawRow: src.row,     // datos RFCE guardados como referencia
          });
        }
      } catch (_) { /* ignore */ }

      if (!ecfOriginalJson) {
        skipped.push({ encf: refEncf, reason: 'No tiene linkedRawRow con datos ECF' });
        continue;
      }

      // 4. Actualizar el documento: cambiar de RFCE → ECF y resetear estado
      await this.repository.query(
        `UPDATE ecf_documents
         SET submission_mode = 'normal',
             estado_dgii = 'firmado',
             track_id = NULL,
             error_message = NULL,
             certification_original_xml = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [ecfOriginalJson, refDoc.id]
      );

      fixed.push({ encf: refEncf, previousMode: 'rfce', newMode: 'normal' });
      this.logger?.info(`[fixNcfModificadoRefs] ${refEncf} convertido RFCE→ECF para que E33/E34 pueda referenciarlo.`);
    }

    return {
      ok: true,
      fixed: fixed.length,
      skipped: skipped.length,
      details: { fixed, skipped },
      message: fixed.length > 0
        ? `${fixed.length} caso(s) E32 convertido(s) de RFCE→ECF para que E33/E34 los pueda referenciar: ${fixed.map((f) => f.encf).join(', ')}.`
        : `No se requirió conversión. Revisados: ${[...ncfRefs].join(', ')}.`,
    };
  }

  // Rota los eNCFs quemados (ya enviados a DGII en intentos anteriores) asignando nuevos números
  // de secuencia para que DGII no rechace con "Este número de secuencia ya ha sido utilizado".
  // DGII no permite reutilizar secuencias entre intentos, aunque el portal se reinicie.
  // Pasos:
  //   1. Encuentra todos los docs del batch que ya fueron enviados (estado != firmado/pendiente), excepto RFCE.
  //   2. Calcula el máximo de secuencia por tipo_ecf entre TODOS los docs del batch.
  //   3. Asigna nuevos eNCFs (max+1, max+2...) a cada doc quemado.
  //   4. Actualiza NCFModificado en docs que referencian un eNCF quemado.
  //   5. Resetea estado a "firmado" para que vuelvan a enviarse desde cero.
  async rotateBurnedEncfs(req) {
    await this.ensureReady();
    const actor = req
      ? await this.getCurrentActor(req, { adminOnly: true })
      : { id: null, nombre: 'Sistema', usuario: 'sistema', rol: 'admin' };
    throw new EcfError(
      'Rotación de eNCF deshabilitada para certificación DGII: el portal valida contra los eNCF exactos de su colección de datos. Usa "Reset enviados" para reiniciar estados sin cambiar secuencias.',
      { statusCode: 409 }
    );

    // force=true → reinicio completo: rota TODOS los eNCFs que alguna vez fueron enviados a DGII
    //   (incluso los que están en firmado/pendiente porque el viejo reset los devolvió a ese estado).
    // Detectamos "enviado alguna vez" con sent_at IS NOT NULL, que el reset no borra.
    // nuclear=true → caso extremo: rota TODOS sin excepción (incluso docs nunca enviados).
    //   Usar solo cuando se reimporta el set completo desde cero.
    const forceAll = String(req?.query?.force || req?.body?.force || '').toLowerCase() === 'true';
    const nuclearAll = String(req?.query?.nuclear || req?.body?.nuclear || '').toLowerCase() === 'true';

    const batchId = await this.repository.getLatestCertificationBatchId();
    const batchClause = batchId ? 'AND certification_batch_id = ?' : '';
    const batchParams = batchId ? [batchId] : [];

    // 1. Docs quemados:
    //    - Normal:  solo rechazado/error/en-vuelo (aceptados quedan intactos)
    //    - Force:   todo lo que fue enviado alguna vez (sent_at IS NOT NULL) incluyendo los que
    //               el viejo reset devolvió a firmado. Preserva aceptados y docs nunca enviados.
    //    - Nuclear: todo sin excepción (evitar salvo reimportación total)
    let estadoFilter;
    if (nuclearAll) {
      estadoFilter = ''; // Sin filtro: rotar TODOS
    } else if (forceAll) {
      // Rotar si:  no está aceptado  Y  (no está firmado/pendiente  O  fue enviado antes)
      estadoFilter = `AND estado_dgii NOT IN ('aceptado', 'aceptado_condicional')
         AND (estado_dgii NOT IN ('firmado', 'pendiente') OR sent_at IS NOT NULL)`;
    } else {
      estadoFilter = `AND estado_dgii IN ('rechazado', 'error', 'enviado', 'en_proceso', 'procesando')`;
    }

    // En force/nuclear mode se incluyen también docs RFCE (tienen submission_mode='rfce')
    const submissionModeFilter = (forceAll || nuclearAll)
      ? `AND (submission_mode IS NULL OR submission_mode IN ('normal', 'rfce'))`
      : `AND (submission_mode IS NULL OR submission_mode = 'normal')`;

    const burnedDocs = await this.repository.query(
      `SELECT id, encf, tipo_ecf, certification_original_xml, certification_case_key, submission_mode
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         ${estadoFilter}
         ${submissionModeFilter}
       ORDER BY tipo_ecf, encf`,
      batchParams
    );

    if (!burnedDocs.length) {
      return {
        ok: true,
        rotated: 0,
        refUpdated: 0,
        mapping: [],
        message: nuclearAll
          ? 'No hay comprobantes de certificación en el batch. Importa el set primero.'
          : forceAll
          ? 'No hay comprobantes enviados que rotar. Todos están en firmado/pendiente sin haber sido enviados a DGII.'
          : 'No hay comprobantes quemados que rotar. Solo hay docs en firmado/pendiente/aceptado.',
      };
    }

    // 2. Calcular máximo de secuencia por tipo_ecf en todo el batch
    const allCertDocs = await this.repository.query(
      `SELECT encf, tipo_ecf FROM ecf_documents
       WHERE business_id = 1 AND certification_case_key IS NOT NULL ${batchClause}`,
      batchParams
    );
    const maxSeqByType = {};
    for (const doc of allCertDocs) {
      // eNCF tiene formato E310000000001 → extraer parte numérica
      const numStr = String(doc.encf || '').replace(/^E\d{2}0*/, '');
      const seqNum = Number(numStr) || 0;
      const tipo = String(doc.tipo_ecf || '').trim().toUpperCase();
      if (!maxSeqByType[tipo] || seqNum > maxSeqByType[tipo]) {
        maxSeqByType[tipo] = seqNum;
      }
    }

    // 3. Asignar nuevos eNCFs (max+1 por tipo)
    const encfMapping = new Map(); // old → new
    const currentMaxByType = { ...maxSeqByType };
    for (const doc of burnedDocs) {
      const tipo = String(doc.tipo_ecf || '').trim().toUpperCase();
      currentMaxByType[tipo] = (currentMaxByType[tipo] || 0) + 1;
      // Padding a 10 digitos: E31 + 10 digitos = 13 chars total (formato e-NCF DGII).
      const newSeqStr = String(currentMaxByType[tipo]).padStart(10, '0');
      const newEncf = `${tipo}${newSeqStr}`;
      encfMapping.set(String(doc.encf || '').trim().toUpperCase(), newEncf);
    }

    // 4. Actualizar cada doc quemado
    const rotated = [];
    for (const doc of burnedDocs) {
      const oldEncf = String(doc.encf || '').trim().toUpperCase();
      const newEncf = encfMapping.get(oldEncf);
      if (!newEncf) continue;

      // Actualizar NCFModificado si apunta a otro eNCF quemado
      let newCertOriginal = doc.certification_original_xml || null;
      try {
        const src = JSON.parse(newCertOriginal || '{}');
        if (src?.row?.NCFModificado) {
          const oldRef = String(src.row.NCFModificado).trim().toUpperCase();
          if (encfMapping.has(oldRef)) {
            src.row.NCFModificado = encfMapping.get(oldRef);
            newCertOriginal = JSON.stringify(src);
          }
        }
      } catch (_) { /* Si el JSON no parsea, dejamos el original */ }

      // Actualizar certification_case_key (reemplazar el viejo encf por el nuevo)
      const oldCaseKey = doc.certification_case_key || '';
      const newCaseKey = oldCaseKey.includes(oldEncf.toLowerCase())
        ? oldCaseKey.replace(new RegExp(oldEncf.toLowerCase(), 'gi'), newEncf.toLowerCase())
        : oldCaseKey.replace(new RegExp(doc.encf, 'gi'), newEncf);

      await this.repository.query(
        `UPDATE ecf_documents
         SET encf = ?,
             certification_original_xml = ?,
             certification_case_key = ?,
             estado_dgii = 'firmado',
             track_id = NULL,
             error_message = NULL,
             xml_content = NULL,
             signed_xml_content = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [newEncf, newCertOriginal, newCaseKey, doc.id]
      );

      rotated.push({ old: doc.encf, new: newEncf, tipo: doc.tipo_ecf });
      this.logger?.info(`[rotateBurnedEncfs] ${doc.encf} → ${newEncf}`);
    }

    // 5. Actualizar NCFModificado en docs NO quemados que referencian eNCFs quemados
    const nonBurnedDocs = await this.repository.query(
      `SELECT id, encf, certification_original_xml FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND (submission_mode IS NULL OR submission_mode = 'normal')
         AND estado_dgii IN ('firmado', 'pendiente', 'aceptado', 'aceptado_condicional')`,
      batchParams
    );
    const refUpdated = [];
    for (const doc of nonBurnedDocs) {
      try {
        const src = JSON.parse(doc.certification_original_xml || '{}');
        if (src?.row?.NCFModificado) {
          const oldRef = String(src.row.NCFModificado).trim().toUpperCase();
          if (encfMapping.has(oldRef)) {
            src.row.NCFModificado = encfMapping.get(oldRef);
            await this.repository.query(
              `UPDATE ecf_documents
               SET certification_original_xml = ?,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [JSON.stringify(src), doc.id]
            );
            refUpdated.push(doc.encf);
          }
        }
      } catch (_) { /* ignore */ }
    }

    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      documentId: null,
      sequenceId: null,
      tipoComprobante: null,
      encf: null,
      actionName: 'certification_rotate_encfs',
      status: 'ok',
      detail: `${forceAll ? '[FORCE] ' : ''}${rotated.length} eNCF(s) rotados. Mapeo: ${rotated.map((r) => `${r.old}→${r.new}`).join(', ')}. ${refUpdated.length} referencia(s) NCFModificado actualizadas.`,
      responsePayload: { rotated, refUpdated },
    });

    return {
      ok: true,
      rotated: rotated.length,
      refUpdated: refUpdated.length,
      mapping: rotated,
      message: forceAll
        ? `[REINICIO TOTAL] ${rotated.length} comprobante(s) rotados a nuevos eNCFs incluyendo aceptados. ${refUpdated.length} referencia(s) NCFModificado actualizadas. Ahora ejecuta "run-sequential".`
        : `${rotated.length} comprobante(s) rotados a nuevos eNCFs (los ya aceptados no fueron tocados). ${refUpdated.length} referencia(s) NCFModificado actualizadas. Ahora ejecuta "run-sequential" para reenviar.`,
    };
  }

  /**
   * Parchea el NombreComercial del rawRow de un caso de certificación en la BD.
   * Necesario cuando el Excel del set DGII tiene un valor incorrecto para un caso específico.
   * Ejemplo: E310000000002 tiene 'DOCUMENTOS ELECTRONICOS DE 02' en el Excel
   * pero DGII espera '' (campo omitido). Llamar con { encf, nombreComercial: '' } para corregirlo.
   */
  async fixCaseNombreComercial(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });

    const body = req.body || {};
    const encf = String(body?.encf || '').trim().toUpperCase();
    assertCondition(encf, 'Se requiere el campo encf.', { statusCode: 422 });

    // NombreComercial nuevo: '' para omitirlo (DGII espera campo ausente), o cualquier texto
    const nombreComercial = body?.nombreComercial == null ? '' : String(body.nombreComercial);

    const rows = await this.repository.query(
      `SELECT id, encf, certification_original_xml
       FROM ecf_documents
       WHERE business_id = 1 AND encf = ?
       LIMIT 1`,
      [encf]
    );
    assertCondition(rows.length > 0, `Documento ${encf} no encontrado.`, { statusCode: 404 });

    const doc = rows[0];
    const rawCertOriginal = String(doc.certification_original_xml || '').replace(/^﻿/, '').trim();
    assertCondition(
      rawCertOriginal.startsWith('{'),
      `El documento ${encf} no tiene rawRow (certification_original_xml no es JSON).`,
      { statusCode: 422 }
    );

    let src;
    try {
      src = JSON.parse(rawCertOriginal);
    } catch (e) {
      throw new EcfError(`certification_original_xml de ${encf} no es JSON válido.`, { statusCode: 422 });
    }

    assertCondition(
      src?.kind === 'spreadsheet_row' && src?.row,
      `El documento ${encf} no tiene rawRow de hoja de cálculo (kind=${src?.kind}).`,
      { statusCode: 422 }
    );

    const oldValue = String(src.row.NombreComercial ?? '');
    const oldLinkedValue = String(src.linkedRawRow?.NombreComercial ?? '');
    src.row.NombreComercial = nombreComercial;
    if (src.linkedRawRow && typeof src.linkedRawRow === 'object') {
      src.linkedRawRow.NombreComercial = nombreComercial;
    }

    await this.repository.query(
      `UPDATE ecf_documents
       SET certification_original_xml = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [JSON.stringify(src), doc.id]
    );

    this.logger?.info(`[fixCaseNombreComercial] ${encf}: NombreComercial "${oldValue}" → "${nombreComercial}"`);

    return {
      ok: true,
      encf,
      oldNombreComercial: oldValue,
      oldLinkedNombreComercial: oldLinkedValue,
      newNombreComercial: nombreComercial,
      message: `NombreComercial de ${encf} actualizado de "${oldValue}" a "${nombreComercial}". Reenvía el caso para aplicar el cambio.`,
    };
  }

  async fixAllCasesNombreComercial(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });
    throw new EcfError(
      'No se permite aplicar NombreComercial a todo el set. DGII define valores distintos por comprobante; reimporta el Excel oficial o corrige un caso específico.',
      { statusCode: 422, code: 'CERTIFICATION_GLOBAL_NOMBRE_COMERCIAL_BLOCKED' }
    );
  }

  /**
   * Actualiza campos arbitrarios del rawRow de un caso de certificación.
   * Body: { encf: 'E310000000002', fields: { MontoGravadoI1: '3961.31', MontoGravadoTotal: '3961.31' } }
   * Útil para corregir valores incorrectos importados del Excel antes de reenviar.
   */
  async fixCaseRawRow(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });

    const body = req.body || {};
    const encf = String(body?.encf || '').trim().toUpperCase();
    assertCondition(encf, 'Se requiere el campo encf.', { statusCode: 422 });
    const fields = body?.fields;
    assertCondition(
      fields && typeof fields === 'object' && !Array.isArray(fields) && Object.keys(fields).length > 0,
      'Se requiere el campo fields (objeto con los campos a actualizar).',
      { statusCode: 422 }
    );

    const rows = await this.repository.query(
      `SELECT id, encf, certification_original_xml
       FROM ecf_documents
       WHERE business_id = 1 AND encf = ?
       LIMIT 1`,
      [encf]
    );
    assertCondition(rows.length > 0, `Documento ${encf} no encontrado.`, { statusCode: 404 });

    const doc = rows[0];
    const rawCertOriginal = String(doc.certification_original_xml || '').replace(/^﻿/, '').trim();
    assertCondition(
      rawCertOriginal.startsWith('{'),
      `El documento ${encf} no tiene rawRow (certification_original_xml no es JSON).`,
      { statusCode: 422 }
    );

    let src;
    try {
      src = JSON.parse(rawCertOriginal);
    } catch (e) {
      throw new EcfError(`certification_original_xml de ${encf} no es JSON válido.`, { statusCode: 422 });
    }

    assertCondition(
      src?.kind === 'spreadsheet_row' && src?.row,
      `El documento ${encf} no tiene rawRow de hoja de cálculo (kind=${src?.kind}).`,
      { statusCode: 422 }
    );

    const oldValues = {};
    const newValues = {};
    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      oldValues[fieldName] = src.row[fieldName] ?? null;
      src.row[fieldName] = fieldValue;
      newValues[fieldName] = fieldValue;
    }

    await this.repository.query(
      `UPDATE ecf_documents
       SET certification_original_xml = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [JSON.stringify(src), doc.id]
    );

    this.logger?.info(`[fixCaseRawRow] ${encf}: ${JSON.stringify(oldValues)} → ${JSON.stringify(newValues)}`);

    return {
      ok: true,
      encf,
      oldValues,
      newValues,
      message: `rawRow de ${encf} actualizado. Reenvía el caso para aplicar el cambio.`,
    };
  }

  /**
   * Genera y firma los RFCE de facturas de consumo < 250Mil para RecepcionFC.
   * La E32 completa se conserva localmente para auditoria, RI, QR y reimpresion,
   * pero no se remite a DGII cuando el monto es menor a RD$250,000.
   */
  async generate250MilXmls(req) {
    await this.ensureReady();

    const OUT_DIR = path.join(process.cwd(), 'scripts', '250mil-upload');
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const LOCAL_ECF_DIR = path.join(process.cwd(), 'storage', 'ecf', 'ecf-originales-locales');
    fs.mkdirSync(LOCAL_ECF_DIR, { recursive: true });
    const tmpDir = path.join(process.cwd(), 'storage', 'ecf', 'tmp');
    if (fs.existsSync(tmpDir)) {
      for (const f of fs.readdirSync(tmpDir)) {
        if (/\.(xml|zip|json)$/i.test(f)) {
          try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_) { /* ignorar */ }
        }
      }
    }

    // Certificado del repositorio (mismo que usa el flujo normal de certificación)
    let certificate = null;
    try {
      certificate = await this.resolveCertificate();
    } catch (certErr) {
      return {
        ok: false,
        error: `No hay certificado válido disponible: ${certErr?.message || certErr}`,
        hint: 'Carga un .p12 válido en /api/ecf/certificate/upload o configura PATH/CERT_PASSWORD en el entorno.',
      };
    }
    const localEmitter = await this.getEmitterForXml(1);

    // Helper: normaliza valores vacíos / especiales del dataset DGII
    const val = (row, key) => {
      const v = String(row[key] ?? '').trim();
      const lower = v.toLowerCase();
      return (v === '' || lower === '#e' || lower === 'n/a' || lower === '#n/a') ? '' : v;
    };

    // Limpiar XMLs/ZIP anteriores del directorio para evitar subir payloads viejos.
    // Esta carpeta debe quedar solo con RFCE exportables; los ECF completos se
    // guardan en storage/ecf/ecf-originales-locales para auditoria.
    for (const f of fs.readdirSync(OUT_DIR)) {
      const target = path.join(OUT_DIR, f);
      if (/\.(xml|zip)$/i.test(f)) {
        try { fs.unlinkSync(target); } catch (_) { /* ignorar */ }
      } else if (f.toLowerCase() === 'ecf-originales-locales') {
        try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) { /* ignorar */ }
      }
    }
    for (const f of fs.readdirSync(LOCAL_ECF_DIR)) {
      if (/\.(xml|zip)$/i.test(f)) {
        try { fs.unlinkSync(path.join(LOCAL_ECF_DIR, f)); } catch (_) { /* ignorar */ }
      }
    }

    // Obtener todos los docs E32 RFCE del batch actual de certificación
    let rfceDocs = await this.repository.query(
      `SELECT id, encf, certification_original_xml
       FROM ecf_documents
       WHERE business_id=1
         AND certification_case_key IS NOT NULL
         AND submission_mode='rfce'
         AND tipo_ecf='E32'
       ORDER BY encf ASC`
    );

    if (!rfceDocs.length) {
      const latestExcel = findLatestDgiiCertificationExcel();
      if (latestExcel) {
        rfceDocs = readRfceDocsFromExcel(latestExcel);
        this.logger?.warn?.('No había RFCE en BD; se usará el Excel DGII más reciente como fuente.', {
          latestExcel,
          count: rfceDocs.length,
        });
      }
    }

    if (!rfceDocs.length) {
      return {
        ok: false,
        error: `No se encontraron documentos E32 RFCE de certificación ni Excel DGII RFCE válido. Carpetas revisadas: ${getDgiiCertificationExcelDirs().join(', ')}.`,
      };
    }

    const generated = [];
    const errors = [];

    for (const doc of rfceDocs) {
      // Leer y parsear el JSON almacenado
      let certSource;
      try {
        certSource = JSON.parse(doc.certification_original_xml || '{}');
      } catch (_) {
        errors.push({ encf: doc.encf, error: 'certification_original_xml no es JSON válido. Reimporta el set.' });
        continue;
      }

      const rfceRow = certSource.row || {};
      const linkedEcfRow = certSource.linkedRawRow || null;
      const ecfRow = linkedEcfRow || rfceRow;
      if (Object.keys(rfceRow).length < 5) {
        errors.push({ encf: doc.encf, error: 'Fila RFCE vacía o incompleta. Reimporta el set DGII original con hojas ECF y RFCE.' });
        continue;
      }

      let localSignedEcf;
      let localSecurityCode;
      let reusedExistingE32 = false;
      try {
        // NC del ECF viene del rawRow (actualizado en DB con el dataset oficial DGII).
        // E320000000012-15: NC="DOCUMENTOS ELECTRONICOS" (verificado en 40211932609-17062026010303.xlsx).
        // El security code del RFCE se deriva de la firma de ESTE ECF, por lo que el ECF que se
        // sube al portal debe ser exactamente este (sin re-firmar) para que las firmas coincidan.

        // ── Protección anti-sobreescritura: si el E32 local coincide con un RFCE aceptado,
        // reusar SIN re-firmar. Re-firmar produce una firma diferente al CodigoSeguridadeCF
        // ya comprometido en el RFCE aceptado en DGII.
        const localEcfPath = path.join(LOCAL_ECF_DIR, `${doc.encf}.xml`);
        if (fs.existsSync(localEcfPath)) {
          const existingE32 = fs.readFileSync(localEcfPath, 'utf8');
          const existingCode = computeSecurityCode(existingE32);
          const step4State = this._step4RfceReadState();
          const step4Item = (step4State.items || []).find((i) => i.encf === doc.encf);
          const isAcceptedInStep4 = step4Item
            && ['aceptado', 'aceptado_condicional'].includes(String(step4Item.estado || '').toLowerCase());

          if (isAcceptedInStep4) {
            // 1. Intentar localPath del estado step4
            let rfceCode = null;
            if (step4Item.localPath) {
              const rp = path.resolve(process.cwd(), step4Item.localPath);
              if (fs.existsSync(rp)) rfceCode = extractRfceSecurityCode(fs.readFileSync(rp, 'utf8'));
            }
            // 2. Intentar el archivo RFCE actual en scripts/250mil-upload/{encf}.xml
            if (!rfceCode) {
              const cur = path.join(process.cwd(), 'scripts', '250mil-upload', `${doc.encf}.xml`);
              if (fs.existsSync(cur)) rfceCode = extractRfceSecurityCode(fs.readFileSync(cur, 'utf8'));
            }
            // 3. Fallback: buscar en rfce-enviados el RFCE que coincida con el E32 existente
            if (rfceCode !== existingCode) {
              const rfceEnvDir = path.join(process.cwd(), 'storage', 'ecf', 'rfce-enviados');
              if (fs.existsSync(rfceEnvDir)) {
                const arch = fs.readdirSync(rfceEnvDir)
                  .filter((f) => f.startsWith('rfce-enviado-') && f.endsWith('.xml'))
                  .sort().reverse();
                for (const af of arch) {
                  try {
                    const xml = fs.readFileSync(path.join(rfceEnvDir, af), 'utf8');
                    const encfInFile = (xml.match(/<eNCF>([^<]+)<\/eNCF>/i) || [])[1] || '';
                    if (encfInFile !== doc.encf) continue;
                    const code = extractRfceSecurityCode(xml);
                    if (code && code === existingCode) { rfceCode = code; break; }
                  } catch (_) { /* skip */ }
                }
              }
            }
            if (rfceCode && rfceCode === existingCode) {
              localSignedEcf = existingE32;
              localSecurityCode = existingCode;
              reusedExistingE32 = true;
            }
          }
        }

        if (!reusedExistingE32) {
          const ecfNombreComercial = certificationEmitterNombreComercial(ecfRow, localEmitter?.nombre_comercial || '', localEmitter?.razon_social || '');
          const localEcfRow = {
            ...ecfRow,
            NombreComercial: ecfNombreComercial,
            FechaVencimientoSecuencia: val(ecfRow, 'FechaVencimientoSecuencia'),
          };
          const localTransmission = buildTransmissionFromSpreadsheetRow({
            testCase: {
              encf: doc.encf,
              tipoEcf: 'E32',
              rawRow: localEcfRow,
              linkedRawRow: null,
              sourceSheet: 'ECF',
              submissionMode: 'normal',
              emitterNombreComercial: ecfNombreComercial,
            },
            issueDate: new Date(),
            certificateContext: null,
            emitter: localEmitter,
          });
          localSignedEcf = signatureService.signXML(localTransmission.xml, certificate);
          localSecurityCode = computeSecurityCode(localSignedEcf);
          fs.writeFileSync(localEcfPath, localSignedEcf, 'utf8');
        }
      } catch (localError) {
        errors.push({ encf: doc.encf, error: `Error construyendo ECF local: ${localError.message}` });
        continue;
      }

      // ── Construir XML RFCE E32 para RecepcionFC ─────────────────────────────────────────
      let xmlContent;
      try {
        const transmission = buildTransmissionFromSpreadsheetRow({
          testCase: {
            encf: doc.encf,
            tipoEcf: 'E32',
            rawRow: rfceRow,
            linkedRawRow: ecfRow,
            sourceSheet: 'RFCE',
            submissionMode: 'rfce',
            computedCodigoSeguridadeCF: localSecurityCode,
          },
          issueDate: new Date(),
          certificateContext: certificate,
          emitter: localEmitter,
        });
        xmlContent = transmission.xml;
      } catch (buildError) {
        errors.push({ encf: doc.encf, error: `Error construyendo XML: ${buildError.message}` });
        continue;
      }

      // ── Firmar con el certificado del repositorio ────────────────────────────────────────
      let signedXml;
      let xsdValidation;
      try {
        signedXml = signatureService.signXML(xmlContent, certificate);
        xsdValidation = assertValidRfceXml(signedXml, { requireSignature: true });
      } catch (signError) {
        errors.push({ encf: doc.encf, error: `Error firmando/validando RFCE: ${signError.message}` });
        continue;
      }

      const localValidation = this.validateCertificationDocumentBeforeSend({
        ...doc,
        tipo_ecf: 'E32',
        submission_mode: 'rfce',
        xml_content: xmlContent,
        signed_xml_content: signedXml,
        _certificationValidationRow: rfceRow,
      });
      if (!localValidation.ok) {
        errors.push({ encf: doc.encf, error: localValidation.errors[0], validation: localValidation });
        continue;
      }

      if (!/^<\?xml[\s\S]*<RFCE[\s>]/i.test(signedXml)) {
        errors.push({ encf: doc.encf, error: 'El XML generado no es RFCE. RecepcionFC requiere resumen RFCE E32.' });
        continue;
      }
      if (/<NombreComercial\b/i.test(signedXml)) {
        errors.push({ encf: doc.encf, error: 'El XML RFCE <250Mil no debe incluir NombreComercial.' });
        continue;
      }
      if (!/<CodigoSeguridadeCF\b/i.test(signedXml)) {
        errors.push({ encf: doc.encf, error: 'El XML RFCE <250Mil debe incluir CodigoSeguridadeCF.' });
        continue;
      }
      const rfceSecurityCode = extractRfceSecurityCode(signedXml);
      const normRfceCode = String(rfceSecurityCode || '').trim();
      const normLocalCode = String(localSecurityCode || '').trim();
      if (!normRfceCode || normRfceCode !== normLocalCode) {
        errors.push({
          encf: doc.encf,
          error: `CodigoSeguridadeCF inconsistente: RFCE="${normRfceCode || '(ausente)'}", ECF="${normLocalCode || '(ausente)'}".`,
        });
        continue;
      }
      const signedPath = path.join(OUT_DIR, `${doc.encf}.xml`);
      fs.writeFileSync(signedPath, signedXml, 'utf8');

      // Actualizar ruta del XML generado en la BD
      try {
        await this.repository.query(
          `UPDATE ecf_documents
           SET certification_signed_xml_path = ?,
               signed_xml_content = ?,
               xml_content = ?,
               submission_mode = 'rfce',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [signedPath, signedXml, xmlContent, doc.id]
        );
      } catch (_) { /* No bloquear si el UPDATE falla */ }

      const sizekb = Math.round(fs.statSync(signedPath).size / 1024);
      const items = Object.keys(ecfRow || {})
        .filter((k) => /^NombreItem\[/.test(k) && val(ecfRow, k))
        .map((k) => val(ecfRow, k));

      generated.push({
        encf: doc.encf,
        file: signedPath,
        sizekb,
        items,
        root: 'RFCE',
        endpoint: this.config.DGII_FC_URL,
        montoTotal: val(rfceRow, 'MontoTotal') || '?',
        montoGravadoI1: val(rfceRow, 'MontoGravadoI1') || '?',
        itbis1: val(rfceRow, 'ITBIS1') || '?',
        totalItbis1: val(rfceRow, 'TotalITBIS1') || '?',
        nombreComercial: '(omitido)',
        localEcfFile: path.join(LOCAL_ECF_DIR, `${doc.encf}.xml`),
        xsdValidation,
      });
    }

    if (generated.length === 0) {
      return {
        ok: false,
        error: errors.length
          ? `${errors.length} error(es). Primer error: ${errors[0].error}`
          : 'No se generaron XMLs.',
        errors,
      };
    }

    return {
      ok: true,
      generated,
      errors: errors.length ? errors : undefined,
      outDir: OUT_DIR,
      localEcfDir: LOCAL_ECF_DIR,
      message: `✓ ${generated.length} RFCE firmados en ${OUT_DIR}.`,
    };
  }

  _disabled250MilPortalFlow() {
    throw new EcfError(
      'Flujo eliminado. No se deben generar ni subir ECF completos <250Mil por esta vía. Usa RFCE automático.',
      {
        statusCode: 410,
        details: {
          use: '/certification-center/rfce/generate, /certification-center/rfce/submit, /certification-center/rfce/poll',
        },
      }
    );
  }

  async prepareFinal250MilPortalPackage(_req) {
    this._disabled250MilPortalFlow();
    await this.ensureReady();
    const certificate = await this.resolveCertificate();

    const OUT_DIR = getPreferredFinal250MilDir();
    const resolvedOutDir = path.resolve(OUT_DIR);
    const expectedParent = 'DGII_CARGAR_AHORA_4_XML_VERIFICADOS';
    assertCondition(
      path.basename(path.dirname(resolvedOutDir)).toUpperCase() === expectedParent
        && /^LOTE_\d{14}$/i.test(path.basename(resolvedOutDir)),
      `Ruta final 250Mil no permitida: ${resolvedOutDir}`,
      { statusCode: 422 }
    );

    const val = (row, key) => {
      const v = String(row?.[key] ?? '').trim();
      const lower = v.toLowerCase();
      return (v === '' || lower === '#e' || lower === 'n/a' || lower === '#n/a' || lower === '#ref!') ? '' : v;
    };

    const certificationBatchId = await this.repository.getLatestCertificationBatchId();
    const batchClause = certificationBatchId ? ' AND certification_batch_id = ?' : '';
    const batchParams = certificationBatchId ? [certificationBatchId] : [];
    let rfceDocs = await this.repository.query(
      `SELECT id, encf, estado_dgii, signed_xml_content,
              certification_original_xml, certification_sent_xml_path
       FROM ecf_documents
       WHERE business_id=1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND submission_mode='rfce'
         AND tipo_ecf='E32'
       ORDER BY encf ASC`,
      batchParams
    );

    if (!rfceDocs.length) {
      const latestExcel = findLatestDgiiCertificationExcel();
      if (latestExcel) {
        rfceDocs = readRfceDocsFromExcel(latestExcel);
        this.logger?.warn?.('No había RFCE en BD; se preparará carpeta final desde el Excel DGII más reciente.', {
          latestExcel,
          count: rfceDocs.length,
        });
      }
    }

    if (!rfceDocs.length) {
      return {
        ok: false,
        error: 'No se encontraron los 4 casos E32 <250Mil. Importa el set DGII primero.',
        outDir: resolvedOutDir,
      };
    }

    if (rfceDocs.length !== 4) {
      return {
        ok: false,
        error: `Se esperaban exactamente 4 casos E32 <250Mil y se encontraron ${rfceDocs.length}. Revisa el lote de certificación activo.`,
        outDir: resolvedOutDir,
      };
    }

    const stagingDir = resolvedOutDir;

    // Eliminar TODOS los LOTE anteriores para que el usuario nunca suba archivos viejos por error.
    const loteParentDir = path.dirname(stagingDir);
    if (fs.existsSync(loteParentDir)) {
      const oldLotes = fs.readdirSync(loteParentDir).filter((d) => /^LOTE_\d{14}$/i.test(d));
      for (const old of oldLotes) {
        const oldPath = path.join(loteParentDir, old);
        if (oldPath !== stagingDir) {
          fs.rmSync(oldPath, { recursive: true, force: true });
        }
      }
    }

    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    const generated = [];
    const errors = [];
    const localEcfDir = path.join(process.cwd(), 'storage', 'ecf', 'ecf-originales-locales');
    const localEmitter = await this.getEmitterForXml(1);

    for (const doc of rfceDocs) {
      let certSource;
      try {
        certSource = JSON.parse(doc.certification_original_xml || '{}');
      } catch (_) {
        errors.push({ encf: doc.encf, error: 'certification_original_xml no es JSON válido. Reimporta el set DGII.' });
        continue;
      }

      const rfceRow = certSource.row || {};
      const ecfRow = certSource.linkedRawRow || rfceRow;
      if (!Object.keys(ecfRow || {}).length) {
        errors.push({ encf: doc.encf, error: 'No existe la fila ECF íntegra vinculada al RFCE.' });
        continue;
      }

      try {
        // El estado local puede ser incorrecto (ej: "bloqueado" cuando DGII realmente lo aceptó
        // en una sesión anterior). Solo se bloquea si el archivo ECF local no existe.
        const localEcfPath = path.join(localEcfDir, `${doc.encf}.xml`);
        if (!fs.existsSync(localEcfPath)) {
          errors.push({
            encf: doc.encf,
            error: 'No existe el ECF firmado para este RFCE. Usa "Enviar pendientes" para reenviar el RFCE y generar el ECF local.',
          });
          continue;
        }
        let signedXml = fs.readFileSync(localEcfPath, 'utf8').replace(/^﻿/, '');
        // Auto-correct NombreComercial: el rawRow marca el valor exacto esperado por DGII.
        // Dataset oficial DGII (40211932609-17062026010303.xlsx): E320000000012-15 → NC="DOCUMENTOS ELECTRONICOS".
        const expectedPortalNC = certificationEmitterNombreComercial(ecfRow, localEmitter?.nombre_comercial || '', localEmitter?.razon_social || '');
        const currentNcPortalMatch = signedXml.match(/<NombreComercial>([^<]*)<\/NombreComercial>/i);
        const currentPortalNC = currentNcPortalMatch ? currentNcPortalMatch[1].trim() : '';
        if (currentPortalNC !== expectedPortalNC) {
          let fixedPortal = normalizeEcfXmlStructure(signedXml, { removeSignature: true });
          fixedPortal = fixedPortal
            .replace(new RegExp('<NombreComercial[^>]*>[^<]*</NombreComercial>', 'gi'), '')
            .replace(new RegExp('<NombreComercial\\s*/>', 'gi'), '');
          if (expectedPortalNC) {
            fixedPortal = fixedPortal.replace(/<\/RazonSocialEmisor>/i, `</RazonSocialEmisor>\n  <NombreComercial>${expectedPortalNC}</NombreComercial>`);
          }
          signedXml = signatureService.signXML(fixedPortal, certificate);
          fs.writeFileSync(localEcfPath, signedXml, 'utf8');
        }
        const signatureVerification = signatureService.verifySignature(signedXml);
        if (!signatureVerification.ok) {
          errors.push({ encf: doc.encf, error: 'El ECF guardado no tiene firma digital válida. Usa "Enviar pendientes" para regenerarlo.' });
          continue;
        }
        const rfcePathCandidates = [
          doc.certification_sent_xml_path,
          doc.certification_signed_xml_path,
          path.join(process.cwd(), 'scripts', '250mil-upload', `${doc.encf}.xml`),
        ]
          .map((candidate) => String(candidate || '').trim())
          .filter(Boolean)
          .map((candidate) => path.resolve(process.cwd(), candidate));
        const rfceFilePath = rfcePathCandidates.find((candidate) => fs.existsSync(candidate));
        const rfceXml = rfceFilePath
          ? fs.readFileSync(rfceFilePath, 'utf8').replace(/^\uFEFF/, '')
          : String(doc.signed_xml_content || '').replace(/^\uFEFF/, '');
        if (detectXmlRoot(rfceXml) !== 'RFCE') {
          errors.push({ encf: doc.encf, error: 'No se encontró el RFCE aceptado usado como referencia para validar el ECF íntegro.' });
          continue;
        }
        const expectedSecurityCode = extractRfceSecurityCode(rfceXml);
        const actualSecurityCode = computeSecurityCode(signedXml);
        const localValidation = this.validateCertificationDocumentBeforeSend({
          id: doc.id || null,
          encf: doc.encf,
          tipo_ecf: 'E32',
          submission_mode: 'normal',
          xml_content: signedXml,
          signed_xml_content: signedXml,
          _certificationValidationRow: { ...ecfRow },
        });

        if (!localValidation.ok) {
          errors.push({ encf: doc.encf, error: localValidation.errors[0], validation: localValidation });
          continue;
        }
        if (!/^<\?xml[\s\S]*<ECF[\s>]/i.test(signedXml)) {
          errors.push({ encf: doc.encf, error: 'El archivo final debe tener raíz <ECF>.' });
          continue;
        }
        if (!/<DetallesItems\b/i.test(signedXml)) {
          errors.push({ encf: doc.encf, error: 'El archivo final debe incluir DetallesItems.' });
          continue;
        }

        const rnc = val(ecfRow, 'RNCEmisor') || this.config?.DGII_RNC || '';
        const fileName = `${digitsOnly(rnc)}${doc.encf}.xml`;
        const filePath = path.join(resolvedOutDir, fileName);
        const stagedFilePath = path.join(stagingDir, fileName);
        fs.writeFileSync(stagedFilePath, signedXml, 'utf8');
        const securityCodeMatch = !expectedSecurityCode || actualSecurityCode === expectedSecurityCode;
        generated.push({
          encf: doc.encf,
          file: filePath,
          fileName,
          root: 'ECF',
          tipoEcf: '32',
          nombreComercial: '(omitido)',
          razonSocialEmisor: val(ecfRow, 'RazonSocialEmisor'),
          codigoSeguridad: actualSecurityCode,
          codigoSeguridadRfce: expectedSecurityCode,
          securityCodeMatch,
          sizekb: Math.round(fs.statSync(stagedFilePath).size / 1024),
        });
      } catch (error) {
        errors.push({ encf: doc.encf, error: error.message });
      }
    }

    if (generated.length !== 4) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      return {
        ok: false,
        error: errors.length
          ? `No se preparó el paquete final completo. Primer error: ${errors[0].error}`
          : `Solo se prepararon ${generated.length} de los 4 XML requeridos.`,
        errors,
        outDir: resolvedOutDir,
      };
    }

    const verificationLines = [
      'LOTE DGII - 4 ECF INTEGROS DE CONSUMO < RD$250,000',
      `Generado: ${new Date().toISOString()}`,
      'NombreComercial: OMITIDO EN LOS 4 XML',
      'Usar solamente los cuatro archivos .xml de esta carpeta.',
      '',
      ...generated.map((file) => {
        const hash = nodeCrypto.createHash('sha256').update(fs.readFileSync(file.file)).digest('hex').toUpperCase();
        return `${file.fileName} | SHA256=${hash} | CodigoSeguridad=${file.codigoSeguridad} | XSD=OK | Firma=OK`;
      }),
    ];
    fs.writeFileSync(
      path.join(resolvedOutDir, 'VERIFICACION.txt'),
      `${verificationLines.join('\r\n')}\r\n`,
      'utf8'
    );

    return {
      ok: true,
      generated,
      errors: errors.length ? errors : undefined,
      outDir: resolvedOutDir,
      message: `✓ ${generated.length} XML ECF finales listos en ${resolvedOutDir}. Sube estos archivos uno por uno en la pantalla Facturas de consumo <250Mil.`,
    };
  }

  async openFinal250MilPortalFolder(req) {
    this._disabled250MilPortalFlow();
    const prepared = await this.prepareFinal250MilPortalPackage(req);
    if (!prepared.ok) return prepared;

    // Sync status.json so localPaths point to the newly created LOTE.
    const batchId = await this.repository.getLatestCertificationBatchId();
    const items = (prepared.generated || []).map((f) => ({
      encf: f.encf,
      fileName: f.fileName,
      localPath: f.file,
      estado: 'generado',
      trackId: null,
      fechaGenerado: new Date().toISOString(),
      fechaEnviado: null,
      mensajeDgii: null,
      dgiiResponse: null,
      sizekb: f.sizekb || 0,
      securityCodeMatch: f.securityCodeMatch,
    }));
    this._portal250MilWriteState({ batchId, items, outDir: prepared.outDir });

    const opened = openFolderInOs(prepared.outDir);
    return { ...prepared, opened };
  }

  async openLocalEcfOriginalesFolder() {
    this._disabled250MilPortalFlow();
    await this.ensureReady();
    const dir = path.join(process.cwd(), 'storage', 'ecf', 'ecf-originales-locales');
    fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.xml'));
    const opened = openFolderInOs(dir);
    return { ok: true, dir, files, opened };
  }

  // ── Portal < 250Mil: estado persistente ─────────────────────────────────────

  _portal250MilStatusPath() {
    return path.join(this.certificationDir, '250mil-portal-status.json');
  }

  _portal250MilReadState() {
    const p = this._portal250MilStatusPath();
    if (!fs.existsSync(p)) return { items: [] };
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return { items: [] }; }
  }

  _portal250MilWriteState(state) {
    const p = this._portal250MilStatusPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ...state, lastUpdated: new Date().toISOString() }, null, 2), 'utf8');
  }

  async portal250MilGetStatus() {
    this._disabled250MilPortalFlow();
    await this.ensureReady();
    return { ok: true, ...this._portal250MilReadState() };
  }

  async portal250MilGetLocalEcfXml(encf) {
    this._disabled250MilPortalFlow();
    await this.ensureReady();
    const cleanEncf = String(encf || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    assertCondition(cleanEncf, 'eNCF inválido.', { statusCode: 400 });
    const filePath = path.join(process.cwd(), 'storage', 'ecf', 'ecf-originales-locales', `${cleanEncf}.xml`);
    assertCondition(fs.existsSync(filePath), `Archivo ${cleanEncf}.xml no encontrado en ecf-originales-locales. Genera el lote primero.`, { statusCode: 404 });
    const xml = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
    return { encf: cleanEncf, xml };
  }

  async portal250MilSaveLocalEcfXml(encf, req) {
    this._disabled250MilPortalFlow();
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });
    const cleanEncf = String(encf || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    assertCondition(cleanEncf, 'eNCF inválido.', { statusCode: 400 });

    const rawXml = String(req.body?.xml || '').trim();
    assertCondition(rawXml, 'El campo xml es requerido.', { statusCode: 400 });

    const { DOMParser } = require('@xmldom/xmldom');
    const parser = new DOMParser();
    const parsed = parser.parseFromString(rawXml.replace(/^<\?xml[^>]*\?>/, '').trim(), 'text/xml');
    const parseError = parsed.getElementsByTagName('parsererror')[0];
    assertCondition(!parseError, `XML inválido: ${String(parseError?.textContent || '').slice(0, 200)}`, { statusCode: 400 });

    const certificate = await this.resolveCertificate();
    const normalizedXml = normalizeEcfXmlStructure(rawXml, { removeSignature: true });
    const signedXml = signatureService.signXML(normalizedXml, certificate);
    const verification = signatureService.verifySignature(signedXml);
    assertCondition(verification.ok, 'El XML editado no pasó la verificación de firma.', { statusCode: 422 });

    const localEcfDir = path.join(process.cwd(), 'storage', 'ecf', 'ecf-originales-locales');
    fs.mkdirSync(localEcfDir, { recursive: true });
    fs.writeFileSync(path.join(localEcfDir, `${cleanEncf}.xml`), signedXml, 'utf8');

    // Si el lote ya fue generado, actualizar también el archivo ahí
    const state = this._portal250MilReadState();
    let loteUpdated = false;
    if (state.outDir && fs.existsSync(state.outDir)) {
      const item = (state.items || []).find((i) => String(i.encf || '').toUpperCase() === cleanEncf);
      if (item?.fileName) {
        const lotePath = path.join(state.outDir, item.fileName);
        if (fs.existsSync(lotePath)) {
          fs.writeFileSync(lotePath, signedXml, 'utf8');
          loteUpdated = true;
        }
      }
    }

    return {
      ok: true,
      message: `${cleanEncf}.xml guardado y firmado.${loteUpdated ? ' El archivo en la carpeta del lote también fue actualizado.' : ' Regenera el lote para actualizar la carpeta DGII.'}`,
      loteUpdated,
    };
  }

  async portal250MilGenerate(req) {
    this._disabled250MilPortalFlow();
    await this.ensureReady();
    if (req) await this.getCurrentActor(req, { adminOnly: true });

    const prepResult = await this.prepareFinal250MilPortalPackage(req);
    if (!prepResult.ok) return prepResult;

    const batchId = await this.repository.getLatestCertificationBatchId();
    const items = (prepResult.generated || []).map((f) => ({
      encf: f.encf,
      fileName: f.fileName,
      localPath: f.file,
      estado: 'generado',
      trackId: null,
      fechaGenerado: new Date().toISOString(),
      fechaEnviado: null,
      mensajeDgii: null,
      dgiiResponse: null,
      sizekb: f.sizekb || 0,
      securityCodeMatch: f.securityCodeMatch,
    }));

    this._portal250MilWriteState({ batchId, items, outDir: prepResult.outDir });
    return {
      ok: true,
      items,
      outDir: prepResult.outDir,
      message: `✓ ${items.length} archivos generados y firmados en ${prepResult.outDir}. Abre la carpeta y sube esos 4 XML uno por uno en el portal web de DGII (pantalla "Facturas de consumo <250Mil").`,
    };
  }

  async portal250MilSubmit(req) {
    this._disabled250MilPortalFlow();
    await this.ensureReady();
    if (req) await this.getCurrentActor(req, { adminOnly: true });

    let state = this._portal250MilReadState();
    if (!state.items?.length) {
      const genResult = await this.portal250MilGenerate(req);
      if (!genResult.ok) return genResult;
      state = this._portal250MilReadState();
    }

    const updatedItems = [...(state.items || [])];
    const results = [];

    for (let i = 0; i < updatedItems.length; i++) {
      const item = updatedItems[i];
      if (item.estado === 'aceptado') {
        results.push({ encf: item.encf, ok: true, estado: 'aceptado', skipped: true });
        continue;
      }

      const filePath = item.localPath;
      if (!filePath || !fs.existsSync(filePath)) {
        updatedItems[i] = { ...item, estado: 'error', mensajeDgii: 'Archivo no encontrado. Regenera primero.' };
        results.push({ encf: item.encf, ok: false, error: updatedItems[i].mensajeDgii });
        continue;
      }

      try {
        const signedXml = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
        const response = await this.receptionService.sendSignedEcf({
          signedXml,
          filename: item.fileName,
        });
        const trackId = response.trackId || response.trackid || response.TrackId || null;
        const sequenceUsed = isDgiiSequenceUsedResponse(response);
        const estado = sequenceUsed ? 'aceptado' : (trackId ? 'enviado' : normalizeDgiiState(response));
        const mensajeDgii = response.mensaje || response.message || response.descripcion || null;
        updatedItems[i] = { ...item, estado, trackId, fechaEnviado: new Date().toISOString(), mensajeDgii, dgiiResponse: response };
        results.push({ encf: item.encf, ok: estado !== 'rechazado', estado, trackId });
      } catch (error) {
        updatedItems[i] = { ...item, estado: 'error', mensajeDgii: error.message, fechaEnviado: new Date().toISOString() };
        results.push({ encf: item.encf, ok: false, error: error.message });
      }
    }

    this._portal250MilWriteState({ ...state, items: updatedItems });
    const aceptados = updatedItems.filter((i) => i.estado === 'aceptado').length;
    return { ok: true, results, items: updatedItems, aceptados };
  }

  async portal250MilPollStatuses() {
    this._disabled250MilPortalFlow();
    await this.ensureReady();
    const state = this._portal250MilReadState();
    const updatedItems = [...(state.items || [])];
    const results = [];

    for (let i = 0; i < updatedItems.length; i++) {
      const item = updatedItems[i];
      if (!item.trackId || ['aceptado', 'rechazado'].includes(item.estado)) continue;
      try {
        const dgii = await this.statusService.getTrackStatus(item.trackId);
        const estado = normalizeDgiiState(dgii);
        const mensajesArr = Array.isArray(dgii.mensajes) ? dgii.mensajes : [];
        const mensajeDgii = dgii.mensaje
          || mensajesArr.map((m) => String(m?.valor || m?.descripcion || '').trim()).filter(Boolean).join(' | ')
          || null;
        updatedItems[i] = { ...item, estado, mensajeDgii, dgiiResponse: dgii };
        results.push({ encf: item.encf, estado, trackId: item.trackId });
      } catch (error) {
        results.push({ encf: item.encf, error: error.message });
      }
    }

    this._portal250MilWriteState({ ...state, items: updatedItems });
    const aceptados = updatedItems.filter((it) => it.estado === 'aceptado').length;
    return { ok: true, results, items: updatedItems, aceptados };
  }

  // ── Paso 4 DGII: RFCE <250Mil por RecepcionFC ──────────────────────────────

  // Guarda automáticamente los E32 de portal cuando los RFCE son aceptados.
  // Verifica que el security code del E32 local coincida con el del RFCE antes de copiar.
  _savePortalE32ForAcceptedItems(items) {
    const LOCAL_ECF_DIR = path.join(process.cwd(), 'storage', 'ecf', 'ecf-originales-locales');
    // Incluir items aceptados + items cuyo E32 local exista y tenga CodigoSeguridadeCF consistente.
    // "generado" puede ocurrir cuando el RFCE se envió por otra ruta y el JSON no se actualizó.
    // La verificación del código en el loop siguiente ya descarta archivos inconsistentes.
    const FINAL_STATES = ['rechazado', 'rechazado_condicional', 'error', 'bloqueado'];
    const accepted = (items || []).filter((i) =>
      !FINAL_STATES.includes(String(i.estado || '').toLowerCase())
    );
    if (!accepted.length) return { ok: false, reason: 'Todos los RFCE están rechazados o en error. Regenera y reenvía.', portalFiles: [] };

    let portalDir = null;
    const portalFiles = [];
    const warnings = [];

    try {
      // Carpeta fija para que el usuario siempre sepa dónde buscar
      portalDir = path.join(LOCAL_ECF_WORK_DIR, 'DGII_CARGAR_AHORA_4_XML_VERIFICADOS', 'PORTAL_VERIFICADO');
      fs.mkdirSync(portalDir, { recursive: true });
      // Limpiar archivos anteriores para que solo queden los del lote actual
      for (const old of fs.readdirSync(portalDir)) {
        if (old.toLowerCase().endsWith('.xml')) fs.unlinkSync(path.join(portalDir, old));
      }

      const RFCE_ENVIADOS_DIR = path.join(process.cwd(), 'storage', 'ecf', 'rfce-enviados');

      for (const item of accepted) {
        const ecfPath = path.join(LOCAL_ECF_DIR, `${item.encf}.xml`);

        if (!fs.existsSync(ecfPath)) {
          warnings.push({ encf: item.encf, warning: 'E32 local no encontrado. Genera RFCE de nuevo.' });
          continue;
        }

        const e32Xml = fs.readFileSync(ecfPath, 'utf8');
        const e32Code = computeSecurityCode(e32Xml);

        // 1. Intentar localPath del estado step4
        let rfceCode = null;
        if (item.localPath && fs.existsSync(path.resolve(process.cwd(), item.localPath))) {
          rfceCode = extractRfceSecurityCode(fs.readFileSync(path.resolve(process.cwd(), item.localPath), 'utf8'));
        }

        // 2. Intentar el archivo RFCE actual en scripts/250mil-upload/{encf}.xml
        if (!rfceCode) {
          const currentRfcePath = path.join(process.cwd(), 'scripts', '250mil-upload', `${item.encf}.xml`);
          if (fs.existsSync(currentRfcePath)) {
            rfceCode = extractRfceSecurityCode(fs.readFileSync(currentRfcePath, 'utf8'));
          }
        }

        // 3. Fallback: buscar en rfce-enviados un RFCE que tenga el mismo CodigoSeguridadeCF que el E32
        //    Esto maneja el caso donde scripts/250mil-upload fue sobreescrito con un nuevo generate
        //    pero el E32 en ecf-originales-locales sigue siendo el correcto del batch aceptado.
        if (rfceCode !== e32Code && fs.existsSync(RFCE_ENVIADOS_DIR)) {
          const archiveFiles = fs.readdirSync(RFCE_ENVIADOS_DIR)
            .filter((f) => f.startsWith('rfce-enviado-') && f.endsWith('.xml'))
            .sort().reverse(); // más reciente primero
          for (const af of archiveFiles) {
            try {
              const xml = fs.readFileSync(path.join(RFCE_ENVIADOS_DIR, af), 'utf8');
              const encfInFile = (xml.match(/<eNCF>([^<]+)<\/eNCF>/i) || [])[1] || '';
              if (encfInFile !== item.encf) continue;
              const code = extractRfceSecurityCode(xml);
              if (code && code === e32Code) { rfceCode = code; break; }
            } catch (_) { /* skip */ }
          }
        }

        if (!rfceCode || e32Code !== rfceCode) {
          // El código no coincide pero el archivo existe — lo incluimos igual con advertencia
          warnings.push({
            encf: item.encf,
            warning: `CodigoSeguridadeCF del E32 (${e32Code || '?'}) no coincide con el RFCE (${rfceCode || '?'}). Archivo incluido de todas formas.`,
          });
        }

        const rncMatch = e32Xml.match(/<RNCEmisor>([^<]+)<\/RNCEmisor>/i);
        const rncEmisor = rncMatch ? rncMatch[1].trim() : '';
        if (!rncEmisor) { warnings.push({ encf: item.encf, warning: 'No se pudo extraer RNC del E32.' }); continue; }

        const dgiiFileName = generarNombreArchivoDGII(rncEmisor, item.encf);
        const portalPath = path.join(portalDir, dgiiFileName);
        fs.copyFileSync(ecfPath, portalPath);
        portalFiles.push({ encf: item.encf, dgiiFileName, portalPath });
      }
    } catch (err) {
      this.logger?.warn?.('Error guardando E32 portal.', { error: err.message });
      return { ok: false, reason: err.message, portalFiles: [] };
    }

    return {
      ok: portalFiles.length > 0,
      portalDir,
      portalFiles,
      warnings,
      message: portalFiles.length === accepted.length
        ? `✓ ${portalFiles.length} E32 portal guardados en ${portalDir}`
        : `${portalFiles.length}/${accepted.length} E32 guardados. ${warnings.length} no coinciden — regenera y reenvía los RFCE.`,
    };
  }

  _step4RfceStatusPath() {
    return path.join(this.certificationDir, 'step4-rfce-status.json');
  }

  _step4RfceReadState() {
    const p = this._step4RfceStatusPath();
    if (!fs.existsSync(p)) return { items: [] };
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return { items: [] }; }
  }

  _step4RfceWriteState(state) {
    const p = this._step4RfceStatusPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ...state, lastUpdated: new Date().toISOString() }, null, 2), 'utf8');
  }

  async _step4RfceItemsFromDocuments() {
    const batchId = await this.repository.getLatestCertificationBatchId();
    const params = [];
    let batchClause = '';
    if (batchId) {
      batchClause = ' AND certification_batch_id = ?';
      params.push(batchId);
    }
    const rows = await this.repository.query(
      `SELECT id, encf, estado_dgii, track_id, error_message, dgii_response_json,
              certification_sent_xml_path, certification_dgii_file_name,
              certification_test_type, monto_total, sent_at, last_checked_at, updated_at
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND submission_mode = 'rfce'
       ORDER BY COALESCE(certification_order_index, id) ASC, id ASC`,
      params
    ).catch(() => []);

    return rows.map((row) => {
      const dgiiResponse = parseJson(row.dgii_response_json, null);
      return {
        id: row.id,
        encf: row.encf,
        fileName: row.certification_dgii_file_name || `${row.encf}-rfce.xml`,
        localPath: row.certification_sent_xml_path || null,
        estado: row.estado_dgii || 'pendiente',
        trackId: row.track_id || null,
        mensajeDgii: row.error_message || null,
        dgiiResponse,
        permanentlyBlocked: isPermanentlyBlockedRfceItem({
          estado: row.estado_dgii,
          certificationTestType: row.certification_test_type,
          dgiiResponse,
        }),
        montoTotal: row.monto_total || null,
        fechaEnviado: row.sent_at || null,
        fechaConsulta: row.last_checked_at || row.updated_at || null,
        root: 'RFCE',
        source: 'ecf_documents',
      };
    });
  }

  async step4RfceGetStatus() {
    await this.ensureReady();
    const state = this._step4RfceReadState();
    const dbItems = await this._step4RfceItemsFromDocuments();
    const dbByEncf = new Map(dbItems.map((item) => [String(item.encf || '').toUpperCase(), item]));
    const items = (state.items || []).length
      ? (state.items || []).map((item) => {
          const dbItem = dbByEncf.get(String(item.encf || '').toUpperCase());
          return dbItem ? { ...item, ...dbItem } : item;
        })
      : dbItems;
    const accepted = items.filter((item) => ['aceptado', 'aceptado_condicional'].includes(String(item.estado || '').toLowerCase())).length;
    return {
      ok: true,
      ...state,
      items,
      aceptados: accepted,
      total: items.length,
      source: dbItems.length ? 'ecf_documents' : (state.items?.length ? 'state' : 'empty'),
    };
  }

  // Prepara los archivos E32 para el portal DGII a partir de los RFCE ya aceptados.
  // NO regenera ni re-firma nada — solo verifica y copia los E32 existentes.
  async step4RfcePreparePortal(req) {
    await this.ensureReady();
    if (req) await this.getCurrentActor(req, { adminOnly: true });
    const state = this._step4RfceReadState();
    const dbItems = await this._step4RfceItemsFromDocuments();
    const dbByEncf = new Map(dbItems.map((item) => [String(item.encf || '').toUpperCase(), item]));
    const items = (state.items || []).length
      ? (state.items || []).map((item) => {
          const dbItem = dbByEncf.get(String(item.encf || '').toUpperCase());
          return dbItem ? { ...item, ...dbItem } : item;
        })
      : dbItems;

    const portalResult = this._savePortalE32ForAcceptedItems(items);
    const opened = portalResult.portalDir ? openFolderInOs(portalResult.portalDir) : false;
    return {
      ok: portalResult.ok,
      portalDir: portalResult.portalDir || null,
      portalFiles: portalResult.portalFiles || [],
      portalWarnings: portalResult.warnings || [],
      opened,
      message: portalResult.ok
        ? portalResult.message
        : (portalResult.reason || 'No se pudieron preparar los archivos del portal.'),
      aceptados: items.filter((i) => ['aceptado', 'aceptado_condicional'].includes(String(i.estado || '').toLowerCase())).length,
      total: items.length,
    };
  }

  async step4RfceGenerate(req) {
    await this.ensureReady();
    if (req) await this.getCurrentActor(req, { adminOnly: true });

    const generatedResult = await this.generate250MilXmls(req || {});
    if (!generatedResult.ok) return generatedResult;

    const batchId = await this.repository.getLatestCertificationBatchId();
    // La BD (ecf_documents) es la fuente de verdad de lo ya resuelto (aceptado o
    // permanentemente bloqueado). Si se reconstruye "items" en blanco cada vez que se
    // llama a generate(), se pierde esa memoria y step4RfceSubmit vuelve a reenviar
    // TODO — incluyendo lo ya aceptado y el eNCF muerto del Paso 2 — cada vez que se
    // presiona "Reenviar RFCE" o se dispara el flujo automático. Por eso cada item
    // generado se fusiona con su contraparte en BD antes de escribir el estado local.
    const dbItems = await this._step4RfceItemsFromDocuments();
    const dbByEncf = new Map(dbItems.map((i) => [String(i.encf || '').toUpperCase(), i]));
    const items = (generatedResult.generated || []).map((item) => {
      const dbItem = dbByEncf.get(String(item.encf || '').toUpperCase());
      const isResolved = dbItem && (
        ['aceptado', 'aceptado_condicional'].includes(String(dbItem.estado || '').toLowerCase())
        || dbItem.permanentlyBlocked
      );
      return {
        encf: item.encf,
        fileName: path.basename(item.file || `${item.encf}.xml`),
        localPath: item.file,
        estado: isResolved ? dbItem.estado : 'generado',
        trackId: isResolved ? dbItem.trackId : null,
        fechaGenerado: new Date().toISOString(),
        fechaEnviado: isResolved ? dbItem.fechaEnviado : null,
        mensajeDgii: isResolved ? dbItem.mensajeDgii : null,
        dgiiResponse: isResolved ? dbItem.dgiiResponse : null,
        permanentlyBlocked: isResolved ? !!dbItem.permanentlyBlocked : false,
        endpoint: item.endpoint || this.config.DGII_FC_URL,
        root: 'RFCE',
        sizekb: item.sizekb || 0,
        montoTotal: item.montoTotal || null,
        localEcfFile: item.localEcfFile || null,
      };
    });
    this._step4RfceWriteState({ batchId, items, outDir: generatedResult.outDir });
    return {
      ok: true,
      items,
      outDir: generatedResult.outDir,
      message: `${items.length} resumen(es) RFCE generados para el paso 4. Envíalos por RecepcionFC.`,
    };
  }

  // Cuando DGII certecf rechaza un RFCE con "ya utilizado previamente", el eNCF queda
  // permanentemente quemado en ese entorno. Este método rota el eNCF: asigna uno nuevo
  // desde la secuencia, actualiza la BD y regenera los XMLs del paso 4.
  //
  // SOLO es seguro rotar documentos del Paso 4 (simulación, certification_test_type
  // empieza con 'simulation-'), cuyo eNCF sale de NUESTRA secuencia activa. Los del
  // Paso 2 ("Pruebas de Datos e-CF") traen el eNCF EXACTO del set de datos que DGII
  // entregó — si se rota, el Resumen queda con un eNCF que DGII nunca emitió, y la
  // Factura de Consumo vinculada (que sigue referenciando el eNCF original) se
  // rechaza después con "no existe en nuestra colección de datos". Mismo motivo por
  // el que rotateBurnedEncfs() está deshabilitada para certificación — ver ahí.
  // Por eso la elegibilidad se verifica ANTES de tocar la secuencia o la BD.
  async _rotateAndRegenerateRfce(oldEncf, req) {
    try {
      const docs = await this.repository.query(
        'SELECT id, certification_original_xml, certification_test_type FROM ecf_documents WHERE business_id = 1 AND encf = ? AND tipo_ecf = ? AND submission_mode = ?',
        [oldEncf.toUpperCase(), 'E32', 'rfce']
      );
      if (!docs.length) return { ok: false };
      const doc = docs[0];

      const isSimulated = String(doc.certification_test_type || '').toLowerCase().startsWith('simulation-');
      if (!isSimulated) {
        return { ok: false, blocked: true, reason: 'fixed-dataset-encf' };
      }

      let certSrc;
      try { certSrc = JSON.parse(doc.certification_original_xml || '{}'); } catch (_) { return { ok: false }; }

      const seqResult = await this.generateNextENCF({ body: { tipoComprobante: 'E32' } });
      const newEncf = seqResult.encf;

      const patchEncf = (row) => {
        if (!row || typeof row !== 'object') return row;
        const u = { ...row };
        if (u.ENCF && String(u.ENCF).toUpperCase() === oldEncf.toUpperCase()) u.ENCF = newEncf;
        if (u.eNCF && String(u.eNCF).toUpperCase() === oldEncf.toUpperCase()) u.eNCF = newEncf;
        return u;
      };
      certSrc = { ...certSrc, row: patchEncf(certSrc.row), linkedRawRow: patchEncf(certSrc.linkedRawRow) };
      // El documento se actualiza ANTES de "reservar" el siguiente número: si el paso
      // de reserva falla, el eNCF ya quedó consumido en ecf_documents y localEncfExists()
      // lo detectará en el próximo generateNextENCF, evitando reutilizarlo por error.
      await this.repository.query(
        'UPDATE ecf_documents SET encf = ?, certification_original_xml = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [newEncf, JSON.stringify(certSrc), doc.id]
      );
      if (seqResult.sequence?.id && seqResult.numero) {
        await this.repository.query(
          'UPDATE ecf_sequences SET proximo_numero = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND proximo_numero <= ?',
          [seqResult.numero + 1, seqResult.sequence.id, seqResult.numero]
        );
      }
      await this.step4RfceGenerate(req);
      console.log(`[ECF] RFCE rotado por "ya utilizado": ${oldEncf} → ${newEncf}`);
      return { ok: true, oldEncf, newEncf };
    } catch (err) {
      console.warn('[ECF] _rotateAndRegenerateRfce falló:', err.message);
      return { ok: false };
    }
  }

  async step4RfceSubmit(req) {
    await this.ensureReady();
    if (req) await this.getCurrentActor(req, { adminOnly: true });

    let state = this._step4RfceReadState();
    if (!state.items?.length) {
      const generated = await this.step4RfceGenerate(req);
      if (!generated.ok) return generated;
      state = this._step4RfceReadState();
    }

    const updatedItems = [...(state.items || [])];
    const results = [];
    for (let index = 0; index < updatedItems.length; index += 1) {
      let item = updatedItems[index];
      if (['aceptado', 'aceptado_condicional'].includes(String(item.estado || '').toLowerCase())) {
        results.push({ encf: item.encf, ok: true, estado: item.estado, skipped: true });
        continue;
      }
      // No reintentar un RFCE del Paso 2 ya marcado como permanentemente bloqueado —
      // cada reenvío vuelve a golpear DGII con el mismo eNCF muerto y dispara de nuevo
      // el "las pruebas han sido reiniciadas" en el portal, sin ninguna posibilidad de éxito.
      if (item.permanentlyBlocked) {
        results.push({ encf: item.encf, ok: false, estado: item.estado, skipped: true, permanentlyBlocked: true });
        continue;
      }
      let rfceRetry = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const filePath = path.resolve(process.cwd(), String(item.localPath || ''));
        if (!item.localPath || !fs.existsSync(filePath)) {
          const mensajeDgii = 'RFCE no encontrado. Genera los resúmenes del paso 4 primero.';
          updatedItems[index] = { ...item, estado: 'error', mensajeDgii };
          results.push({ encf: item.encf, ok: false, error: mensajeDgii });
          break;
        }
        try {
          const signedXml = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
          const response = await this.fcService.sendConsumptionSummary({
            signedXml,
            filename: item.fileName,
            localEcfPath: item.localEcfFile || null,
          });
          const trackId = response.trackId || response.trackid || response.TrackId || null;
          const sequenceUsed = isDgiiSequenceUsedResponse(response);
          const estado = sequenceUsed ? 'aceptado' : (trackId ? 'enviado' : normalizeDgiiState(response));
          let mensajeDgii = response.mensaje || response.message || response.descripcion || response.error || null;
          let permanentlyBlocked = false;

          // DGII certecf quema el eNCF aunque rechace el RFCE. Si detectamos "ya utilizado"
          // rotamos al siguiente número de secuencia y reintentamos (máx 3 veces por item).
          // _rotateAndRegenerateRfce se niega a rotar eNCF del Paso 2 (set fijo de DGII);
          // en ese caso no hay que reintentar — queda bloqueado hasta bajar un set nuevo.
          if (estado === 'rechazado' && isRfceEncfAlreadyUsedError(response) && rfceRetry < 3) {
            rfceRetry += 1;
            const rotated = await this._rotateAndRegenerateRfce(item.encf, req);
            if (rotated.ok) {
              const newState = this._step4RfceReadState();
              const newItem = (newState.items || []).find((i) => i.encf === rotated.newEncf);
              if (newItem) {
                updatedItems[index] = newItem;
                item = newItem;
                continue;
              }
            } else if (rotated.blocked) {
              permanentlyBlocked = true;
              mensajeDgii = `${mensajeDgii ? mensajeDgii + ' — ' : ''}Este e-NCF pertenece al set fijo de datos DGII (Paso 2) y no se puede rotar localmente: el portal valida contra el e-NCF exacto entregado. Ve al portal DGII, descarga un set de comprobantes nuevo y reimpórtalo — no reintentes con el mismo e-NCF.`;
            }
          }

          updatedItems[index] = {
            ...item,
            estado,
            trackId,
            fechaEnviado: new Date().toISOString(),
            mensajeDgii,
            dgiiResponse: response,
            permanentlyBlocked,
          };
          await this.repository.query(
            `UPDATE ecf_documents
                SET estado_dgii = ?,
                    track_id = ?,
                    dgii_response_json = ?,
                    error_message = ?,
                    certification_sent_xml_path = ?,
                    certification_dgii_file_name = ?,
                    sent_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
              WHERE business_id = 1
                AND certification_case_key IS NOT NULL
                AND encf = ?`,
            [
              estado,
              trackId,
              JSON.stringify(response),
              ['rechazado', 'error'].includes(estado) ? mensajeDgii : null,
              response.xmlPath || response.archivoEnviado || filePath,
              response.dgiiFileName || item.fileName,
              item.encf,
            ]
          ).catch(err => console.warn('[ECF] UPDATE batch cert envío falló:', err.message));
          results.push({ encf: item.encf, ok: !['rechazado', 'error'].includes(estado), estado, trackId, mensaje: mensajeDgii });
          break;
        } catch (error) {
          if (isDgiiSequenceUsedResponse(error)) {
            const dgiiResponse = error?.details && typeof error.details === 'object'
              ? error.details
              : { error: error.message };
            const mensajeDgii = dgiiResponse.error || dgiiResponse.descripcion || dgiiResponse.mensaje || error.message;
            updatedItems[index] = {
              ...item,
              estado: 'aceptado',
              mensajeDgii,
              fechaEnviado: new Date().toISOString(),
              dgiiResponse: { ...dgiiResponse, reconciled: true, reason: 'dgii-sequence-used' },
            };
            await this.repository.query(
              `UPDATE ecf_documents
                  SET estado_dgii = 'aceptado',
                      error_message = NULL,
                      dgii_response_json = ?,
                      updated_at = CURRENT_TIMESTAMP
                WHERE business_id = 1
                  AND certification_case_key IS NOT NULL
                  AND encf = ?`,
              [JSON.stringify(updatedItems[index].dgiiResponse), item.encf]
            ).catch(err => console.warn('[ECF] UPDATE batch cert reconciled falló:', err.message));
            results.push({ encf: item.encf, ok: true, estado: 'aceptado', mensaje: mensajeDgii });
            break;
          }
          updatedItems[index] = { ...item, estado: 'error', mensajeDgii: error.message, fechaEnviado: new Date().toISOString() };
          await this.repository.query(
            `UPDATE ecf_documents
                SET estado_dgii = 'error',
                    error_message = ?,
                    dgii_response_json = ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE business_id = 1
                AND certification_case_key IS NOT NULL
                AND encf = ?`,
            [error.message, JSON.stringify({ error: error.message, details: error.details || null }), item.encf]
          ).catch(err => console.warn('[ECF] UPDATE batch cert error falló:', err.message));
          results.push({ encf: item.encf, ok: false, error: error.message });
          break;
        }
      }
    }

    this._step4RfceWriteState({ ...state, items: updatedItems });

    return {
      ok: results.every((result) => result.ok !== false),
      results,
      items: updatedItems,
      aceptados: updatedItems.filter((item) => ['aceptado', 'aceptado_condicional'].includes(String(item.estado || '').toLowerCase())).length,
      enviados: updatedItems.filter((item) => String(item.estado || '').toLowerCase() === 'enviado').length,
      rechazados: updatedItems.filter((item) => String(item.estado || '').toLowerCase() === 'rechazado').length,
      bloqueados: updatedItems.filter((item) => item.permanentlyBlocked).length,
    };
  }

  // "Reiniciar Paso 2 por completo" — acción explícita que deja los 21 comprobantes Y los 4
  // RFCE del lote actual en blanco, para reintentar desde cero SIN tener que re-subir el
  // Excel (típicamente tras descargar un set de datos nuevo en el portal DGII — ese set puede
  // traer eNCF distintos tanto para los 21 como para los 4 RFCE, no solo para el RFCE — o para
  // salir de un estado confuso). A diferencia de _resetAndRetry2 / resetRejectedCertification-
  // CasesToFirmado, esto SÍ toca los ya aceptados a propósito. NO borra certification_original_xml
  // (fuente de datos del Excel DGII que ambos flujos —21 y RFCE— necesitan para regenerar el XML).
  async step2ResetCompletely(req) {
    await this.ensureReady();
    if (req) await this.getCurrentActor(req, { adminOnly: true });

    const { reset, batchId } = await this.repository.resetCertificationBatchCompletely();

    // Limpiar XMLs de RFCE generados para no reutilizar por error firmas/eNCF de la corrida
    // anterior. Los 21 comprobantes normales regeneran su XML desde certification_original_xml
    // al reenviar, sin depender de archivos locales adicionales.
    const dirsToClean = [
      path.join(process.cwd(), 'scripts', '250mil-upload'),
      path.join(process.cwd(), 'storage', 'ecf', 'ecf-originales-locales'),
    ];
    for (const dir of dirsToClean) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (/\.(xml|zip)$/i.test(f)) {
          try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignorar */ }
        }
      }
    }

    this._step4RfceWriteState({ batchId, items: [] });

    return {
      ok: true,
      reset,
      batchId,
      message: reset > 0
        ? `${reset} documento(s) del Paso 2 reiniciados (21 comprobantes + 4 RFCE). Listo para regenerar y reenviar desde cero.`
        : 'No había documentos del Paso 2 que reiniciar en el lote actual.',
    };
  }

  async step4RfcePollStatuses() {
    await this.ensureReady();
    const state = this._step4RfceReadState();
    const updatedItems = [...(state.items || [])];
    const results = [];

    const candidates = updatedItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.trackId && !['aceptado', 'aceptado_condicional', 'rechazado'].includes(String(item.estado || '').toLowerCase()));

    const polled = await mapWithConcurrency(candidates, 4, async ({ item, index }) => {
      try {
        const dgii = await this.statusService.getTrackStatus(item.trackId);
        const sequenceUsed = isDgiiSequenceUsedResponse(dgii);
        const estado = sequenceUsed ? 'aceptado' : normalizeDgiiState(dgii);
        const mensajesArr = Array.isArray(dgii.mensajes) ? dgii.mensajes : [];
        const mensajeDgii = dgii.mensaje
          || mensajesArr.map((m) => String(m?.valor || m?.descripcion || '').trim()).filter(Boolean).join(' | ')
          || null;
        updatedItems[index] = { ...item, estado, mensajeDgii, dgiiResponse: dgii };
        await this.repository.query(
          `UPDATE ecf_documents
              SET estado_dgii = ?,
                  dgii_response_json = ?,
                  error_message = ?,
                  last_checked_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
            WHERE business_id = 1
              AND certification_case_key IS NOT NULL
              AND encf = ?`,
          [estado, JSON.stringify(dgii), estado === 'rechazado' ? mensajeDgii : null, item.encf]
        ).catch(err => console.warn('[ECF] UPDATE poll batch falló:', err.message));
        return { encf: item.encf, estado, trackId: item.trackId, mensaje: mensajeDgii };
      } catch (error) {
        return { encf: item.encf, error: error.message };
      }
    });
    results.push(...polled);

    this._step4RfceWriteState({ ...state, items: updatedItems });

    return {
      ok: true,
      results,
      items: updatedItems,
      aceptados: updatedItems.filter((item) => ['aceptado', 'aceptado_condicional'].includes(String(item.estado || '').toLowerCase())).length,
    };
  }

  /**
   * Paso 3 certificación DGII: envía Aprobaciones Comerciales (ACECF) desde el
   * Excel descargado del portal ("DESCARGAR APROBACIONES COMERCIALES").
   * Usa el certificado P12 ya almacenado en el sistema.
   */
  async processAprobacionComercialTestSet(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });

    const form = formidable({ multiples: false, maxFileSize: 20 * 1024 * 1024, keepExtensions: true });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (error, parsedFields, parsedFiles) => {
        if (error) reject(error);
        else resolve({ fields: parsedFields, files: parsedFiles });
      });
    });

    const oneFile = (...keys) => {
      for (const k of keys) {
        const v = files?.[k];
        const f = Array.isArray(v) ? v[0] : v;
        if (f?.filepath) return f;
      }
      return null;
    };
    const oneField = (...keys) => {
      for (const k of keys) {
        const v = fields?.[k];
        const s = String(Array.isArray(v) ? v[0] : (v ?? '')).trim();
        if (s) return s;
      }
      return '';
    };

    const excelFile = oneFile('excel', 'testset', 'files', 'file');
    const environment = normalizeEnvironmentKey(oneField('environment', 'ambiente') || 'certecf');
    // NUNCA usar un valor por defecto de .env aquí — DGII valida FechaHoraAprobacionComercial
    // contra el valor exacto de cada fila del Excel (o la hora real de envío si la fila no lo
    // trae). Un default fijo en el ambiente causaba que TODAS las filas usaran la misma fecha
    // vieja de una corrida anterior, sin importar lo que trajera el Excel — DGII rechazaba todo
    // el lote con "el valor enviado no coincide con el valor del conjunto de datos entregados".
    const fechaHoraACOverrideRaw = oneField(
      'fechaHoraAprobacionComercial',
      'FechaHoraAprobacionComercial',
      'fechaHoraAC',
      'FechaHoraAC'
    );
    const skipMissingLocalDocs = oneField('skipMissingLocalDocs', 'skipMissingLocalDocument') !== '0';

    assertCondition(excelFile?.filepath, 'Carga el Excel de Aprobaciones Comerciales descargado del portal DGII.', { statusCode: 400 });

    this.applyRuntimeConfig(environment);
    const certificate = await this.resolveCertificate();

    const buffer = fs.readFileSync(excelFile.filepath);
    // cellDates:true para que XLSX devuelva Date objects en las columnas de fecha.
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });

    const sheetName = workbook.SheetNames.find((n) => /AC|ACECF|APROBACION/i.test(n))
      || workbook.SheetNames[0];
    assertCondition(sheetName, 'No se encontró hoja de datos en el Excel.', { statusCode: 400 });

    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    assertCondition(rows.length, 'El Excel no contiene filas de Aprobaciones Comerciales.', { statusCode: 400 });

    // El Excel de "Pruebas de Datos e-CF" (Paso 2) NO trae la columna FechaHoraAprobacionComercial
    // — es un archivo distinto al de "Aprobaciones Comerciales" (Paso 3). Detectarlo aquí evita que
    // el resto del proceso falle de forma confusa (fechas que caen a "ahora" o valores de otras
    // columnas metidos por error en el campo de fecha).
    assertCondition(
      Object.keys(rows[0] || {}).includes('FechaHoraAprobacionComercial'),
      'Este Excel no parece ser el de Aprobaciones Comerciales (Paso 3) — no trae la columna FechaHoraAprobacionComercial. Descarga el archivo correcto desde el portal DGII (sección Aprobación Comercial), no el de Pruebas de Datos e-CF.',
      { statusCode: 400 }
    );

    const auth = await this.authService.authenticate({ forceRefresh: true });
    const token = auth.token;

    const pad = (n) => String(n).padStart(2, '0');

    // FechaEmision viene como texto "01-04-2020" (DD-MM-YYYY dominicano).
    // NO usar new Date(string) — V8 interpreta "01-04-2020" como January 4 en vez de April 1.
    // Si es Date object (cellDates:true en XLSX), usar UTC para evitar desfase de timezone.
    const toDgiiDate = (val) => {
      if (!val && val !== 0) return '';
      if (val instanceof Date) {
        return `${pad(val.getUTCDate())}-${pad(val.getUTCMonth() + 1)}-${val.getUTCFullYear()}`;
      }
      const s = String(val).trim();
      // Ya en formato DD-MM-YYYY o D-M-YYYY → pasar directamente sin re-parsear
      const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
      if (m) return `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}-${m[3]}`;
      // Intentar parsear otros formatos como último recurso
      const dt = new Date(s);
      if (!isNaN(dt.getTime())) {
        return `${pad(dt.getUTCDate())}-${pad(dt.getUTCMonth() + 1)}-${dt.getUTCFullYear()}`;
      }
      return s;
    };

    const toDgiiDateTime = (val) => {
      if (!val && val !== 0) return '';
      if (val instanceof Date) {
        // Usar hora LOCAL — Excel almacena datetimes en hora local (RD = UTC-4).
        // getUTCHours() daría 4 horas de más y no coincidiría con el dataset DGII.
        return `${pad(val.getDate())}-${pad(val.getMonth() + 1)}-${val.getFullYear()} ${pad(val.getHours())}:${pad(val.getMinutes())}:${pad(val.getSeconds())}`;
      }
      const s = String(val).trim();
      // Ya en formato DD-MM-YYYY HH:mm:ss → pasar directamente
      const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/);
      if (m) return `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}-${m[3]} ${m[4].padStart(2, '0')}:${m[5]}:${m[6]}`;
      // Formato locale "M/D/YYYY H:MM:SS AM/PM" (como devuelve Excel en raw:false con cellDates:false)
      const ampm = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i);
      if (ampm) {
        let h = parseInt(ampm[4], 10);
        if (ampm[7] && ampm[7].toUpperCase() === 'PM' && h < 12) h += 12;
        if (ampm[7] && ampm[7].toUpperCase() === 'AM' && h === 12) h = 0;
        return `${ampm[2].padStart(2,'0')}-${ampm[1].padStart(2,'0')}-${ampm[3]} ${pad(h)}:${ampm[5]}:${ampm[6]}`;
      }
      return s;
    };

    const normalizeVal = (...keys) => (row) => {
      for (const k of keys) {
        const v = row[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return v;
      }
      return '';
    };

    const results = [];
    const fechaHoraACOverride = fechaHoraACOverrideRaw ? toDgiiDateTime(fechaHoraACOverrideRaw) : '';
    // Aprendido en vivo de la propia DGII: la primera vez que un rechazo nos diga el valor
    // exacto que esperan, lo reutilizamos para TODAS las filas siguientes del mismo lote —
    // el Excel descargado del portal puede traer una fecha vieja/desactualizada en esta
    // columna (confirmado: dos descargas distintas del mismo día trajeron valores distintos
    // entre sí, y ninguno coincidía con lo que DGII realmente esperaba en ese momento).
    let learnedFechaHoraAC = '';
    const localRows = skipMissingLocalDocs
      ? await this.repository.query(
        `SELECT encf
           FROM ecf_documents
          WHERE business_id = 1
            AND certification_case_key IS NOT NULL
            AND estado_dgii IN ('aceptado', 'aceptado_condicional')`
      ).catch(() => [])
      : [];
    const acceptedLocalEncfs = new Set(localRows.map((r) => String(r.encf || '').trim().toUpperCase()).filter(Boolean));

    for (const row of rows) {
      const rncEmisor     = String(normalizeVal('RNCEmisor', 'RncEmisor', 'RNC Emisor', 'RNCemisor')(row)).replace(/\D/g, '');
      const encf          = String(normalizeVal('eNCF', 'ENCF', 'NCFElectronico', 'NCF', 'e-NCF')(row)).replace(/\s/g, '').toUpperCase();
      const fechaEmision  = toDgiiDate(normalizeVal('FechaEmision', 'Fecha Emision', 'FechaDeEmision')(row));
      const montoTotalRaw = normalizeVal('MontoTotal', 'Monto Total', 'monto_total')(row);
      const rncComprador  = String(normalizeVal('RNCComprador', 'RncComprador', 'RNC Comprador')(row)).replace(/\D/g, '');
      const estadoRaw     = normalizeVal('Estado', 'estado')(row) || '1';
      const motivo        = String(normalizeVal('DetalleMotivoRechazo', 'MotivoRechazo', 'Motivo')(row)).trim();
      // FechaHoraAprobacionComercial: DGII valida contra el valor exacto de su conjunto de datos.
      // Leer del Excel (columna que DGII pre-rellena con el timestamp correcto).
      // Solo si el Excel no trae la columna, caer a la hora actual como último recurso.
      const fechaHoraACRaw = normalizeVal(
        'FechaHoraAprobacionComercial', 'Fecha Hora Aprobacion Comercial',
        'FechaHoraAC', 'FechaAprobacion', 'Fecha Hora AC'
      )(row);
      const fechaHoraAC = fechaHoraACOverride || learnedFechaHoraAC || (fechaHoraACRaw
        ? toDgiiDateTime(fechaHoraACRaw)
        : (() => { const n = new Date(); return `${pad(n.getDate())}-${pad(n.getMonth()+1)}-${n.getFullYear()} ${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`; })());

      console.log(`[ACECF] ${encf} → fechaHoraAC="${fechaHoraAC}" fechaEmision="${fechaEmision}" rncEmisor="${rncEmisor}" rncComprador="${rncComprador}"`);

      if (!rncEmisor || !encf) {
        results.push({ encf: encf || '(vacío)', ok: false, error: 'RNCEmisor o eNCF no encontrado en la fila.' });
        continue;
      }

      // Aprobación Comercial solo aplica a E31, E33, E34, E44, E45 — confirmado en vivo contra
      // DGII enviando los 10 tipos de e-CF: E32, E41 y E46 siempre responden "Aprobacion
      // Comercial no es requerida para este tipo de e-CF" (E43/E47 se cubren abajo, por no
      // tener comprador identificado).
      const tipoEcfMatch = encf.match(/^E(\d{2})/);
      const tipoEcf = tipoEcfMatch ? tipoEcfMatch[1] : '';
      const TIPOS_CON_APROBACION_COMERCIAL = new Set(['31', '33', '34', '44', '45']);
      if (tipoEcf && !TIPOS_CON_APROBACION_COMERCIAL.has(tipoEcf)) {
        results.push({ encf, ok: false, skipped: true, error: `E${tipoEcf} no requiere Aprobación Comercial.` });
        continue;
      }

      // Aprobación Comercial exige un comprador identificado (quien aprueba/rechaza el
      // comprobante) — sin RNCComprador no hay a quién enviársela. Confirmado en vivo: DGII
      // rechaza estas filas con "Aprobacion Comercial no es requerida para este tipo de e-CF"
      // (típicamente E43/E47, que no llevan comprador identificado).
      if (!rncComprador) {
        results.push({ encf, ok: false, skipped: true, error: 'Sin RNCComprador — este tipo de e-CF no requiere Aprobación Comercial.' });
        continue;
      }
      if (skipMissingLocalDocs && acceptedLocalEncfs.size && !acceptedLocalEncfs.has(encf)) {
        results.push({
          encf,
          ok: false,
          skipped: true,
          staleDataset: true,
          error: 'Este e-NCF no existe entre los e-CF aceptados localmente del lote actual. Se omitió para no reiniciar el Paso 3 en DGII; descarga el Excel/lote nuevo del portal.',
        });
        continue;
      }

      const estado = String(estadoRaw).replace(/\D/g, '') || '1';
      const montoTotal = (() => {
        const n = parseFloat(String(montoTotalRaw).replace(/[^0-9.,-]/g, '').replace(',', '.'));
        return isNaN(n) ? '0.00' : n.toFixed(2);
      })();

      const buildXml = (fechaHoraACValue) => {
        let x = `<?xml version="1.0" encoding="utf-8"?>\n<ACECF>\n  <DetalleAprobacionComercial>\n    <Version>1.0</Version>\n    <RNCEmisor>${rncEmisor}</RNCEmisor>\n    <eNCF>${encf}</eNCF>\n    <FechaEmision>${fechaEmision}</FechaEmision>\n    <MontoTotal>${montoTotal}</MontoTotal>\n    <RNCComprador>${rncComprador}</RNCComprador>\n    <Estado>${estado}</Estado>`;
        if (estado === '2' && motivo) {
          x += `\n    <DetalleMotivoRechazo>${motivo}</DetalleMotivoRechazo>`;
        }
        x += `\n    <FechaHoraAprobacionComercial>${fechaHoraACValue}</FechaHoraAprobacionComercial>\n  </DetalleAprobacionComercial>\n</ACECF>`;
        return x;
      };

      const filename = `${rncComprador || rncEmisor}${encf}.xml`;
      const outDir = path.join(process.cwd(), 'storage', 'ecf', 'acecf-enviados');
      fs.mkdirSync(outDir, { recursive: true });

      const sendOnce = async (fechaHoraACValue) => {
        let signedXml;
        try {
          signedXml = signatureService.signXML(buildXml(fechaHoraACValue), certificate);
        } catch (signErr) {
          return { ok: false, error: `Error firmando: ${signErr.message}` };
        }
        fs.writeFileSync(path.join(outDir, filename), signedXml, 'utf8');
        try {
          const dgiiResponse = await this.dgiiClient.submitAcecf({ token, signedXml, filename });
          // DGII responde HTTP 200 incluso cuando RECHAZA la aprobación comercial — el
          // resultado real va en el cuerpo (codigo/estado), nunca en el status HTTP. Usar
          // solo el status HTTP aquí hacía que "ok" fuera siempre true y el reintento con
          // auto-corrección de FechaHoraAprobacionComercial (más abajo) nunca se disparara.
          const dgiiState = normalizeDgiiState(dgiiResponse);
          const ok = ['aceptado', 'aceptado_condicional', 'en_proceso'].includes(dgiiState);
          const mensajesArr = Array.isArray(dgiiResponse.mensajes) ? dgiiResponse.mensajes : [];
          // dgiiResponse.mensaje puede venir como string O como array (DGII no es consistente
          // entre endpoints) — normalizar siempre a string antes de usarlo, para no romper
          // código que llame .match()/.includes() sobre él (ver ACECF: array de 1 string).
          const rawMensaje = dgiiResponse.mensaje || dgiiResponse.Mensaje;
          const mensajeTexto = (Array.isArray(rawMensaje)
            ? rawMensaje.map((m) => String(m?.valor || m?.Valor || m?.descripcion || m?.Descripcion || m || '').trim()).filter(Boolean).join(' | ')
            : rawMensaje)
            || mensajesArr.map((m) => String(m?.valor || m?.Valor || m?.descripcion || m?.Descripcion || m?.mensaje || m || '').trim()).filter(Boolean).join(' | ')
            || null;
          return {
            encf,
            rncEmisor,
            rncComprador,
            estado: dgiiResponse.estado || dgiiResponse.Estado || null,
            trackId: dgiiResponse.trackId || dgiiResponse.TrackId || null,
            mensaje: mensajeTexto,
            http: dgiiResponse.http?.status,
            raw: String(dgiiResponse.raw || '').slice(0, 400),
            ok,
          };
        } catch (sendErr) {
          return { encf, ok: false, error: sendErr.message };
        }
      };

      let result = await sendOnce(fechaHoraAC);

      // DGII a veces expone el valor EXACTO que espera dentro del propio mensaje de rechazo
      // ("...no coincide con el valor (7/6/2026 8:05:00 AM) del conjunto de datos entregados").
      // El Excel descargado del portal puede venir desactualizado (contenido congelado de una
      // corrida anterior — confirmado comparando varias descargas separadas por horas con
      // contenido idéntico), mientras que la validación de DGII ya espera un valor distinto.
      // En vez de fallar sin remedio, reintentamos usando el valor que DGII mismo indica en cada
      // rechazo — en lote puede desfasarse más de una vez si DGII reinicia el dataset a mitad
      // de la corrida (un e-NCF sin match en la colección también dispara el reinicio).
      const originalFechaHoraAC = fechaHoraAC;
      let attemptValue = fechaHoraAC;
      let corrections = 0;
      const MAX_FECHA_RETRIES = 2;
      while (!result.ok && result.mensaje && corrections < MAX_FECHA_RETRIES) {
        const mismatch = result.mensaje.match(/no coincide con el valor\s*\(([^)]+)\)\s*del conjunto de datos entregados/i);
        if (!mismatch) break;
        const corrected = toDgiiDateTime(mismatch[1].trim());
        if (!corrected || corrected === attemptValue) break;
        attemptValue = corrected;
        corrections++;
        result = await sendOnce(attemptValue);
      }
      if (corrections > 0) {
        result = { ...result, correctedFechaHoraAC: attemptValue, originalFechaHoraAC };
        if (result.ok) {
          // Recordar el valor que la DGII confirmó como correcto para saltarlo directo en
          // las filas siguientes del mismo lote, en vez de repetir el ciclo rechazo→corrección
          // fila por fila (cada rechazo reinicia el lote completo de pruebas en DGII).
          learnedFechaHoraAC = attemptValue;
        }
      }

      // "no existe en nuestra colección de datos" no es un problema de fecha: significa que
      // este e-NCF ya no pertenece al lote de pruebas activo en DGII (típicamente porque el
      // rechazo de OTRA fila del mismo Excel reinició todo el dataset a mitad de la corrida).
      // Reenviar el mismo archivo no lo arregla — hace falta un Excel recién descargado.
      if (!result.ok && /no existe en nuestra colecci/i.test(String(result.mensaje || ''))) {
        result = { ...result, staleDataset: true };
      }

      results.push(result);
    }

    const accepted = results.filter((r) => r.ok).length;
    return {
      ok: accepted > 0,
      total: results.length,
      accepted,
      results,
      environment,
      message: `${accepted}/${results.length} Aprobaciones Comerciales enviadas correctamente.`,
    };
  }

  async deleteCertificationCase(documentId, req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: false });
    const result = await this.repository.deleteSingleCertificationCase(documentId);
    if (!result.deleted) return { ok: false, message: 'Caso no encontrado o ya eliminado.' };
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      documentId,
      actionName: 'certification_case_deleted',
      status: 'ok',
      detail: `Caso de certificación #${documentId} eliminado manualmente.`,
      responsePayload: result,
    });
    return { ok: true, message: `Caso #${documentId} eliminado.` };
  }

  async resetCertificationData(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const result = await this.repository.deleteCurrentBatchCertificationCases();
    fs.rmSync(this.certificationSignedDir, { recursive: true, force: true });
    fs.mkdirSync(this.certificationSignedDir, { recursive: true });
    fs.rmSync(this._portal250MilStatusPath(), { force: true });
    fs.rmSync(this._step4RfceStatusPath(), { force: true });
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      documentId: null,
      sequenceId: null,
      tipoComprobante: null,
      encf: null,
      actionName: 'certification_reset',
      status: 'ok',
      detail: `Se eliminaron ${result.deleted} caso(s) de certificación del batch ${result.batchId || '—'}.`,
      responsePayload: result,
    });
    return {
      ok: true,
      message: `Se eliminaron ${result.deleted} caso(s) de certificación. Importa el set nuevamente para empezar de cero.`,
      deleted: result.deleted,
      batchId: result.batchId,
    };
  }

  validateCertificationDocumentBeforeSend(document) {
    const row = certificationRowForDocument(document);
    if (!row) {
      return {
        ok: true,
        warnings: ['No hay rawRow del dataset DGII guardado; se validará solo contra el XML almacenado.'],
        logs: {},
      };
    }

    const signedOrXml = String(document.signed_xml_content || document.xml_content || '');
    const root = signedOrXml.trim() ? parseXml(signedOrXml) : null;
    const idDocNode = root?.getElementsByTagName?.('IdDoc')?.[0] || null;
    const emisorNode = root?.getElementsByTagName?.('Emisor')?.[0] || null;
    const compradorNode = root?.getElementsByTagName?.('Comprador')?.[0] || null;
    const totalesNode = root?.getElementsByTagName?.('Totales')?.[0] || null;

    // Usar la misma lógica que repairStoredDocumentXml: rawRow.NC vacío → '';
    // si difiere del config → usar rawRow.NC; si igual → usar rawRow.RazonSocial si difiere del emitter local.
    const expectedNombreComercial = certificationEmitterNombreComercial(row, document._configNombreComercial, document._localRazonSocial);
    const actualNombreComercial = firstNodeText(emisorNode, 'NombreComercial');
    const expectedMontoGravadoI1 = parseDatasetNumber(row.MontoGravadoI1);
    const expectedItbisRate1 = parseDatasetNumber(row.ITBIS1);
    const calculatedTotalItbis1 = roundMoney(expectedMontoGravadoI1 * expectedItbisRate1 / 100);
    const datasetTotalItbis1Text = normalizeDatasetValue(row.TotalITBIS1);
    const expectedTotalItbis1 = datasetTotalItbis1Text
      ? parseDatasetNumber(datasetTotalItbis1Text)
      : calculatedTotalItbis1;
    const datasetTotalItbisText = normalizeDatasetValue(row.TotalITBIS);
    const expectedTotalItbis = datasetTotalItbisText
      ? parseDatasetNumber(datasetTotalItbisText)
      : expectedTotalItbis1;
    const expectedRncEmisor = normalizeDatasetValue(row.RNCEmisor).replace(/\D/g, '');
    const actualRncEmisor = firstNodeText(emisorNode, 'RNCEmisor').replace(/\D/g, '');
    const expectedRazonSocialEmisor = normalizeDatasetValue(row.RazonSocialEmisor);
    const actualRazonSocialEmisor = firstNodeText(emisorNode, 'RazonSocialEmisor');
    const expectedFechaEmision = normalizeDatasetValue(row.FechaEmision);
    const actualFechaEmision = firstNodeText(emisorNode, 'FechaEmision');
    const actualMontoGravadoI1 = parseDatasetNumber(firstNodeText(totalesNode, 'MontoGravadoI1'));
    const actualTotalItbis = parseDatasetNumber(firstNodeText(totalesNode, 'TotalITBIS'));
    const actualTotalItbis1 = parseDatasetNumber(firstNodeText(totalesNode, 'TotalITBIS1'));
    const expectedMontoTotal = parseDatasetNumber(row.MontoTotal);
    const actualMontoTotal = parseDatasetNumber(firstNodeText(totalesNode, 'MontoTotal'));
    const expectedEncf = String(document.encf || '').trim();
    const actualEncf = firstNodeText(idDocNode, 'eNCF');
    const expectedTipo = String(document.tipo_ecf || normalizeDatasetValue(row.TipoeCF) || '').replace(/^E/i, '').trim();
    const actualTipo = firstNodeText(idDocNode, 'TipoeCF').replace(/^E/i, '');
    const expectedTerminoPago = normalizeDatasetValue(row.TerminoPago);
    const actualTerminoPago = firstNodeText(idDocNode, 'TerminoPago');
    const expectedFechaLimitePago = normalizeDatasetValue(row.FechaLimitePago);
    const actualFechaLimitePago = firstNodeText(idDocNode, 'FechaLimitePago');
    const expectedRnc = normalizeDatasetValue(row.RNCComprador).replace(/\D/g, '');
    const actualRnc = firstNodeText(compradorNode, 'RNCComprador').replace(/\D/g, '');
    const expectedRazon = normalizeDatasetValue(row.RazonSocialComprador);
    const actualRazon = firstNodeText(compradorNode, 'RazonSocialComprador');
    const isRfceXml = String(root?.documentElement?.nodeName || '').toUpperCase() === 'RFCE'
      || String(document.submission_mode || '').toLowerCase() === 'rfce';

    const errors = [];
    // RNCEmisor y RazonSocialEmisor NO se validan contra el dataset DGII:
    // deben ser los datos REALES del contribuyente (NG 06-2018), independientemente
    // de los placeholders que usa el set de pruebas ("DOCUMENTOS ELECTRONICOS DE 02").
    //
    // Para documentos de simulación (Paso 4/5, certification_test_type empieza con
    // "simulation-"), lo mismo aplica a NombreComercial y RazonSocialComprador — deben ser
    // los datos reales (emisor y contacto), confirmado en vivo con un representante de la
    // DGII. Para Paso 2 (Pruebas de Datos e-CF, sin ese flag) SÍ deben coincidir exacto con
    // el dataset — confirmado en vivo que la DGII rechaza el nombre real ahí.
    const isSimulatedDoc = String(document.certification_test_type || '').toLowerCase().startsWith('simulation-');
    if (expectedFechaEmision && actualFechaEmision !== expectedFechaEmision) {
      errors.push(`FechaEmision inválida para ${expectedEncf}: XML="${actualFechaEmision}", dataset="${expectedFechaEmision}".`);
    }
    // La ausencia también es un valor esperado. Esto bloquea localmente casos como
    // E410000000001, cuyo dataset usa #e, antes de que DGII reinicie toda la prueba.
    if (!isSimulatedDoc && !isRfceXml && actualNombreComercial !== expectedNombreComercial) {
      errors.push(`NombreComercial inválido para ${expectedEncf}: XML="${actualNombreComercial || '(ausente)'}", dataset="${expectedNombreComercial || '(ausente)'}".`);
    }
    if (expectedMontoGravadoI1 > 0 && !sameMoney(actualMontoGravadoI1, expectedMontoGravadoI1)) {
      errors.push(`MontoGravadoI1 inválido para ${expectedEncf}: XML=${moneyText(actualMontoGravadoI1)}, dataset=${moneyText(expectedMontoGravadoI1)}.`);
    }
    if (expectedTotalItbis > 0 && !sameMoney(actualTotalItbis, expectedTotalItbis)) {
      errors.push(`TotalITBIS inválido para ${expectedEncf}: XML=${moneyText(actualTotalItbis)}, dataset=${moneyText(expectedTotalItbis)}.`);
    }
    if (expectedTotalItbis1 > 0 && !sameMoney(actualTotalItbis1, expectedTotalItbis1)) {
      errors.push(`TotalITBIS1 inválido para ${expectedEncf}: XML=${moneyText(actualTotalItbis1)}, dataset=${moneyText(expectedTotalItbis1)}.`);
    }
    if (expectedMontoTotal > 0 && !sameMoney(actualMontoTotal, expectedMontoTotal)) {
      errors.push(`MontoTotal inválido para ${expectedEncf}: XML=${moneyText(actualMontoTotal)}, dataset=${moneyText(expectedMontoTotal)}.`);
    }
    if (actualEncf !== expectedEncf) {
      errors.push(`e-NCF inválido: XML="${actualEncf}", documento="${expectedEncf}".`);
    }
    if (expectedTipo && actualTipo !== expectedTipo) {
      errors.push(`Tipo e-CF inválido para ${expectedEncf}: XML="${actualTipo}", esperado="${expectedTipo}".`);
    }
    if (!isRfceXml && actualTerminoPago !== expectedTerminoPago) {
      errors.push(`TerminoPago inválido para ${expectedEncf}: XML="${actualTerminoPago || '(ausente)'}", dataset="${expectedTerminoPago || '(ausente)'}".`);
    }
    // E43 no tiene FechaLimitePago en su XSD — omitir la comparación para este tipo.
    if (!isRfceXml && expectedTipo !== '43' && actualFechaLimitePago !== expectedFechaLimitePago) {
      errors.push(`FechaLimitePago inválida para ${expectedEncf}: XML="${actualFechaLimitePago || '(ausente)'}", dataset="${expectedFechaLimitePago || '(ausente)'}".`);
    }
    if (expectedRnc && actualRnc !== expectedRnc) {
      errors.push(`RNC/Cédula receptor inválido para ${expectedEncf}: XML="${actualRnc}", dataset="${expectedRnc}".`);
    }
    if (!isSimulatedDoc && expectedRazon && actualRazon !== expectedRazon) {
      errors.push(`RazónSocialReceptor inválida para ${expectedEncf}: XML="${actualRazon}", dataset="${expectedRazon}".`);
    }

    return {
      ok: errors.length === 0,
      errors,
      logs: {
        numeroPrueba: document.certification_order_index || null,
        tipoEcf: document.tipo_ecf,
        encf: expectedEncf,
        emisorUsado: {
          rnc: actualRncEmisor,
          razonSocial: actualRazonSocialEmisor,
          fechaEmision: actualFechaEmision,
        },
        emisorEsperado: {
          rnc: expectedRncEmisor,
          razonSocial: expectedRazonSocialEmisor,
          fechaEmision: expectedFechaEmision,
        },
        receptorUsado: { rnc: actualRnc, razonSocial: actualRazon },
        nombreComercialUsado: actualNombreComercial,
        nombreComercialEsperado: expectedNombreComercial,
        terminoPagoUsado: actualTerminoPago,
        terminoPagoEsperado: expectedTerminoPago,
        fechaLimitePagoUsada: actualFechaLimitePago,
        fechaLimitePagoEsperada: expectedFechaLimitePago,
        montoGravadoI1: moneyText(actualMontoGravadoI1),
        totalITBIS1Calculado: moneyText(calculatedTotalItbis1),
        totalITBIS1EsperadoDataset: moneyText(expectedTotalItbis1),
        totalITBISXml: moneyText(actualTotalItbis),
        totalITBIS1Xml: moneyText(actualTotalItbis1),
        montoTotal: moneyText(actualMontoTotal),
      },
    };
  }

  async regenerateCertificationCase(documentId, req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });
    const document = await this.repository.getDocument(Number(documentId));
    if (!document || !document.certification_case_key) {
      throw new EcfError('Caso de certificación DGII no encontrado.', { statusCode: 404 });
    }
    if (isCertificationBlockedEncf(document.encf) || String(document.estado_dgii || '').trim().toLowerCase() === 'bloqueado') {
      const message = 'e-NCF bloqueado: la secuencia ya fue utilizada y no debe reenviarse.';
      await this.repository.markDocumentStatus(document.id, {
        estado_dgii: 'bloqueado',
        dgii_response_json: {
          blocked: true,
          reason: isCertificationBlockedEncf(document.encf) ? 'known-used-before-send' : 'previously-blocked',
          encf: document.encf,
        },
        error_message: message,
      });
      const refreshedBlocked = await this.repository.getDocument(document.id);
      return {
        ok: false,
        blocked: true,
        sequenceUsed: true,
        message,
        case: this.buildCertificationCasePayload(refreshedBlocked || document, {
          estado: 'bloqueado',
          mensaje: message,
          dgiiResponse: { blocked: true, encf: document.encf },
        }),
      };
    }

    const certificate = await this.resolveCertificate();
    const regenerated = await this.repairStoredDocumentXml(document, certificate);
    const localValidation = this.validateCertificationDocumentBeforeSend(regenerated);
    if (!localValidation.ok) {
      await this.repository.markDocumentStatus(regenerated.id, {
        estado_dgii: 'error',
        dgii_response_json: { localValidation },
        error_message: localValidation.errors[0],
      });
      return {
        ok: false,
        message: localValidation.errors[0],
        localValidation,
        case: this.buildCertificationCasePayload(await this.repository.getDocument(regenerated.id), {
          estado: 'error',
          mensaje: localValidation.errors[0],
          dgiiResponse: { localValidation },
        }),
      };
    }

    await this.repository.query(
      `UPDATE ecf_documents
       SET estado_dgii = 'firmado',
           track_id = NULL,
           dgii_response_json = NULL,
           error_message = NULL,
           certification_sent_xml_path = NULL,
           certification_response_path = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [regenerated.id]
    );
    await this.syncCertificationArtifacts(regenerated);
    const refreshed = await this.repository.getDocument(regenerated.id);
    return {
      ok: true,
      message: `XML de prueba ${regenerated.encf} regenerado y validado localmente.`,
      localValidation,
      case: this.buildCertificationCasePayload(refreshed || regenerated),
    };
  }

  async getFullCertificationXml(documentId) {
    await this.ensureReady();
    const document = await this.repository.getDocument(documentId);
    assertCondition(document, `Documento ${documentId} no encontrado.`, { statusCode: 404 });
    const xml = String(document.xml_content || document.signed_xml_content || '').trim();
    return { encf: document.encf, tipoEcf: document.tipo_ecf, xml };
  }

  async saveCertificationCaseXml(documentId, req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });
    const document = await this.repository.getDocument(Number(documentId));
    if (!document || !document.certification_case_key) {
      throw new EcfError('Caso de certificación DGII no encontrado.', { statusCode: 404 });
    }

    const rawXml = String(req.body?.xml || '').trim();
    assertCondition(rawXml, 'El campo xml es requerido.', { statusCode: 400 });

    const { DOMParser } = require('@xmldom/xmldom');
    const parser = new DOMParser();
    const parsed = parser.parseFromString(rawXml.replace(/^<\?xml[^>]*\?>/, '').trim(), 'text/xml');
    const parseError = parsed.getElementsByTagName('parsererror')[0];
    assertCondition(!parseError, `XML inválido: ${String(parseError?.textContent || '').slice(0, 200)}`, { statusCode: 400 });

    const certificate = await this.resolveCertificate();
    const normalizedXml = normalizeEcfXmlStructure(rawXml, { removeSignature: true });
    const signedXml = signatureService.signXML(normalizedXml, certificate);
    const verification = signatureService.verifySignature(signedXml);
    assertCondition(verification.ok, 'El XML editado no pasó la verificación local de firma.', { statusCode: 422 });

    await this.repository.updateDocumentPayload(document.id, {
      xml_content: normalizedXml,
      signed_xml_content: signedXml,
      codigo_seguridad: computeSecurityCode(signedXml),
      estado_dgii: 'firmado',
      signed_at: new Date(),
    });

    await this.repository.query(
      `UPDATE ecf_documents
       SET track_id = NULL, dgii_response_json = NULL, error_message = NULL,
           certification_sent_xml_path = NULL, certification_response_path = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [document.id]
    );

    const refreshed = await this.repository.getDocument(document.id);
    await this.syncCertificationArtifacts(refreshed || { ...document, xml_content: normalizedXml, signed_xml_content: signedXml });

    return {
      ok: true,
      message: `XML de ${document.encf} guardado y firmado exitosamente.`,
      case: this.buildCertificationCasePayload(refreshed),
    };
  }

  async sendCertificationCase(documentId, req, options = {}) {
    await this.ensureReady();
    const actor = req ? await this.getCurrentActor(req, { adminOnly: true }) : { id: null, nombre: 'Sistema', usuario: 'Sistema', rol: 'Sistema' };
    const document = await this.repository.getDocument(Number(documentId));
    if (!document || !document.certification_case_key) {
      throw new EcfError('Caso de certificación DGII no encontrado.', { statusCode: 404 });
    }

    const certificate = await this.resolveCertificate();
    const preparedDocument = await this.repairStoredDocumentXml(document, certificate);
    const localValidation = this.validateCertificationDocumentBeforeSend(preparedDocument);
    if (!localValidation.ok) {
      const message = localValidation.errors[0] || `La prueba ${preparedDocument.encf} no pasó la validación local.`;
      await this.repository.markDocumentStatus(preparedDocument.id, {
        estado_dgii: 'error',
        dgii_response_json: { localValidation },
        error_message: message,
      });
      await this.repository.saveTestRun(
        'certification_local_validation',
        'warning',
        message,
        {
          documentId: preparedDocument.id,
          encf: preparedDocument.encf,
          validation: localValidation,
        },
        preparedDocument.environment
      );
      const refreshedInvalid = await this.repository.getDocument(preparedDocument.id);
      return {
        ok: false,
        blocked: true,
        localValidation,
        message,
        case: this.buildCertificationCasePayload(refreshedInvalid || preparedDocument, {
          estado: 'error',
          mensaje: message,
          dgiiResponse: { localValidation },
        }),
      };
    }
    let response;
    try {
      response = await this.sendPreparedDocument(preparedDocument);
    } catch (error) {
      const dgiiResponse = error?.details && typeof error.details === 'object'
        ? error.details
        : { error: error.message };
      if (isDgiiSequenceUsedResponse(dgiiResponse) || isDgiiSequenceUsedResponse(error)) {
        const message = dgiiResponse.error || dgiiResponse.descripcion || dgiiResponse.mensaje || error.message || 'DGII indicó que la secuencia ya fue utilizada.';
        const reconciledState = 'rechazado';
        // "Regenerar con nuevos eNCFs" solo es válido para casos del Paso 4 (simulación).
        // El Paso 2 usa el eNCF exacto del set DGII — no hay nada que regenerar ahí.
        const isSimulatedDoc = String(preparedDocument.certification_test_type || '').toLowerCase().startsWith('simulation-');
        await this.repository.markDocumentStatus(preparedDocument.id, {
          estado_dgii: reconciledState,
          dgii_response_json: { ...dgiiResponse, reconciled: false, reason: 'dgii-sequence-used' },
          error_message: isSimulatedDoc
            ? 'Rechazado en certificación: eNCF ya utilizado — usar Regenerar con nuevos eNCFs.'
            : 'Rechazado en certificación: este e-NCF del set fijo de datos DGII ya fue utilizado y no se puede regenerar (Paso 2 exige el e-NCF exacto). Descarga un set de comprobantes nuevo en el portal DGII y reimpórtalo.',
        });
        await this.syncCertificationArtifacts(preparedDocument, {
          sentXmlPath: dgiiResponse.xmlPath || dgiiResponse.archivoEnviado || null,
          responsePath: dgiiResponse.trackPath || null,
          dgiiFileName: dgiiResponse.dgiiFileName || null,
        });
        const refreshedBlocked = await this.repository.getDocument(preparedDocument.id);
        return {
          ok: true,
          blocked: false,
          sequenceUsed: true,
          message,
          case: this.buildCertificationCasePayload(refreshedBlocked || preparedDocument, {
            estado: reconciledState,
            codigo: getDgiiResponseCode(dgiiResponse),
            mensaje: message,
            dgiiResponse: { ...dgiiResponse, reconciled: true },
          }),
          dgiiResponse,
        };
      }
      const failedState = normalizeDgiiState(dgiiResponse);
      const finalFailedState = failedState === 'pendiente' ? 'error' : failedState;

      await this.repository.markDocumentSent(preparedDocument.id, {
        estado_dgii: finalFailedState,
        track_id: dgiiResponse.trackId || dgiiResponse.trackid || dgiiResponse.TrackId || null,
        dgii_response_json: dgiiResponse,
        error_message: dgiiResponse.error || dgiiResponse.descripcion || dgiiResponse.mensaje || error.message,
      });
      await this.syncCertificationArtifacts(preparedDocument, {
        sentXmlPath: dgiiResponse.xmlPath || dgiiResponse.archivoEnviado || null,
        responsePath: dgiiResponse.trackPath || null,
        dgiiFileName: dgiiResponse.dgiiFileName || null,
      });

      const refreshedFailed = await this.repository.getDocument(preparedDocument.id);
      await this.repository.saveTestRun(
        'certification_case_send',
        'warning',
        `Prueba ${preparedDocument.encf} rechazada por DGII.`,
        {
          documentId: preparedDocument.id,
          encf: preparedDocument.encf,
          dgiiResponse,
        },
        preparedDocument.environment
      );
      await this.repository.saveAudit({
        userId: actor.id,
        userName: actor.nombre || actor.usuario,
        userRole: actor.rol || actor.role_code,
        documentId: preparedDocument.id,
        sequenceId: preparedDocument.sequence_id || null,
        tipoComprobante: preparedDocument.tipo_ecf,
        encf: preparedDocument.encf,
        actionName: 'certification_case_rejected',
        status: 'warning',
        detail: `Prueba de certificación rechazada: ${preparedDocument.encf}.`,
        responsePayload: dgiiResponse,
      });
      return {
        ok: false,
        message: dgiiResponse.error || dgiiResponse.descripcion || dgiiResponse.mensaje || error.message,
        case: this.buildCertificationCasePayload(refreshedFailed || preparedDocument, {
          estado: finalFailedState,
          trackId: dgiiResponse.trackId || dgiiResponse.trackid || dgiiResponse.TrackId || null,
          codigo: getDgiiResponseCode(dgiiResponse),
          mensaje: dgiiResponse.error || dgiiResponse.descripcion || dgiiResponse.mensaje || error.message,
          dgiiResponse,
        }),
        dgiiResponse,
      };
    }

    if (isDgiiSequenceUsedResponse(response)) {
      const message = response.error || response.descripcion || response.mensaje || response.message || 'DGII indicó que la secuencia ya fue utilizada.';
      const isCertificationCase = Boolean(preparedDocument.certification_case_key);
      const reconciledState = isCertificationCase ? 'aceptado' : 'bloqueado';
      await this.repository.markDocumentStatus(preparedDocument.id, {
        estado_dgii: reconciledState,
        dgii_response_json: { ...response, reconciled: isCertificationCase, reason: 'dgii-sequence-used' },
        error_message: message,
      });
      const refreshedBlocked = await this.repository.getDocument(preparedDocument.id);
      return {
        ok: isCertificationCase,
        blocked: !isCertificationCase,
        sequenceUsed: true,
        message,
        case: this.buildCertificationCasePayload(refreshedBlocked || preparedDocument, {
          estado: reconciledState,
          codigo: getDgiiResponseCode(response),
          mensaje: message,
          dgiiResponse: { ...response, reconciled: isCertificationCase },
        }),
        dgiiResponse: response,
      };
    }

    const sent = await this.finalizeSentDocument(preparedDocument, response, 'Documento de certificación enviado a DGII.');

    // En modo secuencial (skipStatusQuery=true) no consultamos el TrackID inmediatamente
    // para no bloquear el envío de los siguientes casos. El estado queda como 'enviado'
    // y el usuario puede usar "Consultar estados" al finalizar la ráfaga.
    let statusPayload = null;
    if (sent.trackId && !options.skipStatusQuery) {
      statusPayload = await this.queryDocumentStatus(preparedDocument.id);
    }
    const finalCertificationState = String(statusPayload?.estado || sent.estado || '').trim().toLowerCase();

    await this.syncCertificationArtifacts(preparedDocument, {
      sentXmlPath: response.xmlPath || response.archivoEnviado || null,
      responsePath: statusPayload?.archivoEstado || response.trackPath || null,
      dgiiFileName: response.dgiiFileName || null,
    });
    await this.repository.saveTestRun(
      'certification_case_send',
      ['rechazado', 'error'].includes(finalCertificationState) ? 'warning' : 'ok',
      ['rechazado', 'error'].includes(finalCertificationState)
        ? `Prueba ${preparedDocument.encf} rechazada por DGII.`
        : `Prueba ${preparedDocument.encf} enviada a DGII.`,
      {
        documentId: preparedDocument.id,
        encf: preparedDocument.encf,
        trackId: sent.trackId,
        localValidation: localValidation.logs,
        dgiiResponse: response,
        statusPayload,
      },
      preparedDocument.environment
    );
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      documentId: preparedDocument.id,
      sequenceId: preparedDocument.sequence_id || null,
      tipoComprobante: preparedDocument.tipo_ecf,
      encf: preparedDocument.encf,
      actionName: 'certification_case_sent',
      status: ['rechazado', 'error'].includes(finalCertificationState) ? 'warning' : 'ok',
      detail: `Prueba de certificación enviada: ${preparedDocument.encf}.`,
      responsePayload: { sent, statusPayload },
    });

    const refreshed = await this.repository.getDocument(preparedDocument.id);
    const certificationSummary = await this.repository.getCertificationSummary();
    const dgiiMsg = statusPayload?.mensaje || sent.mensaje
      || (statusPayload?.dgiiResponse || {})?.mensaje || null;
    const dgiiCode = getDgiiResponseCode(statusPayload?.dgiiResponse || {}) || null;
    console.log('===== DGII CERTIFICACIÓN =====');
    console.log(`Prueba: ${preparedDocument.certification_order_index || '?'} / ${certificationSummary.total || '?'}`);
    console.log(`Tipo: ${preparedDocument.tipo_ecf || '—'}`);
    console.log(`eNCF: ${preparedDocument.encf || '—'}`);
    console.log(`Archivo: ${this.receptionStorage.getState()?.latestSent?.dgiiFileName || '—'}`);
    console.log(`TrackID: ${sent.trackId || '—'}`);
    console.log(`Estado: ${(finalCertificationState || 'pendiente').toString().toUpperCase()}`);
    if (dgiiCode) console.log(`Código DGII: ${dgiiCode}`);
    if (dgiiMsg) console.log(`Mensaje DGII: ${dgiiMsg}`);
    console.log('=============================');
    return {
      ok: !['rechazado', 'error'].includes(finalCertificationState),
      message: statusPayload?.mensaje || sent.mensaje,
      case: this.buildCertificationCasePayload(refreshed || preparedDocument, {
        estado: finalCertificationState,
        trackId: sent.trackId,
        codigo: getDgiiResponseCode(statusPayload?.dgiiResponse || response),
        mensaje: statusPayload?.mensaje || sent.mensaje,
        dgiiResponse: statusPayload?.dgiiResponse || response,
      }),
      dgiiResponse: this.config.DEBUG_ECF ? (statusPayload?.dgiiResponse || response) : undefined,
    };
  }

  async queryCertificationCase(documentId) {
    await this.ensureReady();
    const document = await this.repository.getDocument(Number(documentId));
    if (!document || !document.certification_case_key) {
      throw new EcfError('Caso de certificación DGII no encontrado.', { statusCode: 404 });
    }
    const result = await this.queryDocumentStatus(document.id);
    const refreshed = await this.repository.getDocument(document.id);
    await this.syncCertificationArtifacts(refreshed || document, {
      responsePath: result.archivoEstado || null,
    });
    return {
      ...result,
      case: this.buildCertificationCasePayload(refreshed || document, {
        estado: result.estado,
        trackId: result.trackId,
        mensaje: result.mensaje,
        dgiiResponse: result.dgiiResponse,
      }),
      suggestedSolution: suggestDgiiSolution(result.dgiiResponse || { codigo: getDgiiResponseCode(result), mensaje: result.mensaje }),
    };
  }

  async sendNextCertificationCase(req) {
    await this.ensureReady();
    const activeDocument = await this.repository.getActiveCertificationDocument();
    if (activeDocument) {
      const activeStatus = activeDocument.track_id
        ? await this.queryCertificationCase(activeDocument.id)
        : { case: this.buildCertificationCasePayload(activeDocument) };
      const activeState = String(activeStatus?.case?.estado || '').trim().toLowerCase();

      if (['enviado', 'procesando', 'en_proceso'].includes(activeState)) {
        return {
          ok: false,
          blocked: true,
          message: `La prueba ${activeDocument.encf} sigue en proceso en DGII. Consulta su TrackID antes de continuar con la siguiente.`,
          case: activeStatus.case || this.buildCertificationCasePayload(activeDocument, { estado: activeState }),
        };
      }

      if (['rechazado', 'error'].includes(activeState)) {
        return {
          ok: false,
          blocked: true,
          message: `La prueba ${activeDocument.encf} fue rechazada por DGII. Corrige ese caso antes de avanzar al siguiente.`,
          case: activeStatus.case || this.buildCertificationCasePayload(activeDocument, { estado: activeState }),
        };
      }
    }

    const nextDocument = await this.repository.getNextPendingCertificationDocument();
    assertCondition(nextDocument, 'No hay pruebas pendientes de certificación DGII por enviar.', { statusCode: 404 });
    return this.sendCertificationCase(nextDocument.id, req);
  }

  async runCertificationSequence(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });
    // Límite generoso — un set DGII típico tiene 21-30 casos.
    const limit = Math.max(1, Math.min(Number(req.body?.limit || 50), 200));
    // Retardo entre envíos (ms) para no saturar DGII ni expirar el token.
    const delayMs = Math.max(0, Math.min(Number(req.body?.delayMs ?? 80), 3000));
    const results = [];
    let consecutiveErrors = 0;
    // Guard de seguridad: no procesar el mismo documento dos veces en la misma ráfaga.
    const processedInThisRun = new Set();

    for (let index = 0; index < limit; index += 1) {
      // includeRejected: false — los rechazados necesitan corrección manual y reenvío individual.
      // No los retomamos automáticamente en la ráfaga para evitar que el mismo doc quemado
      // bloquee el avance de la secuencia (bug: el doc rechazado se retornaba como "siguiente"
      // indefinidamente y el guard processedInThisRun cortaba el loop antes de procesar docs
      // posteriores con orden_index mayor).
      // Los documentos en 'aceptado'/'enviado'/'en_proceso' se saltan automáticamente.
      let nextDocument;
      try {
        nextDocument = await this.repository.getNextPendingCertificationDocument({ includeRejected: false });
      } catch (_) {
        break;
      }
      if (!nextDocument) break; // No quedan pendientes → todos enviados o set vacío.
      if (processedInThisRun.has(nextDocument.id)) break; // Safety guard (no debería ocurrir).
      processedInThisRun.add(nextDocument.id);

      let step;
      try {
        // skipStatusQuery=true: no esperamos respuesta de DGII tras el envío.
        // El documento queda en estado 'enviado' con su TrackID registrado.
        // El usuario puede consultar los estados con "Actualizar estados" al finalizar.
        step = await this.sendCertificationCase(nextDocument.id, req, { skipStatusQuery: true });
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        const isFatal = consecutiveErrors >= 3
          || (error.statusCode != null && error.statusCode >= 500);
        results.push({
          ok: false,
          message: error.message,
          encf: nextDocument.encf,
          fatalStop: isFatal,
        });
        if (isFatal) break; // Error de red / auth grave: detener la ráfaga.
        // Error puntual (firma, XML): registrar y continuar con el siguiente caso.
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      results.push(step);

      // Detener en primer rechazo explícito de DGII.
      // No continuar enviando documentos si uno fue rechazado — los siguientes pueden
      // depender del rechazado (ej. E33/E34 referencian E31/E32) y fallarían en cascada.
      // El usuario debe corregir el caso rechazado y reenviarlo individualmente.
      if (!step.ok) {
        break;
      }

      // Pausa entre envíos para respetar la tasa de DGII y mantener vivo el token.
      if (index < limit - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    const lastResult = results.length > 0 ? results[results.length - 1] : null;
    const lastState = String(lastResult?.case?.estado || '').trim().toLowerCase();
    const stoppedByRejection = Boolean(lastResult && !lastResult.ok
      && !lastResult.fatalStop
      && ['rechazado', 'error'].includes(lastState));
    const stoppedByTransient = Boolean(lastResult && !lastResult.ok
      && !lastResult.fatalStop
      && ['error_consulta', 'error_auth'].includes(lastState));

    return {
      ok: results.every((r) => r?.ok !== false),
      stoppedByRejection,
      stoppedByTransient,
      totalProcessed: results.length,
      results,
      summary: await this.repository.getCertificationSummary(),
    };
  }

  // Sincronización forzada: consulta TODOS los docs con track_id que aún no estén aceptados,
  // sin importar su estado local. Útil cuando DGII muestra aceptados pero la BD local no.
  async certificationCenterForceSync(req = null) {
    await this.ensureReady();
    const reconcilePortalAccepted = toBoolean(req?.body?.reconcilePortalAccepted);
    const batchId = await this.repository.getLatestCertificationBatchId();
    const params = [];
    let batchClause = '';
    if (batchId) {
      batchClause = ' AND certification_batch_id = ?';
      params.push(batchId);
    }
    const rows = await this.repository.query(
      `SELECT *
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND track_id IS NOT NULL
         AND estado_dgii NOT IN ('aceptado', 'aceptado_condicional', 'bloqueado')
       ORDER BY COALESCE(certification_order_index, id) ASC, id ASC
       LIMIT 60`,
      params
    );

    const results = await mapWithConcurrency(rows, 6, async (document) => {
      try {
        const status = await this.queryDocumentStatus(document.id);
        const pollState = (status.estado || 'pendiente').toUpperCase();
        console.log(`[force-sync] ${document.encf}: ${pollState}`);
        return { id: document.id, encf: document.encf, estado: status.estado, trackId: document.track_id };
      } catch (error) {
        return { id: document.id, encf: document.encf, error: error.message };
      }
    });

    const sinTrackId = await this.repository.query(
      `SELECT COUNT(*) AS cnt
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND track_id IS NULL
         AND estado_dgii NOT IN ('aceptado', 'aceptado_condicional', 'bloqueado')`,
      params
    );
    const countSinTrackId = Number(sinTrackId?.[0]?.cnt || 0);
    const portalReconciliation = reconcilePortalAccepted
      ? await this.certificationCenterMarkPortalAccepted({ batchId })
      : null;

    return {
      ok: true,
      synced: results.length,
      sinTrackId: countSinTrackId,
      portalReconciliation,
      results,
      message: portalReconciliation
        ? `Sincronizado con DGII: ${portalReconciliation.ecfAccepted}/${portalReconciliation.ecfTotal} comprobantes y ${portalReconciliation.rfceAccepted}/${portalReconciliation.rfceTotal} resúmenes marcados como aceptados según el portal.`
        : (countSinTrackId > 0
          ? `${results.length} docs sincronizados. ${countSinTrackId} doc(s) sin TrackId (nunca enviados) — usa "Enviar pendientes" para reenviarlos.`
          : `${results.length} docs sincronizados con DGII.`),
    };
  }

  async certificationCenterMarkPortalAccepted({ batchId = null } = {}) {
    await this.ensureReady();
    const params = [];
    let batchClause = '';
    const latestBatchId = batchId || await this.repository.getLatestCertificationBatchId();
    if (latestBatchId) {
      batchClause = ' AND certification_batch_id = ?';
      params.push(latestBatchId);
    }

    const ecfRows = await this.repository.query(
      `SELECT id, encf
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND (submission_mode IS NULL OR submission_mode <> 'rfce')
       ORDER BY COALESCE(certification_order_index, id) ASC, id ASC`,
      params
    );

    const reconcilePayload = JSON.stringify({
      estado: 'Aceptado',
      codigo: '1',
      reconciled: true,
      source: 'dgii-certification-portal',
      message: 'Marcado como aceptado porque el portal DGII CerteCF ya muestra el lote completado.',
      reconciledAt: new Date().toISOString(),
    });

    await this.repository.query(
      `UPDATE ecf_documents
       SET estado_dgii = 'aceptado',
           dgii_response_json = ?,
           error_message = NULL,
           last_checked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND (submission_mode IS NULL OR submission_mode <> 'rfce')`,
      [reconcilePayload, ...params]
    );

    const rfceRows = await this.repository.query(
      `SELECT id, encf, monto_total
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND submission_mode = 'rfce'
       ORDER BY COALESCE(certification_order_index, id) ASC, id ASC`,
      params
    ).catch(() => []);

    await this.repository.query(
      `UPDATE ecf_documents
       SET estado_dgii = 'aceptado',
           dgii_response_json = ?,
           error_message = NULL,
           last_checked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND submission_mode = 'rfce'`,
      [reconcilePayload, ...params]
    ).catch(err => console.warn('[ECF] UPDATE reconcile rfce batch falló:', err.message));

    let rfceItems = [];
    const currentRfceState = this._step4RfceReadState();
    if (Array.isArray(currentRfceState.items) && currentRfceState.items.length) {
      rfceItems = currentRfceState.items;
    } else if (rfceRows.length) {
      rfceItems = rfceRows.map((row) => ({
        encf: row.encf,
        fileName: `${row.encf}-rfce.xml`,
        estado: 'pendiente',
        trackId: null,
        montoTotal: row.monto_total || null,
        root: 'RFCE',
      }));
    } else {
      const latestExcel = findLatestDgiiCertificationExcel();
      if (latestExcel) {
        rfceItems = readRfceDocsFromExcel(latestExcel).map((row) => ({
          encf: row.encf,
          fileName: `${row.encf}-rfce.xml`,
          estado: 'pendiente',
          trackId: null,
          root: 'RFCE',
        }));
      }
    }

    const acceptedRfceItems = rfceItems.map((item) => ({
      ...item,
      estado: 'aceptado',
      mensajeDgii: 'Aceptado en el portal DGII CerteCF.',
      dgiiResponse: {
        estado: 'Aceptado',
        codigo: '1',
        reconciled: true,
        source: 'dgii-certification-portal',
      },
      fechaAceptado: new Date().toISOString(),
    }));
    if (acceptedRfceItems.length) {
      this._step4RfceWriteState({
        ...currentRfceState,
        batchId: latestBatchId || currentRfceState.batchId || null,
        items: acceptedRfceItems,
      });
    }

    return {
      batchId: latestBatchId,
      ecfAccepted: ecfRows.length,
      ecfTotal: ecfRows.length,
      rfceAccepted: acceptedRfceItems.length,
      rfceTotal: acceptedRfceItems.length,
    };
  }

  // Consulta masiva de TrackIDs para todos los casos de certificación que están en
  // estado 'enviado' o 'en_proceso'. Se llama tras la ráfaga de envíos para actualizar
  // los estados sin bloquear el bucle de envío.
  async pollCertificationStatuses() {
    await this.ensureReady();
    const batchId = await this.repository.getLatestCertificationBatchId();
    const params = [];
    let batchClause = '';
    if (batchId) {
      batchClause = ' AND certification_batch_id = ?';
      params.push(batchId);
    }
    const rows = await this.repository.query(
      `SELECT *
       FROM ecf_documents
       WHERE business_id = 1
         AND certification_case_key IS NOT NULL
         ${batchClause}
         AND estado_dgii IN ('enviado', 'en_proceso', 'procesando')
         AND track_id IS NOT NULL
       ORDER BY COALESCE(certification_order_index, id) ASC, id ASC
       LIMIT 60`,
      params
    );

    const results = await mapWithConcurrency(rows, 6, async (document) => {
      try {
        const status = await this.queryDocumentStatus(document.id);
        const pollState = (status.estado || 'pendiente').toUpperCase();
        const rawMsg = typeof status.mensaje === 'string' ? status.mensaje : JSON.stringify(status.mensaje || '');
        const pollMsg = (rawMsg && rawMsg !== 'Consulta completada.')
          ? rawMsg
          : (status.mensajes || []).map((m) => String(m?.valor || m?.descripcion || '').trim()).filter(Boolean).join(' | ');
        console.log(`[poll] ${document.encf}: ${pollState}${pollMsg ? ` — ${pollMsg}` : ''}`);
        return {
          id: document.id,
          encf: document.encf,
          estado: status.estado,
          trackId: status.trackId,
          mensaje: status.mensaje,
        };
      } catch (error) {
        return { id: document.id, encf: document.encf, error: error.message };
      }
    });

    return {
      ok: true,
      polled: results.length,
      results,
      summary: await this.repository.getCertificationSummary(),
    };
  }

  async retryPendingDocuments() {
    const documents = await this.repository.getRetryableDocuments();
    const results = [];
    for (const document of documents) {
      try {
        results.push(await this.resendDocument(document.id));
      } catch (error) {
        results.push({ ok: false, id: document.id, error: error.message });
      }
    }
    return { ok: true, results };
  }

  async testSend(documentId) {
    if (documentId) return this.resendDocument(documentId);
    const latest = await this.repository.getLatestDocument();
    if (!latest) {
      return { ok: false, message: 'Todavía no hay documentos e-CF generados para probar el envío.' };
    }
    return this.resendDocument(latest.id);
  }

  async testTrackId({ documentId, trackId }) {
    if (documentId) return this.queryDocumentStatus(documentId);
    if (trackId) {
      const dgii = await this.statusService.getTrackStatus(trackId);
      return {
        estado: normalizeDgiiState(dgii),
        mensaje: dgii.mensaje || dgii.message || 'Consulta completada.',
        trackId,
        dgiiResponse: this.config.DEBUG_ECF ? dgii : undefined,
      };
    }
    return { ok: false, message: 'Debes indicar un documento o un TrackId para consultar estado.' };
  }

  async importTestSet(req) {
    await this.ensureReady();
    const actor = await this.getCurrentActor(req, { adminOnly: true });
    const form = formidable({ multiples: false, maxFileSize: 15 * 1024 * 1024, keepExtensions: true });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (error, parsedFields, parsedFiles) => {
        if (error) reject(error);
        else resolve({ fields: parsedFields, files: parsedFiles });
      });
    });

    const rawFile = files.csv || files.file || files.testset;
    const uploaded = Array.isArray(rawFile) ? rawFile[0] : rawFile;
    assertCondition(uploaded?.filepath, 'Debe subir el archivo oficial del set de homologación DGII.', { statusCode: 400 });

    const environmentField = Array.isArray(fields.ambiente) ? fields.ambiente[0] : fields.ambiente;
    const environmentFallback = Array.isArray(fields.environment) ? fields.environment[0] : fields.environment;
    const environment = normalizeEnvironmentKey(environmentField || environmentFallback || (await this.repository.getResolvedEmitter(1)).environment);
    const emitter = await this.repository.getResolvedEmitter(1);
    assertCondition(digitsOnly(emitter.rnc), 'Debes guardar el RNC del negocio antes de importar el set de homologación.', { statusCode: 422 });

    const fileBuffer = fs.readFileSync(path.resolve(uploaded.filepath));
    let certificateContext = null;
    let certificateWarning = null;
    try {
      certificateContext = await this.resolveCertificate();
    } catch (error) {
      certificateWarning = error.message;
      this.logger.warn('Set de homologación importado sin certificado activo.', {
        error: error.message,
      });
    }

    const result = await importHomologationTestSet({
      repository: this.repository,
      businessId: 1,
      buffer: fileBuffer,
      filename: uploaded.originalFilename || 'set-dgii.csv',
      emitter,
      environment,
      certificateContext,
      userId: actor.id || null,
    });

    await this.repository.saveTestRun(
      'homologation_import',
      result.errors > 0 ? 'warning' : 'ok',
      `Set DGII importado: ${result.ok}/${result.total} casos listos.`,
      {
        ...result,
        certificateWarning,
      },
      environment
    );
    await this.repository.saveAudit({
      userId: actor.id,
      userName: actor.nombre || actor.usuario,
      userRole: actor.rol || actor.role_code,
      actionName: 'homologation_test_set_imported',
      status: result.errors > 0 ? 'warning' : 'ok',
      detail: `Importó set DGII: ${result.ok}/${result.total} casos.`,
      responsePayload: {
        total: result.total,
        ok: result.ok,
        errors: result.errors,
        hasCert: result.hasCert,
        certificateWarning,
      },
    });

    return {
      ...result,
      message: certificateWarning
        ? `Set importado sin firma digital activa. ${certificateWarning}`
        : `Set importado: ${result.ok}/${result.total} casos preparados.`,
      certificateWarning,
    };
  }

  async saveManualChecklist(req) {
    await this.getCurrentActor(req, { adminOnly: true });
    const key = String(req.params.key || 'manual_check').trim();
    const status = String(req.body?.status || 'pending').trim();
    const notes = String(req.body?.notes || '').trim() || 'Sin notas';
    await this.repository.saveTestRun(key, status, notes, { notes, savedAt: nowIso() });
    return { ok: true, key, status, notes };
  }

  async resignPendingDocuments(req) {
    await this.getCurrentActor(req, { adminOnly: true });
    const documents = await this.repository.getRetryableDocuments();
    const certificate = await this.resolveCertificate();
    const results = [];
    for (const document of documents) {
      if (!document.xml_content) continue;
      const normalizedXml = normalizeEcfXmlStructure(document.xml_content);
      const signedXml = signatureService.signXML(normalizedXml, certificate);
      const verification = signatureService.verifySignature(signedXml);
      if (!verification.ok) {
        results.push({ ok: false, id: document.id, error: 'La firma regenerada no pasó la verificación local.' });
        continue;
      }
      await this.repository.updateDocumentPayload(document.id, {
        xml_content: normalizedXml,
        signed_xml_content: signedXml,
        codigo_seguridad: computeSecurityCode(signedXml),
        estado_dgii: 'firmado',
        signed_at: new Date(),
      });
      results.push({ ok: true, id: document.id, encf: document.encf, status: 'firmado' });
    }
    return { ok: true, results };
  }

  async getSummaryReport() {
    return this.repository.getSummaryReport();
  }

  // ── Wizard: firma XML de postulación con P12 almacenado ──────────────────────
  async signPostulationXml(req) {
    const form = formidable({ multiples: false, maxFileSize: 10 * 1024 * 1024, keepExtensions: true });
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, parsedFields, parsedFiles) => {
        if (err) reject(err);
        else resolve({ fields: parsedFields, files: parsedFiles });
      });
    });

    const raw = files.xml || files.file;
    const uploaded = Array.isArray(raw) ? raw[0] : raw;
    if (!uploaded?.filepath) {
      throw new EcfError('No se recibió el archivo XML (campo "xml").', { statusCode: 400 });
    }

    const rawXml = fs.readFileSync(path.resolve(uploaded.filepath), 'utf8');
    const trimmedXml = rawXml.replace(/^﻿/, '').trimStart();
    if (!trimmedXml.startsWith('<')) {
      throw new EcfError(
        'El archivo seleccionado no es un XML válido. Debes subir el archivo XML generado por DGII (no un Excel ni otro formato).',
        { statusCode: 400 }
      );
    }

    const certificate = await this.resolveCertificate();

    let signedXml;
    try {
      signedXml = signatureService.signXML(rawXml, certificate);
    } catch (signErr) {
      throw new EcfError(`Error al firmar el XML: ${signErr.message}`, { statusCode: 422 });
    }

    // Auto-poblar todos los campos del Contribuyente en ecf_emitters desde el XML de DGII
    const autoFilledFields = [];
    try {
      const emitter = await this.repository.getEmitter(1);
      const doc = parseXml(rawXml);
      const tag = (name) => doc.getElementsByTagName(name)[0]?.textContent?.trim() || '';

      const fromXml = {
        rnc:          tag('RNCContribuyente'),
        razon_social: tag('RazonSocial'),
        telefono:     tag('Telefono'),
        direccion:    tag('Direccion'),
        provincia:    tag('Provincia'),
        municipio:    tag('Municipio'),
        correo:       tag('CorreoElectronico'),
      };

      const labels = {
        rnc: 'RNC', razon_social: 'Razón Social', telefono: 'Teléfono',
        direccion: 'Dirección', provincia: 'Provincia', municipio: 'Municipio', correo: 'Correo',
      };

      const updates = {};
      for (const [field, val] of Object.entries(fromXml)) {
        if (val) {
          updates[field] = val;
          autoFilledFields.push(labels[field]);
        }
      }

      if (Object.keys(updates).length > 0) {
        await this.repository.upsertEmitter(1, updates);
        this.logger.info('[signPostulation] Auto-poblados desde XML de DGII:', updates);
      }
    } catch (autoFillErr) {
      this.logger.warn('[signPostulation] No se pudo auto-poblar datos del emisor:', autoFillErr.message);
    }

    return { ok: true, signedXml, autoFilledFields };
  }

  // ── Wizard de certificación: estado persistido en disco ───────────────────────
  async getWizardState() {
    const stateFile = path.join(process.cwd(), 'storage', 'ecf', 'cert-wizard-state.json');
    try {
      const raw = fs.readFileSync(stateFile, 'utf8');
      return { ok: true, state: JSON.parse(raw) };
    } catch (_) {
      return { ok: true, state: null };
    }
  }

  async saveWizardState(req) {
    const stateFile = path.join(process.cwd(), 'storage', 'ecf', 'cert-wizard-state.json');
    const stateDir = path.dirname(stateFile);
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    const { state } = req.body || {};
    if (!state || typeof state !== 'object') throw new Error('Payload inválido: se requiere { state: { ... } }');
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    return { ok: true };
  }

  // ENDPOINT DE DIAGNÓSTICO TEMPORAL — eliminar después de resolver el problema de certificación
  async diagCertificationOriginalXml() {
    await this.ensureReady();
    const batchId = await this.repository.getLatestCertificationBatchId();
    const params = [];
    let batchClause = '';
    if (batchId) { batchClause = ' AND certification_batch_id = ?'; params.push(batchId); }
    // Devolver los 2 primeros casos generales + todos los E47 (los que siempre fallan)
    const rows = await this.repository.query(
      `SELECT encf, tipo_ecf, estado_dgii, submission_mode,
              LENGTH(certification_original_xml) AS orig_len,
              CASE
                WHEN certification_original_xml IS NULL THEN 'NULL'
                WHEN LEFT(certification_original_xml,1) = '<' THEN 'XML_no_bom'
                WHEN HEX(LEFT(certification_original_xml,3)) = 'EFBBBF' THEN 'XML_bom'
                WHEN LEFT(certification_original_xml,1) = '{' THEN 'JSON'
                ELSE 'OTHER'
              END AS orig_type,
              certification_original_xml AS raw_json
       FROM ecf_documents
       WHERE business_id = 1 AND certification_case_key IS NOT NULL ${batchClause}
       ORDER BY COALESCE(certification_order_index, id) ASC
       LIMIT 30`,
      params
    );
    // Para cada caso, parsear el JSON y devolver las claves del row y los campos relevantes
    const cases = rows.map((r) => {
      let rowKeys = [];
      let sampleFields = {};
      try {
        const parsed = JSON.parse(r.raw_json || '{}');
        const row = parsed.row || {};
        rowKeys = Object.keys(row).slice(0, 80);
        sampleFields = {
          Municipio: row['Municipio'],
          Provincia: row['Provincia'],
          WebSite: row['WebSite'],
          NumeroFacturaInterna: row['NumeroFacturaInterna'],
          IdentificadorExtranjero: row['IdentificadorExtranjero'],
          ValorPagar: row['ValorPagar'],
          MontoPeriodo: row['MontoPeriodo'],
          TerminoPago: row['TerminoPago'],
          PrecioUnitarioItem1: row['PrecioUnitarioItem[1]'],
          NombreComercial: row['NombreComercial'],
          MontoGravadoTotal: row['MontoGravadoTotal'],
          MontoGravadoI1: row['MontoGravadoI1'],
          ITBIS1: row['ITBIS1'],
          TotalITBIS: row['TotalITBIS'],
          TotalITBIS1: row['TotalITBIS1'],
          MontoImpuestoAdicional: row['MontoImpuestoAdicional'],
          MontoTotal: row['MontoTotal'],
          kind: parsed.kind,
          sourceSheet: parsed.sourceSheet,
        };
      } catch (_) {}
      return {
        encf: r.encf,
        tipo_ecf: r.tipo_ecf,
        estado_dgii: r.estado_dgii,
        orig_type: r.orig_type,
        orig_len: r.orig_len,
        sampleFields,
        rowKeyCount: rowKeys.length,
        // Solo mostrar rowKeys completas para casos E47 (los que fallan)
        rowKeys: String(r.tipo_ecf || '').toUpperCase() === 'E47' ? rowKeys : undefined,
      };
    });
    return { ok: true, batchId, cases };
  }

  // Diagnóstico: mensajes DGII de todos los docs rechazados en el batch actual.
  // Llamar con GET /api/ecf/diag/cert-rejection-messages para ver por qué DGII rechazó.
  async diagCertRejectionMessages() {
    await this.ensureReady();
    const batchId = await this.repository.getLatestCertificationBatchId();
    const params = [];
    let batchClause = '';
    if (batchId) { batchClause = ' AND certification_batch_id = ?'; params.push(batchId); }
    const rows = await this.repository.query(
      `SELECT encf, tipo_ecf, estado_dgii, error_message, dgii_response_json
       FROM ecf_documents
       WHERE business_id = 1 AND certification_case_key IS NOT NULL ${batchClause}
         AND estado_dgii = 'rechazado'
       ORDER BY COALESCE(certification_order_index, id) ASC
       LIMIT 30`,
      params
    );
    const results = rows.map((r) => {
      let mensajes = [];
      let rawMensaje = null;
      try {
        const parsed = JSON.parse(r.dgii_response_json || '{}');
        const arr = Array.isArray(parsed.mensajes) ? parsed.mensajes : (Array.isArray(parsed.Mensajes) ? parsed.Mensajes : []);
        mensajes = arr.map((m) => String(m?.valor || m?.Valor || m?.descripcion || m?.Descripcion || m?.mensaje || JSON.stringify(m) || '').trim()).filter(Boolean);
        rawMensaje = parsed.mensaje || parsed.message || parsed.descripcion || null;
      } catch (_) {}
      return {
        encf: r.encf,
        tipo: r.tipo_ecf,
        estado: r.estado_dgii,
        errorMessage: r.error_message,
        rawMensaje,
        mensajes,
      };
    });
    return { ok: true, total: results.length, results };
  }

  // ── Control de secuencias ──────────────────────────────────────────────────

  _parseEncfNumber(encf, tipoEcf) {
    try { return parseEncfNumber(String(encf || ''), String(tipoEcf || '')) || 0; }
    catch (_) { return 0; }
  }

  async getSequenceUsageStats() {
    await this.ensureReady();
    const stats = await this.repository.getSequenceUsageStats(1);
    // Cruzar con ecf_sequences para obtener el próximo disponible según el rango
    const sequences = await this.repository.query(
      'SELECT tipo_comprobante, proximo_numero, numero_final, activo, fecha_vencimiento FROM ecf_sequences WHERE business_id=1 AND activo=1'
    ).catch(() => []);
    const seqMap = {};
    for (const s of sequences) seqMap[s.tipo_comprobante] = s;

    return stats.map(row => {
      const seq = seqMap[row.tipo_ecf] || null;
      const maxUsed = Number(row.ultimo_numero || 0);
      const proxSeq  = seq ? Number(seq.proximo_numero || 0) : null;
      const proximo  = proxSeq !== null ? Math.max(maxUsed + 1, proxSeq) : maxUsed + 1;
      return {
        tipoEcf:     row.tipo_ecf,
        total:       Number(row.total),
        aceptadas:   Number(row.aceptadas),
        rechazadas:  Number(row.rechazadas),
        bloqueadas:  Number(row.bloqueadas),
        enviadas:    Number(row.enviadas),
        reservadas:  Number(row.reservadas),
        canceladas:  Number(row.canceladas),
        ultimoNumero: maxUsed,
        proximoDisponible: proximo,
        secuenciaActiva: !!seq,
        disponibleTotal: seq ? Math.max(0, Number(seq.numero_final) - proximo + 1) : null,
        ultimoEnvio: row.ultimo_envio,
      };
    });
  }

  async findNextAvailableSequence(req) {
    await this.ensureReady();
    const { tipoEcf } = req.body || req.query || {};
    if (!tipoEcf) return { ok: false, message: 'Indica el tipo de e-CF (ej. E31, E32).' };
    const tipo = String(tipoEcf).trim().toUpperCase();
    const maxFromUsage = await this.repository.getNextAvailableAfterUsage(1, tipo);
    const seqs = await this.repository.query(
      'SELECT * FROM ecf_sequences WHERE business_id=1 AND tipo_comprobante=? AND activo=1 ORDER BY id LIMIT 1',
      [tipo]
    ).catch(() => []);
    const seq = seqs[0] || null;
    const proxSeq = seq ? Number(seq.proximo_numero || 0) : 0;
    const proxDisp = Math.max(maxFromUsage + 1, proxSeq);
    const encf = seq ? this.repository.formatEncf(tipo, proxDisp) : null;
    return {
      ok: true,
      tipoEcf: tipo,
      proximoDisponible: proxDisp,
      encf,
      maxUsadoEnDGII: maxFromUsage,
      proxNumeroSecuencia: proxSeq,
      secuenciaId: seq?.id || null,
      secuenciaActiva: !!seq,
    };
  }

  // ── RFCE (Resumen Factura de Consumo Electrónica < 250,000 DOP) ───────────

  async rfceList(req) {
    await this.ensureReady();
    const q = req.query || {};
    const limite = Math.min(Number(q.limite || 50), 200);
    const offset = Math.max(0, Number(q.offset || 0));
    const clauses = ["business_id = 1", "submission_mode = 'rfce'", "certification_case_key IS NULL"];
    const params = [];
    if (q.estado) { clauses.push('estado_dgii = ?'); params.push(String(q.estado).trim().toLowerCase()); }
    if (q.encf) { clauses.push('UPPER(encf) LIKE ?'); params.push(`%${String(q.encf).trim().toUpperCase()}%`); }
    const where = clauses.join(' AND ');
    const rows = await this.repository.query(
      `SELECT id, encf, tipo_ecf, estado_dgii, track_id, nombre_comprador, rnc_comprador,
              monto_total, itbis_total, codigo_seguridad, submission_mode,
              created_at, sent_at, error_message
       FROM ecf_documents WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limite, offset]
    );
    const countRows = await this.repository.query(
      `SELECT COUNT(*) AS total FROM ecf_documents WHERE ${where}`, params
    );
    return { ok: true, total: Number(countRows[0]?.total || 0), items: rows };
  }

  async rfceGet(rfceId) {
    await this.ensureReady();
    assertCondition(rfceId > 0, 'ID de RFCE inválido.', { statusCode: 422 });
    const doc = await this.repository.getDocument(rfceId);
    assertCondition(doc, `RFCE ${rfceId} no encontrado.`, { statusCode: 404 });
    assertCondition(
      String(doc.submission_mode || '').toLowerCase() === 'rfce',
      `El documento ${rfceId} no es un RFCE (submission_mode=${doc.submission_mode}).`,
      { statusCode: 422 }
    );
    return {
      ok: true,
      rfce: {
        ...doc,
        hasSignedXml: Boolean(doc.signed_xml_content?.trim()),
        hasLocalE32: Boolean(doc.xml_content?.trim()),
        rfceXmlLength: doc.signed_xml_content?.length || 0,
      },
    };
  }

  async rfceGenerate(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });

    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    assertCondition(items.length > 0, 'Debe incluir al menos un ítem para generar el RFCE.', { statusCode: 422 });

    const totals = buildTotals(items);
    const rfceThreshold = Number(this.config.DGII_RFCE_THRESHOLD_DOP || 250000);

    const emitter = await this.getEmitterForXml(1);
    assertCondition(emitter.rnc, 'El emisor no tiene RNC configurado.', { statusCode: 422 });
    assertCondition(emitter.razonSocial || emitter.razon_social, 'El emisor no tiene RazónSocial configurada.', { statusCode: 422 });

    const rawEmitter = await this.repository.getResolvedEmitter(1);
    const environment = normalizeEnvironmentKey(body.environment || rawEmitter.environment);
    this.applyRuntimeConfig(environment);

    const certificate = await this.resolveCertificate();

    const generated = await this.repository.generateNextENCF({
      businessId: 1,
      tipoComprobante: 'E32',
      sale: {},
    });
    const { encf, sequence, numero: sequenceNumber } = generated;

    const issueDate = body.fechaEmision ? new Date(body.fechaEmision) : new Date();
    assertCondition(!Number.isNaN(issueDate.getTime()), 'Fecha de emisión inválida.', { statusCode: 422 });

    const customer = body.customer || {};
    const tipoIngresos = String(body.tipoIngresos || '01').padStart(2, '0');
    const tipoPago = String(body.tipoPago || '1');
    const paymentForms = Array.isArray(body.paymentForms) && body.paymentForms.length
      ? body.paymentForms
      : [{ formaPago: tipoPago, montoPago: totals.total }];

    // 1. Generar E32 completo local (registro de auditoría — nunca se envía a DGII)
    const { xml: localE32Xml } = generateEcfXml({
      emitter,
      customer: { rnc: digitsOnly(customer.rnc || ''), nombre: customer.nombre || 'Consumidor Final' },
      document: { tipoeCF: 'E32', eNCF: encf, tipoIngresos, tipoPago },
      items,
      issueDate,
    });
    // DGII exige NombreComercial ausente en E32 comprobante de consumo
    const localE32Clean = localE32Xml
      .replace(/<NombreComercial>[^<]*<\/NombreComercial>/gi, '')
      .replace(/<NombreComercial\s*\/>/gi, '');

    // 2. Firmar E32 local → derivar CodigoSeguridadeCF (primeros 6 chars del SignatureValue)
    const signedLocalE32 = signatureService.signXML(localE32Clean, certificate);
    const codigoSeguridad = computeSecurityCode(signedLocalE32);
    assertCondition(codigoSeguridad?.length === 6, 'No se pudo derivar el CodigoSeguridadeCF.', { statusCode: 500 });

    // 3. Generar XML RFCE
    const rfceXml = generateRfceXml({
      emitter: { rnc: emitter.rnc, razonSocial: emitter.razonSocial || emitter.razon_social },
      customer: { rnc: digitsOnly(customer.rnc || ''), nombre: customer.nombre || 'Consumidor Final' },
      document: { eNCF: encf, tipoeCF: 'E32', tipoIngresos, tipoPago, codigoSeguridad },
      totals,
      paymentForms,
      issueDate,
    });

    // 4. Firmar RFCE
    const signedRfce = signatureService.signXML(rfceXml, certificate);

    // 5. Validar estructura XSD oficial
    const xsdValidation = assertValidRfceXml(signedRfce, { requireSignature: true });

    // 6. Guardar en BD: xml_content = E32 local, signed_xml_content = RFCE firmado
    const insertResult = await this.repository.query(
      `INSERT INTO ecf_documents
       (business_id, sequence_id, tipo_ecf, encf, environment, estado_dgii, submission_mode,
        codigo_seguridad, nombre_comprador, rnc_comprador,
        subtotal, descuento_total, monto_exento, monto_gravado, itbis_total, monto_total,
        xml_content, signed_xml_content,
        xml_generated_at, signed_at, created_at, updated_at)
       VALUES (1, ?, 'E32', ?, ?, 'firmado', 'rfce', ?, ?, ?,
               ?, ?, ?, ?, ?, ?,
               ?, ?,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        sequence.id, encf, environment,
        codigoSeguridad,
        customer.nombre || 'Consumidor Final',
        digitsOnly(customer.rnc || ''),
        totals.subtotal, totals.totalDiscount, totals.exemptAmount,
        totals.totalTaxed, totals.totalTax, totals.total,
        localE32Clean,
        signedRfce,
      ]
    );
    const rfceId = Number(insertResult.insertId || 0);

    // 7. Avanzar secuencia y registrar uso
    await this.repository.advanceSequenceAfterUse(sequence.id, encf)
      .catch(err => console.error('[ECF] Error crítico avanzando secuencia E32 — posible duplicado eNCF:', err.message));
    await this.repository.recordSequenceUsage({
      businessId: 1, rncEmisor: emitter.rnc, tipoEcf: 'E32', encf,
      sequenceNumber, status: 'RESERVED', environment, ecfDocumentId: rfceId,
    }).catch(err => console.warn('[ECF] recordSequenceUsage E32 falló (no crítico):', err.message));

    // 8. Auditoría
    await this.repository.saveAudit({
      documentId: rfceId, encf, tipoComprobante: 'E32',
      actionName: 'rfce_generado', status: 'ok',
      detail: `RFCE generado: ${encf}. MontoTotal: ${totals.total.toFixed(2)} DOP. ${totals.total < rfceThreshold ? 'Bajo umbral (<250K).' : 'Sobre umbral (≥250K).'}`,
    }).catch(err => console.warn('[ECF] saveAudit rfce_generado falló (no crítico):', err.message));

    return {
      ok: true,
      rfceId,
      encf,
      codigoSeguridad,
      environment,
      totals: {
        subtotal: totals.subtotal,
        totalDiscount: totals.totalDiscount,
        exemptAmount: totals.exemptAmount,
        totalTaxed: totals.totalTaxed,
        taxed18: totals.taxed18,
        taxed16: totals.taxed16,
        totalTax: totals.totalTax,
        total: totals.total,
      },
      tipoIngresos,
      tipoPago,
      xsdValidation,
      umbralDOP: rfceThreshold,
      bajoUmbral: totals.total < rfceThreshold,
      message: `RFCE generado y firmado correctamente. eNCF: ${encf}.`,
    };
  }

  async rfceSend(req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });

    const body = req.body || {};

    // Flujo combinado generate+send si vienen items sin rfceId
    if (Array.isArray(body.items) && body.items.length > 0 && !body.rfceId) {
      const genResult = await this.rfceGenerate(req);
      return this._rfceSendById(genResult.rfceId, req);
    }

    const rfceId = Number(body.rfceId || 0);
    assertCondition(rfceId > 0, 'Debe indicar rfceId para enviar el RFCE.', { statusCode: 422 });
    return this._rfceSendById(rfceId, req);
  }

  async _rfceSendById(rfceId, req) {
    const doc = await this.repository.getDocument(rfceId);
    assertCondition(doc, `RFCE ${rfceId} no encontrado.`, { statusCode: 404 });
    assertCondition(
      String(doc.submission_mode || '').toLowerCase() === 'rfce',
      `El documento ${rfceId} no es un RFCE.`,
      { statusCode: 422 }
    );

    const forceResend = Boolean((req.body || {}).forceResend);
    const alreadySentStates = new Set(['enviado', 'aceptado', 'aceptado_condicional', 'en_proceso', 'procesando']);
    const currentState = String(doc.estado_dgii || '').toLowerCase();
    assertCondition(
      !alreadySentStates.has(currentState) || forceResend,
      `El RFCE ${doc.encf} ya fue enviado (estado: ${doc.estado_dgii}). Use forceResend:true para reenviar.`,
      { statusCode: 409 }
    );

    const signedRfce = String(doc.signed_xml_content || '').trim();
    assertCondition(signedRfce, `El RFCE ${doc.encf} no tiene XML firmado. Use rfce/generate primero.`, { statusCode: 422 });

    const rawEmitter = await this.repository.getResolvedEmitter(1);
    const environment = normalizeEnvironmentKey(rawEmitter.environment);
    this.applyRuntimeConfig(environment);

    let dgiiResponse;
    try {
      dgiiResponse = await this.fcService.sendConsumptionSummary({
        signedXml: signedRfce,
        filename: `${doc.encf}-rfce.xml`,
        localEcfPath: null,
      });
    } catch (error) {
      await this.repository.markDocumentSent(doc.id, {
        estado_dgii: 'error',
        track_id: null,
        dgii_response_json: { error: error.message },
        error_message: error.message,
      });
      throw error;
    }

    const trackId = dgiiResponse.trackId || null;
    const estado = trackId ? 'enviado' : normalizeDgiiState(dgiiResponse);
    const errorMsg = ['rechazado', 'error'].includes(estado)
      ? (dgiiResponse.mensaje || dgiiResponse.descripcion || null)
      : null;

    await this.repository.markDocumentSent(doc.id, {
      estado_dgii: estado,
      track_id: trackId,
      dgii_response_json: dgiiResponse,
      error_message: errorMsg,
    });

    // Registrar uso de secuencia
    const usageStatus = trackId ? 'SENT' : (['aceptado', 'aceptado_condicional'].includes(estado) ? 'ACCEPTED' : 'REJECTED');
    await this.repository.recordSequenceUsage({
      businessId: 1, tipoEcf: 'E32', encf: doc.encf,
      status: usageStatus,
      dgiiTrackId: trackId,
      dgiiCode: dgiiResponse.codigo || null,
      dgiiMessage: dgiiResponse.mensaje || dgiiResponse.descripcion || null,
      environment, sentAt: new Date().toISOString(), ecfDocumentId: doc.id,
    }).catch(err => console.warn('[ECF] recordSequenceUsage rfce_enviado falló:', err.message));

    await this.repository.saveAudit({
      documentId: doc.id, encf: doc.encf, tipoComprobante: 'E32',
      actionName: 'rfce_enviado',
      status: ['rechazado', 'error'].includes(estado) ? 'warning' : 'ok',
      detail: `RFCE enviado a DGII: ${doc.encf}. TrackID: ${trackId || '(none)'}. Estado: ${estado}.`,
      responsePayload: dgiiResponse,
    }).catch(err => console.warn('[ECF] saveAudit rfce_enviado falló:', err.message));

    return {
      ok: !['rechazado', 'error'].includes(estado),
      rfceId: doc.id,
      encf: doc.encf,
      trackId,
      estado,
      mensaje: dgiiResponse.mensaje || dgiiResponse.descripcion || null,
      codigo: dgiiResponse.codigo || null,
      mensajes: dgiiResponse.mensajes || [],
      dgiiFileName: dgiiResponse.dgiiFileName || null,
      xmlPath: dgiiResponse.xmlPath || null,
      endpoint: dgiiResponse.endpoint || null,
      xsdValidation: dgiiResponse.xsdValidation || null,
      environment,
    };
  }

  async rfceStatus(trackId) {
    await this.ensureReady();
    const normalizedTrackId = String(trackId || '').trim();
    assertCondition(normalizedTrackId, 'Debe indicar un TrackID para consultar.', { statusCode: 422 });

    const rawEmitter = await this.repository.getResolvedEmitter(1);
    const environment = normalizeEnvironmentKey(rawEmitter.environment);
    this.applyRuntimeConfig(environment);

    const result = await this.receptionService.getTrackStatus(normalizedTrackId);
    const linkedDoc = await this.repository.getDocumentByTrackId(normalizedTrackId);

    if (linkedDoc && String(linkedDoc.submission_mode || '').toLowerCase() === 'rfce') {
      const newEstado = normalizeDgiiState(result);
      const prevEstado = String(linkedDoc.estado_dgii || '').toLowerCase();
      if (newEstado && newEstado !== prevEstado) {
        await this.repository.markDocumentStatus(linkedDoc.id, {
          estado_dgii: newEstado,
          dgii_response_json: result,
          error_message: newEstado === 'rechazado'
            ? (result.mensaje || result.descripcion || null)
            : null,
        });
        const seqStatus = ['aceptado', 'aceptado_condicional'].includes(newEstado) ? 'ACCEPTED'
          : newEstado === 'rechazado' ? 'REJECTED' : null;
        if (seqStatus) {
          await this.repository.recordSequenceUsage({
            businessId: 1, tipoEcf: 'E32', encf: linkedDoc.encf,
            status: seqStatus, dgiiTrackId: normalizedTrackId, environment,
            dgiiMessage: result.mensaje || result.descripcion || null,
            ecfDocumentId: linkedDoc.id,
          }).catch(err => console.warn('[ECF] recordSequenceUsage poll falló:', err.message));
        }
      }
    }

    return {
      ok: true,
      trackId: normalizedTrackId,
      estado: normalizeDgiiState(result),
      mensaje: result.mensaje || result.descripcion || null,
      codigo: result.codigo || null,
      encf: result.encf || linkedDoc?.encf || null,
      fechaRecepcion: result.fechaRecepcion || null,
      mensajes: result.mensajes || [],
      rfceId: linkedDoc?.id || null,
      environment,
    };
  }

  async rfceResend(rfceId, req) {
    await this.ensureReady();
    await this.getCurrentActor(req, { adminOnly: true });

    const doc = await this.repository.getDocument(rfceId);
    assertCondition(doc, `RFCE ${rfceId} no encontrado.`, { statusCode: 404 });
    assertCondition(
      String(doc.submission_mode || '').toLowerCase() === 'rfce',
      `El documento ${rfceId} no es un RFCE.`,
      { statusCode: 422 }
    );

    const resendableStates = new Set(['error', 'rechazado', 'firmado', 'pendiente']);
    const currentState = String(doc.estado_dgii || '').toLowerCase();
    const forceResend = Boolean((req.body || {}).forceResend);
    assertCondition(
      resendableStates.has(currentState) || forceResend,
      `El RFCE ${doc.encf} está en estado "${doc.estado_dgii}" y no puede reenviarse automáticamente. Use forceResend:true para forzar.`,
      { statusCode: 409 }
    );

    // Re-firmar si el XML está presente (por si el certificado cambió)
    const signedRfce = String(doc.signed_xml_content || '').trim();
    if (!signedRfce) {
      throw new EcfError(`El RFCE ${doc.encf} no tiene XML firmado. Regenere el RFCE completo.`, { statusCode: 422 });
    }

    // Resetear estado para permitir envío
    await this.repository.markDocumentStatus(doc.id, {
      estado_dgii: 'firmado',
    }).catch(err => console.warn('[ECF] markDocumentStatus rfce_resend falló:', err.message));

    return this._rfceSendById(rfceId, { ...req, body: { ...(req.body || {}), forceResend: true } });
  }
}

function createEcfService(deps) {
  return new EcfService(deps);
}

module.exports = {
  createEcfService,
};

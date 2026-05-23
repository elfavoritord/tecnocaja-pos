'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { buildEcfConfig } = require('../modules/ecf/config/ecf.config');
const { DgiiClient } = require('../modules/ecf/dgii/client');
const { AuthService } = require('../modules/ecf/services/auth.service');
const { SeedStorageService } = require('../modules/ecf/services/seed-storage.service');
const signatureService = require('../modules/ecf/signature/signature.service');
const { generateEcfXml } = require('../modules/ecf/services/ecf-generator');
const { createLogger } = require('../modules/ecf/utils/logger');

const ARTIFACT_DIR = path.resolve(__dirname, '..', 'logs', 'ecf-smoke');

function ensureArtifactDir() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function writeArtifact(name, content) {
  ensureArtifactDir();
  const filePath = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(filePath, String(content || ''), 'utf8');
  return filePath;
}

function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

function printResult(label, payload) {
  console.log(`${label}: ${JSON.stringify(payload, null, 2)}`);
}

function buildSimpleInvoice(config) {
  return generateEcfXml({
    emitter: {
      rnc: config.DGII_RNC,
      razonSocial: 'TECNO CAJA TEST',
      nombreComercial: 'TECNO CAJA TEST',
      direccion: 'Santo Domingo',
      telefono: '8090000000',
      correo: 'facturacion@test.local',
    },
    customer: {
      nombre: 'Consumidor Final',
      rnc: '',
      telefono: '',
      correo: '',
      direccion: '',
    },
    document: {
      eNCF: `E32${String(Date.now()).slice(-11)}`,
      tipoeCF: 'E32',
      tipoIngresos: '01',
      tipoPago: '1',
    },
    items: [
      {
        name: 'Producto de prueba',
        quantity: 1,
        unitPrice: 100,
        discount: 0,
        taxRate: 18,
      },
    ],
    issueDate: new Date(),
  });
}

async function main() {
  const config = buildEcfConfig();
  const logger = createLogger('ecf.smoke', { debug: true });
  const seedStorage = new SeedStorageService({ logger });
  const dgiiClient = new DgiiClient({ config, logger });
  const authService = new AuthService({
    config,
    dgiiClient,
    signatureService,
    logger,
    seedStorage,
    certificateResolver: async () => signatureService.loadCertificate({
      certPath: config.CERT_PATH,
      certPassword: config.CERT_PASSWORD,
    }),
  });

  printSection('Configuracion');
  printResult('config', {
    DGII_ENV: config.DGII_ENV,
    DGII_RNC: config.DGII_RNC,
    CERT_PATH: config.CERT_PATH,
    DEBUG_ECF: config.DEBUG_ECF,
  });

  printSection('Paso 2 - Certificado');
  const certificate = signatureService.loadCertificate({
    certPath: config.CERT_PATH,
    certPassword: config.CERT_PASSWORD,
  });
  const certificateValidation = signatureService.validateCertificate(certificate, {
    expectedRnc: config.DGII_RNC,
  });
  const simpleProbeXml = '<?xml version="1.0" encoding="UTF-8"?><Prueba><Valor>OK</Valor></Prueba>';
  const signedProbeXml = signatureService.signXML(simpleProbeXml, certificate);
  const probeVerification = signatureService.verifySignature(signedProbeXml);
  writeArtifact('probe.xml', simpleProbeXml);
  writeArtifact('probe-signed.xml', signedProbeXml);
  printResult('certificateValidation', certificateValidation);
  printResult('probeVerification', probeVerification);

  if (!certificateValidation.isValidNow || !probeVerification.ok) {
    throw new Error('El certificado no pasó la validación local completa.');
  }

  printSection('Paso 4 - Generacion XML');
  const generated = buildSimpleInvoice(config);
  const xmlPath = writeArtifact('factura-simple.xml', generated.xml);
  printResult('invoiceTotals', generated.totals);
  printResult('invoiceArtifact', { xmlPath });

  printSection('Paso 5 - Firma XML e-CF');
  const signedInvoiceXml = signatureService.signXML(generated.xml, certificate);
  const signedInvoiceVerification = signatureService.verifySignature(signedInvoiceXml);
  const signedXmlPath = writeArtifact('factura-simple-firmada.xml', signedInvoiceXml);
  printResult('signedInvoiceVerification', signedInvoiceVerification);
  printResult('signedInvoiceArtifact', { signedXmlPath });

  if (!signedInvoiceVerification.ok) {
    throw new Error('La factura simple no pasó la verificación local de firma.');
  }

  printSection('Paso 3 - Autenticacion DGII');
  const seed = await authService.requestSeed();
  printResult('seed', {
    semillaDetectada: Boolean(seed.value),
    semillaPreview: seed.value ? `${seed.value.slice(0, 12)}...` : '',
    fecha: seed.fecha || null,
    url: config.DGII_SEMILLA_URL,
    archivo: seed.storage?.xmlPath || null,
  });

  const signedSeedXml = signatureService.signXML(seed.xml, certificate);
  const signedSeed = seedStorage.markSigned({
    id: seed.storage?.id,
    signedXml: signedSeedXml,
    estado: 'firmada',
  });
  const authResponse = await dgiiClient.validateSeed(signedSeedXml);
  printResult('authResponse', {
    httpStatus: authResponse.http?.status,
    tokenDetected: Boolean(authResponse.token),
    expedido: authResponse.expedido || null,
    expira: authResponse.expira || null,
    archivoFirmado: signedSeed.signedPath || null,
    raw: authResponse.raw || '',
  });

  if (!authResponse.token) {
    throw new Error(`DGII no entrego token. HTTP ${authResponse.http?.status || 0}. Respuesta: ${authResponse.raw || ''}`);
  }

  printSection('Paso 6 - Envio DGII');
  const reception = await dgiiClient.submitEcf({
    token: authResponse.token,
    signedXml: signedInvoiceXml,
    filename: 'factura-simple-firmada.xml',
  });
  printResult('reception', {
    httpStatus: reception.http?.status,
    trackId: reception.trackId || reception.trackid || reception.TrackId || null,
    mensaje: reception.mensaje || reception.message || null,
    raw: reception.raw || '',
  });

  const trackId = reception.trackId || reception.trackid || reception.TrackId || null;
  if (!trackId) {
    throw new Error(`DGII no devolvio TrackId. HTTP ${reception.http?.status || 0}. Respuesta: ${reception.raw || ''}`);
  }

  printSection('Paso 7 - Consulta TrackId');
  const trackStatus = await dgiiClient.getTrackStatus({
    token: authResponse.token,
    trackId,
  });
  printResult('trackStatus', {
    httpStatus: trackStatus.http?.status,
    estado: trackStatus.estado || trackStatus.Estado || null,
    mensaje: trackStatus.mensaje || trackStatus.message || null,
    raw: trackStatus.raw || '',
  });
}

main().catch((error) => {
  console.error('\nSMOKE TEST FAILED');
  console.error(error.message || error);
  process.exit(1);
});

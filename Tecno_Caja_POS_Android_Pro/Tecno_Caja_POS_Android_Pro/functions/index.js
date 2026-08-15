'use strict';

const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

setGlobalOptions({ region: 'us-central1' });

// Una sola app de Admin SDK para todas las funciones de este proyecto.
// companies.js y fiscal.js llaman admin.firestore() asumiendo que esto ya
// corrió — por eso se inicializa acá, antes de requerirlos.
admin.initializeApp();

// ── Empresa 100% móvil (sin depender de Tecno Caja POS Windows) ────────────
const {
  createMobileCompany,
  updateBusinessCapabilities,
} = require('./companies');
exports.createMobileCompany = createMobileCompany;
exports.updateBusinessCapabilities = updateBusinessCapabilities;

// ── Apertura móvil de una empresa POS ya sincronizada en la nube ─────────
const { getMyCompanyBootstrap } = require('./mobile-bootstrap');
exports.getMyCompanyBootstrap = getMyCompanyBootstrap;

const { createBusinessUser, updateBusinessUser } = require('./users');
exports.createBusinessUser = createBusinessUser;
exports.updateBusinessUser = updateBusinessUser;

const {
  acquireCashRegister,
  releaseCashRegister,
  getMyOpenCashRegister,
} = require('./cash-registers');
exports.acquireCashRegister = acquireCashRegister;
exports.releaseCashRegister = releaseCashRegister;
exports.getMyOpenCashRegister = getMyOpenCashRegister;

const { syncSales } = require('./sales-sync');
exports.syncSales = syncSales;

const { getMyBusinessLicense } = require('./licenses');
exports.getMyBusinessLicense = getMyBusinessLicense;

// ── Servicio fiscal central: único árbitro de NCF/e-CF ─────────────────────
const {
  requestNcf,
  configureNcfSequence,
  listNcfSequences,
  getFiscalSettings,
  updateFiscalSettings,
} = require('./fiscal');
exports.requestNcf = requestNcf;
exports.configureNcfSequence = configureNcfSequence;
exports.listNcfSequences = listNcfSequences;
exports.getFiscalSettings = getFiscalSettings;
exports.updateFiscalSettings = updateFiscalSettings;

// ── Consulta de RNC/Cédula en el padrón descargable de la DGII ───────────
const { dgiiLookup } = require('./dgii');
exports.dgiiLookup = dgiiLookup;

// ── Proceso multiempresa de certificación e-CF ─────────────────────────────
const {
  startEcfCertification,
  getEcfCertificationStatus,
  confirmEcfCertificationStep,
  validateEcfServiceUrls,
} = require('./certification');
exports.startEcfCertification = startEcfCertification;
exports.getEcfCertificationStatus = getEcfCertificationStatus;
exports.confirmEcfCertificationStep = confirmEcfCertificationStep;
exports.validateEcfServiceUrls = validateEcfServiceUrls;

const { uploadEcfCertificate } = require('./certificate-vault');
exports.uploadEcfCertificate = uploadEcfCertificate;

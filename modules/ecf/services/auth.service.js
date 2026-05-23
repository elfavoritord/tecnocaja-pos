'use strict';

const fs = require('fs');
const { EcfError } = require('../utils/errors');
const { SeedStorageService } = require('./seed-storage.service');

class AuthService {
  constructor({ config, dgiiClient, signatureService, logger, certificateResolver, seedStorage }) {
    this.config = config;
    this.dgiiClient = dgiiClient;
    this.signatureService = signatureService;
    this.logger = logger;
    this.certificateResolver = certificateResolver;
    this.seedStorage = seedStorage || new SeedStorageService({ logger });
    this.tokenCache = null;
    this.refreshPromise = null;
  }

  getCachedToken() {
    return this.tokenCache;
  }

  clearToken() {
    this.tokenCache = null;
  }

  isTokenValid(minimumMs = 120000) {
    return Boolean(
      this.tokenCache?.token &&
      this.tokenCache?.expiresAt &&
      this.tokenCache.expiresAt.getTime() - Date.now() > minimumMs
    );
  }

  async requestSeed() {
    const seed = await this.dgiiClient.getSeed();

    if (!String(seed?.xml || '').trim()) {
      throw new EcfError('No se pudo obtener una nueva semilla desde DGII', {
        statusCode: 502,
        details: {
          environment: this.config.DGII_ENV,
          semillaUrl: this.config.DGII_SEMILLA_URL,
          rawResponsePreview: String(seed?.raw || '').slice(0, 240),
        },
      });
    }

    const seedDir = this.seedStorage.getPaths().seedDir;

    if (!fs.existsSync(seedDir)) {
      fs.mkdirSync(seedDir, { recursive: true });
    }

    const entry = this.seedStorage.saveSeed({
      seedXml: seed.xml,
      seedValue: seed.value,
      seedDate: seed.fecha,
      environment: this.config.DGII_ENV,
      estado: 'obtenida',
    });

    console.log('[ECF]');
    console.log('Nueva semilla obtenida');
    console.log(`Ambiente:${this.config.DGII_ENV}`);
    console.log(`Archivo:${entry.xmlPath}`);

    this.logger.info('Nueva semilla obtenida', {
      environment: this.config.DGII_ENV,
      file: entry.xmlPath,
      estado: entry.estado,
      seedDetected: entry.seedDetected,
    });

    return {
      ...seed,
      storage: entry,
    };
  }

  async authenticate({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.isTokenValid()) {
      return {
        token: this.tokenCache.token,
        expedido: this.tokenCache.issuedAt?.toISOString() || null,
        expira: this.tokenCache.expiresAt?.toISOString() || null,
        source: 'cache',
      };
    }

    if (this.refreshPromise && !forceRefresh) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.#refreshToken().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  async #refreshToken() {
    const seed = await this.requestSeed();
    const certificate = await this.certificateResolver();

    const signedSeed = this.signatureService.signXML(seed.xml, certificate);
    const signedEntry = this.seedStorage.markSigned({
      id: seed.storage?.id,
      signedXml: signedSeed,
      estado: 'firmada',
    });

    const localVerification = this.signatureService.verifySignature
      ? this.signatureService.verifySignature(signedSeed)
      : null;

    console.log('\n=========== XML SEMILLA FIRMADA ===========');
    console.log('Environment:', this.config.DGII_ENV);
    console.log('Seed URL:', this.config.DGII_SEMILLA_URL);
    console.log('Validate URL:', this.config.DGII_VALIDAR_SEMILLA_URL);
    console.log('Seed detected:', Boolean(seed.value));
    console.log('Seed date:', seed.fecha || null);
    console.log('Signed XML length:', signedSeed.length);
    console.log('Local verification:', localVerification);
    console.log('Signed XML preview:');
    console.log(String(signedSeed).slice(0, 1200));
    console.log('===========================================\n');

    let auth;
    try {
      auth = await this.dgiiClient.validateSeed(signedSeed);
    } catch (error) {
      this.seedStorage.markFailed({
        id: signedEntry.id,
        error: error.message,
      });
      throw error;
    }

    console.log('\n=========== RESPUESTA DGII VALIDAR SEMILLA ===========');
    console.log('Environment:', this.config.DGII_ENV);
    console.log('HTTP Status:', auth.http?.status);
    console.log('Validate URL:', this.config.DGII_VALIDAR_SEMILLA_URL);
    console.log('Token detected:', Boolean(auth.token));
    console.log('Raw response:');
    console.log(auth.raw || auth.http?.body || '');
    console.log('======================================================\n');

    if (!auth.token) {
      this.seedStorage.markFailed({
        id: signedEntry.id,
        error: 'DGII no devolvió un token de autenticación.',
      });
      throw new EcfError('DGII no devolvió un token de autenticación.', {
        statusCode: 502,
        details: {
          httpStatus: auth.http?.status,
          response: auth.raw || auth.http?.body || '',
          validateUrl: this.config.DGII_VALIDAR_SEMILLA_URL,
        },
      });
    }

    const issuedAt = auth.expedido ? new Date(auth.expedido) : new Date();
    const expiresAt = auth.expira
      ? new Date(auth.expira)
      : new Date(Date.now() + this.config.TOKEN_DURATION * 1000);

    const authenticatedEntry = this.seedStorage.markAuthenticated({
      id: signedEntry.id,
      tokenDetected: Boolean(auth.token),
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    this.tokenCache = {
      token: auth.token,
      issuedAt,
      expiresAt,
      signedSeedXml: signedSeed,
      seedXml: seed.xml,
      semilla: seed.value,
      seedHistoryId: authenticatedEntry.id,
    };

    this.logger.info('Token DGII emitido correctamente.', {
      environment: this.config.DGII_ENV,
      expiresAt: expiresAt.toISOString(),
      issuedAt: issuedAt.toISOString(),
      semillaArchivo: authenticatedEntry.xmlPath,
      semillaFirmadaArchivo: authenticatedEntry.signedPath,
    });

    return {
      token: auth.token,
      expedido: issuedAt.toISOString(),
      expira: expiresAt.toISOString(),
      signedSeedXml: signedSeed,
      seedXml: seed.xml,
      semilla: seed.value,
      seedHistory: authenticatedEntry,
      rawResponse: auth.raw || auth.http?.body || '',
    };
  }
}

module.exports = {
  AuthService,
};

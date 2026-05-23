'use strict';

const fs = require('fs');
const {
  crearArchivoTemporalDGII,
  eliminarArchivoTemporalDGII,
  extractDgiiIdentityFromXml,
  generarNombreArchivoDGII,
  validarNombreArchivoDGII,
} = require('../utils/dgii-file.util');

function pickFirst(source, candidates) {
  for (const key of candidates) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return null;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      return {
        valor: message.valor ?? message.Valor ?? message.message ?? message.mensaje ?? null,
        codigo: message.codigo ?? message.Codigo ?? null,
      };
    })
    .filter((message) => message && (message.valor || message.codigo !== null));
}

class FcService {
  constructor({ authService, dgiiClient, logger, config, storageService }) {
    this.authService = authService;
    this.dgiiClient = dgiiClient;
    this.logger = logger;
    this.config = config || dgiiClient?.config || null;
    this.storageService = storageService || null;
  }

  async sendConsumptionSummary({ signedXml, filename }) {
    const { rncEmisor, encf } = extractDgiiIdentityFromXml(signedXml);
    const dgiiFileName = validarNombreArchivoDGII(generarNombreArchivoDGII(rncEmisor, encf), {
      rnc: rncEmisor,
      encf,
    });
    const savedXml = this.storageService?.saveSentXml({
      xmlContent: signedXml,
      environment: this.config?.DGII_ENV,
      sourcePath: filename || null,
      dgiiFileName,
    }) || null;
    const tempFile = crearArchivoTemporalDGII({
      xmlContent: signedXml,
      dgiiFileName,
      baseDir: process.cwd(),
    });

    console.log('===== ENVÍO DGII =====');
    console.log(`RNC: ${rncEmisor}`);
    console.log(`eNCF: ${encf}`);
    console.log('Archivo Local:');
    console.log(savedXml?.xmlPath || filename || 'RFCE interno');
    console.log('');
    console.log('Archivo DGII:');
    console.log(dgiiFileName);
    console.log('');
    console.log('Estado:');
    console.log('Archivo válido para envío DGII');
    console.log('======================');

    const auth = await this.authService.authenticate();
    let response;
    try {
      response = await this.dgiiClient.submitRfce({
        token: auth.token,
        signedXml: fs.readFileSync(tempFile.tempPath, 'utf8'),
        filename: dgiiFileName,
      });
    } finally {
      eliminarArchivoTemporalDGII(tempFile.tempPath);
    }

    const savedTrack = this.storageService?.saveTrack({
      trackId: response.trackId || null,
      mensaje: pickFirst(response, ['mensaje', 'message', 'Mensaje', 'Message']),
      error: pickFirst(response, ['error', 'Error']),
      codigo: pickFirst(response, ['codigo', 'Codigo']),
      descripcion: pickFirst(response, ['descripcion', 'Descripcion', 'mensaje', 'message']),
      environment: this.config?.DGII_ENV,
      xmlPath: savedXml?.xmlPath || null,
      httpStatus: response.http?.status || null,
      responseBody: response.raw || response.http?.body || '',
    }) || null;

    const result = {
      ...response,
      mensaje: pickFirst(response, ['mensaje', 'message', 'Mensaje', 'Message']),
      error: pickFirst(response, ['error', 'Error']),
      codigo: pickFirst(response, ['codigo', 'Codigo']),
      descripcion: pickFirst(response, ['descripcion', 'Descripcion', 'mensaje', 'message']),
      fecha: response.fecha || response.fechaRecepcion || new Date().toISOString(),
      estado: response.trackId ? 'ENVIADO' : (response.estado || response.error || response.descripcion || response.mensaje || 'ERROR'),
      mensajes: normalizeMessages(response.mensajes || response.Mensajes),
      xmlPath: savedXml?.xmlPath || null,
      archivoEnviado: savedXml?.xmlPath || null,
      trackPath: savedTrack?.trackPath || null,
      dgiiFileName,
    };

    const logPayload = {
      status: result.http?.status,
      elapsedMs: result.http?.elapsedMs,
      filename: dgiiFileName,
      trackId: result.trackId || null,
      codigo: result.codigo || null,
      descripcion: result.descripcion || null,
      error: result.error || null,
    };

    if (Number(result.http?.status || 0) >= 400) {
      this.logger.warn('DGII devolvió observación al enviar resumen RFCE.', logPayload);
    } else {
      this.logger.info('Resumen RFCE enviado a DGII.', logPayload);
    }
    return result;
  }
}

module.exports = {
  FcService,
};

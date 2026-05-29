'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { EcfError, assertCondition } = require('../utils/errors');
const { normalizeReceptionState } = require('./reception-storage.service');
const {
  assertDgiiXmlRoot,
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

function buildDgiiDispatchPlan({ xmlContent, sourcePath = null, storageService = null, environment = 'certecf', baseDir = process.cwd() } = {}) {
  const { rncEmisor, encf } = extractDgiiIdentityFromXml(xmlContent);
  const dgiiFileName = validarNombreArchivoDGII(generarNombreArchivoDGII(rncEmisor, encf), {
    rnc: rncEmisor,
    encf,
  });

  const savedXml = storageService?.saveSentXml({
    xmlContent,
    environment,
    sourcePath,
    dgiiFileName,
  }) || null;

  const tempFile = crearArchivoTemporalDGII({
    xmlContent,
    dgiiFileName,
    baseDir,
  });

  return {
    rncEmisor,
    encf,
    dgiiFileName,
    savedXml,
    tempFile,
  };
}

function logDgiiDispatchPlan({ rncEmisor, encf, savedXml, dgiiFileName }) {
  console.log('===== ENVÍO DGII =====');
  console.log(`RNC: ${rncEmisor}`);
  console.log(`eNCF: ${encf}`);
  console.log('Archivo Local:');
  console.log(savedXml?.xmlPath || '—');
  console.log('');
  console.log('Archivo DGII:');
  console.log(dgiiFileName);
  console.log('');
  console.log('Estado:');
  console.log('Archivo válido para envío DGII');
  console.log('======================');
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

function serializePayload(payload) {
  if (payload === undefined || payload === null) return '';
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload);
}

function parseTrackPayload(payload) {
  const raw = serializePayload(payload).trim();
  if (!raw) {
    return {
      trackId: null,
      mensaje: null,
      error: null,
      codigo: null,
      descripcion: null,
      fecha: null,
      estado: 'ENVIADO',
      raw,
    };
  }

  try {
    const json = typeof payload === 'object' && payload !== null ? payload : JSON.parse(raw);
    return {
      trackId: pickFirst(json, ['trackId', 'TrackId', 'trackid']),
      mensaje: pickFirst(json, ['mensaje', 'message', 'Mensaje', 'Message']),
      error: pickFirst(json, ['error', 'Error', 'detalleError', 'DetalleError']),
      codigo: pickFirst(json, ['codigo', 'Codigo', 'codigorespuesta', 'CodigoRespuesta']),
      descripcion: pickFirst(json, ['descripcion', 'Descripcion', 'descripcionMensaje', 'DescripcionMensaje']),
      fecha: pickFirst(json, ['fechaRecepcion', 'FechaRecepcion', 'fecha', 'Fecha', 'timestamp', 'Timestamp']),
      estado: normalizeReceptionState(
        pickFirst(json, ['estado', 'Estado', 'status', 'mensaje', 'message']) || 'ENVIADO'
      ),
      rnc: pickFirst(json, ['rnc', 'RNC', 'rncemisor', 'RNCEmisor']),
      encf: pickFirst(json, ['encf', 'eNCF', 'NCFElectronico']),
      secuenciaUtilizada: json?.secuenciaUtilizada ?? json?.SecuenciaUtilizada ?? null,
      fechaRecepcion: pickFirst(json, ['fechaRecepcion', 'FechaRecepcion']),
      mensajes: normalizeMessages(json?.mensajes ?? json?.Mensajes),
      raw,
    };
  } catch (_) {
    return {
      trackId: extractTagValue(raw, 'trackId') || extractTagValue(raw, 'TrackId') || null,
      mensaje: extractTagValue(raw, 'mensaje') || extractTagValue(raw, 'Mensaje') || extractTagValue(raw, 'Message') || null,
      error: extractTagValue(raw, 'error') || extractTagValue(raw, 'Error') || null,
      codigo: extractTagValue(raw, 'codigo') || extractTagValue(raw, 'Codigo') || null,
      descripcion: extractTagValue(raw, 'descripcion')
        || extractTagValue(raw, 'Descripcion')
        || extractTagValue(raw, 'DescripcionMensaje')
        || null,
      fecha: extractTagValue(raw, 'fechaRecepcion')
        || extractTagValue(raw, 'FechaRecepcion')
        || extractTagValue(raw, 'fecha')
        || extractTagValue(raw, 'Fecha')
        || null,
      estado: normalizeReceptionState(
        extractTagValue(raw, 'estado')
        || extractTagValue(raw, 'Estado')
        || extractTagValue(raw, 'mensaje')
        || extractTagValue(raw, 'Message')
        || 'ENVIADO'
      ),
      rnc: extractTagValue(raw, 'rnc') || extractTagValue(raw, 'RNC') || null,
      encf: extractTagValue(raw, 'encf') || extractTagValue(raw, 'eNCF') || null,
      secuenciaUtilizada: extractTagValue(raw, 'secuenciaUtilizada') || extractTagValue(raw, 'SecuenciaUtilizada') || null,
      fechaRecepcion: extractTagValue(raw, 'fechaRecepcion') || extractTagValue(raw, 'FechaRecepcion') || null,
      mensajes: [],
      raw,
    };
  }
}

class ReceptionService {
  constructor({ authService, dgiiClient, logger, config, storageService }) {
    this.authService = authService;
    this.dgiiClient = dgiiClient;
    this.logger = logger;
    this.config = config || dgiiClient?.config || null;
    this.storageService = storageService || null;
  }

  async sendSignedEcf({ signedXml = null, filename = null, xmlPath = null }) {
    const xmlFilePath = xmlPath ? path.resolve(String(xmlPath)) : null;
    if (xmlFilePath) {
      assertCondition(fs.existsSync(xmlFilePath), `El XML indicado no existe: ${xmlFilePath}`, { statusCode: 404 });
      signedXml = fs.readFileSync(xmlFilePath, 'utf8');
    }

    const xmlContent = String(signedXml || '');
    assertCondition(xmlContent.trim(), 'El XML firmado no contiene datos para enviar.', { statusCode: 422 });
    const xmlRoot = assertDgiiXmlRoot(xmlContent, 'ECF', this.config?.DGII_RECEPCION_URL || 'Recepcion');
    const dispatchPlan = buildDgiiDispatchPlan({
      xmlContent,
      sourcePath: xmlFilePath,
      storageService: this.storageService,
      environment: this.config?.DGII_ENV,
      baseDir: process.cwd(),
    });

    logDgiiDispatchPlan(dispatchPlan);

    const auth = await this.authService.authenticate();
    const form = new FormData();
    form.append('xml', fs.createReadStream(dispatchPlan.tempFile.tempPath), {
      filename: dispatchPlan.dgiiFileName,
      contentType: 'text/xml',
    });

    const startedAt = Date.now();
    let response;

    try {
      response = await axios.post(this.config.DGII_RECEPCION_URL, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${auth.token}`,
          accept: 'application/json',
        },
        timeout: 45000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        responseType: 'text',
        transformResponse: [(value) => value],
        validateStatus: () => true,
      });
    } catch (error) {
      eliminarArchivoTemporalDGII(dispatchPlan.tempFile.tempPath);
      this.logger.error('Fallo de red enviando e-CF a DGII.', {
        environment: this.config?.DGII_ENV,
        recepcionUrl: this.config?.DGII_RECEPCION_URL,
        filename: dispatchPlan.dgiiFileName,
        error: error.message,
      });
      throw new EcfError(`No se pudo enviar el e-CF a DGII: ${error.message}`, {
        statusCode: 502,
        details: {
          environment: this.config?.DGII_ENV,
          recepcionUrl: this.config?.DGII_RECEPCION_URL,
        },
      });
    }

    const parsed = parseTrackPayload(response.data);
    eliminarArchivoTemporalDGII(dispatchPlan.tempFile.tempPath);
    const savedXml = dispatchPlan.savedXml;

    const savedTrack = this.storageService?.saveTrack({
      trackId: parsed.trackId,
      mensaje: parsed.mensaje,
      error: parsed.error,
      codigo: parsed.codigo,
      descripcion: parsed.descripcion,
      environment: this.config?.DGII_ENV,
      xmlPath: savedXml?.xmlPath || null,
      httpStatus: response.status,
      responseBody: parsed.raw,
    }) || null;

    const result = {
      trackId: parsed.trackId || null,
      mensaje: parsed.mensaje || parsed.descripcion || null,
      error: parsed.error || null,
      codigo: parsed.codigo || null,
      descripcion: parsed.descripcion || parsed.mensaje || null,
      fecha: parsed.fecha || new Date().toISOString(),
      estado: parsed.trackId ? 'ENVIADO' : normalizeReceptionState(parsed.mensaje || parsed.error || 'ENVIADO'),
      xmlPath: savedXml?.xmlPath || null,
      archivoEnviado: savedXml?.xmlPath || null,
      trackPath: savedTrack?.trackPath || null,
      http: {
        status: response.status,
        headers: response.headers,
        body: parsed.raw,
        elapsedMs: Date.now() - startedAt,
      },
      raw: parsed.raw,
      endpoint: this.config.DGII_RECEPCION_URL,
      xmlRoot,
      xmlType: 'ECF',
      requestXmlPath: savedXml?.xmlPath || null,
      requestXml: xmlContent,
    };

    if (response.status >= 200 && response.status < 300 && result.trackId) {
      this.logger.info('e-CF enviado a DGII.', {
        environment: this.config?.DGII_ENV,
        status: response.status,
        elapsedMs: result.http.elapsedMs,
        trackId: result.trackId,
        filename: dispatchPlan.dgiiFileName,
        archivoEnviado: result.xmlPath,
        recepcionUrl: this.config?.DGII_RECEPCION_URL,
        xmlRoot,
        xmlType: 'ECF',
      });
    } else {
      this.logger.warn('DGII devolvió observación al enviar e-CF.', {
        environment: this.config?.DGII_ENV,
        status: response.status,
        elapsedMs: result.http.elapsedMs,
        trackId: result.trackId,
        codigo: result.codigo,
        descripcion: result.descripcion,
        error: result.error,
        recepcionUrl: this.config?.DGII_RECEPCION_URL,
        xmlRoot,
        xmlType: 'ECF',
      });
    }

    if (response.status >= 400) {
      throw new EcfError(result.error || result.descripcion || result.mensaje || `DGII rechazó el envío. HTTP ${response.status}`, {
        statusCode: 502,
        details: result,
      });
    }

    return result;
  }

  async getTrackStatus(trackId) {
    assertCondition(trackId, 'Debe indicar un TrackId para consultar.', { statusCode: 422 });

    const auth = await this.authService.authenticate();
    const startedAt = Date.now();
    let response;

    try {
      response = await axios.get(this.config.DGII_CONSULTA_URL, {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          accept: 'application/json',
        },
        params: {
          TrackId: String(trackId).trim(),
        },
        timeout: 30000,
        responseType: 'text',
        transformResponse: [(value) => value],
        validateStatus: () => true,
      });
    } catch (error) {
      this.logger.error('Fallo de red consultando TrackID en DGII.', {
        environment: this.config?.DGII_ENV,
        consultaUrl: this.config?.DGII_CONSULTA_URL,
        trackId,
        error: error.message,
      });
      throw new EcfError(`No se pudo consultar el TrackID en DGII: ${error.message}`, {
        statusCode: 502,
        details: {
          environment: this.config?.DGII_ENV,
          consultaUrl: this.config?.DGII_CONSULTA_URL,
          trackId,
        },
      });
    }

    const parsed = parseTrackPayload(response.data);
    const savedStatus = this.storageService?.saveTrackStatus({
      trackId,
      payload: parsed,
      environment: this.config?.DGII_ENV,
      httpStatus: response.status,
    }) || null;

    const result = {
      trackId: parsed.trackId || String(trackId).trim(),
      mensaje: parsed.mensaje || parsed.descripcion || null,
      error: parsed.error || null,
      codigo: parsed.codigo || null,
      descripcion: parsed.descripcion || parsed.mensaje || null,
      fecha: parsed.fecha || parsed.fechaRecepcion || new Date().toISOString(),
      estado: String(parsed.codigo || '').trim() === '4'
        ? 'ACEPTADO_CONDICIONAL'
        : normalizeReceptionState(parsed.estado || parsed.mensaje || parsed.error || 'PROCESANDO'),
      rnc: parsed.rnc || null,
      encf: parsed.encf || null,
      secuenciaUtilizada: parsed.secuenciaUtilizada,
      fechaRecepcion: parsed.fechaRecepcion || parsed.fecha || null,
      mensajes: parsed.mensajes || [],
      statusPath: savedStatus?.statusPath || null,
      http: {
        status: response.status,
        headers: response.headers,
        body: parsed.raw,
        elapsedMs: Date.now() - startedAt,
      },
      raw: parsed.raw,
    };

    if (response.status >= 200 && response.status < 300) {
      this.logger.info('TrackID consultado en DGII.', {
        environment: this.config?.DGII_ENV,
        consultaUrl: this.config?.DGII_CONSULTA_URL,
        trackId: result.trackId,
        estado: result.estado,
        status: response.status,
        elapsedMs: result.http.elapsedMs,
      });
    } else {
      this.logger.warn('DGII devolvió observación al consultar TrackID.', {
        environment: this.config?.DGII_ENV,
        consultaUrl: this.config?.DGII_CONSULTA_URL,
        trackId: result.trackId,
        estado: result.estado,
        status: response.status,
        codigo: result.codigo,
        descripcion: result.descripcion,
      });
    }

    if (response.status >= 400) {
      throw new EcfError(result.error || result.descripcion || result.mensaje || `DGII rechazó la consulta del TrackID. HTTP ${response.status}`, {
        statusCode: 502,
        details: result,
      });
    }

    return result;
  }
}

module.exports = {
  ReceptionService,
};

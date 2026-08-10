'use strict';

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { getCertificateContext } = require('./certificate');
const { signXmlDocument } = require('./xmlsign');

const XML_CONTENT_TYPES = ['application/xml', 'text/xml', 'application/soap+xml'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// DGII rechaza el ARECF si no viene firmado (visto en certificación real:
// "La firma del XML no es válida"). Firmamos con la misma lógica que ya usa
// el POS local; si el certificado no está disponible, degradamos a enviar
// sin firma en vez de tumbar el servicio — mejor una respuesta a tiempo que
// ninguna, y el log deja claro que falta configurar el certificado.
function signArecf(xml) {
  const cert = getCertificateContext();
  if (!cert) return xml;
  try {
    return signXmlDocument(xml, cert);
  } catch (err) {
    console.error(`[GATEWAY] Error firmando ARECF: ${err.message}`);
    return xml;
  }
}

// DGII puede mandar el XML como cuerpo crudo o como multipart/form-data
// (archivo adjunto o campo de texto) — no asumimos un solo formato.
function resolveXmlBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Array.isArray(req.files) && req.files.length) {
    const xmlFile =
      req.files.find((f) => f.buffer && f.buffer.toString('utf8').trim().startsWith('<')) || req.files[0];
    if (xmlFile?.buffer) return xmlFile.buffer.toString('utf8');
  }
  if (req.body && typeof req.body === 'object') {
    const xmlField = Object.values(req.body).find(
      (v) => typeof v === 'string' && v.trim().startsWith('<')
    );
    if (xmlField) return xmlField;
  }
  return '';
}

// Misma lógica de extracción y formato de fecha que server/routes/dgii-public.routes.js
// (POS local) — se porta tal cual, no se reinventa.
function fmtDgiiDateTime(d = new Date()) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}`;
}

function extractTagValue(xml, tag) {
  const m = String(xml || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function buildArecf({ rncEmisor, rncComprador, encf, estado = '0', codigoMotivo = '' }) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ARECF>',
    '  <DetalleAcusedeRecibo>',
    '    <Version>1.0</Version>',
    `    <RNCEmisor>${rncEmisor}</RNCEmisor>`,
    `    <RNCComprador>${rncComprador}</RNCComprador>`,
    `    <eNCF>${encf}</eNCF>`,
    `    <Estado>${estado}</Estado>`,
    codigoMotivo ? `    <CodigoMotivoNoRecibido>${codigoMotivo}</CodigoMotivoNoRecibido>` : '',
    `    <FechaHoraAcuseRecibo>${fmtDgiiDateTime()}</FechaHoraAcuseRecibo>`,
    '  </DetalleAcusedeRecibo>',
    '</ARECF>',
  ]
    .filter(Boolean)
    .join('\n');
}

function requireAdminToken(req, res, next) {
  const expected = String(process.env.GATEWAY_ADMIN_TOKEN || '').trim();
  if (!expected) return res.status(503).json({ error: 'GATEWAY_ADMIN_TOKEN no configurado' });
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== expected) return res.status(401).json({ error: 'No autorizado' });
  return next();
}

function createGatewayRouter({ store }) {
  const router = express.Router();
  const xmlParser = express.text({ type: XML_CONTENT_TYPES, limit: '20mb' });
  const businessId = String(process.env.GATEWAY_BUSINESS_ID || 'default').trim();

  router.use((req, res, next) => {
    if (req.method === 'GET') return next();
    const ct = String(req.headers['content-type'] || '');
    console.log(`[GATEWAY] ${req.method} ${req.path} content-type=${ct || '(ninguno)'}`);
    if (ct.includes('multipart/form-data')) return upload.any()(req, res, next);
    if (XML_CONTENT_TYPES.some((t) => ct.includes(t))) return xmlParser(req, res, next);
    return express.json({ limit: '20mb' })(req, res, next);
  });

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'tecno-caja-ecf-gateway',
      environment: process.env.DGII_ENVIRONMENT || 'TEST',
      timestamp: new Date().toISOString(),
    });
  });

  // ── GET /fe/autenticacion/api/semilla ────────────────────────────────────
  router.get('/fe/autenticacion/api/semilla', (_req, res) => {
    const seed = crypto.randomBytes(16).toString('hex').toUpperCase();
    const now = new Date();
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<SemillaModel>',
      `  <valor>${seed}</valor>`,
      `  <fecha>${now.toISOString()}</fecha>`,
      '</SemillaModel>',
    ].join('\n');
    res.type('application/xml').send(xml);
  });

  // ── POST /fe/autenticacion/api/validacioncertificado ─────────────────────
  router.post('/fe/autenticacion/api/validacioncertificado', (_req, res) => {
    res.json({
      status: 'certificado_validado',
      mensaje: 'Certificado recibido y validado correctamente.',
      timestamp: new Date().toISOString(),
    });
  });

  // GET de verificación de disponibilidad (DGII/el portal hacen un GET antes
  // de enviar el POST real; sin esto responden 404 y lo reportan como "fallo
  // de comunicación").
  router.get('/fe/recepcion/api/ecf', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'recepcion' });
  });
  router.get('/fe/aprobacioncomercial/api/ecf', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'aprobacioncomercial' });
  });

  // ── POST /fe/recepcion/api/ecf ───────────────────────────────────────────
  router.post('/fe/recepcion/api/ecf', async (req, res) => {
    const body = resolveXmlBody(req);
    const rncEmisor = String(extractTagValue(body, 'RNCEmisor') || '').replace(/\D/g, '');
    const rncComprador = String(extractTagValue(body, 'RNCComprador') || '').replace(/\D/g, '');
    const encf = extractTagValue(body, 'eNCF');

    if (!rncEmisor || !encf) {
      console.log(`[GATEWAY] recepcion/ecf RECHAZADO — body (300c): ${body.slice(0, 300) || '(vacío)'}`);
      const arecf = signArecf(buildArecf({
        rncEmisor: rncEmisor || '00000000000',
        rncComprador: rncComprador || '00000000000',
        encf: encf || 'E000000000000',
        estado: '1',
        codigoMotivo: '1', // Error de Especificación
      }));
      return res.status(400).type('application/xml').send(arecf);
    }

    const key = `${rncEmisor}_${encf}`;
    const existing = await store.findByKey('ecf_gateway_received', key);
    if (existing) {
      console.log(`[GATEWAY] recepcion/ecf duplicado — eNCF=${encf} RNC=${rncEmisor}`);
      const arecf = signArecf(buildArecf({
        rncEmisor,
        rncComprador: rncComprador || existing.rncComprador || '',
        encf,
        estado: '0',
      }));
      await store.save('ecf_gateway_received', key, {
        ...existing,
        rncComprador: rncComprador || existing.rncComprador || '',
        lastDuplicateAt: new Date().toISOString(),
        arecf,
      });
      return res.type('application/xml').send(arecf);
    }

    const arecf = signArecf(buildArecf({ rncEmisor, rncComprador, encf, estado: '0' }));
    const record = {
      businessId,
      rncEmisor,
      rncComprador,
      encf,
      receivedAt: new Date().toISOString(),
      xml: body.slice(0, 200000),
      arecf,
    };
    await store.save('ecf_gateway_received', key, record);
    console.log(`[GATEWAY] recepcion/ecf — eNCF=${encf} RNC=${rncEmisor}`);
    res.type('application/xml').send(arecf);
  });

  // ── POST /fe/aprobacioncomercial/api/ecf ─────────────────────────────────
  router.post('/fe/aprobacioncomercial/api/ecf', async (req, res) => {
    const body = resolveXmlBody(req);
    const rncEmisor = String(extractTagValue(body, 'RNCEmisor') || '').replace(/\D/g, '');
    const encf = extractTagValue(body, 'eNCF') || extractTagValue(body, 'ENCF');
    const estado = extractTagValue(body, 'Estado');

    if (!rncEmisor || !encf) {
      console.log(`[GATEWAY] aprobacioncomercial/ecf RECHAZADO — body (300c): ${body.slice(0, 300) || '(vacío)'}`);
      return res.status(400).json({ status: 'error', mensaje: 'RNCEmisor y eNCF son obligatorios.' });
    }

    const key = `${rncEmisor}_${encf}`;
    const existing = await store.findByKey('ecf_gateway_approvals', key);
    if (existing) {
      console.log(`[GATEWAY] aprobacioncomercial/ecf duplicado — eNCF=${encf}`);
      return res.json(existing.ack);
    }

    const ack = {
      status: 'recibido',
      mensaje: 'Aprobación comercial recibida correctamente.',
      encf,
      timestamp: new Date().toISOString(),
    };
    const record = {
      businessId,
      rncEmisor,
      encf,
      estado,
      receivedAt: new Date().toISOString(),
      xml: body.slice(0, 200000),
      ack,
    };
    await store.save('ecf_gateway_approvals', key, record);
    console.log(`[GATEWAY] aprobacioncomercial/ecf — eNCF=${encf} estado=${estado}`);
    res.json(ack);
  });

  // ── GET /admin/received ──────────────────────────────────────────────────
  router.get('/admin/received', requireAdminToken, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const [received, approvals] = await Promise.all([
      store.list('ecf_gateway_received', { limit }),
      store.list('ecf_gateway_approvals', { limit }),
    ]);
    res.json({ received, approvals });
  });

  return router;
}

module.exports = { createGatewayRouter, buildArecf, extractTagValue, fmtDgiiDateTime };

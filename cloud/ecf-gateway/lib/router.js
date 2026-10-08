'use strict';

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { getCertificateContextForRnc, sealCertificate } = require('./certificate');
const { signXmlDocument } = require('./xmlsign');
const {
  LEGACY_APPROVALS,
  LEGACY_RECEIVED,
  approvalsCollection,
  createTenantService,
  isValidRnc,
  normalizeRnc,
  receivedCollection,
  safeEqual,
} = require('./tenants');

const XML_CONTENT_TYPES = ['application/xml', 'text/xml', 'application/soap+xml'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Motivos de CodigoMotivoNoRecibido del ARECF (formato DGII).
const MOTIVO_ERROR_ESPECIFICACION = '1';
const MOTIVO_RNC_COMPRADOR_NO_CORRESPONDE = '4';

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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .formatToParts(d)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  const dd = parts.day;
  const mm = parts.month;
  const yyyy = parts.year;
  const hh = parts.hour === '24' ? '00' : parts.hour;
  const mi = parts.minute;
  const ss = parts.second;
  return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}`;
}

function extractTagValue(xml, tag) {
  const m = String(xml || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function buildArecf({ rncEmisor, rncComprador, encf, estado = '0', codigoMotivo = '' }) {
  const motivo = codigoMotivo ? `<CodigoMotivoNoRecibido>${codigoMotivo}</CodigoMotivoNoRecibido>` : '';
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ARECF xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="schema.xsd">',
    '<DetalleAcusedeRecibo>',
    '<Version>1.0</Version>',
    `<RNCEmisor>${rncEmisor}</RNCEmisor>`,
    `<RNCComprador>${rncComprador}</RNCComprador>`,
    `<eNCF>${encf}</eNCF>`,
    `<Estado>${estado}</Estado>`,
    motivo,
    `<FechaHoraAcuseRecibo>${fmtDgiiDateTime()}</FechaHoraAcuseRecibo>`,
    '</DetalleAcusedeRecibo>',
    '</ARECF>',
  ].join('');
}

// Dos tipos de token:
//   - GATEWAY_ADMIN_TOKEN: Emilio. Ve cualquier empresa y registra empresas.
//   - Token de empresa ("<rnc>.<secreto>"): el POS de cada cliente. Solo ve
//     sus propios documentos.
function createAuth(tenants) {
  return async function requireAuth(req, res, next) {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'No autorizado' });

    const adminToken = String(process.env.GATEWAY_ADMIN_TOKEN || '').trim();
    if (adminToken && safeEqual(token, adminToken)) {
      req.gatewayAuth = { role: 'admin' };
      return next();
    }
    const tenant = await tenants.authenticate(token);
    if (tenant) {
      req.gatewayAuth = { role: 'tenant', rnc: tenant.rnc };
      return next();
    }
    return res.status(401).json({ error: 'No autorizado' });
  };
}

function requireAdmin(req, res, next) {
  if (req.gatewayAuth?.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador del Gateway.' });
  return next();
}

function createGatewayRouter({ store, kms }) {
  const router = express.Router();
  const xmlParser = express.text({ type: XML_CONTENT_TYPES, limit: '20mb' });
  const defaultRnc = normalizeRnc(process.env.GATEWAY_DEFAULT_RNC);
  const tenants = createTenantService({
    store,
    defaultRnc,
    defaultBusinessId: String(process.env.GATEWAY_BUSINESS_ID || 'default').trim(),
  });
  const requireAuth = createAuth(tenants);

  // DGII rechaza el ARECF si no viene firmado (visto en certificación real:
  // "La firma del XML no es válida"). Se firma con el certificado de la
  // empresa receptora; si no hay, se envía sin firma en vez de tumbar el
  // servicio — mejor una respuesta a tiempo que ninguna, y el log lo dice.
  async function signArecf(xml, recipientRnc, tenant) {
    const cert = await getCertificateContextForRnc(recipientRnc, store, {
      tenant,
      // CERT_PATH es el certificado de la empresa por defecto: nunca se firma
      // con él a nombre de otra empresa.
      allowEnvCert: tenant ? Boolean(tenant.isDefault || tenant.legacy) : !defaultRnc,
      kms,
    });
    if (!cert) return xml;
    try {
      return signXmlDocument(xml, cert);
    } catch (err) {
      console.error(`[GATEWAY] Error firmando ARECF: ${err.message}`);
      return xml;
    }
  }

  // Empresa que se consulta en /admin: la del token de empresa (no puede
  // pedir otra), o ?rnc= / la empresa por defecto para el administrador.
  function scopeRnc(req, res) {
    const requested = normalizeRnc(req.params.rnc || req.query.rnc);
    if (req.gatewayAuth.role === 'tenant') {
      if (requested && requested !== req.gatewayAuth.rnc) {
        res.status(403).json({ error: 'Este token no tiene acceso a esa empresa.' });
        return null;
      }
      return req.gatewayAuth.rnc;
    }
    const rnc = requested || defaultRnc;
    if (!rnc) {
      res.status(400).json({ error: 'Indica ?rnc=<RNC de la empresa>.' });
      return null;
    }
    return rnc;
  }

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
      multiempresa: Boolean(defaultRnc),
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
    const tenant = await tenants.resolve(rncComprador);

    if (!rncEmisor || !encf) {
      console.log(`[GATEWAY] recepcion/ecf RECHAZADO — body (300c): ${body.slice(0, 300) || '(vacío)'}`);
      const arecf = await signArecf(buildArecf({
        rncEmisor: rncEmisor || '00000000000',
        rncComprador: rncComprador || '00000000000',
        encf: encf || 'E000000000000',
        estado: '1',
        codigoMotivo: MOTIVO_ERROR_ESPECIFICACION,
      }), rncComprador, tenant);
      return res.status(400).type('application/xml').send(arecf);
    }

    if (!tenant) {
      console.log(`[GATEWAY] recepcion/ecf RECHAZADO — RNCComprador=${rncComprador || '(vacío)'} no es una empresa de este Gateway (eNCF=${encf})`);
      const arecf = await signArecf(buildArecf({
        rncEmisor,
        rncComprador,
        encf,
        estado: '1',
        codigoMotivo: MOTIVO_RNC_COMPRADOR_NO_CORRESPONDE,
      }), rncComprador, null);
      return res.type('application/xml').send(arecf);
    }

    const collection = receivedCollection(tenant.rnc);
    const key = `${rncEmisor}_${encf}`;
    const existing = await store.findByKey(collection, key);
    if (existing) {
      console.log(`[GATEWAY] recepcion/ecf duplicado — eNCF=${encf} RNC=${rncEmisor} receptor=${tenant.rnc}`);
      const arecf = await signArecf(buildArecf({
        rncEmisor,
        rncComprador,
        encf,
        estado: '0',
      }), rncComprador, tenant);
      await store.save(collection, key, {
        ...existing,
        lastDuplicateAt: new Date().toISOString(),
        arecf,
      });
      return res.type('application/xml').send(arecf);
    }

    const arecf = await signArecf(
      buildArecf({ rncEmisor, rncComprador, encf, estado: '0' }),
      rncComprador,
      tenant
    );
    const record = {
      tenantRnc: tenant.rnc,
      businessId: tenant.businessId || null,
      rncEmisor,
      rncComprador,
      encf,
      receivedAt: new Date().toISOString(),
      xml: body.slice(0, 200000),
      arecf,
    };
    await store.save(collection, key, record);
    console.log(`[GATEWAY] recepcion/ecf — eNCF=${encf} RNC=${rncEmisor} receptor=${tenant.rnc}`);
    res.type('application/xml').send(arecf);
  });

  // ── POST /fe/aprobacioncomercial/api/ecf ─────────────────────────────────
  router.post('/fe/aprobacioncomercial/api/ecf', async (req, res) => {
    const body = resolveXmlBody(req);
    const rncEmisor = String(extractTagValue(body, 'RNCEmisor') || '').replace(/\D/g, '');
    const rncComprador = String(extractTagValue(body, 'RNCComprador') || '').replace(/\D/g, '');
    const encf = extractTagValue(body, 'eNCF') || extractTagValue(body, 'ENCF');
    const estado = extractTagValue(body, 'Estado');

    if (!rncEmisor || !encf) {
      console.log(`[GATEWAY] aprobacioncomercial/ecf RECHAZADO — body (300c): ${body.slice(0, 300) || '(vacío)'}`);
      return res.status(400).json({ status: 'error', mensaje: 'RNCEmisor y eNCF son obligatorios.' });
    }

    // La aprobación llega a la empresa que EMITIÓ la factura.
    const tenant = await tenants.resolve(rncEmisor);
    if (!tenant) {
      console.log(`[GATEWAY] aprobacioncomercial/ecf RECHAZADO — RNCEmisor=${rncEmisor} no es una empresa de este Gateway (eNCF=${encf})`);
      return res.status(400).json({
        status: 'error',
        mensaje: 'El RNCEmisor no corresponde a una empresa de este servicio.',
      });
    }

    const collection = approvalsCollection(tenant.rnc);
    const key = `${rncEmisor}_${encf}`;
    const existing = await store.findByKey(collection, key);
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
      tenantRnc: tenant.rnc,
      businessId: tenant.businessId || null,
      rncEmisor,
      rncComprador,
      encf,
      estado,
      receivedAt: new Date().toISOString(),
      xml: body.slice(0, 200000),
      ack,
    };
    await store.save(collection, key, record);
    console.log(`[GATEWAY] aprobacioncomercial/ecf — eNCF=${encf} estado=${estado} emisor=${tenant.rnc}`);
    res.json(ack);
  });

  // ── GET /admin/received ──────────────────────────────────────────────────
  // ?rnc= elige la empresa (solo administrador). Con token de empresa siempre
  // devuelve la suya.
  router.get('/admin/received', requireAuth, async (req, res) => {
    const rnc = scopeRnc(req, res);
    if (!rnc) return;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const lists = [
      store.list(receivedCollection(rnc), { limit }),
      store.list(approvalsCollection(rnc), { limit }),
    ];
    // Lo recibido antes del modo multiempresa es todo de la empresa por defecto.
    if (rnc === defaultRnc) {
      lists.push(store.list(LEGACY_RECEIVED, { limit }), store.list(LEGACY_APPROVALS, { limit }));
    }
    const [received, approvals, legacyReceived = [], legacyApprovals = []] = await Promise.all(lists);
    const newestFirst = (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
    res.json({
      rnc,
      received: [...received, ...legacyReceived].sort(newestFirst).slice(0, limit),
      approvals: [...approvals, ...legacyApprovals].sort(newestFirst).slice(0, limit),
    });
  });

  // ── Empresas del Gateway ─────────────────────────────────────────────────
  router.get('/admin/tenants', requireAuth, requireAdmin, async (_req, res) => {
    res.json({ tenants: await tenants.list() });
  });

  // Registra o actualiza una empresa. El token de empresa solo se devuelve
  // al crearla o con rotateToken: true — guárdalo, no se puede volver a ver.
  router.post('/admin/tenants', requireAuth, requireAdmin, async (req, res) => {
    const rnc = normalizeRnc(req.body?.rnc);
    if (!isValidRnc(rnc)) return res.status(400).json({ error: 'El RNC debe tener 9 u 11 dígitos.' });
    const result = await tenants.upsert({
      rnc,
      nombre: req.body?.nombre,
      businessId: req.body?.businessId,
      active: typeof req.body?.active === 'boolean' ? req.body.active : undefined,
      rotateToken: req.body?.rotateToken === true,
    });
    console.log(`[GATEWAY] empresa ${result.created ? 'registrada' : 'actualizada'}: ${rnc}`);
    res.status(result.created ? 201 : 200).json({ tenant: result.tenant, token: result.token });
  });

  // Sube el .p12 con el que se firma el ARECF de esa empresa. Acepta
  // multipart (archivo + campo "password") o JSON { certificateBase64, password }.
  router.put('/admin/tenants/:rnc/certificate', requireAuth, async (req, res) => {
    const rnc = scopeRnc(req, res);
    if (!rnc) return;
    if (!(await tenants.exists(rnc))) {
      return res.status(404).json({ error: 'Registra primero la empresa (POST /admin/tenants).' });
    }
    const file = Array.isArray(req.files) ? req.files[0] : null;
    const p12Buffer = file?.buffer || Buffer.from(String(req.body?.certificateBase64 || ''), 'base64');
    let certificate;
    try {
      certificate = await sealCertificate({ p12Buffer, password: String(req.body?.password || ''), kms });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    } finally {
      p12Buffer.fill(0);
    }
    const tenant = await tenants.saveCertificate(rnc, certificate);
    console.log(`[GATEWAY] certificado actualizado para ${rnc}: ${certificate.subject} (vence ${certificate.validTo})`);
    res.json({ tenant });
  });

  return router;
}

module.exports = { createGatewayRouter, buildArecf, extractTagValue, fmtDgiiDateTime };

// ══════════════════════════════════════════════════════════════════════════════
//  fiscal.routes.js  —  Tecno Caja e-CF / DGII
//  Todos los endpoints de la API fiscal. Montado en /api/fiscal por server.js.
//  Requiere: query, withTransaction, resolveRequestActorUser,
//            isGlobalAdministratorUser, isBranchAdministratorUser,
//            userRoleHasPermission  (inyectados vía factory).
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs         = require('fs');
const { formidable } = require('formidable');
const express    = require('express');

const { ensureFiscalExtensions, writeFiscalAuditLog } = require('../fiscal/fiscalExtensions');
const certSvc    = require('../fiscal/fiscalCertificateService');
const authSvc    = require('../fiscal/dgiiAuthService');
const seqSvc     = require('../fiscal/ncfSequenceService');
const modeSvc    = require('../fiscal/fiscalModeService');
const senderSvc  = require('../fiscal/ecfSenderService');
const homologationSvc  = require('../fiscal/homologationService');
const testSetImporter  = require('../fiscal/testSetImporter');
const { signXml, generateSecurityCodeFromSignedXml } = require('../fiscal/ecfXmlService');

// ── PERMISOS ──────────────────────────────────────────────────────────────────
function canViewFiscal(user)    { return isAdmin(user) || hasPerm(user, 'fiscal.config.view', 'gestionar_configuracion_fiscal', 'gestionar_ecf'); }
function canEditFiscal(user)    { return isAdmin(user) || hasPerm(user, 'fiscal.config.edit', 'gestionar_configuracion_fiscal', 'gestionar_ecf'); }
function canManageCert(user)    { return isAdmin(user) || hasPerm(user, 'fiscal.certificate.upload', 'gestionar_configuracion_fiscal'); }
function canManageSeq(user)     { return isAdmin(user) || hasPerm(user, 'fiscal.sequence.create', 'gestionar_configuracion_fiscal'); }
function canViewSeq(user)       { return isAdmin(user) || hasPerm(user, 'fiscal.sequence.view', 'fiscal.config.view', 'gestionar_configuracion_fiscal'); }
function canViewDocs(user)      { return isAdmin(user) || hasPerm(user, 'fiscal.invoice.view_status', 'fiscal.config.view'); }
function canResendDoc(user)     { return isAdmin(user) || hasPerm(user, 'fiscal.invoice.resend', 'gestionar_ecf'); }
function canViewXml(user)       { return isAdmin(user) || hasPerm(user, 'fiscal.invoice.view_xml', 'gestionar_configuracion_fiscal'); }

function isAdmin(u)             { return isGlobalAdmin(u) || isBranchAdmin(u); }
function isGlobalAdmin(u)       { return normRole(u) === 'administrador_general'; }
function isBranchAdmin(u)       { return normRole(u) === 'administrador_sucursal'; }
function normRole(u)            { return String(u?.role_code || u?.rol || '').trim().toLowerCase(); }
function hasPerm(u, ...perms)   {
  const vals = new Set(parsePerms(u?.role_permissions));
  if (vals.has('*')) return true;
  return perms.some(p => vals.has(p));
}
function parsePerms(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch (_) { return []; }
}

// ── FACTORY ───────────────────────────────────────────────────────────────────
/**
 * @param {{ query, withTransaction, resolveRequestActorUser }} deps
 */
function createFiscalRouter(deps) {
  const { query, withTransaction, resolveRequestActorUser } = deps;
  const router = express.Router();

  // Memoize ensureFiscalExtensions (solo una vez al primer uso)
  let _extensionsReady = false;
  async function ensureReady() {
    if (_extensionsReady) return;
    await ensureFiscalExtensions(query, async (table, col, def) => {
      try {
        const client = String(process.env.DB_CLIENT || 'sqlite').toLowerCase();
        if (client === 'mysql') {
          const cols = await query(`SHOW COLUMNS FROM \`${table}\` LIKE '${col}'`);
          if (cols.length) return;
          await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${def}`);
        } else {
          const info = await query(`PRAGMA table_info(${table})`);
          if (info.some(c => c.name === col)) return;
          await query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
        }
      } catch (_) {}
    });
    _extensionsReady = true;
  }

  // Helper: obtener business_id del contexto actual
  async function resolveBusinessId(req) {
    const configRows = await query('SELECT business_id FROM config WHERE id = 1 LIMIT 1');
    return Number(configRows[0]?.business_id || 1);
  }

  // ── GET /api/fiscal/status  ─────────────────────────────────────────────────
  // Estado general del módulo fiscal (modo, cert, secuencias)
  router.get('/status', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewFiscal(actor)) return res.status(403).json({ error: 'Sin permiso para ver configuración fiscal.' });
      const businessId = await resolveBusinessId(req);
      const state = await modeSvc.getFiscalMode(query, businessId);
      const cert  = await certSvc.getCertificateStatus(query, businessId);
      res.json({ ...state, certificate: cert });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── GET /api/fiscal/config  ─────────────────────────────────────────────────
  router.get('/config', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewFiscal(actor)) return res.status(403).json({ error: 'Sin permiso.' });
      const businessId = await resolveBusinessId(req);
      const rows = await query('SELECT * FROM fiscal_config WHERE business_id = ? LIMIT 1', [businessId]);
      const biz  = await query('SELECT id, nombre, razon_social, nombre_comercial, rnc, direccion, municipio, provincia, telefono, correo FROM businesses WHERE id = ? LIMIT 1', [businessId]);
      res.json({ config: rows[0] || null, business: biz[0] || null });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── GET /api/fiscal/config/dgii  ──────────────────────────────────────────
  router.get('/config/dgii', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewFiscal(actor)) return res.status(403).json({ error: 'Sin permiso.' });
      const businessId = await resolveBusinessId(req);
      const bundle = await homologationSvc.getDgiiConfigBundle(query, businessId);
      res.json(bundle);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/config/dgii  ─────────────────────────────────────────
  router.post('/config/dgii', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canEditFiscal(actor)) return res.status(403).json({ error: 'Sin permiso para editar la configuración DGII.' });
      const businessId = await resolveBusinessId(req);
      const bundle = await homologationSvc.saveDgiiSettings(query, businessId, req.body || {}, {
        userId: actor.id,
        ipAddress: req.ip
      });
      res.json(bundle);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/config/business  ──────────────────────────────────────
  // Actualizar datos del negocio (emisor fiscal)
  router.post('/config/business', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canEditFiscal(actor)) return res.status(403).json({ error: 'Sin permiso para editar datos del negocio.' });
      const businessId = await resolveBusinessId(req);
      const { rnc, razon_social, nombre_comercial, direccion, municipio, provincia, telefono, correo } = req.body;

      await query(`
        UPDATE businesses SET
          rnc              = COALESCE(?, rnc),
          razon_social     = COALESCE(?, razon_social),
          nombre_comercial = COALESCE(?, nombre_comercial),
          direccion        = COALESCE(?, direccion),
          municipio        = COALESCE(?, municipio),
          provincia        = COALESCE(?, provincia),
          telefono         = COALESCE(?, telefono),
          correo           = COALESCE(?, correo)
        WHERE id = ?
      `, [rnc||null, razon_social||null, nombre_comercial||null, direccion||null,
          municipio||null, provincia||null, telefono||null, correo||null, businessId]);

      await writeFiscalAuditLog(query, {
        businessId, userId: actor.id,
        action: 'datos_negocio_actualizados',
        description: `Datos del negocio actualizados. RNC: ${rnc || 'sin cambio'}`,
        ipAddress: req.ip
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/config/environment  ──────────────────────────────────
  router.post('/config/environment', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canEditFiscal(actor)) return res.status(403).json({ error: 'Sin permiso para cambiar ambiente.' });
      const businessId = await resolveBusinessId(req);
      const { environment } = req.body;
      const result = await modeSvc.setEnvironment(query, businessId, environment, {
        userId: actor.id, ipAddress: req.ip
      });
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/certificate/upload  ──────────────────────────────────
  // Subir certificado .p12 (multipart/form-data)
  router.post('/certificate/upload', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canManageCert(actor)) return res.status(403).json({ error: 'Sin permiso para subir certificados.' });
      const businessId = await resolveBusinessId(req);

      const form = formidable({ maxFileSize: 5 * 1024 * 1024, keepExtensions: true });
      const [fields, files] = await new Promise((resolve, reject) => {
        form.parse(req, (err, f, fi) => err ? reject(err) : resolve([f, fi]));
      });

      const password  = String(fields.password?.[0] || fields.password || '');
      const fileEntry = files.certificate?.[0] || files.certificate;
      if (!fileEntry) return res.status(400).json({ error: 'No se recibió ningún archivo .p12.' });
      if (!password)  return res.status(400).json({ error: 'La contraseña del certificado es obligatoria.' });

      const p12Buffer = fs.readFileSync(fileEntry.filepath || fileEntry.path);

      // Limpiar archivo temporal
      try { fs.unlinkSync(fileEntry.filepath || fileEntry.path); } catch (_) {}

      // Obtener RNC del negocio para validar coincidencia
      const bizRows    = await query('SELECT rnc FROM businesses WHERE id = ? LIMIT 1', [businessId]);
      const bizRnc     = bizRows[0]?.rnc || null;

      // Validar certificado
      let certInfo;
      try {
        certInfo = certSvc.validateCertificate(p12Buffer, password, bizRnc);
      } catch (certErr) {
        return res.status(400).json({ error: `Certificado inválido: ${certErr.message}` });
      }

      if (certInfo.isExpired) {
        return res.status(400).json({ error: 'El certificado está vencido. Carga un certificado vigente.', certInfo });
      }

      // Guardar cifrado en BD
      await certSvc.saveCertificateSecurely(query, {
        businessId, p12Buffer, password, certInfo,
        userId: actor.id, ipAddress: req.ip
      });

      res.json({
        ok: true,
        certInfo: {
          subject:       certInfo.subject,
          issuer:        certInfo.issuer,
          serialNumber:  certInfo.serialNumber,
          validFrom:     certInfo.validFrom,
          validTo:       certInfo.validTo,
          daysRemaining: certInfo.daysRemaining,
          rncMatch:      certInfo.rncMatch,
          isExpired:     certInfo.isExpired
        }
      });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── GET /api/fiscal/certificate/status  ──────────────────────────────────
  router.get('/certificate/status', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewFiscal(actor)) return res.status(403).json({ error: 'Sin permiso.' });
      const businessId = await resolveBusinessId(req);
      const status = await certSvc.getCertificateStatus(query, businessId);
      res.json(status);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/certificate/validate-stored  ────────────────────────
  router.post('/certificate/validate-stored', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewFiscal(actor)) return res.status(403).json({ error: 'Sin permiso.' });
      const businessId = await resolveBusinessId(req);
      const bizRows = await query('SELECT rnc FROM businesses WHERE id = ? LIMIT 1', [businessId]);
      const result = await certSvc.validateStoredCertificate(query, businessId, bizRows[0]?.rnc || null);
      await homologationSvc.recordTestRun(query, {
        businessId,
        testKey: 'certificate_validation',
        status: result.valid ? 'ok' : 'error',
        summary: result.valid
          ? `Certificado valido. Vence ${result.validTo}.`
          : 'El certificado almacenado no supero la validacion.',
        details: result,
        createdBy: actor.id,
        sourceIp: req.ip
      }).catch(() => {});
      res.json({ ok: result.valid, result });
    } catch (e) {
      await homologationSvc.recordTestRun(query, {
        businessId: await resolveBusinessId(req).catch(() => 1),
        testKey: 'certificate_validation',
        status: 'error',
        summary: e.message,
        details: { error: e.message },
        createdBy: null,
        sourceIp: req.ip
      }).catch(() => {});
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/dgii/test-connection  ────────────────────────────────
  router.post('/dgii/test-connection', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canEditFiscal(actor)) return res.status(403).json({ error: 'Sin permiso para probar conexión DGII.' });
      const businessId  = await resolveBusinessId(req);
      const { environment } = req.body;
      const result = await authSvc.testConnection(query, businessId, environment);
      await homologationSvc.recordTestRun(query, {
        businessId,
        testKey: 'authenticate',
        environment: environment || null,
        status: result.ok ? 'ok' : 'error',
        summary: result.ok
          ? `Autenticacion DGII exitosa para ambiente ${result.environment}.`
          : `Fallo autenticacion DGII: ${result.error}`,
        details: result,
        createdBy: actor.id,
        sourceIp: req.ip
      }).catch(() => {});
      res.json(result);
    } catch (e) {
      await homologationSvc.recordTestRun(query, {
        businessId: await resolveBusinessId(req).catch(() => 1),
        testKey: 'authenticate',
        environment: req.body?.environment || null,
        status: 'error',
        summary: e.message,
        details: { error: e.message },
        createdBy: null,
        sourceIp: req.ip
      }).catch(() => {});
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/dgii/authenticate  ──────────────────────────────────
  router.post('/dgii/authenticate', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canEditFiscal(actor)) return res.status(403).json({ error: 'Sin permiso para autenticar con DGII.' });
      const businessId  = await resolveBusinessId(req);
      const rows        = await query('SELECT environment FROM fiscal_config WHERE business_id = ? LIMIT 1', [businessId]);
      const environment = rows[0]?.environment || 'test';
      const result      = await authSvc.authenticateDGII(query, businessId, environment);
      await homologationSvc.recordTestRun(query, {
        businessId,
        testKey: 'authenticate',
        environment,
        status: 'ok',
        summary: `Autenticacion DGII completada. Token hasta ${result.expiresAt?.toISOString?.() || result.expiresAt}.`,
        details: {
          environment,
          expiresAt: result.expiresAt,
          issuedAt: result.issuedAt
        },
        createdBy: actor.id,
        sourceIp: req.ip
      }).catch(() => {});
      res.json({ ok: true, expiresAt: result.expiresAt, environment: result.environment });
    } catch (e) {
      await homologationSvc.recordTestRun(query, {
        businessId: await resolveBusinessId(req).catch(() => 1),
        testKey: 'authenticate',
        status: 'error',
        summary: e.message,
        details: { error: e.message },
        createdBy: null,
        sourceIp: req.ip
      }).catch(() => {});
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/dgii/test-seed  ─────────────────────────────────────
  router.post('/dgii/test-seed', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canEditFiscal(actor)) return res.status(403).json({ error: 'Sin permiso para probar la semilla.' });
      const businessId = await resolveBusinessId(req);
      const rows = await query('SELECT environment FROM fiscal_config WHERE business_id = ? LIMIT 1', [businessId]);
      const environment = req.body?.environment || rows[0]?.environment || 'test';
      const result = await authSvc.fetchSeedXml(environment);
      const seedValue = resolveSeedPreviewValue(result);
      const response = {
        ok: true,
        environment: result.environment,
        seedDetected: Boolean(seedValue),
        seedPreview: seedValue ? `${seedValue.slice(0, 8)}...` : '',
        rawResponseLength: Buffer.byteLength(String(result.rawSeedResponse || ''), 'utf8'),
        builtXmlLength: Buffer.byteLength(String(result.seedXml || ''), 'utf8')
      };
      await homologationSvc.recordTestRun(query, {
        businessId,
        testKey: 'seed',
        environment: result.environment,
        status: response.seedDetected ? 'ok' : 'warning',
        summary: response.seedDetected
          ? `Semilla obtenida correctamente en ${result.environment}: ${seedValue.slice(0, 8)}...`
          : `DGII respondio sin una semilla interpretable en ${result.environment}.`,
        details: response,
        createdBy: actor.id,
        sourceIp: req.ip
      }).catch(() => {});
      res.json(response);
    } catch (e) {
      await homologationSvc.recordTestRun(query, {
        businessId: await resolveBusinessId(req).catch(() => 1),
        testKey: 'seed',
        environment: req.body?.environment || null,
        status: 'error',
        summary: e.message,
        details: { error: e.message },
        createdBy: null,
        sourceIp: req.ip
      }).catch(() => {});
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/dgii/debug-auth  ────────────────────────────────────
  // Diagnóstico completo del flujo semilla → firma → validación.
  // Devuelve el XML firmado exacto, la URL usada y la respuesta cruda de DGII.
  router.post('/dgii/debug-auth', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canEditFiscal(actor)) return res.status(403).json({ error: 'Sin permiso.' });
      const businessId = await resolveBusinessId(req);
      const rows = await query('SELECT environment FROM fiscal_config WHERE business_id = ? LIMIT 1', [businessId]);
      const environment = req.body?.environment || rows[0]?.environment || 'test';

      const seedResult = await authSvc.fetchSeedXml(environment);
      const { signXmlWithBusinessCertificate } = require('../fiscal/ecfSigningService');
      const signedSeed = await signXmlWithBusinessCertificate(query, businessId, seedResult.seedXml);

      const dgiiResponse = await authSvc.httpPostMultipart(
        seedResult.authUrls.validateSeedUrl,
        [
          {
            name: 'xml',
            filename: `semilla-debug-${Date.now()}.xml`,
            contentType: 'text/xml',
            value: signedSeed.signedXml
          }
        ],
        {
          Accept: 'application/json, application/xml, text/xml, */*'
        }
      );

      res.json({
        seedValue: seedResult.seedValue,
        validateSeedUrl: seedResult.authUrls.validateSeedUrl,
        builtXmlToSign: seedResult.seedXml,
        signedXml: signedSeed.signedXml,
        dgiiHttpStatus: dgiiResponse.status,
        dgiiResponseHeaders: dgiiResponse.headers,
        dgiiResponseBody: String(dgiiResponse.body || ''),
        dgiiResponseBodyLength: Buffer.byteLength(String(dgiiResponse.body || ''), 'utf8')
      });
    } catch (e) {
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });

  // ── POST /api/fiscal/dgii/test-send  ─────────────────────────────────────
  router.post('/dgii/test-send', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canResendDoc(actor)) return res.status(403).json({ error: 'Sin permiso para enviar documentos de prueba.' });
      const businessId = await resolveBusinessId(req);
      const requestedDocumentId = Number(req.body?.documentId || 0) || 0;
      let documentRows = [];
      if (requestedDocumentId) {
        documentRows = await query(
          'SELECT id, encf, ambiente FROM ecf_documents WHERE business_id = ? AND id = ? LIMIT 1',
          [businessId, requestedDocumentId]
        );
      } else {
        documentRows = await query(
          `SELECT id, encf, ambiente
           FROM ecf_documents
           WHERE business_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
          [businessId]
        );
      }
      if (!documentRows[0]) {
        return res.status(404).json({ error: 'No se encontro ningun documento e-CF para probar el envio.' });
      }
      const result = await senderSvc.sendElectronicDocument(query, Number(documentRows[0].id));
      await homologationSvc.recordTestRun(query, {
        businessId,
        testKey: 'send_ecf',
        environment: documentRows[0].ambiente || null,
        status: result.ok ? 'ok' : 'warning',
        summary: `Envio de prueba ${documentRows[0].encf}: ${result.estado || 'sin estado'}.`,
        details: { documentId: documentRows[0].id, encf: documentRows[0].encf, result },
        createdBy: actor.id,
        sourceIp: req.ip
      }).catch(() => {});
      res.json({ ok: true, documentId: Number(documentRows[0].id), encf: documentRows[0].encf, result });
    } catch (e) {
      await homologationSvc.recordTestRun(query, {
        businessId: await resolveBusinessId(req).catch(() => 1),
        testKey: 'send_ecf',
        status: 'error',
        summary: e.message,
        details: { error: e.message, documentId: Number(req.body?.documentId || 0) || null },
        createdBy: null,
        sourceIp: req.ip
      }).catch(() => {});
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/dgii/test-trackid  ──────────────────────────────────
  router.post('/dgii/test-trackid', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewDocs(actor)) return res.status(403).json({ error: 'Sin permiso para consultar TrackID.' });
      const businessId = await resolveBusinessId(req);
      const requestedDocumentId = Number(req.body?.documentId || 0) || 0;
      const requestedTrackId = String(req.body?.trackId || '').trim();
      let rows = [];
      if (requestedDocumentId) {
        rows = await query(
          'SELECT id, track_id, encf, ambiente FROM ecf_documents WHERE business_id = ? AND id = ? LIMIT 1',
          [businessId, requestedDocumentId]
        );
      } else if (requestedTrackId) {
        rows = await query(
          'SELECT id, track_id, encf, ambiente FROM ecf_documents WHERE business_id = ? AND track_id = ? ORDER BY created_at DESC LIMIT 1',
          [businessId, requestedTrackId]
        );
      } else {
        rows = await query(
          `SELECT id, track_id, encf, ambiente
           FROM ecf_documents
           WHERE business_id = ? AND track_id IS NOT NULL AND track_id <> ''
           ORDER BY created_at DESC
           LIMIT 1`,
          [businessId]
        );
      }
      if (!rows[0]) {
        return res.status(404).json({ error: 'No se encontro un documento con TrackID para consultar.' });
      }
      const result = rows[0].track_id
        ? await senderSvc.getStatusByTrackId(query, Number(rows[0].id), rows[0].track_id)
        : await senderSvc.getDocumentState(query, Number(rows[0].id));
      await homologationSvc.recordTestRun(query, {
        businessId,
        testKey: 'trackid',
        environment: rows[0].ambiente || null,
        status: ['aceptado', 'aceptado_condicional', 'enviado', 'procesando', 'pendiente'].includes(result.estado)
          ? 'ok'
          : 'warning',
        summary: `Consulta TrackID ${rows[0].track_id || 'sin track'}: ${result.estado || 'sin estado'}.`,
        details: { documentId: rows[0].id, encf: rows[0].encf, trackId: rows[0].track_id, result },
        createdBy: actor.id,
        sourceIp: req.ip
      }).catch(() => {});
      res.json({ ok: true, documentId: Number(rows[0].id), encf: rows[0].encf, trackId: rows[0].track_id, result });
    } catch (e) {
      await homologationSvc.recordTestRun(query, {
        businessId: await resolveBusinessId(req).catch(() => 1),
        testKey: 'trackid',
        status: 'error',
        summary: e.message,
        details: {
          error: e.message,
          documentId: Number(req.body?.documentId || 0) || null,
          trackId: req.body?.trackId || null
        },
        createdBy: null,
        sourceIp: req.ip
      }).catch(() => {});
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── GET /api/fiscal/dgii/test-runs  ──────────────────────────────────────
  router.get('/dgii/test-runs', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewFiscal(actor)) return res.status(403).json({ error: 'Sin permiso.' });
      const businessId = await resolveBusinessId(req);
      const rows = await homologationSvc.getRecentTestRuns(query, businessId, Number(req.query.limit || 20));
      res.json(rows.map((row) => ({
        ...row,
        details: (() => {
          try {
            return row.details_json ? JSON.parse(row.details_json) : null;
          } catch (_) {
            return null;
          }
        })()
      })));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/security/internal-token/rotate  ─────────────────────
  router.post('/security/internal-token/rotate', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canEditFiscal(actor)) return res.status(403).json({ error: 'Sin permiso para rotar el token interno.' });
      const businessId = await resolveBusinessId(req);
      const result = await homologationSvc.rotateInternalToken(query, businessId, {
        requireInternalToken: req.body?.requireInternalToken,
        userId: actor.id,
        ipAddress: req.ip
      });
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── GET /api/fiscal/homologation/checklist  ───────────────────────────────
  router.get('/homologation/checklist', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewFiscal(actor)) return res.status(403).json({ error: 'Sin permiso.' });
      const businessId = await resolveBusinessId(req);
      const bundle = await homologationSvc.getDgiiConfigBundle(query, businessId);
      res.json(bundle.checklist);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/homologation/checklist/:key  ────────────────────────
  router.post('/homologation/checklist/:key', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canEditFiscal(actor)) return res.status(403).json({ error: 'Sin permiso para actualizar checks de homologacion.' });
      const businessId = await resolveBusinessId(req);
      const result = await homologationSvc.saveManualCheck(query, businessId, req.params.key, req.body || {}, {
        userId: actor.id,
        ipAddress: req.ip
      });
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/activate  ───────────────────────────────────────────
  router.post('/activate', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canEditFiscal(actor)) return res.status(403).json({ error: 'Sin permiso para activar facturación electrónica.' });
      const businessId = await resolveBusinessId(req);
      const result = await modeSvc.activateFiscalMode(query, businessId, {
        userId: actor.id, ipAddress: req.ip
      });
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 422).json({ error: e.message, reasons: e.reasons || [] });
    }
  });

  // ── POST /api/fiscal/deactivate  ─────────────────────────────────────────
  router.post('/deactivate', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canEditFiscal(actor)) return res.status(403).json({ error: 'Sin permiso para desactivar facturación electrónica.' });
      const businessId = await resolveBusinessId(req);
      const result = await modeSvc.deactivateFiscalMode(query, businessId, {
        userId: actor.id, ipAddress: req.ip
      });
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── GET /api/fiscal/validate-activation  ─────────────────────────────────
  router.get('/validate-activation', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewFiscal(actor)) return res.status(403).json({ error: 'Sin permiso.' });
      const businessId = await resolveBusinessId(req);
      const result = await modeSvc.validateCanActivate(query, businessId);
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  SECUENCIAS e-NCF
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /api/fiscal/sequences  ───────────────────────────────────────────
  router.get('/sequences', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewSeq(actor)) return res.status(403).json({ error: 'Sin permiso para ver secuencias e-NCF.' });
      const businessId = await resolveBusinessId(req);
      const seqs = await seqSvc.listSequences(query, businessId);
      res.json(seqs);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/sequences  ──────────────────────────────────────────
  router.post('/sequences', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canManageSeq(actor)) return res.status(403).json({ error: 'Sin permiso para crear secuencias e-NCF.' });
      const businessId = await resolveBusinessId(req);
      const result = await seqSvc.createSequence(query, {
        businessId,
        branchId:         req.body.branchId || null,
        cashRegisterId:   req.body.cashRegisterId || null,
        tipoComprobante:  req.body.tipoComprobante,
        prefijo:          req.body.prefijo || 'E',
        desde:            req.body.desde || 1,
        hasta:            req.body.hasta || 9999999999,
        fechaAutorizacion: req.body.fechaAutorizacion || null,
        fechaVencimiento:  req.body.fechaVencimiento || null,
        createdBy:        actor.id,
        userId:           actor.id,
        ipAddress:        req.ip
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── PUT /api/fiscal/sequences/:id  ───────────────────────────────────────
  router.put('/sequences/:id', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canManageSeq(actor)) return res.status(403).json({ error: 'Sin permiso para editar secuencias e-NCF.' });
      const businessId = await resolveBusinessId(req);
      const result = await seqSvc.updateSequence(query, Number(req.params.id), req.body, {
        businessId, userId: actor.id, ipAddress: req.ip
      });
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── DELETE /api/fiscal/sequences/:id  ────────────────────────────────────
  router.delete('/sequences/:id', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canManageSeq(actor)) return res.status(403).json({ error: 'Sin permiso para desactivar secuencias.' });
      const businessId = await resolveBusinessId(req);
      const result = await seqSvc.disableSequence(query, Number(req.params.id), {
        businessId, userId: actor.id, ipAddress: req.ip
      });
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── GET /api/fiscal/sequences/types  ─────────────────────────────────────
  router.get('/sequences/types', async (req, res) => {
    res.json(Object.entries(seqSvc.ECF_TYPES).map(([code, info]) => ({
      code, label: info.label, serie: info.code
    })));
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  DOCUMENTOS e-CF
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /api/fiscal/documents  ───────────────────────────────────────────
  router.get('/documents', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewDocs(actor)) return res.status(403).json({ error: 'Sin permiso para ver documentos e-CF.' });
      const businessId = await resolveBusinessId(req);

      const { estado, tipo, desde, hasta, page = 1, limit = 50 } = req.query;
      const conditions = ['d.business_id = ?'];
      const params     = [businessId];

      if (estado) { conditions.push('d.estado_dgii = ?'); params.push(estado); }
      if (tipo)   { conditions.push('d.tipo_ecf = ?');    params.push(tipo); }
      if (desde)  { conditions.push('d.fecha_emision >= ?'); params.push(desde); }
      if (hasta)  { conditions.push('d.fecha_emision <= ?'); params.push(hasta + ' 23:59:59'); }

      const offset = (Number(page) - 1) * Number(limit);
      params.push(Number(limit), offset);

      const rows = await query(`
        SELECT d.id, d.tipo_ecf, d.encf, d.rnc_emisor, d.rnc_comprador,
               d.nombre_comprador, d.monto_total, d.itbis_total,
               d.fecha_emision, d.estado_dgii, d.track_id, d.ambiente,
               d.is_sent, d.retry_count, d.codigo_seguridad, d.qr_url,
               d.submission_mode,
               d.mensajes_dgii, d.created_at,
               s.invoice_number
        FROM ecf_documents d
        LEFT JOIN sales s ON s.id = d.sale_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY d.created_at DESC
        LIMIT ? OFFSET ?
      `, params);

      const totalRow = await query(
        `SELECT COUNT(*) AS total FROM ecf_documents d WHERE ${conditions.join(' AND ')}`,
        params.slice(0, -2)
      );

      res.json({ documents: rows, total: Number(totalRow[0]?.total || 0), page: Number(page), limit: Number(limit) });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/documents/:id/resend  ───────────────────────────────
  router.post('/documents/:id/resend', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canResendDoc(actor)) return res.status(403).json({ error: 'Sin permiso para reenviar documentos.' });
      const result = await senderSvc.sendElectronicDocument(query, Number(req.params.id));
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── GET /api/fiscal/documents/:id/status  ────────────────────────────────
  router.get('/documents/:id/status', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewDocs(actor)) return res.status(403).json({ error: 'Sin permiso.' });
      const rows = await query(
        'SELECT id, track_id, estado_dgii FROM ecf_documents WHERE id = ? LIMIT 1',
        [Number(req.params.id)]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Documento no encontrado.' });
      const result = rows[0].track_id
        ? await senderSvc.getStatusByTrackId(query, rows[0].id, rows[0].track_id)
        : await senderSvc.getDocumentState(query, rows[0].id);
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── GET /api/fiscal/documents/:id/xml  ───────────────────────────────────
  router.get('/documents/:id/xml', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewXml(actor)) return res.status(403).json({ error: 'Sin permiso para ver XML.' });
      const rows = await query(
        'SELECT signed_xml_content, xml_content, encf FROM ecf_documents WHERE id = ? LIMIT 1',
        [Number(req.params.id)]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Documento no encontrado.' });
      const xml = rows[0].signed_xml_content || rows[0].xml_content;
      if (!xml) return res.status(404).json({ error: 'XML no disponible.' });
      const download = req.query.download === '1';
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      if (download) res.setHeader('Content-Disposition', `attachment; filename="${rows[0].encf}.xml"`);
      res.send(xml);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/documents/retry-pending  ────────────────────────────
  router.post('/documents/retry-pending', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canResendDoc(actor)) return res.status(403).json({ error: 'Sin permiso.' });
      const businessId = await resolveBusinessId(req);
      const results = await senderSvc.retryPendingDocuments(query, businessId);
      res.json({ ok: true, results });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/documents/resign-pending  ───────────────────────────
  // Re-firma todos los documentos pendientes con el certificado vigente.
  // Necesario tras actualizar el algoritmo de firma (XMLDSig correcto).
  router.post('/documents/resign-pending', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canResendDoc(actor)) return res.status(403).json({ error: 'Sin permiso.' });
      const businessId = await resolveBusinessId(req);

      const { cert, privateKey } = await certSvc.getCertificateForSigning(query, businessId);

      const pending = await query(
        `SELECT id, encf, xml_content FROM ecf_documents
         WHERE business_id = ? AND xml_content IS NOT NULL
           AND estado_dgii IN ('pendiente','pendiente_red','error_red','error','pendiente_rfce')
           AND COALESCE(is_sent,0)=0
         ORDER BY id ASC LIMIT 50`,
        [businessId]
      );

      const results = [];
      for (const doc of pending) {
        try {
          const newSignedXml = signXml(doc.xml_content, cert, privateKey);
          const newCodigo = generateSecurityCodeFromSignedXml(newSignedXml);
          await query(
            `UPDATE ecf_documents SET signed_xml_content=?, codigo_seguridad=?, fecha_firma=NOW() WHERE id=?`,
            [newSignedXml, newCodigo, doc.id]
          );
          results.push({ id: doc.id, encf: doc.encf, ok: true });
        } catch (err) {
          results.push({ id: doc.id, encf: doc.encf, ok: false, error: err.message });
        }
      }
      res.json({ ok: true, total: results.length, results });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  REPORTES FISCALES
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /api/fiscal/reports/summary  ─────────────────────────────────────
  router.get('/reports/summary', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canViewDocs(actor)) return res.status(403).json({ error: 'Sin permiso para ver reportes fiscales.' });
      const businessId = await resolveBusinessId(req);
      const { desde, hasta } = req.query;

      const dateFilter = desde && hasta
        ? `AND d.fecha_emision BETWEEN ? AND ?`
        : '';
      const dateParams = desde && hasta ? [desde, hasta + ' 23:59:59'] : [];

      const byType = await query(`
        SELECT tipo_ecf, estado_dgii,
               COUNT(*) AS cantidad,
               SUM(monto_total) AS monto_total,
               SUM(itbis_total) AS itbis_total
        FROM ecf_documents d
        WHERE business_id = ? ${dateFilter}
        GROUP BY tipo_ecf, estado_dgii
        ORDER BY tipo_ecf, estado_dgii
      `, [businessId, ...dateParams]);

      const totals = await query(`
        SELECT estado_dgii,
               COUNT(*) AS cantidad,
               SUM(monto_total) AS monto_total,
               SUM(itbis_total) AS itbis_total
        FROM ecf_documents d
        WHERE business_id = ? ${dateFilter}
        GROUP BY estado_dgii
      `, [businessId, ...dateParams]);

      const seqSummary = await query(`
        SELECT tipo_comprobante, prefijo, desde, hasta, proximo, activo,
               fecha_vencimiento,
               (hasta - proximo + 1) AS restantes
        FROM fiscal_sequences
        WHERE business_id = ?
        ORDER BY tipo_comprobante
      `, [businessId]);

      res.json({ byType, totals, sequences: seqSummary });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/fiscal/homologation/import-test-set  ───────────────────────
  // Recibe el CSV del set de prueba DGII, crea secuencias y genera los docs
  router.post('/homologation/import-test-set', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!canEditFiscal(actor)) return res.status(403).json({ error: 'Sin permiso para importar el set de prueba.' });
      const businessId = await resolveBusinessId(req);

      const form = formidable({ maxFileSize: 10 * 1024 * 1024, keepExtensions: true });
      const [fields, files] = await new Promise((resolve, reject) => {
        form.parse(req, (err, f, fi) => err ? reject(err) : resolve([f, fi]));
      });

      const fileEntry = files.csv?.[0] || files.csv || files.file?.[0] || files.file;
      let fileBuffer = null;
      let filename   = 'data.csv';
      if (fileEntry) {
        const filePath = fileEntry.filepath || fileEntry.path;
        fileBuffer = fs.readFileSync(filePath);
        filename   = fileEntry.originalFilename || fileEntry.name || filename;
        try { fs.unlinkSync(filePath); } catch (_) {}
      } else if (fields.csv) {
        fileBuffer = Buffer.from(String(fields.csv?.[0] || fields.csv || ''), 'utf8');
      }
      if (!fileBuffer || !fileBuffer.length) {
        return res.status(400).json({ error: 'No se recibió el archivo del set de prueba.' });
      }

      const ambiente = String(fields.ambiente?.[0] || fields.ambiente || 'test').trim();
      const result = await testSetImporter.importTestSet(query, businessId, fileBuffer, {
        ambiente,
        filename,
        userId:    actor.id,
        ipAddress: req.ip,
      });
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── GET /api/fiscal/audit-log  ───────────────────────────────────────────
  router.get('/audit-log', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!isGlobalAdmin(actor)) return res.status(403).json({ error: 'Solo el administrador general puede ver el log de auditoría fiscal.' });
      const businessId = await resolveBusinessId(req);
      const rows = await query(
        `SELECT l.*, u.nombre AS user_name
         FROM fiscal_audit_log l
         LEFT JOIN users u ON u.id = l.user_id
         WHERE l.business_id = ?
         ORDER BY l.created_at DESC LIMIT 200`,
        [businessId]
      );
      res.json(rows);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

function resolveSeedPreviewValue(result) {
  const explicitSeed = String(result?.seedValue || '').trim();
  if (explicitSeed) return explicitSeed;

  const seedXml = String(result?.seedXml || '');
  const seedMatch = seedXml.match(/<valor>([^<]+)<\/valor>/i) || seedXml.match(/<Semilla>([^<]+)<\/Semilla>/i);
  if (seedMatch?.[1]) return seedMatch[1].trim();

  const rawResponse = String(result?.rawSeedResponse || '');
  const rawMatch = rawResponse.match(/<valor>([^<]+)<\/valor>/i) || rawResponse.match(/<Semilla>([^<]+)<\/Semilla>/i);
  return rawMatch?.[1] ? rawMatch[1].trim() : '';
}

module.exports = createFiscalRouter;

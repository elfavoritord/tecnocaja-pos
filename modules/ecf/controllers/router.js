'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createEcfService } = require('../services/ecf.service');
const { buildQrVerificationUrl } = require('../utils/qr-url.util');
const { checkQrResolves } = require('../utils/dgii-live-check.util');
const { recordQrDiagnostic } = require('../utils/qr-diagnostic.util');

function wrap(handler) {
  return async (req, res) => {
    try {
      const payload = await handler(req, res);
      if (res.headersSent) return;
      res.json(payload);
    } catch (error) {
      res.status(error.statusCode || 500).json({
        error: error.message || 'Error interno e-CF.',
        details: error.details || undefined,
      });
    }
  };
}

function createEcfRouter(deps) {
  const router = express.Router();
  const service = createEcfService(deps);
  const disabled250MilPortalFlow = (_req, res) => {
    res.status(410).json({
      error: 'Flujo eliminado. No se deben generar ni subir ECF completos <250Mil por esta vía.',
      details: {
        use: '/certification-center/rfce/generate, /certification-center/rfce/submit, /certification-center/rfce/poll',
      },
    });
  };

  router.get('/status', wrap(() => service.getSystemStatus()));
  router.get('/config', wrap(() => service.getBundle()));
  router.get('/config/dgii', wrap(() => service.getBundle()));
  router.post('/config/business', wrap((req) => service.saveBusiness(req)));
  router.post('/config/dgii', wrap((req) => service.saveDgiiSettings(req)));
  router.post('/config/environment', wrap((req) => service.saveEnvironment(req)));

  // ── Diagnóstico y auditoría del emisor ───────────────────────────────────────
  // Muestra los datos del emisor tal como aparecerán en el XML — sin caché, sin hardcoding.
  router.get('/emitter/xml-preview', wrap(() => service.getEmitterXmlPreview()));
  // Historial de emisores usados en XMLs (auditoría de origen de datos).
  router.get('/emitter/xml-logs', wrap(() => service.getEmitterXmlLogs()));
  // Vista previa del XML de un caso de certificación específico.
  router.get('/certification/cases/:id/xml-preview', wrap((req) => service.getCertificationCaseXmlPreview(Number(req.params.id))));
  // XML completo para edición manual + guardar-y-firmar.
  router.get('/certification/cases/:id/full-xml', wrap((req) => service.getFullCertificationXml(Number(req.params.id))));
  router.post('/certification/cases/:id/edit-xml', wrap((req) => service.saveCertificationCaseXml(Number(req.params.id), req)));
  router.post('/security/internal-token/rotate', wrap((req) => service.rotateInternalToken(req)));

  router.post('/certificate/upload', wrap((req) => service.handleCertificateUpload(req)));
  router.post('/certificate/validate-stored', wrap(() => service.validateStoredCertificate()));

  router.post('/activate', wrap((req) => service.activate(req)));
  router.post('/deactivate', wrap((req) => service.deactivate(req)));
  router.get('/validate-activation', wrap(() => service.validateActivation()));

  router.get('/sequences', wrap(() => service.listSequences()));
  router.get('/sequences/next', wrap((req) => service.generateNextENCF(req)));
  router.post('/sequences/next', wrap((req) => service.generateNextENCF(req)));
  router.get('/sequences/types', wrap(() => require('../config/document-types').getDocumentTypes()));
  router.post('/sequences', wrap((req) => service.saveSequence(req)));
  router.post('/sequences/:id/next', wrap((req) => service.updateSequenceNext(req)));
  router.delete('/sequences/:id', wrap((req) => service.disableSequence(req)));
  router.delete('/sequences/:id/permanent', wrap((req) => service.deleteSequencePermanently(req)));

  router.get('/documents', wrap((req) => service.listDocuments(req.query || {})));
  router.post('/enviar', wrap((req) => service.enviarDocumento(req)));
  router.get('/track/:id', wrap((req) => service.consultarTrackId(req.params.id, req)));
  router.get('/enviados/current/xml', async (req, res) => {
    try {
      const result = await service.getCurrentSentXml();
      res.type('application/xml').send(result.xml || '');
    } catch (error) {
      res.status(error.statusCode || 500).json({
        error: error.message || 'No se pudo obtener el XML enviado.',
        details: error.details || undefined,
      });
    }
  });
  router.post('/documents/:id/resend', wrap((req) => service.resendDocument(Number(req.params.id))));
  router.get('/documents/:id/status', wrap((req) => service.queryDocumentStatus(Number(req.params.id))));
  router.get('/documents/:id/xml', async (req, res) => {
    try {
      const xml = await service.getDocumentXml(Number(req.params.id));
      if (String(req.query.download || '').trim() === '1') {
        res.setHeader('Content-Disposition', `attachment; filename="ecf-${req.params.id}.xml"`);
      }
      res.type('application/xml').send(xml);
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || 'No se pudo obtener el XML.' });
    }
  });
  router.post('/documents/retry-pending', wrap(() => service.retryPendingDocuments()));
  router.post('/documents/resign-pending', wrap((req) => service.resignPendingDocuments(req)));

  router.post('/dgii/test-connection', wrap((req) => service.testConnection(req)));
  router.post('/dgii/test-seed', wrap((req) => service.testSeed(req)));
  router.get('/dgii/seeds', wrap(() => service.getSeedState()));
  router.post('/dgii/seeds/sign-current', wrap((req) => service.signCurrentSeed(req)));
  router.post('/dgii/seeds/clear-history', wrap((req) => service.clearSeedHistory(req)));
  router.get('/dgii/seeds/current/xml', async (req, res) => {
    try {
      const result = await service.getCurrentSeedXml(req);
      res.type('application/xml').send(result.xml || '');
    } catch (error) {
      res.status(error.statusCode || 500).json({
        error: error.message || 'No se pudo obtener el XML de la semilla.',
      });
    }
  });
  router.post('/dgii/test-send', wrap((req) => service.testSend(Number(req.body?.documentId || 0) || null)));
  router.post('/dgii/test-trackid', wrap((req) => service.testTrackId({
    documentId: Number(req.body?.documentId || 0) || null,
    trackId: String(req.body?.trackId || '').trim() || null,
  })));
  router.post('/dgii/debug-auth', wrap((req) => service.debugAuth(req)));

  router.post('/homologation/import-test-set', wrap((req) => service.importTestSet(req)));
  router.post('/homologation/checklist/:key', wrap((req) => service.saveManualChecklist(req)));
  router.get('/certification-center/status', wrap(() => service.certificationCenterStatus()));
  router.post('/certification-center/force-sync', wrap((req) => service.certificationCenterForceSync(req)));
  router.post('/certification-center/process', wrap((req) => service.certificationCenterProcess(req)));
  router.post('/certification-center/simulate/generate', wrap((req) => service.generateSimulationSet(req)));
  router.post('/certification-center/simulate/manual-send', wrap((req) => service.simulateManualSend(req)));
  router.post('/certification-center/reset', wrap((req) => service.certificationCenterReset(req)));
  router.post('/certification-center/cases/:id/retry', wrap((req) => service.certificationCenterRetry(Number(req.params.id), req)));
  router.get('/certification-center/rfce/status', wrap(() => service.step4RfceGetStatus()));
  router.post('/certification-center/rfce/generate', wrap((req) => service.step4RfceGenerate(req)));
  router.post('/certification-center/rfce/submit', wrap((req) => service.step4RfceSubmit(req)));
  router.post('/certification-center/rfce/poll', wrap(() => service.step4RfcePollStatuses()));
  router.post('/certification-center/rfce/prepare-portal', wrap((req) => service.step4RfcePreparePortal(req)));
  router.post('/certification-center/reset-step2-completely', wrap((req) => service.step2ResetCompletely(req)));
  router.get('/certification/cases', wrap((req) => service.listCertificationCases(req.query || {})));
  router.get('/certification/summary', wrap(() => service.getCertificationSummary()));
  router.post('/certification/import', wrap((req) => service.importCertificationSet(req)));
  router.post('/certification/send-next', wrap((req) => service.sendNextCertificationCase(req)));
  router.post('/certification/run-sequential', wrap((req) => service.runCertificationSequence(req)));
  router.post('/certification/poll-statuses', wrap(() => service.pollCertificationStatuses()));
  router.post('/certification/reset-sent', wrap((req) => service.resetSentCertificationCases(req)));
  // Resetea docs rechazados/error → firmado para reintento (usar después de fix-rawrow/fix-nombre-comercial).
  router.post('/certification/reset-rejected', wrap((req) => service.resetRejectedCertificationCases(req)));
  // Convierte E32 RFCE → ECF cuando es referenciado por E33/E34 (NCFModificado)
  router.post('/certification/fix-ncf-refs', wrap((req) => service.fixNcfModificadoRefs(req)));
  // Rota eNCFs quemados (ya enviados en intentos anteriores) asignando nuevos números de secuencia.
  // Usar cuando DGII rechaza con "Este número de secuencia ya ha sido utilizado".
  router.post('/certification/rotate-encfs', wrap((req) => service.rotateBurnedEncfs(req)));
  // Parchea NombreComercial del rawRow de un caso cuando el Excel tiene valor incorrecto.
  // Body: { encf: 'E310000000002', nombreComercial: '' }
  router.post('/certification/fix-nombre-comercial', wrap((req) => service.fixCaseNombreComercial(req)));
  router.post('/certification/fix-nombre-comercial-all', wrap((req) => service.fixAllCasesNombreComercial(req)));
  // Actualiza campos arbitrarios del rawRow de un caso de certificación.
  // Body: { encf: 'E310000000002', fields: { MontoGravadoI1: '3961.31', MontoGravadoTotal: '3961.31' } }
  router.post('/certification/fix-rawrow', wrap((req) => service.fixCaseRawRow(req)));
  // Genera y firma los XMLs < 250Mil detectados en el dataset para subir al portal DGII
  router.post('/certification/generate-250mil', wrap((req) => service.generate250MilXmls(req)));
  router.post('/certification/prepare-final-250mil', disabled250MilPortalFlow);
  router.post('/certification/open-final-250mil-folder', disabled250MilPortalFlow);
  router.post('/certification/open-local-ecf-folder', disabled250MilPortalFlow);
  router.get('/certification/portal-250mil/status', disabled250MilPortalFlow);
  router.post('/certification/portal-250mil/generate', disabled250MilPortalFlow);
  router.post('/certification/portal-250mil/submit', disabled250MilPortalFlow);
  router.post('/certification/portal-250mil/poll', disabled250MilPortalFlow);
  router.get('/certification/portal-250mil/local-ecf/:encf', disabled250MilPortalFlow);
  router.post('/certification/portal-250mil/local-ecf/:encf', disabled250MilPortalFlow);

  // ── Paso 3 certificación: Aprobaciones Comerciales (ACECF) ───────────────
  router.post('/certification/aprobacion-comercial/process', wrap((req) => service.processAprobacionComercialTestSet(req)));

  router.post('/certification/cases/:id/regenerate', wrap((req) => service.regenerateCertificationCase(Number(req.params.id), req)));
  router.post('/certification/cases/:id/send', wrap((req) => service.sendCertificationCase(Number(req.params.id), req)));
  router.post('/certification/cases/:id/resend', wrap((req) => service.sendCertificationCase(Number(req.params.id), req, { forceResend: true })));
  router.get('/certification/cases/:id/track', wrap((req) => service.queryCertificationCase(Number(req.params.id))));
  router.delete('/certification/cases/:id', wrap((req) => service.deleteCertificationCase(Number(req.params.id), req)));
  router.delete('/certification/reset', wrap((req) => service.resetCertificationData(req)));
  router.get('/sequence-usage/stats', wrap(() => service.getSequenceUsageStats()));
  router.post('/sequence-usage/find-next', wrap((req) => service.findNextAvailableSequence(req)));

  // ── RFCE: Resumen Factura de Consumo Electrónica < 250,000 DOP ───────────
  // GET  /api/ecf/rfce                   → listar RFCE emitidos
  // POST /api/ecf/rfce/generate          → generar + firmar RFCE (sin enviar)
  // POST /api/ecf/rfce/send              → enviar RFCE existente (rfceId) o generar+enviar (items)
  // GET  /api/ecf/rfce/status/:trackId   → consultar estado en DGII por TrackID
  // GET  /api/ecf/rfce/:id               → obtener RFCE por ID
  // POST /api/ecf/rfce/:id/resend        → reenviar RFCE rechazado/en error
  router.get('/rfce', wrap((req) => service.rfceList(req)));
  router.post('/rfce/generate', wrap((req) => service.rfceGenerate(req)));
  router.post('/rfce/send', wrap((req) => service.rfceSend(req)));
  router.get('/rfce/status/:trackId', wrap((req) => service.rfceStatus(req.params.trackId)));
  router.get('/rfce/:id', wrap((req) => service.rfceGet(Number(req.params.id))));
  router.post('/rfce/:id/resend', wrap((req) => service.rfceResend(Number(req.params.id), req)));
  // ── Wizard de certificación: estado persistido ───────────────────────────────
  router.get('/wizard/state', wrap(() => service.getWizardState()));
  router.post('/wizard/state', wrap((req) => service.saveWizardState(req)));
  // Firma un XML de postulación con el P12 almacenado y devuelve el XML firmado
  router.post('/wizard/sign-postulation-xml', wrap((req) => service.signPostulationXml(req)));
  router.post('/wizard/sign-declaration-xml', wrap((req) => service.signDeclarationXml(req)));
  router.post('/certification/validate-service-urls', wrap((req) => service.validateServiceUrls(req)));
  router.post('/wizard/set-production-base-url', wrap((req) => service.setProductionBaseUrl(req)));
  router.post('/wizard/step14-evidence', wrap((req) => service.saveStep14Evidence(req)));

  // ── Activación segura de producción DGII (ambiente 'ecf') — acción independiente,
  //    nunca disparada automáticamente por el wizard. Ver docs/plan de activación segura.
  router.get('/production/status', wrap(() => service.getProductionActivationStatus()));
  router.post('/production/activate', wrap((req) => service.activateProduction(req)));
  router.post('/production/revert', wrap((req) => service.revertProductionToCertification(req)));

  router.get('/reports/summary', wrap(() => service.getSummaryReport()));
  // DIAGNÓSTICO TEMPORAL — eliminar después de resolver el problema de certificación
  router.get('/diag/cert-original-xml', wrap(() => service.diagCertificationOriginalXml()));
  // Muestra los mensajes DGII de todos los docs rechazados en el batch actual.
  router.get('/diag/cert-rejection-messages', wrap(() => service.diagCertRejectionMessages()));

  // ── Paso 5: Representación Impresa (HTML + PDF) ────────────────────────────
  router.get('/print/step5-docs', async (req, res) => {
    try {
      const rows = await deps.query(
        `SELECT encf, tipo_ecf, submission_mode, estado_dgii, environment, signed_xml_content
         FROM ecf_documents
         WHERE certification_batch_id = (
           SELECT certification_batch_id FROM ecf_documents
           WHERE certification_batch_id IS NOT NULL
           ORDER BY created_at DESC LIMIT 1
         )
         ORDER BY tipo_ecf, submission_mode, encf`,
      );
      const TYPE_LABELS = {
        '31-normal': 'Factura de Crédito Fiscal (E31)',
        '32-normal': 'Factura de Consumo ≥ 250,000 DOP (E32)',
        '32-rfce':   'Factura de Consumo < 250,000 DOP (E32 RFCE)',
        '33-normal': 'Nota de Débito (E33)',
        '34-normal': 'Nota de Crédito (E34)',
        '41-normal': 'Compras (E41)',
        '43-normal': 'Gastos Menores (E43)',
        '44-normal': 'Regímenes Especiales (E44)',
        '45-normal': 'Gubernamentales (E45)',
        '46-normal': 'Comprobante para Exportaciones (E46)',
        '47-normal': 'Comprobante para Pagos al Exterior (E47)',
      };
      const ORDER = ['31-normal','32-normal','32-rfce','33-normal','34-normal','41-normal','43-normal','44-normal','45-normal','46-normal','47-normal'];
      // Cuando un lote tiene más de un documento del mismo tipo (ej. reintentos
      // tras un rechazo), preferir uno que NO esté rechazado en vez de tomar
      // el primero por orden de eNCF — de lo contrario el Paso 5 puede mostrar
      // un comprobante rechazado para subir al portal DGII aunque exista uno
      // válido del mismo tipo en el mismo lote.
      const ESTADO_RANK = { aceptado: 0, aceptado_condicional: 1, firmado: 2, enviado: 3, rechazado: 4 };
      const rankOf = (estado) => ESTADO_RANK[estado] ?? 3;
      const byKeyCandidates = {};
      rows.forEach((r) => {
        const k = `${r.tipo_ecf.replace('E','')}-${(r.submission_mode||'normal').toLowerCase()}`;
        (byKeyCandidates[k] = byKeyCandidates[k] || []).push(r);
      });
      Object.values(byKeyCandidates).forEach((list) => list.sort((a, b) => rankOf(a.estado_dgii) - rankOf(b.estado_dgii)));

      // DGII puede aceptar un documento en la recepción y aun así tardar (o nunca llegar) a
      // indexarlo en su portal público ConsultaTimbre/ConsultaTimbreFC — el Paso 5/6 exige
      // "la correcta conformación de los QR", que DGII valida escaneando. Por eso, entre los
      // candidatos aceptados del mismo tipo, se prueba en vivo cuál YA resuelve ahí antes de
      // elegirlo como representante, en vez de tomar el primero por eNCF a ciegas — ver
      // dgii-live-check.util.js.
      const docs = [];
      for (const k of ORDER) {
        const candidates = byKeyCandidates[k];
        if (!candidates || !candidates.length) continue;
        let chosen = candidates[0];
        let dgiiVerificado = false;
        let dgiiEstadoPublico = null;
        for (const candidate of candidates) {
          if (!['aceptado', 'aceptado_condicional'].includes(String(candidate.estado_dgii || '').toLowerCase())) break;
          const qrUrl = buildQrVerificationUrl(candidate.signed_xml_content, candidate.environment);
          const result = await checkQrResolves(qrUrl);
          if (result.indexed) {
            chosen = candidate;
            dgiiVerificado = true;
            dgiiEstadoPublico = result.estado;
            break;
          }
        }
        docs.push({
          key: k,
          tipo: chosen.tipo_ecf,
          label: TYPE_LABELS[k] || k,
          encf: chosen.encf,
          estado: chosen.estado_dgii,
          dgiiVerificado,
          dgiiEstadoPublico,
        });
      }
      res.json({ docs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/print/step5-pdf-bundle', async (req, res) => {
    let browser;
    try {
      const archiver = require('archiver');
      const puppeteer = require('puppeteer');
      const { generateReprImpresaHtml } = require('./repr-impresa');

      const rows = await deps.query(
        `SELECT encf, tipo_ecf, submission_mode, signed_xml_content, estado_dgii, rnc_comprador, environment
         FROM ecf_documents
         WHERE certification_batch_id = (
           SELECT certification_batch_id FROM ecf_documents
           WHERE certification_batch_id IS NOT NULL
           ORDER BY created_at DESC LIMIT 1
         )
           AND signed_xml_content IS NOT NULL
         ORDER BY tipo_ecf, submission_mode, encf`,
      );

      const TYPE_LABELS = {
        '31-normal': 'Factura-Credito-Fiscal',
        '32-normal': 'Factura-Consumo-Mayor250k',
        '32-rfce':   'Factura-Consumo-Menor250k',
        '33-normal': 'Nota-Debito',
        '34-normal': 'Nota-Credito',
        '41-normal': 'Compras',
        '43-normal': 'Gastos-Menores',
        '44-normal': 'Regimenes-Especiales',
        '45-normal': 'Gubernamentales',
        '46-normal': 'Exportaciones',
        '47-normal': 'Pagos-Exterior',
      };
      const ORDER = ['31-normal','32-normal','32-rfce','33-normal','34-normal','41-normal','43-normal','44-normal','45-normal','46-normal','47-normal'];

      // Pick one representative per type — preferir el que esté realmente aceptado en DGII
      // en vez del primero por orden de eNCF (que puede ser uno rechazado o aún sin
      // confirmar si hay varios intentos del mismo tipo en el lote, ej. E31 con un
      // rechazo seguido de reintentos aceptados).
      const ESTADO_RANK = { aceptado: 0, aceptado_condicional: 1, firmado: 2, enviado: 3, rechazado: 4 };
      const rankOf = (estado) => ESTADO_RANK[estado] ?? 3;
      const byKeyCandidates = {};
      rows.forEach((r) => {
        const k = `${r.tipo_ecf.replace('E','')}-${(r.submission_mode||'normal').toLowerCase()}`;
        (byKeyCandidates[k] = byKeyCandidates[k] || []).push(r);
      });
      Object.values(byKeyCandidates).forEach((list) => list.sort((a, b) => rankOf(a.estado_dgii) - rankOf(b.estado_dgii)));

      // DGII puede aceptar un documento en la recepción y aun así tardar (o nunca llegar) a
      // indexarlo en su portal público de verificación — el Paso 5/6 exige "la correcta
      // conformación de los QR", que DGII valida escaneando. Entre los candidatos aceptados
      // del mismo tipo, probar en vivo cuál YA resuelve ahí antes de elegirlo como
      // representante — ver dgii-live-check.util.js. Si ninguno resuelve, se usa igual el
      // mejor rankeado (no hay otra opción) pero queda marcado en el resumen del ZIP.
      const selected = [];
      const verificationSummary = [];
      for (let i = 0; i < ORDER.length; i += 1) {
        const key = ORDER[i];
        const candidates = byKeyCandidates[key];
        if (!candidates || !candidates.length) continue;
        let row = candidates[0];
        let dgiiVerificado = false;
        let dgiiEstadoPublico = null;
        for (const candidate of candidates) {
          if (!['aceptado', 'aceptado_condicional'].includes(String(candidate.estado_dgii || '').toLowerCase())) break;
          const qrUrl = buildQrVerificationUrl(candidate.signed_xml_content, candidate.environment);
          const result = await checkQrResolves(qrUrl);
          if (result.indexed) {
            row = candidate;
            dgiiVerificado = true;
            dgiiEstadoPublico = result.estado;
            break;
          }
        }
        selected.push({ key, idx: selected.length + 1, row });
        verificationSummary.push({ key, encf: row.encf, dgiiVerificado, dgiiEstadoPublico });
      }

      if (!selected.length) return res.status(404).json({ error: 'No hay documentos de simulación con XML firmado.' });

      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
      const page = await browser.newPage();

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="representaciones-impresas-DGII.zip"');

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.pipe(res);

      // La Representación Impresa debe mostrar exactamente lo que se transmitió a la DGII —
      // durante certificación esos datos vienen fijos del set de pruebas de la DGII (incluida
      // su empresa de ejemplo), no del emisor/comprador real configurado localmente. Por eso no
      // se sobreescribe emitter/buyer aquí: se deja que generateReprImpresaHtml lea el XML tal cual.
      for (const { key, idx, row } of selected) {
        const label = TYPE_LABELS[key] || key;
        const filename = `${String(idx).padStart(2,'0')}-${label}-${row.encf}.pdf`;
        const html = await generateReprImpresaHtml(row.signed_xml_content, { env: process.env.DGII_ENV || 'certecf' });
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const pdfRaw = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
        archive.append(Buffer.isBuffer(pdfRaw) ? pdfRaw : Buffer.from(pdfRaw), { name: filename });
        recordQrDiagnostic({
          tipoEcf: row.tipo_ecf,
          signedXml: row.signed_xml_content,
          environment: row.environment,
          estadoConsultaResultado: row.estado_dgii,
          pdfGeneradoPath: filename,
        });
      }

      const resumenLines = [
        'Verificación en vivo contra el portal público de DGII (ConsultaTimbre/ConsultaTimbreFC) al momento de generar este ZIP.',
        'Un "NO" no significa que el documento esté mal — DGII lo aceptó igual en la recepción — significa que su índice',
        'público de verificación aún no lo tiene indexado. Si DGII rechaza este comprobante en el Paso 6 por el QR,',
        'espera un poco y vuelve a generar el ZIP: puede que ya haya un candidato del mismo tipo que sí resuelva.',
        '',
        ...verificationSummary.map((v) => `Tipo ${v.key}: eNCF ${v.encf} — verificado en DGII: ${v.dgiiVerificado ? 'SI (' + v.dgiiEstadoPublico + ')' : 'NO'}`),
      ];
      archive.append(resumenLines.join('\n'), { name: '00-RESUMEN-VERIFICACION-DGII.txt' });

      await browser.close();
      browser = null;
      await archive.finalize();
    } catch (e) {
      if (browser) { try { await browser.close(); } catch (_) {} }
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // Descarga el XML firmado de TODOS los documentos del lote de certificación activo, en un
  // solo ZIP — útil para verificar rápido (ej. RazonSocialEmisor/Comprador) sin tener que
  // reenviar cada uno a la DGII solo para chequear el contenido.
  router.get('/print/step5-xml-bundle', async (req, res) => {
    try {
      const archiver = require('archiver');
      const rows = await deps.query(
        `SELECT encf, tipo_ecf, submission_mode, signed_xml_content, xml_content
         FROM ecf_documents
         WHERE certification_batch_id = (
           SELECT certification_batch_id FROM ecf_documents
           WHERE certification_batch_id IS NOT NULL
           ORDER BY created_at DESC LIMIT 1
         )
           AND (signed_xml_content IS NOT NULL OR xml_content IS NOT NULL)
         ORDER BY tipo_ecf, submission_mode, encf`,
      );

      if (!rows.length) return res.status(404).json({ error: 'No hay documentos con XML en el lote activo.' });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="xml-documentos-DGII.zip"');

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.pipe(res);

      for (const row of rows) {
        const xml = row.signed_xml_content || row.xml_content || '';
        const suffix = (row.submission_mode || 'normal').toLowerCase() === 'rfce' ? '-rfce' : '';
        archive.append(xml, { name: `${row.tipo_ecf}${suffix}-${row.encf}.xml` });
      }

      await archive.finalize();
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // Lista los diagnósticos QR-vs-XML más recientes (ver qr-diagnostic.util.js) — uno por
  // cada e-CF para el que se generó un QR (venta real o Paso 5 de certificación), con la
  // comparación campo por campo y el SignatureValue completo. Útil para auditar sin acceso
  // directo al filesystem del servidor.
  router.get('/print/qr-diagnostics', async (req, res) => {
    try {
      const dir = path.join(process.cwd(), 'storage', 'ecf', 'qr-diagnostics');
      if (!fs.existsSync(dir)) return res.json({ diagnostics: [] });
      const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 200));
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit);
      const diagnostics = files.map(({ f }) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      res.json({ diagnostics });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/print/repr-impresa/:encf', async (req, res) => {
    try {
      const { generateReprImpresaHtml } = require('./repr-impresa');
      const rows = await deps.query(`SELECT signed_xml_content FROM ecf_documents WHERE encf = ? AND signed_xml_content IS NOT NULL LIMIT 1`, [req.params.encf]);
      if (!rows.length) return res.status(404).json({ error: 'Documento no encontrado o sin XML firmado.' });
      const html = await generateReprImpresaHtml(rows[0].signed_xml_content, { env: process.env.DGII_ENV || 'certecf' });
      res.type('text/html').send(html);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/print/repr-impresa/:encf/pdf', async (req, res) => {
    let browser;
    try {
      const { generateReprImpresaHtml } = require('./repr-impresa');
      const puppeteer = require('puppeteer');
      const rows = await deps.query(`SELECT signed_xml_content FROM ecf_documents WHERE encf = ? AND signed_xml_content IS NOT NULL LIMIT 1`, [req.params.encf]);
      if (!rows.length) return res.status(404).json({ error: 'Documento no encontrado o sin XML firmado.' });
      const html = await generateReprImpresaHtml(rows[0].signed_xml_content, { env: process.env.DGII_ENV || 'certecf' });
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
      await browser.close();
      browser = null;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.encf}-repr-impresa.pdf"`);
      res.send(pdf);
    } catch (e) {
      if (browser) { try { await browser.close(); } catch (_) {} }
      res.status(500).json({ error: e.message });
    }
  });

  return {
    router,
    service,
  };
}

function createDisabledLegacyApiRouter() {
  const router = express.Router();
  router.use((_req, res) => {
    res.status(410).json({
      error: 'Las rutas fiscales anteriores fueron desactivadas. Usa /api/ecf.',
    });
  });
  return router;
}

function createDisabledLegacyPublicRouter() {
  const router = express.Router();
  router.use('/fe', (_req, res) => {
    res.status(410).json({
      error: 'Las rutas públicas DGII heredadas fueron retiradas del módulo activo.',
    });
  });
  return router;
}

module.exports = {
  createDisabledLegacyApiRouter,
  createDisabledLegacyPublicRouter,
  createEcfRouter,
};

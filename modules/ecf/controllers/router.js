'use strict';

const express = require('express');
const { createEcfService } = require('../services/ecf.service');

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
  router.get('/certification/cases', wrap((req) => service.listCertificationCases(req.query || {})));
  router.get('/certification/summary', wrap(() => service.getCertificationSummary()));
  router.post('/certification/import', wrap((req) => service.importCertificationSet(req)));
  router.post('/certification/send-next', wrap((req) => service.sendNextCertificationCase(req)));
  router.post('/certification/run-sequential', wrap((req) => service.runCertificationSequence(req)));
  router.post('/certification/poll-statuses', wrap(() => service.pollCertificationStatuses()));
  router.post('/certification/reset-sent', wrap((req) => service.resetSentCertificationCases(req)));
  // Convierte E32 RFCE → ECF cuando es referenciado por E33/E34 (NCFModificado)
  router.post('/certification/fix-ncf-refs', wrap((req) => service.fixNcfModificadoRefs(req)));
  // Rota eNCFs quemados (ya enviados en intentos anteriores) asignando nuevos números de secuencia.
  // Usar cuando DGII rechaza con "Este número de secuencia ya ha sido utilizado".
  router.post('/certification/rotate-encfs', wrap((req) => service.rotateBurnedEncfs(req)));
  // Parchea NombreComercial del rawRow de un caso cuando el Excel tiene valor incorrecto.
  // Body: { encf: 'E310000000002', nombreComercial: '' }
  router.post('/certification/fix-nombre-comercial', wrap((req) => service.fixCaseNombreComercial(req)));
  // Genera y firma los 4 XMLs < 250Mil para subir al portal DGII
  router.post('/certification/generate-250mil', wrap((req) => service.generate250MilXmls(req)));
  router.post('/certification/cases/:id/send', wrap((req) => service.sendCertificationCase(Number(req.params.id), req)));
  router.post('/certification/cases/:id/resend', wrap((req) => service.sendCertificationCase(Number(req.params.id), req, { forceResend: true })));
  router.get('/certification/cases/:id/track', wrap((req) => service.queryCertificationCase(Number(req.params.id))));
  router.delete('/certification/reset', wrap((req) => service.resetCertificationData(req)));
  router.get('/reports/summary', wrap(() => service.getSummaryReport()));
  // DIAGNÓSTICO TEMPORAL — eliminar después de resolver el problema de certificación
  router.get('/diag/cert-original-xml', wrap(() => service.diagCertificationOriginalXml()));
  // Muestra los mensajes DGII de todos los docs rechazados en el batch actual.
  router.get('/diag/cert-rejection-messages', wrap(() => service.diagCertRejectionMessages()));

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

'use strict';

/**
 * firma.routes.js — Firma digital del PDF de cotización / factura de servicios.
 *
 *   GET    /api/servicios/documento/firma-estado              → estado del certificado .p12
 *   POST   /api/servicios/documento/firmar                    { pdfBase64 } → { ok, signedBase64 }
 *   POST   /api/servicios/documento/:base/:id/guardar-firmado { pdfBase64 } → guarda el PDF ya firmado
 *   GET    /api/servicios/documento/:base/:id/firmado         → { pdfBase64, signedAt } | 404
 *   DELETE /api/servicios/documento/:base/:id/firmado         → borra el firmado guardado
 *
 * Reusa el certificado .p12 que ya administra el módulo e-CF (modules/ecf), pero
 * NO envía nada a DGII: solo estampa una firma PAdES.
 */

const express = require('express');
const fs = require('fs');
const { httpError, roleCodeOf, actorName, makeServiceGuard } = require('./_common');
const { signServiceDocumentPdf } = require('./pdf-sign');

// El body JSON global va topado en 10 MB; cortamos antes con un mensaje claro.
const MAX_PDF_B64 = 9 * 1024 * 1024;

// base de la URL → tabla del documento.
const DOC_TABLES = { facturas: 'svc_invoices', cotizaciones: 'svc_quotations' };

function createFirmaRouter(deps) {
  const { query, getConfig, ecfService, writeAuditLog } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();

  router.use(guard.requireService());

  async function certStatus() {
    if (!ecfService || typeof ecfService.getCertificateStatus !== 'function') {
      return { hasCertificate: false, status: 'unavailable' };
    }
    if (typeof ecfService.ensureReady === 'function') {
      await ecfService.ensureReady().catch(() => {});
    }
    try {
      return await ecfService.getCertificateStatus();
    } catch (e) {
      return { hasCertificate: false, status: 'error', error: e.message };
    }
  }

  router.get('/firma-estado', async (_req, res) => {
    const st = await certStatus();
    res.json({
      hasCertificate: Boolean(st && st.hasCertificate),
      status: st && st.status ? st.status : 'none',
      subject: (st && st.subject) || '',
      validTo: (st && st.validTo) || null,
      isExpired: Boolean(st && st.isExpired),
      error: (st && st.error) || null,
    });
  });

  router.post('/firmar', async (req, res) => {
    const actor = req.authUser;
    try {
      const pdfBase64 = String(req.body && req.body.pdfBase64 || '');
      if (!pdfBase64) throw httpError('Falta el PDF a firmar (pdfBase64).');
      if (pdfBase64.length > MAX_PDF_B64) throw httpError('El PDF es demasiado grande para firmar.', 413);

      const st = await certStatus();
      if (!st || !st.hasCertificate) return res.json({ ok: false, reason: 'no-cert', message: 'No hay certificado .p12 cargado.' });
      if (st.isExpired || st.status === 'vencido') return res.json({ ok: false, reason: 'expired', message: 'El certificado .p12 está vencido.' });
      if (st.status === 'error') return res.json({ ok: false, reason: 'cert-error', message: st.error || 'El certificado no se pudo leer.' });

      // resolveCertificate valida vigencia y devuelve ruta + contraseña descifrada.
      const cert = await ecfService.resolveCertificate();
      if (!cert || !cert.certPath || !fs.existsSync(cert.certPath)) {
        return res.json({ ok: false, reason: 'no-cert', message: 'El archivo del certificado no está disponible.' });
      }
      const p12Buffer = fs.readFileSync(cert.certPath);

      const cfg = (getConfig ? await getConfig().catch(() => ({})) : {}) || {};
      const signerName = String(cfg.nombre || 'Emisor').trim();
      const signerRnc = String(cfg.rnc || '').replace(/\D/g, '');

      const pdfBuffer = Buffer.from(pdfBase64.replace(/^data:application\/pdf;base64,/, ''), 'base64');
      const signed = await signServiceDocumentPdf(pdfBuffer, {
        p12Buffer,
        passphrase: cert.certPassword,
        signerName,
        signerRnc,
        reason: `Documento emitido por ${signerName}`,
        location: cfg.direccion || 'República Dominicana',
      });

      if (typeof writeAuditLog === 'function') {
        writeAuditLog({
          userId: actor && actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
          moduleName: 'Facturación', actionName: 'Documento firmado digitalmente',
          detail: `${signerName} · ${(signed.length / 1024).toFixed(0)} KB`,
        }).catch(() => {});
      }

      res.json({ ok: true, signedBase64: signed.toString('base64') });
    } catch (e) {
      // Errores de solicitud (falta el PDF, muy grande) → 4xx normal.
      if (e.statusCode && e.statusCode < 500) {
        return res.status(e.statusCode).json({ error: e.message });
      }
      // Fallo de firma en sí → 200 ok:false para que el llamador caiga a "sin firma".
      res.json({ ok: false, reason: 'sign-failed', message: e.message });
    }
  });

  // ── PDF ya firmado, guardado con el documento ──────────────────────────────
  function tableFor(base) {
    const t = DOC_TABLES[String(base || '').toLowerCase()];
    if (!t) throw httpError('Tipo de documento no válido.', 400);
    return t;
  }

  router.post('/:base/:id/guardar-firmado', async (req, res) => {
    try {
      const table = tableFor(req.params.base);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw httpError('Documento no válido.', 400);
      const pdfBase64 = String(req.body && req.body.pdfBase64 || '');
      if (!pdfBase64) throw httpError('Falta el PDF (pdfBase64).', 400);
      if (pdfBase64.length > MAX_PDF_B64) throw httpError('El PDF es demasiado grande.', 413);

      const clean = pdfBase64.replace(/^data:application\/pdf;base64,/, '');
      const raw = Buffer.from(clean, 'base64').toString('latin1');
      if (!raw.startsWith('%PDF')) throw httpError('El contenido no es un PDF.', 400);
      // Debe venir ya firmado (tener el diccionario de firma).
      if (!/\/ByteRange\s*\[/.test(raw)) throw httpError('El PDF no está firmado.', 400);

      await query(`UPDATE ${table} SET signed_pdf = ?, signed_at = datetime('now') WHERE id = ?`, [clean, id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  router.get('/:base/:id/firmado', async (req, res) => {
    try {
      const table = tableFor(req.params.base);
      const id = Number(req.params.id);
      const [row] = await query(`SELECT signed_pdf, signed_at FROM ${table} WHERE id = ? LIMIT 1`, [id]);
      if (!row || !row.signed_pdf) return res.status(404).json({ error: 'Sin PDF firmado guardado.' });
      res.json({ pdfBase64: row.signed_pdf, signedAt: row.signed_at || null });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  router.delete('/:base/:id/firmado', async (req, res) => {
    try {
      const table = tableFor(req.params.base);
      await query(`UPDATE ${table} SET signed_pdf = NULL, signed_at = NULL WHERE id = ?`, [Number(req.params.id)]);
      res.json({ ok: true });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createFirmaRouter };

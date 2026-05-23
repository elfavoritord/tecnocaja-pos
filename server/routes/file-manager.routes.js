/**
 * file-manager.routes.js
 * API REST para el módulo de gestión de archivos Sistema_Data.
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');

function createFileManagerRouter({ fileManagerService, query }) {
  const router = express.Router();
  const svc    = fileManagerService;

  // ── GET /api/files/structure ───────────────────────────────────────────────
  router.get('/structure', (_req, res) => {
    try {
      res.json({ ok: true, tree: svc.getFolderTree(), baseDir: svc.baseDir });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/files/list ────────────────────────────────────────────────────
  router.get('/list', async (req, res) => {
    try {
      const { term, category, sub_category, start_date, end_date, document_type, page, limit } = req.query;
      const result = await svc.searchFiles({
        term, category,
        subCategory:  sub_category,
        startDate:    start_date,
        endDate:      end_date,
        documentType: document_type,
        page:         parseInt(page)  || 1,
        limit:        parseInt(limit) || 50,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/files/disk-stats ──────────────────────────────────────────────
  router.get('/disk-stats', async (_req, res) => {
    try {
      const stats = await svc.getDiskStats();
      res.json({ ok: true, stats });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/files/old ─────────────────────────────────────────────────────
  router.get('/old', async (req, res) => {
    try {
      const days  = parseInt(req.query.days) || 365;
      const files = await svc.getOldFiles(days);
      res.json({ ok: true, files: files || [], count: (files || []).length, days });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/files/filename ────────────────────────────────────────────────
  router.get('/filename', (req, res) => {
    try {
      const { type, id, date, period, clientName, provName, name, extension } = req.query;
      const fileName = svc.generateFileName(type, {
        id, date: date ? new Date(date) : new Date(),
        period, clientName, provName, name, extension,
      });
      res.json({ ok: true, fileName });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/files/download/:id ────────────────────────────────────────────
  router.get('/download/:id', async (req, res) => {
    try {
      const rows = await query('SELECT * FROM file_registry WHERE id = ? AND is_deleted = 0', [req.params.id]);
      if (!rows?.length) return res.status(404).json({ error: 'Archivo no encontrado' });
      const file = rows[0];
      if (!fs.existsSync(file.file_path)) return res.status(404).json({ error: 'Archivo no encontrado en disco' });
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.file_name)}"`);
      const ext = path.extname(file.file_name).toLowerCase();
      res.setHeader('Content-Type', ext === '.pdf' ? 'application/pdf' : ext === '.zip' ? 'application/zip' : 'application/octet-stream');
      res.sendFile(path.resolve(file.file_path));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/files/preview/:id ─────────────────────────────────────────────
  router.get('/preview/:id', async (req, res) => {
    try {
      const rows = await query('SELECT * FROM file_registry WHERE id = ? AND is_deleted = 0', [req.params.id]);
      if (!rows?.length) return res.status(404).json({ error: 'Archivo no encontrado' });
      const file = rows[0];
      if (!fs.existsSync(file.file_path)) return res.status(404).json({ error: 'Archivo no encontrado en disco' });
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.file_name)}"`);
      res.setHeader('Content-Type', 'application/pdf');
      res.sendFile(path.resolve(file.file_path));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/files/save ───────────────────────────────────────────────────
  // Guarda contenido (base64 PDF) + registra en la BD.
  // Body: { documentType, content, referenceId, referenceDate, description,
  //         category?, subCategory?, fileName?, branchId?, terminalId? }
  router.post('/save', async (req, res) => {
    try {
      const { documentType, content } = req.body;
      if (!documentType || !content) {
        return res.status(400).json({ ok: false, error: 'documentType y content son requeridos' });
      }
      const result = await svc.saveAndRegister(req.body);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/files/register ───────────────────────────────────────────────
  // Registra un archivo que ya existe en disco (ej. backups).
  router.post('/register', async (req, res) => {
    try {
      const result = await svc.registerFile(req.body);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/files/cleanup ────────────────────────────────────────────────
  router.post('/cleanup', async (req, res) => {
    try {
      const { daysOld = 365 } = req.body;
      const result = await svc.cleanupOldFiles(Number(daysOld));
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── DELETE /api/files/:id ──────────────────────────────────────────────────
  router.delete('/:id', async (req, res) => {
    try {
      const result = await svc.deleteFile(parseInt(req.params.id), req.query.permanent === 'true');
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createFileManagerRouter };

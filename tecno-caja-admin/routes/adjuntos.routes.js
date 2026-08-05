'use strict';

/**
 * adjuntos.routes.js — Archivos adjuntos (comprobantes, facturas escaneadas)
 * Compartido entre Compras y Gastos — misma colección, mismo par de endpoints.
 * Calcado del patrón ya probado en tecno-caja-contadores/server.js (adjuntos
 * de asientos contables / movimientos de banco).
 *
 * POST   /api/adjuntos                          — sube un archivo (dataBase64)
 * GET    /api/adjuntos?entidadTipo&entidadId     — lista con signed URLs (15 min)
 * DELETE /api/adjuntos/:id                       — borra de Storage + Firestore
 */

const express = require('express');

const COL_ADJUNTOS = 'adjuntos';
const ENTIDADES_VALIDAS = ['compra', 'gasto'];

function createAdjuntosRouter({ col, docData, isoNow, requireAuth, getBucket }) {
  const router = express.Router();

  router.post('/', requireAuth, async (req, res) => {
    try {
      const bucket = getBucket();
      if (!bucket) return res.status(500).json({ error: 'Firebase Storage no está configurado.' });

      const { entidadTipo, entidadId, nombre, contentType, dataBase64 } = req.body || {};
      if (!ENTIDADES_VALIDAS.includes(entidadTipo)) return res.status(400).json({ error: 'entidadTipo inválido.' });
      if (!entidadId || !nombre || !dataBase64) return res.status(400).json({ error: 'entidadId, nombre y dataBase64 son requeridos.' });

      const buffer = Buffer.from(String(dataBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (buffer.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'El archivo no puede superar 10MB.' });

      const storagePath = `admin/${entidadTipo}s/${entidadId}/${Date.now()}-${nombre}`;
      await bucket.file(storagePath).save(buffer, { contentType: contentType || 'application/octet-stream' });

      const ref = await col(COL_ADJUNTOS).add({
        entidadTipo, entidadId, nombre,
        contentType: contentType || 'application/octet-stream',
        size: buffer.length, storagePath,
        subidoPor: req.adminUser.email, fecha: isoNow(),
      });
      res.status(201).json({ ok: true, id: ref.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/', requireAuth, async (req, res) => {
    try {
      const { entidadTipo, entidadId } = req.query;
      if (!entidadTipo || !entidadId) return res.status(400).json({ error: 'entidadTipo y entidadId son requeridos.' });

      const snap = await col(COL_ADJUNTOS)
        .where('entidadTipo', '==', entidadTipo)
        .where('entidadId', '==', entidadId)
        .get();

      const bucket = getBucket();
      const items = await Promise.all(snap.docs.map(async (d) => {
        const data = docData(d);
        let url = null;
        if (bucket) {
          try {
            const [signedUrl] = await bucket.file(data.storagePath).getSignedUrl({ action: 'read', expires: Date.now() + 15 * 60 * 1000 });
            url = signedUrl;
          } catch { /* archivo pudo haber sido borrado directamente en Storage */ }
        }
        return { ...data, url };
      }));
      res.json(items);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/:id', requireAuth, async (req, res) => {
    try {
      const ref = col(COL_ADJUNTOS).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Adjunto no encontrado.' });

      const bucket = getBucket();
      if (bucket) {
        try { await bucket.file(doc.data().storagePath).delete(); } catch { /* ya no existía en Storage */ }
      }
      await ref.delete();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createAdjuntosRouter };

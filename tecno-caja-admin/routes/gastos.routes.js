'use strict';

/**
 * gastos.routes.js — Gastos operativos de la empresa (Tecno Caja)
 * Registro plano, ya pagado — sin cuenta por pagar (a diferencia de Compras).
 *
 * GET    /api/gastos       — lista (filtros: categoria, q)
 * GET    /api/gastos/:id   — detalle
 * POST   /api/gastos       — crear
 * PUT    /api/gastos/:id   — editar
 * DELETE /api/gastos/:id   — borrar (registro interno, no fiscal)
 */

const express = require('express');

const COL_GASTOS = 'gastos';
const METODOS_PAGO = ['efectivo', 'transferencia', 'tarjeta', 'otro'];
const CATEGORIAS = [
  'luz', 'internet', 'alquiler', 'combustible', 'transporte', 'nomina',
  'mantenimiento', 'publicidad', 'equipos', 'servicios_profesionales',
  'impuestos', 'oficina', 'otros',
];

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function validatePayload(body) {
  const categoria = CATEGORIAS.includes(body.categoria) ? body.categoria : null;
  if (!categoria) throw new Error('Selecciona una categoría válida.');

  const monto = Number(body.monto);
  if (!Number.isFinite(monto) || monto <= 0) throw new Error('Ingresa un monto válido.');

  return {
    categoria,
    monto,
    proveedor: body.proveedor || null,
    comprobante: body.comprobante || null,
    fecha: body.fecha || null,
    metodoPago: METODOS_PAGO.includes(body.metodoPago) ? body.metodoPago : 'efectivo',
    notas: body.notas || null,
  };
}

function createGastosRouter({ col, docData, isoNow, audit, requireAuth }) {
  const router = express.Router();

  router.get('/', requireAuth, async (req, res) => {
    try {
      let query = col(COL_GASTOS);
      if (req.query.categoria) query = query.where('categoria', '==', req.query.categoria);
      const snap = await query.get();
      let list = snap.docs.map(docData);

      const q = String(req.query.q || '').trim().toLowerCase();
      if (q) {
        list = list.filter(g =>
          (g.proveedor   || '').toLowerCase().includes(q) ||
          (g.comprobante || '').toLowerCase().includes(q)
        );
      }

      list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      res.json(list);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/:id', requireAuth, async (req, res) => {
    try {
      const doc = await col(COL_GASTOS).doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: 'Gasto no encontrado.' });
      res.json(docData(doc));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/', requireAuth, async (req, res) => {
    try {
      const payload = validatePayload(req.body || {});
      const now = isoNow();
      const data = { ...payload, fecha: payload.fecha || now, createdBy: req.adminUser.email, createdAt: now, updatedAt: now };

      const ref = await col(COL_GASTOS).add(data);
      await audit(req.adminUser.email, 'gasto.crear', ref.id, `${data.categoria} — RD$ ${fmtMoney(data.monto)}`);
      const doc = await ref.get();
      res.status(201).json(docData(doc));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.put('/:id', requireAuth, async (req, res) => {
    try {
      const ref = col(COL_GASTOS).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Gasto no encontrado.' });

      const payload = validatePayload(req.body || {});
      const update = { ...payload, updatedAt: isoNow() };

      await ref.update(update);
      await audit(req.adminUser.email, 'gasto.editar', req.params.id, `${payload.categoria} — RD$ ${fmtMoney(payload.monto)}`);
      const updated = await ref.get();
      res.json(docData(updated));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.delete('/:id', requireAuth, async (req, res) => {
    try {
      const ref = col(COL_GASTOS).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Gasto no encontrado.' });
      const data = doc.data();
      await ref.delete();
      await audit(req.adminUser.email, 'gasto.eliminar', req.params.id, `${data.categoria} — RD$ ${fmtMoney(data.monto)}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createGastosRouter };

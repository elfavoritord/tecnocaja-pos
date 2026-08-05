'use strict';

/**
 * compras.routes.js — Compras a suplidores de la empresa (Tecno Caja)
 * No tiene relación con el inventario de los clientes POS ni con NCF/e-CF:
 * es el registro de lo que Emilio compra para operar/entregar a clientes.
 *
 * GET    /api/compras            — lista (filtros: estado, q)
 * GET    /api/compras/:id        — detalle
 * POST   /api/compras            — crear
 * PUT    /api/compras/:id        — editar (bloqueado si ya está pagada)
 * POST   /api/compras/:id/pagos  — registrar abono (solo tipoPago=credito)
 */

const express = require('express');

const COL_COMPRAS = 'compras';
const METODOS_PAGO = ['efectivo', 'transferencia', 'tarjeta', 'otro'];
const TIPOS_PAGO = ['contado', 'credito'];
const ESTADOS_EDITABLES = ['pendiente', 'parcial'];

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw new Error('La compra debe tener al menos un ítem.');
  return rawItems.map((it, idx) => {
    const descripcion = String(it.descripcion || '').trim();
    const cantidad = Number(it.cantidad);
    const precioUnitario = Number(it.precioUnitario);
    if (!descripcion) throw new Error(`El ítem ${idx + 1} necesita una descripción.`);
    if (!Number.isFinite(cantidad) || cantidad <= 0) throw new Error(`El ítem ${idx + 1} necesita una cantidad válida.`);
    if (!Number.isFinite(precioUnitario) || precioUnitario < 0) throw new Error(`El ítem ${idx + 1} necesita un precio válido.`);
    return { descripcion, cantidad, precioUnitario, monto: cantidad * precioUnitario };
  });
}

function computeTotals(items, { aplicaItbis, tasaItbis }) {
  const subtotal = items.reduce((sum, it) => sum + it.monto, 0);
  const itbis = aplicaItbis ? subtotal * (Number(tasaItbis) || 0) : 0;
  return { subtotal, itbis, total: subtotal + itbis };
}

function createComprasRouter({ col, docData, isoNow, audit, requireAuth }) {
  const router = express.Router();

  router.get('/', requireAuth, async (req, res) => {
    try {
      let query = col(COL_COMPRAS);
      if (req.query.estado) query = query.where('estado', '==', req.query.estado);
      const snap = await query.get();
      let list = snap.docs.map(docData);

      const q = String(req.query.q || '').trim().toLowerCase();
      if (q) {
        list = list.filter(c =>
          (c.suplidorNombre || '').toLowerCase().includes(q) ||
          (c.numeroFactura || '').toLowerCase().includes(q)
        );
      }

      list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      res.json(list);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/:id', requireAuth, async (req, res) => {
    try {
      const doc = await col(COL_COMPRAS).doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: 'Compra no encontrada.' });
      res.json(docData(doc));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/', requireAuth, async (req, res) => {
    try {
      const { suplidorNombre, suplidorRnc, numeroFactura, comprobanteFiscal,
        fechaCompra, fechaVencimiento, items, aplicaItbis, tasaItbis,
        tipoPago, metodoPago, notas } = req.body;

      if (!String(suplidorNombre || '').trim()) return res.status(400).json({ error: 'El nombre del suplidor es obligatorio.' });

      const normItems = normalizeItems(items);
      const aplicaItbisBool = aplicaItbis !== false;
      const tasa = Number.isFinite(Number(tasaItbis)) ? Number(tasaItbis) : 0.18;
      const { subtotal, itbis, total } = computeTotals(normItems, { aplicaItbis: aplicaItbisBool, tasaItbis: tasa });

      const tipo = TIPOS_PAGO.includes(tipoPago) ? tipoPago : 'contado';
      const now = isoNow();
      const esContado = tipo === 'contado';

      const data = {
        suplidorNombre: String(suplidorNombre).trim(),
        suplidorRnc: suplidorRnc || null,
        numeroFactura: numeroFactura || null,
        comprobanteFiscal: comprobanteFiscal || null,
        fechaCompra: fechaCompra || now,
        fechaVencimiento: esContado ? null : (fechaVencimiento || null),
        items: normItems,
        aplicaItbis: aplicaItbisBool, tasaItbis: tasa,
        subtotal, itbis, total,
        tipoPago: tipo,
        metodoPago: METODOS_PAGO.includes(metodoPago) ? metodoPago : 'efectivo',
        estado: esContado ? 'pagada' : 'pendiente',
        montoPagado: esContado ? total : 0,
        pagos: esContado ? [{ monto: total, fecha: now, metodo: METODOS_PAGO.includes(metodoPago) ? metodoPago : 'efectivo', nota: 'Pago de contado al registrar la compra', registradoPor: req.adminUser.email }] : [],
        notas: notas || null,
        createdBy: req.adminUser.email,
        createdAt: now, updatedAt: now,
      };

      const ref = await col(COL_COMPRAS).add(data);
      await audit(req.adminUser.email, 'compra.crear', ref.id, `${data.suplidorNombre} — RD$ ${fmtMoney(total)} (${tipo})`);
      const doc = await ref.get();
      res.status(201).json(docData(doc));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.put('/:id', requireAuth, async (req, res) => {
    try {
      const ref = col(COL_COMPRAS).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Compra no encontrada.' });
      const existing = doc.data();
      if (!ESTADOS_EDITABLES.includes(existing.estado)) {
        return res.status(400).json({ error: `No se puede editar una compra en estado "${existing.estado}".` });
      }

      const { suplidorNombre, suplidorRnc, numeroFactura, comprobanteFiscal,
        fechaCompra, fechaVencimiento, items, aplicaItbis, tasaItbis, metodoPago, notas } = req.body;

      const normItems = normalizeItems(items);
      const aplicaItbisBool = aplicaItbis !== false;
      const tasa = Number.isFinite(Number(tasaItbis)) ? Number(tasaItbis) : 0.18;
      const { subtotal, itbis, total } = computeTotals(normItems, { aplicaItbis: aplicaItbisBool, tasaItbis: tasa });

      const montoPagado = Number(existing.montoPagado || 0);
      if (total < montoPagado) {
        return res.status(400).json({ error: 'El nuevo total no puede ser menor al monto ya pagado.' });
      }

      const update = {
        suplidorNombre: suplidorNombre ? String(suplidorNombre).trim() : existing.suplidorNombre,
        suplidorRnc: suplidorRnc ?? existing.suplidorRnc,
        numeroFactura: numeroFactura ?? existing.numeroFactura,
        comprobanteFiscal: comprobanteFiscal ?? existing.comprobanteFiscal,
        fechaCompra: fechaCompra ?? existing.fechaCompra,
        fechaVencimiento: existing.tipoPago === 'credito' ? (fechaVencimiento ?? existing.fechaVencimiento) : null,
        items: normItems,
        aplicaItbis: aplicaItbisBool, tasaItbis: tasa,
        subtotal, itbis, total,
        metodoPago: METODOS_PAGO.includes(metodoPago) ? metodoPago : existing.metodoPago,
        notas: notas ?? existing.notas,
        estado: montoPagado >= total ? 'pagada' : (montoPagado > 0 ? 'parcial' : 'pendiente'),
        updatedAt: isoNow(),
      };

      await ref.update(update);
      await audit(req.adminUser.email, 'compra.editar', req.params.id, existing.suplidorNombre);
      const updated = await ref.get();
      res.json(docData(updated));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/:id/pagos', requireAuth, async (req, res) => {
    try {
      const ref = col(COL_COMPRAS).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Compra no encontrada.' });
      const existing = doc.data();
      if (existing.tipoPago === 'contado') return res.status(400).json({ error: 'Esta compra fue registrada de contado; no admite abonos.' });
      if (existing.estado === 'pagada') return res.status(400).json({ error: 'Esta compra ya está pagada en su totalidad.' });

      const monto = Number(req.body.monto);
      if (!Number.isFinite(monto) || monto <= 0) return res.status(400).json({ error: 'Ingresa un monto de pago válido.' });

      const metodo = METODOS_PAGO.includes(req.body.metodo) ? req.body.metodo : 'efectivo';
      const now = isoNow();
      const montoPagadoNuevo = Number(existing.montoPagado || 0) + monto;

      if (montoPagadoNuevo - existing.total > 0.01) {
        return res.status(400).json({ error: `El pago excede el saldo pendiente (RD$ ${fmtMoney(existing.total - existing.montoPagado)}).` });
      }

      const pago = { monto, fecha: now, metodo, nota: req.body.nota || null, registradoPor: req.adminUser.email };
      const estado = montoPagadoNuevo >= existing.total - 0.01 ? 'pagada' : 'parcial';

      await ref.update({
        pagos: [...(existing.pagos || []), pago],
        montoPagado: montoPagadoNuevo,
        estado,
        updatedAt: now,
      });

      await audit(req.adminUser.email, 'compra.pago', req.params.id, `${existing.suplidorNombre} — RD$ ${fmtMoney(monto)} (${metodo})`);
      const updated = await ref.get();
      res.json(docData(updated));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createComprasRouter };

'use strict';

/**
 * suscripciones.routes.js — Suscripciones / pagos recurrentes mensuales
 *
 * Cada suscripción es una plantilla de factura que se repite cada mes. NO cobra
 * tarjetas: solo genera la factura mensual (con su NCF) para que Emilio la cobre
 * como cualquier otra. La generación es manual (botón) + aviso de pendientes.
 *
 * GET    /api/suscripciones                 — lista (con `vencida` calculado)
 * GET    /api/suscripciones/pendientes      — { total, suscripciones } por facturar hoy
 * POST   /api/suscripciones                 — crear
 * PUT    /api/suscripciones/:id             — editar
 * POST   /api/suscripciones/:id/estado      — { estado: activa|pausada|cancelada }
 * DELETE /api/suscripciones/:id             — eliminar
 * POST   /api/suscripciones/generar         — genera facturas de las vencidas (o de `ids`)
 */

const express = require('express');
const { crearFactura, renderInvoicePdf } = require('./facturacion.routes');
const { isConfigured: isMailerConfigured, sendMail } = require('./mailer');

const COL_SUS = 'suscripciones';
const ESTADOS = ['activa', 'pausada', 'cancelada'];
const NCF_TIPOS = { B01: 'Crédito Fiscal', B02: 'Consumo', B04: 'Nota de Crédito', B15: 'Gubernamental' };
const NCF_REQUIEREN_RNC = ['B01', 'B15'];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Suma un mes a una fecha ISO (YYYY-MM-DD), fijando el día al día de corte.
// diaCorte se valida 1..28, así que no hay problemas de meses cortos.
function nextMonthIso(iso, diaCorte) {
  const [y, m] = String(iso).split('-').map(Number);       // m = 1..12
  const dia = Math.min(Math.max(Number(diaCorte) || 1, 1), 28);
  const d = new Date(y, m, dia);                            // m (0-idx) = mes siguiente
  return d.toISOString().slice(0, 10);
}

function periodoDe(iso) {
  return String(iso).slice(0, 7); // 'YYYY-MM'
}

function periodoLabel(periodo) {
  const [y, m] = periodo.split('-').map(Number);
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return `${meses[(m - 1) % 12]} ${y}`;
}

function normalizeInput(body, existing = {}) {
  const monto = Number(body.monto);
  const diaCorte = parseInt(body.diaCorte, 10);
  const tipoNcf = String(body.tipoNcf || existing.tipoNcf || '').toUpperCase().trim();
  const concepto = String(body.concepto ?? existing.concepto ?? '').trim();
  const clienteNombre = String(body.clienteNombre ?? existing.clienteNombre ?? '').trim();
  const clienteRnc = (body.clienteRnc ?? existing.clienteRnc ?? '') || '';

  if (!concepto) throw new Error('Indica el concepto (lo que dice el ítem de la factura).');
  if (!Number.isFinite(monto) || monto <= 0) throw new Error('El monto mensual debe ser mayor a 0.');
  if (!Number.isInteger(diaCorte) || diaCorte < 1 || diaCorte > 28) throw new Error('El día de corte debe estar entre 1 y 28.');
  if (!NCF_TIPOS[tipoNcf]) throw new Error('Selecciona el tipo de comprobante fiscal (NCF).');
  if (NCF_REQUIEREN_RNC.includes(tipoNcf) && !String(clienteRnc).trim()) {
    throw new Error(`El comprobante ${tipoNcf} exige el RNC/Cédula del cliente.`);
  }

  return {
    concepto, monto, diaCorte, tipoNcf, clienteNombre,
    clienteRnc: clienteRnc || null,
    clienteTelefono: (body.clienteTelefono ?? existing.clienteTelefono ?? '') || null,
    clienteDireccion: (body.clienteDireccion ?? existing.clienteDireccion ?? '') || null,
    clienteEmail: (body.clienteEmail ?? existing.clienteEmail ?? '') || null,
    aplicaItbis: body.aplicaItbis != null ? body.aplicaItbis !== false : (existing.aplicaItbis !== false),
    tasaItbis: Number.isFinite(Number(body.tasaItbis)) ? Number(body.tasaItbis) : (existing.tasaItbis ?? 0.18),
    descuento: Number(body.descuento) || 0,
    metodoPago: body.metodoPago || existing.metodoPago || 'transferencia',
    diasVencimiento: Number.isFinite(Number(body.diasVencimiento)) ? Number(body.diasVencimiento) : (existing.diasVencimiento ?? 0),
    enviarAutomatico: body.enviarAutomatico != null ? body.enviarAutomatico === true : (existing.enviarAutomatico === true),
    notas: (body.notas ?? existing.notas ?? '') || null,
  };
}

function decorate(s) {
  const hoy = todayIso();
  return {
    ...s,
    vencida: s.estado === 'activa' && s.proximaFacturacion && String(s.proximaFacturacion).slice(0, 10) <= hoy,
    periodoPendiente: s.proximaFacturacion ? periodoDe(s.proximaFacturacion) : null,
  };
}

function createSuscripcionesRouter({ col, docData, isoNow, audit, requireAuth, licenciasCollection }) {
  const router = express.Router();

  async function listarVencidas() {
    const snap = await col(COL_SUS).where('estado', '==', 'activa').get();
    const hoy = todayIso();
    return snap.docs.map(docData).filter(s =>
      s.proximaFacturacion && String(s.proximaFacturacion).slice(0, 10) <= hoy
      && periodoDe(s.proximaFacturacion) !== s.ultimoPeriodoFacturado
    );
  }

  router.get('/', requireAuth, async (_req, res) => {
    try {
      const snap = await col(COL_SUS).get();
      const list = snap.docs.map(docData)
        .sort((a, b) => String(a.estado).localeCompare(String(b.estado)) || String(a.proximaFacturacion || '').localeCompare(String(b.proximaFacturacion || '')))
        .map(decorate);
      res.json(list);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/pendientes', requireAuth, async (_req, res) => {
    try {
      const vencidas = await listarVencidas();
      res.json({
        total: vencidas.length,
        suscripciones: vencidas.map(s => ({
          id: s.id, clienteNombre: s.clienteNombre, concepto: s.concepto,
          monto: s.monto, periodo: periodoDe(s.proximaFacturacion),
          proximaFacturacion: s.proximaFacturacion,
        })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/', requireAuth, async (req, res) => {
    try {
      const { negocioId } = req.body;
      if (!negocioId) return res.status(400).json({ error: 'Selecciona un negocio/cliente.' });
      const negDoc = await col(licenciasCollection).doc(negocioId).get();
      if (!negDoc.exists) return res.status(404).json({ error: 'El negocio seleccionado no existe.' });

      const fields = normalizeInput(req.body);
      const now = isoNow();

      // Primera facturación: el próximo día de corte a partir de hoy (o la fecha
      // explícita que envíe el front en `primeraFacturacion`).
      let proxima = String(req.body.primeraFacturacion || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(proxima)) {
        const hoy = new Date();
        let cand = new Date(hoy.getFullYear(), hoy.getMonth(), fields.diaCorte);
        if (cand < hoy) cand = new Date(hoy.getFullYear(), hoy.getMonth() + 1, fields.diaCorte);
        proxima = cand.toISOString().slice(0, 10);
      }

      const data = {
        negocioId, ...fields,
        proximaFacturacion: proxima,
        estado: 'activa',
        ultimoPeriodoFacturado: null,
        ultimaFacturaId: null,
        facturasGeneradas: 0,
        createdBy: req.adminUser.email,
        createdAt: now, updatedAt: now,
      };
      const ref = await col(COL_SUS).add(data);
      await audit(req.adminUser.email, 'suscripcion.crear', ref.id, `${data.clienteNombre} — ${data.concepto} — RD$ ${data.monto}/mes`);
      res.status(201).json(decorate({ id: ref.id, ...data }));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.put('/:id', requireAuth, async (req, res) => {
    try {
      const ref = col(COL_SUS).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Suscripción no encontrada.' });
      const existing = doc.data();

      const fields = normalizeInput(req.body, existing);
      const update = { ...fields, updatedAt: isoNow() };
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.body.proximaFacturacion || ''))) {
        update.proximaFacturacion = String(req.body.proximaFacturacion).slice(0, 10);
      }
      await ref.update(update);
      await audit(req.adminUser.email, 'suscripcion.editar', req.params.id, existing.concepto);
      const updated = await ref.get();
      res.json(decorate(docData(updated)));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/:id/estado', requireAuth, async (req, res) => {
    try {
      const estado = String(req.body.estado || '').toLowerCase();
      if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });
      const ref = col(COL_SUS).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Suscripción no encontrada.' });
      await ref.update({ estado, updatedAt: isoNow() });
      await audit(req.adminUser.email, `suscripcion.${estado}`, req.params.id, doc.data().concepto);
      res.json({ ok: true, estado });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.delete('/:id', requireAuth, async (req, res) => {
    try {
      const ref = col(COL_SUS).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Suscripción no encontrada.' });
      await ref.delete();
      await audit(req.adminUser.email, 'suscripcion.eliminar', req.params.id, doc.data().concepto);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Genera las facturas de las suscripciones vencidas (o de las `ids` indicadas).
  // Cada factura consume un NCF de su secuencia. Si una falla, no se adelanta su
  // fecha; se reportan los errores y se sigue con las demás.
  router.post('/generar', requireAuth, async (req, res) => {
    try {
      const ids = Array.isArray(req.body.ids) ? req.body.ids : null;
      let objetivo = await listarVencidas();
      if (ids) objetivo = objetivo.filter(s => ids.includes(s.id));

      const deps = { col, isoNow, audit, licenciasCollection, docData };
      const resultados = [];

      for (const s of objetivo) {
        const periodo = periodoDe(s.proximaFacturacion);
        try {
          let fechaVencimiento = null;
          if (Number(s.diasVencimiento) > 0) {
            const d = new Date();
            d.setDate(d.getDate() + Number(s.diasVencimiento));
            fechaVencimiento = d.toISOString().slice(0, 10);
          }

          const factura = await crearFactura(deps, {
            negocioId: s.negocioId,
            clienteNombre: s.clienteNombre,
            clienteRnc: s.clienteRnc,
            clienteTelefono: s.clienteTelefono,
            clienteDireccion: s.clienteDireccion,
            clienteEmail: s.clienteEmail,
            items: [{ descripcion: `${s.concepto} — ${periodoLabel(periodo)}`, cantidad: 1, precioUnitario: s.monto }],
            aplicaItbis: s.aplicaItbis,
            tasaItbis: s.tasaItbis,
            descuento: s.descuento || 0,
            metodoPago: s.metodoPago,
            fechaVencimiento,
            notas: s.notas,
            tipoNcf: s.tipoNcf,
            origen: 'suscripcion',
            suscripcionId: s.id,
            periodo,
          }, req.adminUser.email);

          await col(COL_SUS).doc(s.id).update({
            proximaFacturacion: nextMonthIso(s.proximaFacturacion, s.diaCorte),
            ultimoPeriodoFacturado: periodo,
            ultimaFacturaId: factura.id,
            facturasGeneradas: (Number(s.facturasGeneradas) || 0) + 1,
            updatedAt: isoNow(),
          });

          // Envío automático por correo (opcional). Un fallo de correo NO revierte
          // la factura ya creada — solo se reporta.
          let correo = null;
          if (s.enviarAutomatico && s.clienteEmail && isMailerConfigured()) {
            try {
              const pdf = await renderInvoicePdf(factura, col);
              await sendMail({
                to: s.clienteEmail,
                subject: `Factura ${factura.numero}${factura.ncf ? ` · NCF ${factura.ncf}` : ''} — ${s.concepto}`,
                text: `Estimado(a) ${factura.clienteNombre},\n\nAdjuntamos la factura ${factura.numero} correspondiente a ${s.concepto} (${periodoLabel(periodo)}) por RD$ ${Number(factura.total).toLocaleString('es-DO', { minimumFractionDigits: 2 })}.\n\nGracias por su preferencia.`,
                attachmentBuffer: pdf,
                attachmentName: `${factura.numero}.pdf`,
              });
              await col('facturas').doc(factura.id).update({ ultimoEmailA: s.clienteEmail, ultimoEmailEn: isoNow() }).catch(() => {});
              correo = { enviado: true, to: s.clienteEmail };
            } catch (mailErr) {
              correo = { enviado: false, error: mailErr.message };
            }
          }

          resultados.push({ suscripcionId: s.id, ok: true, facturaId: factura.id, numero: factura.numero, ncf: factura.ncf, cliente: s.clienteNombre, periodo, correo });
        } catch (err) {
          resultados.push({ suscripcionId: s.id, ok: false, cliente: s.clienteNombre, periodo, error: err.message });
        }
      }

      const generadas = resultados.filter(r => r.ok).length;
      const errores = resultados.filter(r => !r.ok);
      await audit(req.adminUser.email, 'suscripcion.generar', 'batch', `${generadas} facturas generadas, ${errores.length} errores`);
      res.json({ generadas, errores: errores.length, resultados });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createSuscripcionesRouter };

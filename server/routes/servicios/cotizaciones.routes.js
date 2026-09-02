'use strict';

/**
 * cotizaciones.routes.js — Cotizaciones del modo Empresas de Servicios.
 * Flujo: Cliente → Cotización → Aprobación → Factura (POST /api/servicios/facturas/desde-cotizacion/:id).
 *
 *  GET    /api/servicios/cotizaciones?estado=&clientId=&branchId=&desde=&hasta=
 *  POST   /api/servicios/cotizaciones
 *  GET    /api/servicios/cotizaciones/:id
 *  PUT    /api/servicios/cotizaciones/:id
 *  POST   /api/servicios/cotizaciones/:id/estado   { estado }
 *  DELETE /api/servicios/cotizaciones/:id
 */

const express = require('express');
const {
  httpError, roleCodeOf, actorName, computeTotals, makeServiceGuard, resolveBranch,
} = require('./_common');
const { renderInvoiceDoc, renderEmailBody } = require('./renderDoc');
const { sendInvoiceEmail } = require('./mailer');

const ESTADOS = ['borrador', 'enviada', 'aprobada', 'rechazada', 'vencida', 'convertida'];
const EDITABLE = ['borrador', 'enviada'];

function mapQuotation(row, items = []) {
  return {
    id: row.id,
    numero: row.numero,
    clientId: row.client_id || null,
    clientName: row.client_name || '',
    clientRnc: row.client_rnc || '',
    branchId: row.branch_id || null,
    sucursal: row.branch_name || '',
    fecha: row.fecha,
    validezDias: Number(row.validez_dias || 15),
    estado: row.estado,
    subtotal: Number(row.subtotal || 0),
    descuento: Number(row.descuento || 0),
    itbis: Number(row.itbis || 0),
    total: Number(row.total || 0),
    notas: row.notas || '',
    condiciones: row.condiciones || '',
    convertedInvoiceId: row.converted_invoice_id || null,
    creadoPor: row.created_by_user_name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
    items: items.map((it) => ({
      id: it.id,
      serviceId: it.service_id || null,
      descripcion: it.descripcion,
      cantidad: Number(it.cantidad || 0),
      precio: Number(it.precio || 0),
      descuentoPct: Number(it.descuento_pct || 0),
      itbisPct: Number(it.itbis_pct || 0),
      total: Number(it.total || 0),
    })),
  };
}

function createCotizacionesRouter(deps) {
  const {
    query, withTransaction, writeAuditLog, ensureSchema, nextServiceDocNumber,
    getConfig, isGlobalAdministratorUser, getUserScopeBranchId,
  } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();

  router.use(guard.requireService());
  router.use(async (_req, _res, next) => {
    try { await ensureSchema(query); next(); } catch (e) { next(e); }
  });

  async function loadItems(quotationId) {
    return query('SELECT * FROM svc_quotation_items WHERE quotation_id = ? ORDER BY id', [quotationId]);
  }

  async function fetchFull(id) {
    const [row] = await query(
      `SELECT q.*, b.nombre AS branch_name, c.email AS client_email FROM svc_quotations q
       LEFT JOIN branches b ON b.id = q.branch_id
       LEFT JOIN clients c ON c.id = q.client_id
       WHERE q.id = ?`, [id]
    );
    if (!row) return null;
    return { ...mapQuotation(row, await loadItems(id)), clientEmail: row.client_email || '' };
  }

  // ── Listar ───────────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const branchScope = resolveBranch(req.authUser, req.query.branchId, deps);
      const cond = [];
      const params = [];
      if (branchScope) { cond.push('q.branch_id = ?'); params.push(branchScope); }
      if (req.query.estado && ESTADOS.includes(req.query.estado)) {
        cond.push('q.estado = ?'); params.push(req.query.estado);
      } else if (req.query.todas !== '1') {
        // Por defecto la lista NO muestra cotizaciones ya cerradas (convertidas
        // en factura o rechazadas) — se ven en Facturación. ?todas=1 las incluye.
        cond.push("q.estado NOT IN ('convertida', 'rechazada')");
      }
      if (req.query.clientId) { cond.push('q.client_id = ?'); params.push(Number(req.query.clientId)); }
      if (req.query.desde) { cond.push('q.fecha >= ?'); params.push(String(req.query.desde)); }
      if (req.query.hasta) { cond.push('q.fecha <= ?'); params.push(String(req.query.hasta)); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const rows = await query(
        `SELECT q.*, b.nombre AS branch_name FROM svc_quotations q
         LEFT JOIN branches b ON b.id = q.branch_id
         ${where} ORDER BY q.fecha DESC, q.id DESC LIMIT 500`, params
      );
      res.json(rows.map((r) => mapQuotation(r)));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const full = await fetchFull(Number(req.params.id));
      if (!full) return res.status(404).json({ error: 'Cotización no encontrada.' });
      res.json(full);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // Ensambla el payload del documento A4/térmico.
  async function buildDocPayload(full, cfg) {
    let contact = {};
    if (full.clientId) {
      const [c] = await query('SELECT email, telefono, direccion FROM clients WHERE id = ? LIMIT 1', [full.clientId]);
      if (c) contact = { clientEmail: c.email || '', clientTel: c.telefono || '', clientDir: c.direccion || '' };
    }
    let correo = '';
    try {
      const [mc] = await query('SELECT service_mail_user FROM config WHERE id = 1 LIMIT 1');
      correo = (mc && mc.service_mail_user) || '';
    } catch (_) { /* noop */ }
    return {
      empresa: {
        nombre: cfg.nombre || 'Tecno Caja', rnc: cfg.rnc || '', direccion: cfg.direccion || '',
        telefono: cfg.telefono || '', correo, logo: cfg.logo || '',
      },
      invoice: { ...full, ...contact, docType: 'cotizacion' },
      items: full.items,
    };
  }

  // ── Documento imprimible (A4 / 80mm / 58mm) ──────────────────────────────
  router.get('/:id/documento', async (req, res) => {
    try {
      const full = await fetchFull(Number(req.params.id));
      if (!full) return res.status(404).json({ error: 'Cotización no encontrada.' });
      const cfg = (getConfig ? await getConfig().catch(() => ({})) : {});
      const formato = String(req.query.formato || cfg.serviceInvoiceDefaultFormat || 'a4').toLowerCase();
      const html = renderInvoiceDoc(await buildDocPayload(full, cfg), formato);
      if (req.query.raw === '1') { res.type('html').send(html); return; }
      res.json({ formato, html, quotation: full });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Enviar por correo (siempre A4) ──────────────────────────────────────
  router.post('/:id/email', guard.requirePerm('servicios.crear', 'servicios.enviar', 'servicios.editar'), async (req, res) => {
    const actor = req.authUser;
    try {
      const full = await fetchFull(Number(req.params.id));
      if (!full) throw httpError('Cotización no encontrada.', 404);
      let to = String(req.body?.to || '').trim();
      if (!to && full.clientId) {
        const [c] = await query('SELECT email FROM clients WHERE id = ? LIMIT 1', [full.clientId]);
        to = String(c?.email || '').trim();
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw httpError('Indica un correo de destino válido.');
      const cfg = (getConfig ? await getConfig().catch(() => ({})) : {});
      const payload = await buildDocPayload(full, cfg);
      const mensaje = String(req.body?.mensaje || '').trim()
        || `Estimado/a ${full.clientName || 'cliente'}, adjunto la cotización ${full.numero} por RD$ ${Number(full.total).toFixed(2)}.`;
      await sendInvoiceEmail(query, {
        to,
        subject: req.body?.subject || `Cotización ${full.numero} — ${payload.empresa.nombre}`,
        text: mensaje,
        html: renderEmailBody(payload, mensaje),
        pdfBase64: req.body?.pdfBase64 || null,
        filename: `${full.numero}.pdf`,
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Cotizaciones', actionName: 'Cotización enviada por correo',
        detail: `${full.numero} → ${to}`,
        branchId: full.branchId, clientId: full.clientId, documentType: 'cotizacion', documentRef: full.numero, amount: full.total,
      });
      res.json({ ok: true, to });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  async function readBody(body) {
    const fecha = String(body?.fecha || '').trim() || new Date().toISOString().slice(0, 10);
    const totals = computeTotals(body?.items);
    if (!totals.items.length) throw httpError('Agrega al menos un servicio a la cotización.');
    if (totals.items.some((i) => !i.descripcion)) throw httpError('Cada línea necesita una descripción.');
    let clientId = body?.clientId ? Number(body.clientId) : null;
    let clientName = String(body?.clientName || '').trim() || null;
    let clientRnc = String(body?.clientRnc || '').trim() || null;
    if (clientId) {
      const [cli] = await query('SELECT nombre, cedula FROM clients WHERE id = ? LIMIT 1', [clientId]);
      if (cli) { clientName = cli.nombre || clientName; clientRnc = String(cli.cedula || '').trim() || clientRnc; }
      else clientId = null;
    }
    return {
      fecha,
      clientId,
      clientName,
      clientRnc,
      validezDias: Math.max(1, Number(body?.validezDias || 15)),
      notas: String(body?.notas || '').trim() || null,
      condiciones: String(body?.condiciones || '').trim() || null,
      totals,
    };
  }

  // ── Crear ────────────────────────────────────────────────────────────────
  router.post('/', guard.requirePerm('servicios.crear'), async (req, res) => {
    const actor = req.authUser;
    try {
      const p = await readBody(req.body);
      const branchId = resolveBranch(actor, req.body?.branchId, deps)
        || (req.body?.branchId ? Number(req.body.branchId) : null);
      const cashRegisterId = req.body?.cashRegisterId ? Number(req.body.cashRegisterId) : null;
      const estado = EDITABLE.includes(req.body?.estado) ? req.body.estado : 'borrador';

      const saved = await withTransaction(async (conn) => {
        const numero = await nextServiceDocNumber(conn, 'quotation');
        const r = await conn.query(
          `INSERT INTO svc_quotations
            (numero, client_id, client_name, client_rnc, branch_id, cash_register_id, fecha, validez_dias,
             estado, subtotal, descuento, itbis, total, notas, condiciones, created_by_user_id, created_by_user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [numero, p.clientId, p.clientName, p.clientRnc, branchId, cashRegisterId, p.fecha, p.validezDias,
           estado, p.totals.subtotal, p.totals.descuento, p.totals.itbis, p.totals.total, p.notas, p.condiciones,
           actor.id, actorName(actor)]
        );
        const quotationId = r.insertId;
        for (const it of p.totals.items) {
          await conn.query(
            `INSERT INTO svc_quotation_items
              (quotation_id, service_id, descripcion, cantidad, precio, descuento_pct, itbis_pct, total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [quotationId, it.serviceId, it.descripcion, it.cantidad, it.precio, it.descuentoPct, it.itbisPct, it.total]
          );
        }
        return { quotationId, numero };
      });

      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Cotizaciones', actionName: 'Cotización creada',
        detail: `${saved.numero} · RD$ ${p.totals.total.toFixed(2)}`,
        branchId, clientId: p.clientId, documentType: 'cotizacion', documentRef: saved.numero, amount: p.totals.total,
      });
      res.status(201).json(await fetchFull(saved.quotationId));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Editar (solo borrador/enviada) ───────────────────────────────────────
  router.put('/:id', guard.requirePerm('servicios.crear', 'servicios.editar'), async (req, res) => {
    const actor = req.authUser;
    const id = Number(req.params.id);
    try {
      const [cur] = await query('SELECT * FROM svc_quotations WHERE id = ?', [id]);
      if (!cur) throw httpError('Cotización no encontrada.', 404);
      if (!EDITABLE.includes(cur.estado)) throw httpError(`No se puede editar una cotización en estado "${cur.estado}".`, 409);
      const p = await readBody(req.body);
      await withTransaction(async (conn) => {
        await conn.query(
          `UPDATE svc_quotations SET client_id=?, client_name=?, client_rnc=?, fecha=?, validez_dias=?,
             subtotal=?, descuento=?, itbis=?, total=?, notas=?, condiciones=?, updated_at=datetime('now') WHERE id=?`,
          [p.clientId, p.clientName, p.clientRnc, p.fecha, p.validezDias,
           p.totals.subtotal, p.totals.descuento, p.totals.itbis, p.totals.total, p.notas, p.condiciones, id]
        );
        await conn.query('DELETE FROM svc_quotation_items WHERE quotation_id = ?', [id]);
        for (const it of p.totals.items) {
          await conn.query(
            `INSERT INTO svc_quotation_items
              (quotation_id, service_id, descripcion, cantidad, precio, descuento_pct, itbis_pct, total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, it.serviceId, it.descripcion, it.cantidad, it.precio, it.descuentoPct, it.itbisPct, it.total]
          );
        }
      });
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Cotizaciones', actionName: 'Cotización editada', detail: `${cur.numero} (#${id})`,
        branchId: cur.branch_id, clientId: p.clientId, documentType: 'cotizacion', documentRef: cur.numero, amount: p.totals.total,
      });
      res.json(await fetchFull(id));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Cambiar estado ───────────────────────────────────────────────────────
  router.post('/:id/estado', guard.requirePerm('servicios.crear', 'servicios.editar'), async (req, res) => {
    const actor = req.authUser;
    const id = Number(req.params.id);
    const nuevo = String(req.body?.estado || '').trim().toLowerCase();
    try {
      if (!['enviada', 'aprobada', 'rechazada', 'vencida', 'borrador'].includes(nuevo)) {
        throw httpError('Estado no válido.');
      }
      const [cur] = await query('SELECT * FROM svc_quotations WHERE id = ?', [id]);
      if (!cur) throw httpError('Cotización no encontrada.', 404);
      if (cur.estado === 'convertida') throw httpError('La cotización ya fue convertida en factura.', 409);
      await query(`UPDATE svc_quotations SET estado = ?, updated_at = datetime('now') WHERE id = ?`, [nuevo, id]);
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Cotizaciones', actionName: `Cotización ${nuevo}`, detail: `${cur.numero} (#${id})`,
        branchId: cur.branch_id, clientId: cur.client_id, documentType: 'cotizacion', documentRef: cur.numero,
      });
      res.json(await fetchFull(id));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  router.delete('/:id', guard.requirePerm('servicios.editar', 'servicios.anular'), async (req, res) => {
    const actor = req.authUser;
    const id = Number(req.params.id);
    try {
      const [cur] = await query('SELECT * FROM svc_quotations WHERE id = ?', [id]);
      if (!cur) throw httpError('Cotización no encontrada.', 404);
      if (cur.estado !== 'borrador') throw httpError('Solo se pueden eliminar cotizaciones en borrador. Usa "rechazada" para las demás.', 409);
      await query('DELETE FROM svc_quotations WHERE id = ?', [id]);
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Cotizaciones', actionName: 'Cotización eliminada', detail: `${cur.numero} (#${id})`,
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createCotizacionesRouter, mapQuotation, ESTADOS };

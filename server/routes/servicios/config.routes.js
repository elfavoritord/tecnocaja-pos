'use strict';

/**
 * config.routes.js — Configuración del modo Empresa de Servicios.
 * El vertical (tipo de empresa) se fija en el wizard y NO se cambia desde aquí.
 *
 *  GET /api/servicios/config
 *  PUT /api/servicios/config           { fiscalMode?, invoiceFormat?, mailUser?, mailPass?, mailFrom? }
 */

const express = require('express');
const { httpError, roleCodeOf, actorName, makeServiceGuard } = require('./_common');

const VERTICALES = [
  'srv_consultoria', 'srv_tecnologia', 'srv_publicidad', 'srv_arquitectura',
  'srv_limpieza', 'srv_seguridad', 'srv_mantenimiento', 'srv_viajes',
];
const FISCAL = ['ncf', 'ecf', 'consumidor'];
const FORMATOS = ['a4', '80mm', '58mm'];

function createConfigRouter(deps) {
  const { query, writeAuditLog, ensureSchema } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();

  router.use(guard.requireService());
  router.use(async (_req, _res, next) => { try { await ensureSchema(query); next(); } catch (e) { next(e); } });

  router.get('/', async (_req, res) => {
    try {
      const [row = {}] = await query(
        `SELECT business_type, service_vertical, service_fiscal_mode, service_invoice_default_format,
                service_mail_user, service_mail_from
         FROM config WHERE id = 1 LIMIT 1`
      );
      res.json({
        vertical: row.service_vertical || row.business_type || null,
        fiscalMode: row.service_fiscal_mode || 'ncf',
        invoiceFormat: row.service_invoice_default_format || 'a4',
        mailUser: row.service_mail_user || '',
        mailFrom: row.service_mail_from || '',
        mailConfigured: Boolean(row.service_mail_user),
      });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  router.put('/', guard.requirePerm('servicios.config', 'servicios.editar'), async (req, res) => {
    const actor = req.authUser;
    const b = req.body || {};
    try {
      const sets = [];
      const params = [];
      if (b.fiscalMode !== undefined) {
        if (!FISCAL.includes(b.fiscalMode)) throw httpError('Modo fiscal no válido.');
        sets.push('service_fiscal_mode = ?'); params.push(b.fiscalMode);
      }
      if (b.invoiceFormat !== undefined) {
        if (!FORMATOS.includes(b.invoiceFormat)) throw httpError('Formato de factura no válido.');
        sets.push('service_invoice_default_format = ?'); params.push(b.invoiceFormat);
      }
      if (b.mailUser !== undefined) { sets.push('service_mail_user = ?'); params.push(String(b.mailUser).trim() || null); }
      if (b.mailPass !== undefined && b.mailPass !== '') { sets.push('service_mail_pass = ?'); params.push(String(b.mailPass).replace(/\s+/g, '')); }
      if (b.mailFrom !== undefined) { sets.push('service_mail_from = ?'); params.push(String(b.mailFrom).trim() || null); }
      if (!sets.length) throw httpError('Nada que actualizar.');

      await query(`UPDATE config SET ${sets.join(', ')} WHERE id = 1`, params);
      await writeAuditLog({
        userId: actor.id, userName: actorName(actor), userRole: roleCodeOf(actor),
        moduleName: 'Configuración', actionName: 'Configuración de servicios actualizada',
        detail: Object.keys(b).filter((k) => k !== 'mailPass').join(', '),
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createConfigRouter, VERTICALES };

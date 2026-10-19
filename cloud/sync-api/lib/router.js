'use strict';

/**
 * Rutas de la Sync API.
 *
 *   GET  /health
 *   POST /v1/equipos/activar   { codigo, equipo: { deviceId, hostname, serverId, appVersion } }
 *        → 201 { token, equipoId, empresa, sucursal }  (el token se entrega UNA vez)
 *   GET  /v1/identidad          Authorization: Bearer <token>
 *        → { empresa, sucursal, equipo, licencia }      (datos vigentes desde la central)
 *   POST /v1/latido             Authorization: Bearer <token>
 *        { appVersion, modo, pendientes: { salida, errores }, ultimaSincronizacion }
 *        → { ok }   (para el estado de cada sucursal en los paneles)
 *
 * Los eventos (ventas, inventario, catálogo) llegan en la Fase 5.
 */

const express = require('express');
const { createSucursalesCentral } = require('../vendor/multisucursal/sucursales');
const { autenticar, nuevoToken } = require('./equipos');
const { createRateLimiter } = require('./rate-limit');

const MODOS = new Set(['normal', 'local', 'contingencia', 'sin_bd']);

function texto(valor, max) {
  return String(valor == null ? '' : valor).trim().slice(0, max);
}

function entero(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 1e9) : 0;
}

function vistaSucursal(s) {
  return {
    branchUuid: s.branchUuid,
    nombre: s.nombre,
    codigo: s.codigo || '',
    direccion: s.direccion || '',
    telefono: s.telefono || '',
    encargado: s.encargado || '',
    esPrincipal: Boolean(s.esPrincipal),
    estado: s.estado,
    version: Number(s.version || 1),
  };
}

function createRouter({ db, now = () => new Date(), limites = {} }) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  const central = createSucursalesCentral({ db, now });
  const permitirActivacion = createRateLimiter({
    windowMs: limites.activarVentanaMs || 15 * 60 * 1000,
    max: limites.activarMax || 10,
    now: () => now().getTime(),
  });

  function fallo(res, error) {
    const status = Number(error.statusCode) || 500;
    if (status >= 500) console.error('[SYNC]', error);
    res.status(status).set('Cache-Control', 'no-store').json({
      ok: false,
      error: status >= 500 ? 'Error interno de la Sync API.' : error.message,
      code: status >= 500 ? 'ERROR_INTERNO' : (error.code || null),
    });
  }

  async function autenticado(req, res, next) {
    try {
      req.ctx = await autenticar(db, req.get('authorization'));
      next();
    } catch (error) {
      fallo(res, error);
    }
  }

  router.get('/health', (_req, res) => res.json({ ok: true, servicio: 'tecno-caja-sync-api' }));

  router.post('/v1/equipos/activar', async (req, res) => {
    if (!permitirActivacion(req.ip)) {
      return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera unos minutos.', code: 'DEMASIADOS_INTENTOS' });
    }
    try {
      const codigo = texto(req.body?.codigo, 20);
      if (!codigo) return res.status(400).json({ ok: false, error: 'Escribe el código de activación.', code: 'SIN_CODIGO' });
      const credencial = nuevoToken();
      const r = await central.activarEquipo(codigo, req.body?.equipo || {}, {
        equipoId: credencial.equipoId,
        tokenHash: credencial.tokenHash,
      });
      res.status(201).set('Cache-Control', 'no-store').json({
        ok: true,
        token: credencial.token,
        equipoId: r.equipoId,
        empresa: { licenseId: r.licenseId, companyUuid: r.companyUuid, nombre: r.businessName },
        sucursal: vistaSucursal(r.sucursal),
        reemplazados: r.reemplazados.length,
      });
    } catch (error) {
      fallo(res, error);
    }
  });

  router.get('/v1/identidad', autenticado, (req, res) => {
    const { equipo, licencia, sucursal } = req.ctx;
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      empresa: {
        licenseId: equipo.licenseId,
        companyUuid: licencia.companyUuid || equipo.companyUuid,
        nombre: licencia.businessName || licencia.razon_social || '',
      },
      sucursal: vistaSucursal(sucursal),
      equipo: { equipoId: equipo.equipoId, estado: equipo.estado },
      licencia: { status: licencia.status || 'trial' },
    });
  });

  router.post('/v1/latido', autenticado, async (req, res) => {
    try {
      const b = req.body || {};
      const ultima = new Date(b.ultimaSincronizacion);
      const latido = {
        appVersion: texto(b.appVersion, 20),
        modo: MODOS.has(b.modo) ? b.modo : 'normal',
        pendientes: { salida: entero(b.pendientes?.salida), errores: entero(b.pendientes?.errores) },
        ultimaSincronizacion: Number.isNaN(ultima.getTime()) ? null : ultima.toISOString(),
        recibidoEn: now().toISOString(),
      };
      await req.ctx.equipo.ref.update({ ultimaConexion: now(), latido, ...(latido.appVersion ? { appVersion: latido.appVersion } : {}) });
      res.json({ ok: true });
    } catch (error) {
      fallo(res, error);
    }
  });

  return router;
}

module.exports = { createRouter };

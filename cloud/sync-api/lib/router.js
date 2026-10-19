'use strict';

/**
 * Rutas de la Sync API.
 *
 *   GET  /health
 *   POST /v1/equipos/activar   { codigo, equipo: { deviceId, hostname, serverId, appVersion } }
 *        → 201 { token, equipoId, empresa, sucursal }  (el token se entrega UNA vez)
 *   POST /v1/acceso/dueno       { idToken }   (Firebase Auth del dueño del negocio)
 *        → { empresas: [{ licenseId, nombre, perfil, sucursales: [{ ..., pc }] }] }
 *   POST /v1/equipos/activar-dueno  { idToken, licenseId, branchUuid, equipo }
 *        → 201 igual que activar, sin código (el dueño elige la sucursal)
 *   GET  /v1/identidad          Authorization: Bearer <token>
 *        → { empresa, sucursal, equipo, licencia }      (datos vigentes desde la central)
 *   POST /v1/latido             Authorization: Bearer <token>
 *        { appVersion, modo, pendientes: { salida, errores }, ultimaSincronizacion, ncf: [{ rangoUuid, siguiente }] }
 *        → { ok }   (para el estado de cada sucursal en los paneles)
 *   POST /v1/eventos            Authorization: Bearer <token>
 *        { eventos: [{ eventId, entityType, entityUuid, operation, version, payload }] }  (máx. 200)
 *        → { resultados: [{ eventId, resultado: ok|duplicado|rechazado, code?, motivo? }] }
 *   GET  /v1/cambios?tipo=catalogo|usuarios|comandos|ncf&desde=<seq>&limite=<n>&contar=1
 *        → { items, siguiente, hayMas, pendientes? }
 *   GET  /v1/sucursales         sucursales de la empresa (nombre, código, principal, estado)
 *
 * La empresa y la sucursal salen SIEMPRE del token, nunca del cuerpo: un
 * equipo no puede mandar ni leer datos de otra sucursal o de otra empresa.
 */

const express = require('express');
const { createSucursalesCentral } = require('../vendor/multisucursal/sucursales');
const { createSincronizacionCentral, STREAMS } = require('../vendor/multisucursal/sincronizacion-central');
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

// Cuánto vale el inicio de sesión del dueño para listar y unir una PC.
const VIGENCIA_SESION_DUENO_MS = 30 * 60 * 1000;

function createRouter({
  db,
  now = () => new Date(),
  limites = {},
  // Firebase Auth (Admin SDK) en producción; en pruebas, uno falso.
  verificarIdToken = async () => { throw new Error('Firebase Auth no está configurado.'); },
}) {
  const router = express.Router();
  const jsonChico = express.json({ limit: '64kb' });
  // Un lote de 200 ventas con sus líneas.
  const jsonLote = express.json({ limit: '4mb' });
  const central = createSucursalesCentral({ db, now });
  const sincronizacion = createSincronizacionCentral({ db, now });
  const permitirActivacion = createRateLimiter({
    windowMs: limites.activarVentanaMs || 15 * 60 * 1000,
    max: limites.activarMax || 10,
    now: () => now().getTime(),
  });
  // Entrar con la cuenta del dueño: aparte de la activación (listar y luego
  // activar son dos llamadas del mismo asistente).
  const permitirDueno = createRateLimiter({
    windowMs: limites.duenoVentanaMs || 15 * 60 * 1000,
    max: limites.duenoMax || 20,
    now: () => now().getTime(),
  });
  // Por equipo: un POS normal hace unas pocas peticiones por minuto.
  const permitirEquipo = createRateLimiter({
    windowMs: 60 * 1000,
    max: limites.equipoPorMinuto || 120,
    now: () => now().getTime(),
  });

  function contexto(req) {
    const { equipo, sucursal } = req.ctx;
    return {
      licenseId: equipo.licenseId,
      branchUuid: equipo.branchUuid,
      esPrincipal: Boolean(sucursal.esPrincipal),
      equipoId: equipo.equipoId,
      hostname: equipo.hostname || '',
    };
  }

  // Para el panel: cuándo sincronizó por última vez cada PC (alerta > 4 h).
  function marcarSincronizacion(req) {
    return req.ctx.equipo.ref.update({ ultimaSincronizacion: now(), ultimaConexion: now() }).catch(() => {});
  }

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
      if (!permitirEquipo(req.ctx.equipo.equipoId)) {
        return res.status(429).json({ ok: false, error: 'Demasiadas peticiones de este equipo.', code: 'DEMASIADAS_PETICIONES' });
      }
      next();
    } catch (error) {
      fallo(res, error);
    }
  }

  router.get('/health', (_req, res) => res.json({ ok: true, servicio: 'tecno-caja-sync-api' }));

  router.post('/v1/equipos/activar', jsonChico, async (req, res) => {
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

  // ── Entrar con la cuenta del dueño (asistente de una PC nueva, sin código) ──
  // El POS manda el idToken de Firebase Auth que obtuvo con el correo y la
  // contraseña del dueño (o su Google). Se exige que sea de un inicio de
  // sesión reciente: un token viejo filtrado no sirve para unir una PC.
  async function dueno(req) {
    const idToken = texto(req.body?.idToken, 4096);
    if (!idToken) throw Object.assign(new Error('Entra con el correo y la contraseña del dueño del negocio.'), { statusCode: 400, code: 'SIN_CUENTA' });
    let t;
    try {
      t = await verificarIdToken(idToken);
    } catch (_) {
      throw Object.assign(new Error('La sesión del dueño no es válida o venció. Vuelve a escribir el correo y la contraseña.'), { statusCode: 401, code: 'CUENTA_INVALIDA' });
    }
    const email = String(t?.email || '').trim().toLowerCase();
    const autenticadoEn = Number(t?.auth_time) * 1000;
    if (!email) throw Object.assign(new Error('Esa cuenta no tiene correo.'), { statusCode: 401, code: 'CUENTA_INVALIDA' });
    if (!Number.isFinite(autenticadoEn) || now().getTime() - autenticadoEn > VIGENCIA_SESION_DUENO_MS) {
      throw Object.assign(new Error('Por seguridad, vuelve a escribir el correo y la contraseña del dueño.'), { statusCode: 401, code: 'SESION_VIEJA' });
    }
    return { uid: String(t.uid || t.sub || ''), email };
  }

  function vistaPerfil(p) {
    return p ? {
      tipoNegocio: p.tipoNegocio || null,
      moneda: p.moneda || null,
      itbis: p.itbis ?? null,
      rnc: p.rnc || null,
    } : null;
  }

  // Empresas con sucursales de este dueño (para elegir en cuál trabaja la PC).
  router.post('/v1/acceso/dueno', jsonChico, async (req, res) => {
    if (!permitirDueno(req.ip)) {
      return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera unos minutos.', code: 'DEMASIADOS_INTENTOS' });
    }
    try {
      const cuenta = await dueno(req);
      const empresas = await central.empresasDelDueno(cuenta.email);
      if (!empresas.length) {
        return res.status(404).set('Cache-Control', 'no-store').json({
          ok: false,
          error: 'Esta cuenta no es la dueña de ninguna empresa con sucursales en Tecno Caja. Las sucursales las crea Tecno Caja o tu contador.',
          code: 'SIN_EMPRESA',
        });
      }
      res.set('Cache-Control', 'no-store').json({
        ok: true,
        dueno: { email: cuenta.email },
        empresas: empresas.map((e) => ({
          licenseId: e.licenseId,
          companyUuid: e.companyUuid,
          nombre: e.businessName,
          activa: e.activa,
          perfil: vistaPerfil(e.perfilNegocio),
          sucursales: e.sucursales.map((s) => ({ ...vistaSucursal(s), pc: s.pc })),
        })),
      });
    } catch (error) {
      fallo(res, error);
    }
  });

  // Une esta PC a la sucursal elegida (mismo resultado que activar con código).
  router.post('/v1/equipos/activar-dueno', jsonChico, async (req, res) => {
    if (!permitirActivacion(req.ip)) {
      return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera unos minutos.', code: 'DEMASIADOS_INTENTOS' });
    }
    try {
      const cuenta = await dueno(req);
      const licenseId = texto(req.body?.licenseId, 160);
      const branchUuid = texto(req.body?.branchUuid, 36);
      if (!licenseId || !branchUuid) return res.status(400).json({ ok: false, error: 'Elige la sucursal.', code: 'DATOS_INVALIDOS' });
      const credencial = nuevoToken();
      const r = await central.activarEquipoDueno(cuenta, licenseId, branchUuid, req.body?.equipo || {}, {
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
        perfil: vistaPerfil(r.perfilNegocio),
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

  router.post('/v1/latido', jsonChico, autenticado, async (req, res) => {
    try {
      const b = req.body || {};
      const ultima = new Date(b.ultimaSincronizacion);
      const latido = {
        appVersion: texto(b.appVersion, 20),
        modo: MODOS.has(b.modo) ? b.modo : 'normal',
        pendientes: {
          salida: entero(b.pendientes?.salida),
          errores: entero(b.pendientes?.errores),
          conflictos: entero(b.pendientes?.conflictos),
        },
        ultimaSincronizacion: Number.isNaN(ultima.getTime()) ? null : ultima.toISOString(),
        recibidoEn: now().toISOString(),
      };
      await req.ctx.equipo.ref.update({ ultimaConexion: now(), latido, ...(latido.appVersion ? { appVersion: latido.appVersion } : {}) });
      if (Array.isArray(b.ncf) && b.ncf.length) await sincronizacion.registrarUsoNcf(contexto(req), b.ncf).catch(() => 0);
      // La principal publica su perfil: una sucursal nueva arranca igual.
      if (req.ctx.sucursal.esPrincipal && b.perfil && typeof b.perfil === 'object') {
        const itbis = Number(b.perfil.itbis);
        await db.collection('licencias').doc(req.ctx.equipo.licenseId).set({
          perfilNegocio: {
            tipoNegocio: texto(b.perfil.tipoNegocio, 30) || null,
            moneda: texto(b.perfil.moneda, 5) || null,
            itbis: Number.isFinite(itbis) && itbis >= 0 && itbis <= 100 ? itbis : null,
            rnc: String(b.perfil.rnc || '').replace(/\D/g, '').slice(0, 11) || null,
            actualizadoEn: now(),
          },
        }, { merge: true }).catch(() => {});
      }
      res.json({ ok: true });
    } catch (error) {
      fallo(res, error);
    }
  });

  // Sucursales de la empresa (para elegir a cuáles va un producto, un usuario
  // o un cambio de precio en la principal).
  router.get('/v1/sucursales', autenticado, async (req, res) => {
    try {
      const snap = await db.collection('licencias').doc(req.ctx.equipo.licenseId).collection('sucursales').get();
      res.set('Cache-Control', 'no-store').json({
        ok: true,
        sucursales: snap.docs.map((d) => ({ ...vistaSucursal({ branchUuid: d.id, ...d.data() }), estaPc: d.id === req.ctx.equipo.branchUuid })),
      });
    } catch (error) {
      fallo(res, error);
    }
  });

  router.post('/v1/eventos', jsonLote, autenticado, async (req, res) => {
    try {
      const eventos = req.body?.eventos;
      if (!Array.isArray(eventos)) return res.status(400).json({ ok: false, error: 'Falta la lista de eventos.', code: 'DATOS_INVALIDOS' });
      const resultados = await sincronizacion.procesarEventos(contexto(req), eventos);
      await marcarSincronizacion(req);
      res.set('Cache-Control', 'no-store').json({ ok: true, resultados });
    } catch (error) {
      fallo(res, error);
    }
  });

  router.get('/v1/cambios', autenticado, async (req, res) => {
    try {
      const tipo = String(req.query.tipo || '');
      if (!STREAMS.includes(tipo)) return res.status(400).json({ ok: false, error: 'Tipo de cambios desconocido.', code: 'DATOS_INVALIDOS' });
      const r = await sincronizacion.cambios(contexto(req), tipo, req.query.desde, req.query.limite, { contar: req.query.contar === '1' });
      await marcarSincronizacion(req);
      res.set('Cache-Control', 'no-store').json({ ok: true, ...r });
    } catch (error) {
      fallo(res, error);
    }
  });

  return router;
}

module.exports = { createRouter };

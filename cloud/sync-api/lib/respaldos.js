'use strict';

/**
 * Respaldos en la nube sin llaves en las PC.
 *
 * El POS ya no necesita una llave de Backblaze en su app.env: le pide aquí un
 * permiso corto y recibe enlaces de un solo uso (5 min) para SU carpeta
 * `backups/<licencia>/`. La llave del bucket vive solo en este servicio.
 *
 *   POST /v1/respaldos/sesion   { licenseId, deviceId }  (la PC registrada en su licencia)
 *                               o { idToken }            (la cuenta del dueño, p. ej. PC formateada)
 *        → { token, modo, licencias: [{ licenseId, nombre }], expira }
 *   POST /v1/respaldos/listar   Bearer → { licenseId } → { objetos: [{ key, size, lastModified }] }
 *   POST /v1/respaldos/subir    Bearer (solo la PC) → { key, sha256 } → { url, headers, expira }
 *   POST /v1/respaldos/bajar    Bearer → { key } → { url, expira }
 *   POST /v1/respaldos/verificar Bearer → { key } → { size, sha256 }
 *   POST /v1/respaldos/borrar   Bearer (solo la PC) → { key } → { ok }
 *   POST /v1/respaldos/clave    Bearer → { licenseId, propia? } → { clave, anteriores }
 *
 * La clave con que la PC cifra sus respaldos queda guardada aquí, cifrada con
 * RESPALDOS_SECRETO (que solo tiene este servicio): una PC formateada pierde su
 * app.env, y sin esa clave sus respaldos no se pueden abrir. La licencia sale
 * SIEMPRE del permiso, nunca del cuerpo: nadie abre la carpeta de otro negocio.
 */

const crypto = require('crypto');
const express = require('express');
const { createRateLimiter } = require('./rate-limit');

const COL_LICENCIAS = 'licencias';
const COL_CLAVES = 'respaldos_claves';
const CAMPOS_CORREO_DUENO = ['correo', 'ownerEmail', 'email'];
const VIGENCIA_EQUIPO_MS = 60 * 60 * 1000;
const VIGENCIA_DUENO_MS = 30 * 60 * 1000;
const VIGENCIA_SESION_DUENO_MS = 30 * 60 * 1000;
const LEGADA = 'Seguridad2026';
const MAX_ARCHIVO = 512 * 1024 * 1024;

const texto = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const correoNormal = (v) => String(v || '').trim().toLowerCase();
const fallo = (mensaje, statusCode, code) => Object.assign(new Error(mensaje), { statusCode, code });
const prefijo = (licenseId) => `backups/${licenseId}/`;

function llaveDe(secreto) {
  return crypto.createHash('sha256').update(String(secreto)).digest();
}

// Permiso firmado (como un JWT pequeño): { lic, modo, exp }.
function firmar(datos, secreto) {
  const cuerpo = Buffer.from(JSON.stringify(datos)).toString('base64url');
  const firma = crypto.createHmac('sha256', llaveDe(secreto)).update(cuerpo).digest('base64url');
  return `${cuerpo}.${firma}`;
}

function leerPermiso(token, secreto, ahora) {
  const [cuerpo, firma] = String(token || '').split('.');
  if (!cuerpo || !firma) return null;
  const esperada = crypto.createHmac('sha256', llaveDe(secreto)).update(cuerpo).digest('base64url');
  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let datos;
  try { datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!datos || !Array.isArray(datos.lic) || Number(datos.exp) < ahora) return null;
  return datos;
}

function cifrar(valor, secreto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', llaveDe(secreto), iv);
  const datos = Buffer.concat([c.update(String(valor), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), datos: datos.toString('base64') };
}

function descifrar(caja, secreto) {
  const d = crypto.createDecipheriv('aes-256-gcm', llaveDe(secreto), Buffer.from(caja.iv, 'base64'));
  d.setAuthTag(Buffer.from(caja.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(caja.datos, 'base64')), d.final()]).toString('utf8');
}

/**
 * @param {object} deps
 *   db                Firestore (Admin SDK)
 *   almacen           { listar(prefijo), urlSubida(key, sha256), urlBajada(key), verificar(key), borrar(key) }
 *   secreto           RESPALDOS_SECRETO (firma los permisos y cifra las claves)
 *   verificarIdToken  Firebase Auth del dueño
 */
function createRespaldosRouter({ db, almacen, secreto, verificarIdToken, now = () => new Date(), limites = {} }) {
  const router = express.Router();
  const json = express.json({ limit: '16kb' });
  const permitirSesion = createRateLimiter({ windowMs: 15 * 60 * 1000, max: limites.sesionMax || 30, now: () => now().getTime() });
  const permitirPermiso = createRateLimiter({ windowMs: 60 * 1000, max: limites.porMinuto || 120, now: () => now().getTime() });

  function responderFallo(res, error) {
    const status = Number(error.statusCode) || 500;
    if (status >= 500) console.error('[RESPALDOS]', error);
    res.status(status).set('Cache-Control', 'no-store').json({
      ok: false,
      error: status >= 500 ? 'Error interno del servicio de respaldos.' : error.message,
      code: status >= 500 ? 'ERROR_INTERNO' : (error.code || null),
    });
  }

  function listo(req, res, next) {
    if (!almacen || !secreto) return responderFallo(res, fallo('El servicio de respaldos no está configurado.', 503, 'SIN_CONFIGURAR'));
    next();
  }

  async function licenciasDelDueno(email) {
    const docs = new Map();
    for (const campo of CAMPOS_CORREO_DUENO) {
      const snap = await db.collection(COL_LICENCIAS).where(campo, '==', email).limit(25).get();
      snap.docs.forEach((d) => docs.set(d.id, d));
    }
    return [...docs.values()]
      .filter((d) => !d.data().deleted)
      .map((d) => ({ licenseId: d.id, nombre: d.data().businessName || d.data().razon_social || d.id }));
  }

  // La PC tiene que estar registrada (devices) en su licencia y no liberada.
  async function sesionEquipo(body) {
    const licenseId = texto(body.licenseId, 120);
    const deviceId = texto(body.deviceId, 200);
    if (!licenseId || !deviceId) throw fallo('Falta la licencia o el equipo.', 400, 'DATOS_INCOMPLETOS');
    const doc = await db.collection(COL_LICENCIAS).doc(licenseId).get();
    const lic = doc.exists ? doc.data() : null;
    if (!lic || lic.deleted) throw fallo('Esta licencia no existe.', 403, 'LICENCIA_DESCONOCIDA');
    const equipo = lic.devices && typeof lic.devices === 'object' ? lic.devices[deviceId] : null;
    if (!equipo || ['released', 'liberado', 'blocked', 'bloqueado'].includes(String(equipo.status || '').toLowerCase())) {
      throw fallo('Este equipo no está registrado en la licencia.', 403, 'EQUIPO_NO_REGISTRADO');
    }
    return { lic: [licenseId], modo: 'equipo', licencias: [{ licenseId, nombre: lic.businessName || licenseId }], vigencia: VIGENCIA_EQUIPO_MS };
  }

  async function sesionDueno(body) {
    const idToken = texto(body.idToken, 4096);
    let t;
    try { t = await verificarIdToken(idToken); } catch (_) {
      throw fallo('La cuenta del dueño no es válida o venció. Vuelve a escribir el correo y la contraseña.', 401, 'CUENTA_INVALIDA');
    }
    const email = correoNormal(t?.email);
    const autenticadoEn = Number(t?.auth_time) * 1000;
    if (!email) throw fallo('Esa cuenta no tiene correo.', 401, 'CUENTA_INVALIDA');
    if (!Number.isFinite(autenticadoEn) || now().getTime() - autenticadoEn > VIGENCIA_SESION_DUENO_MS) {
      throw fallo('Por seguridad, vuelve a escribir el correo y la contraseña del dueño.', 401, 'SESION_VIEJA');
    }
    const licencias = await licenciasDelDueno(email);
    if (!licencias.length) throw fallo(`${email} no es la cuenta del dueño de ningún negocio en Tecno Caja.`, 404, 'SIN_NEGOCIOS');
    return { lic: licencias.map((l) => l.licenseId), modo: 'dueno', licencias, vigencia: VIGENCIA_DUENO_MS, email };
  }

  router.post('/v1/respaldos/sesion', json, listo, async (req, res) => {
    if (!permitirSesion(req.ip)) return responderFallo(res, fallo('Demasiados intentos. Espera unos minutos.', 429, 'DEMASIADOS_INTENTOS'));
    try {
      const s = req.body?.idToken ? await sesionDueno(req.body) : await sesionEquipo(req.body || {});
      const exp = now().getTime() + s.vigencia;
      res.set('Cache-Control', 'no-store').json({
        ok: true, token: firmar({ lic: s.lic, modo: s.modo, exp }, secreto), modo: s.modo,
        licencias: s.licencias, expira: new Date(exp).toISOString(), ...(s.email ? { email: s.email } : {}),
      });
    } catch (error) {
      responderFallo(res, error);
    }
  });

  // Todo lo demás exige el permiso de /sesion.
  function conPermiso(req, res, next) {
    const permiso = leerPermiso(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''), secreto, now().getTime());
    if (!permiso) return responderFallo(res, fallo('El permiso de respaldos venció. Vuelve a pedirlo.', 401, 'PERMISO_VENCIDO'));
    if (!permitirPermiso(permiso.lic.join(','))) return responderFallo(res, fallo('Demasiadas peticiones.', 429, 'DEMASIADAS_PETICIONES'));
    req.permiso = permiso;
    next();
  }

  // La llave pedida tiene que estar dentro de la carpeta de una de sus licencias.
  function licenciaDeLlave(permiso, key) {
    const k = texto(key, 600);
    if (!k || k.includes('..') || k.includes('\\')) throw fallo('Archivo inválido.', 400, 'ARCHIVO_INVALIDO');
    const lic = permiso.lic.find((id) => k.startsWith(prefijo(id)) && k.length > prefijo(id).length);
    if (!lic) throw fallo('Ese archivo no es de tu negocio.', 403, 'OTRO_NEGOCIO');
    return k;
  }

  router.post('/v1/respaldos/listar', json, listo, conPermiso, async (req, res) => {
    try {
      const licenseId = texto(req.body?.licenseId, 120) || req.permiso.lic[0];
      if (!req.permiso.lic.includes(licenseId)) throw fallo('Ese negocio no es tuyo.', 403, 'OTRO_NEGOCIO');
      const objetos = await almacen.listar(prefijo(licenseId));
      res.set('Cache-Control', 'no-store').json({ ok: true, licenseId, objetos });
    } catch (error) {
      responderFallo(res, error);
    }
  });

  router.post('/v1/respaldos/subir', json, listo, conPermiso, async (req, res) => {
    try {
      if (req.permiso.modo !== 'equipo') throw fallo('Solo la PC del negocio sube respaldos.', 403, 'SOLO_EQUIPO');
      const key = licenciaDeLlave(req.permiso, req.body?.key);
      const sha256 = texto(req.body?.sha256, 64).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw fallo('Falta la huella del archivo.', 400, 'SIN_HUELLA');
      const tamano = Number(req.body?.tamano || 0);
      if (tamano > MAX_ARCHIVO) throw fallo('El respaldo es demasiado grande.', 413, 'MUY_GRANDE');
      res.set('Cache-Control', 'no-store').json({ ok: true, ...(await almacen.urlSubida(key, sha256)) });
    } catch (error) {
      responderFallo(res, error);
    }
  });

  router.post('/v1/respaldos/bajar', json, listo, conPermiso, async (req, res) => {
    try {
      const key = licenciaDeLlave(req.permiso, req.body?.key);
      res.set('Cache-Control', 'no-store').json({ ok: true, ...(await almacen.urlBajada(key)) });
    } catch (error) {
      responderFallo(res, error);
    }
  });

  router.post('/v1/respaldos/verificar', json, listo, conPermiso, async (req, res) => {
    try {
      const key = licenciaDeLlave(req.permiso, req.body?.key);
      res.set('Cache-Control', 'no-store').json({ ok: true, ...(await almacen.verificar(key)) });
    } catch (error) {
      responderFallo(res, error);
    }
  });

  router.post('/v1/respaldos/borrar', json, listo, conPermiso, async (req, res) => {
    try {
      if (req.permiso.modo !== 'equipo') throw fallo('Solo la PC del negocio borra sus respaldos viejos.', 403, 'SOLO_EQUIPO');
      const key = licenciaDeLlave(req.permiso, req.body?.key);
      await almacen.borrar(key);
      res.set('Cache-Control', 'no-store').json({ ok: true });
    } catch (error) {
      responderFallo(res, error);
    }
  });

  // Clave de los respaldos de un negocio. La PC manda la suya si tiene una
  // propia (propia: '...'); si no tiene, se le devuelve la guardada (PC
  // formateada). El dueño solo la lee, para restaurar en otra PC.
  router.post('/v1/respaldos/clave', json, listo, conPermiso, async (req, res) => {
    try {
      const licenseId = texto(req.body?.licenseId, 120) || req.permiso.lic[0];
      if (!req.permiso.lic.includes(licenseId)) throw fallo('Ese negocio no es tuyo.', 403, 'OTRO_NEGOCIO');
      const ref = db.collection(COL_CLAVES).doc(licenseId);
      const propia = typeof req.body?.propia === 'string' ? req.body.propia.slice(0, 200) : '';
      const resultado = await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        const guardada = doc.exists ? doc.data() : null;
        const actual = guardada?.actual ? descifrar(guardada.actual, secreto) : null;
        const anteriores = (guardada?.anteriores || []).map((c) => descifrar(c, secreto));
        if (req.permiso.modo === 'equipo' && propia && propia !== actual) {
          // La PC tiene una clave propia distinta: es la vigente; la de antes se conserva para abrir lo viejo.
          const nuevasAnteriores = [actual, ...anteriores].filter((c) => c && c !== propia).slice(0, 10);
          tx.set(ref, {
            actual: cifrar(propia, secreto), anteriores: nuevasAnteriores.map((c) => cifrar(c, secreto)),
            actualizadaEn: now(), licenseId,
          }, { merge: true });
          return { clave: propia, anteriores: nuevasAnteriores, guardada: true };
        }
        if (!actual) {
          if (req.permiso.modo !== 'equipo') throw fallo('Este negocio todavía no tiene su clave de respaldos guardada.', 404, 'SIN_CLAVE');
          // Sin clave propia: cifra con la de siempre; se guarda igual para saberlo al restaurar.
          tx.set(ref, { actual: cifrar(LEGADA, secreto), anteriores: [], creadaEn: now(), licenseId });
          return { clave: LEGADA, anteriores: [], guardada: true };
        }
        return { clave: actual, anteriores, guardada: false };
      });
      res.set('Cache-Control', 'no-store').json({ ok: true, licenseId, ...resultado });
    } catch (error) {
      responderFallo(res, error);
    }
  });

  return router;
}

module.exports = { createRespaldosRouter, firmar, leerPermiso, cifrar, descifrar };

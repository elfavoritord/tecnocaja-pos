'use strict';

/**
 * server/multisucursal/enlace.js — Enlace de esta PC (nodo de la sucursal)
 * con la Sync API central (cloud/sync-api). Fase 3c.
 *
 *  - activar(codigo): canjea el código de equipo que generó Emilio o el
 *    contador en su panel. La API devuelve un token (se guarda en
 *    config/app.env, como los demás secretos) y la identidad central: esta
 *    base ADOPTA el companyUuid y el branchUuid en businesses/branches, y la
 *    sucursal local toma el nombre y los datos de la central.
 *  - refrescarIdentidad(): trae los datos vigentes (si el contador editó la
 *    sucursal) y detecta si el equipo fue reemplazado, revocado, o si la
 *    sucursal o la licencia están inactivas.
 *  - latido(): avisa que está en línea y cuántos eventos tiene pendientes
 *    (los paneles lo muestran).
 *
 * Nunca bloquea la venta: todo es en segundo plano y sin Internet solo anota
 * el último error. El token nunca sale de esta PC salvo hacia la Sync API.
 */

const CLAVE_ESTADO = 'multisucursal_enlace';
const ESTADOS = Object.freeze({
  SIN_VINCULAR: 'sin_vincular',
  VINCULADO: 'vinculado',
  REEMPLAZADO: 'reemplazado',
  REVOCADO: 'revocado',
  SUCURSAL_INACTIVA: 'sucursal_inactiva',
  LICENCIA_INACTIVA: 'licencia_inactiva',
});
// Respuestas 403 de la Sync API → estado del enlace. Reemplazado y revocado
// son definitivos (hace falta un código nuevo); los otros dos se revisan solos.
const ESTADO_POR_CODIGO = Object.freeze({
  EQUIPO_REEMPLAZADO: ESTADOS.REEMPLAZADO,
  EQUIPO_REVOCADO: ESTADOS.REVOCADO,
  SUCURSAL_INACTIVA: ESTADOS.SUCURSAL_INACTIVA,
  LICENCIA_INACTIVA: ESTADOS.LICENCIA_INACTIVA,
  EMPRESA_NO_ENCONTRADA: ESTADOS.REVOCADO,
  TOKEN_INVALIDO: ESTADOS.REVOCADO,
});
const DEFINITIVOS = new Set([ESTADOS.REEMPLAZADO, ESTADOS.REVOCADO]);

class ErrorEnlace extends Error {
  constructor(mensaje, codigo, status = 400) {
    super(mensaje);
    this.code = codigo;
    this.statusCode = status;
  }
}

function createEnlaceCentral({
  query,
  identidad,
  bandejas,
  env = process.env,
  persistEnv = () => {},
  fetchImpl = (...args) => fetch(...args),
  now = () => new Date(),
  getEquipo = () => ({}),
  getModo = () => 'normal',
  logger = console,
  timeoutMs = 15000,
}) {
  const url = () => String(env.TECNO_CAJA_SYNC_URL || '').trim().replace(/\/+$/, '');
  const token = () => String(env.TECNO_CAJA_SYNC_TOKEN || '').trim();
  let timers = [];

  async function leerEstado() {
    const rows = await query('SELECT config_value FROM installation_config WHERE config_key = ? LIMIT 1', [CLAVE_ESTADO]).catch(() => []);
    try { return JSON.parse(rows[0]?.config_value || '{}') || {}; } catch (_) { return {}; }
  }

  async function guardarEstado(cambios) {
    const actual = await leerEstado();
    const nuevo = { ...actual, ...cambios };
    const valor = JSON.stringify(nuevo);
    const r = await query('UPDATE installation_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP WHERE config_key = ?', [valor, CLAVE_ESTADO]);
    if (!Number(r?.affectedRows || 0)) {
      await query('INSERT INTO installation_config (config_key, config_value) VALUES (?, ?)', [CLAVE_ESTADO, valor]);
    }
    return nuevo;
  }

  async function llamar(method, ruta, body, { conToken = true } = {}) {
    if (!url()) throw new ErrorEnlace('El servicio central de sucursales no está configurado en esta PC.', 'SIN_CONFIGURAR', 503);
    const controlador = new AbortController();
    const reloj = setTimeout(() => controlador.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${url()}${ruta}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(conToken && token() ? { Authorization: `Bearer ${token()}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controlador.signal,
      });
    } catch (error) {
      throw new ErrorEnlace('Sin conexión con el servicio central de sucursales.', 'SIN_CONEXION', 503);
    } finally {
      clearTimeout(reloj);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ErrorEnlace(data.error || `Error ${res.status} del servicio central.`, data.code || `HTTP_${res.status}`, res.status);
    return data;
  }

  // Esta base pasa a tener la identidad de la central. Primero se suelta el
  // uuid si otra fila local lo tenía (índice único), después se asigna.
  async function adoptarUuid(tabla, id, uuid) {
    if (!id || !uuid) return;
    await query(`UPDATE ${tabla} SET \`uuid\` = NULL WHERE \`uuid\` = ? AND id <> ?`, [uuid, id]);
    await query(`UPDATE ${tabla} SET \`uuid\` = ? WHERE id = ?`, [uuid, id]);
  }

  async function copiarDatosSucursal(branchId, sucursal) {
    if (!branchId || !sucursal) return;
    await query(
      'UPDATE branches SET nombre = ?, direccion = ?, telefono = ?, encargado = ? WHERE id = ?',
      [sucursal.nombre, sucursal.direccion || '', sucursal.telefono || '', sucursal.encargado || '', branchId]
    );
    if (sucursal.codigo) {
      // codigo es único en branches: solo si ninguna otra sucursal local lo usa.
      const otra = await query('SELECT id FROM branches WHERE codigo = ? AND id <> ? LIMIT 1', [sucursal.codigo, branchId]);
      if (!otra.length) await query('UPDATE branches SET codigo = ? WHERE id = ?', [sucursal.codigo, branchId]);
    }
  }

  async function aplicarIdentidad(datos) {
    const local = await identidad.obtener();
    await adoptarUuid('businesses', local.empresa.id, datos.empresa?.companyUuid);
    await adoptarUuid('branches', local.sucursal.id, datos.sucursal?.branchUuid);
    await copiarDatosSucursal(local.sucursal.id, datos.sucursal);
    return local;
  }

  function registrarFalla(error) {
    const estado = ESTADO_POR_CODIGO[error.code];
    return guardarEstado({
      ...(estado ? { estado } : {}),
      ultimoError: { codigo: error.code || null, mensaje: error.message, at: now().toISOString() },
    });
  }

  async function activar(codigo) {
    const limpio = String(codigo || '').trim();
    if (!limpio) throw new ErrorEnlace('Escribe el código de activación.', 'SIN_CODIGO');
    const r = await llamar('POST', '/v1/equipos/activar', { codigo: limpio, equipo: getEquipo() }, { conToken: false });

    // El token primero: si algo de lo local falla, se reintenta con
    // refrescarIdentidad sin gastar otro código.
    env.TECNO_CAJA_SYNC_TOKEN = r.token;
    persistEnv({ TECNO_CAJA_SYNC_TOKEN: r.token });
    await guardarEstado({
      estado: ESTADOS.VINCULADO,
      equipoId: r.equipoId,
      empresa: r.empresa,
      sucursal: r.sucursal,
      activadoEn: now().toISOString(),
      ultimaConexion: now().toISOString(),
      ultimoError: null,
    });
    try {
      await aplicarIdentidad(r);
    } catch (error) {
      logger.warn?.('[multisucursal] Activado, pero no se pudo aplicar la identidad local todavía:', error.message);
    }
    // Primer latido ya: los paneles ven la PC en línea al momento. Si falla,
    // latido() solo anota el error.
    await latido();
    iniciar();
    return estado();
  }

  async function refrescarIdentidad() {
    if (!token()) return estado();
    try {
      const r = await llamar('GET', '/v1/identidad');
      await aplicarIdentidad(r);
      await guardarEstado({
        estado: ESTADOS.VINCULADO,
        empresa: r.empresa,
        sucursal: r.sucursal,
        licencia: r.licencia,
        ultimaConexion: now().toISOString(),
        ultimoError: null,
      });
    } catch (error) {
      await registrarFalla(error);
    }
    return estado();
  }

  async function latido() {
    if (!token()) return estado();
    const actual = await leerEstado();
    if (DEFINITIVOS.has(actual.estado)) return estado();
    try {
      const r = await bandejas.resumen(query).catch(() => null);
      const pendientes = r
        ? { salida: Number(r.salida.pendiente || 0) + Number(r.salida.error || 0), errores: Number(r.salida.rechazado || 0) }
        : { salida: 0, errores: 0 };
      await llamar('POST', '/v1/latido', {
        appVersion: getEquipo().appVersion || '',
        modo: getModo(),
        pendientes,
        ultimaSincronizacion: actual.ultimaConexion || null,
      });
      await guardarEstado({ ultimaConexion: now().toISOString(), ultimoError: null, ...(actual.estado ? {} : { estado: ESTADOS.VINCULADO }) });
    } catch (error) {
      await registrarFalla(error);
    }
    return estado();
  }

  async function desvincular() {
    env.TECNO_CAJA_SYNC_TOKEN = '';
    persistEnv({ TECNO_CAJA_SYNC_TOKEN: '' });
    detener();
    await guardarEstado({ estado: ESTADOS.SIN_VINCULAR, desvinculadoEn: now().toISOString() });
    return estado();
  }

  async function estado() {
    const guardado = await leerEstado();
    const estadoActual = token() ? (guardado.estado || ESTADOS.VINCULADO) : ESTADOS.SIN_VINCULAR;
    return {
      configurado: Boolean(url()),
      tieneToken: Boolean(token()),
      vinculado: estadoActual === ESTADOS.VINCULADO,
      estado: estadoActual,
      equipoId: guardado.equipoId || null,
      empresa: guardado.empresa || null,
      sucursal: guardado.sucursal || null,
      licencia: guardado.licencia || null,
      activadoEn: guardado.activadoEn || null,
      ultimaConexion: guardado.ultimaConexion || null,
      ultimoError: guardado.ultimoError || null,
    };
  }

  function detener() {
    timers.forEach((t) => clearTimeout(t) || clearInterval(t));
    timers = [];
  }

  // Latido cada 5 min e identidad cada 30 min; el primero a los 20 s del
  // arranque. Sin token o sin URL no hace nada.
  function iniciar({ primeraEsperaMs = 20000, latidoMs = 5 * 60 * 1000, identidadMs = 30 * 60 * 1000 } = {}) {
    detener();
    if (!url() || !token()) return false;
    const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };
    timers.push(unref(setTimeout(() => { refrescarIdentidad().then(() => latido()).catch(() => {}); }, primeraEsperaMs)));
    timers.push(unref(setInterval(() => { latido().catch(() => {}); }, latidoMs)));
    timers.push(unref(setInterval(() => { refrescarIdentidad().catch(() => {}); }, identidadMs)));
    return true;
  }

  return { activar, refrescarIdentidad, latido, desvincular, estado, iniciar, detener };
}

module.exports = { createEnlaceCentral, ErrorEnlace, ESTADOS, CLAVE_ESTADO };

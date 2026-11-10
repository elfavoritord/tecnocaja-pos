'use strict';

/**
 * Formatos de envío de datos a la DGII — por ahora el 606 (compras y gastos).
 *
 *   GET  /api/dgii/606?periodo=AAAAMM        revisión: errores, avisos, excluidos, vista previa y estado
 *   GET  /api/dgii/606/txt?periodo=AAAAMM    descarga el TXT (solo sin errores) y lo marca «exportado»
 *   POST /api/dgii/606/presentado            { periodo, constancia, fecha?, notas? } → «presentado_confirmado»
 *   GET  /api/dgii/historial?formato=606     estado de cada período
 *
 * Estados (por formato y período): preparacion (hay errores) → validado (sin
 * errores) → exportado (se descargó el TXT; guarda su huella) →
 * presentado_confirmado (solo con el número de constancia de la Oficina Virtual).
 * Descargar el archivo no es presentarlo: no hay envío automático a la DGII.
 *
 * Permiso: administrador general o «formatos_dgii». El 606 es de todo el RNC,
 * no de una sucursal.
 */

const crypto = require('crypto');
const express = require('express');
const Formato606 = require('../../js/formato-606');
const { crearDatos606 } = require('../services/dgii/datos-606');

function httpError(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

async function ensureSchema(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS dgii_formatos_envio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formato VARCHAR(10) NOT NULL,
      periodo VARCHAR(6) NOT NULL,
      estado VARCHAR(30) NOT NULL DEFAULT 'preparacion',
      cantidad INT NOT NULL DEFAULT 0,
      monto_total DECIMAL(16,2) NOT NULL DEFAULT 0.00,
      itbis_total DECIMAL(16,2) NOT NULL DEFAULT 0.00,
      hash_txt VARCHAR(64) DEFAULT NULL,
      archivo_nombre VARCHAR(80) DEFAULT NULL,
      exportado_at DATETIME DEFAULT NULL,
      exportado_por VARCHAR(120) DEFAULT NULL,
      constancia VARCHAR(120) DEFAULT NULL,
      presentado_fecha DATE DEFAULT NULL,
      presentado_at DATETIME DEFAULT NULL,
      presentado_por VARCHAR(120) DEFAULT NULL,
      notas VARCHAR(255) DEFAULT NULL,
      historial TEXT DEFAULT NULL,
      updated_at DATETIME DEFAULT NULL
    )
  `);
  try {
    await query('CREATE UNIQUE INDEX ux_dgii_formatos_periodo ON dgii_formatos_envio (formato, periodo)');
  } catch (error) {
    const m = String(error?.message || '').toLowerCase();
    if (!m.includes('exist') && !m.includes('duplicate')) throw error;
  }
}

function createFormatosDgiiRouter({
  query, resolveRequestActorUser, userRoleHasPermission, writeAuditLog = async () => {},
  ahora = () => new Date().toISOString().slice(0, 19).replace('T', ' '),
}) {
  const router = express.Router();
  const datos606 = crearDatos606({ query });
  let esquema = null;

  const nombreDe = (actor) => actor?.nombre || actor?.usuario || 'Sistema';
  const esAdminGeneral = (actor) => String(actor?.role_code || actor?.rol || '').trim().toLowerCase() === 'administrador_general';

  router.use(async (req, res, next) => {
    try {
      const actor = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
      if (!esAdminGeneral(actor) && !userRoleHasPermission(actor, 'formatos_dgii')) {
        return res.status(403).json({ error: 'No tienes permiso para los formatos de la DGII.' });
      }
      req.authUser = actor;
      esquema = esquema || ensureSchema(query).catch((e) => { esquema = null; throw e; });
      await esquema;
      next();
    } catch (e) {
      res.status(e.statusCode || 401).json({ error: e.message || 'Sesión inválida o expirada.' });
    }
  });

  const periodoDe = (req) => {
    const periodo = String(req.query?.periodo || req.body?.periodo || '').replace(/\D/g, '');
    if (!Formato606.periodoValido(periodo)) throw httpError('Indica el mes (AAAAMM).');
    return periodo;
  };

  async function registro(formato, periodo) {
    const [fila] = await query('SELECT * FROM dgii_formatos_envio WHERE formato = ? AND periodo = ? LIMIT 1', [formato, periodo]);
    return fila || null;
  }

  async function guardar(formato, periodo, cambios, evento) {
    const actual = await registro(formato, periodo);
    const historial = (() => { try { return JSON.parse(actual?.historial || '[]'); } catch (_) { return []; } })();
    if (evento) historial.push({ ...evento, at: ahora() });
    const fila = { ...(actual || {}), ...cambios, historial: JSON.stringify(historial.slice(-50)), updated_at: ahora() };
    const cols = ['estado', 'cantidad', 'monto_total', 'itbis_total', 'hash_txt', 'archivo_nombre', 'exportado_at', 'exportado_por',
      'constancia', 'presentado_fecha', 'presentado_at', 'presentado_por', 'notas', 'historial', 'updated_at'];
    if (actual) {
      await query(`UPDATE dgii_formatos_envio SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => fila[c] ?? null), actual.id]);
    } else {
      try {
        await query(`INSERT INTO dgii_formatos_envio (formato, periodo, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`,
          [formato, periodo, ...cols.map((c) => fila[c] ?? null)]);
      } catch (error) {
        // Dos revisiones a la vez: la otra ya creó la fila.
        if (!/unique|duplicate/i.test(String(error?.message || ''))) throw error;
        return guardar(formato, periodo, cambios, null);
      }
    }
    return registro(formato, periodo);
  }

  const vistaEstado = (fila, hashActual) => (fila ? {
    estado: fila.estado, cantidad: Number(fila.cantidad || 0), archivo: fila.archivo_nombre,
    exportadoAt: fila.exportado_at, exportadoPor: fila.exportado_por, constancia: fila.constancia,
    presentadoFecha: fila.presentado_fecha, presentadoAt: fila.presentado_at, presentadoPor: fila.presentado_por,
    cambioDesdeExportacion: Boolean(fila.hash_txt && hashActual && fila.hash_txt !== hashActual),
    historial: (() => { try { return JSON.parse(fila.historial || '[]'); } catch (_) { return []; } })(),
  } : { estado: 'preparacion', historial: [] });

  async function revisar606(periodo) {
    const [cfg] = await query('SELECT rnc, business_name FROM config LIMIT 1');
    const datos = await datos606.leer(periodo);
    const resultado = Formato606.construir({ rncInformante: cfg?.rnc, periodo, registros: datos.registros });
    const hash = resultado.txt ? crypto.createHash('sha256').update(resultado.txt).digest('hex') : null;
    return { cfg: cfg || {}, datos, resultado, hash };
  }

  router.get('/606', async (req, res) => {
    try {
      const periodo = periodoDe(req);
      const { cfg, datos, resultado, hash } = await revisar606(periodo);
      let fila = await registro('606', periodo);
      // Revisar no cambia lo ya exportado o presentado: solo dice si los datos cambiaron.
      if (!fila || ['preparacion', 'validado'].includes(fila.estado)) {
        const estado = resultado.ok ? 'validado' : 'preparacion';
        if (!fila || fila.estado !== estado || Number(fila.cantidad) !== resultado.resumen.cantidad) {
          fila = await guardar('606', periodo, {
            estado, cantidad: resultado.resumen.cantidad, monto_total: resultado.resumen.montoFacturado, itbis_total: resultado.resumen.itbisFacturado,
          }, { accion: estado === 'validado' ? 'Validado sin errores' : `Con ${resultado.errores.length} error(es)`, usuario: nombreDe(req.authUser) });
        }
      }
      res.json({
        formato: '606', periodo, negocio: cfg.business_name || '', rncInformante: resultado.rncInformante,
        nombreArchivo: resultado.nombreArchivo, ok: resultado.ok, sinRegistros: resultado.sinRegistros,
        resumen: resultado.resumen, errores: resultado.errores, avisos: [...datos.avisos, ...resultado.avisos],
        excluidos: datos.excluidos, encabezados: Formato606.ENCABEZADOS,
        filas: resultado.filas.slice(0, 1000).map((f) => ({ fila: f.fila, origen: f.origen, referencia: f.referencia, campos: f.campos })),
        estado: vistaEstado(fila, hash),
      });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  router.get('/606/txt', async (req, res) => {
    try {
      const periodo = periodoDe(req);
      const { resultado, hash } = await revisar606(periodo);
      if (!resultado.ok) {
        return res.status(422).json({ error: resultado.sinRegistros ? 'No hay compras ni gastos con comprobante en ese mes.' : 'Corrige los errores antes de descargar el TXT.', errores: resultado.errores });
      }
      const antes = await registro('606', periodo);
      const rectifica = antes?.estado === 'presentado_confirmado' && antes.hash_txt !== hash;
      await guardar('606', periodo, {
        estado: antes?.estado === 'presentado_confirmado' && antes.hash_txt === hash ? 'presentado_confirmado' : 'exportado',
        cantidad: resultado.resumen.cantidad, monto_total: resultado.resumen.montoFacturado, itbis_total: resultado.resumen.itbisFacturado,
        hash_txt: hash, archivo_nombre: resultado.nombreArchivo, exportado_at: ahora(), exportado_por: nombreDe(req.authUser),
        ...(rectifica ? { constancia: null, presentado_fecha: null, presentado_at: null, presentado_por: null } : {}),
      }, { accion: rectifica ? 'Exportado de nuevo con cambios (rectificación: falta su constancia)' : 'TXT exportado', usuario: nombreDe(req.authUser), hash, cantidad: resultado.resumen.cantidad });
      await Promise.resolve(writeAuditLog({
        userId: req.authUser.id, userName: nombreDe(req.authUser), userRole: String(req.authUser.role_code || req.authUser.rol || ''),
        moduleName: 'Formatos DGII', actionName: 'Formato 606 exportado',
        detail: `${periodo} · ${resultado.resumen.cantidad} registro(s) · RD$ ${resultado.resumen.montoFacturado} · ${hash.slice(0, 12)}`,
      })).catch(() => {});
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${resultado.nombreArchivo}"`);
      res.send(resultado.txt);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  router.post('/606/presentado', async (req, res) => {
    try {
      const periodo = periodoDe(req);
      const constancia = String(req.body?.constancia || '').trim().slice(0, 120);
      if (constancia.length < 4) throw httpError('Escribe el número de constancia o de recepción que da la Oficina Virtual de la DGII.');
      const fila = await registro('606', periodo);
      if (!fila || !['exportado', 'presentado_confirmado'].includes(fila.estado) || !fila.hash_txt) {
        throw httpError('Primero descarga el TXT de ese mes: solo se registra la constancia del archivo que exportaste.', 409);
      }
      const fecha = String(req.body?.fecha || '').slice(0, 10);
      const actualizado = await guardar('606', periodo, {
        estado: 'presentado_confirmado', constancia, presentado_fecha: /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : ahora().slice(0, 10),
        presentado_at: ahora(), presentado_por: nombreDe(req.authUser), notas: String(req.body?.notas || '').slice(0, 255) || fila.notas || null,
      }, { accion: `Presentado en la DGII · constancia ${constancia}`, usuario: nombreDe(req.authUser), hash: fila.hash_txt });
      await Promise.resolve(writeAuditLog({
        userId: req.authUser.id, userName: nombreDe(req.authUser), userRole: String(req.authUser.role_code || req.authUser.rol || ''),
        moduleName: 'Formatos DGII', actionName: 'Formato 606 presentado', detail: `${periodo} · constancia ${constancia}`,
      })).catch(() => {});
      res.json({ ok: true, estado: vistaEstado(actualizado, actualizado.hash_txt) });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  router.get('/historial', async (req, res) => {
    try {
      const formato = String(req.query?.formato || '606').replace(/\D/g, '') || '606';
      const filas = await query('SELECT * FROM dgii_formatos_envio WHERE formato = ? ORDER BY periodo DESC LIMIT 36', [formato]);
      res.json(filas.map((f) => ({ periodo: f.periodo, ...vistaEstado(f, null) })));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createFormatosDgiiRouter, ensureSchema };

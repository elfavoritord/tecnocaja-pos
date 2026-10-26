'use strict';

/**
 * server/multisucursal/ncf-central.js — Rangos NCF que la central asigna a
 * ESTA sucursal (Fase 7).
 *
 * La central reparte la autorización de la DGII en sub-rangos que no se
 * cruzan entre sucursales. Aquí se aplica cada rango sobre el sistema de
 * secuencias que ya usa esta PC, sin tocar cómo se consume el número en la
 * venta (getNextNcf, con su bloqueo):
 *   - secuencias autorizadas (ncf_authorized_sequences, si está activado), o
 *   - el sistema anterior (ncf_sequences), o
 *   - para los e-NCF (serie E), las secuencias de producción de la factura
 *     electrónica (ecf_sequences con environment 'ecf'; modules/ecf). El
 *     número lo sigue sacando generateNextENCF, con su bloqueo.
 *
 * Reglas:
 *   - Un rango por tipo a la vez. Cuando se agota, se activa el siguiente que
 *     esté en espera (en el siguiente ciclo de sincronización).
 *   - Al activar el primero de la central, las demás secuencias activas de
 *     ese tipo en esta base se suspenden: la central pasa a ser la única que
 *     da números a esta sucursal.
 *   - Si esta base ya emitió un número de ese rango, se rechaza y se avisa a
 *     la central (nunca se reutiliza un NCF).
 * Cada cambio de estado sube a la central como evento 'ncf_rango'.
 */

const crypto = require('crypto');

const NOMBRES = {
  B01: 'Crédito Fiscal', B02: 'Consumidor Final', B03: 'Nota de Débito', B04: 'Nota de Crédito',
  B11: 'Comprobante de Compras', B12: 'Registro Único de Ingresos', B13: 'Gastos Menores',
  B14: 'Régimen Especial', B15: 'Gubernamental', B16: 'Comprobante para Exportaciones',
  B17: 'Comprobante para Pagos al Exterior',
};
const NOTA = 'Asignado por la central (Tecno Caja multisucursal)';

function esElectronico(tipo) {
  return String(tipo || '').toUpperCase().startsWith('E');
}

// ncf_rangos_central guarda desde/hasta en INT.
const MAXIMO_LOCAL = 2147483647;

// 'AAAA-MM-DD' (la columna DATE llega como Date o como texto según el motor).
function fechaTexto(valor) {
  if (!valor) return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    return `${valor.getFullYear()}-${String(valor.getMonth() + 1).padStart(2, '0')}-${String(valor.getDate()).padStart(2, '0')}`;
  }
  const m = String(valor).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function createNcfCentral({
  query, withTransaction, bandejas, identidad, now = () => new Date(), auditar = async () => {}, logger = console,
  randomUUID = () => crypto.randomUUID(),
}) {
  async function tablaExiste(nombre) {
    const r = await query(`SELECT 1 FROM ${nombre} LIMIT 1`).then(() => true, () => false);
    return r;
  }

  async function sistemaEnUso() {
    const cfg = await query('SELECT ncf_authorized_sequences_v2_enabled AS v2 FROM config WHERE id = 1 LIMIT 1').catch(() => []);
    return Number(cfg[0]?.v2 || 0) ? 'v2' : 'legado';
  }

  async function eventoEstado(executor, rango, estado, extra = {}) {
    const ident = await identidad.obtener();
    await bandejas.registrarSalida(executor, {
      companyUuid: ident.empresa.uuid,
      branchUuid: ident.sucursal.uuid,
      entityType: 'ncf_rango',
      entityUuid: rango.rango_uuid,
      operation: 'estado',
      payload: { rangoUuid: rango.rango_uuid, estado, ...extra },
    });
  }

  // Último número de ese tipo que esta base ya emitió (los NCF tienen el mismo
  // largo, así que el orden de texto es el numérico). Un e-NCF cuenta solo si
  // salió en producción: los de las pruebas de certificación no son reales.
  async function ultimoEmitido(executor, tipo) {
    if (esElectronico(tipo)) {
      const docs = await executor.query(
        "SELECT encf FROM ecf_documents WHERE environment = 'ecf' AND tipo_ecf = ? AND encf IS NOT NULL ORDER BY encf DESC LIMIT 1",
        [tipo]
      ).catch(() => []);
      const e = Number(String(docs[0]?.encf || '').slice(3));
      return Number.isFinite(e) ? e : 0;
    }
    const rows = await executor.query(
      "SELECT ncf FROM sales WHERE ncf LIKE ? AND ncf IS NOT NULL ORDER BY ncf DESC LIMIT 1",
      [`${tipo}%`]
    ).catch(() => []);
    const n = Number(String(rows[0]?.ncf || '').slice(3));
    return Number.isFinite(n) ? n : 0;
  }

  // Lo que llega de la central (stream 'ncf'). Idempotente.
  async function registrar(item) {
    const ahora = now().toISOString();
    const filas = await query('SELECT rango_uuid, estado FROM ncf_rangos_central WHERE rango_uuid = ? LIMIT 1', [item.rangoUuid]);
    if (!filas.length) {
      if (item.estado === 'anulado') return 'ignorado';
      await query(
        `INSERT INTO ncf_rangos_central (rango_uuid, tipo, desde, hasta, vence, autorizacion, estado, recibido_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, 'en_espera', ?)`,
        [item.rangoUuid, item.tipo, Number(item.desde), Number(item.hasta), item.vence || null, item.autorizacion || null, ahora]
      );
      await withTransaction(async (conn) => eventoEstado(conn, { rango_uuid: item.rangoUuid }, 'en_espera'));
      return 'registrado';
    }
    if (item.estado === 'anulado' && filas[0].estado === 'en_espera') {
      await withTransaction(async (conn) => {
        await conn.query("UPDATE ncf_rangos_central SET estado = 'anulado', actualizado_at_utc = ? WHERE rango_uuid = ?", [ahora, item.rangoUuid]);
        await eventoEstado(conn, filas[0], 'anulado');
      });
      return 'anulado';
    }
    return 'sin_cambios';
  }

  async function secuenciaLocal(executor, rango) {
    if (!rango.secuencia_local_id) return null;
    if (rango.sistema === 'ecf') {
      const rows = await executor.query(
        'SELECT proximo_numero AS siguiente, numero_final AS hasta, activo FROM ecf_sequences WHERE id = ? LIMIT 1',
        [rango.secuencia_local_id]
      );
      const s = rows[0];
      return s ? { siguiente: Number(s.siguiente), hasta: Number(s.hasta), activa: Number(s.activo) === 1 } : null;
    }
    if (rango.sistema === 'v2') {
      const rows = await executor.query(
        'SELECT next_number AS siguiente, end_number AS hasta, status, deleted_at FROM ncf_authorized_sequences WHERE id = ? LIMIT 1',
        [rango.secuencia_local_id]
      );
      const s = rows[0];
      return s ? { siguiente: Number(s.siguiente), hasta: Number(s.hasta), activa: s.status === 'activo' && !s.deleted_at } : null;
    }
    const rows = await executor.query(
      'SELECT siguiente_numero AS siguiente, maximo AS hasta, activa FROM ncf_sequences WHERE id = ? LIMIT 1',
      [rango.secuencia_local_id]
    );
    const s = rows[0];
    return s ? { siguiente: Number(s.siguiente), hasta: Number(s.hasta), activa: Number(s.activa) === 1 } : null;
  }

  // e-NCF: el rango de la central pasa a ser la única secuencia de producción
  // de ese tipo en esta base (las que se cargaron a mano se desactivan, igual
  // que con los B). Va sin sucursal ni caja: toda esta base es una sucursal
  // de la central. business_id 1, como todo el módulo e-CF.
  async function activarElectronico(rango) {
    const listo = await query('SELECT environment, authorization_reference FROM ecf_sequences LIMIT 1').then(() => true, () => false);
    if (!listo) {
      return { activado: false, motivo: 'La facturación electrónica todavía no está preparada en esta PC (abre Facturación Electrónica una vez).' };
    }
    return withTransaction(async (conn) => {
      const ahora = now().toISOString();
      const ultimo = await ultimoEmitido(conn, rango.tipo);
      if (ultimo >= Number(rango.desde)) {
        const motivo = `Esta sucursal ya emitió el ${rango.tipo}${String(ultimo).padStart(10, '0')}, dentro de ese rango. Asigna otro.`;
        await conn.query("UPDATE ncf_rangos_central SET estado = 'rechazado', motivo = ?, actualizado_at_utc = ? WHERE rango_uuid = ?", [motivo, ahora, rango.rango_uuid]);
        await eventoEstado(conn, rango, 'rechazado', { motivo });
        return { activado: false, motivo };
      }
      await conn.query(
        "UPDATE ecf_sequences SET activo = 0, updated_at = CURRENT_TIMESTAMP WHERE tipo_comprobante = ? AND environment = 'ecf' AND activo = 1",
        [rango.tipo]
      );
      const r = await conn.query(
        `INSERT INTO ecf_sequences
           (business_id, branch_id, cash_register_id, tipo_comprobante, numero_inicial, numero_final, proximo_numero,
            fecha_autorizacion, fecha_vencimiento, environment, authorization_reference, activo, created_at, updated_at)
         VALUES (1, NULL, NULL, ?, ?, ?, ?, NULL, ?, 'ecf', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [rango.tipo, Number(rango.desde), Number(rango.hasta), Number(rango.desde), rango.vence || null, rango.autorizacion || null]
      );
      await conn.query(
        "UPDATE ncf_rangos_central SET estado = 'en_uso', sistema = 'ecf', secuencia_local_id = ?, motivo = NULL, actualizado_at_utc = ? WHERE rango_uuid = ?",
        [r.insertId, ahora, rango.rango_uuid]
      );
      await eventoEstado(conn, rango, 'en_uso', { siguiente: Number(rango.desde) });
      return { activado: true, sistema: 'ecf', secuenciaId: r.insertId };
    });
  }

  async function activar(rango) {
    if (esElectronico(rango.tipo)) return activarElectronico(rango);
    const ident = await identidad.obtener();
    const sistema = await sistemaEnUso();
    if (!(await tablaExiste(sistema === 'v2' ? 'ncf_authorized_sequences' : 'ncf_sequences'))) {
      return { activado: false, motivo: 'La tabla de secuencias NCF todavía no existe (abre Comprobantes fiscales una vez).' };
    }
    return withTransaction(async (conn) => {
      const ahora = now().toISOString();
      const ultimo = await ultimoEmitido(conn, rango.tipo);
      if (ultimo >= Number(rango.desde)) {
        const motivo = `Esta sucursal ya emitió el ${rango.tipo}${String(ultimo).padStart(8, '0')}, dentro de ese rango. Asigna otro.`;
        await conn.query("UPDATE ncf_rangos_central SET estado = 'rechazado', motivo = ?, actualizado_at_utc = ? WHERE rango_uuid = ?", [motivo, ahora, rango.rango_uuid]);
        await eventoEstado(conn, rango, 'rechazado', { motivo });
        return { activado: false, motivo };
      }
      let secuenciaId;
      if (sistema === 'v2') {
        await conn.query(
          `UPDATE ncf_authorized_sequences SET status = 'suspendido', notes = ?
            WHERE document_type = ? AND status = 'activo' AND deleted_at IS NULL`,
          [`Suspendida: la central asignó el rango ${rango.desde}-${rango.hasta}`, rango.tipo]
        );
        const r = await conn.query(
          `INSERT INTO ncf_authorized_sequences
             (business_id, branch_id, series, document_type, document_name, prefix, start_number, end_number, next_number,
              expiration_date, authorization_reference, environment, status, notes)
           VALUES (?, ?, 'B', ?, ?, ?, ?, ?, ?, ?, ?, 'ncf', 'activo', ?)`,
          [
            ident.empresa.id || 1, ident.sucursal.id || null, rango.tipo, NOMBRES[rango.tipo] || rango.tipo, rango.tipo,
            Number(rango.desde), Number(rango.hasta), Number(rango.desde), rango.vence || null, rango.autorizacion || null, NOTA,
          ]
        );
        secuenciaId = r.insertId;
      } else {
        await conn.query('UPDATE ncf_sequences SET activa = 0 WHERE ncf_type = ? AND activa = 1', [rango.tipo]);
        const r = await conn.query(
          `INSERT INTO ncf_sequences (business_id, branch_id, ncf_type, siguiente_numero, maximo, activa, fecha_vencimiento)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
          [ident.empresa.id || 1, ident.sucursal.id || null, rango.tipo, Number(rango.desde), Number(rango.hasta), rango.vence || null]
        );
        secuenciaId = r.insertId;
      }
      await conn.query(
        "UPDATE ncf_rangos_central SET estado = 'en_uso', sistema = ?, secuencia_local_id = ?, motivo = NULL, actualizado_at_utc = ? WHERE rango_uuid = ?",
        [sistema, secuenciaId, ahora, rango.rango_uuid]
      );
      await eventoEstado(conn, rango, 'en_uso', { siguiente: Number(rango.desde) });
      return { activado: true, sistema, secuenciaId };
    });
  }

  // Una PC que ya facturaba e-CF antes de enlazarse tiene rangos de producción
  // (cargados a mano o del archivo de la DGII) que la central no conoce. Se
  // le avisan para que los deje a nombre de esta sucursal y no le dé esos
  // números a otra. Aquí quedan en uso (o agotados) y ligados a su secuencia:
  // cuando la central los devuelve por el stream 'ncf', registrar() ya los
  // tiene, y uno nuevo de la central espera a que se agoten (ajustar()).
  async function reportarLocales() {
    const filas = await query(
      `SELECT s.id, s.tipo_comprobante, s.numero_inicial, s.numero_final, s.proximo_numero, s.activo,
              s.fecha_vencimiento, s.authorization_reference
         FROM ecf_sequences s
        WHERE s.environment = 'ecf'
          AND NOT EXISTS (SELECT 1 FROM ncf_rangos_central r WHERE r.sistema = 'ecf' AND r.secuencia_local_id = s.id)
        ORDER BY s.id`
    ).catch(() => []); // sin factura electrónica en esta PC no hay nada que avisar
    const reportados = [];
    for (const s of filas) {
      const desde = Number(s.numero_inicial);
      const hasta = Number(s.numero_final);
      const siguiente = Number(s.proximo_numero);
      const activa = Number(s.activo) === 1;
      if (!activa && siguiente <= desde) continue; // nunca dio un número
      if (hasta > MAXIMO_LOCAL) {
        logger.warn?.(`[multisucursal] El rango ${s.tipo_comprobante} ${desde}-${hasta} no se avisa a la central: pasa de ${MAXIMO_LOCAL}.`);
        continue;
      }
      const rango = {
        rango_uuid: randomUUID(),
        tipo: String(s.tipo_comprobante).toUpperCase(),
        estado: activa && siguiente <= hasta ? 'en_uso' : 'agotado',
      };
      const ident = await identidad.obtener();
      await withTransaction(async (conn) => {
        await conn.query(
          `INSERT INTO ncf_rangos_central (rango_uuid, tipo, desde, hasta, vence, autorizacion, estado, sistema, secuencia_local_id, motivo, recibido_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ecf', ?, ?, ?)`,
          [rango.rango_uuid, rango.tipo, desde, hasta, fechaTexto(s.fecha_vencimiento), s.authorization_reference || null,
            rango.estado, s.id, 'Ya estaba en esta PC al enlazarse: avisado a la central.', now().toISOString()]
        );
        await bandejas.registrarSalida(conn, {
          companyUuid: ident.empresa.uuid,
          branchUuid: ident.sucursal.uuid,
          entityType: 'ncf_rango',
          entityUuid: rango.rango_uuid,
          operation: 'reportar',
          payload: {
            rangoUuid: rango.rango_uuid, tipo: rango.tipo, desde, hasta, vence: fechaTexto(s.fecha_vencimiento),
            autorizacion: s.authorization_reference || null, estado: rango.estado, siguiente,
          },
        });
      });
      reportados.push(rango.rango_uuid);
    }
    return reportados;
  }

  // Un rango por tipo: si el que está en uso se agotó (o se desactivó en esta
  // base), se pasa al siguiente en espera.
  async function ajustar() {
    const rangos = await query("SELECT * FROM ncf_rangos_central WHERE estado IN ('en_uso', 'en_espera') ORDER BY tipo, desde");
    const tipos = [...new Set(rangos.map((r) => r.tipo))];
    const resultado = { activados: [], agotados: [], rechazados: [] };
    for (const tipo of tipos) {
      const enUso = rangos.find((r) => r.tipo === tipo && r.estado === 'en_uso');
      if (enUso) {
        const s = await secuenciaLocal({ query }, enUso);
        const agotado = !s || s.siguiente > s.hasta || !s.activa;
        if (!agotado) continue;
        await withTransaction(async (conn) => {
          await conn.query("UPDATE ncf_rangos_central SET estado = 'agotado', actualizado_at_utc = ? WHERE rango_uuid = ?", [now().toISOString(), enUso.rango_uuid]);
          await eventoEstado(conn, enUso, 'agotado', { siguiente: s ? s.siguiente : null });
        });
        resultado.agotados.push(enUso.rango_uuid);
      }
      for (const espera of rangos.filter((r) => r.tipo === tipo && r.estado === 'en_espera')) {
        const r = await activar(espera);
        if (r.activado) {
          resultado.activados.push(espera.rango_uuid);
          await auditar('Rango NCF de la central activado', `${tipo} ${espera.desde}-${espera.hasta}`).catch(() => {});
          break;
        }
        if (r.motivo) resultado.rechazados.push(espera.rango_uuid);
      }
    }
    return resultado;
  }

  // Para el latido: hasta qué número va cada rango en uso.
  async function usoParaLatido() {
    const rangos = await query("SELECT * FROM ncf_rangos_central WHERE estado = 'en_uso'").catch(() => []);
    const uso = [];
    for (const r of rangos) {
      const s = await secuenciaLocal({ query }, r).catch(() => null);
      if (s) uso.push({ rangoUuid: r.rango_uuid, siguiente: s.siguiente });
    }
    return uso;
  }

  async function listar() {
    const rangos = await query('SELECT * FROM ncf_rangos_central ORDER BY tipo, desde').catch(() => []);
    const salida = [];
    for (const r of rangos) {
      const s = r.estado === 'en_uso' ? await secuenciaLocal({ query }, r).catch(() => null) : null;
      salida.push({
        rangoUuid: r.rango_uuid,
        tipo: r.tipo,
        desde: Number(r.desde),
        hasta: Number(r.hasta),
        vence: r.vence || null,
        estado: r.estado,
        sistema: r.sistema || null,
        siguiente: s ? s.siguiente : null,
        disponibles: s ? Math.max(0, s.hasta - s.siguiente + 1) : null,
        motivo: r.motivo || null,
      });
    }
    return salida;
  }

  return { registrar, reportarLocales, ajustar, activar, usoParaLatido, listar, sistemaEnUso, logger };
}

module.exports = { createNcfCentral };

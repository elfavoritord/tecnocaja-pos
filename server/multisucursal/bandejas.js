'use strict';

/**
 * server/multisucursal/bandejas.js — Bandeja de salida (sync_outbox) y de
 * entrada (sync_inbox) de la sincronización entre sucursales.
 *
 * Salida: registrarSalida() se llama DENTRO de la transacción de la operación
 * (venta, ajuste…) con el mismo `executor`: si la transacción se revierte, el
 * evento tampoco existe; si se confirma, el evento ya está en disco aunque se
 * corte la luz un instante después. Un evento solo pasa a 'sincronizado'
 * cuando la nube lo confirma (confirmar()).
 *
 * Entrada: registrarEntrada() es la puerta de idempotencia. El event_id es la
 * llave primaria: el mismo evento recibido dos veces devuelve 'duplicado' y no
 * se vuelve a aplicar.
 *
 * Estados de salida: pendiente → sincronizado | error (se reintenta con espera
 * creciente) | rechazado (la nube lo rechazó por datos: no se reintenta solo).
 */

const crypto = require('crypto');

const ESTADOS_SALIDA = Object.freeze({
  PENDIENTE: 'pendiente',
  SINCRONIZADO: 'sincronizado',
  ERROR: 'error',
  RECHAZADO: 'rechazado',
});

const ESTADOS_ENTRADA = Object.freeze({
  RECIBIDO: 'recibido',
  APLICADO: 'aplicado',
  RECHAZADO: 'rechazado',
  ERROR: 'error',
});

const ESPERA_BASE_MS = 30 * 1000;
const ESPERA_MAXIMA_MS = 60 * 60 * 1000;
const PAYLOAD_MAXIMO_BYTES = 512 * 1024;

// 30 s, 1 min, 2 min, 4 min… hasta 1 h, con ±20 % de variación para que
// varias sucursales que vuelven a tener Internet a la vez no reintenten juntas.
function calcularEsperaMs(intentos, aleatorio = Math.random) {
  const n = Math.max(1, Number(intentos || 1));
  const base = Math.min(ESPERA_MAXIMA_MS, ESPERA_BASE_MS * 2 ** (n - 1));
  const variacion = base * 0.2 * (aleatorio() * 2 - 1);
  return Math.max(1000, Math.round(base + variacion));
}

function texto(valor, max) {
  return String(valor == null ? '' : valor).slice(0, max);
}

function createBandejas({
  dialect = 'sqlite',
  randomUUID = () => crypto.randomUUID(),
  now = () => new Date(),
  aleatorio = Math.random,
} = {}) {
  const insertIgnore = dialect === 'mysql' ? 'INSERT IGNORE INTO' : 'INSERT OR IGNORE INTO';

  function runner(executor) {
    if (typeof executor === 'function') return executor;
    if (executor && typeof executor.query === 'function') return executor.query.bind(executor);
    throw new Error('Se necesita el executor de la transacción (query o conn).');
  }

  async function registrarSalida(executor, evento) {
    const q = runner(executor);
    const {
      companyUuid = null,
      branchUuid = null,
      entityType,
      entityUuid,
      operation,
      version = 1,
      payload = {},
    } = evento || {};
    if (!entityType || !entityUuid || !operation) {
      throw new Error('Evento incompleto: faltan entityType, entityUuid u operation.');
    }
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, 'utf8') > PAYLOAD_MAXIMO_BYTES) {
      throw new Error(`El evento ${entityType} supera ${PAYLOAD_MAXIMO_BYTES} bytes.`);
    }
    const eventId = randomUUID();
    await q(
      `INSERT INTO sync_outbox
         (event_id, company_uuid, branch_uuid, entity_type, entity_uuid, operation, entity_version, payload, created_at_utc, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId, companyUuid, branchUuid, texto(entityType, 40), texto(entityUuid, 36), texto(operation, 20),
        Math.max(1, Number(version) || 1), json, now().toISOString(), ESTADOS_SALIDA.PENDIENTE,
      ]
    );
    return eventId;
  }

  // Lo que toca enviar ahora: pendientes y errores cuya espera ya venció, en
  // el orden en que ocurrieron.
  async function pendientes(executor, { limite = 50 } = {}) {
    const q = runner(executor);
    const ahora = now().toISOString();
    const max = Math.max(1, Math.min(500, Number(limite) || 50));
    const rows = await q(
      `SELECT id, event_id, company_uuid, branch_uuid, entity_type, entity_uuid, operation,
              entity_version, payload, created_at_utc, status, attempts
         FROM sync_outbox
        WHERE status IN (?, ?)
          AND (next_attempt_at_utc IS NULL OR next_attempt_at_utc <= ?)
        ORDER BY id
        LIMIT ${max}`,
      [ESTADOS_SALIDA.PENDIENTE, ESTADOS_SALIDA.ERROR, ahora]
    );
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload || '{}') }));
  }

  async function confirmar(executor, eventIds = []) {
    const q = runner(executor);
    const ids = [...new Set(eventIds.filter(Boolean))];
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    const r = await q(
      `UPDATE sync_outbox SET status = ?, acked_at_utc = ?, last_error = NULL, next_attempt_at_utc = NULL
        WHERE event_id IN (${placeholders}) AND status <> ?`,
      [ESTADOS_SALIDA.SINCRONIZADO, now().toISOString(), ...ids, ESTADOS_SALIDA.SINCRONIZADO]
    );
    return Number(r?.affectedRows || 0);
  }

  // Error de red o del servidor: se reintenta solo. `rechazado`: la nube dijo
  // que el evento es inválido (otra empresa, datos rotos); queda para revisión.
  async function marcarError(executor, eventId, mensaje, { rechazado = false } = {}) {
    const q = runner(executor);
    const rows = await q('SELECT attempts FROM sync_outbox WHERE event_id = ? LIMIT 1', [eventId]);
    if (!rows.length) return null;
    const intentos = Number(rows[0].attempts || 0) + 1;
    const siguiente = rechazado ? null : new Date(now().getTime() + calcularEsperaMs(intentos, aleatorio)).toISOString();
    await q(
      `UPDATE sync_outbox SET status = ?, attempts = ?, last_error = ?, next_attempt_at_utc = ?
        WHERE event_id = ? AND status <> ?`,
      [
        rechazado ? ESTADOS_SALIDA.RECHAZADO : ESTADOS_SALIDA.ERROR,
        intentos, texto(mensaje, 1000), siguiente, eventId, ESTADOS_SALIDA.SINCRONIZADO,
      ]
    );
    return { intentos, siguienteIntento: siguiente };
  }

  // Devuelve 'nuevo' la primera vez y 'duplicado' si ese event_id ya llegó.
  async function registrarEntrada(executor, evento) {
    const q = runner(executor);
    const r = await q(
      `${insertIgnore} sync_inbox
         (event_id, company_uuid, origin_branch_uuid, entity_type, entity_uuid, entity_version, status, received_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        evento.eventId, evento.companyUuid, evento.branchUuid || null, texto(evento.entityType, 40),
        texto(evento.entityUuid, 36), Math.max(1, Number(evento.version) || 1), ESTADOS_ENTRADA.RECIBIDO,
        now().toISOString(),
      ]
    );
    return Number(r?.affectedRows || 0) > 0 ? 'nuevo' : 'duplicado';
  }

  async function marcarEntrada(executor, eventId, estado, error = null) {
    if (!Object.values(ESTADOS_ENTRADA).includes(estado)) throw new Error(`Estado de entrada inválido: ${estado}`);
    const q = runner(executor);
    await q(
      'UPDATE sync_inbox SET status = ?, error = ?, applied_at_utc = ? WHERE event_id = ?',
      [estado, error ? texto(error, 1000) : null, estado === ESTADOS_ENTRADA.APLICADO ? now().toISOString() : null, eventId]
    );
  }

  async function leerCursor(executor, stream) {
    const q = runner(executor);
    const rows = await q('SELECT cursor_value FROM sync_cursors WHERE stream = ? LIMIT 1', [texto(stream, 60)]);
    return rows[0]?.cursor_value ?? null;
  }

  async function guardarCursor(executor, stream, valor) {
    const q = runner(executor);
    const ahora = now().toISOString();
    const r = await q('UPDATE sync_cursors SET cursor_value = ?, updated_at_utc = ? WHERE stream = ?', [
      valor == null ? null : texto(valor, 120), ahora, texto(stream, 60),
    ]);
    if (!Number(r?.affectedRows || 0)) {
      await q(`${insertIgnore} sync_cursors (stream, cursor_value, updated_at_utc) VALUES (?, ?, ?)`, [
        texto(stream, 60), valor == null ? null : texto(valor, 120), ahora,
      ]);
    }
  }

  async function resumen(executor) {
    const q = runner(executor);
    const porEstado = await q('SELECT status, COUNT(*) AS n FROM sync_outbox GROUP BY status');
    const masViejo = await q(
      'SELECT MIN(created_at_utc) AS desde FROM sync_outbox WHERE status IN (?, ?)',
      [ESTADOS_SALIDA.PENDIENTE, ESTADOS_SALIDA.ERROR]
    );
    const conteo = Object.fromEntries(Object.values(ESTADOS_SALIDA).map((estado) => [estado, 0]));
    for (const row of porEstado) conteo[row.status] = Number(row.n || 0);
    return {
      salida: conteo,
      pendienteDesde: masViejo[0]?.desde || null,
    };
  }

  return {
    registrarSalida,
    pendientes,
    confirmar,
    marcarError,
    registrarEntrada,
    marcarEntrada,
    leerCursor,
    guardarCursor,
    resumen,
  };
}

module.exports = {
  createBandejas,
  calcularEsperaMs,
  ESTADOS_SALIDA,
  ESTADOS_ENTRADA,
  PAYLOAD_MAXIMO_BYTES,
};

'use strict';

/**
 * trial-window.js — La prueba dura SIEMPRE 30 días desde su inicio.
 *
 * config.trial_started_at / trial_ends_at se guardan como DATETIME "naive" en
 * UTC (toISOString() sin la Z). SQLite los devuelve como texto, pero mysql2
 * los devuelve como Date interpretando ese texto como hora LOCAL: en RD
 * (UTC-4) cada lectura + escritura le sumaba 4 horas al vencimiento, y como
 * eso pasa varias veces por arranque (y en cada venta, vía el listener de
 * licencia) la prueba "crecía" un día por reinicio. Además, cuando el valor
 * inflado pasaba de 35 días se recortaba a "ahora + 30", así que la prueba
 * nunca terminaba.
 *
 * Por eso el inicio es el ancla (no se mueve una vez fijado) y el fin siempre
 * se deriva de él: inicio + 30 días.
 */

const TRIAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const NAIVE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?$/;

// Lee una fecha de prueba tal como vino de la BD (texto de SQLite o Date de
// mysql2) y devuelve el instante UTC real que se guardó.
function parseUtcDbDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(Date.UTC(
      value.getFullYear(), value.getMonth(), value.getDate(),
      value.getHours(), value.getMinutes(), value.getSeconds()
    ));
  }
  let text = String(value).trim();
  const match = NAIVE_DATETIME_RE.exec(text);
  if (match) text = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toUtcDbDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Sin inicio guardado se reconstruye desde el fin (instalaciones viejas) o se
// toma "ahora" (instalación nueva). Un inicio en el futuro (reloj adelantado
// en algún arranque) NO se mueve hacia atrás ni hacia adelante: solo se
// limita lo que se muestra a 30 días.
function computeTrialWindow({ startedAt = null, endsAt = null, now = new Date() } = {}) {
  const start = startedAt
    || (endsAt ? new Date(endsAt.getTime() - TRIAL_DAYS * DAY_MS) : null)
    || now;
  const end = new Date(start.getTime() + TRIAL_DAYS * DAY_MS);
  const msLeft = end.getTime() - now.getTime();
  return {
    startedAt: start,
    endsAt: end,
    daysLeft: Math.min(TRIAL_DAYS, Math.max(0, Math.ceil(msLeft / DAY_MS))),
    expired: msLeft <= 0,
  };
}

module.exports = {
  DAY_MS,
  TRIAL_DAYS,
  computeTrialWindow,
  parseUtcDbDateTime,
  toUtcDbDateTime,
};

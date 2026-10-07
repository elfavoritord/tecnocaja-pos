'use strict';

/**
 * server/sync/control-center/periods.js
 *
 * Fechas del Centro de Control en hora de República Dominicana. Las ventas se
 * guardan con la hora local de RD (nowRDString en server.js), así que los
 * rangos se arman como texto 'YYYY-MM-DD HH:MM:SS' en esa misma hora, igual
 * que getDefaultRange() de los reportes avanzados del POS.
 *
 * RD no cambia de horario (sin DST): la aritmética de días se hace en UTC
 * sobre la fecha local sin riesgo de saltos.
 */

const RD_TIMEZONE = 'America/Santo_Domingo';

function pad(value) {
  return String(value).padStart(2, '0');
}

/** { day: 'YYYY-MM-DD', time: 'HH:MM:SS' } de un instante, en hora RD. */
function rdParts(date = new Date()) {
  const text = date.toLocaleString('sv-SE', { timeZone: RD_TIMEZONE, hour12: false });
  const [day, rawTime = '00:00:00'] = text.split(' ');
  // Algunas versiones de ICU devuelven "24:00:00" a medianoche.
  const time = rawTime.startsWith('24:') ? `00:${rawTime.slice(3)}` : rawTime;
  return { day, time };
}

function dayToUtc(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function utcToDay(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addDays(day, amount) {
  const date = dayToUtc(day);
  date.setUTCDate(date.getUTCDate() + amount);
  return utcToDay(date);
}

/** Días entre dos fechas 'YYYY-MM-DD' (b - a). */
function diffDays(a, b) {
  return Math.round((dayToUtc(b).getTime() - dayToUtc(a).getTime()) / 86400000);
}

/** Lunes de la semana de `day` (semana de lunes a domingo). */
function weekStart(day) {
  const weekday = dayToUtc(day).getUTCDay(); // 0 = domingo
  return addDays(day, -((weekday + 6) % 7));
}

function monthStart(day) {
  return `${String(day).slice(0, 7)}-01`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** El mismo día del mes anterior (recortado: 31-mar → 28/29-feb). */
function sameDayPreviousMonth(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  const prevYear = m === 1 ? y - 1 : y;
  const prevMonth = m === 1 ? 12 : m - 1;
  const clamped = Math.min(d, daysInMonth(prevYear, prevMonth));
  return `${prevYear}-${pad(prevMonth)}-${pad(clamped)}`;
}

function listDays(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  let cursor = from;
  while (cursor <= to) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** 'YYYY-MM' de los últimos `count` meses, del más viejo al actual. */
function lastMonths(day, count) {
  const [y, m] = String(day).split('-').map(Number);
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const total = (y * 12 + (m - 1)) - i;
    out.push(`${Math.floor(total / 12)}-${pad((total % 12) + 1)}`);
  }
  return out;
}

const PERIOD_LABELS = {
  today: 'Hoy',
  yesterday: 'Ayer',
  week: 'Esta semana',
  month: 'Este mes',
};

/**
 * Rangos que publica el Centro de Control. Las comparaciones usan el MISMO
 * tramo del período anterior (hoy hasta esta hora vs ayer hasta esta hora,
 * semana en curso vs mismos días de la semana pasada, etc.): comparar el día
 * de hoy a medias contra el día de ayer completo siempre daría "bajando".
 */
function buildPeriods(now = new Date()) {
  const { day: today, time } = rdParts(now);
  const yesterday = addDays(today, -1);
  const week = weekStart(today);
  const month = monthStart(today);
  const prevMonthSameDay = sameDayPreviousMonth(today);

  const range = (fromDay, toDay, toTime = '23:59:59') => ({
    fromDay,
    toDay,
    from: `${fromDay} 00:00:00`,
    to: `${toDay} ${toTime}`,
  });

  const periods = {
    today: range(today, today),
    yesterday: range(yesterday, yesterday),
    week: range(week, today),
    month: range(month, today),
  };

  const compare = {
    // Comparación de cada período contra el tramo equivalente anterior.
    today: range(yesterday, yesterday, time),
    yesterday: range(addDays(today, -2), addDays(today, -2)),
    week: range(addDays(week, -7), addDays(today, -7), time),
    month: range(monthStart(prevMonthSameDay), prevMonthSameDay, time),
  };

  // Ventana de hechos diarios: cubre el mes, la semana y al menos 35 días
  // (para "vendido en 30 días", rotación y productos sin movimiento).
  const factsFrom = [week, month, addDays(today, -34)].sort()[0];

  return {
    today,
    time,
    nowText: `${today} ${time}`,
    yesterday,
    periods,
    compare,
    facts: range(factsFrom, today),
    last30: range(addDays(today, -29), today),
    last90: range(addDays(today, -89), today),
  };
}

/** Normaliza un DATE/DATETIME que devuelve mysql2 (Date) o SQLite (texto). */
function toDayKey(value) {
  if (!value) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

/** 'YYYY-MM-DD HH:MM:SS' (hora de pared, tal como está guardada en la BD). */
function toWallText(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${toDayKey(value)} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  const text = String(value).replace('T', ' ');
  return text.length >= 19 ? text.slice(0, 19) : text;
}

module.exports = {
  RD_TIMEZONE,
  PERIOD_LABELS,
  rdParts,
  addDays,
  diffDays,
  weekStart,
  monthStart,
  sameDayPreviousMonth,
  listDays,
  lastMonths,
  buildPeriods,
  toDayKey,
  toWallText,
};

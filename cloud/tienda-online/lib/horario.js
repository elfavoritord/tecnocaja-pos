'use strict';

// Horario de la tienda en hora de República Dominicana (UTC-4, sin horario de
// verano). No depende de la zona horaria del servidor.

const TZ = 'America/Santo_Domingo';
const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function ahoraRD(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hora = `${String(get('hour')).replace('24', '00').padStart(2, '0')}:${get('minute')}`;
  return { dia: DIAS[get('weekday')], hora };
}

/** ¿La tienda está abierta ahora? Un horario que cruza medianoche (20:00–02:00) también vale. */
function estaAbierta(horario, now = new Date()) {
  const dias = Array.isArray(horario?.dias) ? horario.dias : [];
  if (!dias.length) return true;
  const { dia, hora } = ahoraRD(now);
  const hoy = dias.find((d) => Number(d.dia) === dia);
  const ayer = dias.find((d) => Number(d.dia) === (dia + 6) % 7);
  const dentro = (d, enMadrugada = false) => {
    if (!d || !d.abierto) return false;
    const abre = String(d.abre || '00:00');
    const cierra = String(d.cierra || '23:59');
    if (abre <= cierra) return !enMadrugada && hora >= abre && hora <= cierra;
    return enMadrugada ? hora <= cierra : hora >= abre;
  };
  return dentro(hoy) || dentro(ayer, true);
}

module.exports = { estaAbierta, ahoraRD };

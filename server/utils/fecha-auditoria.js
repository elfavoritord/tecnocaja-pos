'use strict';

// audit-event.append (server/services/audit-event.js) guarda created_at en hora
// UTC ("AAAA-MM-DD hh:mm:ss"). SQLite lo devuelve como texto; MariaDB (mysql2)
// lo convierte en Date leyendo esa hora como si fuera la local de la PC, y la
// bitácora de Movimientos salía 4 horas adelantada (12:02 → 04:02 p. m.).
// Aquí la hora guardada se toma siempre como UTC y se devuelve en ISO.
function auditCreatedAtIso(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(),
      value.getHours(), value.getMinutes(), value.getSeconds())).toISOString();
  }
  const texto = String(value || '').trim();
  if (!texto) return null;
  return /[zZ]|[+-]\d{2}:\d{2}$/.test(texto) ? texto : `${texto.replace(' ', 'T')}Z`;
}

module.exports = { auditCreatedAtIso };

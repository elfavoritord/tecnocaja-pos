// ===== TECNO CAJA - FORMATO DE FECHAS =====
//
// Un solo formato en todo el sistema, en una línea:
//   dd/mm/aaaa hh:mm a. m.   (con hora)
//   dd/mm/aaaa               (solo fecha)
// Solo cambia cómo se muestra; las fechas guardadas no se tocan.

(function () {
  'use strict';

  function toDate(value) {
    if (value instanceof Date) return value;
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    // "2026-10-03" sin hora = día local (no UTC, para no correrse un día).
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const [y, m, d] = raw.split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    const parsed = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : raw.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatear(value, { hora = true } = {}) {
    if (value === null || value === undefined || value === '') return '—';
    const date = toDate(value);
    if (!date) return String(value);
    const dia = date.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' });
    if (!hora) return dia;
    const tiempo = date.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${dia} ${tiempo}`;
  }

  window.TcFecha = { formatear, toDate };
})();

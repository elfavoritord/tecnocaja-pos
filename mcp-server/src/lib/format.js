/** Utilidades compartidas de formato para las respuestas de las herramientas. */

const DOP = new Intl.NumberFormat('es-DO', {
  style: 'currency',
  currency: 'DOP',
  minimumFractionDigits: 2,
});

export function money(n) {
  const v = Number(n || 0);
  return DOP.format(Number.isFinite(v) ? v : 0);
}

export function num(n) {
  const v = Number(n || 0);
  return new Intl.NumberFormat('es-DO').format(Number.isFinite(v) ? v : 0);
}

/** YYYY-MM-DD de hoy en hora local del servidor (igual criterio que el POS). */
export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Normaliza el rango de fechas que recibe una herramienta. Acepta `desde`/`hasta`
 * en YYYY-MM-DD o palabras clave: "hoy", "ayer", "semana" (últimos 7 días),
 * "mes" (últimos 30 días). Si no se pasa nada, usa hoy.
 */
export function resolveRange({ desde, hasta, rango } = {}) {
  const hoy = todayKey();

  if (rango) {
    const r = String(rango).toLowerCase().trim();
    const base = new Date();
    if (r === 'hoy') return { desde: hoy, hasta: hoy };
    if (r === 'ayer') {
      const a = new Date(base.getTime() - 86400000);
      const k = todayKey(a);
      return { desde: k, hasta: k };
    }
    if (r === 'semana' || r === '7d') {
      const a = new Date(base.getTime() - 6 * 86400000);
      return { desde: todayKey(a), hasta: hoy };
    }
    if (r === 'mes' || r === '30d') {
      const a = new Date(base.getTime() - 29 * 86400000);
      return { desde: todayKey(a), hasta: hoy };
    }
  }

  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  return {
    desde: isDate(desde) ? desde : hoy,
    hasta: isDate(hasta) ? hasta : isDate(desde) ? desde : hoy,
  };
}

/** Envuelve texto + JSON crudo en el formato de contenido que espera MCP. */
export function reply(text, raw) {
  const content = [{ type: 'text', text }];
  if (raw !== undefined) {
    content.push({
      type: 'text',
      text: '```json\n' + JSON.stringify(raw, null, 2) + '\n```',
    });
  }
  return { content };
}

export function errorReply(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }],
  };
}

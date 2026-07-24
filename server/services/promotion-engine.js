// ══════════════════════════════════════════════════════════════════════════════
//  promotion-engine.js — Tecno Caja
//  Única fuente de verdad para decidir qué promoción aplica a un producto.
//  Sin dependencias de Express — se usa tanto desde promotions.routes.js (para
//  listar/exponer el mapa de promociones activas) como desde el endpoint de
//  checkout en server.js (para revalidar el precio antes de guardar la venta).
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function todayDateKey(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function nowTimeKey(now = new Date()) {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

// Normaliza columnas DATE/TIME que pueden venir como Date, string 'YYYY-MM-DD'/'HH:MM:SS'
// o null, según el driver (mysql2 vs sqlite3) — nunca asumir un solo formato.
function normalizeDateValue(value) {
  if (!value) return null;
  if (value instanceof Date) return todayDateKey(value);
  return String(value).slice(0, 10);
}

function normalizeTimeValue(value) {
  if (!value) return null;
  if (value instanceof Date) return nowTimeKey(value);
  return String(value).slice(0, 8);
}

// Estado grueso para listados/dashboard — no depende de la hora del día, solo
// de la fecha y del toggle manual. La ventana horaria (hora_inicio/hora_fin,
// ej. Happy Hour) se evalúa aparte en isWithinTimeWindow(), porque una
// promoción puede estar "activa" en fecha pero fuera de horario en un momento
// dado sin que por eso deba mostrarse como vencida/deshabilitada.
function computePromotionStatus(promo, now = new Date()) {
  if (Number(promo.deshabilitada) === 1) return 'deshabilitada';

  const today = todayDateKey(now);
  const permanente = Number(promo.permanente) === 1;
  const fechaInicio = normalizeDateValue(promo.fecha_inicio);
  const fechaFin = normalizeDateValue(promo.fecha_fin);

  if (!permanente) {
    if (fechaInicio && today < fechaInicio) return 'programada';
    if (fechaFin && today > fechaFin) return 'vencida';
  }
  return 'activa';
}

function isWithinTimeWindow(promo, now = new Date()) {
  const horaInicio = normalizeTimeValue(promo.hora_inicio);
  const horaFin = normalizeTimeValue(promo.hora_fin);
  if (!horaInicio || !horaFin) return true;
  const current = nowTimeKey(now);
  // Ventana normal (ej. 08:00–17:00). Si hora_fin < hora_inicio se asume que
  // cruza medianoche (ej. 20:00–02:00).
  if (horaInicio <= horaFin) return current >= horaInicio && current <= horaFin;
  return current >= horaInicio || current <= horaFin;
}

// Compara dos promociones candidatas para el mismo producto y decide cuál gana,
// siguiendo el criterio del spec: mayor prioridad → mayor beneficio para el
// cliente → más reciente.
function isBetterCandidate(candidate, current) {
  if (candidate.prioridad !== current.prioridad) return candidate.prioridad > current.prioridad;
  const candidateSavings = candidate.precioOriginal - candidate.precioPromocion;
  const currentSavings = current.precioOriginal - current.precioPromocion;
  if (candidateSavings !== currentSavings) return candidateSavings > currentSavings;
  return new Date(candidate.createdAt || 0).getTime() > new Date(current.createdAt || 0).getTime();
}

// Trae TODAS las filas promoción×producto vigentes por fecha (sin filtrar por
// hora todavía) para la sucursal indicada y el tipo dado — una sola consulta,
// sin N+1. `tipo` se parametriza (placeholder `?`) para reutilizar la misma
// consulta tanto para 'oferta_precio' como para 'descuento_por_cantidad'.
async function fetchDateActiveRows(query, { sucursalId = null, tipo = 'oferta_precio' } = {}) {
  const today = todayDateKey();
  return query(
    `SELECT p.id AS promotion_id, p.nombre, p.prioridad, p.color, p.texto_promocion,
            p.hora_inicio, p.hora_fin, p.permanente, p.created_at,
            pp.producto_id, pp.precio_original, pp.precio_promocion, pp.cantidad_minima
     FROM promotions p
     JOIN promotion_products pp ON pp.promotion_id = p.id
     WHERE p.deshabilitada = 0
       AND p.tipo = ?
       AND (p.sucursal_id IS NULL OR p.sucursal_id = ?)
       AND (
         p.permanente = 1
         OR (
           (p.fecha_inicio IS NULL OR p.fecha_inicio <= ?)
           AND (p.fecha_fin IS NULL OR p.fecha_fin >= ?)
         )
       )`,
    [tipo, sucursalId || null, today, today],
  );
}

// Resuelve el mapa { producto_id: promoInfo } de promociones realmente
// aplicables AHORA MISMO (fecha + hora + prioridad ya resueltos) — es lo que
// consume el POS (vía /api/promotions/active-map) y la caché offline.
async function resolveActivePromotions({ query, sucursalId = null, now = new Date() }) {
  // Interruptor global (pestaña Configuración) — si está apagado, ningún
  // producto se resuelve con promoción, sin importar lo que haya en la tabla.
  const configRows = await query('SELECT promotions_enabled FROM config WHERE id = 1 LIMIT 1').catch(() => []);
  if (configRows.length && Number(configRows[0].promotions_enabled) === 0) return {};

  const rows = await fetchDateActiveRows(query, { sucursalId, tipo: 'oferta_precio' });
  const byProduct = {};

  for (const row of rows) {
    if (!isWithinTimeWindow(row, now)) continue;
    const candidate = {
      promotionId: Number(row.promotion_id),
      nombre: row.nombre,
      precioOriginal: Number(row.precio_original),
      precioPromocion: Number(row.precio_promocion),
      ahorro: Number((Number(row.precio_original) - Number(row.precio_promocion)).toFixed(2)),
      texto: row.texto_promocion || '',
      color: row.color || '',
      prioridad: Number(row.prioridad || 0),
      createdAt: row.created_at,
    };
    const productoId = Number(row.producto_id);
    const current = byProduct[productoId];
    if (!current || isBetterCandidate(candidate, current)) {
      byProduct[productoId] = candidate;
    }
  }

  return byProduct;
}

// Resuelve el mapa { producto_id: reglaInfo } de reglas "descuento_por_cantidad"
// vigentes AHORA MISMO — mismo criterio de fecha/hora/prioridad/config que
// resolveActivePromotions, pero para el tipo condicionado a cantidad mínima.
// El precio solo se activa si la cantidad en el carrito llega a `cantidadMinima`
// (eso lo decide pickWinningPromotion, no esta función).
async function resolveActiveQuantityRules({ query, sucursalId = null, now = new Date() }) {
  const configRows = await query('SELECT promotions_enabled FROM config WHERE id = 1 LIMIT 1').catch(() => []);
  if (configRows.length && Number(configRows[0].promotions_enabled) === 0) return {};

  const rows = await fetchDateActiveRows(query, { sucursalId, tipo: 'descuento_por_cantidad' });
  const byProduct = {};

  for (const row of rows) {
    if (!isWithinTimeWindow(row, now)) continue;
    const candidate = {
      promotionId: Number(row.promotion_id),
      nombre: row.nombre,
      precioOriginal: Number(row.precio_original),
      precioPromocion: Number(row.precio_promocion),
      ahorro: Number((Number(row.precio_original) - Number(row.precio_promocion)).toFixed(2)),
      cantidadMinima: Number(row.cantidad_minima),
      texto: row.texto_promocion || '',
      color: row.color || '',
      prioridad: Number(row.prioridad || 0),
      createdAt: row.created_at,
    };
    const productoId = Number(row.producto_id);
    const current = byProduct[productoId];
    if (!current || isBetterCandidate(candidate, current)) {
      byProduct[productoId] = candidate;
    }
  }

  return byProduct;
}

// Decide qué promoción aplica a una línea del carrito, dado cuántas unidades
// tiene esa línea. Sin I/O — pensada para llamarse dentro de un loop de items
// sin golpear la BD por cada uno (los mapas ya se resolvieron una sola vez
// antes del loop). Si el umbral de cantidad se cumple, compite con la oferta
// plana por el criterio ya usado para desempatar entre promociones del mismo
// tipo (mayor prioridad → mayor ahorro → más reciente) — así un descuento por
// cantidad nunca deja al cliente pagando más de lo que pagaría con una oferta
// de precio ya activa.
function pickWinningPromotion({ ofertaMap, quantityMap, productoId, qty }) {
  const oferta = ofertaMap?.[Number(productoId)] || null;
  const cantidad = quantityMap?.[Number(productoId)] || null;
  const qtyQualifies = Boolean(cantidad) && Number(qty) >= Number(cantidad.cantidadMinima);
  if (qtyQualifies && oferta) return isBetterCandidate(cantidad, oferta) ? cantidad : oferta;
  if (qtyQualifies) return cantidad;
  return oferta;
}

// Usado en el momento de guardar la venta: NUNCA confiar en el precio que
// manda el cliente para un producto en promoción — se vuelve a resolver la
// promoción activa server-side y esa es la fuente de verdad. Wrapper de
// conveniencia para un solo ítem; los checkouts reales (server.js, offline
// sync-pending) resuelven ambos mapas una vez fuera del loop y llaman a
// pickWinningPromotion directamente para no golpear la BD por cada línea.
async function resolvePriceForSaleItem({ query, productoId, sucursalId = null, qty = 1, now = new Date() }) {
  const [ofertaMap, quantityMap] = await Promise.all([
    resolveActivePromotions({ query, sucursalId, now }),
    resolveActiveQuantityRules({ query, sucursalId, now }),
  ]);
  return pickWinningPromotion({ ofertaMap, quantityMap, productoId, qty });
}

module.exports = {
  computePromotionStatus,
  isWithinTimeWindow,
  resolveActivePromotions,
  resolveActiveQuantityRules,
  pickWinningPromotion,
  resolvePriceForSaleItem,
  todayDateKey,
  nowTimeKey,
};

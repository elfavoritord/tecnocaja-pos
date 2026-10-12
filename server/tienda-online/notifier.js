'use strict';

/**
 * server/tienda-online/notifier.js
 *
 * Avisos de la tienda online. WhatsApp NO es por donde entran los pedidos
 * (eso es la nube → POS); aquí solo se avisa.
 *
 * Canales (agregar otro = una entrada más en CANALES y su envío):
 *   web       mensaje en la página de seguimiento del pedido (siempre; lo
 *             sube a la nube el envío de estados de orders-sync)
 *   whatsapp  por el bot de WhatsApp del POS, si está conectado y activado
 * Correo y SMS quedan listos para agregarse sin tocar el resto del módulo.
 *
 * Los avisos se guardan primero en online_order_notifications: sin Internet
 * o con el bot apagado quedan pendientes y salen después.
 */

const { mensajeCliente, ESTADO_ETIQUETAS } = require('./contrato');

const MAX_INTENTOS = 5;

function parseSettings(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function fmtMonto(moneda, valor) {
  return `${moneda || 'RD$'} ${Number(valor || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function createNotifier({ query, nowSql, getWaBot = () => null, logger = console }) {
  async function readSettings() {
    const rows = await query('SELECT settings_json FROM online_store_settings WHERE id = 1 LIMIT 1');
    return parseSettings(rows[0]?.settings_json);
  }

  function botListo() {
    const bot = getWaBot();
    if (!bot || typeof bot.sendTextMessage !== 'function') return null;
    const estado = typeof bot.getSafeState === 'function' ? bot.getSafeState()?.status : 'ready';
    return estado === 'ready' ? bot : null;
  }

  async function insert(orderId, canal, destinatario, mensaje) {
    await query(
      `INSERT INTO online_order_notifications (order_id, channel, recipient, message, status, created_at)
       VALUES (?, ?, ?, ?, 'pendiente', ?)`,
      [orderId, canal, destinatario || null, mensaje, nowSql()],
    );
  }

  /** Prepara el aviso al cliente por cada canal activo. */
  async function enqueueForStatus(order, estado, { motivo = '' } = {}) {
    const texto = mensajeCliente(estado, { numero: order.numero, tipoEntrega: order.entrega?.tipo, motivo });
    if (!texto) return;
    await insert(order.id, 'web', null, texto);
    const settings = await readSettings();
    const telefono = order.cliente?.whatsapp || order.cliente?.telefono || '';
    if (settings.notificaciones?.whatsappCliente && String(telefono).replace(/\D/g, '').length >= 10) {
      const negocio = settings.nombre ? `*${settings.nombre}*\n` : '';
      await insert(order.id, 'whatsapp', telefono, `${negocio}${texto}`);
    }
  }

  /** Envía los avisos pendientes que dependen del POS (WhatsApp). */
  async function dispatchPending() {
    const rows = await query(
      `SELECT * FROM online_order_notifications
        WHERE channel = 'whatsapp' AND status = 'pendiente' AND attempts < ?
        ORDER BY id LIMIT 20`,
      [MAX_INTENTOS],
    );
    if (!rows.length) return { enviados: 0 };
    const bot = botListo();
    if (!bot) return { enviados: 0, omitido: 'bot_no_conectado' };
    let enviados = 0;
    for (const row of rows) {
      const result = await bot.sendTextMessage(row.recipient, row.message).catch((error) => ({ ok: false, error: error.message }));
      if (result?.ok) {
        enviados += 1;
        await query(`UPDATE online_order_notifications SET status = 'enviado', sent_at = ?, attempts = attempts + 1 WHERE id = ?`, [nowSql(), row.id]);
      } else {
        await query(
          `UPDATE online_order_notifications
              SET attempts = attempts + 1, last_error = ?,
                  status = CASE WHEN attempts + 1 >= ? THEN 'fallido' ELSE 'pendiente' END
            WHERE id = ?`,
          [String(result?.error || 'Error').slice(0, 255), MAX_INTENTOS, row.id],
        );
      }
    }
    return { enviados };
  }

  /** Mensajes para la página de seguimiento (todos, en orden). */
  async function webMessages(orderId) {
    const rows = await query(
      `SELECT message, created_at FROM online_order_notifications WHERE order_id = ? AND channel = 'web' ORDER BY id`,
      [orderId],
    );
    return rows;
  }

  async function markWebSent(orderId) {
    await query(
      `UPDATE online_order_notifications SET status = 'enviado', sent_at = ? WHERE order_id = ? AND channel = 'web' AND status = 'pendiente'`,
      [nowSql(), orderId],
    );
  }

  /** Aviso al dueño por WhatsApp cuando entra un pedido (opcional). */
  async function notifyOwnerNewOrder(order) {
    const settings = await readSettings();
    if (!settings.notificaciones?.whatsappDueno) return { ok: false, omitido: 'desactivado' };
    const bot = botListo();
    if (!bot || typeof bot.notifyOwners !== 'function') return { ok: false, omitido: 'bot_no_conectado' };
    const texto = [
      '🛒 *Nuevo pedido online*',
      `Pedido #${order.numero}`,
      `Cliente: ${order.cliente?.nombre || ''}`,
      `Total: ${fmtMonto(order.moneda, order.totales?.total)}`,
      `Entrega: ${order.entrega?.tipo === 'delivery' ? 'Delivery' : 'Retiro en tienda'}`,
      'Revisa el pedido en Tecno Caja.',
    ].join('\n');
    return bot.notifyOwners(texto).catch((error) => {
      logger.warn?.('[tienda-online] No se pudo avisar al dueño por WhatsApp:', error.message);
      return { ok: false };
    });
  }

  return {
    CANALES: { web: 'Página de seguimiento', whatsapp: 'WhatsApp (bot del POS)' },
    ESTADO_ETIQUETAS,
    enqueueForStatus,
    dispatchPending,
    webMessages,
    markWebSent,
    notifyOwnerNewOrder,
  };
}

module.exports = { createNotifier };

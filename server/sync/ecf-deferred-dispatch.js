'use strict';

/**
 * server/sync/ecf-deferred-dispatch.js
 *
 * Envía a la DGII los e-CF que se firmaron sin Internet
 * (ecf.service.js → deferSaleDocumentOffline). Corre solo en la PC principal
 * (una sola vez por negocio, así dos cajas nunca envían el mismo documento):
 *   - en cuanto vuelve Internet (evento 'online' del monitor),
 *   - al arrancar (por si quedaron pendientes de otro día),
 *   - cada 5 minutos como respaldo.
 * Nunca bloquea ventas: todo ocurre en segundo plano.
 */

function startEcfDeferredDispatch({
  service,
  monitor,
  isMain = () => true,
  logger = console,
  intervalMs = 5 * 60 * 1000,
  startupDelayMs = 20000,
} = {}) {
  if (!service || typeof service.sendDeferredDocuments !== 'function' || !monitor) {
    return { run: async () => null, stop() {} };
  }

  let running = false;

  async function run(reason = 'manual') {
    if (running || !isMain() || !monitor.isOnline()) return null;
    running = true;
    try {
      const pending = await service.countDeferredDocuments();
      if (!pending) return { sent: 0, failed: 0, pending: 0 };
      logger.log(`[ecf-diferidos] ${pending} e-CF pendiente(s) de envío — enviando a la DGII (${reason}).`);
      const result = await service.sendDeferredDocuments();
      logger.log(`[ecf-diferidos] Enviados: ${result.sent}. Con error: ${result.failed}.`);
      return result;
    } catch (error) {
      logger.warn('[ecf-diferidos] No se pudieron enviar los e-CF pendientes:', error.message);
      return null;
    } finally {
      running = false;
    }
  }

  const onOnline = () => { run('volvió Internet'); };
  monitor.on('online', onOnline);
  const timer = setInterval(() => { run('revisión periódica'); }, intervalMs);
  if (timer.unref) timer.unref();
  const startup = setTimeout(() => { run('arranque'); }, startupDelayMs);
  if (startup.unref) startup.unref();

  return {
    run,
    stop() {
      clearInterval(timer);
      clearTimeout(startup);
      monitor.removeListener('online', onOnline);
    },
  };
}

module.exports = { startEcfDeferredDispatch };

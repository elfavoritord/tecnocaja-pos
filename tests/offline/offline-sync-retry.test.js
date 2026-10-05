'use strict';

/**
 * Las ventas de contingencia que quedaron a medias (Tecno Caja cerrado o la
 * principal apagada en plena subida) vuelven solas a la cola. Un error de
 * datos se queda para revisión.
 */

const createOfflineRouter = require('../../server/routes/offline.routes');
const { isTransientSyncError } = createOfflineRouter;

describe('reintento de la sincronización de contingencia', () => {
  test.each([
    'connect ECONNREFUSED 192.168.1.10:3306',
    'connect ETIMEDOUT',
    'read ECONNRESET',
    'Connection lost: The server closed the connection.',
    'Lock wait timeout exceeded; try restarting transaction',
    "Record has changed since last read in table 'config'",
    'getaddrinfo ENOTFOUND CAJA-PRINCIPAL',
  ])('reintenta: %s', (message) => {
    expect(isTransientSyncError(message)).toBe(true);
  });

  test.each([
    'El producto ID 77 no existe.',
    'JSON inválido en venta caja2#4#1791197264123',
    'No hay una caja abierta en el servidor para aplicar este movimiento.',
    '',
    null,
  ])('no reintenta: %s', (message) => {
    expect(isTransientSyncError(message)).toBe(false);
  });
});

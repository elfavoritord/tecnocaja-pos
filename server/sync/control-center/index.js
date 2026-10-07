'use strict';

/**
 * server/sync/control-center/index.js
 *
 * Punto de entrada del Centro de Control de la app de reportes (ver
 * publisher.js y docs/CENTRO-DE-CONTROL-REPORTES.md). server.js lo arranca
 * con sus dependencias; cualquier módulo puede avisar de un cambio con
 * notifyControlCenterChange() sin conocer el publicador.
 */

const { createControlCenterPublisher } = require('./publisher');

let instance = null;

function startControlCenterPublisher(deps) {
  if (instance) return instance;
  instance = createControlCenterPublisher(deps);
  instance.start();
  return instance;
}

function notifyControlCenterChange(reason = '') {
  if (!instance) return;
  try {
    instance.notifyChange(reason);
  } catch (_error) {
    // Nunca debe afectar a quien avisa (una venta, un cierre de caja…).
  }
}

function getControlCenterStatus() {
  return instance ? instance.getStatus() : { started: false };
}

function stopControlCenterPublisher() {
  if (!instance) return;
  instance.stop();
  instance = null;
}

module.exports = {
  startControlCenterPublisher,
  notifyControlCenterChange,
  getControlCenterStatus,
  stopControlCenterPublisher,
};

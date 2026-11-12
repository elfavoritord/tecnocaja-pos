'use strict';

// Mantiene el orden de cada impresora sin frenar las otras cajas/impresoras.
function createPrinterQueue() {
  const queues = new Map();
  return (printerName, work) => {
    const key = String(printerName || '').trim().toLowerCase();
    const result = (queues.get(key) || Promise.resolve()).then(work, work);
    const tail = result.then(() => {}, () => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return result;
  };
}

const enqueuePrinterJob = createPrinterQueue();
module.exports = { createPrinterQueue, enqueuePrinterJob };

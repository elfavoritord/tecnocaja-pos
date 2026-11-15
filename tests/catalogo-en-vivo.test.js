'use strict';
// Catálogo en vivo entre cajas (server/realtime/catalogo-en-vivo.js): al cambiar
// un producto, las demás cajas reciben 'catalogo:actualizado' y refrescan la
// pantalla dividida de Ventas.
const { EventEmitter } = require('events');
const { createCatalogoEnVivo, cambiaElCatalogo, EVENTO } = require('../server/realtime/catalogo-en-vivo');

function peticion(method, path, statusCode = 200) {
  const req = { method, path };
  const res = new EventEmitter();
  res.statusCode = statusCode;
  return { req, res };
}

describe('qué rutas cambian el catálogo', () => {
  test.each([
    ['POST', '/api/products'],
    ['PUT', '/api/products/15'],
    ['DELETE', '/api/products/15'],
    ['POST', '/api/products/import-csv'],
    ['POST', '/api/products/15/image'],
    ['POST', '/api/inventory/adjust'],
    ['POST', '/api/combos'],
    ['POST', '/api/purchases'],
    ['POST', '/api/purchases/drafts/abc/registrar'],
    ['POST', '/api/purchases/9/receipts'],
    ['POST', '/api/purchases/9/void'],
  ])('%s %s → sí', (method, path) => {
    expect(cambiaElCatalogo(method, path)).toBe(true);
  });

  test.each([
    ['GET', '/api/products'],
    ['GET', '/api/products/cache-search'],
    ['POST', '/api/sales'],
    ['POST', '/api/purchases/drafts'],
    ['PUT', '/api/purchases/drafts/abc'],
    ['PUT', '/api/config'],
    ['POST', '/api/productsx'],
  ])('%s %s → no', (method, path) => {
    expect(cambiaElCatalogo(method, path)).toBe(false);
  });
});

describe('aviso a las cajas', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('varios cambios seguidos salen en un solo aviso, solo si salieron bien', () => {
    const io = { emit: jest.fn() };
    const { middleware } = createCatalogoEnVivo({ io, esperaMs: 500 });
    const next = jest.fn();

    for (const status of [200, 201, 400]) {
      const { req, res } = peticion('PUT', '/api/products/1', status);
      middleware(req, res, next);
      res.emit('finish');
    }
    expect(next).toHaveBeenCalledTimes(3);
    expect(io.emit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(500);
    expect(io.emit).toHaveBeenCalledTimes(1);
    expect(io.emit.mock.calls[0][0]).toBe(EVENTO);
  });

  test('un error no avisa y una lectura no se escucha', () => {
    const io = { emit: jest.fn() };
    const { middleware } = createCatalogoEnVivo({ io, esperaMs: 10 });
    const fallida = peticion('POST', '/api/products', 409);
    middleware(fallida.req, fallida.res, () => {});
    fallida.res.emit('finish');
    const lectura = peticion('GET', '/api/products', 200);
    middleware(lectura.req, lectura.res, () => {});
    expect(lectura.res.listenerCount('finish')).toBe(0);
    jest.advanceTimersByTime(50);
    expect(io.emit).not.toHaveBeenCalled();
  });

  test('si Socket.IO falla, la petición sigue sin error', () => {
    const io = { emit: () => { throw new Error('sin socket'); } };
    const logger = { warn: jest.fn() };
    const { middleware } = createCatalogoEnVivo({ io, esperaMs: 10, logger });
    const { req, res } = peticion('DELETE', '/api/products/3', 200);
    middleware(req, res, () => {});
    res.emit('finish');
    expect(() => jest.advanceTimersByTime(20)).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});

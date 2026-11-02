'use strict';

/**
 * Cuándo se pide confirmar el reinicio de una actualización, y las operaciones que lo frenan.
 */

const express = require('express');
const request = require('supertest');

const { crearRecordatorio, esMasNueva, UNA_HORA_MS } = require('../electron/update-recordatorio');
const { createOperacionesActivas } = require('../server/system/operaciones-activas');

function preparar({ guardado = null, versionActual = '1.6.8' } = {}) {
  const contexto = { disco: guardado, reloj: 1000000 };
  const abrir = () => crearRecordatorio({
    versionActual,
    ahora: () => contexto.reloj,
    leer: () => contexto.disco,
    guardar: (estado) => { contexto.disco = estado; },
  });
  contexto.r = abrir();
  contexto.reabrir = () => { contexto.r = abrir(); return contexto.r; };
  return contexto;
}

describe('recordatorio del reinicio', () => {
  test('al descargar pide confirmar enseguida; antes no', () => {
    const c = preparar();
    expect(c.r.debeAvisar()).toBe(false);
    c.r.descargada('1.6.9');
    expect(c.r.debeAvisar()).toBe(true);
  });

  test('"Más tarde" espera exactamente una hora, todas las veces', () => {
    const c = preparar();
    c.r.descargada('1.6.9');
    for (let vez = 0; vez < 5; vez += 1) {
      c.r.posponer();
      expect(c.r.debeAvisar()).toBe(false);
      c.reloj += UNA_HORA_MS - 1;
      expect(c.r.debeAvisar()).toBe(false);
      c.reloj += 1;
      expect(c.r.debeAvisar()).toBe(true);
    }
  });

  test('si nadie responde vuelve una hora después, sin reiniciar', () => {
    const c = preparar();
    c.r.descargada('1.6.9');
    c.r.mostrado();
    expect(c.r.debeAvisar()).toBe(false);
    c.reloj += UNA_HORA_MS;
    expect(c.r.debeAvisar()).toBe(true);
  });

  test('si empezó una venta con el aviso en pantalla, vuelve al quedar libre', () => {
    const c = preparar();
    c.r.descargada('1.6.9');
    c.r.mostrado();
    c.r.aplazar();
    expect(c.r.debeAvisar()).toBe(true);
  });

  test('cerrar y abrir el POS no olvida la actualización ni el "más tarde"', () => {
    const c = preparar();
    c.r.descargada('1.6.9');
    c.r.posponer();
    c.reloj += 20 * 60 * 1000;
    c.reabrir();
    // Hasta confirmar que el instalador sigue en disco no se ofrece.
    expect(c.r.debeAvisar()).toBe(false);
    c.r.descargada('1.6.9');
    expect(c.r.debeAvisar()).toBe(false);
    c.reloj += 40 * 60 * 1000;
    expect(c.r.debeAvisar()).toBe(true);
  });

  test('otra versión descargada no se salta un "más tarde" vigente', () => {
    const c = preparar();
    c.r.descargada('1.6.9');
    c.r.posponer();
    c.r.descargada('1.6.10');
    expect(c.r.debeAvisar()).toBe(false);
    expect(c.r.estado().version).toBe('1.6.10');
  });

  test('ya instalada se olvida', () => {
    const c = preparar({ guardado: { version: '1.6.9', proximoAviso: 0 }, versionActual: '1.6.9' });
    expect(c.r.estado()).toBeNull();
    expect(c.disco).toBeNull();
  });

  test('un archivo dañado no impide arrancar', () => {
    const r = crearRecordatorio({ versionActual: '1.6.8', leer: () => { throw new Error('dañado'); }, guardar: () => {} });
    expect(r.debeAvisar()).toBe(false);
  });

  test('no poder guardar no rompe el aviso', () => {
    const r = crearRecordatorio({ versionActual: '1.6.8', leer: () => null, guardar: () => { throw new Error('sin disco'); }, ahora: () => 5 });
    r.descargada('1.6.9');
    expect(r.debeAvisar()).toBe(true);
  });

  test('compara versiones como números', () => {
    expect(esMasNueva('1.6.10', '1.6.9')).toBe(true);
    expect(esMasNueva('1.6.9', '1.6.10')).toBe(false);
    expect(esMasNueva('1.6.9', '1.6.9')).toBe(false);
    expect(esMasNueva('2.0.0', '1.9.9')).toBe(true);
  });
});

describe('operaciones activas del servidor', () => {
  function app({ terminales = [], ahora = () => Date.parse('2026-11-01T12:00:00') } = {}) {
    const operaciones = createOperacionesActivas({ query: async () => terminales, ahora });
    const a = express();
    a.use(operaciones.middleware);
    a.use('/api/system', operaciones.router);
    const soltar = [];
    a.post('/api/sales', (_req, res) => { soltar.push(() => res.json({ ok: true })); });
    a.get('/api/products', (_req, res) => res.json([]));
    a.post('/api/respaldos/auto', (_req, res) => res.json({ ok: true }));
    return { a, operaciones, soltar };
  }

  test('una venta en curso cuenta hasta que termina', async () => {
    const { a, operaciones, soltar } = app();
    const servidor = a.listen(0);
    const venta = request(servidor).post('/api/sales').send({}).then((r) => r);
    while (!soltar.length) await new Promise((r) => setTimeout(r, 5));
    const durante = await request(servidor).get('/api/system/operaciones-activas');
    expect(durante.body.activas).toBe(1);
    soltar[0]();
    await venta;
    while (operaciones.activas() > 0) await new Promise((r) => setTimeout(r, 5));
    const despues = await request(servidor).get('/api/system/operaciones-activas');
    expect(despues.body.activas).toBe(0);
    servidor.close();
  });

  test('leer y el respaldo previo a instalar no cuentan', async () => {
    const { a, operaciones } = app();
    await request(a).get('/api/products');
    await request(a).post('/api/respaldos/auto').send({});
    expect(operaciones.activas()).toBe(0);
  });

  test('cuenta solo las cajas vistas hace poco', async () => {
    const { a } = app({ terminales: [
      { last_seen_at: '2026-11-01 11:58:00' },
      { last_seen_at: '2026-11-01 09:00:00' },
      { last_seen_at: null },
    ] });
    const r = await request(a).get('/api/system/operaciones-activas');
    expect(r.body.otrasCajas).toBe(1);
  });
});

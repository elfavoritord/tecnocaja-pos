'use strict';

/**
 * Lo que cambia en el POS llega rápido a la tienda:
 *   - cambios hechos por las rutas del POS (productos, fotos, precios…) avisan
 *     al publicador al terminar la petición (vigilarCambiosCatalogo);
 *   - cambios hechos en otra caja (misma base) los nota el ciclo de 30 s por
 *     la huella del catálogo, sin esperar la publicación completa de 5 min.
 */

const express = require('express');
const request = require('supertest');
const { createSqlitePos, sqlDate } = require('../helpers/sqlite-pos');
const { createFakeFirestore } = require('../helpers/fake-firestore');
const { createTiendaOnline } = require('../../server/tienda-online');
const { createApp } = require('../../cloud/tienda-online/lib/app');

const LIC = 'pos_cambios00000000';
const SLUG = 'cambios-prueba';

let pos;
let fs;
let tienda;
let productoId;

async function precioPublicado() {
  const app = createApp({ db: fs, FieldValue: fs.FieldValue, limits: { lectura: 1000 } });
  const res = await request(app).get(`/api/tiendas/${SLUG}`);
  return res.body.productos.find((p) => p.id === productoId)?.precio;
}

beforeAll(async () => {
  pos = await createSqlitePos();
  fs = createFakeFirestore();
  tienda = createTiendaOnline({
    query: pos.query,
    withTransaction: pos.withTransaction,
    addColumnIfMissing: pos.addColumnIfMissing,
    nowSql: () => sqlDate(),
    formatSqlDate: (d) => sqlDate(d),
    getLicenseId: () => LIC,
    getFirestore: () => fs,
    getFieldValue: () => fs.FieldValue,
    isMain: () => true,
    mapClientRow: (row) => ({ id: Number(row.id) }),
    logger: { warn() {}, error() {} },
  });
  await tienda.ensureReady();
  const r = await pos.query(
    `INSERT INTO products (codigo, nombre, categoria, precio_compra, precio_venta, stock, estado, tracks_stock, online_enabled)
     VALUES ('AGU', 'Agua', 'Bebidas', 10, 25, 50, 'Activo', 1, 1)`,
  );
  productoId = Number(r.insertId);
  await tienda.settingsStore.write({ enabled: true, slug: SLUG, settings: { nombre: 'Cambios', pagos: { efectivo: { habilitado: true } } } });
  expect((await tienda.publisher.run({ force: true })).ok).toBe(true);
});

afterAll(() => {
  tienda.stop();
  pos.close();
});

test('un precio cambiado en otra caja se publica en el siguiente ciclo (sin esperar 5 min)', async () => {
  expect(await precioPublicado()).toBe(25);
  await tienda.publisher.run(); // ciclo liviano: toma la huella actual
  await pos.query('UPDATE products SET precio_venta = 30 WHERE id = ?', [productoId]);
  const r = await tienda.publisher.run(); // ciclo liviano: la huella cambió → publicación completa
  expect(r).toMatchObject({ ok: true, completa: true });
  expect(await precioPublicado()).toBe(30);
  // Sin cambios, el ciclo sigue siendo liviano.
  expect(await tienda.publisher.run()).toMatchObject({ ok: true, completa: false });
});

test('las rutas del POS que cambian el catálogo avisan al publicador; las de consulta no', async () => {
  const avisos = [];
  const original = tienda.publisher.notifyCatalogChange;
  tienda.publisher.notifyCatalogChange = () => avisos.push(Date.now());
  try {
    const app = express();
    app.use(tienda.vigilarCambiosCatalogo());
    app.put('/api/products/:id', (req, res) => res.json({ ok: true }));
    app.post('/api/products/:id/image', (req, res) => res.status(400).json({ error: 'mala' }));
    app.put('/api/config', (req, res) => res.json({ ok: true }));
    app.get('/api/products', (req, res) => res.json([]));
    app.post('/api/sales', (req, res) => res.json({ ok: true }));
    await request(app).put('/api/products/1').send({});
    await request(app).put('/api/config').send({});
    await request(app).post('/api/products/1/image').send({}); // falló: no avisa
    await request(app).get('/api/products'); // consulta: no avisa
    await request(app).post('/api/sales').send({}); // ventas van por afterAnySale (existencia)
    expect(avisos).toHaveLength(2);
  } finally {
    tienda.publisher.notifyCatalogChange = original;
  }
});

test('el logo nuevo se sube antes de anunciarlo en el perfil (si no sube, el perfil no lo nombra)', async () => {
  const fs2 = createFakeFirestore();
  let falla = false;
  const t2 = createTiendaOnline({
    query: pos.query,
    withTransaction: pos.withTransaction,
    addColumnIfMissing: pos.addColumnIfMissing,
    nowSql: () => sqlDate(),
    formatSqlDate: (d) => sqlDate(d),
    getLicenseId: () => 'pos_logo0000000000',
    getFirestore: () => fs2,
    getFieldValue: () => fs2.FieldValue,
    isMain: () => true,
    mapClientRow: (row) => ({ id: Number(row.id) }),
    processImage: async (buffer) => {
      if (falla) throw new Error('sin Internet a mitad');
      return { mime: 'image/webp', data: buffer.toString('base64') };
    },
    logger: { warn() {}, error() {} },
  });
  const logo = (txt) => `data:image/png;base64,${Buffer.from(txt).toString('base64')}`;
  await pos.query('UPDATE config SET app_logo = ? WHERE id = 1', [logo('logo-1')]);
  await t2.settingsStore.write({ enabled: true, slug: 'logo-prueba', settings: { nombre: 'Logo', pagos: { efectivo: { habilitado: true } } } });
  await t2.publisher.run({ force: true });
  const perfil1 = fs2._get('businesses/pos_logo0000000000/tiendaOnline/perfil');
  const img1 = fs2._get('businesses/pos_logo0000000000/tiendaImagenes/_logo');
  expect(perfil1.logoVersion).toBeTruthy();
  expect(img1.version).toBe(perfil1.logoVersion);
  // Logo nuevo, pero la subida falla: el perfil sigue nombrando el que sí está arriba.
  falla = true;
  await pos.query('UPDATE config SET app_logo = ? WHERE id = 1', [logo('logo-2')]);
  await t2.publisher.run({ force: true });
  expect(fs2._get('businesses/pos_logo0000000000/tiendaOnline/perfil').logoVersion).toBe(perfil1.logoVersion);
  // Vuelve a subir: ahora sí se anuncia el nuevo.
  falla = false;
  await t2.publisher.run({ force: true });
  const perfil3 = fs2._get('businesses/pos_logo0000000000/tiendaOnline/perfil');
  expect(perfil3.logoVersion).not.toBe(perfil1.logoVersion);
  expect(fs2._get('businesses/pos_logo0000000000/tiendaImagenes/_logo').version).toBe(perfil3.logoVersion);
  t2.stop();
  await pos.query('UPDATE config SET app_logo = NULL WHERE id = 1');
});

test('varios cambios seguidos salen en una sola publicación', async () => {
  jest.useFakeTimers();
  try {
    const { createPublisher } = require('../../server/tienda-online/publisher');
    const corridas = [];
    const p = createPublisher({
      nube: {}, catalogBuilder: {}, settingsStore: { read: async () => { corridas.push(1); return { existe: true, enabled: false, slug: '' }; } },
      getLicenseId: () => 'x', logger: { warn() {} },
    });
    p.notifyCatalogChange();
    p.notifyCatalogChange();
    p.notifyCatalogChange();
    jest.advanceTimersByTime(2999);
    expect(corridas).toHaveLength(0);
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    expect(corridas).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});

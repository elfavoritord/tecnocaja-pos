'use strict';

/**
 * Fotos adicionales de la tienda (hasta 6 por producto): se guardan en el POS
 * (products.online_images), se publican como p{id}_n y la nube las entrega en
 * `imagenes` para el carrusel del detalle. SQLite real + Firestore en memoria.
 */

const request = require('supertest');
const { createSqlitePos, sqlDate } = require('../helpers/sqlite-pos');
const { createFakeFirestore } = require('../helpers/fake-firestore');
const { createTiendaOnline } = require('../../server/tienda-online');
const { leerFotosExtra } = require('../../server/tienda-online/fotos');
const { createApp } = require('../../cloud/tienda-online/lib/app');

const LIC = 'pos_ffffeeeeddddcccc';
const SLUG = 'fotos-prueba';

let pos;
let fs;
let tienda;
let app;
let productoId;
const archivos = new Map(); // ruta → buffer (el "disco" de imágenes del POS)
const borrados = [];
let siguiente = 0;

async function publicar() {
  const r = await tienda.publisher.run({ force: true });
  expect(r.ok).toBe(true);
}

async function productoPublico() {
  // App nueva en cada lectura: la nube guarda el catálogo 15 s en caché.
  app = createApp({ db: fs, FieldValue: fs.FieldValue, limits: { lectura: 1000 } });
  const res = await request(app).get(`/api/tiendas/${SLUG}`);
  expect(res.status).toBe(200);
  return res.body.productos.find((p) => p.id === productoId);
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
    processImage: async (buffer) => ({ mime: 'image/webp', data: buffer.toString('base64') }),
    readLocalImage: async (ruta) => archivos.get(ruta) || null,
    saveProductImage: async ({ productId, buffer }) => {
      siguiente += 1;
      const ruta = `/uploads/productos/prod-${productId}-${siguiente}.webp`;
      archivos.set(ruta, buffer);
      return { imageLocal: ruta };
    },
    removeProductImage: async (ruta) => { borrados.push(ruta); archivos.delete(ruta); },
    logger: { warn() {}, error() {} },
  });
  await tienda.ensureReady();
  archivos.set('/uploads/productos/principal.webp', Buffer.from('principal'));
  const r = await pos.query(
    `INSERT INTO products (codigo, nombre, categoria, precio_compra, precio_venta, stock, estado, tracks_stock, online_enabled, image_local)
     VALUES ('CAF', 'Café Premium', 'Café', 100, 150, 10, 'Activo', 1, 1, '/uploads/productos/principal.webp')`,
  );
  productoId = Number(r.insertId);
  await tienda.settingsStore.write({
    enabled: true,
    slug: SLUG,
    settings: { nombre: 'Fotos Prueba', pagos: { efectivo: { habilitado: true } } },
  });
  await publicar();
  app = createApp({ db: fs, FieldValue: fs.FieldValue, limits: { lectura: 1000 } });
});

afterAll(() => {
  tienda.stop();
  pos.close();
});

describe('fotos adicionales de la tienda', () => {
  test('sin fotos extra: solo la principal', async () => {
    const p = await productoPublico();
    expect(p.imagenes).toHaveLength(1);
    expect(p.imagen).toBe(p.imagenes[0]);
  });

  test('se agregan hasta 5 (6 con la principal); la 6.ª extra se rechaza', async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await tienda.fotos.agregar(productoId, Buffer.from(`extra-${i}`));
      expect(r.fotos).toHaveLength(i);
    }
    await expect(tienda.fotos.agregar(productoId, Buffer.from('sobra'))).rejects.toMatchObject({ statusCode: 409 });
    await publicar();
    const p = await productoPublico();
    expect(p.imagenes).toHaveLength(6);
    expect(p.imagenes[1]).toMatch(new RegExp(`/img/p${productoId}_1\\?v=`));
    const img = await request(app).get(p.imagenes[3]);
    expect(img.status).toBe(200);
    expect(img.body.toString()).toBe('extra-3');
  });

  test('mover cambia el orden del carrusel', async () => {
    const antes = (await tienda.fotos.listar(productoId)).fotos;
    const r = await tienda.fotos.mover(productoId, 2, -1);
    expect(r.fotos).toEqual([antes[1], antes[0], ...antes.slice(2)]);
    await publicar();
    const p = await productoPublico();
    expect((await request(app).get(p.imagenes[1])).body.toString()).toBe('extra-2');
  });

  test('quitar borra el archivo y la foto sobrante de la nube', async () => {
    const antes = (await tienda.fotos.listar(productoId)).fotos;
    const r = await tienda.fotos.quitar(productoId, 5);
    expect(r.fotos).toEqual(antes.slice(0, 4));
    expect(borrados).toContain(antes[4]);
    await publicar();
    const p = await productoPublico();
    expect(p.imagenes).toHaveLength(5);
    expect(fs._get(`businesses/${LIC}/tiendaImagenes/p${productoId}_5`)).toBeFalsy();
    await expect(tienda.fotos.quitar(productoId, 9)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('la nube no sirve claves de imagen inventadas', async () => {
    expect((await request(app).get(`/api/tiendas/${SLUG}/img/p${productoId}_9`)).status).toBe(404);
    expect((await request(app).get(`/api/tiendas/${SLUG}/img/..%2Fperfil`)).status).toBe(404);
  });

  test('una lista dañada en la base no rompe nada', () => {
    expect(leerFotosExtra('no es json')).toEqual([]);
    expect(leerFotosExtra(JSON.stringify(['/a.webp', '../../x y', 5, '/b.webp']))).toEqual(['/a.webp', '/b.webp']);
    expect(leerFotosExtra(null)).toEqual([]);
  });
});

'use strict';

// Pruebas propias del servicio (las de punta a punta con el POS están en
// tests/tienda-online/ del repositorio principal).

const request = require('supertest');
const { createApp } = require('../lib/app');
const { createFakeFirestore } = require('../../../tests/helpers/fake-firestore');

function seed() {
  const lic = 'pos_1111222233334444';
  return createFakeFirestore({
    'tienda_slugs/la-esquina': { licenseId: lic },
    [`businesses/${lic}/tiendaOnline/perfil`]: {
      licenseId: lic, slug: 'la-esquina', activa: true, nombre: 'La Esquina', moneda: 'RD$', tasaItbis: 18,
      pagos: [{ codigo: 'efectivo', etiqueta: 'Efectivo' }], retiro: { habilitado: true }, delivery: { habilitado: false, zonas: [] },
      categorias: ['Bebidas'], horario: null,
    },
    [`businesses/${lic}/tiendaOnline/catalogo`]: { paginas: 1, total: 1, version: 'v1' },
    [`businesses/${lic}/tiendaOnline/catalogo_p0`]: {
      productos: [{ id: 5, nombre: 'Agua', categoria: 'Bebidas', precio: 25, modoVenta: 'unidad', controlaStock: true, imagen: 'p5', imagenVersion: 'abc' }],
    },
    [`businesses/${lic}/tiendaOnline/stock`]: { items: { p5: { s: 10 } }, contador: 1001 },
    [`businesses/${lic}/tiendaImagenes/p5`]: { mime: 'image/webp', data: Buffer.from('imagen').toString('base64'), version: 'abc' },
  });
}

describe('servicio de la tienda', () => {
  test('health', async () => {
    const res = await request(createApp({ db: seed(), FieldValue: seed().FieldValue })).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('tecno-caja-tienda-online');
  });

  test('sirve la página con política de seguridad', async () => {
    const res = await request(createApp({ db: seed(), FieldValue: seed().FieldValue })).get('/t/la-esquina');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(res.text).toMatch(/\/static\/app\.js/);
  });

  test('la página lleva nombre, manifiesto e íconos de la tienda (instalable como app)', async () => {
    const db = seed();
    const app = createApp({ db, FieldValue: db.FieldValue });
    const page = await request(app).get('/t/la-esquina');
    expect(page.text).toMatch(/<title>La Esquina<\/title>/);
    expect(page.text).toMatch(/rel="manifest" href="\/t\/la-esquina\/manifest\.webmanifest/);
    expect(page.text).toMatch(/rel="apple-touch-icon" href="\/t\/la-esquina\/iconos\/180\.png/);
    const m = await request(app).get('/t/la-esquina/manifest.webmanifest');
    expect(m.status).toBe(200);
    expect(m.headers['content-type']).toMatch(/manifest\+json/);
    const manifest = JSON.parse(m.text);
    expect(manifest).toMatchObject({ name: 'La Esquina', start_url: '/t/la-esquina?app=1', scope: '/t/la-esquina', display: 'standalone' });
    expect(manifest.icons.map((i) => i.sizes)).toEqual(['192x192', '512x512', '512x512']);
    const icono = await request(app).get('/t/la-esquina/iconos/192.png');
    expect(icono.status).toBe(200);
    expect(icono.headers['content-type']).toBe('image/png');
    expect(icono.body.slice(1, 4).toString()).toBe('PNG');
    expect((await request(app).get('/t/la-esquina/iconos/999.png')).status).toBe(404);
    expect((await request(app).get('/t/otra-tienda/manifest.webmanifest')).status).toBe(404);
  });

  test('archivos de la página comprimidos, con caché larga si traen ?v=, y service worker', async () => {
    const app = createApp({ db: seed(), FieldValue: seed().FieldValue });
    const js = await request(app).get('/static/app.js?v=7').set('Accept-Encoding', 'gzip');
    expect(js.status).toBe(200);
    expect(js.headers['content-encoding']).toBe('gzip');
    expect(js.headers['cache-control']).toMatch(/immutable/);
    expect(js.text).toMatch(/Tienda online de Tecno Caja/);
    const otraVez = await request(app).get('/static/app.js?v=7').set('If-None-Match', js.headers.etag);
    expect(otraVez.status).toBe(304);
    const sinVersion = await request(app).get('/static/styles.css');
    expect(sinVersion.headers['cache-control']).toBe('public, max-age=3600');
    const sw = await request(app).get('/sw.js');
    expect(sw.status).toBe(200);
    expect(sw.headers['content-type']).toMatch(/javascript/);
    expect(sw.headers['cache-control']).toBe('no-cache');
  });

  test('catálogo público e imagen con caché larga', async () => {
    const db = seed();
    const app = createApp({ db, FieldValue: db.FieldValue });
    const res = await request(app).get('/api/tiendas/la-esquina');
    expect(res.status).toBe(200);
    expect(res.body.productos[0]).toMatchObject({ nombre: 'Agua', precio: 25, disponible: 10, agotado: false });
    const img = await request(app).get(res.body.productos[0].imagen);
    expect(img.status).toBe(200);
    expect(img.headers['cache-control']).toMatch(/immutable/);
    // Versión nueva anunciada pero la imagen aún no subió: se entrega la que hay
    // sin "guárdala un año" (antes el logo viejo quedaba pegado en el navegador).
    const adelantada = await request(app).get('/api/tiendas/la-esquina/img/p5?v=nueva');
    expect(adelantada.status).toBe(200);
    expect(adelantada.headers['cache-control']).toBe('public, max-age=30');
  });

  test('rechaza nombres de tienda inválidos y límites de pedidos', async () => {
    const db = seed();
    const app = createApp({ db, FieldValue: db.FieldValue, limits: { pedidos: 2 } });
    const noExiste = await request(app).get('/api/tiendas/API');
    expect(noExiste.status).toBe(404);
    // Un error nunca se guarda en el navegador (un "tienda cerrada" viejo dejaba la PC pegada).
    expect(noExiste.headers['cache-control']).toBe('no-store');
    const body = { idempotencyKey: 'x'.repeat(20), cliente: { nombre: 'Ana', telefono: '8091112222' }, entrega: { tipo: 'retiro' }, pago: { metodo: 'efectivo' }, items: [{ productoId: 5, cantidad: 1 }] };
    const a = await request(app).post('/api/tiendas/la-esquina/pedidos').send(body);
    const b = await request(app).post('/api/tiendas/la-esquina/pedidos').send(body);
    const c = await request(app).post('/api/tiendas/la-esquina/pedidos').send({ ...body, idempotencyKey: 'y'.repeat(20) });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(c.status).toBe(429);
  });
});

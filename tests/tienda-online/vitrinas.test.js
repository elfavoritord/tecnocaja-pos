'use strict';

/**
 * Vitrinas de la tienda (Ofertas especiales y Nuevos productos), con la base
 * SQLite real del POS → publicador → Firestore en memoria → API de la nube.
 * Salen del catálogo: ni duplican productos ni tocan precios o inventario.
 */

const request = require('supertest');
const { createSqlitePos, sqlDate } = require('../helpers/sqlite-pos');
const { createFakeFirestore } = require('../helpers/fake-firestore');
const { createTiendaOnline } = require('../../server/tienda-online');
const { createApp } = require('../../cloud/tienda-online/lib/app');
const { normalizarDiseno } = require('../../server/tienda-online/diseno');

const LIC = 'pos_vitrinas0000000';
const SLUG = 'vitrinas-prueba';
const DIA = 24 * 60 * 60 * 1000;

let pos;
let fs;
let tienda;

async function crearProducto(codigo, { publicado = 1, precio = 100, marca = null } = {}) {
  const r = await pos.query(
    `INSERT INTO products (codigo, nombre, categoria, marca, precio_compra, precio_venta, stock, estado, tracks_stock, online_enabled)
     VALUES (?, ?, 'General', ?, 10, ?, 50, 'Activo', 1, ?)`,
    [codigo, `Producto ${codigo}`, marca, precio, publicado],
  );
  return Number(r.insertId);
}

async function publicar() {
  expect((await tienda.publisher.run({ force: true })).ok).toBe(true);
}

async function vista(now) {
  const app = createApp({ db: fs, FieldValue: fs.FieldValue, limits: { lectura: 1000 }, ...(now ? { now: () => now } : {}) });
  return (await request(app).get(`/api/tiendas/${SLUG}`)).body;
}

let viejo;

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
  viejo = await crearProducto('VIEJO', { marca: 'Rica' });
  await tienda.settingsStore.write({ enabled: true, slug: SLUG, settings: { nombre: 'Vitrinas', pagos: { efectivo: { habilitado: true } } } });
  await publicar();
});

afterAll(() => {
  tienda.stop();
  pos.close();
});

describe('Nuevos productos', () => {
  test('lo que ya existía al activar la tienda no se presenta como nuevo', async () => {
    const { productos } = await vista();
    const p = productos.find((x) => x.id === viejo);
    expect(p.nuevo).toBe(false);
    expect(p.creadoEn).toBeNull();
    expect(p.marca).toBe('Rica');
  });

  test('lo registrado después sí, con su fecha, y no se vuelve a fechar', async () => {
    const id = await crearProducto('NUEVO1');
    await publicar();
    const p = (await vista()).productos.find((x) => x.id === id);
    expect(p.nuevo).toBe(true);
    expect(Date.now() - new Date(p.creadoEn).getTime()).toBeLessThan(60000);

    await pos.query(`UPDATE products SET online_created_at = '2026-01-15 10:00:00' WHERE id = ?`, [id]);
    await publicar();
    const [fila] = await pos.query('SELECT online_created_at AS f FROM products WHERE id = ?', [id]);
    expect(String(fila.f)).toContain('2026-01-15');
  });

  test('deja de ser nuevo solo, a los días configurados, sin que el POS publique', async () => {
    const id = await crearProducto('NUEVO2');
    await publicar();
    const dentro = await vista(new Date(Date.now() + 29 * DIA));
    expect(dentro.productos.find((x) => x.id === id).nuevo).toBe(true);
    const fuera = await vista(new Date(Date.now() + 31 * DIA));
    expect(fuera.productos.find((x) => x.id === id).nuevo).toBe(false);
  });

  test('un producto no se duplica ni cambia su precio o existencia', async () => {
    const [antes] = await pos.query('SELECT COUNT(*) AS n, SUM(precio_venta) AS p, SUM(stock) AS s FROM products');
    await publicar();
    const [despues] = await pos.query('SELECT COUNT(*) AS n, SUM(precio_venta) AS p, SUM(stock) AS s FROM products');
    expect(despues).toEqual(antes);
    const ids = (await vista()).productos.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Ofertas especiales respetan su vigencia', () => {
  const fecha = (d) => new Date(d).toISOString().slice(0, 10);

  async function ponerOferta(productoId, inicio, fin) {
    const r = await pos.query(
      `INSERT INTO promotions (codigo_interno, nombre, tipo, deshabilitada, permanente, fecha_inicio, fecha_fin, prioridad)
       VALUES (?, 'Oferta', 'oferta_precio', 0, 0, ?, ?, 1)`,
      [`P${productoId}`, inicio, fin],
    );
    await pos.query(
      'INSERT INTO promotion_products (promotion_id, producto_id, precio_original, precio_promocion) VALUES (?, ?, 100, 70)',
      [Number(r.insertId), productoId],
    );
  }

  test('vigente: precio anterior y actual. Vencida al otro día: sale sola, sin publicar', async () => {
    const id = await crearProducto('OFERTA1');
    await ponerOferta(id, fecha(Date.now() - DIA), fecha(Date.now() + DIA));
    await publicar();
    const hoy = (await vista()).productos.find((x) => x.id === id);
    expect(hoy.precio).toBe(70);
    expect(hoy.precioAntes).toBe(100);
    const despues = (await vista(new Date(Date.now() + 3 * DIA))).productos.find((x) => x.id === id);
    expect(despues.precio).toBe(100);
    expect(despues.precioAntes).toBeNull();
  });

  test('ya vencida al publicar: no se muestra', async () => {
    const id = await crearProducto('OFERTA2');
    await ponerOferta(id, fecha(Date.now() - 5 * DIA), fecha(Date.now() - 2 * DIA));
    await publicar();
    const p = (await vista()).productos.find((x) => x.id === id);
    expect(p.precio).toBe(100);
    expect(p.precioAntes).toBeNull();
  });

  test('todavía no empieza: no se muestra', async () => {
    const id = await crearProducto('OFERTA3');
    await ponerOferta(id, fecha(Date.now() + 2 * DIA), fecha(Date.now() + 5 * DIA));
    await publicar();
    expect((await vista()).productos.find((x) => x.id === id).precioAntes).toBeNull();
  });
});

describe('Lo que configura el administrador', () => {
  test('se guarda, se publica y llega a la página', async () => {
    const diseno = normalizarDiseno({
      secciones: [{ id: 'ofertas', activa: false }, { id: 'nuevos', titulo: 'Recién llegados' }],
      vitrinas: {
        ofertas: { cantidad: 8, velocidad: 90, direccion: 'derecha', colorFondo: '#112233' },
        nuevos: { cantidad: 12, velocidad: 25, direccion: 'izquierda', diasNuevo: 7, estiloTarjeta: 'borde' },
      },
    });
    await tienda.settingsStore.write({ settings: { diseno } });
    const guardado = await tienda.settingsStore.read();
    expect(guardado.settings.diseno.vitrinas.ofertas.velocidad).toBe(90);
    await publicar();
    const { tienda: t } = await vista();
    expect(t.diseno.vitrinas.ofertas).toMatchObject({ cantidad: 8, velocidad: 90, direccion: 'derecha', colorFondo: '#112233' });
    expect(t.diseno.vitrinas.nuevos).toMatchObject({ cantidad: 12, velocidad: 25, direccion: 'izquierda', diasNuevo: 7, estiloTarjeta: 'borde' });
    expect(t.diseno.secciones.find((s) => s.id === 'ofertas').activa).toBe(false);
    expect(t.diseno.secciones.find((s) => s.id === 'nuevos').titulo).toBe('Recién llegados');
  });

  test('los días configurados mandan', async () => {
    const id = await crearProducto('NUEVO3');
    await publicar();
    expect((await vista(new Date(Date.now() + 6 * DIA))).productos.find((x) => x.id === id).nuevo).toBe(true);
    expect((await vista(new Date(Date.now() + 8 * DIA))).productos.find((x) => x.id === id).nuevo).toBe(false);
  });

  test('guardar otra pantalla no borra el diseño', async () => {
    await tienda.settingsStore.write({ settings: { nombre: 'Otro nombre' } });
    const { settings } = await tienda.settingsStore.read();
    expect(settings.nombre).toBe('Otro nombre');
    expect(settings.diseno.vitrinas.ofertas.velocidad).toBe(90);
  });
});

test('valores fuera de rango o inválidos no entran', () => {
  const { vitrinas } = normalizarDiseno({
    vitrinas: {
      ofertas: { cantidad: 9999, velocidad: 0, direccion: 'arriba', colorFondo: 'url(x)', estiloTarjeta: '"><script>' },
      nuevos: { cantidad: 'muchos', velocidad: -5, diasNuevo: 99999 },
    },
  });
  expect(vitrinas.ofertas).toMatchObject({ cantidad: 40, velocidad: 10, direccion: 'izquierda', colorFondo: null, estiloTarjeta: 'tienda' });
  expect(vitrinas.nuevos).toMatchObject({ cantidad: 24, velocidad: 10, diasNuevo: 365 });
});

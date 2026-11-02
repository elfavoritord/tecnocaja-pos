'use strict';

// Productos y servicios en un solo catálogo: reglas del artículo, enlace con el
// catálogo de una Empresa de Servicios y miniaturas de las fotos.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { createSqlitePos } = require('../helpers/sqlite-pos');
const { esServicio, normalizarArticulo, generarCodigoArticulo } = require('../../server/services/articulos');
const { enlazarServicio, enlazarTodos } = require('../../server/routes/servicios/enlace-productos');
const { ensureServiciosSchema } = require('../../server/routes/servicios/schema');
const { createMiniaturas, rutaMiniatura } = require('../../server/services/miniaturas');

// En Windows, la caché de sharp deja la foto abierta y no se puede borrar la carpeta.
sharp.cache(false);

// La base real agrega estas columnas al arrancar (server.js); el esquema base no las trae.
async function crearPos() {
  const pos = await createSqlitePos();
  await pos.addColumnIfMissing('products', 'barcode', 'VARCHAR(120) DEFAULT NULL');
  return pos;
}

describe('reglas del artículo', () => {
  test('un servicio nunca lleva inventario, lo diga quien lo diga', () => {
    const a = normalizarArticulo({ tipoProducto: 'Servicio', codigo: ' S1 ', tracksStock: true, stock: 50, stockMin: 3, esCombo: true });
    expect(a).toMatchObject({ tipoProducto: 'servicio', codigo: 'S1', tracksStock: false, stock: 0, stockMin: 0, esCombo: false });
  });

  test('un producto queda igual: sus datos no se tocan', () => {
    const entrada = { tipoProducto: 'producto', codigo: 'A1', tracksStock: true, stock: 7, stockMin: 2 };
    expect(normalizarArticulo(entrada)).toMatchObject({ tracksStock: true, stock: 7, stockMin: 2 });
    expect(entrada.codigo).toBe('A1');
    expect(esServicio('producto')).toBe(false);
    expect(esServicio(undefined)).toBe(false);
  });

  test('sin código, se genera uno que no choca', async () => {
    const pos = await crearPos();
    try {
      const s = await generarCodigoArticulo(pos.query, 'servicio');
      expect(s).toMatch(/^SRV-\d{5}$/);
      expect(await generarCodigoArticulo(pos.query, 'producto')).toMatch(/^ART-\d{5}$/);
      await pos.query("INSERT INTO products (codigo, nombre, categoria, precio_compra, precio_venta) VALUES (?, 'Ya estaba', 'General', 0, 1)", [s]);
      const otro = await generarCodigoArticulo(pos.query, 'servicio');
      expect(otro).not.toBe(s);
    } finally {
      pos.close();
    }
  });
});

describe('enlace con el catálogo de servicios', () => {
  let pos;

  beforeEach(async () => {
    pos = await crearPos();
    await ensureServiciosSchema(pos.query);
  });
  afterEach(() => pos.close());

  async function nuevoServicio(nombre, extra = {}) {
    const r = await pos.query(
      'INSERT INTO svc_services (codigo, nombre, precio, itbis_pct, unidad, activo) VALUES (?, ?, ?, ?, ?, ?)',
      [extra.codigo ?? null, nombre, extra.precio ?? 1500, extra.itbis ?? 18, 'servicio', extra.activo ?? 1],
    );
    return Number(r.insertId);
  }
  const productos = () => pos.query("SELECT * FROM products WHERE product_type = 'servicio' ORDER BY id");

  test('crea un solo producto sin inventario, y las veces que corra no duplica', async () => {
    const id = await nuevoServicio('Mantenimiento', { codigo: 'MNT' });
    await enlazarServicio(pos.query, id);
    await enlazarTodos(pos.query);
    await enlazarTodos(pos.query);
    const filas = await productos();
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ codigo: 'MNT', nombre: 'Mantenimiento', precio_venta: 1500, tracks_stock: 0, stock: 0, aplica_itbis: 1 });
    const [s] = await pos.query('SELECT product_id FROM svc_services WHERE id = ?', [id]);
    expect(Number(s.product_id)).toBe(Number(filas[0].id));
  });

  test('editar el servicio actualiza el producto; desactivarlo lo desactiva sin borrarlo', async () => {
    const id = await nuevoServicio('Pintura');
    await enlazarServicio(pos.query, id);
    await pos.query("UPDATE svc_services SET nombre = 'Pintura interior', precio = 2000, itbis_pct = 0, activo = 0 WHERE id = ?", [id]);
    await enlazarServicio(pos.query, id);
    const filas = await productos();
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ nombre: 'Pintura interior', precio_venta: 2000, aplica_itbis: 0, estado: 'Inactivo' });
  });

  test('un código que ya usa un producto no lo pisa', async () => {
    await pos.query("INSERT INTO products (codigo, nombre, categoria, precio_compra, precio_venta) VALUES ('X1', 'Producto real', 'General', 0, 10)");
    const id = await nuevoServicio('Servicio X', { codigo: 'X1' });
    await enlazarServicio(pos.query, id);
    const [p] = await productos();
    expect(p.codigo).toBe(`SRV-${id}`);
    const [real] = await pos.query("SELECT nombre FROM products WHERE codigo = 'X1'");
    expect(real.nombre).toBe('Producto real');
  });

  test('un servicio que no existe no rompe', async () => {
    expect(await enlazarServicio(pos.query, 99999)).toBeNull();
  });
});

describe('miniaturas', () => {
  let dir;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniaturas-'));
    await sharp({ create: { width: 900, height: 600, channels: 3, background: '#336699' } }).webp().toFile(path.join(dir, 'foto.webp'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const pedir = (ruta) => new Promise((resolve) => {
    createMiniaturas({ dir, sharp })({ path: ruta }, { sendFile: resolve }, () => resolve('siguiente'));
  });

  test('la crea la primera vez, más pequeña, y deja la original', async () => {
    expect(rutaMiniatura('/uploads/products/foto.webp')).toBe('/uploads/products/foto-t.webp');
    expect(await pedir('/foto-t.webp')).toBe('siguiente');
    const meta = await sharp(path.join(dir, 'foto-t.webp')).metadata();
    expect(meta.width).toBe(240);
    expect((await sharp(path.join(dir, 'foto.webp')).metadata()).width).toBe(900);
  });

  test('otras rutas y fotos que no existen pasan de largo', async () => {
    expect(await pedir('/foto.webp')).toBe('siguiente');
    expect(await pedir('/nada-t.webp')).toBe('siguiente');
    expect(fs.existsSync(path.join(dir, 'nada-t.webp'))).toBe(false);
    expect(await pedir('/..%2F..%2Fsecreto-t.webp')).toBe('siguiente');
  });
});

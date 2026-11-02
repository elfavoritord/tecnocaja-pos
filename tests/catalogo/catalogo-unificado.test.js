'use strict';

// Catálogo de una Empresa de Servicios enlazado con products, que es lo que publica su tienda.

const { createSqlitePos } = require('../helpers/sqlite-pos');
const { esServicio, esEmpresaServicios } = require('../../server/services/articulos');
const { enlazarServicio, enlazarTodos } = require('../../server/routes/servicios/enlace-productos');
const { ensureServiciosSchema } = require('../../server/routes/servicios/schema');

// La base real agrega estas columnas al arrancar (server.js); el esquema base no las trae.
async function crearPos() {
  const pos = await createSqlitePos();
  await pos.addColumnIfMissing('products', 'barcode', 'VARCHAR(120) DEFAULT NULL');
  return pos;
}

describe('reglas', () => {
  test('qué es un servicio', () => {
    expect(esServicio('Servicio')).toBe(true);
    expect(esServicio('producto')).toBe(false);
    expect(esServicio(undefined)).toBe(false);
  });

  test('qué es una Empresa de Servicios', () => {
    expect(esEmpresaServicios({ service_company: 1 })).toBe(true);
    expect(esEmpresaServicios({ business_type: 'srv_limpieza' })).toBe(true);
    expect(esEmpresaServicios({ service_company: 0, business_type: 'colmado' })).toBe(false);
    expect(esEmpresaServicios(undefined)).toBe(false);
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

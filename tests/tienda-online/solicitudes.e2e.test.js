'use strict';

/**
 * Catálogo unificado en la tienda, de punta a punta y sin red: base SQLite real del
 * POS → publicador → Firestore en memoria → API de la nube → solicitud → POS.
 * Modalidades, cada opción por separado, y que una solicitud nunca se vuelva venta.
 */

const request = require('supertest');
const { createSqlitePos, sqlDate } = require('../helpers/sqlite-pos');
const { createFakeFirestore } = require('../helpers/fake-firestore');
const { createTiendaOnline } = require('../../server/tienda-online');
const { createApp } = require('../../cloud/tienda-online/lib/app');

const LIC = 'pos_ccccddddeeeeffff';
const SLUG = 'negocio-mixto';

let pos;
let fs;
let tienda;
let app;
const eventos = [];
let contador = 0;

const clave = () => `sol${Date.now()}${(contador += 1)}abcdefghijkl`;

function solicitud(extra = {}) {
  return {
    idempotencyKey: clave(),
    tipo: 'cotizacion',
    cliente: { nombre: 'Ana Pérez', telefono: '809-555-0101', email: 'ana@correo.test' },
    mensaje: 'Necesito precio para 3 oficinas',
    ...extra,
  };
}

async function idDe(codigo) {
  const rows = await pos.query('SELECT id FROM products WHERE codigo = ?', [codigo]);
  return Number(rows[0].id);
}

async function publicar(cambios = {}, config = 0) {
  await pos.query('UPDATE config SET service_company = ? WHERE id = 1', [config]);
  const actual = await tienda.settingsStore.read();
  await tienda.settingsStore.write({
    enabled: true,
    slug: SLUG,
    settings: { ...actual.settings, ...cambios },
  });
  const r = await tienda.publisher.run({ force: true });
  expect(r.ok).toBe(true);
  // La nube guarda la tienda unos segundos: una app nueva la lee de una vez.
  app = createApp({ db: fs, FieldValue: fs.FieldValue, limits: { pedidos: 1000, cotizar: 1000, lectura: 1000 } });
}

const leerTienda = async () => (await request(app).get(`/api/tiendas/${SLUG}`)).body;
const enviar = (cuerpo) => request(app).post(`/api/tiendas/${SLUG}/solicitudes`).send(cuerpo);

function pedido(items) {
  return {
    idempotencyKey: clave(),
    cliente: { nombre: 'Juan Pérez', telefono: '829-000-0000' },
    entrega: { tipo: 'retiro' },
    pago: { metodo: 'efectivo' },
    items,
  };
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
    getIo: () => ({ emit: (e, p) => eventos.push([e, p]) }),
    mapClientRow: (row) => ({ id: Number(row.id), nombre: row.nombre, telefono: row.telefono }),
    logger: { warn() {}, error() {} },
  });
  await tienda.ensureReady();
  await pos.addColumnIfMissing('config', 'service_company', 'TINYINT NOT NULL DEFAULT 0');
  const insert = `INSERT INTO products (codigo, nombre, categoria, precio_compra, precio_venta, stock, estado, aplica_itbis, tracks_stock, online_enabled, product_type)
                  VALUES (?, ?, ?, ?, ?, ?, 'Activo', ?, ?, 1, ?)`;
  await pos.query(insert, ['CAB', 'Cable HDMI', 'Accesorios', 100, 300, 5, 1, 1, 'producto']);
  await pos.query(insert, ['LIM', 'Limpieza de oficina', 'Servicios', 0, 2500, 0, 1, 0, 'servicio']);
  await publicar({
    nombre: 'Negocio Mixto',
    telefono: '8095550000',
    pagos: { efectivo: { habilitado: true } },
  });
});

afterAll(() => {
  tienda.stop();
  pos.close();
});

describe('Modalidades de la tienda', () => {
  test('una tienda de antes sigue igual: productos y servicios, y los dos se compran', async () => {
    const { tienda: t, productos } = await leerTienda();
    expect(t.modalidad).toBe('mixta');
    const cable = productos.find((p) => p.nombre === 'Cable HDMI');
    const limpieza = productos.find((p) => p.nombre === 'Limpieza de oficina');
    expect(cable).toMatchObject({ tipo: 'producto', comprable: true, precioOculto: false });
    expect(limpieza).toMatchObject({ tipo: 'servicio', comprable: true, precio: 2500, disponible: null, agotado: false });
  });

  test('solo productos: los servicios no salen ni se pueden pedir', async () => {
    await publicar({ modalidad: 'productos' });
    const { productos } = await leerTienda();
    expect(productos.map((p) => p.nombre)).toEqual(['Cable HDMI']);
    const res = await request(app).post(`/api/tiendas/${SLUG}/pedidos`)
      .send(pedido([{ productoId: await idDe('LIM'), cantidad: 1 }]));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('solo servicios: los productos no salen ni se pueden comprar', async () => {
    await publicar({ modalidad: 'servicios' });
    const { productos, tienda: t } = await leerTienda();
    expect(t.modalidad).toBe('servicios');
    expect(productos.map((p) => p.nombre)).toEqual(['Limpieza de oficina']);
    const res = await request(app).post(`/api/tiendas/${SLUG}/pedidos`)
      .send(pedido([{ productoId: await idDe('CAB'), cantidad: 1 }]));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('una Empresa de Servicios siempre es solo servicios y sin carrito', async () => {
    await publicar({ modalidad: 'mixta', serviciosTienda: { contratar: true, cotizacion: true, cita: false, whatsapp: true, mostrarPrecio: true } }, 1);
    const { productos, tienda: t } = await leerTienda();
    expect(t.modalidad).toBe('servicios');
    expect(productos.map((p) => p.nombre)).toEqual(['Limpieza de oficina']);
    expect(productos[0].comprable).toBe(false);
    const res = await request(app).post(`/api/tiendas/${SLUG}/pedidos`)
      .send(pedido([{ productoId: await idDe('LIM'), cantidad: 1 }]));
    expect(res.status).toBeGreaterThanOrEqual(400);
    await publicar({}, 0);
  });
});

describe('Cada opción por separado', () => {
  const base = { contratar: true, cotizacion: true, cita: false, whatsapp: true, mostrarPrecio: true };

  test('sin "contratar", el servicio se ve con su precio pero el carrito lo rechaza', async () => {
    await publicar({ modalidad: 'mixta', serviciosTienda: { ...base, contratar: false } });
    const { productos } = await leerTienda();
    const limpieza = productos.find((p) => p.tipo === 'servicio');
    expect(limpieza).toMatchObject({ comprable: false, precio: 2500, precioOculto: false });
    const res = await request(app).post(`/api/tiendas/${SLUG}/pedidos`)
      .send(pedido([{ productoId: limpieza.id, cantidad: 1 }]));
    expect(res.status).toBeGreaterThanOrEqual(400);
    // El producto de al lado sigue vendiéndose.
    expect(productos.find((p) => p.tipo === 'producto').comprable).toBe(true);
  });

  test('con el precio oculto, el precio no sale de la nube por ningún lado', async () => {
    await publicar({ modalidad: 'mixta', serviciosTienda: { ...base, mostrarPrecio: false } });
    const cuerpo = await leerTienda();
    const limpieza = cuerpo.productos.find((p) => p.tipo === 'servicio');
    expect(limpieza).toMatchObject({ precio: 0, precioAntes: null, precioOculto: true, comprable: false });
    expect(JSON.stringify(limpieza)).not.toMatch(/2500/);
    const r = await enviar(solicitud({ productoId: limpieza.id }));
    expect(r.status).toBe(201);
    await tienda.sync.recibirSolicitudes();
    const [recibida] = await tienda.solicitudes.listar();
    expect(recibida.precio).toBeNull();
  });

  test('cotización y cita apagadas se rechazan aunque alguien llame directo a la API', async () => {
    await publicar({ modalidad: 'mixta', serviciosTienda: { ...base, cotizacion: false, cita: false } });
    expect((await enviar(solicitud())).status).toBe(409);
    expect((await enviar(solicitud({ tipo: 'cita', fecha: '2026-12-01' }))).status).toBe(409);
    // Una consulta suelta no depende de esas opciones.
    expect((await enviar(solicitud({ tipo: 'consulta' }))).status).toBe(201);
  });

  test('la tienda le dice a la página qué botones van', async () => {
    await publicar({ modalidad: 'mixta', serviciosTienda: { ...base, cita: true, whatsapp: false } });
    const { tienda: t } = await leerTienda();
    expect(t.solicitudes).toEqual({ cotizacion: true, cita: true, whatsapp: false });
  });
});

describe('Solicitudes', () => {
  let limpiezaId;

  beforeAll(async () => {
    await publicar({ modalidad: 'mixta', serviciosTienda: { contratar: false, cotizacion: true, cita: true, whatsapp: true, mostrarPrecio: true } });
    limpiezaId = await idDe('LIM');
  });

  test('valida lo mínimo y atrapa al robot', async () => {
    expect((await enviar(solicitud({ cliente: { nombre: 'A', telefono: '8095550101' } }))).status).toBe(400);
    expect((await enviar(solicitud({ cliente: { nombre: 'Ana', telefono: '12' } }))).status).toBe(400);
    expect((await enviar(solicitud({ cliente: { nombre: 'Ana', telefono: '8095550101', email: 'no-es-correo' } }))).status).toBe(400);
    expect((await enviar(solicitud({ tipo: 'venta' }))).status).toBe(400);
    expect((await enviar(solicitud({ tipo: 'cita' }))).status).toBe(400); // sin fecha
    expect((await enviar(solicitud({ website: 'https://spam.test' }))).status).toBe(400);
    expect((await enviar(solicitud({ productoId: 999999 }))).status).toBe(409);
  });

  test('doble clic: una sola solicitud; llega al POS una vez y no crea venta ni factura', async () => {
    const ventasAntes = (await pos.query('SELECT COUNT(*) AS n FROM sales'))[0].n;
    const stockAntes = (await pos.query("SELECT stock FROM products WHERE codigo = 'CAB'"))[0].stock;
    const cuerpo = solicitud({ productoId: limpiezaId });
    const a = await enviar(cuerpo);
    const b = await enviar(cuerpo);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.repetida).toBe(true);

    await tienda.sync.recibirSolicitudes();
    await tienda.sync.recibirSolicitudes(); // reconexión: no duplica
    const solicitudes = await tienda.solicitudes.listar();
    const mias = solicitudes.filter((s) => s.articulo === 'Limpieza de oficina' && s.mensaje === cuerpo.mensaje && s.precio === 2500);
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({
      tipo: 'cotizacion',
      estado: 'nueva',
      productoId: limpiezaId,
      cliente: { nombre: 'Ana Pérez', telefono: '8095550101', email: 'ana@correo.test' },
    });
    expect(eventos.some(([e]) => e === 'tienda-online:nueva-solicitud')).toBe(true);
    expect((await pos.query('SELECT COUNT(*) AS n FROM sales'))[0].n).toBe(ventasAntes);
    expect((await pos.query("SELECT stock FROM products WHERE codigo = 'CAB'"))[0].stock).toBe(stockAntes);
  });

  test('una cita lleva la fecha y la hora que pidió el cliente', async () => {
    const r = await enviar(solicitud({ tipo: 'cita', productoId: limpiezaId, fecha: '2026-12-15', hora: '10:30', mensaje: 'Por la mañana' }));
    expect(r.status).toBe(201);
    await tienda.sync.recibirSolicitudes();
    const cita = (await tienda.solicitudes.listar()).find((s) => s.tipo === 'cita' && s.mensaje === 'Por la mañana');
    expect(cita).toMatchObject({ fecha: '2026-12-15', hora: '10:30' });
  });

  test('el negocio la lleva de estado en estado; un estado inventado no entra', async () => {
    const [s] = await tienda.solicitudes.listar();
    await tienda.solicitudes.cambiar(s.id, { estado: 'en_revision' });
    await tienda.solicitudes.cambiar(s.id, { estado: 'convertida', referencia: 'Cotización COT-1' });
    const leida = (await tienda.solicitudes.listar()).find((x) => x.id === s.id);
    expect(leida).toMatchObject({ estado: 'convertida', referencia: 'Cotización COT-1' });
    await expect(tienda.solicitudes.cambiar(s.id, { estado: 'facturada' })).rejects.toThrow('Estado inválido');
    expect((await tienda.solicitudes.listar({ estado: 'convertida' })).map((x) => x.id)).toContain(s.id);
    expect(await tienda.solicitudes.contarNuevas()).toBeGreaterThanOrEqual(0);
  });
});

describe('Publicación automática', () => {
  test('apagada, lo nuevo no se publica solo', async () => {
    await publicar({ modalidad: 'mixta', publicacionAutomatica: false, serviciosTienda: { contratar: true, cotizacion: true, cita: false, whatsapp: true, mostrarPrecio: true } });
    await pos.query(`INSERT INTO products (codigo, nombre, categoria, precio_compra, precio_venta, stock, estado, online_enabled, product_type)
                     VALUES ('NUE1', 'Nuevo sin publicar', 'General', 0, 10, 1, 'Activo', 0, 'producto')`);
    await publicar();
    const { productos } = await leerTienda();
    expect(productos.map((p) => p.nombre)).not.toContain('Nuevo sin publicar');
  });

  test('encendida, se publica una sola vez: si el dueño lo oculta, no vuelve', async () => {
    await publicar({ publicacionAutomatica: true });
    await pos.query(`INSERT INTO products (codigo, nombre, categoria, precio_compra, precio_venta, stock, estado, online_enabled, product_type, tracks_stock)
                     VALUES ('NUE2', 'Asesoría nueva', 'Servicios', 0, 900, 0, 'Activo', 0, 'servicio', 0)`);
    await publicar();
    let { productos } = await leerTienda();
    expect(productos.map((p) => p.nombre)).toContain('Asesoría nueva');
    // El que ya existía antes de encender no se publica de golpe.
    expect(productos.map((p) => p.nombre)).not.toContain('Nuevo sin publicar');

    await pos.query("UPDATE products SET online_enabled = 0 WHERE codigo = 'NUE2'");
    await publicar();
    ({ productos } = await leerTienda());
    expect(productos.map((p) => p.nombre)).not.toContain('Asesoría nueva');
  });
});

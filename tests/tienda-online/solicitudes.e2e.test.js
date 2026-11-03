'use strict';

/**
 * La tienda según el tipo de negocio, de punta a punta y sin red: base SQLite real del
 * POS → publicador → Firestore en memoria → API de la nube → solicitud → POS.
 *
 * Un negocio con POS vende como siempre, aunque tenga artículos tipo Servicio.
 * Solo una Empresa de Servicios muestra sus servicios y recibe solicitudes.
 */

const request = require('supertest');
const { createSqlitePos, sqlDate } = require('../helpers/sqlite-pos');
const { createFakeFirestore } = require('../helpers/fake-firestore');
const { createTiendaOnline } = require('../../server/tienda-online');
const { createApp } = require('../../cloud/tienda-online/lib/app');

const LIC = 'pos_ccccddddeeeeffff';
const SLUG = 'negocio-prueba';

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

async function publicar(cambios = {}, empresaServicios = 0) {
  await pos.query('UPDATE config SET service_company = ? WHERE id = 1', [empresaServicios]);
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
const pedir = (items) => request(app).post(`/api/tiendas/${SLUG}/pedidos`).send({
  idempotencyKey: clave(),
  cliente: { nombre: 'Juan Pérez', telefono: '829-000-0000' },
  entrega: { tipo: 'retiro' },
  pago: { metodo: 'efectivo' },
  items,
});

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
  await pos.addColumnIfMissing('config', 'service_products_enabled', 'TINYINT NOT NULL DEFAULT 0');
  const insert = `INSERT INTO products (codigo, nombre, categoria, precio_compra, precio_venta, stock, estado, aplica_itbis, tracks_stock, online_enabled, product_type)
                  VALUES (?, ?, ?, ?, ?, ?, 'Activo', ?, ?, 1, ?)`;
  await pos.query(insert, ['CAB', 'Cable HDMI', 'Accesorios', 100, 300, 5, 1, 1, 'producto']);
  await pos.query(insert, ['LIM', 'Limpieza de oficina', 'Servicios', 0, 2500, 0, 1, 0, 'servicio']);
  await publicar({ nombre: 'Negocio Prueba', telefono: '8095550000', pagos: { efectivo: { habilitado: true } } });
});

afterAll(() => {
  tienda.stop();
  pos.close();
});

describe('Negocio con POS: la tienda sigue como estaba', () => {
  // Datos que pudo guardar la 1.6.11: no cambian nada.
  const guardado = { modalidad: 'servicios', publicacionAutomatica: true, serviciosTienda: { contratar: false, cotizacion: true, cita: true, whatsapp: true, mostrarPrecio: false } };

  beforeAll(() => publicar(guardado));

  test('todo lo publicado se muestra y se vende, y un servicio se ve como un artículo más', async () => {
    const { tienda: t, productos } = await leerTienda();
    expect(t.modalidad).toBe('productos');
    expect(t.solicitudes).toEqual({ cotizacion: false, cita: false, whatsapp: false });
    expect(productos.map((p) => p.nombre).sort()).toEqual(['Cable HDMI', 'Limpieza de oficina']);
    for (const p of productos) expect(p).toMatchObject({ tipo: 'producto', comprable: true, precioOculto: false });
    expect(productos.find((p) => p.nombre === 'Limpieza de oficina').precio).toBe(2500);
  });

  test('el carrito acepta el artículo tipo Servicio', async () => {
    const res = await pedir([{ productoId: await idDe('LIM'), cantidad: 1 }]);
    expect(res.status).toBe(201);
  });

  test('no recibe solicitudes de ningún tipo, ni llamando directo a la API', async () => {
    for (const extra of [{}, { tipo: 'cita', fecha: '2026-12-01' }, { tipo: 'consulta' }]) {
      expect((await enviar(solicitud(extra))).status).toBe(409);
    }
  });

  test('un perfil de un POS anterior se porta igual', async () => {
    const lic = 'pos_9999888877776666';
    const viejo = createFakeFirestore({
      'tienda_slugs/vieja': { licenseId: lic },
      [`businesses/${lic}/tiendaOnline/perfil`]: {
        licenseId: lic, slug: 'vieja', activa: true, nombre: 'Vieja', moneda: 'RD$', tasaItbis: 18,
        pagos: [{ codigo: 'efectivo', etiqueta: 'Efectivo' }], retiro: { habilitado: true }, delivery: { habilitado: false }, categorias: [], horario: null,
      },
      [`businesses/${lic}/tiendaOnline/catalogo`]: { paginas: 1, total: 1, version: 'v1' },
      [`businesses/${lic}/tiendaOnline/catalogo_p0`]: { productos: [{ id: 1, nombre: 'Agua', categoria: 'B', precio: 25, modoVenta: 'unidad', controlaStock: false, itbis: false }] },
      [`businesses/${lic}/tiendaOnline/stock`]: { items: {}, contador: 1 },
    });
    const r = await request(createApp({ db: viejo, FieldValue: viejo.FieldValue })).get('/api/tiendas/vieja');
    expect(r.body.tienda.solicitudes).toEqual({ cotizacion: false, cita: false, whatsapp: false });
    expect(r.body.productos[0]).toMatchObject({ tipo: 'producto', comprable: true });
  });

  test('la publicación automática no le aplica', async () => {
    await pos.query(`INSERT INTO products (codigo, nombre, categoria, precio_compra, precio_venta, stock, estado, online_enabled, product_type)
                     VALUES ('NUEPOS', 'Nuevo en POS', 'General', 0, 10, 1, 'Activo', 0, 'producto')`);
    await publicar();
    const { productos } = await leerTienda();
    expect(productos.map((p) => p.nombre)).not.toContain('Nuevo en POS');
  });

  test('no busca solicitudes en la nube', async () => {
    const r = await tienda.solicitudes.recibirPendientes();
    expect(r).toEqual({ nuevas: 0 });
    expect(eventos.filter(([e]) => e === 'tienda-online:nueva-solicitud')).toHaveLength(0);
  });
});

describe('Empresa de Servicios', () => {
  const base = { cotizacion: true, cita: false, whatsapp: true, mostrarPrecio: true };

  test('solo muestra sus servicios y no los vende por carrito', async () => {
    await publicar({ serviciosTienda: base }, 1);
    const { productos, tienda: t } = await leerTienda();
    expect(t.modalidad).toBe('servicios');
    expect(productos.map((p) => p.nombre)).toEqual(['Limpieza de oficina']);
    expect(productos[0]).toMatchObject({ tipo: 'servicio', comprable: false, precio: 2500, disponible: null });
    expect((await pedir([{ productoId: productos[0].id, cantidad: 1 }])).status).toBeGreaterThanOrEqual(400);
    expect((await pedir([{ productoId: await idDe('CAB'), cantidad: 1 }])).status).toBeGreaterThanOrEqual(400);
  });

  test('con el precio oculto, el precio no sale de la nube por ningún lado', async () => {
    await publicar({ serviciosTienda: { ...base, mostrarPrecio: false } }, 1);
    const { productos } = await leerTienda();
    expect(productos[0]).toMatchObject({ precio: 0, precioAntes: null, precioOculto: true });
    expect(JSON.stringify(productos[0])).not.toMatch(/2500/);
    expect((await enviar(solicitud({ productoId: productos[0].id, mensaje: 'Sin precio' }))).status).toBe(201);
    await tienda.solicitudes.recibirPendientes();
    const recibida = (await tienda.solicitudes.listar()).find((s) => s.mensaje === 'Sin precio');
    expect(recibida.precio).toBeNull();
  });

  test('cotización y cita apagadas se rechazan aunque alguien llame directo a la API', async () => {
    await publicar({ serviciosTienda: { ...base, cotizacion: false, cita: false } }, 1);
    expect((await enviar(solicitud())).status).toBe(409);
    expect((await enviar(solicitud({ tipo: 'cita', fecha: '2026-12-01' }))).status).toBe(409);
    expect((await enviar(solicitud({ tipo: 'consulta' }))).status).toBe(201);
  });

  test('la tienda le dice a la página qué botones van', async () => {
    await publicar({ serviciosTienda: { ...base, cita: true, whatsapp: false } }, 1);
    const { tienda: t } = await leerTienda();
    expect(t.solicitudes).toEqual({ cotizacion: true, cita: true, whatsapp: false });
  });

  describe('Solicitudes', () => {
    let limpiezaId;

    beforeAll(async () => {
      await publicar({ serviciosTienda: { ...base, cita: true } }, 1);
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
      const cuerpo = solicitud({ productoId: limpiezaId, mensaje: 'Son tres oficinas' });
      const a = await enviar(cuerpo);
      const b = await enviar(cuerpo);
      expect(a.status).toBe(201);
      expect(b.status).toBe(200);
      expect(b.body.repetida).toBe(true);

      await tienda.sync.recibirSolicitudes();
      await tienda.sync.recibirSolicitudes(); // reconexión: no duplica
      const mias = (await tienda.solicitudes.listar()).filter((s) => s.mensaje === 'Son tres oficinas');
      expect(mias).toHaveLength(1);
      expect(mias[0]).toMatchObject({
        tipo: 'cotizacion',
        estado: 'nueva',
        articulo: 'Limpieza de oficina',
        precio: 2500,
        productoId: limpiezaId,
        cliente: { nombre: 'Ana Pérez', telefono: '8095550101', email: 'ana@correo.test' },
      });
      expect(eventos.some(([e]) => e === 'tienda-online:nueva-solicitud')).toBe(true);
      expect((await pos.query('SELECT COUNT(*) AS n FROM sales'))[0].n).toBe(ventasAntes);
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
    });
  });

  describe('Si también vende productos', () => {
    beforeAll(async () => {
      await pos.query('UPDATE config SET service_products_enabled = 1 WHERE id = 1');
      await publicar({ serviciosTienda: { ...base, cita: true } }, 1);
    });
    afterAll(async () => {
      await pos.query('UPDATE config SET service_products_enabled = 0 WHERE id = 1');
      await publicar({}, 1);
    });

    test('muestra productos y servicios, sin carrito', async () => {
      const { productos, tienda: t } = await leerTienda();
      expect(t).toMatchObject({ modalidad: 'servicios', conProductos: true });
      const cable = productos.find((p) => p.nombre === 'Cable HDMI');
      expect(cable).toMatchObject({ tipo: 'producto', comprable: false, precio: 300 });
      expect(productos.find((p) => p.nombre === 'Limpieza de oficina')).toMatchObject({ tipo: 'servicio', comprable: false });
      expect((await pedir([{ productoId: cable.id, cantidad: 1 }])).status).toBeGreaterThanOrEqual(400);
    });

    test('un producto se solicita igual que un servicio', async () => {
      const cable = await idDe('CAB');
      const r = await enviar(solicitud({ productoId: cable, mensaje: 'Quiero 5 cables' }));
      expect(r.status).toBe(201);
      await tienda.sync.recibirSolicitudes();
      const s = (await tienda.solicitudes.listar()).find((x) => x.mensaje === 'Quiero 5 cables');
      expect(s).toMatchObject({ articulo: 'Cable HDMI', precio: 300, productoId: cable, servicioId: null });
    });

    test('el precio oculto solo aplica a los servicios', async () => {
      await publicar({ serviciosTienda: { ...base, mostrarPrecio: false } }, 1);
      const { productos } = await leerTienda();
      expect(productos.find((p) => p.nombre === 'Cable HDMI')).toMatchObject({ precio: 300, precioOculto: false });
      expect(productos.find((p) => p.nombre === 'Limpieza de oficina')).toMatchObject({ precio: 0, precioOculto: true });
      await publicar({ serviciosTienda: { ...base, cita: true } }, 1);
    });
  });

  describe('Publicación automática', () => {
    const insertar = (codigo, nombre) => pos.query(
      `INSERT INTO products (codigo, nombre, categoria, precio_compra, precio_venta, stock, estado, online_enabled, product_type, tracks_stock)
       VALUES (?, ?, 'Servicios', 0, 900, 0, 'Activo', 0, 'servicio', 0)`,
      [codigo, nombre],
    );

    test('apagada, lo nuevo no se publica solo', async () => {
      await publicar({ publicacionAutomatica: false }, 1);
      await insertar('NUE1', 'Nuevo sin publicar');
      await publicar({}, 1);
      expect((await leerTienda()).productos.map((p) => p.nombre)).not.toContain('Nuevo sin publicar');
    });

    test('encendida, se publica una sola vez: si el dueño lo oculta, no vuelve', async () => {
      await publicar({ publicacionAutomatica: true }, 1);
      await insertar('NUE2', 'Asesoría nueva');
      await publicar({}, 1);
      const nombres = (await leerTienda()).productos.map((p) => p.nombre);
      expect(nombres).toContain('Asesoría nueva');
      // El que ya existía antes de encender no se publica de golpe.
      expect(nombres).not.toContain('Nuevo sin publicar');

      await pos.query("UPDATE products SET online_enabled = 0 WHERE codigo = 'NUE2'");
      await publicar({}, 1);
      expect((await leerTienda()).productos.map((p) => p.nombre)).not.toContain('Asesoría nueva');
    });
  });
});

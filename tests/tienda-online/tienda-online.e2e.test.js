'use strict';

/**
 * Tienda online de punta a punta, sin red:
 *   base SQLite real del POS → publicador → Firestore en memoria → API de la
 *   nube (cloud/tienda-online) → pedido → sincronización al POS → cobro
 *   (ligado a la venta) → estado de vuelta a la nube.
 *
 * Cubre lo que pidió Emilio: precios del servidor, agotados, dos clientes por
 * la última unidad, doble clic / reintento, pedido que no se duplica al
 * reconectar, una sola conversión aunque dos cajas lo intenten, reserva que se
 * libera una sola vez y precio del pedido respetado.
 */

const request = require('supertest');
const { createSqlitePos, sqlDate } = require('../helpers/sqlite-pos');
const { createFakeFirestore } = require('../helpers/fake-firestore');
const { createTiendaOnline } = require('../../server/tienda-online');
const { createApp } = require('../../cloud/tienda-online/lib/app');

const LIC = 'pos_aaaabbbbccccdddd';
const SLUG = 'colmado-prueba';

let pos;
let fs;
let tienda;
let app;
const eventos = [];

function clave() {
  return `k${Date.now()}${Math.random().toString(36).slice(2, 12)}abcdef`;
}

function pedidoBody(items, extra = {}) {
  return {
    idempotencyKey: clave(),
    cliente: { nombre: 'Juan Pérez', telefono: '829-000-0000' },
    entrega: { tipo: 'retiro' },
    pago: { metodo: 'efectivo' },
    items,
    ...extra,
  };
}

async function productoId(codigo) {
  const rows = await pos.query('SELECT id FROM products WHERE codigo = ?', [codigo]);
  return Number(rows[0].id);
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
  await pos.query('UPDATE config SET tax_rate = 18 WHERE id = 1');
  const insert = `INSERT INTO products (codigo, nombre, categoria, precio_compra, precio_venta, stock, estado, aplica_itbis, tracks_stock, online_enabled)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await pos.query(insert, ['ARZ', 'Arroz 10 lb', 'Granos', 400, 500, 3, 'Activo', 0, 1, 1]);
  await pos.query(insert, ['COC', 'Coca-Cola 2L', 'Bebidas', 100, 150, 10, 'Activo', 1, 1, 1]);
  await pos.query(insert, ['PAN', 'Pan', 'Panadería', 30, 60, 0, 'Activo', 0, 0, 1]);
  await pos.query(insert, ['OCU', 'No publicado', 'Granos', 1, 2, 5, 'Activo', 0, 1, 0]);
  await pos.query(insert, ['INA', 'Inactivo', 'Granos', 1, 2, 5, 'Inactivo', 0, 1, 1]);
  await tienda.settingsStore.write({
    enabled: true,
    slug: SLUG,
    settings: {
      nombre: 'Colmado Prueba',
      pagos: { efectivo: { habilitado: true }, transferencia: { habilitado: true, instrucciones: 'Banco X' } },
      delivery: { habilitado: true, zonas: [{ id: 'vm', nombre: 'Villa Mella', costo: 150, activa: true }] },
    },
  });
  const r = await tienda.publisher.run({ force: true });
  expect(r.ok).toBe(true);
  app = createApp({ db: fs, FieldValue: fs.FieldValue, limits: { pedidos: 1000, cotizar: 1000, lectura: 1000 } });
});

afterAll(() => {
  tienda.stop();
  pos.close();
});

describe('Publicación desde el POS', () => {
  test('publica solo productos activos y marcados, con la existencia de la sucursal', async () => {
    const res = await request(app).get(`/api/tiendas/${SLUG}`);
    expect(res.status).toBe(200);
    const nombres = res.body.productos.map((p) => p.nombre).sort();
    expect(nombres).toEqual(['Arroz 10 lb', 'Coca-Cola 2L', 'Pan']);
    const arroz = res.body.productos.find((p) => p.nombre === 'Arroz 10 lb');
    expect(arroz.disponible).toBe(3);
    expect(res.body.productos.find((p) => p.nombre === 'Pan').disponible).toBeNull();
    // Nunca se publica el costo.
    expect(JSON.stringify(res.body)).not.toMatch(/precio_compra|precioCompra/);
    expect(res.body.tienda.delivery.zonas).toEqual([{ id: 'vm', nombre: 'Villa Mella', costo: 150 }]);
  });

  test('una dirección que no existe da 404', async () => {
    const res = await request(app).get('/api/tiendas/otra-tienda');
    expect(res.status).toBe(404);
  });
});

describe('Checkout en la nube', () => {
  test('el precio y el ITBIS los pone el servidor aunque el navegador mande otros', async () => {
    const coca = await productoId('COC');
    const body = pedidoBody([{ productoId: coca, cantidad: 2, precio: 0.01, total: 0.01 }]);
    body.totales = { total: 1 };
    const res = await request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(body);
    expect(res.status).toBe(201);
    const pedido = fs._get(`businesses/${LIC}/pedidosOnline/${res.body.pedidoId}`);
    expect(pedido.items[0].precioUnitario).toBe(150);
    expect(pedido.totales.subtotal).toBe(300);
    expect(pedido.totales.itbis).toBe(54);
    expect(pedido.totales.total).toBe(354);
    expect(pedido.estado).toBe('nuevo');
    expect(pedido.pos.importado).toBe(false);
  });

  test('doble clic / reintento con la misma clave crea un solo pedido', async () => {
    const coca = await productoId('COC');
    const body = pedidoBody([{ productoId: coca, cantidad: 1 }]);
    const a = await request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(body);
    const b = await request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.repetido).toBe(true);
    expect(b.body.pedidoId).toBe(a.body.pedidoId);
    expect(b.body.token).toBe(a.body.token);
  });

  test('dos clientes por las últimas unidades: solo uno se las lleva', async () => {
    const arroz = await productoId('ARZ');
    const [r1, r2] = await Promise.all([
      request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(pedidoBody([{ productoId: arroz, cantidad: 2 }])),
      request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(pedidoBody([{ productoId: arroz, cantidad: 2 }])),
    ]);
    const estados = [r1.status, r2.status].sort();
    expect(estados).toEqual([201, 409]);
    const fallido = r1.status === 409 ? r1 : r2;
    expect(fallido.body.code).toBe('AGOTADO');
    const stock = fs._get(`businesses/${LIC}/tiendaOnline/stock`);
    expect(stock.items[`p${arroz}`]).toEqual({ s: 3, r: 2 });
  });

  test('agotado: no deja pedir más de lo disponible', async () => {
    const arroz = await productoId('ARZ');
    const res = await request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(pedidoBody([{ productoId: arroz, cantidad: 2 }]));
    expect(res.status).toBe(409);
    expect(res.body.errores[0].disponible).toBe(1);
  });

  test('producto no publicado o inexistente se rechaza', async () => {
    const oculto = await productoId('OCU');
    const res = await request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(pedidoBody([{ productoId: oculto, cantidad: 1 }]));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CARRITO');
  });

  test('delivery exige zona y dirección; el costo sale de la zona', async () => {
    const coca = await productoId('COC');
    const sinZona = await request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(pedidoBody([{ productoId: coca, cantidad: 1 }], {
      entrega: { tipo: 'delivery', direccion: 'Calle 1 #2', sector: 'Centro' },
    }));
    expect(sinZona.status).toBe(400);
    const ok = await request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(pedidoBody([{ productoId: coca, cantidad: 1 }], {
      entrega: { tipo: 'delivery', zonaId: 'vm', direccion: 'Calle 1 #2', sector: 'Los Guaricanos' },
      pago: { metodo: 'transferencia' },
    }));
    expect(ok.status).toBe(201);
    const pedido = fs._get(`businesses/${LIC}/pedidosOnline/${ok.body.pedidoId}`);
    expect(pedido.totales.delivery).toBe(150);
    expect(pedido.entrega.zonaNombre).toBe('Villa Mella');
    expect(pedido.pago.etiqueta).toBe('Transferencia bancaria');
  });

  test('método de pago no habilitado y datos incompletos se rechazan', async () => {
    const coca = await productoId('COC');
    const pago = await request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(pedidoBody([{ productoId: coca, cantidad: 1 }], { pago: { metodo: 'tarjeta' } }));
    expect(pago.status).toBe(400);
    const nombre = await request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(pedidoBody([{ productoId: coca, cantidad: 1 }], { cliente: { nombre: '', telefono: '8290000000' } }));
    expect(nombre.status).toBe(400);
    const bot = await request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(pedidoBody([{ productoId: coca, cantidad: 1 }], { website: 'spam' }));
    expect(bot.status).toBe(400);
  });

  test('seguimiento con el enlace; sin el token no se ve', async () => {
    const coca = await productoId('COC');
    const r = await request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(pedidoBody([{ productoId: coca, cantidad: 1 }]));
    const ok = await request(app).get(`/api/tiendas/${SLUG}/pedidos/${r.body.pedidoId}?k=${r.body.token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.numero).toBe(r.body.numero);
    expect(ok.body.mensajes[0].texto).toMatch(/Hemos recibido/);
    const mal = await request(app).get(`/api/tiendas/${SLUG}/pedidos/${r.body.pedidoId}?k=${'0'.repeat(32)}`);
    expect(mal.status).toBe(404);
  });
});

describe('POS: recepción, estados y conversión en venta', () => {
  let pedidoArroz;

  test('recibe los pedidos una sola vez aunque se repita la sincronización', async () => {
    const r1 = await tienda.sync.pollOnce();
    expect(r1.importados).toBeGreaterThan(0);
    const total1 = (await pos.query('SELECT COUNT(*) AS n FROM online_orders'))[0].n;
    const r2 = await tienda.sync.pollOnce();
    expect(r2.importados).toBe(0);
    const total2 = (await pos.query('SELECT COUNT(*) AS n FROM online_orders'))[0].n;
    expect(total2).toBe(total1);
    // Un mismo documento importado dos veces (reconexión) no se duplica.
    const cualquiera = (await pos.query('SELECT cloud_id FROM online_orders LIMIT 1'))[0].cloud_id;
    const doc = fs._get(`businesses/${LIC}/pedidosOnline/${cualquiera}`);
    const again = await tienda.orders.importOrder(cualquiera, doc, { licenseId: LIC });
    expect(again.inserted).toBe(false);
    expect(eventos.some(([e]) => e === 'tienda-online:nuevo-pedido')).toBe(true);
    const arroz = await productoId('ARZ');
    const rows = await pos.query(
      `SELECT o.id FROM online_orders o JOIN online_order_items i ON i.order_id = o.id WHERE i.product_id = ?`,
      [arroz],
    );
    pedidoArroz = Number(rows[0].id);
  });

  test('no se puede despachar ni entregar sin venta; no se puede rechazar con venta', async () => {
    await expect(tienda.orders.changeStatus(pedidoArroz, 'entregado', {})).rejects.toMatchObject({ statusCode: 409 });
    const p = await tienda.orders.changeStatus(pedidoArroz, 'confirmado', { actor: { id: 1, nombre: 'Admin' } });
    expect(p.estado).toBe('confirmado');
    await expect(tienda.orders.changeStatus(pedidoArroz, 'rechazado', {})).rejects.toMatchObject({ statusCode: 409 });
  });

  test('preparar venta: crea el cliente, bloquea otras cajas y da el borrador', async () => {
    const draft = await tienda.orders.prepareForSale(pedidoArroz, { actor: { id: 1, nombre: 'Caja 1' }, branchId: 1 });
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0].precioPactado).toBe(500);
    expect(draft.cliente.nombre).toBe('Juan Pérez');
    expect(draft.metodoPago).toBe('efectivo');
    await expect(tienda.orders.prepareForSale(pedidoArroz, { actor: { id: 2, nombre: 'Caja 2' }, branchId: 1 }))
      .rejects.toMatchObject({ code: 'EN_PROCESO' });
    const forzado = await tienda.orders.prepareForSale(pedidoArroz, { actor: { id: 2, nombre: 'Caja 2' }, branchId: 1, force: true });
    expect(forzado.items).toHaveLength(1);
    // El cliente se reusa (no se crea dos veces).
    const clientes = await pos.query(`SELECT COUNT(*) AS n FROM clients WHERE sync_origin = 'tienda_online'`);
    expect(clientes[0].n).toBe(1);
  });

  test('el precio cambia en el POS pero se respeta el del pedido', async () => {
    await pos.query(`UPDATE products SET precio_venta = 550 WHERE codigo = 'ARZ'`);
    const prices = await pos.withTransaction((conn) => tienda.hooks.agreedPricesInTx(conn, pedidoArroz));
    expect(prices.get(await productoId('ARZ')).price).toBe(500);
    const detalle = await tienda.orders.get(pedidoArroz);
    expect(detalle.items[0].precioUnitario).toBe(500);
    expect(detalle.revision[0].precioActual).toBe(550);
  });

  test('solo una venta por pedido aunque dos cajas cobren a la vez', async () => {
    const venta = async (factura) => pos.withTransaction(async (conn) => {
      const ins = await conn.query(
        `INSERT INTO sales (invoice_number, user_id, payment_method, subtotal, total) VALUES (?, 1, 'efectivo', 1000, 1000)`,
        [factura],
      );
      await tienda.hooks.claimForSaleInTx(conn, { orderId: pedidoArroz, saleId: ins.insertId, invoiceNumber: factura, actor: { id: 1, nombre: 'Caja' } });
      return ins.insertId;
    });
    const resultados = await Promise.allSettled([venta('FAC-00009001'), venta('FAC-00009002')]);
    const ok = resultados.filter((r) => r.status === 'fulfilled');
    const ko = resultados.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect(ko[0].reason.code).toBe('YA_CONVERTIDO');
    // La venta rechazada se deshizo completa.
    const ventas = await pos.query(`SELECT invoice_number, online_order_id, sync_origin FROM sales WHERE invoice_number IN ('FAC-00009001', 'FAC-00009002')`);
    expect(ventas).toHaveLength(1);
    expect(ventas[0].sync_origin).toBe('tienda_online');
    expect(Number(ventas[0].online_order_id)).toBe(pedidoArroz);
    const orden = await tienda.orders.getRow(pedidoArroz);
    expect(orden.sale_invoice_number).toBe(ventas[0].invoice_number);
  });

  test('el estado sube a la nube y la reserva se libera una sola vez', async () => {
    const arroz = await productoId('ARZ');
    await pos.query(`UPDATE products SET stock = 1 WHERE id = ?`, [arroz]); // el POS ya descontó 2
    const enviado = await tienda.sync.pushOnce();
    expect(enviado.enviados).toBeGreaterThan(0);
    expect(tienda.sync.getStatus().ultimoError).toBeNull();
    const cloudId = (await tienda.orders.getRow(pedidoArroz)).cloud_id;
    const doc = fs._get(`businesses/${LIC}/pedidosOnline/${cloudId}`);
    expect(doc.estado).toBe('confirmado');
    expect(doc.pos.venta.factura).toMatch(/^FAC-0000900/);
    expect(doc.reservaActiva).toBe(false);
    const stock = fs._get(`businesses/${LIC}/tiendaOnline/stock`);
    expect(stock.items[`p${arroz}`]).toEqual({ s: 1, r: 0 });
    // Reintentar el envío no vuelve a descontar la reserva.
    await pos.query('UPDATE online_orders SET cloud_sync_pending = 1 WHERE id = ?', [pedidoArroz]);
    await tienda.sync.pushOnce();
    expect(fs._get(`businesses/${LIC}/tiendaOnline/stock`).items[`p${arroz}`].r).toBe(0);
  });

  test('anular la factura deja el pedido libre para cobrarse otra vez', async () => {
    const row = await tienda.orders.getRow(pedidoArroz);
    const sale = (await pos.query('SELECT * FROM sales WHERE id = ?', [row.sale_id]))[0];
    const liberado = await pos.withTransaction((conn) => tienda.hooks.onSaleCancelledInTx(conn, sale, { id: 1 }));
    expect(liberado).toBe(pedidoArroz);
    const after = await tienda.orders.getRow(pedidoArroz);
    expect(after.sale_id).toBeNull();
    expect(after.status).toBe('confirmado');
  });

  test('cancelar un pedido sin venta libera su reserva en la nube', async () => {
    const coca = await productoId('COC');
    const r = await request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(pedidoBody([{ productoId: coca, cantidad: 4 }]));
    expect(r.status).toBe(201);
    const antes = fs._get(`businesses/${LIC}/tiendaOnline/stock`).items[`p${coca}`].r;
    await tienda.sync.pollOnce();
    const row = (await pos.query('SELECT id FROM online_orders WHERE cloud_id = ?', [r.body.pedidoId]))[0];
    await tienda.orders.changeStatus(row.id, 'cancelado', { motivo: 'Cliente no contesta' });
    await tienda.sync.pushOnce();
    const doc = fs._get(`businesses/${LIC}/pedidosOnline/${r.body.pedidoId}`);
    expect(doc.estado).toBe('cancelado');
    expect(doc.mensajes.some((m) => /cancelado/.test(m.texto))).toBe(true);
    expect(fs._get(`businesses/${LIC}/tiendaOnline/stock`).items[`p${coca}`].r).toBe(antes - 4);
  });

  test('recalcular reservas corrige cualquier desfase', async () => {
    const coca = await productoId('COC');
    await fs.doc(`businesses/${LIC}/tiendaOnline/stock`).update({ [`items.p${coca}.r`]: 99 });
    await tienda.nube.reconcileReservations();
    const abiertos = Object.values(Object.fromEntries([...fs._docs.entries()]
      .filter(([p, d]) => p.startsWith(`businesses/${LIC}/pedidosOnline/`) && d.reservaActiva)))
      .reduce((s, d) => s + Number(d.reservas?.[`p${coca}`] || 0), 0);
    expect(fs._get(`businesses/${LIC}/tiendaOnline/stock`).items[`p${coca}`].r).toBe(abiertos);
  });

  test('reportes: pedidos y ventas online por período', async () => {
    const today = sqlDate().slice(0, 10);
    const r = await tienda.orders.stats({ desde: today, hasta: today });
    expect(r.porEstado.reduce((s, x) => s + x.pedidos, 0)).toBeGreaterThan(0);
    expect(r.clientes[0].nombre).toBe('Juan Pérez');
  });
});

describe('Tienda desactivada', () => {
  test('al desactivarla en el POS la tienda deja de recibir pedidos', async () => {
    await tienda.settingsStore.write({ enabled: false });
    await tienda.publisher.run({ force: true });
    const res = await request(app).get(`/api/tiendas/${SLUG}`);
    // La caché de la nube puede tardar unos segundos; se pide fresco.
    const fresh = await request(app).post(`/api/tiendas/${SLUG}/pedidos`).send(pedidoBody([{ productoId: 1, cantidad: 1 }]));
    expect([200, 410]).toContain(res.status);
    expect(fresh.status).toBe(410);
  });
});

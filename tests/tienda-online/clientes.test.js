'use strict';

/**
 * El cliente de un pedido online queda en Clientes apenas llega el pedido
 * (sin esperar a cobrarlo), sin duplicarse si vuelve a pedir. SQLite real.
 */

const { createSqlitePos, sqlDate } = require('../helpers/sqlite-pos');
const { createFakeFirestore } = require('../helpers/fake-firestore');
const { createTiendaOnline } = require('../../server/tienda-online');

let pos;
let tienda;
const eventos = [];

function pedido(numero, cliente) {
  return {
    numero,
    items: [{ productoId: 1, nombre: 'Agua', cantidad: 1, precioUnitario: 25, subtotal: 25, total: 25 }],
    cliente,
    entrega: { tipo: 'retiro' },
    pago: { metodo: 'efectivo' },
    totales: { subtotal: 25, total: 25 },
  };
}

async function clientes() {
  return pos.query('SELECT id, nombre, telefono, email FROM clients ORDER BY id');
}

beforeAll(async () => {
  pos = await createSqlitePos();
  const fs = createFakeFirestore();
  tienda = createTiendaOnline({
    query: pos.query,
    withTransaction: pos.withTransaction,
    addColumnIfMissing: pos.addColumnIfMissing,
    nowSql: () => sqlDate(),
    formatSqlDate: (d) => sqlDate(d),
    getLicenseId: () => 'pos_clientes',
    getFirestore: () => fs,
    getFieldValue: () => fs.FieldValue,
    isMain: () => true,
    getIo: () => ({ emit: (e, p) => eventos.push([e, p]) }),
    mapClientRow: (row) => ({ id: Number(row.id), nombre: row.nombre, telefono: row.telefono }),
    logger: { warn() {}, error() {} },
  });
  await tienda.ensureReady();
});

afterAll(() => {
  tienda.stop();
  pos.close();
});

describe('clientes de la tienda online', () => {
  test('al llegar el pedido se crea el cliente y se liga', async () => {
    const r = await tienda.orders.importOrder('nube-1', pedido(1001, { nombre: 'Ana Pérez', telefono: '809-555-1111', whatsapp: '8095551111', email: 'ana@correo.com' }));
    expect(r.inserted).toBe(true);
    const lista = await clientes();
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ nombre: 'Ana Pérez', email: 'ana@correo.com' });
    const row = await tienda.orders.getRow(r.orderId);
    expect(Number(row.client_id)).toBe(Number(lista[0].id));
    expect(eventos.some(([e, p]) => e === 'tienda-online:cliente' && p.client.id === Number(lista[0].id))).toBe(true);
    const detalle = await tienda.orders.get(r.orderId);
    expect(detalle.cliente.clientId).toBe(Number(lista[0].id));
    expect(detalle.historial.some((h) => h.tipo === 'cliente')).toBe(true);
  });

  test('si vuelve a pedir con el mismo WhatsApp no se duplica', async () => {
    const r = await tienda.orders.importOrder('nube-2', pedido(1002, { nombre: 'Ana P.', telefono: '+1 (809) 555-1111' }));
    const lista = await clientes();
    expect(lista).toHaveLength(1);
    expect(Number((await tienda.orders.getRow(r.orderId)).client_id)).toBe(Number(lista[0].id));
  });

  test('un pedido repetido de la nube no crea nada', async () => {
    const r = await tienda.orders.importOrder('nube-1', pedido(1001, { nombre: 'Ana Pérez', telefono: '8095551111' }));
    expect(r.inserted).toBe(false);
    expect(await clientes()).toHaveLength(1);
  });

  test('los pedidos viejos sin cliente se ligan al arrancar', async () => {
    const r = await tienda.orders.importOrder('nube-3', pedido(1003, { nombre: 'Luis Gómez', telefono: '8295552222' }));
    // Simula un pedido que llegó antes de esta función.
    await pos.query('UPDATE online_orders SET client_id = NULL WHERE id = ?', [r.orderId]);
    await pos.query('DELETE FROM clients WHERE nombre = ?', ['Luis Gómez']);
    const res = await tienda.orders.vincularClientesPendientes();
    expect(res.creados).toBe(1);
    expect((await clientes()).map((c) => c.nombre)).toContain('Luis Gómez');
  });
});

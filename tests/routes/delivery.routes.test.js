'use strict';

/**
 * tests/routes/delivery.routes.test.js
 *
 * pedidos_delivery y repartidores son colecciones globales de Firestore que
 * comparten todos los clientes. El panel Delivery solo debe ver lo de su
 * negocio: pedidos con su licencia, pedidos viejos que coinciden con una venta
 * local (factura + repartidor + total) y repartidores que son usuarios locales.
 */

const express = require('express');
const request = require('supertest');
const createDeliveryRouter = require('../../server/routes/delivery.routes');
const firebaseSync = require('../../modules/firebase-sync');

// ── Firestore falso (solo lo que usan las rutas) ─────────────────────────────

function fieldMs(value) {
  if (value instanceof Date) return value.getTime();
  return Number(value || 0);
}

function createFakeFirestore(collections, { missingIndex = false } = {}) {
  const store = {};
  for (const [name, docs] of Object.entries(collections)) {
    store[name] = new Map(Object.entries(docs).map(([id, data]) => [id, { ...data }]));
  }
  let autoId = 0;

  function snapshotOf(name, id) {
    const data = store[name]?.get(id);
    return { id, exists: Boolean(data), data: () => (data ? { ...data } : undefined) };
  }

  function makeQuery(name, filters = [], order = null, max = null) {
    return {
      where: (field, op, value) => makeQuery(name, [...filters, { field, op, value }], order, max),
      orderBy: (field, dir) => {
        if (missingIndex) {
          return {
            limit: () => ({
              get: async () => {
                const err = new Error('9 FAILED_PRECONDITION: The query requires an index.');
                err.code = 9;
                throw err;
              },
            }),
          };
        }
        return makeQuery(name, filters, { field, dir }, max);
      },
      limit: (n) => makeQuery(name, filters, order, n),
      get: async () => {
        let ids = [...(store[name] || new Map()).keys()];
        ids = ids.filter((id) => {
          const data = store[name].get(id);
          return filters.every(({ field, op, value }) => {
            if (op === '==') return data[field] === value;
            if (op === 'in') return value.includes(data[field]);
            throw new Error(`operador no soportado: ${op}`);
          });
        });
        if (order) {
          ids.sort((a, b) => fieldMs(store[name].get(b)[order.field]) - fieldMs(store[name].get(a)[order.field]));
        }
        if (max !== null) ids = ids.slice(0, max);
        return { docs: ids.map((id) => snapshotOf(name, id)) };
      },
    };
  }

  const db = {
    store,
    collection: (name) => ({
      ...makeQuery(name),
      doc: (id) => ({
        id,
        _path: [name, id],
        get: async () => snapshotOf(name, id),
        set: async (data, opts) => {
          const prev = opts?.merge ? store[name].get(id) || {} : {};
          store[name].set(id, { ...prev, ...data });
        },
        update: async (data) => {
          if (!store[name].has(id)) {
            const err = new Error('5 NOT_FOUND');
            err.code = 5;
            throw err;
          }
          store[name].set(id, { ...store[name].get(id), ...data });
        },
        onSnapshot: (onNext) => {
          setImmediate(() => onNext(snapshotOf(name, id)));
          return () => {};
        },
      }),
      add: async (data) => {
        autoId += 1;
        const id = `auto_${autoId}`;
        store[name].set(id, { ...data });
        return { id };
      },
    }),
    getAll: async (...refs) => refs.map((ref) => snapshotOf(ref._path[0], ref._path[1])),
  };
  return db;
}

// ── Datos: dos negocios en el mismo proyecto Firebase ────────────────────────

const MI_LICENCIA = 'pos_mio111';
const OTRA_LICENCIA = 'pos_otro999';

function seedPedidos() {
  return {
    // De este negocio (con licencia)
    pos_mio_1: { licenseId: MI_LICENCIA, numeroFactura: 'FAC-00001001', repartidorId: 'uid-rep-mio', estado: 'asignado', total: 500, clienteNombre: 'Cliente mío', creadoEn: 3000 },
    // De otro negocio (con licencia)
    pos_otro_1: { licenseId: OTRA_LICENCIA, numeroFactura: 'FAC-00001001', repartidorId: 'uid-rep-otro', estado: 'asignado', total: 900, clienteNombre: 'Cliente ajeno', creadoEn: 4000 },
    // Viejo sin licencia que SÍ es de este negocio (factura + repartidor + total)
    'pos_FAC-00000900': { numeroFactura: 'FAC-00000900', repartidorId: 'uid-rep-mio', estado: 'entregado', total: 250, clienteNombre: 'Viejo mío', creadoEn: 1000 },
    // Viejo sin licencia de otro negocio con el MISMO repartidor (misma cuenta) pero otro total
    'pos_FAC-00000901': { numeroFactura: 'FAC-00000901', repartidorId: 'uid-rep-mio', estado: 'entregado', total: 777, clienteNombre: 'Viejo ajeno', creadoEn: 2000 },
    // Viejo sin licencia de otro negocio, otro repartidor
    'pos_FAC-00001039': { numeroFactura: 'FAC-00001039', repartidorId: 'uid-rep-otro', estado: 'entregado', total: 1200, clienteNombre: 'EMILIO MANAURYS CABRERA', creadoEn: 5000 },
  };
}

function seedRepartidores() {
  return {
    'uid-rep-mio': { uid: 'uid-rep-mio', nombre: 'Repartidor mío', activo: true, ultimaUbicacion: { lat: 18.4, lng: -69.9 } },
    'uid-rep-otro': { uid: 'uid-rep-otro', nombre: 'Repartidor ajeno', activo: true, ultimaUbicacion: { lat: 18.5, lng: -69.8 } },
  };
}

function makeQuery({ localUids = ['uid-admin', 'uid-rep-mio'], localSales = null } = {}) {
  const sales = localSales || [
    { invoice_number: 'FAC-00000900', total: 250, firebase_uid: 'uid-rep-mio' },
    { invoice_number: 'FAC-00000901', total: 300, firebase_uid: 'uid-rep-mio' },
  ];
  return jest.fn(async (sql) => {
    if (/FROM sales/i.test(sql)) return sales;
    if (/SELECT firebase_uid FROM users/i.test(sql)) return localUids.map((uid) => ({ firebase_uid: uid }));
    return [];
  });
}

function buildApp({ tenantId = MI_LICENCIA, db, query = makeQuery() } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/delivery', createDeliveryRouter({
    query,
    getTenantId: () => tenantId,
    getFirestore: () => db,
  }));
  return app;
}

describe('delivery.routes — aislamiento por negocio', () => {
  test('GET /pedidos solo devuelve pedidos de este negocio', async () => {
    const db = createFakeFirestore({ pedidos_delivery: seedPedidos(), repartidores: seedRepartidores() });
    const res = await request(buildApp({ db })).get('/api/delivery/pedidos');
    expect(res.status).toBe(200);
    const ids = res.body.pedidos.map((p) => p.id);
    expect(ids).toEqual(['pos_mio_1', 'pos_FAC-00000900']);
    const nombres = res.body.pedidos.map((p) => p.clienteNombre);
    expect(nombres).not.toContain('Cliente ajeno');
    expect(nombres).not.toContain('Viejo ajeno');
    expect(nombres).not.toContain('EMILIO MANAURYS CABRERA');
  });

  test('GET /pedidos filtra por estado sin traer pedidos ajenos', async () => {
    const db = createFakeFirestore({ pedidos_delivery: seedPedidos(), repartidores: seedRepartidores() });
    const res = await request(buildApp({ db })).get('/api/delivery/pedidos?estado=entregado&limite=50');
    expect(res.body.pedidos.map((p) => p.id)).toEqual(['pos_FAC-00000900']);
  });

  test('negocio nuevo sin licencia ni ventas delivery: no ve nada', async () => {
    const db = createFakeFirestore({ pedidos_delivery: seedPedidos(), repartidores: seedRepartidores() });
    const app = buildApp({ db, tenantId: '', query: makeQuery({ localUids: ['uid-nuevo'], localSales: [] }) });
    const pedidos = await request(app).get('/api/delivery/pedidos');
    expect(pedidos.body.pedidos).toEqual([]);
    const stats = await request(app).get('/api/delivery/stats');
    expect(stats.body.stats).toEqual({ asignado: 0, en_camino: 0, entregado: 0, incidencia: 0 });
  });

  test('GET /stats cuenta solo los pedidos propios', async () => {
    const db = createFakeFirestore({ pedidos_delivery: seedPedidos(), repartidores: seedRepartidores() });
    const res = await request(buildApp({ db })).get('/api/delivery/stats');
    expect(res.body.stats).toEqual({ asignado: 1, en_camino: 0, entregado: 1, incidencia: 0 });
  });

  test('sin índice compuesto en Firestore sigue filtrando por negocio', async () => {
    const db = createFakeFirestore(
      { pedidos_delivery: seedPedidos(), repartidores: seedRepartidores() },
      { missingIndex: true },
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(buildApp({ db })).get('/api/delivery/pedidos');
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.pedidos.map((p) => p.id)).toEqual(['pos_mio_1', 'pos_FAC-00000900']);
  });

  test('GET /pedidos/:id no entrega el pedido de otro negocio', async () => {
    const db = createFakeFirestore({ pedidos_delivery: seedPedidos(), repartidores: seedRepartidores() });
    const app = buildApp({ db });
    expect((await request(app).get('/api/delivery/pedidos/pos_otro_1')).status).toBe(404);
    expect((await request(app).get('/api/delivery/pedidos/pos_FAC-00001039')).status).toBe(404);
    const own = await request(app).get('/api/delivery/pedidos/pos_mio_1');
    expect(own.status).toBe(200);
    expect(own.body.pedido.clienteNombre).toBe('Cliente mío');
  });

  test('GET /repartidores solo lista usuarios de este negocio', async () => {
    const db = createFakeFirestore({ pedidos_delivery: {}, repartidores: seedRepartidores() });
    const res = await request(buildApp({ db })).get('/api/delivery/repartidores');
    expect(res.body.repartidores.map((r) => r.uid)).toEqual(['uid-rep-mio']);
  });

  test('GET /ubicaciones/stream solo transmite repartidores de este negocio', async () => {
    const http = require('http');
    const db = createFakeFirestore({ pedidos_delivery: {}, repartidores: seedRepartidores() });
    const server = buildApp({ db }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const firstEvent = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${server.address().port}/api/delivery/ubicaciones/stream`, (res) => {
          let buffer = '';
          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const match = buffer.match(/data: (.*)\n\n/);
            if (match) {
              req.destroy();
              resolve(JSON.parse(match[1]));
            }
          });
        });
        req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
      });
      expect(firstEvent.map((r) => r.uid)).toEqual(['uid-rep-mio']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('PATCH /repartidores/:uid/activo rechaza repartidores de otro negocio', async () => {
    const db = createFakeFirestore({ pedidos_delivery: {}, repartidores: seedRepartidores() });
    const res = await request(buildApp({ db }))
      .patch('/api/delivery/repartidores/uid-rep-otro/activo')
      .send({ activo: false });
    expect(res.status).toBe(404);
    expect(db.store.repartidores.get('uid-rep-otro').activo).toBe(true);
  });

  test('POST /pedidos guarda la licencia y exige que el repartidor sea local', async () => {
    const db = createFakeFirestore({ pedidos_delivery: {}, repartidores: seedRepartidores() });
    const app = buildApp({ db });
    const body = { numeroFactura: 'FAC-00001002', repartidorId: 'uid-rep-mio', clienteNombre: 'Ana', total: 100 };

    const ok = await request(app).post('/api/delivery/pedidos').send(body);
    expect(ok.status).toBe(200);
    expect(db.store.pedidos_delivery.get(ok.body.pedidoId).licenseId).toBe(MI_LICENCIA);

    const ajeno = await request(app).post('/api/delivery/pedidos').send({ ...body, repartidorId: 'uid-rep-otro' });
    expect(ajeno.status).toBe(403);

    const sinLicencia = await request(buildApp({ db, tenantId: '' })).post('/api/delivery/pedidos').send(body);
    expect(sinLicencia.status).toBe(409);
  });
});

describe('firebase-sync — ID de pedido por negocio', () => {
  const original = process.env.TECNO_CAJA_LICENSE_UID;
  afterEach(() => {
    if (original === undefined) delete process.env.TECNO_CAJA_LICENSE_UID;
    else process.env.TECNO_CAJA_LICENSE_UID = original;
  });

  test('la misma factura en dos negocios produce IDs distintos', () => {
    const a = firebaseSync.buildPedidoDocId('FAC-00001001', 'pos_aaa');
    const b = firebaseSync.buildPedidoDocId('FAC-00001001', 'pos_bbb');
    expect(a).toBe('pos_pos_aaa_FAC-00001001');
    expect(a).not.toBe(b);
  });

  test('sin licencia no hay ID (no se escribe en un documento compartido)', () => {
    process.env.TECNO_CAJA_LICENSE_UID = '';
    expect(firebaseSync.getTenantId()).toBe('');
    expect(firebaseSync.buildPedidoDocId('FAC-00001001')).toBeNull();
  });

  test('usa la licencia de la instalación', () => {
    process.env.TECNO_CAJA_LICENSE_UID = ' pos_xyz ';
    expect(firebaseSync.getTenantId()).toBe('pos_xyz');
    expect(firebaseSync.buildPedidoDocId('FAC 1/2')).toBe('pos_pos_xyz_FAC_1_2');
  });
});

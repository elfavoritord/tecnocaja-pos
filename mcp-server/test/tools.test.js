import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/server.js';

/** pos falso: responde según el path pedido. */
function fakePos(routes = {}, bootstrap = {}) {
  return {
    async get(path, params) {
      const key = Object.keys(routes).find((r) => path.startsWith(r));
      if (!key) throw new Error(`fakePos: sin ruta para ${path}`);
      return typeof routes[key] === 'function' ? routes[key](params) : routes[key];
    },
    async getBootstrap() {
      return bootstrap;
    },
  };
}

async function connect(pos) {
  const server = buildMcpServer(pos, { name: 'test', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, server };
}

function textOf(result) {
  return (result.content || []).map((c) => c.text).join('\n');
}

test('expone el catálogo de herramientas esperado', async () => {
  const { client } = await connect(fakePos());
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const expected of [
    'ventas_resumen',
    'ventas_por_dia',
    'ventas_por_metodo_pago',
    'ganancias',
    'dashboard_hoy',
    'buscar_producto',
    'stock_bajo',
    'inventario_por_sucursal',
    'top_productos',
    'estado_caja',
    'movimientos_caja',
    'cuentas_por_cobrar',
    'buscar_cliente',
    'top_clientes',
    'reporte_dgii',
  ]) {
    assert.ok(names.includes(expected), `falta la herramienta ${expected}`);
  }
});

test('ventas_resumen formatea los KPIs del POS', async () => {
  const pos = fakePos({
    '/api/reports/advanced/kpis': {
      total_facturado: 12345.5,
      total_ventas: 12000,
      ganancia: 4000,
      margen: '32.4',
      itbis: 1800,
      credito: 500,
      efectivo: 9000,
      tarjeta: 2000,
      transferencia: 1000,
    },
  });
  const { client } = await connect(pos);
  const res = await client.callTool({ name: 'ventas_resumen', arguments: { rango: 'hoy' } });
  const txt = textOf(res);
  assert.match(txt, /Total facturado/);
  assert.match(txt, /12,345\.50/);
  assert.match(txt, /margen 32\.4%/);
});

test('buscar_producto filtra por texto sobre el catálogo', async () => {
  const pos = fakePos({
    '/api/products': {
      products: [
        { id: 1, nombre: 'Coca Cola 600ml', codigo: 'CC600', precioVenta: 75, precioCompra: 55, stock: 40, categoria: 'Bebidas' },
        { id: 2, nombre: 'Pan de agua', codigo: 'PAN01', precioVenta: 10, precioCompra: 6, stock: 100, categoria: 'Panadería' },
      ],
    },
  });
  const { client } = await connect(pos);
  const res = await client.callTool({ name: 'buscar_producto', arguments: { texto: 'coca' } });
  const txt = textOf(res);
  assert.match(txt, /Coca Cola 600ml/);
  assert.doesNotMatch(txt, /Pan de agua/);
});

test('buscar_cliente usa el snapshot de bootstrap', async () => {
  const pos = fakePos(
    {},
    {
      clientes: [
        { id: 7, nombre: 'Colmado La Bendición', telefono: '8095551234', cedula: '00112345678', balance: 1500, limiteCredito: 5000 },
        { id: 8, nombre: 'María Pérez', telefono: '8299990000', cedula: '', balance: 0 },
      ],
    }
  );
  const { client } = await connect(pos);
  const res = await client.callTool({ name: 'buscar_cliente', arguments: { texto: 'bendición' } });
  const txt = textOf(res);
  assert.match(txt, /Colmado La Bendición/);
  assert.match(txt, /1,500\.00/);
  assert.doesNotMatch(txt, /María Pérez/);
});

test('una herramienta devuelve isError cuando el POS falla', async () => {
  const pos = {
    async get() {
      throw new Error('POS caído');
    },
    async getBootstrap() {
      return {};
    },
  };
  const { client } = await connect(pos);
  const res = await client.callTool({ name: 'stock_bajo', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /POS caído/);
});

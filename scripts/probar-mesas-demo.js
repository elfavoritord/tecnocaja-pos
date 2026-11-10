'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const base = 'http://127.0.0.1:3405';
let token;
async function req(path, method = 'GET', body) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
(async () => {
  assert.equal((await req('/api/health')).body.businessName, 'Demo POS Mesas');
  const login = await req('/api/login', 'POST', { usuario: 'demo', password: 'DemoMesas2026!' });
  token = login.body.token; assert.ok(token);
  const branchId = login.body.data.sucursales[0].id, cashRegisterId = login.body.data.cajasSucursal[0].id;
  const product = await req('/api/products', 'POST', { codigo: `DEMO-${Date.now()}`, nombre: 'Bebida de prueba MESAS', categoria: 'BEBIDAS', unidad: 'Unidad', precioVenta: 100, precioCompra: 40, stock: 30, stockMin: 0, aplicaItbis: false, estado: 'Activo', branchId });
  assert.equal(product.status, 201, JSON.stringify(product.body));
  console.log('Producto creado', JSON.stringify(product.body).slice(0, 120));
  const p = product.body.product || product.body.producto || product.body;
  assert.ok(p.id, 'El producto debe devolver id');
  const plano = (await req('/api/mesas/plano')).body;
  const elemento = { id: randomUUID(), codigo: `PRUEBA-${Date.now()}`, forma: 'mesa', x: 60, y: 60, ancho: 120, alto: 90, vendible: true, zona: 'Pruebas' };
  assert.equal((await req('/api/mesas/plano', 'PUT', { version: plano.version, elementos: [...plano.elementos, elemento] })).status, 200);
  const id = randomUUID();
  assert.equal((await req('/api/mesas/cuentas', 'POST', { id, elementoId: elemento.id })).status, 200);
  const items = [{ id: p.id, nombre: 'Bebida de prueba MESAS', qty: 1, precio: 100, descuento: 0, itbis: 0, total: 100, subtotal: 100, impuestoMonto: 0, saleMode: 'unidad' }];
  assert.equal((await req(`/api/mesas/cuentas/${id}`, 'PUT', { version: 0, draft: { items, tableLabel: elemento.codigo } })).status, 200);
  assert.equal((await req(`/api/mesas/cuentas/${id}`, 'PUT', { version: 0, draft: { items } })).status, 409);
  const cuenta = { id, version: 1 };
  const sale = { userId: login.body.user.id, clientId: null, cliente: 'Consumidor Final', tipoComprobante: 'ticket', metodo: 'efectivo', tipoPedido: 'mostrador', items,
    subtotal: 100, descuento: 0, itbis: 0, total: 100, recibido: 100, cambio: 0, branchId, cashRegisterId, clientRequestId: randomUUID(), mesasCuenta: cuenta };
  const result = await req('/api/sales', 'POST', sale);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const retry = await req('/api/sales', 'POST', sale);
  assert.equal(retry.status, 200); assert.equal(retry.body.sale.id, result.body.sale.id);
  const repeat = await req('/api/sales', 'POST', { ...sale, clientRequestId: randomUUID() });
  assert.equal(repeat.status, 409, JSON.stringify(repeat.body));
  assert.ok(!(await req('/api/mesas/cuentas')).body.some((c) => c.id === id));
  console.log('OK: consumo guardado, conflicto detectado, cobro real, reintento sin duplicación y cierre de cuenta.');
})().catch((e) => { console.error(e); process.exitCode = 1; });

'use strict';
// Catálogo de Ventas con miles de productos (js/ventas.js): el índice de
// productos por id y lo que aparta el carrito, calculado una sola vez.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ventas = fs.readFileSync(path.join(__dirname, '../js/ventas.js'), 'utf8');

// Extrae una declaración de nivel superior (function o let) por su nombre.
function extraer(nombre) {
  const inicio = ventas.search(new RegExp(`^(?:function ${nombre}\\(|let ${nombre} =)`, 'm'));
  if (inicio < 0) throw new Error(`no encontré ${nombre}`);
  const resto = ventas.slice(inicio);
  const fin = resto.search(/\r?\n(?:function |let |const |\/\/ |async function )/);
  return resto.slice(0, fin < 0 ? resto.length : fin);
}

function cargar(productos, saleItems = []) {
  const context = vm.createContext({ DB: { productos, saleItems } });
  vm.runInContext([
    extraer('isComboProduct'),
    extraer('salesProductIndexCache'),
    extraer('getSalesProductIndex'),
    extraer('getCartQtyMap'),
    extraer('getCartQtyForProduct'),
    'globalThis.api = { getSalesProductIndex, getCartQtyMap, getCartQtyForProduct };',
  ].join('\n'), context);
  return context;
}

const productos = () => [
  { id: 1, nombre: 'Arroz', precioVenta: 40 },
  { id: 2, nombre: 'Habichuela', precioVenta: 60 },
  { id: 3, nombre: 'Combo desayuno', tipoProducto: 'combo', componentes: [
    { id: 1, cantidad: 2 }, { id: 2, cantidad: 1, controlaStock: false },
  ] },
];

test('el índice encuentra por id y ve al momento un producto reemplazado en su lugar', () => {
  const ctx = cargar(productos());
  const { api, DB } = ctx;
  expect(api.getSalesProductIndex().get(2).nombre).toBe('Habichuela');
  DB.productos[1] = { ...DB.productos[1], precioVenta: 75 }; // como al editar un producto
  expect(api.getSalesProductIndex().get(2).precioVenta).toBe(75);
  expect(api.getSalesProductIndex().get(99)).toBeUndefined();
});

test('el índice se rehace si se agrega, se quita o se reordena la lista', () => {
  const ctx = cargar(productos());
  const { api, DB } = ctx;
  DB.productos.push({ id: 4, nombre: 'Aceite' });
  expect(api.getSalesProductIndex().get(4).nombre).toBe('Aceite');
  DB.productos.reverse();
  expect(api.getSalesProductIndex().get(1).nombre).toBe('Arroz');
  DB.productos = [{ id: 7, nombre: 'Nueva lista' }];
  expect(api.getSalesProductIndex().get(7).nombre).toBe('Nueva lista');
  expect(api.getSalesProductIndex().get(1)).toBeUndefined();
});

test('lo que aparta el carrito (una sola vez) da lo mismo que contarlo producto por producto', () => {
  const carrito = [
    { id: 1, qty: 3 },
    { id: 3, qty: 2 }, // combo: aparta 2 × 2 de arroz; la habichuela no controla existencia
    { id: 2, qty: 1.5 },
    { id: null, qty: 4, quickSale: true },
  ];
  const ctx = cargar(productos(), carrito);
  const mapa = ctx.api.getCartQtyMap();
  for (const id of [1, 2, 3]) {
    expect(mapa.get(id) || 0).toBe(ctx.api.getCartQtyForProduct(id));
  }
  expect(mapa.get(1)).toBe(7);
  expect(mapa.get(2)).toBe(1.5);
});

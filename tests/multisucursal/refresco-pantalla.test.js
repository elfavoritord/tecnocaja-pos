'use strict';

/**
 * js/app.js → refrescarCatalogoSinTocarLaVenta(): cuando llegan productos,
 * usuarios o el nombre de la sucursal desde la central (aviso por socket), la
 * pantalla abierta se refresca SIN borrar la venta en curso ni la sesión.
 * (El bootstrap trae saleItems vacío y currentUser null: hydrateDB() los
 * pisaría.)
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function cargarFuncion() {
  const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'app.js'), 'utf8');
  const inicio = codigo.indexOf('async function refrescarCatalogoSinTocarLaVenta()');
  expect(inicio).toBeGreaterThan(-1);
  // Hasta la llave que cierra la función (el archivo puede tener CRLF).
  const resto = codigo.slice(inicio);
  const cierre = /\r?\n\}\r?\n/.exec(resto);
  expect(cierre).not.toBeNull();
  return resto.slice(0, cierre.index + cierre[0].length);
}

describe('Refresco de la pantalla con datos de la central', () => {
  test('actualiza productos, usuarios y el nombre de la sucursal; no toca la venta ni la sesión', async () => {
    const llamadas = [];
    const DB = {
      productos: [{ codigo: 'VIEJO' }],
      categorias: ['General'],
      users: [{ usuario: 'admin' }],
      sucursales: [{ id: 1, nombre: 'Sucursal Principal' }],
      config: { activeBranchName: 'Sucursal Principal', cajaAbierta: true },
      saleItems: [{ nombre: 'Venta en curso', precio: 99, qty: 1 }],
      currentUser: { usuario: 'admin' },
      authToken: 'token-de-la-sesion',
    };
    const window = {};
    for (const nombre of ['refreshProductCategoryFilter', 'loadProductsTable', 'loadInventoryTable', 'updateInventoryStats', 'renderSalesCatalog', 'loadUsuariosTable', 'syncCajaState']) {
      window[nombre] = () => llamadas.push(nombre);
    }
    window.renderSalesCatalog = () => { llamadas.push('renderSalesCatalog'); throw new Error('vista cerrada'); };
    const api = {
      getBootstrap: async () => ({
        productos: [{ codigo: 'VIEJO' }, { codigo: 'DE-LA-CENTRAL' }],
        categorias: ['General', 'Herramientas'],
        users: [{ usuario: 'admin' }, { usuario: 'ana.norte' }],
        sucursales: [{ id: 1, nombre: 'Norte' }],
        config: { activeBranchName: 'Norte', cajaAbierta: false },
        saleItems: [],
        currentUser: null,
      }),
    };
    const contexto = vm.createContext({ DB, window, api });
    vm.runInContext(`${cargarFuncion()}\nthis.refrescar = refrescarCatalogoSinTocarLaVenta;`, contexto);
    await contexto.refrescar();

    expect(DB.productos.map((p) => p.codigo)).toEqual(['VIEJO', 'DE-LA-CENTRAL']);
    expect(DB.categorias).toEqual(['General', 'Herramientas']);
    expect(DB.users.map((u) => u.usuario)).toEqual(['admin', 'ana.norte']);
    expect(DB.config.activeBranchName).toBe('Norte');
    // Lo que NO se toca:
    expect(DB.saleItems).toEqual([{ nombre: 'Venta en curso', precio: 99, qty: 1 }]);
    expect(DB.currentUser).toEqual({ usuario: 'admin' });
    expect(DB.authToken).toBe('token-de-la-sesion');
    expect(DB.config.cajaAbierta).toBe(true);
    // Se repintan las vistas, aunque una falle.
    expect(llamadas).toEqual(expect.arrayContaining(['loadProductsTable', 'renderSalesCatalog', 'loadUsuariosTable', 'syncCajaState']));
  });

  test('sin conexión con el servidor local no rompe nada', async () => {
    const DB = { productos: [{ codigo: 'A' }], config: {}, saleItems: [{}] };
    const contexto = vm.createContext({ DB, window: {}, api: { getBootstrap: async () => { throw new Error('sin red'); } } });
    vm.runInContext(`${cargarFuncion()}\nthis.refrescar = refrescarCatalogoSinTocarLaVenta;`, contexto);
    await contexto.refrescar();
    expect(DB.productos).toEqual([{ codigo: 'A' }]);
    expect(DB.saleItems).toHaveLength(1);
  });
});

'use strict';
// Permisos por usuario: catálogo compartido (js/permisos-catalogo.js) y la
// regla del servidor (server/security/permisos-usuario.js).
const catalogo = require('../../js/permisos-catalogo');
const permisos = require('../../server/security/permisos-usuario');

describe('catálogo de permisos', () => {
  test('cada código aparece una sola vez y los módulos piden códigos del catálogo', () => {
    expect(new Set(catalogo.CODIGOS).size).toBe(catalogo.CODIGOS.length);
    for (const requeridos of Object.values(catalogo.MODULOS)) {
      for (const codigo of requeridos) expect(catalogo.esValido(codigo)).toBe(true);
    }
  });

  test('normalizar quita desconocidos y repetidos, traduce códigos viejos y respeta el orden del catálogo', () => {
    expect(catalogo.normalizar(['inventario', 'ventas', 'x-raro', 'ventas', 'reportes_sucursal']))
      .toEqual(['ventas', 'inventario', 'reportes']);
    expect(catalogo.normalizar(null)).toEqual([]);
  });

  test('lo que da cada rol hoy: el cajero vende y maneja su caja, pero no cancela facturas ni toca inventario', () => {
    const cajero = catalogo.porDefecto('cajero', ['ventas', 'caja', 'clientes', 'abrir_caja', 'cerrar_caja', 'hacer_corte_caja', 'abrir_gaveta']);
    expect(cajero).toEqual(expect.arrayContaining(['ventas', 'caja', 'abrir_caja', 'cerrar_caja', 'hacer_corte_caja', 'abrir_gaveta', 'clientes', 'reportes']));
    expect(cajero).not.toContain('anular_ventas');
    expect(cajero).not.toContain('inventario');
    expect(cajero).not.toContain('gestionar_configuracion_global');
  });

  test('el administrador general tiene todo; el rol con permisos de la base los suma', () => {
    expect(catalogo.porDefecto('administrador_general')).toEqual(catalogo.CODIGOS);
    expect(catalogo.porDefecto('Administrador')).toEqual(catalogo.CODIGOS);
    expect(catalogo.porDefecto('supervisor', ['compras.ver'])).toContain('compras.ver');
  });

  test('módulos: con alguno de sus permisos se ve; sin regla propia decide la lógica de siempre', () => {
    expect(catalogo.moduloPermitido('inventario', ['inventario'])).toBe(true);
    expect(catalogo.moduloPermitido('configuracion', ['ventas'])).toBe(false);
    expect(catalogo.moduloPermitido('compras', ['gastos.ver'])).toBe(true);
    expect(catalogo.moduloPermitido('srv-facturas', ['ventas'])).toBeNull();
  });

  test('iguales compara listas sin importar el orden', () => {
    expect(catalogo.iguales(['caja', 'ventas'], ['ventas', 'caja'])).toBe(true);
    expect(catalogo.iguales(['caja'], ['ventas', 'caja'])).toBe(false);
  });
});

describe('permisos propios del usuario (servidor)', () => {
  const cajero = (permisosUsuario) => ({ id: 7, role_code: 'cajero', rol: 'Cajero', role_permissions: '["ventas","caja"]', permisos_usuario: permisosUsuario });

  test('sin lista propia usa los del rol, exactamente como antes', () => {
    expect(permisos.propios(cajero(null))).toBeNull();
    expect(permisos.personalizado(cajero(undefined))).toBe(false);
    expect(permisos.personalizado(cajero(''))).toBe(false);
  });

  test('con lista propia vale esa lista (también vacía) y se limpia', () => {
    expect(permisos.propios(cajero('["inventario","ventas","inventado"]'))).toEqual(['ventas', 'inventario']);
    expect(permisos.propios(cajero('[]'))).toEqual([]);
    expect(permisos.personalizado(cajero('[]'))).toBe(true);
  });

  test('una lista ilegible no deja al usuario sin permisos: vuelve a los del rol', () => {
    expect(permisos.propios(cajero('{roto'))).toBeNull();
  });

  test('el administrador general no se personaliza aunque tenga lista guardada', () => {
    expect(permisos.propios({ role_code: 'administrador_general', permisos_usuario: '["ventas"]' })).toBeNull();
    expect(permisos.propios({ rol: 'Administrador', permisos_usuario: '["ventas"]' })).toBeNull();
  });
});

'use strict';

/**
 * server/network/terminal-principal.js — tras restaurar un respaldo multicaja
 * en la PC que tiene la base de datos, esa PC vuelve a ser la principal en vez
 * de quedar en modo enlace (pantalla de bienvenida en bucle).
 */

const { asegurarTerminalPrincipal } = require('../server/network/terminal-principal');

function deps({ terminal = null, local = true, guardar = true } = {}) {
  const guardadas = [];
  return {
    guardadas,
    query: async (sql) => {
      if (/FROM branches/.test(sql)) return [{ id: 3, nombre: 'Sucursal Principal' }];
      if (/FROM cash_registers/.test(sql)) return [{ id: 7, nombre: 'Caja 1' }];
      return [];
    },
    getTerminalConfig: () => terminal,
    saveTerminalConfig: (data) => { guardadas.push(data); return guardar; },
    isLoopbackDbHost: () => local,
    config: { businessStructureMode: 'multicaja', idioma: 'es' }
  };
}

test('si ya tiene configuración de terminal, la deja igual', async () => {
  const existente = { isMain: false, cashRegisterId: 2 };
  const d = deps({ terminal: existente });
  expect(await asegurarTerminalPrincipal(d)).toBe(existente);
  expect(d.guardadas).toHaveLength(0);
});

test('PC con la base de datos local y sin configuración: se marca como principal', async () => {
  const d = deps();
  const terminal = await asegurarTerminalPrincipal(d);
  expect(terminal).toMatchObject({
    isMain: true,
    branchId: 3,
    branchName: 'Sucursal Principal',
    cashRegisterId: 7,
    cashRegisterName: 'Caja 1',
    setupMode: 'multicaja'
  });
  expect(d.guardadas).toHaveLength(1);
});

test('caja secundaria (base de datos en otra PC): sigue en modo enlace', async () => {
  const d = deps({ local: false });
  expect(await asegurarTerminalPrincipal(d)).toBeNull();
  expect(d.guardadas).toHaveLength(0);
});

test('si no se puede guardar el archivo, no finge que quedó lista', async () => {
  expect(await asegurarTerminalPrincipal(deps({ guardar: false }))).toBeNull();
});

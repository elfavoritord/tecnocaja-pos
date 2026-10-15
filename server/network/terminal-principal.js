'use strict';

/**
 * Multicaja/multisucursal: cada PC guarda en config/terminal-config.json si es
 * la principal o qué caja es. Sin ese archivo, /api/setup/status manda la PC
 * al modo enlace ("conectar esta caja a la principal") y la app vuelve a la
 * pantalla de bienvenida.
 *
 * Eso estaba mal en la PC que TIENE la base de datos del negocio (DB_HOST
 * local): después de restaurar un respaldo multicaja —o de formatear y
 * restaurar— el archivo ya no existe, pero los datos son de esta misma PC, así
 * que es la principal. Aquí se vuelve a crear con la primera sucursal y la
 * primera caja del negocio, igual que lo hace el asistente al configurar.
 *
 * Una caja secundaria (DB_HOST apunta a la principal) no se toca: sigue
 * entrando en modo enlace como siempre.
 */

const crypto = require('crypto');

async function asegurarTerminalPrincipal({
  query,
  getTerminalConfig,
  saveTerminalConfig,
  isLoopbackDbHost,
  config = {},
  log = () => {}
}) {
  const actual = getTerminalConfig();
  if (actual) return actual;
  if (!isLoopbackDbHost()) return null;

  const [sucursal] = await query('SELECT id, nombre FROM branches ORDER BY id LIMIT 1').catch(() => []);
  const [caja] = sucursal
    ? await query('SELECT id, nombre FROM cash_registers WHERE branch_id = ? ORDER BY id LIMIT 1', [sucursal.id]).catch(() => [])
    : [];

  const terminal = {
    terminalId: crypto.randomBytes(8).toString('hex'),
    terminalName: 'Terminal Principal',
    branchId: sucursal?.id || null,
    branchName: sucursal?.nombre || 'Sucursal Principal',
    cashRegisterId: caja?.id || null,
    cashRegisterName: caja?.nombre || 'Caja Principal',
    setupMode: config.businessStructureMode || 'multicaja',
    language: config.idioma || 'es',
    linkedAt: new Date().toISOString(),
    linkedBy: 'restauracion',
    isMain: true
  };
  if (!saveTerminalConfig(terminal)) return null;
  log(`[terminal] Esta PC tiene la base de datos del negocio: se marcó otra vez como principal (${terminal.branchName} · ${terminal.cashRegisterName}).`);
  return terminal;
}

module.exports = { asegurarTerminalPrincipal };

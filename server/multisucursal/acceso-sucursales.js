'use strict';

/**
 * server/multisucursal/acceso-sucursales.js — A qué sucursales puede entrar un
 * usuario.
 *
 * Fuente: user_branch_access (ms-0003) + la sucursal principal del usuario
 * (users.sucursal_id ?? users.branch_id), que se sigue respetando aunque la
 * tabla no tenga filas. Un administrador general ve todas.
 *
 * Esto es validación de backend: ocultar un botón no alcanza.
 */

function createAccesoSucursales({ query, esAdministradorGeneral = () => false }) {
  async function sucursalesDelUsuario(usuario) {
    if (!usuario) return { todas: false, ids: [] };
    if (esAdministradorGeneral(usuario)) return { todas: true, ids: [] };

    const ids = new Set();
    const principal = usuario.sucursal_id ?? usuario.branch_id ?? usuario.sucursalId ?? usuario.branchId;
    if (principal !== null && principal !== undefined && Number(principal)) ids.add(Number(principal));

    const userId = Number(usuario.id || 0);
    if (userId) {
      const rows = await query(
        "SELECT branch_id FROM user_branch_access WHERE user_id = ? AND estado = 'Activo'",
        [userId]
      ).catch(() => []);
      for (const row of rows) ids.add(Number(row.branch_id));
    }
    return { todas: false, ids: [...ids].filter(Boolean).sort((a, b) => a - b) };
  }

  async function puedeEntrarASucursal(usuario, branchId) {
    const destino = Number(branchId || 0);
    if (!destino) return false;
    const acceso = await sucursalesDelUsuario(usuario);
    return acceso.todas || acceso.ids.includes(destino);
  }

  // accessType: el campo access_type que la tabla ya tenía ('operador' por
  // defecto). origen: 'local' (asignado en esta PC) o 'central' (Fase 3).
  async function asignar(userId, branchId, { accessType = 'operador', origen = 'local' } = {}) {
    const usuario = Number(userId || 0);
    const sucursal = Number(branchId || 0);
    if (!usuario || !sucursal) throw new Error('Usuario y sucursal son obligatorios.');
    const existe = await query(
      'SELECT id FROM user_branch_access WHERE user_id = ? AND branch_id = ? LIMIT 1',
      [usuario, sucursal]
    );
    if (existe.length) {
      await query(
        "UPDATE user_branch_access SET estado = 'Activo', access_type = ?, origen = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [accessType, origen, existe[0].id]
      );
      return existe[0].id;
    }
    const r = await query(
      "INSERT INTO user_branch_access (user_id, branch_id, access_type, estado, origen, updated_at) VALUES (?, ?, ?, 'Activo', ?, CURRENT_TIMESTAMP)",
      [usuario, sucursal, accessType, origen]
    );
    return Number(r?.insertId || 0);
  }

  // Revocar es lógico: queda el rastro de que tuvo acceso. La sucursal
  // principal (columna de users) no se revoca aquí: se cambia en la ficha del
  // usuario, si no seguiría entrando por esa columna.
  async function revocar(userId, branchId) {
    const usuarios = await query('SELECT sucursal_id, branch_id FROM users WHERE id = ? LIMIT 1', [Number(userId || 0)]);
    const principal = usuarios[0] ? (usuarios[0].sucursal_id ?? usuarios[0].branch_id) : null;
    if (principal !== null && principal !== undefined && Number(principal) === Number(branchId)) {
      throw new Error('Es la sucursal principal del usuario: cámbiala en su ficha.');
    }
    const r = await query(
      "UPDATE user_branch_access SET estado = 'Revocado', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND branch_id = ?",
      [Number(userId || 0), Number(branchId || 0)]
    );
    return Number(r?.affectedRows || 0) > 0;
  }

  return { sucursalesDelUsuario, puedeEntrarASucursal, asignar, revocar };
}

module.exports = { createAccesoSucursales };

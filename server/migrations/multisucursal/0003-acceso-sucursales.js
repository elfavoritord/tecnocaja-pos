'use strict';

/**
 * ms-0003 — Acceso de usuarios a varias sucursales.
 *
 * Hoy cada usuario tiene UNA sucursal (users.sucursal_id ?? users.branch_id,
 * ver getUserBranchIdValue en server.js). Un dueño, un supervisor de zona o
 * una contadora pueden necesitar varias.
 *
 * La tabla user_branch_access YA EXISTE (la crea ensureWizardExtensions en
 * server.js y db/migration-v2.sql, con access_type) pero nadie la usaba. Esta
 * migración la reutiliza: le agrega estado/origen/updated_at y el índice
 * único, y la llena con la sucursal que ya tiene cada usuario (así el
 * resultado es idéntico al de hoy hasta que alguien asigne más sucursales).
 *
 * La reversión NO borra la tabla (no es de esta migración): quita lo que esta
 * migración agregó y las filas que ella misma insertó (origen 'migracion').
 */

const INDICE = 'uq_user_branch_access';
const INDICE_LEGADO = 'uq_user_branch'; // db/migration-v2.sql (MySQL)

module.exports = {
  id: 'ms-0003-acceso-sucursales',
  descripcion: 'user_branch_access (ya existente) con estado, origen e índice único; llenada con la sucursal actual de cada usuario',

  async up(ctx) {
    const { pk } = ctx.types;
    // Misma forma que ensureWizardExtensions, por si esta migración corre
    // antes (migrador SQLite→MySQL sobre una base sin arrancar).
    await ctx.query(`
      CREATE TABLE IF NOT EXISTS user_branch_access (
        id ${pk},
        user_id INT NOT NULL,
        branch_id INT NOT NULL,
        access_type VARCHAR(30) DEFAULT 'operador',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await ctx.addColumn('user_branch_access', 'estado', "VARCHAR(20) NOT NULL DEFAULT 'Activo'");
    await ctx.addColumn('user_branch_access', 'origen', "VARCHAR(20) NOT NULL DEFAULT 'local'");
    await ctx.addColumn('user_branch_access', 'updated_at', 'DATETIME DEFAULT NULL');

    if (!(await ctx.hasIndex('user_branch_access', INDICE)) && !(await ctx.hasIndex('user_branch_access', INDICE_LEGADO))) {
      // Duplicados de antes (la tabla no tenía índice único en SQLite): se
      // conserva la fila más vieja de cada par usuario/sucursal.
      await ctx.query(`
        DELETE FROM user_branch_access
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT MIN(id) AS id FROM user_branch_access GROUP BY user_id, branch_id
          ) conservar
        )
      `);
      await ctx.createIndex('user_branch_access', INDICE, ['user_id', 'branch_id'], { unique: true });
    }
    await ctx.createIndex('user_branch_access', 'idx_user_branch_access_branch', ['branch_id']);

    if (ctx.options.backfill === false) return;
    if (!(await ctx.hasTable('users')) || !(await ctx.hasTable('branches'))) return;
    const tieneSucursalId = await ctx.hasColumn('users', 'sucursal_id');
    const tieneBranchId = await ctx.hasColumn('users', 'branch_id');
    if (!tieneSucursalId && !tieneBranchId) return;
    const sucursalDelUsuario = tieneSucursalId && tieneBranchId
      ? 'COALESCE(u.sucursal_id, u.branch_id)'
      : (tieneSucursalId ? 'u.sucursal_id' : 'u.branch_id');

    await ctx.query(`
      INSERT INTO user_branch_access (user_id, branch_id, access_type, estado, origen)
      SELECT u.id, ${sucursalDelUsuario}, 'principal', 'Activo', 'migracion'
      FROM users u
      WHERE ${sucursalDelUsuario} IS NOT NULL
        AND EXISTS (SELECT 1 FROM branches b WHERE b.id = ${sucursalDelUsuario})
        AND NOT EXISTS (
          SELECT 1 FROM user_branch_access a
          WHERE a.user_id = u.id AND a.branch_id = ${sucursalDelUsuario}
        )
    `);
  },

  async verificar(ctx) {
    if (!(await ctx.hasTable('user_branch_access'))) return false;
    for (const columna of ['estado', 'origen', 'updated_at']) {
      if (!(await ctx.hasColumn('user_branch_access', columna))) return false;
    }
    return (await ctx.hasIndex('user_branch_access', INDICE)) || ctx.hasIndex('user_branch_access', INDICE_LEGADO);
  },

  async down(ctx) {
    if (!(await ctx.hasTable('user_branch_access'))) return;
    if (await ctx.hasColumn('user_branch_access', 'origen')) {
      await ctx.query("DELETE FROM user_branch_access WHERE origen = 'migracion'");
    }
    await ctx.dropIndex('user_branch_access', 'idx_user_branch_access_branch');
    await ctx.dropIndex('user_branch_access', INDICE);
    await ctx.dropColumn('user_branch_access', 'updated_at');
    await ctx.dropColumn('user_branch_access', 'origen');
    await ctx.dropColumn('user_branch_access', 'estado');
  },
};

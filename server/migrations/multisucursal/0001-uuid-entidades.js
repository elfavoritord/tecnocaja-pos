'use strict';

/**
 * ms-0001 — UUID estable en las entidades que viajan entre sucursales y la nube.
 *
 * Los ids enteros son locales de cada base: con una base por sucursal, todas
 * nacen con branch 1, venta 1… y en la nube se pisarían (pasó con A & F
 * LIQUOR STORE al restaurar un respaldo viejo). El uuid es la identidad que
 * se usa fuera de la base; el id entero sigue siendo la llave interna y no se
 * toca ninguna consulta existente.
 *
 * Solo agrega una columna NULL + índice único (varios NULL están permitidos
 * en SQLite y MariaDB). Las filas nuevas que inserta el código actual quedan
 * con uuid NULL hasta que identidad.rellenarUuidsFaltantes() o
 * asegurarUuid() se lo asignan.
 */

const TABLAS_CON_UUID = [
  'businesses',
  'branches',
  'cash_registers',
  'users',
  'categories',
  'products',
  'clients',
  'suppliers',
  'sales',
  'inventory_movements',
  'cash_sessions',
  'branch_transfers',
];

module.exports = {
  id: 'ms-0001-uuid-entidades',
  descripcion: 'Columna uuid (identidad estable) en empresas, sucursales, cajas, usuarios, catálogo, ventas, inventario y caja',
  TABLAS_CON_UUID,

  async up(ctx) {
    for (const tabla of TABLAS_CON_UUID) {
      if (!(await ctx.hasTable(tabla))) continue;
      await ctx.addColumn(tabla, 'uuid', 'VARCHAR(36) DEFAULT NULL');
      if (ctx.options.backfill !== false) {
        await ctx.query(`UPDATE ${tabla} SET \`uuid\` = ${ctx.uuidSql()} WHERE \`uuid\` IS NULL`);
      }
      await ctx.createIndex(tabla, `uq_${tabla}_uuid`, ['uuid'], { unique: true });
    }
  },

  async verificar(ctx) {
    for (const tabla of TABLAS_CON_UUID) {
      if (!(await ctx.hasTable(tabla))) continue;
      if (!(await ctx.hasColumn(tabla, 'uuid'))) return false;
      if (!(await ctx.hasIndex(tabla, `uq_${tabla}_uuid`))) return false;
    }
    return true;
  },

  async down(ctx) {
    for (const tabla of [...TABLAS_CON_UUID].reverse()) {
      if (!(await ctx.hasTable(tabla))) continue;
      await ctx.dropIndex(tabla, `uq_${tabla}_uuid`);
      await ctx.dropColumn(tabla, 'uuid');
    }
  },
};

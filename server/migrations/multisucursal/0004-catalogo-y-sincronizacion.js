'use strict';

/**
 * ms-0004 — Catálogo de la empresa, usuarios por sucursal, marcas de
 * sincronización, conflictos, bitácora y rangos NCF asignados por la central
 * (Fases 4, 5 y 7 del proyecto multisucursal).
 *
 * Solo agrega columnas NULL/con valor por defecto y tablas nuevas: ninguna
 * consulta existente cambia. Con una base por sucursal, products.precio_venta
 * y products.stock locales YA SON el precio y la existencia de esa sucursal;
 * el catálogo central nunca los toca.
 *
 * products
 *   alcance_empresa     'local' (no sale de esta base) | 'global' | 'sucursales'
 *   sucursales_empresa  JSON con los branchUuid cuando alcance = 'sucursales'
 *   origen_catalogo     'local' | 'central' (llegó del catálogo de la empresa)
 *   catalogo_version    versión central aplicada o publicada
 *   catalogo_hash       huella de los datos maestros publicados/aplicados
 *   catalogo_estado     último estado (Activo/Inactivo) que mandó la central: la
 *                       disponibilidad local solo cambia cuando la central lo cambia
 *   sucursal_marca      "precio|costo|stock|estado" enviado a la central
 * users
 *   sucursales_empresa  JSON: ["*"] o branchUuid donde puede entrar (NULL = solo esta base)
 *   origen_usuario      'local' | 'central'
 *   usuario_version / usuario_hash
 * sales
 *   sync_marca          último estado enviado (sale_status|anulada)
 */

const TABLAS = ['sync_conflictos', 'sync_bitacora', 'ncf_rangos_central'];

const COLUMNAS = {
  products: [
    ['alcance_empresa', "VARCHAR(20) NOT NULL DEFAULT 'local'"],
    ['sucursales_empresa', 'TEXT DEFAULT NULL'],
    ['origen_catalogo', "VARCHAR(20) NOT NULL DEFAULT 'local'"],
    ['catalogo_version', 'INT NOT NULL DEFAULT 0'],
    ['catalogo_hash', 'VARCHAR(64) DEFAULT NULL'],
    ['catalogo_estado', 'VARCHAR(20) DEFAULT NULL'],
    ['sucursal_marca', 'VARCHAR(120) DEFAULT NULL'],
  ],
  users: [
    ['sucursales_empresa', 'TEXT DEFAULT NULL'],
    ['origen_usuario', "VARCHAR(20) NOT NULL DEFAULT 'local'"],
    ['usuario_version', 'INT NOT NULL DEFAULT 0'],
    ['usuario_hash', 'VARCHAR(64) DEFAULT NULL'],
  ],
  sales: [
    ['sync_marca', 'VARCHAR(40) DEFAULT NULL'],
  ],
};

module.exports = {
  id: 'ms-0004-catalogo-y-sincronizacion',
  descripcion: 'Catálogo de la empresa, usuarios por sucursal, marcas de sincronización, conflictos, bitácora y rangos NCF de la central',
  TABLAS,
  COLUMNAS,

  async up(ctx) {
    const { pk, longText, text } = ctx.types;
    for (const [tabla, columnas] of Object.entries(COLUMNAS)) {
      if (!(await ctx.hasTable(tabla))) continue;
      for (const [columna, definicion] of columnas) await ctx.addColumn(tabla, columna, definicion);
    }
    if (await ctx.hasTable('products')) {
      await ctx.createIndex('products', 'idx_products_alcance_empresa', ['alcance_empresa']);
    }

    // Lo que llegó de la central y no se pudo aplicar solo (un código o un
    // usuario que ya existe en esta base con otra identidad). Se resuelve a
    // mano con "Vincular": nunca se une por nombre o código en silencio.
    await ctx.query(`
      CREATE TABLE IF NOT EXISTS sync_conflictos (
        id ${pk},
        entity_type VARCHAR(40) NOT NULL,
        entity_uuid VARCHAR(36) NOT NULL,
        clave VARCHAR(160) DEFAULT NULL,
        local_id INT DEFAULT NULL,
        payload ${longText} NOT NULL,
        motivo VARCHAR(255) NOT NULL,
        estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        created_at_utc VARCHAR(30) NOT NULL,
        resuelto_at_utc VARCHAR(30) DEFAULT NULL
      )
    `);
    await ctx.createIndex('sync_conflictos', 'uq_sync_conflictos_entidad', ['entity_type', 'entity_uuid'], { unique: true });

    // Bitácora de cada ciclo de sincronización (observabilidad): duración,
    // eventos, bytes y resultado. Se recorta a los últimos 2000.
    await ctx.query(`
      CREATE TABLE IF NOT EXISTS sync_bitacora (
        id ${pk},
        started_at_utc VARCHAR(30) NOT NULL,
        finished_at_utc VARCHAR(30) DEFAULT NULL,
        duracion_ms INT NOT NULL DEFAULT 0,
        resultado VARCHAR(20) NOT NULL,
        enviados INT NOT NULL DEFAULT 0,
        confirmados INT NOT NULL DEFAULT 0,
        rechazados INT NOT NULL DEFAULT 0,
        recibidos INT NOT NULL DEFAULT 0,
        aplicados INT NOT NULL DEFAULT 0,
        conflictos INT NOT NULL DEFAULT 0,
        bytes_enviados INT NOT NULL DEFAULT 0,
        bytes_recibidos INT NOT NULL DEFAULT 0,
        detalle ${text} DEFAULT NULL
      )
    `);

    // Rangos NCF que la central asignó a ESTA sucursal. La numeración se sigue
    // consumiendo con la tabla de secuencias de siempre (getNextNcf); esta
    // tabla solo dice qué rango toca usar y en qué quedó.
    await ctx.query(`
      CREATE TABLE IF NOT EXISTS ncf_rangos_central (
        rango_uuid VARCHAR(36) NOT NULL PRIMARY KEY,
        tipo VARCHAR(5) NOT NULL,
        desde INT NOT NULL,
        hasta INT NOT NULL,
        vence VARCHAR(10) DEFAULT NULL,
        autorizacion VARCHAR(60) DEFAULT NULL,
        estado VARCHAR(20) NOT NULL DEFAULT 'en_espera',
        sistema VARCHAR(10) DEFAULT NULL,
        secuencia_local_id INT DEFAULT NULL,
        motivo ${text} DEFAULT NULL,
        recibido_at_utc VARCHAR(30) NOT NULL,
        actualizado_at_utc VARCHAR(30) DEFAULT NULL
      )
    `);
    await ctx.createIndex('ncf_rangos_central', 'idx_ncf_rangos_central_tipo', ['tipo', 'estado']);
  },

  async verificar(ctx) {
    for (const tabla of TABLAS) {
      if (!(await ctx.hasTable(tabla))) return false;
    }
    for (const [tabla, columnas] of Object.entries(COLUMNAS)) {
      if (!(await ctx.hasTable(tabla))) continue;
      for (const [columna] of columnas) {
        if (!(await ctx.hasColumn(tabla, columna))) return false;
      }
    }
    return true;
  },

  // Un rango NCF en uso no se suelta al revertir: la secuencia local ya lo
  // está consumiendo y la central lo tiene asignado a esta sucursal.
  async down(ctx) {
    if (await ctx.hasTable('ncf_rangos_central')) {
      const enUso = await ctx.countRows('ncf_rangos_central', "estado IN ('en_uso', 'en_espera')");
      if (enUso > 0) throw new Error(`ncf_rangos_central tiene ${enUso} rango(s) asignado(s); no se revierte.`);
    }
    for (const tabla of [...TABLAS].reverse()) await ctx.dropTable(tabla);
    if (await ctx.hasTable('products')) await ctx.dropIndex('products', 'idx_products_alcance_empresa');
    for (const [tabla, columnas] of Object.entries(COLUMNAS)) {
      if (!(await ctx.hasTable(tabla))) continue;
      for (const [columna] of [...columnas].reverse()) await ctx.dropColumn(tabla, columna);
    }
  },
};

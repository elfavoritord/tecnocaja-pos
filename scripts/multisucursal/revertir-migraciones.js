'use strict';

/**
 * Revierte migraciones multisucursal en la base configurada (la de este
 * userData). Por defecto SOLO muestra qué haría.
 *
 *   node scripts/multisucursal/revertir-migraciones.js                       → estado
 *   node scripts/multisucursal/revertir-migraciones.js --hasta ms-0001-uuid-entidades
 *   node scripts/multisucursal/revertir-migraciones.js --hasta ms-0001-uuid-entidades --confirmar
 *
 * Revierte de la última hacia atrás, hasta la indicada (incluida), después de
 * un respaldo .tcbak verificable. Con la app CERRADA (en SQLite la app tiene la
 * base en memoria y la volvería a escribir).
 *
 * Normalmente no hace falta: las migraciones solo agregan columnas y tablas
 * que el resto del POS no usa. Para apagar la Fase 2 basta
 * TECNO_CAJA_MULTISUCURSAL_DESACTIVAR=1 en config/app.env.
 */

const db = require('../../db');
const { createMigrationRunner } = require('../../server/migrations/runner');
const migraciones = require('../../server/migrations/multisucursal');
const { crearRespaldoPrevio } = require('../../server/multisucursal/respaldo-previo');

function argumento(nombre) {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : null;
}

(async () => {
  const dialect = db.getDbClient() === 'mysql' ? 'mysql' : 'sqlite';
  const destino = dialect === 'mysql'
    ? `MariaDB ${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME || 'tecnocaja'}`
    : `SQLite ${process.env.DB_FILE}`;
  console.log(`Base: ${destino}`);

  const runner = createMigrationRunner({ query: db.query, withTransaction: db.withTransaction, dialect, migrations: migraciones });
  const estado = await runner.status();
  for (const m of estado) console.log(`  ${m.aplicada ? '✔' : '·'} ${m.id} — ${m.descripcion}`);

  const hasta = argumento('--hasta');
  if (!hasta) return;
  const indice = migraciones.findIndex((m) => m.id === hasta);
  if (indice < 0) throw new Error(`No existe la migración ${hasta}`);
  const aRevertir = estado.slice(indice).filter((m) => m.registrada).map((m) => m.id).reverse();
  if (!aRevertir.length) {
    console.log('Nada que revertir.');
    return;
  }
  console.log(`Se revertiría, en este orden: ${aRevertir.join(' → ')}`);
  if (!process.argv.includes('--confirmar')) {
    console.log('Sin --confirmar no se cambia nada.');
    return;
  }

  const respaldo = await crearRespaldoPrevio({ query: db.query, migraciones: aRevertir, prefijo: 'PRE-REVERSION' });
  console.log(`Respaldo previo: ${respaldo.ruta || respaldo.omitido}`);
  for (const id of aRevertir) {
    await runner.revert(id);
    console.log(`  revertida ${id}`);
  }
  await db.flushPendingSave();
})()
  .then(() => db.flushPendingSave().then(() => process.exit(0)))
  .catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });

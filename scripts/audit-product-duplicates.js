/**
 * audit-product-duplicates.js
 *
 * Corre esto ANTES de actualizar una instalación existente a una versión que
 * ya soporte catálogo de productos por sucursal (products.branch_id).
 *
 * La nueva regla de colisión bloquea código/nombre duplicado dentro del mismo
 * alcance (global o misma sucursal). Si un negocio ya tenía productos
 * duplicados colados por un bug viejo o por edición directa de la base de
 * datos, esos duplicados no se tocan solos con la migración — pero la
 * próxima vez que alguien intente editarlos o reimportarlos por CSV, la
 * nueva validación los va a rechazar. Mejor encontrarlos y limpiarlos antes.
 *
 * Uso (desde la raíz del proyecto, con el .env de la instalación a revisar):
 *   node scripts/audit-product-duplicates.js
 */

'use strict';

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
try { require('dotenv').config(); } catch (_) {}

const mysql2 = require('mysql2/promise');

async function findDuplicates(conn, field) {
  const [rows] = await conn.query(
    `SELECT LOWER(${field}) AS valor, COUNT(*) AS total, GROUP_CONCAT(id) AS ids
     FROM products
     WHERE ${field} IS NOT NULL AND ${field} <> ''
     GROUP BY LOWER(${field})
     HAVING COUNT(*) > 1
     ORDER BY total DESC`
  );
  return rows;
}

(async () => {
  const conn = await mysql2.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'tecnocaja',
  });

  console.log('\n🔍 Auditoría de productos duplicados (antes de habilitar catálogo por sucursal)\n');

  try {
    const [dupCodigos, dupNombres] = await Promise.all([
      findDuplicates(conn, 'codigo'),
      findDuplicates(conn, 'nombre'),
    ]);

    if (!dupCodigos.length && !dupNombres.length) {
      console.log('✅ No se encontraron códigos ni nombres duplicados. Todo limpio.\n');
      process.exit(0);
    }

    if (dupCodigos.length) {
      console.log(`⚠️  ${dupCodigos.length} código(s) repetido(s):`);
      dupCodigos.forEach((row) => {
        console.log(`   - "${row.valor}" → ${row.total} productos (ids: ${row.ids})`);
      });
      console.log('');
    }

    if (dupNombres.length) {
      console.log(`⚠️  ${dupNombres.length} nombre(s) repetido(s):`);
      dupNombres.forEach((row) => {
        console.log(`   - "${row.valor}" → ${row.total} productos (ids: ${row.ids})`);
      });
      console.log('');
    }

    console.log(
      'Antes de que alguien edite o reimporte por CSV estos productos, revísalos\n' +
      'a mano: si de verdad son el mismo producto, elimina el duplicado; si son\n' +
      'productos distintos que deberían pertenecer a sucursales distintas,\n' +
      'asígnales su sucursal correcta desde el panel de Productos.\n'
    );
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
})().catch((error) => {
  console.error('❌ Error corriendo la auditoría:', error.message);
  process.exit(1);
});

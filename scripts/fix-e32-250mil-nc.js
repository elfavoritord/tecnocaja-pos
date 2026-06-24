/**
 * Script único: agrega NombreComercial="DOCUMENTOS ELECTRONICOS" al rawRow de
 * E320000000012-15 en la tabla ecf_documents.
 *
 * Dataset oficial DGII (40211932609-17062026010303.xlsx) confirma que la columna
 * NombreComercial en la hoja ECF para estos 4 comprobantes es "DOCUMENTOS ELECTRONICOS".
 * El import anterior dejó ese campo null porque venía de la hoja RFCE (sin NC).
 *
 * Uso: node scripts/fix-e32-250mil-nc.js
 * Requiere que la app (MariaDB embebida) esté corriendo.
 */
'use strict';

const mysql = require('mysql2/promise');

const ENCFS = ['E320000000012', 'E320000000013', 'E320000000014', 'E320000000015'];
const NEW_NC = 'DOCUMENTOS ELECTRONICOS';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || process.env.DB_DATABASE || 'novapos',
  });

  console.log('Conectado a MariaDB. Actualizando NombreComercial para E32 <250Mil...\n');

  for (const encf of ENCFS) {
    const [rows] = await conn.query(
      'SELECT id, certification_original_xml FROM ecf_documents WHERE encf = ? LIMIT 1',
      [encf]
    );

    if (!rows.length) {
      console.log(`  [SKIP] ${encf}: no encontrado en ecf_documents`);
      continue;
    }

    const { id, certification_original_xml } = rows[0];
    if (!certification_original_xml) {
      console.log(`  [SKIP] ${encf}: certification_original_xml vacío`);
      continue;
    }

    let certSource;
    try {
      certSource = JSON.parse(certification_original_xml);
    } catch (_) {
      console.log(`  [ERROR] ${encf}: JSON inválido en certification_original_xml`);
      continue;
    }

    let changed = false;

    if (certSource.row && certSource.row.NombreComercial !== NEW_NC) {
      const before = certSource.row.NombreComercial;
      certSource.row.NombreComercial = NEW_NC;
      console.log(`  ${encf} row.NombreComercial: "${before}" → "${NEW_NC}"`);
      changed = true;
    }

    if (certSource.linkedRawRow) {
      if (certSource.linkedRawRow.NombreComercial !== NEW_NC) {
        const before = certSource.linkedRawRow.NombreComercial;
        certSource.linkedRawRow.NombreComercial = NEW_NC;
        console.log(`  ${encf} linkedRawRow.NombreComercial: "${before}" → "${NEW_NC}"`);
        changed = true;
      }
    }

    if (!changed) {
      console.log(`  [OK] ${encf}: ya tiene NC="${NEW_NC}", sin cambios`);
      continue;
    }

    await conn.query(
      'UPDATE ecf_documents SET certification_original_xml = ? WHERE id = ?',
      [JSON.stringify(certSource), id]
    );
    console.log(`  ✓ ${encf} actualizado (id=${id})\n`);
  }

  await conn.end();
  console.log('\nListo. Ahora en la UI usa "Preparar archivos para portal" para regenerar el LOTE.');
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

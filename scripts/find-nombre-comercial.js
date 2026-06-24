'use strict';
// Busca todos los docs de certificación que tienen NombreComercial en su XML original
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: parseInt(process.env.DB_PORT || '3306'), user: process.env.DB_USER || 'root', password: process.env.DB_PASS || process.env.DB_PASSWORD || '', database: process.env.DB_NAME || process.env.DB_DATABASE || 'novapos'
  });

  const [rows] = await c.query(`
    SELECT id, encf, tipo_ecf, estado_dgii, submission_mode, certification_case_key,
           certification_original_xml
    FROM ecf_documents
    WHERE business_id=1 AND certification_case_key IS NOT NULL
    ORDER BY tipo_ecf, id
  `);

  console.log(`Total docs certificación: ${rows.length}`);
  console.log('\n=== Docs con NombreComercial en certification_original_xml ===');
  let found = 0;
  for (const r of rows) {
    let orig = null;
    try { orig = JSON.parse(r.certification_original_xml || '{}'); } catch {}
    const nc = orig?.row?.NombreComercial;
    if (nc !== undefined && nc !== null && nc !== '') {
      found++;
      console.log(`  id=${r.id} encf=${r.encf} tipo=${r.tipo_ecf} estado=${r.estado_dgii} mode=${r.submission_mode}`);
      console.log(`    NombreComercial="${nc}"`);
    }
  }
  if (found === 0) console.log('  (ninguno)');
  console.log(`\nTotal con NombreComercial: ${found}`);

  // También mostrar batch activo
  const [batch] = await c.query(`
    SELECT certification_batch_id, COUNT(*) as n
    FROM ecf_documents
    WHERE business_id=1 AND certification_case_key IS NOT NULL
    GROUP BY certification_batch_id
    ORDER BY certification_batch_id DESC
  `);
  console.log('\n=== Batches ===');
  for (const b of batch) console.log(`  batch=${b.certification_batch_id} n=${b.n}`);

  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });

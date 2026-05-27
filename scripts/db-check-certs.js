'use strict';
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'novapos'
  });

  const [r1] = await c.query(`
    SELECT tipo_ecf, estado_dgii, submission_mode, COUNT(*) as n
    FROM ecf_documents
    WHERE business_id=1 AND certification_case_key IS NOT NULL
    GROUP BY tipo_ecf, estado_dgii, submission_mode
    ORDER BY tipo_ecf, estado_dgii
  `);
  console.log('=== Certification docs by tipo/estado/mode ===');
  for (const r of r1) {
    console.log(`  ${r.tipo_ecf}|${r.estado_dgii}|${r.submission_mode || 'null'}|n=${r.n}`);
  }

  const [r2] = await c.query(`
    SELECT id, encf, tipo_ecf, estado_dgii, submission_mode, certification_case_key,
           LEFT(certification_original_xml, 200) as prev
    FROM ecf_documents
    WHERE business_id=1 AND certification_case_key IS NOT NULL
    ORDER BY tipo_ecf, id
    LIMIT 30
  `);
  console.log('\n=== All certification docs (first 30) ===');
  for (const r of r2) {
    const nc = (r.prev || '').match(/"NombreComercial":"([^"]*)"/);
    console.log(`  id=${r.id} encf=${r.encf} tipo=${r.tipo_ecf} estado=${r.estado_dgii} mode=${r.submission_mode || 'null'} NomCom=${nc ? nc[1] : '(none)'}`);
  }

  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });

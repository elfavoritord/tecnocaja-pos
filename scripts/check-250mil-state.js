'use strict';
const db = require('../db');

db.query(
  `SELECT id, encf, tipo_ecf, estado_dgii, submission_mode,
          certification_case_key,
          SUBSTR(certification_original_xml, 1, 300) as orig_preview
   FROM ecf_documents
   WHERE business_id=1
     AND certification_case_key IS NOT NULL
     AND tipo_ecf = '32'
   ORDER BY certification_case_key, id`
).then(([rows]) => {
  console.log('Total E32 certification docs:', rows.length);
  for (const r of rows) {
    console.log(`\nid=${r.id} encf=${r.encf} estado=${r.estado_dgii} mode=${r.submission_mode}`);
    console.log(`  case_key=${r.certification_case_key}`);
    const preview = r.orig_preview || '';
    const nomCom = preview.match(/"NombreComercial"\s*:\s*"([^"]*)"/);
    console.log(`  NombreComercial in orig_xml: ${nomCom ? nomCom[1] : '(not found)'}`);
  }
  process.exit(0);
}).catch(e => {
  console.error(e.message);
  process.exit(1);
});

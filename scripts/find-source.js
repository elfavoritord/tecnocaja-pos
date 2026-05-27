'use strict';
// Busca EXACTAMENTE de dónde viene "DOCUMENTOS ELECTRONICOS" en el XML enviado
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

(async () => {
  const c = await mysql.createConnection({
    host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'novapos'
  });

  // 1. Ver certification_original_xml completo de los 4 RFCE docs
  console.log('\n=== certification_original_xml de docs RFCE ===');
  const [rfce] = await c.query(`
    SELECT id, encf, estado_dgii, certification_original_xml, xml_content, signed_xml_content
    FROM ecf_documents
    WHERE business_id=1 AND certification_case_key IS NOT NULL AND submission_mode='rfce'
    ORDER BY encf
  `);
  for (const r of rfce) {
    let orig = {};
    try { orig = JSON.parse(r.certification_original_xml || '{}'); } catch {}
    const nc = orig?.row?.NombreComercial;
    console.log(`\n  encf=${r.encf} estado=${r.estado_dgii}`);
    console.log(`  NombreComercial in orig_xml: "${nc ?? '(not found)'}"`);
    // Buscar "DOCUMENTOS ELECTRONICOS" en cualquier campo del orig_xml
    const raw = r.certification_original_xml || '';
    if (raw.includes('DOCUMENTOS ELECTRONICOS')) {
      const matches = [...raw.matchAll(/"(\w+)"\s*:\s*"([^"]*DOCUMENTOS ELECTRONICOS[^"]*)"/g)];
      for (const m of matches) {
        console.log(`  !! Found "${m[1]}" = "${m[2]}"`);
      }
    } else {
      console.log('  (no "DOCUMENTOS ELECTRONICOS" en orig_xml)');
    }
    // Ver xml_content si existe
    if (r.xml_content) {
      const xc = r.xml_content || '';
      if (xc.includes('DOCUMENTOS ELECTRONICOS')) {
        console.log(`  !! xml_content contiene "DOCUMENTOS ELECTRONICOS"`);
        const idx = xc.indexOf('DOCUMENTOS ELECTRONICOS');
        console.log(`  Context: ...${xc.slice(Math.max(0,idx-50), idx+80)}...`);
      }
    }
    if (r.signed_xml_content) {
      const sx = r.signed_xml_content || '';
      if (sx.includes('DOCUMENTOS ELECTRONICOS')) {
        console.log(`  !! signed_xml_content contiene "DOCUMENTOS ELECTRONICOS"`);
        const idx = sx.indexOf('DOCUMENTOS ELECTRONICOS');
        console.log(`  Context: ...${sx.slice(Math.max(0,idx-50), idx+80)}...`);
      }
    }
  }

  // 2. Buscar en TODOS los docs de cert cualquier referencia a "DOCUMENTOS ELECTRONICOS" sin " DE "
  console.log('\n=== Busca "DOCUMENTOS ELECTRONICOS" sin "DE 02" en todos los docs ===');
  const [all] = await c.query(`
    SELECT id, encf, tipo_ecf, estado_dgii, submission_mode, certification_original_xml, xml_content, signed_xml_content
    FROM ecf_documents
    WHERE business_id=1 AND certification_case_key IS NOT NULL
  `);
  for (const r of all) {
    const raw = r.certification_original_xml || '';
    // Buscar "DOCUMENTOS ELECTRONICOS" que NO sea seguido de " DE "
    if (raw.includes('DOCUMENTOS ELECTRONICOS') && !raw.includes('DOCUMENTOS ELECTRONICOS DE 02')) {
      console.log(`\n  !! id=${r.id} encf=${r.encf} tipo=${r.tipo_ecf} modo=${r.submission_mode}`);
      const matches = [...raw.matchAll(/"(\w+)"\s*:\s*"([^"]*DOCUMENTOS ELECTRONICOS[^"]*)"/g)];
      for (const m of matches) {
        if (!m[2].includes('DE 02')) console.log(`    Field "${m[1]}" = "${m[2]}"`);
      }
    }
  }

  // 3. Ver stored signed XMLs en filesystem
  console.log('\n=== Archivos XML en storage/ecf/certification/signed ===');
  const signedDir = path.join(__dirname, '..', 'storage', 'ecf', 'certification', 'signed');
  if (fs.existsSync(signedDir)) {
    const files = fs.readdirSync(signedDir).filter(f => f.endsWith('.xml'));
    for (const f of files) {
      const content = fs.readFileSync(path.join(signedDir, f), 'utf8');
      const hasNomCom = content.includes('<NombreComercial>');
      const nomComMatch = content.match(/<NombreComercial>([^<]*)<\/NombreComercial>/);
      if (hasNomCom) {
        console.log(`  ${f}: NombreComercial="${nomComMatch ? nomComMatch[1] : '?'}"`);
      }
    }
  }

  // 4. Estado actual de todos los docs
  console.log('\n=== Estado resumido ===');
  const [summary] = await c.query(`
    SELECT tipo_ecf, estado_dgii, submission_mode, COUNT(*) as n
    FROM ecf_documents
    WHERE business_id=1 AND certification_case_key IS NOT NULL
    GROUP BY tipo_ecf, estado_dgii, submission_mode ORDER BY tipo_ecf, estado_dgii
  `);
  for (const s of summary) {
    console.log(`  ${s.tipo_ecf}|${s.estado_dgii}|${s.submission_mode||'null'}|n=${s.n}`);
  }

  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });

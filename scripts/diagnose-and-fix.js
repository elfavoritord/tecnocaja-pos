'use strict';
/**
 * diagnose-and-fix.js
 * 1. Muestra el estado actual de TODOS los docs de certificación
 * 2. Arregla NCFModificado en E33/E34 para que apunte al eNCF actual del E32 referenciado
 * 3. Quita NombreComercial = "DOCUMENTOS ELECTRONICOS" de cualquier doc
 */
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'novapos'
  });

  const [docs] = await c.query(`
    SELECT id, encf, tipo_ecf, estado_dgii, submission_mode, certification_case_key,
           certification_original_xml
    FROM ecf_documents
    WHERE business_id=1 AND certification_case_key IS NOT NULL
    ORDER BY tipo_ecf, encf
  `);

  console.log(`\nTotal docs certificación: ${docs.length}\n`);

  // Parsear todos
  const parsed = docs.map(d => {
    let orig = null;
    try { orig = JSON.parse(d.certification_original_xml || '{}'); } catch {}
    return { ...d, orig };
  });

  // Mostrar estado
  for (const d of parsed) {
    const nc  = d.orig?.row?.NombreComercial;
    const ncm = d.orig?.row?.NCFModificado;
    const oe  = d.orig?.row?.ENCF;
    console.log(`  id=${d.id} encf=${d.encf} tipo=${d.tipo_ecf} estado=${d.estado_dgii} mode=${d.submission_mode || 'null'}`);
    if (oe && oe !== d.encf) console.log(`    orig_ENCF=${oe} (rotado desde orig)`);
    if (ncm)    console.log(`    NCFModificado=${ncm}`);
    if (nc && nc !== '#e') console.log(`    NombreComercial="${nc}"`);
  }

  // --- FIX 1: NCFModificado ---
  // Construir mapa de orig_ENCF → encf_actual para todos los docs
  const origToCurrentEncf = new Map();
  for (const d of parsed) {
    const origEncf = d.orig?.row?.ENCF;
    if (origEncf) origToCurrentEncf.set(String(origEncf).trim().toUpperCase(), d.encf);
    // También mapear el encf actual a sí mismo (por si ya fue parcialmente actualizado)
    origToCurrentEncf.set(String(d.encf).trim().toUpperCase(), d.encf);
  }

  console.log('\n=== Fix NCFModificado ===');
  let ncmFixed = 0;
  for (const d of parsed) {
    const ncm = d.orig?.row?.NCFModificado;
    if (!ncm || ncm === '#e') continue;

    const ncmNorm = String(ncm).trim().toUpperCase();
    const currentTarget = origToCurrentEncf.get(ncmNorm);

    if (!currentTarget) {
      console.log(`  ⚠ id=${d.id} encf=${d.encf}: NCFModificado="${ncm}" → sin doc referenciado en batch`);
      continue;
    }

    if (currentTarget === ncmNorm) {
      console.log(`  ✓ id=${d.id} encf=${d.encf}: NCFModificado="${ncm}" ya es correcto`);
      continue;
    }

    // Necesita actualización
    d.orig.row.NCFModificado = currentTarget;
    await c.query(
      `UPDATE ecf_documents SET certification_original_xml=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [JSON.stringify(d.orig), d.id]
    );
    console.log(`  ✓ Fix id=${d.id} encf=${d.encf}: NCFModificado "${ncm}" → "${currentTarget}"`);
    ncmFixed++;
  }
  if (ncmFixed === 0) console.log('  (sin cambios necesarios en NCFModificado)');

  // --- FIX 2: NombreComercial "DOCUMENTOS ELECTRONICOS" ---
  console.log('\n=== Fix NombreComercial ===');
  let ncFixed = 0;
  for (const d of parsed) {
    const nc = d.orig?.row?.NombreComercial;
    if (!nc || nc === '#e' || !nc.includes('DOCUMENTOS ELECTRONICOS')) continue;
    // Solo arreglar si es exactamente "DOCUMENTOS ELECTRONICOS" (sin "DE 02")
    if (nc === 'DOCUMENTOS ELECTRONICOS') {
      delete d.orig.row.NombreComercial;
      await c.query(
        `UPDATE ecf_documents SET certification_original_xml=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [JSON.stringify(d.orig), d.id]
      );
      console.log(`  ✓ Fix id=${d.id} encf=${d.encf}: eliminado NombreComercial="${nc}"`);
      ncFixed++;
    }
  }
  if (ncFixed === 0) console.log('  (sin NombreComercial="DOCUMENTOS ELECTRONICOS" encontrado)');

  // --- FIX 3: Limpiar XMLs firmados para forzar re-generación ---
  console.log('\n=== Limpiando xml_content y signed_xml de docs firmado/pendiente ===');
  const [res] = await c.query(`
    UPDATE ecf_documents
    SET xml_content=NULL, signed_xml=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE business_id=1
      AND certification_case_key IS NOT NULL
      AND estado_dgii IN ('firmado','pendiente')
  `);
  console.log(`  ${res.affectedRows} docs limpiados (xml_content + signed_xml = NULL)`);

  console.log('\n=== Mapa orig_ENCF → encf_actual ===');
  for (const [k, v] of origToCurrentEncf) {
    if (k !== v) console.log(`  ${k} → ${v}`);
  }

  await c.end();
  console.log('\nListo. Ahora ejecuta run-sequential.');
})().catch(e => { console.error(e.message); process.exit(1); });

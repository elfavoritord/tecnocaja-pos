'use strict';
/**
 * Envía TODOS los 21 comprobantes de certificación + 4 RFCE a DGII certecf
 * desde cero — sin depender del servidor principal.
 *
 * Uso: node fix-send-all-certification.js
 */
process.env.NODE_ENV = 'production';
const path = require('path');
const fs = require('fs');
const projectRoot = path.resolve(__dirname, '..', '..');
process.chdir(projectRoot);
try { require('dotenv').config(); } catch (_) {}

const mysql2 = require(path.join(projectRoot, 'node_modules/mysql2/promise'));
const { createEcfService } = require(path.join(projectRoot, 'modules/ecf/services/ecf.service'));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const conn = await mysql2.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || process.env.DB_DATABASE || 'novapos',
  });
  console.log('✅ Conectado a DB\n');

  const makeQueryFn = (c) => async (sql, params) => {
    const [rows] = await c.query(sql, params || []);
    return rows;
  };
  const query = makeQueryFn(conn);
  const withTransaction = async (fn) => {
    await conn.beginTransaction();
    try {
      const r = await fn({ query: makeQueryFn(conn) });
      await conn.commit();
      return r;
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      throw e;
    }
  };
  const resolveRequestActorUser = async () => ({
    id: 1, usuario: 'admin', nombre: 'Sistema', rol: 'administrador', role_code: 'ADMIN',
  });

  const service = createEcfService({ query, withTransaction, resolveRequestActorUser });
  service.ensureReady = async function () {
    ['storage/ecf/certification/signed', 'storage/ecf/enviados',
     'storage/ecf/rfce-enviados', 'storage/ecf/tracks', 'storage/ecf/seeds']
      .forEach((d) => fs.mkdirSync(path.resolve(process.cwd(), d), { recursive: true }));
  };

  // ─── 1. Resetear estado de los 21 docs (no RFCE) a 'firmado' ─────────────
  console.log('═══ PASO 1: Resetear los 21 docs a firmado ═══');
  const [resetResult] = await conn.query(
    `UPDATE ecf_documents
     SET estado_dgii = 'firmado',
         error_message = NULL,
         dgii_response_json = NULL,
         signed_xml_content = NULL,
         xml_content = NULL,
         sent_at = NULL,
         track_id = NULL
     WHERE certification_case_key IS NOT NULL
       AND (submission_mode IS NULL OR submission_mode != 'rfce')`
  );
  console.log(`  Docs reseteados: ${resetResult.affectedRows}`);

  // ─── 2. Resetear el estado de los RFCE también ────────────────────────────
  console.log('\n═══ PASO 2: Resetear estado RFCE ═══');
  const step4Path = path.resolve('storage/ecf/certification/step4-rfce-status.json');
  if (fs.existsSync(step4Path)) {
    const step4 = JSON.parse(fs.readFileSync(step4Path, 'utf8'));
    if (step4.items) {
      step4.items.forEach((item) => {
        item.estado = 'pendiente';
        item.trackId = null;
        item.dgiiResponse = null;
      });
      fs.writeFileSync(step4Path, JSON.stringify(step4, null, 2), 'utf8');
      console.log(`  ${step4.items.length} RFCE reseteados a pendiente`);
    }
  } else {
    console.log('  No existe step4-rfce-status.json (se generará nuevo)');
  }

  // También resetear los docs RFCE en DB
  const [rfceReset] = await conn.query(
    `UPDATE ecf_documents
     SET estado_dgii = 'firmado',
         error_message = NULL,
         dgii_response_json = NULL,
         signed_xml_content = NULL,
         xml_content = NULL,
         sent_at = NULL,
         track_id = NULL
     WHERE certification_case_key IS NOT NULL
       AND submission_mode = 'rfce'`
  );
  console.log(`  Docs RFCE en DB reseteados: ${rfceReset.affectedRows}`);

  // ─── 3. Enviar los 21 docs en secuencia ──────────────────────────────────
  console.log('\n═══ PASO 3: Enviando 21 comprobantes a DGII ═══');
  const mockReq = { body: {}, params: {}, query: {}, headers: {}, session: {} };
  let aceptados = 0;
  let rechazados = 0;
  let attempt = 0;
  const MAX_DOCS = 25; // safety limit

  while (attempt < MAX_DOCS) {
    attempt++;
    const nextDoc = await service.getNextPendingCertificationDoc
      ? service.getNextPendingCertificationDoc()
      : null;

    // Usar la query directa si no hay método público
    const [[pending]] = await conn.query(
      `SELECT id, encf, tipo_ecf, estado_dgii
       FROM ecf_documents
       WHERE certification_case_key IS NOT NULL
         AND (submission_mode IS NULL OR submission_mode != 'rfce')
         AND estado_dgii IN ('pendiente','firmado','error_auth','error_consulta','rechazado','error')
       ORDER BY COALESCE(certification_order_index, id), id
       LIMIT 1`
    );

    if (!pending) {
      console.log('\n  ✅ No quedan docs pendientes');
      break;
    }

    process.stdout.write(`  [${attempt}] ${pending.encf} (${pending.tipo_ecf}) → `);
    try {
      const result = await service.sendCertificationCase(pending.id, mockReq, { skipStatusQuery: false });
      const estado = result.case?.estado_dgii || result.case?.estado || '?';
      const msg = (result.case?.dgiiResponse?.mensajes || [])
        .map((m) => m.valor || JSON.stringify(m)).join('; ');
      console.log(`${estado}${msg ? ' | ' + msg : ''}`);

      if (estado === 'aceptado') {
        aceptados++;
      } else if (estado === 'en_proceso') {
        // Esperar y consultar
        await sleep(3000);
        const [polled] = await conn.query(
          "SELECT estado_dgii FROM ecf_documents WHERE id=?", [pending.id]
        );
        if (polled[0]?.estado_dgii === 'aceptado') aceptados++;
        else rechazados++;
      } else {
        rechazados++;
        console.log(`    ❌ RECHAZADO: ${msg || estado}`);
        if (rechazados >= 3) {
          console.log('  ⛔ Demasiados rechazos, abortando envío de comprobantes');
          break;
        }
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      rechazados++;
    }

    await sleep(1200); // pausa entre envíos
  }

  // Poll para actualizar estados en_proceso
  if (aceptados < 21) {
    console.log('\n  Consultando estados pendientes...');
    await sleep(3000);
    try {
      await service.pollCertificationStatuses();
    } catch (_) {}
  }

  const [[counts]] = await conn.query(
    `SELECT
       SUM(estado_dgii='aceptado') as ok,
       SUM(estado_dgii NOT IN ('aceptado')) as nok
     FROM ecf_documents
     WHERE certification_case_key IS NOT NULL
       AND (submission_mode IS NULL OR submission_mode != 'rfce')`
  );
  console.log(`\n  📊 Resultado comprobantes: ${counts.ok}/21 aceptados, ${counts.nok} pendientes/rechazados`);

  if (parseInt(counts.nok) > 0) {
    console.log('\n❌ Hay comprobantes sin aceptar. No se enviarán RFCE hasta que todos sean aceptados.');
    conn.end();
    return;
  }

  // ─── 4. Generar y enviar los 4 RFCE ─────────────────────────────────────
  console.log('\n═══ PASO 4: Generando y enviando 4 RFCE ═══');
  try {
    console.log('  Generando RFCE...');
    const genResult = await service.step4RfceGenerate(mockReq);
    console.log(`  RFCE generados: ${(genResult.items || []).length}`);

    await sleep(2000);
    console.log('  Enviando RFCE a DGII...');
    const submitResult = await service.step4RfceSubmit(mockReq);
    console.log(`  Enviados: ${submitResult.enviados || 0} | Aceptados: ${submitResult.aceptados || 0}`);

    if (submitResult.aceptados < 4) {
      await sleep(5000);
      console.log('  Consultando estado RFCE...');
      const pollResult = await service.step4RfcePollStatuses(mockReq);
      console.log(`  Poll RFCE: ${JSON.stringify(pollResult?.resumen || {})}`);
    }
  } catch (err) {
    console.error(`  ERROR en RFCE: ${err.message}`);
  }

  // ─── 5. Actualizar PORTAL_VERIFICADO con los 4 E32 firmados ──────────────
  console.log('\n═══ PASO 5: Actualizando archivos portal ═══');
  try {
    const srcDir = path.resolve('storage/ecf/ecf-originales-locales');
    const dstDir = path.resolve('ecf/DGII_CARGAR_AHORA_4_XML_VERIFICADOS/PORTAL_VERIFICADO');
    fs.mkdirSync(dstDir, { recursive: true });
    const rnc = '40211932609';
    let copied = 0;
    for (const encf of ['E320000000012', 'E320000000013', 'E320000000014', 'E320000000015']) {
      const src = path.join(srcDir, encf + '.xml');
      const dst = path.join(dstDir, rnc + encf + '.xml');
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        const size = fs.statSync(dst).size;
        console.log(`  ✅ ${rnc}${encf}.xml (${size} bytes)`);
        copied++;
      } else {
        console.log(`  ⚠  ${encf}.xml no encontrado en ecf-originales-locales`);
      }
    }
    console.log(`  Total archivos portal: ${copied}/4`);
  } catch (err) {
    console.error(`  ERROR portal: ${err.message}`);
  }

  // ─── Resumen final ────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════');
  console.log('          RESUMEN FINAL');
  console.log('════════════════════════════════════════');

  const [[finalCounts]] = await conn.query(
    `SELECT
       SUM(estado_dgii='aceptado') as ok,
       COUNT(*) as total
     FROM ecf_documents
     WHERE certification_case_key IS NOT NULL
       AND (submission_mode IS NULL OR submission_mode != 'rfce')`
  );
  console.log(`Comprobantes (ECF):   ${finalCounts.ok}/${finalCounts.total} aceptados`);

  const step4Final = fs.existsSync(step4Path)
    ? JSON.parse(fs.readFileSync(step4Path, 'utf8'))
    : { items: [] };
  const rfceOk = (step4Final.items || []).filter((i) => i.estado === 'aceptado').length;
  console.log(`RFCE resúmenes:       ${rfceOk}/4 aceptados`);

  const portalDir = path.resolve('ecf/DGII_CARGAR_AHORA_4_XML_VERIFICADOS/PORTAL_VERIFICADO');
  const portalFiles = fs.existsSync(portalDir)
    ? fs.readdirSync(portalDir).filter((f) => f.endsWith('.xml'))
    : [];
  console.log(`Portal XMLs listos:   ${portalFiles.length}/4`);
  console.log('════════════════════════════════════════');

  if (parseInt(finalCounts.ok) === 21 && rfceOk === 4) {
    console.log('\n🎉 21/21 + 4/4 RFCE ¡TODO LISTO!');
    console.log('\n⬆  SIGUIENTE PASO (manual):');
    console.log('   Portal DGII → "Facturas de consumo < 250Mil" → subir los 4 XMLs del PORTAL_VERIFICADO');
  } else {
    console.log('\n⚠  Aún hay pendientes — revisar errores arriba');
  }

  conn.end();
}

main().catch((e) => {
  console.error('\nFatal:', e.message);
  console.error(e.stack?.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});

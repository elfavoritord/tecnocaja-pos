'use strict';
/**
 * Regenera y envía el set completo de Pruebas de Simulación (Paso 4) a DGII.
 * Aplica correctIscEspecificoCerveza en patchRow para que la tasa ISC 006
 * sea válida según el catálogo DGII actual (758.26 Q2-2026).
 */
process.env.NODE_ENV = 'production';
const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname));
try { require('dotenv').config(); } catch (_) {}

const mysql2 = require('./node_modules/mysql2/promise');
const { createEcfService } = require('./modules/ecf/services/ecf.service');

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

  const query = async (sql, p) => { const [r] = await conn.query(sql, p || []); return r; };
  const withTransaction = async (fn) => {
    await conn.beginTransaction();
    try { const r = await fn({ query }); await conn.commit(); return r; }
    catch (e) { try { await conn.rollback(); } catch (_) {} throw e; }
  };
  const service = createEcfService({
    query, withTransaction,
    resolveRequestActorUser: async () => ({ id: 1, usuario: 'admin', nombre: 'Sistema', rol: 'administrador', role_code: 'ADMIN' }),
  });
  service.ensureReady = async () => {
    ['storage/ecf/certification/signed', 'storage/ecf/enviados',
     'storage/ecf/rfce-enviados', 'storage/ecf/tracks', 'storage/ecf/seeds',
     'storage/ecf/ecf-originales-locales']
      .forEach((d) => fs.mkdirSync(path.resolve(process.cwd(), d), { recursive: true }));
  };

  const mockReq = { body: {}, params: {}, query: {}, headers: {}, session: {} };

  // ── 1. Regenerar el set de simulación (con ISC corregida en patchRow) ────────
  console.log('═══ PASO 1: Generando set de simulación ═══');
  let genResult;
  try {
    genResult = await service.generateSimulationSet(mockReq);
    const total = (genResult.results || []).length || 0;
    const ok = (genResult.results || []).filter(r => r.ok !== false).length;
    console.log(`  Docs generados: ${total} | OK inicial: ${ok}`);
  } catch (err) {
    console.error('ERROR generando simulación:', err.message);
    conn.end();
    process.exit(1);
  }

  // ── 2. Esperar un momento y hacer poll de estados ─────────────────────────────
  console.log('\n═══ PASO 2: Consultando estados ═══');
  await sleep(5000);
  try {
    await service.pollCertificationStatuses();
  } catch (_) {}

  // ── 3. Mostrar estado por tipo ────────────────────────────────────────────────
  const [stats] = await conn.query(
    `SELECT tipo_ecf, estado_dgii, COUNT(*) as cnt
     FROM ecf_documents
     WHERE certification_case_key IS NOT NULL
       AND (submission_mode IS NULL OR submission_mode != 'rfce')
       AND certification_source_name = 'simulation'
     GROUP BY tipo_ecf, estado_dgii
     ORDER BY tipo_ecf`
  );

  console.log('\n═══ RESULTADO POR TIPO ═══');
  const byTipo = {};
  stats.forEach(r => {
    if (!byTipo[r.tipo_ecf]) byTipo[r.tipo_ecf] = {};
    byTipo[r.tipo_ecf][r.estado_dgii] = r.cnt;
  });
  Object.entries(byTipo).forEach(([tipo, estados]) => {
    const aceptado = estados['aceptado'] || 0;
    const total = Object.values(estados).reduce((a, b) => a + b, 0);
    const icon = aceptado === total ? '✅' : '⚠ ';
    console.log(`  ${icon} ${tipo}: ${aceptado}/${total} aceptados | ${JSON.stringify(estados)}`);
  });

  const [[totals]] = await conn.query(
    `SELECT
       SUM(estado_dgii='aceptado') as ok,
       SUM(estado_dgii!='aceptado') as nok,
       COUNT(*) as total
     FROM ecf_documents
     WHERE certification_case_key IS NOT NULL
       AND (submission_mode IS NULL OR submission_mode != 'rfce')
       AND certification_source_name = 'simulation'`
  );

  console.log(`\n  Total: ${totals.ok}/${totals.total} aceptados, ${totals.nok} pendientes/rechazados`);

  if (parseInt(totals.nok) > 0) {
    const [pending] = await conn.query(
      `SELECT encf, tipo_ecf, estado_dgii, error_message
       FROM ecf_documents
       WHERE certification_case_key IS NOT NULL
         AND (submission_mode IS NULL OR submission_mode != 'rfce')
         AND certification_source_name = 'simulation'
         AND estado_dgii != 'aceptado'
       ORDER BY tipo_ecf`
    );
    console.log('\n  Pendientes/Rechazados:');
    pending.forEach(d => console.log(`    ${d.encf} | ${d.tipo_ecf} | ${d.estado_dgii} | ${d.error_message || ''}`));
  }

  conn.end();
}

main().catch(e => {
  console.error('\nFatal:', e.message, e.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});

'use strict';
/**
 * Reinicia el Paso 4 (Pruebas de Simulación e-CF) con eNCFs y TrackId nuevos para
 * los 11 tipos de comprobante, los envía a DGII certecf uno por uno, genera y envía
 * los RFCE, y al final reporta el estado real de indexación pública (ConsultaTimbre)
 * por tipo — sin prometer que todos resuelvan ahí, eso lo decide DGII.
 *
 * Uso: node scripts/operational/regenerate-and-send-step4-batch.js
 */
process.env.NODE_ENV = 'production';
const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..', '..'));
try { require('dotenv').config(); } catch (_) {}

const mysql2 = require('mysql2/promise');
const { createEcfService } = require('../../modules/ecf/services/ecf.service');
const { buildQrVerificationUrl } = require('../../modules/ecf/utils/qr-url.util');
const { checkQrResolves } = require('../../modules/ecf/utils/dgii-live-check.util');

const DB_NAME_ECF = 'novapos';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const conn = await mysql2.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
    database: DB_NAME_ECF,
  });
  console.log('Conectado a DB\n');

  const makeQueryFn = (c) => async (sql, params) => { const [rows] = await c.query(sql, params || []); return rows; };
  const query = makeQueryFn(conn);
  const withTransaction = async (fn) => {
    await conn.beginTransaction();
    try { const r = await fn({ query: makeQueryFn(conn) }); await conn.commit(); return r; }
    catch (e) { try { await conn.rollback(); } catch (_) {} throw e; }
  };
  const resolveRequestActorUser = async () => ({ id: 1, usuario: 'admin', nombre: 'Sistema Cert', rol: 'administrador', role_code: 'ADMIN' });

  const service = createEcfService({ query, withTransaction, resolveRequestActorUser });
  service.ensureReady = async function () {
    ['storage/ecf/certification/signed', 'storage/ecf/enviados', 'storage/ecf/rfce-enviados', 'storage/ecf/tracks', 'storage/ecf/seeds']
      .forEach((d) => fs.mkdirSync(path.resolve(process.cwd(), d), { recursive: true }));
  };
  const mockReq = { body: {}, params: {}, query: {}, headers: {}, session: {} };

  // ─── 1. Regenerar TODO el set de Paso 4 con eNCFs nuevos ────────────────────
  console.log('=== PASO 1: Regenerando set de simulación con eNCFs nuevos ===');
  const regen = await service.generateSimulationSet(mockReq);
  console.log(`  ${regen.message || 'Set regenerado.'}\n`);

  // ─── 2. Enviar en secuencia todos los comprobantes normales (no RFCE) ──────
  console.log('=== PASO 2: Enviando comprobantes normales (11 tipos) a DGII certecf ===');
  let aceptados = 0;
  let rechazados = 0;
  let attempt = 0;
  const MAX_DOCS = 40;

  while (attempt < MAX_DOCS) {
    attempt++;
    const nextDoc = await service.repository.getNextPendingCertificationDocument({ includeRejected: true });
    if (!nextDoc) {
      console.log('  No quedan comprobantes normales pendientes.\n');
      break;
    }
    process.stdout.write(`  [${attempt}] ${nextDoc.tipo_ecf} ${nextDoc.encf} -> `);
    try {
      const result = await service.sendCertificationCase(nextDoc.id, mockReq, { skipStatusQuery: false });
      const estado = result.case?.estado || '?';
      const msg = result.message || result.case?.mensaje || '';
      console.log(`${estado}${msg ? ' | ' + msg : ''}`);
      if (estado === 'aceptado' || estado === 'aceptado_condicional') aceptados++;
      else rechazados++;
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      rechazados++;
    }
    await sleep(1200);
  }
  console.log(`  Normales: ${aceptados} aceptados, ${rechazados} rechazados/pendientes de este pase.\n`);

  // ─── 3. RFCE (Factura de Consumo < 250Mil) ──────────────────────────────────
  console.log('=== PASO 3: Generando y enviando RFCE ===');
  try {
    const genResult = await service.step4RfceGenerate(mockReq);
    console.log(`  RFCE generados: ${(genResult.items || []).length}`);
    await sleep(2000);
    const submitResult = await service.step4RfceSubmit(mockReq);
    console.log(`  Enviados: ${submitResult.enviados || 0} | Aceptados: ${submitResult.aceptados || 0}`);
    if ((submitResult.aceptados || 0) < 1) {
      await sleep(4000);
      const pollResult = await service.step4RfcePollStatuses(mockReq);
      console.log(`  Poll RFCE: ${JSON.stringify(pollResult?.resumen || {})}`);
    }
  } catch (err) {
    console.error(`  ERROR en RFCE: ${err.message}`);
  }
  console.log();

  // ─── 4. Resumen de aceptación DGII por tipo ─────────────────────────────────
  console.log('=== PASO 4: Resumen de aceptación DGII (ConsultaResultado) por tipo ===');
  const batchId = await service.repository.getLatestCertificationBatchId();
  const rows = await query(
    `SELECT encf, tipo_ecf, submission_mode, estado_dgii, environment, track_id, signed_xml_content
     FROM ecf_documents
     WHERE certification_batch_id = ?
     ORDER BY tipo_ecf, submission_mode, encf`,
    [batchId],
  );

  const TYPE_ORDER = ['31-normal','32-normal','32-rfce','33-normal','34-normal','41-normal','43-normal','44-normal','45-normal','46-normal','47-normal'];
  const byKey = {};
  rows.forEach((r) => {
    const k = `${r.tipo_ecf.replace('E', '')}-${(r.submission_mode || 'normal').toLowerCase()}`;
    (byKey[k] = byKey[k] || []).push(r);
  });

  console.log('\n  Tipo         | Aceptados | eNCFs');
  console.log('  -------------|-----------|---------------------------------');
  for (const key of TYPE_ORDER) {
    const list = byKey[key] || [];
    const okList = list.filter((r) => ['aceptado', 'aceptado_condicional'].includes(String(r.estado_dgii || '').toLowerCase()));
    console.log(`  ${key.padEnd(12)} | ${String(okList.length).padStart(2)}/${String(list.length).padEnd(2)}      | ${list.map((r) => `${r.encf}:${r.estado_dgii}`).join(', ')}`);
  }

  // ─── 5. Estado real de indexación pública (ConsultaTimbre) por tipo ────────
  console.log('\n=== PASO 5: Verificando indexación pública en DGII (ConsultaTimbre) ahora mismo ===');
  console.log('  (informativo — DGII puede tardar horas/días en indexar; no es un fallo nuestro si no resuelve todavía)\n');
  for (const key of TYPE_ORDER) {
    const candidates = (byKey[key] || []).filter((r) => ['aceptado', 'aceptado_condicional'].includes(String(r.estado_dgii || '').toLowerCase()));
    if (!candidates.length) {
      console.log(`  ${key.padEnd(12)} -> sin candidato aceptado todavía`);
      continue;
    }
    let anyIndexed = false;
    const details = [];
    for (const c of candidates) {
      const url = buildQrVerificationUrl(c.signed_xml_content, c.environment);
      const res = await checkQrResolves(url);
      details.push(`${c.encf}:${res.indexed ? 'SI' : 'no'}`);
      if (res.indexed) anyIndexed = true;
    }
    console.log(`  ${key.padEnd(12)} -> ${anyIndexed ? 'AL MENOS UNO INDEXADO' : 'ninguno indexado todavia'} | ${details.join(', ')}`);
  }

  console.log('\n=== LISTO — revisa el resumen arriba. Paso 5 real (subir PDFs al portal DGII) sigue siendo manual. ===');
  await conn.end();
}

main().catch((e) => { console.error('Fatal:', e.message); console.error(e.stack?.split('\n').slice(0, 8).join('\n')); process.exit(1); });

'use strict';
/**
 * Script standalone para enviar los docs restantes de certificación DGII (E46, E47).
 * Usa createEcfService directamente con conexión MariaDB inyectada.
 * Ejecutar: node run-cert-sequence.js
 */
process.env.NODE_ENV = 'production';
const path = require('path');
const fs = require('fs');
const projectRoot = path.resolve(__dirname, '..', '..');
process.chdir(projectRoot);

try { require('dotenv').config(); } catch (_) {}

const mysql2 = require(path.join(projectRoot, 'node_modules/mysql2/promise'));
const { createEcfService } = require(path.join(projectRoot, 'modules/ecf/services/ecf.service'));

async function main() {
  const conn = await mysql2.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || process.env.DB_DATABASE || 'novapos',
  });

  const makeQueryFn = (c) => async (sql, params) => {
    const [rows] = await c.query(sql, params || []);
    return rows;
  };

  const query = makeQueryFn(conn);

  const withTransaction = async (fn) => {
    await conn.beginTransaction();
    try {
      const txConn = { query: makeQueryFn(conn) };
      const r = await fn(txConn);
      await conn.commit();
      return r;
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      throw e;
    }
  };

  // Actor admin mock — solo para satisfacer getCurrentActor({ adminOnly: true })
  const resolveRequestActorUser = async () => ({
    id: 1, usuario: 'admin', nombre: 'Sistema Cert', rol: 'administrador', role_code: 'ADMIN',
  });

  const service = createEcfService({ query, withTransaction, resolveRequestActorUser });

  // Parchear ensureReady para evitar el DDL de SQLite que falla en MariaDB
  service.ensureReady = async function () {
    const dirs = [
      path.resolve(process.cwd(), 'storage', 'ecf', 'certification', 'signed'),
      path.resolve(process.cwd(), 'storage', 'ecf', 'enviados'),
      path.resolve(process.cwd(), 'storage', 'ecf', 'rfce-enviados'),
      path.resolve(process.cwd(), 'storage', 'ecf', 'tracks'),
    ];
    dirs.forEach((d) => fs.mkdirSync(d, { recursive: true }));
    if (this.seedStorage?.ensureStorage) this.seedStorage.ensureStorage();
    if (this.receptionStorage?.ensureStorage) this.receptionStorage.ensureStorage();
  };

  // Estado previo
  const pending = await query(
    `SELECT id, encf, tipo_ecf, estado_dgii FROM ecf_documents
     WHERE id IN (4172,4173,4174,4175) ORDER BY certification_order_index`,
  );
  console.log('\nDocs a enviar:');
  pending.forEach((d) => console.log(` ${d.id}  ${d.tipo_ecf}  ${d.encf}  ${d.estado_dgii}`));
  console.log();

  const mockReq = {
    body: { limit: 10, delayMs: 200 },
    params: {}, query: {}, headers: {}, session: {},
  };

  console.log('Iniciando runCertificationSequence...\n');
  let result;
  try {
    result = await service.runCertificationSequence(mockReq);
  } catch (err) {
    console.error('ERROR en runCertificationSequence:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 8).join('\n'));
    process.exitCode = 1;
  }

  if (result) {
    console.log('\n=== Resultados ===');
    const steps = result.results || result.steps || [];
    steps.forEach((s, i) => {
      const status = s.ok ? '[OK]' : '[FAIL]';
      const encf = s.encf || s.case?.encf || '?';
      const msg = s.message || s.case?.mensaje || s.case?.error || '';
      console.log(`  ${i + 1}. ${status}  ${encf}  ${msg}`);
    });
    console.log('\nTotal procesados:', steps.length);
    console.log('Completado:', result.completed ?? result.allSent ?? result.done ?? '?');
  }

  // Estado final
  const after = await query(
    `SELECT id, encf, tipo_ecf, estado_dgii, error_message FROM ecf_documents
     WHERE id IN (4172,4173,4174,4175) ORDER BY certification_order_index`,
  );
  console.log('\nEstado final tras envío:');
  after.forEach((d) => console.log(` ${d.id}  ${d.tipo_ecf}  ${d.encf}  ${d.estado_dgii}  ${d.error_message || ''}`));

  // Consultar estados en DGII para todos los docs 'enviado'
  console.log('\n\n=== Consultando estados en DGII (pollCertificationStatuses) ===');
  try {
    const poll = await service.pollCertificationStatuses();
    console.log('Consultados:', poll.polled);
    if (poll.summary) {
      console.log('Resumen DGII:', JSON.stringify(poll.summary));
    }
  } catch (err) {
    console.error('Error en poll:', err.message);
  }

  conn.end();
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });

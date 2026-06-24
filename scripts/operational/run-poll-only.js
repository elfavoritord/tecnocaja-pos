'use strict';
process.env.NODE_ENV = 'production';
const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname));
try { require('dotenv').config(); } catch (_) {}

const mysql2 = require('./node_modules/mysql2/promise');
const { createEcfService } = require('./modules/ecf/services/ecf.service');

async function main() {
  const conn = await mysql2.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || process.env.DB_DATABASE || 'novapos',
  });
  const makeQueryFn = (c) => async (sql, params) => { const [rows] = await c.query(sql, params||[]); return rows; };
  const query = makeQueryFn(conn);
  const withTransaction = async (fn) => {
    await conn.beginTransaction();
    try { const txConn = { query: makeQueryFn(conn) }; const r = await fn(txConn); await conn.commit(); return r; }
    catch (e) { try { await conn.rollback(); } catch(_) {} throw e; }
  };
  const resolveRequestActorUser = async () => ({ id:1, usuario:'admin', nombre:'Sistema', rol:'administrador', role_code:'ADMIN' });
  const service = createEcfService({ query, withTransaction, resolveRequestActorUser });
  service.ensureReady = async function() {
    ['storage/ecf/certification/signed','storage/ecf/enviados','storage/ecf/rfce-enviados','storage/ecf/tracks']
      .forEach(d => fs.mkdirSync(path.resolve(process.cwd(), d), { recursive: true }));
  };

  console.log('Consultando estados en DGII...\n');
  const poll = await service.pollCertificationStatuses();
  console.log('\nConsultados:', poll.polled);
  if (poll.summary) {
    const s = poll.summary;
    console.log(`\nResumen: ${s.aceptadas} aceptadas / ${s.total} total`);
    console.log(`  Rechazadas: ${s.rechazadas}, Pendientes: ${s.pendientes}`);
  }

  const [rows] = await conn.query(`
    SELECT encf, estado_dgii, error_message FROM ecf_documents
    WHERE certification_batch_id='sim-1781925356811'
    ORDER BY certification_order_index
  `);
  const byStatus = {};
  rows.forEach(r => { byStatus[r.estado_dgii]=(byStatus[r.estado_dgii]||0)+1; });
  console.log('\nEstado DB:', JSON.stringify(byStatus));
  const rechazados = rows.filter(r=>r.estado_dgii==='rechazado');
  if (rechazados.length) {
    console.log('\nRechazados:');
    rechazados.forEach(r=>console.log(' ',r.encf,':', r.error_message?.slice(0,80)));
  }
  const pendientes = rows.filter(r=>r.estado_dgii==='pendiente'||r.estado_dgii==='enviado');
  if (pendientes.length) {
    console.log('\nAún pendientes:', pendientes.map(r=>r.encf).join(', '));
  }

  conn.end();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

'use strict';
/**
 * Reenvía E310000000149 (rechazado por TasaImpuestoAdicional=633.85 inválida)
 * con nuevo eNCF E310000000151 y TasaImpuestoAdicional=6.28.
 */
process.env.NODE_ENV = 'production';
const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname));
try { require('dotenv').config(); } catch (_) {}

const mysql2 = require('./node_modules/mysql2/promise');
const { createEcfService } = require('./modules/ecf/services/ecf.service');

const NEW_ENCF = 'E310000000151';
const NEW_TASA = '6.28'; // Tasa ISC Específico por unidad (cerveza DR)
const BATCH_ID = 'sim-1781925356811';

async function main() {
  const conn = await mysql2.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || process.env.DB_DATABASE || 'novapos',
  });
  const makeQueryFn = (c) => async (sql, params) => { const [rows] = await c.query(sql, params || []); return rows; };
  const query = makeQueryFn(conn);
  const withTransaction = async (fn) => {
    await conn.beginTransaction();
    try { const txConn = { query: makeQueryFn(conn) }; const r = await fn(txConn); await conn.commit(); return r; }
    catch (e) { try { await conn.rollback(); } catch (_) {} throw e; }
  };
  const resolveRequestActorUser = async () => ({ id: 1, usuario: 'admin', nombre: 'Sistema', rol: 'administrador', role_code: 'ADMIN' });
  const service = createEcfService({ query, withTransaction, resolveRequestActorUser });
  service.ensureReady = async function () {
    ['storage/ecf/certification/signed', 'storage/ecf/enviados', 'storage/ecf/rfce-enviados', 'storage/ecf/tracks']
      .forEach((d) => fs.mkdirSync(path.resolve(process.cwd(), d), { recursive: true }));
  };

  // 1. Read the rejected doc
  const [[doc]] = await conn.query("SELECT id, encf, certification_original_xml FROM ecf_documents WHERE encf='E310000000149'");
  if (!doc) throw new Error('E310000000149 no encontrado en DB');

  // 2. Modify the stored row: change TasaImpuestoAdicional[1] from 633.85 to NEW_TASA
  const stored = JSON.parse(doc.certification_original_xml);
  const oldTasa = stored.row['TasaImpuestoAdicional[1]'];
  console.log('TasaImpuestoAdicional[1] original:', oldTasa);
  stored.row['TasaImpuestoAdicional[1]'] = NEW_TASA;
  console.log('TasaImpuestoAdicional[1] nuevo:', NEW_TASA);
  const newCertOriginalXml = JSON.stringify(stored);

  // 3. Update the DB doc to use new eNCF and reset estado
  await conn.query(`
    UPDATE ecf_documents SET
      encf = ?,
      certification_original_xml = ?,
      estado_dgii = 'firmado',
      error_message = NULL,
      dgii_response_json = NULL,
      xml_content = NULL,
      signed_xml_content = NULL,
      track_id = NULL,
      sent_at = NULL
    WHERE id = ?
  `, [NEW_ENCF, newCertOriginalXml, doc.id]);
  console.log(`[OK] Doc ${doc.id} actualizado: encf=${NEW_ENCF}, estado=firmado`);

  // 4. Reserve E310000000151 in the sequence (advance proximo_numero to 152)
  await conn.query(
    `UPDATE ecf_sequences SET proximo_numero = 152 WHERE tipo_comprobante = 'E31' AND business_id = 1 AND proximo_numero <= 151`,
  );
  console.log('[OK] Sequence E31 avanzada a 152');

  // 5. Run sendCertificationCase for the updated doc
  const mockReq = { body: {}, params: {}, query: {}, headers: {}, session: {} };
  console.log('\nEnviando E310000000151 a DGII certecf...');
  const result = await service.sendCertificationCase(doc.id, mockReq, { skipStatusQuery: false });

  console.log('\n=== Resultado ===');
  console.log('ok:', result.ok);
  console.log('encf:', result.case?.encf || NEW_ENCF);
  console.log('estado:', result.case?.estado);
  console.log('mensaje:', result.case?.mensaje || result.message);
  if (result.case?.dgiiResponse) {
    const dgii = result.case.dgiiResponse;
    console.log('DGII estado:', dgii.estado);
    if (dgii.mensajes?.length) console.log('DGII mensajes:', dgii.mensajes.map((m) => m.valor || m).join('; '));
  }

  conn.end();
}

main().catch((e) => { console.error('Fatal:', e.message); console.error(e.stack?.split('\n').slice(0, 5).join('\n')); process.exit(1); });

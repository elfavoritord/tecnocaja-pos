'use strict';
/**
 * Prueba: E310000000051..054 (aceptados en DGII certecf) no indexan en el portal
 * público ConsultaTimbre horas después, mientras que E32 del mismo lote sí. Se
 * genera un eNCF E31 completamente nuevo (E310000000055) reutilizando el mismo
 * documento base (id 5710 / E310000000051, sin modificar ningún campo del payload)
 * y se reenvía a DGII para ver si un envío fresco resuelve distinto.
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

const SOURCE_DOC_ID = 5710; // E310000000051
const NEW_ENCF = 'E310000000055';

// La BD real con los datos de certificación e-CF es 'novapos' — una variable de entorno
// DB_NAME obsoleta a nivel de sistema puede resolver a 'tecnocaja' y romper la conexión.
const DB_NAME_ECF = 'novapos';

async function main() {
  const conn = await mysql2.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
    database: DB_NAME_ECF,
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

  const [[doc]] = await conn.query('SELECT id, encf, certification_original_xml FROM ecf_documents WHERE id = ?', [SOURCE_DOC_ID]);
  if (!doc) throw new Error(`Documento ${SOURCE_DOC_ID} no encontrado en DB`);
  console.log(`[OK] Base: doc ${doc.id} (${doc.encf}) -> nuevo eNCF ${NEW_ENCF}, sin cambios en el payload.`);

  await conn.query(
    `UPDATE ecf_documents SET
       encf = ?,
       estado_dgii = 'firmado',
       error_message = NULL,
       dgii_response_json = NULL,
       xml_content = NULL,
       signed_xml_content = NULL,
       track_id = NULL,
       sent_at = NULL
     WHERE id = ?`,
    [NEW_ENCF, doc.id],
  );
  console.log(`[OK] Doc ${doc.id} actualizado: encf=${NEW_ENCF}, estado=firmado`);

  await conn.query(
    `UPDATE ecf_sequences SET proximo_numero = 56 WHERE tipo_comprobante = 'E31' AND business_id = 1 AND proximo_numero <= 55`,
  );
  console.log('[OK] Secuencia E31 avanzada a 56');

  const mockReq = { body: {}, params: {}, query: {}, headers: {}, session: {} };
  console.log(`\nEnviando ${NEW_ENCF} a DGII certecf...`);
  const result = await service.sendCertificationCase(doc.id, mockReq, { skipStatusQuery: false });

  console.log('\n=== Resultado envío ===');
  console.log('ok:', result.ok);
  console.log('encf:', result.case?.encf || NEW_ENCF);
  console.log('estado:', result.case?.estado);
  console.log('mensaje:', result.case?.mensaje || result.message);
  if (result.case?.dgiiResponse) {
    const dgii = result.case.dgiiResponse;
    console.log('DGII estado:', dgii.estado);
    if (dgii.mensajes?.length) console.log('DGII mensajes:', dgii.mensajes.map((m) => m.valor || m).join('; '));
  }

  const refreshed = (await conn.query('SELECT signed_xml_content, environment FROM ecf_documents WHERE id = ?', [doc.id]))[0][0];
  if (refreshed?.signed_xml_content) {
    const qrUrl = buildQrVerificationUrl(refreshed.signed_xml_content, refreshed.environment);
    console.log('\nQR URL generada:', qrUrl);
    const live = await checkQrResolves(qrUrl);
    console.log('Estado en ConsultaTimbre AHORA MISMO (recién enviado, normal que aún no indexe):', JSON.stringify(live));
  }

  await conn.end();
}

main().catch((e) => { console.error('Fatal:', e.message); console.error(e.stack?.split('\n').slice(0, 5).join('\n')); process.exit(1); });

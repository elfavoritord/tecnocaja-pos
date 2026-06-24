'use strict';
/**
 * Envía E310000000002 a DGII con los valores exactos del conjunto de datos DGII
 * (TasaImpuestoAdicional 633.85 — sin corrección ISC).
 *
 * Usa el código CORREGIDO en test-set-importer.js (buildCertificationEcfXml sin
 * correctIscEspecificoCerveza) y validateCertificationDocumentBeforeSend también
 * corregido. Ejecutar como proceso independiente al servidor principal.
 */
process.env.NODE_ENV = 'production';
const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname));
try { require('dotenv').config(); } catch (_) {}

const mysql2 = require('./node_modules/mysql2/promise');
const { createEcfService } = require('./modules/ecf/services/ecf.service');

const TARGET_ENCF = 'E310000000002';

async function main() {
  const dbPort = parseInt(process.env.DB_PORT || '3306');
  const dbPass = process.env.DB_PASS || process.env.DB_PASSWORD || '';
  const conn = await mysql2.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: dbPort,
    user: process.env.DB_USER || 'root',
    password: dbPass,
    database: process.env.DB_NAME || process.env.DB_DATABASE || 'novapos',
  });

  console.log(`Conectado a DB en puerto ${dbPort}\n`);

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
  const resolveRequestActorUser = async () => ({
    id: 1, usuario: 'admin', nombre: 'Sistema', rol: 'administrador', role_code: 'ADMIN',
  });

  const service = createEcfService({ query, withTransaction, resolveRequestActorUser });
  service.ensureReady = async function () {
    ['storage/ecf/certification/signed', 'storage/ecf/enviados', 'storage/ecf/rfce-enviados', 'storage/ecf/tracks']
      .forEach((d) => fs.mkdirSync(path.resolve(process.cwd(), d), { recursive: true }));
  };

  // 1. Ver estado actual de todos los docs de certificación (no RFCE)
  const [allDocs] = await conn.query(
    `SELECT encf, tipo_ecf, estado_dgii
     FROM ecf_documents
     WHERE certification_case_key IS NOT NULL
       AND (submission_mode IS NULL OR submission_mode != 'rfce')
     ORDER BY COALESCE(certification_order_index, id), id`
  );

  console.log('=== Estado actual de certificación ===');
  const byStatus = {};
  allDocs.forEach((d) => {
    byStatus[d.estado_dgii] = (byStatus[d.estado_dgii] || 0) + 1;
    if (d.estado_dgii !== 'aceptado') {
      console.log(` ⚠  ${d.encf} | ${d.tipo_ecf} | ${d.estado_dgii}`);
    }
  });
  console.log(`\nResumen: ${JSON.stringify(byStatus)}`);
  console.log(`Total docs certificación (no RFCE): ${allDocs.length}\n`);

  // 2. Encontrar el doc objetivo
  const [[target]] = await conn.query(
    `SELECT id, encf, estado_dgii, certification_original_xml
     FROM ecf_documents
     WHERE encf = ? AND certification_case_key IS NOT NULL`,
    [TARGET_ENCF]
  );

  if (!target) {
    console.error(`ERROR: ${TARGET_ENCF} no encontrado en DB`);
    conn.end();
    return;
  }

  console.log(`=== Enviando ${TARGET_ENCF} ===`);
  console.log(`Estado actual: ${target.estado_dgii}`);

  // 3. Verificar que el rawRow tiene la tasa ORIGINAL (sin corrección)
  if (target.certification_original_xml) {
    const stored = JSON.parse(target.certification_original_xml);
    const rawRow = stored.row || stored;
    const tasa = rawRow['TasaImpuestoAdicional[1]'] || rawRow['TasaImpuestoAdicional'];
    const monto = rawRow['MontoTotal'];
    console.log(`rawRow TasaImpuestoAdicional[1]: ${tasa}`);
    console.log(`rawRow MontoTotal: ${monto}`);
    if (String(tasa) === '758.26') {
      console.log('ADVERTENCIA: rawRow tiene tasa 758.26 (corregida). DGII espera 633.85.');
      console.log('Corrigiendo rawRow a 633.85 en DB antes de enviar...');
      rawRow['TasaImpuestoAdicional[1]'] = '633.85';
      if (rawRow['TasaImpuestoAdicional']) rawRow['TasaImpuestoAdicional'] = '633.85';
      // También corregir MontoImpuestoAdicional y MontoTotal para que sean los del dataset
      // Estos valores correctos los tomamos del DGII error: MontoTotal=4674.35, TotalITBIS=713.04
      // No los cambiamos en rawRow — el builder los recalcula.
      stored.row = rawRow;
      await conn.query(
        'UPDATE ecf_documents SET certification_original_xml=? WHERE id=?',
        [JSON.stringify(stored), target.id]
      );
      console.log('rawRow corregido en DB.\n');
    } else {
      console.log(`Tasa en rawRow: ${tasa} (OK — valor DGII dataset)`);
    }
  }

  // 4. Resetear el doc a 'firmado' para que el service lo procese
  await conn.query(
    `UPDATE ecf_documents SET
       estado_dgii = 'firmado',
       error_message = NULL,
       dgii_response_json = NULL,
       signed_xml_content = NULL,
       xml_content = NULL,
       sent_at = NULL
     WHERE id = ?`,
    [target.id]
  );
  console.log(`Doc ${target.id} reseteado a 'firmado'`);

  // 5. Llamar sendCertificationCase con el código CORREGIDO
  const mockReq = { body: {}, params: {}, query: {}, headers: {}, session: {} };
  console.log('\nEnviando a DGII certecf...');

  let result;
  try {
    result = await service.sendCertificationCase(target.id, mockReq, { skipStatusQuery: false });
  } catch (err) {
    console.error('\nERROR en sendCertificationCase:', err.message);
    console.error(err.stack?.split('\n').slice(0, 8).join('\n'));
    conn.end();
    process.exit(1);
  }

  // 6. Mostrar resultado
  console.log('\n=== RESULTADO ===');
  const c = result.case || {};
  const estado = c.estado_dgii || c.estado || '?';
  const dgiiResp = c.dgiiResponse || {};
  const mensajes = (dgiiResp.mensajes || []).map((m) => m.valor || JSON.stringify(m)).join('\n  ');

  console.log(`Estado: ${estado}`);
  console.log(`eNCF: ${c.encf || TARGET_ENCF}`);
  if (mensajes) console.log(`DGII mensajes:\n  ${mensajes}`);
  if (c.error_message || result.message) console.log(`Mensaje: ${c.error_message || result.message}`);

  if (estado === 'aceptado') {
    console.log('\n✅ E310000000002 ACEPTADO por DGII');

    // Contar cuántos faltan
    const [[{ pendientes }]] = await conn.query(
      `SELECT COUNT(*) as pendientes FROM ecf_documents
       WHERE certification_case_key IS NOT NULL
         AND (submission_mode IS NULL OR submission_mode != 'rfce')
         AND estado_dgii != 'aceptado'`
    );
    if (pendientes == 0) {
      console.log('🎉 21/21 COMPROBANTES ACEPTADOS');
    } else {
      console.log(`⚠  Quedan ${pendientes} docs no aceptados`);
    }
  } else {
    console.log('\n❌ Todavía rechazado — revisar mensajes DGII arriba');
  }

  conn.end();
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  console.error(e.stack?.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});

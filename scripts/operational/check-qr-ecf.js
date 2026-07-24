'use strict';
process.env.NODE_ENV = 'production';
const path = require('path');
// Este script vive en scripts/operational/; la raíz real del proyecto (donde
// están node_modules, .env, modules/ y ecf/) está dos niveles arriba.
const projectRoot = path.resolve(__dirname, '..', '..');
try { require('dotenv').config({ path: path.join(projectRoot, '.env') }); } catch (_) {}

const mysql2 = require('mysql2/promise');
const { buildQrVerificationUrl, parseEcfXmlForQr } = require(
  path.join(projectRoot, 'modules/ecf/utils/qr-url.util')
);

// Uso: node scripts/operational/check-qr-ecf.js <eNCF>
// Compara, para un e-CF ya enviado, el XML firmado real contra:
//  - la URL de verificación que el QR debería tener (recalculada ahora mismo)
//  - lo que quedó guardado en sales.qr_data (lo que de verdad se imprimió)
//  - el estado que DGII confirmó (ConsultaResultado)
// y avisa si algo no coincide, sin adivinar nada.
async function main() {
  const encf = String(process.argv[2] || '').trim().toUpperCase();
  if (!encf) {
    console.error('Uso: node scripts/operational/check-qr-ecf.js <eNCF>   (ej: E310000000035)');
    process.exit(1);
  }

  const conn = await mysql2.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || process.env.DB_DATABASE || 'novapos',
  });

  const [docRows] = await conn.query(
    `SELECT id, encf, tipo_ecf, estado_dgii, track_id, environment, signed_xml_content, dgii_response_json, sale_id
     FROM ecf_documents WHERE encf = ? ORDER BY id DESC LIMIT 1`,
    [encf]
  );

  if (!docRows.length) {
    console.log(`No existe ningún ecf_documents con eNCF = ${encf}.`);
    await conn.end();
    return;
  }

  const doc = docRows[0];
  console.log(`\n== ${encf} (ecf_documents.id=${doc.id}) ==`);
  console.log('Estado DGII guardado localmente :', doc.estado_dgii);
  console.log('TrackId                         :', doc.track_id || '(ninguno — nunca se envió)');
  console.log('Ambiente                        :', doc.environment);

  if (!doc.signed_xml_content) {
    console.log('\n⚠ No hay XML firmado guardado — el documento nunca llegó a firmarse.');
    await conn.end();
    return;
  }

  const parsed = parseEcfXmlForQr(doc.signed_xml_content);
  console.log('\n-- Campos del XML firmado --');
  console.log(parsed);

  const urlRecalculada = buildQrVerificationUrl(doc.signed_xml_content, doc.environment);
  console.log('\n-- URL de verificación (recalculada ahora del XML) --');
  console.log(urlRecalculada);

  // Qué quedó realmente impreso en el recibo de la venta ligada (si hay).
  let saleRow = null;
  if (doc.sale_id) {
    const [saleRows] = await conn.query(
      'SELECT id, qr_data, ecf_estado FROM sales WHERE id = ? LIMIT 1',
      [doc.sale_id]
    );
    saleRow = saleRows[0] || null;
  }

  if (saleRow) {
    console.log('\n-- sales.qr_data (lo que realmente se imprimió/compartió) --');
    console.log(saleRow.qr_data || '(vacío — el recibo se imprimió sin QR)');
    if (saleRow.qr_data && saleRow.qr_data !== urlRecalculada) {
      console.log('\n❌ MISMATCH: sales.qr_data NO coincide con la URL recalculada del XML.');
    } else if (saleRow.qr_data) {
      console.log('\n✅ sales.qr_data coincide exactamente con el XML firmado.');
    }
  } else {
    console.log('\n(Este documento no está ligado a ninguna venta — típico de pruebas de certificación.)');
  }

  // Qué dijo DGII la última vez que se consultó.
  if (doc.dgii_response_json) {
    try {
      const resp = JSON.parse(doc.dgii_response_json);
      console.log('\n-- Última respuesta de DGII guardada --');
      console.log({ codigo: resp.codigo, estado: resp.estado, mensajes: resp.mensajes || resp.mensaje });
    } catch (_) { /* ignorar si no es JSON parseable */ }
  }

  console.log('\nPara probar el QR manualmente, abre esta URL en el navegador:');
  console.log(urlRecalculada);

  await conn.end();
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});

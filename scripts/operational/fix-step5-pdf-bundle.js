'use strict';
process.env.NODE_ENV = 'production';
const path = require('path');
const fs = require('fs');
// Este script vive en scripts/operational/; la raíz real del proyecto (donde
// están node_modules, .env, modules/ y ecf/) está dos niveles arriba.
const projectRoot = path.resolve(__dirname, '..', '..');
try { require('dotenv').config({ path: path.join(projectRoot, '.env') }); } catch (_) {}

const mysql2 = require('mysql2/promise');

const TYPE_LABELS = {
  '31-normal': 'Factura-Credito-Fiscal',
  '32-normal': 'Factura-Consumo-Mayor250k',
  '32-rfce':   'Factura-Consumo-Menor250k',
  '33-normal': 'Nota-Debito',
  '34-normal': 'Nota-Credito',
  '41-normal': 'Compras',
  '43-normal': 'Gastos-Menores',
  '44-normal': 'Regimenes-Especiales',
  '45-normal': 'Gubernamentales',
  '46-normal': 'Exportaciones',
  '47-normal': 'Pagos-Exterior',
};
const ORDER = ['31-normal','32-normal','32-rfce','33-normal','34-normal','41-normal','43-normal','44-normal','45-normal','46-normal','47-normal'];

async function main() {
  const conn = await mysql2.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || process.env.DB_DATABASE || 'novapos',
  });
  console.log('Conectado a DB\n');

  const [rows] = await conn.query(
    `SELECT encf, tipo_ecf, submission_mode, signed_xml_content, estado_dgii
     FROM ecf_documents
     WHERE certification_batch_id = (
       SELECT certification_batch_id FROM ecf_documents
       WHERE certification_batch_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1
     ) AND signed_xml_content IS NOT NULL
     ORDER BY tipo_ecf, submission_mode, encf`
  );

  // Preferir el documento realmente aceptado en DGII por tipo, no el primero por
  // orden de eNCF (puede ser un rechazo seguido de reintentos aceptados).
  const ESTADO_RANK = { aceptado: 0, aceptado_condicional: 1, firmado: 2, enviado: 3, rechazado: 4 };
  const rankOf = (estado) => ESTADO_RANK[estado] ?? 3;
  const byKey = {};
  rows.forEach((r) => {
    const k = r.tipo_ecf.replace('E','') + '-' + (r.submission_mode || 'normal').toLowerCase();
    if (!byKey[k] || rankOf(r.estado_dgii) < rankOf(byKey[k].estado_dgii)) byKey[k] = r;
  });
  const selected = ORDER.map((k, i) => ({ key: k, idx: i + 1, row: byKey[k] })).filter((x) => x.row);
  console.log('Tipos encontrados:', selected.length + '/' + ORDER.length);
  selected.forEach((s) => console.log('  ' + String(s.idx).padStart(2,'0') + ' ' + s.key + ' -> ' + s.row.encf));

  const archiver = require('archiver');
  const puppeteer = require('puppeteer');
  const { generateReprImpresaHtml } = require(path.join(projectRoot, 'modules/ecf/controllers/repr-impresa'));

  // Cargar emisor real para que la RI muestre la razón social del RNC (Norma General 06-2018)
  const [[emitterRow]] = await conn.query('SELECT * FROM ecf_emitters WHERE business_id = 1 LIMIT 1').catch(() => [[null]]);
  const [[configRow]] = await conn.query('SELECT * FROM config WHERE id = 1 LIMIT 1').catch(() => [[null]]);
  const rawNombreComercial = emitterRow?.nombre_comercial ?? '';
  const emitter = {
    rnc: (emitterRow?.rnc || configRow?.rnc || '').replace(/\D/g, ''),
    razon_social: emitterRow?.razon_social || configRow?.business_name || '',
    // Los valores "DOCUMENTOS ELECTRONICOS DE XX" son placeholders del set de pruebas DGII.
    nombre_comercial: /documentos electronicos/i.test(rawNombreComercial) ? '' : rawNombreComercial,
    direccion: emitterRow?.direccion || configRow?.address || '',
    telefono: emitterRow?.telefono || configRow?.phone || '',
    correo: emitterRow?.correo || '',
  };
  console.log('Emisor real:', { rnc: emitter.rnc, razon_social: emitter.razon_social, nombre_comercial: emitter.nombre_comercial });

  // Limpiar el placeholder del set de pruebas de la BD si aún está guardado
  if (/documentos electronicos/i.test(rawNombreComercial)) {
    await conn.query('UPDATE ecf_emitters SET nombre_comercial = ? WHERE business_id = 1', ['']).catch(() => {});
    console.log('⚠ nombre_comercial era un placeholder DGII — limpiado en BD.\n');
  }

  // Resolver la Razón Social REAL de cada RNC comprador contra el padrón DGII
  // (vía el endpoint /api/rnc/lookup del propio backend, ya corriendo) — el
  // set de pruebas trae el mismo RNC con nombres distintos según el comprobante
  // (ej. 131880681 aparece como "DE 02", "DE 03", "DE 04", "ZONA FRANCA LOI").
  const http = require('http');
  function rncLookup(rnc) {
    return new Promise((resolve) => {
      http.get(`http://127.0.0.1:3399/api/rnc/lookup?id=${encodeURIComponent(rnc)}`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve({ found: false }); }
        });
      }).on('error', () => resolve({ found: false }));
    });
  }
  const buyerNameByRnc = {};
  const distinctRncs = [...new Set(
    rows.map((r) => (r.signed_xml_content.match(/<RNCComprador[^>]*>([^<]*)<\/RNCComprador>/i) || [])[1]).filter(Boolean)
  )];
  for (const rnc of distinctRncs) {
    const result = await rncLookup(rnc);
    if (result.found && result.nombre) {
      buyerNameByRnc[rnc] = result.nombre;
      console.log(`Comprador RNC ${rnc} -> "${result.nombre}" (padrón DGII)`);
    } else {
      console.log(`Comprador RNC ${rnc} -> no encontrado en padrón, se deja el valor del XML.`);
    }
  }

  const outDir = path.join(projectRoot, 'ecf/DGII_CARGAR_AHORA_4_XML_VERIFICADOS');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'representaciones-impresas-DGII.zip');
  const out = fs.createWriteStream(outPath);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(out);

  console.log('\nAbriendo navegador...');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();

  for (const { key, idx, row } of selected) {
    const label = TYPE_LABELS[key] || key;
    const filename = String(idx).padStart(2,'0') + '-' + label + '-' + row.encf + '.pdf';
    process.stdout.write('  ' + filename + ' ... ');
    try {
      const rncComprador = (row.signed_xml_content.match(/<RNCComprador[^>]*>([^<]*)<\/RNCComprador>/i) || [])[1];
      const buyer = rncComprador && buyerNameByRnc[rncComprador] ? { razon_social: buyerNameByRnc[rncComprador] } : null;
      const html = await generateReprImpresaHtml(row.signed_xml_content, { env: process.env.DGII_ENV || 'certecf', emitter, buyer });
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const pdfRaw = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
      const pdf = Buffer.isBuffer(pdfRaw) ? pdfRaw : Buffer.from(pdfRaw);
      archive.append(pdf, { name: filename });
      console.log('OK (' + (pdf.length / 1024).toFixed(1) + ' KB)');
    } catch (e) {
      console.log('ERROR: ' + e.message);
    }
  }

  await browser.close();
  await archive.finalize();
  await new Promise((resolve) => out.on('close', resolve));

  const size = fs.statSync(outPath).size;
  console.log('\n✅ ZIP listo:', outPath);
  console.log('   Tamaño total:', (size / 1024).toFixed(1) + ' KB');
  console.log('   Archivos: ' + selected.length);

  conn.end();
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });

'use strict';
/**
 * Envía las 7 Aprobaciones Comerciales (ACECF) válidas a DGII Paso 3.
 *
 * FechaHoraAprobacionComercial fija al valor exacto del dataset DGII:
 *   6/23/2026 8:19:36 PM → 23-06-2026 20:19:36
 *
 * eNCFs "no existe en la colección" se excluyen automáticamente.
 */
process.env.NODE_ENV = 'production';
const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname));
try { require('dotenv').config(); } catch (_) {}

const { createEcfService } = require('./modules/ecf/services/ecf.service');
const mysql2 = require('./node_modules/mysql2/promise');

// ─── Datos exactos del dataset DGII (del mensaje de error DGII) ─────────────
const FECHA_HORA_AC = '23-06-2026 20:19:36'; // 6/23/2026 8:19:36 PM → hora local RD

// eNCFs que SÍ existen en el dataset DGII Paso 3:
const ENCFS_VALIDOS = [
  'E310000000002',
  'E310000000034',
  'E330000000001',
  'E340000000002',
  'E340000000013',
  'E440000000013',
  'E450000000009',
];

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
    ['storage/ecf/certification/signed', 'storage/ecf/enviados', 'storage/ecf/acecf-enviados', 'storage/ecf/seeds']
      .forEach((d) => fs.mkdirSync(path.resolve(process.cwd(), d), { recursive: true }));
  };

  // Obtener datos de los docs de certificación para los 7 eNCFs válidos
  const docs = await query(
    'SELECT encf, tipo_ecf, rnc_comprador, monto_total, certification_original_xml FROM ecf_documents WHERE encf IN (?) AND certification_case_key IS NOT NULL',
    [ENCFS_VALIDOS]
  );

  // Ordenar igual que ENCFS_VALIDOS
  const docsMap = {};
  docs.forEach((d) => { docsMap[d.encf] = d; });
  const ordered = ENCFS_VALIDOS.map((e) => docsMap[e]).filter(Boolean);

  console.log(`Docs encontrados en DB: ${ordered.length}/${ENCFS_VALIDOS.length}`);
  if (ordered.length !== ENCFS_VALIDOS.length) {
    const missing = ENCFS_VALIDOS.filter((e) => !docsMap[e]);
    console.error('Faltan en DB:', missing.join(', '));
  }
  console.log('');

  // Autenticar con DGII certecf
  console.log('Autenticando con DGII certecf...');
  service.applyRuntimeConfig('certecf');
  const auth = await service.authService.authenticate({ forceRefresh: true });
  const token = auth.token;
  console.log(`Token OK (expira: ${auth.expira || '?'})\n`);

  const certificate = await service.resolveCertificate();
  const { signXML } = require('./modules/ecf/signature/signature.service');
  const RNC_EMISOR = '40211932609';

  const results = [];
  let aceptados = 0;

  for (const doc of ordered) {
    const raw = doc.certification_original_xml
      ? JSON.parse(doc.certification_original_xml).row || {}
      : {};

    const rncComprador = String(doc.rnc_comprador || '').replace(/\D/g, '');
    const montoTotal   = parseFloat(String(doc.monto_total || '0')).toFixed(2);
    const fechaEmision = raw['FechaEmision'] || raw['Fecha Emision'] || '';

    // En el ACECF, el "Emisor" es el COMPRADOR que aprueba el documento.
    // DGII espera: RNCEmisor=comprador(131880681), RNCComprador=emisorOriginal(40211932609)
    const acecfRncEmisor    = rncComprador; // 131880681 — quien envía la aprobación
    const acecfRncComprador = RNC_EMISOR;   // 40211932609 — nosotros (el vendedor original)

    process.stdout.write(`[ACECF] ${doc.encf} | RNCEm:${acecfRncEmisor} | RNCComp:${acecfRncComprador} | Monto:${montoTotal} → `);

    // Construir XML ACECF con los valores exactos del dataset DGII
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<ACECF>',
      '  <DetalleAprobacionComercial>',
      '    <Version>1.0</Version>',
      `    <RNCEmisor>${acecfRncEmisor}</RNCEmisor>`,
      `    <eNCF>${doc.encf}</eNCF>`,
      `    <FechaEmision>${fechaEmision}</FechaEmision>`,
      `    <MontoTotal>${montoTotal}</MontoTotal>`,
      `    <RNCComprador>${acecfRncComprador}</RNCComprador>`,
      '    <Estado>1</Estado>',
      `    <FechaHoraAprobacionComercial>${FECHA_HORA_AC}</FechaHoraAprobacionComercial>`,
      '  </DetalleAprobacionComercial>',
      '</ACECF>',
    ].join('\n');

    // Firmar
    let signedXml;
    try {
      signedXml = signXML(xml, certificate);
    } catch (signErr) {
      console.log(`ERROR firma: ${signErr.message}`);
      results.push({ encf: doc.encf, ok: false, error: signErr.message });
      continue;
    }

    // Guardar copia local
    const outDir = path.resolve('storage/ecf/acecf-enviados');
    fs.mkdirSync(outDir, { recursive: true });
    const filename = `${rncComprador}${doc.encf}.xml`;
    fs.writeFileSync(path.join(outDir, filename), signedXml, 'utf8');

    // Enviar a DGII
    try {
      const resp = await service.dgiiClient.submitAcecf({ token, signedXml, filename });
      const ok = resp.http?.status >= 200 && resp.http?.status < 300;
      const estado = resp.estado || resp.Estado || '';
      const mensajes = Array.isArray(resp.mensajes)
        ? resp.mensajes.map((m) => String(m?.valor || m?.Valor || m?.descripcion || m?.Descripcion || m || '')).filter(Boolean).join(' | ')
        : (resp.mensaje || resp.Mensaje || '');
      const estadoCode = resp.codigoEstado || resp.codigo || '';

      console.log(`HTTP:${resp.http?.status} | estado:${estado}(${estadoCode})${mensajes ? ' | ' + mensajes : ''}`);
      // Mostrar raw completo si hay error para ver el timestamp esperado
      if (!ok || resp.http?.status >= 400) {
        console.log(`  RAW: ${String(resp.http?.body || '').slice(0, 600)}`);
      }
      results.push({ encf: doc.encf, ok, estado, mensaje: mensajes });
      if (ok && (estado === '1' || String(estadoCode) === '1' || !estado)) aceptados++;
    } catch (err) {
      console.log(`ERROR envío: ${err.message}`);
      results.push({ encf: doc.encf, ok: false, error: err.message });
    }

    await sleep(1000);
  }

  console.log('\n════════════════════════════════');
  console.log('     RESUMEN APROBACIONES');
  console.log('════════════════════════════════');
  results.forEach((r) => {
    const icon = r.ok ? '✅' : '❌';
    console.log(`${icon} ${r.encf}: ${r.estado || ''} ${r.mensaje || r.error || ''}`);
  });
  console.log(`\nTotal enviados: ${results.length} | Aparentemente OK: ${aceptados}`);
  console.log('════════════════════════════════');

  conn.end();
}

main().catch((e) => {
  console.error('\nFatal:', e.message);
  console.error(e.stack?.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});

'use strict';
/**
 * fix-nombre-comercial.js
 *
 * 1. Muestra el estado actual de los 4 docs E32 < 250Mil en la DB
 * 2. Quita NombreComercial de certification_original_xml para esos 4 docs
 *    (DGII espera NombreComercial = '' pero el Excel lo tiene como "DOCUMENTOS ELECTRONICOS")
 * 3. Regenera los XMLs de 250Mil con los ítems CORRECTOS del set de prueba
 *    y los firma con el certificado P12
 *
 * Uso: node scripts/fix-nombre-comercial.js
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const CERT_PATH = 'C:\\Users\\Emilio Coding IA\\Downloads\\20260519-145000-DHP4YAET5.p12';
const CERT_PASS = 'TecnoCaja95';
const OUT_DIR = path.join(__dirname, '250mil-upload');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Datos EXACTOS del set de prueba DGII (ECF sheet filas 12-15)
const CASOS_250MIL = [
  {
    encf: 'E320000000011',
    montoGravado: '34000.00', totalITBIS: '6120.00', montoTotal: '40120.00',
    items: [
      { num: 1, nombre: 'Cargador', tipo: '1', cant: '1', um: '55', precio: '5000.00', monto: '5000.00' },
      { num: 2, nombre: 'FREEZER',  tipo: '1', cant: '1', um: '23', precio: '29000.00', monto: '29000.00' },
    ],
  },
  {
    encf: 'E320000000013',
    montoGravado: '95000.00', totalITBIS: '17100.00', montoTotal: '112100.00',
    items: [
      { num: 1, nombre: 'Nevera', tipo: '1', cant: '1', um: '55', precio: '95000.00', monto: '95000.00' },
    ],
  },
  {
    encf: 'E320000000014',
    montoGravado: '10100.00', totalITBIS: '1818.00', montoTotal: '11918.00',
    items: [
      { num: 1, nombre: 'Articulos de belleza', tipo: '1', cant: '1', um: '55', precio: '10000.00', monto: '10000.00' },
      { num: 2, nombre: 'Queso',                tipo: '1', cant: '1', um: '23', precio: '100.00',   monto: '100.00'   },
    ],
  },
  {
    encf: 'E320000000015',
    montoGravado: '55000.00', totalITBIS: '9900.00', montoTotal: '64900.00',
    items: [
      { num: 1, nombre: 'Celular',  tipo: '1', cant: '1', um: '55', precio: '50000.00', monto: '50000.00' },
      { num: 2, nombre: 'Cargador', tipo: '1', cant: '1', um: '23', precio: '5000.00',  monto: '5000.00'  },
    ],
  },
];

function buildEcfXml(caso) {
  const itemsXml = caso.items.map(it => `    <Item>
      <NumeroLinea>${it.num}</NumeroLinea>
      <IndicadorFacturacion>1</IndicadorFacturacion>
      <NombreItem>${it.nombre}</NombreItem>
      <IndicadorBienoServicio>${it.tipo}</IndicadorBienoServicio>
      <CantidadItem>${it.cant}</CantidadItem>
      <UnidadMedida>${it.um}</UnidadMedida>
      <PrecioUnitarioItem>${it.precio}</PrecioUnitarioItem>
      <MontoItem>${it.monto}</MontoItem>
    </Item>`).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<ECF xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Encabezado>
    <Version>1.0</Version>
    <IdDoc>
      <TipoeCF>32</TipoeCF>
      <eNCF>${caso.encf}</eNCF>
      <IndicadorMontoGravado>0</IndicadorMontoGravado>
      <TipoIngresos>01</TipoIngresos>
      <TipoPago>1</TipoPago>
      <TablaFormasPago>
        <FormaDePago>
          <FormaPago>1</FormaPago>
          <MontoPago>${caso.montoTotal}</MontoPago>
        </FormaDePago>
      </TablaFormasPago>
    </IdDoc>
    <Emisor>
      <RNCEmisor>40211932609</RNCEmisor>
      <RazonSocialEmisor>DOCUMENTOS ELECTRONICOS PRUEBA FACTURA DE CONSUMO MENOR 250MIL</RazonSocialEmisor>
      <DireccionEmisor>AVE. ISABEL AGUIAR NO. 269, ZONA INDUSTRIAL DE HERRERA</DireccionEmisor>
      <TablaTelefonoEmisor>
        <TelefonoEmisor>809-472-7676</TelefonoEmisor>
      </TablaTelefonoEmisor>
      <CorreoEmisor>DOCUMENTOSELECTRONICOS@123.COM</CorreoEmisor>
      <FechaEmision>01-04-2020</FechaEmision>
    </Emisor>
    <Comprador>
      <RNCComprador>131880681</RNCComprador>
      <RazonSocialComprador>DOCUMENTOS ELECTRONICOS DE 03</RazonSocialComprador>
      <CorreoComprador>DOCUMENTOSELECTRONICOSDE0612345678969789@123.COM</CorreoComprador>
      <DireccionComprador>AVE. ISABEL AGUIAR NO. 269, ZONA INDUSTRIAL DE HERRERA</DireccionComprador>
      <MunicipioComprador>170203</MunicipioComprador>
      <ProvinciaComprador>170000</ProvinciaComprador>
      <TelefonoAdicional>809-472-7676</TelefonoAdicional>
    </Comprador>
    <Totales>
      <MontoGravadoTotal>${caso.montoGravado}</MontoGravadoTotal>
      <MontoGravadoI1>${caso.montoGravado}</MontoGravadoI1>
      <ITBIS1>18</ITBIS1>
      <TotalITBIS>${caso.totalITBIS}</TotalITBIS>
      <TotalITBIS1>${caso.totalITBIS}</TotalITBIS1>
      <MontoTotal>${caso.montoTotal}</MontoTotal>
      <MontoPeriodo>${caso.montoTotal}</MontoPeriodo>
      <ValorPagar>${caso.montoTotal}</ValorPagar>
    </Totales>
  </Encabezado>
  <DetallesItems>
${itemsXml}
  </DetallesItems>
</ECF>`;
}

function buildSignerScript() {
  return `
param([string]$InputXmlPath,[string]$OutputXmlPath,[string]$PfxPath,[string]$PfxPassword)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Security.Cryptography;
public class RSAPKCS1SHA256SignatureDescription : SignatureDescription {
  public RSAPKCS1SHA256SignatureDescription() {
    KeyAlgorithm = typeof(RSACryptoServiceProvider).FullName;
    DigestAlgorithm = typeof(SHA256Managed).FullName;
    FormatterAlgorithm = typeof(RSAPKCS1SignatureFormatter).FullName;
    DeformatterAlgorithm = typeof(RSAPKCS1SignatureDeformatter).FullName;
  }
  public override AsymmetricSignatureDeformatter CreateDeformatter(AsymmetricAlgorithm key) {
    var d = new RSAPKCS1SignatureDeformatter(key); d.SetHashAlgorithm("SHA256"); return d;
  }
  public override AsymmetricSignatureFormatter CreateFormatter(AsymmetricAlgorithm key) {
    var f = new RSAPKCS1SignatureFormatter(key); f.SetHashAlgorithm("SHA256"); return f;
  }
}
"@ -IgnoreWarnings -ErrorAction SilentlyContinue
[System.Security.Cryptography.CryptoConfig]::AddAlgorithm([RSAPKCS1SHA256SignatureDescription],'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256')
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Security')
$flags=[System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet
$cert=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxPath,$PfxPassword,$flags)
$xmlDoc=New-Object System.Xml.XmlDocument; $xmlDoc.PreserveWhitespace=$false; $xmlDoc.Load($InputXmlPath)
$signedXml=New-Object System.Security.Cryptography.Xml.SignedXml($xmlDoc)
$signedXml.SigningKey=$cert.PrivateKey
$signedXml.SignedInfo.CanonicalizationMethod=[System.Security.Cryptography.Xml.SignedXml]::XmlDsigCanonicalizationUrl
$signedXml.SignedInfo.SignatureMethod='http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
$ref=New-Object System.Security.Cryptography.Xml.Reference; $ref.Uri=''
$ref.DigestMethod='http://www.w3.org/2001/04/xmlenc#sha256'
$t=New-Object System.Security.Cryptography.Xml.XmlDsigEnvelopedSignatureTransform; [void]$ref.AddTransform($t)
[void]$signedXml.AddReference($ref)
$ki=New-Object System.Security.Cryptography.Xml.KeyInfo
$x509=New-Object System.Security.Cryptography.Xml.KeyInfoX509Data($cert); [void]$ki.AddClause($x509)
$signedXml.KeyInfo=$ki
$signedXml.ComputeSignature()
$sig=$signedXml.GetXml(); [void]$xmlDoc.DocumentElement.AppendChild($xmlDoc.ImportNode($sig,$true))
$s=New-Object System.Xml.XmlWriterSettings; $s.Encoding=New-Object System.Text.UTF8Encoding($false); $s.Indent=$true
$w=[System.Xml.XmlWriter]::Create($OutputXmlPath,$s); $xmlDoc.Save($w); $w.Flush(); $w.Close()
Write-Output "OK: $OutputXmlPath"
`;
}

async function main() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'novapos'
  });

  try {
    // 1. Mostrar estado actual de docs E32 en batch de certificacion
    const [rows] = await conn.query(
      `SELECT id, encf, tipo_ecf, estado_dgii, submission_mode, certification_case_key,
              certification_original_xml
       FROM ecf_documents
       WHERE business_id=1 AND certification_case_key IS NOT NULL AND tipo_ecf='32'
       ORDER BY certification_case_key`
    );

    console.log('\n=== ESTADO ACTUAL docs E32 en certificación ===');
    for (const r of rows) {
      let origJson = null;
      try { origJson = JSON.parse(r.certification_original_xml); } catch {}
      const nc = origJson?.row?.NombreComercial;
      console.log(`  id=${r.id} encf=${r.encf} estado=${r.estado_dgii} mode=${r.submission_mode}`);
      console.log(`    case_key=${r.certification_case_key} NombreComercial="${nc ?? '(no field)'}"`);
    }

    // 2. Fix NombreComercial: quitar el campo de todos los E32 docs en certificación
    //    que tienen NombreComercial = "DOCUMENTOS ELECTRONICOS"
    let fixed = 0;
    for (const r of rows) {
      if (!r.certification_original_xml) continue;
      let origJson = null;
      try { origJson = JSON.parse(r.certification_original_xml); } catch { continue; }

      if (origJson?.row?.NombreComercial !== undefined) {
        const oldVal = origJson.row.NombreComercial;
        delete origJson.row.NombreComercial;
        await conn.query(
          `UPDATE ecf_documents SET certification_original_xml=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
          [JSON.stringify(origJson), r.id]
        );
        console.log(`\n  ✓ Fixed id=${r.id} encf=${r.encf}: removed NombreComercial="${oldVal}"`);
        fixed++;
      }
    }
    if (fixed === 0) console.log('\n  (No NombreComercial fields to fix)');
    else console.log(`\n  Total fixed: ${fixed} docs`);

  } finally {
    await conn.end();
  }

  // 3. Regenerar < 250Mil XMLs con ítems correctos
  console.log('\n=== Regenerando XMLs para sección < 250Mil ===');
  const signerPs1 = path.join(os.tmpdir(), 'dgii-signer-250mil-v2.ps1');
  fs.writeFileSync(signerPs1, buildSignerScript(), 'utf8');
  const signedFiles = [];

  for (const caso of CASOS_250MIL) {
    const unsignedPath = path.join(os.tmpdir(), `${caso.encf}-unsigned.xml`);
    const signedPath = path.join(OUT_DIR, `${caso.encf}.xml`);

    fs.writeFileSync(unsignedPath, buildEcfXml(caso), 'utf8');

    try {
      const out = execFileSync('pwsh', [
        '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', signerPs1,
        '-InputXmlPath', unsignedPath,
        '-OutputXmlPath', signedPath,
        '-PfxPath', CERT_PATH,
        '-PfxPassword', CERT_PASS,
      ], { encoding: 'utf8', timeout: 30000 });
      console.log(`  ✓ ${caso.encf} firmado (${fs.statSync(signedPath).size} bytes)`);
      signedFiles.push(signedPath);
    } catch (err) {
      console.error(`  ✗ Error firmando ${caso.encf}:`, err.stderr || err.message);
    }
  }

  // 4. Crear ZIP
  const zipPath = path.join(OUT_DIR, '250mil-ecf-signed.zip');
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  const fileListPs = signedFiles.map(f => `'${f}'`).join(',');
  try {
    execFileSync('pwsh', [
      '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Compress-Archive -Path @(${fileListPs}) -DestinationPath '${zipPath}'`
    ], { encoding: 'utf8', timeout: 30000 });
    console.log(`\n  ✓ ZIP: ${zipPath} (${fs.statSync(zipPath).size} bytes)`);
  } catch (err) {
    console.error('Error ZIP:', err.stderr || err.message);
  }

  console.log('\n=== RESUMEN ===');
  console.log('1. NombreComercial quitado de los docs E32 en la DB');
  console.log('2. XMLs < 250Mil regenerados con ítems correctos del set de prueba DGII');
  console.log('3. Reinicia la app y ejecuta rotate-encfs?force=true, luego run-sequential');
  console.log('4. Cuando logres 21/21 + 4/4, sube el ZIP al portal:');
  console.log(`   ${zipPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });

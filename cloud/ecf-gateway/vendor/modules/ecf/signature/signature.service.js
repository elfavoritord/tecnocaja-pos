'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');
const { parseXml } = require('../utils/xml.util');

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function subjectToString(cert) {
  return (cert.subject?.attributes || [])
    .map((a) => `${a.shortName || a.name}=${a.value}`)
    .join(', ');
}

function issuerToString(cert) {
  return (cert.issuer?.attributes || [])
    .map((a) => `${a.shortName || a.name}=${a.value}`)
    .join(', ');
}

function loadCertificate({ certPath, certPassword }) {
  if (!certPath) throw new Error('No se ha configurado CERT_PATH.');
  if (!fs.existsSync(certPath)) throw new Error(`El certificado no existe: ${certPath}`);

  const p12Buffer = fs.readFileSync(certPath);
  const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, String(certPassword || ''));

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];

  const cert = certBags[0]?.cert;
  const privateKey = keyBags[0]?.key;

  if (!cert) throw new Error('El P12 no contiene certificado X509.');
  if (!privateKey) throw new Error('El P12 no contiene clave privada.');

  const certificatePem = forge.pki.certificateToPem(cert);
  const certificateBase64 = certificatePem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  // El .p12 trae la cadena completa (hoja + intermedia VIAFIRMA + raíz), pero
  // solo firmábamos con `certBags[0]` (la hoja) — el KeyInfo del XML firmado
  // nunca incluía la CA intermedia. DGII acepta el e-CF con solo la hoja (su
  // ingesta normal), pero el validador de Acuse de Recibo lo rechaza con
  // "Error de Firma Digital" porque no puede construir la cadena de confianza
  // sin la intermedia. Se arma la cadena completa (hoja primero) para que
  // quien firme pueda incluirla en <X509Data>.
  const certificateChainPem = certBags
    .map((bag) => bag.cert)
    .filter(Boolean)
    .map((c) => forge.pki.certificateToPem(c))
    .join('\n');

  return {
    certPath,
    certPassword,
    certificate: cert,
    privateKey,
    certificatePem,
    certificateBase64,
    certificateChainPem: certificateChainPem || certificatePem,
    subject: subjectToString(cert),
    issuer: issuerToString(cert),
    serialNumber: cert.serialNumber,
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
  };
}

function validateCertificate(certificateContext, { expectedRnc = null } = {}) {
  const now = new Date();
  const subjectDigits = digitsOnly(certificateContext.subject);
  const expected = digitsOnly(expectedRnc);

  return {
    exists: true,
    subject: certificateContext.subject,
    issuer: certificateContext.issuer,
    serialNumber: certificateContext.serialNumber,
    validFrom: certificateContext.validFrom.toISOString(),
    validTo: certificateContext.validTo.toISOString(),
    isExpired: certificateContext.validTo < now,
    isNotYetValid: certificateContext.validFrom > now,
    isValidNow: certificateContext.validFrom <= now && certificateContext.validTo >= now,
    rncMatch: expected ? subjectDigits.includes(expected) : null,
    belongsToRnc: expected ? subjectDigits.includes(expected) : null,
  };
}

// `Add-Type -TypeDefinition` recompila la clase C# con Roslyn EN CADA INVOCACIÓN de
// PowerShell — es el costo dominante al firmar en ráfaga (certificación con 20+
// comprobantes): varios segundos por documento solo en compilar, no en firmar. La clase
// nunca cambia, así que se compila UNA VEZ a un .dll persistido en disco (-OutputAssembly)
// y las siguientes firmas lo cargan con `Add-Type -Path` (carga de assembly ya compilado,
// sin JIT/Roslyn de por medio) — mismo algoritmo, mismo resultado, solo se salta la
// recompilación. Si el .dll cacheado no carga (corrupto, versión de .NET distinta tras
// una actualización de Windows), se recompila una vez y se vuelve a guardar.
function buildPowerShellSignerScript() {
  return `
param(
  [string]$InputXmlPath,
  [string]$OutputXmlPath,
  [string]$PfxPath,
  [string]$PfxPassword,
  [string]$AssemblyCachePath
)

$ErrorActionPreference = 'Stop'

$csharpSource = @"
using System;
using System.Security.Cryptography;
public class RSAPKCS1SHA256SignatureDescription : SignatureDescription {
  public RSAPKCS1SHA256SignatureDescription() {
    KeyAlgorithm = typeof(RSACryptoServiceProvider).FullName;
    DigestAlgorithm = typeof(SHA256Managed).FullName;
    FormatterAlgorithm = typeof(RSAPKCS1SignatureFormatter).FullName;
    DeformatterAlgorithm = typeof(RSAPKCS1SignatureDeformatter).FullName;
  }
  public override AsymmetricSignatureDeformatter CreateDeformatter(AsymmetricAlgorithm key) {
    var deformatter = new RSAPKCS1SignatureDeformatter(key);
    deformatter.SetHashAlgorithm("SHA256");
    return deformatter;
  }
  public override AsymmetricSignatureFormatter CreateFormatter(AsymmetricAlgorithm key) {
    var formatter = new RSAPKCS1SignatureFormatter(key);
    formatter.SetHashAlgorithm("SHA256");
    return formatter;
  }
}
"@

$loadedFromCache = $false
if ($AssemblyCachePath -and (Test-Path $AssemblyCachePath)) {
  try {
    Add-Type -Path $AssemblyCachePath -ErrorAction Stop
    $loadedFromCache = $true
  } catch {
    Remove-Item $AssemblyCachePath -Force -ErrorAction SilentlyContinue
  }
}
if (-not $loadedFromCache) {
  if ($AssemblyCachePath) {
    Add-Type -TypeDefinition $csharpSource -OutputAssembly $AssemblyCachePath -IgnoreWarnings -ErrorAction SilentlyContinue
  } else {
    Add-Type -TypeDefinition $csharpSource -IgnoreWarnings -ErrorAction SilentlyContinue
  }
}

[System.Security.Cryptography.CryptoConfig]::AddAlgorithm(
  [RSAPKCS1SHA256SignatureDescription],
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
)
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Security')

$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
  $PfxPath,
  $PfxPassword,
  $flags
)

$xmlDoc = New-Object System.Xml.XmlDocument
$xmlDoc.PreserveWhitespace = $false
$xmlDoc.Load($InputXmlPath)

$signedXml = New-Object System.Security.Cryptography.Xml.SignedXml($xmlDoc)
$signedXml.SigningKey = $cert.PrivateKey
$signedXml.SignedInfo.CanonicalizationMethod = [System.Security.Cryptography.Xml.SignedXml]::XmlDsigCanonicalizationUrl
$signedXml.SignedInfo.SignatureMethod = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'

$reference = New-Object System.Security.Cryptography.Xml.Reference
$reference.Uri = ''
$reference.DigestMethod = 'http://www.w3.org/2001/04/xmlenc#sha256'
$transform = New-Object System.Security.Cryptography.Xml.XmlDsigEnvelopedSignatureTransform
[void]$reference.AddTransform($transform)
[void]$signedXml.AddReference($reference)

$keyInfo = New-Object System.Security.Cryptography.Xml.KeyInfo
$x509Data = New-Object System.Security.Cryptography.Xml.KeyInfoX509Data($cert)
[void]$keyInfo.AddClause($x509Data)
$signedXml.KeyInfo = $keyInfo

$signedXml.ComputeSignature()
$signatureNode = $signedXml.GetXml()
[void]$xmlDoc.DocumentElement.AppendChild($xmlDoc.ImportNode($signatureNode, $true))

$settings = New-Object System.Xml.XmlWriterSettings
$settings.Encoding = New-Object System.Text.UTF8Encoding($false)
$settings.Indent = $true
$settings.NewLineChars = "\`r\`n"
$settings.NewLineHandling = [System.Xml.NewLineHandling]::Replace
$settings.OmitXmlDeclaration = $false

$writer = [System.Xml.XmlWriter]::Create($OutputXmlPath, $settings)
$xmlDoc.Save($writer)
$writer.Close()
`;
}

// Persistido fuera del temp dir por invocación (que se borra al final de cada firma) para
// que sobreviva entre firmas y entre reinicios de la app — ver comentario en
// buildPowerShellSignerScript sobre por qué esto elimina la recompilación C# por documento.
function getAssemblyCachePath() {
  const dir = path.join(process.cwd(), 'storage', 'ecf', 'sign-cache');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'RSAPKCS1SHA256SignatureDescription.dll');
}

function signXmlWithWindowsOnce(xmlContent, certificateContext) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tecnocaja-ecf-sign-'));
  const inputPath = path.join(tempDir, 'semilla.xml');
  const outputPath = path.join(tempDir, 'semilla-firmada.xml');
  const scriptPath = path.join(tempDir, 'sign-semilla.ps1');
  const shellBinary = fs.existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';
  const assemblyCachePath = getAssemblyCachePath();

  try {
    fs.writeFileSync(inputPath, String(xmlContent || ''), 'utf8');
    fs.writeFileSync(scriptPath, buildPowerShellSignerScript(), 'utf8');

    execFileSync(
      shellBinary,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        inputPath,
        outputPath,
        String(certificateContext.certPath || ''),
        String(certificateContext.certPassword || ''),
        assemblyCachePath,
      ],
      { stdio: 'pipe' }
    );

    const signedXml = fs.readFileSync(outputPath, 'utf8');
    if (!String(signedXml || '').trim()) {
      throw new Error('El firmador de Windows no generó contenido XML firmado.');
    }
    return signedXml;
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const stdout = String(error?.stdout || '').trim();
    const raw = stderr || stdout || error.message || 'Error desconocido al firmar XML con Windows.';
    // Strip ANSI escape codes emitted by pwsh.exe
    const detail = raw.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\r?\n[ \t]+/g, ' ').trim();
    throw new Error(`No se pudo firmar la semilla con Windows/.NET SignedXml. ${detail}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * `Add-Type` compila C# dinámicamente en cada invocación de PowerShell, y bajo
 * ráfagas de llamadas seguidas (como al certificar 20+ comprobantes) el CLR de
 * Windows a veces falla con un "Internal CLR error" transitorio (0x80131506)
 * que no tiene relación con el certificado ni el XML — es un fallo del propio
 * runtime .NET, no un problema de datos. Firmar es una operación pura sobre un
 * archivo temporal (sin efectos secundarios), así que reintentar es seguro: si
 * el problema es real (cert vencido, password incorrecto), fallará igual las
 * 3 veces y el mensaje de error se preserva sin cambios.
 *
 * No se agrega una espera artificial entre intentos: esta función es
 * síncrona (execFileSync bloquea el hilo) y este módulo no puede volverse
 * async sin tocar todos sus llamadores, así que un sleep real requeriría un
 * busy-wait que bloquearía el servidor completo — el propio arranque del
 * proceso de PowerShell (cientos de ms) ya da un respiro natural entre intentos.
 */
function signXmlWithWindows(xmlContent, certificateContext, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return signXmlWithWindowsOnce(xmlContent, certificateContext);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function signXmlWithXmlCrypto(xmlContent, certificateContext) {
  const certPem = certificateContext.certificatePem || forge.pki.certificateToPem(certificateContext.certificate);
  const privateKeyPem = forge.pki.privateKeyToPem(certificateContext.privateKey);
  let unsignedXml = String(xmlContent || '')
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, '');
  if (!/\bxsi:/i.test(unsignedXml)) {
    unsignedXml = unsignedXml.replace(/(<[A-Za-z_][\w:.-]*\b[^>]*?)\s+xmlns:xsi="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance"/i, '$1');
  }
  if (!/\bxsd:/i.test(unsignedXml)) {
    unsignedXml = unsignedXml.replace(/(<[A-Za-z_][\w:.-]*\b[^>]*?)\s+xmlns:xsd="http:\/\/www\.w3\.org\/2001\/XMLSchema"/i, '$1');
  }

  const signer = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certPem,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  });
  signer.addReference({
    xpath: '/*',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    uri: '',
    isEmptyUri: true,
  });
  signer.computeSignature(unsignedXml);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${signer.getSignedXml()}`;
}

function signXML(xmlContent, certificateContext) {
  if (!String(xmlContent || '').trim()) throw new Error('No hay XML para firmar.');
  if (!certificateContext?.certificate || !certificateContext?.privateKey) {
    throw new Error('No hay certificado cargado con clave privada disponible.');
  }

  return signXmlWithXmlCrypto(xmlContent, certificateContext);
}

function verifySignature(signedXml) {
  const hasSignedInfo = /<SignedInfo[\s>]/.test(signedXml);
  const hasSignatureValue = /<SignatureValue[\s>]/.test(signedXml);
  const hasCertificate = /<X509Certificate[\s>]/.test(signedXml);
  const hasDigestValue = /<DigestValue[\s>]/.test(signedXml);
  let signatureValid = false;
  let validationError = null;

  if (hasSignedInfo && hasSignatureValue && hasCertificate) {
    try {
      const signatureXml = String(signedXml || '').match(/<Signature[\s\S]*<\/Signature>/)?.[0] || '';
      const certificateB64 = String(
        parseXml(signedXml).getElementsByTagName('X509Certificate')?.[0]?.textContent || ''
      ).replace(/\s+/g, '');
      const publicCert = certificateB64
        ? `-----BEGIN CERTIFICATE-----\n${certificateB64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`
        : undefined;
      const verifier = new SignedXml({ publicCert });
      verifier.loadSignature(signatureXml);
      signatureValid = verifier.checkSignature(String(signedXml || '').replace(/^\uFEFF/, ''));
      if (!signatureValid) validationError = verifier.validationErrors || verifier.getValidationErrors?.() || null;
    } catch (error) {
      validationError = error.message;
    }
  }

  return {
    ok: hasSignedInfo && hasSignatureValue && hasCertificate && hasDigestValue && signatureValid,
    signatureValid,
    digestValid: signatureValid,
    hasSignedInfo,
    hasSignatureValue,
    hasCertificate,
    hasDigestValue,
    validationError,
    note: 'Firma generada/verificada con xml-crypto.',
  };
}

module.exports = {
  loadCertificate,
  validateCertificate,
  signXML,
  verifySignature,
};

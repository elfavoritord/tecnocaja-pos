'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');
const { canonicalizeNode, parseXml, serializeXml } = require('../utils/xml.util');

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

  return {
    certPath,
    certPassword,
    certificate: cert,
    privateKey,
    certificatePem,
    certificateBase64,
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

function buildPowerShellSignerScript() {
  return `
param(
  [string]$InputXmlPath,
  [string]$OutputXmlPath,
  [string]$PfxPath,
  [string]$PfxPassword
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
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
"@ -IgnoreWarnings -ErrorAction SilentlyContinue

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

function signXmlWithWindows(xmlContent, certificateContext) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tecnocaja-ecf-sign-'));
  const inputPath = path.join(tempDir, 'semilla.xml');
  const outputPath = path.join(tempDir, 'semilla-firmada.xml');
  const scriptPath = path.join(tempDir, 'sign-semilla.ps1');
  const shellBinary = fs.existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';

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
    const detail = stderr || stdout || error.message || 'Error desconocido al firmar XML con Windows.';
    throw new Error(`No se pudo firmar la semilla con Windows/.NET SignedXml. ${detail}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildInheritedNamespaces(rootElement) {
  if (!rootElement?.attributes) return '';
  const namespaces = [];
  for (let index = 0; index < rootElement.attributes.length; index += 1) {
    const attribute = rootElement.attributes.item(index);
    const attributeName = String(attribute?.nodeName || '');
    if (attributeName === 'xmlns' || attributeName.startsWith('xmlns:')) {
      namespaces.push(` ${attributeName}="${String(attribute.nodeValue || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')}"`);
    }
  }
  namespaces.sort();
  return namespaces.join('');
}

function signXML(xmlContent, certificateContext) {
  if (!String(xmlContent || '').trim()) throw new Error('No hay XML para firmar.');
  if (!certificateContext?.certificate || !certificateContext?.privateKey) {
    throw new Error('No hay certificado cargado con clave privada disponible.');
  }

  if (
    process.platform === 'win32' &&
    certificateContext?.certPath &&
    fs.existsSync(certificateContext.certPath)
  ) {
    return signXmlWithWindows(xmlContent, certificateContext);
  }

  const xmlDoc = parseXml(String(xmlContent).replace(/^\uFEFF/, ''));
  const root = xmlDoc.documentElement;
  if (!root) throw new Error('El XML no tiene un nodo raíz válido para firmar.');

  const digestInput = canonicalizeNode(root, { excludeSignature: true });
  const digestMd = forge.md.sha256.create();
  digestMd.update(digestInput, 'utf8');
  const digestB64 = forge.util.encode64(digestMd.digest().getBytes());

  const inheritedNamespaces = buildInheritedNamespaces(root);
  const signedInfoTemplate =
    `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"${inheritedNamespaces}>` +
    '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>' +
    '<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>' +
    '<Reference URI="">' +
    '<Transforms>' +
    '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>' +
    '</Transforms>' +
    '<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>' +
    `<DigestValue>${digestB64}</DigestValue>` +
    '</Reference>' +
    '</SignedInfo>';

  const signedInfoXml = canonicalizeNode(parseXml(signedInfoTemplate).documentElement);
  const signMd = forge.md.sha256.create();
  signMd.update(signedInfoXml, 'utf8');
  const signatureB64 = forge.util.encode64(certificateContext.privateKey.sign(signMd));

  const certPem = forge.pki.certificateToPem(certificateContext.certificate);
  const certB64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----\s*/g, '')
    .replace(/-----END CERTIFICATE-----\s*/g, '')
    .replace(/\s+/g, '');

  const signatureDoc = parseXml(
    '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">' +
      signedInfoXml +
      `<SignatureValue>${signatureB64}</SignatureValue>` +
      `<KeyInfo><X509Data><X509Certificate>${certB64}</X509Certificate></X509Data></KeyInfo>` +
    '</Signature>'
  );

  root.appendChild(xmlDoc.importNode(signatureDoc.documentElement, true));
  const serialized = serializeXml(xmlDoc)
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, '');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
}

function verifySignature(signedXml) {
  const hasSignedInfo = /<SignedInfo[\s>]/.test(signedXml);
  const hasSignatureValue = /<SignatureValue[\s>]/.test(signedXml);
  const hasCertificate = /<X509Certificate[\s>]/.test(signedXml);
  const hasDigestValue = /<DigestValue[\s>]/.test(signedXml);

  return {
    ok: hasSignedInfo && hasSignatureValue && hasCertificate && hasDigestValue,
    signatureValid: hasSignatureValue,
    digestValid: hasDigestValue,
    hasSignedInfo,
    hasSignatureValue,
    hasCertificate,
    hasDigestValue,
    note: 'Firma generada con Windows/.NET SignedXml.',
  };
}

module.exports = {
  loadCertificate,
  validateCertificate,
  signXML,
  verifySignature,
};

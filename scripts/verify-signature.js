'use strict';
// Script de diagnóstico: verifica DigestValue y SignatureValue, y simula el fix
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { DOMParser } = require('@xmldom/xmldom');

const historyPath = path.join(__dirname, '..', 'storage', 'ecf', 'seeds', 'history.json');
const history = fs.existsSync(historyPath)
  ? JSON.parse(fs.readFileSync(historyPath, 'utf8') || '[]')
  : [];
const latestSigned = history.find((entry) => entry?.signedPath);
if (!latestSigned?.signedPath) {
  throw new Error('No hay una semilla firmada disponible en storage/ecf/seeds/history.json.');
}
const signedXmlPath = path.resolve(__dirname, '..', latestSigned.signedPath);
const xmlString = fs.readFileSync(signedXmlPath, 'utf8');

// --- C14N helpers ---
function canonicalizeNode(node, options = {}) {
  if (!node) return '';
  switch (node.nodeType) {
    case 9: return canonicalizeNode(node.documentElement, options);
    case 1: {
      if (options.excludeSignature && isSignatureElement(node)) return '';
      const attrs = [];
      for (let i = 0; i < node.attributes.length; i++) attrs.push(node.attributes.item(i));
      attrs.sort(compareCanonicalAttributes);
      let xml = `<${node.nodeName}`;
      for (const attr of attrs) xml += ` ${attr.nodeName}="${escapeAttrValue(attr.nodeValue)}"`;
      xml += '>';
      for (let child = node.firstChild; child; child = child.nextSibling) xml += canonicalizeNode(child, options);
      xml += `</${node.nodeName}>`;
      return xml;
    }
    case 3: case 4: return escapeTextValue(node.data);
    case 7: { const d = String(node.data||'').trim(); return d ? `<?${node.target} ${d}?>` : `<?${node.target}?>`; }
    case 8: return '';
    default: return '';
  }
}
function isSignatureElement(n) { return n?.nodeType===1 && String(n.localName||n.nodeName||'').toLowerCase()==='signature' && (n.namespaceURI==='http://www.w3.org/2000/09/xmldsig#'||!n.namespaceURI); }
function compareCanonicalAttributes(a, b) {
  const aNs=isNsAttr(a), bNs=isNsAttr(b);
  if (aNs!==bNs) return aNs?-1:1;
  const aKey=aNs?nsSortKey(a):String(a.nodeName||''), bKey=bNs?nsSortKey(b):String(b.nodeName||'');
  return aKey<bKey?-1:aKey>bKey?1:0;
}
function isNsAttr(a) { const n=String(a?.nodeName||''); return n==='xmlns'||n.startsWith('xmlns:'); }
function nsSortKey(a) { const n=String(a?.nodeName||''); return n==='xmlns'?'':n.slice('xmlns:'.length); }
function escapeAttrValue(v) { return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;').replace(/\t/g,'&#x9;').replace(/\n/g,'&#xA;').replace(/\r/g,'&#xD;'); }
function escapeTextValue(v) { return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\r/g,'&#xD;'); }

// --- Parse ---
const xmlDoc = new DOMParser().parseFromString(xmlString, 'application/xml');
const root = xmlDoc.documentElement;

// --- 1. DigestValue ---
const c14nDoc = canonicalizeNode(root, { excludeSignature: true });
const md1 = forge.md.sha256.create(); md1.update(c14nDoc, 'utf8');
const computedDigest = forge.util.encode64(md1.digest().getBytes());
const embeddedDigest = (xmlDoc.getElementsByTagName('DigestValue')[0]?.textContent||'').trim();
console.log('=== DigestValue ===');
console.log('Match:', embeddedDigest === computedDigest ? 'YES ✓' : 'NO ✗');

// --- 2. Build inherited-ns SignedInfo (as the fixed code would produce) ---
const sigEl = xmlDoc.getElementsByTagName('Signature')[0];
const rootNsAttrs = [];
for (let i = 0; i < root.attributes.length; i++) {
  const a = root.attributes.item(i);
  if (isNsAttr(a)) rootNsAttrs.push(a);
}
rootNsAttrs.sort(compareCanonicalAttributes);
const inheritedNs = rootNsAttrs.map(a => ` ${a.nodeName}="${escapeAttrValue(a.nodeValue)}"`).join('');

const digestB64 = computedDigest; // reuse correct digest
const fixedSignedInfoTemplate =
  `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"${inheritedNs}>` +
  '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>' +
  '<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>' +
  '<Reference URI=""><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms>' +
  '<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>' +
  `<DigestValue>${digestB64}</DigestValue></Reference></SignedInfo>`;

const fixedSignedInfoXml = canonicalizeNode(new DOMParser().parseFromString(fixedSignedInfoTemplate, 'application/xml').documentElement);
console.log('\n=== Fixed SignedInfo C14N (first 200 chars) ===');
console.log(fixedSignedInfoXml.slice(0, 200));

// --- 3. Verify signature ---
const sigValueEl = sigEl?.getElementsByTagName('SignatureValue')[0];
const signatureB64 = (sigValueEl?.textContent||'').trim();
const certEl = sigEl?.getElementsByTagName('X509Certificate')[0];
const certB64 = (certEl?.textContent||'').replace(/\s/g,'');

function verify(pubKey, message, sigB64) {
  try {
    const md = forge.md.sha256.create(); md.update(message, 'utf8');
    return pubKey.verify(md.digest().bytes(), forge.util.decode64(sigB64));
  } catch { return false; }
}

const cert = forge.pki.certificateFromPem(`-----BEGIN CERTIFICATE-----\n${certB64}\n-----END CERTIFICATE-----`);
const pub = cert.publicKey;

const verifyStandalone = verify(pub, canonicalizeNode(sigEl?.getElementsByTagName('SignedInfo')[0]), signatureB64);
const verifyFixed = verify(pub, fixedSignedInfoXml, signatureB64);

console.log('\n=== Signature Verification ===');
console.log('Current (standalone, no inherited ns): ', verifyStandalone ? 'verifies ✓' : 'FAILS ✗');
console.log('Fixed   (with inherited ns from root): ', verifyFixed      ? 'verifies ✓' : 'FAILS ✗');
console.log('\nInherited ns added:', inheritedNs || '(none)');

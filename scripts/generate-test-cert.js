#!/usr/bin/env node
/**
 * Genera un certificado .p12 de prueba para el ambiente TesteCF de la DGII.
 * NO usar en producción — solo para homologación y pruebas técnicas.
 */

const forge = require('node-forge');
const fs    = require('fs');
const path  = require('path');

const CERT_PASSWORD = 'TecnoCaja2026';
const OUTPUT_FILE   = path.join(__dirname, '..', 'certificado-prueba.p12');

console.log('Generando certificado de prueba...');

// Par de claves RSA 2048
const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();

cert.publicKey   = keys.publicKey;
cert.serialNumber = '01';

cert.validity.notBefore = new Date();
cert.validity.notAfter  = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 3);

const attrs = [
  { name: 'commonName',       value: '40211932609 EMILIO MANAURYS CABRERA' },
  { name: 'organizationName', value: 'TECNO CAJA TEST'                      },
  { name: 'countryName',      value: 'DO'                                    }
];

cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([
  { name: 'basicConstraints', cA: false },
  { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyEncipherment: true }
]);
cert.sign(keys.privateKey, forge.md.sha256.create());

// Empaquetar como PKCS#12
const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
  keys.privateKey,
  [cert],
  CERT_PASSWORD,
  { generateLocalKeyId: true, friendlyName: 'TECNO CAJA TEST' }
);

const p12Buffer = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
fs.writeFileSync(OUTPUT_FILE, p12Buffer);

console.log('');
console.log('✅ Certificado generado exitosamente');
console.log('   Archivo   : certificado-prueba.p12  (en la raíz del proyecto)');
console.log('   Contraseña: ' + CERT_PASSWORD);
console.log('');
console.log('⚠️  SOLO para ambiente TesteCF — NO usar en producción');

'use strict';

const crypto = require('crypto');
const os = require('os');

let cachedMachineFingerprint = null;
let cachedDeviceId = null;
let cachedDescriptor = null;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function collectMacAddresses() {
  const interfaces = os.networkInterfaces() || {};
  const macs = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      const mac = String(entry?.mac || '').trim().toLowerCase();
      if (!mac || mac === '00:00:00:00:00:00' || entry?.internal) continue;
      macs.push(mac);
    }
  }
  return [...new Set(macs)].sort();
}

function buildMachineDescriptor() {
  const macs = collectMacAddresses();
  const cpuModel = String(os.cpus?.()?.[0]?.model || '').trim();
  return {
    hostname: String(os.hostname?.() || process.env.COMPUTERNAME || 'tecnocaja').trim(),
    platform: process.platform,
    arch: process.arch,
    release: String(os.release?.() || '').trim(),
    cpus: Number(os.cpus?.()?.length || 0),
    cpuModel,
    totalMem: Number(os.totalmem?.() || 0),
    systemDrive: String(process.env.SystemDrive || '').trim().toUpperCase(),
    macs,
  };
}

function getMachineDescriptor() {
  if (!cachedDescriptor) {
    const descriptor = buildMachineDescriptor();
    cachedDescriptor = {
      ...descriptor,
      macHash: sha256Hex(JSON.stringify(descriptor.macs)).slice(0, 24),
    };
  }
  return cachedDescriptor;
}

// Huella COMPLETA (incluye MAC) — es la base histórica de deriveDeviceId().
// NO cambiarla: el deviceId ya registrado en Firestore para instalaciones
// existentes depende de que esto se mantenga estable, o el servidor de
// licencias las trata como "otro dispositivo" (bloqueo por límite excedido —
// esto pasó de verdad al intentar excluir las MAC de aquí directamente).
function getMachineFingerprint() {
  if (!cachedMachineFingerprint) {
    cachedMachineFingerprint = sha256Hex(JSON.stringify(getMachineDescriptor()));
  }
  return cachedMachineFingerprint;
}

let cachedStableMachineFingerprint = null;

// Huella ESTABLE (sin MAC) — solo para derivar claves de almacenamiento LOCAL
// (cifrado de la BD SQLite, hash de integridad del caché de licencia). Las
// direcciones MAC cambian cuando se apaga WiFi/red (p. ej. al probar modo
// offline), lo que hacía que el chequeo de integridad del caché de licencia
// se disparara como falso positivo de "cambio no autorizado". A diferencia
// de getMachineFingerprint(), esta NO se usa para el deviceId remoto —
// cambiar el deviceId rompe el registro de dispositivos ya autorizados en
// Firestore (deviceLimit), que es un problema real y distinto del caché local.
function getStableMachineFingerprint() {
  if (!cachedStableMachineFingerprint) {
    const { macs, macHash, ...stableDescriptor } = getMachineDescriptor();
    cachedStableMachineFingerprint = sha256Hex(JSON.stringify(stableDescriptor));
  }
  return cachedStableMachineFingerprint;
}

function deriveDeviceId() {
  const fingerprint = getMachineFingerprint();
  const secret = String(
    process.env.TECNO_CAJA_DEVICE_SECRET
      || process.env.TECNO_CAJA_LICENSE_STORAGE_SECRET
      || `${process.env.TECNO_CAJA_USER_DATA || ''}:${process.env.TECNO_CAJA_APP_ROOT || ''}`
  ).trim() || fingerprint;

  const digest = crypto
    .createHmac('sha256', secret)
    .update(fingerprint)
    .digest('hex');

  return `npd_${digest.slice(0, 32)}`;
}

function getDeviceId() {
  if (!cachedDeviceId) {
    cachedDeviceId = deriveDeviceId();
  }
  return cachedDeviceId;
}

function getDeviceDescriptor() {
  const machine = getMachineDescriptor();
  return {
    deviceId: getDeviceId(),
    hostname: machine.hostname,
    platform: machine.platform,
    arch: machine.arch,
    macHash: machine.macHash,
  };
}

module.exports = {
  getDeviceDescriptor,
  getDeviceId,
  getMachineDescriptor,
  getMachineFingerprint,
  getStableMachineFingerprint,
  sha256Hex,
};

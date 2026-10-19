'use strict';

/**
 * Token de equipo: "eq_<equipoId>.<secreto>". El equipoId permite leer el
 * documento directo (equipos_sync/{equipoId}); en Firestore solo se guarda el
 * SHA-256 del token completo (igual que los tokens de empresa del gateway
 * e-CF). El POS lo guarda en su config/app.env y lo manda en cada petición.
 */

const crypto = require('crypto');
const { COL_EQUIPOS, ESTADOS, ESTADOS_EQUIPO } = require('../vendor/multisucursal/sucursales');

const TOKEN_PATTERN = /^eq_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function nuevoToken({ randomUUID = () => crypto.randomUUID(), randomBytes = (n) => crypto.randomBytes(n) } = {}) {
  const equipoId = randomUUID();
  const token = `eq_${equipoId}.${randomBytes(32).toString('base64url')}`;
  return { equipoId, token, tokenHash: hashToken(token) };
}

function iguales(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

class ErrorAuth extends Error {
  constructor(mensaje, codigo, status = 401) {
    super(mensaje);
    this.code = codigo;
    this.statusCode = status;
  }
}

// Devuelve { equipo, licencia, sucursal } o lanza ErrorAuth. Revisa el token,
// que el equipo siga activo (no reemplazado ni revocado), que la licencia no
// esté suspendida y que la sucursal siga activa.
async function autenticar(db, cabecera) {
  const token = String(cabecera || '').replace(/^Bearer\s+/i, '').trim();
  const m = TOKEN_PATTERN.exec(token);
  if (!m) throw new ErrorAuth('Falta el token del equipo.', 'SIN_TOKEN');

  const snap = await db.collection(COL_EQUIPOS).doc(m[1]).get();
  if (!snap.exists || !iguales(hashToken(token), snap.data().tokenHash)) {
    throw new ErrorAuth('Token de equipo inválido.', 'TOKEN_INVALIDO');
  }
  const equipo = { equipoId: snap.id, ref: snap.ref, ...snap.data() };
  if (equipo.estado === ESTADOS_EQUIPO.REEMPLAZADO) {
    throw new ErrorAuth('Otra PC se activó para esta sucursal. Esta quedó fuera de la sincronización.', 'EQUIPO_REEMPLAZADO', 403);
  }
  if (equipo.estado !== ESTADOS_EQUIPO.ACTIVO) {
    throw new ErrorAuth('Este equipo fue revocado por el administrador de Tecno Caja.', 'EQUIPO_REVOCADO', 403);
  }

  const licRef = db.collection('licencias').doc(equipo.licenseId);
  const [lic, suc] = await Promise.all([licRef.get(), licRef.collection('sucursales').doc(equipo.branchUuid).get()]);
  if (!lic.exists || lic.data().deleted) throw new ErrorAuth('La empresa ya no existe.', 'EMPRESA_NO_ENCONTRADA', 403);
  if (['suspended', 'cancelled'].includes(lic.data().status)) {
    throw new ErrorAuth('La licencia de la empresa no está activa.', 'LICENCIA_INACTIVA', 403);
  }
  if (!suc.exists || suc.data().estado !== ESTADOS.ACTIVA) {
    throw new ErrorAuth('La sucursal de este equipo está desactivada.', 'SUCURSAL_INACTIVA', 403);
  }
  return { equipo, licencia: lic.data(), sucursal: { branchUuid: suc.id, ...suc.data() } };
}

module.exports = { autenticar, nuevoToken, hashToken, ErrorAuth, TOKEN_PATTERN };

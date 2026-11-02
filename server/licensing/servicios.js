'use strict';

// Cada servicio de una empresa tiene su propio estado. Vencer la facturación
// electrónica o el soporte nunca toca la licencia del programa.
//
// Una licencia sin `servicios` es de antes de este modelo: nada se le restringe
// hasta que se le registre un contrato desde el panel.

const MODALIDAD_PERMANENTE = 'LIFETIME_NO_SUBSCRIPTION';

const ESTADOS_SERVICIO = ['activo', 'inactivo', 'suspendido'];
const SERVICIOS_DE_PAGO = ['ecf', 'soporte'];

/** Al registrar un contrato: lo que siempre va incluido y lo que se contrata aparte. */
function serviciosIniciales() {
  return {
    ecf: { estado: 'inactivo', venceEn: null },
    soporte: { estado: 'inactivo', venceEn: null },
    respaldoLocal: { estado: 'activo', venceEn: null },
    respaldoNube: { estado: 'activo', venceEn: null },
    actualizaciones: { estado: 'activo', venceEn: null },
  };
}

function fechaIso(valor) {
  if (!valor) return null;
  const d = typeof valor?.toDate === 'function' ? valor.toDate() : new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function leerServicio(entrada, porDefecto, now) {
  if (!entrada || typeof entrada !== 'object') return porDefecto;
  const venceEn = fechaIso(entrada.venceEn);
  let estado = ESTADOS_SERVICIO.includes(entrada.estado) ? entrada.estado : 'inactivo';
  if (estado === 'activo' && venceEn && now.getTime() > new Date(venceEn).getTime()) estado = 'vencido';
  return { estado, venceEn, permitido: estado === 'activo' };
}

/**
 * El estado de cada servicio de esta empresa.
 * `sin_contrato` = licencia anterior a este modelo: se permite todo como hasta hoy.
 */
function resolverServicios(servicios, now = new Date()) {
  const conContrato = Boolean(servicios && typeof servicios === 'object' && Object.keys(servicios).length);
  const sinContrato = { estado: 'sin_contrato', venceEn: null, permitido: true };
  const incluido = { estado: 'activo', venceEn: null, permitido: true };
  const s = conContrato ? servicios : {};
  return {
    conContrato,
    fuente: conContrato ? servicios : null,
    ecf: conContrato ? leerServicio(s.ecf, { estado: 'inactivo', venceEn: null, permitido: false }, now) : sinContrato,
    soporte: conContrato ? leerServicio(s.soporte, { estado: 'inactivo', venceEn: null, permitido: false }, now) : sinContrato,
    respaldoLocal: leerServicio(s.respaldoLocal, incluido, now),
    respaldoNube: leerServicio(s.respaldoNube, incluido, now),
    actualizaciones: leerServicio(s.actualizaciones, incluido, now),
  };
}

function normalizarModalidad(valor) {
  const v = String(valor || '').trim();
  return [MODALIDAD_PERMANENTE, 'mensual', 'anual'].includes(v) ? v : null;
}

module.exports = {
  ESTADOS_SERVICIO,
  MODALIDAD_PERMANENTE,
  SERVICIOS_DE_PAGO,
  normalizarModalidad,
  resolverServicios,
  serviciosIniciales,
};

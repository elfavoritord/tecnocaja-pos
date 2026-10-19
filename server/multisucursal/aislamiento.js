'use strict';

/**
 * server/multisucursal/aislamiento.js — Reglas de aislamiento entre empresas y
 * sucursales para los eventos de sincronización.
 *
 * Se aplica a todo evento que llega (a la sucursal desde la nube, o a la nube
 * desde una sucursal) ANTES de tocar la base. No confía en lo que diga el
 * evento: compara contra la identidad propia de quien lo recibe.
 *
 * Alcance de cada tipo de entidad:
 *  - 'empresa':  catálogo maestro, categorías, usuarios. Vale para cualquier
 *                sucursal de la misma empresa.
 *  - 'sucursal': ventas, caja, inventario, precio local. Solo para la
 *                sucursal dueña (o la nube, que las recibe todas).
 */

const { esUuid } = require('./identidad');

const ALCANCE_POR_ENTIDAD = Object.freeze({
  producto: 'empresa',
  categoria: 'empresa',
  usuario: 'empresa',
  acceso_sucursal: 'empresa',
  sucursal: 'empresa',
  configuracion: 'empresa',
  precio_sucursal: 'sucursal',
  venta: 'sucursal',
  movimiento_inventario: 'sucursal',
  caja: 'sucursal',
  transferencia: 'sucursal',
});

const OPERACIONES = new Set(['crear', 'actualizar', 'desactivar', 'anular']);

function rechazo(motivo, detalle = '') {
  return { ok: false, motivo, detalle };
}

/**
 * @param {object} evento  { eventId, companyUuid, branchUuid, entityType, entityUuid, operation, version, payload }
 * @param {object} receptor
 *   { companyUuid, branchUuid (null si el receptor es la nube), sucursalesPermitidas?: string[] }
 */
function validarEvento(evento, receptor) {
  if (!evento || typeof evento !== 'object') return rechazo('formato', 'El evento no es un objeto.');
  if (!receptor || !esUuid(receptor.companyUuid)) return rechazo('receptor', 'El receptor no tiene empresa identificada.');

  const { eventId, companyUuid, branchUuid, entityType, entityUuid, operation, version, payload } = evento;
  if (!esUuid(eventId)) return rechazo('formato', 'event_id inválido.');
  if (!esUuid(companyUuid)) return rechazo('formato', 'company_uuid inválido.');
  if (!esUuid(entityUuid)) return rechazo('formato', 'entity_uuid inválido.');
  if (!Object.prototype.hasOwnProperty.call(ALCANCE_POR_ENTIDAD, entityType)) {
    return rechazo('entidad', `Tipo de entidad desconocido: ${entityType}`);
  }
  if (!OPERACIONES.has(operation)) return rechazo('operacion', `Operación desconocida: ${operation}`);
  if (!Number.isInteger(Number(version)) || Number(version) < 1) return rechazo('formato', 'Versión inválida.');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return rechazo('formato', 'payload inválido.');

  if (companyUuid.toLowerCase() !== receptor.companyUuid.toLowerCase()) {
    return rechazo('otra_empresa', 'El evento pertenece a otra empresa.');
  }

  const alcance = ALCANCE_POR_ENTIDAD[entityType];
  if (alcance === 'sucursal') {
    if (!esUuid(branchUuid)) return rechazo('formato', 'Un evento de sucursal necesita branch_uuid.');
    const recibeSucursal = esUuid(receptor.branchUuid);
    if (recibeSucursal && branchUuid.toLowerCase() !== receptor.branchUuid.toLowerCase()) {
      return rechazo('otra_sucursal', 'El evento es de otra sucursal.');
    }
    // La nube puede limitar desde qué sucursales acepta (las que el equipo
    // que envía tiene autorizadas).
    const permitidas = Array.isArray(receptor.sucursalesPermitidas)
      ? receptor.sucursalesPermitidas.map((s) => String(s).toLowerCase())
      : null;
    if (!recibeSucursal && permitidas && !permitidas.includes(branchUuid.toLowerCase())) {
      return rechazo('sucursal_no_autorizada', 'El equipo no está autorizado para esa sucursal.');
    }
  }

  return { ok: true, alcance };
}

module.exports = { validarEvento, ALCANCE_POR_ENTIDAD, OPERACIONES };

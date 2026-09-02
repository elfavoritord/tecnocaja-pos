'use strict';

/**
 * _common.js — Helpers compartidos por los routers del modo Empresas de Servicios.
 */

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function roleCodeOf(actor) {
  return String(actor?.role_code || actor?.rol || '').trim().toLowerCase();
}

function actorName(actor) {
  return actor?.nombre || actor?.usuario || 'Sistema';
}

function round2(n) {
  return Number((Number(n) || 0).toFixed(2));
}

// Calcula subtotal/descuento/itbis/total de una lista de items
// { cantidad, precio, descuentoPct, itbisPct }.
function computeTotals(items) {
  let subtotal = 0;
  let descuento = 0;
  let itbis = 0;
  const normalized = (Array.isArray(items) ? items : []).map((raw) => {
    const cantidad = Math.max(0, Number(raw.cantidad || raw.qty || 0));
    const precio = Math.max(0, Number(raw.precio || raw.price || 0));
    const descuentoPct = Math.min(100, Math.max(0, Number(raw.descuentoPct ?? raw.descuento_pct ?? 0)));
    const itbisPct = Math.max(0, Number(raw.itbisPct ?? raw.itbis_pct ?? 0));
    const bruto = cantidad * precio;
    const desc = bruto * (descuentoPct / 100);
    const base = bruto - desc;
    const tax = base * (itbisPct / 100);
    subtotal += bruto;
    descuento += desc;
    itbis += tax;
    return {
      serviceId: raw.serviceId ?? raw.service_id ?? null,
      descripcion: String(raw.descripcion || raw.nombre || '').trim(),
      cantidad,
      precio,
      descuentoPct,
      itbisPct,
      total: round2(base + tax),
    };
  });
  return {
    items: normalized,
    subtotal: round2(subtotal),
    descuento: round2(descuento),
    itbis: round2(itbis),
    total: round2(subtotal - descuento + itbis),
  };
}

// Factory de un guard de auth para módulos de servicios. `permOptions` son las
// claves de permiso que habilitan roles no-admin.
function makeServiceGuard({ resolveRequestActorUser, isGlobalAdministratorUser, isBranchAdministratorUser, userRoleHasPermission }) {
  function isServiceAdmin(actor) {
    return isGlobalAdministratorUser(actor) || isBranchAdministratorUser(actor);
  }
  function can(actor, ...perms) {
    if (isServiceAdmin(actor)) return true;
    return userRoleHasPermission(actor, 'servicios', ...perms);
  }
  function requireService(...perms) {
    return async (req, res, next) => {
      try {
        const actor = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
        if (!can(actor, 'servicios.ver', ...perms)) {
          return res.status(403).json({ error: 'No tienes permiso para el módulo de Servicios.' });
        }
        req.authUser = actor;
        next();
      } catch (e) {
        res.status(e.statusCode || 401).json({ error: e.message || 'Sesión inválida o expirada.' });
      }
    };
  }
  function requirePerm(...perms) {
    return (req, res, next) => {
      if (can(req.authUser, ...perms)) return next();
      res.status(403).json({ error: 'No tienes permiso para esta acción en Servicios.' });
    };
  }
  return { isServiceAdmin, can, requireService, requirePerm };
}

// Resuelve la sucursal activa de una operación: admin general puede elegir; el
// resto queda atado a su sucursal asignada.
function resolveBranch(actor, requested, { isGlobalAdministratorUser, getUserScopeBranchId }) {
  if (isGlobalAdministratorUser(actor)) {
    return requested ? Number(requested) : null;
  }
  const scoped = getUserScopeBranchId(actor);
  if (!scoped) throw httpError('Tu usuario no tiene una sucursal asignada.', 403);
  if (requested && Number(requested) !== Number(scoped)) {
    throw httpError('No puedes operar con otra sucursal.', 403);
  }
  return Number(scoped);
}

module.exports = {
  httpError, roleCodeOf, actorName, round2, computeTotals,
  makeServiceGuard, resolveBranch,
};

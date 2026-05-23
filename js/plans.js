/* Tecno Caja — Sistema de planes comerciales
 * Disponible globalmente como window.TecnoCajaPlans
 */
(function () {
  'use strict';

  const PLAN_LEVELS = { basico: 1, pro: 2, plus: 3 };

  const PLAN_NAMES = {
    basico: 'Tecno Caja Básico',
    pro:    'Tecno Caja Pro',
    plus:   'Tecno Caja Plus',
  };

  const MODE_TO_PLAN = {
    monocaja:      'basico',
    multicaja:     'pro',
    sucursal:      'pro',
    multisucursal: 'plus',
  };

  // Módulo → plan mínimo requerido
  const MODULE_PLAN = {
    ventas:        'basico',
    productos:     'basico',
    inventario:    'basico',
    clientes:      'basico',
    proveedores:   'basico',
    caja:          'basico',
    reportes:      'basico',
    usuarios:      'basico',
    configuracion: 'basico',
    // Pro
    posmovil:   'pro',
    movimientos:'basico',
    delivery:   'basico',
    // Plus — reservado para multisucursal (módulos futuros)
  };

  function getCurrentPlanCode() {
    const stored  = (window.DB?.config?.planCode || '').toLowerCase();
    const mode    = (window.DB?.config?.businessStructureMode || '').toLowerCase();
    const derived = MODE_TO_PLAN[mode] || 'basico';
    // Usar el mayor entre el plan guardado y el derivado del modo de estructura
    return (PLAN_LEVELS[stored] || 1) >= (PLAN_LEVELS[derived] || 1)
      ? (PLAN_LEVELS[stored] ? stored : 'basico')
      : derived;
  }

  function getCurrentPlanLevel() {
    return PLAN_LEVELS[getCurrentPlanCode()] || 1;
  }

  function hasFeature(feature) {
    const required = MODULE_PLAN[feature] || 'basico';
    return getCurrentPlanLevel() >= (PLAN_LEVELS[required] || 1);
  }

  /** Devuelve true si el módulo está disponible en el plan actual */
  function isModuleAllowed(moduleId) {
    return hasFeature(moduleId);
  }

  /** Muestra un toast/alert de upgrade si el plan no cubre la feature */
  function guardFeature(feature, onAllowed) {
    if (hasFeature(feature)) {
      if (typeof onAllowed === 'function') onAllowed();
      return true;
    }
    const required = MODULE_PLAN[feature] || 'pro';
    const planName = PLAN_NAMES[required] || required;
    if (typeof window.showToast === 'function') {
      window.showToast(`Esta función requiere ${planName}. Actualiza tu plan para acceder.`, 'warning');
    }
    return false;
  }

  window.TecnoCajaPlans = {
    PLAN_LEVELS,
    PLAN_NAMES,
    MODE_TO_PLAN,
    MODULE_PLAN,
    getCurrentPlanCode,
    getCurrentPlanLevel,
    hasFeature,
    isModuleAllowed,
    guardFeature,
  };

  // Actualizar badge si ya hay sesión activa cuando este script carga
  if (typeof window._updatePlanBadge === 'function') {
    window._updatePlanBadge();
  }
})();

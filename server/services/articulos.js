'use strict';

// Un servicio es product_type = 'servicio' en products. El catálogo de una Empresa de
// Servicios se enlaza ahí (routes/servicios/enlace-productos.js) y es lo que publica su tienda.

const TIPO_SERVICIO = 'servicio';

function esServicio(tipo) {
  return String(tipo || '').trim().toLowerCase() === TIPO_SERVICIO;
}

/** Recibe la fila de config. Igual que getConfig: basta la bandera o el tipo de negocio srv_*. */
function esEmpresaServicios(config) {
  return Number(config?.service_company || 0) === 1 || /^srv_/i.test(String(config?.business_type || ''));
}

module.exports = {
  TIPO_SERVICIO,
  esEmpresaServicios,
  esServicio,
};

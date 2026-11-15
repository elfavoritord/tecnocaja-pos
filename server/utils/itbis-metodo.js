'use strict';

/**
 * Método de ITBIS de los productos (Configuración → Facturación → Impuestos):
 *   adicional → el ITBIS se suma al precio (RD$100 + 18 % = RD$118), como siempre.
 *   fijo      → el precio se cobra tal cual, sin ITBIS ("Aplica ITBIS" apagado).
 *   incluido  → el precio ya trae el ITBIS y se desglosa (RD$118 = 100 + 18).
 * El del negocio es el que traen los productos NUEVOS (formulario e importación
 * CSV); cada producto guarda el suyo (aplica_itbis + itbis_incluido), así que
 * cambiarlo nunca toca los productos que ya existen ni las ventas hechas.
 */
const ITBIS_METODOS = Object.freeze(['adicional', 'fijo', 'incluido']);

function sanitizeItbisMetodo(value) {
  const clean = String(value || '').trim().toLowerCase();
  return ITBIS_METODOS.includes(clean) ? clean : 'adicional';
}

module.exports = { ITBIS_METODOS, sanitizeItbisMetodo };

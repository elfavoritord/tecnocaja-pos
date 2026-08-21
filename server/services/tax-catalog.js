'use strict';

// Única fuente de verdad para convertir un ITBIS de monto fijo (RD$) a la
// tasa de catálogo DGII más cercana. DGII (e-CF y NCF fiscal B01/B02) solo
// acepta tasas de catálogo cerrado — ver IndicadorFacturacionType en
// modules/ecf/schemas/e-CF 34 v.1.0.xsd y TasaITBIS en
// modules/ecf/services/ecf-generator.js — nunca un monto arbitrario. Un
// producto con ITBIS manual en RD$ solo puede cobrarse tal cual en Ticket;
// si la venta termina en un comprobante fiscal, se declara con la tasa más
// cercana de este catálogo.
const CATALOG_TAX_RATES = [0, 16, 18];

function nearestCatalogTaxRate(taxAmount, taxableBase) {
  const amount = Math.max(0, Number(taxAmount || 0));
  const base = Math.max(0, Number(taxableBase || 0));
  if (!(base > 0) || !(amount > 0)) return 0;
  const impliedRate = (amount / base) * 100;
  return CATALOG_TAX_RATES.reduce((closest, rate) => (
    Math.abs(rate - impliedRate) < Math.abs(closest - impliedRate) ? rate : closest
  ), CATALOG_TAX_RATES[0]);
}

module.exports = { nearestCatalogTaxRate, CATALOG_TAX_RATES };

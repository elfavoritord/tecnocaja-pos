'use strict';

function toNumber(value) {
  const n = Number(String(value ?? 0).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function hasTaxId(value) {
  return /\d{9,11}/.test(String(value || '').replace(/\D/g, ''));
}

function validateSaleForEcf({ sale = {}, items = [], emitter = {}, sequence = {}, certificateStatus = {}, requestedType = 'E32' } = {}) {
  const errors = [];
  const type = String(requestedType || 'E32').trim().toUpperCase();

  if (!emitter.rnc) errors.push('El RNC del emisor es obligatorio.');
  if (!emitter.razon_social && !emitter.nombre_comercial) errors.push('La razón social del emisor es obligatoria.');
  if (!sequence.activo || sequence.isExpired || sequence.isExhausted) errors.push('La secuencia e-CF no está disponible.');
  if (!certificateStatus.hasCertificate || certificateStatus.isExpired) errors.push('El certificado digital no está disponible o está vencido.');
  if (!Array.isArray(items) || !items.length) errors.push('La factura debe tener al menos un producto.');

  const buyerTaxId = sale.client_tax_id_snapshot || sale.rncComprador || sale.rnc || sale.clienteRnc || '';
  if (type === 'E31' && !hasTaxId(buyerTaxId)) {
    errors.push('RNC/Cédula del comprador es obligatorio para crédito fiscal E31.');
  }

  let taxable = 0;
  let exempt = 0;
  let itemTax = 0;
  let discount = 0;

  for (const item of items || []) {
    const qty = toNumber(item.qty ?? item.cantidad ?? 1);
    const price = toNumber(item.precio ?? item.price ?? item.precio_unitario);
    const itemDiscount = toNumber(item.descuento ?? item.discount);
    const tax = toNumber(item.itbis ?? item.tax);
    const base = Math.max(0, (qty * price) - itemDiscount);

    discount += itemDiscount;
    itemTax += tax;
    if (tax > 0) taxable += base;
    else exempt += base;
  }

  const subtotal = toNumber(sale.subtotal);
  const saleDiscount = toNumber(sale.descuento ?? sale.discount);
  const taxTotal = toNumber(sale.itbis ?? sale.tax);
  const total = toNumber(sale.total);
  const expectedTotal = subtotal - saleDiscount + taxTotal;

  if (total && Math.abs(total - expectedTotal) > 1) {
    errors.push('El total de la factura no coincide con subtotal, descuento e ITBIS.');
  }

  return {
    ok: errors.length === 0,
    errors,
    type,
    totals: {
      taxable,
      exempt,
      discount: saleDiscount || discount,
      tax: taxTotal || itemTax,
      total: total || expectedTotal,
    },
  };
}

module.exports = {
  validateSaleForEcf,
};

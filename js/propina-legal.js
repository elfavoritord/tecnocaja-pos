(function(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./pos-money') : root.PosMoney);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.PropinaLegal = api;
})(typeof window !== 'undefined' ? window : globalThis, function(M) {
  'use strict';
  // Propina legal 10 %: la misma cuenta en el carrito (js/ventas.js) y en el
  // servidor (POST /api/sales). Solo consumo en el local; después de
  // descuentos y sobre la base sin ITBIS.
  //   minimo:     el negocio la cobra solo desde ese consumo (base sin ITBIS de
  //               lo que lleva propina). 0 = siempre.
  //   sinPropina: el cajero la quitó en esta venta.
  // `posible` es la propina que tocaría si no se hubiera quitado (para el botón).
  function calculate({ enabled = false, orderType = '', consumedHere = false, lines = [], discount = 0, minimo = 0, sinPropina = false }) {
    const modalidad = Boolean(enabled) && (orderType === 'mesa' || (orderType === 'mostrador' && consumedHere === true));
    const bases = lines.map(l => M.cents(l.net || 0));
    const subtotal = bases.reduce((a,b) => a+b,0n), totalDiscount = M.cents(discount);
    if (bases.some(n => n < 0n) || totalDiscount < 0n || totalDiscount > subtotal) throw new Error('Base o descuento de propina no válido.');
    let remainingDiscount = totalDiscount, remainingBase = subtotal;
    const lineDiscounts = [], netas = [];
    lines.forEach((line, i) => {
      const allocated = remainingBase ? M.divide(remainingDiscount * bases[i], remainingBase) : 0n;
      lineDiscounts.push(M.number(allocated));
      remainingDiscount -= allocated; remainingBase -= bases[i];
      netas.push(bases[i] - allocated);
    });
    const baseElegible = lines.reduce((s, line, i) => s + (line.eligible === true ? netas[i] : 0n), 0n);
    const minimoCents = M.cents(Number(minimo) > 0 ? Number(minimo).toFixed(2) : 0);
    const bajoMinimo = minimoCents > 0n && baseElegible < minimoCents;
    const posibleLineas = lines.map((line, i) => (modalidad && !bajoMinimo && line.eligible === true ? M.percent(netas[i], 10) : 0n));
    const posible = posibleLineas.reduce((a,b) => a+b,0n);
    const quitada = sinPropina === true && posible > 0n;
    const amounts = quitada ? posibleLineas.map(() => 0n) : posibleLineas;
    return {
      applies: modalidad && !bajoMinimo && !quitada, lineDiscounts,
      amount: M.number(amounts.reduce((a,b) => a+b,0n)), lineAmounts: amounts.map(M.number),
      posible: M.number(posible), base: M.number(baseElegible), quitada,
      motivo: !enabled ? 'desactivada' : (!modalidad ? 'modalidad' : (bajoMinimo ? 'bajo_minimo' : (quitada ? 'quitada' : null))),
    };
  }
  return { calculate };
});

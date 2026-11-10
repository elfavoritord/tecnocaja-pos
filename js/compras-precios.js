/* Precio de venta al preparar una compra (Compras → Preparar compra).
   Compartido por la pantalla, el servidor (server/services/compras/) y las
   pruebas. El catálogo guarda el precio SIN ITBIS (precio base) y la venta
   suma el ITBIS por línea: round2(base × tasa / 100) (js/ventas.js
   calculateSaleItemTax). Aquí se elige cómo lo escribe el usuario:
   - base:     precio base + ITBIS.
   - incluido: precio final que paga el cliente, con el ITBIS dentro. Se busca
               la base que con ese redondeo da el final; si con 2 decimales no
               existe, se propone la más cercana y se dice.
   - exento:   sin ITBIS (solo para lo que la ley declara exento; la pantalla
               pide confirmarlo y queda en la auditoría).
   La tasa siempre llega de la configuración del negocio: nunca fija aquí.
   Dinero en centavos con js/pos-money.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(() => require('./pos-money'));
  else root.ComprasPrecios = factory(() => root.PosMoney);
})(typeof window !== 'undefined' ? window : globalThis, function (dinero) {
  'use strict';
  const MODOS = Object.freeze({
    base: 'Precio base + ITBIS',
    incluido: 'Precio final (ITBIS incluido)',
    exento: 'Exento de ITBIS',
  });
  const M = () => dinero();
  const fail = (message) => Object.assign(new Error(message), { statusCode: 400 });
  const c = (v) => M().cents(Number(v || 0).toFixed(2));
  const n = (x) => M().number(x);

  function tasaValida(tasa) {
    const t = Number(tasa);
    if (!Number.isFinite(t) || t < 0 || t > 100) throw fail('La tasa de ITBIS de la configuración no es válida.');
    return t;
  }
  // ITBIS de una línea de 1 unidad, en centavos, con el redondeo de la venta.
  const itbisDe = (baseCentavos, tasa) => (tasa > 0 ? M().percent(baseCentavos, tasa) : 0n);

  // Base (centavos) cuyo base + ITBIS se acerca más al final pedido.
  function baseDesdeFinal(finalCentavos, tasa) {
    if (!(tasa > 0)) return { base: finalCentavos, final: finalCentavos };
    const aprox = M().divide(finalCentavos * 10000n, 10000n + M().scaled(tasa, 2));
    let mejor = null;
    for (let d = -3n; d <= 3n; d += 1n) {
      const base = aprox + d;
      if (base < 0n) continue;
      const final = base + itbisDe(base, tasa);
      const dif = final > finalCentavos ? final - finalCentavos : finalCentavos - final;
      // Ante empate, el final que no pasa del pedido.
      if (!mejor || dif < mejor.dif || (dif === mejor.dif && final < mejor.final)) mejor = { base, final, dif };
    }
    return mejor;
  }

  // Precio de venta del producto a partir de lo que escribió el usuario.
  // → { modo, base, itbis, final, aplicaItbis, exacto, aviso }
  function precioVenta({ modo = 'base', precio, tasa }) {
    if (!MODOS[modo]) throw fail('Elige cómo se calcula el ITBIS del precio de venta.');
    const t = tasaValida(tasa);
    const crudo = Number(precio);
    if (!Number.isFinite(crudo) || crudo < 0) throw fail('El precio de venta no es válido.');
    const p = c(crudo);
    if (modo === 'exento' || !(t > 0)) {
      return { modo, base: n(p), itbis: 0, final: n(p), aplicaItbis: false, exacto: true, aviso: '' };
    }
    if (modo === 'base') {
      const itbis = itbisDe(p, t);
      return { modo, base: n(p), itbis: n(itbis), final: n(p + itbis), aplicaItbis: true, exacto: true, aviso: '' };
    }
    const { base, final } = baseDesdeFinal(p, t);
    const exacto = final === p;
    return {
      modo, base: n(base), itbis: n(final - base), final: n(final), aplicaItbis: true, exacto,
      aviso: exacto ? '' : `Con el ITBIS calculado a 2 decimales, el precio más cercano es RD$ ${n(final).toFixed(2)} (base ${n(base).toFixed(2)}).`,
    };
  }

  // Precio base a partir del costo y un margen. Sobre el costo: base = costo × (1 + m);
  // sobre la venta: base = costo ÷ (1 − m). El costo es sin ITBIS (el ITBIS de la
  // compra se recupera; no forma parte del costo del producto).
  function baseDesdeMargen({ costo, margen, tipo = 'costo' }) {
    const k = c(costo);
    const m = Number(margen);
    if (!Number.isFinite(m) || m < 0) throw fail('El margen no es válido.');
    if (tipo === 'venta') {
      if (m >= 100) throw fail('El margen sobre la venta debe ser menor de 100 %.');
      return n(M().divide(k * 10000n, 10000n - M().scaled(m, 2)));
    }
    return n(k + M().percent(k, m));
  }

  // Precio en el modo elegido desde costo + margen (lo que va al campo de precio).
  function precioDesdeMargen({ costo, margen, tipo = 'costo', modo = 'base', tasa }) {
    const base = baseDesdeMargen({ costo, margen, tipo });
    if (modo === 'incluido') return precioVenta({ modo: 'base', precio: base, tasa }).final;
    return base;
  }

  // Ganancia bruta por unidad y margen real (sobre el costo y sobre la venta), sin ITBIS.
  function ganancia({ costo, base }) {
    const k = c(costo), b = c(base);
    const g = b - k;
    const pct = (num, den) => (den > 0n ? Number(M().divide(num * 10000n, den)) / 100 : null);
    return { ganancia: n(g), margenCosto: pct(g, k), margenVenta: pct(g, b), perdida: g < 0n };
  }

  return { MODOS, precioVenta, baseDesdeMargen, precioDesdeMargen, ganancia };
});

/* ═══════════════════════════════════════════════════════════════════════════
   TECNO CAJA — Total editado en productos por peso

   Con "Permitir modificar el total en productos por peso" (Configuración →
   Facturación), el cajero toca el Total de una línea por peso, escribe el
   monto final (lo que marcó la balanza del despachador) y el sistema calcula
   la cantidad: Chuleta a RD$160/lb, total RD$180 → 1.125 lb. El precio por
   libra NO cambia y se cobra exacto el monto escrito.

   Lo usan el carrito (js/ventas.js) y el servidor (POST /api/sales en
   server.js), que repite el cálculo antes de guardar: los dos deben llegar al
   mismo importe, así que aquí van las mismas fórmulas de redondeo que ellos
   (Number(x.toFixed(2)), como roundSaleMoney y calculateSaleItemDiscount).

   El monto escrito es el TOTAL FINAL de la línea (con ITBIS y después del
   descuento de la línea). De él salen, sin tocar el precio:
     - importe antes del descuento (base)  → sale_items.line_total
     - descuento de la línea (su %)
     - neto + ITBIS = monto (el ITBIS, como siempre: tasa sobre el neto o
       monto fijo × cantidad)
     - cantidad = base ÷ precio, con 2 decimales (sale_items.qty y las
       existencias son DECIMAL(…,2); decisión de Emilio). RD$180 a RD$160/lb
       → 1.125 → 1.13 lb, y se cobra RD$180.00 igual.
   La base se guarda tal cual: así factura, e-CF, inventario e impresión usan
   el mismo importe aunque cantidad × precio difiera unos centavos por el
   redondeo del peso. El monto escrito nunca se cambia.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VentaPorMonto = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const DECIMALES_CANTIDAD = 2;
  const MONTO_MAXIMO = 9999999;

  function r2(valor) {
    return Number(Number(valor || 0).toFixed(2));
  }

  function redondearCantidad(valor) {
    return Number(Number(valor || 0).toFixed(DECIMALES_CANTIDAD));
  }

  // Lee un monto escrito por el cajero: "1,250.50", "180", "RD$ 180".
  function leerNumero(texto) {
    const limpio = String(texto ?? '').trim().replace(/[^\d.,-]/g, '').replace(/,/g, '');
    if (!limpio) return NaN;
    const n = Number(limpio);
    return Number.isFinite(n) ? n : NaN;
  }

  function normalizar(p = {}) {
    const modo = p.modoItbis === 'monto' ? 'monto' : 'porcentaje';
    return {
      precio: Number(p.precio),
      descuento: Math.min(100, Math.max(0, Number(p.descuentoPct) || 0)),
      modo,
      tasa: modo === 'porcentaje' ? Math.max(0, Number(p.tasaItbis) || 0) : 0,
      porUnidad: modo === 'monto' ? Math.max(0, Number(p.itbisPorUnidad) || 0) : 0,
    };
  }

  // ITBIS de la línea, igual que calculateSaleItemTax (js/ventas.js).
  function itbisDe(neto, cantidad, { modo, tasa, porUnidad }) {
    if (modo === 'monto') return r2(porUnidad * cantidad);
    if (!(tasa > 0)) return 0;
    return r2(neto * (tasa / 100));
  }

  // Descuento de la línea, igual que calculateSaleItemDiscount (js/ventas.js).
  function descuentoDe(base, pct) {
    return r2(base * (pct / 100));
  }

  // Lo que paga el cliente por unidad de peso (con descuento e ITBIS).
  function precioFinalPorUnidad(p = {}) {
    const n = normalizar(p);
    if (!(n.precio > 0) || n.descuento >= 100) return 0;
    const conDescuento = n.precio * (1 - n.descuento / 100);
    return n.modo === 'monto' ? conDescuento + n.porUnidad : conDescuento * (1 + n.tasa / 100);
  }

  /**
   * Línea por peso cobrada por el total escrito.
   * @param {{monto:number, precio:number, descuentoPct?:number,
   *          modoItbis?:'porcentaje'|'monto', tasaItbis?:number, itbisPorUnidad?:number}} p
   *   precio = precio de venta por unidad de peso SIN ITBIS (el de la línea).
   * @returns {{cantidad:number, base:number, descuento:number, neto:number, itbis:number,
   *            total:number, precioFinalUnidad:number}|null}  null si los datos no sirven.
   */
  function calcular(p = {}) {
    const monto = r2(p.monto);
    const n = normalizar(p);
    if (!(monto > 0) || monto > MONTO_MAXIMO || !(n.precio > 0) || n.descuento >= 100) return null;
    const precioFinalUnidad = precioFinalPorUnidad(p);
    const cantidad = Math.max(0.01, redondearCantidad(monto / precioFinalUnidad));
    const partes = desglosar(monto, cantidad, n);
    return partes ? { cantidad, ...partes, precioFinalUnidad } : null;
  }

  // Base (antes del descuento), descuento, neto e ITBIS de una línea de
  // `cantidad` unidades cuyo total final debe ser `monto`. Si ese total no se
  // puede formar al centavo (el ITBIS se redondea por línea: 84.74 + 18 % =
  // 99.99 y 84.75 + 18 % = 100.01), queda el más cercano SIN pasarse: nunca se
  // le cobra de más al cliente.
  function desglosar(monto, cantidad, n) {
    let neto;
    if (n.modo === 'monto') {
      neto = r2(monto - itbisDe(0, cantidad, n));
    } else if (n.tasa > 0) {
      const aprox = Math.round((monto / (1 + n.tasa / 100)) * 100);
      let mejor = null;
      for (let ajuste = -3; ajuste <= 3; ajuste += 1) {
        const candidato = r2((aprox + ajuste) / 100);
        if (!(candidato > 0)) continue;
        const total = r2(candidato + itbisDe(candidato, cantidad, n));
        if (total === monto) { mejor = candidato; break; }
        if (total < monto && (mejor === null || candidato > mejor)) mejor = candidato;
      }
      neto = mejor;
    } else {
      neto = monto;
    }
    if (!(neto > 0)) return null;

    // Importe antes del descuento: el que, con su descuento redondeado, da el
    // neto (o el más cercano por debajo).
    let base = neto;
    if (n.descuento > 0) {
      const aprox = Math.round((neto / (1 - n.descuento / 100)) * 100);
      let mejor = null;
      for (let ajuste = -4; ajuste <= 4; ajuste += 1) {
        const candidato = r2((aprox + ajuste) / 100);
        if (!(candidato > 0)) continue;
        const netoDe = r2(candidato - descuentoDe(candidato, n.descuento));
        if (netoDe === neto) { mejor = candidato; break; }
        if (netoDe < neto && (mejor === null || candidato > mejor)) mejor = candidato;
      }
      base = mejor === null ? r2(aprox / 100) : mejor;
    }
    const descuento = descuentoDe(base, n.descuento);
    const netoFinal = r2(base - descuento);
    const itbis = itbisDe(netoFinal, cantidad, n);
    return { base, descuento, neto: netoFinal, itbis, total: r2(netoFinal + itbis) };
  }

  // ── ITBIS incluido en el precio (método 3) ─────────────────────────────────
  // El precio de venta del producto ya trae el ITBIS: RD$118 con 18 % → base
  // RD$100 + ITBIS RD$18, y el cliente paga RD$118 (nunca más). La línea queda
  // como cualquier otra (precio sin ITBIS + ITBIS encima), así el carrito, el
  // servidor, el e-CF y las devoluciones la tratan igual que siempre.

  // Precio sin ITBIS de una unidad cuyo precio final ya lo incluye.
  function precioBaseIncluido(p = {}) {
    const precioFinal = Number(p.precioFinal);
    if (!(precioFinal >= 0)) return 0;
    const n = normalizar({ ...p, precio: 1 });
    return n.modo === 'monto' ? Math.max(0, precioFinal - n.porUnidad) : precioFinal / (1 + n.tasa / 100);
  }

  /**
   * Línea de un producto con el ITBIS incluido en su precio.
   * @param {{precioFinal:number, cantidad:number, descuentoPct?:number,
   *          modoItbis?:'porcentaje'|'monto', tasaItbis?:number, itbisPorUnidad?:number}} p
   * @returns {{base:number, descuento:number, neto:number, itbis:number, total:number, precioBase:number}|null}
   *   total = precioFinal × cantidad menos el descuento de la línea (o un centavo menos).
   */
  function lineaItbisIncluido(p = {}) {
    const cantidad = Number(p.cantidad);
    const precioFinal = Number(p.precioFinal);
    const n = normalizar({ ...p, precio: 1 });
    if (!(cantidad > 0) || !(precioFinal >= 0) || n.descuento >= 100) return null;
    const precioBase = precioBaseIncluido(p);
    const monto = r2(r2(precioFinal * cantidad) * (1 - n.descuento / 100));
    if (!(monto > 0)) return { base: 0, descuento: 0, neto: 0, itbis: 0, total: 0, precioBase };
    const partes = desglosar(monto, cantidad, n);
    return partes ? { ...partes, precioBase } : null;
  }

  return {
    DECIMALES_CANTIDAD,
    MONTO_MAXIMO,
    calcular,
    precioFinalPorUnidad,
    precioBaseIncluido,
    lineaItbisIncluido,
    leerNumero,
  };
});

// ══════════════════════════════════════════════════════════════════════════════
//  combos-personalizados-motor.js — Tecno Caja
//  Motor de cálculo de los Combos personalizados. Lo usan el navegador
//  (window.CombosPersonalizadosMotor) y el servidor (require).
//
//  El cajero elige el PRECIO del combo (con ITBIS incluido) y los productos que
//  lleva. Un combo no es un producto: en la venta es un grupo de líneas normales
//  (una por producto) y este motor reparte el precio del combo entre ellas:
//
//    1. Cada producto recibe una parte del precio, proporcional a su precio
//       normal con ITBIS (método del mayor residuo: las partes suman el precio
//       exacto, al centavo).
//    2. De su parte se saca la base y el ITBIS según la tasa del producto
//       (18 %, 16 % o exento). Nunca se agrega ITBIS por encima del precio.
//    3. Cada línea queda con un precio unitario de 2 decimales. Si la base no
//       se divide exacta entre la cantidad, la línea se parte en dos filas del
//       mismo producto (p. ej. 2 × 33.33 y 1 × 33.34): así precio × cantidad
//       = monto de la línea, como lo pide el e-CF, sin descuentos raros.
//
//  Cada fila se calcula con los MISMOS pasos que el carrito (calcItemTotal en
//  js/ventas.js), POST /api/sales y el e-CF (ecf-generator.js → buildTotals):
//    neto  = redondeo a centavos de precio × cantidad
//    ITBIS = redondeo a centavos de neto × tasa
//  y todo se compara en centavos enteros.
// ══════════════════════════════════════════════════════════════════════════════

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CombosPersonalizadosMotor = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Tasas del catálogo de la DGII (mismo criterio que server/services/tax-catalog.js).
  const TASAS_DGII = [0, 16, 18];

  // Igual que roundSaleMoney() de js/ventas.js y Number(x.toFixed(2)) del servidor.
  function redondearDinero(valor) {
    return Number(Number(valor || 0).toFixed(2));
  }

  function aCentavos(valor) {
    return Math.round(redondearDinero(valor) * 100);
  }

  function deCentavos(centavos) {
    return Math.round(Number(centavos || 0)) / 100;
  }

  // Una línea de la venta en centavos. producto: { precio, aplicaItbis,
  // itbisModo ('porcentaje'|'monto'), itbisMonto }, opciones.tasa = ITBIS en %.
  function lineaCentavos(producto = {}, qty = 1, opciones = {}) {
    const cantidad = Number(qty || 0);
    const neto = redondearDinero(Number(producto.precio || 0) * cantidad);
    let itbis = 0;
    if (!opciones.sinItbis && neto > 0 && producto.aplicaItbis) {
      if (String(producto.itbisModo || 'porcentaje') === 'monto') {
        // Mismo orden de operaciones que el carrito: monto × cantidad × (1 − 0%).
        itbis = redondearDinero(Math.max(0, Number(producto.itbisMonto || 0)) * cantidad * 1);
      } else {
        const tasa = Math.max(0, Number(opciones.tasa ?? 0));
        if (tasa > 0) itbis = redondearDinero(neto * (tasa / 100));
      }
    }
    const total = redondearDinero(neto + itbis);
    return { neto: aCentavos(neto), itbis: aCentavos(itbis), total: aCentavos(total) };
  }

  // Junta la selección por producto, en el orden en que se eligió.
  function juntarSeleccion(seleccion = []) {
    const porId = new Map();
    for (const linea of Array.isArray(seleccion) ? seleccion : []) {
      const id = Number(linea?.id || linea?.productId || 0);
      const qty = Number(linea?.qty || linea?.cantidad || 0);
      if (!(id > 0) || !(qty > 0)) continue;
      const previa = porId.get(id);
      if (previa) previa.qty += qty;
      else porId.set(id, { ...linea, id, qty });
    }
    return [...porId.values()];
  }

  // Tasa de ITBIS de un producto dentro del combo. Un ITBIS de monto fijo no es
  // una tasa de la DGII: se usa la tasa del catálogo más cercana, igual que ya
  // hace el e-CF con esos productos.
  function tasaDeLinea(producto = {}, tasaGeneral = 18) {
    if (!producto.aplicaItbis) return 0;
    if (String(producto.itbisModo || 'porcentaje') === 'monto') {
      const base = Number(producto.precio || 0);
      const monto = Math.max(0, Number(producto.itbisMonto || 0));
      if (!(base > 0) || !(monto > 0)) return 0;
      const implicita = (monto / base) * 100;
      return TASAS_DGII.reduce((mejor, t) => (Math.abs(t - implicita) < Math.abs(mejor - implicita) ? t : mejor), TASAS_DGII[0]);
    }
    return Math.max(0, Number(tasaGeneral || 0));
  }

  // Valor normal (con ITBIS) de lo elegido: lo que costaría suelto en el carrito.
  function valorNormalCentavos(seleccion = [], tasa = 18) {
    return juntarSeleccion(seleccion).reduce((acc, l) => acc + lineaCentavos(l, l.qty, { tasa }).total, 0);
  }

  // Filas de una línea con base `base` (centavos) y `qty` unidades: precio
  // unitario de 2 decimales; si no divide exacto, dos filas del mismo producto.
  function filasDeBase(base, qty) {
    const unidad = Math.floor(base / qty);
    const resto = base - unidad * qty;
    const filas = [];
    if (qty - resto > 0) filas.push({ qty: qty - resto, unidadCentavos: unidad });
    if (resto > 0) filas.push({ qty: resto, unidadCentavos: unidad + 1 });
    return filas;
  }

  function totalDeFila(unidadCentavos, qty, tasa) {
    return lineaCentavos({ precio: unidadCentavos / 100, aplicaItbis: tasa > 0, itbisModo: 'porcentaje' }, qty, { tasa });
  }

  function totalDeBase(base, qty, tasa) {
    return filasDeBase(base, qty).reduce((acc, f) => acc + totalDeFila(f.unidadCentavos, f.qty, tasa).total, 0);
  }

  // Base (centavos) cuya línea, con su ITBIS, da `objetivo`; o la más cercana
  // sin pasarse (con ITBIS por línea hay totales que no existen: 84.74 + 18% =
  // 99.99 y 84.75 + 18% = 100.01).
  function baseParaTotal(objetivo, qty, tasa) {
    if (objetivo <= 0) return 0;
    const inicio = Math.round(objetivo / (1 + tasa / 100));
    let mejor = null;
    for (let d = -6; d <= 6; d += 1) {
      const base = inicio + d;
      if (base < 0) continue;
      const total = totalDeBase(base, qty, tasa);
      if (total === objetivo) return base;
      if (total < objetivo && (mejor === null || total > mejor.total)) mejor = { base, total };
    }
    return mejor ? mejor.base : 0;
  }

  // Reparte `precio` (RD$, ITBIS incluido) entre la selección.
  //   seleccion: [{ id, qty, precio, aplicaItbis, itbisModo, itbisMonto }]
  //   tasa: ITBIS general del negocio (%)
  // Devuelve { filas, precioCentavos, sumaCentavos, diferenciaCentavos, normalCentavos }.
  // filas: [{ id, qty, precio, tasa, neto, itbis, total, precioOriginal }] en el
  // orden de la selección; neto/itbis/total en centavos.
  function repartirCombo({ precio = 0, seleccion = [], tasa = 18 } = {}) {
    const precioCentavos = aCentavos(precio);
    const lineas = juntarSeleccion(seleccion).map((l) => ({
      ...l,
      qty: Math.round(Number(l.qty)),
      tasaLinea: tasaDeLinea(l, tasa),
      normal: lineaCentavos(l, l.qty, { tasa }).total,
    })).filter((l) => l.qty > 0);
    const normalCentavos = lineas.reduce((acc, l) => acc + l.normal, 0);
    const vacio = { filas: [], precioCentavos, sumaCentavos: 0, diferenciaCentavos: precioCentavos, normalCentavos };
    if (!lineas.length || precioCentavos <= 0) return vacio;

    // 1. Parte de cada producto (mayor residuo; si todo vale 0, por cantidad).
    // En BigInt: precio × peso puede pasar de 2^53 con montos grandes.
    const pesos = lineas.map((l) => BigInt(normalCentavos > 0 ? l.normal : l.qty));
    const totalPesos = pesos.reduce((a, b) => a + b, 0n);
    const precioBig = BigInt(precioCentavos);
    const partes = pesos.map((p) => Number((precioBig * p) / totalPesos));
    let sobrante = precioCentavos - partes.reduce((a, b) => a + b, 0);
    const orden = pesos
      .map((p, i) => ({ i, residuo: (precioBig * p) % totalPesos }))
      .sort((a, b) => (b.residuo > a.residuo ? 1 : b.residuo < a.residuo ? -1 : a.i - b.i));
    for (let k = 0; sobrante > 0; k = (k + 1) % orden.length, sobrante -= 1) partes[orden[k].i] += 1;

    // 2. Base de cada línea para que su total (con ITBIS) dé su parte.
    const bases = lineas.map((l, i) => baseParaTotal(partes[i], l.qty, l.tasaLinea));
    const totales = () => lineas.map((l, i) => totalDeBase(bases[i], l.qty, l.tasaLinea));
    const suma = () => totales().reduce((a, b) => a + b, 0);

    // 3. Ajuste fino: lo que falta (o sobra) por el redondeo se corrige
    //    moviendo centavos de base, primero en líneas exentas (cualquier monto
    //    les cabe), luego en una línea o en un par de líneas.
    const indices = lineas.map((_, i) => i).sort((a, b) => lineas[a].tasaLinea - lineas[b].tasaLinea || a - b);
    for (let vuelta = 0; vuelta < 4; vuelta += 1) {
      const falta = precioCentavos - suma();
      if (falta === 0) break;
      const actuales = totales();
      let hecho = false;
      for (const i of indices) {
        for (let k = -8; k <= 8 && !hecho; k += 1) {
          if (k === 0 || bases[i] + k < 0) continue;
          if (totalDeBase(bases[i] + k, lineas[i].qty, lineas[i].tasaLinea) - actuales[i] === falta) {
            bases[i] += k;
            hecho = true;
          }
        }
        if (hecho) break;
      }
      for (let a = 0; a < indices.length && !hecho; a += 1) {
        for (let b = a + 1; b < indices.length && !hecho; b += 1) {
          const i = indices[a];
          const j = indices[b];
          for (let ki = -4; ki <= 4 && !hecho; ki += 1) {
            for (let kj = -4; kj <= 4 && !hecho; kj += 1) {
              if ((!ki && !kj) || bases[i] + ki < 0 || bases[j] + kj < 0) continue;
              const cambio = (totalDeBase(bases[i] + ki, lineas[i].qty, lineas[i].tasaLinea) - actuales[i])
                + (totalDeBase(bases[j] + kj, lineas[j].qty, lineas[j].tasaLinea) - actuales[j]);
              if (cambio === falta) {
                bases[i] += ki;
                bases[j] += kj;
                hecho = true;
              }
            }
          }
        }
      }
      if (!hecho) break;
    }
    // Si el centavo exacto no existe, el cliente nunca paga de más.
    for (let guardia = 0; suma() > precioCentavos && guardia < 50; guardia += 1) {
      const i = indices[indices.length - 1 - (guardia % indices.length)];
      if (bases[i] > 0) bases[i] -= 1;
    }

    // Último recurso (casi siempre un solo producto gravado): una línea de 2 o
    // más unidades puede partirse de otra forma (a unidades a un precio y el
    // resto a otro) y llegar al centavo que la partición normal se salta.
    const filasEspeciales = new Map();
    let falta = precioCentavos - suma();
    if (falta !== 0) {
      const actuales = totales();
      for (const i of [...indices].reverse()) {
        const l = lineas[i];
        if (l.qty < 2 || filasEspeciales.size) continue;
        const objetivo = actuales[i] + falta;
        const unidad = Math.floor(bases[i] / l.qty);
        for (let a = 1; a < Math.min(l.qty, 25) && !filasEspeciales.size; a += 1) {
          for (let d1 = -40; d1 <= 40 && !filasEspeciales.size; d1 += 1) {
            const u1 = unidad + d1;
            if (u1 < 0) continue;
            const parte1 = totalDeFila(u1, a, l.tasaLinea).total;
            // Precio de las otras unidades que deja el total en el objetivo.
            const estimado = Math.round((objetivo - parte1) / ((l.qty - a) * (1 + l.tasaLinea / 100)));
            for (let d2 = -3; d2 <= 3; d2 += 1) {
              const u2 = estimado + d2;
              if (u2 < 0 || u2 === u1) continue;
              if (parte1 + totalDeFila(u2, l.qty - a, l.tasaLinea).total === objetivo) {
                filasEspeciales.set(i, [{ qty: a, unidadCentavos: u1 }, { qty: l.qty - a, unidadCentavos: u2 }]);
                break;
              }
            }
          }
        }
      }
      falta = 0;
    }

    const filas = [];
    lineas.forEach((l, i) => {
      for (const f of filasEspeciales.get(i) || filasDeBase(bases[i], l.qty)) {
        const calc = totalDeFila(f.unidadCentavos, f.qty, l.tasaLinea);
        filas.push({
          id: Number(l.id),
          qty: f.qty,
          precio: f.unidadCentavos / 100,
          tasa: l.tasaLinea,
          neto: calc.neto,
          itbis: calc.itbis,
          total: calc.total,
          precioOriginal: redondearDinero(l.precio),
        });
      }
    });
    const sumaCentavos = filas.reduce((acc, f) => acc + f.total, 0);
    return { filas, precioCentavos, sumaCentavos, diferenciaCentavos: precioCentavos - sumaCentavos, normalCentavos };
  }

  // Precio final con ITBIS de una unidad (lo que costaría suelto).
  function precioFinalCentavos(producto = {}, opciones = {}) {
    return lineaCentavos(producto, 1, opciones).total;
  }

  return {
    TASAS_DGII,
    redondearDinero,
    aCentavos,
    deCentavos,
    lineaCentavos,
    juntarSeleccion,
    tasaDeLinea,
    valorNormalCentavos,
    repartirCombo,
    precioFinalCentavos,
  };
});

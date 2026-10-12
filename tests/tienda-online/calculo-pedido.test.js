'use strict';

/**
 * Cálculo del pedido de la tienda online: mismas cuentas que el carrito de
 * Ventas (js/ventas.js) y mismo motor de promociones del POS.
 */

const { calcularPedido, calcularLinea, normalizarCantidad } = require('../../server/tienda-online/calculo-pedido');
const { buildActiveMapFromRows, isActiveOnDate } = require('../../server/services/promotion-engine');
const { normalizarSlug, slugValido, mensajeCliente } = require('../../server/tienda-online/contrato');
const { normalizarSettings } = require('../../server/tienda-online/settings');
const { estaAbierta } = require('../../cloud/tienda-online/lib/horario');

const NOW = new Date(2026, 9, 11, 12, 0, 0); // 11-oct-2026 12:00 local

function promo(extra) {
  return {
    promotion_id: 7, producto_id: 1, nombre: 'Oferta', prioridad: 0, color: '', texto_promocion: 'Oferta',
    hora_inicio: null, hora_fin: null, permanente: 1, fecha_inicio: null, fecha_fin: null,
    created_at: '2026-10-01T10:00:00.000Z', precio_original: 100, precio_promocion: 80, cantidad_minima: null,
    ...extra,
  };
}

describe('calcularLinea', () => {
  test('ITBIS por porcentaje sobre el neto (con descuento del producto)', () => {
    const l = calcularLinea({ id: 1, nombre: 'X', precio: 100, descuentoPct: 10, itbis: { modo: 'porcentaje', tasa: 18 } }, 3, NOW);
    expect(l.subtotal).toBe(300);
    expect(l.descuento).toBe(30);
    expect(l.itbis).toBe(48.6);
    expect(l.total).toBe(318.6);
  });

  test('ITBIS de monto fijo por unidad', () => {
    const l = calcularLinea({ id: 1, nombre: 'X', precio: 50, itbis: { modo: 'monto', monto: 7.5 } }, 2, NOW);
    expect(l.itbis).toBe(15);
    expect(l.total).toBe(115);
  });

  test('promoción de precio y por cantidad: gana la que da más ahorro', () => {
    const producto = {
      id: 1, nombre: 'Refresco', precio: 100,
      ofertas: [promo({ precio_promocion: 90 })],
      porCantidad: [promo({ promotion_id: 8, precio_promocion: 75, cantidad_minima: 3, nombre: '3x' })],
    };
    expect(calcularLinea(producto, 1, NOW).precioUnitario).toBe(90);
    const tres = calcularLinea(producto, 3, NOW);
    expect(tres.precioUnitario).toBe(75);
    expect(tres.promocionId).toBe(8);
    expect(tres.precioOriginal).toBe(100);
  });

  test('promoción vencida u horario fuera de ventana no aplica', () => {
    const vencida = { id: 1, nombre: 'X', precio: 100, ofertas: [promo({ permanente: 0, fecha_fin: '2026-10-10' })] };
    expect(calcularLinea(vencida, 1, NOW).precioUnitario).toBe(100);
    const happyHour = { id: 1, nombre: 'X', precio: 100, ofertas: [promo({ hora_inicio: '17:00:00', hora_fin: '19:00:00' })] };
    expect(calcularLinea(happyHour, 1, NOW).precioUnitario).toBe(100);
    expect(calcularLinea(happyHour, 1, new Date(2026, 9, 11, 18, 0, 0)).precioUnitario).toBe(80);
  });
});

describe('calcularPedido', () => {
  const catalogo = new Map([
    [1, { id: 1, nombre: 'Arroz', precio: 500, modoVenta: 'unidad' }],
    [2, { id: 2, nombre: 'Queso', precio: 300, modoVenta: 'peso', unidad: 'Libra', itbis: { modo: 'porcentaje', tasa: 18 } }],
  ]);

  test('suma líneas repetidas, cobra delivery y su ITBIS', () => {
    const r = calcularPedido({
      catalogo,
      items: [{ productoId: 1, cantidad: 1 }, { productoId: 1, cantidad: 1 }, { productoId: 2, cantidad: 1.5 }],
      delivery: { costo: 100, aplicaItbis: true, tasaItbis: 18 },
      now: NOW,
    });
    expect(r.errores).toEqual([]);
    expect(r.lineas.find((l) => l.productoId === 1).cantidad).toBe(2);
    expect(r.totales.subtotal).toBe(1450);
    expect(r.totales.itbis).toBe(81);
    expect(r.totales.delivery).toBe(100);
    expect(r.totales.deliveryItbis).toBe(18);
    expect(r.totales.total).toBe(1649);
  });

  test('cantidades inválidas y productos inexistentes se reportan', () => {
    const r = calcularPedido({ catalogo, items: [{ productoId: 1, cantidad: 1.5 }, { productoId: 99, cantidad: 1 }, { productoId: 1, cantidad: -1 }], now: NOW });
    expect(r.lineas).toHaveLength(0);
    expect(r.errores.length).toBeGreaterThanOrEqual(2);
  });

  test('normalizarCantidad: enteros por unidad, decimales por peso', () => {
    expect(normalizarCantidad({ modoVenta: 'unidad' }, 2)).toBe(2);
    expect(normalizarCantidad({ modoVenta: 'unidad' }, 2.5)).toBeNull();
    expect(normalizarCantidad({ modoVenta: 'peso' }, 2.555)).toBe(2.56);
    expect(normalizarCantidad({ modoVenta: 'unidad' }, 5000)).toBeNull();
  });
});

describe('motor de promociones (función pura compartida)', () => {
  test('elige la de mayor prioridad y respeta fechas', () => {
    const map = buildActiveMapFromRows([
      promo({ promotion_id: 1, prioridad: 0, precio_promocion: 70 }),
      promo({ promotion_id: 2, prioridad: 5, precio_promocion: 90 }),
    ], { now: NOW });
    expect(map[1].promotionId).toBe(2);
    expect(isActiveOnDate(promo({ permanente: 0, fecha_inicio: '2026-10-12' }), NOW)).toBe(false);
  });
});

describe('contrato y configuración', () => {
  test('slug: normaliza y rechaza reservados', () => {
    expect(normalizarSlug('Colmado Doña María #2')).toBe('colmado-dona-maria-2');
    expect(slugValido('api')).toBe(false);
    expect(slugValido('ab')).toBe(false);
    expect(slugValido('mi-colmado')).toBe(true);
  });

  test('settings: limpia montos, zonas y métodos de pago', () => {
    const s = normalizarSettings({
      pedidoMinimo: -5,
      delivery: { zonas: [{ nombre: 'Villa Mella', costo: '150' }, { nombre: '' }], costoBase: 'abc' },
      pagos: { efectivo: { habilitado: false }, transferencia: { habilitado: true, instrucciones: 'Banco' } },
      conversion: { precio: 'otro' },
    });
    expect(s.pedidoMinimo).toBe(0);
    expect(s.delivery.zonas).toEqual([{ id: 'villa-mella', nombre: 'Villa Mella', costo: 150, activa: true }]);
    expect(s.delivery.costoBase).toBe(0);
    expect(s.pagos.efectivo.habilitado).toBe(false);
    expect(s.pagos.transferencia.habilitado).toBe(true);
    expect(s.conversion.precio).toBe('pedido');
  });

  test('mensajes al cliente', () => {
    expect(mensajeCliente('en_camino', { numero: 1048 })).toBe('🚚 Tu pedido #1048 está en camino.');
    expect(mensajeCliente('listo', { numero: 5, tipoEntrega: 'retiro' })).toMatch(/retirarlo/);
    expect(mensajeCliente('rechazado', { numero: 5, motivo: 'Sin delivery hoy' })).toMatch(/Motivo: Sin delivery hoy/);
  });
});

describe('horario de la tienda (hora de RD)', () => {
  // 11-oct-2026 es domingo. 16:00 UTC = 12:00 en RD.
  const domingoMediodia = new Date('2026-10-11T16:00:00Z');
  const dias = (abre, cierra, abierto = true) => [0, 1, 2, 3, 4, 5, 6].map((dia) => ({ dia, abierto, abre, cierra }));

  test('abierto dentro del horario y cerrado fuera', () => {
    expect(estaAbierta({ dias: dias('08:00', '20:00') }, domingoMediodia)).toBe(true);
    expect(estaAbierta({ dias: dias('13:00', '20:00') }, domingoMediodia)).toBe(false);
    expect(estaAbierta({ dias: dias('08:00', '20:00', false) }, domingoMediodia)).toBe(false);
  });

  test('horario que cruza la medianoche', () => {
    const madrugada = new Date('2026-10-12T05:30:00Z'); // lunes 01:30 en RD
    expect(estaAbierta({ dias: dias('18:00', '02:00') }, madrugada)).toBe(true);
  });
});

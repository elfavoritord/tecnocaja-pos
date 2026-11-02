'use strict';

const {
  MODALIDADES, catalogo, cotizar, formatoRD, limitesDelPlan,
} = require('../../server/licensing/precios');

const RD = (pesos) => pesos * 100;
const { MENSUAL, ANUAL, PERMANENTE } = MODALIDADES;

describe('precios oficiales', () => {
  test.each([
    ['basico', 800, 7200, 8000],
    ['pro', 1400, 12600, 14000],
    ['plus', 1800, 16200, 16000],
  ])('%s: mensual, anual e implementación', (plan, mensual, anual, implementacion) => {
    expect(cotizar({ plan, modalidad: MENSUAL }).totales.total).toBe(RD(mensual));
    expect(cotizar({ plan, modalidad: ANUAL }).totales.total).toBe(RD(anual));
    const conImpl = cotizar({ plan, modalidad: MENSUAL, incluirImplementacion: true });
    expect(conImpl.totales.implementacion).toBe(RD(implementacion));
    expect(conImpl.totales.licencia).toBe(RD(mensual));
  });

  test('el año son 9 meses pagados por 12 de servicio, también en los adicionales', () => {
    const c = cotizar({ plan: 'plus', modalidad: ANUAL, computadorasExtra: 1, sucursalesExtra: 1 });
    expect(c.totales.licencia).toBe(RD(16200));
    expect(c.totales.adicionales).toBe(RD(500 * 9 + 800 * 9));
    expect(c.lineas.find((l) => l.concepto === 'Computadora adicional').total).toBe(RD(4500));
    expect(c.lineas.find((l) => l.concepto === 'Sucursal adicional').total).toBe(RD(7200));
  });
});

describe('adicionales', () => {
  test('PC adicional en MultiCaja', () => {
    const c = cotizar({ plan: 'pro', modalidad: MENSUAL, computadorasExtra: 3, incluirImplementacion: true });
    expect(c.totales.adicionales).toBe(RD(1500));
    expect(c.totales.implementacion).toBe(RD(14000 + 7500));
    expect(c.limites).toEqual({ computadoras: 5, sucursales: 1 });
  });

  test('sucursal adicional en MultiSucursal trae su computadora', () => {
    const c = cotizar({ plan: 'plus', modalidad: MENSUAL, sucursalesExtra: 2 });
    expect(c.totales.adicionales).toBe(RD(1600));
    expect(c.limites).toEqual({ computadoras: 4, sucursales: 4 });
  });

  test('PC adicional dentro de una sucursal', () => {
    const c = cotizar({ plan: 'plus', modalidad: MENSUAL, computadorasExtra: 1, incluirImplementacion: true });
    expect(c.totales.adicionales).toBe(RD(500));
    expect(c.lineas.find((l) => l.concepto === 'Implementación de computadora adicional').total).toBe(RD(3500));
    expect(c.limites).toEqual({ computadoras: 3, sucursales: 2 });
  });

  test('Básico no admite adicionales, MultiCaja tampoco sucursales', () => {
    expect(() => cotizar({ plan: 'basico', modalidad: MENSUAL, computadorasExtra: 1 })).toThrow(/cambia a MultiCaja/);
    expect(() => cotizar({ plan: 'pro', modalidad: MENSUAL, sucursalesExtra: 1 })).toThrow(/cambia a MultiSucursal/);
    expect(() => limitesDelPlan('basico', { sucursalesExtra: 1 })).toThrow();
  });

  test.each([-1, 1.5, 'x', 501])('cantidad inválida: %s', (computadorasExtra) => {
    expect(() => cotizar({ plan: 'pro', modalidad: MENSUAL, computadorasExtra })).toThrow(/número entero/);
  });
});

describe('la implementación no se mezcla ni se repite', () => {
  test('una renovación no la incluye', () => {
    const c = cotizar({ plan: 'pro', modalidad: ANUAL });
    expect(c.totales.implementacion).toBe(0);
    expect(c.lineas.some((l) => l.tipo === 'implementacion')).toBe(false);
  });

  test('el importe recurrente nunca lleva implementación', () => {
    const c = cotizar({ plan: 'pro', modalidad: MENSUAL, computadorasExtra: 1, incluirImplementacion: true });
    expect(c.totales.recurrente).toBe(RD(1900));
    expect(c.totales.total).toBe(RD(1900 + 14000 + 2500));
  });
});

describe('pago único y precios por definir', () => {
  test('sin precio definido no se inventa: queda pendiente', () => {
    const c = cotizar({ plan: 'basico', modalidad: PERMANENTE, servicios: { ecf: 'mensual' } });
    expect(c.totales.total).toBe(0);
    expect(c.pendientes).toEqual(['Licencia permanente Básico', 'Facturación electrónica']);
    expect(c.lineas[0].total).toBeNull();
  });

  test('con el precio del panel ya calcula', () => {
    const precios = { permanente: { basico: 25000 }, ecf: { mensual: 1500 } };
    const c = cotizar({ plan: 'basico', modalidad: PERMANENTE, servicios: { ecf: 'mensual' }, precios });
    expect(c.totales.licencia).toBe(RD(25000));
    expect(c.totales.servicios).toBe(RD(1500));
    expect(c.totales.recurrente).toBe(RD(1500));
    expect(c.pendientes).toEqual([]);
  });

  test('un precio mal escrito en el panel cuenta como no definido', () => {
    const c = catalogo({ permanente: { basico: 'abc', pro: -5, plus: '' }, ecf: { mensual: 99.5 } });
    expect(c.planes.map((p) => p.permanente)).toEqual([null, null, null]);
    expect(c.servicios.ecf.mensual).toBe(9950);
  });

  test('sin decimales sueltos: 0.1 + 0.2 no aparece', () => {
    const c = cotizar({ plan: 'basico', modalidad: PERMANENTE, servicios: { ecf: 'mensual', soporte: 'mensual' }, precios: { permanente: { basico: 0.1 }, ecf: { mensual: 0.2 }, soporte: { mensual: 0.7 } } });
    expect(c.totales.total).toBe(100);
    expect(Number.isInteger(c.totales.total)).toBe(true);
  });
});

test('plan o modalidad inválidos', () => {
  expect(() => cotizar({ plan: '__proto__', modalidad: MENSUAL })).toThrow(/Plan inválido/);
  expect(() => cotizar({ plan: 'basico', modalidad: 'gratis' })).toThrow(/Modalidad inválida/);
});

test('formato para mostrar', () => {
  expect(formatoRD(RD(16200))).toBe('RD$16,200');
  expect(formatoRD(150050)).toBe('RD$1,500.50');
  expect(formatoRD(null)).toBe('Consultar');
});

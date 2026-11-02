'use strict';

const { alertasDeSecuencias } = require('../tecno-caja-contadores/server/alertas-secuencias');

const HOY = '2026-11-01';

function rango(documentType, quedan, total, extra = {}) {
  return {
    documentType, status: 'activo', startNumber: 1, endNumber: total, nextNumber: total - quedan + 1,
    totalAuthorized: total, totalAvailable: quedan, branchId: null, branchName: 'Global', ...extra,
  };
}

const alertas = (aplicadas, pendientes = []) => alertasDeSecuencias({ aplicadas, pendientes, hoy: HOY });

describe('alertas de comprobantes para el contador', () => {
  test('con bastantes comprobantes no avisa', () => {
    expect(alertas([rango('E32', 900, 1000)])).toEqual([]);
  });

  test('avisa cuando quedan pocos, y más fuerte cuando quedan muy pocos', () => {
    expect(alertas([rango('E32', 50, 100)])[0]).toMatchObject({ nivel: 'advertencia', documentType: 'E32', quedan: 50 });
    expect(alertas([rango('E32', 15, 100)])[0]).toMatchObject({ nivel: 'urgente', quedan: 15 });
  });

  test('en un rango grande avisa por porcentaje', () => {
    expect(alertas([rango('E32', 90000, 1000000)])[0].nivel).toBe('advertencia');
    expect(alertas([rango('E32', 19000, 1000000)])[0].nivel).toBe('urgente');
  });

  test('agotada sin otro rango es crítico', () => {
    const [a] = alertas([rango('E32', 0, 100, { effectiveStatus: 'agotado' })]);
    expect(a.nivel).toBe('critico');
    expect(a.msg).toMatch(/se acabaron/);
  });

  test('vencida sin otro rango es crítico', () => {
    const [a] = alertas([rango('E31', 40, 100, { expirationDate: '2026-10-01', effectiveStatus: 'vencido' })]);
    expect(a.nivel).toBe('critico');
    expect(a.msg).toMatch(/venció/);
  });

  test('si ya hay otro rango cargado no avisa, porque no hay nada que pedir', () => {
    expect(alertas([
      rango('E32', 3, 100),
      rango('E32', 500, 500, { startNumber: 101, endNumber: 600, nextNumber: 101 }),
    ])).toEqual([]);
    expect(alertas([rango('E32', 0, 100, { effectiveStatus: 'agotado' }), rango('E32', 500, 500)])).toEqual([]);
  });

  test('si ya lo registró y el POS no lo ha aplicado, no vuelve a avisar', () => {
    expect(alertas([rango('E32', 3, 100)], [{ documentType: 'E32', status: 'pendiente' }])).toEqual([]);
    expect(alertas([rango('E32', 3, 100)], [{ documentType: 'E31', status: 'pendiente' }])).toHaveLength(1);
  });

  test('avisa por fecha de vencimiento', () => {
    expect(alertas([rango('E31', 900, 1000, { expirationDate: '2026-11-21' })])[0]).toMatchObject({ nivel: 'advertencia' });
    expect(alertas([rango('E31', 900, 1000, { expirationDate: '2026-11-05' })])[0]).toMatchObject({ nivel: 'urgente' });
    expect(alertas([rango('E31', 900, 1000, { expirationDate: '2026-11-01' })])[0].msg).toMatch(/vence hoy/);
    expect(alertas([rango('E31', 900, 1000, { expirationDate: '2027-11-01' })])).toEqual([]);
  });

  test('un rango sin vencimiento quita la prisa de la fecha', () => {
    expect(alertas([
      rango('E31', 900, 1000, { expirationDate: '2026-11-05' }),
      rango('E31', 900, 1000),
    ])).toEqual([]);
  });

  test('quien ya factura electrónico no recibe avisos de sus B viejos', () => {
    const viejoB = rango('B01', 0, 100, { effectiveStatus: 'agotado' });
    expect(alertas([viejoB, rango('E31', 900, 1000)])).toEqual([]);
    expect(alertas([viejoB])).toHaveLength(1);
  });

  test('una desactivada no cuenta', () => {
    expect(alertas([rango('E32', 3, 100, { status: 'suspendido' })])).toEqual([]);
  });

  test('cada sucursal se mira aparte', () => {
    const lista = alertas([
      rango('E32', 3, 100, { branchId: 1, branchName: 'Principal' }),
      rango('E32', 900, 1000, { branchId: 2, branchName: 'Norte' }),
    ]);
    expect(lista).toHaveLength(1);
    expect(lista[0].msg).toMatch(/Principal/);
  });
});

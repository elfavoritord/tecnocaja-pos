'use strict';
// Cancelación y notas de crédito: reglas por documento y estado fiscal,
// importe con ITBIS y propina, y reparto del reembolso.
const ajustes = require('../../server/services/ajustes-venta');

const runEcf = (estado) => async (sql) => (/ecf_documents/.test(sql) && estado ? [{ id: 5, tipo_ecf: 'E31', encf: 'E310000000001', estado_dgii: estado }] : []);
const hoy = new Date().toISOString().slice(0, 19).replace('T', ' ');

describe('clasificar', () => {
  test('ticket interno: cancelación interna y nota interna', async () => {
    const c = await ajustes.clasificar(runEcf(null), { id: 1, document_type: 'ticket', sale_status: 'pagada', created_at: hoy });
    expect(c.cancelar.modos).toEqual(['interna']); expect(c.notaCredito.tipo).toBe('interna');
  });
  test('serie B: anulación 608 o nota de crédito B04', async () => {
    const c = await ajustes.clasificar(runEcf(null), { id: 1, document_type: 'comprobante-fiscal', ncf: 'B0200000001', sale_status: 'pagada', created_at: hoy });
    expect(c.cancelar.modos).toEqual(['anulacion_608', 'nota_credito_b04']); expect(c.notaCredito.tipo).toBe('B04');
  });
  test('e-CF aceptado: E34; pendiente: no se cancela a ciegas; rechazado: interna sin nota', async () => {
    const sale = { id: 1, document_type: 'factura-electronica', sale_status: 'pagada', created_at: hoy };
    expect((await ajustes.clasificar(runEcf('aceptado'), sale)).notaCredito.tipo).toBe('E34');
    expect((await ajustes.clasificar(runEcf('aceptado_condicional'), sale)).cancelar.modos).toEqual(['nota_credito_e34']);
    const pend = await ajustes.clasificar(runEcf('enviado'), sale);
    expect(pend.cancelar.permitido).toBe(false); expect(pend.notaCredito.permitido).toBe(false); expect(pend.estadoFiscal).toBe('pendiente_dgii');
    const rech = await ajustes.clasificar(runEcf('rechazado'), sale);
    expect(rech.cancelar.modos).toEqual(['interna_rechazado']); expect(rech.notaCredito.permitido).toBe(false);
  });
  test('ya cancelada o pendiente de cobro', async () => {
    expect((await ajustes.clasificar(runEcf(null), { id: 1, fiscal_status: 'cancelada', created_at: hoy })).cancelar.permitido).toBe(false);
    const p = await ajustes.clasificar(runEcf(null), { id: 1, sale_status: 'pendiente', created_at: hoy });
    expect(p.cancelar.modos).toEqual(['interna']); expect(p.notaCredito.permitido).toBe(false);
  });
  test('más de 30 días: lo marca para que la nota no rebaje el ITBIS', async () => {
    const viejo = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    expect((await ajustes.clasificar(runEcf('aceptado'), { id: 1, document_type: 'factura-electronica', sale_status: 'pagada', created_at: viejo })).masDe30Dias).toBe(true);
  });
});

describe('calcularLineas', () => {
  const sale = { total: '236.00', tax: '36.00', legal_tip_amount: '0' };
  const items = [{ id: 10, qty: 2, price: '100.00', discount_rate: 0, tax_rate: 18, product_id: 3, product_name: 'A', general_discount_amount: 0, legal_tip_amount: 0 }];
  test('incluye el ITBIS de lo devuelto', () => {
    const r = ajustes.calcularLineas({ sale, originalItems: items, devueltoMap: {}, itemsToReturn: [{ saleItemId: 10, qty: 1, restock: false }], previos: { total: 0, itbis: 0, propina: 0 } });
    expect(r.total).toBe(11800n); expect(r.itbis).toBe(1800n); expect(r.completa).toBe(false); expect(r.lineas[0].restock).toBe(false);
  });
  test('descuento de línea, descuento general y propina proporcional', () => {
    const its = [{ id: 1, qty: 2, price: '100.00', discount_rate: 10, tax_rate: 18, general_discount_amount: '18.00', legal_tip_amount: '16.20' }];
    const r = ajustes.calcularLineas({ sale: { total: '999', tax: '0', legal_tip_amount: '0' }, originalItems: its, devueltoMap: {}, itemsToReturn: [{ saleItemId: 1, qty: 1 }], previos: { total: 0, itbis: 0, propina: 0 } });
    expect(r.neto).toBe(8100n); // 90 − 9 de descuento general
    expect(r.itbis).toBe(1458n); expect(r.propina).toBe(810n);
  });
  test('la última devolución completa exactamente lo que queda (sin centavos perdidos)', () => {
    const r = ajustes.calcularLineas({ sale: { total: '100.01', tax: '15.26', legal_tip_amount: '0' }, originalItems: [{ id: 1, qty: 3, price: '28.25', discount_rate: 0, tax_rate: 18 }],
      devueltoMap: { 1: 2 }, itemsToReturn: [{ saleItemId: 1, qty: 1 }], previos: { total: 66.67, itbis: 10.17, propina: 0 } });
    expect(r.completa).toBe(true); expect(r.total).toBe(3334n); expect(r.itbis).toBe(509n);
  });
  test('no permite devolver más de lo vendido', () => {
    expect(() => ajustes.calcularLineas({ sale, originalItems: items, devueltoMap: { 10: 2 }, itemsToReturn: [{ saleItemId: 10, qty: 1 }], previos: { total: 0, itbis: 0, propina: 0 } })).toThrow(/solo puedes devolver/);
  });
});

describe('repartirReembolso', () => {
  const mixto = { total: '100.00', payment_method: 'mixto', financial_version: 1, cash_amount: '20.00', card_amount: '30.00', transfer_amount: '10.00', credit_amount: '40.00', received_amount: '60.00', credit_adjustment: '0' };
  test('cancelar un mixto: cada método por su parte; el crédito rebaja la deuda', () => {
    expect(ajustes.repartirReembolso(mixto, 10000n)).toEqual({ total: 100, efectivo: 20, efectivoDesdeCaja: 20, tarjeta: 30, transferencia: 10, creditoRebajado: 40, efectivoSinReembolsar: 0 });
  });
  test('si el cliente ya pagó el crédito, esa parte se devuelve como dinero', () => {
    const pagado = { ...mixto, received_amount: '100.00' };
    expect(ajustes.repartirReembolso(pagado, 10000n)).toMatchObject({ efectivo: 60, creditoRebajado: 0 });
  });
  test('sin devolver efectivo de la caja: queda registrado como no reembolsado', () => {
    expect(ajustes.repartirReembolso({ total: '50', payment_method: 'efectivo' }, 5000n, { refundCash: false })).toMatchObject({ efectivo: 50, efectivoDesdeCaja: 0, efectivoSinReembolsar: 50 });
  });
});

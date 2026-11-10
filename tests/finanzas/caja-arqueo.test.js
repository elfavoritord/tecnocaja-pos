'use strict';
// Cierre seguro: denominaciones, componentes de pago y efectivo esperado.
const arqueo = require('../../server/services/caja-arqueo');

describe('contarDenominaciones', () => {
  test('suma billetes y monedas dominicanos en centavos exactos', () => {
    const r = arqueo.contarDenominaciones({ 2000: 1, 1000: 2, 500: 1, 200: 3, 100: 4, 50: 1, 20: 2, 25: 3, 10: 1, 5: 2, 1: 7 });
    expect(r.total).toBe(2000 + 2000 + 500 + 600 + 400 + 50 + 40 + 75 + 10 + 10 + 7);
    expect(r.lineas.find((l) => l.valor === 25)).toMatchObject({ tipo: 'moneda', cantidad: 3, subtotal: 75 });
  });
  test('acepta el formato de lista y los vacíos como cero', () => {
    expect(arqueo.contarDenominaciones([{ valor: 100, cantidad: 2 }, { valor: 1, cantidad: '' }]).total).toBe(200);
    expect(arqueo.contarDenominaciones({}).total).toBe(0);
  });
  test('rechaza denominaciones inexistentes, negativos y fracciones', () => {
    expect(() => arqueo.contarDenominaciones({ 3: 1 })).toThrow(/no válida/);
    expect(() => arqueo.contarDenominaciones({ 100: -1 })).toThrow(/enteras/);
    expect(() => arqueo.contarDenominaciones({ 100: 1.5 })).toThrow(/enteras/);
  });
});

describe('componentesVenta', () => {
  const base = { cash_session_id: 7, sale_status: 'pagada', total: '100.00' };
  test('venta nueva: usa el desglose exacto del pago mixto', () => {
    const c = arqueo.componentesVenta({ ...base, payment_method: 'mixto', financial_version: 1, cash_amount: '20.00', card_amount: '30.00', transfer_amount: '10.00', credit_amount: '40.00' }, 7);
    expect([c.cash, c.card, c.transfer, c.credit]).toEqual([2000n, 3000n, 1000n, 4000n]);
  });
  test('ventas viejas por método; el mixto viejo no se cuenta como efectivo', () => {
    expect(arqueo.componentesVenta({ ...base, payment_method: 'tarjeta' }, 7).card).toBe(10000n);
    expect(arqueo.componentesVenta({ ...base, payment_method: 'credito', received_amount: '25.00' }, 7)).toMatchObject({ cash: 2500n, credit: 7500n });
    const mixto = arqueo.componentesVenta({ ...base, payment_method: 'mixto' }, 7);
    expect(mixto.cash).toBe(0n); expect(mixto.mixtoSinDesglose).toBe(10000n);
  });
  test('contra entrega: efectivo en el turno que lo recibió, pendiente en el que se vendió', () => {
    const s = { ...base, payment_method: 'contra_entrega', delivery_cash_status: 'validado', delivery_cash_session_id: 9 };
    expect(arqueo.componentesVenta(s, 9).cash).toBe(10000n);
    expect(arqueo.componentesVenta(s, 7).cash).toBe(0n);
    expect(arqueo.componentesVenta({ ...base, payment_method: 'contra_entrega', delivery_cash_status: 'pendiente' }, 7).contraEntregaPendiente).toBe(10000n);
  });
  test('una cancelación vieja no cuenta; una nueva sí (su reembolso es un movimiento)', () => {
    expect(arqueo.ventaCuenta({ sale_status: 'pagada', fiscal_status: 'cancelada' })).toBe(false);
    expect(arqueo.ventaCuenta({ sale_status: 'pagada', fiscal_status: 'cancelada', cancel_refund_mode: 'efectivo' })).toBe(true);
    expect(arqueo.ventaCuenta({ sale_status: 'pendiente' })).toBe(false);
  });
});

describe('mesasConDeuda (cierre con mesas abiertas)', () => {
  const { mesasConDeuda } = require('../../server/routes/caja-segura.routes');
  const runner = ({ cuentas = [], otrasCajas = 0, sinTabla = false }) => async (sql) => {
    if (/FROM mesas_cuentas/.test(sql)) { if (sinTabla) throw new Error('SQLITE_ERROR: no such table: mesas_cuentas'); return cuentas; }
    if (/FROM cash_sessions/.test(sql)) return [{ total: otrasCajas }];
    return [];
  };
  const cuenta = (items, extra = {}) => ({ id: 'c1', nombre: 'General', elemento_id: 'm1', estado: 'abierta', draft_json: JSON.stringify({ items, tableLabel: 'Mesa 4' }), ...extra });
  test('una mesa con consumo bloquea el cierre de la única caja abierta', async () => {
    const r = await mesasConDeuda(runner({ cuentas: [cuenta([{ id: 1, qty: 2, precio: 150, descuento: 10 }])] }), { branchId: 1, cashRegisterId: 1 });
    expect(r.bloquea).toBe(true); expect(r.mesas[0]).toMatchObject({ mesa: 'Mesa 4', consumo: 270, productos: 1 });
  });
  test('cuentas vacías y el módulo sin usar no bloquean', async () => {
    expect((await mesasConDeuda(runner({ cuentas: [cuenta([])] }), { branchId: 1, cashRegisterId: 1 })).bloquea).toBe(false);
    expect((await mesasConDeuda(runner({ sinTabla: true }), { branchId: 1, cashRegisterId: 1 })).bloquea).toBe(false);
  });
  test('multicaja: si otra caja de la sucursal sigue abierta, las mesas se cobran allí', async () => {
    const r = await mesasConDeuda(runner({ cuentas: [cuenta([{ id: 1, qty: 1, precio: 100 }])], otrasCajas: 1 }), { branchId: 1, cashRegisterId: 1 });
    expect(r.mesas).toHaveLength(1); expect(r.otraCajaAbierta).toBe(true); expect(r.bloquea).toBe(false);
  });
});

describe('resumenTurno', () => {
  function runFalso(tablas) {
    return async (sql) => {
      if (/FROM cash_sessions/.test(sql)) return [tablas.session];
      if (/FROM sales s/.test(sql)) return tablas.sales;
      if (/FROM client_credit_payments/.test(sql)) return tablas.abonos || [];
      if (/FROM cash_movements/.test(sql)) return tablas.movs || [];
      return [];
    };
  }
  test('efectivo esperado = fondo + efectivo + abonos en efectivo + entradas − salidas; crédito y tarjeta aparte', async () => {
    const r = await arqueo.resumenTurno(runFalso({
      session: { id: 7, opened_amount: '1000.00', status: 'open', opened_at: '2026-11-08 08:00:00' },
      sales: [
        { id: 1, cash_session_id: 7, sale_status: 'pagada', payment_method: 'efectivo', total: '100.00', tax: '0', discount: '0', legal_tip_amount: '0', document_type: 'ticket' },
        { id: 2, cash_session_id: 7, sale_status: 'pagada', payment_method: 'mixto', financial_version: 1, total: '100.00', cash_amount: '20.00', card_amount: '30.00', transfer_amount: '10.00', credit_amount: '40.00', tax: '0', discount: '0', legal_tip_amount: '10.00', document_type: 'factura-electronica', transfer_status: 'pendiente' },
        { id: 3, cash_session_id: 7, sale_status: 'pagada', payment_method: 'tarjeta', total: '50.00', tax: '0', discount: '0', legal_tip_amount: '0', document_type: 'ticket', card_status: 'reversada' },
      ],
      abonos: [{ id: 1, amount: '15.00', payment_method: 'efectivo' }, { id: 2, amount: '10.00', payment_method: 'tarjeta' }],
      movs: [
        { id: 1, movement_type: 'Apertura', amount: '1000.00' }, { id: 2, movement_type: 'Retiro de efectivo', amount: '-50.00' },
        { id: 3, movement_type: 'Gasto', amount: '-30.00' }, { id: 4, movement_type: 'Cambio de menudo', amount: '5.00' },
        { id: 5, movement_type: 'Cobro crédito cliente', amount: '15.00' }, { id: 6, movement_type: 'Gaveta abierta', amount: '0' },
      ],
    }), 7);
    expect(r.efectivo.esperado).toBe(1000 + 100 + 20 + 15 + 5 - 50 - 30);
    expect(r.tarjeta.cobrado).toBe(40); expect(r.tarjeta.reversado).toBe(50);
    expect(r.transferencia.pendienteConfirmar).toBe(10);
    expect(r.credito.pendienteNuevo).toBe(40);
    expect(r.ventas.propinaLegal).toBe(10); expect(r.ventas.propias).toBe(240);
    expect(r.efectivo.propinaEnEfectivo).toBe(2); // 10 × 20/100
    expect(r.ventas.facturas).toMatchObject({ total: 3, ticket: 2, electronica: 1 });
    expect(r.cobrado.total).toBe(r.cobrado.efectivo + r.cobrado.tarjeta + r.cobrado.transferencia);
  });
  test('anticipos de reservas: el efectivo sale de sus movimientos; tarjeta y transferencia, de la reserva', async () => {
    const run = async (sql) => {
      if (/FROM cash_sessions/.test(sql)) return [{ id: 7, opened_amount: '1000.00', status: 'open', opened_at: '2026-11-09 08:00:00' }];
      // Venta de 400 con 300 de anticipo ya pagado: el cliente paga 100 en efectivo.
      if (/FROM sales s/.test(sql)) return [{ id: 1, cash_session_id: 7, sale_status: 'pagada', payment_method: 'efectivo', financial_version: 1, total: '400.00', cash_amount: '100.00', card_amount: '0', transfer_amount: '0', credit_amount: '0', tax: '0', discount: '0', legal_tip_amount: '0', document_type: 'ticket' }];
      if (/FROM cash_movements/.test(sql)) return [
        { id: 1, movement_type: 'Anticipo de reserva', amount: '300.00' }, { id: 2, movement_type: 'Anticipo de reserva', amount: '500.00' },
        { id: 3, movement_type: 'Devolución anticipo de reserva', amount: '-200.00' },
      ];
      if (/FROM mesas_reservas/.test(sql)) return [
        { id: 'a', cliente: 'A', anticipo_monto: '300.00', anticipo_metodo: 'efectivo', anticipo_estado: 'aplicado', anticipo_session_id: 7, anticipo_aplicado: '300.00', anticipo_aplicado_session_id: 7, anticipo_factura: 'F1' },
        { id: 'b', cliente: 'B', anticipo_monto: '150.00', anticipo_metodo: 'tarjeta', anticipo_estado: 'devuelto', anticipo_session_id: 7, anticipo_aplicado: '0', anticipo_resuelto_monto: '150.00', anticipo_resuelto_metodo: 'tarjeta', anticipo_resuelto_session_id: 7 },
        { id: 'c', cliente: 'C', anticipo_monto: '500.00', anticipo_metodo: 'efectivo', anticipo_estado: 'devuelto', anticipo_session_id: 7, anticipo_aplicado: '300.00', anticipo_aplicado_session_id: 7, anticipo_resuelto_monto: '200.00', anticipo_resuelto_metodo: 'efectivo', anticipo_resuelto_session_id: 7 },
        { id: 'd', cliente: 'D', anticipo_monto: '80.00', anticipo_metodo: 'transferencia', anticipo_estado: 'retenido', anticipo_session_id: 7, anticipo_aplicado: '0', anticipo_resuelto_monto: '80.00', anticipo_resuelto_session_id: 7 },
      ];
      return [];
    };
    const r = await arqueo.resumenTurno(run, 7);
    expect(r.efectivo.esperado).toBe(1000 + 100 + 300 + 500 - 200);
    expect(r.efectivo).toMatchObject({ anticipos: 800, anticiposDevueltos: 200, entradas: 0, devoluciones: 0 });
    expect(r.tarjeta.cobrado).toBe(0); // 150 recibidos y 150 devueltos por tarjeta
    expect(r.transferencia.cobrado).toBe(80);
    expect(r.ventas.total).toBe(400);
    expect(r.anticipos).toMatchObject({ aplicados: 600, retenidos: 80, recibidos: { efectivo: 800, tarjeta: 150, transferencia: 80, total: 1030 }, devueltos: { efectivo: 200, tarjeta: 150, total: 350 } });
    expect(r.cobrado.efectivo).toBe(100 + 800 - 200);
  });
  test('sin la tabla de reservas (negocio sin Mesas) el resumen sale igual', async () => {
    const run = async (sql) => {
      if (/FROM cash_sessions/.test(sql)) return [{ id: 7, opened_amount: '100.00', status: 'open' }];
      if (/FROM mesas_reservas/.test(sql)) throw new Error('no such table: mesas_reservas');
      return [];
    };
    const r = await arqueo.resumenTurno(run, 7);
    expect(r.efectivo.esperado).toBe(100);
    expect(r.anticipos).toMatchObject({ aplicados: 0, recibidos: { total: 0 }, detalle: [] });
  });
  test('compararConteo marca sobrante, faltante y cuadre', () => {
    expect(arqueo.compararConteo(100, 100).estado).toBe('cuadrada');
    expect(arqueo.compararConteo(105, 100)).toMatchObject({ diferencia: 5, estado: 'sobrante' });
    expect(arqueo.compararConteo(99.99, 100)).toMatchObject({ diferencia: -0.01, estado: 'faltante' });
  });
});

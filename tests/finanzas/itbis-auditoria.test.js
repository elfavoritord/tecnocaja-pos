'use strict';
// ITBIS separado por documento y auditoría (scrub y accesos denegados).
const itbis = require('../../server/services/itbis-separado');
const auditEvent = require('../../server/services/audit-event');
const { createAuditDeniedMiddleware } = require('../../server/routes/auditoria.routes');
const { EventEmitter } = require('events');

function runFalso({ ventas = [], devoluciones = [], anuladas = [], lineas = [], ecf = [] }) {
  return async (sql) => {
    if (/FROM sale_returns r JOIN/.test(sql)) return devoluciones;
    if (/fiscal_status = 'cancelada' AND s.canceled_at/.test(sql)) return anuladas;
    if (/FROM sales s/.test(sql)) return ventas;
    if (/FROM sale_items/.test(sql)) return lineas;
    if (/FROM ecf_documents/.test(sql)) return ecf;
    return [];
  };
}
const v = (id, extra) => ({ id, invoice_number: `FAC-${id}`, subtotal: '100.00', discount: '0', tax: '18.00', total: '118.00', legal_tip_amount: '0', sale_status: 'pagada', created_at: '2026-11-08 10:00:00', ...extra });
const l = (sale_id, extra = {}) => ({ sale_id, qty: 1, price: '100.00', discount_rate: 0, tax_rate: 18, tax_amount: '18.00', ...extra });

describe('itbis-separado', () => {
  test('tickets, e-CF aceptado/pendiente/rechazado y consolidado sin duplicar', async () => {
    const r = await itbis.generar(runFalso({
      ventas: [v(1, { document_type: 'ticket' }), v(2, { document_type: 'factura-electronica' }), v(3, { document_type: 'factura-electronica' }), v(4, { document_type: 'factura-electronica' }),
        v(5, { document_type: 'comprobante-fiscal', ncf: 'B0200000001' })],
      lineas: [l(1), l(2), l(3), l(4), l(5)],
      ecf: [{ sale_id: 2, estado_dgii: 'aceptado' }, { sale_id: 3, estado_dgii: 'en_proceso' }, { sale_id: 4, estado_dgii: 'rechazado' }],
    }), { desdeDatetime: 'a', hastaDatetime: 'b', obligadoEcf: true });
    expect(r.tickets.operaciones).toBe(2); expect(r.tickets.ticketsInternos.operaciones).toBe(1); expect(r.tickets.comprobantesSerieB.operaciones).toBe(1);
    expect(r.ecf.operaciones).toBe(2); expect(r.ecf.pendientes.operaciones).toBe(1); expect(r.ecf.rechazados.operaciones).toBe(1);
    expect(r.consolidado.operaciones).toBe(4); expect(r.consolidado.itbis).toBe(72);
    expect(r.consolidado.rechazadosExcluidos.itbis).toBe(18);
    expect(r.regularizacion.ticketsSinEcf).toBe(1); expect(r.regularizacion.aviso).toMatch(/no sustituye/);
  });
  test('base gravada y exenta; la propina no entra en el ITBIS ni en la base', async () => {
    const r = await itbis.generar(runFalso({
      ventas: [v(1, { document_type: 'ticket', subtotal: '150.00', tax: '18.00', legal_tip_amount: '15.00', total: '183.00' })],
      lineas: [l(1), l(1, { price: '50.00', tax_rate: 0, tax_amount: 0 })],
    }), { desdeDatetime: 'a', hastaDatetime: 'b' });
    expect(r.tickets).toMatchObject({ gravada: 100, exenta: 50, itbis: 18, propinaLegal: 15, redondeo: 0 });
  });
  test('notas de crédito y anulaciones restan como ajustes; pasados 30 días no rebajan ITBIS', async () => {
    const r = await itbis.generar(runFalso({
      ventas: [v(1, { document_type: 'ticket' })], lineas: [l(1), l(2), l(3)],
      devoluciones: [
        { ...v(2, { document_type: 'ticket' }), return_id: 1, returned_at: 'x', returned_amount: '59.00', tax_returned: '9.00', legal_tip_returned: 0, adjustment_kind: 'nota_credito_interna', tax_affects: 1 },
        { ...v(3, { document_type: 'comprobante-fiscal' }), return_id: 2, returned_at: 'x', returned_amount: '118.00', tax_returned: '18.00', legal_tip_returned: 0, adjustment_kind: 'nota_credito_b04', tax_affects: 0 },
      ],
      anuladas: [v(4, { document_type: 'ticket', fiscal_status: 'cancelada', canceled_at: 'x' })],
    }), { desdeDatetime: 'a', hastaDatetime: 'b' });
    expect(r.tickets.ticketsInternos.ajustes.itbis).toBe(9 + 18);
    expect(r.tickets.comprobantesSerieB.ajustes.itbis).toBe(0);
    expect(r.tickets.comprobantesSerieB.ajustes.total).toBe(118);
    expect(r.ajustesDetalle.map((a) => a.tipo).sort()).toEqual(['anulacion', 'nota_credito_b04', 'nota_credito_interna']);
  });
});

describe('auditoría', () => {
  test('scrub quita contraseñas, tokens, PIN y certificados', () => {
    const limpio = auditEvent.scrub({ usuario: 'ana', password: 'x', token: 'y', pin: '1234', certificadoPassword: 'z', nested: { authorization: 'Bearer abc', nota: 'Bearer abcdef' } });
    expect(limpio).toEqual({ usuario: 'ana', nested: { nota: 'Bearer [oculto]' } });
  });
  test('registra el login fallido sin la contraseña y el acceso denegado', () => {
    const eventos = [];
    const mw = createAuditDeniedMiddleware({ writeAuditLog: async (e) => { eventos.push(e); } });
    const correr = (req, status) => { const res = new EventEmitter(); res.statusCode = status; mw(req, res, () => {}); res.emit('finish'); };
    correr({ method: 'POST', originalUrl: '/api/login', body: { usuario: 'cajero1', password: 'secreta' } }, 401);
    correr({ method: 'PATCH', originalUrl: '/api/sales/FAC-1/cancel', body: {}, authUser: { id: 3, nombre: 'Cajero' } }, 403);
    correr({ method: 'GET', originalUrl: '/api/connectivity', body: {} }, 401);
    correr({ method: 'POST', originalUrl: '/api/sales', body: {} }, 201);
    expect(eventos).toHaveLength(2);
    expect(eventos[0]).toMatchObject({ actionName: 'Inicio de sesión fallido', userName: 'cajero1', result: 'denegado' });
    expect(JSON.stringify(eventos)).not.toMatch(/secreta/);
    expect(eventos[1]).toMatchObject({ actionName: 'Acceso denegado', userId: 3, moduleName: 'sales' });
  });
  test('cada evento tiene un identificador único', async () => {
    const ids = [];
    for (let i = 0; i < 50; i += 1) ids.push(await auditEvent.append(async () => {}, { actionName: 'x' }));
    expect(new Set(ids).size).toBe(50);
  });
});

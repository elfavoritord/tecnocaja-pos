'use strict';

const express = require('express');
const request = require('supertest');
jest.mock('../../server/services/finance-migration', () => ({ ensureCajaSegura: async () => {} }));
const { createCajaSeguraRouter } = require('../../server/routes/caja-segura.routes');

function servidor({ cerrar = false, corte = false, manual = false, abierta = true } = {}) {
  let evento;
  const query = jest.fn(async (sql, params) => {
    if (sql.includes('FROM cash_sessions')) return abierta ? [{ id: 4 }] : [];
    if (sql.includes('FROM cash_drawer_events WHERE event_uuid')) return evento ? [evento] : [];
    if (sql.includes('INSERT INTO cash_drawer_events')) {
      const columns = sql.match(/\(([^)]+)\)/)[1].split(',').map((s) => s.trim());
      evento = { id: 1, ...Object.fromEntries(columns.map((c, i) => [c, params[i]])) };
      return { insertId: 1 };
    }
    if (sql.includes('FROM cash_drawer_events WHERE id')) return [evento];
    return [];
  });
  const writeAuditLog = jest.fn(async () => {});
  const { router } = createCajaSeguraRouter({ query, withTransaction: (work) => work({ query }),
    resolveRequestActorUser: async () => ({ id: 7 }), getActor: () => ({ userId: 7, userName: 'Cajero' }),
    resolveScopedBusinessStructureSelection: async () => ({ branchId: 1, cashRegisterId: 2 }),
    userCanCloseCash: () => cerrar, userCanMakeCorte: () => corte, userCanOpenDrawer: () => manual,
    isMysqlDeployment: () => false, nowSql: () => '2026-11-12 12:00:00', writeAuditLog,
  });
  const app = express(); app.use(express.json()); app.use('/api/caja', router);
  return { app, query, writeAuditLog };
}

describe('gaveta para corte/cierre: autorización y registro sin mover dinero', () => {
  test.each([['cierre', { cerrar: true }], ['arqueo', { corte: true }]])('%s usa su propio permiso sin exigir apertura manual', async (motivo, permisos) => {
    const s = servidor(permisos);
    const payload = { motivo, eventUuid: 'evento-conteo-1234' };
    const r = await request(s.app).post('/api/caja/gaveta').send(payload);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ motivo, abrirGaveta: true, sesionCajaId: 4, monto: 0, entrada: 0, salida: 0 });
    expect(s.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(s.query.mock.calls.some(([sql]) => /INSERT INTO cash_movements|UPDATE cash_sessions|UPDATE config/.test(sql))).toBe(false);
    const repetido = await request(s.app).post('/api/caja/gaveta').send(payload);
    expect(repetido.status).toBe(200);
    expect(repetido.body.repetido).toBe(true);
    expect(s.writeAuditLog).toHaveBeenCalledTimes(1);
  });

  test.each([['cierre', { corte: true, manual: true }], ['arqueo', { cerrar: true, manual: true }], ['otro', { cerrar: true, corte: true }]])('%s no acepta un permiso distinto', async (motivo, permisos) => {
    const s = servidor(permisos);
    expect((await request(s.app).post('/api/caja/gaveta').send({ motivo, descripcion: 'Prueba' })).status).toBe(403);
    expect(s.writeAuditLog).not.toHaveBeenCalled();
  });

  test.each(['cierre', 'arqueo'])('%s exige un turno abierto', async (motivo) => {
    const s = servidor({ cerrar: true, corte: true, abierta: false });
    const r = await request(s.app).post('/api/caja/gaveta').send({ motivo });
    expect(r.status).toBe(409);
    expect(s.writeAuditLog).not.toHaveBeenCalled();
  });
});

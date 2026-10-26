'use strict';

/**
 * Al cambiar una secuencia en el POS (NCF B o e-NCF) se refresca enseguida el
 * espejo que ve el Portal del Contador (onSequencesChanged → sync-pos-stats),
 * para que el contador no le registre al negocio un rango que ya tiene.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../db', () => ({ getDbClient: () => 'sqlite' }));

const { createFiscalSequencesRouter } = require('../../server/routes/fiscal-sequences.routes');

function appCon(onSequencesChanged, { insertFalla = false } = {}) {
  const query = jest.fn(async (sql) => {
    const text = String(sql);
    if (/INSERT INTO ncf_authorized_sequences/.test(text)) {
      if (insertFalla) throw new Error('fallo');
      return { insertId: 5 };
    }
    if (/FROM ncf_authorized_sequences fs/.test(text)) return [{ id: 5, document_type: 'B02', start_number: 1, end_number: 100, next_number: 1, status: 'pendiente' }];
    return [];
  });
  const app = express();
  app.use(express.json());
  app.use('/api/fiscal-sequences', createFiscalSequencesRouter({
    query,
    withTransaction: async (work) => work({ query }),
    resolveRequestActorUser: async () => ({ id: 1, usuario: 'admin', role_code: 'administrador_general' }),
    userRoleHasPermission: () => true,
    writeAuditLog: async () => {},
    verifyUserPassword: async () => true,
    getUserScopeBranchId: () => null,
    isGlobalAdministratorUser: () => true,
    isBranchAdministratorUser: () => false,
    attachmentsDir: '',
    isMysqlDeployment: () => false,
    onSequencesChanged,
  }));
  return app;
}

const B02 = { documentType: 'B02', startNumber: 1, endNumber: 100, authorizationReference: 'DGII-1', expirationDate: '2099-12-31' };

test('registrar una secuencia B avisa al portal; consultar no', async () => {
  const avisar = jest.fn();
  const app = appCon(avisar);

  await request(app).get('/api/fiscal-sequences').expect(200);
  expect(avisar).not.toHaveBeenCalled();

  const res = await request(app).post('/api/fiscal-sequences').send(B02);
  expect(res.status).toBeLessThan(400);
  expect(avisar).toHaveBeenCalledTimes(1);
});

test('si el cambio falla no se avisa', async () => {
  const avisar = jest.fn();
  const res = await request(appCon(avisar, { insertFalla: true })).post('/api/fiscal-sequences').send(B02);
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(avisar).not.toHaveBeenCalled();
});

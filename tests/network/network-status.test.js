'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const createNetworkRouter = require('../../server/routes/network.routes');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('network status', () => {
  let envSnapshot;

  beforeEach(() => {
    envSnapshot = { ...process.env };
  });

  afterEach(() => {
    process.env = envSnapshot;
  });

  it('lee terminal-config.json desde AppData y detecta una terminal secundaria', async () => {
    const userDataPath = makeTempDir('tecnocaja-user-');
    const terminalConfigPath = path.join(userDataPath, 'config', 'terminal-config.json');
    fs.mkdirSync(path.dirname(terminalConfigPath), { recursive: true });
    fs.writeFileSync(terminalConfigPath, JSON.stringify({
      terminalId: 'term-sucursal-2',
      terminalName: 'Caja Yamasa',
      branchId: 2,
      branchName: 'Sucursal Yamasa',
      cashRegisterId: 5,
      cashRegisterName: 'Caja 1',
      setupMode: 'multisucursal',
      isMain: false
    }), 'utf8');

    process.env.TECNO_CAJA_USER_DATA = userDataPath;
    process.env.PORT = '3399';

    const query = jest.fn(async (sql) => {
      if (/SELECT business_id FROM config/i.test(sql)) return [{ business_id: 77 }];
      if (/SELECT tr\.\*/i.test(sql)) return [];
      if (/SELECT id, nombre, codigo, estado FROM branches/i.test(sql)) {
        return [{ id: 2, nombre: 'Sucursal Yamasa', codigo: 'YAM', estado: 'Activa' }];
      }
      if (/SELECT id, branch_id, nombre, codigo, estado FROM cash_registers/i.test(sql)) {
        return [{ id: 5, branch_id: 2, nombre: 'Caja 1', codigo: 'C1', estado: 'Activa' }];
      }
      return [];
    });

    const app = express();
    app.use('/api/network', createNetworkRouter({
      query,
      resolveRequestActorUser: async () => ({ role_code: 'administrador_general' })
    }));

    const res = await request(app).get('/api/network/status').expect(200);

    expect(res.body.isMain).toBe(false);
    expect(res.body.terminalConfig).toMatchObject({
      terminalId: 'term-sucursal-2',
      branchId: 2,
      cashRegisterId: 5,
      isMain: false
    });
  });
});

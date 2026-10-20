'use strict';

/**
 * "Restaurar desde la nube" en una PC recién instalada o formateada, con la
 * cuenta del dueño (server/routes/respaldos.routes.js): ve los respaldos de
 * sus negocios, restaura uno, la PC queda con esa licencia y, si estaba
 * enlazada como sucursal de otro negocio, se desvincula.
 */

const express = require('express');
const request = require('supertest');

const mockNube = new Map();
jest.mock('../../server/services/r2-storage', () => ({
  backupPrefix: (id) => `backups/${id}/`,
  backupKey: (id, nombre) => `backups/${id}/${nombre}`,
  isR2Available: jest.fn(async () => true),
  listObjects: jest.fn(async (prefix) => {
    if (prefix.startsWith('backups/pos_sin_acceso/')) throw new Error('AccessDenied');
    return [...mockNube.entries()].filter(([k]) => k.startsWith(prefix)).map(([Key, v]) => ({ Key, LastModified: v.fecha, Size: v.buf.length }));
  }),
  download: jest.fn(async (key) => mockNube.get(key).buf),
  upload: jest.fn(async () => {}),
  remove: jest.fn(async () => {}),
}));

const { crearBaseSqlite } = require('../multisucursal/sqlite-helper');
const { buildFullPayload, createTcbakBuffer } = require('../../server/services/backup-core');
const createRespaldosRouter = require('../../server/routes/respaldos.routes');

const CLAVE_CIFRADO = 'clave-de-prueba-respaldos';
const DUENO = 'dueno@bravo.test';

describe('Restaurar desde la nube con la cuenta del dueño', () => {
  let envAntes;
  let pc;
  let app;
  let guardado;

  async function respaldoDe(nombreNegocio, { branchUuid = null } = {}) {
    const origen = await crearBaseSqlite();
    await origen.query('UPDATE config SET setup_completed = 1, business_name = ? WHERE id = 1', [nombreNegocio]);
    await origen.query("INSERT INTO users (usuario, password, nombre, rol, email) VALUES ('admin', '', 'Admin', 'Administrador', ?)", [DUENO]);
    await origen.query("INSERT INTO products (codigo, nombre, categoria, precio_venta) VALUES ('P1', 'Arroz', 'X', 10)");
    if (branchUuid) {
      await origen.query('ALTER TABLE branches ADD COLUMN uuid VARCHAR(36)').catch(() => {});
      await origen.query('UPDATE branches SET uuid = ?', [branchUuid]);
    }
    const buf = await createTcbakBuffer(await buildFullPayload(origen.query), CLAVE_CIFRADO);
    origen.close();
    return buf;
  }

  beforeEach(async () => {
    envAntes = { ...process.env };
    process.env.TECNO_CAJA_SECURITY_PASSWORD = CLAVE_CIFRADO;
    delete process.env.TECNO_CAJA_LICENSE_UID;
    delete process.env.TECNO_CAJA_SYNC_TOKEN;
    mockNube.clear();
    mockNube.set('backups/pos_bravo/TecnoCaja_Diario_Bravo_2026-10-19.tcbak', { buf: await respaldoDe('Bravo'), fecha: new Date('2026-10-19T20:00:00Z') });
    mockNube.set('backups/pos_ajeno/TecnoCaja_Diario_Ajeno_2026-10-19.tcbak', { buf: await respaldoDe('Ajeno'), fecha: new Date('2026-10-19T20:00:00Z') });

    pc = await crearBaseSqlite(); // PC recién instalada (sin configurar)
    await pc.query('CREATE TABLE installation_config (id INTEGER PRIMARY KEY AUTOINCREMENT, config_key VARCHAR(100) NOT NULL, config_value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    guardado = {};
    app = express().use(express.json());
    createRespaldosRouter({
      app,
      query: pc.query,
      getActor: () => ({}),
      writeAuditLog: async () => {},
      ensureAdministrator: () => {},
      isGlobalAdministratorUser: () => true,
      resolveRequestActorUser: async () => null,
      verificarCuentaDueno: async (idToken) => {
        if (idToken !== 'token-del-dueno') throw new Error('token inválido');
        return { uid: 'uid-dueno', email: DUENO };
      },
      licenciasDelCorreo: async (email) => (email === DUENO
        ? [{ licenseId: 'pos_bravo', nombre: 'Bravo' }, { licenseId: 'pos_sin_acceso', nombre: 'Sin acceso' }]
        : []),
      persistEnv: (v) => { Object.assign(guardado, v); Object.assign(process.env, v); },
    });
  });

  afterEach(() => {
    pc.close();
    process.env = envAntes;
  });

  test('sin licencia y sin contraseña: pide la cuenta del dueño', async () => {
    const r = await request(app).post('/api/respaldos/setup/cloud/auth').send({ email: DUENO }).expect(404);
    expect(r.body.code).toBe('NECESITA_CUENTA');
  });

  test('cuenta equivocada: no ve nada', async () => {
    const r = await request(app).post('/api/respaldos/setup/cloud/auth').send({ email: DUENO, idToken: 'falso' }).expect(401);
    expect(r.body.code).toBe('CUENTA_INVALIDA');
  });

  test('con la cuenta del dueño ve los respaldos de SUS negocios y restaura uno', async () => {
    const r = await request(app).post('/api/respaldos/setup/cloud/auth').send({ email: DUENO, idToken: 'token-del-dueno' }).expect(200);
    expect(r.body.backups.map((b) => [b.licenseId, b.negocio])).toEqual([['pos_bravo', 'Bravo']]);
    expect(r.body.cloudToken).toEqual(expect.any(String));

    // Un respaldo de otro negocio no se puede restaurar con este permiso.
    await request(app).post('/api/respaldos/setup/restaurar-nube')
      .send({ storageKey: 'backups/pos_ajeno/TecnoCaja_Diario_Ajeno_2026-10-19.tcbak', cloudToken: r.body.cloudToken }).expect(403);
    // Permiso falso o vencido.
    expect((await request(app).post('/api/respaldos/setup/restaurar-nube')
      .send({ storageKey: r.body.backups[0].storageKey, cloudToken: 'x.y.z' }).expect(401)).body.code).toBe('SESION_VENCIDA');

    // Con el permiso del dueño no se vuelve a pedir la clave del usuario.
    const rest = await request(app).post('/api/respaldos/setup/restaurar-nube')
      .send({ storageKey: r.body.backups[0].storageKey, cloudToken: r.body.cloudToken }).expect(200);
    expect(rest.body).toMatchObject({ ok: true, usersRestored: 1 });
    expect(guardado.TECNO_CAJA_LICENSE_UID).toBe('pos_bravo');
    const [cfg] = await pc.query('SELECT business_name, setup_completed FROM config WHERE id = 1');
    expect(cfg).toMatchObject({ business_name: 'Bravo' });
  });

  test('una PC enlazada como sucursal de otro negocio se desvincula al restaurar', async () => {
    process.env.TECNO_CAJA_SYNC_TOKEN = `eq_11111111-1111-4111-8111-111111111111.${'x'.repeat(43)}`;
    await pc.query("INSERT INTO installation_config (config_key, config_value) VALUES ('multisucursal_enlace', ?)", [
      JSON.stringify({ estado: 'vinculado', sucursal: { branchUuid: '22222222-2222-4222-8222-222222222222', nombre: 'Norte' } }),
    ]);
    const r = await request(app).post('/api/respaldos/setup/cloud/auth').send({ email: DUENO, idToken: 'token-del-dueno' }).expect(200);
    await request(app).post('/api/respaldos/setup/restaurar-nube')
      .send({ storageKey: r.body.backups[0].storageKey, cloudToken: r.body.cloudToken }).expect(200);
    expect(guardado.TECNO_CAJA_SYNC_TOKEN).toBe('');
    const [fila] = await pc.query("SELECT config_value FROM installation_config WHERE config_key = 'multisucursal_enlace'");
    expect(JSON.parse(fila.config_value)).toMatchObject({ estado: 'sin_vincular' });
  });
});

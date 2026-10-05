'use strict';

/**
 * tests/routes/respaldos.routes.test.js
 *
 * Fase 2 — C1: POST /api/respaldos/auto no tenía NINGÚN control de acceso
 * (cualquiera que alcanzara el puerto podía disparar respaldos a voluntad).
 * Ahora exige sesión real (req.authUser) o la llamada firmada internamente
 * por electron/main.js (req.isInternalSystemCall).
 */

const express = require('express');
const request = require('supertest');

function buildApp() {
  const { createRespaldosRouter } = { createRespaldosRouter: require('../../server/routes/respaldos.routes') };
  const app = express();
  app.use(express.json());

  const mockQuery = jest.fn().mockResolvedValue([]);
  const resolveRequestActorUser = jest.fn().mockResolvedValue({ id: 1, usuario: 'admin' });
  const ensureAdministrator = jest.fn();
  const isGlobalAdministratorUser = jest.fn().mockReturnValue(true);
  const getActor = jest.fn().mockReturnValue({ userId: 1, userName: 'admin', userRole: 'Administrador' });
  const writeAuditLog = jest.fn().mockResolvedValue(undefined);

  createRespaldosRouter({
    app,
    query: mockQuery,
    getActor,
    writeAuditLog,
    ensureAdministrator,
    isGlobalAdministratorUser,
    resolveRequestActorUser,
  });

  // El resultado real de un backup toca el filesystem — no es lo que se
  // prueba aquí (eso es cosa de backup-core.js). Se sustituye por un mock
  // para poder aislar exclusivamente el control de acceso del endpoint.
  app.locals.createAutomaticBackup = jest.fn().mockResolvedValue({ ok: true, fileName: 'test.tcbak' });

  return { app };
}

describe('POST /api/respaldos/auto — control de acceso (Fase 2, C1)', () => {
  let app;
  let timer;

  beforeEach(() => {
    jest.resetAllMocks();
    const built = buildApp();
    app = built.app;
    timer = app.locals.backupPendingUploadTimer;
  });

  afterEach(() => {
    if (timer) clearInterval(timer);
  });

  test('sin sesión y sin firma interna → 401, NO dispara el respaldo', async () => {
    const res = await request(app).post('/api/respaldos/auto').send({ trigger: 'manual' });
    expect(res.status).toBe(401);
    expect(app.locals.createAutomaticBackup).not.toHaveBeenCalled();
  });

  test('actorUserId en el body, sin token ni firma interna → sigue en 401 (el bypass viejo ya no aplica)', async () => {
    const res = await request(app)
      .post('/api/respaldos/auto')
      .send({ trigger: 'manual', actorUserId: 1, actorUserName: 'Cualquiera', actorUserRole: 'administrador_general' });
    expect(res.status).toBe(401);
    expect(app.locals.createAutomaticBackup).not.toHaveBeenCalled();
  });

  test('con req.isInternalSystemCall (llamada firmada de electron/main.js) → 200 y dispara el respaldo', async () => {
    // Se inyecta el middleware ANTES de crear las rutas para respetar el
    // orden real de Express (mismo orden que en server.js: el middleware de
    // auth global corre antes de montar los routers).
    const appWithInternal = express();
    appWithInternal.use(express.json());
    appWithInternal.use((req, _res, next) => { req.isInternalSystemCall = true; next(); });

    const mockQuery = jest.fn().mockResolvedValue([]);
    require('../../server/routes/respaldos.routes')({
      app: appWithInternal,
      query: mockQuery,
      getActor: jest.fn().mockReturnValue({ userId: null, userName: 'Sistema', userRole: 'Sistema' }),
      writeAuditLog: jest.fn().mockResolvedValue(undefined),
      ensureAdministrator: jest.fn(),
      isGlobalAdministratorUser: jest.fn().mockReturnValue(true),
      resolveRequestActorUser: jest.fn().mockResolvedValue(null),
    });
    appWithInternal.locals.createAutomaticBackup = jest.fn().mockResolvedValue({ ok: true, fileName: 'auto.tcbak' });

    const res = await request(appWithInternal).post('/api/respaldos/auto').send({ trigger: 'cierre_app' });
    expect(res.status).toBe(200);
    expect(appWithInternal.locals.createAutomaticBackup).toHaveBeenCalledWith({ trigger: 'cierre_app', forceCloud: false });

    clearInterval(appWithInternal.locals.backupPendingUploadTimer);
  });

  test('con req.authUser real (sesión) → 200 y dispara el respaldo', async () => {
    const appWithUser = express();
    appWithUser.use(express.json());
    appWithUser.use((req, _res, next) => { req.authUser = { id: 7, usuario: 'cajero1' }; next(); });

    require('../../server/routes/respaldos.routes')({
      app: appWithUser,
      query: jest.fn().mockResolvedValue([]),
      getActor: jest.fn().mockReturnValue({ userId: 7, userName: 'cajero1', userRole: 'Cajero' }),
      writeAuditLog: jest.fn().mockResolvedValue(undefined),
      ensureAdministrator: jest.fn(),
      isGlobalAdministratorUser: jest.fn().mockReturnValue(false),
      resolveRequestActorUser: jest.fn().mockResolvedValue({ id: 7 }),
    });
    appWithUser.locals.createAutomaticBackup = jest.fn().mockResolvedValue({ ok: true, fileName: 'auto2.tcbak' });

    const res = await request(appWithUser).post('/api/respaldos/auto').send({ trigger: 'manual' });
    expect(res.status).toBe(200);
    expect(appWithUser.locals.createAutomaticBackup).toHaveBeenCalled();

    clearInterval(appWithUser.locals.backupPendingUploadTimer);
  });
});

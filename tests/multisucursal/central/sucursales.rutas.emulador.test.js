'use strict';

/**
 * Rutas HTTP de sucursales (las mismas que montan tecno-caja-admin y
 * tecno-caja-contadores) contra el emulador de Firestore. El inicio de sesión
 * de cada panel se reemplaza por una cabecera de prueba; lo que se prueba es
 * que cada panel solo pueda lo que le toca.
 */

const enEmulador = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const describir = enEmulador ? describe : describe.skip;
jest.setTimeout(60000);

const PROYECTO = 'demo-tecnocaja';
const express = require('express');
const request = require('supertest');
const { createSucursalesCentral } = require('../../../server/multisucursal/central/sucursales');
const { createSucursalesRouter } = require('../../../server/multisucursal/central/sucursales.routes');

const LIC = 'pos:tecno-caja-farmacia';
const RUTA = `/api/sucursales/${encodeURIComponent(LIC)}`;

describir('Rutas de sucursales: panel de Emilio y portal del contador', () => {
  let db;
  let auditoria;
  let panelAdmin;
  let portalContador;

  beforeAll(() => {
    const admin = require('firebase-admin');
    db = admin.initializeApp({ projectId: PROYECTO }, `rutas-${Date.now()}`).firestore();
    const requireAuth = (req, res, next) => (req.get('x-prueba-uid') ? next() : res.status(401).json({ error: 'No autorizado.' }));
    const getCentral = () => createSucursalesCentral({ db });

    panelAdmin = express().use(express.json()).use('/api/sucursales', createSucursalesRouter({
      requireAuth,
      getCentral,
      actorDe: (req) => ({ tipo: 'super_admin', uid: req.get('x-prueba-uid'), nombre: 'Emilio' }),
      alCambiar: async (_req, accion, licenseId, detalle) => { auditoria.push([accion, licenseId, detalle]); },
    }));
    portalContador = express().use(express.json()).use('/api/sucursales', createSucursalesRouter({
      requireAuth,
      getCentral,
      actorDe: (req) => ({ tipo: 'contador', uid: req.get('x-prueba-uid'), nombre: 'Firma', contadorId: req.get('x-prueba-firma') }),
    }));
  });

  beforeEach(async () => {
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
    await fetch(`http://${host}:${port}/emulator/v1/projects/${PROYECTO}/databases/(default)/documents`, { method: 'DELETE' });
    auditoria = [];
    await db.collection('licencias').doc(LIC).set({ businessName: 'Farmacia', status: 'active', contadorId: 'firma-1' });
  });

  const comoEmilio = (r) => r.set('x-prueba-uid', 'emilio');
  const comoContador = (r, firma = 'firma-1') => r.set('x-prueba-uid', 'conta').set('x-prueba-firma', firma);

  test('sin sesión no se entra', async () => {
    await request(panelAdmin).get(RUTA).expect(401);
  });

  test('flujo completo: Emilio fija 2, el contador crea 2, la tercera se rechaza', async () => {
    await comoEmilio(request(panelAdmin).put(`${RUTA}/limite`).send({ maximo: 2 })).expect(200);
    expect(auditoria).toEqual([['sucursales.limite', LIC, 'Límite: 2']]);

    const a = await comoContador(request(portalContador).post(RUTA).send({ nombre: 'Principal' })).expect(200);
    expect(a.body.sucursal).toMatchObject({ nombre: 'Principal', esPrincipal: true });
    await comoContador(request(portalContador).post(RUTA).send({ nombre: 'Los Alcarrizos' })).expect(200);
    const tercera = await comoContador(request(portalContador).post(RUTA).send({ nombre: 'Villa Mella' })).expect(409);
    expect(tercera.body).toMatchObject({ ok: false, code: 'LIMITE_SUCURSALES' });

    const resumen = await comoContador(request(portalContador).get(RUTA)).expect(200);
    expect(resumen.body).toMatchObject({ ok: true, maxSucursales: 2, activas: 2, disponibles: 0 });
    expect(resumen.body.sucursales.map((s) => s.nombre)).toEqual(['Principal', 'Los Alcarrizos']);
  });

  test('el contador no puede tocar el límite ni activar/desactivar, aunque llame la ruta', async () => {
    const lim = await comoContador(request(portalContador).put(`${RUTA}/limite`).send({ maximo: 50 })).expect(403);
    expect(lim.body.code).toBe('SIN_PERMISO');
    const { body } = await comoContador(request(portalContador).post(RUTA).send({ nombre: 'Principal' })).expect(200);
    await comoContador(request(portalContador).post(`${RUTA}/${body.sucursal.branchUuid}/estado`).send({ estado: 'inactiva' })).expect(403);
    await comoEmilio(request(panelAdmin).post(`${RUTA}/${body.sucursal.branchUuid}/estado`).send({ estado: 'inactiva' })).expect(200);
  });

  test('otra firma contable no ve ni crea en esta empresa', async () => {
    await comoContador(request(portalContador).get(RUTA), 'firma-2').expect(403);
    await comoContador(request(portalContador).post(RUTA).send({ nombre: 'X' }), 'firma-2').expect(403);
  });

  test('editar y generar el código de equipo desde el portal', async () => {
    const { body } = await comoContador(request(portalContador).post(RUTA).send({ nombre: 'Principal' })).expect(200);
    const uuid = body.sucursal.branchUuid;
    const ed = await comoContador(request(portalContador).put(`${RUTA}/${uuid}`).send({ telefono: '809-000-1111' })).expect(200);
    expect(ed.body.version).toBe(2);
    const cod = await comoContador(request(portalContador).post(`${RUTA}/${uuid}/codigo`)).expect(200);
    expect(cod.body.codigo).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await comoContador(request(portalContador).put(`${RUTA}/no-existe`).send({ nombre: 'X' })).expect(404);
  });
});

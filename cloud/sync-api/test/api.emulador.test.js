'use strict';

/**
 * Sync API contra el emulador de Firestore (sin Firebase real). Desde la raíz:
 *   npm run test:multisucursal-central
 */

const enEmulador = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const describir = enEmulador ? describe : describe.skip;
jest.setTimeout(60000);

const PROYECTO = 'demo-tecnocaja';
const request = require('supertest');
const { createApp } = require('../lib/app');
const { createSucursalesCentral } = require('../vendor/multisucursal/sucursales');
const { hashToken, TOKEN_PATTERN } = require('../lib/equipos');

const LIC = 'pos:tecno-caja-supermercado';
const EMILIO = { tipo: 'super_admin', uid: 'emilio', nombre: 'Emilio' };
const CONTADORA = { tipo: 'contador', uid: 'conta', nombre: 'Firma', contadorId: 'firma-1' };
const PC = { deviceId: 'npd_abc', hostname: 'CAJA-NORTE', serverId: 'srv_0123456789abcdef', appVersion: '1.5.0' };

describir('Sync API: activar equipos, identidad y latido', () => {
  let db;
  let reloj;
  let app;
  let central;

  beforeAll(() => {
    const admin = require('firebase-admin');
    db = admin.initializeApp({ projectId: PROYECTO }, `sync-api-${Date.now()}`).firestore();
  });

  beforeEach(async () => {
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
    await fetch(`http://${host}:${port}/emulator/v1/projects/${PROYECTO}/databases/(default)/documents`, { method: 'DELETE' });
    reloj = new Date('2026-10-19T15:00:00.000Z');
    app = createApp({ db, now: () => reloj, limites: { activarMax: 10 } });
    central = createSucursalesCentral({ db, now: () => reloj });
    await db.collection('licencias').doc(LIC).set({ businessName: 'Supermercado Bravo', status: 'active', contadorId: 'firma-1' });
    await central.fijarLimite(LIC, 3, EMILIO);
  });

  async function sucursalConCodigo(nombre = 'Norte') {
    const s = await central.crear(LIC, { nombre, codigo: nombre.slice(0, 3).toUpperCase() }, CONTADORA);
    const { codigo } = await central.generarCodigo(LIC, s.branchUuid, CONTADORA);
    return { ...s, codigo };
  }

  const activar = (codigo, equipo = PC) => request(app).post('/v1/equipos/activar').send({ codigo, equipo });
  const identidad = (token) => request(app).get('/v1/identidad').set('Authorization', `Bearer ${token}`);

  test('activar con el código: token de una sola vez e identidad de la sucursal', async () => {
    const s = await sucursalConCodigo();
    const r = await activar(s.codigo).expect(201);
    expect(r.body.token).toMatch(TOKEN_PATTERN);
    expect(r.body).toMatchObject({
      ok: true,
      empresa: { licenseId: LIC, companyUuid: s.companyUuid, nombre: 'Supermercado Bravo' },
      sucursal: { branchUuid: s.branchUuid, nombre: 'Norte', codigo: 'NOR', estado: 'activa' },
      reemplazados: 0,
    });
    expect(r.headers['cache-control']).toBe('no-store');

    const doc = (await db.collection('equipos_sync').doc(r.body.equipoId).get()).data();
    expect(doc).toMatchObject({ licenseId: LIC, branchUuid: s.branchUuid, estado: 'activo', hostname: 'CAJA-NORTE', tokenHash: hashToken(r.body.token) });
    expect(JSON.stringify(doc)).not.toContain(r.body.token.split('.')[1]);

    await activar(s.codigo).expect(409);
    const malo = await activar('ZZZZ-ZZZZ').expect(404);
    expect(malo.body.code).toBe('CODIGO_INVALIDO');
  });

  test('una PC con la licencia de otra empresa no se activa y el código no se gasta', async () => {
    const s = await sucursalConCodigo();
    const r = await activar(s.codigo, { ...PC, licenseId: 'pos:tecno-caja-otro-negocio' }).expect(409);
    expect(r.body.code).toBe('OTRA_EMPRESA');
    await activar(s.codigo, { ...PC, licenseId: LIC }).expect(201);
  });

  test('PC recién instalada (sin ventas) con otra licencia: se une y toma la de la empresa', async () => {
    const s = await sucursalConCodigo();
    const con = await activar(s.codigo, { ...PC, licenseId: 'pos_0123456789abcdef', ventas: 12 }).expect(409);
    expect(con.body.code).toBe('OTRA_EMPRESA');
    const r = await activar(s.codigo, { ...PC, licenseId: 'pos_0123456789abcdef', ventas: 0 }).expect(201);
    expect(r.body).toMatchObject({ cambiaLicencia: true, empresa: { licenseId: LIC } });
    const misma = await sucursalConCodigo('Sur');
    const r2 = await activar(misma.codigo, { ...PC, deviceId: 'npd_otra', licenseId: LIC, ventas: 300 }).expect(201);
    expect(r2.body.cambiaLicencia).toBe(false);
  });

  test('sin cupo de equipos en la licencia de la empresa, la PC nueva no se une', async () => {
    await db.collection('licencias').doc(LIC).set({ deviceLimit: 1, devices: { npd_principal: { deviceId: 'npd_principal' } } }, { merge: true });
    const s = await sucursalConCodigo();
    const r = await activar(s.codigo, { ...PC, licenseId: 'pos_0123456789abcdef', ventas: 0 }).expect(409);
    expect(r.body.code).toBe('LIMITE_EQUIPOS');
    await db.collection('licencias').doc(LIC).set({ deviceLimit: 2 }, { merge: true });
    await activar(s.codigo, { ...PC, licenseId: 'pos_0123456789abcdef', ventas: 0 }).expect(201);
  });

  test('identidad con token; sin token o con token falso, no', async () => {
    const s = await sucursalConCodigo();
    const { body } = await activar(s.codigo).expect(201);
    const r = await identidad(body.token).expect(200);
    expect(r.body).toMatchObject({
      empresa: { licenseId: LIC, companyUuid: s.companyUuid },
      sucursal: { branchUuid: s.branchUuid, nombre: 'Norte' },
      equipo: { equipoId: body.equipoId, estado: 'activo' },
      licencia: { status: 'active' },
    });
    expect((await request(app).get('/v1/identidad').expect(401)).body.code).toBe('SIN_TOKEN');
    const falso = body.token.replace(/\..*$/, `.${'A'.repeat(43)}`);
    expect((await identidad(falso).expect(401)).body.code).toBe('TOKEN_INVALIDO');
  });

  test('la identidad trae los datos vigentes (si el contador edita la sucursal)', async () => {
    const s = await sucursalConCodigo();
    const { body } = await activar(s.codigo).expect(201);
    await central.editar(LIC, s.branchUuid, { nombre: 'Norte Plaza', telefono: '809-555-2020' }, CONTADORA);
    const r = await identidad(body.token).expect(200);
    expect(r.body.sucursal).toMatchObject({ nombre: 'Norte Plaza', telefono: '809-555-2020', version: 2 });
  });

  test('una sucursal, una PC: activar otra deja fuera a la anterior', async () => {
    const s = await sucursalConCodigo();
    const vieja = (await activar(s.codigo).expect(201)).body;
    const { codigo } = await central.generarCodigo(LIC, s.branchUuid, CONTADORA);
    const nueva = (await activar(codigo, { ...PC, hostname: 'CAJA-NORTE-2' }).expect(201)).body;
    expect(nueva.reemplazados).toBe(1);
    expect((await identidad(vieja.token).expect(403)).body.code).toBe('EQUIPO_REEMPLAZADO');
    await identidad(nueva.token).expect(200);

    // Otra sucursal no se toca.
    const sur = await sucursalConCodigo('Sur');
    const pcSur = (await activar(sur.codigo).expect(201)).body;
    expect(pcSur.reemplazados).toBe(0);
    await identidad(nueva.token).expect(200);
  });

  test('revocar un equipo es solo de Emilio y lo saca de inmediato', async () => {
    const s = await sucursalConCodigo();
    const { body } = await activar(s.codigo).expect(201);
    await expect(central.revocarEquipo(LIC, body.equipoId, CONTADORA)).rejects.toMatchObject({ code: 'SIN_PERMISO' });
    await central.revocarEquipo(LIC, body.equipoId, EMILIO);
    expect((await identidad(body.token).expect(403)).body.code).toBe('EQUIPO_REVOCADO');
  });

  test('sucursal desactivada o licencia suspendida: el equipo no entra', async () => {
    const s = await sucursalConCodigo();
    const { body } = await activar(s.codigo).expect(201);
    await central.cambiarEstado(LIC, s.branchUuid, 'inactiva', EMILIO);
    expect((await identidad(body.token).expect(403)).body.code).toBe('SUCURSAL_INACTIVA');
    await central.cambiarEstado(LIC, s.branchUuid, 'activa', EMILIO);
    await identidad(body.token).expect(200);
    await db.collection('licencias').doc(LIC).update({ status: 'suspended' });
    expect((await identidad(body.token).expect(403)).body.code).toBe('LICENCIA_INACTIVA');
  });

  test('latido: los paneles ven el estado de cada PC (sin el hash del token)', async () => {
    const s = await sucursalConCodigo();
    const { body } = await activar(s.codigo).expect(201);
    reloj = new Date('2026-10-19T15:05:00.000Z');
    await request(app).post('/v1/latido').set('Authorization', `Bearer ${body.token}`)
      .send({ appVersion: '1.5.1', modo: 'local', pendientes: { salida: 7, errores: 1 }, ultimaSincronizacion: '2026-10-19T14:59:00.000Z' })
      .expect(200);
    const equipos = await central.listarEquipos(LIC, CONTADORA);
    expect(equipos).toHaveLength(1);
    expect(equipos[0]).toMatchObject({
      equipoId: body.equipoId, hostname: 'CAJA-NORTE', appVersion: '1.5.1', estado: 'activo',
      ultimaConexion: '2026-10-19T15:05:00.000Z',
      latido: { modo: 'local', pendientes: { salida: 7, errores: 1 }, ultimaSincronizacion: '2026-10-19T14:59:00.000Z' },
    });
    expect(equipos[0]).not.toHaveProperty('tokenHash');
  });

  test('no se puede probar códigos a lo loco: 10 intentos por IP y luego 429', async () => {
    for (let i = 0; i < 10; i += 1) await activar(`AAAA-AA${String(i).padStart(2, '2')}`).expect(404);
    const r = await activar('BBBB-BBBB').expect(429);
    expect(r.body.code).toBe('DEMASIADOS_INTENTOS');
  });

  test('salud y rutas desconocidas', async () => {
    await request(app).get('/health').expect(200, { ok: true, servicio: 'tecno-caja-sync-api' });
    await request(app).get('/v1/nada').expect(404);
  });
});

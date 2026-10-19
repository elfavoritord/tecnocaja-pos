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

  test('PC con su propia licencia: se une si está recién instalada o si ya era de esta empresa', async () => {
    const s = await sucursalConCodigo();
    const con = await activar(s.codigo, { ...PC, licenseId: 'pos_0123456789abcdef', ventas: 12 }).expect(409);
    expect(con.body.code).toBe('OTRA_EMPRESA');
    const r = await activar(s.codigo, { ...PC, licenseId: 'pos_0123456789abcdef', ventas: 0 }).expect(201);
    expect(r.body).toMatchObject({ empresa: { licenseId: LIC } });
    expect(r.body).not.toHaveProperty('cambiaLicencia');
    // Ya enlazada antes a esta empresa (mismo companyUuid) y con ventas: vale.
    const sur = await sucursalConCodigo('Sur');
    await activar(sur.codigo, { ...PC, deviceId: 'npd_otra', licenseId: 'pos_0123456789abcdef', ventas: 300, companyUuid: s.companyUuid }).expect(201);
    // Y la PC que tiene la licencia de la empresa (la principal), también.
    const { codigo } = await central.generarCodigo(LIC, s.branchUuid, CONTADORA);
    await activar(codigo, { ...PC, licenseId: LIC, ventas: 5000 }).expect(201);
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

  describe('con la cuenta del dueño (sin código)', () => {
    const DUENO = 'dueno@bravo.test';
    const tokenDe = (email, haceMin = 1) => `prueba:${email}:${reloj.getTime() - haceMin * 60000}`;
    const empresas = (token) => request(app).post('/v1/acceso/dueno').send({ idToken: token });
    const unir = (token, branchUuid, equipo = PC, licenseId = LIC) => request(app).post('/v1/equipos/activar-dueno').send({ idToken: token, licenseId, branchUuid, equipo });

    beforeEach(async () => {
      // Firebase Auth falso: "prueba:<correo>:<cuándo inició sesión>".
      app = createApp({
        db, now: () => reloj, limites: { activarMax: 10, duenoMax: 50 },
        verificarIdToken: async (t) => {
          const [tipo, email, ms] = String(t).split(':');
          if (tipo !== 'prueba') throw new Error('token inválido');
          return { uid: `uid-${email}`, email, auth_time: Math.floor(Number(ms) / 1000) };
        },
      });
      await db.collection('licencias').doc(LIC).set({ ownerEmail: DUENO, email: DUENO }, { merge: true });
    });

    test('lista las sucursales de su empresa con la PC que tiene cada una', async () => {
      const centro = await central.crear(LIC, { nombre: 'Centro', codigo: 'CEN' }, CONTADORA);
      const norte = await sucursalConCodigo('Norte');
      await activar(norte.codigo).expect(201);
      // Otra empresa con el mismo dueño pero sin sucursales: no aparece.
      await db.collection('licencias').doc('pos_sin_sucursales').set({ businessName: 'Otro', ownerEmail: DUENO, status: 'active' });

      const r = await empresas(tokenDe(DUENO)).expect(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body.empresas).toHaveLength(1);
      expect(r.body.empresas[0]).toMatchObject({ licenseId: LIC, nombre: 'Supermercado Bravo', activa: true });
      expect(r.body.empresas[0].sucursales).toEqual([
        expect.objectContaining({ branchUuid: centro.branchUuid, nombre: 'Centro', esPrincipal: true, pc: null }),
        expect.objectContaining({ branchUuid: norte.branchUuid, nombre: 'Norte', esPrincipal: false, pc: { hostname: 'CAJA-NORTE', ultimaConexion: reloj.toISOString() } }),
      ]);
      expect(JSON.stringify(r.body)).not.toContain('tokenHash');
    });

    test('el correo del dueño también vale en `correo` (como lo escribe el POS)', async () => {
      await db.collection('licencias').doc(LIC).set({ businessName: 'Supermercado Bravo', status: 'active', contadorId: 'firma-1', correo: DUENO });
      const norte = await central.crear(LIC, { nombre: 'Norte' }, CONTADORA);
      // La licencia propia de una PC de sucursal no aparece como empresa.
      await db.collection('licencias').doc('pos_pc_norte').set({ correo: DUENO, companyUuid: norte.companyUuid, sucursalDe: { licenseId: LIC } });
      const r = await empresas(tokenDe(DUENO)).expect(200);
      expect(r.body.empresas.map((e) => e.licenseId)).toEqual([LIC]);
      await unir(tokenDe(DUENO), norte.branchUuid).expect(201);
    });

    test('otra cuenta, un token falso o una sesión vieja no ven nada', async () => {
      await central.crear(LIC, { nombre: 'Centro' }, CONTADORA);
      expect((await empresas(tokenDe('otro@correo.test')).expect(404)).body.code).toBe('SIN_EMPRESA');
      expect((await empresas('falso').expect(401)).body.code).toBe('CUENTA_INVALIDA');
      expect((await empresas(tokenDe(DUENO, 45)).expect(401)).body.code).toBe('SESION_VIEJA');
      expect((await empresas('').expect(400)).body.code).toBe('SIN_CUENTA');
    });

    test('une la PC a la sucursal elegida: token, identidad y la PC anterior queda fuera', async () => {
      await central.crear(LIC, { nombre: 'Centro' }, CONTADORA);
      const norte = await sucursalConCodigo('Norte');
      const vieja = (await activar(norte.codigo).expect(201)).body;
      await db.collection('licencias').doc(LIC).set({ perfilNegocio: { tipoNegocio: 'ferreteria', moneda: 'RD$', itbis: 18, rnc: '131000001' } }, { merge: true });

      const r = await unir(tokenDe(DUENO), norte.branchUuid, { ...PC, hostname: 'CAJA-NORTE-NUEVA', licenseId: 'pos_nueva', ventas: 0 }).expect(201);
      expect(r.body.token).toMatch(TOKEN_PATTERN);
      expect(r.body).toMatchObject({
        empresa: { licenseId: LIC, companyUuid: norte.companyUuid }, sucursal: { branchUuid: norte.branchUuid, nombre: 'Norte' },
        reemplazados: 1, perfil: { tipoNegocio: 'ferreteria', moneda: 'RD$', itbis: 18, rnc: '131000001' },
      });
      expect((await identidad(vieja.token).expect(403)).body.code).toBe('EQUIPO_REEMPLAZADO');
      expect((await identidad(r.body.token).expect(200)).body.sucursal.nombre).toBe('Norte');
      const doc = (await db.collection('equipos_sync').doc(r.body.equipoId).get()).data();
      expect(doc).toMatchObject({ estado: 'activo', hostname: 'CAJA-NORTE-NUEVA', activadoPor: { tipo: 'dueno', nombre: DUENO } });
      const hist = (await db.collection('licencias').doc(LIC).collection('sucursales_historial').where('accion', '==', 'equipo_activado').get()).docs.map((d) => d.data());
      expect(hist.some((h) => h.detalle.autorizadoPor?.nombre === DUENO)).toBe(true);
    });

    test('no une: otra cuenta, otra empresa con ventas, sucursal desactivada o licencia suspendida', async () => {
      const norte = await central.crear(LIC, { nombre: 'Norte' }, CONTADORA);
      expect((await unir(tokenDe('otro@correo.test'), norte.branchUuid).expect(403)).body.code).toBe('SIN_PERMISO');
      expect((await unir(tokenDe(DUENO), norte.branchUuid, { ...PC, licenseId: 'pos_otra', ventas: 40 }).expect(409)).body.code).toBe('OTRA_EMPRESA');
      expect((await unir(tokenDe(DUENO), 'no-existe').expect(409)).body.code).toBe('SUCURSAL_INACTIVA');
      await central.cambiarEstado(LIC, norte.branchUuid, 'inactiva', EMILIO);
      expect((await unir(tokenDe(DUENO), norte.branchUuid).expect(409)).body.code).toBe('SUCURSAL_INACTIVA');
      await central.cambiarEstado(LIC, norte.branchUuid, 'activa', EMILIO);
      await db.collection('licencias').doc(LIC).update({ status: 'suspended' });
      expect((await unir(tokenDe(DUENO), norte.branchUuid).expect(403)).body.code).toBe('LICENCIA_INACTIVA');
      expect((await db.collection('equipos_sync').get()).size).toBe(0);
    });

    test('el latido de la principal publica el perfil del negocio; el de una sucursal no', async () => {
      const centro = await central.crear(LIC, { nombre: 'Centro' }, CONTADORA);
      const norte = await central.crear(LIC, { nombre: 'Norte' }, CONTADORA);
      const pcCentro = (await unir(tokenDe(DUENO), centro.branchUuid, { ...PC, deviceId: 'npd_c', licenseId: LIC }).expect(201)).body;
      const pcNorte = (await unir(tokenDe(DUENO), norte.branchUuid, { ...PC, deviceId: 'npd_n', ventas: 0 }).expect(201)).body;
      const latido = (token, perfil) => request(app).post('/v1/latido').set('Authorization', `Bearer ${token}`).send({ appVersion: '1.5.1', perfil }).expect(200);
      await latido(pcNorte.token, { tipoNegocio: 'pizzeria' });
      expect((await db.collection('licencias').doc(LIC).get()).data().perfilNegocio).toBeUndefined();
      await latido(pcCentro.token, { tipoNegocio: 'ferreteria', moneda: 'RD$', itbis: 18, rnc: '131-00000-1' });
      expect((await db.collection('licencias').doc(LIC).get()).data().perfilNegocio).toMatchObject({ tipoNegocio: 'ferreteria', moneda: 'RD$', itbis: 18, rnc: '131000001' });
    });
  });

  test('salud y rutas desconocidas', async () => {
    await request(app).get('/health').expect(200, { ok: true, servicio: 'tecno-caja-sync-api' });
    await request(app).get('/v1/nada').expect(404);
  });
});

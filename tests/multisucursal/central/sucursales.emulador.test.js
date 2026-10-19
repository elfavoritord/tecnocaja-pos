'use strict';

/**
 * Reglas centrales de sucursales contra el EMULADOR de Firestore (proyecto
 * demo, sin tocar Firebase real). Corre con:
 *   npm run test:multisucursal-central
 * En `npm test` normal (sin emulador) se omite.
 */

const enEmulador = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const describir = enEmulador ? describe : describe.skip;
// El emulador tarda en la primera conexión y serializa las transacciones que
// compiten (la prueba de concurrencia reintenta varias veces).
jest.setTimeout(60000);

const PROYECTO = 'demo-tecnocaja';
const { createSucursalesCentral, hashCodigo } = require('../../../server/multisucursal/central/sucursales');

const EMILIO = { tipo: 'super_admin', uid: 'emilio-uid', nombre: 'Emilio' };
const CONTADORA = { tipo: 'contador', uid: 'conta-uid', nombre: 'Firma Contable', contadorId: 'firma-1' };
const OTRA_FIRMA = { tipo: 'contador', uid: 'otra-uid', nombre: 'Otra Firma', contadorId: 'firma-2' };
const DUENO = { tipo: 'dueno', uid: 'dueno-uid' };

describir('Sucursales centrales (emulador de Firestore)', () => {
  let admin;
  let db;
  let reloj;
  let central;

  beforeAll(() => {
    admin = require('firebase-admin');
    const app = admin.initializeApp({ projectId: PROYECTO }, `sucursales-${Date.now()}`);
    db = app.firestore();
  });

  beforeEach(async () => {
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
    await fetch(`http://${host}:${port}/emulator/v1/projects/${PROYECTO}/databases/(default)/documents`, { method: 'DELETE' });
    reloj = new Date('2026-10-19T12:00:00.000Z');
    central = createSucursalesCentral({ db, now: () => reloj });
    await db.collection('licencias').doc('pos:tecno-caja-colmado').set({
      businessName: 'Colmado La Fe', status: 'active', contadorId: 'firma-1',
    });
    await db.collection('licencias').doc('pos:tecno-caja-sin-contador').set({ businessName: 'Sin Contador', status: 'active' });
  });

  const LIC = 'pos:tecno-caja-colmado';

  test('sin límite fijado la empresa tiene 1 sucursal; la primera es la principal', async () => {
    const a = await central.crear(LIC, { nombre: 'Principal', codigo: 'p01' }, CONTADORA);
    expect(a).toMatchObject({ nombre: 'Principal', codigo: 'P01', estado: 'activa', esPrincipal: true });
    await expect(central.crear(LIC, { nombre: 'Norte' }, CONTADORA)).rejects.toMatchObject({ code: 'LIMITE_SUCURSALES', statusCode: 409 });
    const r = await central.resumen(LIC, CONTADORA);
    expect(r).toMatchObject({ maxSucursales: 1, activas: 1, disponibles: 0, companyUuid: a.companyUuid });
  });

  test('solo Emilio cambia el límite; el contador crea dentro de él', async () => {
    await expect(central.fijarLimite(LIC, 3, CONTADORA)).rejects.toMatchObject({ code: 'SIN_PERMISO', statusCode: 403 });
    await central.fijarLimite(LIC, 3, EMILIO);
    for (const nombre of ['Principal', 'Norte', 'Sur']) await central.crear(LIC, { nombre }, CONTADORA);
    await expect(central.crear(LIC, { nombre: 'Este' }, CONTADORA)).rejects.toMatchObject({ code: 'LIMITE_SUCURSALES' });
    await central.fijarLimite(LIC, 4, EMILIO);
    await expect(central.crear(LIC, { nombre: 'Este' }, CONTADORA)).resolves.toMatchObject({ nombre: 'Este', esPrincipal: false });
  });

  test('con creaciones a la vez nadie se pasa del límite', async () => {
    await central.fijarLimite(LIC, 2, EMILIO);
    const intentos = await Promise.allSettled(
      ['A', 'B', 'C', 'D', 'E'].map((n) => central.crear(LIC, { nombre: `Sucursal ${n}` }, n < 'C' ? CONTADORA : EMILIO))
    );
    expect(intentos.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const snap = await db.collection('licencias').doc(LIC).collection('sucursales').get();
    expect(snap.size).toBe(2);
    expect(snap.docs.filter((d) => d.data().esPrincipal)).toHaveLength(1);
    // Un solo companyUuid para todas.
    expect(new Set(snap.docs.map((d) => d.data().companyUuid)).size).toBe(1);
  });

  test('el contador solo ve y crea en las empresas que tiene asignadas', async () => {
    await expect(central.crear(LIC, { nombre: 'X' }, OTRA_FIRMA)).rejects.toMatchObject({ code: 'SIN_PERMISO' });
    await expect(central.resumen(LIC, OTRA_FIRMA)).rejects.toMatchObject({ code: 'SIN_PERMISO' });
    await expect(central.crear('pos:tecno-caja-sin-contador', { nombre: 'X' }, CONTADORA)).rejects.toMatchObject({ code: 'SIN_PERMISO' });
    await expect(central.crear(LIC, { nombre: 'X' }, DUENO)).rejects.toMatchObject({ code: 'SIN_PERMISO' });
    await expect(central.crear('pos:no-existe', { nombre: 'X' }, EMILIO)).rejects.toMatchObject({ code: 'NO_ENCONTRADA', statusCode: 404 });
  });

  test('datos: nombre obligatorio y código único dentro de la empresa', async () => {
    await central.fijarLimite(LIC, 5, EMILIO);
    await expect(central.crear(LIC, { nombre: ' ' }, CONTADORA)).rejects.toMatchObject({ code: 'DATOS_INVALIDOS' });
    const a = await central.crear(LIC, { nombre: 'Principal', codigo: 'SUC-1' }, CONTADORA);
    await expect(central.crear(LIC, { nombre: 'Otra', codigo: 'suc-1' }, CONTADORA)).rejects.toMatchObject({ code: 'CODIGO_DUPLICADO' });
    const b = await central.crear(LIC, { nombre: 'Norte', codigo: 'SUC-2' }, CONTADORA);
    await expect(central.editar(LIC, b.branchUuid, { codigo: 'SUC-1' }, CONTADORA)).rejects.toMatchObject({ code: 'CODIGO_DUPLICADO' });

    const r = await central.editar(LIC, a.branchUuid, { nombre: 'Principal Centro', telefono: '809-555-0000' }, CONTADORA);
    expect(r.version).toBe(2);
    const doc = (await db.collection('licencias').doc(LIC).collection('sucursales').doc(a.branchUuid).get()).data();
    expect(doc).toMatchObject({ nombre: 'Principal Centro', telefono: '809-555-0000', codigo: 'SUC-1', version: 2 });
  });

  test('activar/desactivar: solo Emilio, y reactivar respeta el límite', async () => {
    await central.fijarLimite(LIC, 2, EMILIO);
    await central.crear(LIC, { nombre: 'Principal' }, CONTADORA);
    const norte = await central.crear(LIC, { nombre: 'Norte' }, CONTADORA);
    await expect(central.cambiarEstado(LIC, norte.branchUuid, 'inactiva', CONTADORA)).rejects.toMatchObject({ code: 'SIN_PERMISO' });

    await central.cambiarEstado(LIC, norte.branchUuid, 'inactiva', EMILIO);
    const sur = await central.crear(LIC, { nombre: 'Sur' }, CONTADORA); // el cupo quedó libre
    await expect(central.cambiarEstado(LIC, norte.branchUuid, 'activa', EMILIO)).rejects.toMatchObject({ code: 'LIMITE_SUCURSALES' });
    await expect(central.fijarLimite(LIC, 1, EMILIO)).rejects.toMatchObject({ code: 'LIMITE_MENOR_QUE_ACTIVAS' });
    await central.cambiarEstado(LIC, sur.branchUuid, 'inactiva', EMILIO);
    await expect(central.cambiarEstado(LIC, norte.branchUuid, 'activa', EMILIO)).resolves.toMatchObject({ estado: 'activa' });
  });

  test('código de equipo: se guarda solo el hash, sirve una vez y vence en 24 h', async () => {
    const suc = await central.crear(LIC, { nombre: 'Principal' }, CONTADORA);
    const { codigo, venceEn } = await central.generarCodigo(LIC, suc.branchUuid, CONTADORA);
    expect(codigo).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(venceEn).toBe('2026-10-20T12:00:00.000Z');

    const guardados = await db.collection('activaciones_equipo').get();
    expect(guardados.size).toBe(1);
    expect(guardados.docs[0].id).toBe(hashCodigo(codigo));
    expect(JSON.stringify(guardados.docs[0].data())).not.toContain(codigo.replace('-', ''));

    const identidad = await central.canjearCodigo(codigo.toLowerCase().replace('-', ' '), { deviceId: 'npd_1', hostname: 'CAJA-1' });
    expect(identidad).toMatchObject({ licenseId: LIC, companyUuid: suc.companyUuid, sucursal: { branchUuid: suc.branchUuid, nombre: 'Principal' } });
    await expect(central.canjearCodigo(codigo, { deviceId: 'npd_2' })).rejects.toMatchObject({ code: 'CODIGO_USADO' });

    const otro = await central.generarCodigo(LIC, suc.branchUuid, EMILIO);
    reloj = new Date('2026-10-20T12:00:01.000Z');
    await expect(central.canjearCodigo(otro.codigo)).rejects.toMatchObject({ code: 'CODIGO_VENCIDO' });
    await expect(central.canjearCodigo('ZZZZ-ZZZZ')).rejects.toMatchObject({ code: 'CODIGO_INVALIDO' });
  });

  test('no se activa un equipo en una sucursal desactivada ni con la licencia suspendida', async () => {
    await central.fijarLimite(LIC, 2, EMILIO);
    await central.crear(LIC, { nombre: 'Principal' }, CONTADORA);
    const norte = await central.crear(LIC, { nombre: 'Norte' }, CONTADORA);
    const c1 = await central.generarCodigo(LIC, norte.branchUuid, CONTADORA);
    await central.cambiarEstado(LIC, norte.branchUuid, 'inactiva', EMILIO);
    await expect(central.canjearCodigo(c1.codigo)).rejects.toMatchObject({ code: 'SUCURSAL_INACTIVA' });
    await expect(central.generarCodigo(LIC, norte.branchUuid, CONTADORA)).rejects.toMatchObject({ code: 'SUCURSAL_INACTIVA' });

    await central.cambiarEstado(LIC, norte.branchUuid, 'activa', EMILIO);
    const c2 = await central.generarCodigo(LIC, norte.branchUuid, CONTADORA);
    await db.collection('licencias').doc(LIC).update({ status: 'suspended' });
    await expect(central.canjearCodigo(c2.codigo)).rejects.toMatchObject({ code: 'LICENCIA_INACTIVA' });
  });

  test('cada cambio queda en el historial con quién lo hizo', async () => {
    await central.fijarLimite(LIC, 2, EMILIO);
    const s = await central.crear(LIC, { nombre: 'Principal' }, CONTADORA);
    await central.editar(LIC, s.branchUuid, { nombre: 'Principal 2' }, CONTADORA);
    await central.generarCodigo(LIC, s.branchUuid, CONTADORA);
    const hist = await db.collection('licencias').doc(LIC).collection('sucursales_historial').get();
    const acciones = hist.docs.map((d) => [d.data().accion, d.data().actor.tipo]).sort();
    expect(acciones).toEqual([
      ['codigo_equipo', 'contador'], ['crear', 'contador'], ['editar', 'contador'], ['limite', 'super_admin'],
    ]);
  });
});

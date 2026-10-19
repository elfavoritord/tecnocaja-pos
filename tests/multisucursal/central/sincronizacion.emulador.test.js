'use strict';

/**
 * Reglas centrales de la sincronización (sincronizacion-central.js) contra el
 * EMULADOR de Firestore: eventos que suben las sucursales, cambios que bajan
 * por cursor, rangos NCF y resumen de ventas.
 *   npm run test:multisucursal-central
 */

const enEmulador = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const describir = enEmulador ? describe : describe.skip;
jest.setTimeout(60000);

const crypto = require('crypto');
const PROYECTO = 'demo-tecnocaja';
const { createSucursalesCentral } = require('../../../server/multisucursal/central/sucursales');
const { createSincronizacionCentral } = require('../../../server/multisucursal/central/sincronizacion-central');

const LIC = 'pos:tecno-caja-farmacia';
const LIC2 = 'pos:tecno-caja-otra-empresa';
const EMILIO = { tipo: 'super_admin', uid: 'emilio', nombre: 'Emilio' };
const CONTADORA = { tipo: 'contador', uid: 'conta', nombre: 'Firma', contadorId: 'firma-1' };
const OTRA_FIRMA = { tipo: 'contador', uid: 'otra', nombre: 'Otra', contadorId: 'firma-2' };
const HASH = `scrypt:${'a'.repeat(32)}:${'b'.repeat(128)}`;
const id = () => crypto.randomUUID();

describir('Sincronización central (emulador de Firestore)', () => {
  let db;
  let reloj;
  let central;
  let sync;
  let A; let B; let C; let X;

  beforeAll(() => {
    const admin = require('firebase-admin');
    db = admin.initializeApp({ projectId: PROYECTO }, `sincronizacion-${Date.now()}`).firestore();
  });

  beforeEach(async () => {
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
    await fetch(`http://${host}:${port}/emulator/v1/projects/${PROYECTO}/databases/(default)/documents`, { method: 'DELETE' });
    reloj = new Date('2026-10-19T16:00:00.000Z');
    central = createSucursalesCentral({ db, now: () => reloj });
    sync = createSincronizacionCentral({ db, now: () => reloj });
    await db.collection('licencias').doc(LIC).set({ businessName: 'Farmacia', status: 'active', contadorId: 'firma-1' });
    await db.collection('licencias').doc(LIC2).set({ businessName: 'Otra', status: 'active' });
    await central.fijarLimite(LIC, 3, EMILIO);
    const a = await central.crear(LIC, { nombre: 'Principal' }, EMILIO);
    const b = await central.crear(LIC, { nombre: 'Norte' }, EMILIO);
    const c = await central.crear(LIC, { nombre: 'Sur' }, EMILIO);
    const x = await central.crear(LIC2, { nombre: 'Ajena' }, EMILIO);
    A = { licenseId: LIC, branchUuid: a.branchUuid, esPrincipal: true, equipoId: 'eq-a' };
    B = { licenseId: LIC, branchUuid: b.branchUuid, esPrincipal: false, equipoId: 'eq-b' };
    C = { licenseId: LIC, branchUuid: c.branchUuid, esPrincipal: false, equipoId: 'eq-c' };
    X = { licenseId: LIC2, branchUuid: x.branchUuid, esPrincipal: true, equipoId: 'eq-x' };
  });

  const ev = (entityType, entityUuid, payload, operation = 'publicar') => ({ eventId: id(), entityType, entityUuid, operation, version: 1, payload });
  const producto = (datos = {}) => ({ codigo: 'P001', nombre: 'Acetaminofén', categoria: 'Medicinas', precioSugerido: 50, alcance: 'global', ...datos });

  test('venta: se registra una vez, suma al día y al anularse resta; total y líneas no se pisan', async () => {
    const venta = { factura: 'FAC-1', fecha: '2026-10-19 11:00:00', fechaOperativa: '2026-10-19', total: 100, estado: 'pagada', items: [{ codigo: 'P001', nombre: 'Acetaminofén', cantidad: 2, precio: 50, total: 100 }] };
    const uuid = id();
    const e1 = ev('venta', uuid, venta, 'registrar');
    expect(await sync.procesarEvento(B, e1)).toMatchObject({ resultado: 'ok' });
    expect(await sync.procesarEvento(B, e1)).toMatchObject({ resultado: 'duplicado' });
    const dia = () => db.collection('licencias').doc(LIC).collection('sucursales').doc(B.branchUuid).collection('resumen_diario').doc('2026-10-19').get();
    expect((await dia()).data()).toMatchObject({ ventas: 1, total: 100 });

    // Vuelve a llegar anulada (y con otro total que se ignora: es inmutable).
    await sync.procesarEvento(B, ev('venta', uuid, { ...venta, total: 999, estado: 'anulada', anulada: true }, 'registrar'));
    expect((await dia()).data()).toMatchObject({ ventas: 0, total: 0 });
    const doc = (await db.collection('licencias').doc(LIC).collection('sucursales').doc(B.branchUuid).collection('ventas').doc(uuid).get()).data();
    expect(doc).toMatchObject({ total: 100, estado: 'anulada', anulada: true, contada: false, items: [expect.objectContaining({ cantidad: 2 })] });
    // La venta de B no aparece en A.
    const deA = await db.collection('licencias').doc(LIC).collection('sucursales').doc(A.branchUuid).collection('ventas').get();
    expect(deA.size).toBe(0);
  });

  test('precio y existencia por sucursal: historial de precio y un reintento viejo no pisa', async () => {
    const p = id();
    await sync.procesarEvento(A, ev('producto_sucursal', p, { codigo: 'P001', precio: 50, stock: 10, marcaTiempo: '2026-10-19T10:00:00.000Z' }, 'actualizar'));
    await sync.procesarEvento(A, ev('producto_sucursal', p, { codigo: 'P001', precio: 60, stock: 8, marcaTiempo: '2026-10-19T11:00:00.000Z' }, 'actualizar'));
    await sync.procesarEvento(A, ev('producto_sucursal', p, { codigo: 'P001', precio: 40, stock: 99, marcaTiempo: '2026-10-19T09:00:00.000Z' }, 'actualizar'));
    const ref = db.collection('licencias').doc(LIC).collection('sucursales').doc(A.branchUuid);
    expect((await ref.collection('productos').doc(p).get()).data()).toMatchObject({ precio: 60, stock: 8 });
    const hist = await ref.collection('precio_historial').get();
    expect(hist.docs.map((d) => [d.data().antes, d.data().despues])).toEqual([[50, 60]]);
  });

  test('catálogo: solo la principal publica; llega a quien está asignado; código único; retirar', async () => {
    const p1 = id();
    expect(await sync.procesarEvento(B, ev('producto', p1, producto()))).toMatchObject({ resultado: 'rechazado', code: 'SOLO_PRINCIPAL' });
    expect(await sync.procesarEvento(A, ev('producto', p1, producto()))).toMatchObject({ resultado: 'ok' });

    // Otro producto con el mismo código: rechazado.
    expect(await sync.procesarEvento(A, ev('producto', id(), producto({ nombre: 'Copia' })))).toMatchObject({ resultado: 'rechazado', code: 'CODIGO_DUPLICADO' });
    // Solo para Norte.
    const p2 = id();
    await sync.procesarEvento(A, ev('producto', p2, producto({ codigo: 'P002', nombre: 'Ibuprofeno', alcance: 'sucursales', sucursales: [B.branchUuid] })));
    // Una sucursal de OTRA empresa no se puede elegir.
    expect(await sync.procesarEvento(A, ev('producto', id(), producto({ codigo: 'P003', alcance: 'sucursales', sucursales: [X.branchUuid] }))))
      .toMatchObject({ resultado: 'rechazado', code: 'SUCURSAL_AJENA' });

    const deB = await sync.cambios(B, 'catalogo', 0, 200, { contar: true });
    expect(deB.pendientes).toBe(2);
    expect(deB.items.map((i) => [i.datos?.codigo, i.asignado])).toEqual([['P001', true], ['P002', true]]);
    expect(deB.items[0].datos).toMatchObject({ nombre: 'Acetaminofén', precioSugerido: 50 });
    const deC = await sync.cambios(C, 'catalogo', 0);
    expect(deC.items.map((i) => i.asignado)).toEqual([true, false]);
    expect(deC.items[1].datos).toBeUndefined();

    // Cursor: desde el último visto no hay nada; tras retirar llega el cambio.
    expect((await sync.cambios(B, 'catalogo', deB.siguiente)).items).toEqual([]);
    await sync.procesarEvento(A, ev('producto', p1, {}, 'retirar'));
    const tras = await sync.cambios(B, 'catalogo', deB.siguiente);
    expect(tras.items).toEqual([expect.objectContaining({ uuid: p1, asignado: false, version: 2 })]);
    // Retirado libera el código.
    expect(await sync.procesarEvento(A, ev('producto', id(), producto({ nombre: 'Nuevo con P001' })))).toMatchObject({ resultado: 'ok' });
  });

  test('cambios por páginas: una descarga cortada sigue donde quedó', async () => {
    for (let i = 1; i <= 7; i += 1) {
      await sync.procesarEvento(A, ev('producto', id(), producto({ codigo: `C${i}`, nombre: `Producto ${i}` })));
    }
    const p1 = await sync.cambios(B, 'catalogo', 0, 3, { contar: true });
    expect([p1.items.length, p1.hayMas, p1.pendientes]).toEqual([3, true, 7]);
    const p2 = await sync.cambios(B, 'catalogo', p1.siguiente, 3);
    const p3 = await sync.cambios(B, 'catalogo', p2.siguiente, 3);
    expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.datos.codigo)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']);
    expect(p3.hayMas).toBe(false);
  });

  test('usuarios: los publica la principal con la huella de la clave; cada sucursal ve solo los suyos', async () => {
    const u = id();
    const usuario = { usuario: 'maria', nombre: 'María', roleCode: 'cajero', rol: 'Cajero', passwordHash: HASH, sucursales: [B.branchUuid] };
    expect(await sync.procesarEvento(A, ev('usuario', u, { ...usuario, passwordHash: '1234' }))).toMatchObject({ resultado: 'rechazado', code: 'SIN_CLAVE_PROTEGIDA' });
    expect(await sync.procesarEvento(A, ev('usuario', u, usuario))).toMatchObject({ resultado: 'ok' });
    expect(await sync.procesarEvento(A, ev('usuario', id(), { ...usuario, nombre: 'Otra María' }))).toMatchObject({ resultado: 'rechazado', code: 'USUARIO_DUPLICADO' });

    const deB = await sync.cambios(B, 'usuarios', 0);
    expect(deB.items).toEqual([expect.objectContaining({ uuid: u, asignado: true, datos: expect.objectContaining({ usuario: 'maria', passwordHash: HASH }) })]);
    const deC = await sync.cambios(C, 'usuarios', 0);
    expect(deC.items).toEqual([expect.objectContaining({ uuid: u, asignado: false })]);
    expect(JSON.stringify(deC)).not.toContain(HASH);
  });

  test('precio en varias sucursales: solo llega a las elegidas', async () => {
    const p = id();
    await sync.procesarEvento(A, ev('producto', p, producto()));
    expect(await sync.procesarEvento(A, ev('comando_precio', p, { productUuid: p, precio: 75, sucursales: [B.branchUuid] }, 'crear'))).toMatchObject({ resultado: 'ok' });
    expect((await sync.cambios(B, 'comandos', 0)).items).toEqual([expect.objectContaining({ tipo: 'precio', productUuid: p, precio: 75 })]);
    expect((await sync.cambios(C, 'comandos', 0)).items).toEqual([]);
    expect(await sync.procesarEvento(B, ev('comando_precio', p, { productUuid: p, precio: 1, sucursales: [C.branchUuid] }, 'crear'))).toMatchObject({ code: 'SOLO_PRINCIPAL' });
  });

  test('NCF: sub-rangos sin choques entre sucursales; los números anulados no se reutilizan', async () => {
    const r1 = await sync.asignarRangoNcf(LIC, A.branchUuid, { tipo: 'B02', desde: 1, hasta: 500, vence: '2027-12-31' }, CONTADORA);
    await expect(sync.asignarRangoNcf(LIC, B.branchUuid, { tipo: 'B02', desde: 400, hasta: 900 }, EMILIO)).rejects.toMatchObject({ code: 'RANGO_SOLAPADO', statusCode: 409 });
    const r2 = await sync.asignarRangoNcf(LIC, B.branchUuid, { tipo: 'B02', desde: 501, hasta: 1000 }, EMILIO);
    // Otro tipo puede usar los mismos números.
    await sync.asignarRangoNcf(LIC, B.branchUuid, { tipo: 'B01', desde: 1, hasta: 100 }, EMILIO);
    await expect(sync.asignarRangoNcf(LIC, A.branchUuid, { tipo: 'B02', desde: 1001, hasta: 1100 }, OTRA_FIRMA)).rejects.toMatchObject({ code: 'SIN_PERMISO' });

    const deB = await sync.cambios(B, 'ncf', 0);
    expect(deB.items.map((i) => [i.tipo, i.desde, i.hasta])).toEqual([['B02', 501, 1000], ['B01', 1, 100]]);
    expect((await sync.cambios(A, 'ncf', 0)).items.map((i) => i.rangoUuid)).toEqual([r1.rangoUuid]);

    // La sucursal reporta que lo usa: ya no se puede anular.
    await sync.procesarEvento(B, ev('ncf_rango', r2.rangoUuid, { rangoUuid: r2.rangoUuid, estado: 'en_uso', siguiente: 501 }, 'estado'));
    await expect(sync.anularRangoNcf(LIC, B.branchUuid, r2.rangoUuid, EMILIO)).rejects.toMatchObject({ code: 'RANGO_EN_USO' });
    await sync.registrarUsoNcf(B, [{ rangoUuid: r2.rangoUuid, siguiente: 640 }]);

    // A no lo usó: se anula y sus números quedan reservados.
    await sync.anularRangoNcf(LIC, A.branchUuid, r1.rangoUuid, CONTADORA);
    await expect(sync.asignarRangoNcf(LIC, C.branchUuid, { tipo: 'B02', desde: 1, hasta: 10 }, EMILIO)).rejects.toMatchObject({ code: 'RANGO_SOLAPADO' });
    const anulado = (await sync.cambios(A, 'ncf', 0)).items[0];
    expect(anulado).toMatchObject({ rangoUuid: r1.rangoUuid, estado: 'anulado' });

    const lista = await sync.listarRangosNcf(LIC, CONTADORA);
    const deNorte = lista.find((r) => r.rangoUuid === r2.rangoUuid);
    expect(deNorte).toMatchObject({ estadoSucursal: 'en_uso', siguiente: 640, disponibles: 361, sucursal: 'Norte' });
  });

  test('aislamiento: otra empresa no ve el catálogo ni los rangos', async () => {
    await sync.procesarEvento(A, ev('producto', id(), producto()));
    await sync.asignarRangoNcf(LIC, A.branchUuid, { tipo: 'B02', desde: 1, hasta: 10 }, EMILIO);
    expect((await sync.cambios(X, 'catalogo', 0)).items).toEqual([]);
    expect((await sync.cambios(X, 'ncf', 0)).items).toEqual([]);
    await expect(sync.listarRangosNcf(LIC, OTRA_FIRMA)).rejects.toMatchObject({ code: 'SIN_PERMISO' });
    // Un evento de X con un uuid de A queda en la empresa de X (el contexto lo pone el token).
    const v = id();
    await sync.procesarEvento(X, ev('venta', v, { fechaOperativa: '2026-10-19', total: 5, estado: 'pagada' }, 'registrar'));
    const enA = await db.collection('licencias').doc(LIC).collection('sucursales').doc(A.branchUuid).collection('ventas').doc(v).get();
    expect(enA.exists).toBe(false);
  });

  test('resumen de ventas por sucursal (hoy, ayer, período)', async () => {
    const venta = (fecha, total) => ev('venta', id(), { fechaOperativa: fecha, total, estado: 'pagada' }, 'registrar');
    await sync.procesarEventos(A, [venta('2026-10-19', 100), venta('2026-10-19', 50), venta('2026-10-18', 30)]);
    await sync.procesarEventos(B, [venta('2026-10-19', 20)]);
    const r = await sync.resumenOperacion(LIC, CONTADORA);
    expect(r.hoy).toBe('2026-10-19');
    const fila = (n) => r.sucursales.find((s) => s.nombre === n);
    expect(fila('Principal')).toMatchObject({ hoy: { ventas: 2, total: 150 }, ayer: { ventas: 1, total: 30 }, periodo: { ventas: 3, total: 180 } });
    expect(fila('Norte')).toMatchObject({ hoy: { ventas: 1, total: 20 } });
    expect(r.total).toEqual({ hoy: 170, periodo: 200 });
  });
});

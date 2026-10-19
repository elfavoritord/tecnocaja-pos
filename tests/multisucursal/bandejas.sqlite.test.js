'use strict';

const { crearBaseSqlite } = require('./sqlite-helper');
const { createMigrationRunner } = require('../../server/migrations/runner');
const migraciones = require('../../server/migrations/multisucursal');
const { createBandejas, calcularEsperaMs, PAYLOAD_MAXIMO_BYTES } = require('../../server/multisucursal/bandejas');

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const SUCURSAL = '22222222-2222-4222-8222-222222222222';

describe('Bandejas de sincronización (SQLite)', () => {
  let base;
  let reloj;
  let bandejas;
  let secuencia;

  beforeEach(async () => {
    base = await crearBaseSqlite();
    await createMigrationRunner({
      query: base.query, withTransaction: base.withTransaction, dialect: 'sqlite',
      migrations: migraciones, logger: { log() {} },
    }).runPending();
    reloj = new Date('2026-10-18T12:00:00.000Z');
    secuencia = 0;
    bandejas = createBandejas({
      dialect: 'sqlite',
      now: () => reloj,
      aleatorio: () => 0.5, // sin variación: espera exacta
      randomUUID: () => `00000000-0000-4000-8000-${String(++secuencia).padStart(12, '0')}`,
    });
  });

  afterEach(() => base.close());

  const venta = (n) => ({
    companyUuid: EMPRESA, branchUuid: SUCURSAL, entityType: 'venta',
    entityUuid: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`, operation: 'crear',
    payload: { total: 100 * n },
  });

  test('el evento es parte de la transacción: si se revierte, no existe', async () => {
    await expect(base.withTransaction(async (conn) => {
      await bandejas.registrarSalida(conn, venta(1));
      throw new Error('la venta falló');
    })).rejects.toThrow('la venta falló');
    expect(await bandejas.pendientes(base.query)).toEqual([]);

    await base.withTransaction((conn) => bandejas.registrarSalida(conn, venta(2)));
    const pendientes = await bandejas.pendientes(base.query);
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0]).toMatchObject({
      company_uuid: EMPRESA, branch_uuid: SUCURSAL, entity_type: 'venta', operation: 'crear',
      status: 'pendiente', attempts: 0, created_at_utc: '2026-10-18T12:00:00.000Z',
      payload: { total: 200 },
    });
  });

  test('se envían en el orden en que ocurrieron', async () => {
    for (let n = 1; n <= 3; n += 1) await bandejas.registrarSalida(base.query, venta(n));
    const pendientes = await bandejas.pendientes(base.query);
    expect(pendientes.map((p) => p.payload.total)).toEqual([100, 200, 300]);
  });

  test('confirmado no se vuelve a enviar', async () => {
    const id = await bandejas.registrarSalida(base.query, venta(1));
    expect(await bandejas.confirmar(base.query, [id])).toBe(1);
    expect(await bandejas.pendientes(base.query)).toEqual([]);
    expect(await bandejas.confirmar(base.query, [id])).toBe(0);
  });

  test('un error de red se reintenta solo después de la espera', async () => {
    const id = await bandejas.registrarSalida(base.query, venta(1));
    const r = await bandejas.marcarError(base.query, id, 'ECONNREFUSED');
    expect(r).toEqual({ intentos: 1, siguienteIntento: '2026-10-18T12:00:30.000Z' });
    expect(await bandejas.pendientes(base.query)).toEqual([]);

    reloj = new Date('2026-10-18T12:00:31.000Z');
    const otraVez = await bandejas.pendientes(base.query);
    expect(otraVez).toHaveLength(1);
    expect(otraVez[0]).toMatchObject({ status: 'error', attempts: 1 });

    const r2 = await bandejas.marcarError(base.query, id, 'timeout');
    expect(r2.intentos).toBe(2);
    expect(r2.siguienteIntento).toBe('2026-10-18T12:01:31.000Z');
  });

  test('un rechazo de la nube no se reintenta', async () => {
    const id = await bandejas.registrarSalida(base.query, venta(1));
    await bandejas.marcarError(base.query, id, 'otra_empresa', { rechazado: true });
    reloj = new Date('2026-10-19T12:00:00.000Z');
    expect(await bandejas.pendientes(base.query)).toEqual([]);
    expect((await bandejas.resumen(base.query)).salida.rechazado).toBe(1);
  });

  test('la espera crece y se topa en una hora', () => {
    const sinVariacion = () => 0.5;
    expect(calcularEsperaMs(1, sinVariacion)).toBe(30000);
    expect(calcularEsperaMs(2, sinVariacion)).toBe(60000);
    expect(calcularEsperaMs(5, sinVariacion)).toBe(480000);
    expect(calcularEsperaMs(30, sinVariacion)).toBe(3600000);
    expect(calcularEsperaMs(1, () => 1)).toBe(36000);
    expect(calcularEsperaMs(1, () => 0)).toBe(24000);
  });

  test('el mismo evento recibido dos veces se aplica una sola vez', async () => {
    const evento = {
      eventId: '33333333-3333-4333-8333-333333333333', companyUuid: EMPRESA, branchUuid: null,
      entityType: 'producto', entityUuid: '44444444-4444-4444-8444-444444444444', version: 3,
    };
    expect(await bandejas.registrarEntrada(base.query, evento)).toBe('nuevo');
    expect(await bandejas.registrarEntrada(base.query, evento)).toBe('duplicado');
    await bandejas.marcarEntrada(base.query, evento.eventId, 'aplicado');
    const filas = await base.query('SELECT status, entity_version, applied_at_utc FROM sync_inbox');
    expect(filas).toEqual([{ status: 'aplicado', entity_version: 3, applied_at_utc: '2026-10-18T12:00:00.000Z' }]);
  });

  test('cursores de descarga: se crean y se actualizan', async () => {
    expect(await bandejas.leerCursor(base.query, 'catalogo')).toBeNull();
    await bandejas.guardarCursor(base.query, 'catalogo', 'v-120');
    await bandejas.guardarCursor(base.query, 'catalogo', 'v-121');
    expect(await bandejas.leerCursor(base.query, 'catalogo')).toBe('v-121');
  });

  test('resumen por estado y desde cuándo hay pendientes', async () => {
    const a = await bandejas.registrarSalida(base.query, venta(1));
    reloj = new Date('2026-10-18T13:00:00.000Z');
    await bandejas.registrarSalida(base.query, venta(2));
    await bandejas.confirmar(base.query, [a]);
    const r = await bandejas.resumen(base.query);
    expect(r.salida).toEqual({ pendiente: 1, sincronizado: 1, error: 0, rechazado: 0 });
    expect(r.pendienteDesde).toBe('2026-10-18T13:00:00.000Z');
  });

  test('rechaza eventos incompletos o demasiado grandes', async () => {
    await expect(bandejas.registrarSalida(base.query, { entityType: 'venta' })).rejects.toThrow(/incompleto/);
    const enorme = { ...venta(1), payload: { x: 'a'.repeat(PAYLOAD_MAXIMO_BYTES) } };
    await expect(bandejas.registrarSalida(base.query, enorme)).rejects.toThrow(/supera/);
  });
});

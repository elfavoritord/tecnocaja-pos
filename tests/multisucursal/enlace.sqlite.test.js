'use strict';

/**
 * Enlace del POS con la Sync API (server/multisucursal/enlace.js) sobre SQLite,
 * con la API simulada. La API real se prueba en
 * cloud/sync-api/test y de punta a punta en
 * scripts/multisucursal/probar-enlace-pos.js.
 */

const { crearBaseSqlite } = require('./sqlite-helper');
const { createMigrationRunner } = require('../../server/migrations/runner');
const migraciones = require('../../server/migrations/multisucursal');
const { createIdentidad } = require('../../server/multisucursal/identidad');
const { createBandejas } = require('../../server/multisucursal/bandejas');
const { createEnlaceCentral } = require('../../server/multisucursal/enlace');

const EMPRESA = { licenseId: 'pos:tecno-caja-bravo', companyUuid: '11111111-1111-4111-8111-111111111111', nombre: 'Supermercado Bravo' };
const SUCURSAL = {
  branchUuid: '22222222-2222-4222-8222-222222222222', nombre: 'Bravo Norte', codigo: 'NOR',
  direccion: 'Av. Hermanas Mirabal 10', telefono: '809-555-1010', encargado: 'Luis', esPrincipal: false, estado: 'activa', version: 1,
};
const TOKEN = `eq_33333333-3333-4333-8333-333333333333.${'x'.repeat(43)}`;

function apiSimulada() {
  const llamadas = [];
  let respuestas = {};
  const fetchImpl = async (url, opciones) => {
    const ruta = url.replace('https://sync.prueba', '');
    llamadas.push({ ruta, method: opciones.method, auth: opciones.headers.Authorization || null, body: opciones.body ? JSON.parse(opciones.body) : null });
    const r = respuestas[`${opciones.method} ${ruta}`];
    if (!r) throw new Error('ECONNREFUSED');
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  return {
    fetchImpl,
    llamadas,
    responder: (clave, status, body) => { respuestas[clave] = { status, body }; },
    limpiar: () => { respuestas = {}; llamadas.length = 0; },
  };
}

describe('Enlace del POS con la central', () => {
  let base;
  let env;
  let guardadoEnv;
  let api;
  let enlace;
  let reloj;

  beforeEach(async () => {
    base = await crearBaseSqlite();
    await base.query("INSERT INTO branches (id, business_id, nombre, codigo) VALUES (2, 1, 'Sucursal Principal', 'PRINCIPAL-2')");
    await base.query("UPDATE config SET business_id = 1, active_branch_id = 2 WHERE id = 1");
    await base.query('CREATE TABLE installation_config (id INTEGER PRIMARY KEY AUTOINCREMENT, config_key VARCHAR(100) NOT NULL, config_value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    await createMigrationRunner({ query: base.query, withTransaction: base.withTransaction, dialect: 'sqlite', migrations: migraciones, logger: { log() {} } }).runPending();
    env = { TECNO_CAJA_SYNC_URL: 'https://sync.prueba/' };
    guardadoEnv = {};
    api = apiSimulada();
    reloj = new Date('2026-10-19T16:00:00.000Z');
    const identidad = createIdentidad({ query: base.query });
    enlace = createEnlaceCentral({
      query: base.query, identidad, bandejas: createBandejas({ dialect: 'sqlite' }), env,
      persistEnv: (v) => Object.assign(guardadoEnv, v), fetchImpl: api.fetchImpl, now: () => reloj,
      getEquipo: () => ({ deviceId: 'npd_1', hostname: 'CAJA-NORTE', serverId: 'srv_0123456789abcdef', appVersion: '1.5.0', licenseId: EMPRESA.licenseId }),
      logger: { warn() {} },
    });
  });

  afterEach(() => { enlace.detener(); base.close(); });

  const activacionOk = () => api.responder('POST /v1/equipos/activar', 201, { ok: true, token: TOKEN, equipoId: '33333333-3333-4333-8333-333333333333', empresa: EMPRESA, sucursal: SUCURSAL, reemplazados: 0 });

  test('sin URL de la central no hace nada y lo dice', async () => {
    delete env.TECNO_CAJA_SYNC_URL;
    expect(await enlace.estado()).toMatchObject({ configurado: false, tieneToken: false, vinculado: false, estado: 'sin_vincular' });
    await expect(enlace.activar('ABCD-EFGH')).rejects.toMatchObject({ code: 'SIN_CONFIGURAR', statusCode: 503 });
    expect(enlace.iniciar()).toBe(false);
  });

  test('activar: guarda el token y esta base adopta la identidad de la central', async () => {
    activacionOk();
    api.responder('POST /v1/latido', 200, { ok: true });
    const estado = await enlace.activar('abcd-efgh');

    expect(estado).toMatchObject({ configurado: true, tieneToken: true, vinculado: true, estado: 'vinculado', empresa: EMPRESA, sucursal: { nombre: 'Bravo Norte' } });
    expect(guardadoEnv).toEqual({ TECNO_CAJA_SYNC_TOKEN: TOKEN });
    expect(api.llamadas[0]).toMatchObject({
      ruta: '/v1/equipos/activar', method: 'POST', auth: null,
      body: { codigo: 'abcd-efgh', equipo: { hostname: 'CAJA-NORTE', licenseId: EMPRESA.licenseId } },
    });

    const [negocio] = await base.query('SELECT uuid FROM businesses WHERE id = 1');
    const [suc] = await base.query('SELECT uuid, nombre, codigo, direccion, telefono, encargado FROM branches WHERE id = 2');
    expect(negocio.uuid).toBe(EMPRESA.companyUuid);
    expect(suc).toEqual({ uuid: SUCURSAL.branchUuid, nombre: 'Bravo Norte', codigo: 'NOR', direccion: 'Av. Hermanas Mirabal 10', telefono: '809-555-1010', encargado: 'Luis' });
    expect(JSON.stringify(await enlace.estado())).not.toContain(TOKEN);
  });

  test('si otra fila local tenía ese uuid, lo suelta (índice único)', async () => {
    await base.query('UPDATE branches SET uuid = ? WHERE id = 1', [SUCURSAL.branchUuid]);
    activacionOk();
    await enlace.activar('ABCD-EFGH');
    const filas = await base.query('SELECT id, uuid FROM branches ORDER BY id');
    expect(filas.find((f) => f.id === 2).uuid).toBe(SUCURSAL.branchUuid);
    expect(filas.find((f) => f.id === 1).uuid).not.toBe(SUCURSAL.branchUuid);
  });

  test('código rechazado por la central: no queda token', async () => {
    api.responder('POST /v1/equipos/activar', 409, { ok: false, error: 'Este código ya se usó. Pide uno nuevo.', code: 'CODIGO_USADO' });
    await expect(enlace.activar('ABCD-EFGH')).rejects.toMatchObject({ code: 'CODIGO_USADO', statusCode: 409, message: 'Este código ya se usó. Pide uno nuevo.' });
    expect(guardadoEnv).toEqual({});
    expect((await enlace.estado()).tieneToken).toBe(false);
  });

  test('latido: manda los pendientes de la bandeja de salida con el token', async () => {
    activacionOk();
    await enlace.activar('ABCD-EFGH');
    const bandejas = createBandejas({ dialect: 'sqlite' });
    for (let i = 0; i < 3; i += 1) {
      await bandejas.registrarSalida(base.query, { entityType: 'venta', entityUuid: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}`, operation: 'crear', payload: {} });
    }
    api.limpiar();
    api.responder('POST /v1/latido', 200, { ok: true });
    reloj = new Date('2026-10-19T16:05:00.000Z');
    await enlace.latido();
    expect(api.llamadas[0]).toMatchObject({ ruta: '/v1/latido', auth: `Bearer ${TOKEN}`, body: { appVersion: '1.5.0', modo: 'normal', pendientes: { salida: 3, errores: 0 } } });
    expect((await enlace.estado()).ultimaConexion).toBe('2026-10-19T16:05:00.000Z');
  });

  test('identidad: trae los cambios que hizo el contador', async () => {
    activacionOk();
    await enlace.activar('ABCD-EFGH');
    api.responder('GET /v1/identidad', 200, {
      ok: true, empresa: EMPRESA, sucursal: { ...SUCURSAL, nombre: 'Bravo Norte Plaza', version: 2 }, equipo: {}, licencia: { status: 'active' },
    });
    await enlace.refrescarIdentidad();
    const [suc] = await base.query('SELECT nombre FROM branches WHERE id = 2');
    expect(suc.nombre).toBe('Bravo Norte Plaza');
  });

  test.each([
    ['EQUIPO_REEMPLAZADO', 'reemplazado'],
    ['EQUIPO_REVOCADO', 'revocado'],
    ['SUCURSAL_INACTIVA', 'sucursal_inactiva'],
    ['LICENCIA_INACTIVA', 'licencia_inactiva'],
  ])('la central responde %s → estado %s', async (codigo, estado) => {
    activacionOk();
    await enlace.activar('ABCD-EFGH');
    api.responder('GET /v1/identidad', 403, { ok: false, error: 'no', code: codigo });
    const r = await enlace.refrescarIdentidad();
    expect(r).toMatchObject({ estado, vinculado: false, tieneToken: true, ultimoError: { codigo } });
  });

  test('reemplazado o revocado: deja de mandar latidos', async () => {
    activacionOk();
    await enlace.activar('ABCD-EFGH');
    api.responder('GET /v1/identidad', 403, { ok: false, error: 'no', code: 'EQUIPO_REVOCADO' });
    await enlace.refrescarIdentidad();
    api.limpiar();
    await enlace.latido();
    expect(api.llamadas).toEqual([]);
  });

  test('sin Internet: anota el error y no cambia el enlace', async () => {
    activacionOk();
    await enlace.activar('ABCD-EFGH');
    api.limpiar();
    const r = await enlace.latido();
    expect(r).toMatchObject({ vinculado: true, estado: 'vinculado', ultimoError: { codigo: 'SIN_CONEXION' } });
  });

  test('desvincular quita el token', async () => {
    activacionOk();
    await enlace.activar('ABCD-EFGH');
    const r = await enlace.desvincular();
    expect(r).toMatchObject({ tieneToken: false, vinculado: false, estado: 'sin_vincular' });
    expect(guardadoEnv.TECNO_CAJA_SYNC_TOKEN).toBe('');
  });
});

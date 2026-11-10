'use strict';

/**
 * Respaldos sin llaves en la PC (lib/respaldos.js), con un Firestore y un
 * almacén en memoria: no hace falta el emulador. Desde cloud/sync-api: npx jest test/respaldos
 */

const request = require('supertest');
const { createApp } = require('../lib/app');

function firestoreFalso(datos = {}) {
  const colecciones = new Map(Object.entries(datos).map(([c, docs]) => [c, new Map(Object.entries(docs))]));
  const col = (nombre) => {
    if (!colecciones.has(nombre)) colecciones.set(nombre, new Map());
    return colecciones.get(nombre);
  };
  const snapDoc = (nombre, id) => ({ id, exists: col(nombre).has(id), data: () => col(nombre).get(id) });
  const ref = (nombre, id) => ({
    _c: nombre, _id: id,
    get: async () => snapDoc(nombre, id),
    set: async (d, o = {}) => { col(nombre).set(id, o.merge ? { ...(col(nombre).get(id) || {}), ...d } : d); },
  });
  return {
    _col: col,
    collection: (nombre) => ({
      doc: (id) => ref(nombre, id),
      where: (campo, _op, valor) => ({
        limit: () => ({
          get: async () => ({ docs: [...col(nombre).entries()].filter(([, d]) => d[campo] === valor).map(([id]) => snapDoc(nombre, id)) }),
        }),
      }),
    }),
    runTransaction: async (fn) => fn({
      get: (r) => r.get(),
      set: (r, d, o) => { r.set(d, o); },
    }),
  };
}

function almacenFalso() {
  const archivos = new Map();
  return {
    archivos,
    listar: async (prefijo) => [...archivos.entries()].filter(([k]) => k.startsWith(prefijo)).map(([key, v]) => ({ key, size: v.size, lastModified: v.fecha })),
    urlSubida: async (key, sha256) => ({ url: `https://b2.falso/put/${key}`, metodo: 'PUT', headers: { 'x-amz-meta-sha256': sha256 } }),
    urlBajada: async (key) => ({ url: `https://b2.falso/get/${key}` }),
    verificar: async (key) => ({ size: archivos.get(key)?.size || 0, sha256: archivos.get(key)?.sha256 || null }),
    borrar: async (key) => { archivos.delete(key); },
  };
}

const LIC = 'pos_abc123';
const OTRA = 'pos_otra999';
const SHA = 'a'.repeat(64);

describe('Sync API: respaldos sin llaves en la PC', () => {
  let db;
  let almacen;
  let app;
  let reloj;

  beforeEach(() => {
    reloj = new Date('2026-11-10T12:00:00Z');
    db = firestoreFalso({
      licencias: {
        [LIC]: { businessName: 'Colmado Uno', ownerEmail: 'dueno@uno.do', devices: { dev_1: { status: 'active' }, dev_viejo: { status: 'released' } } },
        [OTRA]: { businessName: 'Otro', ownerEmail: 'otro@dos.do', devices: { dev_2: { status: 'active' } } },
      },
    });
    almacen = almacenFalso();
    almacen.archivos.set(`backups/${LIC}/TecnoCaja_Diario_Uno_2026-11-09.tcbak`, { size: 100, sha256: SHA, fecha: '2026-11-09T22:00:00Z' });
    almacen.archivos.set(`backups/${OTRA}/TecnoCaja_Diario_Otro_2026-11-09.tcbak`, { size: 50, fecha: '2026-11-09T22:00:00Z' });
    app = createApp({
      db, now: () => reloj, almacen, secretoRespaldos: 'secreto-de-prueba',
      verificarIdToken: async (t) => {
        if (t === 'token-dueno') return { email: 'dueno@uno.do', auth_time: reloj.getTime() / 1000 - 60 };
        if (t === 'token-viejo') return { email: 'dueno@uno.do', auth_time: reloj.getTime() / 1000 - 3600 };
        throw new Error('token malo');
      },
    });
  });

  const sesion = (cuerpo) => request(app).post('/v1/respaldos/sesion').send(cuerpo);
  const con = (token, ruta, cuerpo = {}) => request(app).post(ruta).set('Authorization', `Bearer ${token}`).send(cuerpo);

  test('la PC registrada en su licencia lista, sube y borra solo en su carpeta', async () => {
    const s = await sesion({ licenseId: LIC, deviceId: 'dev_1' }).expect(200);
    expect(s.body).toMatchObject({ ok: true, modo: 'equipo', licencias: [{ licenseId: LIC, nombre: 'Colmado Uno' }] });
    const lista = await con(s.body.token, '/v1/respaldos/listar').expect(200);
    expect(lista.body.objetos.map((o) => o.key)).toEqual([`backups/${LIC}/TecnoCaja_Diario_Uno_2026-11-09.tcbak`]);
    const subir = await con(s.body.token, '/v1/respaldos/subir', { key: `backups/${LIC}/nuevo.tcbak`, sha256: SHA }).expect(200);
    expect(subir.body.headers['x-amz-meta-sha256']).toBe(SHA);
    await con(s.body.token, '/v1/respaldos/listar', { licenseId: OTRA }).expect(403);
    await con(s.body.token, '/v1/respaldos/bajar', { key: `backups/${OTRA}/TecnoCaja_Diario_Otro_2026-11-09.tcbak` }).expect(403);
    await con(s.body.token, '/v1/respaldos/subir', { key: `backups/${LIC}/../${OTRA}/x.tcbak`, sha256: SHA }).expect(400);
    await con(s.body.token, '/v1/respaldos/borrar', { key: `backups/${LIC}/TecnoCaja_Diario_Uno_2026-11-09.tcbak` }).expect(200);
    expect(almacen.archivos.has(`backups/${LIC}/TecnoCaja_Diario_Uno_2026-11-09.tcbak`)).toBe(false);
  });

  test('una PC no registrada, liberada o de otra licencia no recibe permiso', async () => {
    await sesion({ licenseId: LIC, deviceId: 'dev_x' }).expect(403);
    await sesion({ licenseId: LIC, deviceId: 'dev_viejo' }).expect(403);
    await sesion({ licenseId: LIC, deviceId: 'dev_2' }).expect(403);
    await sesion({ licenseId: 'pos_noexiste', deviceId: 'dev_1' }).expect(403);
  });

  test('el dueño ve y baja los respaldos de sus negocios, pero no sube ni borra', async () => {
    const s = await sesion({ idToken: 'token-dueno' }).expect(200);
    expect(s.body).toMatchObject({ modo: 'dueno', email: 'dueno@uno.do', licencias: [{ licenseId: LIC }] });
    const lista = await con(s.body.token, '/v1/respaldos/listar', { licenseId: LIC }).expect(200);
    expect(lista.body.objetos).toHaveLength(1);
    await con(s.body.token, '/v1/respaldos/bajar', { key: lista.body.objetos[0].key }).expect(200);
    await con(s.body.token, '/v1/respaldos/subir', { key: `backups/${LIC}/x.tcbak`, sha256: SHA }).expect(403);
    await con(s.body.token, '/v1/respaldos/borrar', { key: lista.body.objetos[0].key }).expect(403);
    await sesion({ idToken: 'token-viejo' }).expect(401);
    await sesion({ idToken: 'token-malo' }).expect(401);
  });

  test('el permiso vence y una firma alterada no sirve', async () => {
    const s = await sesion({ licenseId: LIC, deviceId: 'dev_1' }).expect(200);
    const [cuerpo, firma] = s.body.token.split('.');
    const otro = Buffer.from(JSON.stringify({ lic: [OTRA], modo: 'equipo', exp: reloj.getTime() + 1e6 })).toString('base64url');
    await con(`${otro}.${firma}`, '/v1/respaldos/listar').expect(401);
    reloj = new Date(reloj.getTime() + 2 * 60 * 60 * 1000);
    await con(`${cuerpo}.${firma}`, '/v1/respaldos/listar').expect(401);
  });

  test('la clave de los respaldos queda guardada y una PC formateada la recupera', async () => {
    const pc = await sesion({ licenseId: LIC, deviceId: 'dev_1' }).expect(200);
    // La PC tiene su clave propia: se guarda (cifrada).
    const guardar = await con(pc.body.token, '/v1/respaldos/clave', { propia: 'clave-propia-del-negocio' }).expect(200);
    expect(guardar.body).toMatchObject({ clave: 'clave-propia-del-negocio', guardada: true });
    expect(JSON.stringify(db._col('respaldos_claves').get(LIC))).not.toContain('clave-propia-del-negocio');
    // Formateada (sin clave propia): recibe la guardada.
    const formateada = await con(pc.body.token, '/v1/respaldos/clave', {}).expect(200);
    expect(formateada.body).toMatchObject({ clave: 'clave-propia-del-negocio', guardada: false });
    // El dueño en otra PC también la recibe, para restaurar.
    const dueno = await sesion({ idToken: 'token-dueno' }).expect(200);
    const delDueno = await con(dueno.body.token, '/v1/respaldos/clave', { licenseId: LIC }).expect(200);
    expect(delDueno.body.clave).toBe('clave-propia-del-negocio');
    // Si la PC cambia de clave, la anterior se conserva para abrir lo viejo.
    const cambio = await con(pc.body.token, '/v1/respaldos/clave', { propia: 'clave-nueva-2026' }).expect(200);
    expect(cambio.body).toMatchObject({ clave: 'clave-nueva-2026', anteriores: ['clave-propia-del-negocio'] });
    // El dueño no puede pedir la clave de un negocio ajeno, ni crearla.
    await con(dueno.body.token, '/v1/respaldos/clave', { licenseId: OTRA }).expect(403);
  });

  test('sin clave propia ni guardada: queda la de siempre y el dueño la recupera', async () => {
    const pc = await sesion({ licenseId: LIC, deviceId: 'dev_1' }).expect(200);
    const r = await con(pc.body.token, '/v1/respaldos/clave', {}).expect(200);
    expect(r.body).toMatchObject({ clave: 'Seguridad2026', guardada: true });
    const dueno = await sesion({ idToken: 'token-dueno' }).expect(200);
    expect((await con(dueno.body.token, '/v1/respaldos/clave', { licenseId: LIC }).expect(200)).body.clave).toBe('Seguridad2026');
  });

  test('sin llave del bucket el servicio responde 503 y no inventa nada', async () => {
    const sinAlmacen = createApp({ db, now: () => reloj, almacen: null, secretoRespaldos: 'x', verificarIdToken: async () => ({}) });
    await request(sinAlmacen).post('/v1/respaldos/sesion').send({ licenseId: LIC, deviceId: 'dev_1' }).expect(503);
  });
});

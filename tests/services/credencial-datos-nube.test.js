'use strict';

/**
 * PC sin la llave completa (instaladores 1.6.36+): la Sync API le entrega a la
 * PC vinculada una credencial solo de Firestore para subir sus datos, y el
 * asistente busca y guarda el contador por la nube. Todo en memoria: la Sync
 * API corre en el mismo proceso (como tests/services/pos-cloud-connection.test.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

function memoryDb() {
  const data = new Map();
  const snapshot = (key) => ({ id: key.split('/').pop(), exists: data.has(key), data: () => data.get(key) });
  const doc = (key) => ({
    key,
    get: async () => snapshot(key),
    set: async (value, options) => { data.set(key, options?.merge ? { ...data.get(key), ...value } : value); },
  });
  return {
    data,
    collection: (col) => ({
      doc: (id) => doc(`${col}/${id}`),
      get: async () => ({ docs: [...data.keys()].filter((k) => k.startsWith(`${col}/`)).map(snapshot) }),
      where: (field, op, value) => ({ limit: () => ({ get: async () => ({ docs: [...data.keys()].filter((k) => k.startsWith(`${col}/`) && data.get(k)[field] === value).map(snapshot) }) }) }),
    }),
    runTransaction: async (fn) => {
      const writes = [];
      await fn({ get: (ref) => ref.get(), set: (ref, value, options) => writes.push([ref.key, value, options]) });
      for (const [key, value, options] of writes) data.set(key, options?.merge ? { ...data.get(key), ...value } : value);
    },
  };
}

const { privateKey: LLAVE_RSA } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CREDENCIAL = {
  type: 'service_account', project_id: 'reporte-sistema-pos', private_key_id: 'k1', private_key: LLAVE_RSA,
  client_email: 'tecno-caja-pos-pc@reporte-sistema-pos.iam.gserviceaccount.com', client_id: '1',
  token_uri: 'https://oauth2.googleapis.com/token',
};

const VARIABLES = ['TECNO_CAJA_USER_DATA', 'FIREBASE_SERVICE_ACCOUNT_PATH', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'GOOGLE_APPLICATION_CREDENTIALS'];

describe('Credencial de datos entregada por la nube', () => {
  let directorio;
  let guardadas;

  beforeEach(() => {
    jest.resetModules();
    directorio = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-credencial-'));
    guardadas = Object.fromEntries(VARIABLES.map((k) => [k, process.env[k]]));
    for (const k of VARIABLES) delete process.env[k];
    process.env.TECNO_CAJA_USER_DATA = directorio;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(guardadas)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(directorio, { recursive: true, force: true });
  });

  function nubeConPc({ posCredential = JSON.stringify(CREDENCIAL) } = {}) {
    const { createPosRouter } = require('../../cloud/sync-api/lib/pos-installations');
    const { createPosCloudConnection } = require('../../server/services/pos-cloud-connection');
    const db = memoryDb();
    const now = new Date();
    const app = express();
    app.use(createPosRouter({
      db, now: () => now, posCredential,
      verificarIdToken: async () => ({ uid: 'dueno-1', email: 'dueno@colmado.do', email_verified: true }),
    }));
    const client = createPosCloudConnection({
      directory: path.join(directorio, 'config', 'pos-cloud'),
      now: () => now.getTime(),
      fetchImpl: async (url, options) => {
        const r = await request(app).post(new URL(url).pathname).send(JSON.parse(options.body));
        return { ok: r.status < 400, status: r.status, json: async () => r.body };
      },
    });
    client.selectBusiness('colmado-uuid');
    return { db, client };
  }

  test('la PC vinculada la recibe, la guarda cifrada y Firestore queda disponible sin ser "admin"', async () => {
    const { client } = nubeConPc();
    await client.register({ business: { name: 'Colmado Uno' }, device: { deviceId: `npd_${'2'.repeat(32)}`, hostname: 'Caja 1' }, idToken: 'ok' });

    const firebaseAdmin = require('../../modules/firebase-admin');
    expect(firebaseAdmin.getFirebaseConfigStatus()).toMatchObject({ adminEnabled: false, firestoreEnabled: false });
    expect(() => firebaseAdmin.getFirestore()).toThrow(/no esta configurado/i);

    const { serviceAccount } = await client.request('credential');
    firebaseAdmin.guardarCredencialEntregada(serviceAccount);

    const archivo = path.join(directorio, 'config', 'pos-cloud', 'firestore-credencial.json');
    const guardado = fs.readFileSync(archivo, 'utf8');
    expect(guardado).not.toContain('PRIVATE KEY');
    expect(guardado).not.toContain(CREDENCIAL.client_email);

    const estado = firebaseAdmin.getFirebaseConfigStatus();
    // La licencia y la identidad siguen por la Sync API: no es la llave de administrador.
    expect(estado.adminEnabled).toBe(false);
    expect(estado.firestoreEnabled).toBe(true);
    expect(estado.credencialEntregada).toBe(true);
    // Antes había fallado (sin credencial): ahora sí inicializa con la entregada.
    expect(firebaseAdmin.getFirestore()).toBeTruthy();
    expect(firebaseAdmin.getFirebaseApp().options.credential).toBeTruthy();
  });

  test('al abrir otra vez, la credencial guardada se usa sin pedirla', () => {
    const primera = require('../../modules/firebase-admin');
    primera.guardarCredencialEntregada(CREDENCIAL);
    jest.resetModules();
    const otraVez = require('../../modules/firebase-admin');
    expect(otraVez.tieneCredencialEntregada()).toBe(true);
    expect(otraVez.getFirestore()).toBeTruthy();
  });

  test('borrarla apaga la subida de datos', () => {
    const firebaseAdmin = require('../../modules/firebase-admin');
    firebaseAdmin.guardarCredencialEntregada(CREDENCIAL);
    firebaseAdmin.borrarCredencialEntregada();
    expect(firebaseAdmin.tieneCredencialEntregada()).toBe(false);
    expect(firebaseAdmin.getFirebaseConfigStatus().firestoreEnabled).toBe(false);
  });

  test('una credencial dañada no rompe: Firestore sigue no disponible', () => {
    const archivo = path.join(directorio, 'config', 'pos-cloud', 'firestore-credencial.json');
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, 'basura');
    const firebaseAdmin = require('../../modules/firebase-admin');
    expect(() => firebaseAdmin.getFirestore()).toThrow(/no esta configurado/i);
  });

  test('no acepta una respuesta sin llave', () => {
    const firebaseAdmin = require('../../modules/firebase-admin');
    expect(() => firebaseAdmin.guardarCredencialEntregada({ client_email: 'x' })).toThrow(/no es válida/);
    expect(firebaseAdmin.tieneCredencialEntregada()).toBe(false);
  });

  test('sin credencial en la nube, la PC recibe CREDENCIAL_NO_CONFIGURADA y no guarda nada', async () => {
    const { client } = nubeConPc({ posCredential: '' });
    await client.register({ business: { name: 'Colmado Uno' }, device: { deviceId: `npd_${'3'.repeat(32)}`, hostname: 'Caja 1' }, idToken: 'ok' });
    await expect(client.request('credential')).rejects.toMatchObject({ code: 'CREDENCIAL_NO_CONFIGURADA', statusCode: 503 });
    expect(require('../../modules/firebase-admin').tieneCredencialEntregada()).toBe(false);
  });

  test('el contador se guarda en la licencia por la nube', async () => {
    const { db, client } = nubeConPc();
    const { license } = await client.register({ business: { name: 'Colmado Uno' }, device: { deviceId: `npd_${'4'.repeat(32)}`, hostname: 'Caja 1' }, idToken: 'ok' });
    db.data.set('contadores/c1', { nombre_firma: 'Victor Contadores SRL', estado: 'activo' });
    await client.request('contador', { contadorId: 'c1' });
    expect(db.data.get(`licencias/${license.id}`)).toMatchObject({ contadorId: 'c1', contadorNombre: 'Victor Contadores SRL' });
  });
});

describe('Asistente: contadores por la nube cuando la PC no tiene Firestore', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../modules/firebase-admin', () => ({
      getFirestore: () => { throw new Error('Firebase Admin no esta configurado.'); },
    }));
  });
  afterEach(() => jest.dontMock('../../modules/firebase-admin'));

  function app(nube, query = jest.fn().mockResolvedValue([])) {
    const createPlatformRouter = require('../../server/routes/platform.routes');
    const a = express();
    a.use(express.json());
    a.use('/api/platform', createPlatformRouter({ query, nube }));
    return { a, query };
  }

  test('busca en el directorio de la nube y devuelve contadores que se pueden elegir', async () => {
    const nube = { buscarContadores: jest.fn().mockResolvedValue([{ id: 'c1', nombre_firma: 'Victor Contadores SRL', rnc: '131000001', extra: 'no' }]) };
    const { a, query } = app(nube);
    const r = await request(a).get('/api/platform/contadores/buscar').query({ q: 'vicr' });
    expect(r.status).toBe(200);
    expect(nube.buscarContadores).toHaveBeenCalledWith('vicr');
    expect(r.body).toEqual([{ id: 'c1', nombre_firma: 'Victor Contadores SRL', responsable: '', rnc: '131000001', telefono: '', correo: '', logo_url: null }]);
    expect(r.body[0].sinNube).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  test('si la nube no responde, queda la búsqueda local (sin poder vincular)', async () => {
    const nube = { buscarContadores: jest.fn().mockRejectedValue(new Error('sin red')) };
    const query = jest.fn().mockResolvedValue([{ id: 7, nombre_firma: 'Local SRL' }]);
    const { a } = app(nube, query);
    const r = await request(a).get('/api/platform/contadores/buscar').query({ q: 'loc' });
    expect(r.body).toEqual([{ id: 7, nombre_firma: 'Local SRL', sinNube: true }]);
  });

  test('asignar el contador lo guarda por la nube, sin aviso', async () => {
    const nube = { asignarContador: jest.fn().mockResolvedValue({ contadorId: 'c1', contadorNombre: 'Victor Contadores SRL' }) };
    const { a } = app(nube);
    const r = await request(a).post('/api/platform/asignar-contador').send({ contador_id: 'c1', nombre_firma: 'Victor' });
    expect(r.status).toBe(200);
    expect(nube.asignarContador).toHaveBeenCalledWith('c1');
    expect(r.body.syncWarning).toBeNull();
  });

  test('si la nube rechaza, se guarda local y avisa por qué', async () => {
    const nube = { asignarContador: jest.fn().mockRejectedValue(new Error('Ese contador está suspendido.')) };
    const { a } = app(nube);
    const r = await request(a).post('/api/platform/asignar-contador').send({ contador_id: 'c2' });
    expect(r.body.ok).toBe(true);
    expect(r.body.syncWarning).toMatch(/suspendido/);
  });

  test('desvincular también va por la nube', async () => {
    const nube = { asignarContador: jest.fn().mockResolvedValue({ contadorId: null }) };
    const { a } = app(nube);
    await request(a).post('/api/platform/desvincular-contador').send({});
    expect(nube.asignarContador).toHaveBeenCalledWith(null);
  });
});

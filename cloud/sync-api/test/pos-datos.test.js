'use strict';

/**
 * Lo que la PC vinculada pide a la nube para subir sus datos sin la llave
 * completa (credencial de Firestore y contador) y la búsqueda pública de
 * contadores del asistente. Firestore en memoria: no hace falta el emulador.
 * Desde cloud/sync-api: npx jest test/pos-datos
 */

const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../lib/app');

function firestoreFalso(datos = {}) {
  const colecciones = new Map(Object.entries(datos).map(([c, docs]) => [c, new Map(Object.entries(docs))]));
  const col = (nombre) => {
    if (!colecciones.has(nombre)) colecciones.set(nombre, new Map());
    return colecciones.get(nombre);
  };
  const snapDoc = (nombre, id) => ({ id, exists: col(nombre).has(id), data: () => col(nombre).get(id) });
  const lecturas = { contadores: 0 };
  return {
    _col: col,
    lecturas,
    collection: (nombre) => ({
      doc: (id) => ({
        get: async () => snapDoc(nombre, id),
        set: async (d, o = {}) => { col(nombre).set(id, o.merge ? { ...(col(nombre).get(id) || {}), ...d } : d); },
      }),
      get: async () => {
        if (nombre === 'contadores') lecturas.contadores += 1;
        return { docs: [...col(nombre).keys()].map((id) => snapDoc(nombre, id)) };
      },
    }),
  };
}

const LIC = 'pos_abc123';
const CREDENCIAL = {
  type: 'service_account', project_id: 'reporte-sistema-pos', private_key_id: 'k1',
  private_key: '-----BEGIN PRIVATE KEY-----\nfalsa\n-----END PRIVATE KEY-----\n',
  client_email: 'tecno-caja-pos-pc@reporte-sistema-pos.iam.gserviceaccount.com', client_id: '1',
  token_uri: 'https://oauth2.googleapis.com/token', auth_uri: 'no-se-entrega',
};

function equipo() {
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  return {
    deviceId: `npd_${crypto.randomBytes(16).toString('hex')}`,
    privateKey: keys.privateKey,
    publicKey,
    keyId: crypto.createHash('sha256').update(publicKey).digest('hex'),
  };
}

function firmado(pc, action, data = {}, at = Date.now()) {
  const payload = JSON.stringify({ action, at, licenseId: LIC, deviceId: pc.deviceId, ...data });
  return { payload, publicKey: pc.publicKey, signature: crypto.sign(null, Buffer.from(payload), pc.privateKey).toString('base64') };
}

describe('Sync API: datos de la PC vinculada', () => {
  let pc;
  let otra;
  let db;
  let app;
  let reloj;

  beforeEach(() => {
    pc = equipo();
    otra = equipo();
    reloj = new Date();
    db = firestoreFalso({
      licencias: {
        [LIC]: {
          businessName: 'Colmado Uno', ownerEmail: 'dueno@uno.do', status: 'active',
          devices: { [pc.deviceId]: { status: 'active' }, [otra.deviceId]: { status: 'released' } },
          posInstallations: { [pc.keyId]: { deviceId: pc.deviceId }, [otra.keyId]: { deviceId: otra.deviceId } },
        },
      },
      contadores: {
        c1: { nombre_firma: 'Victor Contadores SRL', responsable: 'Víctor Pérez', rnc: '131000001', telefono: '8095550001', correo: 'victor@conta.do', logo_url: 'https://img/logo.png', estado: 'activo', clave: 'NO-SALE', plan: 'pro' },
        c2: { nombre_firma: 'Vicky Fiscal', rnc: '131000002', estado: 'suspendido' },
        c3: { nombre_firma: 'Asesores Martínez', correo: 'info@martinez.do', logo_url: 'javascript:alert(1)' },
      },
    });
    app = createApp({ db, now: () => reloj, almacen: null, secretoRespaldos: '', verificarIdToken: async () => ({}), posCredential: JSON.stringify(CREDENCIAL) });
  });

  describe('credencial de datos', () => {
    test('la PC vinculada la recibe, sin campos de más', async () => {
      const r = await request(app).post('/v1/pos/credential').send(firmado(pc, 'credential'));
      expect(r.status).toBe(200);
      expect(r.body.licenseId).toBe(LIC);
      expect(r.body.serviceAccount.client_email).toBe(CREDENCIAL.client_email);
      expect(r.body.serviceAccount.private_key).toBe(CREDENCIAL.private_key);
      expect(r.body.serviceAccount.auth_uri).toBeUndefined();
    });

    test('un equipo liberado no la recibe', async () => {
      const r = await request(app).post('/v1/pos/credential').send(firmado(otra, 'credential'));
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('EQUIPO_REVOCADO');
      expect(JSON.stringify(r.body)).not.toContain('PRIVATE KEY');
    });

    test('un equipo que no está vinculado no la recibe', async () => {
      const r = await request(app).post('/v1/pos/credential').send(firmado(equipo(), 'credential'));
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('EQUIPO_NO_REGISTRADO');
    });

    test('la firma de otra acción no sirve', async () => {
      const r = await request(app).post('/v1/pos/credential').send(firmado(pc, 'license'));
      expect(r.status).toBe(401);
    });

    test('sin credencial configurada responde 503 y la PC sigue igual', async () => {
      const sin = createApp({ db, now: () => reloj, almacen: null, secretoRespaldos: '', verificarIdToken: async () => ({}), posCredential: '' });
      const r = await request(sin).post('/v1/pos/credential').send(firmado(pc, 'credential'));
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('CREDENCIAL_NO_CONFIGURADA');
    });
  });

  describe('contador del negocio', () => {
    test('lo vincula con el nombre que tiene en la nube', async () => {
      const r = await request(app).post('/v1/pos/contador').send(firmado(pc, 'contador', { contadorId: 'c1' }));
      expect(r.status).toBe(200);
      expect(db._col('licencias').get(LIC)).toMatchObject({ contadorId: 'c1', contadorNombre: 'Victor Contadores SRL', businessStructureMode: 'accountant_client' });
    });

    test('sin contadorId lo desvincula', async () => {
      await request(app).post('/v1/pos/contador').send(firmado(pc, 'contador', { contadorId: 'c1' }));
      const r = await request(app).post('/v1/pos/contador').send(firmado(pc, 'contador', { contadorId: '' }));
      expect(r.status).toBe(200);
      expect(db._col('licencias').get(LIC)).toMatchObject({ contadorId: null, contadorNombre: null, businessStructureMode: 'independent' });
    });

    test('no acepta un contador que no existe o está suspendido', async () => {
      const noExiste = await request(app).post('/v1/pos/contador').send(firmado(pc, 'contador', { contadorId: 'zz' }));
      expect(noExiste.status).toBe(404);
      const suspendido = await request(app).post('/v1/pos/contador').send(firmado(pc, 'contador', { contadorId: 'c2' }));
      expect(suspendido.status).toBe(409);
      expect(db._col('licencias').get(LIC).contadorId).toBeUndefined();
    });

    test('un equipo liberado no lo cambia', async () => {
      const r = await request(app).post('/v1/pos/contador').send(firmado(otra, 'contador', { contadorId: 'c1' }));
      expect(r.status).toBe(403);
      expect(db._col('licencias').get(LIC).contadorId).toBeUndefined();
    });
  });

  describe('búsqueda de contadores', () => {
    test('busca por nombre, sin suspendidos y solo con los datos de contacto', async () => {
      const r = await request(app).get('/v1/contadores/buscar').query({ q: 'vic' });
      expect(r.status).toBe(200);
      expect(r.body.contadores).toEqual([{
        id: 'c1', nombre_firma: 'Victor Contadores SRL', responsable: 'Víctor Pérez', rnc: '131000001',
        telefono: '8095550001', correo: 'victor@conta.do', logo_url: 'https://img/logo.png',
      }]);
    });

    test('busca por RNC y correo; un logo que no es https no sale', async () => {
      const porRnc = await request(app).get('/v1/contadores/buscar').query({ q: '131000001' });
      expect(porRnc.body.contadores.map((c) => c.id)).toEqual(['c1']);
      const porCorreo = await request(app).get('/v1/contadores/buscar').query({ q: 'martinez.do' });
      expect(porCorreo.body.contadores).toHaveLength(1);
      expect(porCorreo.body.contadores[0].logo_url).toBeNull();
    });

    test('con menos de 2 letras no busca', async () => {
      const r = await request(app).get('/v1/contadores/buscar').query({ q: 'v' });
      expect(r.body.contadores).toEqual([]);
      expect(db.lecturas.contadores).toBe(0);
    });

    test('lee Firestore una vez por minuto', async () => {
      await request(app).get('/v1/contadores/buscar').query({ q: 'vic' });
      await request(app).get('/v1/contadores/buscar').query({ q: 'ase' });
      expect(db.lecturas.contadores).toBe(1);
      reloj = new Date(reloj.getTime() + 61000);
      await request(app).get('/v1/contadores/buscar').query({ q: 'ase' });
      expect(db.lecturas.contadores).toBe(2);
    });

    test('limita las búsquedas por IP', async () => {
      let ultima;
      for (let i = 0; i < 41; i += 1) ultima = await request(app).get('/v1/contadores/buscar').query({ q: 'vic' });
      expect(ultima.status).toBe(429);
    });
  });
});

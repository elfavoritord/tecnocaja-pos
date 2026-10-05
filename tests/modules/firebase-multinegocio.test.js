'use strict';

/**
 * tests/modules/firebase-multinegocio.test.js
 *
 * Todos los clientes escriben en el MISMO proyecto Firebase. Los IDs locales
 * (cliente #1, usuario #1) y los nombres de negocio se repiten entre clientes,
 * así que nada puede identificarse solo por eso: ni al sincronizar ni al
 * borrar en el formateo.
 */

// ── Firestore falso con colecciones planas, subcolecciones y batch ───────────

function createFakeFirestore(seed = {}) {
  const store = new Map();
  for (const [name, docs] of Object.entries(seed)) {
    store.set(name, new Map(Object.entries(docs).map(([id, data]) => [id, { ...data }])));
  }
  const col = (path) => {
    if (!store.has(path)) store.set(path, new Map());
    return store.get(path);
  };

  function snapshotOf(path, id) {
    const data = col(path).get(id);
    return { id, exists: Boolean(data), ref: docRef(path, id), data: () => (data ? { ...data } : undefined) };
  }

  function docRef(path, id) {
    return {
      id,
      path: `${path}/${id}`,
      get: async () => snapshotOf(path, id),
      set: async (data, opts) => {
        col(path).set(id, { ...(opts?.merge ? col(path).get(id) || {} : {}), ...data });
      },
      update: async (data) => {
        if (!col(path).has(id)) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
        col(path).set(id, { ...col(path).get(id), ...data });
      },
      delete: async () => { col(path).delete(id); },
      collection: (sub) => collectionRef(`${path}/${id}/${sub}`),
      listCollections: async () => [...store.keys()]
        .filter((key) => key.startsWith(`${path}/${id}/`) && key.split('/').length === path.split('/').length + 2)
        .map((key) => collectionRef(key)),
    };
  }

  function queryRef(path, filters = []) {
    return {
      where: (field, op, value) => queryRef(path, [...filters, { field, op, value }]),
      get: async () => {
        const docs = [...col(path).keys()]
          .filter((id) => filters.every(({ field, op, value }) => {
            const fieldValue = col(path).get(id)[field];
            if (op === '==') return fieldValue === value;
            if (op === 'array-contains') return Array.isArray(fieldValue) && fieldValue.includes(value);
            throw new Error(`operador no soportado: ${op}`);
          }))
          .map((id) => snapshotOf(path, id));
        return { empty: docs.length === 0, docs };
      },
    };
  }

  function collectionRef(path) {
    return { ...queryRef(path), id: path.split('/').pop(), doc: (id) => docRef(path, id) };
  }

  return {
    store,
    docs: (path) => Object.fromEntries(col(path)),
    firestore: {
      collection: (name) => collectionRef(name),
      batch: () => {
        const ops = [];
        return {
          set: (ref, data, opts) => ops.push(() => ref.set(data, opts)),
          delete: (ref) => ops.push(() => ref.delete()),
          commit: async () => { for (const op of ops) await op(); },
        };
      },
    },
  };
}

function loadModule(fake, { deletedAuthUids = [] } = {}) {
  jest.doMock('firebase-admin', () => ({
    apps: [{}],
    app: () => ({
      firestore: () => fake.firestore,
      auth: () => ({
        deleteUser: jest.fn(async (uid) => { deletedAuthUids.push(uid); }),
        getUserByEmail: jest.fn(async () => {
          throw Object.assign(new Error('not found'), { code: 'auth/user-not-found' });
        }),
      }),
    }),
  }));
  return require('../../modules/firebase-admin');
}

describe('Firebase multinegocio — sin mezclar ni borrar datos de otro cliente', () => {
  let envSnapshot;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{}';
    delete process.env.TECNO_CAJA_BUSINESS_ID;
    jest.resetModules();
  });

  afterEach(() => {
    process.env = envSnapshot;
    jest.dontMock('firebase-admin');
  });

  test('el cliente #1 de dos negocios queda en documentos distintos', async () => {
    const fake = createFakeFirestore();
    const admin = loadModule(fake);

    process.env.TECNO_CAJA_LICENSE_UID = 'pos_aaa';
    await admin.syncPosClientsToFirestore([{ id: 1, nombre: 'Juan de A' }], { nombre: 'Colmado' });
    process.env.TECNO_CAJA_LICENSE_UID = 'pos_bbb';
    await admin.syncPosClientsToFirestore([{ id: 1, nombre: 'Pedro de B' }], { nombre: 'Colmado' });

    const docs = fake.docs('pos_clientes');
    expect(docs.pos_pos_aaa_1).toMatchObject({ nombre: 'Juan de A', licenseId: 'pos_aaa' });
    expect(docs.pos_pos_bbb_1).toMatchObject({ nombre: 'Pedro de B', licenseId: 'pos_bbb' });
  });

  test('sin licencia no sube clientes a un documento compartido', async () => {
    const fake = createFakeFirestore();
    const admin = loadModule(fake);
    delete process.env.TECNO_CAJA_LICENSE_UID;

    const result = await admin.syncPosClientsToFirestore([{ id: 1, nombre: 'Ana' }], { nombre: 'Colmado' });
    expect(result).toMatchObject({ skipped: true, total: 0 });
    expect(fake.docs('pos_clientes')).toEqual({});
  });

  test('borrar el cliente #5 no borra el cliente #5 de otro negocio', async () => {
    const fake = createFakeFirestore({
      pos_clientes: {
        pos_5: { nombre: 'Cliente viejo de otro negocio' },
        pos_pos_aaa_5: { nombre: 'Mío', licenseId: 'pos_aaa' },
        pos_pos_bbb_5: { nombre: 'De B', licenseId: 'pos_bbb' },
      },
    });
    const admin = loadModule(fake);
    process.env.TECNO_CAJA_LICENSE_UID = 'pos_aaa';

    await admin.deletePosClientFromFirestore(5);
    expect(Object.keys(fake.docs('pos_clientes')).sort()).toEqual(['pos_5', 'pos_pos_bbb_5']);
  });

  test('sincronizar usuarios no borra licencia ni usuarios de otro negocio con el mismo nombre', async () => {
    const fake = createFakeFirestore({
      licencias: {
        pos_bbb: { source: 'pos', businessKey: 'pos:tecno-caja-colmado', businessName: 'Colmado', status: 'active' },
      },
      usuarios: {
        pos_user_pos_bbb_1: { source: 'pos', businessKey: 'pos:tecno-caja-colmado', principalUid: 'pos_bbb', localUserId: '1' },
        // Documento viejo compartido que escribió ESTE negocio la última vez
        pos_user_1: { source: 'pos', businessKey: 'pos:tecno-caja-colmado', principalUid: 'pos_aaa', localUserId: '1' },
      },
    });
    const admin = loadModule(fake);
    process.env.TECNO_CAJA_LICENSE_UID = 'pos_aaa';

    const result = await admin.syncPosAccountsToFirestore(
      [{ id: 1, nombre: 'Admin A', usuario: 'admin', rol: 'Administrador', estado: 'Activo' }],
      { nombre: 'Colmado', licenseStatus: 'trial' },
    );

    expect(result.licenseDocId).toBe('pos_aaa');
    expect(result.ownerDocId).toBe('pos_user_pos_aaa_1');
    expect(fake.docs('licencias').pos_bbb).toBeDefined();
    const usuarios = fake.docs('usuarios');
    expect(usuarios.pos_user_pos_bbb_1).toBeDefined();
    expect(usuarios.pos_user_pos_aaa_1).toMatchObject({ principalUid: 'pos_aaa', licenseId: 'pos_aaa' });
    expect(usuarios.pos_user_1).toBeUndefined();
  });

  test('el usuario "admin" de otro negocio con el mismo nombre no es un conflicto', async () => {
    const fake = createFakeFirestore({
      usuarios: {
        pos_user_pos_bbb_1: {
          source: 'pos', businessKey: 'pos:tecno-caja-colmado', principalUid: 'pos_bbb',
          localUserId: '1', usernameNormalized: 'admin',
        },
      },
    });
    const admin = loadModule(fake);

    await expect(admin.assertNoFirebaseIdentityConflicts({
      businessName: 'Colmado',
      username: 'admin',
      currentLicenseUid: 'pos_aaa',
      currentLocalUserId: 1,
    })).resolves.toMatchObject({ checked: true });
  });

  test('el formateo borra solo lo de su licencia', async () => {
    const fake = createFakeFirestore({
      licencias: {
        pos_aaa: { source: 'pos', businessKey: 'pos:tecno-caja-colmado', businessName: 'Colmado' },
        pos_bbb: { source: 'pos', businessKey: 'pos:tecno-caja-colmado', businessName: 'Colmado' },
      },
      usuarios: {
        pos_aaa: { source: 'pos', recordKind: 'account', principalUid: 'pos_aaa', businessKey: 'pos:tecno-caja-colmado' },
        pos_user_pos_aaa_1: { source: 'pos', principalUid: 'pos_aaa', businessKey: 'pos:tecno-caja-colmado', firebaseUid: 'auth-a' },
        pos_user_pos_bbb_1: { source: 'pos', principalUid: 'pos_bbb', businessKey: 'pos:tecno-caja-colmado', firebaseUid: 'auth-b' },
        // Mismo correo (misma cuenta Firebase) dado de alta en los dos negocios
        pos_user_pos_aaa_2: { source: 'pos', principalUid: 'pos_aaa', businessKey: 'pos:tecno-caja-colmado', firebaseUid: 'auth-compartida' },
        pos_user_pos_bbb_2: { source: 'pos', principalUid: 'pos_bbb', businessKey: 'pos:tecno-caja-colmado', firebaseUid: 'auth-compartida' },
      },
      codigos: {
        CODA: { source: 'pos', principalUid: 'pos_aaa', businessKey: 'pos:tecno-caja-colmado' },
        CODB: { source: 'pos', principalUid: 'pos_bbb', businessKey: 'pos:tecno-caja-colmado' },
      },
      pos_clientes: {
        pos_pos_aaa_1: { licenseId: 'pos_aaa', businessName: 'Colmado' },
        pos_pos_bbb_1: { licenseId: 'pos_bbb', businessName: 'Colmado' },
      },
      users: {
        'auth-reportes-a': { businessId: 'pos_aaa', businessIds: ['pos_aaa'] },
        'auth-reportes-ambos': { businessId: 'pos_aaa', businessIds: ['pos_aaa', 'pos_bbb'] },
      },
      businesses: { pos_aaa: { nombre: 'A' }, pos_bbb: { nombre: 'B' } },
      'businesses/pos_aaa/sales': { v1: { total: 1 } },
      'businesses/pos_bbb/sales': { v1: { total: 2 } },
    });
    const deletedAuthUids = [];
    const admin = loadModule(fake, { deletedAuthUids });

    await admin.purgePosBusinessFromFirebase({
      businessName: 'Colmado',
      businessId: 'pos_aaa',
      licenseUid: 'pos_aaa',
      authUids: ['auth-a', 'auth-compartida'],
    });

    expect(Object.keys(fake.docs('licencias'))).toEqual(['pos_bbb']);
    expect(Object.keys(fake.docs('usuarios')).sort()).toEqual(['pos_user_pos_bbb_1', 'pos_user_pos_bbb_2']);
    expect(Object.keys(fake.docs('codigos'))).toEqual(['CODB']);
    expect(Object.keys(fake.docs('pos_clientes'))).toEqual(['pos_pos_bbb_1']);
    expect(Object.keys(fake.docs('businesses'))).toEqual(['pos_bbb']);
    expect(fake.docs('businesses/pos_aaa/sales')).toEqual({});
    expect(fake.docs('businesses/pos_bbb/sales')).toEqual({ v1: { total: 2 } });
    // Usuario de reportes que también trabaja para B: se le quita A, no se borra
    expect(fake.docs('users')['auth-reportes-ambos']).toMatchObject({ businessId: 'pos_bbb', businessIds: ['pos_bbb'] });
    expect(fake.docs('users')['auth-reportes-a']).toBeUndefined();
    expect(deletedAuthUids.sort()).toEqual(['auth-a', 'auth-reportes-a']);
  });

  test('el formateo no borra un espacio por nombre que usa otra licencia', async () => {
    const fake = createFakeFirestore({
      licencias: {
        pos_bbb: { source: 'pos', businessKey: 'pos:tecno-caja-colmado', businessName: 'Colmado' },
      },
      businesses: { 'pos:tecno-caja-colmado': { nombre: 'compartido' } },
      'businesses/pos:tecno-caja-colmado/sales': { v1: { total: 2 } },
    });
    const admin = loadModule(fake);

    const result = await admin.purgePosBusinessFromFirebase({
      businessName: 'Colmado',
      businessId: 'pos:tecno-caja-colmado',
      licenseUid: '',
    });

    expect(result.skippedSharedBusinessId).toBe(true);
    expect(fake.docs('businesses')['pos:tecno-caja-colmado']).toBeDefined();
    expect(fake.docs('businesses/pos:tecno-caja-colmado/sales')).toEqual({ v1: { total: 2 } });
    expect(fake.docs('licencias').pos_bbb).toBeDefined();
  });
});

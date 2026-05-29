'use strict';

function createDocSnapshot(collectionName, id, data = {}) {
  return {
    id,
    exists: true,
    ref: { id, collectionName },
    data: () => ({ ...data }),
  };
}

function createMockFirestore(initialStore = {}) {
  const store = {
    usuarios: { ...(initialStore.usuarios || {}) },
    licencias: { ...(initialStore.licencias || {}) },
    codigos: { ...(initialStore.codigos || {}) },
  };
  const operations = [];

  function buildDocs(collectionName, filters = []) {
    const entries = Object.entries(store[collectionName] || {});
    return entries
      .filter(([, data]) => filters.every((filter) => {
        if (filter.op !== '==') return true;
        return (data?.[filter.field] ?? null) === filter.value;
      }))
      .map(([id, data]) => createDocSnapshot(collectionName, id, data));
  }

  function createQuery(collectionName, filters = []) {
    return {
      where(field, op, value) {
        return createQuery(collectionName, filters.concat([{ field, op, value }]));
      },
      async get() {
        const docs = buildDocs(collectionName, filters);
        return {
          empty: docs.length === 0,
          docs,
        };
      },
    };
  }

  function createDocRef(collectionName, id) {
    return {
      id,
      collectionName,
      async get() {
        const data = store[collectionName]?.[id];
        return data
          ? createDocSnapshot(collectionName, id, data)
          : {
              id,
              exists: false,
              ref: { id, collectionName },
              data: () => undefined,
            };
      },
    };
  }

  return {
    operations,
    firestore: {
      batch() {
        return {
          set(ref, data, options) {
            operations.push({ type: 'set', ref, data, options });
          },
          delete(ref) {
            operations.push({ type: 'delete', ref });
          },
          async commit() {
            return true;
          },
        };
      },
      collection(collectionName) {
        return {
          doc(id) {
            return createDocRef(collectionName, id);
          },
          where(field, op, value) {
            return createQuery(collectionName, [{ field, op, value }]);
          },
        };
      },
    },
  };
}

describe('modules/firebase-admin', () => {
  let envSnapshot;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    delete process.env.TECNO_CAJA_LICENSE_UID;
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{}';
    jest.resetModules();
  });

  afterEach(() => {
    process.env = envSnapshot;
    jest.dontMock('firebase-admin');
  });

  it('prioriza la licencia activa cuando hay duplicados para el mismo negocio', () => {
    const { chooseBestLicenseDocument } = require('../../modules/firebase-admin');
    const docs = [
      createDocSnapshot('licencias', 'pos_user_1', {
        businessKey: 'pos:demo',
        status: 'trial',
        updatedAt: '2026-05-01T10:00:00.000Z',
      }),
      createDocSnapshot('licencias', 'pos_user_14', {
        businessKey: 'pos:demo',
        status: 'active',
        planCode: 'plus',
        updatedAt: '2026-05-01T08:00:00.000Z',
      }),
    ];

    const selected = chooseBestLicenseDocument(docs);

    expect(selected?.id).toBe('pos_user_14');
  });

  it('respeta TECNO_CAJA_LICENSE_UID configurado aunque exista otra licencia mejor para el mismo nombre', async () => {
    const mockFirestore = createMockFirestore({
      licencias: {
        pos_user_1: {
          source: 'pos',
          businessKey: 'pos:demo-pos',
          businessName: 'Demo POS',
          status: 'trial',
          updatedAt: '2026-05-01T11:00:00.000Z',
        },
        pos_user_14: {
          source: 'pos',
          businessKey: 'pos:demo-pos',
          businessName: 'Demo POS',
          status: 'active',
          planCode: 'plus',
          updatedAt: '2026-05-01T09:00:00.000Z',
        },
      },
    });
    process.env.TECNO_CAJA_LICENSE_UID = 'pos_user_1';

    jest.doMock('firebase-admin', () => ({
      apps: [{}],
      app: () => ({
        firestore: () => mockFirestore.firestore,
      }),
    }));

    const { syncPosAccountsToFirestore } = require('../../modules/firebase-admin');
    const result = await syncPosAccountsToFirestore(
      [
        { id: 1, nombre: 'Administrador', usuario: 'admin', rol: 'Administrador', estado: 'Activo' },
      ],
      {
        nombre: 'Demo POS',
        licenseStatus: 'active',
        planCode: 'plus',
        planName: 'Tecno Caja Plus',
        businessStructureMode: 'multisucursal',
      }
    );

    const licenseSetOperations = mockFirestore.operations.filter(
      (entry) => entry.type === 'set' && entry.ref.collectionName === 'licencias'
    );
    const deletedLicenseIds = mockFirestore.operations
      .filter((entry) => entry.type === 'delete' && entry.ref.collectionName === 'licencias')
      .map((entry) => entry.ref.id);

    expect(result.licenseDocId).toBe('pos_user_1');
    expect(licenseSetOperations).toHaveLength(1);
    expect(licenseSetOperations[0].ref.id).toBe('pos_user_1');
    expect(deletedLicenseIds).toHaveLength(0);
  });

  it('fetchRemotePosLicenseState usa TECNO_CAJA_LICENSE_UID como fuente autoritativa', async () => {
    const mockFirestore = createMockFirestore({
      licencias: {
        pos_user_1: {
          source: 'pos',
          businessKey: 'pos:demo-pos',
          businessName: 'Demo POS',
          status: 'trial',
          updatedAt: '2026-05-01T11:00:00.000Z',
        },
        pos_user_14: {
          source: 'pos',
          businessKey: 'pos:demo-pos',
          businessName: 'Demo POS',
          status: 'active',
          planCode: 'plus',
          updatedAt: '2026-05-01T09:00:00.000Z',
        },
      },
    });
    process.env.TECNO_CAJA_LICENSE_UID = 'pos_user_1';

    jest.doMock('firebase-admin', () => ({
      apps: [{}],
      app: () => ({
        firestore: () => mockFirestore.firestore,
      }),
    }));

    const { fetchRemotePosLicenseState } = require('../../modules/firebase-admin');
    const remoteState = await fetchRemotePosLicenseState({ business_name: 'Demo POS' });

    expect(remoteState?.id).toBe('pos_user_1');
    expect(remoteState?.status).toBe('trial');
  });

  it('bloquea reutilizar el mismo nombre comercial si ya existe otra licencia en Firebase', async () => {
    const mockFirestore = createMockFirestore({
      licencias: {
        pos_user_14: {
          source: 'pos',
          businessKey: 'pos:tecno-caja-demo-pos',
          businessName: 'Demo POS',
          status: 'active',
        },
      },
    });

    jest.doMock('firebase-admin', () => ({
      apps: [{}],
      app: () => ({
        firestore: () => mockFirestore.firestore,
        auth: () => ({
          getUserByEmail: jest.fn(async () => {
            const error = new Error('not found');
            error.code = 'auth/user-not-found';
            throw error;
          }),
        }),
      }),
    }));

    const { assertNoFirebaseIdentityConflicts } = require('../../modules/firebase-admin');

    await expect(
      assertNoFirebaseIdentityConflicts({ businessName: 'Demo POS' })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'FIREBASE_IDENTITY_CONFLICT',
    });
  });

  it('bloquea reutilizar el mismo usuario o correo dentro del mismo negocio en Firebase', async () => {
    const mockFirestore = createMockFirestore({
      usuarios: {
        pos_user_14: {
          source: 'pos',
          businessKey: 'pos:demo-pos',
          localUserId: '14',
          usernameNormalized: 'admin',
          emailNormalized: 'admin@demo.pos',
          firebaseUid: 'firebase_uid_14',
        },
      },
    });

    jest.doMock('firebase-admin', () => ({
      apps: [{}],
      app: () => ({
        firestore: () => mockFirestore.firestore,
        auth: () => ({
          getUserByEmail: jest.fn(async () => ({
            uid: 'firebase_uid_14',
            email: 'admin@demo.pos',
          })),
        }),
      }),
    }));

    const { assertNoFirebaseIdentityConflicts } = require('../../modules/firebase-admin');

    await expect(
      assertNoFirebaseIdentityConflicts({
        businessName: 'Demo POS',
        username: 'admin',
        email: 'admin@demo.pos',
        currentLocalUserId: 99,
        currentFirebaseUid: 'firebase_uid_99',
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'FIREBASE_IDENTITY_CONFLICT',
    });
  });
});

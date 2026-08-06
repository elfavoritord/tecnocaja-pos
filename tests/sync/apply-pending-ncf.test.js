'use strict';

function createPendingDoc(data) {
  return {
    data: () => data,
    ref: {
      update: jest.fn(async () => {}),
    },
  };
}

describe('apply-pending-ncf', () => {
  let pendingDoc;

  beforeEach(() => {
    jest.resetModules();
    process.env.TECNO_CAJA_LICENSE_UID = 'pos_demo_1';
    pendingDoc = createPendingDoc({
      action: 'create',
      documentType: 'B01',
      startNumber: 1,
      endNumber: 100,
      authorizationReference: 'DGII-123',
      branchId: 2,
      contadorNombre: 'VICRIS',
    });

    jest.doMock('../../modules/firebase-admin', () => ({
      getFirestore: () => ({
        collection: () => ({
          doc: () => ({
            collection: () => ({
              where: () => ({
                get: async () => ({ empty: false, docs: [pendingDoc] }),
              }),
            }),
          }),
        }),
      }),
    }));
  });

  afterEach(() => {
    delete process.env.TECNO_CAJA_LICENSE_UID;
    jest.dontMock('../../modules/firebase-admin');
  });

  it('marca como aplicada una solicitud NCF si el mismo rango ya existe en la sucursal', async () => {
    const { createApplyPendingNcfService } = require('../../server/sync/apply-pending-ncf');
    const query = jest.fn(async (sql) => {
      const text = String(sql || '');
      if (text.includes('FROM branches')) return [{ id: 2 }];
      if (text.includes('FROM ncf_authorized_sequences') && text.includes('start_number = ?')) {
        return [{ id: 88, branch_id: 2, document_type: 'B01', start_number: 1, end_number: 100 }];
      }
      return [];
    });
    const writeAuditLog = jest.fn(async () => {});

    const service = createApplyPendingNcfService({
      query,
      withTransaction: jest.fn(),
      writeAuditLog,
      isMysqlDeployment: () => true,
      attachmentsDir: '',
      attachmentsWebPath: '/uploads/comprobantes-fiscales',
    });

    const result = await service.applyPendingNcfRequests();

    expect(result).toEqual({ ok: true, applied: 1, failed: 0 });
    expect(query).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO ncf_authorized_sequences/i), expect.anything());
    expect(pendingDoc.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'aplicado',
      localSequenceId: 88,
      duplicateResolved: true,
    }));
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actionName: 'duplicate_from_contador',
    }));
  });

  it('rechaza una solicitud NCF local si la sucursal indicada ya no existe', async () => {
    const { createApplyPendingNcfService } = require('../../server/sync/apply-pending-ncf');
    const query = jest.fn(async (sql) => {
      const text = String(sql || '');
      if (text.includes('FROM branches')) return [];
      return [];
    });

    const service = createApplyPendingNcfService({
      query,
      withTransaction: jest.fn(),
      writeAuditLog: jest.fn(),
      isMysqlDeployment: () => true,
      attachmentsDir: '',
      attachmentsWebPath: '/uploads/comprobantes-fiscales',
    });

    const result = await service.applyPendingNcfRequests();

    expect(result).toEqual({ ok: true, applied: 0, failed: 1 });
    expect(query).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO ncf_authorized_sequences/i), expect.anything());
    expect(pendingDoc.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      errorMessage: expect.stringContaining('La sucursal seleccionada (2)'),
    }));
  });

  it('rechaza una solicitud NCF local si se cruza con un rango global existente', async () => {
    const { createApplyPendingNcfService } = require('../../server/sync/apply-pending-ncf');
    const query = jest.fn(async (sql) => {
      const text = String(sql || '');
      if (text.includes('FROM branches')) return [{ id: 2 }];
      if (text.includes('start_number = ?')) return [];
      if (text.includes('NOT (end_number < ? OR start_number > ?)')) {
        return [{ id: 77, branch_id: null, document_type: 'B01', start_number: 50, end_number: 150 }];
      }
      return [];
    });

    const service = createApplyPendingNcfService({
      query,
      withTransaction: jest.fn(),
      writeAuditLog: jest.fn(),
      isMysqlDeployment: () => true,
      attachmentsDir: '',
      attachmentsWebPath: '/uploads/comprobantes-fiscales',
    });

    const result = await service.applyPendingNcfRequests();

    expect(result).toEqual({ ok: true, applied: 0, failed: 1 });
    expect(query).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO ncf_authorized_sequences/i), expect.anything());
    expect(pendingDoc.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      errorMessage: expect.stringContaining('Se cruza con la autorización'),
    }));
  });
});

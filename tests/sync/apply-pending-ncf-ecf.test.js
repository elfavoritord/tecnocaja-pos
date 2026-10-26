'use strict';

/**
 * Rangos e-NCF (E31-E47) que el contador registra desde su portal: el POS los
 * aplica en las secuencias de producción de la factura electrónica
 * (ecf_sequences, ambiente 'ecf'), con las mismas reglas que al subir el
 * archivo de la DGII en Configuración → Secuencias de Comprobantes Electrónicos.
 */

const initSqlJs = require('sql.js');

jest.mock('../../db', () => ({ getDbClient: () => 'sqlite' }));

function docPendiente(data) {
  return { data: () => data, ref: { update: jest.fn(async () => {}) } };
}

let mockCola = [];
jest.mock('../../modules/firebase-admin', () => ({
  getFirestore: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          where: () => ({ get: async () => ({ empty: !mockCola.length, docs: mockCola }) }),
        }),
      }),
    }),
  }),
}));

const { EcfRepository } = require('../../modules/ecf/models/ecf.repository');
const { createApplyPendingNcfService } = require('../../server/sync/apply-pending-ncf');
const { mapEcfSequenceReadOnly } = require('../../server/routes/fiscal-sequences.routes');

async function crearPos() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const query = async (sql, params = []) => {
    const text = String(sql).trim();
    const stmt = db.prepare(text);
    stmt.bind(params.map((value) => (value === undefined ? null : value)));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    if (/^(INSERT|UPDATE|DELETE)/i.test(text)) {
      return { insertId: db.exec('SELECT last_insert_rowid()')[0].values[0][0], affectedRows: db.getRowsModified() };
    }
    return rows;
  };
  const withTransaction = async (work) => work({ query });
  const repo = new EcfRepository({ query, withTransaction });
  const writeAuditLog = jest.fn(async () => {});
  const servicio = createApplyPendingNcfService({
    query, withTransaction, writeAuditLog, isMysqlDeployment: () => false,
    attachmentsDir: '', attachmentsWebPath: '/uploads/comprobantes-fiscales', ecfRepository: repo,
  });
  return { query, repo, servicio, writeAuditLog };
}

const E32 = {
  action: 'create', documentType: 'E32', startNumber: 1, endNumber: 100,
  authorizationReference: '6005604697', authorizationDate: '2026-10-25', contadorNombre: 'VICRIS',
};

beforeEach(() => {
  process.env.TECNO_CAJA_LICENSE_UID = 'pos_demo_1';
  mockCola = [];
});
afterEach(() => { delete process.env.TECNO_CAJA_LICENSE_UID; });

describe('mockCola del contador: rangos e-NCF', () => {
  test('el rango queda como secuencia de producción, con su autorización y su historial', async () => {
    const { query, repo, servicio } = await crearPos();
    const pedido = docPendiente(E32);
    mockCola = [pedido];

    expect(await servicio.applyPendingNcfRequests()).toEqual({ ok: true, applied: 1, failed: 0 });

    const [seq] = await query('SELECT id, tipo_comprobante, numero_inicial, numero_final, proximo_numero, environment, authorization_reference, fecha_autorizacion, activo FROM ecf_sequences');
    expect(seq).toMatchObject({
      tipo_comprobante: 'E32', numero_inicial: 1, numero_final: 100, proximo_numero: 1,
      environment: 'ecf', authorization_reference: '6005604697', fecha_autorizacion: '2026-10-25', activo: 1,
    });
    expect(pedido.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'aplicado', localSequenceId: `ecf-${seq.id}` }));
    const historial = await query("SELECT user_name, action_name, detail FROM ecf_audit_log WHERE sequence_id = ?", [seq.id]);
    expect(historial).toEqual([expect.objectContaining({ user_name: 'Contador: VICRIS', action_name: 'sequence_created' })]);
    expect(historial[0].detail).toMatch(/Portal del Contador/);

    // La factura electrónica ya saca el número de ese rango.
    expect(await repo.generateNextENCF({ tipoComprobante: 'E32', environment: 'ecf' })).toMatchObject({ encf: 'E320000000001' });
  });

  test('el mismo rango otra vez se liga sin duplicar; uno que se cruza se rechaza con el motivo', async () => {
    const { query, servicio } = await crearPos();
    mockCola = [docPendiente(E32)];
    await servicio.applyPendingNcfRequests();

    const repetido = docPendiente(E32);
    const cruzado = docPendiente({ ...E32, startNumber: 50, endNumber: 150 });
    mockCola = [repetido, cruzado];
    expect(await servicio.applyPendingNcfRequests()).toEqual({ ok: true, applied: 1, failed: 1 });

    expect(repetido.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'aplicado', duplicateResolved: true }));
    expect(cruzado.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error', errorMessage: expect.stringMatching(/Ya hay una secuencia E32 de producción/),
    }));
    expect(await query('SELECT COUNT(*) AS n FROM ecf_sequences')).toEqual([{ n: 1 }]);
  });

  test('sin fecha de autorización no se registra (la exige producción)', async () => {
    const { query, servicio } = await crearPos();
    const pedido = docPendiente({ ...E32, authorizationDate: null });
    mockCola = [pedido];

    expect(await servicio.applyPendingNcfRequests()).toEqual({ ok: true, applied: 0, failed: 1 });
    expect(pedido.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error', errorMessage: expect.stringMatching(/fecha en que la DGII autorizó/),
    }));
    expect(await query('SELECT COUNT(*) AS n FROM ecf_sequences')).toEqual([{ n: 0 }]);
  });

  test('un rango nuevo del mismo tipo espera a que se agote el que está en uso', async () => {
    const { repo, servicio } = await crearPos();
    mockCola = [docPendiente({ ...E32, startNumber: 101, endNumber: 200 }), docPendiente(E32)];
    await servicio.applyPendingNcfRequests();

    // Se usa primero el más bajo, aunque haya llegado después.
    expect(await repo.generateNextENCF({ tipoComprobante: 'E32', environment: 'ecf' })).toMatchObject({ encf: 'E320000000001' });
  });

  test('editar o suspender una e-NCF desde el portal no se aplica: se maneja en el POS', async () => {
    const { servicio } = await crearPos();
    const pedido = docPendiente({ action: 'suspend', targetLocalSequenceId: 'ecf-1', reason: 'x', contadorNombre: 'VICRIS' });
    mockCola = [pedido];

    await servicio.applyPendingNcfRequests();

    expect(pedido.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error', errorMessage: expect.stringMatching(/se administran en el POS/),
    }));
  });
});

describe('espejo de solo lectura para el portal', () => {
  const fila = {
    id: 7, business_id: 1, branch_id: null, tipo_comprobante: 'E32', numero_inicial: 1, numero_final: 100,
    proximo_numero: 101, activo: 1, fecha_vencimiento: null, authorization_reference: '6005604697',
  };

  test('nombre de la DGII y estado real (agotada, vencida, desactivada)', () => {
    expect(mapEcfSequenceReadOnly(fila)).toMatchObject({
      id: 'ecf-7', series: 'E', documentType: 'E32', documentName: 'Factura de Consumo Electrónica',
      totalAvailable: 0, status: 'activo', effectiveStatus: 'agotado', readOnly: true,
    });
    expect(mapEcfSequenceReadOnly({ ...fila, proximo_numero: 5, fecha_vencimiento: '2020-12-31' }).effectiveStatus).toBe('vencido');
    expect(mapEcfSequenceReadOnly({ ...fila, proximo_numero: 5, activo: 0 })).toMatchObject({ status: 'suspendido', effectiveStatus: 'suspendido' });
    expect(mapEcfSequenceReadOnly({ ...fila, proximo_numero: 5 }).effectiveStatus).toBe('activo');
  });
});

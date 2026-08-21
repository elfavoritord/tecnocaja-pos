'use strict';

const { createNcfSequenceService } = require('../server/services/ncf-sequence.service');

// Mock de `conn` compatible con lo que espera ncf-sequence.service.js: un
// objeto con .query(sql, params) — igual al patrón que usan los tests de e-CF
// (tests/ecf.sequence-high-watermark.test.js), sin base de datos real.
function createMockConn({ configRow, sequenceRow, engine = 'sqlite' } = {}) {
  const calls = [];
  let currentSeq = sequenceRow ? { ...sequenceRow } : null;
  const query = jest.fn(async (sql, params) => {
    calls.push({ sql: String(sql), params });
    const text = String(sql);
    if (text.includes('FROM config')) {
      return configRow ? [configRow] : [];
    }
    if (text.includes('FROM ncf_authorized_sequences') && text.startsWith('SELECT')) {
      // La query real filtra WHERE status = 'activo' — una secuencia agotada
      // o suspendida no debe volver a aparecer, igual que en la BD real.
      return currentSeq && currentSeq.status === 'activo' ? [currentSeq] : [];
    }
    if (text.includes('FROM ncf_sequences') && text.startsWith('SELECT')) {
      return currentSeq ? [currentSeq] : [];
    }
    if (text.startsWith('UPDATE ncf_authorized_sequences')) {
      if (text.includes("status = 'agotado'")) {
        // Marca de agotado al detectar next_number > end_number — solo [id].
        currentSeq = { ...currentSeq, status: 'agotado' };
      } else {
        // Asignación normal: SET next_number = ?, last_used_number = ?, status = ?, ... WHERE id = ?
        const [nextNumber, lastUsed, status] = params;
        currentSeq = { ...currentSeq, next_number: nextNumber, last_used_number: lastUsed, status };
      }
      return { affectedRows: 1 };
    }
    if (text.startsWith('UPDATE ncf_sequences')) {
      currentSeq = { ...currentSeq, siguiente_numero: currentSeq.siguiente_numero + 1 };
      return { affectedRows: 1 };
    }
    return [];
  });
  return { query, calls, engine, getState: () => currentSeq };
}

const isMysqlDeployment = jest.fn(() => false);

describe('ncf-sequence.service — asignación de NCF', () => {
  beforeEach(() => {
    isMysqlDeployment.mockReturnValue(false);
  });

  test('Prueba 1: nunca toca la tabla sales/invoice_number (FAC y NCF son independientes)', async () => {
    const service = createNcfSequenceService({ isMysqlDeployment });
    const conn = createMockConn({
      configRow: { ncf_authorized_sequences_v2_enabled: 1 },
      sequenceRow: {
        id: 1, document_type: 'B01', next_number: 1, end_number: 100,
        expiration_date: null, status: 'activo',
      },
    });

    await service.getNextNcf(conn, 'B01', null);

    expect(conn.calls.some((c) => /\bsales\b/i.test(c.sql) || /invoice_number/i.test(c.sql))).toBe(false);
  });

  test('Prueba 2: B01 avanza 1, 2, 3 en llamadas consecutivas', async () => {
    const service = createNcfSequenceService({ isMysqlDeployment });
    const conn = createMockConn({
      configRow: { ncf_authorized_sequences_v2_enabled: 1 },
      sequenceRow: {
        id: 1, document_type: 'B01', next_number: 1, end_number: 100,
        expiration_date: null, status: 'activo',
      },
    });

    const r1 = await service.getNextNcf(conn, 'B01', null);
    const r2 = await service.getNextNcf(conn, 'B01', null);
    const r3 = await service.getNextNcf(conn, 'B01', null);

    expect(r1.ncf).toBe('B0100000001');
    expect(r2.ncf).toBe('B0100000002');
    expect(r3.ncf).toBe('B0100000003');
  });

  test('Prueba 3/11: B02 tiene secuencia independiente de B01 (una no altera a la otra)', async () => {
    const service = createNcfSequenceService({ isMysqlDeployment });
    const connB01 = createMockConn({
      configRow: { ncf_authorized_sequences_v2_enabled: 1 },
      sequenceRow: { id: 1, document_type: 'B01', next_number: 5, end_number: 100, expiration_date: null, status: 'activo' },
    });
    const connB02 = createMockConn({
      configRow: { ncf_authorized_sequences_v2_enabled: 1 },
      sequenceRow: { id: 2, document_type: 'B02', next_number: 1, end_number: 50, expiration_date: null, status: 'activo' },
    });

    const b01 = await service.getNextNcf(connB01, 'B01', null);
    const b02 = await service.getNextNcf(connB02, 'B02', null);

    expect(b01.ncf).toBe('B0100000005');
    expect(b02.ncf).toBe('B0200000001');
    // El UPDATE de B01 solo tocó la fila id=1, nunca la id=2 de B02.
    const updateCallB01 = connB01.calls.find((c) => c.sql.startsWith('UPDATE ncf_authorized_sequences'));
    expect(updateCallB01.params[updateCallB01.params.length - 1]).toBe(1);
  });

  test('Prueba 4: usa FOR UPDATE en MySQL para el bloqueo transaccional (concurrencia)', async () => {
    isMysqlDeployment.mockReturnValue(true);
    const service = createNcfSequenceService({ isMysqlDeployment });
    const conn = createMockConn({
      configRow: { ncf_authorized_sequences_v2_enabled: 1 },
      sequenceRow: { id: 1, document_type: 'B01', next_number: 1, end_number: 100, expiration_date: null, status: 'activo' },
    });

    await service.getNextNcf(conn, 'B01', null);

    const selectCall = conn.calls.find((c) => c.sql.trim().startsWith('SELECT * FROM ncf_authorized_sequences'));
    expect(selectCall.sql).toMatch(/FOR UPDATE/);
    // NOTA: esto confirma que la query pide el lock de fila de MySQL, pero la
    // garantía real de "dos terminales nunca reciben el mismo número" depende
    // de que MySQL honre ese lock bajo una transacción real — no verificable
    // al 100% con un mock en memoria. Necesitaría una prueba de integración
    // contra una base MySQL real para cubrir el escenario completo.
  });

  test('Prueba 5/6: no pasa del rango autorizado y bloquea al agotarse', async () => {
    const service = createNcfSequenceService({ isMysqlDeployment });
    const conn = createMockConn({
      configRow: { ncf_authorized_sequences_v2_enabled: 1 },
      sequenceRow: { id: 1, document_type: 'B01', next_number: 15, end_number: 15, expiration_date: null, status: 'activo' },
    });

    const last = await service.getNextNcf(conn, 'B01', null);
    expect(last.ncf).toBe('B0100000015');
    expect(conn.getState().status).toBe('agotado');

    await expect(service.getNextNcf(conn, 'B01', null)).rejects.toThrow(/no hay secuencia activa/i);
  });

  test('Prueba 7: bloquea un rango vencido antes de asignar número', async () => {
    const service = createNcfSequenceService({ isMysqlDeployment });
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const conn = createMockConn({
      configRow: { ncf_authorized_sequences_v2_enabled: 1 },
      sequenceRow: { id: 1, document_type: 'B01', next_number: 1, end_number: 100, expiration_date: ayer, status: 'activo' },
    });

    await expect(service.getNextNcf(conn, 'B01', null)).rejects.toThrow(/venció/i);
    expect(conn.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  test('Prueba 15: el servicio de NCF serie B nunca toca tablas de e-CF (serie E)', async () => {
    const service = createNcfSequenceService({ isMysqlDeployment });
    const conn = createMockConn({
      configRow: { ncf_authorized_sequences_v2_enabled: 1 },
      sequenceRow: { id: 1, document_type: 'B01', next_number: 1, end_number: 100, expiration_date: null, status: 'activo' },
    });

    await service.getNextNcf(conn, 'B01', null);

    expect(conn.calls.some((c) => /ecf_sequences|ecf_documents/i.test(c.sql))).toBe(false);
  });
});

describe('ncf-sequence.service — alertas de secuencias (getSequencesWarningSummary)', () => {
  test('marca como bajo cuando quedan pocos disponibles', async () => {
    const service = createNcfSequenceService({ isMysqlDeployment });
    const query = jest.fn(async () => [
      { document_type: 'B01', next_number: 96, end_number: 100, expiration_date: null, branch_name: null },
      { document_type: 'B02', next_number: 1, end_number: 500, expiration_date: null, branch_name: null },
    ]);

    const warnings = await service.getSequencesWarningSummary(query, { expiryThresholdDays: 30, lowCountThreshold: 20 });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].tipoComprobante).toBe('B01');
    expect(warnings[0].disponibles).toBe(5);
    expect(warnings[0].isLow).toBe(true);
  });

  test('marca como vencida una secuencia con expiration_date pasada', async () => {
    const service = createNcfSequenceService({ isMysqlDeployment });
    const ayer = new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10);
    const query = jest.fn(async () => [
      { document_type: 'B02', next_number: 1, end_number: 500, expiration_date: ayer, branch_name: null },
    ]);

    const warnings = await service.getSequencesWarningSummary(query, { expiryThresholdDays: 30, lowCountThreshold: 20 });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].isExpired).toBe(true);
  });

  test('no reporta secuencias sanas (ni bajas ni por vencer)', async () => {
    const service = createNcfSequenceService({ isMysqlDeployment });
    const lejos = new Date(Date.now() + 86400000 * 200).toISOString().slice(0, 10);
    const query = jest.fn(async () => [
      { document_type: 'B01', next_number: 1, end_number: 500, expiration_date: lejos, branch_name: null },
    ]);

    const warnings = await service.getSequencesWarningSummary(query, { expiryThresholdDays: 30, lowCountThreshold: 20 });

    expect(warnings).toHaveLength(0);
  });
});

describe('Prueba 12: no se puede duplicar un NCF en la base de datos', () => {
  test('el índice único idx_sales_ncf_unique rechaza un NCF repetido', async () => {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ncf VARCHAR(19) DEFAULT NULL,
        invoice_number VARCHAR(20)
      );
      CREATE UNIQUE INDEX idx_sales_ncf_unique ON sales (ncf);
    `);

    db.run('INSERT INTO sales (ncf, invoice_number) VALUES (?, ?)', ['B0100000001', 'FAC-00000001']);
    // Tickets sin NCF (NULL) sí pueden repetirse — NULL nunca choca contra otro NULL.
    db.run('INSERT INTO sales (ncf, invoice_number) VALUES (?, ?)', [null, 'FAC-00000002']);
    db.run('INSERT INTO sales (ncf, invoice_number) VALUES (?, ?)', [null, 'FAC-00000003']);

    expect(() => {
      db.run('INSERT INTO sales (ncf, invoice_number) VALUES (?, ?)', ['B0100000001', 'FAC-00000004']);
    }).toThrow();

    db.close();
  });
});

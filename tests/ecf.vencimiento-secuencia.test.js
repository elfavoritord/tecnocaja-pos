'use strict';

/**
 * Fecha de vencimiento de las secuencias e-NCF de producción. Según los XSD de la DGII
 * es obligatoria en todos los tipos menos E32 y E34, que no la llevan.
 */

const initSqlJs = require('sql.js');

jest.mock('../db', () => ({ getDbClient: () => 'sqlite' }));
const { EcfRepository } = require('../modules/ecf/models/ecf.repository');
const { createEcfService } = require('../modules/ecf/services/ecf.service');
const { llevaVencimiento } = require('../modules/ecf/config/document-types');

const VENCE = `${new Date().getFullYear() + 1}-12-31`;
const RANGO = { environment: 'ecf', authorizationReference: '6005604697', fechaAutorizacion: '2026-10-25', desde: 1, hasta: 100 };

async function preparar() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE ecf_sequences (id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INT DEFAULT 1, branch_id INT, cash_register_id INT,
    tipo_comprobante TEXT, environment TEXT, numero_inicial INT, numero_final INT, proximo_numero INT, fecha_autorizacion TEXT,
    fecha_vencimiento TEXT, authorization_reference TEXT, modo_simple INT DEFAULT 0, deleted_at TEXT, activo INT DEFAULT 1, created_at TEXT, updated_at TEXT)`);
  db.run(`CREATE TABLE ecf_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INT DEFAULT 1, tipo_ecf TEXT, encf TEXT,
    environment TEXT DEFAULT 'ecf', estado_dgii TEXT, dgii_response_json TEXT)`);
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
  const repo = new EcfRepository({ query, withTransaction: async (work) => work({ query }) });
  repo.listSequences = jest.fn(async () => []);
  repo.saveAudit = jest.fn(async () => ({}));
  const service = createEcfService({ query: jest.fn(async () => []), withTransaction: jest.fn(), resolveRequestActorUser: jest.fn() });
  service.repository = repo;
  service.ensureReady = jest.fn(async () => {});
  service.getCurrentActor = jest.fn(async () => ({ id: 1, nombre: 'Admin', rol: 'administrador_general' }));
  return { service, repo, query };
}

describe('qué tipos llevan fecha de vencimiento', () => {
  test('todos menos E32 y E34', () => {
    expect(['E31', 'E33', 'E41', 'E43', 'E44', 'E45', 'E46', 'E47'].every(llevaVencimiento)).toBe(true);
    expect(['E32', 'E34'].some(llevaVencimiento)).toBe(false);
  });
});

describe('agregar un rango de producción', () => {
  test.each(['E31', 'E33', 'E41', 'E43', 'E44', 'E45', 'E46', 'E47'])('%s sin fecha no se agrega', async (tipoComprobante) => {
    const { repo, query } = await preparar();
    await expect(repo.saveSequence(1, { ...RANGO, tipoComprobante })).rejects.toMatchObject({ statusCode: 422 });
    await expect(repo.saveSequence(1, { ...RANGO, tipoComprobante })).rejects.toThrow(/fecha de vencimiento/);
    expect(await query('SELECT id FROM ecf_sequences')).toHaveLength(0);
  });

  test('con fecha sí, y la guarda', async () => {
    const { repo, query } = await preparar();
    await repo.saveSequence(1, { ...RANGO, tipoComprobante: 'E31', fechaVencimiento: VENCE });
    const [fila] = await query('SELECT fecha_vencimiento FROM ecf_sequences');
    expect(fila.fecha_vencimiento).toBe(VENCE);
  });

  test('una fecha que ya pasó no se acepta', async () => {
    const { repo } = await preparar();
    await expect(repo.saveSequence(1, { ...RANGO, tipoComprobante: 'E31', fechaVencimiento: '2020-12-31' })).rejects.toThrow(/ya pasó/);
  });

  test.each(['E32', 'E34'])('%s no la pide, y si llega no se guarda', async (tipoComprobante) => {
    const { repo, query } = await preparar();
    await repo.saveSequence(1, { ...RANGO, tipoComprobante });
    await repo.saveSequence(1, { ...RANGO, tipoComprobante, desde: 101, hasta: 200, fechaVencimiento: '2020-12-31' });
    const filas = await query('SELECT fecha_vencimiento FROM ecf_sequences');
    expect(filas.map((f) => f.fecha_vencimiento)).toEqual([null, null]);
  });

  test('en pruebas (certificación) no cambia nada', async () => {
    const { repo } = await preparar();
    await expect(repo.saveSequence(1, { tipoComprobante: 'E31', environment: 'certecf', desde: 1, hasta: 10 })).resolves.toMatchObject({ environment: 'certecf' });
  });
});

describe('rango viejo cargado sin fecha', () => {
  async function viejo(tipo = 'E31') {
    const contexto = await preparar();
    const { insertId } = await contexto.query(
      `INSERT INTO ecf_sequences (tipo_comprobante, environment, numero_inicial, numero_final, proximo_numero, authorization_reference)
       VALUES (?, 'ecf', 1, 100, 1, '600')`, [tipo]
    );
    return { ...contexto, id: insertId };
  }
  const venta = (service, requestedType) => service.assertSaleHasSequence({ environment: 'ecf', requestedType, buyerTaxId: '131880681' });

  test('la venta se frena y dice dónde ponerla', async () => {
    const { service } = await viejo();
    await expect(venta(service, 'E31')).rejects.toMatchObject({ code: 'ECF_SIN_VENCIMIENTO', statusCode: 422 });
  });

  test('al ponerle la fecha ya se puede vender', async () => {
    const { service, query, id } = await viejo();
    await service.updateSequenceExpiry({ params: { id }, body: { fechaVencimiento: VENCE } });
    const [fila] = await query('SELECT fecha_vencimiento FROM ecf_sequences WHERE id = ?', [id]);
    expect(fila.fecha_vencimiento).toBe(VENCE);
    await expect(venta(service, 'E31')).resolves.toBeUndefined();
  });

  test('no acepta una fecha vacía ni pasada', async () => {
    const { service, id } = await viejo();
    await expect(service.updateSequenceExpiry({ params: { id }, body: {} })).rejects.toThrow(/fecha de vencimiento/);
    await expect(service.updateSequenceExpiry({ params: { id }, body: { fechaVencimiento: '2020-01-01' } })).rejects.toThrow(/ya pasó/);
  });

  test('E32 vende sin fecha y no deja ponérsela', async () => {
    const { service, id } = await viejo('E32');
    await expect(venta(service, 'E32')).resolves.toBeUndefined();
    await expect(service.updateSequenceExpiry({ params: { id }, body: { fechaVencimiento: VENCE } })).rejects.toThrow(/no lleva/);
  });

  test('sin secuencia sigue diciendo que no hay', async () => {
    const { service } = await preparar();
    await expect(venta(service, 'E31')).rejects.toMatchObject({ code: 'ECF_SIN_SECUENCIA' });
  });
});

describe('fechas viejas en E32 y E34', () => {
  test('al preparar la base se quitan, sin tocar los demás tipos ni pruebas', async () => {
    const { repo, query } = await preparar();
    const insertar = (tipo, ambiente) => query(
      `INSERT INTO ecf_sequences (tipo_comprobante, environment, numero_inicial, numero_final, proximo_numero, fecha_vencimiento)
       VALUES (?, ?, 1, 10, 1, '2020-12-31')`, [tipo, ambiente]
    );
    await insertar('E32', 'ecf');
    await insertar('E31', 'ecf');
    await insertar('E32', 'certecf');
    await repo.ensureSchema().catch(() => {});
    const filas = await query('SELECT tipo_comprobante AS t, environment AS e, fecha_vencimiento AS f FROM ecf_sequences ORDER BY id');
    expect(filas).toEqual([
      { t: 'E32', e: 'ecf', f: null },
      { t: 'E31', e: 'ecf', f: '2020-12-31' },
      { t: 'E32', e: 'certecf', f: '2020-12-31' },
    ]);
  });
});

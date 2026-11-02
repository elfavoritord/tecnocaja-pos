'use strict';

/**
 * Una secuencia e-NCF desactivada con e-CF emitidos no tenía salida: no había cómo
 * activarla, no se podía borrar y tampoco cargar otra vez porque se cruza.
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

jest.mock('../db', () => ({ getDbClient: () => 'sqlite' }));
const { EcfRepository } = require('../modules/ecf/models/ecf.repository');
const { createEcfService } = require('../modules/ecf/services/ecf.service');

async function preparar({ proximo = 11, vence = null, conDocumentos = true } = {}) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE ecf_sequences (id INTEGER PRIMARY KEY, business_id INT DEFAULT 1, branch_id INT, cash_register_id INT,
    tipo_comprobante TEXT, environment TEXT, numero_inicial INT, numero_final INT, proximo_numero INT,
    fecha_vencimiento TEXT, activo INT, modo_simple INT DEFAULT 0, deleted_at TEXT, updated_at TEXT)`);
  db.run('CREATE TABLE ecf_documents (id INTEGER PRIMARY KEY, sequence_id INT)');
  db.run('INSERT INTO ecf_sequences (id, tipo_comprobante, environment, numero_inicial, numero_final, proximo_numero, fecha_vencimiento, activo) VALUES (7, ?, ?, 1, 100, ?, ?, 0)',
    ['E32', 'ecf', proximo, vence]);
  if (conDocumentos) db.run('INSERT INTO ecf_documents (sequence_id) VALUES (7)');
  const query = async (sql, params = []) => {
    const text = String(sql).trim();
    const stmt = db.prepare(text);
    stmt.bind(params.map((value) => (value === undefined ? null : value)));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return /^(INSERT|UPDATE|DELETE)/i.test(text) ? { affectedRows: db.getRowsModified() } : rows;
  };
  const service = createEcfService({ query: jest.fn(async () => []), withTransaction: jest.fn(), resolveRequestActorUser: jest.fn() });
  service.repository = new EcfRepository({ query, withTransaction: async (work) => work({ query }) });
  service.repository.saveAudit = jest.fn(async () => ({}));
  service.getCurrentActor = jest.fn(async () => ({ id: 1, nombre: 'Admin', rol: 'administrador_general' }));
  const activo = async () => Number((await query('SELECT activo FROM ecf_sequences WHERE id = 7'))[0].activo);
  return { service, activo, query, req: { params: { id: '7' } } };
}

describe('activar de nuevo una secuencia e-NCF', () => {
  test('una desactivada con e-CF emitidos se puede activar y queda auditado', async () => {
    const { service, activo, req } = await preparar();
    await expect(service.enableSequence(req)).resolves.toEqual({ ok: true });
    expect(await activo()).toBe(1);
    expect(service.repository.saveAudit).toHaveBeenCalledWith(expect.objectContaining({ actionName: 'sequence_enabled' }));
  });

  test('una agotada no se activa', async () => {
    const { service, activo, req } = await preparar({ proximo: 101 });
    await expect(service.enableSequence(req)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/agotó/) });
    expect(await activo()).toBe(0);
  });

  test('una vencida no se activa', async () => {
    const { service, activo, req } = await preparar({ vence: '2020-01-01' });
    await expect(service.enableSequence(req)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/venció/) });
    expect(await activo()).toBe(0);
  });

  test('si no existe responde 404', async () => {
    const { service } = await preparar();
    await expect(service.enableSequence({ params: { id: '999' } })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('con e-CF emitidos pide confirmación aparte y dice cuántos son', async () => {
    const { service, req } = await preparar();
    await expect(service.deleteSequencePermanently(req))
      .rejects.toMatchObject({ statusCode: 409, details: { usada: true, emitidos: 1 } });
  });

  test('confirmado, se quita de la lista pero la fila queda para esos e-CF', async () => {
    const { service, req, query } = await preparar();
    await expect(service.deleteSequencePermanently({ ...req, query: { force: '1' } })).resolves.toMatchObject({ ok: true });
    const [fila] = await query('SELECT activo, deleted_at FROM ecf_sequences WHERE id = 7');
    expect(fila.activo).toBe(0);
    expect(fila.deleted_at).toBeTruthy();
    await expect(service.repository.getSequence(7)).resolves.toMatchObject({ id: 7 });
    expect(service.repository.saveAudit).toHaveBeenCalledWith(expect.objectContaining({ actionName: 'sequence_deleted' }));
  });

  test('eliminada, ya no sale para vender ni en la lista, y su rango se puede cargar otra vez', async () => {
    const { service, req, query } = await preparar({ proximo: 11 });
    await query('UPDATE ecf_sequences SET activo = 1 WHERE id = 7');
    await service.deleteSequencePermanently({ ...req, query: { force: '1' } });
    // Reenviar uno de sus e-CF puede volver a poner activo = 1: aun así no debe usarse.
    await query('UPDATE ecf_sequences SET activo = 1 WHERE id = 7');
    await expect(service.repository.hasAvailableSequence({ tipoComprobante: 'E32', environment: 'ecf' })).resolves.toBe(false);
    const conn = { query };
    await expect(service.repository.getNextAvailableSequence(conn, 1, {}, 'E32', 'ecf')).resolves.toBeNull();
    const overlap = await query(
      `SELECT id FROM ecf_sequences WHERE tipo_comprobante = 'E32' AND environment = 'ecf' AND COALESCE(modo_simple, 0) = 0 AND deleted_at IS NULL`
    ).catch(() => null);
    expect(overlap).toEqual([]);
  });

  test('sin e-CF emitidos sí se borra', async () => {
    const { service, req } = await preparar({ conDocumentos: false });
    await expect(service.deleteSequencePermanently(req)).resolves.toMatchObject({ ok: true });
  });
});

describe('pantallas y NCF serie B', () => {
  const leer = (archivo) => fs.readFileSync(path.join(__dirname, '..', archivo), 'utf8');

  test('las dos pantallas de e-NCF ofrecen Activar', () => {
    expect(leer('js/ecf-sequences-config.js')).toMatch(/ecfProdSeqEnable\(\$\{seq\.id\}\)/);
    expect(leer('js/fiscal-ecf.js')).toMatch(/enableEcfSequence\(\$\{seq\.id\}\)/);
  });

  test('una secuencia B suspendida también se puede activar', () => {
    expect(leer('js/fiscal-sequences-config.js')).toMatch(/r\.status === 'suspendido'/);
    expect(leer('server/routes/fiscal-sequences.routes.js')).toMatch(/ACTIVATABLE_STATUSES = \[[^\]]*'suspendido'/);
  });
});

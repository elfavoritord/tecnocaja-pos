'use strict';

/**
 * Modo sencillo de secuencias e-NCF: marcar el tipo y facturar. Cantidades y fechas son
 * opcionales, salvo la fecha que el XSD de la DGII exige en casi todos los tipos.
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

jest.mock('../db', () => ({ getDbClient: () => 'sqlite' }));
const { EcfRepository } = require('../modules/ecf/models/ecf.repository');
const { createEcfService } = require('../modules/ecf/services/ecf.service');

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
  const filas = (tipo) => query('SELECT * FROM ecf_sequences WHERE tipo_comprobante = ? ORDER BY id', [tipo]);
  return { service, repo, query, filas };
}

const marcar = (service, body) => service.activateSimpleSequence({ body });
const hoyMasUnAno = `${new Date().getFullYear() + 1}-12-31`;

describe('activar un tipo en modo sencillo', () => {
  const syncOriginal = process.env.TECNO_CAJA_SYNC_TOKEN;
  beforeEach(() => { delete process.env.TECNO_CAJA_SYNC_TOKEN; });
  afterAll(() => {
    if (syncOriginal === undefined) delete process.env.TECNO_CAJA_SYNC_TOKEN;
    else process.env.TECNO_CAJA_SYNC_TOKEN = syncOriginal;
  });

  test('E32 y E34 no piden nada: empiezan en 1 y sin vencimiento', async () => {
    const { service, filas } = await preparar();
    await marcar(service, { tipoComprobante: 'E32' });
    await marcar(service, { tipoComprobante: 'E34' });
    const [e32] = await filas('E32');
    expect(e32).toMatchObject({ proximo_numero: 1, modo_simple: 1, activo: 1, environment: 'ecf', fecha_vencimiento: null });
    expect((await filas('E34'))[0].modo_simple).toBe(1);
  });

  test.each(['E31', 'E33', 'E41', 'E43', 'E44', 'E45', 'E46', 'E47'])('%s exige la fecha, como el XSD de la DGII', async (tipo) => {
    const { service } = await preparar();
    await expect(marcar(service, { tipoComprobante: tipo })).rejects.toMatchObject({ statusCode: 422 });
    await expect(marcar(service, { tipoComprobante: tipo, fechaVencimiento: hoyMasUnAno })).resolves.toMatchObject({ ok: true });
  });

  test('la regla de la fecha coincide con los XSD de la DGII', () => {
    const dir = path.join(__dirname, '..', 'modules', 'ecf', 'schemas');
    const sinFecha = fs.readdirSync(dir)
      .map((nombre) => /^e-CF (\d+) v\.1\.0\.xsd$/.exec(nombre))
      .filter(Boolean)
      .filter((m) => !fs.readFileSync(path.join(dir, m[0]), 'utf8').includes('FechaVencimientoSecuencia'))
      .map((m) => `E${m[1]}`)
      .sort();
    expect(sinFecha).toEqual(['E32', 'E34']);
  });

  test('una fecha pasada se rechaza', async () => {
    const { service } = await preparar();
    await expect(marcar(service, { tipoComprobante: 'E31', fechaVencimiento: '2020-12-31' })).rejects.toThrow(/ya pasó/);
  });

  const emitido = (query, encf, estado, mensajes = []) => query(
    "INSERT INTO ecf_documents (tipo_ecf, encf, estado_dgii, dgii_response_json) VALUES ('E32', ?, ?, ?)",
    [encf, estado, JSON.stringify({ mensajes })]
  );

  test('sigue después del último número que la DGII aceptó', async () => {
    const { service, query, filas } = await preparar();
    await emitido(query, 'E320000000040', 'aceptado');
    await query(`INSERT INTO ecf_sequences (tipo_comprobante, environment, numero_inicial, numero_final, proximo_numero, activo)
      VALUES ('E32', 'ecf', 1, 25, 26, 0)`);
    await marcar(service, { tipoComprobante: 'E32' });
    expect((await filas('E32'))[1].proximo_numero).toBe(41);
  });

  test('caso real: 1 y 2 aceptados, 101 y 102 "no autorizada" (75) en rangos eliminados: sigue en el 3', async () => {
    const { service, query, filas } = await preparar();
    await emitido(query, 'E320000000001', 'aceptado');
    await emitido(query, 'E320000000002', 'aceptado');
    const noAutorizada = [{ valor: 'Número de secuencia no autorizada.', codigo: '75' }];
    await emitido(query, 'E320000000101', 'aceptado_condicional', noAutorizada);
    await emitido(query, 'E320000000102', 'aceptado_condicional', noAutorizada);
    await query(`INSERT INTO ecf_sequences (tipo_comprobante, environment, numero_inicial, numero_final, proximo_numero, activo, deleted_at)
      VALUES ('E32', 'ecf', 1, 100, 3, 0, '2026-11-01'), ('E32', 'ecf', 101, 200, 102, 0, '2026-11-01')`);
    await marcar(service, { tipoComprobante: 'E32' });
    const simple = (await filas('E32')).find((f) => f.modo_simple === 1);
    expect(simple.proximo_numero).toBe(3);
  });

  test('un condicional por otro motivo sí cuenta: el número estaba autorizado', async () => {
    const { service, query, filas } = await preparar();
    await emitido(query, 'E320000000007', 'aceptado_condicional', [{ valor: 'MontoTotal', codigo: '12' }]);
    await marcar(service, { tipoComprobante: 'E32' });
    expect((await filas('E32'))[0].proximo_numero).toBe(8);
  });

  test('"Próximo número" corrige hacia atrás en modo sencillo, pero nunca a uno ya emitido', async () => {
    const { service, query, filas } = await preparar();
    const noAutorizada = [{ valor: 'Número de secuencia no autorizada.', codigo: '75' }];
    await emitido(query, 'E320000000002', 'aceptado');
    await emitido(query, 'E320000000102', 'aceptado_condicional', noAutorizada);
    await query(`INSERT INTO ecf_sequences (tipo_comprobante, environment, numero_inicial, numero_final, proximo_numero, modo_simple, activo)
      VALUES ('E32', 'ecf', 102, 9999999999, 103, 1, 1)`);
    const [fila] = await filas('E32');
    service.repository.getSequence = async (id) => (await query('SELECT * FROM ecf_sequences WHERE id = ?', [id]))[0];
    await expect(service.updateSequenceNext({ params: { id: fila.id }, body: { proximoNumero: 2 } })).rejects.toThrow(/ya se emitió/);
    await service.updateSequenceNext({ params: { id: fila.id }, body: { proximoNumero: 3 } });
    const [despues] = await filas('E32');
    expect(despues).toMatchObject({ proximo_numero: 3, numero_inicial: 3, activo: 1 });
  });

  test('si ya hay un rango vigente de la DGII lo usa y no crea otro', async () => {
    const { service, query, filas } = await preparar();
    await query(`INSERT INTO ecf_sequences (tipo_comprobante, environment, numero_inicial, numero_final, proximo_numero, activo)
      VALUES ('E32', 'ecf', 1, 100, 5, 1)`);
    await expect(marcar(service, { tipoComprobante: 'E32' })).resolves.toMatchObject({ existing: true });
    expect(await filas('E32')).toHaveLength(1);
  });

  test('marcar otra vez reactiva la misma fila y conserva el número', async () => {
    const { service, repo, query, filas } = await preparar();
    await marcar(service, { tipoComprobante: 'E32' });
    const [fila] = await filas('E32');
    await query('UPDATE ecf_sequences SET proximo_numero = 9 WHERE id = ?', [fila.id]);
    await repo.disableSequence(fila.id);
    await marcar(service, { tipoComprobante: 'E32' });
    const despues = await filas('E32');
    expect(despues).toHaveLength(1);
    expect(despues[0]).toMatchObject({ activo: 1, proximo_numero: 9 });
  });

  test('una sucursal de empresa no puede: dos sucursales repetirían números', async () => {
    const { service } = await preparar();
    process.env.TECNO_CAJA_SYNC_TOKEN = 'token';
    await expect(marcar(service, { tipoComprobante: 'E32' })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('un tipo que no existe se rechaza', async () => {
    const { service } = await preparar();
    await expect(marcar(service, { tipoComprobante: 'B01' })).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('cargar después el rango real de la DGII', () => {
  const rango = { tipoComprobante: 'E32', environment: 'ecf', authorizationReference: '600', fechaAutorizacion: '2026-10-25' };

  test('no choca, apaga el modo sencillo y sigue donde iba', async () => {
    const { repo, filas, query } = await preparar();
    await repo.activateSimpleSequence(1, { tipoComprobante: 'E32' });
    const [simple] = await filas('E32');
    await query('UPDATE ecf_sequences SET proximo_numero = 8 WHERE id = ?', [simple.id]);
    await repo.saveSequence(1, { ...rango, desde: 1, hasta: 100 });
    const [viejo, real] = await filas('E32');
    expect(viejo.activo).toBe(0);
    expect(real).toMatchObject({ activo: 1, modo_simple: 0, proximo_numero: 8 });
  });

  test('volver a cargar un rango sigue después de lo ya emitido en él', async () => {
    const { repo, query, filas } = await preparar();
    await query("INSERT INTO ecf_documents (tipo_ecf, encf, estado_dgii) VALUES ('E32', 'E320000000002', 'aceptado')");
    await query("INSERT INTO ecf_documents (tipo_ecf, encf, estado_dgii) VALUES ('E32', 'E320000000102', 'aceptado_condicional')");
    await repo.saveSequence(1, { ...rango, desde: 1, hasta: 100 });
    expect((await filas('E32'))[0].proximo_numero).toBe(3);
  });

  test('si el rango real va más adelante, empieza en su propio inicio', async () => {
    const { repo, filas } = await preparar();
    await repo.activateSimpleSequence(1, { tipoComprobante: 'E32' });
    await repo.saveSequence(1, { ...rango, desde: 501, hasta: 600 });
    expect((await filas('E32'))[1].proximo_numero).toBe(501);
  });

  test('dos rangos reales que se cruzan siguen sin poder cargarse', async () => {
    const { repo } = await preparar();
    await repo.saveSequence(1, { ...rango, desde: 1, hasta: 100 });
    await expect(repo.saveSequence(1, { ...rango, desde: 50, hasta: 150 })).rejects.toThrow(/cubre parte/);
  });
});

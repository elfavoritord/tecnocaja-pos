'use strict';

/**
 * Rangos e-NCF (serie E) que la central reparte entre sucursales, igual que
 * los B: la sucursal los aplica sobre sus secuencias de producción de la
 * factura electrónica (ecf_sequences, environment 'ecf').
 */

const initSqlJs = require('sql.js');

jest.mock('../../db', () => ({ getDbClient: () => 'sqlite' }));
const { EcfRepository } = require('../../modules/ecf/models/ecf.repository');
const { createNcfCentral } = require('../../server/multisucursal/ncf-central');

const RANGO_A = '11111111-1111-4111-8111-111111111111';
const RANGO_B = '22222222-2222-4222-8222-222222222222';

async function crearSucursal() {
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
  // Misma tabla que la migración ms-0004.
  await query(`CREATE TABLE ncf_rangos_central (
    rango_uuid VARCHAR(36) NOT NULL PRIMARY KEY, tipo VARCHAR(5) NOT NULL, desde INT NOT NULL, hasta INT NOT NULL,
    vence VARCHAR(10) DEFAULT NULL, autorizacion VARCHAR(60) DEFAULT NULL, estado VARCHAR(20) NOT NULL DEFAULT 'en_espera',
    sistema VARCHAR(10) DEFAULT NULL, secuencia_local_id INT DEFAULT NULL, motivo TEXT DEFAULT NULL,
    recibido_at_utc VARCHAR(30) NOT NULL, actualizado_at_utc VARCHAR(30) DEFAULT NULL)`);
  const repo = new EcfRepository({ query, withTransaction });
  await repo.ensureSchema();

  const eventos = [];
  const ncf = createNcfCentral({
    query,
    withTransaction,
    bandejas: { registrarSalida: async (_executor, evento) => { eventos.push(evento); } },
    identidad: { obtener: async () => ({ empresa: { uuid: 'empresa', id: 1 }, sucursal: { uuid: 'norte', id: 1 } }) },
    logger: { warn() {}, error() {} },
  });
  return { query, repo, ncf, eventos };
}

const E32_NORTE = { rangoUuid: RANGO_A, tipo: 'E32', desde: 101, hasta: 200, autorizacion: '6005604697', estado: 'asignado' };

describe('rangos e-NCF asignados por la central', () => {
  test('el rango llega en espera y al activarse queda como única secuencia E32 de producción', async () => {
    const { query, repo, ncf, eventos } = await crearSucursal();
    // Una secuencia cargada a mano antes de unirse a la empresa.
    await repo.saveSequence(1, { tipoComprobante: 'E32', environment: 'ecf', authorizationReference: 'MANUAL', fechaAutorizacion: '2026-10-25', desde: 1, hasta: 100 });

    expect(await ncf.registrar(E32_NORTE)).toBe('registrado');
    const resultado = await ncf.ajustar();
    expect(resultado.activados).toEqual([RANGO_A]);

    const secuencias = await query("SELECT numero_inicial, numero_final, proximo_numero, activo, authorization_reference FROM ecf_sequences WHERE environment = 'ecf' ORDER BY id");
    expect(secuencias).toEqual([
      { numero_inicial: 1, numero_final: 100, proximo_numero: 1, activo: 0, authorization_reference: 'MANUAL' },
      { numero_inicial: 101, numero_final: 200, proximo_numero: 101, activo: 1, authorization_reference: '6005604697' },
    ]);
    const [rango] = await query('SELECT estado, sistema FROM ncf_rangos_central');
    expect(rango).toEqual({ estado: 'en_uso', sistema: 'ecf' });
    expect(eventos.map((e) => e.payload.estado)).toEqual(['en_espera', 'en_uso']);

    // La factura electrónica saca el número del rango de la central.
    const siguiente = await repo.generateNextENCF({ tipoComprobante: 'E32', environment: 'ecf' });
    expect(siguiente.encf).toBe('E320000000101');
  });

  test('se rechaza si la sucursal ya emitió en producción un número de ese rango', async () => {
    const { query, ncf, eventos } = await crearSucursal();
    await query("INSERT INTO ecf_documents (business_id, tipo_ecf, encf, environment) VALUES (1, 'E32', 'E320000000150', 'ecf')");
    // Un e-NCF de las pruebas de certificación no cuenta.
    await query("INSERT INTO ecf_documents (business_id, tipo_ecf, encf, environment) VALUES (1, 'E32', 'E320000000180', 'certecf')");

    await ncf.registrar(E32_NORTE);
    const resultado = await ncf.ajustar();

    expect(resultado.rechazados).toEqual([RANGO_A]);
    const [rango] = await query('SELECT estado, motivo FROM ncf_rangos_central');
    expect(rango.estado).toBe('rechazado');
    expect(rango.motivo).toMatch(/ya emitió el E320000000150/);
    expect(eventos.at(-1).payload).toMatchObject({ estado: 'rechazado' });
  });

  test('cuando se agota pasa solo al siguiente rango en espera', async () => {
    const { query, ncf } = await crearSucursal();
    await ncf.registrar(E32_NORTE);
    await ncf.ajustar();
    await ncf.registrar({ ...E32_NORTE, rangoUuid: RANGO_B, desde: 501, hasta: 600 });
    await query("UPDATE ecf_sequences SET proximo_numero = 201 WHERE environment = 'ecf' AND numero_inicial = 101");

    const resultado = await ncf.ajustar();

    expect(resultado.agotados).toEqual([RANGO_A]);
    expect(resultado.activados).toEqual([RANGO_B]);
    const lista = await ncf.listar();
    expect(lista.map((r) => [r.desde, r.estado, r.disponibles])).toEqual([[101, 'agotado', null], [501, 'en_uso', 100]]);
  });

  test('una PC que ya facturaba avisa sus rangos y el nuevo de la central espera su turno', async () => {
    const { query, repo, ncf, eventos } = await crearSucursal();
    // Rango del archivo de la DGII, ya usado (va por el 2); otro desactivado sin usar.
    const enUso = await repo.saveSequence(1, { tipoComprobante: 'E32', environment: 'ecf', authorizationReference: '6005604697', fechaAutorizacion: '2026-10-25', desde: 1, hasta: 100 });
    await query('UPDATE ecf_sequences SET proximo_numero = 2 WHERE id = ?', [enUso.id]);
    const sinUsar = await repo.saveSequence(1, { tipoComprobante: 'E31', environment: 'ecf', authorizationReference: 'X', fechaAutorizacion: '2026-10-25', desde: 1, hasta: 10 });
    await query('UPDATE ecf_sequences SET activo = 0 WHERE id = ?', [sinUsar.id]);

    const reportados = await ncf.reportarLocales();

    expect(reportados).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      entityType: 'ncf_rango',
      operation: 'reportar',
      payload: { tipo: 'E32', desde: 1, hasta: 100, autorizacion: '6005604697', estado: 'en_uso', siguiente: 2 },
    });
    expect(await ncf.reportarLocales()).toEqual([]); // ya quedó ligado: no se repite

    // La central le asigna otro E32: espera a que se agote el que ya tenía.
    await ncf.registrar({ ...E32_NORTE, rangoUuid: RANGO_B, desde: 101, hasta: 200 });
    const resultado = await ncf.ajustar();
    expect(resultado.activados).toEqual([]);
    expect(await repo.generateNextENCF({ tipoComprobante: 'E32', environment: 'ecf' })).toMatchObject({ encf: 'E320000000002' });

    // El rango avisado vuelve de la central por el stream 'ncf': ya está.
    expect(await ncf.registrar({ ...E32_NORTE, rangoUuid: reportados[0], desde: 1, hasta: 100 })).toBe('sin_cambios');
  });

  test('un rango ya desactivado que dio números se avisa como agotado', async () => {
    const { query, repo, ncf, eventos } = await crearSucursal();
    const viejo = await repo.saveSequence(1, { tipoComprobante: 'E32', environment: 'ecf', authorizationReference: 'A', fechaAutorizacion: '2026-10-25', desde: 1, hasta: 100 });
    await query('UPDATE ecf_sequences SET proximo_numero = 41, activo = 0 WHERE id = ?', [viejo.id]);

    await ncf.reportarLocales();

    expect(eventos[0].payload).toMatchObject({ estado: 'agotado', siguiente: 41 });
    const [fila] = await query('SELECT estado, sistema FROM ncf_rangos_central');
    expect(fila).toEqual({ estado: 'agotado', sistema: 'ecf' });
  });

  test('sin la factura electrónica preparada en la PC el rango sigue en espera', async () => {
    const { query, ncf } = await crearSucursal();
    await query('DROP TABLE ecf_sequences');
    await ncf.registrar(E32_NORTE);

    const resultado = await ncf.ajustar();

    expect(resultado.activados).toEqual([]);
    const [rango] = await query('SELECT estado FROM ncf_rangos_central');
    expect(rango.estado).toBe('en_espera');
  });
});

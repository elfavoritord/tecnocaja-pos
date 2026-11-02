'use strict';

/**
 * Un e-CF que la DGII rechazó (código 176 en E31) se corrige y sale con otro número,
 * aunque su secuencia ya se haya desactivado o eliminado.
 */

const initSqlJs = require('sql.js');

jest.mock('../db', () => ({ getDbClient: () => 'sqlite' }));
jest.mock('../modules/ecf/signature/signature.service', () => ({
  signXML: (xml) => xml,
  verifySignature: () => ({ ok: true }),
}));
const { EcfRepository } = require('../modules/ecf/models/ecf.repository');
const { createEcfService } = require('../modules/ecf/services/ecf.service');
const { generateEcfXml } = require('../modules/ecf/services/ecf-generator');

const VENCE = `${new Date().getFullYear() + 1}-12-31`;
const gravado = [{ name: 'Servicio', quantity: 1, unitPrice: 1, discount: 0, taxRate: 18 }];
const exento = [{ name: 'Exento', quantity: 1, unitPrice: 650, discount: 0, taxRate: 0 }];
const emitter = { rnc: '40211932609', razonSocial: 'Emisor', direccion: 'Calle 1' };
const cliente = { rnc: '131880681', nombre: 'Cliente SRL' };

function xmlDe(tipo, items, extra = {}) {
  return generateEcfXml({
    emitter, customer: cliente, items,
    document: { eNCF: `${tipo}0000000001`, tipoeCF: tipo, tipoIngresos: '01', tipoPago: '1', fechaVencimientoSecuencia: VENCE, ...extra },
    issueDate: new Date('2026-11-01T12:00:00'),
  }).xml;
}
const indicador = (xml) => (xml.match(/<IndicadorMontoGravado>(\d)<\/IndicadorMontoGravado>/) || [])[1] ?? null;

describe('IndicadorMontoGravado', () => {
  test.each(['E31', 'E32', 'E41', 'E45'])('%s gravado lo lleva en 0', (tipo) => {
    expect(indicador(xmlDe(tipo, gravado))).toBe('0');
  });

  test('una factura con líneas gravadas y exentas también', () => {
    expect(indicador(xmlDe('E31', [...gravado, ...exento]))).toBe('0');
  });

  test('sin líneas gravadas no se pone', () => {
    expect(indicador(xmlDe('E31', exento))).toBeNull();
    expect(indicador(xmlDe('E32', exento))).toBeNull();
  });

  test.each(['E44', 'E46'])('%s no lo tiene en su XSD', (tipo) => {
    expect(indicador(xmlDe(tipo, gravado))).toBeNull();
  });

  test('va antes de TipoIngresos, como pide el XSD', () => {
    const xml = xmlDe('E31', gravado);
    expect(xml.indexOf('<IndicadorMontoGravado>')).toBeLessThan(xml.indexOf('<TipoIngresos>'));
  });

  test('sigue respetando el valor que venga en el documento', () => {
    expect(indicador(xmlDe('E31', gravado, { indicadorMontoGravado: 1 }))).toBe('1');
  });
});

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
  const withTransaction = async (work) => work({ query });
  const repo = new EcfRepository({ query, withTransaction });
  const insertar = async (campos) => {
    const fila = { tipo_comprobante: 'E31', environment: 'ecf', numero_inicial: 1, numero_final: 20, proximo_numero: 5, fecha_vencimiento: VENCE, activo: 1, ...campos };
    const llaves = Object.keys(fila);
    const { insertId } = await query(
      `INSERT INTO ecf_sequences (${llaves.join(', ')}) VALUES (${llaves.map(() => '?').join(', ')})`,
      llaves.map((k) => fila[k])
    );
    return insertId;
  };
  return { repo, query, insertar };
}

const documento = (sequence_id, extra = {}) => ({ id: 213, business_id: 1, sequence_id, tipo_ecf: 'E31', encf: 'E310000000003', environment: 'ecf', estado_dgii: 'rechazado', ...extra });

describe('secuencia para volver a emitir', () => {
  test('si la suya sigue vigente, usa esa', async () => {
    const { repo, insertar } = await preparar();
    const id = await insertar({});
    await expect(repo.sequenceForReissue(documento(id))).resolves.toBe(id);
  });

  test.each([
    ['eliminada', { deleted_at: '2026-11-01 14:35:53', activo: 0 }],
    ['desactivada', { activo: 0 }],
    ['agotada', { proximo_numero: 21 }],
    ['vencida', { fecha_vencimiento: '2020-12-31' }],
  ])('si está %s, pasa a la vigente del tipo', async (_nombre, vieja) => {
    const { repo, insertar } = await preparar();
    const idVieja = await insertar(vieja);
    const vigente = await insertar({ authorization_reference: '6005641595' });
    await expect(repo.sequenceForReissue(documento(idVieja))).resolves.toBe(vigente);
  });

  test('no usa la de otro tipo ni la de pruebas', async () => {
    const { repo, insertar } = await preparar();
    const idVieja = await insertar({ activo: 0 });
    await insertar({ tipo_comprobante: 'E32' });
    await insertar({ environment: 'certecf' });
    await expect(repo.sequenceForReissue(documento(idVieja))).rejects.toThrow(/No hay una secuencia E31 activa/);
  });
});

describe('resultado de la DGII por TrackID', () => {
  function servicio(respuesta) {
    const service = createEcfService({ query: jest.fn(async () => []), withTransaction: jest.fn(), resolveRequestActorUser: jest.fn() });
    const repo = {
      getDocument: jest.fn(async () => ({ id: 214, sale_id: 36, encf: 'E310000000005', tipo_ecf: 'E31', track_id: 'abc', environment: 'ecf' })),
      markDocumentStatus: jest.fn(async () => {}),
      attachSaleSummary: jest.fn(async () => {}),
    };
    service.repository = repo;
    service.useDocumentEnvironment = jest.fn();
    service.statusService = { getTrackStatus: jest.fn(async () => respuesta) };
    return { service, repo };
  }

  test('un aceptado no deja "[object Object]" como error', async () => {
    const { service, repo } = servicio({ estado: 'Aceptado', codigo: '1', mensajes: [{ valor: '', codigo: 0 }] });
    const r = await service.queryDocumentStatus(214);
    expect(r.estado).toBe('aceptado');
    expect(repo.markDocumentStatus).toHaveBeenCalledWith(214, expect.objectContaining({ error_message: null }));
    expect(repo.attachSaleSummary).toHaveBeenCalledWith(36, expect.objectContaining({ estado: 'aceptado', error: null }));
  });

  test('un rechazo sí conserva su motivo', async () => {
    const { service, repo } = servicio({ estado: 'Rechazado', codigo: '2', mensajes: [{ valor: 'Campo no válido', codigo: 176 }] });
    await service.queryDocumentStatus(214);
    expect(repo.markDocumentStatus).toHaveBeenCalledWith(214, expect.objectContaining({ estado_dgii: 'rechazado', error_message: 'Campo no válido' }));
  });
});

describe('reemitir el documento', () => {
  async function reemitir(documentoExtra = {}) {
    const contexto = await preparar();
    const service = createEcfService({ query: jest.fn(async () => []), withTransaction: jest.fn(), resolveRequestActorUser: jest.fn() });
    service.repository = contexto.repo;
    const eliminada = await contexto.insertar({ numero_final: 9999999999, deleted_at: '2026-11-01 14:35:53', activo: 0 });
    const real = await contexto.insertar({ authorization_reference: '6005641595' });
    const reissue = jest.spyOn(contexto.repo, 'reissueDocument').mockResolvedValue();
    const avanzar = jest.spyOn(contexto.repo, 'advanceSequenceAfterUse');
    jest.spyOn(contexto.repo, 'reserveNextEncfForSequence').mockImplementation(async (id) => {
      const [fila] = await contexto.query('SELECT * FROM ecf_sequences WHERE id = ?', [id]);
      return { encf: `E31${String(fila.proximo_numero).padStart(10, '0')}`, sequence: fila };
    });
    const xmlViejo = xmlDe('E31', gravado).replace(/<IndicadorMontoGravado>0<\/IndicadorMontoGravado>/, '').replace(/E310000000001/g, 'E310000000003');
    const salida = await service.advanceDocumentToNextSequence(documento(eliminada, { xml_content: xmlViejo, ...documentoExtra }), {});
    return { ...contexto, salida, reissue, avanzar, eliminada, real };
  }

  test('de una secuencia eliminada sale con el número de la vigente, ya corregido', async () => {
    const { salida, reissue, avanzar, real } = await reemitir();
    expect(salida).toMatchObject({ encf: 'E310000000005', sequence_id: real, estado_dgii: 'firmado' });
    expect(indicador(salida.xml_content)).toBe('0');
    // Al rearmarlo desde el XML viejo, el ITBIS y el total no cambian.
    expect(salida.xml_content).toContain('<TotalITBIS>0.18</TotalITBIS>');
    expect(salida.xml_content).toContain('<MontoTotal>1.18</MontoTotal>');
    expect(salida.xml_content).not.toContain('<MontoExento>');
    expect(reissue).toHaveBeenCalledWith(213, expect.objectContaining({ sequence_id: real, encf: 'E310000000005' }));
    // El número viejo no mueve la secuencia nueva.
    expect(avanzar).not.toHaveBeenCalled();
  });

  test('certificación sigue atada a su secuencia', async () => {
    const { salida, eliminada } = await reemitir({ certification_case_key: 'caso-1' });
    expect(salida.sequence_id).toBe(eliminada);
  });

  test.each([
    [{ quantity: 1, unitPrice: 100, discount: 0, taxRate: 16 }, '<TotalITBIS>16.00</TotalITBIS>', '<MontoTotal>116.00</MontoTotal>'],
    [{ quantity: 1, unitPrice: 100, discount: 0, taxRate: 0 }, '<MontoExento>100.00</MontoExento>', '<MontoTotal>100.00</MontoTotal>'],
    [{ quantity: 2, unitPrice: 100, discount: 20, taxRate: 18 }, '<TotalITBIS>32.40</TotalITBIS>', '<MontoTotal>212.40</MontoTotal>'],
  ])('rearmado desde su XML conserva los montos %#', async (item, esperado1, esperado2) => {
    const service = createEcfService({ query: jest.fn(async () => []), withTransaction: jest.fn(), resolveRequestActorUser: jest.fn() });
    const xml = xmlDe('E31', [{ name: 'Línea', ...item }]);
    const payload = service.extractPayloadFromDocumentXml({ tipo_ecf: 'E31', encf: 'E310000000001' }, xml, VENCE, 'E310000000002');
    const nuevo = generateEcfXml(payload).xml;
    expect(nuevo).toContain(esperado1);
    expect(nuevo).toContain(esperado2);
  });
});

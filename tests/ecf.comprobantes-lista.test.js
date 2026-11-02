'use strict';

/**
 * Configuración → Comprobantes enviados a la DGII: estados, errores, enlace y filtros.
 */

const initSqlJs = require('sql.js');

jest.mock('../db', () => ({ getDbClient: () => 'sqlite' }));
const { EcfRepository } = require('../modules/ecf/models/ecf.repository');
const { createEcfService } = require('../modules/ecf/services/ecf.service');

const firmado = (encf, comprador = '<RNCComprador>131880681</RNCComprador>') => `<ECF><Encabezado><IdDoc><TipoeCF>${encf.slice(1, 3)}</TipoeCF><eNCF>${encf}</eNCF></IdDoc>`
  + `<Emisor><RNCEmisor>40211932609</RNCEmisor><FechaEmision>01-11-2026</FechaEmision></Emisor><Comprador>${comprador}</Comprador>`
  + '<Totales><MontoTotal>1.18</MontoTotal></Totales></Encabezado><FechaHoraFirma>01-11-2026 14:40:07</FechaHoraFirma>'
  + '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignatureValue>QWJjMTIzZGVm</SignatureValue></Signature></ECF>';

async function preparar() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE sales (id INTEGER PRIMARY KEY, invoice_number TEXT)`);
  db.run(`CREATE TABLE ecf_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INT DEFAULT 1, sale_id INT, encf TEXT, tipo_ecf TEXT,
    nombre_comprador TEXT, rnc_comprador TEXT, monto_total REAL, itbis_total REAL, estado_dgii TEXT, track_id TEXT, environment TEXT DEFAULT 'ecf',
    submission_mode TEXT, origen TEXT, error_message TEXT, dgii_response_json TEXT, signed_xml_content TEXT, xml_generated_at TEXT,
    created_at TEXT DEFAULT '2026-11-01 10:00:00', sent_at TEXT)`);
  const query = async (sql, params = []) => {
    const text = String(sql).trim();
    const stmt = db.prepare(text);
    stmt.bind(params.map((value) => (value === undefined ? null : value)));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    if (/^(INSERT|UPDATE|DELETE)/i.test(text)) return { insertId: db.exec('SELECT last_insert_rowid()')[0].values[0][0] };
    return rows;
  };
  const repo = new EcfRepository({ query, withTransaction: async (work) => work({ query }) });
  const insertar = (fila) => {
    const llaves = Object.keys(fila);
    return query(`INSERT INTO ecf_documents (${llaves.join(', ')}) VALUES (${llaves.map(() => '?').join(', ')})`, llaves.map((k) => fila[k]));
  };
  return { repo, query, insertar };
}

async function conDatos() {
  const contexto = await preparar();
  const { insertar, query } = contexto;
  await query("INSERT INTO sales (id, invoice_number) VALUES (36, 'FAC-000036')");
  await insertar({ sale_id: 36, encf: 'E310000000005', tipo_ecf: 'E31', nombre_comprador: 'Emilio', rnc_comprador: '40211932609', monto_total: 1.18, estado_dgii: 'aceptado',
    track_id: 'abc-1', error_message: '[object Object]', dgii_response_json: JSON.stringify({ mensajes: [{ valor: '', codigo: 0 }] }), signed_xml_content: firmado('E310000000005') });
  await insertar({ encf: 'E320000000102', tipo_ecf: 'E32', estado_dgii: 'aceptado_condicional', track_id: 'abc-2',
    dgii_response_json: JSON.stringify({ mensajes: [{ valor: 'Número de secuencia no autorizada', codigo: 75 }] }), signed_xml_content: firmado('E320000000102', '') });
  await insertar({ encf: 'E310000000004', tipo_ecf: 'E31', estado_dgii: 'rechazado', track_id: 'abc-3', error_message: 'Campo no válido',
    dgii_response_json: JSON.stringify({ mensajes: [{ valor: 'Campo no válido', codigo: 176 }] }), signed_xml_content: firmado('E310000000004') });
  await insertar({ encf: 'E340000000001', tipo_ecf: 'E34', estado_dgii: 'error', error_message: 'Sin certificado' });
  await insertar({ encf: 'E310000000006', tipo_ecf: 'E31', estado_dgii: 'enviado', track_id: 'abc-4', signed_xml_content: firmado('E310000000006') });
  await insertar({ encf: 'E310000000099', tipo_ecf: 'E31', estado_dgii: 'aceptado', environment: 'certecf', track_id: 'cert-1', signed_xml_content: firmado('E310000000099') });
  return contexto;
}

const porEncf = (r, encf) => r.documents.find((d) => d.encf === encf);

describe('lista de comprobantes', () => {
  test('resumen por estado, solo producción por defecto', async () => {
    const { repo } = await conDatos();
    const r = await repo.listComprobantes({});
    expect(r.resumen).toEqual({ total: 5, aceptado: 1, condicional: 1, rechazado: 1, proceso: 1, sinEnviar: 1 });
    expect(r.documents.map((d) => d.encf)).not.toContain('E310000000099');
  });

  test('pruebas se ven aparte', async () => {
    const { repo } = await conDatos();
    const r = await repo.listComprobantes({ ambiente: 'pruebas' });
    expect(r.documents.map((d) => d.encf)).toEqual(['E310000000099']);
  });

  test('aceptado: enlace de la DGII, factura y sin mensajes de error', async () => {
    const { repo } = await conDatos();
    const doc = porEncf(await repo.listComprobantes({}), 'E310000000005');
    expect(doc.enlace).toContain('ConsultaTimbre');
    expect(doc.enlace).toContain('ENCF=E310000000005');
    expect(doc).toMatchObject({ factura: 'FAC-000036', grupo: 'aceptado', tieneXml: true, mensajes: [] });
  });

  test('condicional: conserva el aviso de la DGII y su enlace', async () => {
    const { repo } = await conDatos();
    const doc = porEncf(await repo.listComprobantes({}), 'E320000000102');
    expect(doc.mensajes).toEqual([{ codigo: '75', texto: 'Número de secuencia no autorizada' }]);
    expect(doc.enlace).toBeTruthy();
  });

  test('rechazado: motivo una sola vez y sin enlace', async () => {
    const { repo } = await conDatos();
    const doc = porEncf(await repo.listComprobantes({}), 'E310000000004');
    expect(doc.mensajes).toEqual([{ codigo: '176', texto: 'Campo no válido' }]);
    expect(doc.enlace).toBe('');
  });

  test('error sin respuesta de la DGII: muestra el error guardado', async () => {
    const { repo } = await conDatos();
    const doc = porEncf(await repo.listComprobantes({}), 'E340000000001');
    expect(doc).toMatchObject({ grupo: 'sin_enviar', tieneXml: false, enlace: '' });
    expect(doc.mensajes).toEqual([{ codigo: '', texto: 'Sin certificado' }]);
  });

  test.each([
    ['aceptado', ['E310000000005']],
    ['condicional', ['E320000000102']],
    ['rechazado', ['E310000000004']],
    ['proceso', ['E310000000006']],
    ['sin_enviar', ['E340000000001']],
  ])('filtro de estado %s', async (estado, esperado) => {
    const { repo } = await conDatos();
    const r = await repo.listComprobantes({ estado });
    expect(r.documents.map((d) => d.encf)).toEqual(esperado);
    expect(r.resumen.total).toBe(5);
  });

  test('busca por e-NCF, cliente, RNC, factura y TrackID; filtra por tipo y fechas', async () => {
    const { repo } = await conDatos();
    const encfs = async (filtros) => (await repo.listComprobantes(filtros)).documents.map((d) => d.encf);
    expect(await encfs({ buscar: 'E310000000004' })).toEqual(['E310000000004']);
    expect(await encfs({ buscar: 'emilio' })).toEqual(['E310000000005']);
    expect(await encfs({ buscar: '40211932609' })).toEqual(['E310000000005']);
    expect(await encfs({ buscar: 'FAC-000036' })).toEqual(['E310000000005']);
    expect(await encfs({ buscar: 'abc-3' })).toEqual(['E310000000004']);
    expect(await encfs({ tipo: 'e34' })).toEqual(['E340000000001']);
    expect(await encfs({ hasta: '2026-10-31' })).toEqual([]);
    expect(await encfs({ desde: '2026-11-01', hasta: '2026-11-01', tipo: 'E32' })).toEqual(['E320000000102']);
  });

  test('un texto con comillas no rompe la consulta', async () => {
    const { repo } = await conDatos();
    await expect(repo.listComprobantes({ buscar: "x' OR '1'='1" })).resolves.toMatchObject({ total: 0, documents: [] });
    await expect(repo.listComprobantes({ pagina: "1; DROP TABLE sales" })).resolves.toMatchObject({ pagina: 1 });
  });

  test('pagina de 25 en 25, de los más nuevos a los más viejos', async () => {
    const { repo, insertar } = await preparar();
    for (let i = 1; i <= 30; i += 1) await insertar({ encf: `E32${String(i).padStart(10, '0')}`, tipo_ecf: 'E32', estado_dgii: 'aceptado' });
    const uno = await repo.listComprobantes({});
    expect(uno).toMatchObject({ total: 30, pagina: 1, paginas: 2 });
    expect(uno.documents).toHaveLength(25);
    expect(uno.documents[0].encf).toBe('E320000000030');
    const dos = await repo.listComprobantes({ pagina: 2 });
    expect(dos.documents).toHaveLength(5);
    expect((await repo.listComprobantes({ pagina: 99 })).pagina).toBe(2);
  });

  test('el servicio pide una sesión', async () => {
    const service = createEcfService({ query: jest.fn(async () => []), withTransaction: jest.fn(), resolveRequestActorUser: jest.fn(async () => { throw Object.assign(new Error('Sesión'), { statusCode: 401 }); }) });
    await expect(service.listComprobantes({ query: {} })).rejects.toMatchObject({ statusCode: 401 });
  });
});

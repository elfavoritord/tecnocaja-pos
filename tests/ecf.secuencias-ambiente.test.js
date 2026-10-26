'use strict';

/**
 * Secuencias e-NCF de producción y de pruebas separadas. Antes producción
 * seguía con los rangos que creó la certificación (1–9,999,999,999 o el último
 * número de prueba + 200) y la DGII respondía "Aceptado Condicional" con el
 * código 75 "No existen rangos de secuencias disponibles".
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const initSqlJs = require('sql.js');

jest.mock('../db', () => ({ getDbClient: () => 'sqlite' }));
const { EcfRepository } = require('../modules/ecf/models/ecf.repository');
const { createEcfService } = require('../modules/ecf/services/ecf.service');

async function crearRepositorio() {
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
  const repo = new EcfRepository({ query, withTransaction: async (work) => work({ query }) });
  return { repo, query };
}

// Esquema de antes del cambio (sin la columna environment en ecf_sequences).
async function crearEsquemaViejo(query, { activadoEn }) {
  await query(`CREATE TABLE ecf_emitters (
    id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INT NOT NULL DEFAULT 1, rnc VARCHAR(20),
    environment VARCHAR(20) NOT NULL DEFAULT 'testecf', is_active TINYINT(1) NOT NULL DEFAULT 0,
    production_status VARCHAR(30) NOT NULL DEFAULT 'not_configured', production_activated_at DATETIME DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await query(`CREATE TABLE ecf_sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INT NOT NULL DEFAULT 1, branch_id INT DEFAULT NULL,
    cash_register_id INT DEFAULT NULL, tipo_comprobante VARCHAR(5) NOT NULL, numero_inicial BIGINT NOT NULL,
    numero_final BIGINT NOT NULL, proximo_numero BIGINT NOT NULL, fecha_autorizacion DATE DEFAULT NULL,
    fecha_vencimiento DATE DEFAULT NULL, activo TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await query(
    `INSERT INTO ecf_emitters (business_id, rnc, environment, is_active, production_status, production_activated_at)
     VALUES (1, '40211932609', ?, 1, ?, ?)`,
    activadoEn ? ['ecf', 'active', activadoEn] : ['certecf', 'not_configured', null]
  );
}

async function agregarSecuenciaVieja(query, tipo, desde, hasta, proximo, creadaEn) {
  await query(
    `INSERT INTO ecf_sequences (business_id, tipo_comprobante, numero_inicial, numero_final, proximo_numero, activo, created_at)
     VALUES (1, ?, ?, ?, ?, 1, ?)`,
    [tipo, desde, hasta, proximo, creadaEn]
  );
}

const PRODUCCION = {
  tipoComprobante: 'E32',
  environment: 'ecf',
  authorizationReference: 'SOL-2026-000123',
  fechaAutorizacion: '2026-10-26',
  desde: 1,
  hasta: 500,
};

describe('secuencias e-NCF por ambiente', () => {
  test('al actualizar, las secuencias de antes de activar producción quedan como pruebas', async () => {
    const { repo, query } = await crearRepositorio();
    await crearEsquemaViejo(query, { activadoEn: '2026-10-23 14:02:21' });
    await agregarSecuenciaVieja(query, 'E32', 1, 9999999999, 1165, '2026-10-22 09:13:46');
    await agregarSecuenciaVieja(query, 'E34', 1, 216, 122, '2026-10-21 13:25:25');
    await agregarSecuenciaVieja(query, 'E31', 1, 100, 1, '2026-10-24 10:00:00');

    await repo.ensureSchema();

    const porTipo = Object.fromEntries((await repo.listSequences(1)).map((s) => [s.tipoComprobante, s.environment]));
    expect(porTipo).toEqual({ E31: 'ecf', E32: 'certecf', E34: 'certecf' });
  });

  test('sin producción activa, todas las secuencias viejas son de pruebas', async () => {
    const { repo, query } = await crearRepositorio();
    await crearEsquemaViejo(query, { activadoEn: null });
    await agregarSecuenciaVieja(query, 'E32', 1, 200, 10, '2026-10-24 10:00:00');

    await repo.ensureSchema();

    expect((await repo.listSequences(1))[0].environment).toBe('certecf');
  });

  test('una venta en producción no toma una secuencia de pruebas', async () => {
    const { repo, query } = await crearRepositorio();
    await crearEsquemaViejo(query, { activadoEn: '2026-10-23 14:02:21' });
    await agregarSecuenciaVieja(query, 'E32', 1, 9999999999, 1165, '2026-10-22 09:13:46');
    await repo.ensureSchema();

    await expect(repo.generateNextENCF({ tipoComprobante: 'E32', environment: 'ecf' }))
      .rejects.toThrow(/No hay una secuencia E32 de producción/);
    await expect(repo.generateNextENCF({ tipoComprobante: 'E32', environment: 'certecf' }))
      .resolves.toMatchObject({ encf: 'E320000001165' });
  });

  test('con el rango autorizado cargado, producción empieza en el primer número de la DGII', async () => {
    const { repo, query } = await crearRepositorio();
    await crearEsquemaViejo(query, { activadoEn: '2026-10-23 14:02:21' });
    await agregarSecuenciaVieja(query, 'E32', 1, 9999999999, 1165, '2026-10-22 09:13:46');
    await repo.ensureSchema();

    const saved = await repo.saveSequence(1, PRODUCCION);
    expect(saved.environment).toBe('ecf');
    const sequence = await repo.getSequence(saved.id);
    expect(sequence).toMatchObject({ environment: 'ecf', authorization_reference: 'SOL-2026-000123', proximo_numero: 1 });

    await expect(repo.generateNextENCF({ tipoComprobante: 'E32', environment: 'ecf' }))
      .resolves.toMatchObject({ encf: 'E320000000001' });
  });

  test('producción exige el Nº de autorización, la fecha y un rango real', async () => {
    const { repo, query } = await crearRepositorio();
    await crearEsquemaViejo(query, { activadoEn: '2026-10-23 14:02:21' });
    await repo.ensureSchema();

    await expect(repo.saveSequence(1, { ...PRODUCCION, authorizationReference: '' }))
      .rejects.toThrow(/número de autorización/);
    await expect(repo.saveSequence(1, { ...PRODUCCION, fechaAutorizacion: null }))
      .rejects.toThrow(/fecha en que la DGII/);
    await expect(repo.saveSequence(1, { ...PRODUCCION, hasta: 9999999999 }))
      .rejects.toThrow(/no es una autorización de la DGII/);
    await expect(repo.saveSequence(1, { ...PRODUCCION, hasta: 99999999999 }))
      .rejects.toThrow(/9,999,999,999/);

    await repo.saveSequence(1, PRODUCCION);
    await expect(repo.saveSequence(1, { ...PRODUCCION, desde: 400, hasta: 900 }))
      .rejects.toThrow(/ya hay una secuencia E32 de producción/i);
  });

  test('pruebas no exige autorización (la certificación crea sus propios rangos)', async () => {
    const { repo, query } = await crearRepositorio();
    await crearEsquemaViejo(query, { activadoEn: null });
    await repo.ensureSchema();

    const saved = await repo.saveSequence(1, { tipoComprobante: 'E31', environment: 'certecf', desde: 1, hasta: 9999999999 });
    expect(saved.environment).toBe('certecf');
  });

  test('la importación de la certificación nunca extiende un rango de producción', async () => {
    const { repo, query } = await crearRepositorio();
    await crearEsquemaViejo(query, { activadoEn: '2026-10-23 14:02:21' });
    await repo.ensureSchema();
    const saved = await repo.saveSequence(1, PRODUCCION);

    const covered = await repo.ensureSequenceCoverage({ query }, 1, { tipoComprobante: 'E32', numeroInicial: 1, numeroFinal: 10 });

    expect(covered.environment).toBe('certecf');
    expect(covered.id).not.toBe(saved.id);
    expect(await repo.getSequence(saved.id)).toMatchObject({ numero_final: 500, proximo_numero: 1 });
  });

  test('una secuencia elegida a mano no se usa en el ambiente equivocado', async () => {
    const { repo, query } = await crearRepositorio();
    await crearEsquemaViejo(query, { activadoEn: '2026-10-23 14:02:21' });
    await agregarSecuenciaVieja(query, 'E32', 1, 200, 10, '2026-10-22 09:13:46');
    await repo.ensureSchema();
    const [pruebas] = await repo.listSequences(1);

    await expect(repo.generateNextENCF({ tipoComprobante: 'E32', sequenceId: pruebas.id, environment: 'ecf' }))
      .rejects.toThrow(/producción y pruebas no se mezclan/);
  });
});

describe('números usados en pruebas no se pierden en producción', () => {
  async function conPruebasHechas() {
    const { repo, query } = await crearRepositorio();
    await crearEsquemaViejo(query, { activadoEn: '2026-10-23 14:02:21' });
    await repo.ensureSchema();
    // Índice que algunas bases traen: un e-NCF una sola vez sin importar el ambiente.
    await query('CREATE UNIQUE INDEX uq_ecf_documents_business_encf ON ecf_documents (business_id, encf)');
    for (const [encf, environment] of [['E320000000001', 'testecf'], ['E320000000002', 'certecf'], ['E320000000004', 'certecf']]) {
      await query(
        "INSERT INTO ecf_documents (business_id, tipo_ecf, encf, environment, estado_dgii) VALUES (1, 'E32', ?, ?, 'aceptado')",
        [encf, environment]
      );
    }
    await query(
      `INSERT INTO ecf_sequence_usage (business_id, tipo_ecf, encf, sequence_number, status, environment)
       VALUES (1, 'E32', 'E320000000003', 3, 'ACCEPTED', 'certecf')`
    );
    await repo.ensureSchema();
    await repo.saveSequence(1, PRODUCCION);
    return { repo, query };
  }

  test('producción empieza en E320000000001 aunque ese número se usó en pruebas', async () => {
    const { repo, query } = await conPruebasHechas();
    const primero = await repo.generateNextENCF({ tipoComprobante: 'E32', environment: 'ecf' });
    expect(primero.encf).toBe('E320000000001');

    // El índice ya distingue el ambiente: se puede guardar el documento real.
    await query(
      "INSERT INTO ecf_documents (business_id, tipo_ecf, encf, environment, estado_dgii) VALUES (1, 'E32', 'E320000000001', 'ecf', 'pendiente')"
    );
    await expect(query(
      "INSERT INTO ecf_documents (business_id, tipo_ecf, encf, environment, estado_dgii) VALUES (1, 'E32', 'E320000000001', 'ecf', 'pendiente')"
    )).rejects.toThrow(/UNIQUE/);

    const segundo = await repo.generateNextENCF({ tipoComprobante: 'E32', environment: 'ecf' });
    expect(segundo.encf).toBe('E320000000002');
  });

  test('en pruebas se siguen saltando los números ya usados en pruebas', async () => {
    const { repo } = await conPruebasHechas();
    await repo.saveSequence(1, { tipoComprobante: 'E32', environment: 'certecf', desde: 1, hasta: 50 });

    const siguiente = await repo.generateNextENCF({ tipoComprobante: 'E32', environment: 'certecf' });
    expect(siguiente.encf).toBe('E320000000005');
  });

  test('importar la certificación no pisa una venta real con el mismo e-NCF', async () => {
    const { repo, query } = await conPruebasHechas();
    await query(
      "INSERT INTO ecf_documents (business_id, tipo_ecf, encf, environment, estado_dgii, nombre_comprador) VALUES (1, 'E32', 'E320000000010', 'ecf', 'pendiente', 'Cliente real')"
    );

    await repo.saveImportedDocument({ query }, 1, { tipoEcf: 'E32', encf: 'E320000000010', environment: 'certecf' });

    const filas = await query("SELECT environment, estado_dgii, nombre_comprador FROM ecf_documents WHERE encf = 'E320000000010' ORDER BY id");
    expect(filas).toEqual([
      { environment: 'ecf', estado_dgii: 'pendiente', nombre_comprador: 'Cliente real' },
      expect.objectContaining({ environment: 'certecf' }),
    ]);
  });
});

describe('cuando la DGII aprueba más comprobantes', () => {
  test('primero se gasta el rango viejo y el nuevo espera su turno', async () => {
    const { repo, query } = await crearRepositorio();
    await crearEsquemaViejo(query, { activadoEn: '2026-10-23 14:02:21' });
    await repo.ensureSchema();
    const viejo = await repo.saveSequence(1, PRODUCCION);
    await query('UPDATE ecf_sequences SET proximo_numero = 499 WHERE id = ?', [viejo.id]);
    await repo.saveSequence(1, { ...PRODUCCION, authorizationReference: 'SOL-2026-000999', desde: 501, hasta: 1000 });

    const sigue = await repo.generateNextENCF({ tipoComprobante: 'E32', environment: 'ecf' });
    expect(sigue.encf).toBe('E320000000499');

    await query('UPDATE ecf_sequences SET proximo_numero = 501 WHERE id = ?', [viejo.id]); // se agotó
    const nuevo = await repo.generateNextENCF({ tipoComprobante: 'E32', environment: 'ecf' });
    expect(nuevo.encf).toBe('E320000000501');
  });
});

describe('módulo de secuencias e-NCF de producción (servicio)', () => {
  async function crearServicio() {
    const { repo, query } = await crearRepositorio();
    await crearEsquemaViejo(query, { activadoEn: '2026-10-23 14:02:21' });
    await agregarSecuenciaVieja(query, 'E32', 1, 9999999999, 1165, '2026-10-22 09:13:46');
    const service = createEcfService({
      query,
      withTransaction: async (work) => work({ query }),
      resolveRequestActorUser: async () => ({ id: 1, nombre: 'Emilio', rol: 'Administrador' }),
    });
    service.repository = repo;
    service.ensureReady = async () => { await repo.ensureSchema(); };
    await service.ensureReady();
    return { service, query };
  }

  test('lista solo producción o solo pruebas según el módulo que pregunta', async () => {
    const { service } = await crearServicio();
    await service.saveSequence({ body: PRODUCCION });

    const produccion = await service.listSequences({ environment: 'ecf' });
    const pruebas = await service.listSequences({ environment: 'certecf' });
    expect(produccion.map((s) => [s.tipoComprobante, s.desde, s.hasta])).toEqual([['E32', 1, 500]]);
    expect(produccion[0].label).toBe('Factura de Consumo Electrónica');
    expect(pruebas.map((s) => s.hasta)).toEqual([9999999999]);
  });

  test('guarda el historial y no borra un rango de producción con e-CF emitidos', async () => {
    const { service, query } = await crearServicio();
    const { sequence } = await service.saveSequence({ body: PRODUCCION });

    await expect(service.updateSequenceNext({ params: { id: sequence.id }, body: { proximoNumero: 900 } }))
      .rejects.toThrow(/dentro del rango autorizado/);
    await service.updateSequenceNext({ params: { id: sequence.id }, body: { proximoNumero: 5 } });

    const historial = await service.getSequenceHistory(sequence.id);
    expect(historial.map((h) => h.action)).toEqual(['sequence_next_changed', 'sequence_created']);
    expect(historial[1].detail).toMatch(/autorización DGII SOL-2026-000123/);

    await query(
      "INSERT INTO ecf_documents (business_id, sequence_id, tipo_ecf, encf, environment) VALUES (1, ?, 'E32', 'E320000000005', 'ecf')",
      [sequence.id]
    );
    await expect(service.deleteSequencePermanently({ params: { id: sequence.id } }))
      .rejects.toThrow(/ya tiene e-CF emitidos/);
  });
});

describe('archivo de la DGII (js/dgii-autorizacion.js, compartido con el panel de sucursales)', () => {
  const dgii = require('../js/dgii-autorizacion');
  // La pantalla vive en el navegador (js/ecf-sequences-config.js).
  const contexto = { document: { addEventListener: () => {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'ecf-sequences-config.js'), 'utf8'), contexto);

  test('saca tipo, rango, Nº de autorización y fecha de la SolicitudNCF', () => {
    // Tal como la copia la Oficina Virtual (el "<" inicial a veces se pierde).
    const respuesta = `SolicitudNCF>
<Solicitud_6010057797 xmlns="http://tempuri.org/dsCFiscales.xsd">
<NUM_SOL>6010057797</NUM_SOL>
<NUM_AUTOR>6005604697</NUM_AUTOR>
<FECHA_AUTOR>2026-10-25T11:25:00-04:00</FECHA_AUTOR>
<COMP>FACTURA DE CONSUMO ELECTRÓNICA</COMP>
<NUMERO_DESDE>E320000000001</NUMERO_DESDE>
<NUMERO_HASTA>E320000000100</NUMERO_HASTA>
<CODTIPO>32</CODTIPO>
<ESTATUS>APROBADA</ESTATUS>
</Solicitud_6010057797>
</SolicitudNCF>`;
    expect(dgii.leerXml(respuesta)).toEqual([E32_APROBADA]);
    expect(dgii.aprobados(dgii.leerXml(respuesta), 'B')).toEqual([]);
  });

  const E32_APROBADA = {
    tipo: 'E32',
    desde: 1,
    hasta: 100,
    referencia: '6005604697',
    fechaAutorizacion: '2026-10-25',
    estatus: 'APROBADA',
    comprobante: 'FACTURA DE CONSUMO ELECTRÓNICA',
  };
  const leerTabla = (matriz) => dgii.leerFilas(dgii.filasDeTabla(matriz));

  test('lee el CSV de la DGII (con título arriba y punto y coma)', () => {
    const csv = [
      'Consulta de Solicitudes de Comprobantes',
      'NUM_SOL;NUM_AUTOR;FECHA_AUTOR;COMP;NUMERO_DESDE;NUMERO_HASTA;CODTIPO;ESTATUS',
      '6010057797;6005604697;2026-10-25T11:25:00-04:00;"FACTURA DE CONSUMO ELECTRÓNICA";E320000000001;E320000000100;32;APROBADA',
    ].join('\r\n');
    expect(leerTabla(dgii.leerCsv(csv))).toEqual([E32_APROBADA]);
  });

  test('lee el Excel de la DGII con encabezados en español y fecha dd/mm/aaaa', () => {
    const XLSX = require('xlsx');
    const hoja = XLSX.utils.aoa_to_sheet([
      ['No. Solicitud', 'No. Autorización', 'Fecha Autorización', 'Comprobante', 'Número Desde', 'Número Hasta', 'Estatus'],
      [6010057797, 6005604697, '25/10/2026', 'FACTURA DE CONSUMO ELECTRÓNICA', 'E320000000001', 'E320000000100', 'APROBADA'],
    ]);
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Solicitud');
    const leido = XLSX.read(XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellDates: true });
    const matriz = XLSX.utils.sheet_to_json(leido.Sheets[leido.SheetNames[0]], { header: 1, defval: '', raw: true });
    expect(leerTabla(matriz)).toEqual([E32_APROBADA]);
  });

  test('varios archivos a la vez: junta los rangos, no repite y uno malo no frena a los demás', async () => {
    const solicitud = (desde, hasta, autor, estatus = 'APROBADA') => `<SolicitudNCF><Solicitud_1>
      <NUM_AUTOR>${autor}</NUM_AUTOR><FECHA_AUTOR>2026-10-25</FECHA_AUTOR><COMP>X</COMP>
      <NUMERO_DESDE>${desde}</NUMERO_DESDE><NUMERO_HASTA>${hasta}</NUMERO_HASTA><ESTATUS>${estatus}</ESTATUS>
    </Solicitud_1></SolicitudNCF>`;
    const csv = 'NUMERO_DESDE;NUMERO_HASTA;NUM_AUTOR;FECHA_AUTOR;ESTATUS\nB0200000001;B0200000500;5009418959;20/10/2026;APROBADA';
    const leido = await dgii.leerArchivos([
      new File([solicitud('E320000000001', 'E320000000100', '6005604697')], 'e32.xml'),
      new File([solicitud('E310000000001', 'E310000000050', '6005604698', 'EN PROCESO')], 'e31-pendiente.xml'),
      new File([solicitud('E310000000001', 'E310000000050', '6005604698')], 'e31.xml'),
      new File([solicitud('E320000000001', 'E320000000100', '6005604697')], 'e32-copia.xml'),
      new File([csv], 'b02.csv'),
      new File(['no es de la DGII'], 'otro.xml'),
    ]);
    expect(leido.rangos.map((r) => `${r.tipo} ${r.desde}-${r.hasta} ${r.estatus} ${r.archivo}`)).toEqual([
      'E32 1-100 APROBADA e32.xml',
      'E31 1-50 APROBADA e31.xml', // el pendiente se cambia por el aprobado de otro archivo
      'B02 1-500 APROBADA b02.csv',
    ]);
    expect(leido.errores).toEqual([{ archivo: 'otro.xml', mensaje: 'No trae rangos de la DGII.' }]);
    expect(dgii.aprobados(leido.rangos, 'E')).toHaveLength(2);
  });

  test('marca "En uso" el rango más bajo con números y deja el nuevo "En espera"', () => {
    const base = { tipoComprobante: 'E32', activo: true, isExpired: false, isExhausted: false, branchId: null, cashRegisterId: null };
    const enUso = contexto.ecfProdSeqInUseIds([
      { ...base, id: 20, desde: 101, hasta: 200 },
      { ...base, id: 13, desde: 1, hasta: 100 },
      { ...base, id: 7, desde: 1, hasta: 50, tipoComprobante: 'E31' },
    ]);
    expect([...enUso].sort()).toEqual([13, 7]);
  });

  test('lee el detalle en vertical (campo | valor)', () => {
    expect(leerTabla([
      ['NUM_AUTOR', '6005604697'],
      ['FECHA_AUTOR', '25/10/2026'],
      ['COMP', 'FACTURA DE CONSUMO ELECTRÓNICA'],
      ['NUMERO_DESDE', 'E320000000001'],
      ['NUMERO_HASTA', 'E320000000100'],
      ['ESTATUS', 'APROBADA'],
    ])).toEqual([E32_APROBADA]);
  });
});

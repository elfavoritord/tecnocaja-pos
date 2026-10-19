'use strict';

/**
 * Respaldo y restauración de una sucursal enlazada: lo que todavía no confirmó
 * la central (sync_outbox), los cursores de descarga, los conflictos y los
 * rangos NCF de la central viajan en el .tcbak y vuelven al restaurar.
 * Prueba de aceptación 16 del prompt maestro (parte multisucursal).
 */

jest.mock('../../db', () => ({
  getDbClient: () => 'sqlite',
  withTransaction: async (work) => work({ query: () => [] }),
}));

const { crearBaseSqlite } = require('../multisucursal/sqlite-helper');
const { createMigrationRunner } = require('../../server/migrations/runner');
const migraciones = require('../../server/migrations/multisucursal');
const { buildFullPayload, restorePayloadToDb, createTcbakBuffer, parseTcbakBuffer } = require('../../server/services/backup-core');

const silencioso = { log() {}, warn() {}, error() {} };

async function baseMigrada() {
  const base = await crearBaseSqlite();
  await createMigrationRunner({ query: base.query, withTransaction: base.withTransaction, dialect: 'sqlite', migrations: migraciones, logger: silencioso }).runPending();
  return base;
}

describe('Respaldo de una sucursal enlazada', () => {
  let warnOriginal;
  let logOriginal;
  beforeEach(() => {
    warnOriginal = console.warn; logOriginal = console.log;
    console.warn = () => {}; console.log = () => {};
  });
  afterEach(() => { console.warn = warnOriginal; console.log = logOriginal; });

  test('la bandeja sin confirmar, los cursores, los conflictos y los rangos NCF sobreviven al respaldo', async () => {
    const origen = await baseMigrada();
    await origen.query("INSERT INTO users (id, usuario, password, nombre, rol) VALUES (1, 'admin', '', 'Admin', 'Administrador')");
    await origen.query("INSERT INTO products (codigo, nombre, categoria, precio_venta, stock, origen_catalogo, catalogo_version) VALUES ('F1', 'Martillo', 'H', 450, 3, 'central', 2)");
    await origen.query(`INSERT INTO sync_outbox (event_id, entity_type, entity_uuid, operation, payload, created_at_utc, status)
                        VALUES ('e-pend', 'venta', 'u1', 'registrar', '{}', '2026-10-19T10:00:00.000Z', 'pendiente'),
                               ('e-ok', 'venta', 'u2', 'registrar', '{}', '2026-10-19T09:00:00.000Z', 'sincronizado')`);
    await origen.query("INSERT INTO sync_cursors (stream, cursor_value, updated_at_utc) VALUES ('bajada:catalogo', '42', '2026-10-19T10:00:00.000Z')");
    await origen.query(`INSERT INTO sync_conflictos (entity_type, entity_uuid, clave, payload, motivo, created_at_utc)
                        VALUES ('producto', 'c1', 'F9', '{}', 'mismo código', '2026-10-19T10:00:00.000Z')`);
    await origen.query(`INSERT INTO ncf_rangos_central (rango_uuid, tipo, desde, hasta, estado, sistema, recibido_at_utc)
                        VALUES ('r1', 'B02', 2501, 5000, 'en_uso', 'legado', '2026-10-19T10:00:00.000Z')`);

    const payload = await buildFullPayload(origen.query);
    // Ida y vuelta por el formato real del archivo (.tcbak cifrado).
    const archivo = await createTcbakBuffer(payload, 'clave-de-prueba');
    const leido = await parseTcbakBuffer(archivo, 'clave-de-prueba');

    const destino = await baseMigrada();
    await restorePayloadToDb(leido.payload || leido, destino.query);

    expect(await destino.query('SELECT event_id, status FROM sync_outbox')).toEqual([{ event_id: 'e-pend', status: 'pendiente' }]);
    expect(await destino.query('SELECT stream, cursor_value FROM sync_cursors')).toEqual([{ stream: 'bajada:catalogo', cursor_value: '42' }]);
    expect((await destino.query("SELECT clave FROM sync_conflictos WHERE estado = 'pendiente'")).map((r) => r.clave)).toEqual(['F9']);
    expect(await destino.query('SELECT rango_uuid, estado, desde, hasta FROM ncf_rangos_central')).toEqual([{ rango_uuid: 'r1', estado: 'en_uso', desde: 2501, hasta: 5000 }]);
    expect(await destino.query("SELECT origen_catalogo, catalogo_version FROM products WHERE codigo = 'F1'")).toEqual([{ origen_catalogo: 'central', catalogo_version: 2 }]);
    origen.close();
    destino.close();
  });
});

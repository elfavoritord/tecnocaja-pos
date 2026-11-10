'use strict';
jest.mock('../../db', () => ({ getDbClient: () => 'sqlite' }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crearBaseSqlite } = require('../multisucursal/sqlite-helper');
const core = require('../../server/services/backup-core');
const catalog = require('../../server/services/backup-catalog');
const files = require('../../server/services/backup-components');
const restore = require('../../server/services/backup-restore-integral');

describe('respaldo integral V3 (solo bases y archivos temporales)', () => {
  let base, root, components, payload;
  beforeEach(async () => {
    base = await crearBaseSqlite();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-backup-test-'));
    components = [{ id: 'productos', root }];
    await base.query('ALTER TABLE config ADD COLUMN business_uuid TEXT');
    await base.query("UPDATE config SET business_uuid = 'empresa-original', setup_completed = 1 WHERE id = 1");
    await base.query("INSERT INTO users (id, usuario, password, nombre, rol) VALUES (1,'admin','clave-local','Admin','Administrador')");
    await base.query('CREATE TABLE servicios_prueba (id INTEGER PRIMARY KEY, estado TEXT, archivo TEXT)');
    await base.query('CREATE TABLE mesas_prueba (id INTEGER PRIMARY KEY, nombre TEXT)');
    await base.query('CREATE TABLE modulo_futuro (id INTEGER PRIMARY KEY, valor TEXT)');
    await base.query('CREATE TABLE license_cache (id INTEGER PRIMARY KEY, cache_blob TEXT, license_id TEXT)');
    await base.query("INSERT INTO license_cache (id, cache_blob) VALUES (1, 'autorizacion-no-transferible')");
    await base.query('INSERT INTO servicios_prueba VALUES (7, ?, ?)', ['aceptado', path.join(root, 'factura.pdf')]);
    await base.query("INSERT INTO mesas_prueba VALUES (9, 'Mesa 9')");
    fs.writeFileSync(path.join(root, 'factura.pdf'), 'documento-fixture');
    payload = await core.buildFullPayload(base.query, { components });
  });
  afterEach(() => { base?.close(); fs.rmSync(root, { recursive: true, force: true }); });

  test('incluye módulos descubiertos, cifra y recupera tres veces sin duplicar ni copiar activación', async () => {
    expect(payload.catalogo.tablas.modulo_futuro).toEqual([]);
    expect(payload.catalogo.tablas.license_cache).toBeUndefined();
    expect(payload.catalogo.tablas.users[0].password).toBe('');
    expect(payload.catalogo.tablas.users[0].password_hash).toMatch(/^scrypt:/);
    const buffer = await core.createTcbakBuffer(payload, 'clave-larga-prueba');
    await expect(core.parseTcbakBuffer(buffer, 'equivocada')).rejects.toThrow(/Contraseña/);
    const parsed = await core.parseTcbakBuffer(buffer, 'clave-larga-prueba');
    expect(parsed.payload.companyUuid).toBe('empresa-original');
    for (let n = 0; n < 3; n++) {
      await base.query("INSERT OR REPLACE INTO modulo_futuro VALUES (1, 'sobrante')");
      fs.writeFileSync(path.join(root, 'factura.pdf'), 'cambiado');
      await restore.restaurar(parsed.payload, base.query, { withTransaction: base.withTransaction, components });
      expect(await base.query('SELECT * FROM modulo_futuro')).toEqual([]);
      expect(await base.query('SELECT id, estado FROM servicios_prueba')).toEqual([{ id: 7, estado: 'aceptado' }]);
      expect(await base.query('SELECT * FROM mesas_prueba')).toEqual([{ id: 9, nombre: 'Mesa 9' }]);
      expect(fs.readFileSync(path.join(root, 'factura.pdf'), 'utf8')).toBe('documento-fixture');
      expect((await base.query('SELECT cache_blob FROM license_cache'))[0].cache_blob).toBe('autorizacion-no-transferible');
    }
  });
  test('rechaza empresa ajena y corrupción antes de tocar datos', async () => {
    payload.companyUuid = 'otra-empresa';
    await expect(restore.restaurar(payload, base.query, { withTransaction: base.withTransaction, components })).rejects.toThrow(/otra empresa/);
    payload.companyUuid = 'empresa-original';
    payload.catalogo.tablas.mesas_prueba[0].nombre = 'alterado';
    await expect(restore.prevalidar(payload, base.query, { components })).rejects.toThrow(/Integridad/);
    expect((await base.query('SELECT nombre FROM mesas_prueba'))[0].nombre).toBe('Mesa 9');
  });
  test('revierte la base y los adjuntos si falla la confirmación', async () => {
    await base.query("UPDATE mesas_prueba SET nombre = 'estado actual'");
    fs.writeFileSync(path.join(root, 'factura.pdf'), 'archivo actual');
    const fallarCommit = (work) => base.withTransaction(async (tx) => { await work(tx); throw new Error('fallo de disco simulado'); });
    await expect(restore.restaurar(payload, base.query, { withTransaction: fallarCommit, components })).rejects.toThrow(/fallo de disco/);
    expect((await base.query('SELECT nombre FROM mesas_prueba'))[0].nombre).toBe('estado actual');
    expect(fs.readFileSync(path.join(root, 'factura.pdf'), 'utf8')).toBe('archivo actual');
    expect(fs.readdirSync(root)).toEqual(['factura.pdf']);
  });
  test('no acepta errores de tabla, columnas desconocidas ni rutas fuera del destino', async () => {
    await expect(catalog.capturarCatalogo(async (sql) => {
      if (sql.includes('sqlite_master')) return [{ name: 'servicios_prueba' }];
      throw new Error('lectura fallida');
    })).rejects.toThrow('lectura fallida');
    payload.catalogo.tablas.mesas_prueba[0].columna_nueva = 1;
    payload.catalogo.manifiesto.find((m) => m.nombre === 'mesas_prueba').sha256 = catalog.hash(payload.catalogo.tablas.mesas_prueba);
    await expect(restore.prevalidar(payload, base.query, { components })).rejects.toThrow(/columna/);
    payload.archivos.archivos[0].path = '../fuera.pdf';
    expect(() => files.validar(payload.archivos, components)).toThrow(/insegura/);
  });
  test('el contador histórico e-NCF nunca retrocede al restaurar un archivo antiguo', async () => {
    const file = path.join(root, 'ecf-sequence-high-watermarks.json');
    const controls = [{ id: 'fiscal-control', root, files: ['ecf-sequence-high-watermarks.json'] }];
    fs.writeFileSync(file, JSON.stringify({ version: 1, environments: { certecf: { maxima: { E31: 5, E32: 9 } } } }));
    const archive = await files.capturar({ components: controls });
    fs.writeFileSync(file, JSON.stringify({ version: 1, environments: { certecf: { maxima: { E31: 12, E32: 3 } } } }));
    const staged = await files.preparar(archive, { components: controls });
    await staged.commit(); await staged.terminar();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).environments.certecf.maxima).toEqual({ E31: 12, E32: 9 });
  });
});

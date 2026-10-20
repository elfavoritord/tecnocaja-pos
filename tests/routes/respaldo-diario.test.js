'use strict';

/**
 * Respaldo automático diario (server/routes/respaldos.routes.js +
 * server/services/retencion-respaldos.js): una copia por día, local y en la
 * nube, y solo quedan la de hoy y la del día anterior. Base SQLite real en
 * memoria y una nube simulada.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockNube = new Map();
jest.mock('../../server/services/r2-storage', () => ({
  backupPrefix: (id) => `backups/${id}/`,
  backupKey: (id, nombre) => `backups/${id}/${nombre}`,
  upload: jest.fn(async (key, buf) => { mockNube.set(key, { buf, fecha: new Date() }); }),
  listObjects: jest.fn(async (prefix) => [...mockNube.entries()]
    .filter(([k]) => k.startsWith(prefix)).map(([Key, v]) => ({ Key, LastModified: v.fecha, Size: v.buf.length }))),
  remove: jest.fn(async (key) => { mockNube.delete(key); }),
  isR2Available: jest.fn(async () => true),
}));

const { crearBaseSqlite } = require('../multisucursal/sqlite-helper');
const respaldos = require('../../server/routes/respaldos.routes');
const retencion = require('../../server/services/retencion-respaldos');

const DIA = (d, h = 10, m = 0) => new Date(2026, 9, d, h, m);

describe('Respaldo automático: una copia por día, quedan hoy y ayer', () => {
  let base;
  let casa;
  let carpeta;
  let envAntes;

  beforeEach(async () => {
    envAntes = { ...process.env };
    process.env.R2_ACCESS_KEY_ID = 'clave';
    process.env.R2_SECRET_ACCESS_KEY = 'secreto';
    process.env.TECNO_CAJA_LICENSE_UID = 'pos_prueba';
    process.env.TECNO_CAJA_SECURITY_PASSWORD = 'clave-de-prueba-respaldos';
    mockNube.clear();
    casa = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-respaldo-'));
    jest.spyOn(os, 'homedir').mockReturnValue(casa);
    carpeta = path.join(casa, 'Documents', 'TecnoCaja', 'Backups');
    base = await crearBaseSqlite();
    await base.query("UPDATE config SET setup_completed = 1, business_name = 'Colmado Prueba' WHERE id = 1");
    await base.query("INSERT INTO users (usuario, password, nombre, rol) VALUES ('admin', '', 'Admin', 'Administrador')");
    await base.query("INSERT INTO products (codigo, nombre, categoria, precio_venta) VALUES ('P1', 'Arroz', 'X', 10)");
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    base.close();
    fs.rmSync(casa, { recursive: true, force: true });
    process.env = envAntes;
  });

  function en(fecha) {
    jest.useFakeTimers({ now: fecha, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
  }
  const locales = () => fs.readdirSync(carpeta).filter((f) => f.endsWith('.tcbak')).sort();
  const enNube = () => [...mockNube.keys()].map((k) => path.basename(k)).sort();
  const respaldar = (trigger = 'cierre_app') => respaldos.createAutomaticBackup({ query: base.query, trigger });

  test('el mismo día se reemplaza la copia; quedan solo hoy y el día anterior (local y nube)', async () => {
    en(DIA(17));
    const r1 = await respaldar();
    expect(r1).toMatchObject({ ok: true, fileName: 'TecnoCaja_Diario_Colmado_Prueba_2026-10-17.tcbak', estado: 'completado' });
    en(DIA(17, 21, 30));
    await respaldar('cierre_caja');
    expect(locales()).toEqual(['TecnoCaja_Diario_Colmado_Prueba_2026-10-17.tcbak']);
    expect(enNube()).toEqual(['TecnoCaja_Diario_Colmado_Prueba_2026-10-17.tcbak']);

    // Un respaldo manual y uno automático viejo (de antes de este cambio).
    fs.writeFileSync(path.join(carpeta, 'TecnoCaja_Backup_Colmado_Prueba_15-10-2026_09h00_v1.4.7.tcbak'), 'manual');
    fs.writeFileSync(path.join(carpeta, 'TecnoCaja_Backup_Colmado_Prueba_AUTO_16-10-2026_20h00_v1.4.7.tcbak'), 'viejo');
    fs.utimesSync(path.join(carpeta, 'TecnoCaja_Backup_Colmado_Prueba_AUTO_16-10-2026_20h00_v1.4.7.tcbak'), DIA(16, 20), DIA(16, 20));

    en(DIA(18));
    await respaldar();
    en(DIA(19));
    await respaldar();
    expect(locales()).toEqual([
      'TecnoCaja_Backup_Colmado_Prueba_15-10-2026_09h00_v1.4.7.tcbak',
      'TecnoCaja_Diario_Colmado_Prueba_2026-10-18.tcbak',
      'TecnoCaja_Diario_Colmado_Prueba_2026-10-19.tcbak',
    ]);
    expect(enNube()).toEqual([
      'TecnoCaja_Diario_Colmado_Prueba_2026-10-18.tcbak',
      'TecnoCaja_Diario_Colmado_Prueba_2026-10-19.tcbak',
    ]);
  });

  test('si la PC no se usó ayer, queda la del último día que se usó', async () => {
    en(DIA(10));
    await respaldar();
    en(DIA(13));
    await respaldar();
    en(DIA(17));
    await respaldar();
    expect(locales()).toEqual([
      'TecnoCaja_Diario_Colmado_Prueba_2026-10-13.tcbak',
      'TecnoCaja_Diario_Colmado_Prueba_2026-10-17.tcbak',
    ]);
  });

  test('un cambio de productos no rehace la copia si se hizo hace menos de 15 minutos', async () => {
    en(DIA(19, 10, 0));
    await respaldar();
    en(DIA(19, 10, 5));
    // La espera se mide con la hora del archivo (real): recién escrito.
    expect(await respaldar('crear_producto')).toMatchObject({ skipped: true });
    const cierre = await respaldar('cierre_caja');
    expect(cierre.ok).toBe(true);
    expect(cierre.skipped).toBeFalsy();
  });

  test('una base que parece vacía no pisa la copia buena ni hace borrar la de ayer', async () => {
    en(DIA(18));
    await respaldar();
    en(DIA(19));
    await respaldar();
    const buena = fs.readFileSync(path.join(carpeta, 'TecnoCaja_Diario_Colmado_Prueba_2026-10-19.tcbak'));
    // La base se perdió y arrancó en blanco.
    await base.query('DELETE FROM users');
    await base.query('DELETE FROM products');
    en(DIA(19, 22, 15));
    const r = await respaldar('cierre_app');
    expect(r).toMatchObject({ ok: true, paraRevisar: true, fileName: 'TecnoCaja_Revisar_Colmado_Prueba_2026-10-19_22h15.tcbak' });
    expect(fs.readFileSync(path.join(carpeta, 'TecnoCaja_Diario_Colmado_Prueba_2026-10-19.tcbak'))).toEqual(buena);
    expect(locales()).toEqual([
      'TecnoCaja_Diario_Colmado_Prueba_2026-10-18.tcbak',
      'TecnoCaja_Diario_Colmado_Prueba_2026-10-19.tcbak',
      'TecnoCaja_Revisar_Colmado_Prueba_2026-10-19_22h15.tcbak',
    ]);
  });

  test('copia del día: se hace una vez y no se repite el mismo día', async () => {
    en(DIA(19, 8));
    expect(await respaldos.asegurarCopiaDelDia(base.query)).toMatchObject({ ok: true, fileName: expect.stringContaining('2026-10-19') });
    expect(await respaldos.asegurarCopiaDelDia(base.query)).toMatchObject({ skipped: true });
    en(DIA(20, 8));
    expect(await respaldos.asegurarCopiaDelDia(base.query)).toMatchObject({ fileName: expect.stringContaining('2026-10-20') });
  });

  test('sin nube configurada se guarda solo local, sin dejar subidas pendientes', async () => {
    delete process.env.R2_ACCESS_KEY_ID;
    en(DIA(19));
    expect(await respaldar()).toMatchObject({ ok: true, estado: 'completado', storagePath: null });
    expect(mockNube.size).toBe(0);
  });
});

describe('Reglas de retención', () => {
  test('aBorrar: automáticos por día, manuales por cantidad, para revisar los 3 últimos', () => {
    const f = (nombre, fecha) => ({ nombre, fecha });
    const borrar = retencion.aBorrar([
      f('TecnoCaja_Diario_X_2026-10-19.tcbak', DIA(19)),
      f('TecnoCaja_Diario_X_2026-10-18.tcbak', DIA(18)),
      f('TecnoCaja_Diario_X_2026-10-17.tcbak', DIA(17)),
      f('TecnoCaja_Backup_X_AUTO_19-10-2026_09h00_v1.tcbak', DIA(19, 9)),
      f('TecnoCaja_Backup_X_PRE-RESTAURACION_01-10-2026_10h00_v1.tcbak', DIA(1)),
      f('TecnoCaja_Backup_X_01-09-2026_10h00_v1.tcbak', DIA(1) - 30 * 864e5),
      f('TecnoCaja_Revisar_X_2026-10-10_10h00.tcbak', DIA(10)),
      f('TecnoCaja_Revisar_X_2026-10-11_10h00.tcbak', DIA(11)),
      f('TecnoCaja_Revisar_X_2026-10-12_10h00.tcbak', DIA(12)),
      f('TecnoCaja_Revisar_X_2026-10-13_10h00.tcbak', DIA(13)),
    ], { otrosMax: 1 });
    expect(borrar.sort()).toEqual([
      'TecnoCaja_Backup_X_01-09-2026_10h00_v1.tcbak',
      'TecnoCaja_Backup_X_AUTO_19-10-2026_09h00_v1.tcbak',
      'TecnoCaja_Diario_X_2026-10-17.tcbak',
      'TecnoCaja_Revisar_X_2026-10-10_10h00.tcbak',
    ]);
  });

  test('pareceVacio', () => {
    expect(retencion.pareceVacio({ usuarios: 0, productos: 50, ventas: 9 }, null)).toBe(true);
    expect(retencion.pareceVacio({ usuarios: 2, productos: 0, ventas: 0 }, null)).toBe(false);
    expect(retencion.pareceVacio({ usuarios: 2, productos: 0, ventas: 0 }, { productos: 30, ventas: 100 })).toBe(true);
    expect(retencion.pareceVacio({ usuarios: 2, productos: 31, ventas: 100 }, { productos: 30, ventas: 100 })).toBe(false);
  });

  test('fechaLocal y nombreDiario usan la fecha de la PC (no UTC)', () => {
    expect(retencion.fechaLocal(DIA(19, 23, 30))).toBe('2026-10-19');
    expect(retencion.nombreDiario('Colmado Ñoño & Hijos', DIA(19, 23, 30))).toBe('TecnoCaja_Diario_Colmado_Nono_Hijos_2026-10-19.tcbak');
  });
});

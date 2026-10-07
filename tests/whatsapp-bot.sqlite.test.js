'use strict';

/**
 * El bot de WhatsApp en una instalación monocaja nueva (SQLite).
 *
 * Antes usaba SQL solo de MariaDB (ON DUPLICATE KEY UPDATE, CURDATE(), NOW(),
 * DATE_SUB…) y en SQLite no podía ni guardar su configuración ni leer las
 * ventas. Estas pruebas corren el SQL real del bot contra el esquema real
 * (db/schema.sql convertido igual que en el primer arranque).
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { normalizeSchema } = require('../scripts/auto-init-db');
const { saveBotConfig } = require('../server/routes/whatsapp-bot.routes');
const bot = require('../server/integrations/whatsapp-bot');

// Mismo contrato que db.js query() en modo SQLite.
function createSqliteQuery(db) {
  return async (sql, params = []) => {
    const statement = db.prepare(sql);
    statement.bind(params);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) {
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      statement.free();
      return rows;
    }
    statement.run();
    statement.free();
    return { insertId: 0, affectedRows: db.getRowsModified() };
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function localStamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

let db;
let query;

beforeAll(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  const schema = normalizeSchema(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  for (const statement of schema.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
    db.run(statement);
  }
  query = createSqliteQuery(db);
  bot._test.setDb(query);
});

afterAll(() => {
  bot._test.setDb(null);
  db.close();
});

describe('Bot WhatsApp sobre SQLite (monocaja)', () => {
  test('guarda y actualiza su configuración sin errores de sintaxis', async () => {
    await saveBotConfig(query, 'wabot_owner_phone', '18095550000');
    await saveBotConfig(query, 'wabot_owner_phone', '18095551111');
    await saveBotConfig(query, 'wabot_autostart', '1');
    const rows = await query(
      "SELECT config_key, config_value FROM offline_cache_config WHERE config_key LIKE 'wabot_%' ORDER BY config_key"
    );
    expect(rows).toEqual([
      { config_key: 'wabot_autostart', config_value: '1' },
      { config_key: 'wabot_owner_phone', config_value: '18095551111' },
    ]);
  });

  test('lee las ventas del día, de ayer y la última venta', async () => {
    const now = new Date();
    const inicioDelDia = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Pasada la medianoche no hay "hace 10 min" de hoy: se usa las 00:00.
    const haceDiezMin = new Date(Math.max(now.getTime() - 10 * 60000, inicioDelDia.getTime()));
    const ayer = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0);
    const insertSale = (invoice, total, method, createdAt) => query(
      `INSERT INTO sales (invoice_number, user_id, payment_method, subtotal, tax, total, sale_status, fiscal_status, created_at)
       VALUES (?, 1, ?, ?, 0, ?, 'pagada', 'emitida', ?)`,
      [invoice, method, total, total, localStamp(createdAt)]
    );
    await insertSale('FAC-1', 100, 'efectivo', haceDiezMin);
    await insertSale('FAC-2', 50, 'tarjeta', haceDiezMin);
    await insertSale('FAC-0', 80, 'efectivo', ayer);

    const data = await bot._test.getBusinessData('dame las ventas por hora de la semana y las últimas');
    expect(data).not.toBeNull();
    expect(Number(data.d.ventasHoy)).toBe(150);
    expect(Number(data.d.facturasHoy)).toBe(2);
    expect(Number(data.d.efectivoHoy)).toBe(100);
    expect(Number(data.d.ventasAyer)).toBe(80);
    expect(data.d.ultimaVenta).toMatch(/^hace (menos de 1|\d+) min$/);
    expect(data.d.horas).toEqual([
      expect.objectContaining({ hora: haceDiezMin.getHours(), facturas: 2, total: 150 }),
    ]);
    expect(data.d.ultimas.map((v) => v.invoice_number).sort()).toEqual(['FAC-1', 'FAC-2']);
    expect(data.text).toContain('VENTAS HOY');
  });

  test('las fechas de corte salen en hora local (lunes como inicio de semana)', () => {
    const domingo = new Date(2026, 9, 11, 22, 30); // domingo 11-oct-2026
    expect(bot._test.businessDateKeys(domingo)).toEqual({
      today: '2026-10-11',
      yesterday: '2026-10-10',
      monthStart: '2026-10-01',
      prevMonthStart: '2026-09-01',
      last30: '2026-09-11',
      weekStart: '2026-10-05',
    });
    const enero = new Date(2026, 0, 1, 8, 0);
    expect(bot._test.businessDateKeys(enero).prevMonthStart).toBe('2025-12-01');
  });

  test('cambia cada :fecha por ? en el orden en que aparece', () => {
    const [sql, params] = bot._test.bindDateKeys(
      'SELECT 1 WHERE a >= :monthStart AND b = :today AND c < :monthStart',
      { today: 'T', monthStart: 'M' }
    );
    expect(sql).toBe('SELECT 1 WHERE a >= ? AND b = ? AND c < ?');
    expect(params).toEqual(['M', 'T', 'M']);
  });
});

describe('Carpeta de la sesión del bot', () => {
  const originalUserData = process.env.TECNO_CAJA_USER_DATA;
  const originalCwd = process.cwd();
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wabot-dir-'));
    fs.mkdirSync(path.join(tmpRoot, 'programa'));
    fs.mkdirSync(path.join(tmpRoot, 'userdata'));
    process.chdir(path.join(tmpRoot, 'programa'));
    process.env.TECNO_CAJA_USER_DATA = path.join(tmpRoot, 'userdata');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalUserData === undefined) delete process.env.TECNO_CAJA_USER_DATA;
    else process.env.TECNO_CAJA_USER_DATA = originalUserData;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('en una instalación nueva va en los datos del usuario, no en la carpeta del programa', () => {
    expect(bot._test.resolveBotDataDir()).toBe(path.join(tmpRoot, 'userdata', '.wwebjs_auth_pos'));
  });

  test('si ya había una sesión en la ruta vieja, la sigue usando (no pide el QR otra vez)', () => {
    fs.mkdirSync(path.join(tmpRoot, 'programa', '.wwebjs_auth_pos', 'session-tecno-caja-pos-bot'), { recursive: true });
    expect(fs.realpathSync(bot._test.resolveBotDataDir()))
      .toBe(fs.realpathSync(path.join(tmpRoot, 'programa', '.wwebjs_auth_pos')));
  });
});

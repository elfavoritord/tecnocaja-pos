'use strict';

/**
 * Punta a punta del motor de sincronización del POS (server/multisucursal/
 * sincronizacion.js): varias "PC" con su propia base SQLite (esquema real y
 * migraciones reales) hablando por HTTP con la Sync API real, sobre el
 * emulador de Firestore. Cubre las pruebas de aceptación del prompt maestro
 * que se pueden automatizar sin la pantalla.
 *   npm run test:multisucursal-central
 */

const enEmulador = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const describir = enEmulador ? describe : describe.skip;
jest.setTimeout(120000);

const PROYECTO = 'demo-tecnocaja';
const { crearBaseSqlite } = require('../sqlite-helper');
const { createMultisucursal } = require('../../../server/multisucursal');
const { createSucursalesCentral } = require('../../../server/multisucursal/central/sucursales');
const { createSincronizacionCentral } = require('../../../server/multisucursal/central/sincronizacion-central');
const { createApp } = require('../../../cloud/sync-api/lib/app');

const LIC = 'pos:tecno-caja-ferreteria';
const LIC2 = 'pos:tecno-caja-otra';
const EMILIO = { tipo: 'super_admin', uid: 'emilio', nombre: 'Emilio' };
const silencioso = { log() {}, warn() {}, error() {}, info() {} };
const HASH_ADMIN = `scrypt:${'c'.repeat(32)}:${'d'.repeat(128)}`;

describir('Sincronización POS ↔ central (SQLite + Sync API + emulador)', () => {
  let db;
  let servidor;
  let url;
  let central;
  let centralSync;
  const pcs = [];

  beforeAll(async () => {
    const admin = require('firebase-admin');
    db = admin.initializeApp({ projectId: PROYECTO }, `sync-pos-${Date.now()}`).firestore();
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
    await fetch(`http://${host}:${port}/emulator/v1/projects/${PROYECTO}/databases/(default)/documents`, { method: 'DELETE' });
    servidor = await new Promise((resolve) => {
      const s = createApp({ db, limites: { activarMax: 100, equipoPorMinuto: 10000 } }).listen(0, '127.0.0.1', () => resolve(s));
    });
    url = `http://127.0.0.1:${servidor.address().port}`;
    central = createSucursalesCentral({ db });
    centralSync = createSincronizacionCentral({ db });
    await db.collection('licencias').doc(LIC).set({ businessName: 'Ferretería Duarte', status: 'active', contadorId: 'firma-1' });
    await db.collection('licencias').doc(LIC2).set({ businessName: 'Otra empresa', status: 'active' });
    await central.fijarLimite(LIC, 3, EMILIO);
  });

  afterAll(async () => {
    const cerradas = new Set();
    for (const pc of pcs) {
      pc.ms.sincronizacion.detener();
      pc.ms.enlace.detener();
      if (!cerradas.has(pc.base)) { cerradas.add(pc.base); pc.base.close(); }
    }
    await new Promise((r) => servidor.close(r));
  });

  async function crearPc(nombre, { licencia = LIC, base = null } = {}) {
    const b = base || await crearBaseSqlite();
    if (!base) {
      await b.query('CREATE TABLE installation_config (id INTEGER PRIMARY KEY AUTOINCREMENT, config_key VARCHAR(100) NOT NULL, config_value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
      await b.query(`CREATE TABLE ncf_sequences (id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INT NOT NULL DEFAULT 1, branch_id INT DEFAULT NULL,
        ncf_type VARCHAR(5) NOT NULL, siguiente_numero INT NOT NULL DEFAULT 1, maximo INT NOT NULL DEFAULT 99999999, activa TINYINT(1) NOT NULL DEFAULT 1,
        fecha_vencimiento DATE DEFAULT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      await b.query('ALTER TABLE sales ADD COLUMN ncf VARCHAR(19) DEFAULT NULL');
      await b.query('ALTER TABLE sales ADD COLUMN ncf_type VARCHAR(5) DEFAULT NULL');
      await b.query(`INSERT INTO users (id, usuario, password, password_hash, nombre, rol, role_id) VALUES (1, 'admin', '', ?, 'Admin', 'Administrador', 1)`, [HASH_ADMIN]);
    }
    const env = { TECNO_CAJA_SYNC_URL: url };
    const ms = createMultisucursal({
      query: b.query, withTransaction: b.withTransaction, getDbClient: () => 'sqlite', env, persistEnv: () => {},
      getEquipo: () => ({ hostname: nombre, appVersion: '1.5.0', licenseId: licencia }), logger: silencioso,
    });
    await ms.prepararAlArrancar();
    const pc = { nombre, base: b, env, ms, licencia };
    pcs.push(pc);
    return pc;
  }

  async function enlazar(pc, nombreSucursal, licencia = LIC) {
    const s = await central.crear(licencia, { nombre: nombreSucursal }, EMILIO);
    const { codigo } = await central.generarCodigo(licencia, s.branchUuid, EMILIO);
    const r = await pc.ms.enlace.activar(codigo);
    pc.ms.enlace.detener();
    expect(r.vinculado).toBe(true);
    pc.branchUuid = s.branchUuid;
    return s;
  }

  const ciclo = (pc) => pc.ms.sincronizacion.ciclo();
  const productos = (pc) => pc.base.query('SELECT codigo, nombre, precio_venta, stock, estado, uuid, origen_catalogo FROM products ORDER BY codigo');
  const producto = async (pc, codigo) => (await pc.base.query('SELECT * FROM products WHERE codigo = ? LIMIT 1', [codigo]))[0];
  let factura = 0;
  async function vender(pc, codigo, cantidad, { estado = 'pagada', ncf = null } = {}) {
    const p = await producto(pc, codigo);
    factura += 1;
    const total = Number(p.precio_venta) * cantidad;
    const r = await pc.base.query(
      `INSERT INTO sales (invoice_number, user_id, payment_method, subtotal, tax, total, sale_status, fiscal_status, created_at, operative_date, ncf, ncf_type)
       VALUES (?, 1, 'efectivo', ?, 0, ?, ?, 'emitida', '2026-10-19 10:00:00', '2026-10-19', ?, ?)`,
      [`FAC-${pc.nombre}-${factura}`, total, total, estado, ncf, ncf ? ncf.slice(0, 3) : null]
    );
    await pc.base.query('INSERT INTO sale_items (sale_id, product_id, item_name, qty, price, line_total) VALUES (?, ?, ?, ?, ?, ?)', [r.insertId, p.id, p.nombre, cantidad, p.precio_venta, total]);
    await pc.base.query('UPDATE products SET stock = stock - ? WHERE id = ?', [cantidad, p.id]);
    return r.insertId;
  }

  let A; let B; let C;

  test('1-3. empresa con sucursales; cada PC carga solo su configuración', async () => {
    A = await crearPc('CAJA-PRINCIPAL');
    const sa = await enlazar(A, 'Principal');
    expect(sa.esPrincipal).toBe(true);
    B = await crearPc('CAJA-NORTE');
    await enlazar(B, 'Norte');
    const estadoA = await A.ms.enlace.estado();
    const estadoB = await B.ms.enlace.estado();
    expect(estadoA.sucursal).toMatchObject({ nombre: 'Principal', esPrincipal: true });
    expect(estadoB.sucursal).toMatchObject({ nombre: 'Norte', esPrincipal: false });
    const [sucB] = await B.base.query('SELECT uuid, nombre FROM branches WHERE id = 1');
    expect(sucB).toEqual({ uuid: B.branchUuid, nombre: 'Norte' });
  });

  test('4. producto global: la principal lo publica y llega a la otra sucursal con su misma identidad', async () => {
    for (const [codigo, nombre, precio] of [['F001', 'Martillo', 450], ['F002', 'Clavos 2"', 3]]) {
      await A.base.query("INSERT INTO products (codigo, nombre, categoria, precio_venta, precio_compra, stock) VALUES (?, ?, 'Herramientas', ?, 100, 20)", [codigo, nombre, precio]);
    }
    expect(await A.ms.sincronizacion.publicarCatalogo()).toEqual({ publicados: 2 });
    const rA = await ciclo(A);
    expect(rA.resultado).toBe('ok');
    const rB = await ciclo(B);
    expect(rB).toMatchObject({ resultado: 'ok', aplicados: 2 });
    const enA = await productos(A);
    const enB = await productos(B);
    expect(enB.map((p) => [p.codigo, p.nombre, Number(p.precio_venta), Number(p.stock), p.origen_catalogo])).toEqual([
      ['F001', 'Martillo', 450, 0, 'central'],
      ['F002', 'Clavos 2"', 3, 0, 'central'],
    ]);
    expect(enB.map((p) => p.uuid)).toEqual(enA.map((p) => p.uuid));
    // La sucursal B no puede cambiar el nombre (gana la central), sí su precio.
    const protegido = await B.ms.catalogo.protegerMaestroProducto((await producto(B, 'F001')).id, { codigo: 'X', nombre: 'Otro', precioVenta: 500 });
    expect(protegido).toMatchObject({ codigo: 'F001', nombre: 'Martillo', precioVenta: 500 });
    await expect(B.ms.catalogo.validarEliminarProducto((await producto(B, 'F001')).id)).rejects.toMatchObject({ code: 'PRODUCTO_DE_EMPRESA' });
  });

  test('5-6. precio y venta de una sucursal no tocan a la otra; la central los registra', async () => {
    await A.base.query("UPDATE products SET precio_venta = 500 WHERE codigo = 'F001'");
    await B.base.query("UPDATE products SET precio_venta = 470, stock = 30 WHERE codigo = 'F001'");
    await vender(B, 'F001', 2);
    await ciclo(A);
    await ciclo(B);
    expect(Number((await producto(B, 'F001')).precio_venta)).toBe(470);
    expect(Number((await producto(A, 'F001')).precio_venta)).toBe(500);
    expect(Number((await producto(A, 'F001')).stock)).toBe(20);
    expect(Number((await producto(B, 'F001')).stock)).toBe(28);

    const uuid = (await producto(A, 'F001')).uuid;
    const enCentral = async (pc) => (await db.collection('licencias').doc(LIC).collection('sucursales').doc(pc.branchUuid).collection('productos').doc(uuid).get()).data();
    expect(await enCentral(A)).toMatchObject({ precio: 500, stock: 20 });
    expect(await enCentral(B)).toMatchObject({ precio: 470, stock: 28 });
    const resumen = await centralSync.resumenOperacion(LIC, EMILIO);
    expect(resumen.sucursales.find((s) => s.nombre === 'Norte').dias).toEqual([{ fecha: '2026-10-19', ventas: 1, total: 940 }]);
  });

  test('7-8. sin Internet en B se sigue vendiendo; al volver llega lo nuevo y nada se duplica', async () => {
    B.env.TECNO_CAJA_SYNC_URL = 'http://127.0.0.1:9'; // nada escucha ahí
    await A.base.query("INSERT INTO products (codigo, nombre, categoria, precio_venta, alcance_empresa) VALUES ('F003', 'Destornillador', 'Herramientas', 150, 'global')");
    await ciclo(A);
    await vender(B, 'F002', 10);
    const sinRed = await ciclo(B);
    expect(sinRed.resultado).toBe('sin_conexion');
    const estado = await B.ms.sincronizacion.estado();
    expect(estado.indicador.nivel).toBe('sin_conexion');
    expect(estado.pendientes).toBeGreaterThan(0);

    B.env.TECNO_CAJA_SYNC_URL = url;
    // La espera creciente no deja reintentar enseguida: se adelanta para la prueba.
    await B.base.query('UPDATE sync_outbox SET next_attempt_at_utc = NULL');
    const vuelta = await ciclo(B);
    expect(vuelta.resultado).toBe('ok');
    expect((await productos(B)).map((p) => p.codigo)).toEqual(['F001', 'F002', 'F003']);

    // Repetir la sincronización no duplica nada.
    await B.base.query("DELETE FROM sync_cursors WHERE stream LIKE 'bajada:%'");
    await B.base.query("UPDATE sync_outbox SET status = 'pendiente'");
    const repetido = await ciclo(B);
    expect(repetido.resultado).toBe('ok');
    expect((await productos(B)).length).toBe(3);
    const ventasB = await db.collection('licencias').doc(LIC).collection('sucursales').doc(B.branchUuid).collection('ventas').get();
    expect(ventasB.size).toBe(2);
    const dia = (await db.collection('licencias').doc(LIC).collection('sucursales').doc(B.branchUuid).collection('resumen_diario').doc('2026-10-19').get()).data();
    expect(dia).toMatchObject({ ventas: 2, total: 970 });
  });

  test('9. una PC que se reinicia con cambios pendientes los recupera de su bandeja', async () => {
    B.env.TECNO_CAJA_SYNC_URL = 'http://127.0.0.1:9';
    await vender(B, 'F003', 1);
    await ciclo(B);
    expect(Number((await B.base.query("SELECT COUNT(*) AS n FROM sync_outbox WHERE status <> 'sincronizado'"))[0].n)).toBeGreaterThan(0);
    // "Reinicio": otra instancia sobre la misma base (y el mismo app.env).
    B.ms.sincronizacion.detener();
    const reiniciada = await crearPc('CAJA-NORTE', { base: B.base });
    reiniciada.env.TECNO_CAJA_SYNC_TOKEN = B.env.TECNO_CAJA_SYNC_TOKEN;
    reiniciada.branchUuid = B.branchUuid;
    await B.base.query('UPDATE sync_outbox SET next_attempt_at_utc = NULL');
    const r = await ciclo(reiniciada);
    expect(r.resultado).toBe('ok');
    expect(Number((await B.base.query("SELECT COUNT(*) AS n FROM sync_outbox WHERE status <> 'sincronizado'"))[0].n)).toBe(0);
    const ventasB = await db.collection('licencias').doc(LIC).collection('sucursales').doc(B.branchUuid).collection('ventas').get();
    expect(ventasB.size).toBe(3);
    B = reiniciada;
  });

  test('10. una tercera sucursal nueva recibe todo el catálogo autorizado', async () => {
    C = await crearPc('CAJA-SUR');
    await enlazar(C, 'Sur');
    const r = await ciclo(C);
    expect(r).toMatchObject({ resultado: 'ok', aplicados: 3 });
    expect((await productos(C)).map((p) => [p.codigo, Number(p.precio_venta)])).toEqual([['F001', 500], ['F002', 3], ['F003', 150]]);
  });

  test('2. usuario asignado a una sola sucursal: entra en Norte, no en Sur', async () => {
    await A.base.query(`INSERT INTO users (usuario, password, password_hash, nombre, rol, role_id, estado, sucursales_empresa)
                        VALUES ('luis', '', ?, 'Luis Cajero', 'Cajero', 3, 'Activo', ?)`, [`scrypt:${'1'.repeat(32)}:${'2'.repeat(128)}`, JSON.stringify([B.branchUuid])]);
    await ciclo(A);
    await ciclo(B);
    await ciclo(C);
    const [enB] = await B.base.query("SELECT usuario, nombre, password, password_hash, estado, role_id, origen_usuario FROM users WHERE usuario = 'luis'");
    expect(enB).toMatchObject({ nombre: 'Luis Cajero', password: '', estado: 'Activo', role_id: 3, origen_usuario: 'central' });
    expect(enB.password_hash).toMatch(/^scrypt:/);
    expect(await C.base.query("SELECT id FROM users WHERE usuario = 'luis'")).toEqual([]);
    // En Norte no se puede editar: se administra en la principal.
    const [{ id }] = await B.base.query("SELECT id FROM users WHERE usuario = 'luis'");
    await expect(B.ms.catalogo.validarEditarUsuario(id)).rejects.toMatchObject({ code: 'USUARIO_DE_EMPRESA' });

    // La principal lo desactiva: tras sincronizar, Norte también.
    await A.base.query("UPDATE users SET estado = 'Inactivo' WHERE usuario = 'luis'");
    await ciclo(A);
    await ciclo(B);
    expect((await B.base.query("SELECT estado FROM users WHERE usuario = 'luis'"))[0].estado).toBe('Inactivo');
  });

  test('11. desactivar un producto conserva las ventas viejas', async () => {
    await A.base.query("UPDATE products SET estado = 'Inactivo' WHERE codigo = 'F002'");
    await ciclo(A);
    await ciclo(B);
    expect((await producto(B, 'F002')).estado).toBe('Inactivo');
    const ventas = await B.base.query("SELECT COUNT(*) AS n FROM sale_items si JOIN products p ON p.id = si.product_id WHERE p.codigo = 'F002'");
    expect(Number(ventas[0].n)).toBe(1);
  });

  test('conflicto: mismo código local con otra identidad se resuelve a mano (vincular)', async () => {
    await C.base.query("INSERT INTO products (codigo, nombre, categoria, precio_venta, stock) VALUES ('F009', 'Cinta métrica local', 'Herramientas', 210, 7)");
    await A.base.query("INSERT INTO products (codigo, nombre, categoria, precio_venta, alcance_empresa) VALUES ('F009', 'Cinta métrica 5 m', 'Herramientas', 250, 'global')");
    await ciclo(A);
    const r = await ciclo(C);
    expect(r).toMatchObject({ resultado: 'parcial', conflictos: 1 });
    const [conflicto] = await C.ms.sincronizacion.listarConflictos();
    expect(conflicto).toMatchObject({ tipo: 'producto', clave: 'F009' });
    expect((await C.ms.sincronizacion.estado()).indicador.nivel).toBe('error');
    await C.ms.sincronizacion.resolverConflicto(conflicto.id, 'vincular');
    const p = await producto(C, 'F009');
    expect(p).toMatchObject({ nombre: 'Cinta métrica 5 m', uuid: (await producto(A, 'F009')).uuid, origen_catalogo: 'central' });
    expect([Number(p.precio_venta), Number(p.stock)]).toEqual([210, 7]);
  });

  test('precio en varias sucursales: acción explícita de la principal', async () => {
    const id = (await producto(A, 'F003')).id;
    await A.ms.sincronizacion.precioEnSucursales({ productId: id, precio: 175, sucursales: [B.branchUuid] });
    await ciclo(A);
    await ciclo(B);
    await ciclo(C);
    expect(Number((await producto(B, 'F003')).precio_venta)).toBe(175);
    expect(Number((await producto(C, 'F003')).precio_venta)).toBe(150);
    expect(Number((await producto(A, 'F003')).precio_venta)).toBe(150);
    await expect(B.ms.sincronizacion.precioEnSucursales({ productId: 1, precio: 1, sucursales: [C.branchUuid] })).rejects.toMatchObject({ code: 'SOLO_PRINCIPAL' });
  });

  test('17. NCF: la central reparte rangos, la sucursal los usa sin chocar y no reutiliza números', async () => {
    // Norte ya tenía la secuencia de toda la empresa (sistema anterior).
    await B.base.query("INSERT INTO ncf_sequences (ncf_type, siguiente_numero, maximo, activa) VALUES ('B02', 1, 5000, 1)");
    await vender(B, 'F001', 1, { ncf: 'B0200000003' });
    const rNorte = await centralSync.asignarRangoNcf(LIC, B.branchUuid, { tipo: 'B02', desde: 1, hasta: 2500, vence: '2027-12-31' }, EMILIO);
    await ciclo(B);
    // Ya emitió el B0200000003: ese rango no se puede usar.
    const rechazado = (await B.ms.sincronizacion.estado()).ncf.find((x) => x.rangoUuid === rNorte.rangoUuid);
    expect(rechazado).toMatchObject({ estado: 'rechazado' });
    await ciclo(B);
    const doc = (await db.collection('licencias').doc(LIC).collection('sucursales').doc(B.branchUuid).collection('ncf_rangos').doc(rNorte.rangoUuid).get()).data();
    expect(doc.estadoSucursal).toBe('rechazado');

    const bueno = await centralSync.asignarRangoNcf(LIC, B.branchUuid, { tipo: 'B02', desde: 2501, hasta: 5000 }, EMILIO);
    const sur = await centralSync.asignarRangoNcf(LIC, C.branchUuid, { tipo: 'B02', desde: 5001, hasta: 7500 }, EMILIO);
    await ciclo(B);
    await ciclo(C);
    const seqB = await B.base.query("SELECT siguiente_numero, maximo, activa FROM ncf_sequences WHERE ncf_type = 'B02' ORDER BY id");
    expect(seqB.map((s) => [Number(s.siguiente_numero), Number(s.maximo), Number(s.activa)])).toEqual([[1, 5000, 0], [2501, 5000, 1]]);
    const seqC = await C.base.query("SELECT siguiente_numero, maximo, activa FROM ncf_sequences WHERE ncf_type = 'B02'");
    expect(seqC.map((s) => [Number(s.siguiente_numero), Number(s.maximo), Number(s.activa)])).toEqual([[5001, 7500, 1]]);
    for (const [pc, r] of [[B, bueno], [C, sur]]) {
      const d = (await db.collection('licencias').doc(LIC).collection('sucursales').doc(pc.branchUuid).collection('ncf_rangos').doc(r.rangoUuid).get()).data();
      expect(d.estadoSucursal).toBe('en_uso');
    }
    // Se agota en Norte: queda "agotado" y la central lo sabe.
    await B.base.query("UPDATE ncf_sequences SET siguiente_numero = 5001 WHERE ncf_type = 'B02' AND activa = 1");
    await ciclo(B);
    await ciclo(B);
    const agotado = (await db.collection('licencias').doc(LIC).collection('sucursales').doc(B.branchUuid).collection('ncf_rangos').doc(bueno.rangoUuid).get()).data();
    expect(agotado.estadoSucursal).toBe('agotado');
  });

  test('12. aislamiento: una PC de otra empresa no ve nada de esta', async () => {
    const X = await crearPc('CAJA-AJENA', { licencia: LIC2 });
    await enlazar(X, 'Ajena', LIC2);
    const r = await ciclo(X);
    expect(r).toMatchObject({ resultado: 'ok', aplicados: 0 });
    expect(await productos(X)).toEqual([]);
    expect(await X.base.query("SELECT id FROM users WHERE usuario = 'luis'")).toEqual([]);
    // Y su PC no puede elegir sucursales de esta empresa para un producto.
    await X.base.query(`INSERT INTO products (codigo, nombre, categoria, precio_venta, alcance_empresa, sucursales_empresa)
                        VALUES ('Z1', 'Ajeno', 'X', 1, 'sucursales', ?)`, [JSON.stringify([B.branchUuid])]);
    const r2 = await ciclo(X);
    expect(r2).toMatchObject({ resultado: 'parcial', rechazados: 1 });
    expect(r2.detalles[0]).toMatchObject({ code: 'SUCURSAL_AJENA' });
  });

  test('observabilidad: bitácora de cada ciclo y estado con indicador', async () => {
    const ciclos = await A.ms.sincronizacion.bitacora(5);
    expect(ciclos.length).toBeGreaterThan(0);
    expect(ciclos[0]).toEqual(expect.objectContaining({ resultado: expect.any(String), duracion_ms: expect.any(Number), bytes_enviados: expect.any(Number) }));
    const e = await A.ms.sincronizacion.estado();
    expect(e.indicador.nivel).toBe('sincronizado');
    expect(e.ultimoCiclo).toEqual(expect.objectContaining({ resultado: 'ok' }));
  });
});

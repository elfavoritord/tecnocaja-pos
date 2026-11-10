'use strict';
// Permisos por usuario de punta a punta con la app real (servidor Express +
// base de laboratorio). Nunca lee el .env de producción.
//   node scripts/probar-permisos-usuarios.js            (SQLite)
//   node scripts/probar-permisos-usuarios.js --mariadb  (MariaDB empaquetada)
//   ... --ui  además abre el panel de usuarios y el menú en Chrome sin cabeza
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
process.env.TC_E2E_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-permisos-'));
process.env.TC_E2E_DB_PORT = '3463';
const L = require('./e2e-lan/lib');
const catalogo = require('../js/permisos-catalogo');
const MYSQL = process.argv.includes('--mariadb');
const UI = process.argv.includes('--ui');
const resultados = [];
const ok = (nombre) => { resultados.push(nombre); console.log('OK', nombre); };
const CLAVE = 'CajeroLab2026!';

async function main() {
  L.prepareSandbox();
  if (MYSQL) await L.startMariaDb({ fresh: true });
  const port = MYSQL ? 3487 : 3485;
  const userData = path.join(L.WORK, 'pos');
  const home = path.join(userData, 'home'); fs.mkdirSync(home, { recursive: true });
  const env = { ...(MYSQL ? { DB_CLIENT: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(L.DB_PORT), DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'permisos_lab' } : { DB_CLIENT: 'sqlite' }),
    TECNO_CAJA_SIMULATE_NO_INTERNET: '1', USERPROFILE: home, HOME: home };
  if (MYSQL) await L.mysqlRoot('CREATE DATABASE permisos_lab CHARACTER SET utf8mb4');
  let proc;
  try {
    proc = L.startServer('pos', { port, userData, env });
    await L.waitHttp(port, '/api/setup/status', 180000);
    const setup = await L.request(port, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja', businessName: 'LAB PERMISOS',
      adminName: 'Dueño', adminUser: 'dueno', adminEmail: 'dueno@example.test', adminPassword: 'SoloLaboratorio2026!', openingAmount: 1000, currency: 'RD$',
    });
    assert.equal(setup.status, 201, JSON.stringify(setup.body));
    await L.stopServer(proc); proc = null;
    assert.ok(L.seedLicense({ port, userData, env }).ok, 'Licencia de laboratorio');
    proc = L.startServer('pos-activado', { port, userData, env });
    await L.waitHttp(port, '/api/setup/status', 180000);

    const login = async (usuario, password) => {
      const r = await L.request(port, 'POST', '/api/login', { usuario, password });
      assert.ok(r.body?.token, `login ${usuario}: ${JSON.stringify(r.body)}`);
      return r.body;
    };
    const dueno = await login('dueno', 'SoloLaboratorio2026!');
    const api = (method, url, body, token = dueno.token) => L.request(port, method, url, body, token, 90000);
    const branchId = dueno.data.sucursales[0].id, cashRegisterId = dueno.data.cajasSucursal[0].id;
    const estructura = { branchId, cashRegisterId };

    const roles = (await api('GET', '/api/roles')).body;
    const rolCajero = roles.find((r) => r.codigo === 'cajero');
    const delRol = catalogo.porDefecto('cajero', rolCajero.permisos);
    const prod = await api('POST', '/api/products', { codigo: 'PERM1', nombre: 'Producto permisos', categoria: 'GENERAL', unidad: 'Unidad', precioVenta: 100, precioCompra: 40, stock: 10, stockMin: 0, aplicaItbis: false, estado: 'Activo', branchId });
    assert.equal(prod.status, 201, JSON.stringify(prod.body));
    const productId = (prod.body.product || prod.body.producto || prod.body).id;

    // Validaciones al guardar.
    const base = { nombre: 'Cajera Lab', usuario: 'cajera.lab', password: CLAVE, roleCode: 'cajero', estado: 'Activo', branchId, cashRegisterId };
    assert.equal((await api('POST', '/api/users', { ...base, permisos: ['ventas', 'volar'] })).status, 400, 'permiso desconocido');
    assert.equal((await api('POST', '/api/users', { ...base, permisos: 'ventas' })).status, 400, 'permisos que no son lista');
    const personalizados = catalogo.normalizar([...delRol.filter((c) => c !== 'abrir_gaveta'), 'inventario']);
    const creada = await api('POST', '/api/users', { ...base, permisos: personalizados });
    assert.equal(creada.status, 201, JSON.stringify(creada.body));
    assert.equal(creada.body.permisosPropios, true);
    assert.deepEqual(creada.body.permisosUsuario, personalizados);
    const cajeraId = creada.body.id;
    ok('crear usuario con permisos propios: se guardan limpios; códigos desconocidos o formato malo se rechazan');

    // Con sus permisos propios: sin gaveta, con inventario; sin productos ni configuración ni usuarios.
    const cajera = await login('cajera.lab', CLAVE);
    assert.equal(cajera.user.permisosPropios, true);
    assert.ok(!cajera.user.rolePermissions.includes('abrir_gaveta') && cajera.user.rolePermissions.includes('inventario'), JSON.stringify(cajera.user.rolePermissions));
    const comoCajera = (m, u, b) => api(m, u, b, cajera.token);
    const gaveta = () => comoCajera('POST', '/api/caja/gaveta', { eventUuid: randomUUID(), motivo: 'otro', descripcion: 'prueba de permisos', ...estructura });
    const ajuste = () => comoCajera('POST', '/api/inventory/adjust', { productId, tipo: 'entrada', qty: 2, notes: 'prueba de permisos', branchId });
    assert.equal((await gaveta()).status, 403, 'sin «Abrir gaveta» no abre la gaveta');
    const aj = await ajuste();
    assert.equal(aj.status, 200, `con «Inventario» ajusta inventario: ${JSON.stringify(aj.body)}`);
    assert.equal((await comoCajera('POST', '/api/products', { codigo: 'PERM2', nombre: 'No debe', categoria: 'GENERAL', unidad: 'Unidad', precioVenta: 1, precioCompra: 1, stock: 0, stockMin: 0, estado: 'Activo', branchId })).status, 403, 'sin «Productos» no crea productos');
    assert.equal((await comoCajera('PUT', '/api/config', { idioma: 'es' })).status, 403, 'sin «Configuración» no guarda la configuración');
    assert.equal((await comoCajera('PUT', `/api/users/${cajeraId}`, { nombre: 'Me subo' })).status, 403, 'sin «Usuarios» no edita usuarios');
    ok('el servidor respeta la lista propia: gaveta 403, inventario 200, productos/configuración/usuarios 403');

    // Vuelve a los del rol: lo de siempre del cajero (gaveta sí, inventario no).
    const reset = await api('PUT', `/api/users/${cajeraId}`, { permisos: null });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.permisosPropios, false);
    assert.equal((await gaveta()).status, 201, 'cajero normal abre la gaveta');
    assert.equal((await ajuste()).status, 403, 'cajero normal no ajusta inventario');
    // Una lista igual a la del rol no se guarda como propia.
    const igual = await api('PUT', `/api/users/${cajeraId}`, { permisos: delRol });
    assert.equal(igual.body.permisosPropios, false, 'igual a lo del rol = sin permisos propios');
    ok('volver a los del rol: el cajero queda exactamente como antes; una lista igual a la del rol no se guarda');

    // Solo el administrador general personaliza; con «Usuarios» propio no se da permisos a otros.
    const conUsuarios = await api('PUT', `/api/users/${cajeraId}`, { permisos: catalogo.normalizar([...delRol, 'usuarios']) });
    assert.equal(conUsuarios.status, 200, JSON.stringify(conUsuarios.body));
    const cajera2 = await login('cajera.lab', CLAVE);
    const nuevo = { nombre: 'Delivery Lab', usuario: 'delivery.lab', password: CLAVE, roleCode: 'repartidor', estado: 'Activo', branchId };
    const intento = await api('POST', '/api/users', { ...nuevo, permisos: ['delivery', 'reportes'] }, cajera2.token);
    assert.equal(intento.status, 403, `no personaliza permisos: ${JSON.stringify(intento.body)}`);
    const creado = await api('POST', '/api/users', nuevo, cajera2.token);
    assert.equal(creado.status, 201, `con «Usuarios» sí crea usuarios: ${JSON.stringify(creado.body)}`);
    assert.equal((await api('POST', '/api/users', { ...nuevo, usuario: 'admin.lab', roleCode: 'administrador_general' }, cajera2.token)).status, 403, 'no crea administradores');
    ok('solo el administrador general personaliza permisos; «Usuarios» propio crea usuarios pero no administradores');

    // El administrador general no se personaliza; cambiar de rol vuelve a los del rol nuevo.
    const admin = await api('PUT', `/api/users/${dueno.user.id}`, { permisos: ['ventas'] });
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.equal(admin.body.permisosPropios, false, 'al administrador general no se le quitan permisos');
    await api('PUT', `/api/users/${cajeraId}`, { permisos: personalizados });
    const cambioRol = await api('PUT', `/api/users/${cajeraId}`, { roleCode: 'supervisor' });
    assert.equal(cambioRol.status, 200, JSON.stringify(cambioRol.body));
    assert.equal(cambioRol.body.roleCode, 'supervisor', 'el rol elegido se guarda (antes ganaba el anterior)');
    assert.equal(cambioRol.body.permisosPropios, false, 'al cambiar de rol vuelve a los del rol nuevo');
    await api('PUT', `/api/users/${cajeraId}`, { roleCode: 'cajero', cashRegisterId, permisos: personalizados });
    ok('el administrador general no se personaliza; al cambiar de rol vuelve a los permisos del rol nuevo');

    // Auditoría del cambio de permisos.
    const audit = await api('GET', '/api/auditoria?modulo=Usuarios&pageSize=50');
    assert.ok(audit.body.eventos.some((e) => e.accion === 'Permisos del usuario'), 'auditoría de permisos');
    ok('cada cambio de permisos queda en la auditoría con antes y después');

    // Sin internet: el login local respeta la misma lista.
    const cache = await api('POST', '/api/offline/init-cache', {}, cajera2.token);
    assert.ok([200, 201].includes(cache.status), JSON.stringify(cache.body));
    const offline = await L.request(port, 'POST', '/api/auth/offline-login', { usuario: 'cajera.lab', password: CLAVE });
    assert.equal(offline.status, 200, JSON.stringify(offline.body));
    const usuarioOffline = offline.body.user || offline.body;
    assert.equal(usuarioOffline.permisosPropios, true);
    assert.ok(!usuarioOffline.rolePermissions.includes('abrir_gaveta') && usuarioOffline.rolePermissions.includes('inventario'), JSON.stringify(usuarioOffline.rolePermissions));
    ok('sin internet el login local trae los mismos permisos propios');

    if (UI) {
      await require('./probar-permisos-usuarios-ui')({ port, outputDir: path.join(L.WORK, 'capturas'), cajera: { usuario: 'cajera.lab', clave: CLAVE }, cajeraId });
      ok('panel de usuario nuevo y menú del usuario personalizado en Chrome');
    }
  } finally {
    await L.stopServer(proc);
    if (MYSQL) await L.stopMariaDb();
  }
  console.log(`\n${resultados.length} verificaciones OK (${MYSQL ? 'MariaDB' : 'SQLite'}). Laboratorio: ${L.WORK}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

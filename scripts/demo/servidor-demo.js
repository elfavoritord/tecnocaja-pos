// Servidor DEMO para que Emilio pruebe la app con el código de esta carpeta sin
// que lo bloquee la licencia: modo demostración (TECNO_CAJA_DEMO=1, ver
// server.js → LICENCIA_DEMO), SQLite y nada del Firebase, la nube ni los datos
// reales. Los datos se CONSERVAN entre arranques (carpeta TC_DEMO_DIR o
// <unidad>:\TecnoCaja-Demo); con --nuevo se empieza de cero.
// La primera vez crea un colmado con la caja abierta y productos de ejemplo.
// Uso: npm run demo            (http://127.0.0.1:3470, admin / 1234)
//      npm run demo -- --nuevo
// No va en el instalador (package.json → build.files excluye scripts/demo).
const fs = require('fs');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..');
const CARPETA = process.env.TC_DEMO_DIR || path.join(path.parse(PROJECT).root, 'TecnoCaja-Demo');
process.env.TC_E2E_DIR = CARPETA;
const L = require(path.join(PROJECT, 'scripts', 'e2e-lan', 'lib'));

const PORT = Number(process.env.TC_DEMO_PORT) || 3470;
const USER_DATA = path.join(CARPETA, 'pc-data');
const HOME = path.join(CARPETA, 'home');
const NUEVO = process.argv.includes('--nuevo');

// Nombres normales (como los pondría un negocio). El método de ITBIS de cada
// uno: Refresco, Malta y Queso → incluido; Galletas y Aceite → se suma el 18 %;
// Cerveza → RD$20 fijo; Arroz, Pan y Pollo → exentos. Pollo y Queso, por peso.
const PRODUCTOS = [
  { codigo: 'REFRESCO', nombre: 'Refresco de uva', categoria: 'Bebidas', precioVenta: 118, precioCompra: 60, stock: 100, aplicaItbis: true, itbisIncluido: true },
  { codigo: 'MALTA', nombre: 'Malta', categoria: 'Bebidas', precioVenta: 75, precioCompra: 40, stock: 100, aplicaItbis: true, itbisIncluido: true },
  { codigo: 'GALLETAS', nombre: 'Galletas', categoria: 'Galletas', precioVenta: 100, precioCompra: 60, stock: 100, aplicaItbis: true },
  { codigo: 'ACEITE', nombre: 'Aceite', categoria: 'Despensa', precioVenta: 250, precioCompra: 180, stock: 50, aplicaItbis: true },
  { codigo: 'CERVEZA', nombre: 'Cerveza', categoria: 'Bebidas', precioVenta: 150, precioCompra: 100, stock: 100, aplicaItbis: true, itbisModo: 'monto', itbisMonto: 20 },
  { codigo: 'ARROZ', nombre: 'Arroz', categoria: 'Víveres', precioVenta: 40, precioCompra: 30, stock: 200, aplicaItbis: false },
  { codigo: 'PAN', nombre: 'Pan de agua', categoria: 'Panadería', precioVenta: 10, precioCompra: 5, stock: 200, aplicaItbis: false },
  { codigo: 'POLLO', nombre: 'Pollo', categoria: 'Carnes', unidad: 'lb', saleMode: 'peso', precioVenta: 100, precioCompra: 70, stock: 100, aplicaItbis: false },
  { codigo: 'QUESO', nombre: 'Queso de freír', categoria: 'Lácteos', unidad: 'lb', saleMode: 'peso', precioVenta: 300, precioCompra: 200, stock: 40, aplicaItbis: true, itbisIncluido: true },
];

// El proceso que tiene ocupado el puerto (Windows), o null.
function procesoEnPuerto(puerto) {
  try {
    const salida = require('child_process').execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    const linea = salida.split(/\r?\n/).find((l) => new RegExp(`[:.]${puerto}\\s+\\S+\\s+(LISTENING|ESCUCHANDO)`, 'i').test(l));
    return linea ? Number(linea.trim().split(/\s+/).pop()) || null : null;
  } catch (_) {
    return null;
  }
}

// Si ya hay un demo encendido no se arranca otro encima: copiar el código nuevo
// sobre el que está corriendo lo dañaba ("memory access out of bounds") y este
// script terminaba hablando con el viejo.
async function revisarDemoEncendido() {
  const pid = procesoEnPuerto(PORT);
  if (!pid) return;
  let entra = false;
  try {
    const r = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' }, '', 8000);
    entra = r.status === 200;
  } catch (_) { /* no responde */ }
  const cerrar = `Ciérralo (Ctrl+C en la ventana donde corre, o en PowerShell: Stop-Process -Id ${pid}) y vuelve a correr npm run demo.`;
  if (entra) {
    console.log(`[demo] Ya hay un demo encendido en http://127.0.0.1:${PORT} (proceso ${pid}) y se puede entrar (admin / 1234).`);
    console.log(`[demo] Ese demo tiene el código de cuando se encendió. Para probar el código de ahora: ${cerrar}`);
    process.exit(0);
  }
  console.error(`[demo] El puerto ${PORT} lo tiene otro proceso (${pid}) que no deja entrar: es un demo viejo dañado u otro programa. ${cerrar}`);
  console.error(`[demo] Los datos del demo están guardados en ${USER_DATA} y no se pierden al cerrarlo.`);
  process.exit(1);
}

(async () => {
  await revisarDemoEncendido();
  L.prepareSandbox(); // copia el código actual de esta carpeta (no toca los datos)
  if (NUEVO) for (const dir of [USER_DATA, HOME]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
  const server = L.startServer('demo', {
    port: PORT,
    userData: USER_DATA,
    env: { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TECNO_CAJA_DEMO: '1', TECNO_CAJA_SYNC_URL: 'off' },
  });
  const salir = async () => {
    // SQLite guarda en disco cada poco: se espera antes de apagar.
    await new Promise((r) => setTimeout(r, 2500));
    await L.stopServer(server);
    process.exit(0);
  };
  process.on('SIGINT', salir);
  process.on('SIGTERM', salir);
  server.on('exit', (code) => {
    console.log(`[demo] el servidor se detuvo (código ${code}). Log: ${path.join(CARPETA, 'demo.log')}`);
    process.exit(1);
  });

  await L.waitHttp(PORT);
  const estado = await L.request(PORT, 'GET', '/api/setup/status');
  if (estado.body?.setupRequired !== false) {
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Colmado Demo', adminName: 'Emilio', adminUser: 'admin', adminEmail: 'admin@demo.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    const login = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    const token = login.body?.token;
    if (!token) throw new Error(`No pude entrar: ${JSON.stringify(login.body || login).slice(0, 300)}`);
    for (const p of PRODUCTOS) {
      const r = await L.request(PORT, 'POST', '/api/products', { marca: '', estado: 'Activo', stockMin: 0, unidad: 'Unidad', saleMode: 'unidad', ...p }, token);
      if (r.status >= 300) console.log(`[demo] no se creó ${p.nombre}: ${JSON.stringify(r.body || r).slice(0, 200)}`);
    }
    const cfg = ((await L.request(PORT, 'GET', '/api/bootstrap', null, token)).body || {}).config || {};
    await L.request(PORT, 'PUT', '/api/config', { ...cfg, weightTotalEditEnabled: true, salesSplitViewEnabled: true }, token);
    console.log('[demo] negocio de ejemplo creado (Colmado Demo, caja abierta, productos de prueba).');
  }
  const prueba = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
  console.log(`[demo] entrada: ${prueba.status === 200 ? 'OK' : `FALLA ${prueba.status} ${prueba.body?.error || ''}`}`);
  console.log(`[demo] LISTO http://127.0.0.1:${PORT}  usuario: admin  clave: 1234  (datos en ${CARPETA})`);
  await new Promise(() => {}); // queda encendido
})().catch((error) => {
  console.error('[demo] FALLÓ:', error.stack || error.message);
  process.exit(1);
});

// Buscador de productos de la venta (js/buscador-productos.js) en la app real,
// con SQLite en una carpeta temporal: un pedazo del nombre, palabras en otro
// orden, sin acentos, mal escrito, Enter agrega el más parecido, y el lector de
// códigos sigue igual (código exacto entra, uno que no existe ofrece crearlo y
// uno a medias no agrega nada a ciegas).
// Uso: npm run test:buscador
/* global DB, doLogin, showModule, refrescarCatalogoSinTocarLaVenta, closeAllModals, getSalesCatalogProducts, searchGridColumns */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..');
process.env.TC_E2E_DIR = path.join(os.tmpdir(), 'tecnocaja-buscador');
const L = require(path.join(PROJECT, 'scripts', 'e2e-lan', 'lib'));
const puppeteer = require(path.join(PROJECT, 'node_modules', 'puppeteer'));

const OUT = path.join(L.WORK, 'capturas');
const PORT = Number(process.env.TC_PRUEBA_PORT) || 3487;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Los de la captura de Emilio (GRUPO DUPAAL SRL) y unos de colmado.
const PRODUCTOS = [
  { codigo: 'PLATO-DIA', nombre: '.PLATO DEL DIA GENERICO', categoria: 'COMIDA RAPIDA', precioVenta: 205 },
  { codigo: 'POLLO-12', nombre: '1/2 POLLO AL HORNO', precioVenta: 300 },
  { codigo: 'POLLO-14', nombre: '1/4 POLLO ROSTIZADO', precioVenta: 175 },
  { codigo: 'PECH-10', nombre: '10 PECHURINAS CON YU- TOS', precioVenta: 650 },
  { codigo: 'PECH-2', nombre: '2 PIEZAS PECHURINAS YU-TOS', precioVenta: 170 },
  { codigo: 'PECH-3', nombre: '3 PECHURINAS CON YU -TOS', precioVenta: 225 },
  { codigo: '7460000000011', nombre: 'Galletas de soda', precioVenta: 35 },
  { codigo: '7460000000028', nombre: 'Piña colada', precioVenta: 150 },
  { codigo: '7460000000035', nombre: 'Café Santo Domingo 1 lb', precioVenta: 290 },
];
for (let i = 1; i <= 70; i += 1) {
  PRODUCTOS.push({ codigo: `REL-${String(i).padStart(3, '0')}`, nombre: `Producto de relleno ${i}`, precioVenta: 10 + i });
}

(async () => {
  let server = null;
  let browser = null;
  const problemas = [];
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME, OUT]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    fs.mkdirSync(OUT, { recursive: true });
    server = L.startServer('buscador', { port: PORT, userData: USER_DATA, env: { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TECNO_CAJA_DEMO: '1', TECNO_CAJA_SYNC_URL: 'off' } });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Colmado La Esquina', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });

    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.on('pageerror', (e) => problemas.push(`error de página: ${e.message}`));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#login-user', { timeout: 30000 });
    await page.evaluate(() => {
      document.getElementById('login-user').value = 'admin';
      document.getElementById('login-pass').value = '1234';
      return doLogin();
    });
    await page.waitForFunction(() => Boolean(typeof DB !== 'undefined' && DB.currentUser), { timeout: 30000 });
    await sleep(1500);

    await page.evaluate(async (lista) => {
      for (const p of lista) {
        const r = await fetch('/api/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` },
          body: JSON.stringify({ marca: '', estado: 'Activo', stockMin: 0, precioCompra: 5, unidad: 'Unidad', saleMode: 'unidad', categoria: 'General', stock: 100, aplicaItbis: false, ...p }),
        });
        if (!r.ok) throw new Error(`${p.nombre}: ${(await r.json()).error}`);
      }
      await refrescarCatalogoSinTocarLaVenta();
      showModule('ventas');
      await new Promise((r) => setTimeout(r, 800));
    }, PRODUCTOS);

    const lista = () => page.evaluate(() => ({
      visible: !document.getElementById('search-dropdown').classList.contains('hidden'),
      nombres: [...document.querySelectorAll('#search-dropdown .search-result-item .sri-name')].map((n) => n.textContent),
      marcada: document.querySelector('#search-dropdown .search-result-item.selected .sri-name')?.textContent || null,
      notas: [...document.querySelectorAll('#search-dropdown .search-note')].map((n) => n.textContent),
    }));
    const carrito = () => page.evaluate(() => DB.saleItems.map((i) => i.nombre));
    const vaciarCarrito = () => page.evaluate(() => { DB.saleItems = []; });
    // Escribir como una persona (letra por letra) y esperar a que se vea la lista.
    const escribir = async (texto) => {
      await page.click('#product-search', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.keyboard.type(texto, { delay: 30 });
      await sleep(250);
    };
    // El lector USB: todo seguido y Enter en el acto.
    const escanear = async (texto) => {
      await page.click('#product-search', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.keyboard.type(texto);
      await page.keyboard.press('Enter');
      await sleep(600);
    };

    // 1. Una letra: primero los que empiezan por P, y salen más de 8.
    await escribir('p');
    let r = await lista();
    await page.screenshot({ path: path.join(OUT, '1-letra-p.png') });
    L.check('"p": los que empiezan por P van primero', r.nombres.slice(0, 3).join(' | ') === '.PLATO DEL DIA GENERICO | Piña colada | Producto de relleno 1', r.nombres.slice(0, 5).join(' | '));
    L.check('"p": salen hasta 50 y dice cuántos hay', r.nombres.length === 50 && r.notas.some((n) => /Se ven 50 de \d+/.test(n)), `${r.nombres.length} · ${r.notas.join(' / ')}`);
    const cuadros = await page.evaluate(() => searchGridColumns());
    L.check('En cuadros: 6 a 8 por fila en una pantalla de 1366', cuadros >= 6 && cuadros <= 8, `${cuadros} por fila`);

    // 2. Palabras sueltas en otro orden + Enter agrega el marcado.
    await escribir('horno pollo');
    r = await lista();
    await page.screenshot({ path: path.join(OUT, '2-horno-pollo.png') });
    L.check('"horno pollo" encuentra 1/2 POLLO AL HORNO y lo marca', r.nombres[0] === '1/2 POLLO AL HORNO' && r.marcada === '1/2 POLLO AL HORNO', JSON.stringify(r));
    await page.keyboard.press('Enter');
    await sleep(500);
    L.check('Enter agrega el marcado sin escribir el nombre completo', JSON.stringify(await carrito()) === JSON.stringify(['1/2 POLLO AL HORNO']), JSON.stringify(await carrito()));

    // 3. Sin acentos ni guiones.
    await escribir('pina');
    r = await lista();
    L.check('"pina" encuentra Piña colada', r.nombres[0] === 'Piña colada', r.nombres.join(' | '));
    await escribir('yutos');
    r = await lista();
    L.check('"yutos" encuentra los 3 de YU-TOS', r.nombres.length === 3, r.nombres.join(' | '));
    await escribir('cafe');
    r = await lista();
    L.check('"cafe" encuentra Café', r.nombres[0] === 'Café Santo Domingo 1 lb', r.nombres.join(' | '));

    // 4. Mal escrito: sale el que se parece, con el aviso.
    await escribir('galetas');
    r = await lista();
    await page.screenshot({ path: path.join(OUT, '3-mal-escrito.png') });
    L.check('"galetas" (mal escrito) sugiere Galletas de soda', r.nombres[0] === 'Galletas de soda' && r.notas.some((n) => /se parecen/.test(n)), JSON.stringify(r));

    // 5. Enter antes de que salga la lista (se escribe rápido): muestra la
    //    lista con el más parecido marcado; el segundo Enter lo agrega.
    await vaciarCarrito();
    await page.click('#product-search', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.keyboard.type('pech');
    await page.keyboard.press('Enter');
    await sleep(300);
    r = await lista();
    const tras1 = await carrito();
    L.check('Enter rápido con varios: no agrega a ciegas, marca el primero', tras1.length === 0 && r.marcada === '3 PECHURINAS CON YU -TOS', `${JSON.stringify(tras1)} · ${r.marcada}`);
    await page.keyboard.press('Enter');
    await sleep(500);
    L.check('El segundo Enter agrega el marcado', JSON.stringify(await carrito()) === JSON.stringify(['3 PECHURINAS CON YU -TOS']), JSON.stringify(await carrito()));

    // 6. Flechas en los cuadros: → al siguiente, ↓ a la fila de abajo.
    await vaciarCarrito();
    await escribir('pechurinas');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await sleep(500);
    L.check('Flecha derecha + Enter agrega el segundo cuadro', JSON.stringify(await carrito()) === JSON.stringify(['10 PECHURINAS CON YU- TOS']), JSON.stringify(await carrito()));
    await vaciarCarrito();
    await escribir('producto relleno');
    const columnas = await page.evaluate(() => searchGridColumns());
    await page.keyboard.press('ArrowDown');
    r = await lista();
    L.check('Flecha abajo baja una fila entera', r.marcada === r.nombres[columnas], `${columnas} columnas · marcado ${r.marcada}`);
    await page.keyboard.press('Escape');

    // 7. El lector de códigos sigue igual.
    await vaciarCarrito();
    await escanear('7460000000011');
    L.check('Lector: código exacto entra', JSON.stringify(await carrito()) === JSON.stringify(['Galletas de soda']), JSON.stringify(await carrito()));
    await escanear('7460000000012');
    const nuevo = await page.evaluate(() => Boolean(document.getElementById('venta-producto-nuevo'))
      && !document.getElementById('modal-overlay')?.classList.contains('hidden'));
    L.check('Lector: un código que no existe ofrece crearlo (no uno parecido)', nuevo && (await carrito()).length === 1, String(nuevo));
    await page.evaluate(() => closeAllModals());
    await sleep(300);
    await escanear('746000');
    r = await lista();
    L.check('Lector: un código a medias muestra los que empiezan así sin marcar ni agregar', (await carrito()).length === 1 && r.nombres.length === 3 && r.marcada === null, JSON.stringify(r));
    await page.screenshot({ path: path.join(OUT, '4-codigo-a-medias.png') });

    // 8. Pantalla dividida (catálogo): el mismo buscador, del más parecido al menos.
    const catalogo = await page.evaluate(() => {
      document.getElementById('product-search').value = 'pollo';
      return getSalesCatalogProducts().map((p) => p.nombre);
    });
    L.check('Catálogo: "pollo" con el mismo orden', catalogo.join(' | ') === '1/2 POLLO AL HORNO | 1/4 POLLO ROSTIZADO', catalogo.join(' | '));

    L.check('Sin errores en la página', problemas.length === 0, problemas.join('\n'));
    if (L.results.some((x) => !x.ok)) process.exitCode = 1;
  } catch (error) {
    console.error('FALLÓ:', error.stack || error.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await sleep(2000);
    if (server) await L.stopServer(server).catch(() => {});
    console.log('Capturas en:', OUT);
  }
})();

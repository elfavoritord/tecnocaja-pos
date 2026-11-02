'use strict';

// El POS real con clics de verdad: una Empresa de Servicios (sin pantalla de venta)
// atendiendo solicitudes, y un negocio normal vendiendo un servicio. SQLite temporal.
//   node cloud/tienda-online/test/ui/probar-servicios-pos.js [carpeta-de-capturas]
/* global DB, doLogin, renderSalesCatalog, showModule, TiendaOnline -- corren dentro de la página */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-servicios-ui');
const L = require('../../../../scripts/e2e-lan/lib');
const puppeteer = require(path.join(L.PROJECT, 'node_modules', 'puppeteer'));

const PORT = 3497;
const CAPTURAS = process.argv[2] || '';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const resultados = [];
function ok(nombre, cond, detalle = '') {
  resultados.push({ nombre, ok: Boolean(cond) });
  console.log(`${cond ? '  ok ' : 'FALLA'} ${nombre}${!cond && detalle ? ` → ${detalle}` : ''}`);
}

async function arrancar(nombre, businessType, port) {
  const USER_DATA = path.join(L.WORK, `${nombre}-data`);
  const HOME = path.join(L.WORK, `${nombre}-home`);
  for (const dir of [USER_DATA, HOME]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
  const server = L.startServer(nombre, {
    port,
    userData: USER_DATA,
    env: { DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TECNO_CAJA_TIENDA_ONLINE_URL: 'https://tienda.prueba.test' },
  });
  await L.waitHttp(port);
  await L.request(port, 'POST', '/api/setup/complete', {
    language: 'es', businessType, businessStructureMode: 'monocaja',
    businessName: 'Negocio Prueba', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
    adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
  });
  return server;
}

async function entrar(browser, port) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  const errores = [];
  page.on('pageerror', (e) => errores.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#login-user', { timeout: 30000 });
  await page.evaluate(() => {
    document.getElementById('login-user').value = 'admin';
    document.getElementById('login-pass').value = '1234';
  });
  await page.evaluate(() => doLogin());
  await sleep(2000);
  const api = (metodo, ruta, cuerpo) => page.evaluate(async (m, r, c) => {
    const res = await fetch(r, {
      method: m,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` },
      body: c ? JSON.stringify(c) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, metodo, ruta, cuerpo);
  return { page, errores, api };
}

async function empresaServicios(browser) {
  const server = await arrancar('srv', 'srv_limpieza', PORT);
  try {
    const { page, errores, api } = await entrar(browser, PORT);
    const modo = await page.evaluate(() => ({
      servicio: Boolean(DB.config?.serviceCompany),
      ventas: Boolean(document.querySelector('[data-module="ventas"]')?.offsetParent),
    }));
    ok('empresa de servicios, sin pantalla de venta', modo.servicio && !modo.ventas, JSON.stringify(modo));

    // El servicio del catálogo nace con su producto, sin duplicar.
    const creado = await api('POST', '/api/servicios/catalogo', { nombre: 'Limpieza profunda', codigo: 'LIMP-1', precio: 3500, itbisPct: 18, unidad: 'servicio' });
    ok('crear el servicio', creado.status === 201 || creado.status === 200, JSON.stringify(creado.body));
    const servicioId = creado.body.id;
    ok('el servicio queda enlazado a su producto', Number(creado.body.productoId) > 0, JSON.stringify(creado.body));
    await api('POST', '/api/servicios/catalogo', { nombre: 'Fumigación', precio: 2000, itbisPct: 18, unidad: 'servicio' });
    const productos = await api('GET', '/api/tienda-online/productos?limit=50');
    const nombres = (productos.body.productos || productos.body.items || []).map((p) => p.nombre);
    ok('los servicios se pueden publicar en la tienda', nombres.includes('Limpieza profunda') && nombres.includes('Fumigación'), JSON.stringify(productos.body).slice(0, 300));

    // Activar y abrir
    await api('PUT', '/api/tienda-online/config', { enabled: true, slug: 'limpieza-prueba' });
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(2500);
    const logueada = await page.evaluate(() => Boolean(DB.currentUser));
    if (!logueada) {
      await page.evaluate(() => {
        document.getElementById('login-user').value = 'admin';
        document.getElementById('login-pass').value = '1234';
      });
      await page.evaluate(() => doLogin());
      await sleep(2000);
    }

    // Solicitudes de ejemplo, como si hubieran llegado de la nube.
    let lista = [
      { id: 1, cloudId: 'a', tipo: 'cotizacion', estado: 'nueva', productoId: creado.body.productoId, articulo: 'Limpieza profunda', precio: 3500, servicioId, cliente: { nombre: 'Ana Pérez', telefono: '8095550101', email: '' }, mensaje: 'Son tres oficinas', fecha: '', hora: '', referencia: '', creadoEn: '2026-11-02 09:00:00' },
      { id: 2, cloudId: 'b', tipo: 'cita', estado: 'nueva', productoId: creado.body.productoId, articulo: 'Limpieza profunda', precio: 3500, servicioId, cliente: { nombre: 'Luis Díaz', telefono: '8095550202', email: '' }, mensaje: '', fecha: '2030-01-15', hora: '10:30', referencia: '', creadoEn: '2026-11-02 09:10:00' },
    ];
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('/api/tienda-online/solicitudes')) {
        if (req.method() === 'GET') {
          req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ solicitudes: lista, nuevas: lista.filter((s) => s.estado === 'nueva').length }) });
          return;
        }
        if (req.method() === 'PUT') {
          const id = Number(url.split('/').pop());
          const cambio = JSON.parse(req.postData() || '{}');
          lista = lista.map((s) => (s.id === id ? { ...s, ...cambio } : s));
          req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(lista.find((s) => s.id === id)) });
          return;
        }
      }
      req.continue();
    });

    await page.evaluate(() => { showModule('tiendaonline', document.getElementById('nav-tienda-online')); });
    await sleep(1200);
    const vista = await page.evaluate(() => ({
      nav: document.querySelector('#nav-tienda-online .nav-label')?.textContent,
      corto: document.querySelector('#nav-tienda-online .nav-short')?.textContent,
      arriba: document.getElementById('breadcrumb')?.textContent,
      titulo: document.querySelector('#module-tiendaonline .module-header h2')?.textContent,
      pedidos: document.querySelector('[data-to-tab="pedidos"]')?.classList.contains('hidden'),
      reportes: document.querySelector('[data-to-tab="reportes"]')?.classList.contains('hidden'),
      publicados: document.getElementById('to-tab-btn-productos')?.textContent,
      panel: !document.getElementById('to-pane-solicitudes')?.classList.contains('hidden'),
      tarjetas: document.querySelectorAll('.to-solicitud').length,
    }));
    ok('el módulo se llama Tienda online y abre en Solicitudes', vista.nav === 'Tienda online' && vista.corto === 'Tienda' && vista.arriba === 'Tienda online' && vista.titulo === 'Tienda online' && vista.panel, JSON.stringify(vista));
    ok('sin pedidos ni reportes de venta', vista.pedidos && vista.reportes);
    ok('la lista de lo publicado habla de servicios', /Servicios publicados/.test(vista.publicados), vista.publicados);
    ok('se ven las dos solicitudes', vista.tarjetas === 2, String(vista.tarjetas));
    if (CAPTURAS) {
      fs.mkdirSync(CAPTURAS, { recursive: true });
      await page.screenshot({ path: path.join(CAPTURAS, 'pos-solicitudes.png') });
    }

    // Cotización de verdad, sin factura.
    await page.evaluate(() => TiendaOnline.atenderSolicitud(1, 'cotizacion'));
    await sleep(1200);
    const cots = await api('GET', '/api/servicios/cotizaciones');
    const filas = cots.body.cotizaciones || cots.body.items || cots.body;
    ok('crea la cotización con su precio y el cliente', Array.isArray(filas) && filas.length === 1 && Number(filas[0].total) === 4130 && filas[0].clientName === 'Ana Pérez', JSON.stringify(cots.body).slice(0, 400));
    const facturas = await api('GET', '/api/servicios/facturas');
    const fact = facturas.body.facturas || facturas.body.items || facturas.body;
    ok('no crea factura', Array.isArray(fact) && fact.length === 0, JSON.stringify(facturas.body).slice(0, 200));
    ok('la solicitud queda atendida con su referencia', lista[0].estado === 'convertida' && /Cotización/.test(lista[0].referencia), JSON.stringify(lista[0]));

    // Cita al calendario real.
    await page.evaluate(() => TiendaOnline.atenderSolicitud(2, 'calendario'));
    await sleep(1000);
    const cal = await api('GET', '/api/servicios/calendario?desde=2030-01-01&hasta=2030-12-31');
    const eventos = cal.body.items || cal.body.eventos || cal.body;
    ok('la cita entra al calendario con su fecha y hora', Array.isArray(eventos) && eventos.some((e) => e.fecha === '2030-01-15' && e.hora && e.hora.startsWith('10:30')), JSON.stringify(cal.body).slice(0, 300));
    ok('la cita queda atendida', lista[1].estado === 'convertida');

    // Configuración: tipo de tienda
    await page.evaluate(() => TiendaOnline.openConfig());
    await page.waitForSelector('[data-cfg-tab="6"]', { timeout: 8000 });
    await page.click('[data-cfg-tab="6"]');
    await sleep(200);
    const form = await page.evaluate(() => ({
      modalidad: Boolean(document.querySelector('#tocfg-modalidad')),
      contratar: Boolean(document.querySelector('#tocfg-srv-contratar')),
      cotizacion: document.querySelector('#tocfg-srv-cotizacion')?.checked,
    }));
    ok('en servicios no se elige modalidad ni carrito', !form.modalidad && !form.contratar && form.cotizacion === true, JSON.stringify(form));
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'pos-tipo-tienda-servicios.png') });
    ok('sin errores en la pantalla (servicios)', errores.length === 0, errores.join(' | '));
  } finally {
    L.stopServer(server);
  }
}

async function negocioNormal(browser) {
  const server = await arrancar('pos', 'colmado', PORT + 1);
  try {
    const { page, errores, api } = await entrar(browser, PORT + 1);

    // Sin código ni barras: el sistema le pone uno.
    const servicio = await api('POST', '/api/products', { nombre: 'Instalación de abanico', categoria: 'General', precioCompra: 0, precioVenta: 800, stock: 99, stockMin: 5, tipoProducto: 'servicio', tracksStock: true, unidad: 'servicio', aplicaItbis: 1 });
    ok('un servicio se crea sin código', servicio.status === 201 || servicio.status === 200, JSON.stringify(servicio.body).slice(0, 200));
    ok('recibe un código interno', /^SRV-\d{5}$/.test(servicio.body.codigo), servicio.body.codigo);
    ok('un servicio nunca lleva inventario', Number(servicio.body.stock) === 0 && servicio.body.tracksStock === false, JSON.stringify(servicio.body).slice(0, 200));
    const producto = await api('POST', '/api/products', { nombre: 'Abanico de techo', categoria: 'General', precioCompra: 1000, precioVenta: 2500, stock: 5, stockMin: 1, unidad: 'und', aplicaItbis: 1 });
    ok('un producto se crea sin código', /^ART-\d{5}$/.test(producto.body.codigo), JSON.stringify(producto.body).slice(0, 200));
    const sinNombre = await api('POST', '/api/products', { categoria: 'General', precioVenta: 10 });
    ok('el nombre sigue siendo obligatorio', sinNombre.status >= 400);
    const repetido = await api('POST', '/api/products', { nombre: 'Otro', codigo: producto.body.codigo, categoria: 'General', precioVenta: 10 });
    ok('un código repetido se rechaza', repetido.status >= 400);

    // Pantalla de ventas: filtro y etiqueta.
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(2000);
    if (!(await page.evaluate(() => Boolean(DB.currentUser)))) {
      await page.evaluate(() => {
        document.getElementById('login-user').value = 'admin';
        document.getElementById('login-pass').value = '1234';
      });
      await page.evaluate(() => doLogin());
      await sleep(2000);
    }
    await page.evaluate(() => { showModule('ventas', document.querySelector('[data-module="ventas"]')); renderSalesCatalog(true); });
    await sleep(1500);
    ok('el filtro de tipo aparece en el catálogo de Ventas', await page.$eval('#sales-type-filter', (e) => !e.classList.contains('hidden')));
    const contar = () => page.evaluate(() => document.querySelectorAll('.sales-product-card').length);
    const todos = await contar();
    await page.select('#sales-type-filter', 'servicios');
    await sleep(500);
    const servicios = await contar();
    const conEtiqueta = await page.evaluate(() => document.querySelectorAll('.sales-product-service-badge').length);
    await page.select('#sales-type-filter', 'productos');
    await sleep(500);
    const productos = await contar();
    ok('el filtro separa productos y servicios', servicios >= 1 && productos >= 1 && servicios + productos === todos, `${todos}/${servicios}/${productos}`);
    ok('el servicio lleva su etiqueta', conEtiqueta >= 1, String(conEtiqueta));
    await page.select('#sales-type-filter', 'todos');
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'pos-ventas-filtro.png') });

    // Venta real: el servicio no descuenta, el producto sí.
    const stockDe = async (id) => {
      const r = (await api('GET', '/api/products?pageSize=100')).body;
      const lista = Array.isArray(r) ? r : (r.items || r.products || r.productos || []);
      return Number(lista.find((p) => Number(p.id) === Number(id))?.stock);
    };
    const antes = await stockDe(producto.body.id);
    const venta = await api('POST', '/api/sales', {
      userId: 1, clientId: null, cliente: 'Consumidor Final', tipoComprobante: 'ticket', ncfType: null, metodo: 'efectivo', tipoPedido: 'mostrador',
      items: [
        { id: servicio.body.id, codigo: servicio.body.codigo, nombre: 'Instalación de abanico', qty: 1, precio: 800 },
        { id: producto.body.id, codigo: producto.body.codigo, nombre: 'Abanico de techo', qty: 2, precio: 2500 },
      ],
      subtotal: 5800, descuento: 0, itbis: 1044, total: 6844, pagoCon: 10000, cambio: 3156,
    });
    ok('vende producto y servicio juntos', venta.status === 200 || venta.status === 201, JSON.stringify(venta.body).slice(0, 300));
    ok('el producto descuenta', await stockDe(producto.body.id) === antes - 2);
    ok('el servicio sigue sin inventario', await stockDe(servicio.body.id) === 0);

    // Compras no ofrece servicios.
    const enCompras = await page.evaluate((id) => {
      const p = (DB.productos || []).find((x) => Number(x.id) === Number(id));
      return p ? p.tipoProducto : null;
    }, servicio.body.id);
    ok('el servicio queda marcado como tal', enCompras === 'servicio', String(enCompras));

    // Configuración: modalidades visibles y se guardan.
    await page.evaluate(() => TiendaOnline.openConfig());
    await page.waitForSelector('[data-cfg-tab="6"]', { timeout: 8000 });
    await page.click('[data-cfg-tab="6"]');
    await sleep(200);
    await page.select('#tocfg-modalidad', 'mixta');
    await page.evaluate(() => {
      document.querySelector('#tocfg-srv-contratar').checked = false;
      document.querySelector('#tocfg-srv-cita').checked = true;
      document.querySelector('#tocfg-srv-precio').checked = false;
      document.querySelector('#tocfg-auto').checked = true;
    });
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'pos-tipo-tienda.png') });
    await page.$eval('#tocfg-slug', (e) => { e.value = 'colmado-prueba'; });
    await page.$$eval('[data-pago]', (l) => { if (!l.some((c) => c.checked)) l[0].click(); });
    await page.evaluate(() => [...document.querySelectorAll('[data-btn]')].find((b) => /^Guardar/.test(b.textContent)).click());
    await sleep(900);
    const cfg = (await api('GET', '/api/tienda-online/config')).body;
    ok('guarda cada opción por separado', cfg.settings.modalidad === 'mixta' && cfg.settings.serviciosTienda.contratar === false && cfg.settings.serviciosTienda.cita === true && cfg.settings.serviciosTienda.mostrarPrecio === false && cfg.settings.serviciosTienda.cotizacion === true && cfg.settings.publicacionAutomatica === true, JSON.stringify({ m: cfg.settings.modalidad, s: cfg.settings.serviciosTienda, a: cfg.settings.publicacionAutomatica }));

    // Pestaña Solicitudes real, vacía.
    await page.evaluate(() => { showModule('tiendaonline', document.getElementById('nav-tienda-online')); TiendaOnline.switchTab('solicitudes'); });
    await sleep(800);
    ok('Solicitudes vacía lo explica', /Todavía no hay solicitudes/.test(await page.$eval('#to-pane-solicitudes', (e) => e.textContent)));
    const pestanas = await page.evaluate(() => ({
      pedidos: document.querySelector('[data-to-tab="pedidos"]')?.classList.contains('hidden'),
      titulo: document.querySelector('#module-tiendaonline .module-header h2')?.textContent,
    }));
    ok('un negocio normal conserva sus Pedidos online', pestanas.pedidos === false && pestanas.titulo === 'Pedidos online', JSON.stringify(pestanas));
    ok('sin errores en la pantalla (POS)', errores.length === 0, errores.join(' | '));
  } finally {
    L.stopServer(server);
  }
}

(async () => {
  L.prepareSandbox();
  const browser = await puppeteer.launch({ headless: true });
  try {
    await empresaServicios(browser);
    await negocioNormal(browser);
  } finally {
    await browser.close();
  }
  const fallas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - fallas.length}/${resultados.length} pasaron`);
  process.exit(fallas.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

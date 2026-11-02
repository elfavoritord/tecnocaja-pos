'use strict';

// El POS real con clics de verdad, en SQLite temporal. Una Empresa de Servicios (sin pantalla
// de venta) activa su tienda y atiende solicitudes; un negocio con POS sigue como siempre.
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
    const original = window.showToast;
    window.avisos = [];
    window.showToast = function (mensaje, ...resto) {
      window.avisos.push(String(mensaje));
      return original.call(this, mensaje, ...resto);
    };
    document.getElementById('login-user').value = 'admin';
    document.getElementById('login-pass').value = '1234';
  });
  await page.evaluate(() => doLogin());
  await sleep(2500);
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

const clicEnBoton = (page, texto) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('[data-btn]')].filter((x) => new RegExp(t).test(x.textContent)).pop();
  b.click();
}, texto);

async function empresaServicios(browser) {
  const server = await arrancar('srv', 'srv_limpieza', PORT);
  try {
    const { page, errores, api } = await entrar(browser, PORT);
    const modo = await page.evaluate(() => ({
      servicio: Boolean(DB.config?.serviceCompany),
      ventas: Boolean(document.querySelector('[data-module="ventas"]')?.offsetParent),
      avisos: window.avisos,
    }));
    ok('empresa de servicios, sin pantalla de venta', modo.servicio && !modo.ventas, JSON.stringify(modo));
    ok('al entrar no sale el aviso de módulo no activo', !modo.avisos.some((a) => /no está activo/.test(a)), modo.avisos.join(' | '));

    const creado = await api('POST', '/api/servicios/catalogo', { nombre: 'Limpieza profunda', codigo: 'LIMP-1', precio: 3500, itbisPct: 18, unidad: 'servicio' });
    ok('crear el servicio', creado.status === 201 || creado.status === 200, JSON.stringify(creado.body));
    const servicioId = creado.body.id;
    ok('el servicio queda enlazado a su producto', Number(creado.body.productoId) > 0, JSON.stringify(creado.body));
    await api('POST', '/api/servicios/catalogo', { nombre: 'Fumigación', precio: 2000, itbisPct: 18, unidad: 'servicio' });
    const productos = await api('GET', '/api/tienda-online/productos?limit=50');
    const nombres = (productos.body.productos || productos.body.items || []).map((p) => p.nombre);
    ok('los servicios se pueden publicar en la tienda', nombres.includes('Limpieza profunda') && nombres.includes('Fumigación'), JSON.stringify(productos.body).slice(0, 300));

    // Activar la tienda como lo haría el dueño: Configuración → Mi Negocio → Tienda online.
    await page.evaluate(() => { showModule('configuracion', document.querySelector('[data-module="configuracion"]')); });
    await sleep(1500);
    const tarjeta = await page.evaluate(() => {
      const c = [...document.querySelectorAll('.cfg-group-card')].find((x) => /Mi Negocio/.test(x.textContent));
      c?.click();
      return Boolean(c);
    });
    ok('Configuración tiene Mi Negocio', tarjeta);
    await sleep(500);
    const fila = await page.evaluate(() => {
      const f = [...document.querySelectorAll('#cfg-group-modal *')].filter((x) => x.children.length <= 3 && x.textContent.trim().startsWith('Tienda online') && x.offsetParent).pop();
      f?.click();
      return Boolean(f);
    });
    ok('Mi Negocio tiene Tienda online', fila);
    await sleep(500);
    const check = await page.evaluate(() => {
      const c = document.getElementById('cfg-tienda-online-enabled');
      c?.click();
      return Boolean(c);
    });
    ok('se puede encender', check);
    await page.waitForSelector('#tocfg-slug', { timeout: 8000 });
    const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-cfg-tab]')].filter((b) => !b.classList.contains('hidden')).map((b) => b.textContent.trim()));
    ok('sin pestañas de Entrega ni Pagos', !tabs.includes('Entrega') && !tabs.includes('Pagos') && tabs.includes('Solicitudes'), tabs.join());
    await page.$eval('#tocfg-slug', (e) => { e.value = 'limpieza-prueba'; });
    await page.click('[data-cfg-tab="6"]');
    await sleep(200);
    const form = await page.evaluate(() => ({
      modalidad: Boolean(document.querySelector('#tocfg-modalidad')),
      contratar: Boolean(document.querySelector('#tocfg-srv-contratar')),
      cotizacion: document.querySelector('#tocfg-srv-cotizacion')?.checked,
    }));
    ok('elige solo cómo recibir solicitudes', !form.modalidad && !form.contratar && form.cotizacion === true, JSON.stringify(form));
    await page.evaluate(() => { document.querySelector('#tocfg-srv-cita').checked = true; });
    if (CAPTURAS) {
      fs.mkdirSync(CAPTURAS, { recursive: true });
      await page.screenshot({ path: path.join(CAPTURAS, 'pos-solicitudes-config.png') });
    }
    await clicEnBoton(page, '^Guardar');
    await sleep(1200);
    const cfg = (await api('GET', '/api/tienda-online/config')).body;
    ok('queda activa sin pedir método de pago', cfg.enabled === true && cfg.slug === 'limpieza-prueba', JSON.stringify({ e: cfg.enabled, s: cfg.slug, avisos: await page.evaluate(() => window.avisos) }));
    ok('guarda la opción de citas', cfg.settings.serviciosTienda.cita === true);

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
      solicitudes: document.querySelector('[data-to-tab="solicitudes"]')?.classList.contains('hidden'),
      publicados: document.getElementById('to-tab-btn-productos')?.textContent,
      panel: !document.getElementById('to-pane-solicitudes')?.classList.contains('hidden'),
      tarjetas: document.querySelectorAll('.to-solicitud').length,
    }));
    ok('el módulo se llama Tienda online y abre en Solicitudes', vista.nav === 'Tienda online' && vista.corto === 'Tienda' && vista.arriba === 'Tienda online' && vista.titulo === 'Tienda online' && vista.panel && vista.solicitudes === false, JSON.stringify(vista));
    ok('sin pedidos ni reportes de venta', vista.pedidos && vista.reportes);
    ok('la lista de lo publicado habla de servicios', /Servicios publicados/.test(vista.publicados), vista.publicados);
    ok('se ven las dos solicitudes', vista.tarjetas === 2, String(vista.tarjetas));
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'pos-solicitudes.png') });

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
    ok('sin errores en la pantalla (servicios)', errores.length === 0, errores.join(' | '));
  } finally {
    L.stopServer(server);
  }
}

async function negocioConPos(browser) {
  const server = await arrancar('pos', 'colmado', PORT + 1);
  try {
    const { page, errores, api } = await entrar(browser, PORT + 1);

    // Productos: como en la 1.6.10.
    const sinCodigo = await api('POST', '/api/products', { nombre: 'Sin código', categoria: 'General', precioCompra: 1, precioVenta: 10, stock: 1, stockMin: 0, unidad: 'und', aplicaItbis: 1 });
    ok('el código sigue siendo obligatorio', sinCodigo.status === 400 && /Código y nombre/.test(sinCodigo.body.error), JSON.stringify(sinCodigo.body));
    const datos = { codigo: 'INS-1', nombre: 'Instalación', categoria: 'General', precioCompra: 0, precioVenta: 800, stock: 7, stockMin: 1, tipoProducto: 'servicio', tracksStock: true, unidad: 'und', aplicaItbis: 1 };
    const conStock = await api('POST', '/api/products', datos);
    ok('un artículo tipo Servicio conserva su stock al crearse', Number(conStock.body.stock) === 7, JSON.stringify(conStock.body).slice(0, 200));
    const id = conStock.body.id;
    const editado = await api('PUT', `/api/products/${id}`, { ...datos, nombre: 'Instalación editada' });
    ok('y al editarse no se pone en 0', editado.status === 200 && Number(editado.body.stock) === 7 && editado.body.tracksStock !== false, JSON.stringify(editado.body).slice(0, 200));

    // Ventas: sin los cambios de la 1.6.11.
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
    await page.evaluate(() => {
      const original = window.showToast;
      window.avisos = [];
      window.showToast = function (mensaje, ...resto) {
        window.avisos.push(String(mensaje));
        return original.call(this, mensaje, ...resto);
      };
      showModule('ventas', document.querySelector('[data-module="ventas"]'));
      renderSalesCatalog(true);
    });
    await sleep(1500);
    const ventas = await page.evaluate(() => ({
      filtro: Boolean(document.getElementById('sales-type-filter')),
      etiqueta: document.querySelectorAll('.sales-product-service-badge').length,
      miniatura: [...document.querySelectorAll('.sales-product-image')].some((i) => /-t\.webp/.test(i.getAttribute('src') || '')),
      tarjetas: document.querySelectorAll('.sales-product-card').length,
    }));
    ok('Ventas sin filtro de tipo, etiqueta ni miniaturas', !ventas.filtro && ventas.etiqueta === 0 && !ventas.miniatura && ventas.tarjetas >= 1, JSON.stringify(ventas));

    // Venta: descuenta como siempre.
    const venta = await api('POST', '/api/sales', {
      userId: 1, clientId: null, cliente: 'Consumidor Final', tipoComprobante: 'ticket', ncfType: null, metodo: 'efectivo', tipoPedido: 'mostrador',
      items: [{ id, codigo: 'INS-1', nombre: 'Instalación', qty: 1, precio: 800 }],
      subtotal: 800, descuento: 0, itbis: 144, total: 944, pagoCon: 1000, cambio: 56,
    });
    ok('la venta funciona', venta.status === 200 || venta.status === 201, JSON.stringify(venta.body).slice(0, 300));
    const lista = (await api('GET', '/api/products?pageSize=100')).body;
    const filas = Array.isArray(lista) ? lista : (lista.items || lista.products || lista.productos || []);
    ok('el artículo con inventario descuenta', Number(filas.find((p) => Number(p.id) === Number(id))?.stock) === 6);

    // Tienda online: como en la 1.6.10.
    await page.evaluate(() => TiendaOnline.openConfig());
    await page.waitForSelector('#tocfg-slug', { timeout: 8000 });
    const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-cfg-tab]')].filter((b) => !b.classList.contains('hidden')).map((b) => b.textContent.trim()));
    ok('Configurar tienda sin pestañas nuevas', tabs.join() === 'General,Entrega,Pagos,Horario,Avanzado,Vitrinas', tabs.join());
    await page.$eval('#tocfg-slug', (e) => { e.value = 'colmado-prueba'; });
    await page.evaluate(() => { document.querySelectorAll('[data-pago]').forEach((c) => { c.checked = false; }); });
    await clicEnBoton(page, '^Guardar');
    await sleep(500);
    ok('sigue pidiendo un método de pago', await page.evaluate(() => window.avisos.some((a) => /método de pago/.test(a))));
    await page.evaluate(() => { document.querySelector('[data-pago]').checked = true; });
    await clicEnBoton(page, '^Guardar');
    await sleep(900);
    const cfg = (await api('GET', '/api/tienda-online/config')).body;
    ok('guarda sin tocar lo de servicios', cfg.slug === 'colmado-prueba' && cfg.settings.publicacionAutomatica === false, JSON.stringify({ s: cfg.slug, a: cfg.settings.publicacionAutomatica }));
    ok('el editor no trae sección de Servicios', !(cfg.disenoBase?.secciones || []).some((s) => s.id === 'servicios'));

    await page.evaluate(() => { showModule('tiendaonline', document.getElementById('nav-tienda-online')); });
    await sleep(900);
    const vista = await page.evaluate(() => ({
      nav: document.querySelector('#nav-tienda-online .nav-label')?.textContent,
      corto: document.querySelector('#nav-tienda-online .nav-short')?.textContent,
      titulo: document.querySelector('#module-tiendaonline .module-header h2')?.textContent,
      pedidos: document.querySelector('[data-to-tab="pedidos"]')?.classList.contains('hidden'),
      solicitudes: document.querySelector('[data-to-tab="solicitudes"]')?.classList.contains('hidden'),
      publicados: document.getElementById('to-tab-btn-productos')?.textContent,
    }));
    ok('conserva sus Pedidos online, sin Solicitudes', vista.nav === 'Pedidos online' && vista.corto === 'Pedidos' && vista.titulo === 'Pedidos online' && vista.pedidos === false && vista.solicitudes === true && /Productos publicados/.test(vista.publicados), JSON.stringify(vista));
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'pos-pedidos.png') });
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
    await negocioConPos(browser);
  } finally {
    await browser.close();
  }
  const fallas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - fallas.length}/${resultados.length} pasaron`);
  process.exit(fallas.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

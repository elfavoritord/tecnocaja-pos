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
    await productosEnEmpresa(page, api);
    ok('sin errores en la pantalla (servicios)', errores.length === 0, errores.join(' | '));
  } finally {
    L.stopServer(server);
  }
}

// La Empresa de Servicios que también vende productos: se facturan como un servicio.
async function productosEnEmpresa(page, api) {
  const navVisible = (modulo) => page.evaluate((m) => {
    // El menú pasa a "Más" lo que no cabe: por eso no se mira si se está pintando.
    const n = document.querySelector(`.nav-item[data-module="${m}"]`);
    const ocultoPorCss = document.documentElement.dataset.appMode === 'servicios' && !document.documentElement.dataset.serviceProducts && ['productos', 'inventario', 'compras'].includes(m);
    return Boolean(n) && !n.classList.contains('hidden') && !ocultoPorCss;
  }, modulo);
  ok('apagado: sin módulo de Productos', !(await navVisible('productos')));
  const sinActivar = await api('GET', '/api/servicios/catalogo/productos');
  ok('apagado: la factura no ofrece productos', Array.isArray(sinActivar.body) && sinActivar.body.length === 0);

  // Encenderlo como lo haría el dueño: Configuración → Empresa de Servicios.
  await page.evaluate(() => { showModule('configuracion', document.querySelector('[data-module="configuracion"]')); });
  await sleep(1000);
  await page.evaluate(() => document.getElementById('srv-cfg-card').click());
  await page.waitForSelector('input[name="productos"]', { timeout: 8000 });
  await page.evaluate(() => { document.querySelector('input[name="productos"]').checked = true; });
  if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'pos-ajuste-productos.png') });
  await page.evaluate(() => {
    const form = document.querySelector('input[name="productos"]').closest('form');
    (form.querySelector('[type="submit"]') || [...form.ownerDocument.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Guardar')).click();
  });
  await sleep(1200);
  ok('encendido: aparecen Productos, Inventario, Compras y Proveedores', (await navVisible('productos')) && (await navVisible('inventario')) && (await navVisible('compras')) && (await navVisible('proveedores')));
  ok('sigue sin pantalla de venta', !(await navVisible('ventas')) && !(await navVisible('caja')));

  const crear = await api('POST', '/api/products', { codigo: 'TONER-1', nombre: 'Tóner HP', categoria: 'General', precioCompra: 1000, precioVenta: 2500, stock: 5, stockMin: 1, unidad: 'und', aplicaItbis: 1 });
  ok('crear un producto', Number(crear.body.id) > 0, JSON.stringify(crear.body).slice(0, 200));
  const id = Number(crear.body.id);
  const stockDe = async () => {
    const r = (await api('GET', '/api/products')).body;
    return Number(r.products.find((p) => Number(p.id) === id)?.stock);
  };
  const nombres = (await api('GET', '/api/products')).body.products.map((p) => p.nombre);
  ok('la lista de Productos no repite los servicios', nombres.includes('Tóner HP') && !nombres.includes('Limpieza profunda'), nombres.join());

  // Comprar sube la existencia, sin caja.
  const proveedor = await api('POST', '/api/suppliers', { nombre: 'Proveedor Tóner', rnc: '', telefono: '', email: '', direccion: '' });
  const compra = await api('POST', '/api/purchases', {
    supplierId: Number(proveedor.body?.id || proveedor.body?.supplier?.id || 0), branchId: await page.evaluate(() => DB.config.activeBranchId || DB.sucursales?.[0]?.id), numeroDocumento: 'B0100000001', condicionPago: 'contado', fechaComprobante: new Date().toISOString().slice(0, 10),
    items: [{ productId: id, codigo: 'TONER-1', nombre: 'Tóner HP', cantidad: 2, costoUnitario: 1000, itbisPct: 18 }],
  });
  ok('comprar sube la existencia, sin caja', compra.status === 201 && await stockDe() === 7, `HTTP ${compra.status} ${compra.body?.error || ''} stock ${await stockDe()}`);
  const ajuste = 2;

  // Los módulos abren sin errores.
  for (const modulo of ['productos', 'inventario', 'compras', 'proveedores']) {
    const abrio = await page.evaluate((m) => {
      window.avisos.length = 0;
      showModule(m, document.querySelector(`.nav-item[data-module="${m}"]`));
      return document.getElementById(`module-${m}`)?.classList.contains('active');
    }, modulo);
    await sleep(600);
    ok(`abre ${modulo}`, abrio && !(await page.evaluate(() => window.avisos.some((a) => /no está activo|permiso/.test(a)))));
    if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, `srv-modulo-${modulo}.png`) });
  }

  // El buscador del catálogo en Nueva factura.
  await api('POST', '/api/products', { codigo: 'CABLE-0', barcode: '7460000000017', nombre: 'Cable sin existencia', categoria: 'General', precioCompra: 1, precioVenta: 50, stock: 0, stockMin: 0, unidad: 'und', aplicaItbis: 0 });
  await page.evaluate(() => { showModule('srv-facturas', document.querySelector('.nav-item[data-module="srv-facturas"]')); });
  await sleep(800);
  // Varios clics seguidos abren una sola ventana, y abre de una vez.
  const apertura = await page.evaluate(async () => {
    const espera = (ms) => new Promise((r) => { setTimeout(r, ms); });
    const b = [...document.querySelectorAll('#module-srv-facturas button, [id*="srv"] button')].find((x) => /Nueva factura/.test(x.textContent));
    const t0 = performance.now();
    b.click(); b.click(); b.click();
    while (!document.querySelector('[data-bus-q]') && performance.now() - t0 < 8000) await espera(10);
    const ms = Math.round(performance.now() - t0);
    await espera(500);
    b.click();
    await espera(300);
    return { ms, ventanas: document.querySelectorAll('.srv-modal-back').length };
  });
  ok('varios clics en Nueva factura abren una sola ventana', apertura.ventanas === 1, JSON.stringify(apertura));
  ok('Nueva factura abre de una vez', apertura.ms < 400, `${apertura.ms} ms`);
  await page.waitForFunction(() => !document.querySelector('[data-bus-tipos]').hidden, { timeout: 8000 });
  const lineas = () => page.$$eval('[data-lines] tr', (l) => l.map((tr) => ({
    pid: tr.querySelector('[name=pid]').value, sid: tr.querySelector('[name=sid]').value, d: tr.querySelector('[name=d]').value,
    c: tr.querySelector('[name=c]').value, p: tr.querySelector('[name=p]').value, ip: tr.querySelector('[name=ip]').value,
  })).filter((x) => x.d));
  const tiposTxt = await page.$$eval('[data-bus-tipo]', (l) => l.map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
  ok('el buscador trae Todos, Servicios y Productos', tiposTxt.join('|') === 'Todos 4|Servicios 2|Productos 2', tiposTxt.join('|'));
  await page.click('[data-bus-q]');
  await page.type('[data-bus-q]', 'toner');
  await sleep(150);
  const resultado = await page.$$eval('.srv-bus-item', (l) => l.map((i) => i.textContent.replace(/\s+/g, ' ').trim()));
  ok('busca sin acentos y muestra precio, ITBIS y existencia', resultado.length === 1 && /Tóner HP/.test(resultado[0]) && /2,500\.00/.test(resultado[0]) && /18% ITBIS/.test(resultado[0]) && new RegExp(`Existencia: ${5 + ajuste}`).test(resultado[0]), JSON.stringify(resultado));
  if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'pos-buscador.png') });
  await page.keyboard.press('Enter');
  await sleep(200);
  let l = await lineas();
  ok('Enter agrega el producto con su precio e ITBIS', l.length === 1 && Number(l[0].pid) === id && !l[0].sid && l[0].d === 'Tóner HP' && Number(l[0].p) === 2500 && Number(l[0].ip) === 18, JSON.stringify(l));
  ok('el buscador queda vacío y listo', await page.evaluate(() => document.activeElement === document.querySelector('[data-bus-q]') && !document.querySelector('[data-bus-q]').value && document.querySelector('[data-bus-lista]').hidden));
  await page.type('[data-bus-q]', 'TONER-1');
  await page.keyboard.press('Enter');
  await sleep(200);
  l = await lineas();
  ok('el mismo código otra vez suma la cantidad', l.length === 1 && Number(l[0].c) === 2, JSON.stringify(l));
  await page.type('[data-bus-q]', '7460000000017');
  await page.keyboard.press('Enter');
  await sleep(200);
  ok('un producto agotado no se agrega', (await lineas()).length === 1 && await page.evaluate(() => window.avisos.some((a) => /agotado/.test(a))));
  await page.evaluate(() => { document.querySelector('[data-bus-q]').value = ''; });
  await page.click('[data-bus-tipo="servicio"]');
  await sleep(150);
  const soloServicios = await page.$$eval('.srv-bus-item', (l) => l.map((i) => i.querySelector('.srv-bus-nom').textContent));
  ok('el filtro Servicios muestra solo servicios', soloServicios.join() === 'Fumigación,Limpieza profunda', soloServicios.join());
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await sleep(200);
  l = await lineas();
  ok('con flechas y Enter se agrega un servicio', l.length === 2 && l[1].d === 'Limpieza profunda' && Number(l[1].sid) > 0 && !l[1].pid, JSON.stringify(l));
  await page.type('[data-bus-q]', 'no existe');
  await sleep(150);
  ok('sin resultados lo dice', /Nada coincide/.test(await page.$eval('[data-bus-lista]', (e) => e.textContent)));
  await page.keyboard.press('Escape');
  ok('Esc cierra el buscador y no la factura', await page.evaluate(() => document.querySelector('[data-bus-lista]').hidden && Boolean(document.querySelector('[data-buscador]'))));
  await page.keyboard.press('Enter');
  ok('Enter en el buscador vacío no emite la factura', await page.evaluate(() => Boolean(document.querySelector('[data-buscador]'))));
  if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, 'pos-factura-producto.png') });
  await page.evaluate(() => [...document.querySelectorAll('.srv-modal button, .modal-overlay button')].find((b) => /Cancelar|Cerrar/.test(b.textContent))?.click());

  // Factura: producto y servicio juntos; descuenta solo el producto.
  const factura = (items, extra = {}) => api('POST', '/api/servicios/facturas', { fiscalMode: 'consumidor', clientName: 'Cliente', items, ...extra });
  const lineaProducto = (cantidad) => ({ productId: id, descripcion: 'Tóner HP', cantidad, precio: 2500, itbisPct: 18 });
  const mixta = await factura([lineaProducto(2), { descripcion: 'Instalación', cantidad: 1, precio: 500, itbisPct: 18 }]);
  ok('factura con producto y servicio', mixta.status === 201 && Number(mixta.body.total) === 6490, JSON.stringify(mixta.body).slice(0, 200));
  ok('descuenta la existencia', await stockDe() === 3 + ajuste, String(await stockDe()));

  // Sin existencia: no se emite nada.
  const facturasAntes = (await api('GET', '/api/servicios/facturas?todas=1')).body.length;
  const sinStock = await factura([lineaProducto(99)]);
  ok('sin existencia se rechaza', sinStock.status === 409 && /Stock insuficiente/.test(sinStock.body.error), JSON.stringify(sinStock.body));
  ok('y no queda factura ni cambia el stock', (await api('GET', '/api/servicios/facturas?todas=1')).body.length === facturasAntes && await stockDe() === 3 + ajuste);

  // Anular devuelve lo vendido, una sola vez.
  const anular = await api('POST', `/api/servicios/facturas/${mixta.body.id}/anular`, { motivo: 'Prueba', forzar: true });
  ok('anular la factura', anular.status === 200, JSON.stringify(anular.body).slice(0, 200));
  ok('devuelve la existencia', await stockDe() === 5 + ajuste, String(await stockDe()));
  const otra = await api('POST', `/api/servicios/facturas/${mixta.body.id}/anular`, { motivo: 'Otra vez', forzar: true });
  ok('anular dos veces no duplica', otra.status === 409 && await stockDe() === 5 + ajuste);

  // Cotizar no toca inventario; facturar la cotización, sí.
  const cot = await api('POST', '/api/servicios/cotizaciones', { clientName: 'Cliente', items: [lineaProducto(1)] });
  ok('cotizar no descuenta', cot.status === 201 && await stockDe() === 5 + ajuste, JSON.stringify(cot.body).slice(0, 160));
  const deCot = await api('POST', `/api/servicios/facturas/desde-cotizacion/${cot.body.id}`, { fiscalMode: 'consumidor' });
  ok('facturar la cotización descuenta', deCot.status === 201 && deCot.body.items[0].productId === id && await stockDe() === 4 + ajuste, JSON.stringify(deCot.body).slice(0, 200));

  // Un servicio no se puede vender como producto, ni un producto si la opción está apagada.
  const productoDeServicio = (await api('GET', '/api/servicios/catalogo?activo=1')).body[0].productoId;
  const conServicio = await factura([{ productId: productoDeServicio, descripcion: 'x', cantidad: 1, precio: 1 }]);
  ok('el producto de un servicio no se factura como producto', conServicio.status === 409, JSON.stringify(conServicio.body));
  await api('PUT', '/api/servicios/config', { productos: false });
  const apagado = await factura([lineaProducto(1)]);
  ok('apagado, la factura rechaza productos', apagado.status === 409 && await stockDe() === 4 + ajuste, JSON.stringify(apagado.body));
  await api('PUT', '/api/servicios/config', { productos: true });
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
    const srvProductos = await page.evaluate(() => getComputedStyle(document.querySelector('.nav-item[data-module="productos"]')).display !== 'none');
    ok('un negocio con POS sigue con su módulo de Productos', srvProductos);
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

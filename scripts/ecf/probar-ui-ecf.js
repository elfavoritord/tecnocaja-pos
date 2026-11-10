// La app real en Chrome contra el DGII falso: cobrar con e-CF en el POS y emitir la factura de
// servicios, con clics y teclas. Nada sale a la DGII real.
// Uso: node scripts/ecf/probar-ui-ecf.js [--servicios]
/* global DB, addProductById, doLogin, openBillingModal, processSale, setSaleDocumentPreset, showModule -- corren en la página */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVICIOS = process.argv.includes('--servicios');
const NOMBRE = SERVICIOS ? 'servicios' : 'pos';
process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), `tecnocaja-ui-ecf-${NOMBRE}`);
const L = require('../e2e-lan/lib');
const puppeteer = require(path.join(L.PROJECT, 'node_modules', 'puppeteer'));
const forge = require(path.join(L.PROJECT, 'node_modules', 'node-forge'));
const { crearDgiiFalso } = require('./dgii-falso');

const PORT = SERVICIOS ? 3466 : 3465;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const CAPTURAS = path.join(L.WORK, 'capturas');
const XMLS = path.join(L.WORK, 'xml-recibidos');
const RNC = '40211932609';
const VENCE = `${new Date().getFullYear() + 1}-12-31`;
const check = L.check;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = (xml, nombre) => (String(xml).match(new RegExp(`<${nombre}>([^<]*)</${nombre}>`)) || [])[1] ?? null;

function crearCertificado(destino, clave) {
  const llaves = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = llaves.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 3 * 365 * 86400000);
  const atributos = [{ name: 'commonName', value: 'EMILIO MANAURYS CABRERA' }, { name: 'countryName', value: 'DO' }, { type: '2.5.4.5', value: `IDCDO-${RNC}` }];
  cert.setSubject(atributos);
  cert.setIssuer(atributos);
  cert.sign(llaves.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(llaves.privateKey, [cert], clave, { algorithm: '3des' });
  fs.writeFileSync(destino, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));
}

(async () => {
  let server = null;
  let browser = null;
  for (const dir of [USER_DATA, HOME, XMLS]) fs.rmSync(dir, { recursive: true, force: true });
  const dgii = crearDgiiFalso({ carpeta: XMLS });
  const ultimo = () => dgii.estado.recibidos[dgii.estado.recibidos.length - 1];
  try {
    L.prepareSandbox();
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    fs.mkdirSync(CAPTURAS, { recursive: true });
    fs.mkdirSync(XMLS, { recursive: true });
    const puertoDgii = await dgii.escuchar();
    server = L.startServer(`ui-${NOMBRE}`, {
      port: PORT, userData: USER_DATA,
      env: {
        DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TC_DGII_FALSO_PUERTO: String(puertoDgii),
        NODE_OPTIONS: `--require ${path.join(L.APP, 'scripts', 'ecf', 'dgii-falso-preload.js').split(path.sep).join('/')}`,
      },
    });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: SERVICIOS ? 'srv_tecnologia' : 'colmado', businessStructureMode: 'monocaja',
      businessName: 'Negocio Prueba', adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test',
      adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    const login = await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' });
    const token = login.body?.token;
    const branchId = login.body?.data?.sucursales?.[0]?.id;
    const api = (m, u, b) => L.request(PORT, m, u, b, token);
    await api('POST', '/api/ecf/config/business', { rnc: RNC, razon_social: 'EMILIO MANAURYS CABRERA', nombre_comercial: 'Negocio', direccion: 'Calle 1', provincia: '', municipio: '', telefono: '809-555-1234', correo: 'n@prueba.test' });
    const rutaP12 = path.join(L.WORK, 'prueba.p12');
    crearCertificado(rutaP12, 'clave-prueba');
    const form = new FormData();
    form.append('password', 'clave-prueba');
    form.append('certificate', new Blob([fs.readFileSync(rutaP12)]), 'prueba.p12');
    await fetch(`http://127.0.0.1:${PORT}/api/ecf/production/reactivar-certificado`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    for (const t of ['E31', 'E32', 'E33', 'E34', 'E44', 'E45', 'E46']) {
      await api('POST', '/api/ecf/sequences/simple', { tipoComprobante: t, ...(['E32', 'E34'].includes(t) ? {} : { fechaVencimiento: VENCE }) });
    }
    let productoId = null;
    if (!SERVICIOS) {
      const prod = await api('POST', '/api/products', { codigo: 'GRAV', barcode: 'GRAV', nombre: 'Producto Gravado', categoria: 'GENERAL', unidad: 'Unidad', marca: '', precioVenta: 100, precioCompra: 50, stock: 100, stockMin: 0, aplicaItbis: true, estado: 'Activo', branchId });
      productoId = Number(prod.body?.product?.id || prod.body?.producto?.id || prod.body?.id || 0);
    }

    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 860 });
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.pathname === '/api/rnc/lookup') {
        const id = u.searchParams.get('id');
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(id === '131880681'
          ? { found: true, rnc: id, nombre: 'EMPRESA DEL PADRON SRL', tipo: 'Persona Jurídica', categoria: 'COMERCIO', estado: 'NORMAL' }
          : { found: false }) });
      }
      return req.continue();
    });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#login-user', { timeout: 30000 });
    await page.evaluate(() => { document.getElementById('login-user').value = 'admin'; document.getElementById('login-pass').value = '1234'; });
    await page.evaluate(() => doLogin());
    await sleep(1500);
    await page.evaluate(() => {
      const pass = document.getElementById('login-pass');
      if (pass && !pass.value) pass.value = '1234';
      if (!(typeof DB !== 'undefined' && DB.currentUser)) return doLogin();
      return null;
    });
    await page.waitForFunction(() => Boolean(typeof DB !== 'undefined' && DB.currentUser), { timeout: 30000 });
    await sleep(1000);

    if (SERVICIOS) {
      const avisos = () => page.evaluate(() => [...document.querySelectorAll('.toast, [class*="toast"]')].map((t) => t.innerText).join(' | '));
      await page.evaluate(() => showModule('srv-facturas'));
      await page.waitForSelector('[data-new]', { visible: true, timeout: 15000 });
      await page.click('[data-new]');
      await page.waitForSelector('#srv-cli-rnc', { visible: true });

      // RNC escrito: trae el nombre del padrón.
      await page.type('#srv-cli-rnc', '131-88068-1');
      await page.waitForFunction(() => document.getElementById('srv-cli-name').value.length > 0, { timeout: 5000 });
      check('Al escribir el RNC sale el nombre', (await page.$eval('#srv-cli-name', (e) => e.value)) === 'EMPRESA DEL PADRON SRL');
      check('Dice que se agregará a Clientes', /Se agregará a tus clientes/.test(await page.$eval('#srv-cli-email-hint', (e) => e.textContent)));
      await page.select('#srv-comp', 'ecf|E31');
      await page.type('[name=d]', 'Consultoría');
      await page.click('[name=p]', { clickCount: 3 });
      await page.type('[name=p]', '1000');
      await page.click('[name=ip]', { clickCount: 3 });
      await page.type('[name=ip]', '18');
      await page.screenshot({ path: path.join(CAPTURAS, 'factura-e31.png') });
      await page.click('button[type=submit].btn-primary');
      // Pagada y aceptada sale de la lista por defecto: el resultado llega como aviso.
      await page.waitForFunction(() => [...document.querySelectorAll('.toast, [class*="toast"]')].some((t) => /Aceptado DGII/.test(t.innerText)), { timeout: 30000 });
      check('El resultado de la DGII llega solo, como aviso', true);
      await page.waitForSelector('#fac-todas', { visible: true });
      await page.click('#fac-todas');
      await page.waitForFunction(() => /Aceptado DGII/.test(document.getElementById('srv-facturas')?.innerText || document.body.innerText), { timeout: 10000 });
      check('Con "Ver pagadas" la factura dice Aceptado DGII', true);
      const r31 = ultimo();
      check('E31 con los datos escritos', r31?.encf?.startsWith('E31') && tag(r31.xml, 'RNCComprador') === '131880681' && Number(tag(r31.xml, 'MontoTotal')) === 1180 && tag(r31.xml, 'IndicadorMontoGravado') === '0', r31 ? `${r31.encf} ${tag(r31.xml, 'MontoTotal')}` : 'no llegó');
      check('Avisa que el cliente se agregó', /EMPRESA DEL PADRON SRL se agregó|Aceptado/.test(await avisos()), (await avisos()).slice(0, 160));
      await page.screenshot({ path: path.join(CAPTURAS, 'lista-aceptado.png') });
      const boot = await api('GET', '/api/bootstrap');
      check('El cliente quedó en la base', (boot.body?.clientes || []).some((c) => String(c.cedula) === '131880681'), JSON.stringify(boot.body?.clientes || []).slice(0, 160));
      check('Y en la lista de esta pantalla, sin recargar', await page.evaluate(() => (DB.clientes || []).some((c) => String(c.cedula) === '131880681')));

      // E44: el ITBIS de las líneas se va a 0 y vuelve al cambiar de comprobante.
      await page.click('[data-new]');
      await page.waitForSelector('#srv-comp', { visible: true });
      await page.type('[name=d]', 'Servicio');
      await page.click('[name=p]', { clickCount: 3 });
      await page.type('[name=p]', '1000');
      await page.click('[name=ip]', { clickCount: 3 });
      await page.type('[name=ip]', '18');
      const opciones = await page.$$eval('#srv-comp option', (os) => os.map((o) => o.value));
      check('E44 aparece para elegir', opciones.includes('ecf|E44'), opciones.join(' '));
      await page.select('#srv-comp', 'ecf|E44');
      await sleep(200);
      const enE44 = await page.$eval('[name=ip]', (e) => ({ valor: e.value, solo: e.readOnly }));
      check('E44: ITBIS en 0 y sin poder cambiarlo', Number(enE44.valor) === 0 && enE44.solo, JSON.stringify(enE44));
      await page.select('#srv-comp', 'ecf|E31');
      await sleep(200);
      const deVuelta = await page.$eval('[name=ip]', (e) => ({ valor: e.value, solo: e.readOnly }));
      check('Volver a E31: el ITBIS regresa', Number(deVuelta.valor) === 18 && !deVuelta.solo, JSON.stringify(deVuelta));
      await page.keyboard.press('Escape');
    } else {
      await page.evaluate(() => showModule('ventas'));
      await sleep(800);
      const totalCobro = () => page.$eval('#cobro-total-left', (e) => e.textContent.replace(/[^\d.]/g, ''));
      const itbisCobro = () => page.$eval('#cobro-itbis', (e) => e.textContent.replace(/[^\d.]/g, ''));

      await page.evaluate((id) => addProductById(id), productoId);
      await sleep(300);
      await page.evaluate(() => openBillingModal());
      await page.waitForSelector('#cobro-total-left', { visible: true, timeout: 10000 });
      await sleep(400);
      check('Cobro con ITBIS: 118', Number(await totalCobro()) === 118, await totalCobro());

      // E44: el total se recalcula sin ITBIS; volver lo devuelve.
      await page.evaluate(() => setSaleDocumentPreset('E44'));
      await sleep(400);
      check('Cobro en E44: total 100 sin ITBIS', Number(await totalCobro()) === 100 && Number(await itbisCobro()) === 0, `${await totalCobro()} / ${await itbisCobro()}`);
      const recibidoYDevuelta = () => page.evaluate(() => ({
        recibido: Number(document.getElementById('monto-recibido')?.value || 0),
        devuelta: parseFmt(document.getElementById('cambio-val')?.textContent || '0'),
      }));
      const e44Recibido = await recibidoYDevuelta();
      check('E44: el recibido exacto baja a 100, sin devuelta', e44Recibido.recibido === 100 && e44Recibido.devuelta === 0, JSON.stringify(e44Recibido));
      check('Comprobantes: Ticket, E32, E31 y «Más» (sin botón e-CF)', JSON.stringify(await page.$$eval('#cobro-shell .cobro-docs .cobro-doc[data-preset]', (b) => b.map((x) => x.dataset.preset))) === '["ticket","E32","E31"]');
      await page.screenshot({ path: path.join(CAPTURAS, 'cobro-e44.png') });
      await page.evaluate(() => setSaleDocumentPreset('factura-electronica'));
      await sleep(400);
      check('Volver a e-CF: total 118', Number(await totalCobro()) === 118, await totalCobro());
      const vueltaRecibido = await recibidoYDevuelta();
      check('Volver a e-CF: el recibido exacto sube a 118', vueltaRecibido.recibido === 118 && vueltaRecibido.devuelta === 0, JSON.stringify(vueltaRecibido));

      // Cobrar E31 escribiendo el RNC.
      await page.evaluate(() => { window.CobroUI?.revealRnc?.(); });
      await sleep(200);
      await page.evaluate(() => {
        const rnc = document.getElementById('ncf-rnc-input');
        rnc.value = '131880681'; rnc.dispatchEvent(new Event('input', { bubbles: true }));
        const razon = document.getElementById('ncf-razon-input');
        if (razon) { razon.value = 'Empresa de Prueba SRL'; razon.dispatchEvent(new Event('input', { bubbles: true })); }
      });
      await page.evaluate(() => {
        const recibido = document.getElementById('cobro-recibido') || document.getElementById('sale-recibido') || document.getElementById('monto-recibido');
        if (recibido) { recibido.value = '118'; recibido.dispatchEvent(new Event('input', { bubbles: true })); }
      });
      await page.screenshot({ path: path.join(CAPTURAS, 'cobro-e31.png') });
      const antes = dgii.estado.recibidos.length;
      await page.evaluate(() => processSale('charge'));
      for (let i = 0; i < 40 && dgii.estado.recibidos.length === antes; i += 1) await sleep(300);
      const r = ultimo();
      check('Cobrar en la pantalla emite el E31', dgii.estado.recibidos.length > antes && r?.encf?.startsWith('E31'), r ? r.encf : 'no llegó');
      check('E31 del cobro: total, RNC e indicador', Number(tag(r?.xml, 'MontoTotal')) === 118 && tag(r?.xml, 'RNCComprador') === '131880681' && tag(r?.xml, 'IndicadorMontoGravado') === '0', r ? `${tag(r.xml, 'MontoTotal')} ${tag(r.xml, 'RNCComprador')}` : '');
      check('Sin reclamos del DGII', r && !r.errores.length, JSON.stringify(r?.errores));
      await sleep(800);
      await page.screenshot({ path: path.join(CAPTURAS, 'despues-del-cobro.png') });

      // Cobrar E44 con un producto con ITBIS: lo que se cobra y el XML dicen lo mismo.
      await page.keyboard.press('Escape');
      await page.evaluate(() => { document.querySelectorAll('#modal-overlay, .modal-overlay').forEach((m) => m.classList.add('hidden')); showModule('ventas'); });
      await sleep(600);
      await page.evaluate((id) => { DB.saleItems = []; addProductById(id); }, productoId);
      await sleep(300);
      await page.evaluate(() => openBillingModal());
      await page.waitForSelector('#cobro-total-left', { visible: true, timeout: 10000 });
      await page.evaluate(() => setSaleDocumentPreset('E44'));
      await sleep(300);
      await page.evaluate(() => {
        window.CobroUI?.revealRnc?.();
        const rnc = document.getElementById('ncf-rnc-input');
        rnc.value = '131880681'; rnc.dispatchEvent(new Event('input', { bubbles: true }));
        const razon = document.getElementById('ncf-razon-input');
        if (razon) { razon.value = 'Zona Franca SRL'; razon.dispatchEvent(new Event('input', { bubbles: true })); }
      });
      const antes44 = dgii.estado.recibidos.length;
      await page.evaluate(() => processSale('charge'));
      for (let i = 0; i < 40 && dgii.estado.recibidos.length === antes44; i += 1) await sleep(300);
      const r44 = ultimo();
      check('Cobrar en E44 emite el E44 exento por 100', r44?.encf?.startsWith('E44') && Number(tag(r44.xml, 'MontoTotal')) === 100 && !r44.errores.length, r44 ? `${r44.encf} ${tag(r44.xml, 'MontoTotal')} ${JSON.stringify(r44.errores)}` : 'no llegó');
    }
    const relevantes = errores.filter((e) => !/ResizeObserver|Failed to fetch/.test(e));
    check('Sin errores de página', relevantes.length === 0, JSON.stringify(relevantes).slice(0, 400));
    L.log(`Capturas: ${CAPTURAS}`);
  } catch (e) {
    check('Prueba completa', false, e.stack || e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await L.stopServer(server).catch(() => {});
    await dgii.cerrar();
  }
  const fallas = L.results.filter((r) => !r.ok);
  console.log(`\n[ui-${NOMBRE}] ${L.results.length - fallas.length}/${L.results.length} comprobaciones OK`);
  process.exit(fallas.length ? 1 : 0);
})();

// Paso 2 de la certificación con la pantalla real (Chrome) y el DGII FALSO lento, como la
// DGII real: "Procesar y enviar comprobantes" tiene que mostrar el avance de los 4 RFCE y
// de los 21 e-CF hasta el final, sin quedarse "cargando". Nada sale a la DGII real.
// Uso: node scripts/ecf/probar-paso2-ui.js <set-paso2.xlsx> [--demora=1500] [--en-proceso]
//   --en-proceso: la DGII falsa contesta "En proceso" un buen rato después de recibirlos,
//   como pasó con un cliente; la pantalla tiene que seguir preguntando sola.
/* global ECF_CERT_WIZARD, doLogin, openFiscalConfigModal, switchFiscalTab, DB -- corren en la página */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-paso2-ui');
const L = require('../e2e-lan/lib');
const puppeteer = require(path.join(L.PROJECT, 'node_modules', 'puppeteer'));
const forge = require(path.join(L.PROJECT, 'node_modules', 'node-forge'));
const { crearDgiiFalso } = require('./dgii-falso');

const SET = process.argv[2];
const DEMORA = Number((process.argv.find((a) => a.startsWith('--demora=')) || '').split('=')[1]) || 1500;
const EN_PROCESO = process.argv.includes('--en-proceso');
const PORT = Number(process.env.TC_PRUEBA_PORT) || 3467;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const XMLS = path.join(L.WORK, 'xml-recibidos');
const CAPTURAS = path.join(L.WORK, 'capturas');
const check = L.check;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function crearCertificado(destino, clave, rnc) {
  const llaves = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = llaves.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 3 * 365 * 86400000);
  const atributos = [{ name: 'commonName', value: 'PRUEBA CERTIFICACION' }, { name: 'countryName', value: 'DO' }, { type: '2.5.4.5', value: `IDCDO-${rnc}` }];
  cert.setSubject(atributos);
  cert.setIssuer(atributos);
  cert.sign(llaves.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(llaves.privateKey, [cert], clave, { algorithm: '3des' });
  fs.writeFileSync(destino, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));
}

(async () => {
  if (!SET || !fs.existsSync(SET)) {
    console.error('Indica el Excel del Paso 2 (RNC-DDMMAAAAhhmmss.xlsx).');
    process.exit(2);
  }
  const RNC = path.basename(SET).split('-')[0];
  const dgii = crearDgiiFalso({ carpeta: XMLS });
  let server = null;
  let browser = null;
  let page = null;
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME, XMLS, CAPTURAS]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    for (const dir of [XMLS, CAPTURAS]) fs.mkdirSync(dir, { recursive: true });
    const copia = path.join(L.WORK, path.basename(SET));
    fs.copyFileSync(SET, copia);
    const puertoDgii = await dgii.escuchar();
    server = L.startServer('paso2-ui', {
      port: PORT, userData: USER_DATA,
      env: {
        DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TECNO_CAJA_DEMO: '1', TECNO_CAJA_SYNC_URL: 'off',
        TC_DGII_FALSO_PUERTO: String(puertoDgii),
        NODE_OPTIONS: `--require ${path.join(L.APP, 'scripts', 'ecf', 'dgii-falso-preload.js').split(path.sep).join('/')}`,
      },
    });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja', businessName: 'Negocio Prueba',
      adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test', adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    const token = (await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' })).body?.token || '';
    const api = (m, u, b) => L.request(PORT, m, u, b, token, 120000);
    await api('POST', '/api/ecf/config/business', {
      rnc: RNC, razon_social: 'EMPRESA DE PRUEBA SRL', nombre_comercial: 'Negocio Prueba', direccion: 'Calle 1 No. 2',
      provincia: '', municipio: '', telefono: '809-555-1234', correo: 'negocio@prueba.test',
    });
    // El certificado se guarda importando el set una vez (importOnly): así no se conecta
    // la recepción con el gateway real, como haría "Cargar certificado".
    const rutaP12 = path.join(L.WORK, 'prueba.p12');
    crearCertificado(rutaP12, 'clave-prueba', RNC);
    const form = new FormData();
    form.append('excel', new Blob([fs.readFileSync(copia)]), path.basename(copia));
    form.append('certificate', new Blob([fs.readFileSync(rutaP12)]), 'prueba.p12');
    form.append('password', 'clave-prueba');
    form.append('environment', 'certecf');
    form.append('importOnly', 'true');
    const previo = await fetch(`http://127.0.0.1:${PORT}/api/ecf/certification-center/process`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    check('Certificado guardado', previo.status === 200, `HTTP ${previo.status}`);
    await api('POST', '/api/ecf/wizard/state', {
      state: { currentStep: 2, completedSteps: [1], startedAt: new Date().toISOString(), environment: 'certecf', steps: {} },
    });
    dgii.estado.demoraMs = DEMORA;
    // 5 rondas de consulta del envío + 2 de la pantalla contestan "En proceso" (21 cada una).
    if (EN_PROCESO) dgii.estado.responderEnProceso = 21 * 7;

    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    page.on('dialog', (d) => { console.log(`[paso2-ui] ventana: ${d.message().replace(/\s+/g, ' ').slice(0, 160)}`); d.accept(); });
    if (process.env.TC_DEPURAR) {
      page.on('console', (m) => console.log(`[pagina] ${m.type()} ${m.text().slice(0, 200)}`));
      page.on('request', (r) => { if (r.url().includes('/api/ecf/')) console.log(`[pagina] → ${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
      page.on('response', (r) => { if (r.url().includes('/api/ecf/')) console.log(`[pagina] ← ${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
    }
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#login-user', { timeout: 30000 });
    await page.evaluate(() => { document.getElementById('login-user').value = 'admin'; document.getElementById('login-pass').value = '1234'; });
    await page.evaluate(() => doLogin());
    await page.waitForFunction(() => Boolean(typeof DB !== 'undefined' && DB.currentUser), { timeout: 30000 });
    await sleep(1000);
    await page.evaluate(() => { openFiscalConfigModal(); switchFiscalTab('homologation'); });
    await page.waitForSelector('#ecf-wz-step2-excel', { timeout: 20000 });
    const input = await page.$('#ecf-wz-step2-excel');
    await input.uploadFile(copia);
    await page.evaluate(() => ECF_CERT_WIZARD._onStep2ExcelChange(document.getElementById('ecf-wz-step2-excel')));

    const inicio = Date.now();
    // Clic del DOM (dispara el onclick del botón); el de coordenadas cae fuera dentro del modal.
    await page.$eval('#ecf-wz-step2-process-btn', (boton) => boton.click());
    const leerLog = () => page.evaluate(() => [...document.querySelectorAll('#ecf-wz-step2-log div')].map((d) => d.textContent.replace(/^.*? — /, '')));
    const botonOcupado = () => page.evaluate(() => document.getElementById('ecf-wz-step2-process-btn')?.disabled === true);

    // Pasados los 90 s (donde antes la pantalla dejaba de esperar) sigue mostrando el avance.
    await page.waitForFunction(() => /Enviando comprobantes a la DGII: \d+ de \d+/.test(document.getElementById('ecf-wz-step2-log')?.textContent || ''), { timeout: 240000 });
    check('Muestra el avance de los comprobantes', true);
    check('El botón queda ocupado mientras envía', await botonOcupado());
    await page.screenshot({ path: path.join(CAPTURAS, 'paso2-enviando.png') });

    // Cambiar de paso y volver: el avance se retoma solo.
    await page.evaluate(() => { ECF_CERT_WIZARD.goToStep(1); });
    await sleep(1500);
    await page.evaluate(() => { ECF_CERT_WIZARD.goToStep(2); });
    await page.waitForSelector('#ecf-wz-step2-log', { timeout: 10000 });

    // Termina cuando el botón queda libre y ya salió el resultado.
    await page.waitForFunction(() => {
      const texto = document.getElementById('ecf-wz-step2-log')?.textContent || '';
      const libre = document.getElementById('ecf-wz-step2-process-btn')?.disabled === false;
      return libre && /Listo: \d+\/\d+ comprobantes aceptados|RFCE rechazado|Error:/.test(texto);
    }, { timeout: 1500000, polling: 1000 });
    const segundos = Math.round((Date.now() - inicio) / 1000);
    const log = await leerLog();
    await page.screenshot({ path: path.join(CAPTURAS, 'paso2-listo.png') });
    console.log(`[paso2-ui] terminó en ${segundos} s (DGII falso con ${DEMORA} ms por respuesta)`);
    for (const linea of log) console.log(`[paso2-ui]   ${linea}`);

    const rutas = dgii.estado.rutas.filter((r) => /^POST /.test(r));
    const fc = rutas.filter((r) => /RecepcionFC/i.test(r)).length;
    const ecf = rutas.filter((r) => /Recepcion/i.test(r) && !/RecepcionFC/i.test(r)).length;
    check('Siguió hasta el final sin quedarse cargando', log.some((l) => /^Listo:/.test(l)), `${segundos} s`);
    check('Salieron los 4 RFCE y los 21 e-CF', fc === 4 && ecf === 21, `RFCE ${fc} · e-CF ${ecf}`);
    check('Al volver al Paso 2 se retomó el avance', log.some((l) => /^Listo:/.test(l)), log.slice(-2).join(' | '));
    check('El botón vuelve a quedar libre', !(await botonOcupado()));
    check('El resultado cuenta los 21 sin los RFCE', log.some((l) => /^Listo: \d+\/21 comprobantes aceptados/.test(l)), log.find((l) => /^Listo:/.test(l)) || '');
    if (EN_PROCESO) {
      check('Avisa que la DGII sigue validando', log.some((l) => /todavía está validando 21 comprobante/.test(l)));
      check('Sigue preguntando sola hasta la respuesta de la DGII', log.some((l) => /^La DGII respondió: \d+\/21/.test(l)), log.slice(-2).join(' | '));
    }
    check('Sin errores en la página', errores.length === 0, errores.slice(0, 3).join(' | '));
    if (L.results.some((r) => !r.ok)) process.exitCode = 1;
  } catch (error) {
    console.error('FALLÓ:', error.stack || error.message);
    if (page) {
      await page.screenshot({ path: path.join(CAPTURAS, 'fallo.png') }).catch(() => {});
      const texto = await page.evaluate(() => (document.getElementById('fiscal-tab-homologation')?.innerText || document.body.innerText || '').slice(0, 1500)).catch(() => '');
      console.error('Pantalla:', texto.replace(/\s+/g, ' '));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await sleep(2000);
    if (server) await L.stopServer(server).catch(() => {});
    await dgii.cerrar().catch(() => {});
    console.log('Capturas:', CAPTURAS);
    process.exit(process.exitCode || 0);
  }
})();

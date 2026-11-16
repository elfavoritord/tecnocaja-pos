// Paso 2 de la certificación ("Procesar y enviar comprobantes") contra un servidor
// real y el DGII FALSO, con un set oficial de la DGII: primero los 4 RFCE y después
// los 21 e-CF. Nada sale a la DGII real (dgii-falso-preload.js).
// Uso: node scripts/ecf/probar-paso2-rfce-primero.js <set-paso2.xlsx> [--rechazar-rfce]
//        [--demora=800]       cada respuesta de la DGII falsa tarda eso (ms), como la real
//        [--con-asistente]    mientras tanto consulta el estado cada 4 s, como el asistente
//        [--sin-segundo-plano] espera la respuesta al final (sin background=true)
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TC_E2E_DIR = process.env.TC_E2E_DIR || path.join(os.tmpdir(), 'tecnocaja-paso2-rfce');
const L = require('../e2e-lan/lib');
const forge = require(path.join(L.PROJECT, 'node_modules', 'node-forge'));
const { crearDgiiFalso } = require('./dgii-falso');

const SET = process.argv[2];
const RECHAZAR = process.argv.includes('--rechazar-rfce');
const DEMORA = Number((process.argv.find((a) => a.startsWith('--demora=')) || '').split('=')[1]) || 0;
const CON_ASISTENTE = process.argv.includes('--con-asistente');
const SEGUNDO_PLANO = !process.argv.includes('--sin-segundo-plano');
const PORT = Number(process.env.TC_PRUEBA_PORT) || 3463;
const USER_DATA = path.join(L.WORK, 'pc-data');
const HOME = path.join(L.WORK, 'home');
const XMLS = path.join(L.WORK, 'xml-recibidos');
const check = L.check;
const ctx = { token: '' };
const api = (method, url, body) => L.request(PORT, method, url, body, ctx.token, 120000);

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
  try {
    L.prepareSandbox();
    for (const dir of [USER_DATA, HOME, XMLS]) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
    fs.mkdirSync(XMLS, { recursive: true });
    const copia = path.join(L.WORK, path.basename(SET));
    fs.copyFileSync(SET, copia);
    const puertoDgii = await dgii.escuchar();
    server = L.startServer('paso2', {
      port: PORT, userData: USER_DATA,
      env: {
        DB_CLIENT: 'sqlite', USERPROFILE: HOME, HOME, TECNO_CAJA_DEMO: '1', TECNO_CAJA_SYNC_URL: 'off',
        TC_DGII_FALSO_PUERTO: String(puertoDgii),
        // TC_PRELOAD_EXTRA: otro --require para diagnosticar (por ejemplo, una traza de tiempos).
        NODE_OPTIONS: [path.join(L.APP, 'scripts', 'ecf', 'dgii-falso-preload.js'), process.env.TC_PRELOAD_EXTRA]
          .filter(Boolean).map((p) => `--require ${p.split(path.sep).join('/')}`).join(' '),
      },
    });
    await L.waitHttp(PORT);
    await L.request(PORT, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'colmado', businessStructureMode: 'monocaja', businessName: 'Negocio Prueba',
      adminName: 'Admin', adminUser: 'admin', adminEmail: 'admin@prueba.test', adminPassword: '1234', openingAmount: 1000, currency: 'RD$',
    });
    ctx.token = (await L.request(PORT, 'POST', '/api/login', { usuario: 'admin', password: '1234' })).body?.token || '';
    const negocio = await api('POST', '/api/ecf/config/business', {
      rnc: RNC, razon_social: 'EMPRESA DE PRUEBA SRL', nombre_comercial: 'Negocio Prueba', direccion: 'Calle 1 No. 2',
      provincia: '', municipio: '', telefono: '809-555-1234', correo: 'negocio@prueba.test',
    });
    check('Datos del emisor', negocio.status === 200, `HTTP ${negocio.status} ${negocio.body?.error || ''}`);

    // Si se pide, el DGII falso rechaza el primer RFCE como "ya utilizado".
    if (RECHAZAR) dgii.estado.rechazarPrimerRfce = true;
    dgii.estado.demoraMs = DEMORA;

    const rutaP12 = path.join(L.WORK, 'prueba.p12');
    crearCertificado(rutaP12, 'clave-prueba', RNC);
    const form = new FormData();
    form.append('excel', new Blob([fs.readFileSync(copia)]), path.basename(copia));
    form.append('certificate', new Blob([fs.readFileSync(rutaP12)]), 'prueba.p12');
    form.append('password', 'clave-prueba');
    form.append('environment', 'certecf');
    form.append('forceReset', 'true');
    // Lo que manda el asistente: el servidor responde al importar y sigue enviando.
    if (SEGUNDO_PLANO) form.append('background', 'true');
    const inicio = Date.now();
    // Lo que hace el asistente mientras espera (_followStep2Run): cada 4 s lee el estado,
    // una consulta a la vez.
    const consultas = { hechas: 0, lentas: 0, maxMs: 0, enCurso: false };
    const consultar = async () => {
      if (consultas.enCurso) return;
      consultas.enCurso = true;
      const t = Date.now();
      await Promise.all([
        api('GET', '/api/ecf/certification-center/status'),
        api('GET', '/api/ecf/certification-center/rfce/status'),
      ]).catch(() => {});
      const ms = Date.now() - t;
      consultas.enCurso = false;
      consultas.hechas += 1;
      consultas.maxMs = Math.max(consultas.maxMs, ms);
      if (ms > 4000) consultas.lentas += 1;
    };
    const asistente = CON_ASISTENTE ? setInterval(consultar, 4000) : null;
    const res = await fetch(`http://127.0.0.1:${PORT}/api/ecf/certification-center/process`, {
      method: 'POST', headers: { Authorization: `Bearer ${ctx.token}` }, body: form, signal: AbortSignal.timeout(600000),
    });
    let cuerpo = await res.json().catch(() => ({}));
    const segundosRespuesta = Math.round((Date.now() - inicio) / 1000);
    if (SEGUNDO_PLANO && res.status === 200) {
      check('Responde apenas importa (en segundo plano)', cuerpo.processing === true && segundosRespuesta < 30, `${segundosRespuesta} s`);
      // Un segundo "Procesar y enviar" mientras tanto no arranca otro envío.
      const otra = new FormData();
      otra.append('excel', new Blob([fs.readFileSync(copia)]), path.basename(copia));
      otra.append('forceReset', 'true');
      const doble = await fetch(`http://127.0.0.1:${PORT}/api/ecf/certification-center/process`, {
        method: 'POST', headers: { Authorization: `Bearer ${ctx.token}` }, body: otra,
      });
      const dobleCuerpo = await doble.json().catch(() => ({}));
      check('Un segundo clic no arranca otro envío', doble.status === 409 && dobleCuerpo.details?.code === 'PASO2_EN_CURSO', `HTTP ${doble.status}`);
      const fases = new Set();
      let run = cuerpo.processRun;
      while (run?.active && Date.now() - inicio < 900000) {
        await new Promise((r) => setTimeout(r, 2000));
        const estado = await api('GET', '/api/ecf/certification-center/status');
        run = estado.body?.processRun;
        if (run?.phase) fases.add(run.phase);
        if (!run?.active) cuerpo = { ...(run?.result || {}), error: run?.error, counts: run?.result?.counts || estado.body?.counts };
      }
      console.log(`[paso2] fases vistas: ${[...fases].join(' → ')}`);
    }
    const segundos = Math.round((Date.now() - inicio) / 1000);
    if (asistente) clearInterval(asistente);
    const rutas = dgii.estado.rutas.filter((r) => /^POST /.test(r));
    const primerFc = rutas.findIndex((r) => /RecepcionFC/i.test(r));
    const primerEcf = rutas.findIndex((r) => /Recepcion/i.test(r) && !/RecepcionFC/i.test(r));
    const fc = rutas.filter((r) => /RecepcionFC/i.test(r)).length;
    const ecf = rutas.filter((r) => /Recepcion/i.test(r) && !/RecepcionFC/i.test(r)).length;
    console.log(`[paso2] respuesta HTTP ${res.status} en ${segundosRespuesta} s · terminó en ${segundos} s · RFCE enviados ${fc} · e-CF enviados ${ecf}`);
    const hosts = {};
    for (const r of dgii.estado.rutas) hosts[r] = (hosts[r] || 0) + 1;
    console.log(`[paso2] destinos ${JSON.stringify(hosts)} · DGII a la vez (máx) ${dgii.estado.maxEnCurso}`);
    if (CON_ASISTENTE) console.log(`[paso2] consultas del asistente ${consultas.hechas} · lentas (>4 s) ${consultas.lentas} · la más lenta ${consultas.maxMs} ms`);
    console.log(`[paso2] counts ${JSON.stringify(cuerpo.counts || {})} · rfce ${JSON.stringify({ ok: cuerpo.rfceProcessResult?.ok, aceptados: cuerpo.rfceProcessResult?.aceptados, rechazados: cuerpo.rfceProcessResult?.rechazados })}`);
    if (cuerpo.error) console.log(`[paso2] error: ${cuerpo.error}`);
    check('El proceso responde', res.status === 200, `HTTP ${res.status} ${cuerpo.error || ''}`);
    if (RECHAZAR) {
      check('RFCE rechazado: no se mandó ningún e-CF', ecf === 0 && cuerpo.rfceFirstRejected === true, `e-CF ${ecf}`);
    } else {
      check('Los RFCE salen antes que los e-CF', primerFc >= 0 && (primerEcf < 0 || primerFc < primerEcf), `FC en ${primerFc}, e-CF en ${primerEcf}`);
      check('Salieron los 4 RFCE', fc === 4, String(fc));
      check('Salieron todos los e-CF del set', ecf >= 21, String(ecf));
    }
    if (L.results.some((r) => !r.ok)) process.exitCode = 1;
  } catch (error) {
    console.error('FALLÓ:', error.stack || error.message);
    process.exitCode = 1;
  } finally {
    await new Promise((r) => setTimeout(r, 2000));
    if (server) await L.stopServer(server).catch(() => {});
    await dgii.cerrar().catch(() => {});
    console.log('Log del servidor:', path.join(L.WORK, 'paso2.log'));
    process.exit(process.exitCode || 0);
  }
})();

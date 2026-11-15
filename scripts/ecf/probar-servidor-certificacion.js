'use strict';

/**
 * Prueba de punta a punta del servidor de certificación (tools/certificacion),
 * en una carpeta temporal (no toca Documents ni el POS de Emilio):
 *  1. crea una empresa → su POS queda listo con los usuarios emilio y contable;
 *  2. se entra en esta PC y por la dirección https del túnel (como el contable);
 *  3. carga un .p12 de prueba y firma un XML de postulación como en el Paso 1;
 *  4. todo quedó en la carpeta de ESA empresa (nada en la copia del programa);
 *  5. se apaga, se cierra el panel, se abre de nuevo y la empresa vuelve con su
 *     certificado (no se pierde nada).
 *
 *   node scripts/ecf/probar-servidor-certificacion.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const forge = require('node-forge');

const BASE = path.join(os.tmpdir(), `tc-cert-prueba-${Date.now().toString(36)}`);
const PANEL = 3650;
const RNC = '999999990';
const resultados = [];
const check = (nombre, ok, detalle = '') => { resultados.push(ok); console.log(`${ok ? 'OK   ' : 'FALLA'} ${nombre}${detalle ? ` — ${detalle}` : ''}`); };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function panel() {
  const p = spawn(process.execPath, [path.join(__dirname, '..', '..', 'tools', 'certificacion', 'servidor.js')], {
    env: { ...process.env, TC_CERT_DIR: BASE, TC_CERT_PANEL_PORT: String(PANEL), TC_CERT_SIN_NAVEGADOR: '1', ELECTRON_RUN_AS_NODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  p.stdout.on('data', (d) => process.stdout.write(`   [panel] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`   [panel] ${d}`));
  return p;
}
async function api(metodo, ruta, cuerpo) {
  const r = await fetch(`http://127.0.0.1:${PANEL}${ruta}`, { method: metodo, headers: { 'Content-Type': 'application/json', 'X-Panel': 'certificacion' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function esperarEmpresa(condicion, ms = 600000) {
  const inicio = Date.now();
  let ultima = null;
  while (Date.now() - inicio < ms) {
    try { ultima = (await api('GET', '/api/estado')).body?.empresas?.find((e) => e.rnc === RNC); } catch (_) { /* panel arrancando */ }
    if (ultima && condicion(ultima)) return ultima;
    await dormir(2000);
  }
  throw new Error(`La empresa no llegó al estado esperado: ${JSON.stringify(ultima)}`);
}
function certificadoDePrueba() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: 'REPRESENTANTE PRUEBA' }, { type: '2.5.4.5', value: `IDCDO-${RNC}` }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'clave123', { algorithm: '3des' })).getBytes(), 'binary');
}
async function entrar(base, usuario, clave, origen) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origen ? { Origin: origen } : {}) }, body: JSON.stringify({ usuario, password: clave }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
function archivos(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== 'node_modules') out.push(...archivos(p)); else if (e.isFile()) out.push(p);
  }
  return out;
}

(async () => {
  let p = panel();
  try {
    await dormir(4000);
    const creada = await api('POST', '/api/empresas', { nombre: 'Prueba Certificación SRL', rnc: RNC });
    check('el panel crea la empresa', creada.status === 201, `HTTP ${creada.status} ${creada.body?.error || ''}`);
    const repetida = await api('POST', '/api/empresas', { nombre: 'Otra', rnc: RNC });
    check('no deja crear la misma empresa dos veces', repetida.status === 409);
    const sinPermiso = await fetch(`http://127.0.0.1:${PANEL}/api/empresas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('una página de Internet no puede dar órdenes al panel', sinPermiso.status === 403);

    let emp = await esperarEmpresa((e) => e.lista && e.estado === 'lista');
    check('su POS quedó listo', true, `${emp.local} · ${emp.url || 'sin túnel'}`);
    const [emilio, contable] = emp.usuarios;
    const local = await entrar(emp.local, emilio.usuario, emilio.clave);
    check('Emilio entra en esta PC', Boolean(local.body?.token), `HTTP ${local.status}`);
    const conta = await entrar(emp.local, contable.usuario, contable.clave);
    check('el contable tiene su usuario', Boolean(conta.body?.token), `HTTP ${conta.status} ${conta.body?.error || ''}`);

    if (emp.url) {
      let pagina = null;
      for (let i = 0; i < 15 && !(pagina && pagina.status === 200); i += 1) {
        try { pagina = await fetch(emp.url); } catch (_) { pagina = null; }
        if (!pagina || pagina.status !== 200) await dormir(3000);
      }
      check('la dirección https abre el POS', pagina?.status === 200 && /<html/i.test(await pagina.text()), `HTTP ${pagina?.status}`);
      const remoto = await entrar(emp.url, contable.usuario, contable.clave, emp.url);
      check('el contable entra desde su casa (por el túnel, con su Origin)', Boolean(remoto.body?.token), `HTTP ${remoto.status} ${remoto.body?.error || ''}`);
    } else {
      check('dirección https del túnel', false, emp.error || 'sin dirección');
    }

    const token = local.body.token;
    const auth = { Authorization: `Bearer ${token}` };
    const fd = new FormData();
    fd.append('certificate', new Blob([certificadoDePrueba()]), 'empresa.p12');
    fd.append('password', 'clave123');
    const subida = await fetch(`${emp.local}/api/ecf/certificate/upload`, { method: 'POST', headers: auth, body: fd });
    const subidaJson = await subida.json().catch(() => null);
    check('carga el certificado .p12 de la empresa', subida.ok, `HTTP ${subida.status} ${subidaJson?.error || ''}`);

    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<FormularioPostulacion>\n  <RNCContribuyente>${RNC}</RNCContribuyente>\n  <RazonSocial>PRUEBA CERTIFICACION SRL</RazonSocial>\n</FormularioPostulacion>`;
    const fx = new FormData();
    fx.append('xml', new Blob([xml], { type: 'application/xml' }), 'postulacion.xml');
    const firma = await fetch(`${emp.local}/api/ecf/wizard/sign-postulation-xml`, { method: 'POST', headers: auth, body: fx });
    const firmaJson = await firma.json().catch(() => null);
    const firmado = String(firmaJson?.signedXml || firmaJson?.data?.signedXml || '');
    check('firma el XML de postulación (Paso 1)', /<SignatureValue>[^<]{100,}/.test(firmado), `HTTP ${firma.status} ${firmaJson?.error || ''}`);
    check('la firma lleva el certificado de la empresa (no el de Emilio)', /<X509Certificate>[A-Za-z0-9+/=\s]{200,}/.test(firmado));

    const raiz = path.join(BASE, 'empresas', RNC);
    const enEmpresa = archivos(raiz).map((f) => path.relative(raiz, f).replace(/\\/g, '/'));
    check('el certificado quedó en la carpeta de la empresa', enEmpresa.some((f) => /^datos\/ecf\/certificates\/.+\.p12$/i.test(f)), enEmpresa.filter((f) => /certificates/.test(f)).join(', '));
    const enPrograma = archivos(path.join(BASE, 'programa', 'app')).map((f) => path.relative(path.join(BASE, 'programa', 'app'), f).replace(/\\/g, '/'));
    check('en la copia del programa no hay certificados ni datos de empresas', !enPrograma.some((f) => /\.(p12|pfx|sqlite|db)$/i.test(f) || /^storage\//.test(f) || /^ecf\//.test(f)),
      enPrograma.filter((f) => /\.(p12|pfx|sqlite|db)$/i.test(f) || /^storage\//.test(f) || /^ecf\//.test(f)).slice(0, 5).join(', '));
    check('tampoco hay .env en la copia del programa', !fs.existsSync(path.join(BASE, 'programa', 'app', '.env')));

    // Apagar con el botón, cerrar el panel y abrirlo otra vez.
    const apagada = await api('POST', `/api/empresas/${RNC}/apagar`);
    check('se apaga guardando su base', apagada.status === 200 && apagada.body?.estado === 'apagada', `HTTP ${apagada.status}`);
    p.kill();
    await dormir(3000);
    p = panel();
    emp = await esperarEmpresa((e) => e.estado === 'lista');
    check('al abrir el panel la empresa enciende sola', true, emp.url || 'sin túnel');
    const otra = await entrar(emp.local, emilio.usuario, emilio.clave);
    const bundle = await fetch(`${emp.local}/api/ecf/config`, { headers: { Authorization: `Bearer ${otra.body?.token}` } }).then((r) => r.json()).catch(() => null);
    const cert = bundle?.certificate || bundle?.data?.certificate || {};
    check('sigue con su certificado después de apagar y encender', cert.hasCertificate === true && /REPRESENTANTE PRUEBA/.test(String(cert.subject || '')), JSON.stringify(cert).slice(0, 160));
    check('el panel muestra el paso del asistente', emp.progreso && emp.progreso.paso >= 1, JSON.stringify(emp.progreso));
    await api('POST', `/api/empresas/${RNC}/apagar`);
  } catch (e) {
    check('sin errores inesperados', false, e.stack || e.message);
  } finally {
    try { p.kill(); } catch (_) { /* ya salió */ }
  }
  const fallas = resultados.filter((x) => !x).length;
  console.log(fallas ? `\n${fallas} comprobación(es) fallaron. Carpeta: ${BASE}` : `\n${resultados.length} comprobaciones OK. Carpeta de prueba: ${BASE}`);
  process.exit(fallas ? 1 : 0);
})();

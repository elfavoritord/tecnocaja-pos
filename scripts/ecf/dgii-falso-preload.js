// Se carga con NODE_OPTIONS=--require en el servidor de prueba: todo lo que iba a
// *.dgii.gov.do va al DGII falso de la prueba. Ningún e-CF de prueba llega a la DGII real.
const http = require('http');
const https = require('https');

const PUERTO = Number(process.env.TC_DGII_FALSO_PUERTO);
if (!PUERTO) throw new Error('Falta TC_DGII_FALSO_PUERTO: no arranco sin el DGII falso.');
const esDgii = (host) => /(^|\.)dgii\.gov\.do$/i.test(String(host || ''));

const httpsRequest = https.request.bind(https);
https.request = function request(opciones, ...resto) {
  if (typeof opciones === 'object' && opciones && !(opciones instanceof URL) && esDgii(opciones.hostname || opciones.host)) {
    return http.request({
      ...opciones,
      protocol: 'http:',
      hostname: '127.0.0.1',
      host: '127.0.0.1',
      port: PUERTO,
      agent: undefined,
      path: `/${opciones.hostname || opciones.host}${opciones.path}`,
    }, ...resto);
  }
  if ((typeof opciones === 'string' || opciones instanceof URL) && esDgii(new URL(opciones).hostname)) {
    throw new Error(`Salida a la DGII real bloqueada: ${opciones}`);
  }
  return httpsRequest(opciones, ...resto);
};

const fetchReal = globalThis.fetch;
if (fetchReal) {
  globalThis.fetch = function fetchProbado(url, ...resto) {
    const destino = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
    if (esDgii(destino.hostname)) {
      return fetchReal(`http://127.0.0.1:${PUERTO}/${destino.hostname}${destino.pathname}${destino.search}`, ...resto);
    }
    return fetchReal(url, ...resto);
  };
}

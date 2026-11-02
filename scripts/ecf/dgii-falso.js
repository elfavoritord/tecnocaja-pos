// DGII falso para las pruebas: da semilla y token, recibe e-CF y RFCE, guarda cada XML y
// contesta por TrackID con la misma forma que la DGII real. Aplica las reglas que ya vimos
// en la DGII real (código 176, 135, número repetido) y revisa las sumas de cada XML.
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const num = (xml, tag) => {
  const m = String(xml).match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? Number(m[1]) : null;
};
const txt = (xml, tag) => {
  const m = String(xml).match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
};
const casi = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.011;

function xmlDelMultipart(cuerpo, contentType) {
  const frontera = String(contentType).match(/boundary=(.+)$/)?.[1];
  if (!frontera) return cuerpo.toString('utf8');
  const parte = cuerpo.toString('utf8').split(`--${frontera}`).find((p) => /name="xml"/.test(p)) || '';
  return parte.slice(parte.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
}

// Lo que la DGII reclamaría en este e-CF: [{ codigo, valor }].
function revisarEcf(xml) {
  const errores = [];
  const tipo = txt(xml, 'TipoeCF');
  const lineas = [...xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map((m) => m[1]);
  const grav = num(xml, 'MontoGravadoTotal') || 0;
  const exento = num(xml, 'MontoExento') || 0;
  const itbis = num(xml, 'TotalITBIS') || 0;
  const total = num(xml, 'MontoTotal');
  const sumaLineas = lineas.reduce((s, l) => s + (num(l, 'MontoItem') || 0), 0);
  if (['31', '32', '33', '34', '41', '45'].includes(tipo) && lineas.some((l) => ['1', '2'].includes(txt(l, 'IndicadorFacturacion')))
    && txt(xml, 'IndicadorMontoGravado') === null && tipo === '31') {
    errores.push({ codigo: 176, valor: 'El campo IndicadorMontoGravado del área IdDoc de la sección Encabezado no es válido' });
  }
  lineas.forEach((l, i) => {
    const calculado = (num(l, 'CantidadItem') || 0) * (num(l, 'PrecioUnitarioItem') || 0) - (num(l, 'DescuentoMonto') || 0);
    if (Math.abs(calculado - (num(l, 'MontoItem') || 0)) > 0.05) errores.push({ codigo: 9009, valor: `Línea ${i + 1}: cantidad × precio − descuento ≠ MontoItem` });
  });
  if (!casi(sumaLineas, grav + exento)) errores.push({ codigo: 9001, valor: `Líneas ${sumaLineas} ≠ gravado ${grav} + exento ${exento}` });
  if (!casi(grav + exento + itbis, total)) errores.push({ codigo: 9002, valor: `Total ${total} ≠ ${grav} + ${exento} + ${itbis}` });
  const i1 = num(xml, 'MontoGravadoI1') || 0;
  const i2 = num(xml, 'MontoGravadoI2') || 0;
  const i3 = num(xml, 'MontoGravadoI3') || 0;
  if (!casi(i1 + i2 + i3, grav)) errores.push({ codigo: 9003, valor: `Gravado por tasa ${i1}+${i2}+${i3} ≠ ${grav}` });
  if (!casi((num(xml, 'TotalITBIS1') || 0), i1 * 0.18)) errores.push({ codigo: 9004, valor: 'ITBIS 18% mal calculado' });
  if (!casi((num(xml, 'TotalITBIS2') || 0), i2 * 0.16)) errores.push({ codigo: 9005, valor: 'ITBIS 16% mal calculado' });
  if (['33', '34'].includes(tipo) && !txt(xml, 'NCFModificado')) errores.push({ codigo: 9006, valor: 'Nota sin NCFModificado' });
  if (['31', '33', '41', '44', '45'].includes(tipo) && !txt(xml, 'RNCComprador')) errores.push({ codigo: 9007, valor: 'Falta RNCComprador' });
  if (!/<Signature[\s>]/.test(xml)) errores.push({ codigo: 9008, valor: 'Sin firma' });
  return errores;
}

function crearDgiiFalso({ carpeta }) {
  fs.mkdirSync(carpeta, { recursive: true });
  const estado = {
    recibidos: [], // { encf, tipo, xml, ruta, errores, trackId, raiz }
    rutas: [],
    rechazarSiguiente: 0,
    tiposSinRango: new Set(),
    responderEnProceso: 0,
  };
  const usados = new Set();
  const porTrack = new Map();

  const responder = (res, codigo, cuerpo, tipo = 'application/json') => {
    res.writeHead(codigo, { 'Content-Type': tipo });
    res.end(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
  };

  function recibir(xml, raiz) {
    const encf = txt(xml, 'eNCF');
    const tipo = encf ? encf.slice(0, 3) : '';
    const ruta = path.join(carpeta, `${tipo}-${estado.recibidos.length + 1}-${raiz}-${encf}.xml`);
    fs.writeFileSync(ruta, xml, 'utf8');
    const errores = raiz === 'ECF' ? revisarEcf(xml) : [];
    const repetido = usados.has(encf);
    if (estado.tiposSinRango.has(tipo)) errores.push({ codigo: 135, valor: 'No existen rangos de secuencias disponibles.' });
    if (estado.rechazarSiguiente > 0) {
      estado.rechazarSiguiente -= 1;
      errores.push({ codigo: 8000, valor: 'Rechazo simulado de la prueba' });
    }
    usados.add(encf);
    const registro = { encf, tipo, xml, ruta, errores, raiz, repetido };
    estado.recibidos.push(registro);
    return registro;
  }

  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      const cuerpo = Buffer.concat(partes);
      const url = new URL(req.url, 'http://x');
      const ruta = url.pathname;
      estado.rutas.push(`${req.method} ${ruta}`);
      if (/Semilla/i.test(ruta) && req.method === 'GET') {
        return responder(res, 200, `<?xml version="1.0" encoding="utf-8"?><SemillaModel><valor>${crypto.randomBytes(8).toString('hex')}</valor><fecha>${new Date().toISOString()}</fecha></SemillaModel>`, 'text/xml');
      }
      if (/ValidacionCertificado|ValidarSemilla|ValidacionSemilla/i.test(ruta)) {
        const expira = new Date(Date.now() + 3600 * 1000).toISOString();
        return responder(res, 200, { token: `token-${Date.now()}`, expedido: new Date().toISOString(), expira });
      }
      if (/RecepcionFC/i.test(ruta) && req.method === 'POST') {
        const xml = xmlDelMultipart(cuerpo, req.headers['content-type']);
        const r = recibir(xml, 'RFCE');
        return responder(res, 200, r.repetido
          ? { codigo: 2, estado: 'Rechazado', mensajes: [{ valor: 'Secuencia ya utilizada', codigo: 1209 }], encf: r.encf, secuenciaUtilizada: true }
          : r.errores.length
            ? { codigo: 2, estado: 'Rechazado', mensajes: r.errores, encf: r.encf, secuenciaUtilizada: true }
            : { codigo: 1, estado: 'Aceptado', mensajes: null, encf: r.encf, secuenciaUtilizada: true });
      }
      if (/Recepcion/i.test(ruta) && req.method === 'POST') {
        const xml = xmlDelMultipart(cuerpo, req.headers['content-type']);
        const r = recibir(xml, 'ECF');
        const trackId = crypto.randomUUID();
        porTrack.set(trackId, r);
        r.trackId = trackId;
        return responder(res, 200, { trackId, error: null, mensaje: null });
      }
      if (/Consulta/i.test(ruta) && req.method === 'GET') {
        const r = porTrack.get(url.searchParams.get('trackid') || url.searchParams.get('trackId'));
        if (!r) return responder(res, 200, { codigo: '3', estado: 'No encontrado', mensajes: [{ valor: 'TrackID no encontrado', codigo: 3 }] });
        if (estado.responderEnProceso > 0) {
          estado.responderEnProceso -= 1;
          return responder(res, 200, { trackId: r.trackId, codigo: '3', estado: 'En Proceso', rnc: txt(r.xml, 'RNCEmisor'), encf: r.encf, secuenciaUtilizada: true, mensajes: [] });
        }
        const rechazado = r.errores.length || r.repetido;
        return responder(res, 200, {
          trackId: r.trackId,
          codigo: rechazado ? '2' : '1',
          estado: rechazado ? 'Rechazado' : 'Aceptado',
          rnc: txt(r.xml, 'RNCEmisor'),
          encf: r.encf,
          secuenciaUtilizada: true,
          fechaRecepcion: new Date().toLocaleString('en-US'),
          mensajes: rechazado ? (r.errores.length ? r.errores : [{ valor: 'Secuencia ya utilizada', codigo: 1209 }]) : [{ valor: '', codigo: 0 }],
        });
      }
      return responder(res, 404, { error: `Ruta no simulada: ${req.method} ${ruta}` });
    });
  });

  return {
    estado,
    escuchar: () => new Promise((resolve) => { servidor.listen(0, '127.0.0.1', () => resolve(servidor.address().port)); }),
    cerrar: () => new Promise((resolve) => { servidor.close(() => resolve()); servidor.closeAllConnections?.(); }),
  };
}

module.exports = { crearDgiiFalso, revisarEcf };

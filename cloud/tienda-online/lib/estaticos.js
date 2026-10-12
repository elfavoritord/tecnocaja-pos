'use strict';

// Velocidad de la tienda: los archivos de la página (app.js, styles.css…) se
// comprimen una sola vez y, como el index.html los pide con ?v=N, se guardan
// en el navegador por un año (cambiar N es lo que los renueva). Las
// respuestas JSON grandes (el catálogo) también van comprimidas.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const TIPOS = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function aceptaGzip(req) {
  return /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
}

/** Sirve /static/*.js y *.css comprimidos y con caché larga si vienen con ?v=. */
function createEstaticos(dir) {
  const cache = new Map();

  function leer(nombre) {
    if (cache.has(nombre)) return cache.get(nombre);
    const ruta = path.join(dir, nombre);
    if (!fs.existsSync(ruta)) return null;
    const raw = fs.readFileSync(ruta);
    const archivo = {
      raw,
      gz: zlib.gzipSync(raw, { level: 9 }),
      etag: `"${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20)}"`,
      tipo: TIPOS[path.extname(nombre)],
    };
    cache.set(nombre, archivo);
    return archivo;
  }

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const nombre = String(req.path || '').replace(/^\/+/, '');
    if (!/^[\w.-]+\.(js|css)$/.test(nombre)) return next();
    const archivo = leer(nombre);
    if (!archivo) return next();
    res.set('Content-Type', archivo.tipo);
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
    res.set('ETag', archivo.etag);
    res.set('Vary', 'Accept-Encoding');
    if (req.headers['if-none-match'] === archivo.etag) return res.status(304).end();
    if (aceptaGzip(req)) {
      res.set('Content-Encoding', 'gzip');
      return res.end(req.method === 'HEAD' ? undefined : archivo.gz);
    }
    return res.end(req.method === 'HEAD' ? undefined : archivo.raw);
  };
}

/** res.json comprimido (gzip) cuando la respuesta es grande y el navegador lo acepta. */
function comprimirJson(req, res, next) {
  const original = res.json.bind(res);
  res.json = (body) => {
    const texto = JSON.stringify(body);
    if (texto === undefined || texto.length < 1400 || !aceptaGzip(req)) return original(body);
    res.set('Vary', 'Accept-Encoding');
    res.set('Content-Encoding', 'gzip');
    res.type('application/json; charset=utf-8');
    return res.send(zlib.gzipSync(texto, { level: 6 }));
  };
  next();
}

module.exports = { createEstaticos, comprimirJson };

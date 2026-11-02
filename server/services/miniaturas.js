'use strict';

// Miniatura de cada foto de producto: la pantalla de ventas no necesita 900 px.
// Se crea la primera vez que se pide, así que las fotos viejas también la tienen.

const fs = require('fs');
const path = require('path');

const SUFIJO = '-t.webp';
const LADO = 240;

function rutaMiniatura(ruta) {
  return String(ruta).replace(/\.webp$/i, SUFIJO);
}

function createMiniaturas({ dir, sharp }) {
  return async (req, res, next) => {
    const nombre = path.basename(decodeURIComponent(String(req.path || '')));
    if (!nombre.endsWith(SUFIJO)) return next();
    const destino = path.join(dir, nombre);
    if (fs.existsSync(destino)) return next();
    const original = path.join(dir, nombre.slice(0, -SUFIJO.length) + '.webp');
    if (!fs.existsSync(original)) return next();
    try {
      await sharp(original).resize(LADO, LADO, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toFile(destino);
    } catch (error) {
      console.warn('[miniaturas] No se pudo crear:', nombre, error.message);
      return res.sendFile(original);
    }
    return next();
  };
}

module.exports = { SUFIJO, createMiniaturas, rutaMiniatura };

'use strict';

/**
 * server/sync/control-center/fotos.js
 *
 * Fotos de los productos para la app de reportes. Cada foto guardada en el
 * POS (la que se sube en la PC o la que manda la app) se publica achicada en
 *
 *   controlCenter/foto_{productId}   { mime, data (base64), version, branchIds }
 *   controlCenter/fotos              índice { versions: { productId: version } }
 *
 * y el catálogo dice qué versión tiene cada producto (`photo`). Sin Firebase
 * Storage: igual que las fotos de la tienda online, van en Firestore.
 *
 * La versión es el nombre del archivo local, que ya trae la huella del
 * contenido (saveProductImageBuffer): si la foto cambia, cambia el nombre.
 * Solo se sube lo que cambió y unas pocas por corrida, para no cargar la PC.
 */

const path = require('path');

const TAMANO = { width: 480, height: 480 };
const DEFAULTS = {
  porCorrida: 30,
  // Una foto de 480 px en WebP pesa ~20-60 KB; esto es solo el tope de seguridad
  // para no pasar del límite de 1 MB por documento de Firestore.
  maxBase64: 700 * 1024,
};

function versionDe(imageLocal) {
  return path.basename(String(imageLocal || '')).slice(0, 120);
}

function createFotosPublisher({ query, processImage, readLocalImage, logger = console, options = {} }) {
  const opts = { ...DEFAULTS, ...options };
  const publicadas = new Map(); // productId -> versión que ya está en Firestore
  const fallidas = new Map(); // productId -> versión que no se pudo procesar (no se reintenta)
  let indiceLeido = false;

  function coleccion(firestore, businessId) {
    return firestore.collection('businesses').doc(businessId).collection('controlCenter');
  }

  async function leerIndice(firestore, businessId) {
    if (indiceLeido) return;
    indiceLeido = true;
    const snap = await coleccion(firestore, businessId).doc('fotos').get().catch(() => null);
    const versions = (snap?.exists ? snap.data() : null)?.versions || {};
    for (const [id, version] of Object.entries(versions)) publicadas.set(String(id), String(version));
  }

  /**
   * Sube las fotos nuevas o cambiadas y borra las que ya no están. Devuelve
   * las versiones publicadas (productId -> versión) para el catálogo.
   */
  async function publicar(firestore, businessId, branchIds = []) {
    if (!processImage || !readLocalImage) return new Map(publicadas);
    await leerIndice(firestore, businessId);
    const filas = await query(
      `SELECT id, nombre, image_local FROM products
        WHERE image_local IS NOT NULL AND image_local <> ''`
    );
    const vigentes = new Map(filas.map((f) => [String(f.id), versionDe(f.image_local)]));
    const base = coleccion(firestore, businessId);
    let cambios = 0;

    const pendientes = filas.filter((f) => {
      const id = String(f.id);
      const version = vigentes.get(id);
      return publicadas.get(id) !== version && fallidas.get(id) !== version;
    });
    for (const fila of pendientes.slice(0, opts.porCorrida)) {
      const id = String(fila.id);
      const version = vigentes.get(id);
      try {
        const buffer = await readLocalImage(fila.image_local);
        if (!buffer) {
          fallidas.set(id, version);
          continue;
        }
        const out = await processImage(buffer, TAMANO);
        if (!out?.data || out.data.length > opts.maxBase64) {
          logger.warn?.(`[control-center] La foto de "${fila.nombre}" quedó muy pesada; no se publica.`);
          fallidas.set(id, version);
          continue;
        }
        await base.doc(`foto_${id}`).set({
          kind: 'productPhoto',
          productId: id,
          mime: out.mime || 'image/webp',
          data: out.data,
          version,
          branchIds,
        });
        publicadas.set(id, version);
        cambios += 1;
      } catch (error) {
        fallidas.set(id, version);
        logger.warn?.(`[control-center] No se pudo publicar la foto de "${fila.nombre}": ${error.message}`);
      }
    }

    // Fotos quitadas o productos borrados.
    for (const id of [...publicadas.keys()]) {
      if (vigentes.has(id)) continue;
      await base.doc(`foto_${id}`).delete().catch(() => {});
      publicadas.delete(id);
      cambios += 1;
    }

    if (cambios > 0) {
      await base.doc('fotos').set({
        kind: 'photoIndex',
        versions: Object.fromEntries(publicadas),
        branchIds,
      });
    }
    return new Map(publicadas);
  }

  return { publicar, versiones: () => new Map(publicadas) };
}

module.exports = { createFotosPublisher, versionDe, TAMANO };

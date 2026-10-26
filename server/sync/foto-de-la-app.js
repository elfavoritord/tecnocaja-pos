'use strict';

/**
 * server/sync/foto-de-la-app.js
 *
 * Foto que manda la app de reportes con un producto (imageUrl con un data URL
 * JPEG, sin Firebase Storage). El POS la guarda como archivo local, igual que
 * las fotos que se suben en la PC (saveProductImageBuffer), y el Centro de
 * Control la devuelve achicada a la app (control-center/fotos.js).
 */

const DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,/i;

function esFotoDeLaApp(valor) {
  return DATA_URL.test(String(valor || ''));
}

async function guardarFotoDeLaApp(
  { query, saveProductImageBuffer, removeLocalProductImage, decodeDataUrlImage },
  { productId, productName, dataUrl }
) {
  const saved = await saveProductImageBuffer({ productId, productName, buffer: decodeDataUrlImage(dataUrl) });
  const [antes] = await query('SELECT image_local FROM products WHERE id = ? LIMIT 1', [productId]);
  await query('UPDATE products SET image_local = ?, image_url = NULL WHERE id = ?', [saved.imageLocal, productId]);
  if (antes?.image_local && antes.image_local !== saved.imageLocal) {
    await Promise.resolve(removeLocalProductImage(antes.image_local)).catch(() => {});
  }
  return saved.imageLocal;
}

module.exports = { esFotoDeLaApp, guardarFotoDeLaApp };

'use strict';

/**
 * La foto que manda la app de reportes con un producto (data URL) se guarda
 * como archivo local, igual que las de la PC, y reemplaza la anterior.
 */

const { esFotoDeLaApp, guardarFotoDeLaApp } = require('../../server/sync/foto-de-la-app');

test('reconoce la foto de la app y deja pasar las URL de siempre', () => {
  expect(esFotoDeLaApp('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
  expect(esFotoDeLaApp('https://img.example/aceite.jpg')).toBe(false);
  expect(esFotoDeLaApp('')).toBe(false);
  expect(esFotoDeLaApp(null)).toBe(false);
});

test('guarda el archivo, limpia image_url y borra la foto vieja', async () => {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    if (/^SELECT image_local/.test(sql)) return [{ image_local: '/uploads/productos/vieja-7-aaa.webp' }];
    return [];
  });
  const saveProductImageBuffer = jest.fn(async () => ({ imageLocal: '/uploads/productos/arroz-7-bbb.webp' }));
  const removeLocalProductImage = jest.fn(async () => {});
  const decodeDataUrlImage = jest.fn((dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64'));

  const local = await guardarFotoDeLaApp(
    { query, saveProductImageBuffer, removeLocalProductImage, decodeDataUrlImage },
    { productId: 7, productName: 'Arroz', dataUrl: `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}` }
  );

  expect(local).toBe('/uploads/productos/arroz-7-bbb.webp');
  expect(saveProductImageBuffer).toHaveBeenCalledWith({ productId: 7, productName: 'Arroz', buffer: Buffer.from('jpeg') });
  expect(calls.find((c) => c.sql.startsWith('UPDATE')).params).toEqual(['/uploads/productos/arroz-7-bbb.webp', 7]);
  expect(removeLocalProductImage).toHaveBeenCalledWith('/uploads/productos/vieja-7-aaa.webp');
});

'use strict';

const path = require('path');

// Carpeta de los archivos de trabajo e-CF (E32 completos, RFCE firmados, ACECF, evidencias).
// En la app instalada process.cwd() es la carpeta del programa y cada actualización la borra
// entera: a mitad de la certificación se perdían los E32 del Paso 4 y el Paso 5 ya no podía
// armar la representación del RFCE. TECNO_CAJA_USER_DATA (lo fija electron/main.js) es la
// carpeta de datos del usuario, que las actualizaciones no tocan.
function ecfWorkPath(...segments) {
  const base = process.env.TECNO_CAJA_USER_DATA
    ? path.resolve(process.env.TECNO_CAJA_USER_DATA)
    : process.cwd();
  return path.join(base, ...segments);
}

module.exports = {
  ecfWorkPath,
};

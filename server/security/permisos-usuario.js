'use strict';
// Permisos propios de un usuario (users.permisos_usuario). NULL = los de su rol,
// exactamente como siempre. Con lista propia, el usuario puede justo lo marcado
// y los atajos por rol (cajero/supervisor/admin de sucursal) dejan de aplicarle.
// El administrador general no se personaliza: siempre puede todo.
const catalogo = require('../../js/permisos-catalogo');

function leerLista(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  let lista = valor;
  if (typeof lista === 'string') {
    try { lista = JSON.parse(lista); } catch (_) { return null; }
  }
  return Array.isArray(lista) ? catalogo.normalizar(lista) : null;
}

const esAdminGeneral = (user) => catalogo.normalizarRol(user?.role_code || user?.rol) === 'administrador_general';

// Lista propia efectiva o null si el usuario usa los permisos de su rol.
function propios(user) {
  if (!user || esAdminGeneral(user)) return null;
  return leerLista(user.permisos_usuario);
}

const personalizado = (user) => propios(user) !== null;

module.exports = { catalogo, leerLista, propios, personalizado, esAdminGeneral };

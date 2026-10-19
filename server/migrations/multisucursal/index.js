'use strict';

// Orden de aplicación. Nunca reordenar ni cambiar el id de una migración ya
// publicada: el id es la clave en schema_migrations de cada cliente.
module.exports = [
  require('./0001-uuid-entidades'),
  require('./0002-tablas-sincronizacion'),
  require('./0003-acceso-sucursales'),
  require('./0004-catalogo-y-sincronizacion'),
];

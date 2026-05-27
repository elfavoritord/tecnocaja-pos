'use strict';

console.error([
  'Generador obsoleto bloqueado.',
  '',
  'Este script no usa la validacion local actual y puede provocar rechazos/reinicio en DGII.',
  '',
  'Usa el boton del modulo DGII:',
  '  Generar XMLs <250Mil ahora',
  '',
  'Ese flujo genera XML <ECF> firmados desde el dataset vigente y sin NombreComercial.',
].join('\n'));

process.exit(1);

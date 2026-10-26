'use strict';

/**
 * electron/recibo-pago.js — Recibo de pago del contador en impresora térmica.
 *
 * Sale con comandos ESC/POS directos (electron/thermal-printer.js, el motor
 * del POS copiado por vendor-sync), igual que los tickets del POS. Mandarlo
 * como página HTML hacía que el controlador de Windows lo girara y lo
 * encogiera en una orilla del papel.
 *
 * datos = reciboPagoDatos() del portal (public/js/contadores-app.js):
 *   { numero, fecha, cliente, rnc, ncf, total, anteriores, monto, saldo,
 *     saldada, metodo, nota, concepto: [lo facturado], pagoNumero, pagosTotal, letras }
 * firma = { nombre_firma, rnc, telefono, direccion, logoMono? } — logoMono:
 *   el logo ya en puntos de térmica ({ width, height, bytesPerLine, data }).
 */

const { ESCPOSBuilder, sendRawToPrinter } = require('./thermal-printer');

function dinero(n) {
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Parte un texto en líneas de `cols` caracteres sin cortar palabras.
function partir(texto, cols) {
  const lineas = [];
  let linea = '';
  String(texto || '').split(/\s+/).filter(Boolean).forEach((palabra) => {
    while (palabra.length > cols) {
      if (linea) { lineas.push(linea); linea = ''; }
      lineas.push(palabra.slice(0, cols));
      palabra = palabra.slice(cols);
    }
    if (!linea) linea = palabra;
    else if (linea.length + 1 + palabra.length <= cols) linea += ` ${palabra}`;
    else { lineas.push(linea); linea = palabra; }
  });
  if (linea) lineas.push(linea);
  return lineas;
}

// "25/10/2026 11:30 a. m." en la hora de esta PC.
function fechaHora(valor) {
  const f = new Date(valor);
  if (Number.isNaN(f.getTime())) return '';
  const dd = String(f.getDate()).padStart(2, '0');
  const mm = String(f.getMonth() + 1).padStart(2, '0');
  const h = f.getHours();
  const hora = `${((h + 11) % 12) + 1}:${String(f.getMinutes()).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
  return `${dd}/${mm}/${f.getFullYear()} ${hora}`;
}

function construirReciboPago(datos, firma = {}, ancho = 80) {
  const p = new ESCPOSBuilder(Number(ancho) === 58 ? '58mm' : '80mm');
  const cols = p.cols;
  const centrado = (texto) => partir(texto, cols).forEach((l) => p.text(l));

  p.init();

  // Logo (ya en puntos de térmica, lo convierte el portal) y la firma
  p.align(1);
  if (firma.logoMono) p.rasterImage(firma.logoMono).feed(1);
  p.bold(true).size(1, 2);
  centrado(firma.nombre_firma || 'Recibo de pago');
  p.size(1, 1).bold(false);
  centrado([firma.rnc ? `RNC ${firma.rnc}` : '', firma.telefono || ''].filter(Boolean).join(' - '));
  if (firma.direccion) centrado(firma.direccion);
  p.feed(1);

  // Título (letra doble: cabe en 58 mm, que da 16 columnas así)
  p.bold(true).size(2, 2).text('RECIBO DE PAGO').size(1, 1);
  p.bold(false).text(`No. ${datos.numero}`);
  const cuando = fechaHora(datos.fecha);
  if (cuando) p.text(cuando);
  p.align(0).separator();

  // Cliente
  p.text('Recibimos de:');
  p.bold(true);
  partir(datos.cliente, cols).forEach((l) => p.text(l));
  p.bold(false);
  if (datos.rnc) p.text(`RNC / Cédula: ${datos.rnc}`);
  p.separator();

  // Por qué paga: lo que se facturó (la segunda línea de cada uno, con sangría)
  if (Array.isArray(datos.concepto) && datos.concepto.length) {
    p.text('Por concepto de:');
    datos.concepto.forEach((c) => partir(c, cols - 2).forEach((l, i) => p.text(`${i ? '  ' : '- '}${l}`)));
    p.separator();
  }

  // Factura y pago
  p.row2('Factura', datos.ncf);
  p.row2('Total factura', dinero(datos.total));
  if (Number(datos.anteriores) > 0) p.row2('Pagado antes', dinero(datos.anteriores));
  p.doubleSep();
  p.bold(true).size(1, 2).row2('ESTE PAGO', `RD$ ${dinero(datos.monto)}`).size(1, 1).bold(false);
  if (datos.letras) partir(datos.letras, cols).forEach((l) => p.text(l));
  p.doubleSep();
  p.row2('Forma de pago', datos.metodo || 'Efectivo');
  if (Number(datos.pagosTotal) > 1) p.row2('Pago', `${datos.pagoNumero} de ${datos.pagosTotal}`);
  if (datos.saldada) {
    p.align(1).bold(true).text('FACTURA SALDADA').bold(false).align(0);
  } else {
    p.bold(true).row2('Saldo pendiente', `RD$ ${dinero(datos.saldo)}`).bold(false);
  }
  if (datos.nota) {
    p.separator();
    partir(`Nota del pago: ${datos.nota}`, cols).forEach((l) => p.text(l));
  }

  // Firma de quien recibe
  p.feed(3).align(1);
  p.text('_'.repeat(Math.min(32, cols - 6)));
  p.text('Recibido por');
  p.align(0).separator();
  p.align(1).text('¡Gracias por su pago!');
  p.feed(4).cut(true);
  return p.build();
}

// Imprime el recibo (y sus copias, cada una con su corte) en la térmica.
async function imprimirReciboPago(impresora, datos, firma, ancho, copias = 1) {
  const uno = construirReciboPago(datos, firma, ancho);
  const veces = Math.min(3, Math.max(1, Number(copias) || 1));
  return sendRawToPrinter(impresora, Buffer.concat(Array.from({ length: veces }, () => uno)));
}

module.exports = { construirReciboPago, imprimirReciboPago, partir, fechaHora };

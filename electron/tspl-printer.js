'use strict';

/**
 * Tecno Caja — Motor de impresión de etiquetas TSPL/TSPL2
 * Para impresoras térmicas de etiquetas dedicadas (Xprinter/TSC/Godex/2C-LP427B/etc.)
 * conectadas como impresora de Windows.
 *
 * Por qué TSPL y no Chromium/webContents.print(): Chromium ignora/descarta
 * tamaños de página personalizados muy pequeños (30-50mm) y cae a un tamaño
 * de página gigante por defecto — confirmado con un PDF de diagnóstico donde
 * el contenido salía diminuto en una esquina de una hoja enorme. Las
 * impresoras de etiquetas por rollo además usan un sensor de separación
 * (gap) entre etiquetas que no tiene relación con "tamaño de página" de un
 * documento — hay que hablarle al hardware en su propio lenguaje (TSPL),
 * indicando el tamaño real de la etiqueta directamente a la impresora.
 *
 * Reutiliza sendRawToPrinter() de thermal-printer.js — mismo transporte
 * (OpenPrinter/WritePrinter vía PowerShell) que ya usa la impresión ESC/POS
 * de recibos, solo cambia el contenido del buffer.
 */

const { sendRawToPrinter } = require('./thermal-printer');

const DOTS_PER_MM = 8; // 203 dpi ≈ 8 dots/mm

function mmToDots(mm) {
  return Math.max(0, Math.round(Number(mm || 0) * DOTS_PER_MM));
}

// TSPL no garantiza soporte de acentos con el codepage por defecto en todos
// los clones — se normalizan a ASCII para evitar caracteres corruptos.
function stripAccents(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '');
}

function escapeTsplString(str) {
  return stripAccents(str).replace(/"/g, "'");
}

class TSPLBuilder {
  constructor() {
    this._lines = [];
  }

  raw(line) {
    this._lines.push(line);
    return this;
  }

  size(widthMm, heightMm) {
    return this.raw(`SIZE ${widthMm} mm,${heightMm} mm`);
  }

  gap(gapMm = 2) {
    return this.raw(`GAP ${gapMm} mm,0 mm`);
  }

  /** Densidad/calor de impresión, 0-15 (más alto = más oscuro/negro) */
  density(level = 10) {
    return this.raw(`DENSITY ${Math.max(0, Math.min(15, Number(level) || 10))}`);
  }

  cls() {
    return this.raw('CLS');
  }

  /**
   * @param {number} xMm @param {number} yMm
   * @param {string} content
   * @param {{font?: string, mult?: number, bold?: boolean}} opts font TSPL built-in 1-8, mult escala x/y 1-10
   */
  text(xMm, yMm, content, opts = {}) {
    const font = opts.font || '3';
    const mult = Math.max(1, Math.min(10, Number(opts.mult) || 1));
    const safe = escapeTsplString(content);
    if (!safe) return this;
    const xDots = mmToDots(xMm);
    const yDots = mmToDots(yMm);
    this.raw(`TEXT ${xDots},${yDots},"${font}",0,${mult},${mult},"${safe}"`);
    if (opts.bold) {
      // TSPL no tiene negrita nativa — se simula con impresión múltiple
      // desfasada 2 dots en las 4 direcciones, engrosando bien el trazo
      // (1 dot de desfase era casi imperceptible).
      const off = 2;
      this.raw(`TEXT ${xDots + off},${yDots},"${font}",0,${mult},${mult},"${safe}"`);
      this.raw(`TEXT ${xDots},${yDots + off},"${font}",0,${mult},${mult},"${safe}"`);
      this.raw(`TEXT ${xDots + off},${yDots + off},"${font}",0,${mult},${mult},"${safe}"`);
    }
    return this;
  }

  /** Code128, sin texto legible propio (el texto se maneja aparte con .text()) */
  barcode(xMm, yMm, content, heightMm = 7, moduleWidthDots = 2) {
    const safe = escapeTsplString(content);
    if (!safe) return this;
    return this.raw(`BARCODE ${mmToDots(xMm)},${mmToDots(yMm)},"128",${mmToDots(heightMm)},0,0,${moduleWidthDots},${moduleWidthDots},"${safe}"`);
  }

  qrcode(xMm, yMm, content, cellWidth = 4) {
    const safe = escapeTsplString(content);
    if (!safe) return this;
    return this.raw(`QRCODE ${mmToDots(xMm)},${mmToDots(yMm)},M,${cellWidth},A,0,"${safe}"`);
  }

  print(copies = 1) {
    return this.raw(`PRINT 1,${Math.max(1, Number(copies) || 1)}`);
  }

  build() {
    return Buffer.from(this._lines.join('\r\n') + '\r\n', 'ascii');
  }
}

const TAMANOS = {
  '30x20': { widthMm: 30, heightMm: 20 },
  '50x30': { widthMm: 50, heightMm: 30 },
};

function money(n) {
  return `RD$${Number(n || 0).toFixed(2)}`;
}

// Tabla aproximada de fuentes internas TSPL (ancho/alto de celda de
// caracter en dots, a mult=1) — valores estándar compartidos por la mayoría
// de clones compatibles TSPL (TSC/Xprinter/Godex). Puede variar un poco
// según el firmware exacto del modelo; si el centrado sale ligeramente
// desviado, es cuestión de afinar esta tabla, no de rediseñar el enfoque.
const FONT_METRICS = {
  '1': { charW: 8, charH: 16 },
  '2': { charW: 12, charH: 20 },
  '3': { charW: 16, charH: 24 },
  '4': { charW: 24, charH: 32 },
};

function textWidthMm(str, font, mult) {
  const m = FONT_METRICS[font] || FONT_METRICS['2'];
  return (String(str || '').length * m.charW * mult) / DOTS_PER_MM;
}
function textHeightMm(font, mult) {
  const m = FONT_METRICS[font] || FONT_METRICS['2'];
  return (m.charH * mult) / DOTS_PER_MM;
}
// Ancho aproximado de un CODE128. Importante: si el contenido es puramente
// numérico y de largo par, el firmware casi siempre usa Code Set C (empareja
// 2 dígitos por símbolo) — la mitad de símbolos que Code Set B. No detectar
// esto fue justo lo que causaba el descentrado (se estimaba ~2x más ancho
// de lo que realmente se imprimía para códigos como "0001").
function code128SymbolCount(content) {
  const str = String(content || '');
  if (/^\d+$/.test(str) && str.length % 2 === 0 && str.length > 0) return str.length / 2;
  return str.length;
}
const BARCODE_MODULE_DOTS = 3; // más grueso que el mínimo (2) = código más grande/bold
function barcodeWidthMm(content) {
  const symbols = code128SymbolCount(content);
  const modules = 11 * (symbols + 2) + 13 + 20; // start+datos+checksum(11c/u) + stop(13) + zonas mudas(~20)
  return (modules * BARCODE_MODULE_DOTS) / DOTS_PER_MM;
}
// Tamaño aproximado de un QR (crece por versión cada ~10 caracteres extra).
function qrSizeMm(content, cellWidth) {
  const modules = 21 + 4 * Math.ceil(String(content || '').length / 10);
  return (modules * cellWidth) / DOTS_PER_MM;
}

function centeredX(widthMm, labelWidthMm, marginMm) {
  return Math.max(marginMm, (labelWidthMm - widthMm) / 2);
}

/**
 * Genera el buffer TSPL completo para imprimir todas las líneas (cada una
 * repetida su `cantidad`), en el tamaño y campos de la plantilla.
 * Todo el contenido queda centrado horizontal y verticalmente dentro de la
 * etiqueta (se calcula el alto total del bloque primero, y se arranca desde
 * el margen correspondiente para que sobre lo mismo arriba que abajo).
 *
 * @param {{ tamanoKey: string, camposConfig: object, lineas: Array<{nombre,precioVenta,codigo,barcode,marca,categoria,cantidad}> }} data
 */
function buildLabelsTspl({ tamanoKey, camposConfig = {}, lineas = [], barcodeOffsetMm = 0 } = {}) {
  const tamano = TAMANOS[String(tamanoKey || '').toLowerCase()] || TAMANOS['50x30'];
  const cfg = camposConfig || {};
  // Ajuste manual de calibración horizontal del código de barras/QR — el
  // ancho real que renderiza cada firmware TSPL clon es imposible de
  // predecir con exactitud sin la impresora física en mano; en vez de
  // seguir adivinando a ciegas, este offset deja que el usuario lo centre
  // él mismo una sola vez desde Configuración → Periféricos.
  const bcOffsetMm = Number(barcodeOffsetMm) || 0;
  const b = new TSPLBuilder();
  b.size(tamano.widthMm, tamano.heightMm);
  b.gap(2);
  b.density(10);

  const marginMm = 1.5;
  const lineGapMm = 0.6;
  const maxContentWidthMm = tamano.widthMm - marginMm * 2;
  const maxContentHeightMm = tamano.heightMm - marginMm * 2;

  for (const l of lineas) {
    const cantidad = Math.max(0, Number(l.cantidad) || 0);
    if (!cantidad) continue;

    // 1ra pasada: arma la lista de bloques a dibujar y calcula el alto total.
    // Todo el texto en bold (opts.bold) — pedido explícito, TSPL lo simula
    // con doble impresión desfasada (ver TSPLBuilder.text).
    const blocks = [];
    if (cfg.mostrarNombre && l.nombre) blocks.push({ type: 'text', content: l.nombre, font: '3', mult: 1 });
    if (cfg.mostrarMarca && l.marca) blocks.push({ type: 'text', content: l.marca, font: '2', mult: 1 });
    if (cfg.mostrarCategoria && l.categoria) blocks.push({ type: 'text', content: l.categoria, font: '2', mult: 1 });
    if (cfg.mostrarPrecio) blocks.push({ type: 'text', content: money(l.precioVenta), font: '2', mult: 2 });
    if (cfg.mostrarCodigo && l.codigo) blocks.push({ type: 'text', content: l.codigo, font: '2', mult: 1 });
    if (cfg.mostrarBarcode) blocks.push({ type: 'barcode', content: l.barcode || l.codigo });
    if (cfg.mostrarQR) blocks.push({ type: 'qr', content: l.barcode || l.codigo });

    // Alto del código de barras — 9mm fijo (igual que la vista previa en
    // pantalla, .lm-barcode{height:9mm} en label-manager.js) para que la
    // proporción impresa se vea como la vista previa, topado por el espacio
    // que realmente quede disponible en etiquetas muy chicas.
    let nonBarcodeHeightMm = 0;
    let gapsCount = Math.max(0, blocks.length - 1);
    blocks.forEach((blk) => {
      if (blk.type === 'text') blk.heightMm = textHeightMm(blk.font, blk.mult);
      else if (blk.type === 'qr') blk.heightMm = Math.min(qrSizeMm(blk.content, 3), maxContentHeightMm * 0.6);
      if (blk.type !== 'barcode') nonBarcodeHeightMm += blk.heightMm;
    });
    const barcodeBlock = blocks.find((blk) => blk.type === 'barcode');
    if (barcodeBlock) {
      const availableMm = maxContentHeightMm - nonBarcodeHeightMm - gapsCount * lineGapMm;
      barcodeBlock.heightMm = Math.max(6, Math.min(9, availableMm));
    }

    const totalHeightMm = blocks.reduce((sum, blk, i) => sum + blk.heightMm + (i > 0 ? lineGapMm : 0), 0);

    // 2da pasada: dibuja centrado, arrancando desde el margen que reparte
    // el espacio sobrante por igual arriba y abajo.
    let yMm = Math.max(marginMm, marginMm + (maxContentHeightMm - totalHeightMm) / 2);
    b.cls();
    blocks.forEach((blk) => {
      if (blk.type === 'text') {
        const wMm = Math.min(textWidthMm(blk.content, blk.font, blk.mult), maxContentWidthMm);
        b.text(centeredX(wMm, tamano.widthMm, marginMm), yMm, blk.content, { font: blk.font, mult: blk.mult, bold: true });
      } else if (blk.type === 'barcode') {
        const wMm = Math.min(barcodeWidthMm(blk.content), maxContentWidthMm);
        b.barcode(centeredX(wMm, tamano.widthMm, marginMm) + bcOffsetMm, yMm, blk.content, blk.heightMm, BARCODE_MODULE_DOTS);
      } else if (blk.type === 'qr') {
        const wMm = Math.min(qrSizeMm(blk.content, 3), maxContentWidthMm);
        b.qrcode(centeredX(wMm, tamano.widthMm, marginMm) + bcOffsetMm, yMm, blk.content, 3);
      }
      yMm += blk.heightMm + lineGapMm;
    });

    b.print(cantidad);
  }

  return b.build();
}

async function printLabelsTspl(printerName, data) {
  try {
    const buffer = buildLabelsTspl(data);
    return await sendRawToPrinter(printerName, buffer);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  TSPLBuilder,
  buildLabelsTspl,
  printLabelsTspl,
};

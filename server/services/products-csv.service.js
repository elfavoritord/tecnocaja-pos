'use strict';

const fs = require('fs');
const path = require('path');

const PRODUCTS_CSV_DIR = path.resolve(__dirname, '../../storage/products/csv-backups');
const PRODUCTS_CSV_CURRENT_FILE = path.join(PRODUCTS_CSV_DIR, 'productos-current.csv');

const PRODUCT_CSV_COLUMNS = [
  { key: 'codigo', label: 'Código' },
  { key: 'nombre', label: 'Nombre' },
  { key: 'marca', label: 'Marca' },
  { key: 'categoria', label: 'Categoría' },
  { key: 'unidad', label: 'Unidad' },
  { key: 'saleMode', label: 'Modo Venta' },
  { key: 'precioCompra', label: 'Costo' },
  { key: 'precioVenta', label: 'Precio' },
  { key: 'stock', label: 'Stock' },
  { key: 'stockMin', label: 'Stock Mínimo' },
  { key: 'estado', label: 'Estado' },
  { key: 'tipoProducto', label: 'Tipo Producto' },
  { key: 'aplicaItbis', label: 'Aplica ITBIS' },
  { key: 'tracksStock', label: 'Rastrea Stock' },
  { key: 'esCombo', label: 'Es Combo' },
  { key: 'tiempoPreparacion', label: 'Tiempo Preparación' },
  { key: 'imagenUrl', label: 'Imagen URL' },
  { key: 'imagenLocal', label: 'Imagen Local' },
];

const HEADER_ALIASES = {
  codigo: 'codigo',
  cod: 'codigo',
  code: 'codigo',
  sku: 'codigo',
  nombre: 'nombre',
  producto: 'nombre',
  nombreproducto: 'nombre',
  marca: 'marca',
  categoria: 'categoria',
  unidad: 'unidad',
  modoventa: 'saleMode',
  mododeventa: 'saleMode',
  salemode: 'saleMode',
  costo: 'precioCompra',
  compra: 'precioCompra',
  preciocompra: 'precioCompra',
  precio_compra: 'precioCompra',
  precio: 'precioVenta',
  venta: 'precioVenta',
  precioventa: 'precioVenta',
  precio_venta: 'precioVenta',
  stock: 'stock',
  existencia: 'stock',
  stockminimo: 'stockMin',
  stockmin: 'stockMin',
  stock_min: 'stockMin',
  stock_minimo: 'stockMin',
  estado: 'estado',
  tipoproducto: 'tipoProducto',
  tipo: 'tipoProducto',
  producttype: 'tipoProducto',
  aplicaitbis: 'aplicaItbis',
  aplica_itbis: 'aplicaItbis',
  itbis: 'aplicaItbis',
  rastreastock: 'tracksStock',
  tracksstock: 'tracksStock',
  tracks_stock: 'tracksStock',
  controlastock: 'tracksStock',
  escombo: 'esCombo',
  combo: 'esCombo',
  iscombo: 'esCombo',
  tiempopreparacion: 'tiempoPreparacion',
  tiempo_preparacion: 'tiempoPreparacion',
  preparacion: 'tiempoPreparacion',
  imagenurl: 'imagenUrl',
  imageurl: 'imagenUrl',
  imagen_local: 'imagenLocal',
  imagenlocal: 'imagenLocal',
  imagelocal: 'imagenLocal',
  margen: 'margen',
};

function ensureProductsCsvDir(directory = PRODUCTS_CSV_DIR) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function pad(value, size = 2) {
  return String(value).padStart(size, '0');
}

function formatProductsCsvTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    pad(date.getMilliseconds(), 3),
  ].join('');
}

function normalizeCsvHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const normalized = String(value);
  if (!/[",\n\r]/.test(normalized) && normalized.trim() === normalized) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, '""')}"`;
}

function parseBooleanLike(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'si', 'sí', 'yes', 'activo', 'activa'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'inactivo', 'inactiva'].includes(normalized)) return false;
  return fallback;
}

function parseDecimalLike(value, fallback = 0) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;

  let normalized = raw
    .replace(/^rd\$\s*/i, '')
    .replace(/\s+/g, '');

  const lastComma = normalized.lastIndexOf(',');
  const lastDot = normalized.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = normalized.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    normalized = normalized.replace(',', '.');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function detectDelimiter(text) {
  const firstLine = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';

  const delimiters = [',', ';', '\t', '|'];
  let winner = ',';
  let maxCount = -1;

  for (const delimiter of delimiters) {
    const count = firstLine.split(delimiter).length - 1;
    if (count > maxCount) {
      maxCount = count;
      winner = delimiter;
    }
  }

  return winner;
}

function parseDelimitedText(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let insideQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];

    if (insideQuotes) {
      if (current === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (current === '"') {
        insideQuotes = false;
      } else {
        field += current;
      }
      continue;
    }

    if (current === '"') {
      insideQuotes = true;
      continue;
    }

    if (current === delimiter) {
      row.push(field);
      field = '';
      continue;
    }

    if (current === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    if (current !== '\r') {
      field += current;
    }
  }

  row.push(field);
  rows.push(row);
  return rows.filter((cells) => cells.some((cell) => String(cell || '').trim() !== ''));
}

function normalizeProductCsvRow(rawRow = {}, rowNumber = 0, providedFields = []) {
  return {
    rowNumber,
    providedFields: [...new Set(providedFields)],
    codigo: String(rawRow.codigo || '').trim(),
    nombre: String(rawRow.nombre || '').trim(),
    marca: String(rawRow.marca || '').trim(),
    categoria: String(rawRow.categoria || '').trim() || 'General',
    unidad: String(rawRow.unidad || '').trim() || 'Unidad',
    saleMode: String(rawRow.saleMode || '').trim() || 'unidad',
    precioCompra: parseDecimalLike(rawRow.precioCompra, 0),
    precioVenta: parseDecimalLike(rawRow.precioVenta, 0),
    stock: parseDecimalLike(rawRow.stock, 0),
    stockMin: parseDecimalLike(rawRow.stockMin, 0),
    estado: String(rawRow.estado || '').trim() || 'Activo',
    tipoProducto: String(rawRow.tipoProducto || '').trim() || 'general',
    aplicaItbis: parseBooleanLike(rawRow.aplicaItbis, false),
    tracksStock: parseBooleanLike(rawRow.tracksStock, true),
    esCombo: parseBooleanLike(rawRow.esCombo, false),
    tiempoPreparacion: Math.max(0, Math.round(parseDecimalLike(rawRow.tiempoPreparacion, 15))),
    imagenUrl: String(rawRow.imagenUrl || '').trim(),
    imagenLocal: String(rawRow.imagenLocal || '').trim(),
  };
}

function parseProductsCsvBuffer(buffer, originalName = 'productos.csv') {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  const cleanText = text.replace(/^\uFEFF/, '').trim();
  if (!cleanText) {
    throw new Error(`El archivo ${originalName} está vacío.`);
  }

  const delimiter = detectDelimiter(cleanText);
  const rows = parseDelimitedText(cleanText, delimiter);
  if (rows.length < 2) {
    throw new Error(`El archivo ${originalName} no contiene filas de productos para importar.`);
  }

  const headers = rows[0].map((header) => HEADER_ALIASES[normalizeCsvHeader(header)] || '');
  const normalizedRows = [];

  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    const rawRow = {};
    const providedFields = [];

    headers.forEach((fieldName, cellIndex) => {
      if (!fieldName || fieldName === 'margen') return;
      rawRow[fieldName] = cells[cellIndex];
      providedFields.push(fieldName);
    });

    if (!String(rawRow.codigo || '').trim() && !String(rawRow.nombre || '').trim()) {
      continue;
    }

    normalizedRows.push(normalizeProductCsvRow(rawRow, index + 1, providedFields));
  }

  if (!normalizedRows.length) {
    throw new Error(`El archivo ${originalName} no contiene productos válidos.`);
  }

  return normalizedRows;
}

function mapProductRowToCsvRecord(row = {}) {
  return {
    codigo: row.codigo || '',
    nombre: row.nombre || '',
    marca: row.marca || '',
    categoria: row.categoria || '',
    unidad: row.unidad || 'Unidad',
    saleMode: row.sale_mode || row.saleMode || 'unidad',
    precioCompra: Number(row.precio_compra ?? row.precioCompra ?? 0),
    precioVenta: Number(row.precio_venta ?? row.precioVenta ?? 0),
    stock: Number(row.stock ?? 0),
    stockMin: Number(row.stock_min ?? row.stockMin ?? 0),
    estado: row.estado || 'Activo',
    tipoProducto: row.product_type || row.tipoProducto || 'general',
    aplicaItbis: Number(row.aplica_itbis ?? row.aplicaItbis ?? 0) ? 'Sí' : 'No',
    tracksStock: Number(row.tracks_stock ?? row.tracksStock ?? 1) ? 'Sí' : 'No',
    esCombo: Number(row.is_combo ?? row.esCombo ?? 0) ? 'Sí' : 'No',
    tiempoPreparacion: Number(row.preparation_time_minutes ?? row.tiempoPreparacion ?? 15),
    imagenUrl: row.image_url || row.imagenUrl || '',
    imagenLocal: row.image_local || row.imagenLocal || '',
  };
}

function buildProductsCsvContent(rows = []) {
  const header = PRODUCT_CSV_COLUMNS.map((column) => csvEscape(column.label)).join(',');
  const body = (Array.isArray(rows) ? rows : []).map((row) => {
    const record = mapProductRowToCsvRecord(row);
    return PRODUCT_CSV_COLUMNS.map((column) => csvEscape(record[column.key])).join(',');
  });
  return [header].concat(body).join('\n');
}

function writeProductsCsvSnapshot(rows = [], options = {}) {
  const directory = ensureProductsCsvDir(options.directory || PRODUCTS_CSV_DIR);
  const csvContent = buildProductsCsvContent(rows);
  const timestamp = formatProductsCsvTimestamp(options.date || new Date());
  const backupFileName = `productos-backup-${timestamp}.csv`;
  const currentFilePath = path.join(directory, 'productos-current.csv');
  const backupFilePath = path.join(directory, backupFileName);

  fs.writeFileSync(currentFilePath, csvContent, 'utf8');
  fs.writeFileSync(backupFilePath, csvContent, 'utf8');

  return {
    directory,
    currentFilePath,
    backupFilePath,
    backupFileName,
    csvContent,
  };
}

module.exports = {
  PRODUCTS_CSV_CURRENT_FILE,
  PRODUCTS_CSV_DIR,
  PRODUCT_CSV_COLUMNS,
  buildProductsCsvContent,
  parseProductsCsvBuffer,
  writeProductsCsvSnapshot,
};

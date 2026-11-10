'use strict';
// Importa compras desde CSV o Excel con la plantilla de Tecno Caja. Un archivo
// puede traer varias facturas: se agrupan por RNC del proveedor + NCF (o número
// de factura) y cada una queda como un borrador de «Preparar compra».

const XLSX = require('xlsx');

const VERSION = 'tabla-1';
const MAX_FILAS = 5000;
const MAX_FACTURAS = 250;

// Nombre de columna → campo. Se compara sin tildes, mayúsculas ni signos.
const ALIAS = {
  rnc_proveedor: ['rnc proveedor', 'rnc', 'rnc cedula', 'cedula', 'rnc suplidor', 'rnc del proveedor'],
  nombre_proveedor: ['nombre proveedor', 'proveedor', 'suplidor', 'razon social', 'nombre suplidor'],
  tipo_comprobante: ['tipo comprobante', 'tipo ncf', 'tipo'],
  ncf: ['ncf', 'e ncf', 'encf', 'comprobante fiscal', 'comprobante'],
  numero_documento: ['numero documento', 'numero factura', 'no factura', 'factura', 'documento', 'num factura'],
  fecha: ['fecha', 'fecha comprobante', 'fecha factura', 'fecha emision'],
  condicion_pago: ['condicion pago', 'condicion', 'forma pago', 'pago'],
  fecha_vencimiento: ['fecha vencimiento', 'vencimiento', 'vence'],
  codigo: ['codigo', 'codigo interno', 'cod', 'sku'],
  codigo_barras: ['codigo barras', 'codigo de barras', 'barcode', 'ean', 'upc'],
  codigo_proveedor: ['codigo proveedor', 'referencia proveedor', 'ref proveedor', 'referencia'],
  descripcion: ['descripcion', 'producto', 'articulo', 'detalle', 'nombre producto', 'concepto'],
  unidad: ['unidad', 'um', 'unidad medida', 'medida'],
  cantidad: ['cantidad', 'cant', 'qty'],
  costo_unitario: ['costo unitario', 'costo', 'precio unitario', 'precio compra', 'costo unit'],
  descuento: ['descuento', 'desc', 'descuento monto'],
  itbis_pct: ['itbis pct', 'itbis %', '% itbis', 'tasa itbis', 'itbis'],
  tipo_linea: ['tipo linea', 'tipo de linea', 'clase'],
  precio_venta: ['precio venta', 'precio de venta', 'pvp'],
  modo_itbis: ['modo itbis', 'modo precio'],
  control_inventario: ['control inventario', 'controla inventario', 'inventario'],
};
const COLUMNAS_PLANTILLA = ['rnc_proveedor', 'nombre_proveedor', 'tipo_comprobante', 'ncf', 'numero_documento', 'fecha', 'condicion_pago',
  'fecha_vencimiento', 'codigo', 'codigo_barras', 'codigo_proveedor', 'descripcion', 'unidad', 'cantidad', 'costo_unitario', 'descuento',
  'itbis_pct', 'tipo_linea', 'precio_venta', 'modo_itbis', 'control_inventario'];

const limpiar = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9%]+/g, ' ').trim();
const dos = (n) => String(n).padStart(2, '0');

function campoDeEncabezado(encabezado) {
  const e = limpiar(encabezado);
  const directo = e.replace(/ /g, '_');
  if (ALIAS[directo]) return directo;
  for (const [campo, alias] of Object.entries(ALIAS)) if (alias.includes(e)) return campo;
  return null;
}

// "1,234.50" · "1.234,50" · "12,5" · "RD$ 100" → número
function numero(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  let t = String(valor ?? '').trim().replace(/rd\$|us\$|\$|\s/gi, '');
  if (!t) return null;
  const coma = t.lastIndexOf(','), punto = t.lastIndexOf('.');
  if (coma >= 0 && punto >= 0) t = coma > punto ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (coma >= 0) t = /^-?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Fecha de Excel (Date), "2026-11-09", "09/11/2026" (día/mes/año) → aaaa-mm-dd
function fecha(valor) {
  if (valor instanceof Date && !Number.isNaN(valor.getTime())) return `${valor.getFullYear()}-${dos(valor.getMonth() + 1)}-${dos(valor.getDate())}`;
  const t = String(valor ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${dos(m[2])}-${dos(m[3])}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${dos(m[2])}-${dos(m[1])}`;
  return '';
}

function siNo(valor, porDefecto = null) {
  const t = limpiar(valor);
  if (!t) return porDefecto;
  if (['si', 's', '1', 'true', 'x', 'yes'].includes(t)) return true;
  if (['no', 'n', '0', 'false'].includes(t)) return false;
  return porDefecto;
}

function tipoLinea(valor) {
  const t = limpiar(valor);
  if (!t) return null;
  if (/serv|gasto/.test(t)) return 'servicio_gasto';
  if (/sin/.test(t)) return 'sin_inventario';
  return 'inventario';
}

function modoItbis(valor) {
  const t = limpiar(valor);
  if (!t) return null;
  if (/exent/.test(t)) return 'exento';
  if (/inclu|final|fijo/.test(t)) return 'incluido';
  return 'base';
}

const BOM = String.fromCharCode(0xfeff);
const sinBom = (t) => (t.startsWith(BOM) ? t.slice(1) : t);

function textoDeArchivo(buffer) {
  const utf8 = sinBom(buffer.toString('utf8'));
  return utf8.includes('�') ? buffer.toString('latin1') : utf8;
}

// buffer + nombre → { facturas: [borrador], errores: [{ fila, texto }] }
function leerTabla(buffer, nombreArchivo = '') {
  const csv = /\.(csv|txt)$/i.test(nombreArchivo);
  let libro;
  try {
    libro = csv
      // raw: el CSV queda como texto (sin adivinar fechas al estilo de EE. UU.: 09/11 es 9 de noviembre).
      ? XLSX.read(textoDeArchivo(buffer), { type: 'string', raw: true })
      : XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (_) {
    throw Object.assign(new Error('No se pudo leer el archivo. Usa la plantilla de compras en Excel o CSV.'), { statusCode: 400 });
  }
  const hoja = libro.Sheets[libro.SheetNames[0]];
  const filas = hoja ? XLSX.utils.sheet_to_json(hoja, { header: 1, defval: '', raw: true }) : [];
  if (filas.length < 2) throw Object.assign(new Error('El archivo no tiene filas de compras.'), { statusCode: 400 });
  if (filas.length - 1 > MAX_FILAS) throw Object.assign(new Error(`El archivo tiene más de ${MAX_FILAS} filas. Divídelo en partes.`), { statusCode: 400 });
  const campos = filas[0].map(campoDeEncabezado);
  for (const necesario of ['descripcion', 'cantidad', 'costo_unitario']) {
    if (!campos.includes(necesario)) throw Object.assign(new Error(`Falta la columna «${necesario}». Descarga la plantilla de compras.`), { statusCode: 400 });
  }
  if (!campos.includes('rnc_proveedor') && !campos.includes('nombre_proveedor')) {
    throw Object.assign(new Error('Falta la columna del proveedor (rnc_proveedor o nombre_proveedor).'), { statusCode: 400 });
  }

  const grupos = new Map();
  const errores = [];
  filas.slice(1).forEach((fila, i) => {
    const numeroFila = i + 2;
    const v = {};
    campos.forEach((campo, j) => { if (campo && v[campo] === undefined) v[campo] = fila[j]; });
    if (Object.values(v).every((x) => String(x ?? '').trim() === '')) return; // fila vacía
    const rnc = String(v.rnc_proveedor ?? '').replace(/\D/g, '');
    const proveedor = String(v.nombre_proveedor ?? '').trim();
    const ncf = String(v.ncf ?? '').trim().toUpperCase();
    const documento = String(v.numero_documento ?? '').trim();
    if (!rnc && !proveedor) { errores.push({ fila: numeroFila, texto: 'falta el proveedor (RNC o nombre).' }); return; }
    const clave = `${rnc || limpiar(proveedor)}|${ncf || documento || 'sin-numero'}`;
    if (!grupos.has(clave)) {
      if (grupos.size >= MAX_FACTURAS) { errores.push({ fila: numeroFila, texto: `más de ${MAX_FACTURAS} facturas en un archivo.` }); return; }
      grupos.set(clave, {
        version: VERSION, origen: csv ? 'csv' : 'xlsx',
        encabezado: {
          proveedor: { nombre: proveedor, rnc }, tipoComprobante: String(v.tipo_comprobante ?? '').trim().toUpperCase() || (ncf ? ncf.slice(0, 3) : ''),
          ncf, numeroDocumento: documento || ncf, fechaComprobante: fecha(v.fecha),
          condicionPago: /cred/.test(limpiar(v.condicion_pago)) ? 'credito' : 'contado', fechaVencimiento: fecha(v.fecha_vencimiento),
          documentoOrigen: 'tabla',
        },
        lineas: [], avisos: [], filas: [],
      });
    }
    const g = grupos.get(clave);
    g.filas.push(numeroFila);
    const cantidad = numero(v.cantidad), costo = numero(v.costo_unitario), descuento = numero(v.descuento) ?? 0, itbis = numero(v.itbis_pct);
    const descripcion = String(v.descripcion ?? '').trim();
    const problemas = [];
    if (!descripcion) problemas.push('falta la descripción');
    if (!(cantidad > 0)) problemas.push('cantidad no válida');
    if (costo === null || costo < 0) problemas.push('costo no válido');
    if (itbis !== null && (itbis < 0 || itbis > 100)) problemas.push('ITBIS % no válido');
    if (problemas.length) g.avisos.push({ nivel: 'error', texto: `Fila ${numeroFila}: ${problemas.join(', ')}.` });
    if (!g.encabezado.fechaComprobante) g.encabezado.fechaComprobante = fecha(v.fecha);
    const precio = numero(v.precio_venta);
    g.lineas.push({
      fila: numeroFila, descripcion, codigo: String(v.codigo ?? '').trim(), codigoBarras: String(v.codigo_barras ?? '').trim(),
      codigoProveedor: String(v.codigo_proveedor ?? '').trim(), unidad: String(v.unidad ?? '').trim(),
      cantidad: cantidad ?? 0, costoUnitario: costo ?? 0, descuento, itbisPct: itbis ?? 18,
      tipoLinea: tipoLinea(v.tipo_linea), controlaInventario: siNo(v.control_inventario),
      precio: precio !== null && precio > 0 ? { modo: modoItbis(v.modo_itbis) || null, valor: precio } : null,
    });
  });

  const facturas = [...grupos.values()].map((g) => {
    if (!g.encabezado.fechaComprobante) g.avisos.push({ nivel: 'error', texto: 'Falta la fecha de la factura.' });
    delete g.filas;
    return g;
  });
  if (!facturas.length) throw Object.assign(new Error('No hay ninguna factura válida en el archivo.'), { statusCode: 400, errores });
  return { facturas, errores };
}

// Plantilla (primera fila: encabezados; segunda: ejemplo).
function plantillaFilas() {
  return [COLUMNAS_PLANTILLA, ['131000001', 'Distribuidora Ejemplo SRL', 'B01', 'B0100000123', 'FAC-123', '2026-11-09', 'contado', '',
    'P0001', '7501234567890', 'DE-55', 'Arroz 5 lb', 'Unidad', '10', '250.00', '0', '18', 'inventario', '330.00', 'incluido', 'si']];
}

module.exports = { leerTabla, numero, fecha, campoDeEncabezado, plantillaFilas, COLUMNAS_PLANTILLA, VERSION };

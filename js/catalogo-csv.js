/**
 * js/catalogo-csv.js — Importar y exportar el catálogo (productos o servicios)
 * en CSV, el mismo formato en el POS y en el Portal del Contador.
 *
 * Fuente única. La usan:
 *   - el POS: Catálogo de servicios de la Empresa de Servicios (js/servicios/servicios.js)
 *   - el portal del contador (copia por vendor-sync): pestaña Productos/Servicios de un negocio
 *   - las pruebas (require).
 *
 * Las columnas de productos son las del exportador del POS
 * (server/services/products-csv.service.js): un archivo exportado de un lado
 * se importa en el otro. Los encabezados se reconocen sin importar acentos,
 * mayúsculas ni el orden; el separador puede ser coma, punto y coma o tab.
 *
 *   TcCatalogoCsv.leerArchivo(file) → Promise<texto>   (UTF-8 o el ANSI de Excel)
 *   TcCatalogoCsv.leerServicios(texto) → { filas, errores }
 *   TcCatalogoCsv.leerProductos(texto) → { filas, errores }
 *   TcCatalogoCsv.aCsv(columnas, registros) → texto (con BOM para que Excel vea los acentos)
 *   fila.campos = las columnas que traía el archivo: al actualizar solo se cambian esas.
 *   fila.soloActualiza = servicio con código y sin nombre: no se puede crear, solo
 *   actualizar uno que ya exista con ese código.
 */
(function (global) {
  'use strict';

  var ACENTOS = new RegExp('[\\u0300-\\u036f]', 'g');

  function normal(clave) {
    return String(clave == null ? '' : clave).normalize('NFD').replace(ACENTOS, '').toLowerCase().replace(/[^a-z0-9%]+/g, '');
  }

  // Encabezado → campo. Productos: los mismos alias que el importador del POS.
  var ALIAS_PRODUCTOS = {
    codigo: 'codigo', cod: 'codigo', code: 'codigo', sku: 'codigo', codigodebarras: 'codigo', codigobarras: 'codigo',
    nombre: 'nombre', producto: 'nombre', nombreproducto: 'nombre', descripcion: 'nombre',
    sucursal: 'sucursal', branch: 'sucursal',
    marca: 'marca',
    categoria: 'categoria',
    unidad: 'unidad',
    costo: 'precioCompra', compra: 'precioCompra', preciocompra: 'precioCompra', preciodecompra: 'precioCompra', costodecompra: 'precioCompra',
    precio: 'precioVenta', venta: 'precioVenta', precioventa: 'precioVenta', preciodeventa: 'precioVenta',
    stock: 'stock', existencia: 'stock', inventario: 'stock',
    stockminimo: 'stockMin', stockmin: 'stockMin', minimo: 'stockMin',
    estado: 'activo', activo: 'activo',
    aplicaitbis: 'aplicaItbis', itbis: 'aplicaItbis',
    rastreastock: 'tracksStock', tracksstock: 'tracksStock', controlastock: 'tracksStock', controlarinventario: 'tracksStock',
  };

  var ALIAS_SERVICIOS = {
    codigo: 'codigo', cod: 'codigo', code: 'codigo', sku: 'codigo',
    nombre: 'nombre', servicio: 'nombre', nombreservicio: 'nombre', producto: 'nombre',
    descripcion: 'descripcion', detalle: 'descripcion', nota: 'descripcion',
    categoria: 'categoria',
    unidad: 'unidad',
    precio: 'precio', precioventa: 'precio', venta: 'precio', tarifa: 'precio', monto: 'precio',
    itbis: 'itbisPct', 'itbis%': 'itbisPct', itbispct: 'itbisPct', itbisporciento: 'itbisPct', tasaitbis: 'itbisPct',
    impuesto: 'itbisPct', aplicaitbis: 'itbisPct',
    duracion: 'duracionMin', duracionmin: 'duracionMin', minutos: 'duracionMin', duracionminutos: 'duracionMin',
    estado: 'activo', activo: 'activo',
  };

  // Columnas al exportar (los encabezados que el importador reconoce).
  var COLUMNAS_PRODUCTOS = [
    ['codigo', 'Código'], ['nombre', 'Nombre'], ['sucursal', 'Sucursal'], ['marca', 'Marca'], ['categoria', 'Categoría'],
    ['unidad', 'Unidad'], ['precioCompra', 'Costo'], ['precioVenta', 'Precio'], ['stock', 'Stock'], ['stockMin', 'Stock Mínimo'],
    ['estado', 'Estado'], ['aplicaItbis', 'Aplica ITBIS'], ['tracksStock', 'Rastrea Stock'],
  ];
  var COLUMNAS_SERVICIOS = [
    ['codigo', 'Código'], ['nombre', 'Nombre'], ['descripcion', 'Descripción'], ['categoria', 'Categoría'],
    ['unidad', 'Unidad'], ['precio', 'Precio'], ['itbisPct', 'ITBIS %'], ['duracionMin', 'Duración (min)'], ['estado', 'Estado'],
  ];

  // "RD$ 1,500.50", "1.500,50", "1,500", "15,50", "1500" → número. Vacío o
  // basura → null. Una sola coma seguida de 3 cifras es de miles (en RD el
  // decimal es el punto); con 1 o 2 cifras es el decimal.
  function numero(valor) {
    var texto = String(valor == null ? '' : valor).trim().replace(/^rd\$\s*/i, '').replace(/%$/, '').replace(/\s+/g, '');
    if (!texto) return null;
    var coma = texto.lastIndexOf(',');
    var punto = texto.lastIndexOf('.');
    if (coma > -1 && punto > -1) texto = coma > punto ? texto.replace(/\./g, '').replace(',', '.') : texto.replace(/,/g, '');
    else if (coma > -1) texto = /,\d{3}$/.test(texto) ? texto.replace(/,/g, '') : texto.replace(',', '.');
    var n = Number(texto);
    return Number.isFinite(n) ? n : null;
  }

  function siNo(valor) {
    var t = normal(valor);
    if (!t) return null;
    if (['1', 'si', 'yes', 'true', 'activo', 'activa', 'x'].indexOf(t) >= 0) return true;
    if (['0', 'no', 'false', 'inactivo', 'inactiva', 'exento', 'exenta'].indexOf(t) >= 0) return false;
    return null;
  }

  // ITBIS de un servicio: "18", "18%", "Sí" (= 18) o "No"/"Exento" (= 0).
  function itbisPct(valor) {
    var n = numero(valor);
    if (n !== null) return n;
    var b = siNo(valor);
    if (b === true) return 18;
    if (b === false) return 0;
    return null;
  }

  // Bytes del archivo → texto. Excel en Windows guarda el CSV en ANSI
  // (Windows-1252): si no es UTF-8 válido se lee así para no romper acentos.
  function decodificar(bytes) {
    if (typeof bytes === 'string') return bytes.replace(new RegExp('^\\ufeff'), '');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(new RegExp('^\\ufeff'), '');
    } catch (_) {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }

  function leerArchivo(file) {
    if (!/\.(csv|txt)$/i.test(String(file && file.name || ''))) {
      return Promise.reject(new Error((file && file.name ? file.name + ': ' : '') + 'usa un archivo CSV (Excel → Guardar como → CSV).'));
    }
    return file.arrayBuffer().then(function (datos) { return decodificar(new Uint8Array(datos)); });
  }

  // CSV → filas de celdas. El separador se mira en el encabezado.
  function filasDeCsv(texto) {
    var limpio = String(texto || '').replace(new RegExp('^\\ufeff'), '');
    var primera = (limpio.split(/\r?\n/).filter(function (l) { return l.trim(); })[0]) || '';
    var separador = [',', ';', '\t', '|'].reduce(function (mejor, s) {
      return primera.split(s).length > primera.split(mejor).length ? s : mejor;
    }, ',');
    var filas = [];
    var fila = [];
    var celda = '';
    var comillas = false;
    for (var i = 0; i < limpio.length; i += 1) {
      var ch = limpio[i];
      if (comillas) {
        if (ch === '"' && limpio[i + 1] === '"') { celda += '"'; i += 1; } else if (ch === '"') { comillas = false; } else { celda += ch; }
      } else if (ch === '"') {
        comillas = true;
      } else if (ch === separador) {
        fila.push(celda); celda = '';
      } else if (ch === '\n') {
        fila.push(celda); filas.push(fila); fila = []; celda = '';
      } else if (ch !== '\r') {
        celda += ch;
      }
    }
    fila.push(celda);
    filas.push(fila);
    return filas.filter(function (f) { return f.some(function (c) { return String(c).trim() !== ''; }); });
  }

  // Filas → objetos por encabezado. Cada uno sabe qué columnas traía (campos).
  function registros(texto, alias) {
    var filas = filasDeCsv(texto);
    if (filas.length < 2) throw new Error('El archivo no trae filas debajo del encabezado.');
    var columnas = filas[0].map(function (h) { return alias[normal(h)] || ''; });
    if (columnas.indexOf('nombre') < 0 && columnas.indexOf('codigo') < 0) {
      throw new Error('No encontré las columnas Código o Nombre en el encabezado.');
    }
    return filas.slice(1).map(function (celdas, i) {
      var r = { fila: i + 2, campos: [] };
      columnas.forEach(function (campo, j) {
        if (!campo || r.campos.indexOf(campo) >= 0) return;
        r[campo] = String(celdas[j] == null ? '' : celdas[j]).trim();
        r.campos.push(campo);
      });
      return r;
    });
  }

  function texto(valor) { return String(valor == null ? '' : valor).trim(); }

  // Repetidos dentro del mismo archivo (mismo código, o mismo nombre sin código).
  function marcarRepetidos(filas, errores) {
    var vistos = {};
    return filas.filter(function (f) {
      var clave = f.codigo ? 'c:' + f.codigo.toLowerCase() : 'n:' + f.nombre.toLowerCase();
      if (vistos[clave]) {
        errores.push({ fila: f.fila, mensaje: 'Repite ' + (f.codigo ? 'el código ' + f.codigo : '"' + f.nombre + '"') + ' de la fila ' + vistos[clave] + '.' });
        return false;
      }
      vistos[clave] = f.fila;
      return true;
    });
  }

  function leerServicios(contenido) {
    var errores = [];
    var filas = [];
    registros(contenido, ALIAS_SERVICIOS).forEach(function (r) {
      var f = { fila: r.fila, campos: r.campos, codigo: texto(r.codigo), nombre: texto(r.nombre) };
      if (!f.nombre && !f.codigo) return; // fila vacía
      // Con código y sin nombre solo puede actualizar uno que ya exista.
      if (!f.nombre) f.soloActualiza = true;
      if (r.campos.indexOf('descripcion') >= 0) f.descripcion = texto(r.descripcion);
      if (r.campos.indexOf('categoria') >= 0) f.categoria = texto(r.categoria);
      if (r.campos.indexOf('unidad') >= 0) f.unidad = texto(r.unidad) || 'servicio';
      if (r.campos.indexOf('precio') >= 0) {
        f.precio = numero(r.precio);
        if (f.precio === null || f.precio < 0) { errores.push({ fila: r.fila, mensaje: 'El precio "' + r.precio + '" no es un número válido.' }); return; }
      }
      if (r.campos.indexOf('itbisPct') >= 0) {
        f.itbisPct = itbisPct(r.itbisPct);
        if (f.itbisPct === null || f.itbisPct < 0 || f.itbisPct > 100) { errores.push({ fila: r.fila, mensaje: 'El ITBIS "' + r.itbisPct + '" no es válido (usa 0, 16 o 18).' }); return; }
      }
      if (r.campos.indexOf('duracionMin') >= 0) f.duracionMin = numero(r.duracionMin);
      if (r.campos.indexOf('activo') >= 0) f.activo = siNo(r.activo) !== false;
      filas.push(f);
    });
    return { filas: marcarRepetidos(filas, errores), errores: errores };
  }

  function leerProductos(contenido) {
    var errores = [];
    var filas = [];
    registros(contenido, ALIAS_PRODUCTOS).forEach(function (r) {
      var f = { fila: r.fila, campos: r.campos, codigo: texto(r.codigo), nombre: texto(r.nombre) };
      if (!f.nombre && !f.codigo) return;
      if (!f.codigo) { errores.push({ fila: r.fila, mensaje: 'Falta el código del producto.' }); return; }
      if (!f.nombre) { errores.push({ fila: r.fila, mensaje: 'Falta el nombre del producto.' }); return; }
      ['sucursal', 'marca', 'categoria', 'unidad'].forEach(function (c) { if (r.campos.indexOf(c) >= 0) f[c] = texto(r[c]); });
      var malo = ['precioCompra', 'precioVenta', 'stock', 'stockMin'].filter(function (c) {
        if (r.campos.indexOf(c) < 0 || texto(r[c]) === '') return false;
        f[c] = numero(r[c]);
        return f[c] === null || f[c] < 0;
      })[0];
      if (malo) { errores.push({ fila: r.fila, mensaje: 'El valor "' + r[malo] + '" no es un número válido.' }); return; }
      if (r.campos.indexOf('aplicaItbis') >= 0) f.aplicaItbis = siNo(r.aplicaItbis) === true || (numero(r.aplicaItbis) || 0) > 0;
      if (r.campos.indexOf('tracksStock') >= 0) f.tracksStock = siNo(r.tracksStock) !== false;
      if (r.campos.indexOf('activo') >= 0) f.activo = siNo(r.activo) !== false;
      filas.push(f);
    });
    return { filas: marcarRepetidos(filas, errores), errores: errores };
  }

  function celdaCsv(valor) {
    var t = valor == null ? '' : String(valor);
    return /[",;\n\r]/.test(t) || t.trim() !== t ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  // columnas: [[campo, encabezado], …]; registros: objetos con esos campos.
  function aCsv(columnas, registrosDatos) {
    var lineas = [columnas.map(function (c) { return celdaCsv(c[1]); }).join(',')];
    (registrosDatos || []).forEach(function (r) {
      lineas.push(columnas.map(function (c) { return celdaCsv(r[c[0]]); }).join(','));
    });
    return '﻿' + lineas.join('\r\n') + '\r\n';
  }

  var api = {
    COLUMNAS_PRODUCTOS: COLUMNAS_PRODUCTOS,
    COLUMNAS_SERVICIOS: COLUMNAS_SERVICIOS,
    numero: numero,
    decodificar: decodificar,
    leerArchivo: leerArchivo,
    filasDeCsv: filasDeCsv,
    leerServicios: leerServicios,
    leerProductos: leerProductos,
    aCsv: aCsv,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.TcCatalogoCsv = api;
})(typeof window !== 'undefined' ? window : globalThis);

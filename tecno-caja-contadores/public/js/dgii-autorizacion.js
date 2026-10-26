/**
 * js/dgii-autorizacion.js — Lee la autorización de secuencias que da la DGII
 * (Oficina Virtual → Consultas → Solicitudes de Comprobantes) en XML, Excel o
 * CSV y devuelve los rangos: tipo, desde, hasta, Nº y fecha de autorización.
 *
 * Fuente única. La usan:
 *   - el POS: Configuración → Secuencias de Comprobantes Electrónicos (js/ecf-sequences-config.js)
 *   - el panel de sucursales (js/sucursales-central-ui.js): tecno-caja-admin
 *     la sirve desde aquí y el portal del contador la copia por vendor-sync.
 *   - las pruebas (require).
 *
 *   TcDgiiAutorizacion.leerArchivo(file) → Promise<[rango]>
 *   TcDgiiAutorizacion.leerArchivos(files) → Promise<{ rangos, errores }> (varios a la vez)
 *   rango = { tipo: 'E32', desde: 1, hasta: 100, referencia: '6005604697',
 *             fechaAutorizacion: '2026-10-25', estatus: 'APROBADA', comprobante: '…' }
 */
(function (global) {
  'use strict';

  // Respuesta SolicitudNCF: un bloque Solicitud_<n> por tipo.
  function leerXml(texto) {
    var bloques = String(texto || '').split(/<Solicitud_\d+/i).slice(1);
    function etiqueta(bloque, nombre) {
      var m = bloque.match(new RegExp('<' + nombre + '>([^<]*)</' + nombre + '>', 'i'));
      return m ? m[1].trim() : '';
    }
    return bloques.map(function (bloque) {
      var desde = etiqueta(bloque, 'NUMERO_DESDE').toUpperCase();
      var hasta = etiqueta(bloque, 'NUMERO_HASTA').toUpperCase();
      return {
        tipo: desde.slice(0, 3),
        desde: Number(desde.slice(3)) || 0,
        hasta: Number(hasta.slice(3)) || 0,
        referencia: etiqueta(bloque, 'NUM_AUTOR'),
        fechaAutorizacion: etiqueta(bloque, 'FECHA_AUTOR').slice(0, 10),
        estatus: etiqueta(bloque, 'ESTATUS').toUpperCase(),
        comprobante: etiqueta(bloque, 'COMP'),
      };
    }).filter(function (r) { return r.tipo && r.desde && r.hasta; });
  }

  // "AAAA-MM-DD" con la fecha local (nunca toISOString: de noche da el día siguiente).
  function normalizarFecha(valor) {
    if (!valor) return '';
    if (valor instanceof Date) {
      if (isNaN(valor.getTime())) return '';
      return valor.getFullYear() + '-' + String(valor.getMonth() + 1).padStart(2, '0') + '-' + String(valor.getDate()).padStart(2, '0');
    }
    var texto = String(valor).trim();
    var m = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // dd/mm/aaaa, como lo muestra la DGII
    if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    return '';
  }

  var ACENTOS = new RegExp('[\\u0300-\\u036f]', 'g');

  // Filas del Excel o CSV. Las columnas se buscan por nombre (NUMERO_DESDE /
  // "Número Desde", NUM_AUTOR / "No. Autorización", FECHA_AUTOR, ESTATUS…),
  // sin importar acentos ni el orden.
  function leerFilas(filas) {
    function normal(clave) { return String(clave).normalize('NFD').replace(ACENTOS, '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
    function numero(valor) { return Number(String(valor || '').toUpperCase().replace(/^[A-Z]\d{2}/, '').replace(/\D/g, '')) || 0; }
    function texto(valor) { return String(valor == null ? '' : valor).trim(); }
    return (filas || []).map(function (fila) {
      var pares = Object.keys(fila || {}).map(function (k) { return [normal(k), fila[k]]; });
      function campo(prueba) {
        var par = pares.filter(function (p) { return prueba(p[0]); })[0];
        return par ? par[1] : '';
      }
      var desde = texto(campo(function (k) { return k.indexOf('DESDE') >= 0; })).toUpperCase();
      var hasta = texto(campo(function (k) { return k.indexOf('HASTA') >= 0; })).toUpperCase();
      var codTipo = texto(campo(function (k) { return k === 'CODTIPO'; }));
      var tipo = /^[A-Z]\d{2}/.test(desde) ? desde.slice(0, 3) : (codTipo ? 'E' + codTipo.padStart(2, '0') : '');
      return {
        tipo: tipo,
        desde: numero(desde),
        hasta: numero(hasta),
        referencia: texto(campo(function (k) { return k.indexOf('AUTOR') >= 0 && k.indexOf('FECHA') < 0; })),
        fechaAutorizacion: normalizarFecha(campo(function (k) { return k.indexOf('FECHA') >= 0 && k.indexOf('AUTOR') >= 0; })),
        estatus: texto(campo(function (k) { return k.indexOf('ESTATUS') >= 0 || k === 'ESTADO'; })).toUpperCase(),
        comprobante: texto(campo(function (k) { return k === 'COMP' || k.indexOf('COMPROBANTE') >= 0; })),
      };
    }).filter(function (r) { return r.tipo && r.desde && r.hasta; });
  }

  // Tabla (filas de celdas) → objetos por encabezado. El encabezado es la
  // primera fila que trae DESDE y HASTA (puede haber un título arriba). Si el
  // archivo viene en vertical (campo | valor), se arma un solo rango.
  function filasDeTabla(matriz) {
    function vacia(celda) { return String(celda == null ? '' : celda).trim() === ''; }
    var filas = (matriz || []).filter(function (f) { return (f || []).some(function (c) { return !vacia(c); }); });
    var inicio = -1;
    for (var i = 0; i < filas.length && inicio < 0; i += 1) {
      if (filas[i].filter(function (c) { return /DESDE|HASTA/i.test(String(c == null ? '' : c)); }).length >= 2) inicio = i;
    }
    if (inicio >= 0) {
      var encabezado = filas[inicio];
      return filas.slice(inicio + 1).map(function (f) {
        var obj = {};
        encabezado.forEach(function (nombre, j) { obj[nombre] = f[j] == null ? '' : f[j]; });
        return obj;
      });
    }
    var pares = filas.filter(function (f) { return f.length >= 2 && !vacia(f[0]); });
    if (!pares.some(function (f) { return /DESDE/i.test(String(f[0])); })) return [];
    var unico = {};
    pares.forEach(function (f) { unico[f[0]] = f[1]; });
    return [unico];
  }

  // CSV simple (coma o punto y coma, comillas dobles) → filas de celdas. El
  // separador se mira en la fila de encabezado (puede haber un título arriba).
  function leerCsv(texto) {
    var lineas = String(texto || '').replace(new RegExp('^\\ufeff'), '').split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (!lineas.length) return [];
    var encabezado = lineas.filter(function (l) { return /DESDE/i.test(l); })[0] || lineas[0];
    var separador = (encabezado.match(/;/g) || []).length > (encabezado.match(/,/g) || []).length ? ';' : ',';
    return lineas.map(function (linea) {
      var celdas = [];
      var celda = '';
      var entreComillas = false;
      for (var i = 0; i < linea.length; i += 1) {
        var ch = linea[i];
        if (ch === '"' && entreComillas && linea[i + 1] === '"') { celda += '"'; i += 1; } else if (ch === '"') { entreComillas = !entreComillas; } else if (ch === separador && !entreComillas) { celdas.push(celda); celda = ''; } else { celda += ch; }
      }
      celdas.push(celda);
      return celdas.map(function (v) { return v.trim(); });
    });
  }

  // Excel: SheetJS ya cargado (window.XLSX) o con el cargador del POS.
  function cargarExcel() {
    if (global.XLSX) return Promise.resolve(global.XLSX);
    if (global.VendorLoader) return global.VendorLoader.load('xlsx').then(function () { return global.XLSX; });
    return Promise.reject(new Error('Aquí no se puede leer Excel: sube el XML de la DGII.'));
  }

  function leerArchivo(file) {
    var nombre = String(file && file.name || '');
    if (/\.xml$/i.test(nombre)) return file.text().then(leerXml);
    if (/\.csv$/i.test(nombre)) return file.text().then(function (t) { return leerFilas(filasDeTabla(leerCsv(t))); });
    return cargarExcel().then(function (XLSX) {
      return file.arrayBuffer().then(function (datos) {
        var libro = XLSX.read(datos, { type: 'array', cellDates: true });
        var hoja = libro.Sheets[libro.SheetNames[0]];
        return leerFilas(filasDeTabla(XLSX.utils.sheet_to_json(hoja, { header: 1, defval: '', raw: true })));
      });
    });
  }

  // Varios archivos a la vez (la DGII da uno por solicitud). Uno que no se
  // puede leer no frena a los demás. Un rango repetido en dos archivos (mismo
  // tipo, desde y hasta) se cuenta una vez, quedándose con el aprobado.
  //   → Promise<{ rangos: [rango + { archivo }], errores: [{ archivo, mensaje }] }>
  function leerArchivos(files) {
    var lista = Array.prototype.slice.call(files || []);
    return Promise.all(lista.map(function (file) {
      return leerArchivo(file).then(
        function (rangos) { return { file: file, rangos: rangos }; },
        function (e) { return { file: file, error: e }; }
      );
    })).then(function (leidos) {
      var posicion = {};
      var rangos = [];
      var errores = [];
      leidos.forEach(function (l) {
        var nombre = String(l.file && l.file.name || '');
        if (l.error) { errores.push({ archivo: nombre, mensaje: l.error.message || String(l.error) }); return; }
        if (!l.rangos.length) { errores.push({ archivo: nombre, mensaje: 'No trae rangos de la DGII.' }); return; }
        l.rangos.forEach(function (r) {
          var clave = r.tipo + ':' + r.desde + ':' + r.hasta;
          var rango = Object.assign({}, r, { archivo: nombre });
          if (posicion[clave] === undefined) { posicion[clave] = rangos.push(rango) - 1; return; }
          var antes = rangos[posicion[clave]];
          if (antes.estatus && antes.estatus !== 'APROBADA' && (!r.estatus || r.estatus === 'APROBADA')) rangos[posicion[clave]] = rango;
        });
      });
      return { rangos: rangos, errores: errores };
    });
  }

  // Lo que se puede registrar: aprobado (o sin estatus, si el archivo no lo trae).
  function aprobados(rangos, serie) {
    return (rangos || []).filter(function (r) {
      return (!serie || r.tipo.charAt(0) === serie) && (!r.estatus || r.estatus === 'APROBADA');
    });
  }

  var api = {
    leerXml: leerXml,
    leerFilas: leerFilas,
    filasDeTabla: filasDeTabla,
    leerCsv: leerCsv,
    normalizarFecha: normalizarFecha,
    leerArchivo: leerArchivo,
    leerArchivos: leerArchivos,
    aprobados: aprobados,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.TcDgiiAutorizacion = api;
})(typeof window !== 'undefined' ? window : globalThis);

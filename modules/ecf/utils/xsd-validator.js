'use strict';

// Valida un XML contra el XSD oficial de la DGII de su tipo, sin programas
// externos (la app corre empaquetada y PowerShell no lee dentro del .asar).
//
// Cubre lo que usan los XSD de e-CF de la DGII (modules/ecf/schemas): elementos
// con xs:sequence (sin choice ni atributos), xs:any al final para la firma y
// tipos simples por restricción de xs:string / xs:decimal / xs:integer con
// enumeration, pattern, length, min/maxLength, totalDigits, fractionDigits y
// min/max Inclusive/Exclusive. Si un XSD trae algo fuera de eso, lo dice en vez
// de dar por bueno el XML.
//
// Los patrones se evalúan como lo hace el validador de .NET (el de la DGII y el
// de scripts/ecf/validar-xsd.ps1): ^ y $ funcionan como anclas y (?: …) se
// acepta. \d, \w y \s siguen sus significados Unicode.

const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

const XS = 'http://www.w3.org/2001/XMLSchema';
const SCHEMAS_DIR = path.resolve(__dirname, '..', 'schemas');
const ARCHIVOS = {
  E31: 'e-CF 31 v.1.0.xsd', E32: 'e-CF 32 v.1.0.xsd', E33: 'e-CF 33 v.1.0.xsd', E34: 'e-CF 34 v.1.0.xsd',
  E41: 'e-CF 41 v.1.0.xsd', E43: 'e-CF 43 v.1.0.xsd', E44: 'e-CF 44 v.1.0.xsd', E45: 'e-CF 45 v.1.0.xsd',
  E46: 'e-CF 46 v.1.0.xsd', E47: 'e-CF 47 v.1.0.xsd',
};
const FACETAS = new Set(['enumeration', 'pattern', 'length', 'minLength', 'maxLength', 'totalDigits', 'fractionDigits',
  'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive', 'whiteSpace']);

const hijos = (nodo) => Array.from(nodo?.childNodes || []).filter((n) => n.nodeType === 1);
const nombreLocal = (nodo) => String(nodo?.localName || nodo?.nodeName || '').replace(/^.*:/, '');
const esXs = (nodo, nombre) => nodo && nodo.namespaceURI === XS && nombreLocal(nodo) === nombre;
const BOM = String.fromCharCode(0xfeff);
const sinBom = (texto) => { const s = String(texto || ''); return s.startsWith(BOM) ? s.slice(1) : s; };

function ocurrencias(nodo) {
  const min = nodo.getAttribute('minOccurs');
  const max = nodo.getAttribute('maxOccurs');
  return {
    min: min === '' || min === null ? 1 : Number(min),
    max: max === 'unbounded' ? Infinity : (max === '' || max === null ? 1 : Number(max)),
  };
}

// ── Patrones: del dialecto XSD/.NET a una RegExp de JavaScript con «u» ──────
const CLASE = { d: '\\p{Nd}', w: '\\p{L}\\p{M}\\p{N}\\p{S}', s: ' \\t\\n\\r' };
const SINTAXIS = new Set(['^', '$', '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/']);

function traducirPatron(patron) {
  let salida = '';
  let enClase = false;
  for (let i = 0; i < patron.length; i += 1) {
    const c = patron[i];
    if (c === '\\' && i + 1 < patron.length) {
      const e = patron[i + 1];
      i += 1;
      if (e === 'd' || e === 'w' || e === 's') {
        salida += enClase ? CLASE[e] : `[${CLASE[e]}]`;
      } else if (e === 'D' || e === 'W' || e === 'S') {
        const base = CLASE[e.toLowerCase()];
        if (enClase) throw new Error(`Patrón con \\${e} dentro de una clase: ${patron}`);
        salida += `[^${base}]`;
      } else if (e === 'p' || e === 'P') {
        const fin = patron.indexOf('}', i);
        salida += `\\${e}${patron.slice(i + 1, fin + 1)}`;
        i = fin;
      } else if (e === 'n' || e === 'r' || e === 't') {
        salida += `\\${e}`;
      } else if (e === 'i' || e === 'c' || e === 'I' || e === 'C') {
        throw new Error(`Patrón con \\${e} (no soportado): ${patron}`);
      } else if (e === '-') {
        salida += enClase ? '\\-' : '-';
      } else if (SINTAXIS.has(e)) {
        salida += `\\${e}`;
      } else {
        salida += e;
      }
      continue;
    }
    if (enClase) {
      if (c === ']') enClase = false;
      salida += c;
      continue;
    }
    if (c === '[') {
      enClase = true;
      salida += c;
      if (patron[i + 1] === '^') { salida += '^'; i += 1; }
      if (patron[i + 1] === ']') { salida += '\\]'; i += 1; }
      continue;
    }
    // XSD: «.» es cualquier carácter salvo fin de línea.
    salida += c === '.' ? '[^\\n\\r]' : c;
  }
  return new RegExp(`^(?:${salida})$`, 'u');
}

// ── Lectura del XSD ─────────────────────────────────────────────────────────
function leerTipoSimple(nodo, tiposConNombre) {
  const restriccion = hijos(nodo).find((h) => esXs(h, 'restriction'));
  if (!restriccion) throw new Error(`Tipo simple sin restricción (${nodo.getAttribute('name') || 'anónimo'}).`);
  const base = restriccion.getAttribute('base');
  const tipo = { base, facetas: { enumeration: [], pattern: [] } };
  for (const f of hijos(restriccion)) {
    const nombre = nombreLocal(f);
    if (!FACETAS.has(nombre)) throw new Error(`Faceta no soportada: ${nombre}.`);
    const valor = f.getAttribute('value');
    if (nombre === 'enumeration') tipo.facetas.enumeration.push(valor);
    else if (nombre === 'pattern') tipo.facetas.pattern.push({ fuente: valor, re: traducirPatron(valor) });
    else tipo.facetas[nombre] = valor;
  }
  if (!/^xs:(string|decimal|integer)$/.test(base) && !tiposConNombre.has(base)) {
    throw new Error(`Tipo base no soportado: ${base}.`);
  }
  return tipo;
}

function leerElemento(nodo, ctx) {
  const decl = { nombre: nodo.getAttribute('name'), ...ocurrencias(nodo) };
  const tipo = nodo.getAttribute('type');
  if (tipo) {
    decl.tipo = tipo;
    return decl;
  }
  const complejo = hijos(nodo).find((h) => esXs(h, 'complexType'));
  const simple = hijos(nodo).find((h) => esXs(h, 'simpleType'));
  if (complejo) decl.contenido = leerComplejo(complejo, ctx);
  else if (simple) decl.simple = leerTipoSimple(simple, ctx.tiposConNombre);
  else decl.tipo = 'xs:string';
  return decl;
}

function leerComplejo(nodo, ctx) {
  const partes = hijos(nodo);
  const otros = partes.filter((h) => !esXs(h, 'sequence') && !esXs(h, 'annotation'));
  if (otros.length) throw new Error(`Tipo complejo con ${nombreLocal(otros[0])} (no soportado).`);
  const secuencia = partes.find((h) => esXs(h, 'sequence'));
  if (!secuencia) return [];
  return hijos(secuencia).map((p) => {
    if (esXs(p, 'element')) return leerElemento(p, ctx);
    if (esXs(p, 'any')) return { any: true, ...ocurrencias(p) };
    if (esXs(p, 'annotation')) return null;
    throw new Error(`Secuencia con ${nombreLocal(p)} (no soportado).`);
  }).filter(Boolean);
}

function leerEsquema(texto) {
  const doc = new DOMParser().parseFromString(sinBom(texto), 'application/xml');
  const raiz = doc.documentElement;
  if (!esXs(raiz, 'schema')) throw new Error('El archivo no es un XSD.');
  const tiposConNombre = new Map();
  const nodos = hijos(raiz);
  for (const n of nodos) {
    if (esXs(n, 'simpleType')) tiposConNombre.set(n.getAttribute('name'), null);
  }
  for (const n of nodos) {
    if (esXs(n, 'simpleType')) tiposConNombre.set(n.getAttribute('name'), leerTipoSimple(n, tiposConNombre));
    else if (esXs(n, 'complexType')) throw new Error('Tipos complejos con nombre: no soportados.');
  }
  const ctx = { tiposConNombre };
  const raices = nodos.filter((n) => esXs(n, 'element')).map((n) => leerElemento(n, ctx));
  return { raices, tiposConNombre };
}

const cache = new Map();
function esquemaDe(tipoOArchivo) {
  const archivo = ARCHIVOS[String(tipoOArchivo || '').toUpperCase()] || tipoOArchivo;
  if (!cache.has(archivo)) {
    const ruta = path.isAbsolute(archivo) ? archivo : path.join(SCHEMAS_DIR, archivo);
    cache.set(archivo, leerEsquema(fs.readFileSync(ruta, 'utf8')));
  }
  return cache.get(archivo);
}

// ── Validación de valores ───────────────────────────────────────────────────
function digitosDecimal(valor) {
  const [entero, fraccion = ''] = valor.replace(/^[+-]/, '').split('.');
  const ent = entero.replace(/^0+/, '');
  const fra = fraccion.replace(/0+$/, '');
  return { total: (ent + fra).replace(/^0+/, '').length || 1, fraccion: fra.length };
}

function validarValor(tipoRef, valorCrudo, esquema, ruta, errores) {
  const tipo = typeof tipoRef === 'string' ? null : tipoRef;
  let base = tipo ? tipo.base : tipoRef;
  const cadena = [];
  if (tipo) cadena.push(tipo);
  while (base && !/^xs:/.test(base)) {
    const sig = esquema.tiposConNombre.get(base);
    if (!sig) { errores.push(`${ruta}: tipo desconocido ${base}.`); return; }
    cadena.push(sig);
    base = sig.base;
  }
  const esTexto = base === 'xs:string';
  const valor = esTexto ? valorCrudo : String(valorCrudo).replace(/[\t\n\r ]+/g, ' ').trim();
  const mal = (motivo) => errores.push(`${ruta}: «${String(valorCrudo).slice(0, 60)}» ${motivo}.`);

  if (base === 'xs:decimal' && !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(valor)) return mal('no es un número decimal');
  if (base === 'xs:integer' && !/^[+-]?\d+$/.test(valor)) return mal('no es un número entero');
  if (base === 'xs:dateTime' && !/^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(valor)) return mal('no es fecha y hora');

  // Cada nivel de la cadena de restricciones se cumple por separado (como en XSD).
  for (const t of cadena) {
    const f = t.facetas;
    if (f.enumeration.length && !f.enumeration.includes(valor)) {
      return mal(`no es un valor permitido (${f.enumeration.slice(0, 8).join(', ')}${f.enumeration.length > 8 ? '…' : ''})`);
    }
    if (f.pattern.length && !f.pattern.some((p) => p.re.test(valor))) return mal(`no cumple el formato ${f.pattern[0].fuente}`);
    const largo = Array.from(valor).length;
    if (f.length !== undefined && largo !== Number(f.length)) return mal(`debe tener ${f.length} caracteres`);
    if (f.minLength !== undefined && largo < Number(f.minLength)) return mal(`debe tener al menos ${f.minLength} caracteres`);
    if (f.maxLength !== undefined && largo > Number(f.maxLength)) return mal(`pasa de ${f.maxLength} caracteres`);
    if (base === 'xs:decimal' || base === 'xs:integer') {
      const d = digitosDecimal(valor);
      if (f.totalDigits !== undefined && d.total > Number(f.totalDigits)) return mal(`pasa de ${f.totalDigits} dígitos`);
      if (f.fractionDigits !== undefined && d.fraccion > Number(f.fractionDigits)) return mal(`pasa de ${f.fractionDigits} decimales`);
      const num = Number(valor);
      if (f.minInclusive !== undefined && !(num >= Number(f.minInclusive))) return mal(`es menor que ${f.minInclusive}`);
      if (f.maxInclusive !== undefined && !(num <= Number(f.maxInclusive))) return mal(`es mayor que ${f.maxInclusive}`);
      if (f.minExclusive !== undefined && !(num > Number(f.minExclusive))) return mal(`debe ser mayor que ${f.minExclusive}`);
      if (f.maxExclusive !== undefined && !(num < Number(f.maxExclusive))) return mal(`debe ser menor que ${f.maxExclusive}`);
    }
  }
}

// ── Validación de la estructura ─────────────────────────────────────────────
function validarElemento(decl, nodo, esquema, ruta, errores, opciones) {
  const elementos = hijos(nodo);
  if (decl.contenido) {
    const texto = Array.from(nodo.childNodes || []).filter((n) => n.nodeType === 3 || n.nodeType === 4)
      .map((n) => n.nodeValue).join('').trim();
    if (texto) errores.push(`${ruta}: no debe llevar texto («${texto.slice(0, 40)}»).`);
    validarSecuencia(decl.contenido, elementos, esquema, ruta, errores, opciones);
    return;
  }
  if (elementos.length) {
    errores.push(`${ruta}: no debe llevar elementos dentro (${nombreLocal(elementos[0])}).`);
    return;
  }
  validarValor(decl.simple || decl.tipo, nodo.textContent || '', esquema, ruta, errores);
}

function validarSecuencia(particulas, elementos, esquema, ruta, errores, opciones) {
  let i = 0;
  for (const p of particulas) {
    let cuenta = 0;
    if (p.any) {
      while (i < elementos.length && cuenta < p.max) { i += 1; cuenta += 1; }
      if (cuenta < p.min && !opciones.sinFirma) errores.push(`${ruta}: falta la firma digital (Signature).`);
      continue;
    }
    while (i < elementos.length && cuenta < p.max && nombreLocal(elementos[i]) === p.nombre && !elementos[i].namespaceURI) {
      validarElemento(p, elementos[i], esquema, `${ruta}/${p.nombre}${p.max > 1 ? `[${cuenta + 1}]` : ''}`, errores, opciones);
      i += 1; cuenta += 1;
    }
    if (cuenta < p.min) errores.push(`${ruta}: falta ${p.nombre}${p.min > 1 ? ` (mínimo ${p.min})` : ''}.`);
  }
  if (i < elementos.length) {
    const sobra = elementos[i];
    const repetido = particulas.some((p) => p.nombre === nombreLocal(sobra));
    errores.push(`${ruta}: ${nombreLocal(sobra)} ${repetido ? 'fuera de orden o repetido de más' : 'no está permitido aquí'}.`);
  }
}

/**
 * Valida el XML contra el XSD del tipo de e-CF.
 * @param {string} xml
 * @param {object} [opciones] { tipo: 'E41' (si no, se lee de TipoeCF), sinFirma: true si aún no se firmó }
 * @returns {{ ok: boolean, tipo: string|null, errores: string[] }}
 */
function validarEcfXsd(xml, opciones = {}) {
  const errores = [];
  let doc;
  try {
    const fallos = [];
    doc = new DOMParser({ onError: (nivel, msg) => { if (nivel !== 'warning') fallos.push(String(msg)); } })
      .parseFromString(sinBom(xml).trim(), 'application/xml');
    if (fallos.length || !doc?.documentElement) return { ok: false, tipo: null, errores: [`El XML no se puede leer: ${fallos[0] || 'vacío'}`] };
  } catch (e) {
    return { ok: false, tipo: null, errores: [`El XML no se puede leer: ${e.message}`] };
  }
  const raiz = doc.documentElement;
  const tipoXml = (() => {
    const nodo = raiz.getElementsByTagName('TipoeCF')[0];
    return nodo ? `E${String(nodo.textContent || '').trim()}` : null;
  })();
  const tipo = String(opciones.tipo || tipoXml || '').toUpperCase();
  if (!ARCHIVOS[tipo]) return { ok: false, tipo: tipo || null, errores: [`No hay XSD para el tipo ${tipo || '(sin TipoeCF)'}.`] };
  if (opciones.tipo && tipoXml && tipoXml !== tipo) errores.push(`El XML dice ${tipoXml} y se esperaba ${tipo}.`);

  const esquema = esquemaDe(tipo);
  const decl = esquema.raices.find((r) => r.nombre === nombreLocal(raiz));
  if (!decl) return { ok: false, tipo, errores: [`La raíz <${nombreLocal(raiz)}> no es la del XSD (${esquema.raices.map((r) => r.nombre).join(', ')}).`] };
  validarElemento(decl, raiz, esquema, `/${decl.nombre}`, errores, { sinFirma: opciones.sinFirma === true });
  return { ok: errores.length === 0, tipo, errores };
}

module.exports = { validarEcfXsd, traducirPatron, esquemaDe, ARCHIVOS };

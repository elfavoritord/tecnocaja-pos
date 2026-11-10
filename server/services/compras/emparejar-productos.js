'use strict';
// Reconoce los productos de una factura de proveedor contra el catálogo.
// Orden: código de barras → código interno → equivalencia guardada con ese
// proveedor → nombre idéntico (normalizado). Lo demás solo son SUGERENCIAS que
// el usuario confirma: dos nombres parecidos nunca se unen solos (p. ej.
// «Coca Cola 2L» y «Coca Cola 1L» son productos distintos).

const UNIDADES = [
  [/\b(litros?|lts?|l)\b/g, 'l'], [/\b(mililitros?|ml)\b/g, 'ml'], [/\b(kilogramos?|kilos?|kgs?|kg)\b/g, 'kg'],
  [/\b(gramos?|grs?|g)\b/g, 'g'], [/\b(libras?|lbs?|lb)\b/g, 'lb'], [/\b(onzas?|oz)\b/g, 'oz'],
  [/\b(unidades?|unds?|und|uds?|u)\b/g, 'und'], [/\b(paquetes?|paq|pqt)\b/g, 'paq'], [/\b(cajas?|cja|cj)\b/g, 'caja'],
];

// "Coca-Cola 2 Lts." → "coca cola 2 l"
function normalizarTexto(texto) {
  let t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/(\d)[,.](\d)/g, '$1.$2').replace(/[^a-z0-9.]+/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
  t = t.replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2');
  for (const [re, unidad] of UNIDADES) t = t.replace(re, unidad);
  return t.replace(/\s+/g, ' ').trim();
}
const palabras = (t) => normalizarTexto(t).split(' ').filter(Boolean);
// Cantidades y medidas de la descripción ("2 l", "500 g", "x12"): si difieren, no es el mismo producto.
const numeros = (t) => palabras(t).filter((p) => /^\d+(\.\d+)?$/.test(p)).map((p) => String(Number(p))).sort().join('|');

function codigoBarrasValido(codigo) {
  const d = String(codigo || '').trim();
  if (!/^\d{8}$|^\d{12,14}$/.test(d)) return false;
  const digitos = d.split('').map(Number);
  const control = digitos.pop();
  const suma = digitos.reverse().reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (suma % 10)) % 10 === control;
}

function similitud(a, b) {
  const x = new Set(palabras(a)), y = new Set(palabras(b));
  if (!x.size || !y.size) return 0;
  let comunes = 0;
  for (const p of x) if (y.has(p)) comunes += 1;
  return comunes / (x.size + y.size - comunes);
}

const activo = (p) => !['eliminado'].includes(String(p.estado || '').toLowerCase());

// productos: [{ id, codigo, barcode, nombre, unidad, estado }]
// equivalencias: [{ product_id, codigo_proveedor, descripcion_normalizada }] de ESTE proveedor
// linea: { codigo, codigoBarras, codigoProveedor, descripcion, unidad }
// → { productoId, metodo, sugerencias: [{ id, nombre, codigo, puntaje, motivo }] }
function emparejarLinea(linea, { productos = [], equivalencias = [] } = {}) {
  const lista = productos.filter(activo);
  const igual = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() && String(a || '').trim() !== '';
  const barras = String(linea.codigoBarras || '').trim();
  if (barras) {
    const p = lista.find((x) => igual(x.barcode, barras) || igual(x.codigo, barras));
    if (p) return { productoId: Number(p.id), metodo: 'codigo_barras', sugerencias: [] };
  }
  const codigo = String(linea.codigo || '').trim();
  if (codigo) {
    const p = lista.find((x) => igual(x.codigo, codigo) || igual(x.barcode, codigo));
    if (p) return { productoId: Number(p.id), metodo: 'codigo', sugerencias: [] };
  }
  const codigoProveedor = String(linea.codigoProveedor || '').trim();
  const descripcion = normalizarTexto(linea.descripcion);
  const eq = equivalencias.find((e) => (codigoProveedor && igual(e.codigo_proveedor, codigoProveedor))
    || (!e.codigo_proveedor && descripcion && e.descripcion_normalizada === descripcion));
  if (eq && lista.some((p) => Number(p.id) === Number(eq.product_id))) {
    return { productoId: Number(eq.product_id), metodo: 'equivalencia', sugerencias: [] };
  }
  if (descripcion) {
    const exacto = lista.find((p) => normalizarTexto(p.nombre) === descripcion);
    if (exacto) return { productoId: Number(exacto.id), metodo: 'nombre_exacto', sugerencias: [] };
  }
  // Sugerencias: parecido de palabras, y las cantidades/medidas tienen que coincidir.
  const medidas = numeros(linea.descripcion);
  const sugerencias = descripcion ? lista
    .map((p) => ({ p, puntaje: similitud(linea.descripcion, p.nombre) }))
    .filter(({ p, puntaje }) => puntaje >= 0.5 && numeros(p.nombre) === medidas)
    .sort((a, b) => b.puntaje - a.puntaje)
    .slice(0, 5)
    .map(({ p, puntaje }) => ({ id: Number(p.id), nombre: p.nombre, codigo: p.codigo || '', puntaje: Math.round(puntaje * 100) / 100, motivo: 'nombre parecido' }))
    : [];
  return { productoId: null, metodo: null, sugerencias };
}

module.exports = { emparejarLinea, normalizarTexto, codigoBarrasValido, similitud, numeros };

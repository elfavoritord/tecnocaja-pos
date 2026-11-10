'use strict';

// Validación independiente de persistencia: los identificadores sobreviven
// a cambios visuales y los elementos con operaciones activas no se eliminan.
const FORMAS = new Set(['cuadro', 'rectangulo', 'circulo', 'mesa', 'mueble', 'pared', 'puerta', 'zona', 'texto', 'decoracion']);
const bibliotecaElementos = require('../../js/mesas-elementos');

function validarPlano(elementos, idsActivos = []) {
  if (!Array.isArray(elementos)) throw new Error('El plano debe contener una lista de elementos.');
  if (elementos.length > 5000) throw new Error('El plano admite hasta 5000 elementos.');
  const ids = new Set();
  const codigos = new Set();
  const resultado = elementos.map((elemento) => {
    if (!elemento || typeof elemento !== 'object') throw new Error('Elemento inválido.');
    const { id, codigo, forma, x, y, ancho, alto, vendible } = elemento;
    if (typeof id !== 'string' || !id.trim() || id.length > 80 || ids.has(id)) throw new Error('Identificador vacío o repetido.');
    if (typeof codigo !== 'string' || !codigo.trim() || codigo.length > 100) throw new Error('El código es obligatorio y admite hasta 100 caracteres.');
    const clave = codigo.trim().normalize('NFKC').toUpperCase();
    if (codigos.has(clave)) throw new Error('El código ya existe en el plano.');
    if (!FORMAS.has(forma)) throw new Error('Forma no admitida.');
    if (![x, y, ancho, alto].every(Number.isFinite) || ancho <= 0 || alto <= 0) throw new Error('Dimensiones o coordenadas inválidas.');
    if (typeof vendible !== 'boolean') throw new Error('Indique si el elemento permite ventas.');
    ids.add(id);
    codigos.add(clave);
    const zona = typeof elemento.zona === 'string' ? elemento.zona.trim() : '';
    if (zona.length > 100) throw new Error('La zona admite hasta 100 caracteres.');
    const tipo = elemento.tipo || '';
    if (tipo && !bibliotecaElementos.buscar(tipo)) throw new Error('Tipo de mobiliario no admitido.');
    const color = elemento.color || '#b77b47';
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Color inválido.');
    const capacidad = elemento.capacidad ?? 0;
    if (!Number.isSafeInteger(capacidad) || capacidad < 0) throw new Error('Capacidad inválida.');
    const angulo = elemento.rotacion ?? 0;
    if (typeof angulo !== 'number' || !Number.isFinite(angulo)) throw new Error('Rotación inválida.');
    const rotacion = ((angulo % 360) + 360) % 360;
    const textoEscala = elemento.textoEscala ?? 1;
    if (typeof textoEscala !== 'number' || !Number.isFinite(textoEscala) || textoEscala < .75 || textoEscala > 3) throw new Error('Tamaño de texto inválido.');
    if (elemento.etiqueta !== undefined && typeof elemento.etiqueta !== 'boolean') throw new Error('Etiqueta inválida.');
    const grupoId = elemento.grupoId ?? '';
    if (typeof grupoId !== 'string' || (grupoId && !/^[a-zA-Z0-9_-]{1,80}$/.test(grupoId))) throw new Error('Grupo inválido.');
    return { id, codigo: codigo.trim(), forma, x, y, ancho, alto, vendible, zona, tipo, color, capacidad, etiqueta: elemento.etiqueta !== false, rotacion, textoEscala, grupoId };
  });
  for (const id of idsActivos) {
    const elemento = resultado.find((item) => item.id === id);
    if (!elemento || !elemento.vendible) throw new Error('No se puede eliminar o deshabilitar una mesa con operaciones activas.');
  }
  return resultado;
}

module.exports = { validarPlano };

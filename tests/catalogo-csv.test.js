'use strict';

/**
 * js/catalogo-csv.js — importar/exportar productos y servicios en CSV, el
 * mismo formato en el POS y en el portal del contador.
 */

const csv = require('../js/catalogo-csv');
const { parseProductsCsvBuffer, PRODUCT_CSV_COLUMNS } = require('../server/services/products-csv.service');

describe('servicios', () => {
  test('encabezados con o sin acentos, en cualquier orden y con punto y coma', () => {
    const texto = [
      'SERVICIO;Precio;itbis %;Categoria;Codigo;Descripción',
      'Mantenimiento de PC;RD$ 1,500.00;18%;Soporte;MANT-01;"Limpieza; revisión"',
      'Asesoría;2500;Exento;;;',
      'Instalación de red;1.250,50;Sí;Redes;RED-01;',
    ].join('\r\n');
    const r = csv.leerServicios(texto);
    expect(r.errores).toEqual([]);
    expect(r.filas.map((f) => [f.codigo, f.nombre, f.precio, f.itbisPct, f.categoria])).toEqual([
      ['MANT-01', 'Mantenimiento de PC', 1500, 18, 'Soporte'],
      ['', 'Asesoría', 2500, 0, ''],
      ['RED-01', 'Instalación de red', 1250.5, 18, 'Redes'],
    ]);
    expect(r.filas[0].descripcion).toBe('Limpieza; revisión');
    expect(r.filas[0].campos.sort()).toEqual(['categoria', 'codigo', 'descripcion', 'itbisPct', 'nombre', 'precio']);
  });

  test('solo Código y Precio: sirve para subir precios sin tocar lo demás', () => {
    const r = csv.leerServicios('Código,Precio\nMANT-01,1800\nRED-01,abc\n,');
    expect(r.filas).toEqual([{ fila: 2, campos: ['codigo', 'precio'], codigo: 'MANT-01', nombre: '', soloActualiza: true, precio: 1800 }]);
    expect(r.errores).toEqual([{ fila: 3, mensaje: 'El precio "abc" no es un número válido.' }]);
  });

  test('errores por fila: precio malo y repetidos; sin nombre solo actualiza', () => {
    const r = csv.leerServicios('Código,Nombre,Precio\nA1,Uno,100\nA2,,50\nA3,Tres,abc\nA1,Otra vez,10');
    expect(r.filas.map((f) => [f.codigo, Boolean(f.soloActualiza)])).toEqual([['A1', false], ['A2', true]]);
    expect(r.errores).toEqual([
      { fila: 4, mensaje: 'El precio "abc" no es un número válido.' },
      { fila: 5, mensaje: 'Repite el código A1 de la fila 2.' },
    ]);
  });

  test('sin columnas Código ni Nombre avisa claro', () => {
    expect(() => csv.leerServicios('Precio,ITBIS\n10,18')).toThrow(/Código o Nombre/);
  });

  test('exportar y volver a importar da lo mismo', () => {
    const texto = csv.aCsv(csv.COLUMNAS_SERVICIOS, [
      { codigo: 'MANT-01', nombre: 'Mantenimiento, completo', descripcion: 'Dice "todo"', categoria: 'Soporte', unidad: 'visita', precio: '1500.00', itbisPct: 18, duracionMin: 60, estado: 'Activo' },
      { codigo: '', nombre: 'Asesoría', descripcion: '', categoria: '', unidad: 'hora', precio: '2500.00', itbisPct: 0, duracionMin: '', estado: 'Inactivo' },
    ]);
    expect(texto.startsWith('﻿Código,Nombre,Descripción')).toBe(true);
    const r = csv.leerServicios(texto);
    expect(r.errores).toEqual([]);
    expect(r.filas[0]).toMatchObject({ codigo: 'MANT-01', nombre: 'Mantenimiento, completo', descripcion: 'Dice "todo"', precio: 1500, itbisPct: 18, duracionMin: 60, activo: true });
    expect(r.filas[1]).toMatchObject({ nombre: 'Asesoría', unidad: 'hora', itbisPct: 0, activo: false });
  });
});

describe('productos (mismo formato que el POS)', () => {
  test('lo que exporta el portal lo importa el POS (products-csv.service)', () => {
    const texto = csv.aCsv(csv.COLUMNAS_PRODUCTOS, [{
      codigo: '0001', nombre: 'Agua 500 ml', sucursal: '', marca: 'Dasani', categoria: 'Bebidas', unidad: 'Unidad',
      precioCompra: '10.00', precioVenta: '20.00', stock: 100, stockMin: 10, estado: 'Activo', aplicaItbis: 'Sí', tracksStock: 'Sí',
    }]);
    const [p] = parseProductsCsvBuffer(Buffer.from(texto, 'utf8'));
    expect(p).toMatchObject({
      codigo: '0001', nombre: 'Agua 500 ml', marca: 'Dasani', categoria: 'Bebidas', precioCompra: 10, precioVenta: 20,
      stock: 100, stockMin: 10, aplicaItbis: true, tracksStock: true,
    });
  });

  test('lo que exporta el POS lo lee el portal', () => {
    const encabezado = PRODUCT_CSV_COLUMNS.map((c) => c.label).join(',');
    const fila = '0002,Refresco,,Coca-Cola,Bebidas,Unidad,unidad,25,40,48,6,Activo,general,Sí,No,No,15,,';
    const r = csv.leerProductos(`${encabezado}\n${fila}`);
    expect(r.errores).toEqual([]);
    expect(r.filas[0]).toMatchObject({
      codigo: '0002', nombre: 'Refresco', marca: 'Coca-Cola', categoria: 'Bebidas', precioCompra: 25, precioVenta: 40,
      stock: 48, stockMin: 6, aplicaItbis: true, tracksStock: false,
    });
  });

  test('un producto necesita código y nombre', () => {
    const r = csv.leerProductos('Código,Nombre,Precio\n,Sin código,10\nX1,,10\nX2,Bien,10');
    expect(r.filas.map((f) => f.codigo)).toEqual(['X2']);
    expect(r.errores.map((e) => e.mensaje)).toEqual(['Falta el código del producto.', 'Falta el nombre del producto.']);
  });
});

describe('archivo', () => {
  test('el CSV que guarda Excel en Windows (ANSI) no rompe los acentos', () => {
    const ansi = Buffer.from('Código;Nombre;Precio\r\nA1;Instalación;100\r\n', 'latin1');
    const r = csv.leerServicios(csv.decodificar(new Uint8Array(ansi)));
    expect(r.filas[0]).toMatchObject({ codigo: 'A1', nombre: 'Instalación', precio: 100 });
  });

  test('números como los escribe la gente', () => {
    expect([csv.numero('RD$ 1,500.00'), csv.numero('1,500'), csv.numero('15,50'), csv.numero('1.500,50'), csv.numero('18%'), csv.numero(''), csv.numero('abc')])
      .toEqual([1500, 1500, 15.5, 1500.5, 18, null, null]);
  });
});

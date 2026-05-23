'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildProductsCsvContent,
  parseProductsCsvBuffer,
  writeProductsCsvSnapshot,
} = require('../server/services/products-csv.service');

describe('products-csv.service', () => {
  test('parsea un CSV exportado por el módulo de productos', () => {
    const csv = [
      'Código,Nombre,Marca,Categoría,Unidad,Modo Venta,Costo,Precio,Stock,Stock Mínimo,Estado,Tipo Producto,Aplica ITBIS,Rastrea Stock,Es Combo,Tiempo Preparación,Imagen URL,Imagen Local',
      'P001,Café Molido,Monte Alto,Alimentos,Unidad,unidad,125.50,175.00,14,3,Activo,general,Sí,Sí,No,10,https://example.com/cafe.jpg,',
    ].join('\n');

    const rows = parseProductsCsvBuffer(Buffer.from(csv, 'utf8'), 'productos.csv');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      codigo: 'P001',
      nombre: 'Café Molido',
      categoria: 'Alimentos',
      precioCompra: 125.5,
      precioVenta: 175,
      stock: 14,
      stockMin: 3,
      aplicaItbis: true,
      tracksStock: true,
      esCombo: false,
      tiempoPreparacion: 10,
    });
  });

  test('soporta delimitador punto y coma y columnas mínimas', () => {
    const csv = [
      'Código;Nombre;Categoría;Precio;Stock;Estado',
      'P002;Azúcar Morena;Despensa;99,50;7;Activo',
    ].join('\n');

    const rows = parseProductsCsvBuffer(Buffer.from(csv, 'utf8'), 'productos.csv');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      codigo: 'P002',
      nombre: 'Azúcar Morena',
      categoria: 'Despensa',
      precioVenta: 99.5,
      stock: 7,
      estado: 'Activo',
    });
  });

  test('genera un CSV respaldable y escribe snapshot actual + histórico', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tecnocaja-products-csv-'));
    const rows = [
      {
        codigo: 'P003',
        nombre: 'Galletas',
        categoria: 'Snacks',
        precioCompra: 50,
        precioVenta: 75,
        stock: 12,
        stockMin: 2,
      },
    ];

    const csv = buildProductsCsvContent(rows);
    expect(csv).toContain('Código,Nombre');
    expect(csv).toContain('P003,Galletas');

    const result = writeProductsCsvSnapshot(rows, {
      date: new Date(2026, 4, 21, 14, 30, 45, 123),
      directory: tempDir,
    });

    expect(fs.existsSync(result.currentFilePath)).toBe(true);
    expect(fs.existsSync(result.backupFilePath)).toBe(true);
    expect(path.basename(result.backupFilePath)).toContain('productos-backup-20260521-143045123');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

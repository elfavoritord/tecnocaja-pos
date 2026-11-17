'use strict';
// Información adicional del producto en la factura (js/producto-info-adicional.js,
// server/productos/info-adicional.js). Pedido de Emilio del 2026-11-16: opcional,
// solo se cambia desde Productos y el XML del e-CF no cambia.
const Info = require('../js/producto-info-adicional');
const { createInfoAdicional } = require('../server/productos/info-adicional');
const { infoAdicionalDeFilaCsv, parseProductsCsvBuffer, buildProductsCsvContent } = require('../server/services/products-csv.service');
const FacturaPlantillas = require('../js/factura-plantillas');

const disco = {
  descripcion: 'Corte de porcelanato, Dekton, Neolith e Infinity.',
  especificaciones: 'Corte de materiales de ingeniería.',
  procedencia: 'China',
  observaciones: 'Usar con protección.',
  mostrarEnFactura: true,
};

describe('limpieza y largos', () => {
  test('quita caracteres de control y deja los saltos de línea', () => {
    const sucio = `Línea 1${String.fromCharCode(7)}\r\nLínea 2${String.fromCharCode(0x200b)}\n\n\n\nLínea 3   `;
    expect(Info.limpiarTexto(sucio, 100)).toBe('Línea 1\nLínea 2\n\nLínea 3');
  });

  test('respeta los largos máximos', () => {
    const info = Info.normalizar({ descripcion: 'a'.repeat(5000), procedencia: 'b'.repeat(500) });
    expect(info.descripcion).toHaveLength(Info.LIMITES.descripcion);
    expect(info.procedencia).toHaveLength(Info.LIMITES.procedencia);
  });

  test('sin texto no se guarda nada', () => {
    expect(Info.serializar({ descripcion: '   ', mostrarEnFactura: true })).toBeNull();
    expect(Info.deFila(null)).toBeNull();
    expect(Info.deFila('no es json')).toBeNull();
  });
});

describe('qué sale en la factura', () => {
  test('apagado en el negocio: nada (la factura sale como siempre)', () => {
    expect(Info.paraVenta(disco, { activo: false })).toBeNull();
    expect(Info.paraVenta(disco, null)).toBeNull();
  });

  test('el producto sin "Mostrar en la factura": nada', () => {
    expect(Info.paraVenta({ ...disco, mostrarEnFactura: false }, { activo: true })).toBeNull();
  });

  test('solo los campos que el negocio eligió (observaciones apagadas por defecto)', () => {
    expect(Info.paraVenta(disco, { activo: true })).toEqual({
      descripcion: disco.descripcion,
      especificaciones: disco.especificaciones,
      procedencia: 'China',
    });
    expect(Info.paraVenta(disco, { activo: true, especificaciones: false, procedencia: false, observaciones: true })).toEqual({
      descripcion: disco.descripcion,
      observaciones: 'Usar con protección.',
    });
  });

  test('las líneas como en el ejemplo de Emilio', () => {
    const copia = Info.paraVenta(disco, { activo: true });
    expect(Info.lineas(copia, { codigo: 'MRT115' })).toEqual([
      'MRT115',
      'Corte de porcelanato, Dekton, Neolith e Infinity.',
      'Corte de materiales de ingeniería.',
      'PROCEDENCIA: CHINA',
    ]);
  });

  test('ticket de 58 mm: se parte al ancho sin cortar palabras', () => {
    const copia = Info.paraVenta(disco, { activo: true });
    const lineas = Info.lineasTicket(copia, 30, { codigo: 'MRT115' });
    lineas.forEach((linea) => expect(linea.length).toBeLessThanOrEqual(30));
    expect(lineas.join(' ')).toBe('MRT115 Corte de porcelanato, Dekton, Neolith e Infinity. Corte de materiales de ingeniería. PROCEDENCIA: CHINA');
  });
});

describe('servidor: producto, línea de venta y reimpresión', () => {
  function servicio() {
    const consultas = [];
    const conn = { query: async (sql, params) => { consultas.push({ sql, params }); return []; } };
    return { info: createInfoAdicional({ addColumnIfMissing: async () => {} }), conn, consultas };
  }

  test('guardar el producto: solo si viene en lo que se guarda', async () => {
    const { info, conn, consultas } = servicio();
    await info.guardarEnProducto(conn, 5, undefined);
    expect(consultas).toHaveLength(0);
    await info.guardarEnProducto(conn, 5, disco);
    expect(consultas[0].sql).toMatch(/UPDATE products SET info_adicional = \?/);
    expect(JSON.parse(consultas[0].params[0])).toMatchObject({ procedencia: 'China', mostrarEnFactura: true });
  });

  test('la línea guarda la copia y la reimpresión la devuelve aunque el producto cambie', async () => {
    const { info, conn, consultas } = servicio();
    const producto = { info_adicional: JSON.stringify(disco) };
    const config = { info_adicional_factura: JSON.stringify({ activo: true }) };
    const copia = info.copiaParaLinea(producto, config);
    await info.guardarEnLinea(conn, 9, copia);
    const guardada = consultas[0].params[0];
    // El producto cambia después: la línea conserva lo de la venta.
    producto.info_adicional = JSON.stringify({ ...disco, procedencia: 'México' });
    expect(info.deLineaGuardada({ info_adicional: guardada })).toEqual({ infoAdicional: { ...copia } });
    expect(info.deLineaGuardada({ info_adicional: null })).toEqual({});
  });

  test('negocio con la función apagada: la línea no guarda nada', async () => {
    const { info, conn, consultas } = servicio();
    await info.guardarEnLinea(conn, 9, info.copiaParaLinea({ info_adicional: JSON.stringify(disco) }, { info_adicional_factura: null }));
    expect(consultas).toHaveLength(0);
  });
});

describe('CSV de productos', () => {
  test('exporta y vuelve a importar las columnas nuevas (con saltos de línea)', () => {
    const contenido = buildProductsCsvContent([{
      codigo: 'MRT115', nombre: 'Disco 115mm', categoria: 'Ferretería', precio_venta: 100,
      info_adicional: JSON.stringify({ ...disco, descripcion: 'Línea 1\nLínea 2' }),
    }]);
    const [fila] = parseProductsCsvBuffer(Buffer.from(contenido, 'utf8'), 'productos.csv');
    const info = infoAdicionalDeFilaCsv(fila, null);
    expect(info).toMatchObject({ descripcion: 'Línea 1\nLínea 2', procedencia: 'China', mostrarEnFactura: true });
  });

  test('un archivo sin esas columnas no toca la información del producto', () => {
    const [fila] = parseProductsCsvBuffer(Buffer.from('Código,Nombre,Precio\nA1,Producto,10\n', 'utf8'), 'p.csv');
    expect(infoAdicionalDeFilaCsv(fila, JSON.stringify(disco))).toBeUndefined();
  });

  test('si trae solo una columna, lo demás queda como estaba', () => {
    const [fila] = parseProductsCsvBuffer(Buffer.from('Código,Nombre,Procedencia\nA1,Producto,Italia\n', 'utf8'), 'p.csv');
    expect(infoAdicionalDeFilaCsv(fila, JSON.stringify(disco))).toMatchObject({ procedencia: 'Italia', descripcion: disco.descripcion });
  });
});

describe('factura A4: las líneas debajo del nombre', () => {
  test('cada plantilla muestra el detalle y lo escapa', () => {
    const doc = {
      isCot: false, estadoLabel: 'PAGADA', pagado: 118, balance: 0,
      empresa: { nombre: 'Ferretería', rnc: '', direccion: '' },
      cliente: { nombre: 'Consumidor Final' },
      numero: 'FAC-1', fecha: '16/11/2026',
      items: [{
        descripcion: 'Disco 115mm ultra fino porcelanato',
        detalle: ['MRT115', 'Corte de porcelanato <b>', 'PROCEDENCIA: CHINA'],
        cantidad: 1, unidad: 'Unidad', precio: 100, itbisPct: 18, itbisMonto: 18, total: 100,
      }],
      subtotal: 100, itbis: 18, total: 118,
    };
    for (const plantilla of ['clasica', 'ejecutiva', 'recuadro', 'banner']) {
      const html = FacturaPlantillas.render(doc, { plantilla });
      expect(html).toContain('MRT115<br>Corte de porcelanato &lt;b&gt;<br>PROCEDENCIA: CHINA');
    }
  });
});

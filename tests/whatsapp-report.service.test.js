'use strict';

const XLSX = require('xlsx');
const {
  generateWhatsAppReport,
  resolveDateRange,
} = require('../server/services/whatsapp-report.service');

function createQueryMock() {
  return jest.fn(async (sql) => {
    if (sql.includes('FROM sales s') && sql.includes('s.invoice_number')) {
      return [{
        invoice_number: 'FAC-1',
        created_at: new Date(2026, 7, 10, 10, 30),
        cliente: 'Cliente prueba',
        payment_method: 'efectivo',
        subtotal: 100,
        tax: 18,
        discount: 0,
        total: 118,
      }];
    }
    if (sql.includes('FROM products')) {
      return [{
        codigo: 'P-1', nombre: 'Producto', categoria: 'General', stock: 2,
        stock_min: 3, precio_compra: 50, precio_venta: 100, estado_stock: 'Bajo',
      }];
    }
    if (sql.includes('FROM clients') && !sql.includes('LEFT JOIN clients')) {
      return [{
        nombre: 'Cliente prueba', telefono: '8090000000', email: '', direccion: '',
        limite_credito: 1000, balance: 118,
      }];
    }
    if (sql.includes("s.payment_method = 'credito'")) {
      return [{ cliente: 'Cliente prueba', telefono: '8090000000', facturas: 1, pendiente: 118 }];
    }
    if (sql.includes('FROM cash_movements')) {
      return [{
        happened_at: new Date(2026, 7, 10, 9, 0), movement_type: 'ingreso',
        amount: 500, usuario: 'Admin', notas: 'Apertura',
      }];
    }
    return [];
  });
}

describe('WhatsApp report service', () => {
  test('resuelve periodos locales sin convertirlos a UTC', () => {
    const now = new Date(2026, 7, 10, 14, 0);
    expect(resolveDateRange('hoy', null, null, now)).toMatchObject({
      from: '2026-08-10',
      to: '2026-08-10',
    });
    expect(resolveDateRange('mes_anterior', null, null, now)).toMatchObject({
      from: '2026-07-01',
      to: '2026-07-31',
    });
  });

  test('rechaza rangos personalizados invalidos o excesivos', () => {
    expect(() => resolveDateRange('personalizado', '2026-08-20', '2026-08-10'))
      .toThrow('fecha inicial');
    expect(() => resolveDateRange('personalizado', '2024-01-01', '2026-01-01'))
      .toThrow('366 dias');
  });

  test('genera un PDF de ventas listo para WhatsApp', async () => {
    const report = await generateWhatsAppReport({
      query: createQueryMock(),
      reportType: 'ventas',
      format: 'pdf',
      period: 'hoy',
      now: new Date(2026, 7, 10, 14, 0),
    });
    expect(report.filename).toBe('TecnoCaja_ventas_2026-08-10_2026-08-10.pdf');
    expect(report.mimeType).toBe('application/pdf');
    expect(report.buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(report.sections[0].rows).toHaveLength(1);
  });

  test('genera Excel completo con una hoja por modulo', async () => {
    const report = await generateWhatsAppReport({
      query: createQueryMock(),
      reportType: 'completo',
      format: 'xlsx',
      period: 'mes',
      now: new Date(2026, 7, 10, 14, 0),
    });
    const workbook = XLSX.read(report.buffer, { type: 'buffer' });
    expect(workbook.SheetNames).toEqual([
      'Ventas', 'Inventario', 'Clientes', 'Cuentas por cobrar', 'Movimientos de caja',
    ]);
  });

  test('genera CSV UTF-8 con encabezados', async () => {
    const report = await generateWhatsAppReport({
      query: createQueryMock(),
      reportType: 'inventario',
      format: 'csv',
      period: 'hoy',
    });
    const text = report.buffer.toString('utf8');
    expect(text.startsWith('\uFEFFInventario')).toBe(true);
    expect(text).toContain('Codigo,Producto,Categoria,Stock');
  });
});

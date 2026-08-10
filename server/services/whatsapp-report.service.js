'use strict';

const XLSX = require('xlsx');
const { jsPDF } = require('jspdf');

const REPORT_TYPES = new Set(['ventas', 'inventario', 'clientes', 'cuentas_cobrar', 'caja', 'completo']);
const REPORT_FORMATS = new Set(['pdf', 'xlsx', 'csv']);
const PERIODS = new Set(['hoy', 'ayer', 'semana', 'mes', 'mes_anterior', 'personalizado']);

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (toDateKey(date) !== match[0]) return null;
  return date;
}

function resolveDateRange(period = 'hoy', from, to, now = new Date()) {
  const normalized = PERIODS.has(period) ? period : 'hoy';
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);

  if (normalized === 'ayer') {
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
  } else if (normalized === 'semana') {
    const mondayOffset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - mondayOffset);
  } else if (normalized === 'mes') {
    start.setDate(1);
  } else if (normalized === 'mes_anterior') {
    start.setMonth(start.getMonth() - 1, 1);
    end.setDate(0);
  } else if (normalized === 'personalizado') {
    const customStart = parseDateKey(from);
    const customEnd = parseDateKey(to || from);
    if (!customStart || !customEnd) {
      throw new Error('Para un periodo personalizado indica desde y hasta en formato YYYY-MM-DD.');
    }
    start.setTime(customStart.getTime());
    end.setTime(customEnd.getTime());
  }

  if (start > end) throw new Error('La fecha inicial no puede ser posterior a la fecha final.');
  const days = Math.floor((end - start) / 86400000) + 1;
  if (days > 366) throw new Error('El reporte no puede abarcar mas de 366 dias.');

  return {
    period: normalized,
    from: toDateKey(start),
    to: toDateKey(end),
    fromDatetime: `${toDateKey(start)} 00:00:00`,
    toDatetime: `${toDateKey(end)} 23:59:59`,
  };
}

function money(value) {
  return `RD$ ${Number(value || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function plainValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (value instanceof Date) return value.toLocaleString('es-DO');
  return String(value);
}

function section(title, columns, rows, summary = []) {
  return { title, columns, rows, summary };
}

async function loadSales(query, range) {
  const rows = await query(
    `SELECT s.invoice_number, s.created_at,
            COALESCE(s.client_name_snapshot, c.nombre, 'Consumidor final') AS cliente,
            s.payment_method, s.subtotal, s.tax, s.discount, s.total
       FROM sales s
       LEFT JOIN clients c ON c.id = s.client_id
      WHERE s.created_at BETWEEN ? AND ?
        AND COALESCE(s.sale_status, 'pagada') = 'pagada'
        AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
      ORDER BY s.created_at DESC
      LIMIT 5000`,
    [range.fromDatetime, range.toDatetime],
  );
  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const tax = rows.reduce((sum, row) => sum + Number(row.tax || 0), 0);
  return section('Ventas', [
    { key: 'invoice_number', label: 'Factura' },
    { key: 'created_at', label: 'Fecha' },
    { key: 'cliente', label: 'Cliente' },
    { key: 'payment_method', label: 'Metodo' },
    { key: 'subtotal', label: 'Subtotal', money: true },
    { key: 'tax', label: 'ITBIS', money: true },
    { key: 'total', label: 'Total', money: true },
  ], rows, [`Facturas: ${rows.length}`, `Total: ${money(total)}`, `ITBIS: ${money(tax)}`]);
}

async function loadInventory(query) {
  const rows = await query(
    `SELECT codigo, nombre, categoria, stock, stock_min, precio_compra, precio_venta,
            CASE
              WHEN tracks_stock = 0 THEN 'No controla stock'
              WHEN stock <= 0 THEN 'Agotado'
              WHEN stock_min > 0 AND stock <= stock_min THEN 'Bajo'
              ELSE 'Disponible'
            END AS estado_stock
       FROM products
      WHERE LOWER(estado) = 'activo'
      ORDER BY nombre
      LIMIT 5000`,
    [],
  );
  const value = rows.reduce((sum, row) => sum + (Number(row.stock || 0) * Number(row.precio_compra || 0)), 0);
  const low = rows.filter((row) => row.estado_stock === 'Bajo' || row.estado_stock === 'Agotado').length;
  return section('Inventario', [
    { key: 'codigo', label: 'Codigo' },
    { key: 'nombre', label: 'Producto' },
    { key: 'categoria', label: 'Categoria' },
    { key: 'stock', label: 'Stock' },
    { key: 'stock_min', label: 'Minimo' },
    { key: 'precio_venta', label: 'Precio', money: true },
    { key: 'estado_stock', label: 'Estado' },
  ], rows, [`Productos: ${rows.length}`, `Alertas: ${low}`, `Valor al costo: ${money(value)}`]);
}

async function loadCustomers(query) {
  const rows = await query(
    `SELECT nombre, telefono, email, direccion, limite_credito, balance
       FROM clients
      ORDER BY nombre
      LIMIT 5000`,
    [],
  );
  const balance = rows.reduce((sum, row) => sum + Number(row.balance || 0), 0);
  return section('Clientes', [
    { key: 'nombre', label: 'Cliente' },
    { key: 'telefono', label: 'Telefono' },
    { key: 'email', label: 'Correo' },
    { key: 'direccion', label: 'Direccion' },
    { key: 'limite_credito', label: 'Limite credito', money: true },
    { key: 'balance', label: 'Balance', money: true },
  ], rows, [`Clientes: ${rows.length}`, `Balance registrado: ${money(balance)}`]);
}

async function loadReceivables(query) {
  const rows = await query(
    `SELECT COALESCE(s.client_name_snapshot, c.nombre, 'Sin nombre') AS cliente,
            COALESCE(s.client_phone_snapshot, c.telefono, '-') AS telefono,
            COUNT(*) AS facturas,
            SUM(CASE
                  WHEN COALESCE(s.total, 0) > COALESCE(s.received_amount, 0)
                    THEN COALESCE(s.total, 0) - COALESCE(s.received_amount, 0)
                  ELSE 0
                END) AS pendiente
       FROM sales s
       LEFT JOIN clients c ON c.id = s.client_id
      WHERE s.payment_method = 'credito'
        AND COALESCE(s.sale_status, 'pagada') = 'pagada'
        AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'
        AND COALESCE(s.total, 0) > COALESCE(s.received_amount, 0)
      GROUP BY s.client_id, COALESCE(s.client_name_snapshot, c.nombre, 'Sin nombre'),
               COALESCE(s.client_phone_snapshot, c.telefono, '-')
      ORDER BY pendiente DESC
      LIMIT 5000`,
    [],
  );
  const total = rows.reduce((sum, row) => sum + Number(row.pendiente || 0), 0);
  return section('Cuentas por cobrar', [
    { key: 'cliente', label: 'Cliente' },
    { key: 'telefono', label: 'Telefono' },
    { key: 'facturas', label: 'Facturas' },
    { key: 'pendiente', label: 'Pendiente', money: true },
  ], rows, [`Deudores: ${rows.length}`, `Total pendiente: ${money(total)}`]);
}

async function loadCash(query, range) {
  const rows = await query(
    `SELECT happened_at, movement_type, amount,
            COALESCE(created_by_user_name, 'Sistema') AS usuario,
            COALESCE(notes, '') AS notas
       FROM cash_movements
      WHERE happened_at BETWEEN ? AND ?
      ORDER BY happened_at DESC
      LIMIT 5000`,
    [range.fromDatetime, range.toDatetime],
  );
  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return section('Movimientos de caja', [
    { key: 'happened_at', label: 'Fecha' },
    { key: 'movement_type', label: 'Tipo' },
    { key: 'amount', label: 'Monto', money: true },
    { key: 'usuario', label: 'Usuario' },
    { key: 'notas', label: 'Notas' },
  ], rows, [`Movimientos: ${rows.length}`, `Monto acumulado: ${money(total)}`]);
}

async function loadSections(query, reportType, range) {
  const loaders = {
    ventas: () => loadSales(query, range),
    inventario: () => loadInventory(query),
    clientes: () => loadCustomers(query),
    cuentas_cobrar: () => loadReceivables(query),
    caja: () => loadCash(query, range),
  };
  if (reportType === 'completo') {
    return Promise.all(Object.values(loaders).map((load) => load()));
  }
  return [await loaders[reportType]()];
}

function sanitizeSheetName(value) {
  return String(value).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Reporte';
}

function rowsForExport(reportSection) {
  return reportSection.rows.map((row) => {
    const item = {};
    for (const column of reportSection.columns) {
      item[column.label] = row[column.key] instanceof Date
        ? row[column.key].toLocaleString('es-DO')
        : row[column.key];
    }
    return item;
  });
}

function createXlsx(sections) {
  const workbook = XLSX.utils.book_new();
  for (const item of sections) {
    const rows = rowsForExport(item);
    const worksheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Estado: 'Sin datos' }]);
    XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeSheetName(item.title));
  }
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
}

function csvEscape(value) {
  const text = plainValue(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function createCsv(sections) {
  const lines = [];
  for (const item of sections) {
    if (lines.length) lines.push('');
    lines.push(csvEscape(item.title));
    lines.push(item.columns.map((column) => csvEscape(column.label)).join(','));
    for (const row of item.rows) {
      lines.push(item.columns.map((column) => csvEscape(row[column.key])).join(','));
    }
    lines.push(...item.summary.map(csvEscape));
  }
  return Buffer.from(`\uFEFF${lines.join('\r\n')}`, 'utf8');
}

function normalizePdfText(value) {
  return plainValue(value)
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2192/g, 'a');
}

function createPdf(sections, range) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 14;
  let y = 16;

  const ensureSpace = (height = 8) => {
    if (y + height <= pageHeight - 14) return;
    doc.addPage();
    y = 16;
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Tecno Caja POS', margin, y);
  y += 7;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Reporte del ${range.from} al ${range.to}`, margin, y);
  y += 9;

  for (const item of sections) {
    ensureSpace(18);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(normalizePdfText(item.title), margin, y);
    y += 6;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const summary = item.summary.join(' | ');
    for (const line of doc.splitTextToSize(normalizePdfText(summary), pageWidth - (margin * 2))) {
      doc.text(line, margin, y);
      y += 4;
    }
    y += 2;

    if (!item.rows.length) {
      doc.text('Sin datos para este periodo.', margin, y);
      y += 8;
      continue;
    }

    const visibleColumns = item.columns.slice(0, 5);
    for (const row of item.rows) {
      ensureSpace(10);
      const line = visibleColumns.map((column) => {
        const raw = row[column.key];
        return `${column.label}: ${column.money ? money(raw) : normalizePdfText(raw)}`;
      }).join(' | ');
      const wrapped = doc.splitTextToSize(line, pageWidth - (margin * 2));
      for (const text of wrapped.slice(0, 3)) {
        doc.text(text, margin, y);
        y += 4;
      }
      y += 1;
    }
    y += 4;
  }

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setFontSize(8);
    doc.setTextColor(100);
    doc.text(`Pagina ${page} de ${pages}`, pageWidth - margin, pageHeight - 7, { align: 'right' });
  }
  return Buffer.from(doc.output('arraybuffer'));
}

async function generateWhatsAppReport({ query, reportType, format, period, from, to, now }) {
  const normalizedType = String(reportType || '').toLowerCase();
  const normalizedFormat = String(format || 'pdf').toLowerCase();
  if (!REPORT_TYPES.has(normalizedType)) throw new Error('Tipo de reporte no permitido.');
  if (!REPORT_FORMATS.has(normalizedFormat)) throw new Error('Formato no permitido. Usa PDF, Excel o CSV.');

  const range = resolveDateRange(String(period || 'hoy').toLowerCase(), from, to, now);
  const sections = await loadSections(query, normalizedType, range);
  const stamp = `${range.from}_${range.to}`;
  const baseName = `TecnoCaja_${normalizedType}_${stamp}`;

  if (normalizedFormat === 'xlsx') {
    return {
      buffer: createXlsx(sections),
      filename: `${baseName}.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sections,
      range,
    };
  }
  if (normalizedFormat === 'csv') {
    return {
      buffer: createCsv(sections),
      filename: `${baseName}.csv`,
      mimeType: 'text/csv',
      sections,
      range,
    };
  }
  return {
    buffer: createPdf(sections, range),
    filename: `${baseName}.pdf`,
    mimeType: 'application/pdf',
    sections,
    range,
  };
}

module.exports = {
  generateWhatsAppReport,
  resolveDateRange,
};

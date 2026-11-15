'use strict';

/**
 * PDF del estado de cuenta de un cliente, para mandarlo desde la app de reportes.
 *
 * Es la misma hoja que descarga el POS (buildClientStatementPdf de
 * js/clientes-estado-cuenta.js): A4 apaisada, mismos encabezados y columnas, y
 * los números del mismo cálculo (server/services/client-statement.js). Si se
 * cambia uno, revisar el otro.
 */

const ESTADOS = { abierta: 'Abierta', pagada: 'Pagada', vencida: 'Vencida', cancelada: 'Cancelada', aplicado: 'Aplicado' };

function crearFmt(moneda = 'RD$') {
  return (valor) => `${moneda} ${Number(valor || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function grilla(report) {
  const rows = report.rows || [];
  return [['Fecha', 'Movimiento', 'Factura / NCF', 'Vence', 'Cargo', 'Abono / ajuste', 'Saldo', 'Estado'],
    ['', 'Saldo inicial', '', '', '', '', report.openingBalance, ''],
    ...rows.map((r) => [r.date, r.type, r.reference, String(r.dueDate || '').slice(0, 10), r.debit || '', r.credit || '', r.balance,
      `${ESTADOS[r.status] || r.status || ''}${r.overdueDays ? ` · ${r.overdueDays} días` : ''}`]),
    ['', 'Saldo al cierre', '', '', '', '', report.closingBalance, '']];
}

/**
 * @param {object} report  salida de client-statement.build
 * @param {object} negocio { nombre, rnc, direccion, telefono, moneda }
 * @returns {Buffer}
 */
function pdfEstadoCuenta(report, negocio = {}) {
  const { jsPDF } = require('jspdf');
  const fmt = crearFmt(negocio.moneda || 'RD$');
  const doc = new jsPDF({ orientation: 'landscape', format: 'a4' });
  const neg = { nombre: negocio.nombre || 'Tecno Caja', rnc: negocio.rnc || '', direccion: negocio.direccion || '', telefono: negocio.telefono || '' };
  const c = report.client || {};
  let y = 14;
  const heading = () => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(14); doc.text(neg.nombre, 12, y); doc.setFontSize(9);
    doc.text([neg.rnc ? `RNC ${neg.rnc}` : '', neg.direccion, neg.telefono].filter(Boolean).join(' · '), 12, y + 5);
    doc.setFontSize(13); doc.text('Estado de cuenta', 284, y, { align: 'right' }); doc.setFontSize(9);
    doc.text(`Fecha de corte ${report.fechaCorte}`, 284, y + 5, { align: 'right' }); y += 12;
    doc.setFontSize(10);
    doc.text(`${c.nombre || ''}${c.rnc || c.cedula ? ` · ${c.rnc || c.cedula}` : ''}${c.telefonoFormateado ? ` · ${c.telefonoFormateado}` : ''}`, 12, y); y += 5;
    doc.setFontSize(9);
    doc.text(`Período: ${report.from || 'Inicio'} a ${report.to || 'Hoy'} · Límite: ${report.sinLimite ? 'sin límite' : fmt(report.limiteCredito)} · Saldo inicial ${fmt(report.openingBalance)} · Saldo actual ${fmt(report.currentBalance)} · Vigente ${fmt(report.deudaVigente)} · Vencida ${fmt(report.deudaVencida)}`, 12, y); y += 7;
  };
  heading();
  const widths = [32, 44, 42, 22, 28, 30, 30, 44];
  const xs = [12];
  widths.slice(0, -1).forEach((w, i) => xs.push(xs[i] + w));
  const filas = grilla(report);
  const header = filas.shift();
  const line = (cells, bold = false) => {
    const lines = cells.map((v, i) => doc.splitTextToSize(typeof v === 'number' ? fmt(v) : String(v || ''), widths[i] - 3));
    const height = Math.max(...lines.map((v) => v.length)) * 4.2 + 3;
    if (y + height > 194) { doc.addPage(); y = 14; heading(); line(header, true); }
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(8);
    lines.forEach((v, i) => doc.text(v, xs[i], y));
    y += height; doc.setDrawColor(220); doc.line(12, y - 3, 284, y - 3);
  };
  line(header, true);
  filas.forEach((r) => line(r));
  if (report.legacyOpening || Math.abs(Number(report.reconciliationDifference || 0)) > 0.009) {
    if (y > 180) { doc.addPage(); y = 16; }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text('Incluye registros históricos. Revise cualquier diferencia de conciliación indicada en el sistema.', 12, y + 4);
  }
  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { pdfEstadoCuenta, grilla, crearFmt };

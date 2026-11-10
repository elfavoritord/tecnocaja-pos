// Estado de cuenta individual y reporte general de clientes (mejora 2).
// Todo sale de /api/clients/:id/statement y /api/clients/receivables-report:
// lo que se ve, se imprime, se descarga y se comparte es el mismo cálculo.
let clientStatementReport = null;
let clientReceivablesReport = { clientes: [] };
const STATEMENT_ESTADOS = { abierta: 'Abierta', pagada: 'Pagada', vencida: 'Vencida', cancelada: 'Cancelada', aplicado: 'Aplicado' };

function statementBusiness() {
  const cfg = typeof getEffectiveConfig === 'function' ? getEffectiveConfig() : (DB.config || {});
  return { nombre: cfg.nombre || DB.config?.nombre || cfg.businessName || 'Tecno Caja', rnc: cfg.rnc || DB.config?.rnc || '',
    direccion: cfg.direccion || DB.config?.direccion || '', telefono: cfg.telefono || DB.config?.telefono || '' };
}

function statementVisibleRows(report = clientStatementReport) {
  const filtro = document.getElementById('statement-filter')?.value || report.filtro || 'todos';
  report.filtro = filtro;
  if (filtro === 'todos') return report.rows;
  if (filtro === 'movimientos') return report.rows.filter((r) => !String(r.id).startsWith('sale-'));
  return report.rows.filter((r) => String(r.id).startsWith('sale-') && r.status === filtro.replace(/s$/, ''));
}

async function openClientStatement(id, retainPeriod = false) {
  try {
    const from = retainPeriod ? document.getElementById('statement-from')?.value || '' : '';
    const to = retainPeriod ? document.getElementById('statement-to')?.value || '' : '';
    const filtro = retainPeriod ? document.getElementById('statement-filter')?.value || 'todos' : 'todos';
    const report = await api.request(`/api/clients/${id}/statement?${new URLSearchParams({ from, to })}`);
    report.filtro = filtro;
    clientStatementReport = report;
    const c = report.client;
    document.getElementById('modal-title').textContent = `Estado de cuenta · ${c.nombre}`;
    document.getElementById('modal-body').innerHTML = `
      <div class="ec-cabecera">
        <div><span>Cliente</span><strong>${escapeHtml(c.nombre)}</strong><small>${escapeHtml(c.rnc || c.cedula || '')}${c.telefonoFormateado ? ` · ${escapeHtml(c.telefonoFormateado)}` : ''}</small></div>
        <div><span>Límite de crédito</span><strong>${report.sinLimite ? 'Sin límite' : fmt(report.limiteCredito)}</strong>${report.disponible !== null ? `<small>Disponible ${fmt(report.disponible)}</small>` : ''}</div>
        <div><span>Saldo actual</span><strong>${fmt(report.currentBalance)}</strong><small>Corte ${escapeHtml(report.fechaCorte)}</small></div>
        <div><span>Deuda vigente</span><strong>${fmt(report.deudaVigente)}</strong></div>
        <div class="${report.deudaVencida > 0 ? 'ec-alerta' : ''}"><span>Deuda vencida</span><strong>${fmt(report.deudaVencida)}</strong></div>
      </div>
      <div class="modal-grid ec-filtros"><label>Desde<input id="statement-from" type="date" class="form-input" value="${escapeHtml(from)}"></label>
      <label>Hasta<input id="statement-to" type="date" class="form-input" value="${escapeHtml(to)}"></label>
      <label>Mostrar<select id="statement-filter" class="form-input" onchange="renderClientStatementRows()">
        ${[['todos', 'Todo'], ['abiertas', 'Facturas abiertas'], ['pagadas', 'Facturas pagadas'], ['vencidas', 'Facturas vencidas'], ['movimientos', 'Solo abonos y ajustes']].map(([v, t]) => `<option value="${v}" ${v === filtro ? 'selected' : ''}>${t}</option>`).join('')}
      </select></label>
      <button class="btn-secondary" onclick="openClientStatement(${Number(id)},true)">Aplicar período</button></div>
      <p>Saldo inicial del período: <strong>${fmt(report.openingBalance)}</strong> · Saldo al cierre: <strong>${fmt(report.closingBalance)}</strong></p>
      ${report.legacyOpening ? '<p>El saldo inicial histórico no tiene detalle de movimientos anteriores.</p>' : ''}
      ${Math.abs(report.reconciliationDifference) > 0.009 ? '<p class="inline-form-alert">Hay una diferencia con los registros históricos que requiere revisión. No se crearon cargos ni abonos para ocultarla.</p>' : ''}
      <div id="statement-rows" style="overflow:auto;max-height:50vh"></div>`;
    document.getElementById('modal-footer').innerHTML = `<button class="btn-secondary" onclick="closeAllModals()">Cerrar</button>
      <button class="btn-secondary" onclick="exportClientStatement('xlsx')">Excel</button>
      <button class="btn-secondary" onclick="exportClientStatement('print')">Imprimir A4</button>
      <button class="btn-secondary" onclick="exportClientStatement('pdf')">PDF</button>
      <button class="btn-primary" onclick="prepareClientStatementWhatsApp()">Compartir PDF</button>`;
    document.getElementById('modal-overlay').classList.remove('hidden');
    renderClientStatementRows();
  } catch (e) { showToast(e.message, 'error'); }
}

function renderClientStatementRows() {
  const report = clientStatementReport;
  const box = document.getElementById('statement-rows');
  if (!report || !box) return;
  const rows = statementVisibleRows(report);
  box.innerHTML = `<table class="data-table"><thead><tr><th>Fecha</th><th>Movimiento</th><th>Factura / NCF</th><th>Vence</th><th>Cargo</th><th>Abono / ajuste</th><th>Saldo</th><th>Estado</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.type)}</td>
      <td>${r.saleId ? `<button class="btn-ghost" onclick="openStatementInvoice(${Number(r.saleId)})">${escapeHtml(r.reference || '')}</button>` : escapeHtml(r.reference || '')}</td>
      <td>${escapeHtml(String(r.dueDate || '').slice(0, 10))}</td><td>${r.debit ? fmt(r.debit) : ''}</td><td>${r.credit ? fmt(r.credit) : ''}</td><td>${fmt(r.balance)}</td>
      <td>${escapeHtml(STATEMENT_ESTADOS[r.status] || r.status || '')}${r.overdueDays ? ` · ${r.overdueDays} días` : ''}</td></tr>`).join('') || '<tr><td colspan="8">Sin movimientos con este filtro.</td></tr>'}
    </tbody></table>`;
}

async function openStatementInvoice(saleId) {
  const report = clientStatementReport;
  if (!report) return;
  try {
    const f = await api.request(`/api/clients/${Number(report.client.id)}/statement/invoice/${Number(saleId)}`);
    let box = document.getElementById('ec-factura');
    if (!box) { box = document.createElement('div'); box.id = 'ec-factura'; box.className = 'aud-detalle'; document.body.appendChild(box); }
    box.innerHTML = `<div class="aud-detalle-card" role="dialog" aria-modal="true" aria-label="Detalle de factura">
      <div class="aud-detalle-head"><h3>${escapeHtml(f.documento)} · ${escapeHtml(STATEMENT_ESTADOS[f.estado] || f.estado)}</h3><button class="btn-secondary" onclick="document.getElementById('ec-factura').remove()">Cerrar</button></div>
      <div class="aud-fila"><span>Fecha</span><strong>${escapeHtml(f.fecha)}</strong></div>
      <div class="aud-fila"><span>Vence</span><strong>${escapeHtml(f.vence || '—')}${f.diasAtraso ? ` · ${f.diasAtraso} días de atraso` : ''}</strong></div>
      <table class="data-table"><thead><tr><th>Concepto</th><th>Cant.</th><th>Precio</th><th>Desc.</th><th>ITBIS</th><th>Total</th></tr></thead><tbody>
        ${f.conceptos.map((i) => `<tr><td>${escapeHtml(i.nombre)}</td><td>${i.cantidad}</td><td>${fmt(i.precio)}</td><td>${i.descuentoPct ? `${i.descuentoPct}%` : ''}</td><td>${i.itbisPct ? `${i.itbisPct}%` : 'Exento'}</td><td>${fmt(i.total)}</td></tr>`).join('')}
      </tbody></table>
      <div class="aud-fila"><span>Subtotal</span><strong>${fmt(f.subtotal)}</strong></div>
      ${f.descuento ? `<div class="aud-fila"><span>Descuento</span><strong>- ${fmt(f.descuento)}</strong></div>` : ''}
      <div class="aud-fila"><span>ITBIS</span><strong>${fmt(f.itbis)}</strong></div>
      ${f.propinaLegal ? `<div class="aud-fila"><span>Propina legal</span><strong>${fmt(f.propinaLegal)}</strong></div>` : ''}
      <div class="aud-fila"><span>Total</span><strong>${fmt(f.total)}</strong></div>
      ${f.cobradoAlVender !== null ? `<div class="aud-fila"><span>Cobrado al vender</span><strong>${fmt(f.cobradoAlVender)}</strong></div>` : ''}
      <h4>Pagos aplicados</h4>${f.pagos.length ? f.pagos.map((p) => `<div class="aud-fila"><span>${escapeHtml(p.fecha)} · ${escapeHtml(p.metodo)}</span><strong>${fmt(p.monto)}</strong></div>`).join('') : '<p class="text-muted">Sin abonos.</p>'}
      ${f.notas.length ? `<h4>Notas de crédito / ajustes</h4>${f.notas.map((n) => `<div class="aud-fila"><span>${escapeHtml(n.fecha)} · ${escapeHtml(n.documento || 'Nota')} · ${escapeHtml(n.motivo)}</span><strong>${fmt(n.monto)}</strong></div>`).join('')}` : ''}
      <div class="aud-fila"><span><strong>Saldo pendiente</strong></span><strong>${fmt(f.pendiente)}</strong></div></div>`;
  } catch (e) { showToast(e.message, 'error'); }
}

function statementGrid(report) {
  const rows = statementVisibleRows(report);
  return [['Fecha', 'Movimiento', 'Factura / NCF', 'Vence', 'Cargo', 'Abono / ajuste', 'Saldo', 'Estado'],
    ['', 'Saldo inicial', '', '', '', '', report.openingBalance, ''],
    ...rows.map((r) => [r.date, r.type, r.reference, String(r.dueDate || '').slice(0, 10), r.debit || '', r.credit || '', r.balance, `${STATEMENT_ESTADOS[r.status] || r.status || ''}${r.overdueDays ? ` · ${r.overdueDays} días` : ''}`]),
    ['', 'Saldo al cierre', '', '', '', '', report.closingBalance, '']];
}

async function buildClientStatementPdf(report) {
  await window.VendorLoader.load('jspdf');
  const doc = new window.jspdf.jsPDF({ orientation: 'landscape', format: 'a4' });
  const neg = statementBusiness(), c = report.client;
  let y = 14;
  const heading = () => {
    doc.setFontSize(14); doc.text(neg.nombre, 12, y); doc.setFontSize(9);
    doc.text([neg.rnc ? `RNC ${neg.rnc}` : '', neg.direccion, neg.telefono].filter(Boolean).join(' · '), 12, y + 5);
    doc.setFontSize(13); doc.text('Estado de cuenta', 284, y, { align: 'right' }); doc.setFontSize(9);
    doc.text(`Fecha de corte ${report.fechaCorte}`, 284, y + 5, { align: 'right' }); y += 12;
    doc.setFontSize(10); doc.text(`${c.nombre}${c.rnc || c.cedula ? ` · ${c.rnc || c.cedula}` : ''}${c.telefonoFormateado ? ` · ${c.telefonoFormateado}` : ''}`, 12, y); y += 5;
    doc.setFontSize(9);
    doc.text(`Período: ${report.from || 'Inicio'} a ${report.to || 'Hoy'} · Límite: ${report.sinLimite ? 'sin límite' : fmt(report.limiteCredito)} · Saldo inicial ${fmt(report.openingBalance)} · Saldo actual ${fmt(report.currentBalance)} · Vigente ${fmt(report.deudaVigente)} · Vencida ${fmt(report.deudaVencida)}`, 12, y); y += 7;
  };
  heading();
  const widths = [32, 44, 42, 22, 28, 30, 30, 44], xs = [12];
  widths.slice(0, -1).forEach((w, i) => xs.push(xs[i] + w));
  const grid = statementGrid(report), header = grid.shift();
  const line = (cells, bold = false) => {
    const lines = cells.map((v, i) => doc.splitTextToSize(typeof v === 'number' ? fmt(v) : String(v || ''), widths[i] - 3));
    const height = Math.max(...lines.map((v) => v.length)) * 4.2 + 3;
    if (y + height > 194) { doc.addPage(); y = 14; heading(); line(header, true); }
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(8);
    lines.forEach((v, i) => doc.text(v, xs[i], y));
    y += height; doc.setDrawColor(220); doc.line(12, y - 3, 284, y - 3);
  };
  line(header, true); grid.forEach((r) => line(r));
  if (report.legacyOpening || Math.abs(report.reconciliationDifference) > .009) {
    if (y > 180) { doc.addPage(); y = 16; }
    doc.setFontSize(9); doc.text('Incluye registros históricos. Revise cualquier diferencia de conciliación indicada en el sistema.', 12, y + 4);
  }
  return doc;
}

async function exportClientStatement(format) {
  try {
    if (!clientStatementReport) return;
    const report = clientStatementReport, file = `Estado_cuenta_${Number(report.client.id)}_${report.fechaCorte}`;
    if (format === 'xlsx') {
      await window.VendorLoader.load('xlsx');
      const neg = statementBusiness();
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[neg.nombre], [`Estado de cuenta · ${report.client.nombre}`], [`Fecha de corte ${report.fechaCorte}`],
        [`Saldo actual ${report.currentBalance} · Vigente ${report.deudaVigente} · Vencida ${report.deudaVencida}`], [], ...statementGrid(report)]), 'Estado de cuenta');
      XLSX.writeFile(book, file + '.xlsx'); return;
    }
    const doc = await buildClientStatementPdf(report);
    if (format === 'print') { doc.autoPrint(); window.open(doc.output('bloburl'), '_blank'); }
    else doc.save(file + '.pdf');
  } catch (e) { showToast(e.message, 'error'); }
}

// Compartir por WhatsApp solo a iniciativa del usuario y con el número confirmado.
function prepareClientStatementWhatsApp() {
  if (!clientStatementReport) return;
  const report = clientStatementReport;
  const body = document.getElementById('modal-body');
  let box = document.getElementById('statement-share-confirm');
  if (!box) { box = document.createElement('div'); box.id = 'statement-share-confirm'; body.appendChild(box); }
  box.innerHTML = `<hr><label>Confirma el número de WhatsApp de ${escapeHtml(report.client.nombre)}
    <input id="statement-share-phone" class="form-input" type="tel" value="${escapeHtml(report.client.telefonoFormateado || report.client.telefono || '')}"></label>
    <p>Vas a compartir información financiera. Verifica que el destinatario sea correcto antes de enviarla. El sistema no verifica que este teléfono tenga WhatsApp.</p>
    <label><input type="checkbox" id="statement-share-ok"> Confirmo que el número es del cliente</label>
    <button class="btn-primary" onclick="shareConfirmedClientStatement()">Preparar PDF para compartir</button>`;
  box.scrollIntoView({ block: 'nearest' });
}
async function shareConfirmedClientStatement() {
  try {
    if (!document.getElementById('statement-share-ok')?.checked) { showToast('Confirma que el número es del cliente.', 'warning'); return; }
    const phone = document.getElementById('statement-share-phone').value.trim();
    const normalized = ClienteTelefono.normalize(phone, phone.startsWith('+') && !phone.startsWith('+1') ? 'INT' : 'DO');
    if (!normalized.ok) { showToast(normalized.error, 'error'); return; }
    const doc = await buildClientStatementPdf(clientStatementReport);
    const file = new File([doc.output('blob')], 'Estado_de_cuenta.pdf', { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Estado de cuenta' });
    else {
      doc.save('Estado_de_cuenta.pdf');
      window.open(`https://wa.me/${normalized.value.replace(/\D/g, '')}?text=${encodeURIComponent('Le comparto su estado de cuenta en PDF.')}`, '_blank', 'noopener');
      showToast('Adjunta el PDF descargado al chat y revisa el destinatario antes de enviarlo.', 'info');
    }
  } catch (e) { if (e.name !== 'AbortError') showToast(e.message, 'error'); }
}

// ── Reporte general de clientes ─────────────────────────────────────────
const RECEIVABLE_ESTADOS = { sin_deuda: 'Sin deuda', al_dia: 'Al día', vencido: 'Vencido', sobre_limite: 'Sobre el límite' };
async function openClientReceivablesReport(branchId = '') {
  try {
    clientReceivablesReport = await api.request(`/api/clients/receivables-report${branchId ? `?branchId=${Number(branchId)}` : ''}`);
    const r = clientReceivablesReport;
    document.getElementById('modal-title').textContent = 'Reporte general de clientes';
    document.getElementById('modal-body').innerHTML = `<div class="modal-grid ec-filtros">
      <input id="receivables-search" class="form-input" placeholder="Nombre, cédula/RNC o teléfono" oninput="renderClientReceivablesReport()">
      <select id="receivables-status" class="form-input" onchange="renderClientReceivablesReport()">
        ${[['all', 'Todos'], ['debt', 'Con deuda'], ['nodebt', 'Sin deuda'], ['overdue', 'Vencidos'], ['limit', 'Con límite de crédito'], ['nolimit', 'Sin límite'], ['over', 'Sobre el límite']].map(([v, t]) => `<option value="${v}" ${v === 'debt' ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <select id="receivables-branch" class="form-input" onchange="openClientReceivablesReport(this.value)"><option value="">Todas las sucursales</option>
        ${(DB.sucursales || []).map((b) => `<option value="${Number(b.id)}" ${Number(b.id) === Number(r.branchId) ? 'selected' : ''}>${escapeHtml(b.nombre)}</option>`).join('')}</select></div>
      <div id="receivables-report-table"></div>`;
    document.getElementById('modal-footer').innerHTML = `<button class="btn-secondary" onclick="closeAllModals()">Cerrar</button><button class="btn-secondary" onclick="exportClientReceivablesReport('xlsx')">Excel</button><button class="btn-secondary" onclick="exportClientReceivablesReport('print')">Imprimir A4</button><button class="btn-primary" onclick="exportClientReceivablesReport('pdf')">PDF</button>`;
    document.getElementById('modal-overlay').classList.remove('hidden'); renderClientReceivablesReport();
  } catch (e) { showToast(e.message, 'error'); }
}
function filteredClientReceivables() {
  const search = String(document.getElementById('receivables-search')?.value || '').toLowerCase().replace(/[-\s()]/g, '');
  const state = document.getElementById('receivables-status')?.value || 'debt';
  const test = { all: () => true, debt: (c) => c.balance > 0, nodebt: (c) => !(c.balance > 0), overdue: (c) => c.vencido > 0, limit: (c) => !c.sinLimite, nolimit: (c) => c.sinLimite, over: (c) => c.estado === 'sobre_limite' }[state] || (() => true);
  return clientReceivablesReport.clientes.filter((c) => test(c) && (!search || `${c.nombre} ${c.rnc || ''} ${c.cedula || ''} ${c.telefono || ''}`.toLowerCase().replace(/[-\s()]/g, '').includes(search)));
}
function receivablesGrid(list) {
  return [['Cliente', 'Cédula / RNC', 'Teléfono', 'Dirección', 'Límite', 'Utilizado', 'Disponible', 'Pendiente', 'Fact. pend.', 'Fact. vencidas', 'Vencido', 'Último movimiento', 'Estado'],
    ...list.map((c) => [c.nombre, c.rnc || c.cedula || '', c.telefonoFormateado || c.telefono || '', c.direccion || '', c.sinLimite ? 'Sin límite' : c.limiteCredito, c.limiteUtilizado,
      c.limiteDisponible === null ? '—' : c.limiteDisponible, c.balance, c.facturasPendientes, c.facturasVencidas, c.vencido, String(c.ultimoMovimiento || '').slice(0, 19), RECEIVABLE_ESTADOS[c.estado] || c.estado])];
}
function renderClientReceivablesReport() {
  const list = filteredClientReceivables();
  const total = list.reduce((n, c) => n + PosMoney.cents(c.balance), 0n);
  const vencido = list.reduce((n, c) => n + PosMoney.cents(c.vencido), 0n);
  const r = clientReceivablesReport;
  document.getElementById('receivables-report-table').innerHTML = `<p>${list.length} de ${r.totalClientes} clientes · Por cobrar: <strong>${fmt(PosMoney.number(total))}</strong> · Vencido: <strong>${fmt(PosMoney.number(vencido))}</strong> · Fecha de corte ${escapeHtml(r.fechaCorte)}</p>
    <div style="overflow:auto;max-height:55vh"><table class="data-table"><thead><tr><th>Cliente</th><th>Teléfono</th><th>Límite</th><th>Utilizado</th><th>Disponible</th><th>Pendiente</th><th>Fact. pend.</th><th>Vencidas</th><th>Vencido</th><th>Último movimiento</th><th>Estado</th></tr></thead><tbody>${list.map((c) => `<tr>
      <td><button class="btn-ghost" onclick="openClientStatement(${Number(c.id)})">${escapeHtml(c.nombre)}</button><br><small>${escapeHtml(c.rnc || c.cedula || '')}</small></td>
      <td>${escapeHtml(c.telefonoFormateado || c.telefono || '')}</td><td>${c.sinLimite ? 'Sin límite' : fmt(c.limiteCredito)}</td><td>${fmt(c.limiteUtilizado)}</td>
      <td>${c.limiteDisponible === null ? '—' : fmt(c.limiteDisponible)}</td><td>${fmt(c.balance)}</td><td>${c.facturasPendientes}</td><td>${c.facturasVencidas}</td><td>${fmt(c.vencido)}</td>
      <td>${escapeHtml(String(c.ultimoMovimiento || '').slice(0, 19))}</td><td>${escapeHtml(RECEIVABLE_ESTADOS[c.estado] || c.estado)}</td></tr>`).join('') || '<tr><td colspan="11">Sin resultados.</td></tr>'}</tbody></table></div>`;
}
async function exportClientReceivablesReport(format) {
  try {
    const list = filteredClientReceivables(), grid = receivablesGrid(list), r = clientReceivablesReport, neg = statementBusiness();
    const total = PosMoney.number(list.reduce((n, c) => n + PosMoney.cents(c.balance), 0n));
    if (format === 'xlsx') {
      await VendorLoader.load('xlsx'); const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[neg.nombre], ['Reporte general de clientes'], [`Fecha de corte ${r.fechaCorte}`], [`Clientes ${list.length} · Por cobrar ${total}`], [], ...grid]), 'Clientes');
      XLSX.writeFile(book, `Reporte_clientes_${r.fechaCorte}.xlsx`); return;
    }
    await VendorLoader.load('jspdf'); const doc = new jspdf.jsPDF({ orientation: 'landscape', format: 'a4' });
    const widths = [40, 24, 22, 30, 18, 18, 18, 18, 12, 12, 18, 26, 20];
    let y = 14;
    const head = () => { doc.setFontSize(13); doc.text(`${neg.nombre} · Reporte general de clientes`, 10, y); doc.setFontSize(9);
      doc.text(`Fecha de corte ${r.fechaCorte} · ${list.length} clientes · Por cobrar ${fmt(total)}`, 10, y + 5); y += 11; };
    head();
    grid.forEach((row, i) => {
      doc.setFont('helvetica', i === 0 ? 'bold' : 'normal'); doc.setFontSize(7);
      const lines = row.map((v, j) => doc.splitTextToSize(typeof v === 'number' && j !== 8 && j !== 9 ? fmt(v) : String(v ?? ''), widths[j] - 1));
      const h = Math.max(...lines.map((a) => a.length)) * 3.2 + 2;
      if (y + h > 198) { doc.addPage(); y = 14; head(); }
      let x = 10; lines.forEach((v, j) => { doc.text(v, x, y); x += widths[j]; }); y += h;
    });
    if (format === 'print') { doc.autoPrint(); window.open(doc.output('bloburl'), '_blank'); } else doc.save(`Reporte_clientes_${r.fechaCorte}.pdf`);
  } catch (e) { showToast(e.message, 'error'); }
}

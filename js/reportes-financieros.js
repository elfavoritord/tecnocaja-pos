let businessFinanceReport = null;
async function openLegalTipReport() {
  businessFinanceReport = { title: 'Propinas legales · recaudación', endpoint: '/api/reports/legal-tips',
    columns: [['fecha','Fecha'],['factura','Factura'],['sucursal','Sucursal'],['cajero','Cajero'],['mesero','Mesero'],['propina','Facturada'],['cobrada','Cobrada'],['pendiente','Pendiente']] };
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('modal-title').textContent = businessFinanceReport.title;
  document.getElementById('modal-body').innerHTML = `<div id="finance-report" class="modal-grid">
    <label>Desde<input type="date" id="finance-from" class="form-input" value="${today.slice(0,8)}01"></label>
    <label>Hasta<input type="date" id="finance-to" class="form-input" value="${today}"></label>
    <label>Sucursal<select id="finance-branch" class="form-input"><option value="">Todas las permitidas</option>${(DB.sucursales || []).map(b => `<option value="${Number(b.id)}">${escapeHtml(b.nombre)}</option>`).join('')}</select></label>
    <label>Cajero<select id="finance-user" class="form-input"><option value="">Todos</option>${(DB.users || []).map(u => `<option value="${Number(u.id)}">${escapeHtml(u.nombre)}</option>`).join('')}</select></label>
    <label>Mesero<input id="finance-waiter" class="form-input" placeholder="Nombre exacto (opcional)"></label>
    <button class="btn-secondary" onclick="loadBusinessFinanceReport()">Consultar</button></div><div id="finance-report-results"></div>`;
  document.getElementById('modal-footer').innerHTML = '<button class="btn-secondary" onclick="closeAllModals()">Cerrar</button><button class="btn-secondary" onclick="exportBusinessFinanceReport(\'xlsx\')">Excel</button><button class="btn-secondary" onclick="exportBusinessFinanceReport(\'print\')">Imprimir A4</button><button class="btn-primary" onclick="exportBusinessFinanceReport(\'pdf\')">PDF</button>';
  document.getElementById('modal-overlay').classList.remove('hidden');
  await loadBusinessFinanceReport();
}
async function loadBusinessFinanceReport() {
  try {
    const qs = new URLSearchParams({desde: document.getElementById('finance-from').value, hasta: document.getElementById('finance-to').value,
      branchId: document.getElementById('finance-branch').value, cashierId: document.getElementById('finance-user').value, waiter: document.getElementById('finance-waiter').value});
    const data = await api.request(businessFinanceReport.endpoint + '?' + qs);
    businessFinanceReport.data = data;
    const cols = businessFinanceReport.columns;
    document.getElementById('finance-report-results').innerHTML = `<p>Propina facturada: <strong>${fmt(data.totals.propina)}</strong> · Cobrada: <strong>${fmt(data.totals.cobrada)}</strong> · Pendiente: <strong>${fmt(data.totals.pendiente)}</strong></p>
      <p>Recaudación registrada; la propina se mantiene separada del ITBIS. Este reporte no reparte pagos a empleados.</p>
      ${data.quitadas?.ventas ? `<p>Ventas en que se quitó la propina al cobrar: <strong>${data.quitadas.ventas}</strong> · propina no cobrada <strong>${fmt(data.quitadas.monto)}</strong>
        (${data.quitadas.detalle.slice(0, 10).map((q) => `${escapeHtml(q.factura)} por ${escapeHtml(q.cajero || '—')}`).join(', ')}${data.quitadas.ventas > 10 ? ', …' : ''}).</p>` : ''}
      <div style="max-height:55vh;overflow:auto"><table class="data-table"><thead><tr>${cols.map(c=>`<th>${escapeHtml(c[1])}</th>`).join('')}</tr></thead><tbody>${data.rows.map(r => `<tr>${cols.map(c => `<td>${escapeHtml(typeof r[c[0]] === 'number' ? fmt(r[c[0]]) : String(r[c[0]] || ''))}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="8">Sin movimientos.</td></tr>'}</tbody></table></div>`;
  } catch (e) { showToast(e.message,'error'); }
}
async function exportBusinessFinanceReport(format) {
  try {
    const report = businessFinanceReport;
    if (!report?.data) return;
    const grid = [report.columns.map(c=>c[1]),...report.data.rows.map(r=>report.columns.map(c=>r[c[0]] ?? ''))];
    const file = 'Propinas_legales';
    if (format === 'xlsx') {
      await VendorLoader.load('xlsx'); const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[report.title],[`Período ${report.data.desde} a ${report.data.hasta}`],...grid]),'Recaudación');
      XLSX.writeFile(book,file+'.xlsx'); return;
    }
    await VendorLoader.load('jspdf'); const doc = new jspdf.jsPDF({orientation:'landscape',format:'a4'});
    let y = 16; doc.setFontSize(15); doc.text(report.title,12,y); y+=8;
    doc.setFontSize(9); doc.text(`Período ${report.data.desde} a ${report.data.hasta} · Cobrada: ${fmt(report.data.totals.cobrada)}`,12,y); y+=10;
    const width = 272/report.columns.length;
    for (const row of grid) {
      doc.setFontSize(8); const lines = row.map(v=>doc.splitTextToSize(typeof v==='number'?fmt(v):String(v),width-3));
      const h = Math.max(...lines.map(a=>a.length))*4+4;
      if (y+h>194) {doc.addPage();y=16;}
      lines.forEach((v,i)=>doc.text(v,12+i*width,y));y+=h;
    }
    if(format==='print'){doc.autoPrint();window.open(doc.output('bloburl'),'_blank');}else doc.save(file+'.pdf');
  } catch(e){showToast(e.message,'error');}
}

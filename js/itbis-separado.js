// ITBIS separado por tipo de documento (mejora 7), dentro de Reportes → DGII.
// Los montos los calcula /api/reports/itbis-separado; aquí solo se muestran y
// se exportan. Cada venta cuenta una vez; la propina legal va aparte.
(function () {
  'use strict';
  const state = { vista: 'tickets', data: null };
  const esc = (v) => (typeof escapeHtml === 'function' ? escapeHtml(String(v ?? '')) : String(v ?? ''));
  const money = (v) => (typeof fmt === 'function' ? fmt(Number(v || 0)) : `RD$ ${Number(v || 0).toFixed(2)}`);
  const toast = (m, t = 'info') => (typeof showToast === 'function' ? showToast(m, t) : console.log(m));
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const VISTAS = { tickets: 'Tickets internos / no electrónicos', ecf: 'Facturas electrónicas e-CF', consolidado: 'Consolidado general' };
  const ETIQUETA_CLASE = { ticket: 'Ticket interno (sin e-CF)', ncf: 'Comprobante serie B', ecf: 'e-CF' };

  function periodo(p) {
    const hoy = new Date();
    const dias = (k) => new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - k);
    if (p === 'hoy') return [ymd(hoy), ymd(hoy)];
    if (p === 'ayer') return [ymd(dias(1)), ymd(dias(1))];
    if (p === '7') return [ymd(dias(6)), ymd(hoy)];
    if (p === '30') return [ymd(dias(29)), ymd(hoy)];
    if (p === 'mes') return [ymd(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), ymd(hoy)];
    return null;
  }

  function montar() {
    const box = document.getElementById('itbis-separado');
    if (!box || box.dataset.listo) return;
    box.dataset.listo = '1';
    const [d, h] = periodo('mes');
    box.innerHTML = `
      <div class="repv2-panel-head" style="margin:1.5rem 0 0.75rem"><div><h3>ITBIS por tipo de documento</h3>
        <p>Tickets internos, comprobantes electrónicos y consolidado, sin duplicar operaciones. La propina legal no se suma al ITBIS.</p></div></div>
      <div class="itbis-sep-filtros">
        <label>Período<select id="isp-periodo" class="form-input" onchange="ItbisSeparado.cambiarPeriodo(this.value)">
          <option value="hoy">Hoy</option><option value="ayer">Ayer</option><option value="7">Últimos 7 días</option><option value="30">Últimos 30 días</option>
          <option value="mes" selected>Este mes</option><option value="custom">Personalizado</option></select></label>
        <label>Desde<input type="date" id="isp-desde" class="form-input" value="${d}"></label>
        <label>Hasta<input type="date" id="isp-hasta" class="form-input" value="${h}"></label>
        <label>Sucursal<select id="isp-sucursal" class="form-input"><option value="">Todas las permitidas</option>${(DB.sucursales || []).map((b) => `<option value="${Number(b.id)}">${esc(b.nombre)}</option>`).join('')}</select></label>
        <label>Caja<select id="isp-caja" class="form-input"><option value="">Todas</option>${(DB.cajasSucursal || []).map((c) => `<option value="${Number(c.id)}">${esc(c.nombre)}</option>`).join('')}</select></label>
        <label>Usuario<select id="isp-usuario" class="form-input"><option value="">Todos</option>${(DB.users || []).map((u) => `<option value="${Number(u.id)}">${esc(u.nombre)}</option>`).join('')}</select></label>
        <button class="btn-primary" type="button" onclick="ItbisSeparado.cargar()">Consultar</button>
      </div>
      <div class="itbis-sep-tabs" role="tablist">${Object.entries(VISTAS).map(([k, t]) => `<button type="button" role="tab" class="repv2-subtab${k === state.vista ? ' active' : ''}" data-vista="${k}" onclick="ItbisSeparado.vista('${k}')">${t}</button>`).join('')}</div>
      <div id="isp-contenido"><p class="text-muted">Pulsa Consultar para ver el ITBIS del período.</p></div>
      <div class="itbis-sep-acciones">
        <button class="repv2-btn-export" onclick="ItbisSeparado.exportar('pdf','tickets')">PDF solo tickets</button>
        <button class="repv2-btn-export" onclick="ItbisSeparado.exportar('pdf','ecf')">PDF solo e-CF</button>
        <button class="repv2-btn-export" onclick="ItbisSeparado.exportar('pdf','todos')">PDF ambos + consolidado</button>
        <button class="repv2-btn-export" onclick="ItbisSeparado.exportar('print','todos')">Imprimir A4</button>
        <button class="repv2-btn-export" onclick="ItbisSeparado.exportar('xlsx','todos')">Excel</button>
        <button class="repv2-btn-export" onclick="ItbisSeparado.termico()">Resumen térmico</button>
      </div>`;
  }

  function cambiarPeriodo(p) {
    const r = periodo(p);
    if (!r) return;
    document.getElementById('isp-desde').value = r[0];
    document.getElementById('isp-hasta').value = r[1];
    cargar();
  }

  async function cargar() {
    montar();
    const box = document.getElementById('isp-contenido');
    try {
      const qs = new URLSearchParams({ desde: document.getElementById('isp-desde').value, hasta: document.getElementById('isp-hasta').value,
        branchId: document.getElementById('isp-sucursal').value, cashRegisterId: document.getElementById('isp-caja').value, userId: document.getElementById('isp-usuario').value });
      box.innerHTML = '<p class="text-muted">Calculando…</p>';
      state.data = await api.request(`/api/reports/itbis-separado?${qs}`);
      pintar();
    } catch (e) { box.innerHTML = `<p class="inline-form-alert">${esc(e.message)}</p>`; }
  }

  function vista(k) {
    state.vista = k;
    document.querySelectorAll('.itbis-sep-tabs [data-vista]').forEach((b) => b.classList.toggle('active', b.dataset.vista === k));
    pintar();
  }

  function kpis(v) {
    return [['Operaciones', String(v.operaciones)], ['Total de ventas', money(v.total)], ['Base gravada', money(v.gravada)], ['Base exenta', money(v.exenta)],
      ['ITBIS facturado', money(v.itbis)], ['Ajustes (notas de crédito / anulaciones)', `- ${money(v.ajustes.itbis)}`], ['ITBIS neto', money(v.itbisNeto)],
      ['Descuentos', money(v.descuentos)], ['Propina legal (aparte)', money(v.propinaLegal)]];
  }
  const tarjetas = (filas, destacar = 'ITBIS neto') => `<div class="itbis-sep-kpis">${filas.map(([l, v]) => `<div class="${l === destacar ? 'destacado' : ''}"><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>`;

  function seccionVista(k) {
    const d = state.data;
    if (k === 'tickets') {
      const t = d.tickets;
      return `${d.regularizacion.aviso ? `<div class="tc-notice tc-notice--warning itbis-sep-aviso">${esc(d.regularizacion.aviso)}</div>` : ''}
        ${tarjetas(kpis(t))}
        <div class="itbis-sep-sub"><div><h4>Tickets internos (sin e-CF)</h4>${tarjetas(kpis(t.ticketsInternos).slice(0, 7))}</div>
        <div><h4>Comprobantes tradicionales serie B</h4>${tarjetas(kpis(t.comprobantesSerieB).slice(0, 7))}</div></div>
        <p class="itbis-sep-nota">${esc(t.nota)}</p>`;
    }
    if (k === 'ecf') {
      const e = d.ecf;
      return `${tarjetas(kpis(e))}
        <div class="itbis-sep-estados">
          <div><span>Pendientes de respuesta DGII</span><strong>${e.pendientes.operaciones} · ITBIS ${money(e.pendientes.itbis)}</strong></div>
          <div><span>Contingencia</span><strong>${e.contingencia.operaciones} · ITBIS ${money(e.contingencia.itbis)}</strong></div>
          <div class="rechazo"><span>Rechazados (no se suman)</span><strong>${e.rechazados.operaciones} · ITBIS ${money(e.rechazados.itbis)}</strong></div>
        </div><p class="itbis-sep-nota">${esc(e.nota)}</p>`;
    }
    const c = d.consolidado;
    return `${tarjetas(kpis(c))}
      <div class="itbis-sep-estados">
        <div><span>No electrónico (tickets + serie B)</span><strong>ITBIS neto ${money(d.tickets.itbisNeto)}</strong></div>
        <div><span>e-CF (aceptados + pendientes)</span><strong>ITBIS neto ${money(d.ecf.itbisNeto)}</strong></div>
        <div class="rechazo"><span>e-CF rechazados excluidos</span><strong>${c.rechazadosExcluidos.operaciones} · ${money(c.rechazadosExcluidos.total)}</strong></div>
      </div><p class="itbis-sep-nota">${esc(c.nota)}</p>`;
  }

  function filasDetalle(k) {
    const d = state.data;
    return d.detalle.filter((r) => k === 'consolidado' || k === 'todos' || (k === 'tickets' ? r.clase !== 'ecf' : r.clase === 'ecf'));
  }
  function filasAjustes(k) {
    const d = state.data;
    return d.ajustesDetalle.filter((r) => k === 'consolidado' || k === 'todos' || (k === 'tickets' ? r.clase !== 'ecf' : r.clase === 'ecf'));
  }

  function pintar() {
    const box = document.getElementById('isp-contenido');
    if (!box || !state.data) return;
    const k = state.vista;
    const det = filasDetalle(k), aj = filasAjustes(k);
    box.innerHTML = `${seccionVista(k)}
      <h4>Detalle de operaciones (${det.length})</h4>
      <div class="repv2-table-wrap itbis-sep-tabla"><table class="repv2-table"><thead><tr><th>Fecha</th><th>Documento</th><th>Tipo</th><th>Estado</th><th>Cajero</th><th>Total</th><th>Gravado</th><th>Exento</th><th>ITBIS</th><th>Propina</th></tr></thead><tbody>
      ${det.slice(0, 1500).map((r) => `<tr><td>${esc(r.fecha)}</td><td>${esc(r.documento)}</td><td>${esc(ETIQUETA_CLASE[r.clase])}</td><td>${esc(r.estado)}</td><td>${esc(r.cajero)}</td>
        <td>${money(r.total)}</td><td>${money(r.gravada)}</td><td>${money(r.exenta)}</td><td>${money(r.itbis)}</td><td>${money(r.propinaLegal)}</td></tr>`).join('') || '<tr><td colspan="10">Sin operaciones.</td></tr>'}
      </tbody></table></div>
      ${aj.length ? `<h4>Ajustes del período (${aj.length})</h4><div class="repv2-table-wrap"><table class="repv2-table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Factura</th><th>Documento</th><th>Base</th><th>ITBIS</th><th>Propina</th><th>Total</th></tr></thead><tbody>
        ${aj.map((a) => `<tr><td>${esc(a.fecha)}</td><td>${esc(a.tipo)}</td><td>${esc(a.factura)}</td><td>${esc(a.documento)}</td><td>${money(a.base)}</td><td>${money(a.itbis)}</td><td>${money(a.propinaLegal)}</td><td>${money(a.total)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  }

  function bloquesExport(alcance) {
    const d = state.data;
    const bloques = [];
    if (alcance === 'tickets' || alcance === 'todos') bloques.push(['Tickets internos / no electrónicos', d.tickets, 'tickets']);
    if (alcance === 'ecf' || alcance === 'todos') bloques.push(['Facturas electrónicas e-CF', d.ecf, 'ecf']);
    if (alcance === 'todos') bloques.push(['Consolidado general', d.consolidado, 'consolidado']);
    return bloques;
  }

  async function exportar(formato, alcance) {
    if (!state.data) { await cargar(); if (!state.data) return; }
    const d = state.data;
    const negocio = DB.config?.nombre || DB.config?.businessName || 'Tecno Caja';
    const nombre = `ITBIS_${alcance}_${d.desde}_${d.hasta}`;
    try {
      if (formato === 'xlsx') {
        await VendorLoader.load('xlsx');
        const book = XLSX.utils.book_new();
        for (const [titulo, v, k] of bloquesExport(alcance)) {
          const filas = [[`${negocio} · ${titulo}`], [`Período ${d.desde} a ${d.hasta}`], [], ...kpis(v).map(([l, x]) => [l, x]), [],
            ['Fecha', 'Documento', 'Tipo', 'Estado', 'Cajero', 'Total', 'Gravado', 'Exento', 'ITBIS', 'Propina'],
            ...filasDetalle(k).map((r) => [r.fecha, r.documento, ETIQUETA_CLASE[r.clase], r.estado, r.cajero, r.total, r.gravada, r.exenta, r.itbis, r.propinaLegal])];
          XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(filas), titulo.slice(0, 30).replace(/[\\/?*[\]:]/g, ' '));
        }
        if (d.ajustesDetalle.length) {
          XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Fecha', 'Tipo', 'Factura', 'Documento', 'Clase', 'Base', 'ITBIS', 'Propina', 'Total'],
            ...filasAjustes(alcance === 'todos' ? 'todos' : alcance).map((a) => [a.fecha, a.tipo, a.factura, a.documento, ETIQUETA_CLASE[a.clase], a.base, a.itbis, a.propinaLegal, a.total])]), 'Ajustes');
        }
        XLSX.writeFile(book, `${nombre}.xlsx`);
        return;
      }
      await VendorLoader.load('jspdf');
      const doc = new jspdf.jsPDF({ orientation: 'landscape', format: 'a4' });
      let y = 14;
      const nueva = () => { doc.addPage(); y = 14; };
      doc.setFontSize(14); doc.text(`${negocio} · ITBIS por tipo de documento`, 10, y); y += 6;
      doc.setFontSize(9); doc.text(`Período ${d.desde} a ${d.hasta}. Reporte orientativo: no sustituye la emisión ni la declaración ante la DGII.`, 10, y); y += 8;
      if (d.regularizacion.aviso && alcance !== 'ecf') { doc.setTextColor(150, 80, 0); doc.text(doc.splitTextToSize(d.regularizacion.aviso, 275), 10, y); doc.setTextColor(0); y += 10; }
      const widths = [32, 44, 40, 34, 34, 22, 22, 22, 20, 18];
      for (const [titulo, v, k] of bloquesExport(alcance)) {
        if (y > 170) nueva();
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(titulo, 10, y); y += 6;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
        kpis(v).forEach(([l, x], i) => { doc.text(`${l}: ${x}`, 10 + (i % 3) * 92, y + Math.floor(i / 3) * 5); });
        y += Math.ceil(kpis(v).length / 3) * 5 + 4;
        const filas = [['Fecha', 'Documento', 'Tipo', 'Estado', 'Cajero', 'Total', 'Gravado', 'Exento', 'ITBIS', 'Propina'],
          ...filasDetalle(k).map((r) => [r.fecha, r.documento, ETIQUETA_CLASE[r.clase], r.estado, r.cajero, money(r.total), money(r.gravada), money(r.exenta), money(r.itbis), money(r.propinaLegal)])];
        filas.forEach((row, i) => {
          doc.setFont('helvetica', i === 0 ? 'bold' : 'normal'); doc.setFontSize(7);
          if (y > 195) nueva();
          let x = 10;
          row.forEach((cell, j) => { doc.text(doc.splitTextToSize(String(cell ?? ''), widths[j] - 1)[0] || '', x, y); x += widths[j]; });
          y += 4;
        });
        y += 6;
      }
      if (formato === 'print') { doc.autoPrint(); window.open(doc.output('bloburl'), '_blank'); } else doc.save(`${nombre}.pdf`);
    } catch (e) { toast(e.message, 'error'); }
  }

  // Resumen en impresora térmica (mismo formato por secciones que el cierre).
  async function termico() {
    if (!state.data) { await cargar(); if (!state.data) return; }
    const d = state.data;
    const settings = typeof _resolveCortePrintSettings === 'function' ? await _resolveCortePrintSettings() : {};
    if (!(window.novaDesktop?.printCorteEscpos && settings.printerName && settings.isThermal)) { toast('Configura una impresora térmica para el resumen.', 'warning'); return; }
    const sec = (titulo, v) => ({ titulo, filas: kpis(v).slice(0, 7).map(([l, x]) => ({ etiqueta: l, valor: x })) });
    const r = await window.novaDesktop.printCorteEscpos({
      negocio: { nombre: DB.config?.nombre || DB.config?.businessName || 'Tecno Caja', rnc: DB.config?.rnc || '' }, titulo: `ITBIS ${d.desde} a ${d.hasta}`,
      secciones: [sec('No electrónico', d.tickets), sec('e-CF', d.ecf), sec('Consolidado', d.consolidado)], corte: {},
      config: { paperWidth: settings.paperWidth, cortarPapel: true, currency: settings.currency || 'RD$' },
    }, { printerName: settings.printerName, paperWidth: settings.paperWidth });
    toast(r?.ok ? 'Resumen enviado a la impresora.' : (r?.error || 'No se pudo imprimir.'), r?.ok ? 'success' : 'error');
  }

  window.ItbisSeparado = { montar, cargar, vista, cambiarPeriodo, exportar, termico };
})();

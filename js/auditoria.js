// Visor de auditoría global (mejora 5): filtros, detalle con antes/después,
// paginación y exportación. Solo lectura — /api/auditoria decide el alcance
// (administrador general: todo; administrador de sucursal: su sucursal).
(function () {
  'use strict';
  const state = { page: 1, data: null, filtros: {} };
  const esc = (v) => (typeof escapeHtml === 'function' ? escapeHtml(String(v ?? '')) : String(v ?? ''));
  const money = (v) => (typeof fmt === 'function' ? fmt(Number(v || 0)) : Number(v || 0).toFixed(2));
  const toast = (m, t = 'info') => (typeof showToast === 'function' ? showToast(m, t) : console.log(m));
  const fechaLocal = (v) => {
    if (!v) return '';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString('es-DO', { timeZone: 'America/Santo_Domingo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const RESULTADOS = [['', 'Todos'], ['exito', 'Éxito'], ['diferencia', 'Con diferencia'], ['pendiente', 'Pendiente'], ['rechazado', 'Rechazado'], ['error', 'Error'], ['denegado', 'Denegado']];

  function abrir() {
    const hoy = new Date(), hace7 = new Date(Date.now() - 6 * 86400000);
    document.getElementById('modal-title').textContent = 'Auditoría del negocio';
    document.getElementById('modal-body').innerHTML = `<div class="aud-modal">
      <div class="aud-filtros">
        <label>Desde<input type="date" id="aud-desde" class="form-input" value="${ymd(hace7)}"></label>
        <label>Hasta<input type="date" id="aud-hasta" class="form-input" value="${ymd(hoy)}"></label>
        <label>Usuario<input type="text" id="aud-usuario" class="form-input" placeholder="Nombre"></label>
        <label>Módulo<select id="aud-modulo" class="form-input"><option value="">Todos</option></select></label>
        <label>Resultado<select id="aud-resultado" class="form-input">${RESULTADOS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
        <label>Sucursal<select id="aud-sucursal" class="form-input"><option value="">Todas las permitidas</option>${(DB.sucursales || []).map((b) => `<option value="${Number(b.id)}">${esc(b.nombre)}</option>`).join('')}</select></label>
        <label>Caja<select id="aud-caja" class="form-input"><option value="">Todas</option>${(DB.cajasSucursal || []).map((c) => `<option value="${Number(c.id)}">${esc(c.nombre)}</option>`).join('')}</select></label>
        <label>Factura / documento<input type="text" id="aud-documento" class="form-input" placeholder="FAC-, NCF, e-NCF…"></label>
        <label>Cliente<input type="text" id="aud-cliente" class="form-input" list="aud-clientes" placeholder="Nombre del cliente"><datalist id="aud-clientes">${(DB.clientes || []).slice(0, 2000).map((c) => `<option value="${esc(c.nombre)}">`).join('')}</datalist></label>
        <label>Producto / texto<input type="text" id="aud-texto" class="form-input" placeholder="Producto, motivo, acción…"></label>
        <label class="aud-check"><input type="checkbox" id="aud-criticos"> Solo eventos críticos</label>
        <button class="btn-primary" type="button" onclick="Auditoria.buscar(1)">Buscar</button>
      </div>
      <div id="aud-resultado-lista"><p class="text-muted">Cargando…</p></div>
    </div>`;
    document.getElementById('modal-footer').innerHTML = `<button class="btn-secondary" onclick="closeAllModals()">Cerrar</button>
      <button class="btn-secondary" onclick="Auditoria.exportar('xlsx')">Excel</button>
      <button class="btn-secondary" onclick="Auditoria.exportar('print')">Imprimir</button>
      <button class="btn-primary" onclick="Auditoria.exportar('pdf')">PDF</button>`;
    document.getElementById('modal-overlay').classList.remove('hidden');
    buscar(1);
  }

  function leerFiltros() {
    const v = (id) => String(document.getElementById(id)?.value || '').trim();
    const clienteNombre = v('aud-cliente').toLowerCase();
    const cliente = clienteNombre ? (DB.clientes || []).find((c) => String(c.nombre || '').toLowerCase() === clienteNombre) : null;
    return { desde: v('aud-desde'), hasta: v('aud-hasta'), usuario: v('aud-usuario'), modulo: v('aud-modulo'), resultado: v('aud-resultado'),
      branchId: v('aud-sucursal'), cashRegisterId: v('aud-caja'), documento: v('aud-documento'), texto: v('aud-texto') || (clienteNombre && !cliente ? clienteNombre : ''),
      clientId: cliente ? String(cliente.id) : '', criticos: document.getElementById('aud-criticos')?.checked ? '1' : '' };
  }

  async function consultar(filtros, page, pageSize = 100) {
    const qs = new URLSearchParams(Object.entries({ ...filtros, page, pageSize }).filter(([, v]) => v !== '' && v !== undefined && v !== null));
    return api.request(`/api/auditoria?${qs}`);
  }

  async function buscar(page = 1) {
    const box = document.getElementById('aud-resultado-lista');
    try {
      state.filtros = leerFiltros();
      state.page = page;
      const data = await consultar(state.filtros, page);
      state.data = data;
      const sel = document.getElementById('aud-modulo');
      if (sel && sel.options.length <= 1) sel.innerHTML = '<option value="">Todos</option>' + data.modulos.map((m) => `<option ${m === state.filtros.modulo ? 'selected' : ''}>${esc(m)}</option>`).join('');
      box.innerHTML = `<p class="aud-resumen">${data.total} evento(s) · página ${data.page} de ${data.paginas}. Fecha y hora mostradas en hora de República Dominicana.</p>
        <div class="aud-tabla"><table class="data-table"><thead><tr><th>Fecha</th><th>Usuario</th><th>Módulo</th><th>Acción</th><th>Resultado</th><th>Referencia</th><th>Monto</th><th>Detalle</th></tr></thead><tbody>
        ${data.eventos.map((e, i) => `<tr class="${e.critico ? 'aud-critico' : ''}" onclick="Auditoria.detalle(${i})" tabindex="0" onkeydown="if(event.key==='Enter')Auditoria.detalle(${i})">
          <td>${esc(fechaLocal(e.fecha))}</td><td>${esc(e.usuario)}<br><small>${esc(e.rol)}</small></td><td>${esc(e.modulo)}</td><td>${esc(e.accion)}</td>
          <td><span class="aud-res aud-res--${esc(e.resultado)}">${esc(e.resultado)}</span></td><td>${esc(e.referencia)}</td>
          <td>${e.monto === null ? '' : esc(money(e.monto))}</td><td class="aud-det">${esc(String(e.detalle || '').slice(0, 160))}</td></tr>`).join('') || '<tr><td colspan="8">Sin eventos con estos filtros.</td></tr>'}
        </tbody></table></div>
        <div class="aud-paginas">
          <button class="btn-secondary" ${data.page <= 1 ? 'disabled' : ''} onclick="Auditoria.buscar(${data.page - 1})">Anterior</button>
          <button class="btn-secondary" ${data.page >= data.paginas ? 'disabled' : ''} onclick="Auditoria.buscar(${data.page + 1})">Siguiente</button>
        </div>`;
    } catch (e) {
      if (box) box.innerHTML = `<p class="inline-form-alert">${esc(e.message)}</p>`;
    }
  }

  function bloqueJson(titulo, valor) {
    if (valor === null || valor === undefined) return '';
    return `<h4>${esc(titulo)}</h4><pre class="aud-json">${esc(JSON.stringify(valor, null, 2))}</pre>`;
  }

  function detalle(i) {
    const e = state.data?.eventos?.[i];
    if (!e) return;
    const filas = [['Identificador', e.eventId || `#${e.id}`], ['Fecha (RD)', fechaLocal(e.fecha)], ['Usuario', `${e.usuario} · ${e.rol}`], ['Módulo', e.modulo],
      ['Acción', e.accion], ['Resultado', e.resultado], ['Motivo', e.motivo], ['Referencia', e.referencia], ['Documento', e.documento],
      ['Monto', e.monto === null ? '' : money(e.monto)], ['Método de pago', e.metodoPago], ['Sucursal', e.sucursalId], ['Caja', e.cajaId],
      ['Turno de caja', e.sesionCajaId], ['Cliente', e.clienteId], ['Equipo', e.dispositivo], ['Empresa', e.empresaId]].filter(([, v]) => v !== null && v !== undefined && v !== '');
    let box = document.getElementById('aud-detalle');
    if (!box) {
      box = document.createElement('div');
      box.id = 'aud-detalle';
      box.className = 'aud-detalle';
      document.body.appendChild(box);
    }
    box.innerHTML = `<div class="aud-detalle-card" role="dialog" aria-modal="true" aria-label="Detalle del evento">
      <div class="aud-detalle-head"><h3>${esc(e.accion)}</h3><button class="btn-secondary" onclick="document.getElementById('aud-detalle').remove()">Cerrar</button></div>
      ${filas.map(([k, v]) => `<div class="aud-fila"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}
      <h4>Detalle</h4><p>${esc(e.detalle)}</p>
      ${bloqueJson('Antes', e.antes)}${bloqueJson('Después', e.despues)}
      <p class="text-muted">Los eventos no se editan: una corrección queda como un evento nuevo.</p></div>`;
  }

  async function todos() {
    const filas = [];
    for (let page = 1; page <= 20; page += 1) {
      const data = await consultar(state.filtros, page, 500);
      filas.push(...data.eventos);
      if (page >= data.paginas) break;
    }
    return filas;
  }

  async function exportar(formato) {
    try {
      const eventos = await todos();
      const grid = [['Fecha (RD)', 'Identificador', 'Usuario', 'Rol', 'Módulo', 'Acción', 'Resultado', 'Referencia', 'Monto', 'Sucursal', 'Caja', 'Turno', 'Equipo', 'Motivo', 'Detalle'],
        ...eventos.map((e) => [fechaLocal(e.fecha), e.eventId || e.id, e.usuario, e.rol, e.modulo, e.accion, e.resultado, e.referencia, e.monto ?? '', e.sucursalId || '', e.cajaId || '', e.sesionCajaId || '', e.dispositivo, e.motivo, e.detalle])];
      const nombre = `Auditoria_${state.filtros.desde || 'inicio'}_${state.filtros.hasta || 'hoy'}`;
      if (formato === 'xlsx') {
        await VendorLoader.load('xlsx');
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[`Auditoría · ${DB.config?.nombre || DB.config?.businessName || ''}`], [`Período ${state.filtros.desde} a ${state.filtros.hasta}`], ...grid]), 'Auditoría');
        XLSX.writeFile(book, `${nombre}.xlsx`);
        return;
      }
      await VendorLoader.load('jspdf');
      const doc = new jspdf.jsPDF({ orientation: 'landscape', format: 'a4' });
      const cols = [0, 2, 4, 5, 6, 7, 8, 14];
      const widths = [32, 34, 26, 44, 20, 30, 20, 71];
      let y = 14;
      doc.setFontSize(13); doc.text(`Auditoría · ${DB.config?.nombre || DB.config?.businessName || ''}`, 10, y); y += 6;
      doc.setFontSize(9); doc.text(`Período ${state.filtros.desde} a ${state.filtros.hasta} · ${eventos.length} evento(s)${state.filtros.criticos ? ' · solo críticos' : ''}`, 10, y); y += 7;
      grid.forEach((row, i) => {
        doc.setFont('helvetica', i === 0 ? 'bold' : 'normal'); doc.setFontSize(7);
        const lines = cols.map((c, j) => doc.splitTextToSize(c === 8 && row[c] !== '' && i > 0 ? money(row[c]) : String(row[c] ?? ''), widths[j] - 1));
        const h = Math.max(...lines.map((l) => l.length)) * 3.2 + 2;
        if (y + h > 200) { doc.addPage(); y = 14; }
        let x = 10;
        lines.forEach((l, j) => { doc.text(l, x, y); x += widths[j]; });
        y += h;
      });
      if (formato === 'print') { doc.autoPrint(); window.open(doc.output('bloburl'), '_blank'); } else doc.save(`${nombre}.pdf`);
    } catch (e) { toast(e.message, 'error'); }
  }

  window.Auditoria = { abrir, buscar, detalle, exportar };
})();

'use strict';

/**
 * servicios.js — Frontend del modo "Empresa de Servicios" (M1 núcleo).
 *
 * Inyecta los ítems de sidebar y los paneles de módulo srv-*, y los renderiza
 * contra /api/servicios/*. Se activa solo cuando html[data-app-mode="servicios"]
 * (lo pone applyBusinessProfile en app.js); en instalaciones POS los ítems
 * quedan ocultos por isBusinessModuleEnabled().
 *
 * showModule('srv-...') llama a window.Servicios.onShow(name) (hook en app.js).
 */
(function () {
  const API = '/api/servicios';
  // `api` es un global léxico de js/api.js (const, no cuelga de window).
  const apiRef = () => (typeof api !== 'undefined' ? api : window.api);
  const req = (path, opts) => apiRef().request(API + path, opts);
  const post = (path, data) => req(path, { method: 'POST', body: JSON.stringify(data || {}) });
  const put = (path, data) => req(path, { method: 'PUT', body: JSON.stringify(data || {}) });
  const del = (path) => req(path, { method: 'DELETE' });
  const toast = (m, t) => {
    const fn = (typeof showToast !== 'undefined' && showToast) || window.showToast;
    if (fn) fn(m, t || 'info'); else console.log('[servicios]', m);
  };
  // `DB` es un global léxico de js/data.js (const, no cuelga de window).
  const dbRef = () => (typeof DB !== 'undefined' ? DB : (window.DB || {}));
  const money = (n) => 'RD$ ' + (Number(n) || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const MESES_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  // Formatea fechas ISO ("2026-09-02" o "2026-09-02T04:00:00.000Z") a "2 sep 2026".
  // withTime=true agrega " HH:MM" solo si la marca de tiempo trae hora real
  // (para columnas de auditoría). Por defecto NO muestra hora.
  function fdate(v, withTime) {
    if (!v) return '—';
    const s = String(v);
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    let y, mo, da;
    if (m) { [, y, mo, da] = m; }
    else { const d = new Date(s); if (isNaN(d)) return s; y = d.getFullYear(); mo = String(d.getMonth() + 1).padStart(2, '0'); da = String(d.getDate()).padStart(2, '0'); }
    let suf = '';
    if (withTime) {
      const hm = /[T ](\d{2}):(\d{2})/.exec(s);
      if (hm && (hm[1] !== '00' || hm[2] !== '00')) suf = ' ' + hm[1] + ':' + hm[2];
    }
    return `${Number(da)} ${MESES_ES[Number(mo) - 1] || mo} ${y}${suf}`;
  }

  const NAV = [
    { mod: 'srv-facturas', label: 'Facturación', icon: '💵' },
    { mod: 'srv-cobros', label: 'Cobros', icon: '💰' },
    { mod: 'srv-cxc', label: 'Cuentas por cobrar', icon: '📉' },
    { mod: 'srv-cotizaciones', label: 'Cotizaciones', icon: '📝' },
    { mod: 'srv-dashboard', label: 'Panel', icon: '📊' },
    { mod: 'srv-servicios', label: 'Servicios', icon: '🧾' },
    { mod: 'srv-contratos', label: 'Contratos', icon: '📄' },
    { mod: 'srv-proyectos', label: 'Proyectos', icon: '📁' },
    { mod: 'srv-obras', label: 'Obras', icon: '🏗️' },
    { mod: 'srv-campanas', label: 'Campañas', icon: '📣' },
    { mod: 'srv-ordenes', label: 'Órdenes de trabajo', icon: '🛠️' },
    { mod: 'srv-mantenimiento', label: 'Equipos y mantenimiento', icon: '⚙️' },
    { mod: 'srv-seguridad', label: 'Puestos de seguridad', icon: '🛡️' },
    { mod: 'srv-reservaciones', label: 'Reservaciones', icon: '✈️' },
    { mod: 'srv-calendario', label: 'Calendario', icon: '📅' },
    { mod: 'srv-auditoria', label: 'Auditoría', icon: '🔍' },
  ];

  let injected = false;

  function injectChrome() {
    if (injected) return;
    injected = true;

    // ── Nav ────────────────────────────────────────────────────────────────
    const nav = document.querySelector('.sidebar nav') || document.querySelector('.sidebar .nav-menu') || document.querySelector('.sidebar');
    if (nav) {
      const first = nav.querySelector('.nav-item');
      NAV.forEach((n) => {
        if (nav.querySelector(`.nav-item[data-module="${n.mod}"]`)) return;
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'nav-item';
        a.dataset.module = n.mod;
        a.innerHTML = `<span class="nav-icon">${n.icon}</span><span class="nav-label">${n.label}</span>`;
        a.addEventListener('click', (e) => { e.preventDefault(); window.showModule(n.mod, a); });
        nav.insertBefore(a, first || null);
      });
    }

    // ── Paneles ────────────────────────────────────────────────────────────
    const main = document.querySelector('.main-content') || document.querySelector('main');
    if (main) {
      NAV.forEach((n) => {
        if (document.getElementById('module-' + n.mod)) return;
        const div = document.createElement('div');
        div.id = 'module-' + n.mod;
        div.className = 'module hidden';
        div.innerHTML = `
          <div class="module-header"><h2>${n.icon} ${n.label}</h2>
            <div class="srv-actions" data-actions></div>
          </div>
          <div class="srv-body" data-body><div class="srv-loading">Cargando…</div></div>`;
        main.appendChild(div);
      });
    }
  }

  function bodyOf(mod) { return document.querySelector(`#module-${mod} [data-body]`); }
  function actionsOf(mod) { return document.querySelector(`#module-${mod} [data-actions]`); }

  // ── Modal genérico ───────────────────────────────────────────────────────
  function modal(title, contentHtml, onSubmit, { wide, submitLabel } = {}) {
    const back = document.createElement('div');
    back.className = 'srv-modal-back';
    back.innerHTML = `
      <div class="srv-modal ${wide ? 'srv-modal-wide' : ''}">
        <div class="srv-modal-head"><h3>${esc(title)}</h3><button type="button" data-x>✕</button></div>
        <form data-form><div class="srv-modal-body">${contentHtml}</div>
          <div class="srv-modal-foot">
            <button type="button" class="btn btn-ghost" data-cancel>Cancelar</button>
            <button type="submit" class="btn btn-primary">${esc(submitLabel || 'Guardar')}</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector('[data-x]').onclick = close;
    back.querySelector('[data-cancel]').onclick = close;
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    back.querySelector('[data-form]').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target).entries());
      try {
        const btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = 'Guardando…';
        await onSubmit(fd, back);
        close();
      } catch (err) {
        toast(err.message || 'Error', 'error');
        const btn = e.target.querySelector('button[type=submit]');
        if (btn) { btn.disabled = false; btn.textContent = esc(submitLabel || 'Guardar'); }
      }
    });
    return back;
  }

  // ── Selector de cliente (usa DB.clientes ya cargado en el renderer) ──────
  function clientPickerHtml(cur) {
    const list = Array.isArray(dbRef().clientes) ? dbRef().clientes : [];
    // Al editar, si el registro solo trae clientId, resolver la cédula del catálogo.
    let rncInicial = cur?.clientRnc || '';
    if (!rncInicial && cur?.clientId) {
      const c = list.find((x) => x.id == cur.clientId);
      if (c) rncInicial = c.cedula || c.rnc || '';
    }
    const opts = list
      .slice()
      .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || '')))
      .map((c) => {
        const rnc = c.cedula || c.rnc || '';
        return `<option value="${c.id}" data-nombre="${esc(c.nombre)}" data-rnc="${esc(rnc)}" data-email="${esc(c.email || '')}"${cur && cur.clientId == c.id ? ' selected' : ''}>${esc(c.nombre)}${rnc ? ' — ' + esc(rnc) : ''}</option>`;
      }).join('');
    return `
      <label>Cliente registrado
        <select name="clientId" id="srv-cli-pick"><option value="">— Nuevo / sin registrar —</option>${opts}</select>
      </label>
      <div class="srv-row">
        <label>Nombre<input name="clientName" id="srv-cli-name" value="${esc(cur?.clientName || '')}" required></label>
        <label>RNC / Cédula<input name="clientRnc" id="srv-cli-rnc" value="${esc(rncInicial)}"></label>
      </div>
      <p class="srv-hint" id="srv-cli-email-hint"></p>`;
  }

  function wireClientPicker(root) {
    const pick = root.querySelector('#srv-cli-pick');
    const name = root.querySelector('#srv-cli-name');
    const rnc = root.querySelector('#srv-cli-rnc');
    const hint = root.querySelector('#srv-cli-email-hint');
    if (!pick) return;
    const fill = () => {
      const o = pick.selectedOptions[0];
      if (pick.value && o) {
        name.value = o.dataset.nombre || '';
        rnc.value = o.dataset.rnc || rnc.value || '';
        name.readOnly = true; rnc.readOnly = true;
        hint.textContent = o.dataset.email ? 'Correo: ' + o.dataset.email : 'Este cliente no tiene correo — agrégalo en Clientes para poder enviar la factura.';
      } else {
        name.readOnly = false; rnc.readOnly = false;
        hint.textContent = '';
      }
    };
    pick.addEventListener('change', fill);
    if (pick.value) fill(); // cliente preseleccionado (edición): rellenar de una
  }

  const DATE_KEYS = /^(fecha|vencimiento|createdAt|updatedAt|fechaProgramada|fechaInicio|fechaEntrega|fechaSalida|fechaRegreso|fechaLimite|proximaRevision|proximaFecha|fechaFin|fechaFinEstimada|anuladoAt|completadaAt)$/;
  function cellValue(c, r) {
    if (c.render) return c.render(r);
    const v = r[c.key];
    if (c.key && DATE_KEYS.test(c.key) && v) return esc(fdate(v));
    return esc(v);
  }
  function table(cols, rows) {
    return `<div class="srv-table-wrap"><table class="srv-table">
      <thead><tr>${cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr>${cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${cellValue(c, r)}</td>`).join('')}</tr>`).join('')
        : `<tr><td colspan="${cols.length}" class="srv-empty">Sin registros</td></tr>`}</tbody>
    </table></div>`;
  }

  const VERT_LABELS = {
    srv_consultoria: 'Consultoría', srv_tecnologia: 'Empresa de Tecnología', srv_publicidad: 'Agencia de Publicidad',
    srv_arquitectura: 'Arquitectura e Ingeniería', srv_limpieza: 'Empresa de Limpieza', srv_seguridad: 'Empresa de Seguridad',
    srv_mantenimiento: 'Empresa de Mantenimiento', srv_viajes: 'Agencia de Viajes',
  };

  // Chip de solo lectura en el Panel: "<Vertical> · <Estructura>". El tipo de
  // empresa se fija en el wizard y NO se cambia desde la app.
  function renderPanelChip() {
    const host = actionsOf('srv-dashboard');
    if (!host) return;
    const dbc = dbRef().config || {};
    const vert = dbc.serviceVertical || dbc.tipoNegocio || '';
    const vertLabel = VERT_LABELS[vert] || 'Empresa de Servicios';
    const modeMap = { monocaja: 'Monocaja', multicaja: 'Multicaja', multisucursal: 'Multisucursal', sucursal: 'Sucursal' };
    const mode = modeMap[String(dbc.businessStructureMode || '').toLowerCase()] || '';
    host.innerHTML = `<span class="srv-panel-chip">🏢 ${esc(vertLabel)}${mode ? ` · <strong>${esc(mode)}</strong>` : ''}</span>`;
  }

  // ═══ Dashboard ═════════════════════════════════════════════════════════════
  async function renderDashboard() {
    const b = bodyOf('srv-dashboard');
    renderPanelChip();
    b.innerHTML = '<div class="srv-loading">Cargando…</div>';
    try {
      const d = await req('/dashboard');
      const card = (t, v, sub) => `<div class="srv-kpi"><span class="srv-kpi-t">${esc(t)}</span><span class="srv-kpi-v">${v}</span>${sub ? `<span class="srv-kpi-s">${esc(sub)}</span>` : ''}</div>`;
      b.innerHTML = `
        <div class="srv-kpis">
          ${card('Servicios facturados', money(d.serviciosFacturados.monto), `${d.serviciosFacturados.cantidad} facturas`)}
          ${card('Cobros del período', money(d.cobrosPeriodo.monto), `${d.cobrosPeriodo.cantidad} pagos`)}
          ${card('Cuentas por cobrar', money(d.cuentasPorCobrar), `${d.facturasPendientes} pendientes`)}
          ${card('Facturas vencidas', d.facturasVencidas, '')}
          ${card('Cotizaciones abiertas', (d.cotizaciones.borrador + d.cotizaciones.enviada), `${d.cotizaciones.aprobada} aprobadas`)}
          ${card('Ganancia estimada', money(d.gananciaEstimada), `gastos ${money(d.gastosPeriodo)}`)}
        </div>
        <h3 class="srv-h3">Rendimiento por sucursal</h3>
        ${table([
          { label: 'Sucursal', key: 'sucursal' },
          { label: 'Facturado', num: true, render: (r) => money(r.facturado) },
          { label: 'Por cobrar', num: true, render: (r) => money(r.porCobrar) },
        ], d.porSucursal || [])}
        <h3 class="srv-h3">Servicios más facturados</h3>
        ${table([
          { label: 'Servicio', key: 'nombre' },
          { label: 'Veces', num: true, key: 'veces' },
          { label: 'Monto', num: true, render: (r) => money(r.monto) },
        ], d.topServicios || [])}`;
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }

  // ═══ Catálogo de servicios ════════════════════════════════════════════════
  async function renderServicios() {
    const b = bodyOf('srv-servicios');
    actionsOf('srv-servicios').innerHTML = `<button class="btn btn-primary" data-new>+ Nuevo servicio</button>`;
    actionsOf('srv-servicios').querySelector('[data-new]').onclick = () => formServicio();
    b.innerHTML = '<div class="srv-loading">Cargando…</div>';
    try {
      const rows = await req('/catalogo');
      b.innerHTML = table([
        { label: 'Código', key: 'codigo' },
        { label: 'Servicio', key: 'nombre' },
        { label: 'Categoría', key: 'categoria' },
        { label: 'Unidad', key: 'unidad' },
        { label: 'Precio', num: true, render: (r) => money(r.precio) },
        { label: 'ITBIS %', num: true, render: (r) => (r.itbisPct || 0) + '%' },
        { label: '', render: (r) => `<button class="srv-link" data-edit="${r.id}">Editar</button> · <button class="srv-link" data-del="${r.id}">Baja</button>` },
      ], rows);
      b.querySelectorAll('[data-edit]').forEach((el) => el.onclick = () => formServicio(rows.find((x) => x.id == el.dataset.edit)));
      b.querySelectorAll('[data-del]').forEach((el) => el.onclick = async () => {
        if (!confirm('¿Dar de baja este servicio?')) return;
        try { await del('/catalogo/' + el.dataset.del); toast('Servicio dado de baja', 'success'); renderServicios(); }
        catch (e) { toast(e.message, 'error'); }
      });
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }

  async function formServicio(srv) {
    let cats = [];
    try { cats = await req('/catalogo/categorias'); } catch (_) {}
    const opts = cats.map((c) => `<option value="${c.id}" ${srv && srv.categoriaId == c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('');
    modal(srv ? 'Editar servicio' : 'Nuevo servicio', `
      <label>Nombre<input name="nombre" required value="${esc(srv?.nombre || '')}"></label>
      <label>Código<input name="codigo" value="${esc(srv?.codigo || '')}"></label>
      <label>Descripción<textarea name="descripcion" rows="2">${esc(srv?.descripcion || '')}</textarea></label>
      <div class="srv-row">
        <label>Categoría<select name="categoriaId"><option value="">—</option>${opts}</select></label>
        <label>Unidad<input name="unidad" value="${esc(srv?.unidad || 'servicio')}"></label>
      </div>
      <div class="srv-row">
        <label>Precio<input name="precio" type="number" step="0.01" min="0" value="${srv?.precio ?? 0}"></label>
        <label>ITBIS %<input name="itbisPct" type="number" step="0.01" min="0" value="${srv?.itbisPct ?? 0}"></label>
        <label>Duración (min)<input name="duracionMin" type="number" min="0" value="${srv?.duracionMin ?? ''}"></label>
      </div>`, async (fd) => {
      fd.categoriaId = fd.categoriaId || null;
      if (srv) await put('/catalogo/' + srv.id, fd); else await post('/catalogo', fd);
      toast('Servicio guardado', 'success');
      renderServicios();
    });
  }

  // ═══ Cotizaciones ═════════════════════════════════════════════════════════
  let _cotTodas = false;
  async function renderCotizaciones() {
    const b = bodyOf('srv-cotizaciones');
    actionsOf('srv-cotizaciones').innerHTML = `
      <label style="font-size:12px;display:flex;align-items:center;gap:5px"><input type="checkbox" id="cot-todas"${_cotTodas ? ' checked' : ''}> Ver convertidas/rechazadas</label>
      <button class="btn btn-primary" data-new>+ Nueva cotización</button>`;
    actionsOf('srv-cotizaciones').querySelector('[data-new]').onclick = () => formCotizacion();
    actionsOf('srv-cotizaciones').querySelector('#cot-todas').onchange = (e) => { _cotTodas = e.target.checked; renderCotizaciones(); };
    b.innerHTML = '<div class="srv-loading">Cargando…</div>';
    try {
      const rows = await req('/cotizaciones' + (_cotTodas ? '?todas=1' : ''));
      b.innerHTML = table([
        { label: 'Número', key: 'numero' },
        { label: 'Cliente', key: 'clientName' },
        { label: 'Fecha', key: 'fecha' },
        { label: 'Estado', render: (r) => `<span class="srv-badge srv-badge-${r.estado}">${r.estado}</span>` },
        { label: 'Total', num: true, render: (r) => money(r.total) },
        { label: '', render: (r) => {
          const acc = [`<button class="srv-link" data-view="${r.id}">Ver / Imprimir</button>`,
            `<button class="srv-link" data-mail="${r.id}">Correo</button>`];
          if (['borrador', 'enviada'].includes(r.estado)) acc.push(`<button class="srv-link" data-edit="${r.id}">Editar</button>`);
          if (['borrador', 'enviada', 'aprobada'].includes(r.estado)) acc.push(`<button class="srv-link" data-fact="${r.id}">Facturar</button>`);
          if (r.estado === 'enviada') acc.push(`<button class="srv-link" data-ap="${r.id}">Aprobar</button>`);
          if (r.estado === 'borrador') acc.push(`<button class="srv-link" data-send="${r.id}">Enviar</button>`);
          return acc.join(' · ');
        } },
      ], rows);
      b.querySelectorAll('[data-view]').forEach((el) => el.onclick = () => abrirDoc('cotizaciones', el.dataset.view, 'Cotización'));
      b.querySelectorAll('[data-mail]').forEach((el) => el.onclick = () => enviarCorreoDoc('cotizaciones', el.dataset.mail, 'cotización'));
      b.querySelectorAll('[data-edit]').forEach((el) => el.onclick = async () => formCotizacion(await req('/cotizaciones/' + el.dataset.edit)));
      b.querySelectorAll('[data-fact]').forEach((el) => el.onclick = () => facturarCotizacion(el.dataset.fact));
      b.querySelectorAll('[data-ap]').forEach((el) => el.onclick = () => cambiarEstadoCot(el.dataset.ap, 'aprobada'));
      b.querySelectorAll('[data-send]').forEach((el) => el.onclick = () => cambiarEstadoCot(el.dataset.send, 'enviada'));
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }

  async function cambiarEstadoCot(id, estado) {
    try { await post(`/cotizaciones/${id}/estado`, { estado }); toast('Cotización ' + estado, 'success'); renderCotizaciones(); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function viewCotizacion(id) {
    const q = await req('/cotizaciones/' + id);
    modal('Cotización ' + q.numero, `
      <p><strong>${esc(q.clientName || 'Sin cliente')}</strong> ${q.clientRnc ? '· ' + esc(q.clientRnc) : ''}</p>
      <p>Fecha: ${esc(q.fecha)} · Validez: ${q.validezDias} días · Estado: <strong>${esc(q.estado)}</strong></p>
      ${table([
        { label: 'Descripción', key: 'descripcion' },
        { label: 'Cant.', num: true, key: 'cantidad' },
        { label: 'Precio', num: true, render: (r) => money(r.precio) },
        { label: 'Total', num: true, render: (r) => money(r.total) },
      ], q.items)}
      <p class="srv-tot">Subtotal ${money(q.subtotal)} · Desc. ${money(q.descuento)} · ITBIS ${money(q.itbis)} · <strong>Total ${money(q.total)}</strong></p>
      ${q.notas ? `<p>${esc(q.notas)}</p>` : ''}`, async () => {}, { wide: true, submitLabel: 'Cerrar' });
  }

  // Editor de líneas reutilizable (cotización / factura).
  // Celdas de una fila: guarda el serviceId (si viene del catálogo) en un hidden.
  function lineCells(it = {}) {
    return `<td><input type="hidden" name="sid" value="${it.serviceId ? Number(it.serviceId) : ''}">
        <input name="d" value="${esc(it.descripcion || '')}" placeholder="Servicio / concepto"></td>
      <td><input name="c" type="number" step="0.01" min="0" value="${it.cantidad ?? 1}" style="width:70px"></td>
      <td><input name="p" type="number" step="0.01" min="0" value="${it.precio ?? 0}" style="width:100px"></td>
      <td><input name="dp" type="number" step="0.01" min="0" value="${it.descuentoPct ?? 0}" style="width:60px"></td>
      <td><input name="ip" type="number" step="0.01" min="0" value="${it.itbisPct ?? 0}" style="width:60px"></td>
      <td><button type="button" class="srv-link" data-rm>✕</button></td>`;
  }

  function lineEditor(items) {
    const its = items && items.length ? items : [{}];
    const rowsHtml = its.map((it, i) => `<tr data-i="${i}">${lineCells(it)}</tr>`).join('');
    return `<div class="srv-lines">
      <div class="srv-catrow" style="margin:0 0 8px">
        <select data-cat-sel style="width:100%;max-width:440px">
          <option value="">+ Agregar desde el catálogo de servicios…</option>
        </select>
      </div>
      <table class="srv-table"><thead><tr><th>Descripción</th><th>Cant.</th><th>Precio</th><th>Desc%</th><th>ITBIS%</th><th></th></tr></thead>
      <tbody data-lines>${rowsHtml}</tbody></table>
      <button type="button" class="srv-link" data-add>+ Agregar línea manual</button>
    </div>`;
  }

  function collectLines(root) {
    return [...root.querySelectorAll('[data-lines] tr')].map((tr) => ({
      serviceId: Number(tr.querySelector('[name=sid]')?.value || 0) || null,
      descripcion: tr.querySelector('[name=d]').value.trim(),
      cantidad: Number(tr.querySelector('[name=c]').value || 0),
      precio: Number(tr.querySelector('[name=p]').value || 0),
      descuentoPct: Number(tr.querySelector('[name=dp]').value || 0),
      itbisPct: Number(tr.querySelector('[name=ip]').value || 0),
    })).filter((x) => x.descripcion);
  }

  function wireLines(root) {
    const tbody = root.querySelector('[data-lines]');
    const addRow = (it) => {
      const tr = document.createElement('tr');
      tr.innerHTML = lineCells(it || {});
      tbody.appendChild(tr);
      tr.querySelector('[data-rm]').onclick = () => tr.remove();
      return tr;
    };
    root.querySelector('[data-add]').onclick = () => addRow({});
    tbody.querySelectorAll('[data-rm]').forEach((el) => el.onclick = () => el.closest('tr').remove());

    // Catálogo de servicios: elegir uno agrega (o rellena) una línea con su
    // precio e ITBIS ya cargados. Las líneas manuales siguen igual.
    const sel = root.querySelector('[data-cat-sel]');
    if (sel) {
      req('/catalogo?activo=1').then((rows) => {
        (rows || []).forEach((s) => {
          const o = document.createElement('option');
          o.value = String(s.id);
          o.textContent = `${s.codigo ? s.codigo + ' · ' : ''}${s.nombre} — ${money(s.precio)}${s.itbisPct ? ' + ' + s.itbisPct + '% ITBIS' : ''}`;
          o.dataset.nombre = s.nombre;
          o.dataset.precio = s.precio;
          o.dataset.itbis = s.itbisPct || 0;
          sel.appendChild(o);
        });
      }).catch(() => {});
      sel.onchange = () => {
        const o = sel.selectedOptions[0];
        if (!o || !o.value) return;
        const it = {
          serviceId: Number(o.value), descripcion: o.dataset.nombre,
          cantidad: 1, precio: Number(o.dataset.precio || 0),
          descuentoPct: 0, itbisPct: Number(o.dataset.itbis || 0),
        };
        // Si la primera fila sigue vacía, reutilízala en vez de dejar una en blanco.
        const first = tbody.querySelector('tr');
        const firstEmpty = first
          && !first.querySelector('[name=d]').value.trim()
          && Number(first.querySelector('[name=p]').value || 0) === 0;
        if (firstEmpty) {
          first.querySelector('[name=sid]').value = it.serviceId;
          first.querySelector('[name=d]').value = it.descripcion;
          first.querySelector('[name=c]').value = it.cantidad;
          first.querySelector('[name=p]').value = it.precio;
          first.querySelector('[name=ip]').value = it.itbisPct;
        } else {
          addRow(it);
        }
        sel.value = '';
      };
    }
  }

  async function formCotizacion(q) {
    const m = modal(q ? 'Editar cotización ' + q.numero : 'Nueva cotización', `
      ${clientPickerHtml(q)}
      <div class="srv-row">
        <label>Fecha<input name="fecha" type="date" value="${esc(q?.fecha || today())}"></label>
        <label>Validez (días)<input name="validezDias" type="number" min="1" value="${q?.validezDias ?? 15}"></label>
      </div>
      ${lineEditor(q?.items)}
      <label>Notas<textarea name="notas" rows="2">${esc(q?.notas || '')}</textarea></label>`, async (fd, root) => {
      const items = collectLines(root);
      if (!items.length) throw new Error('Agrega al menos una línea.');
      const payload = { ...fd, clientId: fd.clientId || null, items };
      if (q) await put('/cotizaciones/' + q.id, payload); else await post('/cotizaciones', payload);
      toast('Cotización guardada', 'success');
      renderCotizaciones();
    }, { wide: true });
    wireClientPicker(m);
    wireLines(m);
  }

  // Campos de facturación compartidos: comprobante (tipos NCF ya configurados),
  // método de pago y condición. Devuelve { html, wire(root) }.
  async function billingFields(defaults = {}) {
    let resp = { comprobantes: [], necesitaActivar: false };
    let cfg = {};
    try { [resp, cfg] = await Promise.all([req('/facturas/comprobantes'), req('/config')]); } catch (_) {}
    const comps = Array.isArray(resp) ? resp : (resp.comprobantes || []);
    const necesitaActivar = !Array.isArray(resp) && resp.necesitaActivar;
    const defMode = cfg.fiscalMode || 'ncf';
    const opts = [];
    comps.forEach((c) => {
      const venc = c.vencimiento ? ' · vence ' + fdate(c.vencimiento) : '';
      opts.push(`<option value="ncf|${esc(c.tipo)}" data-venc="${esc(c.vencimiento || '')}"${defMode === 'ncf' && (defaults.ncfTipo === c.tipo || (!defaults.ncfTipo && opts.length === 0)) ? ' selected' : ''}>NCF ${esc(c.tipo)} — ${esc(c.nombre)}${venc} (${c.disponibles} disp.)</option>`);
    });
    opts.push(`<option value="ecf|E31"${defMode === 'ecf' ? ' selected' : ''}>e-CF (electrónico)</option>`);
    opts.push(`<option value="consumidor|"${defMode === 'consumidor' || !comps.length ? ' selected' : ''}>Sin comprobante fiscal</option>`);
    const metodos = ['efectivo', 'transferencia', 'tarjeta', 'deposito', 'cheque', 'otro'];
    const html = `
      <label>Comprobante fiscal
        <select name="comprobante" id="srv-comp">${opts.join('')}</select>
        <small class="srv-hint" id="srv-comp-venc"></small>
        ${necesitaActivar ? '<small class="srv-hint" style="color:#b45309">⚠ Tienes secuencias NCF registradas pero <strong>desactivadas</strong>. Actívalas en Configuración → Ventas y Facturación → Secuencias de Comprobantes Fiscales (casilla "Usar los rangos registrados… al facturar").</small>' : (!comps.length ? '<small class="srv-hint" style="color:#b45309">No hay secuencias NCF disponibles. Regístralas en Configuración → Secuencias de Comprobantes Fiscales.</small>' : '')}
      </label>
      <div class="srv-row">
        <label>Condición<select name="condicionPago" id="srv-cond">
          <option value="contado">Contado (pagada al emitir)</option>
          <option value="credito">Crédito</option>
        </select></label>
        <label id="srv-mp-wrap">Método de pago<select name="metodoPago">${metodos.map((m) => `<option>${m}</option>`).join('')}</select></label>
      </div>`;
    const wire = (root) => {
      const sel = root.querySelector('#srv-comp');
      const vencEl = root.querySelector('#srv-comp-venc');
      const cond = root.querySelector('#srv-cond');
      const mpWrap = root.querySelector('#srv-mp-wrap');
      const syncVenc = () => {
        const o = sel.selectedOptions[0];
        vencEl.textContent = o && o.dataset.venc ? 'La factura vencerá el ' + fdate(o.dataset.venc) + ' (fecha del comprobante).' : '';
      };
      const syncMp = () => { mpWrap.style.display = cond.value === 'contado' ? '' : 'none'; };
      sel.addEventListener('change', syncVenc); cond.addEventListener('change', syncMp);
      syncVenc(); syncMp();
    };
    return { html, wire };
  }
  function readBilling(fd) {
    const [mode, tipo] = String(fd.comprobante || 'consumidor|').split('|');
    const out = { fiscalMode: mode, ncfTipo: tipo || null, condicionPago: fd.condicionPago || 'contado' };
    if (out.condicionPago === 'contado') { out.pagoInmediato = true; out.metodoPago = fd.metodoPago || 'efectivo'; }
    else { out.pagoInmediato = false; }
    return out;
  }

  async function facturarCotizacion(id) {
    const bf = await billingFields();
    const m = modal('Convertir cotización en factura', `
      <p>Se generará una factura de servicios a partir de la cotización.</p>
      ${bf.html}`, async (fd) => {
      const inv = await post('/facturas/desde-cotizacion/' + id, { ...fd, ...readBilling(fd) });
      toast('Factura ' + inv.numero + (inv.ncf ? ' · ' + inv.ncf : '') + ' emitida', 'success');
      renderCotizaciones();
      window.showModule('srv-facturas', document.querySelector('.nav-item[data-module="srv-facturas"]'));
    }, { submitLabel: 'Facturar' });
    bf.wire(m);
  }

  // ═══ Facturación ══════════════════════════════════════════════════════════
  let _facTodas = false;
  async function renderFacturas() {
    const b = bodyOf('srv-facturas');
    actionsOf('srv-facturas').innerHTML = `
      <label style="font-size:12px;display:flex;align-items:center;gap:5px"><input type="checkbox" id="fac-todas"${_facTodas ? ' checked' : ''}> Ver pagadas/anuladas</label>
      <button class="btn btn-primary" data-new>+ Nueva factura</button>`;
    actionsOf('srv-facturas').querySelector('[data-new]').onclick = () => formFactura();
    actionsOf('srv-facturas').querySelector('#fac-todas').onchange = (e) => { _facTodas = e.target.checked; renderFacturas(); };
    b.innerHTML = '<div class="srv-loading">Cargando…</div>';
    try {
      const rows = await req('/facturas' + (_facTodas ? '?todas=1' : ''));
      b.innerHTML = table([
        { label: 'Número', key: 'numero' },
        { label: 'NCF', key: 'ncf' },
        { label: 'Cliente', key: 'clientName' },
        { label: 'Fecha', key: 'fecha' },
        { label: 'Total', num: true, render: (r) => money(r.total) },
        { label: 'Balance', num: true, render: (r) => money(r.balance) },
        { label: 'Estado', render: (r) => `<span class="srv-badge srv-badge-${r.estado}">${r.estado}</span>` },
        { label: '', render: (r) => {
          const acc = [`<button class="srv-link" data-doc="${r.id}">Imprimir</button>`, `<button class="srv-link" data-mail="${r.id}">Correo</button>`];
          if (r.estado !== 'anulada' && r.balance > 0) acc.push(`<button class="srv-link" data-pay="${r.id}">Cobrar</button>`);
          if (r.estado !== 'anulada') acc.push(`<button class="srv-link" data-void="${r.id}">Anular</button>`);
          return acc.join(' · ');
        } },
      ], rows);
      b.querySelectorAll('[data-doc]').forEach((el) => el.onclick = () => verDocumento(el.dataset.doc));
      b.querySelectorAll('[data-mail]').forEach((el) => el.onclick = () => enviarCorreo(el.dataset.mail));
      b.querySelectorAll('[data-pay]').forEach((el) => el.onclick = () => formPago(el.dataset.pay));
      b.querySelectorAll('[data-void]').forEach((el) => el.onclick = () => anularFactura(el.dataset.void));
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }

  async function formFactura() {
    const bf = await billingFields();
    const m = modal('Nueva factura de servicios', `
      ${clientPickerHtml()}
      <label>Fecha<input name="fecha" type="date" value="${today()}"></label>
      ${bf.html}
      ${lineEditor()}
      <label>Notas<textarea name="notas" rows="2"></textarea></label>`, async (fd, root) => {
      const items = collectLines(root);
      if (!items.length) throw new Error('Agrega al menos una línea.');
      const inv = await post('/facturas', { ...fd, ...readBilling(fd), clientId: fd.clientId || null, items });
      toast('Factura ' + inv.numero + (inv.ncf ? ' · ' + inv.ncf : '') + (inv.estado === 'pagada' ? ' (pagada)' : '') + ' emitida', 'success');
      renderFacturas();
    }, { wide: true, submitLabel: 'Emitir factura' });
    wireClientPicker(m);
    bf.wire(m);
    wireLines(m);
  }

  // Abre un documento (factura/cotización) en una ventana con barra: selector de
  // formato + Imprimir/Guardar PDF + Enviar por correo.
  async function abrirDoc(base, id, label) {
    let d;
    try { d = await req(`/${base}/${id}/documento?formato=a4`); }
    catch (e) { toast(e.message, 'error'); return; }
    const w = window.open('', '_blank');
    if (!w) { toast('Permite las ventanas emergentes para ver el documento.', 'warning'); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(label)}</title>
      <style>body{margin:0;background:#eef1f4;font-family:system-ui,Segoe UI,sans-serif}
      .bar{position:sticky;top:0;display:flex;gap:8px;align-items:center;padding:9px 14px;background:#111827;color:#fff}
      .bar select,.bar button{font:inherit;padding:6px 10px;border-radius:6px;border:0;cursor:pointer}
      .bar button{background:#15803d;color:#fff}.bar .g{background:#374151}
      iframe{width:100%;border:0;height:calc(100vh - 50px)}</style></head>
      <body><div class="bar"><strong>${esc(label)}</strong>
        <select id="fmt"><option value="a4">A4</option><option value="80mm">80 mm</option><option value="58mm">58 mm</option></select>
        <button class="g" id="pr">Imprimir / Guardar PDF</button>
        <button id="ml">Enviar por correo</button></div>
      <iframe id="fr"></iframe></body></html>`);
    w.document.close();
    const load = async (fmt) => {
      let doc = d;
      if (fmt !== 'a4') { try { doc = await req(`/${base}/${id}/documento?formato=${fmt}`); } catch (_) {} }
      const fr = w.document.getElementById('fr'); if (fr) fr.srcdoc = doc.html;
    };
    setTimeout(() => {
      const sel = w.document.getElementById('fmt');
      if (sel) sel.onchange = () => load(sel.value);
      const pr = w.document.getElementById('pr');
      if (pr) pr.onclick = () => { try { w.document.getElementById('fr').contentWindow.print(); } catch (_) {} };
      const ml = w.document.getElementById('ml');
      if (ml) ml.onclick = () => { try { w.close(); } catch (_) {} enviarCorreoDoc(base, id, label.toLowerCase()); };
      load('a4');
    }, 120);
  }

  async function enviarCorreoDoc(base, id, label) {
    let info;
    try { info = await req(`/${base}/${id}`); } catch (e) { toast(e.message, 'error'); return; }
    modal(`Enviar ${label} ${info.numero} por correo`, `
      <p>Se enviará en <strong>formato A4 (PDF)</strong>.</p>
      <label>Correo destino<input name="to" type="email" value="${esc(info.clientEmail || '')}" placeholder="cliente@correo.com"></label>
      <label>Mensaje<textarea name="mensaje" rows="3"></textarea></label>
      <p class="srv-hint">Si el envío falla, revisa el Gmail y la contraseña de aplicación en Configuración → Empresa de Servicios.</p>`, async (fd) => {
      let pdfBase64 = null;
      try {
        if (window.novaDesktop && window.novaDesktop.htmlToPdf) {
          const d = await req(`/${base}/${id}/documento?formato=a4`);
          pdfBase64 = await window.novaDesktop.htmlToPdf(d.html);
        }
      } catch (_) {}
      await post(`/${base}/${id}/email`, { ...fd, pdfBase64 });
      toast(pdfBase64 ? 'Enviado por correo con el PDF adjunto' : 'Enviado por correo (sin PDF adjunto — reinicia la app para habilitarlo)', pdfBase64 ? 'success' : 'warning');
    }, { submitLabel: 'Enviar' });
  }

  const verDocumento = (id) => abrirDoc('facturas', id, 'Factura');
  const enviarCorreo = (id) => enviarCorreoDoc('facturas', id, 'factura');

  async function anularFactura(id) {
    modal('Anular factura', `
      <label>Motivo<textarea name="motivo" rows="2" required></textarea></label>
      <label class="srv-check"><input type="checkbox" name="forzar" value="1"> Forzar aunque tenga pagos</label>`, async (fd) => {
      await post(`/facturas/${id}/anular`, { motivo: fd.motivo, forzar: fd.forzar === '1' });
      toast('Factura anulada', 'success');
      renderFacturas();
    }, { submitLabel: 'Anular' });
  }

  // ═══ Cobros ═══════════════════════════════════════════════════════════════
  async function renderCobros() {
    const b = bodyOf('srv-cobros');
    actionsOf('srv-cobros').innerHTML = '';
    b.innerHTML = '<div class="srv-loading">Cargando…</div>';
    try {
      const rows = await req('/cobros');
      b.innerHTML = table([
        { label: 'Fecha', key: 'fecha' },
        { label: 'Factura', key: 'factura' },
        { label: 'Cliente', key: 'clientName' },
        { label: 'Método', key: 'metodo' },
        { label: 'Monto', num: true, render: (r) => money(r.monto) },
        { label: 'Estado', render: (r) => r.anuladoAt ? '<span class="srv-badge srv-badge-anulada">anulado</span>' : 'ok' },
        { label: '', render: (r) => r.anuladoAt ? '' : `<button class="srv-link" data-void="${r.id}">Anular</button>` },
      ], rows);
      b.querySelectorAll('[data-void]').forEach((el) => el.onclick = async () => {
        const motivo = prompt('Motivo de la anulación del pago:');
        if (motivo == null) return;
        try { await post(`/cobros/${el.dataset.void}/anular`, { motivo }); toast('Pago anulado', 'success'); renderCobros(); }
        catch (e) { toast(e.message, 'error'); }
      });
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }

  async function formPago(invoiceId) {
    const inv = await req('/facturas/' + invoiceId);
    let metodos = ['efectivo', 'transferencia', 'tarjeta', 'deposito', 'cheque', 'otro'];
    try { metodos = await req('/cobros/metodos'); } catch (_) {}
    modal('Registrar pago — ' + inv.numero, `
      <p>Balance pendiente: <strong>${money(inv.balance)}</strong></p>
      <div class="srv-row">
        <label>Monto<input name="monto" type="number" step="0.01" min="0" value="${inv.balance}" required></label>
        <label>Método<select name="metodo">${metodos.map((x) => `<option>${x}</option>`).join('')}</select></label>
      </div>
      <div class="srv-row">
        <label>Fecha<input name="fecha" type="date" value="${today()}"></label>
        <label>Referencia<input name="referencia"></label>
      </div>
      <label class="srv-check"><input type="checkbox" name="esAnticipo" value="1"> Es anticipo / a cuenta</label>`, async (fd) => {
      await post('/cobros', { invoiceId: Number(invoiceId), monto: Number(fd.monto), metodo: fd.metodo, fecha: fd.fecha, referencia: fd.referencia, esAnticipo: fd.esAnticipo === '1' });
      toast('Pago registrado', 'success');
      renderFacturas();
      if (document.querySelector('#module-srv-cobros.active')) renderCobros();
    }, { submitLabel: 'Registrar pago' });
  }

  // ═══ Cuentas por cobrar ═══════════════════════════════════════════════════
  async function renderCxc() {
    const b = bodyOf('srv-cxc');
    actionsOf('srv-cxc').innerHTML = '';
    b.innerHTML = '<div class="srv-loading">Cargando…</div>';
    try {
      const d = await req('/cobros/cxc');
      b.innerHTML = `
        <div class="srv-kpis">
          <div class="srv-kpi"><span class="srv-kpi-t">Total pendiente</span><span class="srv-kpi-v">${money(d.resumen.totalPendiente)}</span></div>
          <div class="srv-kpi"><span class="srv-kpi-t">Vencido</span><span class="srv-kpi-v">${money(d.resumen.totalVencido)}</span></div>
          <div class="srv-kpi"><span class="srv-kpi-t">Facturas</span><span class="srv-kpi-v">${d.resumen.cantidad}</span></div>
        </div>
        ${table([
          { label: 'Factura', key: 'numero' },
          { label: 'Cliente', key: 'clientName' },
          { label: 'Vence', render: (r) => r.vencimiento || '—' },
          { label: 'Atraso', num: true, render: (r) => r.diasAtraso ? r.diasAtraso + ' d' : '—' },
          { label: 'Balance', num: true, render: (r) => money(r.balance) },
          { label: '', render: (r) => `<button class="srv-link" data-pay="${r.id}">Cobrar</button>` },
        ], d.items)}`;
      b.querySelectorAll('[data-pay]').forEach((el) => el.onclick = () => formPago(el.dataset.pay));
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }

  // ═══ Auditoría ════════════════════════════════════════════════════════════
  async function renderAuditoria() {
    const b = bodyOf('srv-auditoria');
    actionsOf('srv-auditoria').innerHTML = `
      <input id="srv-aud-user" placeholder="Usuario" style="width:120px">
      <input id="srv-aud-desde" type="date">
      <input id="srv-aud-hasta" type="date">
      <button class="btn btn-ghost" data-f>Filtrar</button>`;
    const load = async () => {
      b.innerHTML = '<div class="srv-loading">Cargando…</div>';
      const qs = new URLSearchParams();
      const u = document.getElementById('srv-aud-user')?.value.trim();
      const d1 = document.getElementById('srv-aud-desde')?.value;
      const d2 = document.getElementById('srv-aud-hasta')?.value;
      if (u) qs.set('usuario', u);
      if (d1) qs.set('desde', d1);
      if (d2) qs.set('hasta', d2);
      try {
        const rows = await req('/auditoria?' + qs.toString());
        b.innerHTML = table([
          { label: 'Fecha/Hora', render: (r) => fdate(r.fecha, true) },
          { label: 'Usuario', key: 'usuario' },
          { label: 'Rol', key: 'rol' },
          { label: 'Sucursal', key: 'sucursal' },
          { label: 'Terminal', key: 'terminal' },
          { label: 'Módulo', key: 'modulo' },
          { label: 'Acción', key: 'accion' },
          { label: 'Documento', render: (r) => r.documento || '' },
          { label: 'Monto', num: true, render: (r) => r.monto != null ? money(r.monto) : '' },
        ], rows);
      } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
    };
    actionsOf('srv-auditoria').querySelector('[data-f]').onclick = load;
    load();
  }

  // ═══ M2 — Contratos / Proyectos / Órdenes / Calendario ════════════════════
  let _empCache = null;
  async function empOptions(selectedId) {
    if (!_empCache) { try { _empCache = await req('/recursos/empleados'); } catch (_) { _empCache = []; } }
    return `<option value="">— Sin asignar —</option>` + _empCache
      .map((e) => `<option value="${e.id}" data-nombre="${esc(e.nombre)}"${selectedId == e.id ? ' selected' : ''}>${esc(e.nombre)}${e.cargo ? ' (' + esc(e.cargo) + ')' : ''}</option>`).join('');
  }
  function empNameFromSelect(sel) {
    const o = sel && sel.selectedOptions && sel.selectedOptions[0];
    return o ? (o.dataset.nombre || '') : '';
  }
  const badge = (s) => `<span class="srv-badge srv-badge-${s}">${esc(String(s || '').replace(/_/g, ' '))}</span>`;

  // ── Contratos ────────────────────────────────────────────────────────────
  async function renderContratos() {
    const b = bodyOf('srv-contratos');
    actionsOf('srv-contratos').innerHTML = `<button class="btn btn-primary" data-new>+ Nuevo contrato</button>`;
    actionsOf('srv-contratos').querySelector('[data-new]').onclick = () => formContrato();
    b.innerHTML = '<div class="srv-loading">Cargando…</div>';
    try {
      const rows = await req('/contratos');
      b.innerHTML = table([
        { label: 'Número', key: 'numero' },
        { label: 'Título', key: 'titulo' },
        { label: 'Cliente', key: 'clientName' },
        { label: 'Frecuencia', key: 'frecuencia' },
        { label: 'Monto', num: true, render: (r) => money(r.monto) },
        { label: 'Vigencia', render: (r) => `${r.fechaInicio || '—'} → ${r.fechaFin || '—'}` },
        { label: 'Estado', render: (r) => badge(r.estado) },
        { label: '', render: (r) => `<button class="srv-link" data-edit="${r.id}">Editar</button> · <button class="srv-link" data-del="${r.id}">Eliminar</button>${r.estado === 'activo' ? ` · <button class="srv-link" data-susp="${r.id}">Suspender</button>` : ` · <button class="srv-link" data-act="${r.id}">Activar</button>`}` },
      ], rows);
      const byId = (id) => rows.find((x) => x.id == id);
      b.querySelectorAll('[data-edit]').forEach((el) => el.onclick = async () => formContrato(await req('/contratos/' + el.dataset.edit)));
      b.querySelectorAll('[data-del]').forEach((el) => el.onclick = async () => { if (confirm('¿Eliminar contrato?')) { try { await del('/contratos/' + el.dataset.del); toast('Contrato eliminado', 'success'); renderContratos(); } catch (e) { toast(e.message, 'error'); } } });
      b.querySelectorAll('[data-susp]').forEach((el) => el.onclick = () => cambioEstado('/contratos/' + el.dataset.susp + '/estado', 'suspendido', renderContratos));
      b.querySelectorAll('[data-act]').forEach((el) => el.onclick = () => cambioEstado('/contratos/' + el.dataset.act + '/estado', 'activo', renderContratos));
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }
  async function cambioEstado(path, estado, after) {
    try { await post(path, { estado }); toast('Estado actualizado', 'success'); after && after(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function formContrato(c) {
    const m = modal(c ? 'Editar contrato ' + c.numero : 'Nuevo contrato', `
      ${clientPickerHtml(c)}
      <label>Título<input name="titulo" required value="${esc(c?.titulo || '')}"></label>
      <label>Descripción<textarea name="descripcion" rows="2">${esc(c?.descripcion || '')}</textarea></label>
      <div class="srv-row">
        <label>Inicio<input name="fechaInicio" type="date" value="${esc(c?.fechaInicio || today())}"></label>
        <label>Fin<input name="fechaFin" type="date" value="${esc(c?.fechaFin || '')}"></label>
      </div>
      <div class="srv-row">
        <label>Monto<input name="monto" type="number" step="0.01" min="0" value="${c?.monto ?? 0}"></label>
        <label>Frecuencia<select name="frecuencia">${['unica', 'semanal', 'quincenal', 'mensual', 'trimestral', 'anual'].map((f) => `<option${c?.frecuencia === f ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
      </div>
      <label>Notas<textarea name="notas" rows="2">${esc(c?.notas || '')}</textarea></label>`, async (fd) => {
      const payload = { ...fd, clientId: fd.clientId || null };
      if (c) await put('/contratos/' + c.id, payload); else await post('/contratos', payload);
      toast('Contrato guardado', 'success'); renderContratos();
    }, { wide: true });
    wireClientPicker(m);
  }

  // ── Proyectos ────────────────────────────────────────────────────────────
  async function renderProyectos() {
    const b = bodyOf('srv-proyectos');
    actionsOf('srv-proyectos').innerHTML = `<button class="btn btn-primary" data-new>+ Nuevo proyecto</button>`;
    actionsOf('srv-proyectos').querySelector('[data-new]').onclick = () => formProyecto();
    b.innerHTML = '<div class="srv-loading">Cargando…</div>';
    try {
      const rows = await req('/proyectos');
      b.innerHTML = table([
        { label: 'Número', key: 'numero' },
        { label: 'Proyecto', key: 'nombre' },
        { label: 'Cliente', key: 'clientName' },
        { label: 'Responsable', key: 'responsable' },
        { label: 'Presupuesto', num: true, render: (r) => money(r.presupuesto) },
        { label: 'Avance', num: true, render: (r) => (r.avancePct || 0) + '%' },
        { label: 'Estado', render: (r) => badge(r.estado) },
        { label: '', render: (r) => `<button class="srv-link" data-view="${r.id}">Abrir</button>` },
      ], rows);
      b.querySelectorAll('[data-view]').forEach((el) => el.onclick = () => viewProyecto(el.dataset.view));
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }
  async function formProyecto(p) {
    const m = modal(p ? 'Editar proyecto ' + p.numero : 'Nuevo proyecto', `
      ${clientPickerHtml(p)}
      <label>Nombre<input name="nombre" required value="${esc(p?.nombre || '')}"></label>
      <label>Descripción<textarea name="descripcion" rows="2">${esc(p?.descripcion || '')}</textarea></label>
      <div class="srv-row">
        <label>Presupuesto<input name="presupuesto" type="number" step="0.01" min="0" value="${p?.presupuesto ?? 0}"></label>
        <label>Responsable<select name="responsableId" id="srv-pr-resp">${await empOptions(p?.responsableId)}</select></label>
      </div>
      <div class="srv-row">
        <label>Inicio<input name="fechaInicio" type="date" value="${esc(p?.fechaInicio || today())}"></label>
        <label>Entrega<input name="fechaEntrega" type="date" value="${esc(p?.fechaEntrega || '')}"></label>
      </div>
      <label>Notas<textarea name="notas" rows="2">${esc(p?.notas || '')}</textarea></label>`, async (fd, root) => {
      fd.responsableNombre = empNameFromSelect(root.querySelector('#srv-pr-resp'));
      const payload = { ...fd, clientId: fd.clientId || null, responsableId: fd.responsableId || null };
      if (p) await put('/proyectos/' + p.id, payload); else await post('/proyectos', payload);
      toast('Proyecto guardado', 'success'); renderProyectos();
    }, { wide: true });
    wireClientPicker(m);
  }
  async function viewProyecto(id) {
    const p = await req('/proyectos/' + id);
    const r = p.rentabilidad;
    const m = modal('Proyecto ' + p.numero + ' — ' + p.nombre, `
      <div class="srv-kpis">
        <div class="srv-kpi"><span class="srv-kpi-t">Presupuesto</span><span class="srv-kpi-v">${money(r.presupuesto)}</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Gastado</span><span class="srv-kpi-v">${money(r.gastado)}</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Facturado</span><span class="srv-kpi-v">${money(r.facturado)}</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Margen s/facturado</span><span class="srv-kpi-v">${money(r.margenFacturado)}</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Avance</span><span class="srv-kpi-v">${p.avancePct}%</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Estado</span><span class="srv-kpi-v">${esc(p.estado)}</span></div>
      </div>
      <div class="srv-row" style="margin-top:8px">
        <label>Cambiar estado<select id="srv-pr-est">${['planificacion', 'en_progreso', 'pausado', 'completado', 'cancelado'].map((s) => `<option${p.estado === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
        <button type="button" class="btn btn-ghost" id="srv-pr-est-apply">Aplicar</button>
        <button type="button" class="btn btn-ghost" id="srv-pr-edit">Editar datos</button>
      </div>
      <h3 class="srv-h3">Tareas <button type="button" class="srv-link" id="srv-pr-addtask">+ agregar</button></h3>
      <div id="srv-pr-tasks">${table([
        { label: 'Tarea', key: 'titulo' },
        { label: 'Asignado', key: 'asignado' },
        { label: 'Límite', render: (t) => t.fechaLimite || '—' },
        { label: 'Estado', render: (t) => `<select data-task="${t.id}">${['pendiente', 'en_progreso', 'hecha'].map((s) => `<option${t.estado === s ? ' selected' : ''}>${s}</option>`).join('')}</select>` },
        { label: '', render: (t) => `<button class="srv-link" data-deltask="${t.id}">✕</button>` },
      ], p.tareas)}</div>
      <h3 class="srv-h3">Gastos <button type="button" class="srv-link" id="srv-pr-addexp">+ agregar</button></h3>
      <div id="srv-pr-exps">${table([
        { label: 'Descripción', key: 'descripcion' },
        { label: 'Fecha', key: 'fecha' },
        { label: 'Monto', num: true, render: (e) => money(e.monto) },
        { label: '', render: (e) => `<button class="srv-link" data-delexp="${e.id}">✕</button>` },
      ], p.gastos)}</div>`, async () => {}, { wide: true, submitLabel: 'Cerrar' });

    const reload = async () => { m.remove(); viewProyecto(id); };
    m.querySelector('#srv-pr-est-apply').onclick = async () => {
      try { await post(`/proyectos/${id}/estado`, { estado: m.querySelector('#srv-pr-est').value }); toast('Estado actualizado', 'success'); renderProyectos(); reload(); }
      catch (e) { toast(e.message, 'error'); }
    };
    m.querySelector('#srv-pr-edit').onclick = () => { m.remove(); formProyecto(p); };
    m.querySelector('#srv-pr-addtask').onclick = () => {
      const titulo = prompt('Título de la tarea:'); if (!titulo) return;
      post(`/proyectos/${id}/tareas`, { titulo }).then(reload).catch((e) => toast(e.message, 'error'));
    };
    m.querySelector('#srv-pr-addexp').onclick = () => {
      const d = prompt('Descripción del gasto:'); if (!d) return;
      const mo = Number(prompt('Monto:') || 0); if (!(mo > 0)) return;
      post(`/proyectos/${id}/gastos`, { descripcion: d, monto: mo }).then(reload).catch((e) => toast(e.message, 'error'));
    };
    m.querySelectorAll('[data-task]').forEach((sel) => sel.onchange = () => post(`/proyectos/${id}/tareas/${sel.dataset.task}/estado`, { estado: sel.value }).then(() => { renderProyectos(); }).catch((e) => toast(e.message, 'error')));
    m.querySelectorAll('[data-deltask]').forEach((el) => el.onclick = () => del(`/proyectos/${id}/tareas/${el.dataset.deltask}`).then(reload).catch((e) => toast(e.message, 'error')));
    m.querySelectorAll('[data-delexp]').forEach((el) => el.onclick = () => del(`/proyectos/${id}/gastos/${el.dataset.delexp}`).then(reload).catch((e) => toast(e.message, 'error')));
  }

  // ── Órdenes de trabajo ───────────────────────────────────────────────────
  async function renderOrdenes() {
    const b = bodyOf('srv-ordenes');
    actionsOf('srv-ordenes').innerHTML = `<button class="btn btn-primary" data-new>+ Nueva orden</button>`;
    actionsOf('srv-ordenes').querySelector('[data-new]').onclick = () => formOrden();
    b.innerHTML = '<div class="srv-loading">Cargando…</div>';
    try {
      const rows = await req('/ordenes');
      b.innerHTML = table([
        { label: 'Número', key: 'numero' },
        { label: 'Título', key: 'titulo' },
        { label: 'Cliente', key: 'clientName' },
        { label: 'Tipo', key: 'tipo' },
        { label: 'Responsable', key: 'responsable' },
        { label: 'Programada', render: (r) => `${r.fechaProgramada || '—'} ${r.hora || ''}` },
        { label: 'Estado', render: (r) => `<select data-est="${r.id}">${['pendiente', 'asignada', 'en_proceso', 'completada', 'cancelada'].map((s) => `<option${r.estado === s ? ' selected' : ''}>${s}</option>`).join('')}</select>` },
        { label: '', render: (r) => `<button class="srv-link" data-edit="${r.id}">Editar</button> · <button class="srv-link" data-del="${r.id}">✕</button>` },
      ], rows);
      b.querySelectorAll('[data-est]').forEach((sel) => sel.onchange = () => post(`/ordenes/${sel.dataset.est}/estado`, { estado: sel.value }).then(() => toast('Estado actualizado', 'success')).catch((e) => { toast(e.message, 'error'); renderOrdenes(); }));
      b.querySelectorAll('[data-edit]').forEach((el) => el.onclick = async () => formOrden(await req('/ordenes/' + el.dataset.edit)));
      b.querySelectorAll('[data-del]').forEach((el) => el.onclick = async () => { if (confirm('¿Eliminar orden?')) { try { await del('/ordenes/' + el.dataset.del); toast('Orden eliminada', 'success'); renderOrdenes(); } catch (e) { toast(e.message, 'error'); } } });
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }
  async function formOrden(o) {
    const respOpts = await empOptions(o?.responsableId);
    const m = modal(o ? 'Editar orden ' + o.numero : 'Nueva orden de trabajo', `
      <div class="srv-form-sec">Cliente</div>
      ${clientPickerHtml(o)}

      <div class="srv-form-sec">Detalle del trabajo</div>
      <label>Título<input name="titulo" required value="${esc(o?.titulo || '')}" placeholder="Ej. Instalación de cámaras en local A"></label>
      <div class="srv-row">
        <label>Tipo<select name="tipo">${['servicio', 'soporte', 'mantenimiento', 'instalacion', 'trabajo'].map((t) => `<option${o?.tipo === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Prioridad<select name="prioridad">${['baja', 'normal', 'alta', 'urgente'].map((t) => `<option${(o?.prioridad || 'normal') === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      </div>
      <label>Descripción<textarea name="descripcion" rows="2">${esc(o?.descripcion || '')}</textarea></label>

      <div class="srv-form-sec">Programación</div>
      <div class="srv-row">
        <label>Responsable<select name="responsableId" id="srv-ot-resp">${respOpts}</select></label>
        <label>Fecha<input name="fechaProgramada" type="date" value="${esc(o?.fechaProgramada || today())}"></label>
        <label>Hora<input name="hora" type="time" value="${esc(o?.hora || '')}"></label>
      </div>
      <label>Ubicación<input name="ubicacion" value="${esc(o?.ubicacion || '')}" placeholder="Dirección o referencia del sitio"></label>
      <div class="srv-row">
        <label>Materiales / recursos<textarea name="materiales" rows="2">${esc(o?.materiales || '')}</textarea></label>
        <label>Observaciones<textarea name="observaciones" rows="2">${esc(o?.observaciones || '')}</textarea></label>
      </div>`, async (fd, root) => {
      fd.responsableNombre = empNameFromSelect(root.querySelector('#srv-ot-resp'));
      const payload = { ...fd, clientId: fd.clientId || null, responsableId: fd.responsableId || null };
      if (o) await put('/ordenes/' + o.id, payload); else await post('/ordenes', payload);
      toast('Orden guardada', 'success'); renderOrdenes();
    }, { wide: true });
    wireClientPicker(m);
  }

  // ── Calendario ───────────────────────────────────────────────────────────
  async function renderCalendario() {
    const b = bodyOf('srv-calendario');
    actionsOf('srv-calendario').innerHTML = `<button class="btn btn-primary" data-new>+ Programar servicio</button>`;
    actionsOf('srv-calendario').querySelector('[data-new]').onclick = () => formAgenda();
    b.innerHTML = '<div class="srv-loading">Cargando…</div>';
    try {
      const rows = await req('/calendario');
      b.innerHTML = table([
        { label: 'Fecha', key: 'fecha' },
        { label: 'Hora', key: 'hora' },
        { label: 'Servicio', key: 'titulo' },
        { label: 'Cliente', key: 'clientName' },
        { label: 'Empleado', key: 'empleado' },
        { label: 'Recurrencia', key: 'recurrencia' },
        { label: 'Estado', render: (r) => `<select data-est="${r.id}">${['programado', 'hecho', 'reprogramado', 'cancelado'].map((s) => `<option${r.estado === s ? ' selected' : ''}>${s}</option>`).join('')}</select>` },
        { label: '', render: (r) => `<button class="srv-link" data-edit="${r.id}">Editar</button> · <button class="srv-link" data-del="${r.id}">✕</button>` },
      ], rows);
      b.querySelectorAll('[data-est]').forEach((sel) => sel.onchange = () => post(`/calendario/${sel.dataset.est}/estado`, { estado: sel.value }).then(() => toast('Actualizado', 'success')).catch((e) => { toast(e.message, 'error'); renderCalendario(); }));
      b.querySelectorAll('[data-edit]').forEach((el) => el.onclick = async () => formAgenda((await req('/calendario')).find((x) => x.id == el.dataset.edit)));
      b.querySelectorAll('[data-del]').forEach((el) => el.onclick = async () => { if (confirm('¿Eliminar del calendario?')) { try { await del('/calendario/' + el.dataset.del); toast('Eliminado', 'success'); renderCalendario(); } catch (e) { toast(e.message, 'error'); } } });
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }
  async function formAgenda(s) {
    const m = modal(s ? 'Editar programación' : 'Programar servicio', `
      ${clientPickerHtml(s)}
      <label>Servicio / título<input name="titulo" required value="${esc(s?.titulo || '')}"></label>
      <div class="srv-row">
        <label>Fecha<input name="fecha" type="date" value="${esc(s?.fecha || today())}"></label>
        <label>Hora<input name="hora" type="time" value="${esc(s?.hora || '')}"></label>
        <label>Recurrencia<select name="recurrencia">${['unica', 'semanal', 'quincenal', 'mensual'].map((r) => `<option${s?.recurrencia === r ? ' selected' : ''}>${r}</option>`).join('')}</select></label>
      </div>
      <label>Empleado<select name="empleadoId" id="srv-ag-emp">${await empOptions(s?.empleadoId)}</select></label>
      <label>Notas<textarea name="notas" rows="2">${esc(s?.notas || '')}</textarea></label>`, async (fd, root) => {
      fd.empleadoNombre = empNameFromSelect(root.querySelector('#srv-ag-emp'));
      const payload = { ...fd, clientId: fd.clientId || null, empleadoId: fd.empleadoId || null };
      if (s) await put('/calendario/' + s.id, payload); else await post('/calendario', payload);
      toast('Servicio programado', 'success'); renderCalendario();
    }, { wide: true });
    wireClientPicker(m);
  }

  // ═══ M3 — Verticales especializados ══════════════════════════════════════
  // Helper CRUD list genérico con acciones estándar.
  function crudList(mod, newLabel, onNew) {
    const host = actionsOf(mod);
    if (host) { host.innerHTML = `<button class="btn btn-primary" data-new>+ ${esc(newLabel)}</button>`; host.querySelector('[data-new]').onclick = onNew; }
    bodyOf(mod).innerHTML = '<div class="srv-loading">Cargando…</div>';
  }
  async function prompt2(label1, label2) {
    const a = prompt(label1); if (a == null) return null;
    const b = prompt(label2); if (b == null) return null;
    return [a, b];
  }

  // ── Puestos de seguridad ─────────────────────────────────────────────────
  async function renderSeguridad() {
    crudList('srv-seguridad', 'Nuevo puesto', () => formPuesto());
    try {
      const rows = await req('/seguridad/puestos');
      bodyOf('srv-seguridad').innerHTML = table([
        { label: 'Número', key: 'numero' }, { label: 'Puesto', key: 'nombre' },
        { label: 'Cliente', key: 'clientName' }, { label: 'Ubicación', key: 'ubicacion' },
        { label: 'Guardias', num: true, key: 'guardiasRequeridos' },
        { label: 'Tarifa/mes', num: true, render: (r) => money(r.tarifaMensual) },
        { label: 'Estado', render: (r) => badge(r.estado) },
        { label: '', render: (r) => `<button class="srv-link" data-view="${r.id}">Abrir</button>` },
      ], rows);
      bodyOf('srv-seguridad').querySelectorAll('[data-view]').forEach((el) => el.onclick = () => viewPuesto(el.dataset.view));
    } catch (e) { bodyOf('srv-seguridad').innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }
  async function formPuesto(p) {
    const m = modal(p ? 'Editar puesto ' + p.numero : 'Nuevo puesto', `
      ${clientPickerHtml(p)}
      <label>Nombre del puesto<input name="nombre" required value="${esc(p?.nombre || '')}"></label>
      <label>Ubicación<input name="ubicacion" value="${esc(p?.ubicacion || '')}"></label>
      <div class="srv-row">
        <label>Tipo<select name="tipo">${['fijo', 'movil'].map((t) => `<option${p?.tipo === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Turnos/día<input name="turnosPorDia" type="number" min="1" value="${p?.turnosPorDia ?? 1}"></label>
        <label>Guardias<input name="guardiasRequeridos" type="number" min="1" value="${p?.guardiasRequeridos ?? 1}"></label>
        <label>Tarifa mensual<input name="tarifaMensual" type="number" step="0.01" min="0" value="${p?.tarifaMensual ?? 0}"></label>
      </div>
      <label>Notas<textarea name="notas" rows="2">${esc(p?.notas || '')}</textarea></label>`, async (fd) => {
      const payload = { ...fd, clientId: fd.clientId || null };
      if (p) await put('/seguridad/puestos/' + p.id, payload); else await post('/seguridad/puestos', payload);
      toast('Puesto guardado', 'success'); renderSeguridad();
    }, { wide: true });
    wireClientPicker(m);
  }
  async function viewPuesto(id) {
    const p = await req('/seguridad/puestos/' + id);
    const m = modal('Puesto ' + p.numero + ' — ' + p.nombre, `
      <p>${esc(p.clientName || 'Sin cliente')} · ${esc(p.ubicacion || '')} · ${esc(p.tipo)} · ${p.guardiasRequeridos} guardias · ${money(p.tarifaMensual)}/mes</p>
      <h3 class="srv-h3">Turnos <button type="button" class="srv-link" id="pt-add">+ agregar</button></h3>
      ${table([
        { label: 'Guardia', key: 'empleado' }, { label: 'Fecha', key: 'fecha' }, { label: 'Turno', key: 'turno' },
        { label: 'Estado', render: (t) => `<select data-shift="${t.id}">${['programado', 'cumplido', 'ausente', 'relevo'].map((s) => `<option${t.estado === s ? ' selected' : ''}>${s}</option>`).join('')}</select>` },
        { label: '', render: (t) => `<button class="srv-link" data-delshift="${t.id}">✕</button>` },
      ], p.turnos)}
      <h3 class="srv-h3">Incidencias <button type="button" class="srv-link" id="pi-add">+ agregar</button></h3>
      ${table([
        { label: 'Fecha', key: 'fecha' }, { label: 'Tipo', key: 'tipo' }, { label: 'Gravedad', key: 'gravedad' },
        { label: 'Descripción', key: 'descripcion' },
        { label: '', render: (i) => `<button class="srv-link" data-delinc="${i.id}">✕</button>` },
      ], p.incidencias)}`, async () => {}, { wide: true, submitLabel: 'Cerrar' });
    const reload = () => { m.remove(); viewPuesto(id); };
    m.querySelector('#pt-add').onclick = async () => {
      const r = await prompt2('Nombre del guardia:', 'Fecha (AAAA-MM-DD):'); if (!r) return;
      post(`/seguridad/puestos/${id}/turnos`, { employeeName: r[0], fecha: r[1] }).then(reload).catch((e) => toast(e.message, 'error'));
    };
    m.querySelector('#pi-add').onclick = async () => {
      const d = prompt('Descripción de la incidencia:'); if (!d) return;
      post(`/seguridad/puestos/${id}/incidencias`, { descripcion: d }).then(reload).catch((e) => toast(e.message, 'error'));
    };
    m.querySelectorAll('[data-shift]').forEach((s) => s.onchange = () => post(`/seguridad/turnos/${s.dataset.shift}/estado`, { estado: s.value }).catch((e) => toast(e.message, 'error')));
    m.querySelectorAll('[data-delshift]').forEach((el) => el.onclick = () => del(`/seguridad/turnos/${el.dataset.delshift}`).then(reload));
    m.querySelectorAll('[data-delinc]').forEach((el) => el.onclick = () => del(`/seguridad/incidencias/${el.dataset.delinc}`).then(reload));
  }

  // ── Equipos y mantenimiento ──────────────────────────────────────────────
  async function renderMantenimiento() {
    crudList('srv-mantenimiento', 'Nuevo equipo', () => formEquipo());
    try {
      const rows = await req('/mantenimiento/equipos');
      bodyOf('srv-mantenimiento').innerHTML = table([
        { label: 'Equipo', key: 'nombre' }, { label: 'Cliente', key: 'clientName' },
        { label: 'Marca/Modelo', render: (r) => `${r.marca || ''} ${r.modelo || ''}`.trim() || '—' },
        { label: 'Serie', key: 'serie' }, { label: 'Ubicación', key: 'ubicacion' },
        { label: 'Próx. revisión', render: (r) => r.proximaRevision || '—' },
        { label: 'Estado', render: (r) => badge(r.estado) },
        { label: '', render: (r) => `<button class="srv-link" data-view="${r.id}">Abrir</button>` },
      ], rows);
      bodyOf('srv-mantenimiento').querySelectorAll('[data-view]').forEach((el) => el.onclick = () => viewEquipo(el.dataset.view));
    } catch (e) { bodyOf('srv-mantenimiento').innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }
  async function formEquipo(eq) {
    const m = modal(eq ? 'Editar equipo' : 'Nuevo equipo', `
      ${clientPickerHtml(eq)}
      <label>Nombre<input name="nombre" required value="${esc(eq?.nombre || '')}"></label>
      <div class="srv-row">
        <label>Tipo<input name="tipo" value="${esc(eq?.tipo || '')}"></label>
        <label>Marca<input name="marca" value="${esc(eq?.marca || '')}"></label>
        <label>Modelo<input name="modelo" value="${esc(eq?.modelo || '')}"></label>
        <label>Serie<input name="serie" value="${esc(eq?.serie || '')}"></label>
      </div>
      <div class="srv-row">
        <label>Ubicación<input name="ubicacion" value="${esc(eq?.ubicacion || '')}"></label>
        <label>Estado<select name="estado">${['operativo', 'en_reparacion', 'fuera_servicio'].map((s) => `<option${eq?.estado === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
        <label>Próxima revisión<input name="proximaRevision" type="date" value="${esc(eq?.proximaRevision || '')}"></label>
      </div>
      <label>Notas<textarea name="notas" rows="2">${esc(eq?.notas || '')}</textarea></label>`, async (fd) => {
      const payload = { ...fd, clientId: fd.clientId || null };
      if (eq) await put('/mantenimiento/equipos/' + eq.id, payload); else await post('/mantenimiento/equipos', payload);
      toast('Equipo guardado', 'success'); renderMantenimiento();
    }, { wide: true });
    wireClientPicker(m);
  }
  async function viewEquipo(id) {
    const e = await req('/mantenimiento/equipos/' + id);
    const m = modal('Equipo — ' + e.nombre, `
      <p>${esc(e.clientName || '')} · ${esc(e.marca || '')} ${esc(e.modelo || '')} · Serie ${esc(e.serie || '—')} · ${esc(e.estado)}</p>
      <h3 class="srv-h3">Planes de mantenimiento <button type="button" class="srv-link" id="mp-add">+ agregar</button></h3>
      ${table([
        { label: 'Título', key: 'titulo' }, { label: 'Tipo', key: 'tipo' }, { label: 'Frecuencia', key: 'frecuencia' },
        { label: 'Próxima', render: (p) => p.proximaFecha || '—' },
        { label: '', render: (p) => `<button class="srv-link" data-delplan="${p.id}">✕</button>` },
      ], e.planes)}
      <h3 class="srv-h3">Historial de intervenciones <button type="button" class="srv-link" id="mh-add">+ agregar</button></h3>
      ${table([
        { label: 'Fecha', key: 'fecha' }, { label: 'Tipo', key: 'tipo' }, { label: 'Descripción', key: 'descripcion' },
        { label: 'Técnico', key: 'tecnico' }, { label: 'Costo', num: true, render: (h) => money(h.costo) },
      ], e.historial)}`, async () => {}, { wide: true, submitLabel: 'Cerrar' });
    const reload = () => { m.remove(); viewEquipo(id); };
    m.querySelector('#mp-add').onclick = async () => {
      const t = prompt('Título del plan:'); if (!t) return;
      post(`/mantenimiento/equipos/${id}/planes`, { titulo: t }).then(reload).catch((x) => toast(x.message, 'error'));
    };
    m.querySelector('#mh-add').onclick = async () => {
      const d = prompt('Descripción de la intervención:'); if (!d) return;
      const c = Number(prompt('Costo (0 si no aplica):') || 0);
      post(`/mantenimiento/equipos/${id}/historial`, { descripcion: d, costo: c }).then(reload).catch((x) => toast(x.message, 'error'));
    };
    m.querySelectorAll('[data-delplan]').forEach((el) => el.onclick = () => del(`/mantenimiento/planes/${el.dataset.delplan}`).then(reload));
  }

  // ── Reservaciones (viajes) ───────────────────────────────────────────────
  async function renderReservaciones() {
    crudList('srv-reservaciones', 'Nueva reservación', () => formReserva());
    try {
      const rows = await req('/viajes/reservaciones');
      bodyOf('srv-reservaciones').innerHTML = table([
        { label: 'Número', key: 'numero' }, { label: 'Título', key: 'titulo' }, { label: 'Cliente', key: 'clientName' },
        { label: 'Destino', key: 'destino' }, { label: 'Salida', render: (r) => r.fechaSalida || '—' },
        { label: 'Total', num: true, render: (r) => money(r.total) }, { label: 'Saldo', num: true, render: (r) => money(r.saldo) },
        { label: 'Estado', render: (r) => badge(r.estado) },
        { label: '', render: (r) => `<button class="srv-link" data-view="${r.id}">Abrir</button>` },
      ], rows);
      bodyOf('srv-reservaciones').querySelectorAll('[data-view]').forEach((el) => el.onclick = () => viewReserva(el.dataset.view));
    } catch (e) { bodyOf('srv-reservaciones').innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }
  async function formReserva(r) {
    const m = modal(r ? 'Editar reservación ' + r.numero : 'Nueva reservación', `
      ${clientPickerHtml(r)}
      <label>Título<input name="titulo" required value="${esc(r?.titulo || '')}"></label>
      <div class="srv-row">
        <label>Destino<input name="destino" value="${esc(r?.destino || '')}"></label>
        <label>Salida<input name="fechaSalida" type="date" value="${esc(r?.fechaSalida || '')}"></label>
        <label>Regreso<input name="fechaRegreso" type="date" value="${esc(r?.fechaRegreso || '')}"></label>
      </div>
      <div class="srv-row">
        <label>Costo<input name="costo" type="number" step="0.01" min="0" value="${r?.costo ?? 0}"></label>
        <label>Total al cliente<input name="total" type="number" step="0.01" min="0" value="${r?.total ?? 0}"></label>
        <label>Anticipo<input name="anticipo" type="number" step="0.01" min="0" value="${r?.anticipo ?? 0}"></label>
      </div>
      <label>Proveedor principal<input name="proveedorPrincipal" value="${esc(r?.proveedorPrincipal || '')}"></label>
      <label>Notas<textarea name="notas" rows="2">${esc(r?.notas || '')}</textarea></label>`, async (fd) => {
      const payload = { ...fd, clientId: fd.clientId || null };
      if (r) await put('/viajes/reservaciones/' + r.id, payload); else await post('/viajes/reservaciones', payload);
      toast('Reservación guardada', 'success'); renderReservaciones();
    }, { wide: true });
    wireClientPicker(m);
  }
  async function viewReserva(id) {
    const r = await req('/viajes/reservaciones/' + id);
    const m = modal('Reservación ' + r.numero, `
      <div class="srv-kpis">
        <div class="srv-kpi"><span class="srv-kpi-t">Total</span><span class="srv-kpi-v">${money(r.total)}</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Anticipo</span><span class="srv-kpi-v">${money(r.anticipo)}</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Saldo</span><span class="srv-kpi-v">${money(r.saldo)}</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Costo</span><span class="srv-kpi-v">${money(r.costo)}</span></div>
      </div>
      <div class="srv-row" style="margin-top:8px">
        <label>Estado<select id="rs-est">${['cotizada', 'confirmada', 'en_curso', 'completada', 'cancelada'].map((s) => `<option${r.estado === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
        <button type="button" class="btn btn-ghost" id="rs-est-apply">Aplicar</button>
        <button type="button" class="btn btn-ghost" id="rs-edit">Editar</button>
      </div>
      <h3 class="srv-h3">Servicios (vuelos, hoteles…) <button type="button" class="srv-link" id="ri-add">+ agregar</button></h3>
      ${table([
        { label: 'Tipo', key: 'tipo' }, { label: 'Descripción', key: 'descripcion' }, { label: 'Proveedor', key: 'proveedor' },
        { label: 'Costo', num: true, render: (i) => money(i.costo) }, { label: 'Precio', num: true, render: (i) => money(i.precio) },
        { label: '', render: (i) => `<button class="srv-link" data-delitem="${i.id}">✕</button>` },
      ], r.items)}
      <h3 class="srv-h3">Viajeros <button type="button" class="srv-link" id="rt-add">+ agregar</button></h3>
      ${table([{ label: 'Nombre', key: 'nombre' }, { label: '', render: (t) => `<button class="srv-link" data-deltrav="${t.id}">✕</button>` }], r.viajeros)}
      <h3 class="srv-h3">Comisiones <button type="button" class="srv-link" id="rc-add">+ agregar</button></h3>
      ${table([
        { label: 'Descripción', key: 'descripcion' }, { label: 'Base', num: true, render: (c) => money(c.base) },
        { label: '%', num: true, key: 'pct' }, { label: 'Monto', num: true, render: (c) => money(c.monto) },
        { label: 'Estado', render: (c) => `<select data-com="${c.id}">${['pendiente', 'cobrada', 'anulada'].map((s) => `<option${c.estado === s ? ' selected' : ''}>${s}</option>`).join('')}</select>` },
      ], r.comisiones)}`, async () => {}, { wide: true, submitLabel: 'Cerrar' });
    const reload = () => { m.remove(); viewReserva(id); };
    m.querySelector('#rs-est-apply').onclick = () => post(`/viajes/reservaciones/${id}/estado`, { estado: m.querySelector('#rs-est').value }).then(() => { renderReservaciones(); reload(); }).catch((e) => toast(e.message, 'error'));
    m.querySelector('#rs-edit').onclick = () => { m.remove(); formReserva(r); };
    m.querySelector('#ri-add').onclick = async () => {
      const d = prompt('Descripción (ej. Vuelo SDQ-MIA):'); if (!d) return;
      const costo = Number(prompt('Costo:') || 0); const precio = Number(prompt('Precio al cliente:') || 0);
      post(`/viajes/reservaciones/${id}/items`, { descripcion: d, costo, precio }).then(reload).catch((e) => toast(e.message, 'error'));
    };
    m.querySelector('#rt-add').onclick = async () => { const n = prompt('Nombre del viajero:'); if (!n) return; post(`/viajes/reservaciones/${id}/viajeros`, { travelerName: n }).then(reload).catch((e) => toast(e.message, 'error')); };
    m.querySelector('#rc-add').onclick = async () => {
      const d = prompt('Descripción de la comisión:'); if (!d) return;
      const base = Number(prompt('Base:') || 0); const pct = Number(prompt('% comisión:') || 0);
      post(`/viajes/reservaciones/${id}/comisiones`, { descripcion: d, base, pct }).then(reload).catch((e) => toast(e.message, 'error'));
    };
    m.querySelectorAll('[data-delitem]').forEach((el) => el.onclick = () => del(`/viajes/items/${el.dataset.delitem}`).then(reload));
    m.querySelectorAll('[data-deltrav]').forEach((el) => el.onclick = () => del(`/viajes/viajeros-reserva/${el.dataset.deltrav}`).then(reload));
    m.querySelectorAll('[data-com]').forEach((s) => s.onchange = () => post(`/viajes/comisiones/${s.dataset.com}/estado`, { estado: s.value }).catch((e) => toast(e.message, 'error')));
  }

  // ── Campañas (publicidad) ────────────────────────────────────────────────
  async function renderCampanas() {
    crudList('srv-campanas', 'Nueva campaña', () => formCampana());
    try {
      const rows = await req('/campanas');
      bodyOf('srv-campanas').innerHTML = table([
        { label: 'Número', key: 'numero' }, { label: 'Campaña', key: 'nombre' }, { label: 'Cliente', key: 'clientName' },
        { label: 'Canal', key: 'canal' }, { label: 'Presupuesto', num: true, render: (r) => money(r.presupuesto) },
        { label: 'Gastado', num: true, render: (r) => money(r.gastado) }, { label: 'Estado', render: (r) => badge(r.estado) },
        { label: '', render: (r) => `<button class="srv-link" data-view="${r.id}">Abrir</button>` },
      ], rows);
      bodyOf('srv-campanas').querySelectorAll('[data-view]').forEach((el) => el.onclick = () => viewCampana(el.dataset.view));
    } catch (e) { bodyOf('srv-campanas').innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }
  async function formCampana(c) {
    const m = modal(c ? 'Editar campaña ' + c.numero : 'Nueva campaña', `
      ${clientPickerHtml(c)}
      <label>Nombre<input name="nombre" required value="${esc(c?.nombre || '')}"></label>
      <label>Objetivo<textarea name="objetivo" rows="2">${esc(c?.objetivo || '')}</textarea></label>
      <div class="srv-row">
        <label>Canal<select name="canal">${['redes', 'tv', 'radio', 'exterior', 'digital', 'mixto'].map((x) => `<option${c?.canal === x ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
        <label>Presupuesto<input name="presupuesto" type="number" step="0.01" min="0" value="${c?.presupuesto ?? 0}"></label>
      </div>
      <div class="srv-row">
        <label>Inicio<input name="fechaInicio" type="date" value="${esc(c?.fechaInicio || today())}"></label>
        <label>Fin<input name="fechaFin" type="date" value="${esc(c?.fechaFin || '')}"></label>
      </div>
      <label>Notas<textarea name="notas" rows="2">${esc(c?.notas || '')}</textarea></label>`, async (fd) => {
      const payload = { ...fd, clientId: fd.clientId || null };
      if (c) await put('/campanas/' + c.id, payload); else await post('/campanas', payload);
      toast('Campaña guardada', 'success'); renderCampanas();
    }, { wide: true });
    wireClientPicker(m);
  }
  async function viewCampana(id) {
    const c = await req('/campanas/' + id);
    const m = modal('Campaña ' + c.numero + ' — ' + c.nombre, `
      <div class="srv-kpis">
        <div class="srv-kpi"><span class="srv-kpi-t">Presupuesto</span><span class="srv-kpi-v">${money(c.presupuesto)}</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Gastado</span><span class="srv-kpi-v">${money(c.gastado)}</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Disponible</span><span class="srv-kpi-v">${money(c.disponible)}</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Canal</span><span class="srv-kpi-v">${esc(c.canal)}</span></div>
      </div>
      <h3 class="srv-h3">Gastos de campaña <button type="button" class="srv-link" id="ce-add">+ agregar</button></h3>
      ${table([
        { label: 'Descripción', key: 'descripcion' }, { label: 'Categoría', key: 'categoria' }, { label: 'Fecha', key: 'fecha' },
        { label: 'Monto', num: true, render: (g) => money(g.monto) },
        { label: '', render: (g) => `<button class="srv-link" data-delexp="${g.id}">✕</button>` },
      ], c.gastos)}`, async () => {}, { wide: true, submitLabel: 'Cerrar' });
    const reload = () => { m.remove(); viewCampana(id); };
    m.querySelector('#ce-add').onclick = async () => {
      const d = prompt('Descripción del gasto:'); if (!d) return;
      const mo = Number(prompt('Monto:') || 0); if (!(mo > 0)) return;
      post(`/campanas/${id}/gastos`, { descripcion: d, monto: mo }).then(reload).catch((e) => toast(e.message, 'error'));
    };
    m.querySelectorAll('[data-delexp]').forEach((el) => el.onclick = () => del(`/campanas/gastos/${el.dataset.delexp}`).then(reload));
  }

  // ── Obras (arquitectura) ─────────────────────────────────────────────────
  async function renderObras() {
    crudList('srv-obras', 'Nueva obra', () => formObra());
    try {
      const rows = await req('/obras');
      bodyOf('srv-obras').innerHTML = table([
        { label: 'Número', key: 'numero' }, { label: 'Obra', key: 'nombre' }, { label: 'Cliente', key: 'clientName' },
        { label: 'Dirección', key: 'direccion' }, { label: 'Presupuesto', num: true, render: (r) => money(r.presupuesto) },
        { label: 'Avance', num: true, render: (r) => (r.avancePct || 0) + '%' }, { label: 'Estado', render: (r) => badge(r.estado) },
        { label: '', render: (r) => `<button class="srv-link" data-view="${r.id}">Abrir</button>` },
      ], rows);
      bodyOf('srv-obras').querySelectorAll('[data-view]').forEach((el) => el.onclick = () => viewObra(el.dataset.view));
    } catch (e) { bodyOf('srv-obras').innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }
  async function formObra(s) {
    const m = modal(s ? 'Editar obra ' + s.numero : 'Nueva obra', `
      ${clientPickerHtml(s)}
      <label>Nombre<input name="nombre" required value="${esc(s?.nombre || '')}"></label>
      <label>Dirección<input name="direccion" value="${esc(s?.direccion || '')}"></label>
      <div class="srv-row">
        <label>Tipo<select name="tipo">${['residencial', 'comercial', 'industrial', 'remodelacion'].map((x) => `<option${s?.tipo === x ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
        <label>Presupuesto<input name="presupuesto" type="number" step="0.01" min="0" value="${s?.presupuesto ?? 0}"></label>
      </div>
      <div class="srv-row">
        <label>Inicio<input name="fechaInicio" type="date" value="${esc(s?.fechaInicio || today())}"></label>
        <label>Fin estimado<input name="fechaFinEstimada" type="date" value="${esc(s?.fechaFinEstimada || '')}"></label>
      </div>
      <label>Notas<textarea name="notas" rows="2">${esc(s?.notas || '')}</textarea></label>`, async (fd) => {
      const payload = { ...fd, clientId: fd.clientId || null };
      if (s) await put('/obras/' + s.id, payload); else await post('/obras', payload);
      toast('Obra guardada', 'success'); renderObras();
    }, { wide: true });
    wireClientPicker(m);
  }
  async function viewObra(id) {
    const s = await req('/obras/' + id);
    const m = modal('Obra ' + s.numero + ' — ' + s.nombre, `
      <div class="srv-kpis">
        <div class="srv-kpi"><span class="srv-kpi-t">Presupuesto</span><span class="srv-kpi-v">${money(s.presupuesto)}</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Gasto materiales</span><span class="srv-kpi-v">${money(s.gastoMateriales)}</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Avance</span><span class="srv-kpi-v">${s.avancePct}%</span></div>
        <div class="srv-kpi"><span class="srv-kpi-t">Estado</span><span class="srv-kpi-v">${esc(s.estado)}</span></div>
      </div>
      <h3 class="srv-h3">Avances <button type="button" class="srv-link" id="op-add">+ registrar</button></h3>
      ${table([
        { label: 'Fecha', key: 'fecha' }, { label: 'Avance', num: true, render: (p) => p.avancePct + '%' },
        { label: 'Descripción', key: 'descripcion' }, { label: 'Reportado por', key: 'reportadoPor' },
        { label: '', render: (p) => `<button class="srv-link" data-delp="${p.id}">✕</button>` },
      ], s.avances)}
      <h3 class="srv-h3">Materiales <button type="button" class="srv-link" id="om-add">+ agregar</button></h3>
      ${table([
        { label: 'Descripción', key: 'descripcion' }, { label: 'Cant.', num: true, key: 'cantidad' },
        { label: 'Costo unit.', num: true, render: (mm) => money(mm.costoUnit) }, { label: 'Total', num: true, render: (mm) => money(mm.costoTotal) },
        { label: '', render: (mm) => `<button class="srv-link" data-delm="${mm.id}">✕</button>` },
      ], s.materiales)}`, async () => {}, { wide: true, submitLabel: 'Cerrar' });
    const reload = () => { m.remove(); viewObra(id); };
    m.querySelector('#op-add').onclick = async () => {
      const pct = Number(prompt('Avance total (%):') || 0);
      const d = prompt('Descripción del avance:') || '';
      post(`/obras/${id}/avances`, { avancePct: pct, descripcion: d }).then(() => { renderObras(); reload(); }).catch((e) => toast(e.message, 'error'));
    };
    m.querySelector('#om-add').onclick = async () => {
      const d = prompt('Descripción del material:'); if (!d) return;
      const cant = Number(prompt('Cantidad:') || 1); const cu = Number(prompt('Costo unitario:') || 0);
      post(`/obras/${id}/materiales`, { descripcion: d, cantidad: cant, costoUnit: cu }).then(reload).catch((e) => toast(e.message, 'error'));
    };
    m.querySelectorAll('[data-delp]').forEach((el) => el.onclick = () => del(`/obras/avances/${el.dataset.delp}`).then(reload));
    m.querySelectorAll('[data-delm]').forEach((el) => el.onclick = () => del(`/obras/materiales/${el.dataset.delm}`).then(reload));
  }

  // ═══ M4 — Reportes y Ajustes ═════════════════════════════════════════════
  function csvFrom(cols, rows) {
    const head = cols.map((c) => `"${c}"`).join(',');
    const body = rows.map((r) => cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    return head + '\n' + body;
  }
  function downloadText(name, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function renderReportes() {
    const host = actionsOf('srv-reportes');
    const b = bodyOf('srv-reportes');
    const d1 = new Date(); d1.setDate(1);
    host.innerHTML = `
      <label style="font-size:12px">Desde <input type="date" id="srv-rep-d1" value="${d1.toISOString().slice(0, 10)}"></label>
      <label style="font-size:12px">Hasta <input type="date" id="srv-rep-d2" value="${today()}"></label>
      <button class="btn btn-ghost" id="srv-rep-go">Generar</button>`;
    const load = async () => {
      b.innerHTML = '<div class="srv-loading">Cargando…</div>';
      const qs = new URLSearchParams({ desde: document.getElementById('srv-rep-d1').value, hasta: document.getElementById('srv-rep-d2').value });
      try {
        const d = await req('/reportes?' + qs);
        const section = (title, cols, keys, rows) => `
          <div class="srv-rep-block">
            <div class="srv-rep-head"><h3 class="srv-h3">${title}</h3>
              <button class="srv-link" data-csv="${esc(title)}">Exportar CSV</button></div>
            ${table(cols.map((c, i) => ({ label: c, num: i > 0, render: (r) => (i === 0 ? esc(r.grupo) : (keys[i - 1].includes('monto') || keys[i - 1].includes('factur') || keys[i - 1].includes('cobr') || keys[i - 1].includes('balance') || keys[i - 1].includes('vencido') ? money(r[keys[i - 1]]) : r[keys[i - 1]])) })), rows)}
          </div>`;
        b.innerHTML = `
          ${section('Por sucursal', ['Sucursal', 'Facturas', 'Facturado', 'Cobrado', 'Por cobrar'], ['facturas', 'facturado', 'cobrado', 'por_cobrar'], d.porSucursal)}
          ${section('Por usuario', ['Usuario', 'Facturas', 'Facturado'], ['facturas', 'facturado'], d.porUsuario)}
          ${section('Por servicio', ['Servicio', 'Cantidad', 'Monto'], ['cantidad', 'monto'], d.porServicio)}
          ${section('Por cliente', ['Cliente', 'Facturas', 'Facturado', 'Por cobrar'], ['facturas', 'facturado', 'por_cobrar'], d.porCliente)}
          ${section('Por método de pago', ['Método', 'Pagos', 'Monto'], ['pagos', 'monto'], d.porMetodoPago)}
          ${section('Cotizaciones', ['Estado', 'Cantidad', 'Monto'], ['cantidad', 'monto'], d.cotizaciones)}
          ${section('Cuentas por cobrar', ['Sucursal', 'Facturas', 'Balance', 'Vencido'], ['facturas', 'balance', 'vencido'], d.cuentasPorCobrar)}`;
        const map = { 'Por sucursal': d.porSucursal, 'Por usuario': d.porUsuario, 'Por servicio': d.porServicio, 'Por cliente': d.porCliente, 'Por método de pago': d.porMetodoPago, 'Cotizaciones': d.cotizaciones, 'Cuentas por cobrar': d.cuentasPorCobrar };
        b.querySelectorAll('[data-csv]').forEach((el) => el.onclick = () => {
          const rows = map[el.dataset.csv] || [];
          const cols = rows.length ? Object.keys(rows[0]) : ['grupo'];
          downloadText(el.dataset.csv.replace(/\s+/g, '_') + '.csv', csvFrom(cols, rows));
        });
      } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
    };
    host.querySelector('#srv-rep-go').onclick = load;
    load();
  }

  // Agrega una tarjeta "Empresa de Servicios" a la grilla de tarjetas de
  // Configuración (#cfg-group-card-grid la crea app.js). Abre un modal con los
  // ajustes de facturación + correo. Se llama al abrir Configuración.
  function mountConfigSection(tries = 0) {
    const grid = document.getElementById('cfg-group-card-grid');
    if (!grid) {
      if (tries < 20) setTimeout(() => mountConfigSection(tries + 1), 150);
      return;
    }
    if (document.getElementById('srv-cfg-card')) return;
    const card = document.createElement('div');
    card.id = 'srv-cfg-card';
    card.className = 'cfg-group-card';
    card.innerHTML = `<div class="cfg-group-card__icon" style="background:rgba(14,165,233,.13);color:#0ea5e9">⚙️</div>
      <div class="cfg-group-card__body"><span class="cfg-group-card__title">Empresa de Servicios</span>
      <span class="cfg-group-card__desc">Comprobante por defecto, formato de factura y correo (Gmail)</span></div>
      <span class="cfg-group-card__arrow">›</span>`;
    card.addEventListener('click', openServiciosConfigModal);
    grid.appendChild(card);
  }

  async function openServiciosConfigModal() {
    let cfg;
    try { cfg = await req('/config'); } catch (e) { toast(e.message, 'error'); return; }
    const m = modal('⚙️ Ajustes de Empresa de Servicios', `
      <label>Comprobante fiscal por defecto
        <select name="fiscalMode">
          <option value="ncf"${cfg.fiscalMode === 'ncf' ? ' selected' : ''}>NCF tradicional</option>
          <option value="ecf"${cfg.fiscalMode === 'ecf' ? ' selected' : ''}>e-CF</option>
          <option value="consumidor"${cfg.fiscalMode === 'consumidor' ? ' selected' : ''}>Sin comprobante</option>
        </select></label>
      <label>Formato de impresión por defecto
        <select name="invoiceFormat">
          <option value="a4"${cfg.invoiceFormat === 'a4' ? ' selected' : ''}>A4</option>
          <option value="80mm"${cfg.invoiceFormat === '80mm' ? ' selected' : ''}>80 mm</option>
          <option value="58mm"${cfg.invoiceFormat === '58mm' ? ' selected' : ''}>58 mm</option>
        </select></label>
      <p class="srv-hint">El envío por correo siempre usa A4, sin importar este ajuste.</p>
      <hr style="border:0;border-top:1px solid var(--border,#e2e8f0);margin:4px 0">
      <div class="srv-row">
        <label>Cuenta Gmail<input name="mailUser" type="email" value="${esc(cfg.mailUser || '')}" placeholder="tuempresa@gmail.com"></label>
        <label>Nombre del remitente<input name="mailFrom" value="${esc(cfg.mailFrom || '')}" placeholder="Tu Empresa"></label>
      </div>
      <label>Contraseña de aplicación de Google
        <input name="mailPass" type="password" placeholder="${cfg.mailConfigured ? '•••••••• guardada (vacío = no cambiar)' : '16 caracteres'}"></label>
      <p class="srv-hint">Cuenta de Google → Seguridad → Verificación en 2 pasos → <strong>Contraseñas de aplicaciones</strong>. No uses tu contraseña normal.</p>`,
    async (fd) => {
      if (!fd.mailPass) delete fd.mailPass;
      await put('/config', fd);
      toast('Ajustes guardados', 'success');
    }, { submitLabel: 'Guardar' });
    return m;
  }

  const RENDERERS = {
    'srv-dashboard': renderDashboard,
    'srv-servicios': renderServicios,
    'srv-cotizaciones': renderCotizaciones,
    'srv-contratos': renderContratos,
    'srv-proyectos': renderProyectos,
    'srv-obras': renderObras,
    'srv-campanas': renderCampanas,
    'srv-ordenes': renderOrdenes,
    'srv-mantenimiento': renderMantenimiento,
    'srv-seguridad': renderSeguridad,
    'srv-reservaciones': renderReservaciones,
    'srv-calendario': renderCalendario,
    'srv-facturas': renderFacturas,
    'srv-cobros': renderCobros,
    'srv-cxc': renderCxc,
    'srv-auditoria': renderAuditoria,
  };

  window.Servicios = {
    injectChrome,
    onShow(mod) {
      injectChrome();
      const fn = RENDERERS[mod];
      if (fn) fn().catch((e) => toast(e.message || 'Error', 'error'));
    },
    onConfigOpen() {
      try { mountConfigSection(); } catch (e) { console.warn('[servicios] config card:', e); }
    },
  };

  // En modo servicios, la reimpresión/vista de comprobante (POS) se reemplaza
  // por el documento A4 profesional. Envuelve showReceipt: si la venta
  // corresponde a una factura de servicios, abre el A4; si no, deja el recibo
  // normal del POS.
  function wrapShowReceipt() {
    if (typeof window.showReceipt !== 'function' || window.showReceipt.__srvWrapped) return;
    const orig = window.showReceipt;
    const wrapped = function (venta, options) {
      const svc = document.documentElement.dataset.appMode === 'servicios';
      const num = venta && (venta.numero || venta.invoiceNumber || venta.invoice_number || venta.id);
      if (svc && num && !(options && options.preview)) {
        req('/facturas/por-numero/' + encodeURIComponent(num))
          .then((r) => { if (r && r.id) abrirDoc('facturas', r.id, 'Factura'); else orig.call(this, venta, options); })
          .catch(() => orig.call(this, venta, options));
        return;
      }
      return orig.apply(this, arguments);
    };
    wrapped.__srvWrapped = true;
    window.showReceipt = wrapped;
  }

  // Inyecta el chrome en cuanto el DOM esté listo (los ítems quedan ocultos si
  // la instalación no es de servicios, vía applyRolePermissions/isBusinessModuleEnabled).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { injectChrome(); wrapShowReceipt(); });
  } else {
    injectChrome();
    wrapShowReceipt();
  }
  // Reintento por si ventas.js aún no había definido showReceipt.
  setTimeout(wrapShowReceipt, 1500);
})();

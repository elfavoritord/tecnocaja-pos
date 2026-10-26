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
  const n2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

  // Plantilla estándar de la nota "Condiciones de pago" de las cotizaciones.
  // Marcadores: {pct} {restantePct} {anticipo} {restante} {total}
  const DEFAULT_QUOTE_TERMS = `NOTA – CONDICIONES DE PAGO

En caso de que el cliente esté interesado en adquirir la solución completa, incluyendo equipos, transporte, instalación, configuración e implementación del sistema, se requiere un anticipo del {pct}% del monto total cotizado, equivalente a {anticipo}.

Este anticipo será utilizado para proceder con la adquisición y preparación de los equipos, así como cubrir los gastos de transporte y logística necesarios para la instalación.

El {restantePct}% restante, equivalente a {restante}, deberá ser saldado al momento de completar la instalación, configuración y puesta en funcionamiento de la solución.

Monto total de la cotización: {total}

Condición: La compra de los equipos y la programación de la instalación estarán sujetas a la confirmación y recepción del anticipo correspondiente.`;

  function buildQuoteTerms(total, pct, tpl) {
    const p = Math.min(100, Math.max(0, Number(pct) || 0));
    const anticipo = n2(total * p / 100);
    const restante = n2(total - anticipo);
    const base = (tpl && tpl.trim()) ? tpl : DEFAULT_QUOTE_TERMS;
    return base
      .split('{pct}').join(String(p % 1 ? p : Math.round(p)))
      .split('{restantePct}').join(String((100 - p) % 1 ? n2(100 - p) : Math.round(100 - p)))
      .split('{anticipo}').join(money(anticipo))
      .split('{restante}').join(money(restante))
      .split('{total}').join(money(n2(total)));
  }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Fecha LOCAL (toISOString es UTC: en RD, después de las 8 p. m. daba mañana).
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
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
    { mod: 'srv-gastos', label: 'Gastos', icon: '💸' },
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
  // xl + subtitle: formularios por secciones (factura y cotización).
  function modal(title, contentHtml, onSubmit, { wide, xl, subtitle, submitLabel } = {}) {
    const back = document.createElement('div');
    // tc-themed: cuelga de <body> (fuera de #app) y así toma el tema día/noche.
    back.className = 'srv-modal-back tc-themed';
    const size = xl ? 'srv-modal-xl' : (wide ? 'srv-modal-wide' : '');
    back.innerHTML = `
      <div class="srv-modal ${size}">
        <div class="srv-modal-head"><div><h3>${esc(title)}</h3>${subtitle ? `<p class="srv-modal-sub">${esc(subtitle)}</p>` : ''}</div><button type="button" data-x title="Cerrar">✕</button></div>
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
        if (btn) { btn.disabled = false; btn.textContent = submitLabel || 'Guardar'; }
      }
    });
    return back;
  }

  // ── Selector de cliente (usa DB.clientes ya cargado en el renderer) ──────
  // grid=true: los tres campos en una fila (formularios por secciones).
  function clientPickerHtml(cur, { grid, optionalConsumer = false } = {}) {
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
    if (grid) {
      return `
      <div class="srv-grid srv-grid-cli">
        <label>Seleccionar cliente
          <select name="clientId" id="srv-cli-pick"><option value="">— Nuevo / sin registrar —</option>${opts}</select>
        </label>
        <label><span class="srv-lbl">Nombre o razón social <span class="srv-req" id="srv-cli-name-req"${optionalConsumer ? ' hidden' : ''}>*</span></span>
          <input name="clientName" id="srv-cli-name" value="${esc(cur?.clientName || '')}" placeholder="${optionalConsumer ? 'Opcional para consumidor final' : 'Ej: Consultora XYZ SRL'}"${optionalConsumer ? '' : ' required'}></label>
        <label><span class="srv-lbl">RNC / Cédula <span class="srv-req" id="srv-cli-rnc-req" hidden>*</span></span>
          <input name="clientRnc" id="srv-cli-rnc" value="${esc(rncInicial)}" placeholder="RNC (9 dígitos) o cédula (11)" inputmode="numeric"></label>
      </div>
      <p class="srv-hint" id="srv-cli-email-hint"></p>`;
    }
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
    let habiaCliente = false;
    // inicial=true solo al abrir en edición: conserva el RNC guardado si el
    // catálogo no tiene. Al cambiar de cliente no se arrastra el RNC del anterior.
    const fill = (inicial) => {
      const o = pick.selectedOptions[0];
      if (pick.value && o) {
        name.value = o.dataset.nombre || '';
        rnc.value = o.dataset.rnc || (inicial === true ? rnc.value : '') || '';
        // Si el cliente no tiene RNC en el catálogo, se deja escribir aquí
        // (el backend usa la cédula del catálogo y, si falta, la escrita).
        name.readOnly = true; rnc.readOnly = !!o.dataset.rnc;
        hint.textContent = o.dataset.email ? 'Correo: ' + o.dataset.email : 'Este cliente no tiene correo — agrégalo en Clientes para poder enviar la factura.';
        habiaCliente = true;
      } else {
        if (habiaCliente) { name.value = ''; rnc.value = ''; }
        name.readOnly = false; rnc.readOnly = false;
        hint.textContent = '';
        habiaCliente = false;
      }
    };
    pick.addEventListener('change', () => fill(false));
    if (pick.value) fill(true); // cliente preseleccionado (edición): rellenar de una
  }

  const DATE_KEYS = /^(fecha|vencimiento|createdAt|updatedAt|fechaProgramada|fechaInicio|fechaEntrega|fechaSalida|fechaRegreso|fechaLimite|proximaRevision|proximaFecha|fechaFin|fechaFinEstimada|anuladoAt|completadaAt)$/;
  function cellValue(c, r) {
    if (c.render) return c.render(r);
    const v = r[c.key];
    if (c.key && DATE_KEYS.test(c.key) && v) return esc(fdate(v));
    return esc(v);
  }
  // Montos y fechas no se parten en dos líneas (clase nw).
  function table(cols, rows) {
    const clase = (c) => {
      const cls = [c.num && 'num', c.key && DATE_KEYS.test(c.key) && 'nw'].filter(Boolean).join(' ');
      return cls ? ` class="${cls}"` : '';
    };
    return `<div class="srv-table-wrap"><table class="srv-table">
      <thead><tr>${cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr>${cols.map((c) => `<td${clase(c)}>${cellValue(c, r)}</td>`).join('')}</tr>`).join('')
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
  const PERIODOS_PANEL = [['mes', 'Este mes'], ['anterior', 'Mes anterior'], ['anio', 'Este año']];
  let _dashPeriodo = 'mes';

  function rangoPanel(periodo) {
    const d = new Date();
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    if (periodo === 'anterior') {
      return { desde: iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), hasta: iso(new Date(d.getFullYear(), d.getMonth(), 0)) };
    }
    if (periodo === 'anio') return { desde: `${d.getFullYear()}-01-01`, hasta: today() };
    return { desde: iso(new Date(d.getFullYear(), d.getMonth(), 1)), hasta: today() };
  }

  // Lleva al módulo de la tarjeta si está activo en este tipo de empresa.
  function irAModulo(mod) {
    const nav = document.querySelector(`.nav-item[data-module="${mod}"]`);
    if (nav && getComputedStyle(nav).display !== 'none') window.showModule(mod, nav);
  }

  // Barras horizontales simples: [{ etiqueta, valor, extra?, tono? }].
  function barras(filas, vacio) {
    if (!filas.length) return `<p class="srv-dash-vacio">${esc(vacio)}</p>`;
    const max = Math.max(...filas.map((f) => Math.abs(f.valor)), 1);
    return `<div class="srv-barras">${filas.map((f) => `
      <div class="srv-barra${f.tono ? ' srv-barra--' + f.tono : ''}">
        <div class="srv-barra-txt"><span>${esc(f.etiqueta)}${f.extra ? ` <small>${esc(f.extra)}</small>` : ''}</span><b>${money(f.valor)}</b></div>
        <div class="srv-barra-pista"><i style="width:${Math.max(2, Math.round(Math.abs(f.valor) / max * 100))}%"></i></div>
      </div>`).join('')}</div>`;
  }

  function panelDash(titulo, icono, cuerpo, { accion = '', cls = '' } = {}) {
    return `<section class="srv-dash-panel ${cls}">
      <header><h4><span class="srv-card-ico">${ICON[icono] || ''}</span>${esc(titulo)}</h4>${accion}</header>
      ${cuerpo}
    </section>`;
  }

  async function renderDashboard() {
    const b = bodyOf('srv-dashboard');
    renderPanelChip();
    b.innerHTML = '<div class="srv-loading">Cargando…</div>';
    try {
      const rango = rangoPanel(_dashPeriodo);
      const d = await req(`/dashboard?desde=${rango.desde}&hasta=${rango.hasta}`);
      const cot = d.cotizaciones || {};
      const ganancia = Number(d.gananciaEstimada || 0);
      const facturado = Number(d.serviciosFacturados.monto || 0);
      const margen = facturado > 0 ? Math.round(ganancia / facturado * 100) : null;

      const kpi = (mod, icono, tono, titulo, valor, sub) => `
        <button type="button" class="srv-dk srv-dk--${tono}" data-ir="${mod}">
          <span class="srv-dk-ico">${ICON[icono] || ''}</span>
          <span class="srv-dk-t">${esc(titulo)}</span>
          <span class="srv-dk-v">${valor}</span>
          ${sub ? `<span class="srv-dk-s">${sub}</span>` : ''}
        </button>`;

      const totalCotPeriodo = ['borrador', 'enviada', 'aprobada', 'convertida', 'rechazada', 'vencida'].reduce((t, k) => t + (cot[k] || 0), 0);
      const conversion = totalCotPeriodo > 0 ? Math.round((cot.convertida || 0) / totalCotPeriodo * 100) : null;
      const estadoCot = (k, label) => `<li><span class="srv-dot srv-dot--${k}"></span>${label}<b>${cot[k] || 0}</b></li>`;

      const porCobrar = d.porCobrar || [];
      const listaCobrar = porCobrar.length
        ? `<ul class="srv-dash-lista">${porCobrar.map((f) => `
            <li>
              <div><b>${esc(f.numero)}</b><small>${esc(f.cliente || 'Sin cliente')}</small></div>
              <div class="srv-dash-lista-der"><b>${money(f.balance)}</b>
                <small class="${f.vencida ? 'srv-vencida' : ''}">${f.vencimiento ? (f.vencida ? 'Venció ' : 'Vence ') + esc(fdate(f.vencimiento)) : 'Emitida ' + esc(fdate(f.fecha))}</small></div>
            </li>`).join('')}</ul>`
        : '<p class="srv-dash-vacio">No hay facturas pendientes de cobro. 🎉</p>';

      const sucursales = d.porSucursal || [];
      b.innerHTML = `
        <div class="srv-dash">
          <div class="srv-dash-top">
            <div class="srv-periodo" role="group" aria-label="Período">
              ${PERIODOS_PANEL.map(([k, t]) => `<button type="button" data-periodo="${k}" class="${k === _dashPeriodo ? 'is-on' : ''}">${t}</button>`).join('')}
            </div>
            <span class="srv-dash-rango">${esc(fdate(rango.desde))} — ${esc(fdate(rango.hasta))}</span>
          </div>

          <div class="srv-dash-kpis">
            ${kpi('srv-facturas', 'doc', 'azul', 'Servicios facturados', money(facturado), `${d.serviciosFacturados.cantidad} ${d.serviciosFacturados.cantidad === 1 ? 'factura' : 'facturas'}`)}
            ${kpi('srv-cobros', 'cobrar', 'verde', 'Cobros del período', money(d.cobrosPeriodo.monto), `${d.cobrosPeriodo.cantidad} ${d.cobrosPeriodo.cantidad === 1 ? 'pago' : 'pagos'}`)}
            ${kpi('srv-cxc', 'reloj', 'ambar', 'Cuentas por cobrar', money(d.cuentasPorCobrar), `${d.facturasPendientes} ${d.facturasPendientes === 1 ? 'factura pendiente' : 'facturas pendientes'}`)}
            ${kpi('srv-cxc', 'alerta', d.facturasVencidas > 0 ? 'rojo' : 'gris', 'Facturas vencidas', String(d.facturasVencidas), d.facturasVencidas > 0 ? 'Cobrar cuanto antes' : 'Todo al día')}
            ${kpi('srv-cotizaciones', 'lista', 'violeta', 'Cotizaciones abiertas', String(cot.abiertas || 0), cot.montoAbiertas ? `por ${money(cot.montoAbiertas)}` : 'Ninguna pendiente')}
            ${kpi('srv-gastos', ganancia >= 0 ? 'sube' : 'baja', ganancia >= 0 ? 'verde' : 'rojo', 'Ganancia estimada', money(ganancia),
              `Gastos ${money(d.gastosPeriodo)}${margen != null && margen >= 0 ? ` · margen ${margen}%` : (ganancia < 0 ? ' · los gastos superan lo facturado' : '')}`)}
          </div>

          <div class="srv-dash-grid">
            ${panelDash('Ingresos y gastos', 'cobrar', barras([
              { etiqueta: 'Facturado', valor: facturado, tono: 'azul' },
              { etiqueta: 'Cobrado', valor: Number(d.cobrosPeriodo.monto || 0), tono: 'verde' },
              { etiqueta: 'Gastos', valor: Number(d.gastosPeriodo || 0), tono: 'rojo' },
            ], '') + `<div class="srv-dash-neto ${ganancia >= 0 ? 'is-pos' : 'is-neg'}"><span>Ganancia estimada <small>(facturado − gastos)</small></span><b>${money(ganancia)}</b></div>`)}

            ${panelDash('Cotizaciones del período', 'lista', `
              <ul class="srv-estados">
                ${estadoCot('borrador', 'Borrador')}${estadoCot('enviada', 'Enviadas')}${estadoCot('aprobada', 'Aprobadas')}
                ${estadoCot('convertida', 'Convertidas en factura')}${estadoCot('rechazada', 'Rechazadas')}${estadoCot('vencida', 'Vencidas')}
              </ul>
              ${conversion != null ? `<div class="srv-dash-neto"><span>Tasa de conversión</span><b>${conversion}%</b></div>` : ''}`,
            { accion: '<button type="button" class="srv-dash-link" data-ir="srv-cotizaciones">Ver todas</button>' })}

            ${panelDash('Servicios más facturados', 'doc', barras((d.topServicios || []).map((s) => ({
              etiqueta: s.nombre, valor: s.monto, extra: `${s.veces} ${s.veces === 1 ? 'vez' : 'veces'}`, tono: 'azul',
            })), 'Todavía no hay servicios facturados en este período.'))}

            ${panelDash('Gastos por categoría', 'cobrar', barras((d.gastosPorCategoria || []).map((g) => ({
              etiqueta: g.categoria, valor: g.monto, tono: 'rojo',
            })), 'No hay gastos registrados en este período.'),
            { accion: '<button type="button" class="srv-dash-link" data-ir="srv-gastos">Ver gastos</button>' })}

            ${panelDash('Facturas por cobrar', 'reloj', listaCobrar,
              { accion: '<button type="button" class="srv-dash-link" data-ir="srv-cxc">Ver todas</button>' })}

            ${sucursales.length > 1 ? panelDash('Rendimiento por sucursal', 'lista', table([
              { label: 'Sucursal', key: 'sucursal' },
              { label: 'Facturado', num: true, render: (r) => money(r.facturado) },
              { label: 'Por cobrar', num: true, render: (r) => money(r.porCobrar) },
            ], sucursales)) : ''}
          </div>
        </div>`;

      b.querySelectorAll('[data-periodo]').forEach((el) => el.onclick = () => { _dashPeriodo = el.dataset.periodo; renderDashboard(); });
      b.querySelectorAll('[data-ir]').forEach((el) => el.onclick = () => irAModulo(el.dataset.ir));
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

  async function formServicio(srv, onSaved) {
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
      (typeof onSaved === 'function' ? onSaved : renderServicios)();
    });
  }

  // ── Importar / exportar el catálogo en CSV ────────────────────────────────
  // Mismo formato que el portal del contador (js/catalogo-csv.js). El archivo
  // se lee aquí, se muestra qué se crea y qué se actualiza, y al confirmar se
  // manda a POST /catalogo/importar. Ventana de análisis: js/ventana-analisis.js.
  const icono = (nombre) => (window.TcIconos ? window.TcIconos.svg(nombre, 16) : '');

  // Nuevo o "se actualiza" según el catálogo actual (por código o, sin código,
  // por nombre). Uno con código y sin nombre que no existe no se puede crear.
  function clasificarImportacion(filas, actuales, errores) {
    const porCodigo = new Map(actuales.filter((s) => s.codigo).map((s) => [String(s.codigo).toLowerCase(), s]));
    const porNombre = new Map(actuales.map((s) => [String(s.nombre).toLowerCase(), s]));
    const clasificadas = [];
    filas.forEach((f) => {
      const actual = (f.codigo && porCodigo.get(f.codigo.toLowerCase())) || (f.nombre && porNombre.get(f.nombre.toLowerCase()));
      if (!actual && f.soloActualiza) {
        errores.push(`fila ${f.fila}: el código ${f.codigo} no está en el catálogo y la fila no trae nombre para crearlo.`);
        return;
      }
      clasificadas.push({ ...f, estado: actual ? 'actualiza' : 'nuevo' });
    });
    return clasificadas;
  }

  function exportarServiciosCsv(actuales) {
    const csv = window.TcCatalogoCsv;
    const contenido = csv.aCsv(csv.COLUMNAS_SERVICIOS, actuales.map((s) => ({
      codigo: s.codigo, nombre: s.nombre, descripcion: s.descripcion, categoria: s.categoria, unidad: s.unidad,
      precio: (Number(s.precio) || 0).toFixed(2), itbisPct: Number(s.itbisPct) || 0,
      duracionMin: s.duracionMin ?? '', estado: s.activo ? 'Activo' : 'Inactivo',
    })));
    const blob = new Blob([contenido], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = actuales.length ? 'servicios.csv' : 'plantilla-servicios.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(actuales.length ? `${actuales.length} servicios exportados.` : 'Catálogo vacío: se descargó la plantilla con las columnas.', 'success');
  }

  async function leerCsvServicios(files, actuales) {
    const csv = window.TcCatalogoCsv;
    const varios = files.length > 1;
    return window.TcVentanaAnalisis.correr({
      titulo: 'Analizando el archivo',
      subtitulo: varios ? `${files.length} archivos` : files[0].name,
      pasos: [varios ? `Leyendo los ${files.length} archivos` : 'Leyendo el archivo', 'Reconociendo las columnas', 'Comparando con tu catálogo'],
      trabajo: async () => {
        const filas = [];
        const errores = [];
        for (const file of files) {
          try {
            const leido = csv.leerServicios(await csv.leerArchivo(file));
            leido.filas.forEach((f) => filas.push({ ...f, archivo: file.name }));
            leido.errores.forEach((e) => errores.push(`${varios ? `${file.name}, ` : ''}fila ${e.fila}: ${e.mensaje}`));
          } catch (e) {
            errores.push(`${file.name}: ${e.message}`);
          }
        }
        const clasificadas = clasificarImportacion(filas, actuales, errores);
        if (!clasificadas.length) throw new Error(errores[0] || 'El archivo no trae servicios.');
        return { filas: clasificadas, errores };
      },
      resumen: (r) => {
        const nuevos = r.filas.filter((f) => f.estado === 'nuevo').length;
        return `Encontré ${r.filas.length} servicios: ${nuevos} nuevos y ${r.filas.length - nuevos} para actualizar.`
          + (r.errores.length ? ` ${r.errores.length} fila(s) con problemas.` : '');
      },
    });
  }

  // Lo leído, antes de guardar: qué se crea, qué se actualiza y qué falló.
  function pintarPreviaImportacion(zona, leido, alImportar) {
    const nuevos = leido.filas.filter((f) => f.estado === 'nuevo').length;
    const actualiza = leido.filas.length - nuevos;
    const muestra = leido.filas.slice(0, 50);
    zona.innerHTML = `
      <div class="ecfs-found" style="margin:0 0 12px">
        <div class="ecfs-found__title">${icono('file-text')}<span style="flex:1">Listo para importar: ${leido.filas.length} servicios (${nuevos} ${nuevos === 1 ? 'nuevo' : 'nuevos'}, ${actualiza} ${actualiza === 1 ? 'se actualiza' : 'se actualizan'})</span>
          <button type="button" class="ecfs-btn ecfs-found__close" data-imp-quitar>${icono('x')}Quitar</button></div>
        ${table([
          { label: 'Fila', render: (f) => esc(f.fila) },
          { label: 'Código', render: (f) => esc(f.codigo || '—') },
          { label: 'Servicio', render: (f) => esc(f.nombre) },
          { label: 'Precio', num: true, render: (f) => (f.precio != null ? money(f.precio) : '—') },
          { label: 'ITBIS %', num: true, render: (f) => (f.itbisPct != null ? `${f.itbisPct}%` : '—') },
          { label: '', render: (f) => `<span class="ecfs-pill ${f.estado === 'nuevo' ? 'ecfs-pill--ok' : ''}">${f.estado === 'nuevo' ? 'Nuevo' : 'Se actualiza'}</span>` },
        ], muestra)}
        ${leido.filas.length > muestra.length ? `<div class="ecfs-found__notes">… y ${leido.filas.length - muestra.length} más.</div>` : ''}
        ${leido.errores.slice(0, 5).map((e) => `<div class="ecfs-found__notes">No se importa: ${esc(e)}</div>`).join('')}
        ${leido.errores.length > 5 ? `<div class="ecfs-found__notes">… y ${leido.errores.length - 5} fila(s) más con problemas.</div>` : ''}
        <div class="ecfs-found__notes">Al actualizar solo cambian las columnas que trae el archivo. Un CSV con Código y Precio sube los precios sin tocar lo demás.</div>
        <div class="ecfs-found__actions"><button type="button" class="btn btn-primary" data-imp-ok>Importar ${leido.filas.length} servicios</button></div>
      </div>`;
    zona.querySelector('[data-imp-quitar]').onclick = () => { zona.innerHTML = ''; };
    zona.querySelector('[data-imp-ok]').onclick = alImportar;
  }

  async function guardarImportacion(leido) {
    const servicios = leido.filas.map(({ estado: _estado, archivo: _archivo, ...f }) => f);
    return window.TcVentanaAnalisis.correr({
      titulo: 'Importando servicios',
      subtitulo: `${servicios.length} servicios`,
      pasos: ['Revisando cada fila', 'Creando los nuevos', 'Actualizando los que ya existen'],
      trabajo: () => post('/catalogo/importar', { servicios }),
      resumen: (r) => `Listo: ${r.creados} creados y ${r.actualizados} actualizados${r.omitidos ? `; ${r.omitidos} no se pudieron importar` : ''}.`,
    });
  }

  // Gestión del catálogo de servicios en una ventana (sin ítem de menú propio).
  // Se abre desde el botón "Catálogo de servicios" en Facturación / Cotizaciones.
  async function abrirCatalogo() {
    const m = modal('Catálogo de servicios', `
      <div class="srv-actions" style="margin-bottom:10px">
        <button type="button" class="btn btn-primary" data-new-srv>+ Nuevo servicio</button>
        <button type="button" class="btn btn-ghost" data-import-srv title="Crea los nuevos y actualiza los que ya existen (por código o nombre)">${icono('upload')} Importar CSV</button>
        <button type="button" class="btn btn-ghost" data-export-srv title="Descarga el catálogo en CSV (Excel). Sin servicios, descarga la plantilla">${icono('download')} Exportar CSV</button>
        <input type="file" accept=".csv,.txt" multiple hidden data-import-file>
      </div>
      <div data-cat-import></div>
      <div data-cat-list><div class="srv-loading">Cargando…</div></div>`,
    async () => {}, { wide: true, submitLabel: 'Cerrar' });
    const list = m.querySelector('[data-cat-list]');
    const zonaImport = m.querySelector('[data-cat-import]');
    const archivo = m.querySelector('[data-import-file]');
    let actuales = [];
    const load = async () => {
      list.innerHTML = '<div class="srv-loading">Cargando…</div>';
      try {
        const rows = await req('/catalogo');
        actuales = rows;
        list.innerHTML = table([
          { label: 'Código', key: 'codigo' },
          { label: 'Servicio', key: 'nombre' },
          { label: 'Categoría', key: 'categoria' },
          { label: 'Unidad', key: 'unidad' },
          { label: 'Precio', num: true, render: (r) => money(r.precio) },
          { label: 'ITBIS %', num: true, render: (r) => (r.itbisPct || 0) + '%' },
          { label: '', render: (r) => `<button class="srv-link" data-edit="${r.id}">Editar</button> · <button class="srv-link" data-del="${r.id}">Baja</button>` },
        ], rows);
        list.querySelectorAll('[data-edit]').forEach((el) => el.onclick = () => formServicio(rows.find((x) => x.id == el.dataset.edit), load));
        list.querySelectorAll('[data-del]').forEach((el) => el.onclick = async () => {
          if (!confirm('¿Dar de baja este servicio?')) return;
          try { await del('/catalogo/' + el.dataset.del); toast('Servicio dado de baja', 'success'); load(); }
          catch (e) { toast(e.message, 'error'); }
        });
      } catch (e) { list.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
    };
    m.querySelector('[data-new-srv]').onclick = () => formServicio(null, load);
    m.querySelector('[data-export-srv]').onclick = () => exportarServiciosCsv(actuales);
    m.querySelector('[data-import-srv]').onclick = () => { archivo.value = ''; archivo.click(); };
    archivo.onchange = async () => {
      const files = Array.from(archivo.files || []);
      archivo.value = '';
      if (!files.length) return;
      let leido;
      try { leido = await leerCsvServicios(files, actuales); } catch (_) { return; } // el error ya se mostró
      pintarPreviaImportacion(zonaImport, leido, async () => {
        try {
          const r = await guardarImportacion(leido);
          zonaImport.innerHTML = '';
          if (r.errores?.length) toast(`No se importó: ${r.errores[0]}${r.errores.length > 1 ? ` (+${r.errores.length - 1} más)` : ''}`, 'warning');
          load();
        } catch (_) { /* el error ya se mostró; lo leído sigue en pantalla */ }
      });
    };
    load();
  }

  // ═══ Cotizaciones ═════════════════════════════════════════════════════════
  let _cotTodas = false;
  async function renderCotizaciones() {
    const b = bodyOf('srv-cotizaciones');
    actionsOf('srv-cotizaciones').innerHTML = `
      <label class="srv-filtro"><input type="checkbox" id="cot-todas"${_cotTodas ? ' checked' : ''}> Ver convertidas / rechazadas</label>
      <button class="btn btn-ghost" data-catalogo>🧾 Catálogo de servicios</button>
      <button class="btn btn-primary" data-new>+ Nueva cotización</button>`;
    actionsOf('srv-cotizaciones').querySelector('[data-catalogo]').onclick = () => abrirCatalogo();
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
          const abierta = !['convertida', 'rechazada'].includes(r.estado);
          return acciones([
            accion('data-view', r.id, 'Imprimir', 'imprimir', 'pri', VER_AYUDA),
            accion('data-mail', r.id, 'Correo', 'correo'),
            abierta && accion('data-edit', r.id, 'Editar', 'editar'),
            abierta && accion('data-fact', r.id, 'Facturar', 'facturar', 'ok'),
          ]);
        } },
      ], rows);
      b.querySelectorAll('[data-view]').forEach((el) => el.onclick = () => abrirDoc('cotizaciones', el.dataset.view, 'Cotización'));
      b.querySelectorAll('[data-mail]').forEach((el) => el.onclick = () => enviarCorreoDoc('cotizaciones', el.dataset.mail, 'cotización'));
      b.querySelectorAll('[data-edit]').forEach((el) => el.onclick = async () => formCotizacion(await req('/cotizaciones/' + el.dataset.edit)));
      b.querySelectorAll('[data-fact]').forEach((el) => el.onclick = () => facturarCotizacion(el.dataset.fact));
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
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

  // ── Formularios por secciones (factura / cotización) ─────────────────────
  const svg = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    cliente: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    doc: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'),
    lista: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
    nota: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    quitar: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    imprimir: svg('<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>'),
    correo: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>'),
    editar: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    facturar: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 15l2 2 4-4"/>'),
    cobrar: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>'),
    anular: svg('<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>'),
    ver: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    reloj: svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
    alerta: svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>'),
    sube: svg('<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>'),
    baja: svg('<path d="m22 17-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>'),
  };

  // Botones de acción de una fila (Ver, Correo, Editar…).
  // tono: '' gris · 'pri' color del sistema · 'ok' verde · 'peligro' rojo.
  // Los grises y rojos van solo con ícono (el nombre sale al pasar el mouse)
  // para que la fila no se parta en dos; el principal y el verde llevan texto.
  // `attr` es el data-* que ya escuchan los renderers (data-view, data-mail…).
  function accion(attr, id, texto, icono, tono = '', ayuda = '') {
    const soloIcono = !tono || tono === 'peligro';
    return `<button type="button" class="srv-act${tono ? ' srv-act--' + tono : ''}${soloIcono ? ' srv-act--icono' : ''}" ${attr}="${esc(id)}" title="${esc(ayuda || texto)}" aria-label="${esc(texto)}">${ICON[icono] || ''}${soloIcono ? '' : `<span>${esc(texto)}</span>`}</button>`;
  }
  const VER_AYUDA = 'Ver, imprimir o guardar en PDF';
  const acciones = (lista) => `<div class="srv-acts">${lista.filter(Boolean).join('')}</div>`;
  function card(titulo, icono, cuerpo, { acciones = '', cls = '' } = {}) {
    return `<section class="srv-card ${cls}">
      <header class="srv-card-head"><h4><span class="srv-card-ico">${icono}</span>${esc(titulo)}</h4>${acciones}</header>
      <div class="srv-card-body">${cuerpo}</div>
    </section>`;
  }
  // Texto de etiqueta en un solo span: los <label> del modal son flex en
  // columna y un "*" suelto caería en otra línea.
  const lbl = (texto, req) => `<span class="srv-lbl">${esc(texto)}${req ? ' <span class="srv-req">*</span>' : ''}</span>`;

  // Editor de líneas reutilizable (cotización / factura).
  // Celdas de una fila: guarda el serviceId (si viene del catálogo) en un hidden.
  function lineCells(it = {}) {
    return `<td class="srv-l-desc"><input type="hidden" name="sid" value="${it.serviceId ? Number(it.serviceId) : ''}">
        <input name="d" value="${esc(it.descripcion || '')}" placeholder="Servicio o concepto"></td>
      <td><input name="c" type="number" step="0.01" min="0" inputmode="decimal" value="${it.cantidad ?? 1}"></td>
      <td><input name="p" type="number" step="0.01" min="0" inputmode="decimal" value="${it.precio ?? ''}" placeholder="0.00"></td>
      <td><input name="dp" type="number" step="0.01" min="0" max="100" inputmode="decimal" value="${it.descuentoPct ?? 0}"></td>
      <td><input name="ip" type="number" step="0.01" min="0" max="100" inputmode="decimal" value="${it.itbisPct ?? 0}"></td>
      <td class="srv-l-imp" data-imp>—</td>
      <td class="srv-l-rm"><button type="button" class="srv-icon-btn" data-rm title="Quitar línea" aria-label="Quitar línea">${ICON.quitar}</button></td>`;
  }

  function lineEditor(items, titulo) {
    const its = items && items.length ? items : [{}];
    const rowsHtml = its.map((it, i) => `<tr data-i="${i}">${lineCells(it)}</tr>`).join('');
    const acciones = `<div class="srv-lines-cat">
        <select data-cat-sel title="Agregar un servicio del catálogo"><option value="">Agregar del catálogo…</option></select>
        <button type="button" class="btn btn-primary srv-lines-add" data-add>+ Agregar línea</button>
      </div>`;
    return card(titulo, ICON.lista, `
      <div class="srv-lines-scroll">
        <table class="srv-lines-table">
          <colgroup><col><col class="srv-c-cant"><col class="srv-c-precio"><col class="srv-c-pct"><col class="srv-c-pct"><col class="srv-c-total"><col class="srv-c-rm"></colgroup>
          <thead><tr>
            <th>Descripción</th><th class="num">Cant.</th><th class="num">Precio</th>
            <th class="num">Desc&nbsp;%</th><th class="num">ITBIS&nbsp;%</th><th class="num">Total</th><th></th>
          </tr></thead>
          <tbody data-lines>${rowsHtml}</tbody>
        </table>
      </div>`, { acciones, cls: 'srv-lines' });
  }

  // Recuadro de totales (se llena con paintLineTotals).
  function totalsBox(etiquetaTotal) {
    return `<div class="srv-totbox">
      <div class="srv-totbox-row"><span>Subtotal</span><b data-t-sub>${money(0)}</b></div>
      <div class="srv-totbox-row"><span>Descuentos</span><b data-t-desc>${money(0)}</b></div>
      <div class="srv-totbox-row"><span data-t-itbis-lbl>ITBIS</span><b data-t-itbis>${money(0)}</b></div>
      <div class="srv-totbox-total"><span>${esc(etiquetaTotal)}</span><b data-t-total>${money(0)}</b></div>
    </div>`;
  }

  // Líneas con descripción. Una línea con monto pero sin descripción es un
  // error (antes se descartaba en silencio y la factura salía con otro total).
  function collectLines(root) {
    return [...root.querySelectorAll('[data-lines] tr')].map((tr, i) => {
      const it = {
        serviceId: Number(tr.querySelector('[name=sid]')?.value || 0) || null,
        descripcion: tr.querySelector('[name=d]').value.trim(),
        cantidad: Number(tr.querySelector('[name=c]').value || 0),
        precio: Number(tr.querySelector('[name=p]').value || 0),
        descuentoPct: Number(tr.querySelector('[name=dp]').value || 0),
        itbisPct: Number(tr.querySelector('[name=ip]').value || 0),
      };
      if (!it.descripcion && it.precio > 0) {
        tr.querySelector('[name=d]').focus();
        throw new Error(`La línea ${i + 1} tiene precio pero no descripción.`);
      }
      if (it.descripcion && !(it.cantidad > 0)) {
        tr.querySelector('[name=c]').focus();
        throw new Error(`La cantidad de "${it.descripcion}" debe ser mayor que cero.`);
      }
      return it;
    }).filter((x) => x.descripcion);
  }

  // Totales en vivo del editor de líneas (misma fórmula que computeTotals del backend).
  // Actualiza el "Importe" de cada fila y devuelve { subtotal, descuento, itbis, total }.
  function calcLineTotals(root) {
    let subtotal = 0, descuento = 0, itbis = 0;
    const tasas = new Set(); // % de ITBIS de las líneas con monto (para la etiqueta)
    root.querySelectorAll('[data-lines] tr').forEach((tr) => {
      const cant = Math.max(0, Number(tr.querySelector('[name=c]')?.value || 0));
      const precio = Math.max(0, Number(tr.querySelector('[name=p]')?.value || 0));
      const dPct = Math.min(100, Math.max(0, Number(tr.querySelector('[name=dp]')?.value || 0)));
      const iPct = Math.max(0, Number(tr.querySelector('[name=ip]')?.value || 0));
      const bruto = cant * precio;
      const desc = bruto * dPct / 100;
      const base = bruto - desc;
      const tax = base * iPct / 100;
      subtotal += bruto; descuento += desc; itbis += tax;
      if (base > 0) tasas.add(iPct);
      const cell = tr.querySelector('[data-imp]');
      if (cell) cell.textContent = (bruto || base || tax) ? money(n2(base + tax)) : '—';
    });
    return { subtotal: n2(subtotal), descuento: n2(descuento), itbis: n2(itbis), total: n2(subtotal - descuento + itbis), tasas: [...tasas] };
  }

  function paintLineTotals(root) {
    const t = calcLineTotals(root);
    const set = (sel, v) => { const el = root.querySelector(sel); if (el) el.textContent = v; };
    set('[data-t-sub]', money(t.subtotal));
    set('[data-t-desc]', t.descuento > 0 ? '− ' + money(t.descuento) : money(0));
    set('[data-t-itbis]', money(t.itbis));
    set('[data-t-total]', money(t.total));
    // "ITBIS (18%)" solo si todas las líneas llevan la misma tasa; con tasas
    // mezcladas un porcentaje fijo en la etiqueta sería falso.
    const tasa = t.tasas.length === 1 && t.tasas[0] > 0 ? t.tasas[0] : null;
    set('[data-t-itbis-lbl]', tasa != null ? `ITBIS (${tasa % 1 ? n2(tasa) : tasa}%)` : 'ITBIS');
    return t;
  }

  function wireLines(root) {
    const tbody = root.querySelector('[data-lines]');
    const repaint = () => paintLineTotals(root);
    // Quitar la única línea la deja en blanco en vez de dejar la tabla vacía.
    const quitar = (tr) => {
      if (tbody.rows.length > 1) { tr.remove(); repaint(); return; }
      tr.innerHTML = lineCells({});
      tr.querySelector('[data-rm]').onclick = () => quitar(tr);
      repaint();
    };
    const addRow = (it) => {
      const tr = document.createElement('tr');
      tr.innerHTML = lineCells(it || {});
      tbody.appendChild(tr);
      tr.querySelector('[data-rm]').onclick = () => quitar(tr);
      repaint();
      return tr;
    };
    root.querySelector('[data-add]').onclick = () => addRow({}).querySelector('[name=d]').focus();
    tbody.querySelectorAll('[data-rm]').forEach((el) => el.onclick = () => quitar(el.closest('tr')));
    tbody.addEventListener('input', repaint);
    // Enter dentro de una línea NO emite la factura: pasa al siguiente campo y,
    // al final de la última línea, agrega otra.
    tbody.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      const campos = [...tbody.querySelectorAll('input:not([type=hidden])')];
      const sig = campos[campos.indexOf(e.target) + 1];
      if (sig) { sig.focus(); sig.select?.(); }
      else addRow({}).querySelector('[name=d]').focus();
    });
    repaint();

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
          repaint();
        } else {
          addRow(it);
        }
        sel.value = '';
      };
    }
  }

  async function formCotizacion(q) {
    let scfg = {};
    try { scfg = await req('/config'); } catch (_) { /* opcional */ }
    const antDefault = scfg.quoteAdvancePct != null ? scfg.quoteAdvancePct : '';
    const fechaIni = q?.fecha ? String(q.fecha).slice(0, 10) : today();
    const m = modal(q ? 'Editar cotización ' + q.numero : 'Nueva cotización', `
      ${card('Información del cliente', ICON.cliente, clientPickerHtml(q, { grid: true }))}
      ${card('Detalles de la cotización', ICON.doc, `
        <div class="srv-grid srv-grid-3">
          <label>${lbl('Fecha', true)}<input name="fecha" id="srv-cot-fecha" type="date" value="${esc(fechaIni)}" required></label>
          <label>${lbl('Validez (días)', true)}<input name="validezDias" id="srv-cot-validez" type="number" min="1" step="1" value="${q?.validezDias ?? 15}" required></label>
          <label>Válida hasta<output class="srv-readout" id="srv-cot-vence">—</output></label>
        </div>`)}
      ${lineEditor(q?.items, 'Servicios cotizados')}
      <div class="srv-form-end">
        ${card('Condiciones y notas', ICON.nota, `
          <div class="srv-cond-row">
            <label>Anticipo requerido (%)
              <input name="__antpct" id="srv-cot-antpct" type="number" min="0" max="100" step="1" value="${esc(antDefault)}" placeholder="Ej: 50"></label>
            <button type="button" class="btn btn-secondary" id="srv-cot-gennota">Generar nota de condiciones</button>
          </div>
          <label>Notas<textarea name="notas" id="srv-cot-notas" rows="4" placeholder="Condiciones, alcance o comentarios para el cliente (opcional)">${esc(q?.notas || '')}</textarea></label>`)}
        ${totalsBox('Total cotizado')}
      </div>`, async (fd, root) => {
      const items = collectLines(root);
      if (!items.length) throw new Error('Agrega al menos una línea.');
      delete fd.__antpct;
      const payload = { ...fd, clientId: fd.clientId || null, items };
      const saved = q ? await put('/cotizaciones/' + q.id, payload) : await post('/cotizaciones', payload);
      toast('Cotización guardada', 'success');
      renderCotizaciones();
      const cotId = (saved && (saved.id || saved.quotationId)) || (q && q.id);
      if (cotId) firmarYGuardar('cotizaciones', cotId, { avisar: true });
    }, { xl: true, subtitle: 'Datos del cliente, servicios cotizados y condiciones.', submitLabel: q ? 'Guardar cambios' : 'Guardar cotización' });
    wireClientPicker(m);
    wireLines(m);
    const fechaEl = m.querySelector('#srv-cot-fecha');
    const validezEl = m.querySelector('#srv-cot-validez');
    const syncVence = () => {
      const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fechaEl.value);
      const dias = Math.floor(Number(validezEl.value) || 0);
      const out = m.querySelector('#srv-cot-vence');
      if (!f || dias < 1) { out.textContent = '—'; return; }
      const d = new Date(Number(f[1]), Number(f[2]) - 1, Number(f[3]) + dias);
      out.textContent = fdate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    };
    fechaEl.addEventListener('input', syncVence); validezEl.addEventListener('input', syncVence);
    syncVence();
    m.querySelector('#srv-cot-gennota').onclick = () => {
      const pct = Number(m.querySelector('#srv-cot-antpct').value || 0);
      if (!(pct > 0 && pct < 100)) { toast('Escribe un % de anticipo entre 1 y 99.', 'error'); return; }
      const { total } = calcLineTotals(m);
      if (!(total > 0)) { toast('Agrega al menos una línea con monto para calcular la nota.', 'error'); return; }
      const box = m.querySelector('#srv-cot-notas');
      if (box.value.trim() && !confirm('Esto reemplazará el texto actual de Notas. ¿Continuar?')) return;
      // Texto estándar: el texto fijo del negocio ahora va en Ajustes →
      // Términos y condiciones y sale solo en cada documento.
      box.value = buildQuoteTerms(total, pct);
      box.scrollTop = 0;
      toast('Nota de condiciones generada. Puedes editarla antes de guardar.', 'success');
    };
  }

  // Campos de facturación compartidos: comprobante (tipos NCF y e-CF con
  // secuencia activa), método de pago y condición. Devuelve { html, wire(root) }.
  async function billingFields(defaults = {}) {
    let resp = { comprobantes: [], necesitaActivar: false };
    let cfg = {};
    try { [resp, cfg] = await Promise.all([req('/facturas/comprobantes'), req('/config')]); } catch (_) {}
    const comps = Array.isArray(resp) ? resp : (resp.comprobantes || []);
    const ecfs = Array.isArray(resp) ? [] : (resp.electronicos || []);
    const ecfActivo = !Array.isArray(resp) && resp.ecfActivo;
    const necesitaActivar = !Array.isArray(resp) && resp.necesitaActivar;
    const defMode = cfg.fiscalMode || 'ncf';
    // Un e-CF por tipo con secuencia activa; el número lo reserva el módulo
    // e-CF al emitir. Con la facturación electrónica apagada se ven, pero no
    // se pueden elegir. El vencimiento va en la nota de abajo (#srv-comp-venc):
    // en la opción alargaba el texto y se cortaba.
    const opciones = [
      ...comps.map((c) => ({ mode: 'ncf', tipo: c.tipo, venc: c.vencimiento, label: `NCF ${c.tipo} — ${c.nombre} (${c.disponibles} disp.)` })),
      ...ecfs.map((c) => ({ mode: 'ecf', tipo: c.tipo, venc: c.vencimiento, disabled: !ecfActivo, label: `e-CF ${c.tipo} — ${c.nombre} (${c.disponibles} disp.)` })),
      { mode: 'consumidor', tipo: '', label: 'Sin comprobante fiscal' },
    ];
    // Preselección: el tipo pedido, si no el primero del modo de Ajustes, si no
    // el primer comprobante fiscal que haya (p. ej. solo e-CF con modo "ncf").
    const usables = opciones.filter((o) => !o.disabled);
    const elegida = (defaults.ncfTipo && usables.find((o) => o.mode === defMode && o.tipo === defaults.ncfTipo))
      || usables.find((o) => o.mode === defMode)
      || (defMode !== 'consumidor' && usables.find((o) => o.mode !== 'consumidor'))
      || usables[usables.length - 1];
    const opts = opciones.map((o) => `<option value="${esc(o.mode + '|' + o.tipo)}" data-venc="${esc(o.venc || '')}"${o.mode === 'ecf' ? ' data-ecf="1"' : ''}${o.disabled ? ' disabled' : ''}${o === elegida ? ' selected' : ''}>${esc(o.label)}</option>`);
    const metodos = [['efectivo', 'Efectivo'], ['transferencia', 'Transferencia'], ['tarjeta', 'Tarjeta'], ['deposito', 'Depósito'], ['cheque', 'Cheque'], ['otro', 'Otro']];
    const avisos = [];
    if (necesitaActivar) {
      avisos.push('⚠ Tienes secuencias NCF registradas pero <strong>desactivadas</strong>. Actívalas en Configuración → Ventas y Facturación → Secuencias de Comprobantes Fiscales (casilla "Usar los rangos registrados… al facturar").');
    }
    if (ecfs.length && !ecfActivo) {
      avisos.push('⚠ Tienes secuencias e-CF pero la facturación electrónica está <strong>desactivada</strong>. Actívala en Configuración → Facturación Electrónica DGII → Estado.');
    } else if (!ecfs.length && !Array.isArray(resp) && resp.ecfFueraDeAlcance) {
      avisos.push('⚠ Tus secuencias e-CF activas están asignadas a otra sucursal o a una caja. Para facturar servicios regístralas como Global en Configuración → Ventas y Facturación → Secuencias de Comprobantes Electrónicos (e-NCF).');
    }
    if (!comps.length && !ecfs.length && !necesitaActivar) {
      avisos.push('⚠ No hay secuencias NCF ni e-CF disponibles. Regístralas en Configuración → Ventas y Facturación → Secuencias de Comprobantes Fiscales (NCF) o Secuencias de Comprobantes Electrónicos (e-NCF).');
    }
    const aviso = avisos.map((a) => `<p class="srv-aviso">${a}</p>`).join('');
    // Piezas sueltas para el formulario por secciones; `html` las arma apiladas.
    const campos = {
      comprobante: `<label>Comprobante fiscal<select name="comprobante" id="srv-comp">${opts.join('')}</select></label>`,
      condicion: `<label>${lbl('Condición de pago', true)}<select name="condicionPago" id="srv-cond">
          <option value="contado">Contado (pagada al emitir)</option>
          <option value="credito">Crédito</option>
        </select></label>`,
      metodo: `<label id="srv-mp-wrap">${lbl('Método de pago', true)}<select name="metodoPago">${metodos.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>`,
      avisos: `<small class="srv-hint" id="srv-comp-venc"></small>${aviso}`,
    };
    const html = `${campos.comprobante}${campos.avisos}<div class="srv-row">${campos.condicion}${campos.metodo}</div>`;
    const wire = (root) => {
      const sel = root.querySelector('#srv-comp');
      const vencEl = root.querySelector('#srv-comp-venc');
      const cond = root.querySelector('#srv-cond');
      const mpWrap = root.querySelector('#srv-mp-wrap');
      const syncVenc = () => {
        const o = sel.selectedOptions[0];
        vencEl.textContent = o && o.dataset.venc
          ? (o.dataset.ecf ? 'Vencimiento de la secuencia e-CF: ' : 'Vencimiento del NCF: ') + fdate(o.dataset.venc) + ' (se imprime en la factura).'
          : '';
      };
      const syncMp = () => { mpWrap.style.display = cond.value === 'contado' ? '' : 'none'; };
      sel.addEventListener('change', syncVenc); cond.addEventListener('change', syncMp);
      syncVenc(); syncMp();
    };
    return { html, campos, wire };
  }

  // Crédito fiscal, régimen especial y gubernamental (B01/B14/B15 y los e-CF
  // E31/E44/E45) llevan el RNC o la cédula del comprador; consumo final no.
  const COMP_CON_RNC = /^(ncf\|B0?1|ncf\|B14|ncf\|B15|ecf\|E31|ecf\|E44|ecf\|E45)$/;
  function wireRncRequerido(root) {
    const comp = root.querySelector('#srv-comp');
    const rnc = root.querySelector('#srv-cli-rnc');
    const marca = root.querySelector('#srv-cli-rnc-req');
    const nombre = root.querySelector('#srv-cli-name');
    const marcaNombre = root.querySelector('#srv-cli-name-req');
    if (!comp || !rnc) return () => true;
    const compradorObligatorio = () => {
      if (COMP_CON_RNC.test(comp.value)) return true;
      const [mode, type] = String(comp.value || '').split('|');
      const consumo = (mode === 'ncf' && /^B0?2$/.test(type)) || (mode === 'ecf' && type === 'E32');
      return consumo && calcLineTotals(root).total >= 250000;
    };
    const sync = () => {
      const required = compradorObligatorio();
      if (marca) marca.hidden = !required;
      if (marcaNombre) marcaNombre.hidden = !required;
      if (rnc) rnc.required = required;
      if (nombre) nombre.required = required;
    };
    comp.addEventListener('change', sync);
    root.addEventListener('input', sync);
    root.addEventListener('change', sync);
    sync();
    // Validación al emitir: devuelve true o lanza con el mensaje para el usuario.
    return () => {
      if (!compradorObligatorio()) return true;
      if (nombre && !nombre.value.trim()) {
        nombre.focus();
        throw new Error('Para comprobantes de consumo desde RD$250,000, indica el nombre del comprador.');
      }
      const dig = rnc.value.replace(/\D/g, '');
      if (dig.length === 9 || dig.length === 11) return true;
      // Bloqueado = viene del catálogo, y el backend usa el de Clientes.
      if (rnc.readOnly) throw new Error('El RNC/cédula de este cliente en Clientes no es válido (9 u 11 dígitos). Corrígelo en Clientes.');
      rnc.focus();
      throw new Error(dig.length
        ? 'El RNC debe tener 9 dígitos o la cédula 11.'
        : 'Este comprobante necesita el RNC o la cédula del cliente.');
    };
  }
  // Aviso al emitir: número, NCF/e-NCF y, en e-CF, lo que pasó con la DGII.
  function avisarEmision(inv) {
    const base = 'Factura ' + inv.numero + (inv.ncf ? ' · ' + inv.ncf : '');
    const e = inv.ecf;
    if (e && e.error) { toast(base + ' guardada, pero el e-CF no se pudo emitir: ' + e.error, 'error'); return; }
    if (e && e.pendiente) { toast(base + ' emitida. ' + (e.mensaje || 'El e-CF se enviará a la DGII cuando vuelva la conexión.'), 'warning'); return; }
    toast(base + (inv.estado === 'pagada' ? ' (pagada)' : '') + ' emitida' + (e ? ' y enviada a la DGII' : ''), 'success');
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
      avisarEmision(inv);
      await imprimirFacturaSiTermica(inv.id);
      renderCotizaciones();
      window.showModule('srv-facturas', document.querySelector('.nav-item[data-module="srv-facturas"]'));
      if (inv && inv.id) firmarYGuardar('facturas', inv.id, { avisar: true });
    }, { submitLabel: 'Facturar' });
    bf.wire(m);
  }

  // ═══ Facturación ══════════════════════════════════════════════════════════
  let _facTodas = false;
  // Estado del e-CF en la DGII, junto al e-NCF. [clase de srv-badge, texto]
  const ECF_ESTADOS = {
    aceptado: ['pagada', 'Aceptado DGII'], aceptado_condicional: ['pagada', 'Aceptado condicional'],
    enviado: ['parcial', 'Enviado'], en_proceso: ['parcial', 'En proceso'], procesando: ['parcial', 'En proceso'],
    firmado: ['pendiente', 'Firmado, sin enviar'], pendiente: ['pendiente', 'Pendiente de envío'],
    rechazado: ['anulada', 'Rechazado DGII'],
  };
  const ECF_YA_ENVIADO = ['aceptado', 'aceptado_condicional', 'enviado', 'en_proceso', 'procesando'];
  function ecfBadge(r) {
    if (r.fiscalMode !== 'ecf') return '';
    const [cls, txt] = ECF_ESTADOS[r.ecfStatus] || ['anulada', 'Error e-CF'];
    return ` <span class="srv-badge srv-badge-${cls}" title="${esc(r.ecfError || txt)}">${esc(txt)}</span>`;
  }
  const ecfReintentable = (r) => r.fiscalMode === 'ecf' && r.estado !== 'anulada' && !ECF_YA_ENVIADO.includes(r.ecfStatus);
  async function reintentarEcf(id, btn) {
    btn.disabled = true;
    try {
      avisarEmision(await post('/facturas/' + id + '/reintentar-ecf', {}));
    } catch (e) { toast(e.message, 'error'); }
    renderFacturas();
  }
  async function renderFacturas() {
    const b = bodyOf('srv-facturas');
    actionsOf('srv-facturas').innerHTML = `
      <label class="srv-filtro"><input type="checkbox" id="fac-todas"${_facTodas ? ' checked' : ''}> Ver pagadas / anuladas</label>
      <button class="btn btn-ghost" data-catalogo>🧾 Catálogo de servicios</button>
      <button class="btn btn-primary" data-new>+ Nueva factura</button>`;
    actionsOf('srv-facturas').querySelector('[data-catalogo]').onclick = () => abrirCatalogo();
    actionsOf('srv-facturas').querySelector('[data-new]').onclick = () => formFactura();
    actionsOf('srv-facturas').querySelector('#fac-todas').onchange = (e) => { _facTodas = e.target.checked; renderFacturas(); };
    b.innerHTML = '<div class="srv-loading">Cargando…</div>';
    try {
      const rows = await req('/facturas' + (_facTodas ? '?todas=1' : ''));
      b.innerHTML = table([
        { label: 'Número', key: 'numero' },
        { label: 'NCF', render: (r) => esc(r.ncf || '') + ecfBadge(r) },
        { label: 'Cliente', key: 'clientName' },
        { label: 'Fecha', key: 'fecha' },
        { label: 'Total', num: true, render: (r) => money(r.total) },
        { label: 'Balance', num: true, render: (r) => money(r.balance) },
        { label: 'Estado', render: (r) => `<span class="srv-badge srv-badge-${r.estado}">${r.estado}</span>` },
        { label: '', render: (r) => acciones([
          ecfReintentable(r) && accion('data-ecf', r.id, 'Enviar e-CF', 'sube', 'ok', 'Armar, firmar y enviar el e-CF a la DGII'),
          accion('data-doc', r.id, 'Imprimir', 'imprimir', 'pri', VER_AYUDA),
          accion('data-mail', r.id, 'Correo', 'correo'),
          r.estado !== 'anulada' && r.balance > 0 && accion('data-pay', r.id, 'Cobrar', 'cobrar', 'ok'),
          r.estado !== 'anulada' && accion('data-void', r.id, 'Anular', 'anular', 'peligro'),
        ]) },
      ], rows);
      b.querySelectorAll('[data-doc]').forEach((el) => el.onclick = async () => {
        const prefs = await preferenciasImpresionServicio();
        if (prefs.formato === '58mm' || prefs.formato === '80mm') {
          await imprimirDocumentoServicio('facturas', el.dataset.doc, prefs.formato, prefs);
          return;
        }
        verDocumento(el.dataset.doc);
      });
      b.querySelectorAll('[data-mail]').forEach((el) => el.onclick = () => enviarCorreo(el.dataset.mail));
      b.querySelectorAll('[data-pay]').forEach((el) => el.onclick = () => formPago(el.dataset.pay));
      b.querySelectorAll('[data-void]').forEach((el) => el.onclick = () => anularFactura(el.dataset.void));
      b.querySelectorAll('[data-ecf]').forEach((el) => el.onclick = () => reintentarEcf(el.dataset.ecf, el));
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }

  async function formFactura() {
    const bf = await billingFields();
    let validarRnc = () => true;
    const m = modal('Nueva factura de servicios', `
      ${card('Información del cliente', ICON.cliente, clientPickerHtml(null, { grid: true, optionalConsumer: true }))}
      ${card('Detalles de la factura', ICON.doc, `
        <div class="srv-grid srv-grid-fac">
          <label>${lbl('Fecha', true)}<input name="fecha" type="date" value="${today()}" required></label>
          ${bf.campos.comprobante}
          ${bf.campos.condicion}
          ${bf.campos.metodo}
        </div>
        ${bf.campos.avisos}`)}
      ${lineEditor(null, 'Servicios prestados')}
      <div class="srv-form-end">
        ${card('Notas', ICON.nota, '<textarea name="notas" rows="4" placeholder="Notas visibles en la factura (opcional)"></textarea>')}
        ${totalsBox('Total a pagar')}
      </div>`, async (fd, root) => {
      validarRnc();
      const items = collectLines(root);
      if (!items.length) throw new Error('Agrega al menos una línea.');
      const inv = await post('/facturas', { ...fd, ...readBilling(fd), clientId: fd.clientId || null, items });
      avisarEmision(inv);
      await imprimirFacturaSiTermica(inv.id);
      renderFacturas();
      if (inv && inv.id) firmarYGuardar('facturas', inv.id, { avisar: true });
    }, { xl: true, subtitle: 'Datos del cliente, comprobante y servicios a facturar.', submitLabel: 'Emitir factura' });
    wireClientPicker(m);
    bf.wire(m);
    validarRnc = wireRncRequerido(m);
    wireLines(m);
  }

  // Firma el PDF (base64) con el .p12 del emisor si hay uno cargado y vigente.
  // Nunca lanza: si no se puede firmar, devuelve el PDF original.
  async function firmarPdfSiHay(pdfBase64, { silencioso } = {}) {
    if (!pdfBase64) return { base64: pdfBase64, firmado: false };
    try {
      const r = await post('/documento/firmar', { pdfBase64 });
      if (r && r.ok && r.signedBase64) return { base64: r.signedBase64, firmado: true };
      if (r && r.reason && r.reason !== 'no-cert' && !silencioso) {
        toast('El PDF se generó sin firma: ' + (r.message || r.reason), 'warning');
      }
    } catch (e) {
      if (!silencioso) toast('No se pudo firmar el PDF (' + (e.message || 'error') + '). Se usa sin firma.', 'warning');
    }
    return { base64: pdfBase64, firmado: false };
  }

  // Devuelve el PDF firmado que se guardó al crear el documento, o null.
  async function pdfFirmadoGuardado(base, id) {
    try {
      const r = await req(`/documento/${base}/${id}/firmado`);
      return r && r.pdfBase64 ? r.pdfBase64 : null;
    } catch (_) { return null; }
  }

  // Genera el PDF A4 del documento recién creado, lo firma y lo guarda pegado al
  // documento para que al abrirlo salga firmado sin esperar.
  async function firmarYGuardar(base, id, { avisar } = {}) {
    if (!(await autosignActivo())) return;
    const nd = window.novaDesktop;
    if (!nd || !nd.htmlToPdf) return;
    let s;
    try {
      const d = await req(`/${base}/${id}/documento?formato=a4&firmar=1`);
      const pdf = await nd.htmlToPdf(d.html);
      if (!pdf) return;
      s = await firmarPdfSiHay(pdf, { silencioso: true });
      if (!s.firmado) { if (avisar) toast('No se pudo firmar (revisa el certificado .p12).', 'warning'); return; }
    } catch (_) { return; }
    try {
      await post(`/documento/${base}/${id}/guardar-firmado`, { pdfBase64: s.base64 });
      if (avisar) toast('Documento firmado y guardado ✓', 'success');
    } catch (e) {
      toast('El documento se firmó pero no se pudo guardar (¿reiniciaste el servidor?): ' + (e.message || ''), 'warning');
    }
  }

  // Genera el PDF A4 del documento, lo firma si hay certificado y lo guarda en
  // la carpeta de facturas (año/mes). Devuelve true si se guardó.
  async function guardarPdfDocumento(base, id, label) {
    const nd = window.novaDesktop;
    if (!nd || !nd.htmlToPdf || !nd.saveInvoicePdf) {
      toast('Reinicia la app para habilitar la exportación a PDF.', 'warning');
      return false;
    }
    let info;
    try { info = await req(`/${base}/${id}`); } catch (e) { toast(e.message, 'error'); return false; }

    // 1º intento: el PDF firmado que se guardó al crear el documento.
    let base64 = await pdfFirmadoGuardado(base, id);
    let firmado = !!base64;
    if (!base64) {
      toast('Generando PDF…', 'info');
      let d;
      try { d = await req(`/${base}/${id}/documento?formato=a4&firmar=1`); }
      catch (e) { toast(e.message, 'error'); return false; }
      let pdf = null;
      try { pdf = await nd.htmlToPdf(d.html); } catch (_) {}
      if (!pdf) { toast('No se pudo generar el PDF.', 'error'); return false; }
      const s = await firmarPdfSiHay(pdf);
      base64 = s.base64; firmado = s.firmado;
      if (firmado) post(`/documento/${base}/${id}/guardar-firmado`, { pdfBase64: base64 }).catch(() => {});
    }
    try {
      const r = await nd.saveInvoicePdf({
        invoiceNumber: info.numero || label || 'DOC',
        clientName: info.clientName || 'Cliente',
        date: info.fecha || undefined,
        businessName: (dbRef().config && dbRef().config.nombre) || 'Tecno Caja',
        branchName: 'Principal',
        pdfBase64: base64,
      });
      if (r && r.ok) {
        toast((firmado ? '✅ PDF firmado guardado' : 'PDF guardado (sin firma digital)') + (r.filePath ? ': ' + r.filePath : ''), firmado ? 'success' : 'warning');
        if (nd.openExternal && r.filePath) { try { nd.openExternal('file:///' + String(r.filePath).replace(/\\/g, '/')); } catch (_) {} }
        return true;
      }
      toast('No se pudo guardar el PDF: ' + ((r && r.error) || 'error'), 'error');
    } catch (e) { toast(e.message, 'error'); }
    return false;
  }

  // ¿Está activada la firma automática? (config.service_autosign, editable desde
  // el panel e-CF o Ajustes de Empresa de Servicios).
  async function autosignActivo() {
    try { const c = await req('/config'); return !!c.autoSign; }
    catch (_) { return false; }
  }

  // base64 → blob URL en el realm del ABRIDOR (la ventana emergente es same-origin
  // y puede cargarlo). Evita construir Blob en el realm del popup (frágil en Electron).
  function pdfBlobUrl(b64) {
    const bytes = Uint8Array.from(atob(String(b64).replace(/^data:application\/pdf;base64,/, '')), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  }

  // Abre un documento (factura/cotización) en una ventana con barra: selector de
  // formato + Imprimir + Guardar PDF + Enviar por correo.
  // Prioriza el PDF firmado guardado al crear el documento; si no hay, y la
  // auto-firma está activa, firma al vuelo.
  async function preferenciasImpresionServicio() {
    let local = {};
    try { local = await window.novaDesktop?.getPeripheralsConfig?.() || {}; } catch (_) {}
    const cfg = { ...(dbRef().config || {}), ...(local || {}) };
    const formato = String(cfg.receiptPaperSize || '80mm').toLowerCase();
    return { cfg, formato: ['58mm', '80mm', 'a4'].includes(formato) ? formato : 'a4' };
  }

  async function imprimirDocumentoServicio(base, id, formato, prefs = null) {
    if (base === 'facturas' && (formato === '58mm' || formato === '80mm')) {
      return imprimirFacturaConReciboPos(id);
    }
    if (!window.novaDesktop?.printReceiptHtml) {
      abrirDoc(base, id, base === 'facturas' ? 'Factura' : 'Cotización');
      return false;
    }
    try {
      const doc = await req(`/${base}/${id}/documento?formato=${encodeURIComponent(formato)}`);
      const settings = prefs || await preferenciasImpresionServicio();
      const esTermica = formato === '58mm' || formato === '80mm';
      let printerName = '';
      if (esTermica) {
        const configured = String(settings.cfg.receiptPrinterName || '').trim();
        printerName = typeof window.resolveReceiptPrinterName === 'function'
          ? await window.resolveReceiptPrinterName(configured)
          : configured;
      } else if (settings.formato === 'a4' && settings.cfg.receiptPrinterName) {
        printerName = String(settings.cfg.receiptPrinterName).trim();
      } else {
        const result = await window.novaDesktop.listPrinters?.().catch(() => null);
        printerName = String(result?.printers?.find((printer) => printer?.isDefault)?.name || '').trim();
      }
      const result = await window.novaDesktop.printReceiptHtml(doc.html, {
        mode: 'direct', printerName, paperSize: formato,
      });
      if (!result?.ok) throw new Error(result?.error || 'No se pudo imprimir. Revisa la impresora configurada.');
      toast(esTermica ? `Factura enviada a la impresora térmica (${formato}).` : 'Factura A4 enviada a su impresora.', 'success');
      return true;
    } catch (error) {
      toast(error.message || 'No se pudo imprimir la factura.', 'error');
      return false;
    }
  }

  // Reutiliza el mismo modelo, plantilla y canal ESC/POS de la caja del POS.
  // Así las facturas térmicas de servicios salen con el ancho configurado y
  // sin abrir la ventana web de documentos.
  async function imprimirFacturaConReciboPos(id) {
    try {
      const factura = await req(`/facturas/${encodeURIComponent(id)}`);
      if (typeof window.printReceipt !== 'function') {
        toast('No está disponible la impresión del recibo del POS.', 'error');
        return false;
      }
      const venta = {
        id: factura.numero,
        numero: factura.numero,
        fecha: factura.fecha,
        cliente: factura.clientName || 'Consumidor Final',
        razonSocialCliente: factura.clientName || 'Consumidor Final',
        clienteRncCedula: factura.clientRnc || '',
        rncCliente: factura.clientRnc || '',
        cajero: factura.creadoPor || 'Sistema',
        metodo: factura.metodo || 'efectivo',
        subtotal: Number(factura.subtotal || 0),
        descuento: Number(factura.descuento || 0),
        itbis: Number(factura.itbis || 0),
        total: Number(factura.total || 0),
        recibido: Number(factura.pagado || 0),
        balance: Number(factura.balance || 0),
        pagado: Number(factura.pagado || 0),
        encf: factura.fiscalMode === 'ecf' ? factura.ncf : '',
        ncf: factura.ncf || '',
        tipoEcf: factura.ncfTipo || '',
        esElectronica: factura.fiscalMode === 'ecf',
        qrUrl: factura.qrUrl || '',
        estadoDgii: factura.ecfStatus || '',
        receiptPrimaryLabel: 'Factura',
        receiptSuccessMessage: 'Factura enviada a la impresora térmica.',
        printSuccessMessage: 'Factura enviada a la impresora térmica.',
        printFailureMessage: 'No se pudo imprimir la factura en la impresora térmica.',
        items: (factura.items || []).map((item) => ({
          nombre: item.descripcion || 'Servicio',
          qty: Number(item.cantidad || 0),
          precio: Number(item.precio || 0),
          descuento: Number(item.descuentoPct || 0),
          itbis: Number(item.itbisPct || 0),
          total: Number(item.total || 0),
          subtotal: Number(item.total || 0),
        })),
      };
      return await window.printReceipt(venta);
    } catch (error) {
      toast(error.message || 'No se pudo preparar la factura para impresión.', 'error');
      return false;
    }
  }

  async function imprimirFacturaSiTermica(id) {
    const prefs = await preferenciasImpresionServicio();
    if (prefs.formato !== '58mm' && prefs.formato !== '80mm') return false;
    return imprimirFacturaConReciboPos(id);
  }

  async function abrirDoc(base, id, label) {
    const auto = await autosignActivo();
    // Las facturas de servicios comparten el ancho configurado para la
    // impresora de recibos del POS; el selector permite cambiarlo por documento.
    const papelRecibo = String(dbRef().config?.receiptPaperSize || '80mm').toLowerCase();
    const formatoInicial = ['58mm', '80mm'].includes(papelRecibo) ? papelRecibo : 'a4';
    const canPdf = !!(window.novaDesktop && window.novaDesktop.htmlToPdf);
    const storedPdf = (auto || canPdf) ? await pdfFirmadoGuardado(base, id) : null;
    let d;
    try { d = await req(`/${base}/${id}/documento?formato=a4${auto ? '&firmar=1' : ''}`); }
    catch (e) { toast(e.message, 'error'); return; }
    const w = window.open('', '_blank');
    if (!w) { toast('Permite las ventanas emergentes para ver el documento.', 'warning'); return; }
    const modoPdf = !!(storedPdf || (auto && canPdf));
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(label)}</title>
      <style>body{margin:0;background:#eef1f4;font-family:system-ui,Segoe UI,sans-serif}
      .bar{position:sticky;top:0;display:flex;gap:8px;align-items:center;padding:9px 14px;background:#111827;color:#fff}
      .bar select,.bar button{font:inherit;padding:6px 10px;border-radius:6px;border:0;cursor:pointer}
      .bar button{background:#15803d;color:#fff}.bar .g{background:#374151}
      .bar .sig{font-size:12px;color:#86efac;margin-left:auto}
      iframe{width:100%;border:0;height:calc(100vh - 50px)}</style></head>
      <body><div class="bar"><strong>${esc(label)}</strong>
        <select id="fmt"><option value="a4"${formatoInicial === 'a4' ? ' selected' : ''}>A4</option><option value="80mm"${formatoInicial === '80mm' ? ' selected' : ''}>80 mm</option><option value="58mm"${formatoInicial === '58mm' ? ' selected' : ''}>58 mm</option></select>
        <button class="g" id="pr">Imprimir</button>
        <button id="pf">📥 Guardar PDF${modoPdf ? '' : ' firmado'}</button>
        <button class="g" id="ml">Enviar por correo</button>
        ${storedPdf ? '<button class="g" id="rg" title="Vuelve a generar el PDF firmado con el diseño actual">↻ Regenerar</button>' : ''}
        <span class="sig" id="sig"></span></div>
      <iframe id="fr"></iframe></body></html>`);
    w.document.close();
    let blobUrl = null;
    const revoke = () => { if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (_) {} blobUrl = null; } };
    const showPdf = (fr, sig, b64, firmado) => {
      try {
        blobUrl = pdfBlobUrl(b64);
        fr.removeAttribute('srcdoc');
        fr.src = blobUrl;
        if (sig) {
          sig.textContent = firmado ? '✓ Firmado digitalmente' : 'Sin firma — revisa el certificado';
          sig.style.color = firmado ? '#86efac' : '#fbbf24';
        }
        return true;
      } catch (_) { return false; }
    };
    let signedB64 = storedPdf || null;   // cache del PDF firmado dentro de esta ventana
    // Firma en 2º plano y actualiza la vista SIN bloquear la apertura.
    const bgSign = async (fr, sig, { force } = {}) => {
      if ((signedB64 && !force) || !canPdf || (!auto && !force)) return;
      if (sig) { sig.textContent = '⏳ firmando…'; sig.style.color = '#fbbf24'; }
      try {
        const fresh = force ? await req(`/${base}/${id}/documento?formato=a4&firmar=1`).then((r) => r.html).catch(() => d.html) : d.html;
        const pdf = await window.novaDesktop.htmlToPdf(fresh);
        if (!pdf) { if (sig) sig.textContent = ''; return; }
        const s = await firmarPdfSiHay(pdf, { silencioso: true });
        if (!s.firmado) { if (sig) { sig.textContent = 'sin firma — revisa el certificado'; sig.style.color = '#fbbf24'; } return; }
        signedB64 = s.base64;
        post(`/documento/${base}/${id}/guardar-firmado`, { pdfBase64: s.base64 }).catch(() => {});
        // Solo cambio la vista si el usuario sigue en A4 y no navegó a otra cosa.
        const selNow = w.document.getElementById('fmt');
        if (fr && fr.isConnected && (!selNow || selNow.value === 'a4')) showPdf(fr, sig, s.base64, true);
      } catch (_) { if (sig) sig.textContent = ''; }
    };
    const load = async (fmt) => {
      const fr = w.document.getElementById('fr');
      const sig = w.document.getElementById('sig');
      if (!fr) return;
      revoke();
      // A4 con PDF firmado ya disponible → se muestra al instante, sin espera.
      if (fmt === 'a4' && signedB64 && showPdf(fr, sig, signedB64, true)) return;
      // Sin PDF firmado: muestro el documento YA (HTML) y firmo en 2º plano.
      let doc = d;
      if (fmt !== 'a4') { try { doc = await req(`/${base}/${id}/documento?formato=${fmt}`); } catch (_) {} }
      fr.removeAttribute('src');
      fr.srcdoc = doc.html;
      if (sig) sig.textContent = '';
      if (fmt === 'a4') bgSign(fr, sig);
    };
    setTimeout(() => {
      const sel = w.document.getElementById('fmt');
      if (sel) sel.onchange = () => load(sel.value);
      const pr = w.document.getElementById('pr');
      if (pr) pr.onclick = async () => {
        const fmt = w.document.getElementById('fmt')?.value || 'a4';
        const fr = w.document.getElementById('fr');
        if (!window.novaDesktop?.printReceiptHtml) {
          try { fr.contentWindow.print(); } catch (_) { toast('No se pudo abrir la impresión.', 'error'); }
          return;
        }
        pr.disabled = true;
        try {
          const doc = await req(`/${base}/${id}/documento?formato=${encodeURIComponent(fmt)}`);
          const local = await window.novaDesktop.getPeripheralsConfig?.().catch(() => ({})) || {};
          const cfg = { ...(dbRef().config || {}), ...local };
          const esTermica = fmt === '58mm' || fmt === '80mm';
          let printerName = '';
          if (esTermica) {
            const configured = String(cfg.receiptPrinterName || '').trim();
            printerName = typeof window.resolveReceiptPrinterName === 'function'
              ? await window.resolveReceiptPrinterName(configured)
              : configured;
          } else if (cfg.receiptPaperSize === 'a4' && cfg.receiptPrinterName) {
            printerName = String(cfg.receiptPrinterName).trim();
          } else {
            const result = await window.novaDesktop.listPrinters?.().catch(() => null);
            printerName = String(result?.printers?.find((printer) => printer?.isDefault)?.name || '').trim();
          }
          const result = await window.novaDesktop.printReceiptHtml(doc.html, {
            mode: 'direct', printerName, paperSize: fmt,
          });
          if (!result?.ok) throw new Error(result?.error || 'No se pudo imprimir. Revisa la impresora configurada.');
          toast(esTermica ? `Factura enviada a la impresora térmica (${fmt}).` : 'Factura A4 enviada a la impresora predeterminada.', 'success');
        } catch (error) {
          toast(error.message || 'No se pudo imprimir la factura.', 'error');
        } finally {
          pr.disabled = false;
        }
      };
      const pf = w.document.getElementById('pf');
      if (pf) pf.onclick = () => { guardarPdfDocumento(base, id, label); };
      const rg = w.document.getElementById('rg');
      if (rg) rg.onclick = async () => {
        rg.disabled = true; const sig = w.document.getElementById('sig');
        if (sig) { sig.textContent = 'Regenerando…'; sig.style.color = '#fbbf24'; }
        try { await req(`/documento/${base}/${id}/firmado`, { method: 'DELETE' }); } catch (_) {}
        signedB64 = null;
        await bgSign(w.document.getElementById('fr'), sig, { force: true });
        rg.disabled = false;
        toast('PDF firmado regenerado con el diseño actual', 'success');
      };
      const ml = w.document.getElementById('ml');
      if (ml) ml.onclick = () => { try { revoke(); w.close(); } catch (_) {} enviarCorreoDoc(base, id, label.toLowerCase()); };
      try { w.addEventListener('beforeunload', revoke); } catch (_) {}
      load(formatoInicial);
    }, 120);
  }

  async function enviarCorreoDoc(base, id, label) {
    let info;
    try { info = await req(`/${base}/${id}`); } catch (e) { toast(e.message, 'error'); return; }
    modal(`Enviar ${label} ${info.numero} por correo`, `
      <p>Se enviará en <strong>formato A4 (PDF)</strong>, firmado digitalmente si hay certificado cargado.</p>
      <label>Correo destino<input name="to" type="email" value="${esc(info.clientEmail || '')}" placeholder="cliente@correo.com"></label>
      <label>Mensaje<textarea name="mensaje" rows="3"></textarea></label>
      <p class="srv-hint">Si el envío falla, revisa el Gmail y la contraseña de aplicación en Configuración → Empresa de Servicios.</p>`, async (fd) => {
      let pdfBase64 = null;
      let firmado = false;
      try {
        pdfBase64 = await pdfFirmadoGuardado(base, id);
        if (pdfBase64) {
          firmado = true;
        } else if (window.novaDesktop && window.novaDesktop.htmlToPdf) {
          const d = await req(`/${base}/${id}/documento?formato=a4&firmar=1`);
          pdfBase64 = await window.novaDesktop.htmlToPdf(d.html);
          if (pdfBase64) {
            const s = await firmarPdfSiHay(pdfBase64, { silencioso: true });
            pdfBase64 = s.base64; firmado = s.firmado;
            if (firmado) post(`/documento/${base}/${id}/guardar-firmado`, { pdfBase64 }).catch(() => {});
          }
        }
      } catch (_) {}
      await post(`/${base}/${id}/email`, { ...fd, pdfBase64 });
      toast(
        pdfBase64
          ? (firmado ? 'Enviado con el PDF firmado adjunto' : 'Enviado con el PDF adjunto (sin firma digital)')
          : 'Enviado por correo (sin PDF adjunto — reinicia la app para habilitarlo)',
        pdfBase64 ? 'success' : 'warning'
      );
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
        { label: '', render: (r) => r.anuladoAt ? '' : acciones([accion('data-void', r.id, 'Anular', 'anular', 'peligro')]) },
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
          { label: '', render: (r) => acciones([accion('data-pay', r.id, 'Cobrar', 'cobrar', 'ok')]) },
        ], d.items)}`;
      b.querySelectorAll('[data-pay]').forEach((el) => el.onclick = () => formPago(el.dataset.pay));
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }

  // ═══ Gastos ═══════════════════════════════════════════════════════════════
  // Reusa el registro de Gastos del POS: API /api/expenses
  // (server/routes/gastos.routes.js) y el formulario de js/compras.js
  // (categoría, NCF, ITBIS, retenciones y datos del 606). Solo cambia la vista.
  let _gasMes = '';
  async function renderGastos() {
    const b = bodyOf('srv-gastos');
    const mesActual = today().slice(0, 7);
    if (!_gasMes) _gasMes = mesActual;
    actionsOf('srv-gastos').innerHTML = `
      <label class="srv-filtro">Mes <input type="month" id="gas-mes" value="${esc(_gasMes)}"></label>
      <button class="btn btn-primary" data-new>+ Nuevo gasto</button>`;
    actionsOf('srv-gastos').querySelector('[data-new]').onclick = () => {
      if (typeof window.openNuevoGastoModal !== 'function') { toast('El registro de gastos no está disponible.', 'error'); return; }
      window.openNuevoGastoModal();
    };
    actionsOf('srv-gastos').querySelector('#gas-mes').onchange = (e) => { _gasMes = e.target.value || mesActual; renderGastos(); };
    b.innerHTML = '<div class="srv-loading">Cargando…</div>';
    try {
      const [y, m] = _gasMes.split('-').map(Number);
      const ultimo = String(new Date(y, m, 0).getDate()).padStart(2, '0');
      const rows = await apiRef().getExpenses({ desde: `${_gasMes}-01`, hasta: `${_gasMes}-${ultimo}` }) || [];
      const vigentes = rows.filter((g) => g.estado !== 'anulado');
      const suma = (lista) => lista.reduce((t, g) => t + (Number(g.total) || 0), 0);
      const puedeAnular = typeof window.currentUserCan === 'function' ? window.currentUserCan('gastos.anular') : true;
      const puedeEditar = typeof window.currentUserCan === 'function' ? window.currentUserCan('gastos.crear') : true;
      b.innerHTML = `
        <div class="srv-kpis">
          <div class="srv-kpi"><span class="srv-kpi-t">Gastos del mes</span><span class="srv-kpi-v">${money(suma(vigentes))}</span></div>
          <div class="srv-kpi"><span class="srv-kpi-t">Pagados</span><span class="srv-kpi-v">${money(suma(vigentes.filter((g) => g.estado === 'pagado')))}</span></div>
          <div class="srv-kpi"><span class="srv-kpi-t">Pendientes de pago</span><span class="srv-kpi-v">${money(suma(vigentes.filter((g) => g.estado === 'pendiente')))}</span></div>
          <div class="srv-kpi"><span class="srv-kpi-t">Registros</span><span class="srv-kpi-v">${vigentes.length}</span></div>
        </div>
        ${table([
          { label: 'Fecha', key: 'fecha' },
          { label: 'Categoría', render: (g) => {
            const lista = Array.isArray(g.categorias) && g.categorias.length ? g.categorias : [g.categoria];
            return `<span title="${esc(lista.join(', '))}">${esc(lista[0])}${lista.length > 1 ? ` <span class="srv-mas">+${lista.length - 1}</span>` : ''}</span>`;
          } },
          { label: 'Descripción', render: (g) => esc(g.descripcion) + (g.ncf ? `<small class="srv-sub">NCF ${esc(g.ncf)}</small>` : '') },
          { label: 'Proveedor / beneficiario', render: (g) => esc(g.proveedor || g.beneficiario || '—') },
          { label: 'Total', num: true, render: (g) => money(g.total) },
          { label: 'Estado', render: (g) => `<span class="srv-badge srv-badge-${esc(g.estado)}">${esc(g.estado)}</span>` },
          { label: '', render: (g) => acciones([
            accion('data-print', g.id, 'Imprimir', 'imprimir', 'pri', VER_AYUDA),
            accion('data-ver', g.id, 'Ver', 'ver'),
            g.estado !== 'anulado' && puedeEditar && accion('data-edit', g.id, 'Editar', 'editar'),
            g.estado !== 'anulado' && puedeAnular && accion('data-void', g.id, 'Anular', 'anular', 'peligro'),
          ]) },
        ], rows)}`;
      b.querySelectorAll('[data-edit]').forEach((el) => el.onclick = () => window.editarGasto && window.editarGasto(Number(el.dataset.edit)));
      b.querySelectorAll('[data-print]').forEach((el) => el.onclick = () => window.imprimirGasto && window.imprimirGasto(Number(el.dataset.print)));
      b.querySelectorAll('[data-ver]').forEach((el) => el.onclick = () => window.verGasto && window.verGasto(Number(el.dataset.ver)));
      b.querySelectorAll('[data-void]').forEach((el) => el.onclick = () => window.anularGasto && window.anularGasto(Number(el.dataset.void)));
    } catch (e) { b.innerHTML = `<div class="srv-err">${esc(e.message)}</div>`; }
  }
  // compras.js avisa al guardar o anular un gasto: refresca si la vista está abierta.
  window.addEventListener('tc:gastos-cambiaron', () => {
    if (document.getElementById('module-srv-gastos')?.classList.contains('active')) renderGastos().catch(() => {});
  });

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
      <span class="cfg-group-card__desc">Comprobante, formato, correo (Gmail), firma/sello y condiciones de pago</span></div>
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
      <p class="srv-hint">Cuenta de Google → Seguridad → Verificación en 2 pasos → <strong>Contraseñas de aplicaciones</strong>. No uses tu contraseña normal.</p>

      <div class="srv-form-sec">Firma y sello (imagen) en los documentos</div>
      <p class="srv-hint">Se estampa en la cotización y la factura (A4). Ideal: PNG con fondo transparente, máx. ~600 KB.</p>
      <div class="srv-sign-box">
        <img id="srv-sign-prev" alt="Firma" src="${esc(cfg.signature || '')}"${cfg.hasSignature ? '' : ' hidden'}>
        <span id="srv-sign-none" class="srv-hint"${cfg.hasSignature ? ' hidden' : ''}>Sin firma cargada</span>
      </div>
      <div class="srv-row srv-row-bottom">
        <label style="flex:1 1 200px">Imagen de la firma
          <input type="file" id="srv-sign-file" accept="image/png,image/jpeg,image/webp"></label>
        <button type="button" class="btn btn-ghost" id="srv-sign-clear" style="flex:0 0 auto"${cfg.hasSignature ? '' : ' hidden'}>Quitar firma</button>
      </div>
      <input type="hidden" name="signature" id="srv-sign-data" value="">
      <input type="hidden" name="signatureClear" id="srv-sign-clearflag" value="">

      <div class="srv-form-sec">Firma digital (certificado .p12)</div>
      <p class="srv-hint">El .p12 se sube en <strong>Facturación Electrónica e-CF (DGII)</strong>. No se envía nada a DGII.</p>
      <div id="srv-cert-status" class="srv-sign-box"><span class="srv-hint">Consultando certificado…</span></div>
      <label class="srv-check" style="margin-top:8px">
        <input type="checkbox" name="autoSign"${cfg.autoSign ? ' checked' : ''}>
        <span>Firmar automáticamente — la cotización y la factura salen firmadas al verlas, imprimirlas o enviarlas, sin descargar nada.</span>
      </label>

      <div class="srv-form-sec">Términos y condiciones</div>
      <label>Texto de tus términos y condiciones
        <textarea name="terms" rows="8" maxlength="20000" placeholder="Ej.: Los precios incluyen ITBIS. Se requiere un anticipo del 50% para iniciar el trabajo. La garantía cubre defectos de instalación por 30 días…">${esc(cfg.terms || '')}</textarea></label>
      <p class="srv-hint">Sale solo, al final de <strong>todas las cotizaciones y facturas</strong> (al verlas, imprimirlas, en PDF y por correo). Déjalo vacío si no quieres que aparezca.</p>`,
    async (fd) => {
      if (!fd.mailPass) delete fd.mailPass;
      if (!fd.signature) delete fd.signature;
      if (fd.signatureClear !== '1') delete fd.signatureClear;
      fd.autoSign = fd.autoSign === 'on' || fd.autoSign === '1' || fd.autoSign === true;
      await put('/config', fd);
      toast('Ajustes guardados', 'success');
    }, { submitLabel: 'Guardar', wide: true });

    const fileInp = m.querySelector('#srv-sign-file');
    const prev = m.querySelector('#srv-sign-prev');
    const none = m.querySelector('#srv-sign-none');
    const dataInp = m.querySelector('#srv-sign-data');
    const clearFlag = m.querySelector('#srv-sign-clearflag');
    const clearBtn = m.querySelector('#srv-sign-clear');
    fileInp.onchange = () => {
      const f = fileInp.files && fileInp.files[0];
      if (!f) return;
      if (f.size > 600 * 1024) { toast('La imagen pesa más de 600 KB. Redúcela o recórtala.', 'error'); fileInp.value = ''; return; }
      const rd = new FileReader();
      rd.onload = () => {
        dataInp.value = rd.result;
        clearFlag.value = '';
        prev.src = rd.result; prev.hidden = false;
        none.hidden = true; clearBtn.hidden = false;
      };
      rd.readAsDataURL(f);
    };
    clearBtn.onclick = () => {
      dataInp.value = ''; clearFlag.value = '1';
      prev.hidden = true; prev.src = '';
      none.hidden = false; clearBtn.hidden = true; fileInp.value = '';
    };

    // Estado del certificado .p12 para firma digital.
    (async () => {
      const box = m.querySelector('#srv-cert-status');
      if (!box) return;
      try {
        const st = await req('/documento/firma-estado');
        if (st && st.hasCertificate && !st.isExpired && st.status !== 'error') {
          const vto = st.validTo ? fdate(st.validTo) : null;
          box.innerHTML = `<span style="color:#15803d;font-weight:600">✓ Certificado cargado y vigente</span>`
            + (st.subject ? `<span class="srv-hint" style="display:block">${esc(String(st.subject).slice(0, 90))}</span>` : '')
            + (vto ? `<span class="srv-hint" style="display:block">Válido hasta ${esc(vto)}</span>` : '');
        } else if (st && st.hasCertificate && st.isExpired) {
          box.innerHTML = `<span style="color:#b91c1c;font-weight:600">⚠ Certificado vencido</span><span class="srv-hint" style="display:block">Sube uno nuevo en Facturación Electrónica e-CF.</span>`;
        } else if (st && st.status === 'error') {
          box.innerHTML = `<span style="color:#b45309;font-weight:600">⚠ No se pudo leer el certificado</span><span class="srv-hint" style="display:block">${esc(st.error || '')}</span>`;
        } else {
          box.innerHTML = `<span class="srv-hint">Sin certificado. Los PDF saldrán <strong>sin firma digital</strong> hasta que subas un .p12 en Facturación Electrónica e-CF (DGII).</span>`;
        }
      } catch (e) {
        box.innerHTML = `<span class="srv-hint">No se pudo consultar el certificado (${esc(e.message || 'error')}).</span>`;
      }
    })();

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
    'srv-gastos': renderGastos,
    'srv-auditoria': renderAuditoria,
  };

  window.Servicios = {
    injectChrome,
    abrirCatalogo,
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
          .then(async (r) => {
            if (!r || !r.id) return orig.call(this, venta, options);
            const prefs = await preferenciasImpresionServicio();
            if (prefs.formato === '58mm' || prefs.formato === '80mm') {
              await imprimirFacturaConReciboPos(r.id);
            } else {
              abrirDoc('facturas', r.id, 'Factura');
            }
          })
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

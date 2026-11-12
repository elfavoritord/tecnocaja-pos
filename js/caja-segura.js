// Cierre seguro con arqueo por denominaciones (mejora 8) y aperturas de gaveta
// con motivo (mejora 9). El esperado, los métodos de pago y las diferencias los
// calcula el servidor (/api/cash/close, /api/caja/*); esta pantalla solo los
// muestra. Se activa en Configuración → Facturación. Con la caja abierta:
//   - Caja oculta los montos del turno a todos (es la pantalla del cajero);
//   - el corte es un conteo a ciegas (sin esperado ni diferencia);
//   - Reportes solo se abre para quien ve reportes de caja.
// Al cerrar, después de contar, sale el reporte con ventas y diferencia.
(function () {
  'use strict';

  const DENOMINACIONES_DEF = [
    { valor: 2000, tipo: 'billete' }, { valor: 1000, tipo: 'billete' }, { valor: 500, tipo: 'billete' },
    { valor: 200, tipo: 'billete' }, { valor: 100, tipo: 'billete' }, { valor: 50, tipo: 'billete' },
    { valor: 20, tipo: 'billete' }, { valor: 25, tipo: 'moneda' }, { valor: 10, tipo: 'moneda' },
    { valor: 5, tipo: 'moneda' }, { valor: 1, tipo: 'moneda' },
  ];
  const MOTIVOS_UI = [
    { id: 'conteo', titulo: 'Conteo de efectivo', ayuda: 'Arqueo durante el turno. No cierra la caja ni cambia el esperado.' },
    { id: 'cambio', titulo: 'Cambio de menudo', ayuda: 'Cambiar denominaciones. Solo mueve el saldo si entra o sale dinero de verdad.' },
    { id: 'retiro', titulo: 'Corte parcial / retiro', ayuda: 'Sacar efectivo para resguardo. Se descuenta del esperado y el turno sigue abierto.' },
    { id: 'consumo', titulo: 'Consumo interno', ayuda: 'Productos que se consumen en el negocio. Descuenta inventario; no abre la gaveta ni toca el dinero.' },
    { id: 'gasto', titulo: 'Gasto o salida', ayuda: 'Pago de un gasto con efectivo de la caja. Reduce el esperado.' },
    { id: 'otro', titulo: 'Otro motivo', ayuda: 'Cualquier otra apertura. Describe el motivo; no mueve dinero.' },
  ];
  const MOTIVOS_HISTORIAL = [...MOTIVOS_UI,
    { id: 'arqueo', titulo: 'Corte / arqueo de caja' },
    { id: 'cierre', titulo: 'Conteo para cierre de caja' },
    { id: 'venta', titulo: 'Apertura con venta' },
  ];
  const state = { config: null, cierreClasico: null };

  const esc = (v) => (typeof escapeHtml === 'function' ? escapeHtml(String(v ?? '')) : String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
  const money = (v) => (typeof fmt === 'function' ? fmt(Number(v || 0)) : `RD$ ${Number(v || 0).toFixed(2)}`);
  const uuid = () => (window.crypto?.randomUUID?.() || `cs-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);
  const toast = (msg, type = 'info') => (typeof showToast === 'function' ? showToast(msg, type) : console.log(msg));
  const estructura = () => (typeof getBusinessStructurePayload === 'function' ? getBusinessStructurePayload() : {});
  const actorPayload = () => (typeof getActorPayload === 'function' ? getActorPayload() : {});
  const puede = (perm) => (typeof currentUserCan === 'function' ? currentUserCan(perm) : false);
  const hoy = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function abrirModal(titulo, cuerpo, pie, clase = '') {
    document.getElementById('modal-title').textContent = titulo;
    const body = document.getElementById('modal-body');
    body.innerHTML = `<div class="cs-modal ${clase}">${cuerpo}</div>`;
    document.getElementById('modal-footer').innerHTML = pie;
    document.getElementById('modal-overlay').classList.remove('hidden');
    return body;
  }
  const cerrarModal = () => (typeof closeAllModals === 'function' ? closeAllModals() : document.getElementById('modal-overlay')?.classList.add('hidden'));

  async function cargarConfig({ forzar = false } = {}) {
    if (state.config && !forzar) return state.config;
    try {
      state.config = await api.request('/api/caja/config');
    } catch (_) {
      state.config = state.config || { cierreSeguro: false, denominaciones: DENOMINACIONES_DEF, veTurnoAbierto: false, puedeConfigurar: false };
    }
    DB.cajaSegura = state.config;
    aplicarModoCiego();
    pintarHistorial();
    pintarConfig();
    return state.config;
  }

  const activo = () => Boolean(state.config?.cierreSeguro);
  const cajaAbiertaAhora = () => Boolean(DB.config?.cajaAbierta || DB.caja?.abierta);
  // Turno abierto con cierre seguro: la pantalla de Caja no muestra montos a
  // nadie (el cajero mira la misma pantalla aunque entre un administrador).
  const turnoCiego = () => activo() && cajaAbiertaAhora();
  // Fuera de Caja (Reportes) las ventas del turno solo las ve quien tiene
  // reportes de caja; lo decide el servidor (el permiso local del cajero no sirve).
  const ventasOcultas = () => turnoCiego() && !state.config?.veTurnoAbierto;

  const OCULTO = '••••••';
  const AVISO_CIEGO = 'Cierre seguro activo: las ventas y el efectivo del turno se muestran al cerrar la caja.';
  function aplicarModoCiego() {
    const ciego = turnoCiego();
    const monto = document.getElementById('caja-monto');
    if (monto) {
      if (ciego) {
        monto.dataset.csCiego = '1';
        monto.textContent = `${DB.config?.moneda || 'RD$'} ${OCULTO}`;
        monto.title = AVISO_CIEGO;
      } else if (monto.dataset.csCiego) {
        delete monto.dataset.csCiego;
        monto.title = '';
        monto.textContent = typeof fmt === 'function' ? fmt(Number(DB.config?.cajaMonto || 0)) : String(DB.config?.cajaMonto || 0);
      }
    }
    const resumen = document.querySelector('#module-caja .caja-resumen');
    if (!resumen) return;
    if (ciego) {
      resumen.dataset.csCiego = '1';
      resumen.classList.add('cs-ciego');
      resumen.querySelectorAll('.resumen-row span:last-child, .resumen-total span:last-child').forEach((el) => { el.textContent = OCULTO; });
      if (!resumen.querySelector('.cs-ciego-aviso')) {
        const aviso = document.createElement('p');
        aviso.className = 'cs-ciego-aviso';
        aviso.textContent = AVISO_CIEGO;
        resumen.querySelector('h3')?.after(aviso);
      }
    } else if (resumen.dataset.csCiego) {
      delete resumen.dataset.csCiego;
      resumen.classList.remove('cs-ciego');
      resumen.querySelector('.cs-ciego-aviso')?.remove();
      // Los montos se taparon en el DOM: se vuelven a pintar.
      if (typeof renderCajaDaySummary === 'function') renderCajaDaySummary();
    }
  }

  // Barra de Caja: historial de gaveta (solo quien ve reportes de caja; el
  // servidor lo exige) y un aviso cuando el cierre seguro está activo. El
  // interruptor vive en Configuración → Facturación.
  function pintarHistorial() {
    const bar = document.querySelector('#module-caja .caja-quick-bar');
    if (!bar) return;
    let chip = document.getElementById('cs-modo-cierre');
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'cs-modo-cierre';
      chip.className = 'cs-modo-chip';
      bar.appendChild(chip);
    }
    chip.innerHTML = `
      ${state.config?.veTurnoAbierto ? `<button type="button" class="caja-quick-btn" onclick="CajaSegura.abrirHistorialGaveta()" title="Historial de aperturas de gaveta, cortes, cambios, consumos y gastos">
        <span class="cqa-label">Historial gaveta</span></button>` : ''}
      ${activo() ? `<span class="cs-badge" title="${esc(AVISO_CIEGO)}">Cierre seguro</span>` : ''}`;
    chip.classList.toggle('hidden', !chip.textContent.trim());
  }

  // Configuración → Facturación: el interruptor (se guarda al instante).
  function pintarConfig() {
    const input = document.getElementById('cfg-cierre-seguro');
    if (!input) return;
    input.checked = activo();
    input.disabled = !state.config?.puedeConfigurar;
    document.getElementById('cfg-cierre-seguro-permiso')?.classList.toggle('hidden', Boolean(state.config?.puedeConfigurar));
  }
  async function loadConfigSection() {
    await cargarConfig({ forzar: true });
  }

  async function cambiarModo(valor, input) {
    try {
      const r = await api.request('/api/caja/config', { method: 'PUT', body: JSON.stringify({ cierreSeguro: Boolean(valor) }) });
      state.config = { ...(state.config || {}), cierreSeguro: r.cierreSeguro };
      DB.cajaSegura = state.config;
      aplicarModoCiego();
      pintarHistorial();
      pintarConfig();
      toast(valor
        ? 'Cierre seguro activado: con la caja abierta el cajero no ve sus ventas ni el efectivo; los ve al cerrar con el conteo por billetes y monedas.'
        : 'Cierre seguro desactivado.', 'success');
    } catch (e) {
      if (input) input.checked = !valor;
      toast(e.message, 'error');
    }
  }

  // Botón «Corte de caja» con el cierre seguro: conteo a ciegas que no cierra.
  async function abrirCorteCiego() {
    if (!cajaAbiertaAhora()) { toast('La caja no está abierta.', 'warning'); return; }
    if (!puede('hacer_corte_caja')) { toast('No tienes permiso para hacer el corte de caja.', 'error'); return; }
    const evento = await abrirGavetaParaConteo('arqueo');
    abrirArqueo(evento, { corte: true });
  }

  // ── Formulario de denominaciones ─────────────────────────────────────
  function formularioDenominaciones({ prefijo = 'cs', conVerifon = false } = {}) {
    const fila = (d) => `
      <div class="cs-den-row" data-valor="${d.valor}">
        <span class="cs-den-label">${d.tipo === 'moneda' ? 'Moneda' : 'Billete'} RD$${d.valor.toLocaleString('es-DO')}</span>
        <input type="number" inputmode="numeric" min="0" step="1" class="form-input cs-den-input" id="${prefijo}-den-${d.valor}" placeholder="0" oninput="CajaSegura.recalcular('${prefijo}')" aria-label="Cantidad de ${d.tipo} de ${d.valor}">
        <span class="cs-den-sub" id="${prefijo}-sub-${d.valor}">RD$ 0.00</span>
      </div>`;
    return `
      <div class="cs-den-grid">
        <div class="cs-den-col"><h4>Billetes</h4>${DENOMINACIONES_DEF.filter((d) => d.tipo === 'billete').map(fila).join('')}</div>
        <div class="cs-den-col"><h4>Monedas</h4>${DENOMINACIONES_DEF.filter((d) => d.tipo === 'moneda').map(fila).join('')}
          <div class="cs-total-contado"><span>Total contado</span><strong id="${prefijo}-total">RD$ 0.00</strong></div>
        </div>
      </div>
      ${conVerifon ? `<div class="cs-extra">
        <label>Total de tarjetas según el cierre del verifón (opcional)
          <input type="number" min="0" step="0.01" class="form-input" id="${prefijo}-verifon" placeholder="0.00"></label>
      </div>` : ''}
      <label class="cs-notas">Observaciones<textarea id="${prefijo}-notas" class="form-input" rows="2" maxlength="255" placeholder="Opcional"></textarea></label>`;
  }

  function leerDenominaciones(prefijo) {
    const salida = {};
    let totalCent = 0;
    for (const d of DENOMINACIONES_DEF) {
      const el = document.getElementById(`${prefijo}-den-${d.valor}`);
      const raw = String(el?.value || '').trim();
      if (!raw) { salida[d.valor] = 0; continue; }
      const cantidad = Number(raw);
      if (!Number.isInteger(cantidad) || cantidad < 0) throw new Error(`Escribe unidades enteras para RD$${d.valor}.`);
      salida[d.valor] = cantidad;
      totalCent += d.valor * 100 * cantidad;
    }
    return { denominaciones: salida, total: totalCent / 100 };
  }

  function recalcular(prefijo) {
    let totalCent = 0;
    for (const d of DENOMINACIONES_DEF) {
      const cantidad = Math.max(0, Math.floor(Number(document.getElementById(`${prefijo}-den-${d.valor}`)?.value || 0)) || 0);
      totalCent += d.valor * 100 * cantidad;
      const sub = document.getElementById(`${prefijo}-sub-${d.valor}`);
      if (sub) sub.textContent = money((d.valor * cantidad));
    }
    const total = document.getElementById(`${prefijo}-total`);
    if (total) total.textContent = money(totalCent / 100);
  }

  // ── Mesas con consumo sin cobrar: bloquean el cierre ─────────────────
  // El servidor vuelve a comprobarlo dentro del cierre; esto solo evita que
  // el cajero cuente la gaveta para nada.
  async function verificarCierre() {
    let r;
    try {
      const { branchId, cashRegisterId } = estructura();
      r = await api.request(`/api/caja/cierre/verificar?${new URLSearchParams({ branchId: branchId || '', cashRegisterId: cashRegisterId || '' })}`);
    } catch (_) {
      return true; // Sin respuesta: decide el servidor al cerrar.
    }
    if (r.puedeCerrar) return true;
    if (typeof closeCashCierreModal === 'function') closeCashCierreModal();
    const total = r.mesas.reduce((n, m) => n + Math.round(Number(m.consumo || 0) * 100), 0) / 100;
    abrirModal('No se puede cerrar la caja', `
      <p class="cs-aviso">Hay <strong>${r.mesas.length}</strong> mesa(s) con consumo guardado que todavía no se ha cobrado. Cóbralas antes de cerrar el turno; si cierras así, la cuenta queda sin caja que la cobre.</p>
      <div class="cs-tabla-wrap"><table class="data-table"><thead><tr><th>Mesa</th><th>Cuenta</th><th>Productos</th><th>Consumo</th><th>Última modificación</th></tr></thead><tbody>
        ${r.mesas.map((m) => `<tr><td><strong>${esc(m.mesa)}</strong></td><td>${esc(m.cuenta)}</td><td>${m.productos}</td><td>${money(m.consumo)}</td><td>${esc(String(m.actualizada || '').slice(0, 16).replace('T', ' '))}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="cs-aviso">Consumo pendiente: <strong>${money(total)}</strong> (sin impuestos ni propina).</p>`,
    `<button class="btn-secondary" onclick="closeAllModals()">Entendido</button>
     ${window.Mesas?.abrir ? '<button class="btn-primary" onclick="CajaSegura.irAMesas()">Ir a Mesas para cobrar</button>' : ''}`, 'cs-mesas-pendientes');
    return false;
  }

  function irAMesas() {
    cerrarModal();
    const nav = document.querySelector('.nav-item[data-module="ventas"]');
    if (nav && typeof showModule === 'function') showModule('ventas', nav);
    setTimeout(() => window.Mesas?.abrir?.(), 200);
  }

  // ── Cierre con arqueo ────────────────────────────────────────────────
  async function abrirCierre() {
    if (!puede('cerrar_caja')) { toast('No tienes permiso para cerrar caja.', 'error'); return; }
    if (typeof cajaAbierta !== 'undefined' && !cajaAbierta) { toast('La caja no está abierta.', 'warning'); return; }
    if (typeof getPendingDeliveryCashSales === 'function') {
      const pend = getPendingDeliveryCashSales();
      if (pend.length) { toast(`No puedes cerrar caja: hay ${pend.length} pedido(s) contra entrega sin validar. Valídalos primero.`, 'error'); return; }
    }
    if (!(await verificarCierre())) return;
    await cargarConfig();
    if (typeof closeCashCierreModal === 'function') closeCashCierreModal();
    abrirModal('Cierre de caja · arqueo por denominaciones', `
      <p class="cs-aviso">Cuenta el efectivo físico de la gaveta y escribe cuántas unidades hay de cada billete y moneda.
      ${activo() ? 'El sistema mostrará las ventas y el efectivo esperado <strong>después</strong> de guardar el conteo.' : 'El esperado y la diferencia se muestran al guardar el conteo.'}</p>
      ${formularioDenominaciones({ prefijo: 'cs', conVerifon: true })}`,
    `<button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
     <button class="btn-primary" id="cs-btn-cerrar" onclick="CajaSegura.confirmarCierre()">Guardar conteo y analizar</button>`, 'cs-cierre');
    setTimeout(() => document.getElementById('cs-den-2000')?.focus(), 80);
    await abrirGavetaParaConteo('cierre');
  }

  function overlayAnalisis() {
    let el = document.getElementById('cs-analisis');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = 'cs-analisis';
    el.className = 'cs-analisis';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    const pasos = ['Calculando denominaciones', 'Conciliando movimientos', 'Revisando métodos de pago', 'Preparando cierre'];
    el.innerHTML = `<div class="cs-analisis-card">
      <div class="cs-analisis-orb" aria-hidden="true"><span></span><span></span><span></span></div>
      <h3>Analizando el cierre</h3>
      <div class="cs-progress"><div class="cs-progress-bar" id="cs-progress-bar"></div></div>
      <ol class="cs-pasos">${pasos.map((p, i) => `<li id="cs-paso-${i}"><span class="cs-paso-dot"></span>${p}</li>`).join('')}</ol>
      <p class="cs-analisis-nota">Cálculo y validación del sistema con los registros del turno.</p></div>`;
    document.body.appendChild(el);
    return {
      paso(i, estado = 'activo') {
        const li = document.getElementById(`cs-paso-${i}`);
        if (li) { li.className = estado; }
        const done = document.querySelectorAll('#cs-analisis .cs-pasos li.hecho').length;
        const bar = document.getElementById('cs-progress-bar');
        if (bar) bar.style.width = `${Math.round((done / pasos.length) * 100)}%`;
      },
      cerrar() { el.classList.add('cs-salida'); setTimeout(() => el.remove(), 220); },
    };
  }

  async function confirmarCierre() {
    let conteo;
    try { conteo = leerDenominaciones('cs'); } catch (e) { toast(e.message, 'error'); return; }
    const verifonRaw = String(document.getElementById('cs-verifon')?.value || '').trim();
    const notas = String(document.getElementById('cs-notas')?.value || '').trim();
    const btn = document.getElementById('cs-btn-cerrar');
    if (btn) btn.disabled = true;
    cerrarModal();
    const anim = overlayAnalisis();
    try {
      // 1. Denominaciones: calculadas y validadas aquí (unidades enteras).
      anim.paso(0); anim.paso(0, 'hecho');
      // 2. El servidor bloquea el turno, concilia ventas, abonos y movimientos y cierra.
      anim.paso(1);
      const response = await api.closeCash({
        denominaciones: conteo.denominaciones, monto: conteo.total, montoCapturado: true,
        tarjetaVerifon: verifonRaw === '' ? null : Number(verifonRaw), obs: notas || 'Cierre de caja',
        ...estructura(), ...actorPayload(),
      });
      anim.paso(1, 'hecho');
      // 3. Métodos de pago: cada componente debe cuadrar con el total cobrado.
      anim.paso(2);
      const reporte = response.reporte;
      if (!reporte) throw new Error('El servidor cerró la caja pero no devolvió el reporte.');
      validarReporte(reporte);
      anim.paso(2, 'hecho');
      // 4. Reporte listo para ver e imprimir.
      anim.paso(3);
      despuesDeCerrar(response, notas);
      anim.paso(3, 'hecho');
      anim.cerrar();
      // Al cerrar el reporte sigue la pantalla de siempre (incluye la
      // transferencia a Caja General cuando ese módulo está activo).
      state.alCerrarReporte = () => {
        if (typeof showPostCloseScreen === 'function') showPostCloseScreen(resumenPostCierre(reporte, response, notas));
      };
      state.ultimoReporte = reporte;
      mostrarReporte(reporte);
    } catch (e) {
      anim.cerrar();
      toast(e.message || 'No se pudo cerrar la caja.', 'error');
      abrirCierre();
    }
  }

  function validarReporte(r) {
    const suma = Math.round((r.cobrado.efectivo + r.cobrado.tarjeta + r.cobrado.transferencia) * 100);
    if (suma !== Math.round(r.cobrado.total * 100)) throw new Error('El desglose por método no cuadra con el total cobrado. Revisa el turno antes de imprimir.');
  }

  // Estado local igual que el cierre de siempre (sin cerrar sesión).
  function despuesDeCerrar(response, notas) {
    DB.config = { ...DB.config, ...(response.config || {}) };
    DB.caja = { ...DB.caja, sessionId: null, abierta: false, activeSession: null };
    if (typeof cajaAbierta !== 'undefined') { try { cajaAbierta = false; } catch (_) { /* const en otro script */ } }
    DB.movimientosCaja = DB.movimientosCaja || [];
    DB.movimientosCaja.unshift({ tipo: 'Cierre', monto: response.reporte?.conteo?.contado || 0, hora: new Date().toLocaleString('es-DO', { timeZone: 'America/Santo_Domingo' }), obs: notas || 'Cierre de caja', usuarioId: DB.currentUser?.id || null, usuarioNombre: DB.currentUser?.nombre || DB.currentUser?.usuario || 'Sistema' });
    if (typeof syncCajaState === 'function') syncCajaState();
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs();
    if (typeof updateNotifications === 'function') updateNotifications();
  }

  // ── Reporte de cierre ────────────────────────────────────────────────
  function filasReporte(r) {
    const e = r.efectivo, cnt = r.conteo || {};
    const dif = Number(cnt.diferencia || 0);
    const difTxt = Math.abs(dif) < 0.005 ? 'Sin diferencia' : (dif > 0 ? `Sobrante ${money(dif)}` : `Faltante ${money(Math.abs(dif))}`);
    const secciones = [
      { titulo: 'Turno', filas: [
        ['Caja / turno', `#${r.turno.id}`], ['Apertura', r.turno.apertura], ['Cierre', r.turno.cierre || ''],
        ['Abrió', r.turno.abiertoPor], ['Cerró', r.cerradoPor || r.turno.cerradoPor || ''],
        ['Facturas', `${r.ventas.facturas.total} (tickets ${r.ventas.facturas.ticket} · NCF ${r.ventas.facturas.comprobanteFiscal} · e-CF ${r.ventas.facturas.electronica})`],
        ['Canceladas', String(r.ventas.facturas.canceladas || 0)],
      ] },
      { titulo: 'Ventas del turno', filas: [
        ['Total vendido', money(r.ventas.total), true], ['Ventas propias', money(r.ventas.propias)],
        ['ITBIS', money(r.ventas.itbis)], ['Descuentos', money(r.ventas.descuentos)], ['Propina legal', money(r.ventas.propinaLegal)],
      ] },
      { titulo: '1. Efectivo', filas: [
        ['Fondo inicial', money(e.apertura)], ['Ventas en efectivo', money(e.ventas)], ['Abonos en efectivo', money(e.abonos)],
        ['Otras entradas', money(e.entradas)],
        ...(e.anticipos ? [['Anticipos de reservas', money(e.anticipos)]] : []),
        ['Gastos', `- ${money(e.gastos)}`], ['Pagos a suplidores', `- ${money(e.pagosSuplidor)}`],
        ['Devoluciones / cancelaciones', `- ${money(e.devoluciones)}`],
        ...(e.anticiposDevueltos ? [['Anticipos devueltos', `- ${money(e.anticiposDevueltos)}`]] : []),
        ['Retiros / cortes parciales', `- ${money(e.retiros)}`],
        ...(e.otrasSalidas ? [['Otras salidas', `- ${money(e.otrasSalidas)}`]] : []),
        ['Propina incluida en el efectivo', money(e.propinaEnEfectivo)],
        ['Efectivo esperado', money(e.esperado), true], ['Efectivo contado', money(cnt.contado), true], ['Diferencia', difTxt, true],
      ] },
      { titulo: '2. Tarjetas', filas: [
        ['Cobrado con tarjeta', money(r.tarjeta.cobrado), true], ['Ventas', money(r.tarjeta.ventas)], ['Abonos', money(r.tarjeta.abonos)],
        ...(r.tarjeta.anticipos ? [['Anticipos de reservas', money(r.tarjeta.anticipos)]] : []),
        ['Reversado (no cuenta)', money(r.tarjeta.reversado)],
        ...(r.verifon ? [['Según verifón', money(r.verifon.total)], ['Diferencia verifón', money(r.verifon.diferencia)]] : []),
      ] },
      { titulo: '3. Transferencias', filas: [
        ['Registrado', money(r.transferencia.cobrado), true], ['Ventas', money(r.transferencia.ventas)], ['Abonos', money(r.transferencia.abonos)],
        ...(r.transferencia.anticipos ? [['Anticipos de reservas', money(r.transferencia.anticipos)]] : []),
        ['Pendiente de confirmar', money(r.transferencia.pendienteConfirmar)],
      ] },
      { titulo: '4. Crédito (no es dinero recibido)', filas: [
        ['Nuevo crédito del turno', money(r.credito.pendienteNuevo), true],
        ...r.credito.detalle.slice(0, 30).map((cr) => [`${cr.factura} · ${cr.cliente || 'Cliente'}`, `${money(cr.monto)}${cr.vence ? ` · vence ${cr.vence}` : ''}`]),
      ] },
      { titulo: 'Total cobrado por método', filas: [
        ['Efectivo', money(r.cobrado.efectivo)], ['Tarjeta', money(r.cobrado.tarjeta)], ['Transferencia', money(r.cobrado.transferencia)],
        ['Total cobrado', money(r.cobrado.total), true], ['Pendiente por cobrar (crédito)', money(r.credito.pendienteNuevo)],
        ...(r.usdRecibido ? [['USD recibidos', `US$ ${Number(r.usdRecibido).toFixed(2)}`]] : []),
      ] },
    ];
    if (cnt.denominaciones) {
      secciones.splice(3, 0, { titulo: 'Denominaciones contadas', filas: cnt.denominaciones.filter((d) => d.cantidad > 0)
        .map((d) => [`${d.tipo === 'moneda' ? 'Moneda' : 'Billete'} ${d.valor} x ${d.cantidad}`, money(d.subtotal)]) });
    }
    const ant = r.anticipos;
    if (ant?.detalle?.length) {
      const metodoTxt = { efectivo: 'efectivo', tarjeta: 'tarjeta', transferencia: 'transferencia' };
      secciones.push({ titulo: 'Anticipos de reservas', filas: [
        ['Recibidos en el turno', money(ant.recibidos.total), true],
        ['Descontados en facturas (pagados antes)', money(ant.aplicados)],
        ...(ant.devueltos.total ? [['Devueltos', `- ${money(ant.devueltos.total)}`]] : []),
        ...(ant.retenidos ? [['Quedaron al negocio', money(ant.retenidos)]] : []),
        ...ant.detalle.slice(0, 30).map((d) => [`${d.cliente} · ${{ recibido: `recibido (${metodoTxt[d.metodo] || d.metodo})`, aplicado: `en factura ${d.factura}`, devuelto: `devuelto${d.metodo ? ` (${metodoTxt[d.metodo] || d.metodo})` : ''}`, retenido: 'quedó al negocio' }[d.tipo] || d.tipo}`, money(d.monto)]),
      ] });
    }
    if (r.movimientos?.length) secciones.push({ titulo: 'Movimientos de dinero', filas: r.movimientos.slice(0, 40).map((m) => [`${String(m.fecha).slice(11, 16)} ${m.tipo}`, money(m.monto)]) });
    if (r.devoluciones?.length) secciones.push({ titulo: 'Notas de crédito / devoluciones', filas: r.devoluciones.map((d) => [`${d.factura}${d.documento ? ` · ${d.documento}` : ''}`, money(d.monto)]) });
    if (r.arqueos?.length) secciones.push({ titulo: 'Arqueos durante el turno', filas: r.arqueos.map((a) => [`${String(a.fecha).slice(11, 16)} ${a.usuario}`, `${money(a.contado)} (dif. ${money(a.diferencia)})`]) });
    if (r.gaveta?.length) secciones.push({ titulo: 'Aperturas de gaveta', filas: r.gaveta.map((g) => [`${g.origen === 'venta' ? 'Con venta' : 'Manual'} · ${g.motivo}`, String(g.veces)]) });
    if (r.avisos?.length) secciones.push({ titulo: 'Observaciones', filas: r.avisos.map((a) => [a, '']) });
    if (r.notas) secciones.push({ titulo: 'Notas', filas: [[r.notas, '']] });
    return secciones;
  }

  function htmlReporte(r, { imprimir = false, a4 = false } = {}) {
    const cfg = typeof getEffectiveConfig === 'function' ? getEffectiveConfig() : (DB.config || {});
    const dif = Number(r.conteo?.diferencia || 0);
    const clase = Math.abs(dif) < 0.005 ? 'ok' : (dif > 0 ? 'sobra' : 'falta');
    const secciones = filasReporte(r).map((s) => `
      <section class="csr-sec"><h4>${esc(s.titulo)}</h4>
        ${s.filas.map(([l, v, b]) => `<div class="csr-row${b ? ' csr-bold' : ''}"><span>${esc(l)}</span><span>${esc(v)}</span></div>`).join('')}
      </section>`).join('');
    const estilos = imprimir ? `<style>
      .csr{font-family:${a4 ? "'Segoe UI',Arial,sans-serif" : "'Courier New',monospace"};font-size:${a4 ? '12px' : '11px'};color:#000;background:#fff;${a4 ? 'max-width:180mm;margin:10mm auto' : 'padding:2px'}}
      .csr h2{text-align:center;margin:0 0 2px;font-size:${a4 ? '18px' : '13px'}} .csr .csr-sub{text-align:center;margin:0 0 6px;font-size:${a4 ? '12px' : '10px'}}
      .csr-sec{border-top:1px dashed #000;padding-top:4px;margin-top:6px;${a4 ? 'break-inside:avoid' : ''}} .csr-sec h4{margin:0 0 3px;font-size:${a4 ? '13px' : '11px'};text-transform:uppercase}
      .csr-row{display:flex;justify-content:space-between;gap:8px;margin:1px 0} .csr-row span:last-child{text-align:right;white-space:nowrap}
      .csr-bold{font-weight:700} .csr-res{text-align:center;font-weight:700;margin:6px 0;font-size:${a4 ? '15px' : '12px'}}
    </style>` : '';
    const resultado = Math.abs(dif) < 0.005 ? 'Caja cuadrada' : (dif > 0 ? `Sobrante de ${money(dif)}` : `Faltante de ${money(Math.abs(dif))}`);
    return `${estilos}<div class="csr ${imprimir ? (a4 ? 'corte-print corte-print--a4' : 'ticket-print') : ''}">
      <h2>${esc(cfg.nombre || DB.config?.nombre || cfg.businessName || 'Tecno Caja')}</h2>
      <p class="csr-sub">${cfg.rnc ? `RNC ${esc(cfg.rnc)} · ` : ''}REPORTE DE CIERRE DE CAJA</p>
      <p class="csr-sub">${esc(DB.config?.activeBranchName || '')}${DB.config?.activeCashRegisterName ? ` · ${esc(DB.config.activeCashRegisterName)}` : ''}</p>
      <div class="csr-res csr-res--${clase}">${esc(resultado)}</div>
      ${secciones}
      <p class="csr-sub">Generado ${esc(r.generadoEn || new Date().toLocaleString('es-DO'))}</p>
    </div>`;
  }

  function resumenPostCierre(r, response, notas) {
    const e = r.efectivo;
    return {
      cajero: r.cerradoPor || DB.currentUser?.nombre || 'Cajero', apertura: String(r.turno.apertura || '').slice(11, 16),
      cierre: String(r.turno.cierre || '').slice(11, 16), ventas: r.ventas.facturas.total,
      efectivo: r.cobrado.efectivo, tarjeta: r.cobrado.tarjeta, transferencia: r.cobrado.transferencia, credito: r.credito.pendienteNuevo,
      descuentos: r.ventas.descuentos, entradas: e.entradas,
      salidas: e.gastos + e.pagosSuplidor + e.devoluciones + e.retiros + e.otrasSalidas,
      totalEsperado: e.esperado, contado: r.conteo.contado, diferencia: r.conteo.diferencia, notas,
      cashSessionId: response.sessionId || null, tesoreriaInfo: response.tesoreria || null,
    };
  }

  function guardarUltimoReporte(r) { state.ultimoReporte = r; }
  // Desde la pantalla posterior al cierre: abre el reporte completo y al
  // cerrarlo vuelve a esa pantalla.
  function verUltimoReporte() {
    if (!state.ultimoReporte) { toast('No hay un cierre reciente en esta sesión.', 'info'); return; }
    const resumen = typeof showPostCloseScreen === 'function' ? showPostCloseScreen._lastSummary : null;
    document.getElementById('cash-cierre-summary')?.classList.add('hidden');
    state.alCerrarReporte = resumen ? () => showPostCloseScreen(resumen) : null;
    mostrarReporte(state.ultimoReporte);
  }

  function cerrarReporte() {
    cerrarModal();
    const despues = state.alCerrarReporte;
    state.alCerrarReporte = null;
    if (typeof despues === 'function') despues();
  }

  function mostrarReporte(r) {
    state.ultimoReporte = r;
    abrirModal('Reporte de cierre de caja', `<div class="cs-reporte">${htmlReporte(r)}</div>`,
      `<button class="btn-secondary" onclick="CajaSegura.cerrarReporte()">Cerrar</button>
       <button class="btn-secondary" onclick="CajaSegura.imprimirReporte('58mm')">Imprimir 58 mm</button>
       <button class="btn-secondary" onclick="CajaSegura.imprimirReporte('80mm')">Imprimir 80 mm</button>
       <button class="btn-secondary" onclick="CajaSegura.imprimirReporte('a4')">Imprimir A4</button>
       <button class="btn-primary" onclick="CajaSegura.pdfReporte()">Descargar PDF</button>`, 'cs-reporte-modal');
  }

  async function verReporteTurno(sessionId) {
    try { mostrarReporte(await api.request(`/api/caja/turnos/${Number(sessionId)}/resumen`)); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function imprimirReporte(papel) {
    const r = state.ultimoReporte;
    if (!r) return;
    try {
      const settings = typeof _resolveCortePrintSettings === 'function' ? await _resolveCortePrintSettings() : { cfg: {}, currency: 'RD$' };
      const termico = papel === '58mm' || papel === '80mm';
      if (termico && window.novaDesktop?.printCorteEscpos && settings.printerName && settings.isThermal) {
        const cfg = settings.cfg || {};
        const result = await window.novaDesktop.printCorteEscpos({
          negocio: { nombre: cfg.nombre || DB.config?.nombre || cfg.businessName || 'Tecno Caja', rnc: cfg.rnc || '' },
          titulo: 'CIERRE DE CAJA',
          secciones: filasReporte(r).map((s) => ({ titulo: s.titulo, filas: s.filas.map(([l, v, b]) => ({ etiqueta: l, valor: v, negrita: Boolean(b) })) })),
          corte: {},
          config: { paperWidth: papel, narrowCols: Boolean(cfg.receiptNarrowCols), cortarPapel: true, currency: settings.currency || 'RD$' },
        }, { printerName: settings.printerName, paperWidth: papel });
        if (result?.ok) { toast('Reporte enviado a la impresora.', 'success'); return; }
        toast(result?.error || 'No se pudo imprimir en la térmica.', 'error');
        return;
      }
      const html = htmlReporte(r, { imprimir: true, a4: papel === 'a4' });
      if (typeof _printConfiguredHtml === 'function' && window.novaDesktop?.printReceiptHtml) {
        await _printConfiguredHtml(html, { ...settings, paperWidth: papel, isThermal: termico }, 'Reporte enviado a la impresora.');
      } else {
        const w = window.open('', '_blank', 'width=820,height=900');
        if (!w) { toast('Permite ventanas emergentes para imprimir.', 'warning'); return; }
        w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Cierre de caja</title></head><body>${html}</body></html>`);
        w.document.close(); w.focus(); w.print();
      }
    } catch (e) { toast(e.message || 'No se pudo imprimir.', 'error'); }
  }

  async function pdfReporte() {
    const r = state.ultimoReporte;
    if (!r) return;
    try {
      await VendorLoader.load('jspdf');
      const doc = new jspdf.jsPDF({ format: 'a4' });
      let y = 16;
      const cfg = typeof getEffectiveConfig === 'function' ? getEffectiveConfig() : (DB.config || {});
      doc.setFontSize(15); doc.text(String(cfg.nombre || DB.config?.nombre || cfg.businessName || 'Tecno Caja'), 105, y, { align: 'center' }); y += 7;
      doc.setFontSize(10); doc.text(`Reporte de cierre de caja · turno #${r.turno.id}`, 105, y, { align: 'center' }); y += 9;
      for (const s of filasReporte(r)) {
        if (y > 270) { doc.addPage(); y = 16; }
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(s.titulo, 14, y); y += 5;
        doc.setDrawColor(200); doc.line(14, y - 3.5, 196, y - 3.5);
        for (const [l, v, b] of s.filas) {
          const lineas = doc.splitTextToSize(String(l), 120);
          if (y + lineas.length * 4.5 > 285) { doc.addPage(); y = 16; }
          doc.setFont('helvetica', b ? 'bold' : 'normal'); doc.setFontSize(9);
          doc.text(lineas, 16, y); doc.text(String(v), 196, y, { align: 'right' });
          y += lineas.length * 4.5;
        }
        y += 3;
      }
      doc.save(`Cierre_caja_turno_${r.turno.id}.pdf`);
    } catch (e) { toast(e.message || 'No se pudo generar el PDF.', 'error'); }
  }

  // ── Gaveta: apertura manual con motivo ───────────────────────────────
  async function abrirGaveta() {
    if (!(DB.config?.cajaAbierta || DB.caja?.abierta)) { toast('La caja debe estar abierta para usar la gaveta.', 'warning'); return; }
    if (!puede('abrir_gaveta')) { toast('No tienes permiso para abrir la gaveta.', 'error'); return; }
    abrirModal('Abrir gaveta · motivo', `
      <p class="cs-aviso">Elige por qué se abre la gaveta. Cada apertura queda registrada con usuario, caja, turno y hora.</p>
      <div class="cs-motivos">${MOTIVOS_UI.map((m) => `
        <button type="button" class="cs-motivo" data-motivo="${m.id}" onclick="CajaSegura.elegirMotivo('${m.id}')">
          <strong>${esc(m.titulo)}</strong><small>${esc(m.ayuda)}</small></button>`).join('')}</div>
      <div id="cs-motivo-form"></div>`,
    `<button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
     <button class="btn-primary" id="cs-gaveta-ok" onclick="CajaSegura.confirmarGaveta()" disabled>Continuar</button>`, 'cs-gaveta');
  }

  function elegirMotivo(id) {
    state.motivo = id;
    state.consumo = [];
    document.querySelectorAll('.cs-motivo').forEach((b) => b.classList.toggle('selected', b.dataset.motivo === id));
    const form = document.getElementById('cs-motivo-form');
    const ok = document.getElementById('cs-gaveta-ok');
    if (ok) { ok.disabled = false; ok.textContent = id === 'consumo' ? 'Registrar consumo' : 'Registrar y abrir gaveta'; }
    const campo = (label, input) => `<label class="cs-campo">${label}${input}</label>`;
    const formularios = {
      conteo: '<p class="cs-aviso">Después de abrir la gaveta escribirás las unidades de cada billete y moneda.</p>',
      cambio: `<div class="cs-campos">${campo('Efectivo que entra a la gaveta', '<input type="number" min="0" step="0.01" id="cs-g-entrada" class="form-input" placeholder="0.00">')}
        ${campo('Efectivo que sale de la gaveta', '<input type="number" min="0" step="0.01" id="cs-g-salida" class="form-input" placeholder="0.00">')}</div>
        <p class="cs-aviso">Si cambias denominaciones por el mismo valor deja ambos en cero o iguales: el saldo no cambia.</p>
        ${campo('Detalle (opcional)', '<input type="text" id="cs-g-desc" class="form-input" maxlength="200" placeholder="Ej.: cambio de un billete de 2,000">')}`,
      retiro: `<div class="cs-campos">${campo('Monto retirado *', '<input type="number" min="0.01" step="0.01" id="cs-g-monto" class="form-input" placeholder="0.00">')}
        ${campo('Destino / resguardo *', '<input type="text" id="cs-g-destino" class="form-input" maxlength="150" placeholder="Caja fuerte, banco, administración…">')}
        ${campo('Recibe (opcional)', '<input type="text" id="cs-g-resp" class="form-input" maxlength="150">')}</div>`,
      consumo: `<div class="cs-campos">${campo('Buscar producto', '<input type="search" id="cs-g-buscar" class="form-input" placeholder="Nombre o código" oninput="CajaSegura.buscarProducto(this.value)">')}
        ${campo('Persona responsable *', '<input type="text" id="cs-g-resp" class="form-input" maxlength="150">')}</div>
        <div id="cs-g-resultados" class="cs-resultados"></div><div id="cs-g-consumo" class="cs-consumo"></div>
        ${campo('Motivo', '<input type="text" id="cs-g-desc" class="form-input" maxlength="200" placeholder="Ej.: almuerzo del personal">')}`,
      gasto: `<div class="cs-campos">${campo('Concepto *', '<input type="text" id="cs-g-desc" class="form-input" maxlength="200" placeholder="Ej.: compra de hielo">')}
        ${campo('Monto *', '<input type="number" min="0.01" step="0.01" id="cs-g-monto" class="form-input" placeholder="0.00">')}
        ${campo('Responsable', '<input type="text" id="cs-g-resp" class="form-input" maxlength="150">')}
        ${campo('Evidencia (opcional)', '<input type="text" id="cs-g-evid" class="form-input" maxlength="200" placeholder="Nº de factura o recibo">')}</div>`,
      otro: campo('Describe el motivo *', '<input type="text" id="cs-g-desc" class="form-input" maxlength="300">'),
    };
    form.innerHTML = formularios[id] || '';
  }

  function buscarProducto(q) {
    const box = document.getElementById('cs-g-resultados');
    const term = String(q || '').trim().toLowerCase();
    if (!box) return;
    if (term.length < 2) { box.innerHTML = ''; return; }
    const lista = (DB.productos || []).filter((p) => `${p.nombre} ${p.codigo || ''} ${p.barcode || ''}`.toLowerCase().includes(term)).slice(0, 8);
    box.innerHTML = lista.map((p) => `<button type="button" class="cs-resultado" onclick="CajaSegura.agregarConsumo(${Number(p.id)})">${esc(p.nombre)} <small>${esc(p.codigo || '')}</small></button>`).join('') || '<p class="text-muted">Sin resultados.</p>';
  }
  function agregarConsumo(id) {
    const p = (DB.productos || []).find((x) => Number(x.id) === Number(id));
    if (!p) return;
    const actual = state.consumo.find((x) => x.productId === Number(id));
    if (actual) actual.qty += 1; else state.consumo.push({ productId: Number(id), nombre: p.nombre, qty: 1 });
    pintarConsumo();
  }
  function cambiarConsumo(id, valor) {
    const it = state.consumo.find((x) => x.productId === Number(id));
    if (!it) return;
    const qty = Number(valor);
    if (!(qty > 0)) state.consumo = state.consumo.filter((x) => x !== it); else it.qty = qty;
    pintarConsumo();
  }
  function pintarConsumo() {
    const box = document.getElementById('cs-g-consumo');
    if (!box) return;
    box.innerHTML = state.consumo.length ? state.consumo.map((x) => `<div class="cs-consumo-row"><span>${esc(x.nombre)}</span>
      <input type="number" min="0" step="0.01" class="form-input" value="${x.qty}" onchange="CajaSegura.cambiarConsumo(${x.productId}, this.value)" aria-label="Cantidad"></div>`).join('')
      : '<p class="text-muted">Agrega los productos consumidos.</p>';
  }

  async function confirmarGaveta() {
    const motivo = state.motivo;
    if (!motivo) return;
    const val = (id) => String(document.getElementById(id)?.value || '').trim();
    const payload = { eventUuid: uuid(), motivo, descripcion: val('cs-g-desc'), responsable: val('cs-g-resp'), evidencia: val('cs-g-evid'),
      destino: val('cs-g-destino'), monto: val('cs-g-monto') || undefined, entrada: val('cs-g-entrada') || undefined, salida: val('cs-g-salida') || undefined,
      items: motivo === 'consumo' ? state.consumo.map((x) => ({ productId: x.productId, qty: x.qty })) : undefined, ...estructura(), ...actorPayload() };
    const ok = document.getElementById('cs-gaveta-ok');
    if (ok) ok.disabled = true;
    try {
      const evento = await api.request('/api/caja/gaveta', { method: 'POST', body: JSON.stringify(payload) });
      if (evento.abrirGaveta) await abrirGavetaFisica(evento.eventUuid);
      if (evento.movimientoCajaId && typeof refreshCajaData === 'function') refreshCajaData();
      if (motivo === 'consumo' && typeof loadInventoryTable === 'function') loadInventoryTable();
      if (motivo === 'conteo') { abrirArqueo(evento.eventUuid); return; }
      cerrarModal();
      toast(`${MOTIVOS_UI.find((m) => m.id === motivo)?.titulo || 'Apertura'} registrado.`, 'success');
      if (motivo === 'retiro') mostrarComprobanteRetiro(evento);
    } catch (e) {
      toast(e.message, 'error');
      if (ok) ok.disabled = false;
    }
  }

  // La orden física va después de registrar el motivo; su resultado también queda.
  // Se usan los permisos propios del corte/cierre; no es una apertura manual.
  async function abrirGavetaParaConteo(motivo) {
    if (!['cierre', 'arqueo'].includes(motivo) || !cajaAbiertaAhora()) return '';
    if (!puede(motivo === 'cierre' ? 'cerrar_caja' : 'hacer_corte_caja')) return '';
    // Un equipo sin gaveta también puede contar y cerrar su turno.
    if (!window.novaDesktop?.openCashDrawer || typeof getCashDrawerOpenConfig !== 'function' || !getCashDrawerOpenConfig()) return '';
    if (state.aperturaConteo) return state.aperturaConteo;
    state.aperturaConteo = (async () => {
      try {
        const evento = await api.request('/api/caja/gaveta', { method: 'POST', body: JSON.stringify({
          eventUuid: uuid(), motivo, ...estructura(), ...actorPayload(),
        }) });
        if (evento.abrirGaveta) await abrirGavetaFisica(evento.eventUuid);
        return evento.eventUuid || '';
      } catch (e) {
        toast(e.message || 'No se pudo abrir la gaveta para contar el efectivo.', 'warning');
        return '';
      }
    })();
    try { return await state.aperturaConteo; } finally { state.aperturaConteo = null; }
  }

  async function abrirGavetaFisica(eventUuid) {
    let estado = 'sin_gaveta', error = '';
    const cfg = typeof getCashDrawerOpenConfig === 'function' ? getCashDrawerOpenConfig() : null;
    if (window.novaDesktop?.openCashDrawer && cfg) {
      const r = await window.novaDesktop.openCashDrawer(cfg).catch((err) => ({ ok: false, error: err?.message }));
      estado = r?.ok ? 'abierta' : 'fallo';
      error = r?.ok ? '' : String(r?.error || 'La gaveta no respondió.');
      if (!r?.ok) toast(`Registrado, pero la gaveta no abrió: ${error}`, 'warning');
    } else {
      toast('Registrado. Este equipo no tiene gaveta configurada (Configuración → Periféricos).', 'info');
    }
    await api.request(`/api/caja/gaveta/${encodeURIComponent(eventUuid)}/resultado`, { method: 'PATCH', body: JSON.stringify({ estado, error }) }).catch(() => {});
  }

  // Apertura automática al cobrar en efectivo: se registra aparte de las manuales.
  function registrarAperturaVenta(saleRef, resultado) {
    if (!saleRef) return;
    api.request('/api/caja/gaveta', { method: 'POST', body: JSON.stringify({ eventUuid: uuid(), motivo: 'venta', saleRef, estadoGaveta: resultado?.ok ? 'abierta' : 'fallo', ...estructura(), ...actorPayload() }) }).catch(() => {});
  }

  function mostrarComprobanteRetiro(evento) {
    const html = `<div class="csr"><h2>${esc(DB.config?.nombre || DB.config?.businessName || 'Tecno Caja')}</h2><p class="csr-sub">COMPROBANTE DE RETIRO DE EFECTIVO</p>
      <section class="csr-sec">
        <div class="csr-row"><span>Nº</span><span>${esc(evento.id)}</span></div>
        <div class="csr-row"><span>Fecha</span><span>${esc(evento.fecha)}</span></div>
        <div class="csr-row csr-bold"><span>Monto</span><span>${esc(money(evento.salida))}</span></div>
        <div class="csr-row"><span>Destino</span><span>${esc(evento.destino)}</span></div>
        ${evento.responsable ? `<div class="csr-row"><span>Recibe</span><span>${esc(evento.responsable)}</span></div>` : ''}
        <div class="csr-row"><span>Entregado por</span><span>${esc(evento.usuario)}</span></div>
      </section><p class="csr-sub">El turno sigue abierto. Firma: ____________________</p></div>`;
    state.ultimoComprobante = html;
    abrirModal('Comprobante de retiro', `<div class="cs-reporte">${html}</div>`,
      `<button class="btn-secondary" onclick="closeAllModals()">Cerrar</button><button class="btn-primary" onclick="CajaSegura.imprimirComprobante()">Imprimir</button>`);
  }
  async function imprimirComprobante() {
    const settings = typeof _resolveCortePrintSettings === 'function' ? await _resolveCortePrintSettings() : {};
    const html = `<style>.csr{font-family:'Courier New',monospace;font-size:11px;color:#000}.csr h2{text-align:center;font-size:13px;margin:0}.csr-sub{text-align:center}.csr-row{display:flex;justify-content:space-between}.csr-bold{font-weight:700}</style>${state.ultimoComprobante || ''}`;
    if (typeof _printConfiguredHtml === 'function' && window.novaDesktop?.printReceiptHtml) await _printConfiguredHtml(html, settings, 'Comprobante enviado a la impresora.');
    else { const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); w.print(); } }
  }

  // ── Arqueo durante el turno ──────────────────────────────────────────
  function abrirArqueo(drawerEventUuid = '', { corte = false } = {}) {
    state.arqueoUuid = uuid();
    const aviso = activo()
      ? 'Cuenta el efectivo de la gaveta. El conteo queda registrado y el turno sigue abierto; el esperado y la diferencia se muestran al cerrar la caja.'
      : 'Cuenta el efectivo. El turno sigue abierto y el esperado no cambia por este conteo.';
    abrirModal(corte ? 'Corte de caja · conteo a ciegas' : 'Arqueo de caja (sin cerrar)', `
      <p class="cs-aviso">${aviso}</p>
      ${formularioDenominaciones({ prefijo: 'csa' })}`,
    `<button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
     <button class="btn-primary" id="csa-ok" onclick="CajaSegura.guardarArqueo('${esc(drawerEventUuid)}')">Guardar conteo</button>`, 'cs-cierre');
  }
  async function guardarArqueo(drawerEventUuid) {
    let conteo;
    try { conteo = leerDenominaciones('csa'); } catch (e) { toast(e.message, 'error'); return; }
    const ok = document.getElementById('csa-ok');
    if (ok) ok.disabled = true;
    try {
      const r = await api.request('/api/caja/arqueos', { method: 'POST', body: JSON.stringify({ countUuid: state.arqueoUuid, drawerEventUuid: drawerEventUuid || undefined,
        denominaciones: conteo.denominaciones, notas: String(document.getElementById('csa-notas')?.value || '').trim(), ...estructura(), ...actorPayload() }) });
      if (r.ciego) {
        abrirModal('Conteo guardado', `<div class="cs-resultado-arqueo">
          <div class="csr-row csr-bold"><span>Contado</span><strong>${money(r.contado)}</strong></div>
          <p class="cs-aviso">El conteo quedó registrado y el turno sigue abierto. El esperado y la diferencia se muestran al cerrar la caja.</p></div>`,
        '<button class="btn-primary" onclick="closeAllModals()">Listo</button>');
        return;
      }
      const dif = Number(r.diferencia || 0);
      abrirModal('Resultado del arqueo', `<div class="cs-resultado-arqueo cs-${r.estado}">
        <div class="csr-row"><span>Contado</span><strong>${money(r.contado)}</strong></div>
        <div class="csr-row"><span>Esperado</span><strong>${money(r.esperado)}</strong></div>
        <div class="csr-row csr-bold"><span>${dif === 0 ? 'Sin diferencia' : (dif > 0 ? 'Sobrante' : 'Faltante')}</span><strong>${money(Math.abs(dif))}</strong></div>
        <p class="cs-aviso">El arqueo quedó registrado. El turno sigue abierto.</p></div>`,
      '<button class="btn-primary" onclick="closeAllModals()">Listo</button>');
    } catch (e) { toast(e.message, 'error'); if (ok) ok.disabled = false; }
  }

  // ── Historial de aperturas ───────────────────────────────────────────
  async function abrirHistorialGaveta() {
    const d = hoy();
    abrirModal('Historial de gaveta: aperturas, cortes, cambios, consumos y gastos', `
      <div class="cs-filtros">
        <label>Desde<input type="date" id="csh-desde" class="form-input" value="${d.slice(0, 8)}01"></label>
        <label>Hasta<input type="date" id="csh-hasta" class="form-input" value="${d}"></label>
        <label>Motivo<select id="csh-motivo" class="form-input"><option value="">Todos</option>${MOTIVOS_HISTORIAL.map((m) => `<option value="${m.id}">${esc(m.titulo)}</option>`).join('')}</select></label>
        <label>Origen<select id="csh-origen" class="form-input"><option value="">Manual y con venta</option><option value="manual">Solo manual (sin venta)</option><option value="venta">Solo con venta</option></select></label>
        <label>Usuario<select id="csh-usuario" class="form-input"><option value="">Todos</option>${(DB.users || []).map((u) => `<option value="${Number(u.id)}">${esc(u.nombre)}</option>`).join('')}</select></label>
        <label>Caja<select id="csh-caja" class="form-input"><option value="">Todas</option>${(DB.cajasSucursal || DB.cashRegisters || []).map((c) => `<option value="${Number(c.id)}">${esc(c.nombre)}</option>`).join('')}</select></label>
        <button class="btn-secondary" onclick="CajaSegura.cargarHistorial()">Consultar</button>
      </div><div id="csh-resultado"></div>`,
    `<button class="btn-secondary" onclick="closeAllModals()">Cerrar</button>
     <button class="btn-secondary" onclick="CajaSegura.exportarHistorial('xlsx')">Excel</button>
     <button class="btn-secondary" onclick="CajaSegura.exportarHistorial('print')">Imprimir A4</button>
     <button class="btn-primary" onclick="CajaSegura.exportarHistorial('pdf')">PDF</button>`, 'cs-historial');
    await cargarHistorial();
  }

  async function cargarHistorial() {
    const box = document.getElementById('csh-resultado');
    try {
      const qs = new URLSearchParams({ desde: document.getElementById('csh-desde').value, hasta: document.getElementById('csh-hasta').value,
        motivo: document.getElementById('csh-motivo').value, origen: document.getElementById('csh-origen').value,
        userId: document.getElementById('csh-usuario').value, cashRegisterId: document.getElementById('csh-caja').value });
      const data = await api.request(`/api/caja/gaveta?${qs}`);
      state.historial = data;
      const etiquetas = Object.fromEntries(MOTIVOS_HISTORIAL.map((m) => [m.id, m.titulo]));
      box.innerHTML = `<div class="cs-kpis">
          <div><span>Aperturas</span><strong>${data.total}</strong></div>
          <div><span>Entradas de efectivo</span><strong>${money(data.entradas)}</strong></div>
          <div><span>Salidas de efectivo</span><strong>${money(data.salidas)}</strong></div>
          ${Object.entries(data.porMotivo).map(([k, v]) => `<div><span>${esc(etiquetas[k] || k)}</span><strong>${v}</strong></div>`).join('')}
        </div>
        <p class="cs-aviso">${esc(data.nota)}</p>
        <div class="cs-tabla-wrap"><table class="data-table"><thead><tr><th>Fecha</th><th>Usuario</th><th>Caja</th><th>Origen</th><th>Motivo</th><th>Detalle</th><th>Entrada</th><th>Salida</th><th>Gaveta</th></tr></thead><tbody>
        ${data.eventos.map((e) => `<tr><td>${esc(e.fecha)}</td><td>${esc(e.usuario)}</td><td>${esc(e.caja)}</td><td>${e.origen === 'venta' ? 'Con venta' : 'Manual'}</td><td>${esc(e.etiqueta)}</td>
          <td>${esc([e.descripcion, e.destino && `→ ${e.destino}`, e.responsable && `resp. ${e.responsable}`, e.factura, e.productos.map((p) => `${p.cantidad} x ${p.nombre}`).join(', ')].filter(Boolean).join(' · '))}</td>
          <td>${e.entrada ? money(e.entrada) : ''}</td><td>${e.salida ? money(e.salida) : ''}</td><td>${esc(e.estadoGaveta)}</td></tr>`).join('') || '<tr><td colspan="9">Sin aperturas en el período.</td></tr>'}
        </tbody></table></div>`;
    } catch (e) { if (box) box.innerHTML = `<p class="inline-form-alert">${esc(e.message)}</p>`; }
  }

  async function exportarHistorial(formato) {
    const data = state.historial;
    if (!data) return;
    const grid = [['Fecha', 'Usuario', 'Sucursal', 'Caja', 'Dispositivo', 'Origen', 'Motivo', 'Detalle', 'Entrada', 'Salida', 'Gaveta'],
      ...data.eventos.map((e) => [e.fecha, e.usuario, e.sucursal, e.caja, e.dispositivo, e.origen === 'venta' ? 'Con venta' : 'Manual', e.etiqueta,
        [e.descripcion, e.destino, e.responsable, e.factura, e.productos.map((p) => `${p.cantidad} x ${p.nombre}`).join(', ')].filter(Boolean).join(' · '), e.entrada, e.salida, e.estadoGaveta])];
    try {
      if (formato === 'xlsx') {
        await VendorLoader.load('xlsx');
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Historial de gaveta'], [`Período ${data.desde} a ${data.hasta}`], ...grid]), 'Gaveta');
        XLSX.writeFile(book, `Historial_gaveta_${data.desde}_${data.hasta}.xlsx`);
        return;
      }
      await VendorLoader.load('jspdf');
      const doc = new jspdf.jsPDF({ orientation: 'landscape', format: 'a4' });
      const widths = [28, 26, 22, 20, 22, 16, 30, 66, 18, 18, 16];
      let y = 14;
      doc.setFontSize(13); doc.text('Historial de gaveta', 10, y); y += 6;
      doc.setFontSize(9); doc.text(`Período ${data.desde} a ${data.hasta} · ${data.total} aperturas · entradas ${money(data.entradas)} · salidas ${money(data.salidas)}`, 10, y); y += 7;
      for (const [i, row] of grid.entries()) {
        doc.setFont('helvetica', i === 0 ? 'bold' : 'normal'); doc.setFontSize(7);
        const lines = row.map((v, j) => doc.splitTextToSize(typeof v === 'number' ? (v ? money(v) : '') : String(v ?? ''), widths[j] - 1));
        const h = Math.max(...lines.map((l) => l.length)) * 3.3 + 2;
        if (y + h > 200) { doc.addPage(); y = 14; }
        let x = 10;
        lines.forEach((l, j) => { doc.text(l, x, y); x += widths[j]; });
        y += h;
      }
      if (formato === 'print') { doc.autoPrint(); window.open(doc.output('bloburl'), '_blank'); } else doc.save(`Historial_gaveta_${data.desde}_${data.hasta}.pdf`);
    } catch (e) { toast(e.message, 'error'); }
  }

  window.CajaSegura = {
    cargarConfig, loadConfigSection, aplicarModoCiego, cambiarModo, abrirCierre, confirmarCierre, recalcular, mostrarReporte, cerrarReporte, verReporteTurno,
    resumenPostCierre, guardarUltimoReporte, verUltimoReporte, verificarCierre, irAMesas, abrirCorteCiego,
    imprimirReporte, pdfReporte, abrirGaveta, elegirMotivo, buscarProducto, agregarConsumo, cambiarConsumo, confirmarGaveta,
    registrarAperturaVenta, abrirGavetaParaConteo, imprimirComprobante, abrirArqueo, guardarArqueo, abrirHistorialGaveta, cargarHistorial, exportarHistorial,
    get cierreSeguro() { return activo(); },
    get turnoCiego() { return turnoCiego(); },
    get ventasOcultas() { return ventasOcultas(); },
    AVISO_CIEGO,
    _filasReporte: filasReporte,
  };
})();

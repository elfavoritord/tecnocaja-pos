/* Plano de MESAS: usa la sesión y el servidor local del POS. */
(() => {
  'use strict';
  let estado = {}, plano = { version: 0, elementos: [] }, seleccionado = null, editando = false, cambiado = false;
  let host;
  let seleccion = new Set();
  let historial = null, planoGuardado = '', guardandoPlano = false, arrastrandoPlano = false;
  let zoomPlano = 1, busquedaElemento = '';
  let ventanaConsumo = null;
  let nodosTrasladados = [];
  let filtrosAnteriores = null;
  function trasladar(nodo, destino, antes = null) {
    const marcador = document.createComment('mesas: posición original');
    nodo.before(marcador);
    nodosTrasladados.push({ nodo, marcador });
    destino.insertBefore(nodo, antes);
  }
  function abrirVentanaConsumo() {
    const modulo = document.getElementById('module-ventas');
    ventanaConsumo = document.createElement('section');
    ventanaConsumo.id = 'mesas-consumo-ventana';
    ventanaConsumo.setAttribute('role', 'dialog');
    ventanaConsumo.setAttribute('aria-modal', 'true');
    ventanaConsumo.setAttribute('aria-labelledby', 'mesas-consumo-titulo');
    ventanaConsumo.innerHTML = `<header class="mesas-consumo-cabecera"><div><span class="mesas-consumo-etiqueta">CONSUMO DE MESA</span><h2 id="mesas-consumo-titulo">${esc(activa.draft.tableLabel)} <span>· ${esc(activa.nombre)}</span></h2></div><button type="button" class="btn-secondary" id="mesas-consumo-salir">Volver al plano</button></header><div class="mesas-consumo-cuerpo"></div><footer class="mesas-consumo-pie"></footer>`;
    document.body.append(ventanaConsumo);
    document.addEventListener('keydown', atajoConsumo, true);
    trasladar(modulo, ventanaConsumo.querySelector('.mesas-consumo-cuerpo'));
    const categoria = document.getElementById('sales-category-filter');
    const stock = document.getElementById('sales-stock-filter');
    filtrosAnteriores = { categoria: categoria.value, stock: stock.value };
    categoria.value = ''; stock.value = 'todos';
    const categorias = document.createElement('nav');
    categorias.id = 'mesas-categorias';
    categorias.setAttribute('aria-label', 'Categorías de productos');
    modulo.querySelector('.sales-catalog-header').append(categorias);
    // Reubicar los controles reales mantiene los eventos, IDs y cálculos del POS.
    const lado = modulo.querySelector('.ventas-side');
    trasladar(modulo.querySelector('.sale-order-panel'), lado, lado.querySelector('.ventas-summary'));
    ventanaConsumo.querySelector('#mesas-consumo-salir').onclick = () => {
      if (confirm('¿Volver al plano? Los cambios sin guardar se descartarán.')) volver().catch(error);
    };
    focusSalesSearchInput({ force: true });
  }
  function cerrarVentanaConsumo() {
    document.removeEventListener('keydown', atajoConsumo, true);
    document.getElementById('mesas-categorias')?.remove();
    if (filtrosAnteriores) {
      document.getElementById('sales-category-filter').value = filtrosAnteriores.categoria;
      document.getElementById('sales-stock-filter').value = filtrosAnteriores.stock;
      filtrosAnteriores = null;
    }
    for (const { nodo, marcador } of nodosTrasladados.reverse()) marcador.replaceWith(nodo);
    nodosTrasladados = [];
    ventanaConsumo?.remove(); ventanaConsumo = null;
  }
  function atajoConsumo(event) {
    if (!ventanaConsumo || !activa || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const destino = event.target;
    if (destino?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    const id = { g: 'mesas-guardar-consumo', p: 'mesas-precuenta', c: 'mesas-cobrar' }[event.key.toLowerCase()];
    if (!id) return;
    // Los atajos de la cuenta se suspenden mientras está abierto el cobro u otro diálogo.
    const dialogoAbierto = [...document.querySelectorAll('.modal-overlay, #receipt-overlay, [role="dialog"]')]
      .some((el) => el !== ventanaConsumo && !ventanaConsumo.contains(el) && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    if (dialogoAbierto) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.repeat || guardando) return;
    const boton = document.getElementById(id);
    if (boton && !boton.disabled) boton.click();
  }
  function renderCategorias() {
    const contenedor = document.getElementById('mesas-categorias');
    if (!contenedor) return;
    const filtro = document.getElementById('sales-category-filter');
    const disponibles = new Set(DB.productos.filter((p) => isProductSellable(p)).map((p) => p.categoria).filter(Boolean));
    contenedor.replaceChildren();
    for (const opcion of filtro.options) {
      if (!disponibles.has(opcion.value)) continue;
      const boton = document.createElement('button');
      boton.type = 'button'; boton.textContent = opcion.textContent;
      boton.setAttribute('aria-pressed', String(filtro.value === opcion.value));
      boton.title = `Filtrar ${opcion.textContent}. Pulsa de nuevo para ver todo.`;
      boton.onclick = () => { filtro.value = filtro.value === opcion.value ? '' : opcion.value; renderSalesCatalog(); };
      contenedor.append(boton);
    }
  }
  let cuentas = [], meseros = [], activa = null, carritoAnterior = null, guardando = false;
  // Reservaciones de hoy en adelante (reglas en js/mesas-reservas.js).
  let reservas = [], relojPlano = null;
  const reservaVigente = (elementoId) => window.MesasReservas?.vigente(reservas, elementoId) || null;
  const reservaProxima = (elementoId) => window.MesasReservas?.proxima(reservas, elementoId) || null;
  const horaBonita = (hora) => { const [h, m] = String(hora).split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d.toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit' }); };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function api(path, method = 'GET', body) {
    const response = await fetch(`/api/mesas/${path}`, { method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken || ''}` },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación.');
    return data;
  }
  function error(e) { if (typeof showToast === 'function') showToast(e.message, 'error'); else alert(e.message); }
  function aviso(texto) { if (typeof showToast === 'function') showToast(texto, 'success'); }
  // Una cuenta sin productos no ocupa la mesa: entrar y salir sin pedir no la deja roja.
  const conConsumo = (cuenta) => (cuenta?.draft?.items || []).some((i) => Number(i?.qty) > 0);
  const ocupada = (elementoId) => cuentas.some((c) => c.elemento_id === elementoId && conConsumo(c));
  const meserosActivos = () => meseros.filter((m) => Number(m.activo ?? 1) !== 0);

  // Ventanas propias del plano: el plano va por encima de los modales de la app
  // y la app de escritorio no tiene window.prompt.
  // Va fuera del plano (en la página) para que repintar el plano no la cierre;
  // lleva también la clase del plano para usar sus estilos de botones.
  function ventanaPlano(titulo, contenido) {
    const fondo = document.createElement('div');
    fondo.className = 'mesas-pantalla mesas-dialogo-fondo';
    fondo.innerHTML = `<div class="mesas-dialogo" role="dialog" aria-modal="true" aria-labelledby="mesas-dialogo-titulo"><h3 id="mesas-dialogo-titulo">${esc(titulo)}</h3>${contenido}</div>`;
    document.body.append(fondo);
    return fondo;
  }
  function elegirCuenta(opciones) {
    return new Promise((resolve) => {
      const fondo = ventanaPlano('¿A qué cuenta de esta mesa?', `<div class="mesas-dialogo-opciones">${opciones.map((c, i) => {
        const productos = (c.draft?.items || []).length;
        return `<button type="button" data-cuenta="${i}">${esc(c.nombre)} <small>${productos ? `${productos} producto(s)` : 'sin productos'}</small></button>`;
      }).join('')}</div><div class="mesas-dialogo-botones"><button type="button" data-cerrar>Cancelar</button></div>`);
      const terminar = (cuenta) => { document.removeEventListener('keydown', teclas, true); fondo.remove(); resolve(cuenta); };
      const teclas = (event) => { if (event.key === 'Escape') { event.preventDefault(); terminar(null); } };
      document.addEventListener('keydown', teclas, true);
      fondo.onclick = (event) => {
        const boton = event.target.closest('button');
        if (!boton) { if (event.target === fondo) terminar(null); return; }
        terminar(boton.hasAttribute('data-cerrar') ? null : opciones[Number(boton.dataset.cuenta)] || null);
      };
      fondo.querySelector('[data-cuenta]')?.focus();
    });
  }
  // Escape cierra solo la ventana de más arriba (puede haber una sobre otra).
  function conEscape(fondo, alCerrar) {
    const teclas = (event) => {
      if (event.key !== 'Escape') return;
      const fondos = document.querySelectorAll('.mesas-dialogo-fondo');
      if (fondos[fondos.length - 1] !== fondo) return;
      event.preventDefault(); event.stopPropagation(); alCerrar();
    };
    document.addEventListener('keydown', teclas, true);
    return () => document.removeEventListener('keydown', teclas, true);
  }
  // ── Reservaciones ─────────────────────────────────────────────────────────
  const R = () => window.MesasReservas;
  const mesasVendibles = () => plano.elementos.filter((e) => e.vendible);
  const codigoMesa = (elementoId) => plano.elementos.find((e) => e.id === elementoId)?.codigo || 'Mesa';
  // El anticipo entra o sale por la caja abierta de esta terminal.
  const estructuraCaja = () => (typeof getBusinessStructurePayload === 'function' ? getBusinessStructurePayload() : {});
  const cuentaDeReserva = (reservaId) => cuentas.find((c) => c.draft?.reservaId === reservaId) || null;
  // Reserva ya cerrada con anticipo sin resolver (devolver o dejar al negocio).
  // Un consumible cuyo cliente está en su mesa no cuenta: se descuenta al cobrar.
  function anticipoPorResolver(r) {
    if (r.estado === 'activa' || !(R().saldoAnticipo(r.anticipo) > 0)) return false;
    return !(r.anticipo.consumible && !r.anticipo.saleId && r.estado === 'cumplida' && cuentaDeReserva(r.id));
  }
  function textoAnticipo(a) {
    if (!a) return '';
    return `Anticipo ${R().fmtDinero(a.monto)} · ${(R().METODOS_ANTICIPO[a.metodo] || a.metodo).toLowerCase()} · ${a.consumible ? 'consumible' : 'no consumible'} · ${R().estadoAnticipoTexto(a).toLowerCase()}`;
  }
  async function recargarReservas() {
    reservas = await api('reservas').catch(() => reservas);
    if (host && !editando) render();
  }
  // El anticipo movió dinero de la caja: la pantalla de Caja lo ve al instante
  // (saldo, movimiento «Anticipo de reserva» y anticipos del turno).
  function aplicarCaja(caja) {
    if (!caja) return;
    try {
      if (caja.config) DB.config = typeof mergeConfigWithLocalPeripherals === 'function' ? mergeConfigWithLocalPeripherals(caja.config) : { ...DB.config, ...caja.config };
      if (caja.movimiento) DB.movimientosCaja = [caja.movimiento, ...(DB.movimientosCaja || [])];
      if (caja.anticipos && DB.caja?.activeSession) DB.caja.activeSession = { ...DB.caja.activeSession, anticiposReserva: caja.anticipos };
      if (typeof syncCajaState === 'function') syncCajaState();
    } catch (e) { console.warn('[mesas] No se pudo actualizar la pantalla de Caja:', e.message); }
  }
  async function cerrarReserva(reserva, estadoNuevo) {
    await api(`reservas/${encodeURIComponent(reserva.id)}/estado`, 'PATCH', { estado: estadoNuevo });
    await recargarReservas();
  }
  // Campos del anticipo (opcional) para reservar o para agregarlo después.
  let consumiblePorDefecto = true;
  try { consumiblePorDefecto = localStorage.getItem('tc.mesas.anticipoConsumible') !== 'no'; } catch (_) { /* sin almacenamiento */ }
  function camposAnticipo() {
    return `<fieldset class="mesas-campo-ancho mesas-anticipo">
        <legend>Anticipo <small>(opcional)</small></legend>
        <label>Monto<input name="anticipoMonto" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></label>
        <label>Forma de pago<select name="anticipoMetodo">${Object.entries(R().METODOS_ANTICIPO).map(([valor, texto]) => `<option value="${valor}">${texto}</option>`).join('')}</select></label>
        <div class="mesas-anticipo-detalle mesas-campo-ancho" hidden>
          <label>Referencia (opcional)<input name="anticipoReferencia" maxlength="80" autocomplete="off" placeholder="Nº de aprobación o de transferencia"></label>
          <label class="mesas-check"><input type="checkbox" name="anticipoConsumible" ${consumiblePorDefecto ? 'checked' : ''}> Consumible: se descuenta de su cuenta al pagar</label>
          <p class="mesas-dialogo-nota">Entra en la caja abierta de esta terminal. Si no es consumible, o si no viene, se devuelve o queda al negocio según su política.</p>
        </div>
      </fieldset>`;
  }
  function prepararCamposAnticipo(form) {
    const detalle = form.querySelector('.mesas-anticipo-detalle');
    const mostrar = () => { detalle.hidden = !(Number(form.anticipoMonto.value) > 0); };
    form.anticipoMonto.addEventListener('input', mostrar);
    mostrar();
  }
  function leerAnticipo(form) {
    const consumible = form.anticipoConsumible.checked;
    if (Number(form.anticipoMonto.value) > 0) {
      consumiblePorDefecto = consumible;
      try { localStorage.setItem('tc.mesas.anticipoConsumible', consumible ? 'si' : 'no'); } catch (_) { /* sin almacenamiento */ }
    }
    return { anticipoMonto: form.anticipoMonto.value, anticipoMetodo: form.anticipoMetodo.value,
      anticipoReferencia: form.anticipoReferencia.value, anticipoConsumible: consumible };
  }
  function limpiarAnticipo(form) {
    form.anticipoMonto.value = ''; form.anticipoReferencia.value = '';
    form.querySelector('.mesas-anticipo-detalle').hidden = true;
  }
  // Agregar el anticipo a una reserva activa que todavía no tiene.
  function agregarAnticipo(reserva) {
    return new Promise((resolve) => {
      const fondo = ventanaPlano(`Anticipo · ${reserva.cliente}`, `<form class="mesas-reserva-form">${camposAnticipo()}
        <button type="submit" class="mesas-btn-primario mesas-campo-ancho">Registrar anticipo</button></form>
        <div class="mesas-dialogo-botones"><button type="button" data-cerrar>Cancelar</button></div>`);
      const form = fondo.querySelector('form');
      prepararCamposAnticipo(form);
      const terminar = (valor) => { quitarEscape(); fondo.remove(); resolve(valor); };
      const quitarEscape = conEscape(fondo, () => terminar(null));
      fondo.onclick = (event) => { if (event.target === fondo || event.target.closest('[data-cerrar]')) terminar(null); };
      form.onsubmit = async (event) => {
        event.preventDefault();
        const boton = form.querySelector('button[type="submit"]');
        try {
          const datos = leerAnticipo(form);
          if (!R().validarAnticipo(datos)) throw new Error('Escribe el monto del anticipo.');
          boton.disabled = true;
          const r = await api(`reservas/${encodeURIComponent(reserva.id)}/anticipo`, 'POST', { ...datos, ...estructuraCaja() });
          aplicarCaja(r.caja);
          await recargarReservas();
          terminar(r);
        } catch (e) { error(e); boton.disabled = false; }
      };
      form.anticipoMonto.focus();
    });
  }
  // ¿Qué se hace con lo que queda del anticipo? Según la política del negocio.
  function preguntarAnticipo(reserva, motivo) {
    const a = reserva.anticipo, saldo = R().saldoAnticipo(a);
    return new Promise((resolve) => {
      const metodo = (R().METODOS_ANTICIPO[a.metodo] || a.metodo).toLowerCase();
      const fondo = ventanaPlano(`Anticipo de ${reserva.cliente}`, `
        <p class="mesas-dialogo-nota">${motivo ? `${esc(motivo)} ` : ''}Quedan <strong>${esc(R().fmtDinero(saldo))}</strong> del anticipo (pagado con ${esc(metodo)}). ¿Qué indica la política del negocio?</p>
        <div class="mesas-dialogo-opciones">
          <button type="button" data-anticipo="efectivo" class="mesas-btn-primario">Devolverlo en efectivo (sale de la caja)</button>
          ${a.metodo !== 'efectivo' ? `<button type="button" data-anticipo="original">Devolverlo por ${esc(metodo)} (fuera de la caja)</button>` : ''}
          <button type="button" data-anticipo="retener">Se queda el negocio</button>
        </div>
        <div class="mesas-dialogo-botones"><button type="button" data-cerrar>Decidir después</button></div>`);
      const terminar = (valor) => { quitarEscape(); fondo.remove(); resolve(valor); };
      const quitarEscape = conEscape(fondo, () => terminar(null));
      fondo.onclick = (event) => {
        if (event.target === fondo || event.target.closest('[data-cerrar]')) { terminar(null); return; }
        const boton = event.target.closest('[data-anticipo]');
        if (boton) terminar(boton.dataset.anticipo);
      };
      fondo.querySelector('[data-anticipo]')?.focus();
    });
  }
  async function resolverAnticipo(reserva, motivo = '') {
    const decision = await preguntarAnticipo(reserva, motivo);
    if (!decision) { aviso('El anticipo queda pendiente en Reservaciones'); return null; }
    const r = await api(`reservas/${encodeURIComponent(reserva.id)}/anticipo`, 'PATCH',
      { accion: decision === 'retener' ? 'retener' : 'devolver', metodo: decision === 'original' ? 'original' : 'efectivo', ...estructuraCaja() });
    aplicarCaja(r.caja);
    await recargarReservas();
    aviso(decision === 'retener' ? `El anticipo de ${reserva.cliente} quedó al negocio` : `Anticipo devuelto a ${reserva.cliente}`);
    return r;
  }
  // Llegó el cliente: se cierra la reserva y se abre su cuenta. Un anticipo
  // consumible se descontará al cobrar; uno que no lo es se resuelve ahora.
  async function llego(reserva) {
    await cerrarReserva(reserva, 'cumplida');
    if (reserva.anticipo && !reserva.anticipo.consumible && R().saldoAnticipo(reserva.anticipo) > 0) {
      await resolverAnticipo(reserva, 'El cliente llegó. Este anticipo no se descuenta de su cuenta.').catch(error);
    }
    await elegirMesa(reserva.elemento_id, { reserva });
  }
  async function cerrarConAnticipo(reserva, estadoNuevo) {
    await cerrarReserva(reserva, estadoNuevo);
    if (R().saldoAnticipo(reserva.anticipo) > 0) {
      await resolverAnticipo(reserva, estadoNuevo === 'no_vino' ? 'El cliente no vino.' : 'La reserva se canceló.').catch(error);
    }
  }
  // ── Constancia (recibo) de la reserva ─────────────────────────────────────
  function htmlConstancia(secciones, negocio) {
    return `<div class="mesas-constancia-hoja"><h4>${esc(negocio.nombre)}</h4>${negocio.rnc ? `<p class="mesas-constancia-centro">RNC ${esc(negocio.rnc)}</p>` : ''}
      <p class="mesas-constancia-centro"><strong>CONSTANCIA DE RESERVA</strong></p>
      ${secciones.map((s) => `<section><h5>${esc(s.titulo)}</h5>${s.filas.map(([etiqueta, valor, negrita]) => (valor
        ? `<div class="mesas-constancia-fila${negrita ? ' is-negrita' : ''}"><span>${esc(etiqueta)}</span><span>${esc(valor)}</span></div>`
        : `<p>${esc(etiqueta)}</p>`)).join('')}</section>`).join('')}
      <p class="mesas-constancia-centro">${esc(new Date().toLocaleString('es-DO'))}</p></div>`;
  }
  function negocioConstancia(cfg = {}) {
    return { nombre: cfg.nombre || DB.config?.nombre || cfg.businessName || DB.config?.businessName || 'Tecno Caja', rnc: cfg.rnc || DB.config?.rnc || '' };
  }
  async function imprimirConstancia(secciones) {
    const ajustes = typeof _resolveCortePrintSettings === 'function' ? await _resolveCortePrintSettings() : { cfg: {} };
    const cfg = ajustes.cfg || {};
    const negocio = negocioConstancia(cfg);
    // Térmica: el mismo formato por secciones que el reporte de cierre.
    if (ajustes.isThermal && ajustes.printerName && window.novaDesktop?.printCorteEscpos) {
      const result = await window.novaDesktop.printCorteEscpos({ negocio, titulo: 'CONSTANCIA DE RESERVA',
        secciones: secciones.map((s) => ({ titulo: s.titulo, filas: s.filas.map(([etiqueta, valor, negrita]) => ({ etiqueta, valor, negrita: Boolean(negrita) })) })),
        corte: {}, config: { paperWidth: ajustes.paperWidth, narrowCols: Boolean(cfg.receiptNarrowCols), cortarPapel: true, currency: ajustes.currency || 'RD$' } },
      { printerName: ajustes.printerName, paperWidth: ajustes.paperWidth });
      if (!result?.ok) throw new Error(result?.error || 'No se pudo imprimir en la impresora térmica.');
      aviso('Constancia enviada a la impresora');
      return;
    }
    const html = `<style>.mesas-constancia-hoja{font-family:'Courier New',monospace;font-size:12px;color:#000;max-width:360px;margin:0 auto}
      .mesas-constancia-hoja h4{text-align:center;font-size:15px;margin:0 0 2px}.mesas-constancia-hoja h5{font-size:12px;margin:10px 0 3px;border-bottom:1px dashed #000;text-transform:uppercase}
      .mesas-constancia-centro{text-align:center;margin:2px 0}.mesas-constancia-fila{display:flex;justify-content:space-between;gap:10px}.mesas-constancia-fila span:last-child{text-align:right}
      .is-negrita{font-weight:700}.mesas-constancia-hoja p{margin:3px 0}</style>${htmlConstancia(secciones, negocio)}`;
    if (typeof _printConfiguredHtml === 'function' && window.novaDesktop?.printReceiptHtml) {
      await _printConfiguredHtml(html, ajustes, 'Constancia enviada a la impresora');
      return;
    }
    const w = window.open('', '_blank', 'width=440,height=700');
    if (!w) throw new Error('Permite ventanas emergentes para imprimir.');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Constancia de reserva</title></head><body>${html}</body></html>`);
    w.document.close(); w.focus(); w.print();
  }
  function verConstancia(reserva) {
    const secciones = R().constancia(reserva, { mesa: codigoMesa(reserva.elemento_id), usuario: reserva.anticipo?.recibidoPor || reserva.usuario });
    const fondo = ventanaPlano('Constancia de reserva', `<div class="mesas-constancia">${htmlConstancia(secciones, negocioConstancia())}</div>
      <div class="mesas-dialogo-botones"><button type="button" data-cerrar>Cerrar</button><button type="button" class="mesas-btn-primario" data-imprimir>Imprimir</button></div>`);
    const terminar = () => { quitarEscape(); fondo.remove(); };
    const quitarEscape = conEscape(fondo, terminar);
    fondo.onclick = async (event) => {
      if (event.target === fondo || event.target.closest('[data-cerrar]')) { terminar(); return; }
      const boton = event.target.closest('[data-imprimir]');
      if (!boton) return;
      boton.disabled = true;
      try { await imprimirConstancia(secciones); } catch (e) { error(e); } finally { boton.disabled = false; }
    };
    fondo.querySelector('[data-imprimir]').focus();
  }
  // Ventana de una mesa reservada: llegó, no vino, cancelar o usarla mientras tanto.
  function verReserva(reserva) {
    const atrasada = window.MesasReservas.atrasada(reserva);
    const a = reserva.anticipo;
    const fondo = ventanaPlano(`${codigoMesa(reserva.elemento_id)} · reservada`, `
      <div class="mesas-reserva-ficha">
        <strong>${esc(reserva.cliente)}</strong>
        <span>${esc(horaBonita(reserva.hora))} · ${reserva.personas} persona(s)${atrasada ? ' · <em class="mesas-atrasada">atrasada</em>' : ''}</span>
        ${reserva.telefono ? `<span>Tel. ${esc(reserva.telefono)}</span>` : ''}
        ${reserva.nota ? `<span class="mesas-dialogo-nota">${esc(reserva.nota)}</span>` : ''}
        ${a ? `<span class="mesas-reserva-anticipo">${esc(textoAnticipo(a))}</span>` : ''}
      </div>
      <div class="mesas-dialogo-opciones">
        <button type="button" data-reserva="llego" class="mesas-btn-primario">Llegó: abrir su cuenta${a?.consumible && R().saldoAnticipo(a) > 0 ? ' (con su anticipo)' : ''}</button>
        <button type="button" data-reserva="usar">Usar la mesa ahora (la reserva sigue)</button>
        <button type="button" data-reserva="no_vino">No vino</button>
        <button type="button" data-reserva="cancelada">Cancelar la reserva</button>
        ${a ? '' : '<button type="button" data-reserva="anticipo">Agregar anticipo</button>'}
        <button type="button" data-reserva="recibo">Constancia (imprimir)</button>
      </div>
      <div class="mesas-dialogo-botones"><button type="button" data-cerrar>Cerrar</button></div>`);
    const terminar = () => { quitarEscape(); fondo.remove(); };
    const quitarEscape = conEscape(fondo, terminar);
    fondo.onclick = async (event) => {
      if (event.target === fondo || event.target.closest('[data-cerrar]')) { terminar(); return; }
      const boton = event.target.closest('[data-reserva]');
      if (!boton) return;
      const accion = boton.dataset.reserva;
      if (accion === 'recibo') { verConstancia(reserva); return; }
      fondo.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        if (accion === 'anticipo') {
          terminar();
          const conAnticipo = await agregarAnticipo(reserva);
          if (conAnticipo) verConstancia(conAnticipo);
          return;
        }
        if (accion === 'llego') { terminar(); await llego(reserva); return; }
        if (accion === 'usar') { terminar(); await elegirMesa(reserva.elemento_id); return; }
        terminar();
        await cerrarConAnticipo(reserva, accion);
        aviso(accion === 'no_vino' ? `Reserva de ${reserva.cliente} marcada como no vino` : `Reserva de ${reserva.cliente} cancelada`);
      } catch (e) { error(e); fondo.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
    };
  }
  // Lista de reservaciones (hoy y próximos días) y formulario para reservar.
  function abrirReservas({ elementoId = '' } = {}) {
    const ahora = new Date();
    const hoy = window.MesasReservas.fechaLocal(ahora);
    const manana = window.MesasReservas.fechaLocal(new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + 1));
    const proximaMediaHora = new Date(ahora.getTime() + 30 * 60000);
    proximaMediaHora.setMinutes(proximaMediaHora.getMinutes() < 30 ? 30 : 60, 0, 0);
    const horaInicial = `${String(proximaMediaHora.getHours()).padStart(2, '0')}:${String(proximaMediaHora.getMinutes()).padStart(2, '0')}`;
    const fechaInicial = window.MesasReservas.fechaLocal(proximaMediaHora);
    const opcionesMesa = mesasVendibles().map((e) => `<option value="${esc(e.id)}" ${e.id === elementoId ? 'selected' : ''}>${esc(e.codigo)}${e.capacidad ? ` · ${e.capacidad} personas` : ''}${ocupada(e.id) ? ' · ocupada ahora' : ''}</option>`).join('');
    const fondo = ventanaPlano('Reservaciones', `
      <form class="mesas-reserva-form">
        <label class="mesas-campo-ancho">Mesa<select name="elementoId" required>${opcionesMesa || '<option value="">No hay mesas que vendan</option>'}</select></label>
        <label>Fecha<input name="fecha" type="date" min="${hoy}" value="${fechaInicial}" required></label>
        <label>Hora<input name="hora" type="time" value="${horaInicial}" required></label>
        <label class="mesas-campo-ancho">Nombre de quien reserva<input name="cliente" maxlength="120" autocomplete="off" required></label>
        <label>Teléfono<input name="telefono" type="tel" maxlength="40" inputmode="tel" placeholder="809-000-0000"></label>
        <label>Personas<input name="personas" type="number" min="1" max="500" step="1" value="2" required></label>
        <label class="mesas-campo-ancho">Nota<input name="nota" maxlength="300" placeholder="Cumpleaños, silla para bebé…"></label>
        ${camposAnticipo()}
        <button type="submit" class="mesas-btn-primario mesas-campo-ancho">Reservar</button>
      </form>
      <p class="mesas-dialogo-nota">La mesa se ve reservada desde ${window.MesasReservas.VENTANA_MIN / 60} horas antes. Mientras tanto se puede usar.</p>
      <div class="mesas-reserva-lista"></div>
      <div class="mesas-dialogo-botones"><button type="button" data-cerrar>Cerrar</button></div>`);
    fondo.querySelector('.mesas-dialogo').classList.add('mesas-dialogo--ancho');
    const lista = fondo.querySelector('.mesas-reserva-lista');
    const form = fondo.querySelector('form');
    prepararCamposAnticipo(form);
    const etiquetaDia = (fecha) => (fecha === hoy ? 'Hoy' : fecha === manana ? 'Mañana'
      : new Date(`${fecha}T12:00:00`).toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long' }));
    const lineaAnticipo = (r) => (r.anticipo ? `<small class="mesas-reserva-anticipo">${esc(textoAnticipo(r.anticipo))}</small>` : '');
    const pintar = () => {
      const activas = reservas.filter((r) => r.estado === 'activa');
      const atendidasHoy = reservas.filter((r) => r.fecha === hoy && r.estado !== 'activa').length;
      // Reservas cerradas con anticipo por devolver o dejar al negocio.
      const pendientes = reservas.filter(anticipoPorResolver);
      const bloquePendientes = pendientes.length ? `<h4 class="mesas-reserva-alerta">Anticipos por resolver</h4><ul>${pendientes.map((r) => `
        <li data-id="${esc(r.id)}">
          <span class="mesas-reserva-hora">${esc(R().fmtDinero(R().saldoAnticipo(r.anticipo)))}</span>
          <span class="mesas-reserva-datos"><strong>${esc(r.cliente)}</strong><small>${esc(codigoMesa(r.elemento_id))} · ${esc(etiquetaDia(r.fecha))} ${esc(horaBonita(r.hora))} · ${esc({ cumplida: 'llegó', no_vino: 'no vino', cancelada: 'cancelada' }[r.estado] || r.estado)}</small>${lineaAnticipo(r)}</span>
          <span class="mesas-reserva-acciones">${r.anticipo.consumible && !r.anticipo.saleId && r.estado === 'cumplida' ? '<button type="button" data-accion="cuenta">Abrir su cuenta</button>' : ''}<button type="button" data-accion="resolver">Devolver / dejar</button><button type="button" data-accion="recibo">Constancia</button></span>
        </li>`).join('')}</ul>` : '';
      if (!activas.length) {
        lista.innerHTML = `${bloquePendientes}<p class="mesas-reserva-vacia">No hay reservaciones pendientes.${atendidasHoy ? ` Hoy se cerraron ${atendidasHoy}.` : ''}</p>`;
        return;
      }
      const dias = [...new Set(activas.map((r) => r.fecha))];
      lista.innerHTML = bloquePendientes + dias.map((dia) => `<h4>${esc(etiquetaDia(dia))}</h4><ul>${activas.filter((r) => r.fecha === dia).map((r) => `
        <li data-id="${esc(r.id)}">
          <span class="mesas-reserva-hora">${esc(horaBonita(r.hora))}</span>
          <span class="mesas-reserva-datos"><strong>${esc(r.cliente)}</strong><small>${esc(codigoMesa(r.elemento_id))} · ${r.personas} persona(s)${r.telefono ? ` · ${esc(r.telefono)}` : ''}${r.nota ? ` · ${esc(r.nota)}` : ''}${dia === hoy && window.MesasReservas.atrasada(r) ? ' · <em class="mesas-atrasada">atrasada</em>' : ''}</small>${lineaAnticipo(r)}</span>
          <span class="mesas-reserva-acciones">${dia === hoy ? '<button type="button" data-accion="llego">Llegó</button><button type="button" data-accion="no_vino">No vino</button>' : ''}<button type="button" data-accion="cancelada">Cancelar</button>${r.anticipo ? '' : '<button type="button" data-accion="anticipo">Anticipo</button>'}<button type="button" data-accion="recibo">Constancia</button></span>
        </li>`).join('')}</ul>`).join('')
        + (atendidasHoy ? `<p class="mesas-reserva-vacia">Hoy se cerraron ${atendidasHoy} reservación(es).</p>` : '');
    };
    const terminar = () => { quitarEscape(); fondo.remove(); };
    const quitarEscape = conEscape(fondo, terminar);
    form.onsubmit = async (event) => {
      event.preventDefault();
      const boton = form.querySelector('button[type="submit"]');
      const datos = { ...Object.fromEntries(new FormData(form)), ...leerAnticipo(form) };
      datos.personas = Number(datos.personas);
      try {
        // Mismos avisos que daría el servidor, sin esperar.
        window.MesasReservas.validarReserva(datos);
        window.MesasReservas.validarAnticipo(datos);
        boton.disabled = true;
        const nueva = await api('reservas', 'POST', { ...datos, ...estructuraCaja() });
        aplicarCaja(nueva.caja);
        reservas = await api('reservas').catch(() => reservas);
        pintar(); render();
        form.cliente.value = ''; form.telefono.value = ''; form.nota.value = '';
        limpiarAnticipo(form);
        aviso(`${codigoMesa(datos.elementoId)} reservada para ${datos.cliente} a las ${horaBonita(datos.hora)}`);
        verConstancia(nueva);
      } catch (e) { error(e); } finally { boton.disabled = false; }
    };
    fondo.onclick = async (event) => {
      if (event.target === fondo || event.target.closest('[data-cerrar]')) { terminar(); return; }
      const boton = event.target.closest('[data-accion]');
      if (!boton) return;
      const reserva = reservas.find((r) => r.id === boton.closest('li')?.dataset.id);
      if (!reserva) return;
      const accion = boton.dataset.accion;
      if (accion === 'recibo') { verConstancia(reserva); return; }
      boton.disabled = true;
      try {
        if (accion === 'llego') { terminar(); await llego(reserva); return; }
        if (accion === 'cuenta') { terminar(); await elegirMesa(reserva.elemento_id, { reserva }); return; }
        if (accion === 'anticipo') {
          const conAnticipo = await agregarAnticipo(reserva);
          pintar();
          if (conAnticipo) verConstancia(conAnticipo);
          return;
        }
        if (accion === 'resolver') await resolverAnticipo(reserva);
        else await cerrarConAnticipo(reserva, accion);
        pintar();
      } catch (e) { error(e); boton.disabled = false; }
    };
    pintar();
    form.cliente.focus();
  }
  function abrirMeseros() {
    const fondo = ventanaPlano('Meseros/as', `<p class="mesas-dialogo-nota">Se eligen en la cuenta de cada mesa y salen en la venta.</p>
      <ul class="mesas-meseros-lista"></ul>
      <form class="mesas-meseros-nuevo"><label>Nombre<input name="nombre" maxlength="100" autocomplete="off" required></label><label>Teléfono (opcional)<input name="telefono" maxlength="40" autocomplete="off"></label><button type="submit" class="mesas-btn-primario">Agregar</button></form>
      <div class="mesas-dialogo-botones"><button type="button" data-cerrar>Cerrar</button></div>`);
    const lista = fondo.querySelector('.mesas-meseros-lista');
    const form = fondo.querySelector('form');
    const pintar = () => {
      lista.innerHTML = meseros.length ? meseros.map((m) => {
        const activo = Number(m.activo ?? 1) !== 0;
        return `<li class="${activo ? '' : 'inactivo'}"><span>${esc(m.nombre)}${m.telefono ? ` <small>${esc(m.telefono)}</small>` : ''}${activo ? '' : ' <small>(quitado)</small>'}</span><button type="button" data-mesero="${esc(m.id)}" data-activo="${activo ? 'no' : 'si'}">${activo ? 'Quitar' : 'Volver a activar'}</button></li>`;
      }).join('') : '<li class="vacio">Todavía no hay meseros. Agrega el primero.</li>';
    };
    const terminar = () => { document.removeEventListener('keydown', teclas, true); fondo.remove(); };
    const teclas = (event) => { if (event.key === 'Escape') { event.preventDefault(); terminar(); } };
    document.addEventListener('keydown', teclas, true);
    form.onsubmit = async (event) => {
      event.preventDefault();
      const nombre = form.nombre.value.trim();
      if (!nombre) { form.nombre.focus(); return; }
      const boton = form.querySelector('button[type="submit"]');
      boton.disabled = true;
      try {
        await api('meseros', 'POST', { nombre, telefono: form.telefono.value.trim() });
        meseros = await api('meseros'); pintar(); form.reset(); form.nombre.focus();
        aviso(`${nombre} quedó registrado como mesero.`);
      } catch (e) { error(e); } finally { boton.disabled = false; }
    };
    fondo.onclick = async (event) => {
      if (event.target === fondo || event.target.closest('[data-cerrar]')) { terminar(); return; }
      const boton = event.target.closest('[data-mesero]');
      if (!boton) return;
      boton.disabled = true;
      try {
        await api(`meseros/${encodeURIComponent(boton.dataset.mesero)}`, 'PATCH', { activo: boton.dataset.activo === 'si' });
        meseros = await api('meseros'); pintar();
      } catch (e) { error(e); boton.disabled = false; }
    };
    pintar();
    form.nombre.focus();
  }
  async function cargar() {
    try {
      estado = await api('estado');
      document.getElementById('mesas-abrir').classList.toggle('hidden', !estado.activo);
      const toggle = document.getElementById('cfg-mesas-enabled');
      toggle.checked = estado.activo;
      toggle.disabled = !estado.puedeConfigurar;
    } catch (e) { document.getElementById('mesas-abrir')?.classList.add('hidden'); }
  }
  async function activar(value) {
    try { await api('config', 'PUT', { activo: value }); await cargar(); }
    catch (e) { error(e); await cargar(); }
  }
  async function abrir() {
    if (activa) { error(new Error('Guarda el consumo o vuelve al plano desde la barra de la cuenta.')); return; }
    try {
      await cargar();
      if (!estado.activo) return;
      plano = await api('plano'); seleccionado = null; seleccion.clear(); editando = false; cambiado = false;
      historial = new window.MesasHistorial.HistorialPlano(plano.elementos);
      planoGuardado = JSON.stringify(plano.elementos);
      cuentas = await api('cuentas');
      meseros = await api('meseros');
      reservas = await api('reservas').catch(() => []);
      host = document.createElement('section'); host.className = 'mesas-pantalla';
      host.setAttribute('aria-label', 'Plano interactivo de mesas');
      document.body.append(host); render();
      // Las mesas pasan a "Reservada" con la hora: se repinta cada minuto (sin
      // interrumpir el editor ni una ventana abierta).
      clearInterval(relojPlano);
      relojPlano = setInterval(() => {
        if (!host) { clearInterval(relojPlano); relojPlano = null; return; }
        if (!editando && !document.querySelector('.mesas-dialogo-fondo')) render();
      }, 60000);
    } catch (e) { error(e); }
  }
  function cerrar() {
    if (cambiado && !confirm('Hay cambios sin guardar. ¿Salir del editor?')) return;
    host?.remove(); host = null;
  }
  // Estado de una mesa en el plano: ocupada manda sobre reservada.
  function estadoMesa(e) {
    if (!e.vendible) return 'decorativa';
    if (ocupada(e.id)) return 'ocupada';
    return reservaVigente(e.id) ? 'reservada' : 'disponible';
  }
  function leyendaEstados() {
    const cantidades = { disponible: 0, ocupada: 0, reservada: 0, decorativa: 0 };
    for (const e of plano.elementos) cantidades[estadoMesa(e)]++;
    return [['disponible', 'Disponible'], ['ocupada', 'Ocupada'], ['reservada', 'Reservada'], ['decorativa', 'Sin venta']].map(([key, label]) =>
      `<span data-estado="${key}"><i class="mesas-punto ${key}" aria-hidden="true"></i>${label}<b class="mesas-estado-cantidad">${cantidades[key]}</b></span>`).join('');
  }
  function render() {
    const desplazamiento = ['.mesas-scroll', '.mesas-biblioteca', '#mesas-propiedades'].map((selector) => {
      const nodo = host.querySelector(selector);
      return { selector, x: nodo?.scrollLeft || 0, y: nodo?.scrollTop || 0 };
    });
    host.classList.toggle('mesas-editor-activo', editando);
    host.innerHTML = `<header class="mesas-plano-cabecera"><button data-action="cerrar" class="mesas-btn-volver">← Volver a Ventas</button><div class="mesas-plano-titulo"><span>PLANO DEL NEGOCIO</span><h2>${editando ? 'Diseña tu espacio' : 'Mesas y espacios'}</h2></div>
      <div class="mesas-plano-acciones">${estado.puedeEditar ? `<button data-action="editar">${editando ? 'Previsualizar' : plano.elementos.length ? 'Editar plano' : 'Crear mi plano'}</button><button data-action="guardar" class="mesas-btn-primario" ${editando ? '' : 'hidden'}>Guardar plano</button>` : ''}</div></header>
      <div class="mesas-plano-herramientas"><p>${editando ? 'Agrega una figura y arrástrala a su lugar.' : 'Selecciona una mesa para comenzar un pedido.'}</p><div class="mesas-leyenda" aria-label="Cantidad de elementos por estado">${leyendaEstados()}</div>
      <button data-action="reservas">Reservaciones${(() => { const n = reservas.filter((r) => r.estado === 'activa' && r.fecha === window.MesasReservas?.fechaLocal()).length; return n ? ` <b class="mesas-estado-cantidad">${n}</b>` : ''; })()}${(() => { const n = reservas.filter(anticipoPorResolver).length; return n ? ` <b class="mesas-estado-cantidad mesas-alerta" title="Anticipos por devolver o dejar al negocio">${n} anticipo${n === 1 ? '' : 's'}</b>` : ''; })()}</button>
      ${estado.puedeEditar ? '<button data-action="meseros">Meseros/as</button>' : ''}</div>
      <div class="mesas-contenido"><aside class="mesas-biblioteca" ${editando ? '' : 'hidden'}><div class="mesas-panel-titulo"><h3>Elementos</h3><p>Un espacio a tu medida</p></div><input class="mesas-buscar-elemento" type="search" aria-label="Buscar elemento" placeholder="Buscar elemento…" value="${esc(busquedaElemento)}">${bibliotecaElementos()}<p class="mesas-panel-nota">Personaliza el nombre y activa las ventas solo donde las necesites.</p></aside>
      <div class="mesas-mapa-marco"><div class="mesas-mapa-etiqueta"><span>${editando ? 'Lienzo de edición' : 'Plano general'}</span><div class="mesas-zoom"><button type="button" data-zoom="menos" aria-label="Alejar plano">−</button><span id="mesas-zoom-valor">${Math.round(zoomPlano * 100)}%</span><button type="button" data-zoom="mas" aria-label="Acercar plano">+</button><button type="button" data-zoom="ajustar">Ajustar</button></div></div><div class="mesas-scroll"><div class="mesas-lienzo-tamano"><div class="mesas-lienzo">${plano.elementos.map(dibujarElemento).join('')}</div></div></div></div>
      <aside id="mesas-propiedades" ${editando ? '' : 'hidden'}></aside></div><div class="mesas-plano-pie"><span>${editando ? 'Los cambios se aplican al guardar el plano.' : 'Tus cuentas se guardan al confirmar el consumo.'}</span><span>TECNO CAJA · MESAS</span></div>`;
    host.querySelector('[data-action="cerrar"]').onclick = cerrar;
    host.querySelector('[data-action="editar"]')?.addEventListener('click', () => { editando = !editando; render(); });
    host.querySelector('[data-action="guardar"]')?.addEventListener('click', guardar);
    if (editando) {
      const barra = document.createElement('div'); barra.className = 'mesas-seleccion-barra';
      barra.innerHTML = '<button type="button" data-editor="deshacer" title="Deshacer (Ctrl + Z)" aria-keyshortcuts="Control+z">↶ Deshacer</button><button type="button" data-editor="rehacer" title="Rehacer (Ctrl + Y o Ctrl + Shift + Z)" aria-keyshortcuts="Control+y Control+Shift+z">↷ Rehacer</button><button type="button" data-editor="todos" title="Seleccionar todo (Ctrl + A)">Seleccionar todo</button><span id="mesas-seleccion-cantidad"></span><button type="button" data-editor="agrupar" title="Agrupar (Ctrl + G)">Agrupar</button><button type="button" data-editor="desagrupar" title="Desagrupar (Ctrl + Shift + G)">Desagrupar</button><button type="button" data-editor="limpiar" title="Quitar selección (Esc)">Quitar selección</button><small>Ctrl / Shift + clic para añadir · Arrastra en el fondo para seleccionar</small>';
      host.querySelector('.mesas-contenido').before(barra);
      barra.querySelectorAll('[data-editor]').forEach((b) => { b.onclick = () => accionSeleccion(b.dataset.editor); });
    }
    host.querySelectorAll('[data-zoom]').forEach((b) => { b.onclick = () => {
      const scroll = host.querySelector('.mesas-scroll');
      const anterior = zoomPlano;
      zoomPlano = Math.max(.25, Math.min(2, b.dataset.zoom === 'ajustar' ? Math.min(scroll.clientWidth / 1600, scroll.clientHeight / 1000) : zoomPlano + (b.dataset.zoom === 'mas' ? .1 : -.1)));
      aplicarZoom(); scroll.scrollLeft *= zoomPlano / anterior; scroll.scrollTop *= zoomPlano / anterior;
    }; });
    const buscador = host.querySelector('.mesas-buscar-elemento');
    buscador.oninput = () => { busquedaElemento = buscador.value; filtrarElementos(); };
    filtrarElementos(); aplicarZoom();
    host.querySelector('[data-action="meseros"]')?.addEventListener('click', abrirMeseros);
    host.querySelector('[data-action="reservas"]')?.addEventListener('click', () => abrirReservas());
    host.querySelectorAll('[data-figura]').forEach((button) => { button.onclick = () => agregar(button.dataset.figura); });
    host.querySelectorAll('[data-id]').forEach((button) => {
      button.onclick = () => {
        if (editando) return;
        seleccionado = button.dataset.id;
        // Mesa reservada (y libre): primero se ve la reserva.
        const reserva = !ocupada(seleccionado) && reservaVigente(seleccionado);
        if (reserva) { verReserva(reserva); return; }
        elegirMesa(seleccionado).catch(error);
      };
      button.onpointerdown = (event) => {
        if (!editando || event.button !== 0) return;
        event.stopPropagation();
        const e = plano.elementos.find((item) => item.id === button.dataset.id);
        const unidad = window.MesasSeleccion.expandir(plano.elementos, [e.id]);
        const multiple = event.ctrlKey || event.metaKey || event.shiftKey;
        if (multiple) {
          if (seleccion.has(e.id)) unidad.forEach((id) => seleccion.delete(id));
          else unidad.forEach((id) => seleccion.add(id));
        } else if (!seleccion.has(e.id)) seleccion = unidad;
        seleccionado = seleccion.has(e.id) ? e.id : [...seleccion][0] || null;
        propiedades();
        if (multiple || !seleccion.has(e.id)) return;
        const originales = elementosSeleccionados().map((item) => ({ ...item }));
        const nodos = new Map([...host.querySelectorAll('.mesas-figura')].filter((n) => seleccion.has(n.dataset.id)).map((n) => [n.dataset.id, n]));
        const x = event.clientX, y = event.clientY;
        arrastrandoPlano = true;
        button.setPointerCapture(event.pointerId);
        button.onpointermove = (move) => {
          if (Math.hypot(move.clientX - x, move.clientY - y) < 3) return;
          const movidos = window.MesasSeleccion.trasladar(originales, (move.clientX - x) / zoomPlano, (move.clientY - y) / zoomPlano);
          aplicarElementos(movidos);
          for (const item of movidos) {
            const nodo = nodos.get(item.id);
            nodo.style.left = `${item.x}px`; nodo.style.top = `${item.y}px`;
          }
          cambiado = true;
        };
        button.onpointerup = button.onpointercancel = () => { arrastrandoPlano = false; button.onpointermove = null; propiedades(); };
      };
    });
    if (editando) activarMarcoSeleccion();
    propiedades();
    desplazamiento.forEach(({ selector, x, y }) => { const nodo = host.querySelector(selector); if (nodo) { nodo.scrollLeft = x; nodo.scrollTop = y; } });
  }
  function registrarCambio() {
    if (!historial || guardandoPlano || arrastrandoPlano) return;
    historial.registrar(plano.elementos, [...seleccion], seleccionado);
    cambiado = JSON.stringify(plano.elementos) !== planoGuardado;
    const deshacer = host?.querySelector('[data-editor="deshacer"]'), rehacer = host?.querySelector('[data-editor="rehacer"]');
    if (deshacer) deshacer.disabled = !historial.puedeDeshacer;
    if (rehacer) rehacer.disabled = !historial.puedeRehacer;
  }
  function restaurarHistorial(accion) {
    if (!historial || guardandoPlano || arrastrandoPlano) return;
    const estadoAnterior = accion === 'deshacer' ? historial.deshacer() : historial.rehacer();
    if (!estadoAnterior) return;
    plano.elementos = estadoAnterior.elementos;
    seleccion = new Set(estadoAnterior.seleccion); seleccionado = estadoAnterior.principal;
    cambiado = JSON.stringify(plano.elementos) !== planoGuardado;
    render();
  }
  function elementosSeleccionados() { return plano.elementos.filter((e) => seleccion.has(e.id)); }
  function aplicarElementos(items) {
    const mapa = new Map(items.map((e) => [e.id, e]));
    plano.elementos = plano.elementos.map((e) => mapa.get(e.id) || e);
  }
  function accionSeleccion(accion) {
    if (!host || !editando) return;
    if (guardandoPlano || arrastrandoPlano) return;
    if (accion === 'deshacer' || accion === 'rehacer') { restaurarHistorial(accion); return; }
    if (accion === 'todos') seleccion = new Set(plano.elementos.map((e) => e.id));
    else if (accion === 'limpiar') seleccion.clear();
    else if (accion === 'agrupar' && seleccion.size > 1) {
      const grupoId = crypto.randomUUID();
      elementosSeleccionados().forEach((e) => { e.grupoId = grupoId; }); cambiado = true;
    } else if (accion === 'desagrupar') {
      elementosSeleccionados().forEach((e) => { e.grupoId = ''; }); cambiado = true;
    } else if (accion === 'ampliar' || accion === 'reducir') {
      aplicarElementos(window.MesasSeleccion.escalar(elementosSeleccionados(), accion === 'ampliar' ? 1.15 : 1 / 1.15)); cambiado = true;
    } else if (accion === 'eliminar') {
      if (cuentas.some((c) => seleccion.has(c.elemento_id) && conConsumo(c))) { error(new Error('No puedes eliminar elementos con cuentas abiertas.')); return; }
      plano.elementos = plano.elementos.filter((e) => !seleccion.has(e.id)); seleccion.clear(); cambiado = true;
    } else if (accion === 'duplicar' && seleccion.size) {
      const grupos = new Map(), codigos = new Set(plano.elementos.map((e) => e.codigo.toLocaleUpperCase('es')));
      const copias = elementosSeleccionados().map((e) => {
        let n = 1, codigo;
        do { codigo = `${e.codigo.slice(0, 85)} copia ${n++}`; } while (codigos.has(codigo.toLocaleUpperCase('es')));
        codigos.add(codigo.toLocaleUpperCase('es'));
        if (e.grupoId && !grupos.has(e.grupoId)) grupos.set(e.grupoId, crypto.randomUUID());
        return { ...e, id: crypto.randomUUID(), codigo, grupoId: e.grupoId ? grupos.get(e.grupoId) : '' };
      });
      const movidas = window.MesasSeleccion.trasladar(copias, 20, 20);
      plano.elementos.push(...movidas); seleccion = new Set(movidas.map((e) => e.id)); cambiado = true;
    }
    seleccionado = [...seleccion][0] || null; render();
  }
  function activarMarcoSeleccion() {
    const lienzo = host.querySelector('.mesas-lienzo');
    lienzo.onpointerdown = (event) => {
      if (event.button !== 0 || event.target.closest('.mesas-figura')) return;
      event.preventDefault();
      const rect = lienzo.getBoundingClientRect();
      const inicio = { x: (event.clientX - rect.left) / zoomPlano, y: (event.clientY - rect.top) / zoomPlano };
      const anteriores = new Set(event.ctrlKey || event.metaKey || event.shiftKey ? seleccion : []);
      const marco = document.createElement('div'); marco.className = 'mesas-marco-seleccion'; lienzo.append(marco);
      arrastrandoPlano = true;
      lienzo.setPointerCapture(event.pointerId);
      lienzo.onpointermove = (move) => {
        const x = (move.clientX - rect.left) / zoomPlano, y = (move.clientY - rect.top) / zoomPlano;
        const b = { x: Math.min(inicio.x, x), y: Math.min(inicio.y, y), ancho: Math.abs(x - inicio.x), alto: Math.abs(y - inicio.y) };
        Object.assign(marco.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.ancho}px`, height: `${b.alto}px` });
        const ids = plano.elementos.filter((e) => {
          const a = window.MesasSeleccion.limites([e]);
          return a.x < b.x + b.ancho && a.x + a.ancho > b.x && a.y < b.y + b.alto && a.y + a.alto > b.y;
        }).map((e) => e.id);
        seleccion = window.MesasSeleccion.expandir(plano.elementos, [...anteriores, ...ids]); seleccionado = [...seleccion][0] || null; propiedades();
      };
      lienzo.onpointerup = lienzo.onpointercancel = () => { arrastrandoPlano = false; lienzo.onpointermove = null; lienzo.onpointerup = null; lienzo.onpointercancel = null; marco.remove(); propiedades(); };
      seleccion = anteriores; seleccionado = [...seleccion][0] || null; propiedades();
    };
  }
  function atajoEditor(event) {
    if (!host || !editando || event.altKey || event.isComposing || event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
    const key = event.key.toLowerCase();
    let accion = (event.ctrlKey || event.metaKey) ? ({ a: 'todos', g: event.shiftKey ? 'desagrupar' : 'agrupar', d: 'duplicar', z: event.shiftKey ? 'rehacer' : 'deshacer', y: 'rehacer' })[key] : ({ escape: 'limpiar', delete: 'eliminar' })[key];
    const flecha = !event.ctrlKey && !event.metaKey && ({ arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] })[key];
    if (!accion && !(flecha && seleccion.size)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (guardandoPlano || arrastrandoPlano) return;
    if (flecha) {
      const paso = event.shiftKey ? 10 : 1;
      aplicarElementos(window.MesasSeleccion.trasladar(elementosSeleccionados(), flecha[0] * paso, flecha[1] * paso)); cambiado = true; render();
    } else if (!event.repeat) accionSeleccion(accion);
  }
  document.addEventListener('keydown', atajoEditor, true);
  function agregar(forma, base) {
    const modelo = window.MesasElementos.buscar(base?.tipo || forma);
    // Nombre legible por defecto («Mesa 3», «Barra 1», «Nevera exhibidora 1»): es
    // el que sale en la cuenta y el recibo. Se puede cambiar en Propiedades.
    const corto = String(modelo?.nombre || forma).split(/ · | \/ /)[0];
    const prefijo = /^mesa(?!Juntas|Trabajo)|^reservado$|^terraza$/.test(modelo?.tipo || '') ? 'Mesa' : (modelo?.vendible ? corto.split(' ')[0] : corto);
    let n = 1;
    while (plano.elementos.some((e) => e.codigo.toUpperCase() === `${prefijo} ${n}`.toUpperCase())) n++;
    const scroll = host.querySelector('.mesas-scroll');
    // Solo lo que vende, las zonas y los textos muestran su nombre al crearse; lo demás se puede activar.
    const conNombre = Boolean(modelo?.vendible) || ['zona', 'texto'].includes(modelo?.forma);
    const e = { ...(base || { forma: modelo?.forma || forma, tipo: modelo?.tipo || '', x: Math.min(1600 - (modelo?.ancho || 100), Math.round(scroll.scrollLeft / zoomPlano + 50)), y: Math.min(1000 - (modelo?.alto || 80), Math.round(scroll.scrollTop / zoomPlano + 50)), ancho: modelo?.ancho || 100, alto: modelo?.alto || 80, vendible: modelo?.vendible || false, capacidad: modelo?.capacidad || 0, color: modelo?.color || '#b77b47', etiqueta: conNombre, zona: '' }), id: crypto.randomUUID(), codigo: `${prefijo} ${n}` };
    // Una copia individual no queda ligada al grupo del original.
    e.grupoId = '';
    // Una figura nueva va a un hueco libre de la parte visible (antes caían todas encima).
    if (!base && e.forma !== 'zona') Object.assign(e, lugarLibre(e.ancho, e.alto, e.x, e.y, scroll));
    plano.elementos.push(e); seleccionado = e.id; seleccion = new Set([e.id]); cambiado = true; render();
  }
  function lugarLibre(ancho, alto, x0, y0, scroll) {
    const choca = (x, y) => plano.elementos.some((o) => o.forma !== 'zona'
      && x < o.x + o.ancho + 8 && x + ancho + 8 > o.x && y < o.y + o.alto + 8 && y + alto + 8 > o.y);
    const finX = Math.min(1600 - ancho, x0 + Math.max(0, scroll.clientWidth / zoomPlano - ancho - 60));
    const finY = Math.min(1000 - alto, y0 + Math.max(0, scroll.clientHeight / zoomPlano - alto - 60));
    for (let y = y0; y <= finY; y += 20) for (let x = x0; x <= finX; x += 20) if (!choca(x, y)) return { x, y };
    return { x: x0, y: y0 };
  }
  // Grupos plegables de la biblioteca; se recuerda cu\u00e1les cerr\u00f3 el usuario
  // mientras el plano est\u00e1 abierto (el editor se vuelve a pintar seguido).
  const gruposCerrados = new Set();
  let miniaturas = '';
  function bibliotecaElementos() {
    if (!miniaturas) {
      const catalogo = window.MesasElementos.catalogo;
      miniaturas = [...new Set(catalogo.map((e) => e.grupo))].map((grupo) => {
        const items = catalogo.filter((e) => e.grupo === grupo);
        return `<details class="mesas-elementos-grupo" data-grupo="${esc(grupo)}" open><summary>${esc(grupo)}<span>${items.length}</span></summary><div class="mesas-biblioteca-grid">${items.map((e) => `<button type="button" data-figura="${e.tipo}" data-palabras="${esc(`${e.nombre} ${e.grupo} ${e.palabras || ''}`)}" title="Agregar ${esc(e.nombre)}">${window.MesasElementos.dibujo(e.tipo, '', { miniatura: true })}<span>${esc(e.nombre)}</span></button>`).join('')}</div></details>`;
      }).join('');
    }
    return miniaturas;
  }
  function filtrarElementos() {
    const normalizar = (s) => s.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const termino = normalizar(busquedaElemento.trim());
    host.querySelectorAll('.mesas-elementos-grupo').forEach((grupo) => {
      grupo.querySelectorAll('[data-figura]').forEach((b) => { b.hidden = Boolean(termino) && !normalizar(b.dataset.palabras || b.textContent).includes(termino); });
      grupo.hidden = ![...grupo.querySelectorAll('[data-figura]')].some((b) => !b.hidden);
      // Buscando se abren los grupos con resultados; sin b\u00fasqueda, como los dej\u00f3 el usuario.
      grupo.open = termino ? !grupo.hidden : !gruposCerrados.has(grupo.dataset.grupo);
      grupo.ontoggle = () => { if (!termino) { if (grupo.open) gruposCerrados.delete(grupo.dataset.grupo); else gruposCerrados.add(grupo.dataset.grupo); } };
    });
  }
  function aplicarZoom() {
    const lienzo = host.querySelector('.mesas-lienzo');
    lienzo.style.setProperty('--mesas-indicador-escala', String(1 / zoomPlano));
    lienzo.style.transform = `scale(${zoomPlano})`; lienzo.style.transformOrigin = 'top left';
    const tamano = host.querySelector('.mesas-lienzo-tamano');
    tamano.style.width = `${1600 * zoomPlano}px`; tamano.style.height = `${1000 * zoomPlano}px`;
    host.querySelector('#mesas-zoom-valor').textContent = `${Math.round(zoomPlano * 100)}%`;
  }
  function dibujarElemento(e) {
    const enUso = ocupada(e.id);
    const estadoVisual = estadoMesa(e);
    const reserva = e.vendible ? (reservaVigente(e.id) || reservaProxima(e.id)) : null;
    // Hora de la reserva encima de la mesa: llena (ámbar) si ya está reservada, en borde si es más tarde hoy.
    const avisoReserva = reserva ? `<span class="mesas-reserva-chip${reservaVigente(e.id) ? ' is-vigente' : ''}${e.y < 28 ? ' is-abajo' : ''}" title="${esc(`Reserva de ${reserva.cliente} · ${reserva.personas} persona(s) · ${horaBonita(reserva.hora)}`)}">${esc(horaBonita(reserva.hora))}</span>` : '';
    const tipo = e.tipo || ({ mesa: 'mesa4', mueble: 'mostrador', decoracion: 'planta' })[e.forma] || e.forma;
    const angulo = Number.isFinite(e.rotacion) ? ((e.rotacion % 360) + 360) % 360 : 0;
    const factorTexto = Number.isFinite(e.textoEscala) ? Math.max(.75, Math.min(3, e.textoEscala)) : 1;
    return `<button class="mesas-figura mesas-elemento-visual ${e.id === seleccionado ? 'seleccionada' : ''} ${({ ocupada: 'is-occupied', reservada: 'is-reserved', disponible: 'is-available', decorativa: 'is-decoration' })[estadoVisual]}" data-id="${esc(e.id)}" data-forma="${esc(e.forma)}" aria-label="${esc(e.codigo)} · ${({ ocupada: 'Ocupada', reservada: 'Reservada', disponible: 'Disponible', decorativa: 'Sin venta' })[estadoVisual]}${reserva ? ` · reserva ${esc(horaBonita(reserva.hora))}` : ''}" title="${esc(e.codigo)}${e.capacidad ? ` · Capacidad: ${e.capacidad}` : ''}" style="left:${e.x}px;top:${e.y}px;width:${e.ancho}px;height:${e.alto}px;--mesas-giro:${angulo}deg;--mesas-giro-inverso:${-angulo}deg;--mesas-texto-factor:${factorTexto}">${window.MesasElementos.dibujo(tipo, e.color)}${e.etiqueta !== false ? `<span class="mesas-elemento-nombre">${esc(e.codigo)}</span>` : ''}${avisoReserva}<i class="mesas-elemento-estado" aria-hidden="true"></i></button>`;
  }
  function nombreFigura(forma) {
    return ({ cuadro: 'Cuadrado', rectangulo: 'Rectángulo', circulo: 'Círculo', mesa: 'Mesa', mueble: 'Mueble', pared: 'Pared', puerta: 'Puerta', zona: 'Zona', texto: 'Texto', decoracion: 'Decoración' })[forma] || forma;
  }
  function iconoFigura(forma) {
    const dibujos = {
      cuadro: '<rect x="5" y="5" width="18" height="18" rx="3"/>',
      rectangulo: '<rect x="3" y="7" width="22" height="14" rx="3"/>',
      circulo: '<circle cx="14" cy="14" r="10"/>',
      mesa: '<rect x="7" y="7" width="14" height="14" rx="3"/><path d="M10 3h8M10 25h8M3 10v8M25 10v8"/>',
      mueble: '<rect x="3" y="10" width="22" height="12" rx="3"/><path d="M7 10V6h14v4M7 22v3M21 22v3"/>',
      pared: '<path d="M3 8h22v12H3zM3 14h22M10 8v6M19 8v6M15 14v6"/>',
      puerta: '<path d="M5 25V3h18v22M9 25V7h10v18M15 15h1"/>',
      zona: '<rect x="4" y="4" width="20" height="20" rx="3" stroke-dasharray="4 3"/>',
      texto: '<path d="M5 7V4h18v3M14 4v20M10 24h8"/>',
      decoracion: '<path d="m14 3 3 7 8 4-8 3-3 8-4-8-7-3 7-4z"/>',
    };
    return `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${dibujos[forma] || dibujos.cuadro}</svg>`;
  }
  function propiedades() {
    registrarCambio();
    const panel = host.querySelector('#mesas-propiedades');
    const e = plano.elementos.find((item) => item.id === seleccionado);
    const idsExistentes = new Set(plano.elementos.map((item) => item.id));
    seleccion = new Set([...seleccion].filter((id) => idsExistentes.has(id)));
    host.querySelectorAll('.mesas-figura').forEach((nodo) => nodo.classList.toggle('seleccionada', seleccion.has(nodo.dataset.id)));
    const cantidad = host.querySelector('#mesas-seleccion-cantidad');
    if (cantidad) {
      cantidad.textContent = `${seleccion.size} seleccionados`;
      host.querySelector('[data-editor="agrupar"]').disabled = seleccion.size < 2;
      host.querySelector('[data-editor="desagrupar"]').disabled = !elementosSeleccionados().some((a) => a.grupoId);
    }
    if (seleccion.size > 1) {
      panel.innerHTML = `<div class="mesas-panel-titulo"><h3>${seleccion.size} elementos seleccionados</h3><p>Se mueven juntos al arrastrar.</p></div><div class="mesas-acciones-multiples"><button data-multiple="agrupar">Agrupar · Ctrl + G</button><button data-multiple="desagrupar">Desagrupar · Ctrl + Shift + G</button><button data-multiple="ampliar">Ampliar conjunto +</button><button data-multiple="reducir">Reducir conjunto −</button><button data-multiple="duplicar">Duplicar · Ctrl + D</button><button data-multiple="eliminar">Eliminar selección</button></div><p class="mesas-panel-nota">Flechas: mover 1 unidad. Shift + flechas: 10 unidades. Agrupar conserva cada mesa y su cuenta de forma independiente.</p>`;
      panel.querySelectorAll('[data-multiple]').forEach((b) => { b.onclick = () => accionSeleccion(b.dataset.multiple); });
      return;
    }
    if (!e) { panel.innerHTML = '<div class="mesas-panel-titulo"><h3>Propiedades</h3><p>Ajusta cada elemento</p></div><div class="mesas-propiedades-vacio"><span>↖</span><strong>Selecciona una figura</strong><p>Podrás cambiar su nombre, tamaño y posición aquí.</p></div>'; return; }
    const etiquetas = { codigo: 'Nombre / código', zona: 'Zona', x: 'Posición X', y: 'Posición Y', ancho: 'Ancho', alto: 'Alto' };
    panel.innerHTML = `<div class="mesas-panel-titulo"><h3>Propiedades</h3><p>${esc(window.MesasElementos.buscar(e.tipo)?.nombre || nombreFigura(e.forma))}</p></div><div class="mesas-propiedades-grid"><label class="mesas-campo-ancho">Tipo de elemento<select id="mesas-tipo-elemento"><option value="">Figura actual</option>${[...new Set(window.MesasElementos.catalogo.map((m) => m.grupo))].map((grupo) => `<optgroup label="${esc(grupo)}">${window.MesasElementos.catalogo.filter((m) => m.grupo === grupo).map((m) => `<option value="${m.tipo}" ${e.tipo === m.tipo ? 'selected' : ''}>${esc(m.nombre)}</option>`).join('')}</optgroup>`).join('')}</select></label>${['codigo', 'zona', 'x', 'y', 'ancho', 'alto'].map((key) => `<label class="${['codigo', 'zona'].includes(key) ? 'mesas-campo-ancho' : ''}">${etiquetas[key]}<input data-key="${key}" type="${['codigo', 'zona'].includes(key) ? 'text' : 'number'}" value="${esc(e[key])}"></label>`).join('')}<label>Capacidad<input data-key="capacidad" type="number" min="0" step="1" value="${e.capacidad || 0}"></label><label>Color<input id="mesas-color-elemento" type="color" value="${esc(e.color || '#b77b47')}"></label></div><label class="mesas-ventas-check"><input type="checkbox" id="mesas-etiqueta" ${e.etiqueta !== false ? 'checked' : ''}><span>Mostrar nombre</span></label><label class="mesas-ventas-check"><input type="checkbox" id="mesas-vendible" ${e.vendible ? 'checked' : ''}><span>Permitir ventas</span></label><div class="mesas-propiedades-acciones"><button id="mesas-duplicar">Duplicar</button><button id="mesas-eliminar">Eliminar</button></div>`;
    const giro = document.createElement('div');
    giro.className = 'mesas-control-giro';
    giro.innerHTML = `<label for="mesas-angulo">Rotación</label><div><button type="button" data-giro="-90" title="Girar 90° a la izquierda" aria-label="Girar 90 grados a la izquierda">↶ 90°</button><input id="mesas-angulo" type="number" step="15" value="${e.rotacion || 0}" aria-label="Ángulo de rotación en grados"><button type="button" data-giro="90" title="Girar 90° a la derecha" aria-label="Girar 90 grados a la derecha">90° ↷</button></div><button type="button" class="mesas-giro-restablecer">Restablecer a 0°</button>`;
    panel.querySelector('.mesas-propiedades-grid').after(giro);
    const tamano = document.createElement('div'); tamano.className = 'mesas-tamano-elemento';
    tamano.innerHTML = `<h4>Tamaño de este elemento</h4><div><span>Texto</span><button type="button" data-texto="menos" aria-label="Reducir texto del elemento">A−</button><output>${Math.round((e.textoEscala || 1) * 100)}%</output><button type="button" data-texto="mas" aria-label="Aumentar texto del elemento">A+</button></div><div><span>Icono completo</span><button type="button" data-tamano="menos" aria-label="Reducir elemento completo">−</button><output>${Math.round(e.ancho)} × ${Math.round(e.alto)}</output><button type="button" data-tamano="mas" aria-label="Ampliar elemento completo">+</button></div><p>Solo cambia el elemento seleccionado.</p>`;
    panel.querySelector('.mesas-panel-titulo').after(tamano);
    tamano.querySelectorAll('[data-texto]').forEach((b) => { b.onclick = () => {
      e.textoEscala = Math.max(.75, Math.min(3, (e.textoEscala || 1) + (b.dataset.texto === 'mas' ? .25 : -.25)));
      cambiado = true; render();
    }; });
    tamano.querySelectorAll('[data-tamano]').forEach((b) => { b.onclick = () => {
      const texto = e.textoEscala || 1;
      let factor = b.dataset.tamano === 'mas' ? 1.15 : 1 / 1.15;
      factor = Math.max(Math.max(16 / e.ancho, 16 / e.alto, .75 / texto), Math.min(factor, 1600 / e.ancho, 1000 / e.alto, 3 / texto));
      const centroX = e.x + e.ancho / 2, centroY = e.y + e.alto / 2;
      e.ancho = Math.round(e.ancho * factor * 100) / 100;
      e.alto = Math.round(e.alto * factor * 100) / 100;
      e.textoEscala = Math.max(.75, Math.min(3, texto * factor));
      e.x = Math.round(Math.max(0, Math.min(1600 - e.ancho, centroX - e.ancho / 2)) * 100) / 100;
      e.y = Math.round(Math.max(0, Math.min(1000 - e.alto, centroY - e.alto / 2)) * 100) / 100;
      cambiado = true; render();
    }; });
    if (e.forma === 'zona') {
      const colores = document.createElement('div'); colores.className = 'mesas-colores-zona';
      colores.innerHTML = [['Beige', '#d5bea1'], ['Azul suave', '#a8bed6'], ['Verde suave', '#acd0ba']].map(([nombre, color]) => `<button type="button" data-color-zona="${color}" title="Aplicar ${nombre}"><i style="background:${color}" aria-hidden="true"></i>${nombre}</button>`).join('');
      panel.querySelector('.mesas-propiedades-grid').after(colores);
      colores.querySelectorAll('[data-color-zona]').forEach((b) => { b.onclick = () => { e.color = b.dataset.colorZona; cambiado = true; render(); }; });
    }
    const aplicarGiro = (angulo) => { if (!Number.isFinite(angulo)) return; e.rotacion = ((angulo % 360) + 360) % 360; cambiado = true; render(); };
    giro.querySelectorAll('[data-giro]').forEach((b) => { b.onclick = () => aplicarGiro((e.rotacion || 0) + Number(b.dataset.giro)); });
    giro.querySelector('#mesas-angulo').onchange = (event) => aplicarGiro(Number(event.target.value));
    giro.querySelector('.mesas-giro-restablecer').onclick = () => aplicarGiro(0);
    panel.querySelectorAll('[data-key]').forEach((input) => { input.onchange = () => {
      const key = input.dataset.key;
      const value = ['codigo', 'zona'].includes(key) ? input.value : Number(input.value);
      if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || (['ancho', 'alto'].includes(key) && value === 0))) return;
      if (key === 'capacidad' && !Number.isSafeInteger(value)) return;
      e[key] = value; cambiado = true; render();
    }; });
    panel.querySelector('#mesas-vendible').onchange = (event) => { e.vendible = event.target.checked; cambiado = true; render(); };
    panel.querySelector('#mesas-etiqueta').onchange = (event) => { e.etiqueta = event.target.checked; cambiado = true; render(); };
    panel.querySelector('#mesas-color-elemento').onchange = (event) => { e.color = event.target.value; cambiado = true; render(); };
    panel.querySelector('#mesas-tipo-elemento').onchange = (event) => {
      const modelo = window.MesasElementos.buscar(event.target.value);
      if (!modelo) return;
      // Si conservaba el color propio de su figura, toma el de la nueva (una nevera no queda color madera).
      const anterior = window.MesasElementos.buscar(e.tipo);
      if (!e.color || e.color === anterior?.color) e.color = modelo.color;
      e.tipo = modelo.tipo; e.forma = modelo.forma; cambiado = true; render();
    };
    panel.querySelector('#mesas-duplicar').onclick = () => agregar(e.forma, { ...e, x: e.x + 20, y: e.y + 20 });
    panel.querySelector('#mesas-eliminar').onclick = () => { plano.elementos = plano.elementos.filter((item) => item.id !== e.id); seleccionado = null; cambiado = true; render(); };
  }
  async function guardar(event) {
    if (guardandoPlano || arrastrandoPlano) return;
    guardandoPlano = true;
    event.target.disabled = true;
    host.inert = true;
    try {
      plano = await api('plano', 'PUT', plano); planoGuardado = JSON.stringify(plano.elementos);
      historial.sincronizar(plano.elementos, [...seleccion], seleccionado); cambiado = false;
      // Guardado: se sale del editor al plano de las mesas, listo para vender.
      editando = false; seleccionado = null; seleccion.clear();
      cuentas = await api('cuentas').catch(() => cuentas);
      aviso('Plano guardado. Ya puedes elegir una mesa.');
    } catch (e) { error(e); }
    finally { guardandoPlano = false; if (host) { host.inert = false; render(); } }
  }
  async function elegirMesa(id, { nombreCuenta = '', reserva = null } = {}) {
    const elemento = plano.elementos.find((e) => e.id === id);
    if (!elemento?.vendible) return;
    cuentas = await api('cuentas');
    const opciones = cuentas.filter((c) => c.elemento_id === id);
    // El cliente de una reserva tiene su propia cuenta (su anticipo es solo suyo).
    const deLaReserva = reserva ? opciones.find((c) => c.draft?.reservaId === reserva.id) : null;
    let cuenta;
    if (deLaReserva) cuenta = deLaReserva;
    else if (!reserva && opciones.length === 1) cuenta = opciones[0];
    else if (!reserva && opciones.length > 1) {
      cuenta = await elegirCuenta(opciones);
      if (!cuenta) return;
    } else {
      // La cuenta se crea en el servidor al guardar el primer consumo: entrar a
      // la mesa y volver sin pedir nada no la deja ocupada.
      cuenta = { id: crypto.randomUUID(), elemento_id: id, nombre: String(reserva?.cliente || nombreCuenta || 'General').slice(0, 100), version: 0, nueva: true,
        draft: { items: [], tableLabel: elemento.codigo, orderType: 'mesa', ...(reserva ? { reservaId: reserva.id } : {}) } };
    }
    // Anticipo de la reserva de esta cuenta, al día (si es consumible se descuenta al cobrar).
    cuenta.anticipo = null;
    if (cuenta.draft?.reservaId) {
      const actual = await api(`reservas/${encodeURIComponent(cuenta.draft.reservaId)}`).catch(() => null);
      cuenta.anticipo = actual?.anticipo || null;
    }
    carritoAnterior = buildSuspendedSaleDraft('Carrito anterior');
    activa = cuenta;
    applyRecoveredSuspendedSale(cuenta.draft);
    // La cuenta de una mesa es consumo en el local: pedido «Mesa». Sin esto
    // entraba como mostrador y la propina legal nunca se aplicaba.
    if (typeof setSaleOrderType === 'function') setSaleOrderType('mesa'); else DB.saleOrderType = 'mesa';
    DB.saleTableLabel = cuenta.draft.tableLabel || elemento.codigo || '';
    host.remove(); host = null;
    document.body.classList.add('mesas-consumo-activo');
    abrirVentanaConsumo();
    renderSalesCatalog(true);
    barraCuenta();
  }
  function barraCuenta() {
    document.getElementById('mesas-cuenta-barra')?.remove();
    if (!activa) return;
    const barra = document.createElement('div'); barra.id = 'mesas-cuenta-barra';
    // Un mesero quitado ya no se puede asignar (el servidor lo rechaza al guardar).
    if (activa.draft.meseroId && !meserosActivos().some((m) => m.id === activa.draft.meseroId)) activa.draft.meseroId = '';
    const a = activa.anticipo;
    const anticipoChip = a && a.consumible && a.estado === 'recibido' && !a.saleId
      ? `<span class="mesas-cuenta-anticipo" title="Se descuenta de lo que paga el cliente al cobrar">Anticipo ${esc(R().fmtDinero(a.monto))} · se descuenta</span>` : '';
    barra.innerHTML = `<strong>${esc(activa.draft.tableLabel)} · ${esc(activa.nombre)}</strong>${anticipoChip}
      <select id="mesas-cuenta-mesero"><option value="">Sin mesero</option>${meserosActivos().map((m) => `<option value="${esc(m.id)}" ${activa.draft.meseroId === m.id ? 'selected' : ''}>${esc(m.nombre)}</option>`).join('')}</select>
      <div class="mesas-acciones-centrales">
        <button id="mesas-guardar-consumo" type="button" aria-keyshortcuts="g" title="Guardar consumo abierto (G)">Guardar consumo abierto <kbd>G</kbd></button>
        <button id="mesas-precuenta" type="button" aria-keyshortcuts="p" title="Precuenta (P)">Precuenta <kbd>P</kbd></button>
        <button id="mesas-cobrar" type="button" aria-keyshortcuts="c" title="Abrir cobro (C)">Cobrar <kbd>C</kbd></button>
      </div><button id="mesas-volver">Volver al plano</button>`;
    ventanaConsumo.querySelector('.mesas-consumo-pie').append(barra);
    barra.querySelector('#mesas-cuenta-mesero').onchange = (e) => { activa.draft.meseroId = e.target.value; };
    barra.querySelector('#mesas-guardar-consumo').onclick = async () => { try { await guardarCuenta(); await volver(); } catch (e) { error(e); } };
    barra.querySelector('#mesas-cobrar').onclick = () => openBillingModal();
    barra.querySelector('#mesas-volver').onclick = () => { if (confirm('¿Volver al plano? Los cambios sin guardar se descartarán.')) volver().catch(error); };
    barra.querySelector('#mesas-precuenta').onclick = async () => {
      try {
        if (!confirm('¿Guardar el consumo actual y preparar la precuenta sin cobrar?')) return;
        await guardarCuenta();
        const totals = calculateCurrentSaleTotals();
        const mesero = meseros.find((m) => m.id === activa.draft.meseroId)?.nombre || 'Sin asignar';
        const anticipoReserva = typeof anticipoReservaCobro === 'function' ? anticipoReservaCobro(totals.total) : 0;
        const venta = { ...totals, items: cloneSaleData(DB.saleItems, []), ...(anticipoReserva > 0 ? { anticipoReserva } : {}),
          id: activa.draft.tableLabel, fecha: new Date().toISOString(), tipoComprobante: 'ticket',
          cliente: getSelectedSaleClient()?.nombre || 'Consumidor final',
          mesa: activa.draft.tableLabel, mesero, isPrecuenta: true, recibido: 0, cambio: 0,
          descuento: totals.discount || 0,
          receiptDocumentTitle: 'PRECUENTA / ESTADO DE CUENTA',
          receiptDocumentNumber: 'PENDIENTE DE PAGO', receiptPrimaryLabel: 'Mesa',
          receiptMethodRowLabel: 'Estado', receiptMethodLabelOverride: 'Pendiente de pago',
          receiptFooterMessageOverride: 'Documento informativo. No es factura fiscal ni comprobante de pago.' };
        showReceipt(venta, { receiptPreview: true, title: 'Precuenta · Pendiente de pago' });
      } catch (e) { error(e); }
    };
  }
  async function guardarCuenta() {
    if (!activa) return;
    if (guardando) throw new Error('Espera a que termine el guardado.');
    guardando = true;
    try {
      const draft = { ...buildSuspendedSaleDraft(activa.nombre), meseroId: activa.draft.meseroId || '',
        ...(activa.draft.reservaId ? { reservaId: activa.draft.reservaId } : {}) };
      if (activa.nueva) {
        // Cuenta todavía no creada y sin productos: no hay nada que guardar.
        if (!conConsumo({ draft })) { activa.draft = draft; return; }
        await api('cuentas', 'POST', { id: activa.id, elementoId: activa.elemento_id, nombre: activa.nombre });
        activa.nueva = false;
      }
      const result = await api(`cuentas/${encodeURIComponent(activa.id)}`, 'PUT', { version: activa.version, draft });
      activa.version = result.version; activa.draft = draft;
    } finally { guardando = false; }
  }
  async function volver() {
    const salida = activa;
    activa = null;
    document.body.classList.remove('mesas-consumo-activo');
    document.getElementById('mesas-cuenta-barra')?.remove();
    cerrarVentanaConsumo();
    if (carritoAnterior) applyRecoveredSuspendedSale(carritoAnterior);
    carritoAnterior = null;
    // Se salió sin consumo guardado: la cuenta vacía se borra y la mesa queda
    // disponible (el servidor no borra una cuenta con productos ni una que
    // otra caja haya cambiado).
    if (salida && !salida.nueva && !salida.confirmada && !conConsumo(salida)) {
      await api(`cuentas/${encodeURIComponent(salida.id)}?version=${encodeURIComponent(salida.version)}`, 'DELETE').catch(() => {});
    }
    await esperarComprobante();
    await abrir();
    // La cuenta fue menor que el anticipo consumible: lo que sobró se resuelve.
    if (salida?.sobranteReservaId) {
      const reserva = await api(`reservas/${encodeURIComponent(salida.sobranteReservaId)}`).catch(() => null);
      if (reserva && R().saldoAnticipo(reserva.anticipo) > 0) await resolverAnticipo(reserva, 'La cuenta fue menor que el anticipo.').catch(error);
    }
  }
  // El plano va por encima de toda la app: si se abría con el comprobante de la
  // venta a la vista, lo tapaba. Se espera a que el cajero lo cierre.
  function esperarComprobante() {
    const recibo = document.getElementById('receipt-overlay');
    const abierto = () => Boolean(recibo && !recibo.classList.contains('hidden'));
    if (!abierto()) return Promise.resolve();
    return new Promise((resolve) => {
      const vigia = new MutationObserver(() => { if (!abierto()) { vigia.disconnect(); resolve(); } });
      vigia.observe(recibo, { attributes: true, attributeFilter: ['class'] });
    });
  }
  function ventaConfirmada(venta = null) {
    if (!activa) return;
    activa.confirmada = true;
    const usado = Number(venta?.anticipoReserva || 0);
    if (activa.anticipo && usado > 0 && R().restarAnticipo(activa.anticipo.monto, usado) > 0) activa.sobranteReservaId = activa.draft.reservaId;
  }
    window.Mesas = { cargar, activar, abrir, prepararVenta: guardarCuenta, renderCategorias,
    cancelarConsumo: () => {
      if (!activa || activa.confirmada) return false;
      if (confirm('¿Volver al plano y descartar solo los cambios sin guardar?')) volver().catch(error);
      return true;
    },
    cuentaActiva: () => activa ? { id: activa.id, version: activa.version } : null, ventaConfirmada,
    // Anticipo de la reserva de la cuenta que se cobra (ventas.js lo descuenta si es consumible).
    anticipoCuenta: () => (activa?.anticipo && activa.draft?.reservaId ? { ...activa.anticipo, reservaId: activa.draft.reservaId } : null),
    volverTrasVenta: () => { if (activa?.confirmada) volver().catch(error); } };
})();

// Cancelar factura / emitir nota de crédito (mejora 4). Las acciones que se
// ofrecen salen de GET /api/ventas/:factura/ajustes según el documento y su
// estado fiscal real; los importes los calcula el servidor.
(function () {
  'use strict';
  const state = { data: null, factura: '', requestId: null };
  const esc = (v) => (typeof escapeHtml === 'function' ? escapeHtml(String(v ?? '')) : String(v ?? ''));
  const money = (v) => (typeof fmt === 'function' ? fmt(Number(v || 0)) : `RD$ ${Number(v || 0).toFixed(2)}`);
  const toast = (m, t = 'info') => (typeof showToast === 'function' ? showToast(m, t) : console.log(m));
  const uuid = () => (window.crypto?.randomUUID?.() || `nc-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);
  const estructura = () => (typeof getBusinessStructurePayload === 'function' ? getBusinessStructurePayload() : {});
  const actor = () => (typeof getActorPayload === 'function' ? getActorPayload() : {});
  const ESTADO = { sin_comprobante: 'Ticket interno (sin comprobante fiscal)', emitido: 'Comprobante serie B emitido', aceptado: 'e-CF aceptado por la DGII',
    aceptado_condicional: 'e-CF aceptado condicional', rechazado: 'e-CF rechazado por la DGII', pendiente_dgii: 'e-CF pendiente de respuesta de la DGII',
    sin_ecf: 'Venta electrónica sin e-CF generado', cancelada: 'Factura cancelada', pendiente_cobro: 'Factura pendiente de cobro' };
  const MODOS = { interna: 'Cancelación interna documentada', anulacion_608: 'Anular el NCF (se reporta en el formato 608)', nota_credito_b04: 'Nota de crédito B04 por el total',
    nota_credito_e34: 'Nota de crédito electrónica E34 (anula el e-CF)', interna_rechazado: 'Cancelar la venta (e-CF rechazado, sin nota de crédito)' };
  const TIPOS_NOTA = { nota_credito_interna: 'Nota de crédito interna', nota_credito_b04: 'Nota de crédito B04', nota_credito_e34: 'Nota de crédito E34',
    anulacion_608: 'Anulación NCF', parcial: 'Devolución parcial', total: 'Devolución total' };

  function modal(titulo, cuerpo, pie) {
    document.getElementById('modal-title').textContent = titulo;
    document.getElementById('modal-body').innerHTML = `<div class="nc-modal">${cuerpo}</div>`;
    document.getElementById('modal-footer').innerHTML = pie;
    document.getElementById('modal-overlay').classList.remove('hidden');
  }

  async function abrir(factura = '') {
    if (factura) return cargar(factura);
    modal('Cancelar factura o emitir nota de crédito', `
      <p class="cs-aviso">Busca la factura por número, NCF/e-NCF o cliente. Las acciones dependen del tipo de documento y de su estado ante la DGII.</p>
      <div class="nc-buscar"><input type="search" id="nc-q" class="form-input" placeholder="FAC-00001234, B0200000012, E320000000005, cliente…" onkeydown="if(event.key==='Enter')AjustesVenta.buscar()">
      <button class="btn-primary" onclick="AjustesVenta.buscar()">Buscar</button></div><div id="nc-resultados"></div>`,
    '<button class="btn-secondary" onclick="closeAllModals()">Cerrar</button>');
    setTimeout(() => document.getElementById('nc-q')?.focus(), 60);
  }

  async function buscar() {
    const q = String(document.getElementById('nc-q')?.value || '').trim();
    const box = document.getElementById('nc-resultados');
    if (q.length < 2) { toast('Escribe al menos 2 caracteres.', 'warning'); return; }
    try {
      const r = await api.searchForReturn(q);
      const lista = r.results || r.sales || r || [];
      box.innerHTML = lista.length ? `<div class="nc-lista">${lista.map((s) => `<button type="button" class="nc-item" onclick="AjustesVenta.cargar('${esc(s.invoiceNumber || s.invoice_number)}')">
        <strong>${esc(s.invoiceNumber || s.invoice_number)}</strong> <span>${esc(s.ncf || '')}</span> <span>${esc(s.clientName || s.client_name || '')}</span> <span>${money(s.total)}</span></button>`).join('')}</div>`
        : '<p class="text-muted">Sin resultados.</p>';
    } catch (e) { box.innerHTML = `<p class="inline-form-alert">${esc(e.message)}</p>`; }
  }

  async function cargar(factura) {
    try {
      state.factura = factura;
      state.data = await api.request(`/api/ventas/${encodeURIComponent(factura)}/ajustes`);
      state.requestId = uuid();
      pintar();
    } catch (e) { toast(e.message, 'error'); }
  }

  function pintar() {
    const d = state.data, v = d.venta, cl = d.clasificacion;
    const cobro = Object.entries(v.cobro).filter(([, m]) => m > 0).map(([k, m]) => `${k} ${money(m)}`).join(' · ') || 'sin cobro';
    const aviso30 = cl.masDe30Dias && cl.clase !== 'ticket' ? '<p class="tc-notice tc-notice--warning">La factura tiene más de 30 días: la nota de crédito rebaja el monto, pero no el ITBIS.</p>' : '';
    const puedeCancelar = cl.cancelar.permitido && d.permisos.cancelar;
    const puedeNota = cl.notaCredito.permitido && d.permisos.notaCredito;
    modal(`Factura ${v.factura}`, `
      <div class="nc-cabecera">
        <div><span>Documento</span><strong>${esc(v.ncf || v.factura)}</strong></div>
        <div><span>Estado fiscal</span><strong>${esc(ESTADO[cl.estadoFiscal] || cl.estadoFiscal)}</strong></div>
        <div><span>Cliente</span><strong>${esc(v.cliente)}</strong></div>
        <div><span>Fecha</span><strong>${esc(v.fecha)}</strong></div>
        <div><span>Total</span><strong>${money(v.total)}</strong></div>
        <div><span>Ya ajustado</span><strong>${money(v.yaAjustado)}</strong></div>
        <div><span>Cobrado con</span><strong>${esc(cobro)}</strong></div>
        ${v.propinaLegal ? `<div><span>Propina legal</span><strong>${money(v.propinaLegal)}</strong></div>` : ''}
      </div>${aviso30}
      <div class="nc-acciones">
        <section class="nc-accion ${puedeCancelar ? '' : 'nc-off'}">
          <h4>Cancelar factura</h4><p>${esc(cl.cancelar.razon)}${!d.permisos.cancelar ? ' No tienes permiso para cancelar.' : ''}</p>
          ${puedeCancelar ? `
            ${cl.cancelar.modos.length > 1 ? cl.cancelar.modos.map((m, i) => `<label class="nc-radio"><input type="radio" name="nc-modo" value="${m}" ${i === 0 ? 'checked' : ''}> ${esc(MODOS[m])}</label>`).join('') : `<p><strong>${esc(MODOS[cl.cancelar.modos[0]])}</strong></p>`}
            ${v.cobro.efectivo > 0 ? `<label class="nc-check"><input type="checkbox" id="nc-c-efectivo" checked> Devolver efectivo de la caja (hasta ${money(v.cobro.efectivo)})</label>` : ''}
            <label class="nc-check"><input type="checkbox" id="nc-c-inventario" checked> Reintegrar los productos al inventario</label>
            <label class="cs-campo">Motivo *<textarea id="nc-c-motivo" class="form-input" rows="2" maxlength="250"></textarea></label>
            <button class="btn-danger" onclick="AjustesVenta.cancelar()">Cancelar factura</button>` : ''}
        </section>
        <section class="nc-accion ${puedeNota ? '' : 'nc-off'}">
          <h4>Emitir nota de crédito</h4><p>${esc(cl.notaCredito.razon)}${!d.permisos.notaCredito ? ' No tienes permiso para emitir notas.' : ''}</p>
          ${puedeNota ? `
            <div class="nc-tipo"><label class="nc-radio"><input type="radio" name="nc-tipo" value="productos" checked onchange="AjustesVenta.tipo('productos')"> Devolución de productos</label>
            <label class="nc-radio"><input type="radio" name="nc-tipo" value="monto" onchange="AjustesVenta.tipo('monto')"> Ajuste de monto / descuento</label></div>
            <div id="nc-productos">${tablaProductos(d.items)}</div>
            <div id="nc-monto" class="hidden"><div class="cs-campos">
              <label class="cs-campo">Monto con ITBIS *<input type="number" min="0.01" step="0.01" id="nc-m-monto" class="form-input" placeholder="0.00"></label>
              <label class="cs-campo">ITBIS<select id="nc-m-tasa" class="form-input"><option value="18">18%</option><option value="16">16%</option><option value="0">Exento</option></select></label>
              <label class="cs-campo">Concepto<input type="text" id="nc-m-concepto" class="form-input" maxlength="120" placeholder="Ej.: descuento por demora"></label></div></div>
            ${v.cobro.efectivo > 0 ? '<label class="nc-check"><input type="checkbox" id="nc-n-efectivo" checked> Devolver efectivo de la caja (la parte que se cobró en efectivo)</label>' : ''}
            <label class="cs-campo">Motivo *<textarea id="nc-n-motivo" class="form-input" rows="2" maxlength="250"></textarea></label>
            <p class="cs-aviso">El importe exacto (con ITBIS y propina proporcional) lo calcula el sistema. El crédito pendiente del cliente se rebaja primero en la parte que fue a crédito.</p>
            <button class="btn-primary" onclick="AjustesVenta.emitir()">Emitir nota de crédito</button>` : ''}
        </section>
      </div>
      ${d.historial.length ? `<h4>Notas y cancelaciones de esta factura</h4><div class="cs-tabla-wrap"><table class="data-table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Documento</th><th>Total</th><th>Estado DGII</th><th>Motivo</th><th></th></tr></thead><tbody>
        ${d.historial.map((h) => `<tr><td>${esc(h.fecha)}</td><td>${esc(TIPOS_NOTA[h.tipo] || h.tipo)}</td><td>${esc(h.documento)}</td><td>${money(h.total)}</td>
          <td>${esc(h.estadoE34 ? (h.estadoE34.encf ? `${h.estadoE34.encf} · ${h.estadoE34.estado}` : h.estadoE34.estado) : '—')}</td><td>${esc(h.motivo)}</td>
          <td><button class="btn-ghost" onclick="AjustesVenta.verNota(${h.id})">Ver / imprimir</button>
          ${h.estadoE34 && ['error', 'no_emitida', 'rechazado'].includes(String(h.estadoE34.estado)) ? `<button class="btn-ghost" onclick="AjustesVenta.reintentar(${h.id})">Reintentar E34</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : ''}`,
    '<button class="btn-secondary" onclick="closeAllModals()">Cerrar</button><button class="btn-secondary" onclick="AjustesVenta.abrir()">Otra factura</button>');
  }

  function tablaProductos(items) {
    return `<div class="cs-tabla-wrap"><table class="data-table nc-tabla"><thead><tr><th>Producto</th><th>Vendido</th><th>Disponible</th><th>Devolver</th><th>Regresa a inventario</th></tr></thead><tbody>
      ${items.map((i) => `<tr><td>${esc(i.nombre)}<br><small>${money(i.precio)}${i.descuentoPct ? ` · desc. ${i.descuentoPct}%` : ''}${i.itbisPct ? ` · ITBIS ${i.itbisPct}%` : ''}</small></td>
        <td>${i.cantidad}</td><td>${i.disponible}</td>
        <td><input type="number" class="form-input nc-qty" data-id="${i.id}" min="0" max="${i.disponible}" step="${i.saleMode === 'unidad' ? 1 : 0.01}" value="0" ${i.disponible <= 0 ? 'disabled' : ''} aria-label="Cantidad a devolver de ${esc(i.nombre)}"></td>
        <td><input type="checkbox" class="nc-restock" data-id="${i.id}" ${i.controlaInventario ? 'checked' : 'disabled'} title="Desmarca si el producto vuelve dañado o es un servicio"></td></tr>`).join('')}
    </tbody></table></div>`;
  }

  function tipo(t) {
    document.getElementById('nc-productos')?.classList.toggle('hidden', t !== 'productos');
    document.getElementById('nc-monto')?.classList.toggle('hidden', t !== 'monto');
  }

  async function cancelar() {
    const motivo = String(document.getElementById('nc-c-motivo')?.value || '').trim();
    if (!motivo) { toast('Indica el motivo de la cancelación.', 'error'); return; }
    const modo = document.querySelector('input[name="nc-modo"]:checked')?.value || state.data.clasificacion.cancelar.modos[0];
    if (!window.confirm(`¿Cancelar la factura ${state.data.venta.factura}? (${MODOS[modo]}). La factura original no se borra.`)) return;
    try {
      const r = await api.request(`/api/sales/${encodeURIComponent(state.data.venta.factura)}/cancel`, { method: 'PATCH', body: JSON.stringify({
        reason: motivo, modoFiscal: modo, refundCash: document.getElementById('nc-c-efectivo') ? document.getElementById('nc-c-efectivo').checked : false,
        reintegrarInventario: document.getElementById('nc-c-inventario')?.checked !== false, ...estructura(), ...actor() }) });
      despues(r.sale);
      toast('Factura cancelada.', 'success');
      if (r.ecfNota?.encf) toast(`Nota de crédito ${r.ecfNota.encf}: ${r.ecfNota.estado}.`, r.ecfNota.ok ? 'success' : 'warning');
      else if (r.ecfNota?.error) toast(`La factura quedó cancelada, pero la E34 no se emitió: ${r.ecfNota.error}. Puedes reintentarla desde aquí.`, 'warning');
      await cargar(state.factura);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function emitir() {
    const motivo = String(document.getElementById('nc-n-motivo')?.value || '').trim();
    if (!motivo) { toast('Indica el motivo de la nota de crédito.', 'error'); return; }
    const tipoNota = document.querySelector('input[name="nc-tipo"]:checked')?.value || 'productos';
    const body = { invoiceNumber: state.data.venta.factura, reason: motivo, tipo: tipoNota, clientRequestId: state.requestId,
      refundCash: document.getElementById('nc-n-efectivo') ? document.getElementById('nc-n-efectivo').checked : false, ...estructura(), ...actor() };
    if (tipoNota === 'productos') {
      body.items = [...document.querySelectorAll('.nc-qty')].map((el) => ({ saleItemId: Number(el.dataset.id), qty: Number(el.value || 0),
        restock: document.querySelector(`.nc-restock[data-id="${el.dataset.id}"]`)?.checked === true })).filter((i) => i.qty > 0);
      if (!body.items.length) { toast('Indica la cantidad de al menos un producto.', 'warning'); return; }
    } else {
      body.monto = Number(document.getElementById('nc-m-monto')?.value || 0);
      body.itbisTasa = Number(document.getElementById('nc-m-tasa')?.value || 0);
      body.concepto = String(document.getElementById('nc-m-concepto')?.value || '').trim();
      if (!(body.monto > 0)) { toast('Indica el monto del ajuste.', 'warning'); return; }
    }
    try {
      const r = await api.request('/api/sales/return', { method: 'POST', body: JSON.stringify(body) });
      toast(r.message, 'success');
      const reemb = r.reembolso || {};
      if (reemb.tarjeta > 0 || reemb.transferencia > 0) toast(`Reembolso fuera de la caja: tarjeta ${money(reemb.tarjeta)} · transferencia ${money(reemb.transferencia)}.`, 'info');
      if (r.ecfNota?.encf) toast(`E34 ${r.ecfNota.encf}: ${r.ecfNota.estado}.`, r.ecfNota.ok ? 'success' : 'warning');
      else if (r.ecfNota?.error) toast(`La nota quedó registrada, pero la E34 no se emitió: ${r.ecfNota.error}. Puedes reintentarla.`, 'warning');
      if (!r.itbisAfecta) toast('Esta nota no rebaja el ITBIS (más de 30 días).', 'info');
      despues();
      await cargar(state.factura);
      verNota(r.returnId);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function reintentar(id) {
    try {
      const r = await api.request(`/api/ventas/ajustes/${Number(id)}/reintentar`, { method: 'POST', body: '{}' });
      toast(r.encf ? `E34 ${r.encf}: ${r.estado}` : (r.error || 'No se pudo emitir la E34.'), r.ok ? 'success' : 'warning');
      await cargar(state.factura);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function despues(ventaActualizada) {
    if (ventaActualizada && Array.isArray(DB.ventas)) DB.ventas = DB.ventas.map((s) => (s.id === ventaActualizada.id ? ventaActualizada : s));
    try {
      const fresh = await api.getBootstrap();
      if (fresh && typeof hydrateDB === 'function') hydrateDB(fresh);
    } catch (_) { /* se refresca después */ }
    if (typeof syncCajaState === 'function') syncCajaState();
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs();
    if (typeof updateReportes === 'function') updateReportes();
  }

  // ── Nota imprimible ──────────────────────────────────────────────────
  function htmlNota(nt, { imprimir = false, a4 = true } = {}) {
    const fila = (l, v, b) => `<div class="csr-row${b ? ' csr-bold' : ''}"><span>${esc(l)}</span><span>${esc(v)}</span></div>`;
    const titulo = nt.tipo === 'nota_credito_e34' ? 'NOTA DE CRÉDITO ELECTRÓNICA' : (nt.tipo === 'nota_credito_b04' ? 'NOTA DE CRÉDITO' : (nt.tipo === 'nota_credito_interna' ? 'NOTA DE CRÉDITO INTERNA (sin comprobante fiscal)' : 'AJUSTE DE FACTURA'));
    const estilos = imprimir ? `<style>.csr{font-family:${a4 ? "'Segoe UI',Arial,sans-serif" : "'Courier New',monospace"};font-size:${a4 ? '12px' : '11px'};color:#000;${a4 ? 'max-width:180mm;margin:10mm auto' : ''}}
      .csr h2{text-align:center;margin:0}.csr-sub{text-align:center;margin:2px 0}.csr-sec{border-top:1px dashed #000;margin-top:6px;padding-top:4px}
      .csr-row{display:flex;justify-content:space-between;gap:8px}.csr-bold{font-weight:700}</style>` : '';
    return `${estilos}<div class="csr ${imprimir ? (a4 ? 'corte-print corte-print--a4' : 'ticket-print') : ''}">
      <h2>${esc(nt.negocio.nombre)}</h2>${nt.negocio.rnc ? `<p class="csr-sub">RNC ${esc(nt.negocio.rnc)}</p>` : ''}
      <p class="csr-sub"><strong>${esc(titulo)}</strong></p><p class="csr-sub">${esc(nt.documento)} · ${esc(nt.fecha)}</p>
      <section class="csr-sec">${fila('Modifica a', `${nt.original.ncf || nt.original.factura} (${nt.original.factura})`)}${fila('Fecha original', nt.original.fecha)}
        ${fila('Cliente', nt.cliente.nombre)}${nt.cliente.documento ? fila('RNC / cédula', nt.cliente.documento) : ''}${fila('Motivo', nt.motivo)}</section>
      ${nt.lineas.length ? `<section class="csr-sec">${nt.lineas.map((l) => fila(`${l.cantidad} x ${l.nombre}${l.reintegrado ? '' : ' (no regresa a inventario)'}`, money(l.total))).join('')}</section>` : ''}
      <section class="csr-sec">${fila('Base', money(nt.base))}${fila(nt.itbisAfecta ? 'ITBIS' : 'ITBIS (no se rebaja: más de 30 días)', money(nt.itbis))}
        ${nt.propinaLegal ? fila('Propina legal', money(nt.propinaLegal)) : ''}${fila('Total de la nota', money(nt.total), true)}</section>
      ${nt.reembolso && Object.keys(nt.reembolso).length ? `<section class="csr-sec">${fila('Efectivo devuelto de caja', money(nt.reembolso.efectivoDesdeCaja))}
        ${nt.reembolso.tarjeta ? fila('Reembolso a tarjeta', money(nt.reembolso.tarjeta)) : ''}${nt.reembolso.transferencia ? fila('Reembolso por transferencia', money(nt.reembolso.transferencia)) : ''}
        ${nt.reembolso.creditoRebajado ? fila('Rebajado del crédito', money(nt.reembolso.creditoRebajado)) : ''}</section>` : ''}
      ${nt.estadoE34 ? `<p class="csr-sub">Estado DGII: ${esc(nt.estadoE34.estado)}${nt.estadoE34.encf ? ` · ${esc(nt.estadoE34.encf)}` : ''}</p>` : ''}
      <p class="csr-sub">Registrado por ${esc(nt.usuario)}</p></div>`;
  }

  async function verNota(id) {
    try {
      const nt = await api.request(`/api/ventas/ajustes/${Number(id)}`);
      state.nota = nt;
      document.getElementById('modal-title').textContent = 'Nota de crédito';
      document.getElementById('modal-body').innerHTML = `<div class="nc-modal"><div class="cs-reporte">${htmlNota(nt)}</div></div>`;
      document.getElementById('modal-footer').innerHTML = `<button class="btn-secondary" onclick="AjustesVenta.cargar('${esc(state.factura)}')">Volver</button>
        <button class="btn-secondary" onclick="AjustesVenta.imprimirNota('80mm')">Imprimir 80 mm</button>
        <button class="btn-secondary" onclick="AjustesVenta.imprimirNota('58mm')">Imprimir 58 mm</button>
        <button class="btn-secondary" onclick="AjustesVenta.imprimirNota('a4')">Imprimir A4</button>
        <button class="btn-primary" onclick="AjustesVenta.pdfNota()">PDF</button>`;
      document.getElementById('modal-overlay').classList.remove('hidden');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function imprimirNota(papel) {
    const nt = state.nota;
    if (!nt) return;
    const settings = typeof _resolveCortePrintSettings === 'function' ? await _resolveCortePrintSettings() : {};
    const termico = papel !== 'a4';
    if (termico && window.novaDesktop?.printCorteEscpos && settings.printerName && settings.isThermal) {
      const filas = [{ etiqueta: 'Documento', valor: nt.documento }, { etiqueta: 'Modifica a', valor: nt.original.ncf || nt.original.factura }, { etiqueta: 'Cliente', valor: nt.cliente.nombre },
        { etiqueta: `Motivo: ${nt.motivo}`, valor: '' }, ...nt.lineas.map((l) => ({ etiqueta: `${l.cantidad} x ${l.nombre}`, valor: money(l.total) })),
        { etiqueta: 'Base', valor: money(nt.base) }, { etiqueta: 'ITBIS', valor: money(nt.itbis) }, ...(nt.propinaLegal ? [{ etiqueta: 'Propina legal', valor: money(nt.propinaLegal) }] : []),
        { etiqueta: 'TOTAL', valor: money(nt.total), negrita: true }];
      const r = await window.novaDesktop.printCorteEscpos({ negocio: { nombre: nt.negocio.nombre, rnc: nt.negocio.rnc }, titulo: 'NOTA DE CREDITO', secciones: [{ titulo: nt.fecha, filas }], corte: {},
        config: { paperWidth: papel, cortarPapel: true, currency: settings.currency || 'RD$' } }, { printerName: settings.printerName, paperWidth: papel });
      toast(r?.ok ? 'Nota enviada a la impresora.' : (r?.error || 'No se pudo imprimir.'), r?.ok ? 'success' : 'error');
      return;
    }
    const html = htmlNota(nt, { imprimir: true, a4: !termico });
    if (typeof _printConfiguredHtml === 'function' && window.novaDesktop?.printReceiptHtml) await _printConfiguredHtml(html, { ...settings, paperWidth: papel, isThermal: termico }, 'Nota enviada a la impresora.');
    else { const w = window.open('', '_blank'); if (w) { w.document.write(`<!doctype html><meta charset="utf-8">${html}`); w.document.close(); w.print(); } }
  }

  async function pdfNota() {
    const nt = state.nota;
    if (!nt) return;
    try {
      await VendorLoader.load('jspdf');
      const doc = new jspdf.jsPDF({ format: 'a4' });
      let y = 18;
      const linea = (l, v, b) => { doc.setFont('helvetica', b ? 'bold' : 'normal'); doc.text(doc.splitTextToSize(String(l), 120), 16, y); doc.text(String(v ?? ''), 194, y, { align: 'right' }); y += 6; };
      doc.setFontSize(14); doc.text(nt.negocio.nombre || '', 105, y, { align: 'center' }); y += 6;
      doc.setFontSize(10); if (nt.negocio.rnc) { doc.text(`RNC ${nt.negocio.rnc}`, 105, y, { align: 'center' }); y += 6; }
      doc.setFontSize(12); doc.text(nt.tipo === 'nota_credito_interna' ? 'Nota de crédito interna (sin comprobante fiscal)' : 'Nota de crédito', 105, y, { align: 'center' }); y += 8;
      doc.setFontSize(10);
      linea('Documento', nt.documento); linea('Fecha', nt.fecha); linea('Modifica a', `${nt.original.ncf || nt.original.factura} (${nt.original.factura})`);
      linea('Cliente', nt.cliente.nombre); if (nt.cliente.documento) linea('RNC / cédula', nt.cliente.documento); linea('Motivo', nt.motivo); y += 3;
      for (const l of nt.lineas) linea(`${l.cantidad} x ${l.nombre}${l.reintegrado ? '' : ' (no regresa a inventario)'}`, money(l.total));
      y += 3; linea('Base', money(nt.base)); linea(nt.itbisAfecta ? 'ITBIS' : 'ITBIS (no se rebaja: más de 30 días)', money(nt.itbis));
      if (nt.propinaLegal) linea('Propina legal', money(nt.propinaLegal));
      linea('Total de la nota', money(nt.total), true);
      if (nt.estadoE34) linea('Estado DGII', `${nt.estadoE34.estado}${nt.estadoE34.encf ? ` · ${nt.estadoE34.encf}` : ''}`);
      doc.save(`Nota_credito_${nt.documento}.pdf`);
    } catch (e) { toast(e.message, 'error'); }
  }

  window.AjustesVenta = { abrir, buscar, cargar, tipo, cancelar, emitir, reintentar, verNota, imprimirNota, pdfNota };
})();

/* Panel: Planes y precios, cotizador y contrato de cada negocio.
 * Toda cuenta la hace el servidor (routes/contratos.routes.js); aquí solo se muestra. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rd = (c) => (c === null || c === undefined ? 'Por definir' : `RD$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);
  const dia = (v) => (v ? new Date(v).toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
  const PERMANENTE = 'LIFETIME_NO_SUBSCRIPTION';
  const MODALIDADES = [['mensual', 'Mensual'], ['anual', 'Anual (paga 9, recibe 12)'], [PERMANENTE, 'Pago único permanente']];
  const ESTADOS = {
    activo: 'Activo', inactivo: 'No contratado', suspendido: 'Suspendido', vencido: 'Vencido', sin_contrato: 'Sin registrar',
  };
  const CONCEPTOS = [
    ['licencia', 'Licencia'], ['implementacion', 'Implementación'], ['implementacion_adicional', 'Implementación adicional'],
    ['adicional', 'Computadora o sucursal adicional'], ['ecf', 'Facturación electrónica'], ['soporte', 'Soporte técnico'],
  ];

  let catalogo = null;
  let contratoAbierto = null;

  function aviso(texto, tipo = 'success') {
    if (typeof showToast === 'function') showToast(texto, tipo);
  }

  // ── Módulo Planes y precios ─────────────────────────────────────────────
  async function cargarPrecios() {
    const caja = $('precios-contenido');
    if (!caja) return;
    try {
      const r = await api('GET', '/api/precios-licencia');
      catalogo = r.catalogo;
      const g = r.guardados || {};
      const entrada = (id, valor) => `<input class="form-input" type="number" min="0" step="0.01" id="${id}" placeholder="Por definir" value="${valor ?? ''}" style="max-width:150px">`;
      caja.innerHTML = `
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Plan</th><th>Incluye</th><th>Mensual</th><th>Anual</th><th>Implementación</th><th>PC adicional</th><th>Sucursal adicional</th><th>Pago único</th></tr></thead>
          <tbody>${catalogo.planes.map((p) => `<tr>
            <td><b>${esc(p.nombre)}</b></td>
            <td>${p.sucursales > 1 ? `${p.sucursales} sucursales, 1 PC por sucursal` : `${p.computadoras} PC`}</td>
            <td>${rd(p.mensual)}</td><td>${rd(p.anual)}</td><td>${rd(p.implementacion)}</td>
            <td>${p.computadoraExtraMensual === null ? '—' : `${rd(p.computadoraExtraMensual)} al mes, ${rd(p.computadoraExtraAnual)} al año, ${rd(p.computadoraExtraImplementacion)} implementación`}</td>
            <td>${p.sucursalExtraMensual === null ? '—' : `${rd(p.sucursalExtraMensual)} al mes, ${rd(p.sucursalExtraAnual)} al año`}</td>
            <td>${rd(p.permanente)}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <h3 style="margin-top:20px">Precios por definir</h3>
        <p class="helper-text">Estos todavía no son oficiales. Lo que pongas aquí lo usan el cotizador y el registro de pagos, en pesos. Para que el cliente lo vea en el POS y en la página hay que publicarlo aparte.</p>
        <div class="form-row" style="display:flex;flex-wrap:wrap;gap:14px">
          ${catalogo.planes.map((p) => `<label>Pago único ${esc(p.nombre)}${entrada(`pre-perm-${p.codigo}`, g.permanente?.[p.codigo])}</label>`).join('')}
          <label>e-CF al mes${entrada('pre-ecf-mes', g.ecf?.mensual)}</label>
          <label>e-CF al año${entrada('pre-ecf-ano', g.ecf?.anual)}</label>
          <label>Soporte al mes${entrada('pre-sop-mes', g.soporte?.mensual)}</label>
          <label>Soporte al año${entrada('pre-sop-ano', g.soporte?.anual)}</label>
        </div>
        <button class="btn-primary" style="margin-top:12px" onclick="adminContratos.guardarPrecios()">Guardar precios</button>
        <h3 style="margin-top:24px">Cotizador</h3>
        <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end">
          <label>Plan<select class="form-input" id="cot-plan">${catalogo.planes.map((p) => `<option value="${p.codigo}">${esc(p.nombre)}</option>`).join('')}</select></label>
          <label>Modalidad<select class="form-input" id="cot-modalidad">${MODALIDADES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
          <label>PC adicionales<input class="form-input" type="number" min="0" id="cot-pc" value="0" style="max-width:90px"></label>
          <label>Sucursales adicionales<input class="form-input" type="number" min="0" id="cot-suc" value="0" style="max-width:90px"></label>
          <label><input type="checkbox" id="cot-impl" checked> Con implementación</label>
          <label><input type="checkbox" id="cot-ecf"> e-CF</label>
          <label><input type="checkbox" id="cot-sop"> Soporte</label>
          <button class="btn-primary" onclick="adminContratos.cotizar()">Calcular</button>
        </div>
        <div id="cot-resultado" style="margin-top:14px"></div>`;
    } catch (e) {
      caja.textContent = e.message;
    }
  }

  async function guardarPrecios() {
    const v = (id) => $(id).value;
    try {
      await api('PUT', '/api/precios-licencia', {
        permanente: { basico: v('pre-perm-basico'), pro: v('pre-perm-pro'), plus: v('pre-perm-plus') },
        ecf: { mensual: v('pre-ecf-mes'), anual: v('pre-ecf-ano') },
        soporte: { mensual: v('pre-sop-mes'), anual: v('pre-sop-ano') },
      });
      aviso('Precios guardados.');
      cargarPrecios();
    } catch (e) { aviso(e.message, 'error'); }
  }

  async function cotizar() {
    try {
      const periodo = $('cot-modalidad').value === 'anual' ? 'anual' : 'mensual';
      const c = await api('POST', '/api/precios-licencia/cotizar', {
        plan: $('cot-plan').value,
        modalidad: $('cot-modalidad').value,
        computadorasExtra: Number($('cot-pc').value || 0),
        sucursalesExtra: Number($('cot-suc').value || 0),
        incluirImplementacion: $('cot-impl').checked,
        servicios: { ...($('cot-ecf').checked ? { ecf: periodo } : {}), ...($('cot-sop').checked ? { soporte: periodo } : {}) },
      });
      $('cot-resultado').innerHTML = `<table class="data-table">
        <thead><tr><th>Concepto</th><th>Cant.</th><th>Período</th><th>Precio</th><th>Total</th></tr></thead>
        <tbody>${c.lineas.map((l) => `<tr><td>${esc(l.concepto)}</td><td>${l.cantidad}</td><td>${esc(l.periodo === 'unico' ? 'Una vez' : l.periodo)}</td><td>${rd(l.unitario)}</td><td>${rd(l.total)}</td></tr>`).join('')}</tbody>
      </table>
      <p style="margin-top:8px"><b>Una sola vez:</b> ${rd(c.totales.implementacion + (c.periodo === 'unico' ? c.totales.licencia : 0))} ·
        <b>Se repite cada ${c.periodo === 'anual' ? 'año' : 'mes'}:</b> ${rd(c.totales.recurrente)} ·
        <b>Total hoy:</b> ${rd(c.totales.total)}</p>
      <p>Permite ${c.limites.computadoras} computadora(s) y ${c.limites.sucursales} sucursal(es).</p>
      ${c.pendientes.length ? `<p style="color:#d97706">Sin precio definido: ${c.pendientes.map(esc).join(', ')}. No están en el total.</p>` : ''}`;
    } catch (e) { aviso(e.message, 'error'); }
  }

  // ── Contrato de un negocio ──────────────────────────────────────────────
  function filaServicio(id, nombre, s) {
    const venceId = `ctr-vence-${id}`;
    return `<tr>
      <td>${esc(nombre)}</td>
      <td><span class="badge badge-${s.estado === 'activo' ? 'active' : s.estado === 'vencido' || s.estado === 'suspendido' ? 'suspended' : 'pending'}">${esc(ESTADOS[s.estado] || s.estado)}</span></td>
      <td>${dia(s.venceEn)}</td>
      <td style="white-space:nowrap">
        <input class="form-input" type="date" id="${venceId}" style="max-width:150px;display:inline-block">
        <button class="btn-sm btn-success" onclick="adminContratos.servicio('${id}','activar')">Activar</button>
        <button class="btn-sm btn-warning" onclick="adminContratos.servicio('${id}','suspender')">Suspender</button>
      </td>
    </tr>`;
  }

  function pintarContrato(c) {
    contratoAbierto = c;
    const ctr = c.contrato || {};
    const planes = catalogo?.planes || [];
    const s = c.servicios;
    $('contrato-titulo').textContent = `Contrato: ${c.negocio}`;
    $('contrato-cuerpo').innerHTML = `
      <p class="helper-text">Licencia <code>${esc(c.licenseId)}</code>${c.rnc ? ` · RNC ${esc(c.rnc)}` : ''} · Estado: <b>${esc(c.status)}</b>
        ${c.modalidad === PERMANENTE ? ' · Sin vencimiento' : c.expiresAt ? ` · Pagada hasta <b>${dia(c.expiresAt)}</b>` : ''}</p>
      ${c.contrato ? '' : '<p style="color:#d97706">Este negocio todavía no tiene contrato: al guardar, sus servicios empiezan a controlarse. Revisa e-CF y soporte antes de guardar si ya los usa.</p>'}
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end">
        <label>Plan<select class="form-input" id="ctr-plan">${planes.map((p) => `<option value="${p.codigo}" ${p.codigo === c.planCode ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select></label>
        <label>Modalidad<select class="form-input" id="ctr-modalidad">${MODALIDADES.map(([v, t]) => `<option value="${v}" ${v === c.modalidad ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>PC adicionales<input class="form-input" type="number" min="0" id="ctr-pc" value="${ctr.computadorasExtra || 0}" style="max-width:90px"></label>
        <label>Sucursales adicionales<input class="form-input" type="number" min="0" id="ctr-suc" value="${ctr.sucursalesExtra || 0}" style="max-width:90px"></label>
        <label>Pagada hasta<input class="form-input" type="date" id="ctr-vence" value="${c.expiresAt ? c.expiresAt.slice(0, 10) : ''}"></label>
        <label>Adquisición<input class="form-input" type="date" id="ctr-adq" value="${ctr.fechaAdquisicion ? ctr.fechaAdquisicion.slice(0, 10) : ''}"></label>
        <label>Implementación<input class="form-input" type="date" id="ctr-impl" value="${ctr.fechaImplementacion ? ctr.fechaImplementacion.slice(0, 10) : ''}"></label>
        <button class="btn-primary" onclick="adminContratos.guardarContrato()">Guardar contrato</button>
      </div>
      <p style="margin-top:8px">Computadoras: <b>${c.computadorasActivas}</b> activas de <b>${c.computadorasContratadas || '—'}</b> contratadas
        ${c.computadorasContratadas && c.computadorasActivas > c.computadorasContratadas ? '<span style="color:#dc2626"> · Excede lo contratado</span>' : ''}
        ${ctr.sucursales ? ` · Sucursales contratadas: <b>${ctr.sucursales}</b>` : ''}</p>
      <h4 style="margin-top:16px">Servicios</h4>
      <table class="data-table"><thead><tr><th>Servicio</th><th>Estado</th><th>Vence</th><th>Acción</th></tr></thead><tbody>
        ${filaServicio('ecf', 'Facturación electrónica', s.ecf)}
        ${filaServicio('soporte', 'Soporte técnico', s.soporte)}
        <tr><td>Respaldo local</td><td colspan="3">${esc(ESTADOS[s.respaldoLocal.estado])}</td></tr>
        <tr><td>Respaldo en la nube</td><td colspan="3">${esc(ESTADOS[s.respaldoNube.estado])}</td></tr>
        <tr><td>Actualizaciones</td><td colspan="3">${esc(ESTADOS[s.actualizaciones.estado])}</td></tr>
      </tbody></table>
      <h4 style="margin-top:16px">Registrar pago</h4>
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end">
        <label>Concepto<select class="form-input" id="pag-concepto">${CONCEPTOS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
        <label>Período<select class="form-input" id="pag-periodo"><option value="mensual">Mensual</option><option value="anual">Anual</option></select></label>
        <label>Monto RD$<input class="form-input" type="number" min="0" step="0.01" id="pag-monto" style="max-width:130px"></label>
        <label>Método<input class="form-input" id="pag-metodo" maxlength="40" style="max-width:150px"></label>
        <label>Referencia<input class="form-input" id="pag-ref" maxlength="120" style="max-width:170px"></label>
        <button class="btn-primary" id="pag-boton" onclick="adminContratos.registrarPago()">Registrar pago</button>
      </div>
      <p class="helper-text">Registrar licencia, e-CF o soporte alarga su vigencia. No cobra ni factura: solo deja constancia.</p>
      <h4 style="margin-top:16px">Pagos</h4>
      ${(c.pagos || []).length ? `<table class="data-table"><thead><tr><th>Fecha</th><th>Concepto</th><th>Período</th><th>Monto</th><th>Método</th><th>Registró</th></tr></thead><tbody>
        ${c.pagos.map((p) => `<tr><td>${dia(p.fecha)}</td><td>${esc((CONCEPTOS.find(([v]) => v === p.concepto) || [])[1] || p.concepto)}</td><td>${esc(p.periodo === 'unico' ? 'Una vez' : p.periodo)}</td><td>${rd(p.montoCentavos)}</td><td>${esc(p.metodo)}</td><td>${esc(p.registradoPor)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="helper-text">Sin pagos registrados.</p>'}
      <h4 style="margin-top:16px">Equipos</h4>
      ${(c.equipos || []).length ? `<ul>${c.equipos.map((e) => `<li>${esc(e.hostname)} · última conexión ${dia(e.lastSeenAt)}</li>`).join('')}</ul>` : '<p class="helper-text">Sin equipos registrados.</p>'}
      <p class="helper-text">Para quitar o cambiar un equipo usa "Ver" en la lista de Negocios.</p>
      <h4 style="margin-top:16px">Historial</h4>
      ${(c.historial || []).length ? `<ul>${c.historial.slice(0, 15).map((h) => `<li>${dia(h.created_at)} · ${esc(h.action)} · ${esc(h.notes || '')} · ${esc(h.activated_by || '')}</li>`).join('')}</ul>` : '<p class="helper-text">Sin cambios registrados.</p>'}`;
  }

  async function abrir(id) {
    try {
      if (!catalogo) catalogo = (await api('GET', '/api/precios-licencia')).catalogo;
      pintarContrato(await api('GET', `/api/negocios/${encodeURIComponent(id)}/contrato`));
      $('modal-contrato').classList.remove('hidden');
    } catch (e) { aviso(e.message, 'error'); }
  }

  const refrescar = async () => pintarContrato(await api('GET', `/api/negocios/${encodeURIComponent(contratoAbierto.id)}/contrato`));

  async function guardarContrato() {
    try {
      await api('PUT', `/api/negocios/${encodeURIComponent(contratoAbierto.id)}/contrato`, {
        plan: $('ctr-plan').value,
        modalidad: $('ctr-modalidad').value,
        computadorasExtra: Number($('ctr-pc').value || 0),
        sucursalesExtra: Number($('ctr-suc').value || 0),
        venceEn: $('ctr-vence').value ? `${$('ctr-vence').value}T23:59:59` : null,
        fechaAdquisicion: $('ctr-adq').value || null,
        fechaImplementacion: $('ctr-impl').value || null,
      });
      aviso('Contrato guardado.');
      await refrescar();
    } catch (e) { aviso(e.message, 'error'); }
  }

  async function servicio(id, accion) {
    try {
      const fecha = $(`ctr-vence-${id}`).value;
      await api('POST', `/api/negocios/${encodeURIComponent(contratoAbierto.id)}/servicios/${id}`, { accion, venceEn: fecha ? `${fecha}T23:59:59` : null });
      aviso('Servicio actualizado.');
      await refrescar();
    } catch (e) { aviso(e.message, 'error'); }
  }

  // La clave se crea una vez por pago: repetir el clic no cobra ni alarga dos veces.
  let clavePago = null;
  async function registrarPago() {
    const boton = $('pag-boton');
    if (boton.disabled) return;
    clavePago = clavePago || `pago-${crypto.randomUUID()}`;
    boton.disabled = true;
    try {
      await api('POST', `/api/negocios/${encodeURIComponent(contratoAbierto.id)}/pagos`, {
        clave: clavePago,
        concepto: $('pag-concepto').value,
        periodo: $('pag-periodo').value,
        monto: Number($('pag-monto').value),
        metodo: $('pag-metodo').value,
        referencia: $('pag-ref').value,
      });
      clavePago = null;
      aviso('Pago registrado.');
      await refrescar();
    } catch (e) {
      aviso(e.message, 'error');
      boton.disabled = false;
    }
  }

  window.adminContratos = {
    abrir, cargarPrecios, cerrar: () => $('modal-contrato').classList.add('hidden'), cotizar, guardarContrato, guardarPrecios, registrarPago, servicio,
  };
})();

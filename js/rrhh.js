/* ============================================================
   Tecno Caja — Recursos Humanos
   Empleados, Asistencia, Permisos. No calcula nómina ni pagos —
   es registro de personal, no un módulo financiero.
   ============================================================ */

(function () {
  'use strict';

  const RRHH = {
    tab: 'empleados',
    empleados: [],
    filtroAsistenciaEmpleado: '',
    filtroAsistenciaDesde: '',
    filtroAsistenciaHasta: '',
  };

  function fmtDate(v) { return v || ''; }
  function el(id) { return document.getElementById(id); }

  function getAuthHeaders() {
    let tok = '';
    if (typeof getTecnoCajaAuthToken === 'function') tok = getTecnoCajaAuthToken();
    else if (typeof DB !== 'undefined' && DB.authToken) tok = DB.authToken;
    if (tok) return { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' };
    return { 'Content-Type': 'application/json' };
  }

  async function rrhhApi(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: getAuthHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
    return data;
  }
  function rrhhGet(path) { return rrhhApi('GET', path); }
  function toastMsg(msg, type) { if (typeof showToast === 'function') showToast(msg, type); }

  // ── Tabs ─────────────────────────────────────────────────
  window.rrhhSwitchTab = function (tab) {
    RRHH.tab = tab;
    document.querySelectorAll('#module-rrhh .rrhh-tab').forEach(b => b.classList.toggle('active', b.dataset.rrhhtab === tab));
    document.querySelectorAll('#module-rrhh .rrhh-pane').forEach(p => {
      const isActive = p.id === `rrhh-tab-${tab}`;
      p.classList.toggle('active', isActive);
      p.classList.toggle('hidden', !isActive);
    });
    if (tab === 'empleados') rrhhLoadEmpleados();
    if (tab === 'asistencia') rrhhEnsureAsistenciaSelect();
    if (tab === 'permisos') rrhhLoadPermisos();
  };

  let _initialized = false;
  async function rrhhInit() {
    if (_initialized) return;
    _initialized = true;
    await rrhhLoadEmpleados();
  }

  // ── Empleados ────────────────────────────────────────────
  async function rrhhLoadEmpleados() {
    try {
      RRHH.empleados = await rrhhGet('/api/rrhh/empleados');
      rrhhRenderEmpleados();
    } catch (e) {
      const c = el('rrhh-empleados-body');
      if (c) c.innerHTML = `<tr><td colspan="6" style="color:#f87171;padding:12px">${e.message}</td></tr>`;
    }
  }

  function rrhhRenderEmpleados() {
    const tbody = el('rrhh-empleados-body');
    if (!tbody) return;
    tbody.innerHTML = RRHH.empleados.map((emp) => `
      <tr style="cursor:pointer" onclick="rrhhAbrirEmpleado(${emp.id})">
        <td>${esc(emp.nombre)}</td>
        <td>${esc(emp.cargo || '—')}</td>
        <td>${esc(emp.departamento || '—')}</td>
        <td>${esc(emp.telefono || '—')}</td>
        <td>${emp.fechaIngreso ? esc(emp.fechaIngreso) : '—'}</td>
        <td>${emp.estado === 'activo' ? '<span class="badge badge-success">Activo</span>' : '<span class="badge">Inactivo</span>'}</td>
      </tr>`).join('') || '<tr><td colspan="6" style="padding:12px;color:var(--text3)">Sin empleados registrados.</td></tr>';
  }

  function rrhhEmpleadoOptions(selectedId) {
    return RRHH.empleados.filter(e => e.estado === 'activo').map(e =>
      `<option value="${e.id}" ${Number(selectedId) === e.id ? 'selected' : ''}>${esc(e.nombre)}</option>`
    ).join('');
  }

  window.rrhhAbrirEmpleado = function (id) {
    const emp = id ? RRHH.empleados.find(e => e.id === id) : null;
    el('modal-title').textContent = emp ? 'Editar Empleado' : 'Nuevo Empleado';
    el('modal-body').innerHTML = `
      <div class="modal-grid">
        <div class="form-group span-full"><label>Nombre *</label><input type="text" id="rrhh-e-nombre" class="form-input" value="${esc(emp?.nombre || '')}"></div>
        <div class="form-group"><label>Cédula</label><input type="text" id="rrhh-e-cedula" class="form-input" value="${esc(emp?.cedula || '')}"></div>
        <div class="form-group"><label>Teléfono</label><input type="text" id="rrhh-e-telefono" class="form-input" value="${esc(emp?.telefono || '')}"></div>
        <div class="form-group"><label>Email</label><input type="email" id="rrhh-e-email" class="form-input" value="${esc(emp?.email || '')}"></div>
        <div class="form-group"><label>Cargo</label><input type="text" id="rrhh-e-cargo" class="form-input" value="${esc(emp?.cargo || '')}"></div>
        <div class="form-group"><label>Departamento</label><input type="text" id="rrhh-e-departamento" class="form-input" value="${esc(emp?.departamento || '')}"></div>
        <div class="form-group"><label>Fecha de ingreso</label><input type="date" id="rrhh-e-fecha" class="form-input" value="${emp?.fechaIngreso || ''}"></div>
        <div class="form-group"><label>Salario base (RD$)</label><input type="number" id="rrhh-e-salario" class="form-input" min="0" step="0.01" value="${emp?.salarioBase ?? ''}"></div>
        <div class="form-group span-full"><label>Horario</label><input type="text" id="rrhh-e-horario" class="form-input" placeholder="Ej. Lunes a Viernes 8:00am-5:00pm" value="${esc(emp?.horario || '')}"></div>
        <div class="form-group"><label>Estado</label>
          <select id="rrhh-e-estado" class="form-input">
            <option value="activo" ${!emp || emp.estado === 'activo' ? 'selected' : ''}>Activo</option>
            <option value="inactivo" ${emp?.estado === 'inactivo' ? 'selected' : ''}>Inactivo</option>
          </select>
        </div>
      </div>`;
    el('modal-footer').innerHTML = `
      <div style="display:flex;justify-content:${emp ? 'space-between' : 'flex-end'};width:100%;gap:.5rem;align-items:center">
        ${emp ? `<button class="btn-secondary" onclick="rrhhEliminarEmpleado(${emp.id})" style="color:#f87171;border-color:rgba(248,113,113,.3)">🗑 Eliminar</button>` : '<div></div>'}
        <div style="display:flex;gap:.5rem">
          <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
          <button class="btn-primary" onclick="rrhhGuardarEmpleado(${id || 'null'})">💾 Guardar</button>
        </div>
      </div>`;
    el('modal-overlay').classList.remove('hidden');
  };

  window.rrhhGuardarEmpleado = async function (id) {
    const payload = {
      nombre: el('rrhh-e-nombre').value.trim(),
      cedula: el('rrhh-e-cedula').value.trim(),
      telefono: el('rrhh-e-telefono').value.trim(),
      email: el('rrhh-e-email').value.trim(),
      cargo: el('rrhh-e-cargo').value.trim(),
      departamento: el('rrhh-e-departamento').value.trim(),
      fechaIngreso: el('rrhh-e-fecha').value || null,
      salarioBase: el('rrhh-e-salario').value ? Number(el('rrhh-e-salario').value) : null,
      horario: el('rrhh-e-horario').value.trim(),
      estado: el('rrhh-e-estado').value,
    };
    if (!payload.nombre) { toastMsg('El nombre es requerido.', 'warning'); return; }
    try {
      if (id) await rrhhApi('PUT', `/api/rrhh/empleados/${id}`, payload);
      else await rrhhApi('POST', '/api/rrhh/empleados', payload);
      if (typeof closeAllModals === 'function') closeAllModals();
      toastMsg('Empleado guardado.', 'success');
      rrhhLoadEmpleados();
    } catch (e) { toastMsg(e.message, 'error'); }
  };

  window.rrhhEliminarEmpleado = async function (id) {
    if (!confirm('¿Eliminar este empleado? Se perderá su historial de asistencia y permisos.')) return;
    try {
      await rrhhApi('DELETE', `/api/rrhh/empleados/${id}`);
      if (typeof closeAllModals === 'function') closeAllModals();
      toastMsg('Empleado eliminado.', 'success');
      rrhhLoadEmpleados();
    } catch (e) { toastMsg(e.message, 'error'); }
  };

  // ── Asistencia ───────────────────────────────────────────
  function rrhhEnsureAsistenciaSelect() {
    const sel = el('rrhh-asis-empleado');
    if (sel && !sel.dataset.filled) {
      sel.innerHTML = rrhhEmpleadoOptions();
      sel.dataset.filled = '1';
    }
    if (el('rrhh-asis-fecha') && !el('rrhh-asis-fecha').value) {
      el('rrhh-asis-fecha').value = new Date().toISOString().slice(0, 10);
    }
    rrhhLoadAsistencia();
  }

  window.rrhhMarcarAsistencia = async function () {
    const employeeId = el('rrhh-asis-empleado')?.value;
    const fecha = el('rrhh-asis-marcar-fecha')?.value;
    const estado = el('rrhh-asis-estado')?.value;
    if (!employeeId || !fecha) { toastMsg('Selecciona empleado y fecha.', 'warning'); return; }
    try {
      await rrhhApi('POST', '/api/rrhh/asistencia', { employeeId: Number(employeeId), fecha, estado });
      toastMsg('Asistencia registrada.', 'success');
      rrhhLoadAsistencia();
    } catch (e) { toastMsg(e.message, 'error'); }
  };

  window.rrhhLoadAsistencia = async function () {
    const employeeId = el('rrhh-asis-empleado')?.value;
    const tbody = el('rrhh-asis-body');
    if (!employeeId) { if (tbody) tbody.innerHTML = ''; return; }
    try {
      const rows = await rrhhGet(`/api/rrhh/asistencia?empleadoId=${employeeId}`);
      const estadoBadge = { presente: 'badge-success', ausente: '', tardanza: '', permiso: '' };
      if (tbody) {
        tbody.innerHTML = rows.map(r => `
          <tr>
            <td>${esc(r.fecha)}</td>
            <td><span class="badge ${estadoBadge[r.estado] || ''}">${esc(r.estado)}</span></td>
            <td>${esc(r.nota || '')}</td>
          </tr>`).join('') || '<tr><td colspan="3" style="padding:12px;color:var(--text3)">Sin registros de asistencia.</td></tr>';
      }
    } catch (e) { toastMsg(e.message, 'error'); }
  };

  // ── Permisos ─────────────────────────────────────────────
  async function rrhhLoadPermisos() {
    const tbody = el('rrhh-permisos-body');
    try {
      const rows = await rrhhGet('/api/rrhh/permisos');
      if (!tbody) return;
      tbody.innerHTML = rows.map(p => {
        const emp = RRHH.empleados.find(e => e.id === p.employeeId);
        return `
        <tr>
          <td>${esc(emp?.nombre || '—')}</td>
          <td>${esc(p.tipo)}</td>
          <td>${esc(p.fechaInicio)} → ${esc(p.fechaFin)}</td>
          <td>${esc(p.motivo || '')}</td>
          <td>
            ${p.estado === 'pendiente'
              ? `<span class="badge">Pendiente</span>
                 <button class="btn-secondary" style="padding:2px 8px;font-size:.75rem" onclick="rrhhResolverPermiso(${p.id},'aprobar')">✓</button>
                 <button class="btn-secondary" style="padding:2px 8px;font-size:.75rem;color:#f87171" onclick="rrhhResolverPermiso(${p.id},'rechazar')">✕</button>`
              : p.estado === 'aprobado' ? '<span class="badge badge-success">Aprobado</span>' : '<span class="badge" style="color:#f87171">Rechazado</span>'}
          </td>
        </tr>`;
      }).join('') || '<tr><td colspan="5" style="padding:12px;color:var(--text3)">Sin solicitudes registradas.</td></tr>';
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="color:#f87171;padding:12px">${e.message}</td></tr>`;
    }
  }

  window.rrhhAbrirNuevoPermiso = function () {
    el('modal-title').textContent = 'Nueva Solicitud de Permiso';
    el('modal-body').innerHTML = `
      <div class="modal-grid">
        <div class="form-group span-full"><label>Empleado *</label>
          <select id="rrhh-p-empleado" class="form-input"><option value="">-- Selecciona --</option>${rrhhEmpleadoOptions()}</select>
        </div>
        <div class="form-group"><label>Tipo *</label>
          <select id="rrhh-p-tipo" class="form-input">
            <option value="vacaciones">Vacaciones</option>
            <option value="personal">Personal</option>
            <option value="enfermedad">Enfermedad</option>
            <option value="otro">Otro</option>
          </select>
        </div>
        <div class="form-group"><label>Desde *</label><input type="date" id="rrhh-p-desde" class="form-input"></div>
        <div class="form-group"><label>Hasta *</label><input type="date" id="rrhh-p-hasta" class="form-input"></div>
        <div class="form-group span-full"><label>Motivo</label><textarea id="rrhh-p-motivo" class="form-input" rows="2"></textarea></div>
      </div>`;
    el('modal-footer').innerHTML = `
      <div style="display:flex;justify-content:flex-end;width:100%;gap:.5rem">
        <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
        <button class="btn-primary" onclick="rrhhGuardarPermiso()">💾 Guardar</button>
      </div>`;
    el('modal-overlay').classList.remove('hidden');
  };

  window.rrhhGuardarPermiso = async function () {
    const employeeId = el('rrhh-p-empleado')?.value;
    const fechaInicio = el('rrhh-p-desde')?.value;
    const fechaFin = el('rrhh-p-hasta')?.value;
    if (!employeeId || !fechaInicio || !fechaFin) { toastMsg('Empleado y fechas son requeridos.', 'warning'); return; }
    try {
      await rrhhApi('POST', '/api/rrhh/permisos', {
        employeeId: Number(employeeId),
        tipo: el('rrhh-p-tipo').value,
        fechaInicio, fechaFin,
        motivo: el('rrhh-p-motivo').value.trim(),
      });
      if (typeof closeAllModals === 'function') closeAllModals();
      toastMsg('Solicitud creada.', 'success');
      rrhhLoadPermisos();
    } catch (e) { toastMsg(e.message, 'error'); }
  };

  window.rrhhResolverPermiso = async function (id, accion) {
    try {
      await rrhhApi('PUT', `/api/rrhh/permisos/${id}/${accion}`);
      toastMsg(accion === 'aprobar' ? 'Solicitud aprobada.' : 'Solicitud rechazada.', 'success');
      rrhhLoadPermisos();
    } catch (e) { toastMsg(e.message, 'error'); }
  };

  // ── Hook: activación del módulo ──────────────────────────
  const _origShowModule = window.showModule;
  window.showModule = function (mod, elm) {
    if (typeof _origShowModule === 'function') _origShowModule(mod, elm);
    if (mod === 'rrhh') rrhhInit();
  };

  document.addEventListener('DOMContentLoaded', () => {
    const moduleEl = document.getElementById('module-rrhh');
    if (!moduleEl) return;
    const obs = new MutationObserver(() => {
      if (!moduleEl.classList.contains('hidden')) rrhhInit();
    });
    obs.observe(moduleEl, { attributes: true, attributeFilter: ['class'] });
  });
})();

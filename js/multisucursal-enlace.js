/* ============================================================
   Tecno Caja — Sucursal conectada a Tecno Caja (multisucursal)
   Configuración → "Sucursal conectada a Tecno Caja".
   - Escribir el código de equipo que generó Tecno Caja o el
     contador al crear la sucursal → esta PC queda enlazada.
   - Estado del enlace, sincronizar ahora y desvincular.
   Solo administrador general (el servidor lo exige).
   ============================================================ */

/* global showToast, showDeleteConfirm, getTecnoCajaAuthToken, DB */

(function () {
  'use strict';

  const MENSAJES_ESTADO = {
    reemplazado: 'Otra PC se conectó como esta sucursal. Esta quedó fuera de la sincronización. Si es un error, pide un código nuevo.',
    revocado: 'Tecno Caja desconectó este equipo. Pide un código nuevo para volver a conectarlo.',
    sucursal_inactiva: 'La sucursal está desactivada en Tecno Caja. Se vuelve a conectar sola cuando la reactiven.',
    licencia_inactiva: 'La licencia de la empresa no está activa. Se vuelve a conectar sola cuando se reactive.',
  };

  const el = (id) => document.getElementById(id);

  function esc(valor) {
    return String(valor == null ? '' : valor)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fecha(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('es-DO', { dateStyle: 'medium', timeStyle: 'short' });
  }

  async function api(method, ruta, body) {
    const tok = typeof getTecnoCajaAuthToken === 'function' ? getTecnoCajaAuthToken() : (typeof DB !== 'undefined' ? DB.authToken : '');
    const res = await fetch(`/api/multisucursal${ruta}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `Error ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function avisar(mensaje, tipo) {
    if (typeof showToast === 'function') showToast(mensaje, tipo);
  }

  // Formato XXXX-XXXX mientras se escribe.
  function formatearCodigo(input) {
    const limpio = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    input.value = limpio.length > 4 ? `${limpio.slice(0, 4)}-${limpio.slice(4)}` : limpio;
  }

  function formularioCodigo(textoBoton) {
    return `
      <div class="form-group">
        <label for="cfg-ms-codigo">Código de equipo</label>
        <input id="cfg-ms-codigo" class="form-input" placeholder="XXXX-XXXX" maxlength="9" autocomplete="off"
          style="font-family:var(--font-mono,Consolas,monospace);letter-spacing:.15em;text-transform:uppercase;max-width:220px">
        <button type="button" class="btn-primary" data-ms="activar" style="margin-top:.6rem">${textoBoton}</button>
        <small class="helper-text">Lo genera Tecno Caja o tu contador al crear la sucursal. Sirve una sola vez y vence en 24 horas.</small>
      </div>`;
  }

  // Con la PC enlazada, las sucursales no se crean desde el POS.
  function bloquearCreacionLocal(enlazada) {
    const grupo = el('cfg-new-branch-group');
    const nota = el('cfg-new-branch-locked');
    if (!grupo || !nota || !enlazada) return;
    grupo.classList.add('hidden');
    nota.textContent = 'Esta PC está conectada a Tecno Caja como sucursal: las sucursales nuevas las crea Tecno Caja o tu contador desde su panel.';
    nota.classList.remove('hidden');
  }

  function render(datos) {
    const cuerpo = el('cfg-multisucursal-body');
    const e = datos.enlace || {};
    let html;
    if (!e.configurado) {
      html = '<p class="helper-text">El servicio central de sucursales todavía no está disponible en esta PC.</p>';
    } else if (!e.tieneToken) {
      html = `<p class="helper-text" style="margin:.25rem 0 .75rem">Si esta PC es una sucursal de una empresa con varias sucursales, conéctala con el código de equipo. Las ventas y la caja siguen funcionando igual con o sin Internet.</p>${formularioCodigo('Conectar esta PC')}`;
    } else {
      const aviso = MENSAJES_ESTADO[e.estado];
      const definitivo = e.estado === 'reemplazado' || e.estado === 'revocado';
      html = `
        <div class="form-group span-full">
          <div style="font-size:.95rem">${e.vinculado ? '🟢' : '🟠'} Sucursal <strong>${esc(e.sucursal?.nombre || '—')}</strong> de <strong>${esc(e.empresa?.nombre || '—')}</strong></div>
          <small class="helper-text">Conectada el ${esc(fecha(e.activadoEn))} · último contacto con Tecno Caja: ${esc(fecha(e.ultimaConexion))}</small>
          ${aviso ? `<div class="config-lock-note" style="margin-top:.6rem">${esc(aviso)}</div>` : ''}
          ${e.ultimoError && !aviso ? `<small class="helper-text" style="color:var(--warning,#f59e0b)">${esc(e.ultimoError.mensaje)} (${esc(fecha(e.ultimoError.at))})</small>` : ''}
        </div>
        ${definitivo ? formularioCodigo('Conectar con el código nuevo') : ''}
        <div class="form-group" style="display:flex;gap:.5rem;flex-wrap:wrap">
          ${definitivo ? '' : '<button type="button" class="btn-secondary" data-ms="sincronizar">Sincronizar ahora</button>'}
          <button type="button" class="btn-secondary" data-ms="desvincular">Desvincular esta PC</button>
        </div>`;
    }
    cuerpo.innerHTML = html;
    bloquearCreacionLocal(Boolean(e.tieneToken));
  }

  let ocupado = false;
  async function accion(nombre) {
    if (ocupado) return;
    try {
      ocupado = true;
      if (nombre === 'activar') {
        const codigo = el('cfg-ms-codigo')?.value || '';
        if (codigo.replace(/[^A-Z0-9]/gi, '').length !== 8) { avisar('El código tiene 8 caracteres (XXXX-XXXX).', 'warning'); return; }
        const r = await api('POST', '/activar', { codigo });
        avisar(`Listo: esta PC es la sucursal ${r.enlace?.sucursal?.nombre || ''}.`, 'success');
      } else if (nombre === 'sincronizar') {
        await api('POST', '/sincronizar');
        avisar('Sincronizado con Tecno Caja.', 'success');
      } else if (nombre === 'desvincular') {
        const ok = typeof showDeleteConfirm === 'function'
          ? await showDeleteConfirm('¿Desvincular esta PC de Tecno Caja? Deja de sincronizar hasta que se conecte con un código nuevo. No se borra ninguna venta.', { confirmText: 'Desvincular' })
          : window.confirm('¿Desvincular esta PC de Tecno Caja?');
        if (!ok) return;
        await api('POST', '/desvincular');
        avisar('Esta PC quedó desvinculada.', 'success');
      }
      await loadConfigSection();
    } catch (error) {
      avisar(error.message, 'error');
    } finally {
      ocupado = false;
    }
  }

  async function loadConfigSection() {
    const seccion = el('cfg-multisucursal-section');
    if (!seccion) return;
    try {
      const datos = await api('GET', '/estado');
      seccion.classList.remove('hidden');
      render(datos);
    } catch (error) {
      // 401/403: no es administrador general → la sección no aplica.
      seccion.classList.add('hidden');
    }
  }

  document.addEventListener('click', (ev) => {
    const boton = ev.target.closest('#cfg-multisucursal-section [data-ms]');
    if (boton) accion(boton.getAttribute('data-ms'));
  });
  document.addEventListener('input', (ev) => {
    if (ev.target && ev.target.id === 'cfg-ms-codigo') formatearCodigo(ev.target);
  });

  window.MultisucursalEnlace = { loadConfigSection, _esc: esc };
})();

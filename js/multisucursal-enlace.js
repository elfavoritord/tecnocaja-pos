/* ============================================================
   Tecno Caja — Sucursal conectada a Tecno Caja (multisucursal)
   Configuración → "Sucursal conectada a Tecno Caja".
   - Escribir el código de equipo que generó Tecno Caja o el
     contador al crear la sucursal → esta PC queda enlazada.
   - Estado del enlace, sincronizar ahora y desvincular.
   - Sincronización con las demás sucursales: pendientes, errores,
     conflictos (vincular), progreso de descarga, rangos NCF que
     asignó la central y bitácora de ciclos.
   - Solo en la sucursal principal: publicar el catálogo a la
     empresa y cambiar un precio en varias sucursales.
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
  const ICONO_NIVEL = { sincronizado: '🟢', sincronizando: '🟡', pendientes: '🟠', sin_conexion: '🔴', error: '🔴' };
  const ESTADO_RANGO = {
    en_espera: 'En espera', en_uso: 'En uso', agotado: 'Agotado', rechazado: 'Rechazado', anulado: 'Anulado',
  };
  const TIPO_CAMBIO = { venta: 'Venta', producto_sucursal: 'Precio/existencia', producto: 'Producto', usuario: 'Usuario', comando_precio: 'Precio en sucursales', ncf_rango: 'Rango NCF' };

  const el = (id) => document.getElementById(id);
  let pollTimer = null;
  let sucursalesEmpresa = [];

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

  function bytes(n) {
    const v = Number(n || 0);
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 / 1024).toFixed(1)} MB`;
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

  function bloqueSincronizacion(s) {
    if (!s) return '';
    const i = s.indicador || {};
    const c = s.ultimoCiclo;
    const barra = s.progreso && s.progreso.total
      ? `<div style="height:6px;border-radius:99px;background:var(--border,#334155);margin:.4rem 0;max-width:420px">
           <div style="height:6px;border-radius:99px;background:var(--primary,#3b82f6);width:${Math.min(100, Math.round((s.progreso.hechos / s.progreso.total) * 100))}%"></div></div>`
      : '';
    let html = `
      <div class="form-group span-full" data-ms-bloque="sincronizacion">
        <label style="font-weight:600">Sincronización con las demás sucursales</label>
        <div style="font-size:.92rem">${ICONO_NIVEL[i.nivel] || '⚪'} ${esc(i.texto || '—')}</div>
        ${barra}
        <small class="helper-text">Última sincronización: ${esc(fecha(s.ultimaSincronizacion))}
          ${s.pendientes ? ` · ${s.pendientes} cambio(s) por subir${s.pendienteDesde ? ` desde ${esc(fecha(s.pendienteDesde))}` : ''}` : ''}
          ${c ? ` · último ciclo: ${c.enviados} enviado(s), ${c.recibidos} recibido(s), ${bytes(c.bytesEnviados)} ↑ ${bytes(c.bytesRecibidos)} ↓, ${c.duracionMs} ms` : ''}</small>
        <small class="helper-text">La venta, la caja y el inventario funcionan igual sin Internet: lo pendiente se envía solo al volver la conexión.</small>
      </div>`;

    if (s.conflictos && s.conflictos.length) {
      html += `
        <div class="form-group span-full">
          <label style="font-weight:600;color:var(--warning,#f59e0b)">Para revisar: ${s.conflictos.length} registro(s) de la empresa chocan con uno de esta PC</label>
          <small class="helper-text">"Vincular" deja el registro de esta PC como el de la empresa (toma su nombre y datos; conserva aquí el precio, la existencia y el historial). Nada se une solo.</small>
          ${s.conflictos.map((x) => `
            <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.35rem 0">
              <span style="flex:1;min-width:220px">${x.tipo === 'usuario' ? '👤' : '📦'} ${esc(x.motivo)}</span>
              <button type="button" class="btn-secondary compact-btn" data-ms="conflicto" data-id="${esc(x.id)}" data-accion="vincular">Vincular</button>
              <button type="button" class="btn-secondary compact-btn" data-ms="conflicto" data-id="${esc(x.id)}" data-accion="ignorar">Ignorar</button>
            </div>`).join('')}
          ${s.conflictos.length > 1 ? '<button type="button" class="btn-secondary compact-btn" data-ms="conflictos-todos">Vincular todos</button>' : ''}
        </div>`;
    }

    if (s.rechazados && s.rechazados.length) {
      html += `
        <div class="form-group span-full">
          <label style="font-weight:600;color:var(--danger,#ef4444)">La central no aceptó ${s.rechazados.length} cambio(s)</label>
          ${s.rechazados.slice(0, 8).map((r) => `<small class="helper-text" style="display:block">• ${esc(TIPO_CAMBIO[r.tipo] || r.tipo)}: ${esc(r.error || '')}</small>`).join('')}
          <small class="helper-text">Corrige el dato (por ejemplo, un código repetido) y pulsa reintentar.</small>
          <button type="button" class="btn-secondary compact-btn" data-ms="reintentar" style="margin-top:.4rem">Reintentar</button>
        </div>`;
    }

    if (s.ncf && s.ncf.length) {
      html += `
        <div class="form-group span-full">
          <label style="font-weight:600">Rangos NCF asignados por la central</label>
          <table class="data-table" style="width:100%;font-size:.82rem"><thead><tr><th>Tipo</th><th>Rango</th><th>Estado</th><th>Disponibles</th><th>Vence</th></tr></thead><tbody>
          ${s.ncf.map((r) => `<tr><td>${esc(r.tipo)}</td><td>${esc(r.desde)}–${esc(r.hasta)}</td>
            <td>${esc(ESTADO_RANGO[r.estado] || r.estado)}${r.motivo ? `<div class="helper-text">${esc(r.motivo)}</div>` : ''}</td>
            <td>${r.disponibles == null ? '—' : esc(r.disponibles)}</td><td>${esc(r.vence || '—')}</td></tr>`).join('')}
          </tbody></table>
          <small class="helper-text">Los asigna Tecno Caja o tu contador. Cuando uno se agota, esta PC pasa sola al siguiente.</small>
        </div>`;
    }
    return html;
  }

  function bloquePrincipal() {
    const otras = sucursalesEmpresa.filter((s) => s.estado === 'activa');
    return `
      <div class="form-group span-full">
        <label style="font-weight:600">Catálogo de la empresa (esta es la sucursal principal)</label>
        <small class="helper-text">Los productos que publiques llegan solos a las demás sucursales con tu precio como sugerido. Cada sucursal mantiene su propio precio y existencia. Al crear o editar un producto eliges si es solo de esta sucursal o de la empresa.</small>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.4rem">
          <button type="button" class="btn-secondary compact-btn" data-ms="publicar">Publicar todo el catálogo activo</button>
        </div>
      </div>
      <div class="form-group span-full">
        <label style="font-weight:600">Cambiar un precio en varias sucursales</label>
        <small class="helper-text">Es la única forma en que cambia el precio de otra sucursal. Se aplica cuando cada una sincroniza.</small>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-top:.4rem">
          <input id="cfg-ms-precio-codigo" class="form-input" placeholder="Código del producto" style="max-width:180px">
          <input id="cfg-ms-precio-valor" class="form-input" type="number" min="0.01" step="0.01" placeholder="Precio" style="max-width:120px">
        </div>
        <div style="display:flex;gap:.9rem;flex-wrap:wrap;margin:.5rem 0">
          ${otras.map((s) => `<label style="display:inline-flex;gap:.35rem;align-items:center;font-weight:400;white-space:nowrap;width:auto;margin:0">
            <input type="checkbox" style="width:auto;height:auto;margin:0;flex:none" data-ms-precio-sucursal="${esc(s.branchUuid)}"> ${esc(s.nombre)}${s.estaPc ? ' (esta)' : ''}</label>`).join('') || '<small class="helper-text">Sin otras sucursales todavía.</small>'}
        </div>
        <button type="button" class="btn-secondary compact-btn" data-ms="precio">Aplicar precio</button>
      </div>`;
  }

  function bloqueBitacora(ciclos) {
    if (!ciclos || !ciclos.length) return '';
    return `
      <details class="form-group span-full">
        <summary style="cursor:pointer;font-weight:600">Bitácora de sincronización (últimos ${ciclos.length})</summary>
        <table class="data-table" style="width:100%;font-size:.8rem;margin-top:.4rem"><thead><tr><th>Inicio</th><th>Resultado</th><th>Enviados</th><th>Recibidos</th><th>Datos</th><th>Duración</th></tr></thead><tbody>
        ${ciclos.map((c) => `<tr><td>${esc(fecha(c.started_at_utc))}</td><td>${esc(c.resultado)}</td><td>${esc(c.confirmados)}/${esc(c.enviados)}${Number(c.rechazados) ? ` (${esc(c.rechazados)} rechazados)` : ''}</td>
          <td>${esc(c.aplicados)}/${esc(c.recibidos)}${Number(c.conflictos) ? ` (${esc(c.conflictos)} conflictos)` : ''}</td>
          <td>${esc(bytes(c.bytes_enviados))} ↑ ${esc(bytes(c.bytes_recibidos))} ↓</td><td>${esc(c.duracion_ms)} ms</td></tr>`).join('')}
        </tbody></table>
      </details>`;
  }

  function render(datos, sincronizacion, ciclos) {
    const cuerpo = el('cfg-multisucursal-body');
    const e = datos.enlace || {};
    let html;
    if (!e.configurado) {
      html = '<p class="helper-text">El servicio central de sucursales está apagado en esta PC (TECNO_CAJA_SYNC_URL=off).</p>';
    } else if (!e.tieneToken) {
      html = `<p class="helper-text" style="margin:.25rem 0 .75rem">Si esta PC es una sucursal de una empresa con varias sucursales, conéctala con el código de equipo. Las ventas y la caja siguen funcionando igual con o sin Internet.</p>${formularioCodigo('Conectar esta PC')}`;
    } else {
      const aviso = MENSAJES_ESTADO[e.estado];
      const definitivo = e.estado === 'reemplazado' || e.estado === 'revocado';
      html = `
        <div class="form-group span-full">
          <div style="font-size:.95rem">${e.vinculado ? '🟢' : '🟠'} Sucursal <strong>${esc(e.sucursal?.nombre || '—')}</strong>${e.sucursal?.esPrincipal ? ' (principal)' : ''} de <strong>${esc(e.empresa?.nombre || '—')}</strong></div>
          <small class="helper-text">Conectada el ${esc(fecha(e.activadoEn))} · último contacto con Tecno Caja: ${esc(fecha(e.ultimaConexion))}</small>
          ${aviso ? `<div class="config-lock-note" style="margin-top:.6rem">${esc(aviso)}</div>` : ''}
          ${e.ultimoError && !aviso ? `<small class="helper-text" style="color:var(--warning,#f59e0b)">${esc(e.ultimoError.mensaje)} (${esc(fecha(e.ultimoError.at))})</small>` : ''}
        </div>
        ${definitivo ? formularioCodigo('Conectar con el código nuevo') : ''}
        ${e.vinculado ? bloqueSincronizacion(sincronizacion) : ''}
        ${e.vinculado && e.sucursal?.esPrincipal ? bloquePrincipal() : ''}
        <div class="form-group" style="display:flex;gap:.5rem;flex-wrap:wrap">
          ${definitivo ? '' : '<button type="button" class="btn-secondary" data-ms="sincronizar">Sincronizar ahora</button>'}
          <button type="button" class="btn-secondary" data-ms="desvincular">Desvincular esta PC</button>
        </div>
        ${e.vinculado ? bloqueBitacora(ciclos) : ''}`;
    }
    cuerpo.innerHTML = html;
    bloquearCreacionLocal(Boolean(e.tieneToken));
    // Mientras descarga o sube, se refresca solo para mostrar el avance.
    clearTimeout(pollTimer);
    if (sincronizacion && sincronizacion.sincronizando) pollTimer = setTimeout(loadConfigSection, 2000);
  }

  let ocupado = false;
  async function accion(boton) {
    const nombre = boton.getAttribute('data-ms');
    if (ocupado) return;
    try {
      ocupado = true;
      if (nombre === 'activar') {
        const codigo = el('cfg-ms-codigo')?.value || '';
        if (codigo.replace(/[^A-Z0-9]/gi, '').length !== 8) { avisar('El código tiene 8 caracteres (XXXX-XXXX).', 'warning'); return; }
        const r = await api('POST', '/activar', { codigo });
        avisar(`Listo: esta PC es la sucursal ${r.enlace?.sucursal?.nombre || ''}. Descargando el catálogo y los usuarios de la empresa…`, 'success');
      } else if (nombre === 'sincronizar') {
        await api('POST', '/sincronizar');
        avisar('Sincronizando con Tecno Caja…', 'success');
      } else if (nombre === 'desvincular') {
        const ok = typeof showDeleteConfirm === 'function'
          ? await showDeleteConfirm('¿Desvincular esta PC de Tecno Caja? Deja de sincronizar hasta que se conecte con un código nuevo. No se borra ninguna venta.', { confirmText: 'Desvincular' })
          : window.confirm('¿Desvincular esta PC de Tecno Caja?');
        if (!ok) return;
        await api('POST', '/desvincular');
        avisar('Esta PC quedó desvinculada.', 'success');
      } else if (nombre === 'conflicto') {
        const r = await api('POST', `/conflictos/${encodeURIComponent(boton.getAttribute('data-id'))}`, { accion: boton.getAttribute('data-accion') });
        avisar(r.ok ? 'Listo.' : (r.motivo || 'No se pudo.'), r.ok ? 'success' : 'warning');
      } else if (nombre === 'conflictos-todos') {
        const r = await api('POST', '/conflictos', { accion: 'vincular' });
        avisar(`${r.resueltos} vinculado(s).`, 'success');
      } else if (nombre === 'reintentar') {
        const r = await api('POST', '/rechazados/reintentar');
        avisar(`${r.reintentados} cambio(s) se vuelven a enviar.`, 'success');
      } else if (nombre === 'publicar') {
        const ok = typeof showDeleteConfirm === 'function'
          ? await showDeleteConfirm('¿Publicar todos los productos activos de esta sucursal al catálogo de la empresa? Llegarán a las demás sucursales con tu precio como sugerido.', { confirmText: 'Publicar' })
          : window.confirm('¿Publicar todo el catálogo activo a la empresa?');
        if (!ok) return;
        const r = await api('POST', '/catalogo/publicar');
        avisar(`${r.publicados} producto(s) se publican a la empresa.`, 'success');
      } else if (nombre === 'precio') {
        const sucursales = [...document.querySelectorAll('[data-ms-precio-sucursal]:checked')].map((x) => x.getAttribute('data-ms-precio-sucursal'));
        const r = await api('POST', '/precio-sucursales', {
          codigo: el('cfg-ms-precio-codigo')?.value || '',
          precio: Number(el('cfg-ms-precio-valor')?.value || 0),
          sucursales,
        });
        avisar(`${r.producto.nombre}: RD$${r.precio} en ${r.sucursales.length} sucursal(es).`, 'success');
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
    engancharClics();
    let datos;
    try {
      datos = await api('GET', '/estado');
    } catch (error) {
      // 401/403: no es administrador general → la sección no aplica.
      seccion.classList.add('hidden');
      return;
    }
    seccion.classList.remove('hidden');
    let sincronizacion = null;
    let ciclos = [];
    if (datos.enlace?.vinculado) {
      [sincronizacion, ciclos] = await Promise.all([
        api('GET', '/sincronizacion').then((r) => r.sincronizacion).catch(() => null),
        api('GET', '/bitacora?limite=10').then((r) => r.ciclos).catch(() => []),
      ]);
      if (datos.enlace.sucursal?.esPrincipal) {
        sucursalesEmpresa = await api('GET', '/sucursales-empresa').then((r) => r.sucursales || []).catch(() => sucursalesEmpresa);
      }
    }
    render(datos, sincronizacion, ciclos);
  }

  // Para los formularios de producto y usuario: la PC es la principal enlazada
  // y las sucursales de la empresa (para elegir a cuáles va algo). Un minuto
  // de caché: abrir y cerrar formularios no llama a la central cada vez.
  let cacheContexto = null;
  async function contextoEmpresa() {
    if (cacheContexto && Date.now() - cacheContexto.at < 60000) return cacheContexto.valor;
    let valor;
    try {
      const datos = await api('GET', '/estado');
      const e = datos.enlace || {};
      if (!e.vinculado) {
        valor = { enlazada: Boolean(e.tieneToken), principal: false, sucursales: [] };
      } else {
        const sucursales = e.sucursal?.esPrincipal
          ? await api('GET', '/sucursales-empresa').then((r) => r.sucursales || []).catch(() => [])
          : [];
        valor = { enlazada: true, principal: Boolean(e.sucursal?.esPrincipal), sucursales };
      }
    } catch (_) {
      valor = { enlazada: false, principal: false, sucursales: [] };
    }
    cacheContexto = { at: Date.now(), valor };
    return valor;
  }

  function casillasSucursales(nombre, sucursales, elegidas) {
    return sucursales.filter((s) => s.estado === 'activa').map((s) => `
      <label style="display:inline-flex;gap:.35rem;align-items:center;font-weight:400;white-space:nowrap;width:auto;margin:0">
        <input type="checkbox" style="width:auto;height:auto;margin:0;flex:none" data-${nombre}="${esc(s.branchUuid)}" ${elegidas.includes(s.branchUuid) ? 'checked' : ''}> ${esc(s.nombre)}${s.estaPc ? ' (esta)' : ''}
      </label>`).join('');
  }

  // Formulario de producto (js/productos.js).
  //  - Principal: a quién va el producto (solo esta sucursal, toda la
  //    empresa o sucursales elegidas).
  //  - Otra sucursal, producto de la empresa: los datos maestros se ven pero
  //    no se cambian aquí (gana la central); precio, existencia y estado sí.
  const CAMPOS_MAESTROS = ['mp-codigo', 'mp-nombre', 'mp-categoria', 'mp-tipo', 'mp-unidad', 'mp-sale-mode',
    'mp-aplica-itbis', 'mp-itbis-modo-pct', 'mp-itbis-modo-monto', 'mp-itbis-monto', 'mp-tracks-stock'];
  async function montarEnProducto(contenedor, prod) {
    if (!contenedor) return;
    const ctx = await contextoEmpresa();
    if (!document.body.contains(contenedor)) return;
    if (ctx.principal && (!prod || prod.origenCatalogo !== 'central')) {
      const alcance = prod?.alcanceEmpresa || 'local';
      const elegidas = prod?.sucursalesEmpresa || [];
      contenedor.innerHTML = `
        <div class="form-group span-full" data-mp-empresa>
          <label>Catálogo de la empresa</label>
          <select id="mp-alcance-empresa" class="form-input">
            <option value="local" ${alcance === 'local' ? 'selected' : ''}>Solo esta sucursal</option>
            <option value="global" ${alcance === 'global' ? 'selected' : ''}>Todas las sucursales de la empresa</option>
            <option value="sucursales" ${alcance === 'sucursales' ? 'selected' : ''}>Solo las sucursales que elija</option>
          </select>
          <div id="mp-sucursales-empresa" style="display:${alcance === 'sucursales' ? 'flex' : 'none'};gap:.9rem;flex-wrap:wrap;margin-top:.5rem">
            ${casillasSucursales('mp-sucursal', ctx.sucursales, elegidas)}
          </div>
          <small style="display:block;margin-top:0.35rem;font-size:0.78rem;color:var(--text2)">Llega solo a las sucursales elegidas con este precio como sugerido; cada una cambia el suyo sin afectar a las demás.</small>
        </div>`;
      contenedor.querySelector('#mp-alcance-empresa').addEventListener('change', (ev) => {
        contenedor.querySelector('#mp-sucursales-empresa').style.display = ev.target.value === 'sucursales' ? 'flex' : 'none';
      });
      return;
    }
    if (ctx.enlazada && !ctx.principal && prod?.origenCatalogo === 'central') {
      contenedor.innerHTML = `<div class="config-lock-note" style="margin:.25rem 0 .5rem">Producto del catálogo de la empresa: el nombre, el código, la categoría y el impuesto los cambia la sucursal principal. Aquí ajustas el precio, la existencia y si está disponible en esta sucursal.</div>`;
      CAMPOS_MAESTROS.forEach((id) => {
        const campo = document.getElementById(id);
        if (campo) { campo.disabled = true; campo.title = 'Lo cambia la sucursal principal'; }
      });
      return;
    }
    contenedor.innerHTML = '';
  }

  function leerDeProducto() {
    const select = document.getElementById('mp-alcance-empresa');
    if (!select) return {};
    const alcanceEmpresa = select.value;
    return {
      alcanceEmpresa,
      sucursalesEmpresa: alcanceEmpresa === 'sucursales'
        ? [...document.querySelectorAll('[data-mp-sucursal]:checked')].map((x) => x.getAttribute('data-mp-sucursal'))
        : [],
    };
  }

  // Formulario de usuario (js/clientes.js, pestaña de configuración).
  async function montarEnUsuario(contenedor, user, alCambiar) {
    if (!contenedor) return;
    const ctx = await contextoEmpresa();
    if (!document.body.contains(contenedor)) return;
    contenedor.querySelector('[data-eu-empresa]')?.remove();
    const bloque = document.createElement('div');
    bloque.setAttribute('data-eu-empresa', '');
    if (ctx.principal && user?.origenUsuario !== 'central') {
      const elegidas = user?.sucursalesEmpresa || [];
      const todas = elegidas.includes('*');
      bloque.innerHTML = `
        <div class="eu-section-title" style="margin-top:0.25rem">Sucursales de la empresa</div>
        <div class="eu-field">
          <label style="display:inline-flex;gap:.35rem;align-items:center;font-weight:400;white-space:nowrap;width:auto;margin:0">
            <input type="checkbox" style="width:auto;height:auto;margin:0;flex:none" data-eu-todas ${todas ? 'checked' : ''}> Puede entrar en todas las sucursales
          </label>
          <div data-eu-lista style="display:${todas ? 'none' : 'flex'};gap:.9rem;flex-wrap:wrap;margin-top:.4rem">
            ${casillasSucursales('eu-sucursal', ctx.sucursales, elegidas)}
          </div>
          <small style="display:block;margin-top:.35rem;opacity:.75">Sin marcar ninguna, el usuario solo existe en esta PC. Los cambios llegan a las sucursales al sincronizar; si lo desactivas aquí, se desactiva en todas.</small>
        </div>`;
      bloque.addEventListener('change', (ev) => {
        if (ev.target.matches('[data-eu-todas]')) bloque.querySelector('[data-eu-lista]').style.display = ev.target.checked ? 'none' : 'flex';
        if (typeof alCambiar === 'function') alCambiar();
      });
    } else if (ctx.enlazada && !ctx.principal && user?.origenUsuario === 'central') {
      bloque.innerHTML = '<div class="config-lock-note" style="margin-top:.5rem">Usuario de la empresa: se crea, se edita y se desactiva en la sucursal principal. Aquí no se puede cambiar.</div>';
    } else {
      return;
    }
    contenedor.appendChild(bloque);
    if (typeof alCambiar === 'function') alCambiar();
  }

  function leerDeUsuario() {
    const bloque = document.querySelector('[data-eu-empresa]');
    if (!bloque || !bloque.querySelector('[data-eu-todas]')) return null;
    if (bloque.querySelector('[data-eu-todas]').checked) return { sucursalesEmpresa: ['*'] };
    const lista = [...bloque.querySelectorAll('[data-eu-sucursal]:checked')].map((x) => x.getAttribute('data-eu-sucursal'));
    return { sucursalesEmpresa: lista.length ? lista : null };
  }

  // El clic se escucha en el propio contenedor y no en document: Configuración
  // (js/app.js, _cfgDrillSection) mueve este contenido a su ventana, y esa
  // ventana corta los clics con event.stopPropagation().
  function engancharClics() {
    const cuerpo = el('cfg-multisucursal-body');
    if (!cuerpo || cuerpo.dataset.msClics === '1') return;
    cuerpo.dataset.msClics = '1';
    cuerpo.addEventListener('click', (ev) => {
      const boton = ev.target.closest('[data-ms]');
      if (boton && cuerpo.contains(boton)) accion(boton);
    });
  }
  document.addEventListener('input', (ev) => {
    if (ev.target && ev.target.id === 'cfg-ms-codigo') formatearCodigo(ev.target);
  });

  window.MultisucursalEnlace = {
    loadConfigSection, contextoEmpresa, montarEnProducto, leerDeProducto, montarEnUsuario, leerDeUsuario, _esc: esc,
  };
})();

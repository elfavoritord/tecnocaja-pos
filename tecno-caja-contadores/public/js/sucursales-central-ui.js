/**
 * js/sucursales-central-ui.js — Pantalla de sucursales de una empresa.
 *
 * La usan el panel de Emilio (tecno-caja-admin, servida desde aquí) y el portal
 * del contador (copia en tecno-caja-contadores/public/js por vendor-sync).
 * Habla con las rutas de server/multisucursal/central/sucursales.routes.js.
 * Los permisos los decide el servidor; `permisos` solo oculta lo que el
 * usuario no puede hacer.
 *
 *   SucursalesUI.montar(elemento, {
 *     api: (method, path, body) => Promise<json>,   // con la sesión del panel
 *     licenseId,
 *     permisos: { limite: bool, estado: bool },     // Emilio: true/true; contador: false/false
 *     avisar: (mensaje, tipo) => void,              // toast del panel
 *   });
 *
 * Colores: variables del portal (--surface, --text…) con respaldo oscuro para
 * el panel de Emilio, que no las define.
 */
(function (global) {
  'use strict';

  var BASE = '/api/sucursales';

  function esc(valor) {
    return String(valor == null ? '' : valor)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fecha(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('es-DO', { dateStyle: 'medium', timeStyle: 'short' });
  }

  var ESTILOS = [
    '.suc-ui{color:var(--text,#e2e8f0);font-size:.85rem}',
    '.suc-ui h4{margin:0 0 .75rem;color:var(--text-sub,#94a3b8);font-size:.85rem;letter-spacing:.05em;text-transform:uppercase}',
    '.suc-ui .suc-fila{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.75rem}',
    '.suc-ui input{padding:.4rem .6rem;background:var(--surface2,rgba(255,255,255,.06));border:1px solid var(--border,rgba(255,255,255,.12));border-radius:6px;color:var(--text,#e2e8f0);font-size:.85rem}',
    '.suc-ui button{padding:.35rem .75rem;border-radius:6px;border:1px solid var(--border,rgba(255,255,255,.12));background:var(--surface2,rgba(255,255,255,.06));color:var(--text,#e2e8f0);cursor:pointer;font-size:.8rem}',
    '.suc-ui button:disabled{opacity:.45;cursor:not-allowed}',
    '.suc-ui button.suc-primario{background:var(--blue,#3b82f6);border-color:var(--blue,#3b82f6);color:#fff}',
    '.suc-ui button.suc-peligro{color:var(--red,#ef4444)}',
    '.suc-ui table{width:100%;border-collapse:collapse;font-size:.82rem}',
    '.suc-ui th{text-align:left;padding:.4rem .6rem;color:var(--text-muted,#64748b);border-bottom:1px solid var(--border,rgba(255,255,255,.07));font-weight:600}',
    '.suc-ui td{padding:.45rem .6rem;border-bottom:1px solid var(--border,rgba(255,255,255,.05));vertical-align:top}',
    '.suc-ui .suc-sub{color:var(--text-muted,#64748b);font-size:.76rem}',
    '.suc-ui .suc-badge{display:inline-block;padding:.1rem .45rem;border-radius:99px;font-size:.72rem;font-weight:600}',
    '.suc-ui .suc-activa{background:var(--green-bg,rgba(16,185,129,.15));color:var(--green,#10b981)}',
    '.suc-ui .suc-inactiva{background:var(--red-bg,rgba(239,68,68,.12));color:var(--red,#ef4444)}',
    '.suc-ui .suc-principal{background:var(--blue-glow,rgba(59,130,246,.18));color:var(--blue,#60a5fa);margin-left:.35rem}',
    '.suc-ui .suc-caja{margin-top:.9rem;padding:.9rem;border-radius:var(--radius,10px);background:var(--surface,rgba(255,255,255,.03));border:1px solid var(--border,rgba(255,255,255,.08))}',
    '.suc-ui .suc-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.5rem}',
    '.suc-ui .suc-aviso{color:var(--orange,#f59e0b);font-size:.8rem;margin:.4rem 0}',
    '.suc-ui .suc-codigo{font-family:var(--font-mono,Consolas,monospace);font-size:1.6rem;letter-spacing:.18em;font-weight:700;color:var(--text,#fff);margin:.3rem 0}',
    '.suc-ui .suc-acciones{display:flex;gap:.35rem;flex-wrap:wrap;justify-content:flex-end}',
  ].join('\n');

  function asegurarEstilos() {
    if (typeof document === 'undefined' || document.getElementById('suc-ui-estilos')) return;
    var style = document.createElement('style');
    style.id = 'suc-ui-estilos';
    style.textContent = ESTILOS;
    document.head.appendChild(style);
  }

  function montar(contenedor, opciones) {
    var api = opciones.api;
    var licenseId = opciones.licenseId;
    var permisos = opciones.permisos || {};
    var avisar = opciones.avisar || function () {};
    var ruta = BASE + '/' + encodeURIComponent(licenseId);
    var estado = { datos: null, editando: null, codigo: null, ocupado: false };

    asegurarEstilos();
    contenedor.classList.add('suc-ui');

    // type="button" siempre: un <button> sin type es "submit" y el manejador
    // de clics lo ignoraría.
    function boton(accion, texto, id, extra) {
      return '<button type="button" data-accion="' + accion + '"' + (id ? ' data-id="' + esc(id) + '"' : '') + (extra || '') + '>' + texto + '</button>';
    }

    function filaSucursal(s) {
      var acciones = boton('editar', 'Editar', s.branchUuid);
      if (s.estado === 'activa') {
        acciones += boton('codigo', 'Código de equipo', s.branchUuid, ' title="Para autorizar una PC en esta sucursal"');
      }
      if (permisos.estado) {
        acciones += s.estado === 'activa'
          ? boton('desactivar', 'Desactivar', s.branchUuid, ' class="suc-peligro"')
          : boton('activar', 'Activar', s.branchUuid);
      }
      return '<tr>'
        + '<td><strong>' + esc(s.nombre) + '</strong>'
        + (s.esPrincipal ? '<span class="suc-badge suc-principal">Principal</span>' : '')
        + '<div class="suc-sub">' + esc([s.codigo, s.encargado].filter(Boolean).join(' · ') || '—') + '</div></td>'
        + '<td>' + esc(s.direccion || '—') + '<div class="suc-sub">' + esc(s.telefono || '') + '</div></td>'
        + '<td><span class="suc-badge suc-' + esc(s.estado) + '">' + (s.estado === 'activa' ? 'Activa' : 'Inactiva') + '</span>'
        + '<div class="suc-sub">Creada ' + esc(fecha(s.createdAt)) + (s.creadaPor && s.creadaPor.nombre ? ' por ' + esc(s.creadaPor.nombre) : '') + '</div></td>'
        + '<td><div class="suc-acciones">' + acciones + '</div></td>'
        + '</tr>';
    }

    function formulario(s) {
      var v = s || {};
      var titulo = s ? 'Editar sucursal' : 'Nueva sucursal';
      return '<div class="suc-caja"><h4>' + titulo + '</h4><form class="suc-form" data-form="' + (s ? 'editar' : 'crear') + '">'
        + '<input name="nombre" placeholder="Nombre *" maxlength="160" required value="' + esc(v.nombre) + '">'
        + '<input name="codigo" placeholder="Código (ej. SUC-02)" maxlength="40" value="' + esc(v.codigo) + '">'
        + '<input name="direccion" placeholder="Dirección" maxlength="255" value="' + esc(v.direccion) + '">'
        + '<input name="telefono" placeholder="Teléfono" maxlength="40" value="' + esc(v.telefono) + '">'
        + '<input name="encargado" placeholder="Encargado" maxlength="160" value="' + esc(v.encargado) + '">'
        + '<div class="suc-fila" style="margin:0"><button type="submit" class="suc-primario">' + (s ? 'Guardar cambios' : 'Crear sucursal') + '</button>'
        + (s ? boton('cancelar', 'Cancelar') : '') + '</div>'
        + '</form></div>';
    }

    function render() {
      var d = estado.datos;
      if (!d) { contenedor.innerHTML = '<p class="suc-sub">Cargando sucursales…</p>'; return; }
      var html = '<h4>Sucursales (' + d.activas + ' de ' + d.maxSucursales + ' permitidas)</h4>';

      if (permisos.limite) {
        html += '<div class="suc-fila"><label class="suc-sub" for="suc-limite">Sucursales permitidas:</label>'
          + '<input id="suc-limite" type="number" min="1" max="200" style="width:80px" value="' + esc(d.maxSucursales) + '">'
          + boton('limite', 'Guardar límite') + '</div>';
      }

      html += d.sucursales.length
        ? '<table><thead><tr><th>Sucursal</th><th>Dirección</th><th>Estado</th><th></th></tr></thead><tbody>'
          + d.sucursales.map(filaSucursal).join('') + '</tbody></table>'
        : '<p class="suc-sub">Esta empresa todavía no tiene sucursales registradas.</p>';

      if (estado.codigo) {
        html += '<div class="suc-caja"><h4>Código para autorizar una PC en ' + esc(estado.codigo.nombre) + '</h4>'
          + '<div class="suc-codigo">' + esc(estado.codigo.codigo) + '</div>'
          + '<div class="suc-sub">Se escribe en la PC de la sucursal. Sirve una sola vez y vence el ' + esc(fecha(estado.codigo.venceEn))
          + ' — anótalo ahora: no se vuelve a mostrar.</div>'
          + '<div class="suc-fila" style="margin:.6rem 0 0">' + boton('copiar', 'Copiar') + boton('cerrar-codigo', 'Listo') + '</div></div>';
      }

      if (estado.editando) {
        html += formulario(estado.editando);
      } else if (d.disponibles > 0) {
        html += formulario(null);
      } else {
        html += '<p class="suc-aviso">Se alcanzó el límite de sucursales de esta empresa.'
          + (permisos.limite ? ' Súbelo arriba para crear otra.' : ' Solo el administrador de Tecno Caja puede ampliarlo.') + '</p>';
      }
      contenedor.innerHTML = html;
    }

    function cargar() {
      return api('GET', ruta).then(function (r) { estado.datos = r; render(); })
        .catch(function (e) { contenedor.innerHTML = '<p class="suc-aviso">' + esc(e.message) + '</p>'; });
    }

    function hacer(promesa, mensaje) {
      if (estado.ocupado) return Promise.resolve();
      estado.ocupado = true;
      return promesa
        .then(function (r) { if (mensaje) avisar(mensaje, 'success'); return r; })
        .catch(function (e) { avisar(e.message, 'error'); throw e; })
        .finally(function () { estado.ocupado = false; });
    }

    function buscar(id) {
      return (estado.datos.sucursales || []).filter(function (s) { return s.branchUuid === id; })[0];
    }

    contenedor.addEventListener('click', function (ev) {
      var pulsado = ev.target.closest('button[data-accion]');
      if (!pulsado) return;
      var accion = pulsado.getAttribute('data-accion');
      var id = pulsado.getAttribute('data-id');
      var s = id ? buscar(id) : null;

      if (accion === 'editar') { estado.editando = s; estado.codigo = null; render(); return; }
      if (accion === 'cancelar') { estado.editando = null; render(); return; }
      if (accion === 'cerrar-codigo') { estado.codigo = null; render(); return; }
      if (accion === 'copiar' && estado.codigo) {
        (navigator.clipboard ? navigator.clipboard.writeText(estado.codigo.codigo) : Promise.reject(new Error('sin portapapeles')))
          .then(function () { avisar('Código copiado.', 'success'); }, function () { avisar('Cópialo a mano.', 'error'); });
        return;
      }
      if (accion === 'limite') {
        var maximo = Number(contenedor.querySelector('#suc-limite').value);
        hacer(api('PUT', ruta + '/limite', { maximo: maximo }), 'Límite actualizado a ' + maximo + '.').then(cargar).catch(function () {});
        return;
      }
      if (accion === 'codigo' && s) {
        hacer(api('POST', ruta + '/' + encodeURIComponent(s.branchUuid) + '/codigo'), null)
          .then(function (r) { estado.codigo = { codigo: r.codigo, venceEn: r.venceEn, nombre: s.nombre }; estado.editando = null; render(); })
          .catch(function () {});
        return;
      }
      if ((accion === 'desactivar' || accion === 'activar') && s) {
        if (accion === 'desactivar' && !global.confirm('¿Desactivar "' + s.nombre + '"? Sus PC dejarán de sincronizar y se libera un cupo.')) return;
        hacer(api('POST', ruta + '/' + encodeURIComponent(s.branchUuid) + '/estado', { estado: accion === 'activar' ? 'activa' : 'inactiva' }),
          accion === 'activar' ? 'Sucursal activada.' : 'Sucursal desactivada.').then(cargar).catch(function () {});
      }
    });

    contenedor.addEventListener('submit', function (ev) {
      var form = ev.target.closest('form[data-form]');
      if (!form) return;
      ev.preventDefault();
      var datos = {};
      ['nombre', 'codigo', 'direccion', 'telefono', 'encargado'].forEach(function (campo) { datos[campo] = form.elements[campo].value; });
      var editando = form.getAttribute('data-form') === 'editar' && estado.editando;
      var peticion = editando
        ? api('PUT', ruta + '/' + encodeURIComponent(estado.editando.branchUuid), datos)
        : api('POST', ruta, datos);
      hacer(peticion, editando ? 'Sucursal actualizada.' : 'Sucursal creada.')
        .then(function () { estado.editando = null; return cargar(); })
        .catch(function () {});
    });

    render();
    cargar();
    return { recargar: cargar };
  }

  var SucursalesUI = { montar: montar, _esc: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = SucursalesUI;
  global.SucursalesUI = SucursalesUI;
})(typeof window !== 'undefined' ? window : globalThis);

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
 *     permisos: { limite: bool, estado: bool, revocar: bool },  // Emilio: todo; contador: nada
 *     avisar: (mensaje, tipo) => void,              // toast del panel
 *   });
 *
 * Debajo de las sucursales lista las PC autorizadas (Sync API): en línea o no
 * según su último latido, versión y eventos pendientes, con alerta si una no
 * sincroniza hace más de 4 horas. Revocar solo Emilio. Después: ventas por
 * sucursal (hoy, ayer, 30 días) y los rangos NCF repartidos por sucursal
 * (asignar y anular: Emilio y el contador de la empresa).
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

  // La PC manda un latido cada 5 min: dos perdidos más un margen = sin conexión.
  var EN_LINEA_MS = 12 * 60 * 1000;
  // Alerta del prompt maestro: sucursal sin sincronizar hace más de 4 horas.
  var ALERTA_SYNC_MS = 4 * 60 * 60 * 1000;
  var TIPOS_NCF = ['B01', 'B02', 'B03', 'B04', 'B11', 'B12', 'B13', 'B14', 'B15', 'B16', 'B17'];
  // e-NCF (factura electrónica): la DGII los autoriza por RNC y se reparten
  // entre sucursales igual que los B (ver sincronizacion-central.js).
  var TIPOS_ECF = [
    ['E31', 'Factura de Crédito Fiscal Electrónica'], ['E32', 'Factura de Consumo Electrónica'],
    ['E33', 'Nota de Débito Electrónica'], ['E34', 'Nota de Crédito Electrónica'],
    ['E41', 'Compras Electrónico'], ['E43', 'Gastos Menores Electrónico'],
    ['E44', 'Regímenes Especiales Electrónico'], ['E45', 'Gubernamental Electrónico'],
    ['E46', 'Exportaciones Electrónico'], ['E47', 'Pagos al Exterior Electrónico'],
  ];
  var ESTADO_RANGO = {
    en_espera: 'Recibido, en espera', en_uso: 'En uso', agotado: 'Agotado', rechazado: 'Rechazado por la sucursal', anulado: 'Anulado',
  };

  function dinero(n) {
    return 'RD$' + Number(n || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  var MODOS = { local: 'Modo local', contingencia: 'Contingencia', sin_bd: 'Sin base de datos' };

  function hace(iso) {
    var t = iso ? new Date(iso).getTime() : NaN;
    if (isNaN(t)) return 'nunca';
    var min = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (min < 1) return 'ahora mismo';
    if (min < 60) return 'hace ' + min + ' min';
    var h = Math.round(min / 60);
    return h < 48 ? 'hace ' + h + ' h' : 'hace ' + Math.round(h / 24) + ' días';
  }

  function situacionEquipo(e) {
    if (e.estado === 'revocado') return { clase: 'inactiva', texto: 'Revocada' };
    if (e.estado === 'reemplazado') return { clase: 'gris', texto: 'Reemplazada' };
    var t = e.ultimaConexion ? new Date(e.ultimaConexion).getTime() : NaN;
    return !isNaN(t) && Date.now() - t < EN_LINEA_MS
      ? { clase: 'activa', texto: 'En línea' }
      : { clase: 'alerta', texto: 'Sin conexión' };
  }

  var ESTILOS = [
    '.suc-ui{color:var(--text,#e2e8f0);font-size:.85rem}',
    '.suc-ui h4{margin:0 0 .75rem;color:var(--text-sub,#94a3b8);font-size:.85rem;letter-spacing:.05em;text-transform:uppercase}',
    '.suc-ui .suc-fila{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.75rem}',
    '.suc-ui input,.suc-ui select{padding:.4rem .6rem;background:var(--surface2,rgba(255,255,255,.06));border:1px solid var(--border,rgba(255,255,255,.12));border-radius:6px;color:var(--text,#e2e8f0);font-size:.85rem}',
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
    '.suc-ui .suc-alerta{background:var(--orange-bg,rgba(245,158,11,.15));color:var(--orange,#f59e0b)}',
    '.suc-ui .suc-gris{background:var(--surface2,rgba(148,163,184,.12));color:var(--text-muted,#94a3b8)}',
    '.suc-ui .suc-anterior td{opacity:.65}',
    '.suc-ui .suc-titulo-equipos{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-top:1.1rem}',
    '.suc-ui .suc-titulo-equipos h4{margin:0}',
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
    // equipos: null = no se pudieron leer (la lista de sucursales sigue).
    // dgii: autorización leída del archivo de la DGII que falta por repartir
    // ({ tipo, desde, totalDesde, totalHasta, autorizacion, cola }).
    var estado = {
      datos: null, equipos: null, ventas: null, rangos: null, verAnteriores: false, editando: null, codigo: null, ocupado: false, dgii: null,
    };

    asegurarEstilos();
    contenedor.classList.add('suc-ui');

    // type="button" siempre: un <button> sin type es "submit" y el manejador
    // de clics lo ignoraría.
    function boton(accion, texto, id, extra) {
      return '<button type="button" data-accion="' + accion + '"' + (id ? ' data-id="' + esc(id) + '"' : '') + (extra || '') + '>' + texto + '</button>';
    }

    function nombreSucursal(branchUuid) {
      var s = (estado.datos.sucursales || []).filter(function (x) { return x.branchUuid === branchUuid; })[0];
      return s ? s.nombre : 'Sucursal borrada';
    }

    // PC activa de la sucursal, para el resumen en su fila.
    function pcDeSucursal(s) {
      if (!estado.equipos) return '';
      var e = estado.equipos.filter(function (x) { return x.branchUuid === s.branchUuid && x.estado === 'activo'; })[0];
      if (!e) return '<div class="suc-sub">Sin PC autorizada</div>';
      var sit = situacionEquipo(e);
      return '<div class="suc-sub">PC: <span class="suc-badge suc-' + sit.clase + '">' + sit.texto + '</span> ' + esc(hace(e.ultimaConexion)) + '</div>';
    }

    function filaEquipo(e) {
      var sit = situacionEquipo(e);
      var l = e.latido || {};
      var p = l.pendientes || {};
      var detalle = [];
      if (e.estado === 'activo' && l.modo && MODOS[l.modo]) detalle.push(MODOS[l.modo]);
      var pendientes = Number(p.salida || 0);
      var rechazados = Number(p.errores || 0);
      var conflictos = Number(p.conflictos || 0);
      var cola = e.estado !== 'activo' ? '—'
        : (pendientes || rechazados || conflictos)
          ? esc(pendientes + ' por enviar')
            + (rechazados ? '<div class="suc-sub" style="color:var(--red,#ef4444)">' + esc(rechazados + ' rechazados') + '</div>' : '')
            + (conflictos ? '<div class="suc-sub" style="color:var(--orange,#f59e0b)">' + esc(conflictos + ' por revisar en la sucursal') + '</div>' : '')
          : 'Al día';
      // Alerta: una PC activa que no sincroniza hace más de 4 horas.
      var sync = e.ultimaSincronizacion || (l && l.ultimaSincronizacion) || null;
      var tSync = sync ? new Date(sync).getTime() : NaN;
      var alertaSync = e.estado === 'activo' && (isNaN(tSync) || Date.now() - tSync > ALERTA_SYNC_MS);
      if (e.estado === 'activo') {
        detalle.push(alertaSync ? '⚠ sin sincronizar ' + (isNaN(tSync) ? 'todavía' : hace(sync)) : 'sincronizó ' + hace(sync));
      }
      var acciones = permisos.revocar && e.estado === 'activo'
        ? boton('revocar', 'Revocar', e.equipoId, ' class="suc-peligro" title="Si la PC se perdió, se dañó o se vendió"')
        : '';
      return '<tr' + (e.estado === 'activo' ? '' : ' class="suc-anterior"') + ' data-equipo="' + esc(e.equipoId) + '">'
        + '<td><strong>' + esc(e.hostname || 'PC sin nombre') + '</strong>'
        + '<div class="suc-sub">' + esc([e.appVersion ? 'v' + e.appVersion : '', 'autorizada ' + fecha(e.activadoEn)].filter(Boolean).join(' · ')) + '</div></td>'
        + '<td>' + esc(nombreSucursal(e.branchUuid)) + '</td>'
        + '<td><span class="suc-badge suc-' + sit.clase + '">' + sit.texto + '</span>'
        + '<div class="suc-sub"' + (alertaSync ? ' style="color:var(--orange,#f59e0b)"' : '') + '>Última conexión ' + esc(hace(e.ultimaConexion)) + (detalle.length ? ' · ' + esc(detalle.join(' · ')) : '') + '</div></td>'
        + '<td>' + cola + '</td>'
        + '<td><div class="suc-acciones">' + acciones + '</div></td>'
        + '</tr>';
    }

    function seccionEquipos() {
      var lista = estado.equipos;
      if (!lista || !lista.length) return '';
      var activos = lista.filter(function (e) { return e.estado === 'activo'; });
      var anteriores = lista.filter(function (e) { return e.estado !== 'activo'; });
      var filas = activos.concat(estado.verAnteriores ? anteriores : []);
      return '<div class="suc-titulo-equipos"><h4>PC autorizadas</h4><div class="suc-acciones">'
        + (anteriores.length ? boton('ver-anteriores', (estado.verAnteriores ? 'Ocultar' : 'Ver') + ' anteriores (' + anteriores.length + ')') : '')
        + boton('recargar', 'Actualizar') + '</div></div>'
        + (filas.length
          ? '<table><thead><tr><th>PC</th><th>Sucursal</th><th>Conexión</th><th>Pendientes</th><th></th></tr></thead><tbody>'
            + filas.map(filaEquipo).join('') + '</tbody></table>'
          : '<p class="suc-sub">Ninguna PC activa. Genera un código de equipo para autorizar una.</p>');
    }

    // Ventas por sucursal con lo que ya sincronizó cada una.
    function seccionVentas() {
      var v = estado.ventas;
      if (!v || !v.sucursales || !v.sucursales.length) return '';
      var hayVentas = v.sucursales.some(function (s) { return s.periodo.ventas > 0; });
      if (!hayVentas) return '';
      return '<div class="suc-titulo-equipos"><h4>Ventas por sucursal</h4></div>'
        + '<table><thead><tr><th>Sucursal</th><th>Hoy</th><th>Ayer</th><th>Últimos 30 días</th></tr></thead><tbody>'
        + v.sucursales.map(function (s) {
          return '<tr data-ventas="' + esc(s.branchUuid) + '"><td><strong>' + esc(s.nombre) + '</strong></td>'
            + '<td>' + dinero(s.hoy.total) + '<div class="suc-sub">' + esc(s.hoy.ventas) + ' venta(s)</div></td>'
            + '<td>' + dinero(s.ayer.total) + '<div class="suc-sub">' + esc(s.ayer.ventas) + ' venta(s)</div></td>'
            + '<td>' + dinero(s.periodo.total) + '<div class="suc-sub">' + esc(s.periodo.ventas) + ' venta(s)</div></td></tr>';
        }).join('')
        + '<tr><td><strong>Total</strong></td><td><strong>' + dinero(v.total.hoy) + '</strong></td><td></td><td><strong>' + dinero(v.total.periodo) + '</strong></td></tr>'
        + '</tbody></table>'
        + '<p class="suc-sub">Con lo que cada sucursal ya sincronizó. Si una PC tiene ventas por enviar, aparece arriba en "PC autorizadas".</p>';
    }

    // Rangos NCF: la autorización de la DGII se reparte en sub-rangos por
    // sucursal para que dos sucursales sin Internet nunca usen el mismo número.
    function seccionNcf() {
      if (!estado.rangos) return '';
      var activas = (estado.datos.sucursales || []).filter(function (s) { return s.estado === 'activa'; });
      var filas = estado.rangos.map(function (r) {
        var usado = r.siguiente != null ? (r.siguiente - r.desde) : 0;
        var estadoTexto = r.estado === 'anulado' ? 'Anulado' : (ESTADO_RANGO[r.estadoSucursal] || 'Asignado, sin recibir');
        var puedeAnular = r.estado !== 'anulado' && ['en_uso', 'agotado'].indexOf(r.estadoSucursal) === -1;
        return '<tr data-rango="' + esc(r.rangoUuid) + '"><td>' + esc(r.sucursal) + '</td><td><strong>' + esc(r.tipo) + '</strong></td>'
          + '<td>' + esc(r.desde) + '–' + esc(r.hasta) + (r.autorizacion ? '<div class="suc-sub">Aut. ' + esc(r.autorizacion) + '</div>' : '')
          + (r.origen === 'sucursal' ? '<div class="suc-sub">Ya lo tenía la sucursal al conectarse</div>' : '') + '</td>'
          + '<td>' + esc(estadoTexto) + (r.motivoSucursal ? '<div class="suc-sub" style="color:var(--red,#ef4444)">' + esc(r.motivoSucursal) + '</div>' : '') + '</td>'
          + '<td>' + esc(Math.max(0, usado)) + ' / ' + esc(r.total) + '<div class="suc-sub">' + esc(r.disponibles) + ' disponibles</div></td>'
          + '<td>' + esc(r.vence || '—') + '</td>'
          + '<td><div class="suc-acciones">' + (puedeAnular ? boton('ncf-anular', 'Anular', r.rangoUuid, ' class="suc-peligro" data-sucursal="' + esc(r.branchUuid) + '"') : '') + '</div></td></tr>';
      }).join('');
      // Lo que quedó por repartir del archivo de la DGII llena el formulario.
      var p = estado.dgii;
      function opcion(tipo, texto) {
        var elegida = p ? p.tipo === tipo : tipo === 'B02';
        return '<option value="' + tipo + '"' + (elegida ? ' selected' : '') + '>' + texto + '</option>';
      }
      var pendiente = p
        ? '<p class="suc-sub">La DGII autorizó <strong>' + esc(p.tipo) + ' ' + esc(p.totalDesde) + '–' + esc(p.totalHasta) + '</strong>'
          + (p.autorizacion ? ' (autorización ' + esc(p.autorizacion) + ')' : '') + '. Falta por repartir: <strong>' + esc(p.tipo) + ' '
          + esc(p.desde) + '–' + esc(p.totalHasta) + '</strong>. Si lo divides entre varias sucursales, baja el «Hasta»: lo que sobre se queda aquí para la siguiente. '
          + ((p.cola || []).length ? 'Después siguen: ' + p.cola.map(function (r) { return esc(r.tipo) + ' ' + esc(r.desde) + '–' + esc(r.hasta); }).join(', ') + '. ' : '')
          + boton('dgii-quitar', 'Quitar') + '</p>'
        : '';
      return '<div class="suc-titulo-equipos"><h4>Comprobantes fiscales (NCF y e-NCF) por sucursal</h4></div>'
        + (filas ? '<table><thead><tr><th>Sucursal</th><th>Tipo</th><th>Rango</th><th>Estado</th><th>Usados</th><th>Vence</th><th></th></tr></thead><tbody>' + filas + '</tbody></table>'
          : '<p class="suc-sub">Todavía no hay rangos NCF ni e-NCF repartidos entre sucursales.</p>')
        + (activas.length ? '<div class="suc-caja"><h4>Asignar un rango a una sucursal</h4>'
          + '<div class="suc-fila"><label class="suc-sub">Subir la autorización de la DGII (XML, Excel o CSV de la Oficina Virtual; uno o varios archivos): '
          + '<input type="file" data-dgii accept=".xml,.csv,.xls,.xlsx" multiple></label></div>'
          + pendiente
          + '<form class="suc-form" data-form="ncf">'
          + '<select name="branchUuid">' + activas.map(function (s) { return '<option value="' + esc(s.branchUuid) + '">' + esc(s.nombre) + '</option>'; }).join('') + '</select>'
          + '<select name="tipo">'
          + '<optgroup label="Comprobantes fiscales (B)">' + TIPOS_NCF.map(function (t) { return opcion(t, t); }).join('') + '</optgroup>'
          + '<optgroup label="Comprobantes electrónicos (e-NCF)">' + TIPOS_ECF.map(function (t) { return opcion(t[0], t[0] + ' · ' + esc(t[1])); }).join('') + '</optgroup>'
          + '</select>'
          + '<input name="desde" type="number" min="1" placeholder="Desde *" required' + (p ? ' value="' + esc(p.desde) + '"' : '') + '>'
          + '<input name="hasta" type="number" min="1" placeholder="Hasta *" required' + (p ? ' value="' + esc(p.totalHasta) + '"' : '') + '>'
          + '<input name="vence" type="date" title="Fecha de vencimiento de la autorización">'
          + '<input name="autorizacion" maxlength="60" placeholder="No. de autorización DGII"' + (p && p.autorizacion ? ' value="' + esc(p.autorizacion) + '"' : '') + '>'
          + '<div class="suc-fila" style="margin:0"><button type="submit" class="suc-primario">Asignar rango</button></div>'
          + '</form><div class="suc-sub">Los números no pueden cruzarse con otro rango de la empresa (ni con uno anulado). La sucursal lo recibe al sincronizar y lo empieza a usar cuando se le agote el actual. '
          + 'Para la factura electrónica (E31, E32…) se reparte igual la autorización que dio la DGII: un pedazo del rango para cada sucursal. Si la sucursal ya emitió números de ese rango, se rechaza.</div></div>' : '');
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
        + '<div class="suc-sub">Creada ' + esc(fecha(s.createdAt)) + (s.creadaPor && s.creadaPor.nombre ? ' por ' + esc(s.creadaPor.nombre) : '') + '</div>'
        + pcDeSucursal(s) + '</td>'
        + '<td><div class="suc-acciones">' + acciones + '</div></td>'
        + '</tr>';
    }

    // La primera que se crea queda como principal para siempre: es la tienda
    // donde ya trabaja el negocio con su PC (la que publica el catálogo).
    function formulario(s, esLaPrimera) {
      var v = s || {};
      var titulo = s ? 'Editar sucursal' : (esLaPrimera ? 'Sucursal principal' : 'Nueva sucursal');
      return '<div class="suc-caja"><h4>' + titulo + '</h4>'
        + (esLaPrimera ? '<p class="suc-aviso">La primera sucursal queda como <strong>principal</strong>: la tienda donde ya trabaja el negocio con su PC actual. '
          + 'Ponle el nombre de esa tienda; la segunda tienda (la PC nueva) se crea después.</p>' : '')
        + '<form class="suc-form" data-form="' + (s ? 'editar' : 'crear') + '">'
        + '<input name="nombre" placeholder="' + (esLaPrimera ? 'Nombre de la tienda donde ya trabaja el negocio *' : 'Nombre *') + '" maxlength="160" required value="' + esc(v.nombre) + '">'
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

      html += seccionEquipos();
      html += seccionVentas();
      html += seccionNcf();

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
        html += formulario(null, !d.sucursales.length);
      } else {
        var soloPrincipal = d.sucursales.length === 1 && d.sucursales[0].esPrincipal;
        html += '<p class="suc-aviso">'
          + (soloPrincipal ? 'Esta empresa solo tiene permitida la sucursal principal. Para conectar la PC de otra tienda hace falta un cupo más.'
            : 'Se alcanzó el límite de sucursales de esta empresa.')
          + (permisos.limite ? ' Súbelo arriba para crear otra.' : ' Solo el administrador de Tecno Caja puede ampliarlo.') + '</p>';
      }
      contenedor.innerHTML = html;
    }

    function cargar() {
      return Promise.all([
        api('GET', ruta),
        // Las PC son informativas: si su lectura falla, las sucursales se ven igual.
        api('GET', ruta + '/equipos').then(function (r) { return r.equipos || []; }, function () { return null; }),
        api('GET', ruta + '/resumen').then(function (r) { return r; }, function () { return null; }),
        api('GET', ruta + '/ncf').then(function (r) { return r.rangos || []; }, function () { return null; }),
      ]).then(function (r) { estado.datos = r[0]; estado.equipos = r[1]; estado.ventas = r[2]; estado.rangos = r[3]; render(); })
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

    function pendienteDe(r, cola) {
      return { tipo: r.tipo, desde: r.desde, totalDesde: r.desde, totalHasta: r.hasta, autorizacion: r.referencia, cola: cola };
    }

    // Se asignó un pedazo de la autorización de la DGII: lo que sobra queda
    // para la siguiente sucursal; si no sobra, pasa al siguiente tipo del archivo.
    function repartido(rango) {
      var p = estado.dgii;
      if (!p || p.tipo !== rango.tipo || rango.desde !== p.desde) return;
      if (rango.hasta < p.totalHasta) {
        p.desde = rango.hasta + 1;
        avisar('Falta por repartir ' + p.tipo + ' ' + p.desde + '–' + p.totalHasta + '.', 'success');
        return;
      }
      var siguiente = (p.cola || []).shift();
      estado.dgii = siguiente ? pendienteDe(siguiente, p.cola) : null;
    }

    // Los archivos de la DGII (js/dgii-autorizacion.js; uno o varios a la vez)
    // llenan el formulario: un rango tras otro, en el orden en que vienen.
    contenedor.addEventListener('change', function (ev) {
      var input = ev.target.closest('input[data-dgii]');
      if (!input || !input.files || !input.files.length) return;
      var lector = global.TcDgiiAutorizacion;
      var archivos = Array.prototype.slice.call(input.files);
      input.value = '';
      if (!lector) { avisar('Esta pantalla no tiene el lector del archivo de la DGII.', 'error'); return; }
      var varios = archivos.length > 1;
      lector.leerArchivos(archivos).then(function (leido) {
        var aprobados = lector.aprobados(leido.rangos).filter(function (r) {
          return TIPOS_NCF.indexOf(r.tipo) >= 0 || TIPOS_ECF.some(function (t) { return t[0] === r.tipo; });
        });
        var fallaron = leido.errores.length
          ? ' No se pudo leer: ' + leido.errores.map(function (e) { return e.archivo; }).join(', ') + '.'
          : '';
        if (!aprobados.length) { avisar('No encontré rangos aprobados en ' + (varios ? 'esos archivos.' : 'ese archivo.') + fallaron, 'error'); return; }
        estado.dgii = pendienteDe(aprobados[0], aprobados.slice(1));
        avisar((aprobados.length > 1
          ? (varios ? 'Los ' + archivos.length + ' archivos traen ' : 'El archivo trae ') + aprobados.length + ' rangos; empieza por ' + aprobados[0].tipo + '. Al terminar de repartirlo sigue el próximo.'
          : 'Listo: ' + aprobados[0].tipo + ' ' + aprobados[0].desde + '–' + aprobados[0].hasta + '. Elige la sucursal y asigna.') + fallaron, 'success');
        render();
      }, function (e) { avisar('No se pudieron leer los archivos: ' + e.message, 'error'); });
    });

    contenedor.addEventListener('click', function (ev) {
      var pulsado = ev.target.closest('button[data-accion]');
      if (!pulsado) return;
      var accion = pulsado.getAttribute('data-accion');
      var id = pulsado.getAttribute('data-id');
      var s = id ? buscar(id) : null;

      if (accion === 'editar') { estado.editando = s; estado.codigo = null; render(); return; }
      if (accion === 'cancelar') { estado.editando = null; render(); return; }
      if (accion === 'cerrar-codigo') { estado.codigo = null; render(); return; }
      if (accion === 'ver-anteriores') { estado.verAnteriores = !estado.verAnteriores; render(); return; }
      if (accion === 'dgii-quitar') { estado.dgii = null; render(); return; }
      if (accion === 'recargar') { cargar(); return; }
      if (accion === 'revocar') {
        var e = (estado.equipos || []).filter(function (x) { return x.equipoId === id; })[0];
        if (!e) return;
        var pc = e.hostname || 'PC sin nombre';
        if (!global.confirm('¿Revocar la PC "' + pc + '" de "' + nombreSucursal(e.branchUuid) + '"?\n\n'
          + 'Deja de sincronizar con Tecno Caja (en la tienda sigue vendiendo). Para volver a conectarla hace falta un código de equipo nuevo.')) return;
        hacer(api('POST', ruta + '/equipos/' + encodeURIComponent(e.equipoId) + '/revocar'), 'PC revocada.').then(cargar).catch(function () {});
        return;
      }
      if (accion === 'ncf-anular') {
        var sucursalRango = pulsado.getAttribute('data-sucursal');
        if (!global.confirm('¿Anular este rango NCF? La sucursal no lo usará y sus números quedan reservados (no se vuelven a asignar).')) return;
        hacer(api('POST', ruta + '/' + encodeURIComponent(sucursalRango) + '/ncf/' + encodeURIComponent(id) + '/anular'), 'Rango anulado.')
          .then(cargar).catch(function () {});
        return;
      }
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
      if (form.getAttribute('data-form') === 'ncf') {
        var rango = {
          tipo: form.elements.tipo.value,
          desde: Number(form.elements.desde.value),
          hasta: Number(form.elements.hasta.value),
          vence: form.elements.vence.value,
          autorizacion: form.elements.autorizacion.value,
        };
        hacer(api('POST', ruta + '/' + encodeURIComponent(form.elements.branchUuid.value) + '/ncf', rango),
          'Rango ' + rango.tipo + ' ' + rango.desde + '–' + rango.hasta + ' asignado.')
          .then(function () { repartido(rango); })
          .then(cargar).catch(function () {});
        return;
      }
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

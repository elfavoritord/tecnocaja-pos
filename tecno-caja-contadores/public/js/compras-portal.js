/* Compras de proveedores que el contador registra para un negocio (pestaña
   «Compras» de Reportes). La compra va a la cola del negocio y su POS la
   registra sola (cantidades, costos, inventario y productos nuevos); si algo no
   cuadra, vuelve aquí para corregirla. Ver server/compras-portal.js. */
/* global esc, fmtMoney, refreshToken, apiCall, toast */
(function () {
  'use strict';

  const ESTADOS = {
    pendiente: ['Pendiente', 'badge-sol-pendiente', 'Se registra cuando el POS del negocio esté conectado.'],
    procesando: ['Registrando…', 'badge-sol-revision', 'El POS la está registrando.'],
    registrada: ['Registrada', 'badge-sol-completada', ''],
    requiere_correccion: ['Corregir', 'badge-sol-rechazada', ''],
    rechazada: ['Rechazada', 'badge-sol-rechazada', ''],
    cancelada: ['Quitada', 'badge-sol-cancelada', ''],
  };

  const st = { negocioId: null, compras: [], soportado: true, productos: null, editando: null, facturas: [], documento: null };
  const e = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const dinero = (n) => (typeof fmtMoney === 'function' ? fmtMoney(n) : `RD$ ${Number(n || 0).toFixed(2)}`);
  const hoy = () => { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  async function cargar(negocioId) {
    st.negocioId = negocioId;
    const caja = document.getElementById('rep-table-inner');
    if (!caja) return;
    if (!negocioId) { caja.innerHTML = '<div class="rep-loading">Elige un negocio.</div>'; return; }
    caja.innerHTML = '<div class="rep-loading"><div class="rep-spinner"></div>Cargando compras…</div>';
    try {
      await refreshToken();
      const r = await apiCall('GET', `/api/compras-portal/${encodeURIComponent(negocioId)}`);
      st.compras = r.compras || [];
      st.soportado = r.soportado !== false;
      pintarLista();
    } catch (err) {
      caja.innerHTML = `<div class="rep-loading">${e(err.message)}</div>`;
    }
  }

  function pintarLista() {
    const caja = document.getElementById('rep-table-inner');
    const aviso = st.soportado ? '' : `<div class="ccp-aviso">Este negocio tiene una versión de Tecno Caja que todavía no recibe compras desde el portal. Cuando actualice el POS, las compras se registran solas.</div>`;
    const filas = st.compras.map((c) => {
      const [nombre, clase, ayuda] = ESTADOS[c.estado] || [c.estado, 'badge-pending', ''];
      const detalle = c.estado === 'registrada'
        ? `Compra #${e(c.purchaseId)} · ${dinero(c.totalRegistrado)}${c.productosCreados ? ` · ${c.productosCreados} producto(s) nuevo(s)` : ''}`
        : (c.bloqueos.length ? c.bloqueos.map((b) => `<div>• ${e(b)}</div>`).join('') : e(c.mensaje || ayuda));
      const acciones = [
        c.estado === 'requiere_correccion' ? `<button class="btn btn-xs btn-primary" data-ccp-corregir="${e(c.id)}">Corregir</button>` : '',
        ['pendiente', 'requiere_correccion'].includes(c.estado) ? `<button class="btn btn-xs btn-secondary" data-ccp-quitar="${e(c.id)}">Quitar</button>` : '',
      ].join(' ');
      return `<tr>
        <td>${e(c.fecha)}</td><td>${e(c.proveedor.nombre || '')}<div class="ccp-sub">${e(c.proveedor.rnc || '')}</div></td>
        <td>${e(c.ncf || '—')}</td><td class="ccp-num">${c.lineas}</td><td class="ccp-num">${dinero(c.totalAproximado)}</td>
        <td><span class="badge ${clase}">${e(nombre)}</span></td><td class="ccp-detalle">${detalle}</td><td>${acciones}</td></tr>`;
    }).join('');
    caja.innerHTML = `
      <div class="ccp-cabeza">
        <div><strong>Compras de proveedores</strong><div class="ccp-sub">Lo que registras aquí entra al POS del negocio: inventario, costos, cuentas por pagar y productos nuevos.</div></div>
        <button class="btn btn-primary btn-sm" id="ccp-nueva" ${st.soportado ? '' : 'disabled'}>Registrar compra</button>
      </div>
      ${aviso}
      ${st.compras.length ? `<div class="rep-tabla-wrap"><table class="ccp-tabla"><thead><tr><th>Fecha</th><th>Proveedor</th><th>NCF</th><th>Líneas</th><th>Total</th><th>Estado</th><th>Detalle</th><th></th></tr></thead><tbody>${filas}</tbody></table></div>`
        : '<div class="rep-loading">Todavía no has registrado compras para este negocio.</div>'}`;
    caja.querySelector('#ccp-nueva')?.addEventListener('click', () => abrir());
    caja.querySelectorAll('[data-ccp-corregir]').forEach((b) => b.addEventListener('click', () => abrir(st.compras.find((c) => c.id === b.dataset.ccpCorregir))));
    caja.querySelectorAll('[data-ccp-quitar]').forEach((b) => b.addEventListener('click', () => quitar(b.dataset.ccpQuitar)));
  }

  async function quitar(id) {
    if (!confirm('¿Quitar esta compra? No se registrará en el negocio.')) return;
    try {
      await apiCall('POST', `/api/compras-portal/${encodeURIComponent(st.negocioId)}/${encodeURIComponent(id)}/cancelar`, {});
      toast('Compra quitada.', 'success');
      cargar(st.negocioId);
    } catch (err) { toast(err.message, 'error'); }
  }

  // Productos del negocio (los que publica su POS) para elegir en cada línea.
  async function productos() {
    if (st.productos?.negocio === st.negocioId) return st.productos.lista;
    const r = await apiCall('GET', `/api/reportes/${encodeURIComponent(st.negocioId)}/datos?tab=productos`).catch(() => ({ rows: [] }));
    const lista = (r.rows || []).filter((p) => p.id).map((p) => ({ id: Number(p.id), codigo: p.codigo || '', nombre: p.nombre || '', costo: Number(p.costo || 0), itbis: Number(p.aplicaItbis) ? 18 : 0 }));
    st.productos = { negocio: st.negocioId, lista };
    return lista;
  }
  const etiquetaProducto = (p) => `${p.codigo ? `${p.codigo} · ` : ''}${p.nombre}`;

  function lineaVacia() { return { descripcion: '', cantidad: 1, costoUnitario: 0, itbisPct: 18, descuento: 0, tipoLinea: 'inventario', productoId: null, accion: '' }; }

  async function abrir(compra = null) {
    st.editando = compra;
    st.documento = null;
    st.facturas = [];
    const lista = await productos();
    let modal = document.getElementById('ccp-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'ccp-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
    // Corregir: la compra tal como se envió (sin el archivo original, que se conserva).
    const detalle = compra ? await apiCall('GET', `/api/compras-portal/${encodeURIComponent(st.negocioId)}/${encodeURIComponent(compra.id)}`) : null;
    st.form = detalle
      ? { encabezado: { ...detalle.encabezado, proveedor: { ...(detalle.encabezado?.proveedor || {}) } }, lineas: (detalle.lineas || []).map((l) => ({ ...l })) }
      : { encabezado: { proveedor: { nombre: '', rnc: '' }, ncf: '', fechaComprobante: hoy(), condicionPago: 'contado', fechaVencimiento: '' }, lineas: [lineaVacia()] };
    modal.innerHTML = `
      <div class="modal-card pm-modal ccp-card" role="dialog" aria-modal="true">
        <div class="pm-cabeza">
          <div><div class="pm-titulo">${compra ? 'Corregir compra' : 'Registrar compra'}</div>
          <div class="pm-sub">Se registra sola en el POS del negocio. Las líneas sin producto se buscan por código o nombre; las que marques «Nuevo» se crean.</div></div>
          <button type="button" class="pm-cerrar" data-ccp="cerrar" aria-label="Cerrar">×</button>
        </div>
        <div class="ccp-cuerpo">
          ${compra?.bloqueos?.length ? `<div class="ccp-aviso ccp-aviso--error"><strong>El negocio la devolvió:</strong>${compra.bloqueos.map((b) => `<div>• ${e(b)}</div>`).join('')}</div>` : ''}
          <div class="ccp-subir">
            <label class="btn btn-secondary btn-sm">Leer XML / Excel del proveedor<input type="file" id="ccp-archivo" accept=".xml,.xlsx,.xls,.csv" hidden></label>
            <select id="ccp-facturas" class="ccp-input" hidden></select>
            <span class="ccp-sub" id="ccp-lectura"></span>
          </div>
          <div class="ccp-grid">
            <label>Proveedor<input class="ccp-input" data-e="proveedor.nombre"></label>
            <label>RNC o cédula<input class="ccp-input" data-e="proveedor.rnc" inputmode="numeric"></label>
            <label>NCF / e-NCF<input class="ccp-input" data-e="ncf" placeholder="B0100000123 o E310000000123"></label>
            <label>Fecha<input type="date" class="ccp-input" data-e="fechaComprobante"></label>
            <label>Condición<select class="ccp-input" data-e="condicionPago"><option value="contado">Contado</option><option value="credito">Crédito</option></select></label>
            <label>Vence<input type="date" class="ccp-input" data-e="fechaVencimiento"></label>
          </div>
          <datalist id="ccp-productos">${lista.map((p) => `<option value="${e(etiquetaProducto(p))}"></option>`).join('')}</datalist>
          <div class="rep-tabla-wrap"><table class="ccp-tabla ccp-lineas"><thead><tr>
            <th>Producto o descripción</th><th>Tipo</th><th>Cant.</th><th>Costo</th><th>Desc.</th><th>ITBIS %</th><th>Nuevo</th><th>Precio venta (con ITBIS)</th><th>Subtotal</th><th></th>
          </tr></thead><tbody id="ccp-filas"></tbody></table></div>
          <button class="btn btn-xs btn-secondary" data-ccp="agregar">+ Línea</button>
          <div class="ccp-totales" id="ccp-totales"></div>
        </div>
        <div class="pm-pie"><span></span><div class="pm-pie__botones">
          <button class="btn btn-secondary" data-ccp="cerrar">Cancelar</button>
          <button class="btn btn-primary" data-ccp="enviar">${compra ? 'Reenviar al negocio' : 'Registrar en el negocio'}</button>
        </div></div>
      </div>`;
    modal.querySelectorAll('[data-ccp="cerrar"]').forEach((b) => b.addEventListener('click', cerrar));
    modal.querySelector('[data-ccp="agregar"]').addEventListener('click', () => { st.form.lineas.push(lineaVacia()); pintarFilas(); });
    modal.querySelector('[data-ccp="enviar"]').addEventListener('click', enviar);
    modal.querySelector('#ccp-archivo').addEventListener('change', (ev) => leerArchivo(ev.target.files[0]));
    modal.querySelector('#ccp-facturas').addEventListener('change', (ev) => usarFactura(Number(ev.target.value)));
    modal.querySelectorAll('[data-e]').forEach((input) => input.addEventListener('input', () => ponerEncabezado(input)));
    if (window.RNCLookup) {
      const rnc = modal.querySelector('[data-e="proveedor.rnc"]');
      const nombre = modal.querySelector('[data-e="proveedor.nombre"]');
      try { window.RNCLookup.attach(rnc, { nameEl: nombre, mode: 'both', onSelect: (r) => { st.form.encabezado.proveedor = { nombre: r.nombre || r.razonSocial || nombre.value, rnc: String(r.rnc || r.cedula || rnc.value).replace(/\D/g, '') }; pintarEncabezado(); } }); } catch (_) { /* sin buscador */ }
    }
    pintarEncabezado();
    pintarFilas();
  }

  function cerrar() { document.getElementById('ccp-modal')?.classList.add('hidden'); }

  function ponerEncabezado(input) {
    const ruta = input.dataset.e.split('.');
    let o = st.form.encabezado;
    for (const k of ruta.slice(0, -1)) { o[k] = o[k] || {}; o = o[k]; }
    o[ruta[ruta.length - 1]] = input.value;
  }
  function pintarEncabezado() {
    const modal = document.getElementById('ccp-modal');
    modal.querySelectorAll('[data-e]').forEach((input) => {
      const valor = input.dataset.e.split('.').reduce((o, k) => (o ? o[k] : ''), st.form.encabezado);
      input.value = valor ?? '';
    });
  }

  function pintarFilas() {
    const lista = st.productos?.lista || [];
    const cuerpo = document.getElementById('ccp-filas');
    cuerpo.innerHTML = st.form.lineas.map((l, i) => {
      const prod = l.productoId ? lista.find((p) => p.id === Number(l.productoId)) : null;
      const servicio = l.tipoLinea === 'servicio_gasto';
      return `<tr data-i="${i}">
        <td><input class="ccp-input" list="ccp-productos" data-l="producto" value="${e(prod ? etiquetaProducto(prod) : l.descripcion)}" placeholder="Busca un producto o escribe la descripción">
          <div class="ccp-sub">${prod ? 'Producto del negocio' : (l.accion === 'nuevo' ? 'Se crea como producto nuevo' : (servicio ? 'Servicio o gasto (no es inventario)' : 'Se busca por código o nombre en el POS'))}</div></td>
        <td><select class="ccp-input" data-l="tipoLinea"><option value="inventario" ${servicio ? '' : 'selected'}>Producto</option><option value="servicio_gasto" ${servicio ? 'selected' : ''}>Servicio/gasto</option></select></td>
        <td><input class="ccp-input ccp-num" type="number" min="0" step="0.01" data-l="cantidad" value="${e(l.cantidad)}"></td>
        <td><input class="ccp-input ccp-num" type="number" min="0" step="0.01" data-l="costoUnitario" value="${e(l.costoUnitario)}"></td>
        <td><input class="ccp-input ccp-num" type="number" min="0" step="0.01" data-l="descuento" value="${e(l.descuento || 0)}"></td>
        <td><select class="ccp-input" data-l="itbisPct">${[18, 16, 0].map((t) => `<option value="${t}" ${Number(l.itbisPct) === t ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
        <td class="ccp-centro"><input type="checkbox" data-l="nuevo" ${l.accion === 'nuevo' ? 'checked' : ''} ${prod || servicio ? 'disabled' : ''}></td>
        <td><input class="ccp-input ccp-num" type="number" min="0" step="0.01" data-l="precio" value="${e(l.precio?.valor || '')}" ${l.accion === 'nuevo' ? '' : 'disabled'} placeholder="${l.accion === 'nuevo' ? 'Opcional' : ''}"></td>
        <td class="ccp-num">${dinero(subtotal(l))}</td>
        <td><button class="btn btn-xs btn-secondary" data-l="quitar" title="Quitar">×</button></td></tr>`;
    }).join('');
    cuerpo.querySelectorAll('tr').forEach((tr) => {
      const l = st.form.lineas[Number(tr.dataset.i)];
      tr.querySelectorAll('[data-l]').forEach((el) => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' || el.dataset.l === 'quitar' ? (el.dataset.l === 'quitar' ? 'click' : 'change') : 'change', () => cambiarLinea(l, el)));
    });
    pintarTotales();
  }

  function cambiarLinea(l, el) {
    const campo = el.dataset.l;
    if (campo === 'quitar') { st.form.lineas.splice(st.form.lineas.indexOf(l), 1); if (!st.form.lineas.length) st.form.lineas.push(lineaVacia()); return setTimeout(pintarFilas, 0); }
    if (campo === 'producto') {
      const p = (st.productos?.lista || []).find((x) => etiquetaProducto(x) === el.value);
      if (p) { l.productoId = p.id; l.descripcion = p.nombre; l.accion = ''; if (!Number(l.costoUnitario)) l.costoUnitario = p.costo; l.itbisPct = p.itbis; }
      else { l.productoId = null; l.descripcion = el.value; }
    } else if (campo === 'nuevo') {
      l.accion = el.checked ? 'nuevo' : '';
      if (!el.checked) delete l.precio;
    } else if (campo === 'precio') {
      l.precio = Number(el.value) > 0 ? { modo: 'incluido', valor: Number(el.value) } : null;
    } else if (campo === 'tipoLinea') {
      l.tipoLinea = el.value;
      if (el.value === 'servicio_gasto') { l.productoId = null; l.accion = ''; delete l.precio; }
    } else {
      // Números: solo cambian el subtotal y los totales (sin rehacer la tabla
      // mientras el usuario pasa de un campo a otro).
      l[campo] = Number(el.value);
      const celda = el.closest('tr')?.querySelector('td:nth-last-child(2)');
      if (celda) celda.textContent = dinero(subtotal(l));
      return pintarTotales();
    }
    // Rehacer la tabla fuera del evento (un «change» llega también al salir del campo).
    setTimeout(pintarFilas, 0);
  }

  const subtotal = (l) => Math.max(0, Number(l.cantidad || 0) * Number(l.costoUnitario || 0) - Number(l.descuento || 0));
  function pintarTotales() {
    let base = 0; let itbis = 0;
    for (const l of st.form.lineas) { const s = subtotal(l); base += s; itbis += s * Number(l.itbisPct || 0) / 100; }
    document.getElementById('ccp-totales').innerHTML = `Subtotal ${dinero(base)} · ITBIS ${dinero(itbis)} · <strong>Total ${dinero(base + itbis)}</strong>`;
  }

  async function leerArchivo(archivo) {
    if (!archivo) return;
    const info = document.getElementById('ccp-lectura');
    info.textContent = 'Leyendo…';
    try {
      const base64 = await new Promise((ok, mal) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = mal; r.readAsDataURL(archivo); });
      const r = await apiCall('POST', `/api/compras-portal/${encodeURIComponent(st.negocioId)}/leer`, { nombre: archivo.name, base64 });
      st.facturas = r.facturas || [];
      st.documento = r.documento || null;
      const sel = document.getElementById('ccp-facturas');
      sel.hidden = st.facturas.length < 2;
      sel.innerHTML = st.facturas.map((f, i) => `<option value="${i}">${e(f.encabezado?.proveedor?.nombre || 'Proveedor')} · ${e(f.encabezado?.ncf || f.encabezado?.numeroDocumento || `factura ${i + 1}`)}</option>`).join('');
      usarFactura(0);
      const errores = st.facturas.flatMap((f) => (f.avisos || []).filter((a) => a.nivel === 'error').map((a) => a.texto));
      info.textContent = `${archivo.name}: ${st.facturas.length} factura(s)${errores.length ? ` · ${errores.length} problema(s): ${errores.slice(0, 2).join(' | ')}` : ''}`;
    } catch (err) {
      info.textContent = '';
      toast(err.message, 'error');
    }
  }

  function usarFactura(i) {
    const f = st.facturas[i];
    if (!f) return;
    st.form = {
      encabezado: { ...f.encabezado, proveedor: { ...(f.encabezado?.proveedor || {}) }, fechaVencimiento: f.encabezado?.fechaVencimiento || '' },
      lineas: (f.lineas || []).map((l) => ({
        descripcion: l.descripcion, codigo: l.codigo || '', codigoBarras: l.codigoBarras || '', codigoProveedor: l.codigoProveedor || '',
        cantidad: l.cantidad, costoUnitario: l.costoUnitario, descuento: l.descuento || 0, itbisPct: l.itbisPct, tipoLinea: l.tipoLinea === 'servicio_gasto' ? 'servicio_gasto' : 'inventario',
        productoId: null, accion: '', ...(l.precio ? { precio: { modo: l.precio.modo || 'incluido', valor: l.precio.valor } } : {}),
      })),
    };
    pintarEncabezado();
    pintarFilas();
  }

  async function enviar() {
    const boton = document.querySelector('#ccp-modal [data-ccp="enviar"]');
    boton.disabled = true;
    try {
      const cuerpo = { encabezado: st.form.encabezado, lineas: st.form.lineas, ...(st.documento ? { documento: st.documento } : {}) };
      if (st.editando) await apiCall('PUT', `/api/compras-portal/${encodeURIComponent(st.negocioId)}/${encodeURIComponent(st.editando.id)}`, cuerpo);
      else await apiCall('POST', `/api/compras-portal/${encodeURIComponent(st.negocioId)}`, cuerpo);
      toast('Compra enviada: se registra en el POS del negocio.', 'success');
      cerrar();
      cargar(st.negocioId);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      boton.disabled = false;
    }
  }

  window.ComprasPortal = { cargar, abrir, _estado: () => st };
})();

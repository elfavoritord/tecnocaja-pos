'use strict';

// ─── Panel de Delivery — Tecno Caja ─────────────────────────────────────────────
// Pedidos: polling cada 15 s.  Mapa repartidores: SSE en tiempo real.

let _dpInterval    = null;  // polling pedidos + stats
let _dpSse         = null;  // EventSource para ubicaciones
let _dpMap         = null;
let _dpMarkers     = {};
let _dpActiveFilter = 'activos';

// ── Init / stop ───────────────────────────────────────────────────────────────

function initDeliveryPanel() {
  _dpActiveFilter = 'activos';
  _setTabActive('activos');

  if (!_dpMap) {
    _dpInitMap();
  } else {
    setTimeout(() => _dpMap.invalidateSize(), 200);
  }

  // Carga inicial
  refreshDeliveryPanel();

  // Polling pedidos + stats cada 15 s
  if (_dpInterval) clearInterval(_dpInterval);
  _dpInterval = setInterval(() => {
    _dpLoadStats();
    _dpLoadOrders(_dpActiveFilter);
  }, 15000);

  // SSE para ubicaciones en tiempo real
  _dpStartLocationStream();
}

function stopDeliveryPanel() {
  if (_dpInterval) { clearInterval(_dpInterval); _dpInterval = null; }
  _dpStopLocationStream();
}

async function refreshDeliveryPanel() {
  await Promise.all([
    _dpLoadStats(),
    _dpLoadOrders(_dpActiveFilter),
    _dpRenderRepartidoresLocales(),
  ]);
  const el = document.getElementById('dp-last-refresh');
  if (el) el.textContent = new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── SSE — ubicaciones en tiempo real ─────────────────────────────────────────

function _dpStartLocationStream() {
  _dpStopLocationStream();
  try {
    _dpSse = new EventSource('/api/delivery/ubicaciones/stream');

    _dpSse.onopen = () => {
      _setText('dp-map-status', '🟢 En línea');
    };

    _dpSse.onmessage = (e) => {
      try {
        const repartidores = JSON.parse(e.data);
        _dpUpdateMapMarkers(repartidores);
        _dpRenderRepartidoresLocales(); // refresca badge GPS en la lista
      } catch (_) {}
    };

    _dpSse.onerror = () => {
      _setText('dp-map-status', '🔴 Sin señal — reintentando…');
      // El navegador reintenta automáticamente
    };
  } catch (_) {
    // EventSource no disponible (ej. contexto sin red)
  }
}

function _dpStopLocationStream() {
  if (_dpSse) { _dpSse.close(); _dpSse = null; }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

async function _dpLoadStats() {
  try {
    const res = await api.request('/api/delivery/stats');
    const s = res.stats || {};
    _setText('dp-stat-asignado',  s.asignado  ?? 0);
    _setText('dp-stat-camino',    s.en_camino  ?? 0);
    _setText('dp-stat-entregado', s.entregado  ?? 0);
    _setText('dp-stat-incidencia',s.incidencia ?? 0);
  } catch (_) {}
}

// ── Orders list ───────────────────────────────────────────────────────────────

function setDeliveryFilter(filter, el) {
  _dpActiveFilter = filter;
  _setTabActive(filter);
  _dpLoadOrders(filter);
}

function _setTabActive(filter) {
  document.querySelectorAll('#dp-tabs .dp-tab').forEach((t) => {
    t.classList.toggle('dp-tab--active', t.dataset.filter === filter);
  });
}

async function _dpLoadOrders(filter) {
  const container = document.getElementById('dp-orders-list');
  if (!container) return;
  try {
    let pedidos = [];
    if (filter === 'activos') {
      const [r1, r2] = await Promise.all([
        api.request('/api/delivery/pedidos?estado=asignado&limite=80'),
        api.request('/api/delivery/pedidos?estado=en_camino&limite=80'),
      ]);
      pedidos = [...(r1.pedidos || []), ...(r2.pedidos || [])];
      pedidos.sort((a, b) => _tsMs(b.creadoEn) - _tsMs(a.creadoEn));
    } else if (filter === 'incidencia') {
      const r = await api.request('/api/delivery/pedidos?estado=incidencia&limite=50');
      pedidos = r.pedidos || [];
    } else {
      const r = await api.request('/api/delivery/pedidos?estado=entregado&limite=50');
      pedidos = r.pedidos || [];
    }
    _dpRenderOrders(container, pedidos);
  } catch (err) {
    container.innerHTML = `<div class="dp-empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function _dpRenderOrders(container, pedidos) {
  if (!pedidos.length) {
    container.innerHTML = '<div class="dp-empty">No hay pedidos en este momento.</div>';
    return;
  }
  container.innerHTML = pedidos.map(_dpOrderCard).join('');
}

const _ESTADO_META = {
  asignado:   { label: 'Asignado',   cls: 'dp-badge--asignado' },
  en_camino:  { label: 'En camino',  cls: 'dp-badge--camino' },
  entregado:  { label: 'Entregado',  cls: 'dp-badge--entregado' },
  incidencia: { label: 'Incidencia', cls: 'dp-badge--incidencia' },
};

function _dpOrderCard(p) {
  const meta = _ESTADO_META[p.estado] || { label: p.estado, cls: 'dp-badge--asignado' };
  const hora = p.creadoEn
    ? new Date(_tsMs(p.creadoEn)).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
    : '';
  const lastInc = p.incidencias?.length
    ? escapeHtml(p.incidencias[p.incidencias.length - 1].tipo || 'Incidencia')
    : null;

  return `
    <div class="dp-card ${p.estado === 'incidencia' ? 'dp-card--incidencia' : ''}"
         onclick="dpShowDetail('${escapeHtml(p.id)}')">
      <div class="dp-card-top">
        <span class="dp-invoice">#${escapeHtml(p.numeroFactura || p.id)}</span>
        <span class="dp-badge ${meta.cls}">${meta.label}</span>
      </div>
      <div class="dp-card-client">
        <strong>${escapeHtml(p.clienteNombre || 'Cliente')}</strong>
        ${p.clienteTelefono ? `<span class="dp-phone">📞 ${escapeHtml(p.clienteTelefono)}</span>` : ''}
      </div>
      <div class="dp-card-address">📍 ${escapeHtml(p.clienteDireccion || 'Sin dirección')}</div>
      <div class="dp-card-footer">
        <span class="dp-rep">🛵 ${escapeHtml(p.repartidorNombre || '—')}</span>
        <span class="dp-total">RD$ ${Number(p.total || 0).toLocaleString('es-DO', { minimumFractionDigits: 2 })}</span>
        <span class="dp-time">${hora}</span>
      </div>
      ${lastInc ? `<div class="dp-inc-alert">⚠️ ${lastInc}</div>` : ''}
    </div>`;
}

// ── Order detail modal ────────────────────────────────────────────────────────

async function dpShowDetail(pedidoId) {
  try {
    const res = await api.request(`/api/delivery/pedidos/${encodeURIComponent(pedidoId)}`);
    const p = res.pedido;
    if (!p) return;

    const prods = (p.productos || []).map((pr) => `
      <tr>
        <td>${escapeHtml(pr.nombre || '—')}</td>
        <td style="text-align:center">${pr.cantidad ?? 1}</td>
        <td style="text-align:right">RD$ ${Number(pr.precio || 0).toFixed(2)}</td>
      </tr>`).join('');

    const incs = (p.incidencias || []).map((inc) => {
      const ts = inc.timestamp?._seconds
        ? new Date(inc.timestamp._seconds * 1000).toLocaleString('es-DO')
        : (inc.timestamp || '');
      return `
        <div class="dp-detail-inc">
          <strong>${escapeHtml(inc.tipo || 'Incidencia')}</strong>
          <p>${escapeHtml(inc.descripcion || '')}</p>
          <small>${ts}</small>
        </div>`;
    }).join('');

    const meta = _ESTADO_META[p.estado] || { label: p.estado, cls: 'dp-badge--asignado' };
    const mapsUrl = p.clienteLat && p.clienteLng
      ? `https://maps.google.com/?q=${p.clienteLat},${p.clienteLng}`
      : `https://maps.google.com/?q=${encodeURIComponent(p.clienteDireccion || '')}`;

    const html = `
      <div id="dp-modal" class="dp-modal-overlay" onclick="dpCloseModal()">
        <div class="dp-modal" onclick="event.stopPropagation()">
          <div class="dp-modal-header">
            <h3>Pedido #${escapeHtml(p.numeroFactura || pedidoId)}</h3>
            <span class="dp-badge ${meta.cls}">${meta.label}</span>
            <button class="dp-modal-close" onclick="dpCloseModal()">✕</button>
          </div>
          <div class="dp-modal-body">
            <div class="dp-detail-grid">
              <div class="dp-detail-block">
                <h4>Cliente</h4>
                <p><strong>${escapeHtml(p.clienteNombre || '—')}</strong></p>
                ${p.clienteTelefono ? `<p>📞 ${escapeHtml(p.clienteTelefono)}</p>` : ''}
                <p>📍 ${escapeHtml(p.clienteDireccion || 'Sin dirección')}</p>
                <a href="${mapsUrl}" target="_blank" class="dp-maps-link">Ver en Google Maps →</a>
              </div>
              <div class="dp-detail-block">
                <h4>Repartidor</h4>
                <p>🛵 <strong>${escapeHtml(p.repartidorNombre || '—')}</strong></p>
                <p>Estado: <span class="dp-badge ${meta.cls}">${meta.label}</span></p>
                ${p.entregadoEn?._seconds ? `<p>Entregado: ${new Date(p.entregadoEn._seconds * 1000).toLocaleString('es-DO')}</p>` : ''}
              </div>
            </div>

            <h4 style="margin:1rem 0 0.5rem">Productos</h4>
            <table class="dp-prod-table">
              <thead><tr><th>Producto</th><th>Cant.</th><th>Precio</th></tr></thead>
              <tbody>${prods}</tbody>
            </table>
            <div class="dp-total-row">Total: <strong>RD$ ${Number(p.total || 0).toLocaleString('es-DO', { minimumFractionDigits: 2 })}</strong></div>

            ${incs ? `<h4 style="margin:1rem 0 0.5rem">⚠️ Incidencias</h4><div class="dp-incs">${incs}</div>` : ''}
            ${p.notasInternas ? `<h4 style="margin:1rem 0 0.5rem">Notas internas</h4><p>${escapeHtml(p.notasInternas)}</p>` : ''}
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (err) {
    if (typeof showToast === 'function') showToast('Error al cargar el detalle.', 'error');
  }
}

function dpCloseModal() {
  document.getElementById('dp-modal')?.remove();
}

// ── Map ───────────────────────────────────────────────────────────────────────

function _dpInitMap() {
  const el = document.getElementById('dp-map');
  if (!el || !window.L) return;
  _dpMap = window.L.map('dp-map').setView([18.735, -70.163], 12);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
  }).addTo(_dpMap);
}

function _dpUpdateMapMarkers(repartidores) {
  if (!_dpMap || !window.L) return;

  let hasAny = false;

  repartidores.forEach((rep) => {
    const loc = rep.ultimaUbicacion;
    if (!loc?.lat || !loc?.lng) return;
    hasAny = true;

    const tsStr = loc.timestamp?._seconds
      ? new Date(loc.timestamp._seconds * 1000).toLocaleTimeString('es-DO')
      : '';
    const popupHtml = `<b>${escapeHtml(rep.nombre || 'Repartidor')}</b>${tsStr ? `<br>📍 ${tsStr}` : ''}`;

    if (_dpMarkers[rep.uid]) {
      // Mover marcador existente con animación suave
      _dpMarkers[rep.uid].setLatLng([loc.lat, loc.lng]);
      _dpMarkers[rep.uid].setPopupContent(popupHtml);
    } else {
      // Crear nuevo marcador
      const icon = window.L.divIcon({
        html: `<div class="dp-map-pin">🛵<span class="dp-map-pin-name">${escapeHtml(rep.nombre || '')}</span></div>`,
        className: '',
        iconSize: [70, 44],
        iconAnchor: [35, 44],
      });
      _dpMarkers[rep.uid] = window.L.marker([loc.lat, loc.lng], { icon })
        .addTo(_dpMap)
        .bindPopup(popupHtml);
    }
  });

  // Eliminar marcadores de repartidores que ya no están activos
  const uidsActivos = new Set(repartidores.map((r) => r.uid));
  Object.keys(_dpMarkers).forEach((uid) => {
    if (!uidsActivos.has(uid)) {
      _dpMarkers[uid].remove();
      delete _dpMarkers[uid];
    }
  });

  _setText('dp-map-status', hasAny ? '🟢 En línea' : 'Ningún repartidor ha compartido ubicación aún.');
}

// ── Repartidores locales (POS) ────────────────────────────────────────────────

function _dpRenderRepartidoresLocales() {
  const container = document.getElementById('dp-repartidores-locales');
  if (!container) return;

  const reps = (window.DB?.users || []).filter(
    (u) => ['Delivery', 'Repartidor'].includes(u.rol) && u.estado === 'Activo',
  );

  if (!reps.length) {
    container.innerHTML = '<p class="dp-empty" style="font-size:0.8rem">No hay usuarios con rol Repartidor activos. Créalos en <strong>Usuarios</strong>.</p>';
    return;
  }

  // Determina cuáles están activos en el mapa (tienen marcador = tienen ubicación reciente)
  const enMapa = new Set(Object.keys(_dpMarkers));

  container.innerHTML = reps.map((rep) => {
    const hasFbUid  = Boolean(rep.firebase_uid);
    const gpsActivo = hasFbUid && enMapa.has(rep.firebase_uid);
    return `
      <div class="dp-rep-local">
        <div class="dp-rep-local-info">
          <span class="dp-rep-local-name">
            <span class="dp-gps-dot ${gpsActivo ? 'dp-gps-dot--on' : ''}"></span>
            ${escapeHtml(rep.nombre || rep.usuario)}
          </span>
          <span class="dp-rep-local-sub">${escapeHtml(rep.email || rep.telefono || '')}</span>
        </div>
        <div class="dp-rep-local-status">
          ${hasFbUid
            ? `<span class="dp-badge ${gpsActivo ? 'dp-badge--camino' : 'dp-badge--asignado'}">${gpsActivo ? 'GPS activo' : 'Sin señal'}</span>`
            : `<button class="btn-secondary" style="font-size:0.72rem;padding:0.2rem 0.6rem" onclick="dpSyncRepartidor(${rep.id})">Sincronizar</button>`
          }
        </div>
      </div>`;
  }).join('');
}

async function dpSyncRepartidor(posUserId) {
  try {
    const res = await api.request(`/api/delivery/repartidores/sync/${posUserId}`, { method: 'POST' });
    if (res.ok) {
      if (typeof showToast === 'function') showToast('Repartidor sincronizado con Firebase.', 'success');
      if (typeof loadAppData === 'function') await loadAppData();
      _dpRenderRepartidoresLocales();
    }
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Error: ${err.message}`, 'error');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _tsMs(ts) {
  if (!ts) return 0;
  if (typeof ts === 'string') return new Date(ts).getTime();
  if (ts._seconds != null) return ts._seconds * 1000;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  return 0;
}

function _setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

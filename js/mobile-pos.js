let mobileSocket = null;

function mobileText(value) {
  return typeof window.translateCatalogText === 'function'
    ? window.translateCatalogText(String(value || ''))
    : String(value || '');
}

async function refreshMobilePosModule() {
  try {
    const [config, sessions] = await Promise.all([
      api.getMobileConfig(),
      api.getMobileSessions()
    ]);
    DB.mobileConfig = config;
    DB.mobileSessions = sessions;
    renderMobilePosModule();
    connectMobileSocket();
  } catch (error) {
    showToast(error.message || mobileText('No se pudo cargar el POS móvil'), 'error');
  }
}

function renderMobilePosModule() {
  const config = DB.mobileConfig || {};
  const sessions = DB.mobileSessions || [];
  const ipEl = document.getElementById('mobile-pos-ip');
  const hostEl = document.getElementById('mobile-pos-host');
  const countEl = document.getElementById('mobile-pos-sessions-count');
  const itemsEl = document.getElementById('mobile-pos-items-count');
  const qrEl = document.getElementById('mobile-pos-qr');
  const listEl = document.getElementById('mobile-pos-session-list');
  const toggleButton = document.getElementById('mobile-access-toggle');
  const publicBaseUrl = String(config.publicBaseUrl || '').trim();
  const preferredBaseUrl = String(config.preferredBaseUrl || '').trim();
  const flutterMobileUrl = String(config.flutterMobileUrl || '').trim();
  const connectionCode = String(config.connectionCode || '').trim().toUpperCase();
  const qrConnectionValue = String(config.qrConnectionValue || '').trim();

  if (ipEl) ipEl.textContent = connectionCode || '—';
  if (hostEl) {
    const accessLabel = publicBaseUrl
      ? mobileText('URL pública activa')
      : mobileText('Solo red local');
    hostEl.textContent = `${config.appName || 'POS'} · ${config.currency || 'RD$'} · ${mobileText(config.enabled === false ? 'Bloqueado' : 'Activo')} · ${accessLabel}`;
  }
  if (countEl) countEl.textContent = sessions.length;
  if (itemsEl) itemsEl.textContent = sessions.reduce((sum, item) => sum + Number(item.itemCount || 0), 0);
  if (toggleButton) {
    toggleButton.textContent = mobileText(config.enabled === false ? 'Activar acceso móvil' : 'Bloquear acceso móvil');
    toggleButton.className = config.enabled === false ? 'btn-primary' : 'btn-danger';
  }
  if (qrEl) {
    const mobileUrl = flutterMobileUrl || `${preferredBaseUrl || `http://${config.host || '127.0.0.1'}:${config.port || '3000'}`}/flutter-mobile-pos`;
    const qrPayload = qrConnectionValue || connectionCode || mobileUrl;
    renderMobilePosQr({
      qrPayload,
      connectionCode,
      publicBaseUrl,
      mobileUrl
    });
  }

  if (listEl) {
    listEl.innerHTML = sessions.map((session) => `
      <div class="mobile-session-card">
        <div>
          <div style="font-weight:700">${session.deviceName}</div>
          <div class="products-subtle">${session.userName ? `${session.userName} · ${session.userRole || ''}` : (session.deviceId || session.id)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-weight:700">${fmt(session.total || 0)}</div>
          <div class="products-subtle">${session.itemCount || 0} ${mobileText('item(s)')} · ${mobileText(session.status === 'blocked' ? 'Bloqueado' : 'Activo')}</div>
        </div>
        <div class="mobile-session-actions">
          <button class="btn-edit" onclick="importMobileCartToSale('${session.id}')">🛒 ${mobileText('Importar a venta')}</button>
          <button class="btn-secondary" onclick="openMobileSessionDetails('${session.id}')">👁 ${mobileText('Ver')}</button>
          <button class="${session.status === 'blocked' ? 'btn-primary' : 'btn-secondary'}" onclick="toggleMobileSessionBlock('${session.id}', ${session.status === 'blocked'})">${mobileText(session.status === 'blocked' ? 'Desbloquear' : 'Bloquear')}</button>
          <button class="btn-danger" onclick="confirmDeleteMobileSession('${session.id}')">${mobileText('Eliminar')}</button>
        </div>
      </div>
    `).join('') || `<div class="notif-empty">${mobileText('No hay teléfonos conectados todavía.')}</div>`;
  }

  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('module-posmovil'));
  if (typeof initConfigAccordions === 'function') initConfigAccordions('#module-posmovil');
}

async function renderMobilePosQr({ qrPayload, connectionCode, publicBaseUrl, mobileUrl }) {
  const qrEl = document.getElementById('mobile-pos-qr');
  if (!qrEl) return;
  const urlCaption = publicBaseUrl
    ? mobileText('Escanea este QR o escribe el código en la app móvil para conectar desde cualquier red.')
    : mobileText('Escanea este QR o escribe el código en la app móvil dentro de tu red local.');
  const footerLabel = publicBaseUrl
    ? mobileText('Acceso remoto activo')
    : mobileText('Acceso local del POS');
  const actionButtons = `
    <div class="mobile-code-actions">
      <button class="btn-secondary" type="button" onclick="copyMobileConnectionCode()">${mobileText('Copiar código')}</button>
      <button class="btn-primary" type="button" onclick="regenerateMobileConnectionCode()">${mobileText('Regenerar código')}</button>
    </div>
  `;
  try {
    const response = await api.generateQr(qrPayload);
    qrEl.innerHTML = `
      <div class="mobile-code-shell">
        <div class="mobile-code-hero">
          <span class="mobile-code-label">${mobileText('Código de conexión')}</span>
          <strong class="mobile-code-value">${connectionCode || '—'}</strong>
          <p class="mobile-code-caption">${urlCaption}</p>
          ${actionButtons}
        </div>
        <div class="mobile-code-qr-card">
          <div class="mobile-code-qr-title">${mobileText('Escanea desde tu teléfono')}</div>
          <img src="${response.dataUrl}" alt="${mobileText('QR POS móvil')}" class="mobile-code-qr-image">
          <small class="mobile-code-qr-hint">${mobileText('El QR ya guarda la conexión para que el delivery no tenga que escribir IP.')}</small>
        </div>
        <div class="mobile-code-footer">
          <span class="mobile-code-footer-label">${footerLabel}</span>
          <code class="mobile-code-url">${publicBaseUrl || mobileUrl}</code>
        </div>
      </div>
    `;
  } catch (_error) {
    qrEl.innerHTML = `
      <div class="mobile-code-shell">
        <div class="mobile-code-hero">
          <span class="mobile-code-label">${mobileText('Código de conexión')}</span>
          <strong class="mobile-code-value">${connectionCode || '—'}</strong>
          <p class="mobile-code-caption">${urlCaption}</p>
          ${actionButtons}
        </div>
        <div class="mobile-code-qr-card">
          <div class="mobile-code-qr-title">${mobileText('Código QR no disponible')}</div>
          <div class="mobile-code-qr-fallback">${qrPayload}</div>
          <small class="mobile-code-qr-hint">${mobileText('Puedes seguir entrando con el código manual mientras el QR se genera de nuevo.')}</small>
        </div>
        <div class="mobile-code-footer">
          <span class="mobile-code-footer-label">${footerLabel}</span>
          <code class="mobile-code-url">${publicBaseUrl || mobileUrl}</code>
        </div>
      </div>
    `;
  }
}

async function copyMobileConnectionCode() {
  const connectionCode = String(DB.mobileConfig?.connectionCode || '').trim().toUpperCase();
  if (!connectionCode) {
    showToast(mobileText('Todavía no hay un código de conexión disponible.'), 'warning');
    return;
  }

  try {
    await navigator.clipboard.writeText(connectionCode);
    showToast(`${mobileText('Código copiado')}: ${connectionCode}`, 'success');
  } catch (_error) {
    showToast(mobileText('No se pudo copiar el código automáticamente.'), 'error');
  }
}

async function regenerateMobileConnectionCode() {
  const confirmed = window.confirm(mobileText('Se generará un código nuevo y el anterior dejará de funcionar. ¿Deseas continuar?'));
  if (!confirmed) return;

  try {
    const payload = await api.regenerateMobileConnectionCode(getActorPayload());
    DB.mobileConfig = {
      ...(DB.mobileConfig || {}),
      ...(payload || {})
    };
    renderMobilePosModule();
    const syncOk = payload?.syncResult?.synced === true;
    showToast(
      syncOk
        ? `${mobileText('Código regenerado')}: ${payload.connectionCode || '—'}`
        : `${mobileText('Código regenerado')}: ${payload.connectionCode || '—'} · ${mobileText('Firebase pendiente')}`,
      syncOk ? 'success' : 'warning'
    );
  } catch (error) {
    showToast(error.message || mobileText('No se pudo regenerar el código móvil'), 'error');
  }
}

function connectMobileSocket() {
  if (mobileSocket || typeof io === 'undefined') return;
  mobileSocket = io();
  mobileSocket.on('mobile:sessions-updated', (sessions) => {
    DB.mobileSessions = sessions || [];
    renderMobilePosModule();
  });
  mobileSocket.on('mobile:settings-updated', (settings) => {
    DB.mobileConfig = {
      ...(DB.mobileConfig || {}),
      ...(settings || {})
    };
    renderMobilePosModule();
  });
}

async function openMobileSessionDetails(sessionId) {
  try {
    const detail = await api.getMobileSession(sessionId);
    document.getElementById('modal-title').textContent = `${mobileText('Carrito móvil')} · ${detail.deviceName}`;
    document.getElementById('modal-body').innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>${mobileText('Código')}</th><th>${mobileText('Producto')}</th><th>${mobileText('Cant.')}</th><th>${mobileText('Precio')}</th><th>${mobileText('Subtotal')}</th></tr>
          </thead>
          <tbody>
            ${(detail.items || []).map((item) => `
              <tr>
                <td style="font-family:var(--font-mono)">${item.codigo}</td>
                <td>${item.nombre}</td>
                <td>${item.cantidad}</td>
                <td>${fmt(item.precio)}</td>
                <td>${fmt(item.subtotal)}</td>
              </tr>
            `).join('') || `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text3)">${mobileText('Carrito vacío')}</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn-secondary" onclick="closeAllModals()">${mobileText('Cerrar')}</button>
      <button class="btn-primary" onclick="importMobileCartToSale('${sessionId}')">🛒 ${mobileText('Importar a venta')}</button>
    `;
    document.getElementById('modal-overlay').classList.remove('hidden');
    if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
  } catch (error) {
    showToast(error.message || mobileText('No se pudo abrir la sesión móvil'), 'error');
  }
}

async function importMobileCartToSale(sessionId) {
  try {
    const detail = await api.getMobileSession(sessionId);
    DB.saleItems = (detail.items || []).map((item) => ({
      id: item.productId,
      codigo: item.codigo,
      nombre: item.nombre,
      precio: Number(item.precio || 0),
      qty: Number(item.cantidad || 0),
      descuento: 0,
      itbis: Number(DB.config.itbis || 0),
      total: Number(item.subtotal || 0)
    }));
    closeAllModals();
    showModule('ventas', document.querySelector('.nav-item[data-module="ventas"]'));
    if (typeof renderSaleTable === 'function') renderSaleTable();
    if (typeof updateTotals === 'function') updateTotals();
    showToast(`${mobileText('Carrito móvil importado desde')} ${detail.deviceName}`, 'success');
  } catch (error) {
    showToast(error.message || mobileText('No se pudo importar el carrito móvil'), 'error');
  }
}

async function toggleMobileAccess() {
  const enabled = DB.mobileConfig?.enabled !== false;
  const nextEnabled = !enabled;
  try {
    const settings = await api.updateMobileSettings({
      enabled: nextEnabled,
      ...getActorPayload()
    });
    DB.mobileConfig = {
      ...(DB.mobileConfig || {}),
      ...settings
    };
    renderMobilePosModule();
    showToast(mobileText(nextEnabled ? 'Acceso móvil activado' : 'Acceso móvil bloqueado'), 'success');
  } catch (error) {
    showToast(error.message || mobileText('No se pudo cambiar el acceso móvil'), 'error');
  }
}

async function toggleMobileSessionBlock(sessionId, unblock = false) {
  try {
    await api.blockMobileSession(sessionId, {
      blocked: !unblock,
      ...getActorPayload()
    });
    await refreshMobilePosModule();
    showToast(mobileText(unblock ? 'Sesión móvil desbloqueada' : 'Sesión móvil bloqueada'), 'success');
  } catch (error) {
    showToast(error.message || mobileText('No se pudo actualizar la sesión móvil'), 'error');
  }
}

function confirmDeleteMobileSession(sessionId) {
  const session = (DB.mobileSessions || []).find((item) => item.id === sessionId);
  document.getElementById('modal-title').textContent = mobileText('Eliminar sesión móvil');
  document.getElementById('modal-body').innerHTML = `
    <p style="line-height:1.6;color:var(--text2)">
      ${mobileText('Vas a eliminar por completo la sesión móvil de')} <strong style="color:var(--text)">${session?.deviceName || mobileText('este teléfono')}</strong>.
      ${mobileText('Esta acción borrará también su carrito sincronizado.')}
    </p>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">${mobileText('Cancelar')}</button>
    <button class="btn-danger" onclick="deleteMobileSession('${sessionId}')">${mobileText('Eliminar sesión')}</button>
  `;
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
}

async function deleteMobileSession(sessionId) {
  try {
    await api.deleteMobileSession(sessionId, getActorPayload());
    closeAllModals();
    await refreshMobilePosModule();
    showToast(mobileText('Sesión móvil eliminada'), 'success');
  } catch (error) {
    showToast(error.message || mobileText('No se pudo eliminar la sesión móvil'), 'error');
  }
}

window.refreshMobilePosModule = refreshMobilePosModule;
window.openMobileSessionDetails = openMobileSessionDetails;
window.importMobileCartToSale = importMobileCartToSale;
window.toggleMobileAccess = toggleMobileAccess;
window.toggleMobileSessionBlock = toggleMobileSessionBlock;
window.confirmDeleteMobileSession = confirmDeleteMobileSession;
window.deleteMobileSession = deleteMobileSession;
window.copyMobileConnectionCode = copyMobileConnectionCode;
window.regenerateMobileConnectionCode = regenerateMobileConnectionCode;

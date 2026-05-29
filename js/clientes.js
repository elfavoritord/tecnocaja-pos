// ===== TECNO_CAJA - CLIENTES =====

function clientText(value) {
  return typeof window.translateUiString === 'function'
    ? window.translateUiString(String(value || ''), getCurrentLanguage())
    : String(value || '');
}

function reportText(value) {
  return typeof window.translateCatalogText === 'function'
    ? window.translateCatalogText(String(value || ''))
    : clientText(value);
}

function userText(value) {
  return typeof window.translateCatalogText === 'function'
    ? window.translateCatalogText(String(value || ''))
    : clientText(value);
}

function moduleLocale() {
  return typeof getCurrentLocale === 'function' ? getCurrentLocale() : 'es-DO';
}

function getClientePendingCreditSales(clienteId) {
  const normalizedClientId = Number(clienteId || 0);
  if (!normalizedClientId) return [];

  return (DB.ventas || [])
    .filter((sale) => Number(sale?.clientId || 0) === normalizedClientId)
    .filter((sale) => String(sale?.metodo || '').trim() === 'credito')
    .filter((sale) => String(sale?.estadoFiscal || 'emitida').trim() !== 'cancelada')
    .map((sale) => {
      const total = Number(sale?.total || 0);
      const recibido = Number(sale?.recibido || 0);
      const pendiente = Math.max(0, Number((total - recibido).toFixed(2)));
      return {
        invoiceNumber: sale.id,
        fecha: sale.fecha,
        total,
        recibido,
        pendiente
      };
    })
    .filter((sale) => sale.pendiente > 0)
    .sort((a, b) => new Date(a.fecha || 0) - new Date(b.fecha || 0));
}

function getClienteBalancePendiente(clienteId, fallbackBalance = 0) {
  const pendingSales = getClientePendingCreditSales(clienteId);
  if (pendingSales.length) {
    return Number(
      pendingSales.reduce((sum, sale) => sum + Number(sale.pendiente || 0), 0).toFixed(2)
    );
  }
  return Number(fallbackBalance || 0);
}

function loadClientesTable(filter) {
  const tbody = document.getElementById('clientes-tbody');
  if (!tbody) return;
  let list = DB.clientes;
  if (filter) {
    const normalizedFilter = String(filter || '').toLowerCase();
    list = list.filter((c) =>
      String(c?.nombre || '').toLowerCase().includes(normalizedFilter)
      || String(c?.cedula || '').includes(filter)
    );
  }
  const balances = new Map(list.map((cliente) => [cliente.id, getClienteBalancePendiente(cliente.id, cliente.balance)]));
  tbody.innerHTML = list.map(c => `
    <tr>
      <td style="font-weight:600">${c.nombre}</td>
      <td style="font-family:var(--font-mono)">${c.telefono}</td>
      <td>${c.referencia || '—'}</td>
      <td>${c.linkUbicacion ? `<a href="${c.linkUbicacion}" target="_blank" rel="noopener">${clientText('Abrir mapa')}</a>` : '—'}</td>
      <td style="font-family:var(--font-mono)">${c.cedula}</td>
      <td style="font-family:var(--font-mono);color:${(balances.get(c.id) || 0)>0?'var(--warning)':'var(--success)'};font-weight:700">${fmt(balances.get(c.id) || 0)}</td>
      <td style="font-family:var(--font-mono)">${fmt(c.limiteCredito)}</td>
      <td>
        ${(balances.get(c.id) || 0) > 0 ? `<button class="btn-secondary" onclick="openClienteCobroModal(${c.id})" style="margin-right:4px">💵 ${clientText('Cobrar')}</button>` : ''}
        <button class="btn-edit" onclick="editCliente(${c.id})" style="margin-right:4px">✏ ${clientText('Ver')}</button>
        <button class="btn-danger" onclick="deleteCliente(${c.id})">✕</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text3)">${clientText('No se encontraron clientes')}</td></tr>`;
}

function filterClientes(val) { loadClientesTable(val); }

function clearClienteModalError() {
  const box = document.getElementById('client-modal-error');
  if (!box) return;
  box.textContent = '';
  box.classList.add('hidden');
}

function showClienteModalError(message) {
  const box = document.getElementById('client-modal-error');
  if (!box) return;
  box.textContent = message;
  box.classList.remove('hidden');
}

function syncCreditLimitFields() {
  const hasLimit = document.getElementById('cl-credit-withlimit')?.checked;
  const wrap = document.getElementById('cl-limite-wrap');
  if (wrap) wrap.classList.toggle('hidden', !hasLimit);
}
window.syncCreditLimitFields = syncCreditLimitFields;

function openClienteModal(id) {
  const c = id ? DB.clientes.find(x => x.id === id) : null;
  const tieneLimit = c ? (Number(c.limiteCredito || 0) > 0) : false;
  document.getElementById('modal-title').textContent = clientText(c ? 'Editar Cliente' : 'Nuevo Cliente');
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <div id="client-modal-error" class="span-full inline-form-alert hidden"></div>
      <div class="form-group span-full"><label>${clientText('Nombre Completo')}</label><input type="text" id="cl-nombre" class="form-input" value="${c?c.nombre:''}" placeholder="${clientText('Nombre del cliente')}"></div>
      <div class="form-group"><label>${clientText('Teléfono')}</label><input type="text" id="cl-tel" class="form-input" value="${c?c.telefono:''}" placeholder="809-000-0000"></div>
      <div class="form-group"><label>${clientText('Cédula / RNC')}</label><input type="text" id="cl-cedula" class="form-input" value="${c?c.cedula:''}" placeholder="000-0000000-0"></div>
      <div class="form-group span-full"><label>${clientText('Dirección')}</label><input type="text" id="cl-dir" class="form-input" value="${c?c.direccion:''}"></div>
      <div class="form-group span-full"><label>${clientText('Referencia')}</label><input type="text" id="cl-ref" class="form-input" value="${c?c.referencia||'':''}" placeholder="${clientText('Casa azul, frente al parque')}"></div>
      <div class="form-group span-full"><label>${clientText('Link de ubicación')}</label><input type="text" id="cl-mapa" class="form-input" value="${c?c.linkUbicacion||'':''}" placeholder="https://maps.google.com/..."></div>
      <div class="form-group span-full">
        <label>${clientText('Crédito')}</label>
        <div class="credit-limit-toggle">
          <label class="credit-radio-option">
            <input type="radio" name="cl-credit-type" id="cl-credit-nolimit" value="nolimit"
              ${!tieneLimit ? 'checked' : ''} onchange="syncCreditLimitFields()">
            <span class="credit-radio-label">
              <span class="credit-radio-icon">♾️</span>
              <span class="credit-radio-name">${clientText('Sin límite')}</span>
              <span class="credit-radio-sub">${clientText('Puede llevar lo que quiera')}</span>
            </span>
          </label>
          <label class="credit-radio-option">
            <input type="radio" name="cl-credit-type" id="cl-credit-withlimit" value="withlimit"
              ${tieneLimit ? 'checked' : ''} onchange="syncCreditLimitFields()">
            <span class="credit-radio-label">
              <span class="credit-radio-icon">💳</span>
              <span class="credit-radio-name">${clientText('Con límite')}</span>
              <span class="credit-radio-sub">${clientText('Establece un monto máximo')}</span>
            </span>
          </label>
        </div>
        <div id="cl-limite-wrap" class="credit-limit-amount ${tieneLimit ? '' : 'hidden'}">
          <label>${clientText('Monto máximo (RD$)')}</label>
          <input type="number" id="cl-limite" class="form-input" value="${c && tieneLimit ? c.limiteCredito : ''}" min="1" placeholder="Ej: 5,000">
        </div>
      </div>
    </div>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">${clientText('Cancelar')}</button>
    <button class="btn-primary" onclick="saveCliente(${id||'null'})">💾 ${clientText('Guardar')}</button>
  `;
  document.getElementById('modal-overlay').classList.remove('hidden');
  clearClienteModalError();
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
  if (window.RNCLookup) {
    const cedulaEl = document.getElementById('cl-cedula');
    if (cedulaEl && !cedulaEl.dataset.rncAttached) {
      cedulaEl.dataset.rncAttached = '1';
      RNCLookup.attach(cedulaEl, {
        nameEl: document.getElementById('cl-nombre'),
        mode: 'both',
      });
    }
  }
}

function openClienteDetailModal(id) {
  const c = DB.clientes.find(x => x.id === id);
  if (!c) return;

  const pendingSales = getClientePendingCreditSales(id);
  const totalPendiente = getClienteBalancePendiente(id, c.balance);
  const ventasCliente = (DB.ventas || []).filter(v => Number(v.clientId || 0) === id);
  const totalCompras = ventasCliente.reduce((sum, v) => sum + Number(v.total || 0), 0);
  const totalFacturas = ventasCliente.length;
  const inicial = (c.nombre || '?').charAt(0).toUpperCase();

  document.getElementById('modal-title').textContent = clientText('Ficha del cliente');
  document.getElementById('modal-body').innerHTML = `
    <div class="cliente-detail">

      <div class="cliente-detail-header">
        <div class="cliente-detail-avatar">${inicial}</div>
        <div class="cliente-detail-header-info">
          <div class="cliente-detail-header-name">${escapeHtml(c.nombre)}</div>
          ${c.cedula ? `<div class="cliente-detail-header-sub">🪪 ${escapeHtml(c.cedula)}</div>` : ''}
          ${c.telefono ? `<div class="cliente-detail-header-sub">📱 ${escapeHtml(c.telefono)}</div>` : ''}
        </div>
      </div>

      <div class="cliente-detail-stats">
        <div class="cliente-stat-card">
          <span class="cliente-stat-label">${clientText('Total compras')}</span>
          <span class="cliente-stat-val">${fmt(totalCompras)}</span>
        </div>
        <div class="cliente-stat-card ${totalPendiente > 0 ? 'danger' : ''}">
          <span class="cliente-stat-label">${clientText('Balance pendiente')}</span>
          <span class="cliente-stat-val ${totalPendiente > 0 ? 'red' : 'green'}">${fmt(totalPendiente)}</span>
        </div>
        <div class="cliente-stat-card">
          <span class="cliente-stat-label">${clientText('Facturas')}</span>
          <span class="cliente-stat-val">${totalFacturas}</span>
        </div>
      </div>

      <div class="cliente-detail-info">
        ${c.direccion ? `
        <div class="cliente-info-row">
          <span class="cliente-info-icon">📍</span>
          <div class="cliente-info-body">
            <span class="cliente-info-label">${clientText('Dirección')}</span>
            <span class="cliente-info-val">${escapeHtml(c.direccion)}</span>
            ${c.referencia ? `<span class="cliente-info-sub">${escapeHtml(c.referencia)}</span>` : ''}
          </div>
        </div>` : ''}
        ${c.linkUbicacion ? `
        <div class="cliente-info-row">
          <span class="cliente-info-icon">🗺️</span>
          <div class="cliente-info-body">
            <span class="cliente-info-label">${clientText('Ubicación')}</span>
            <a href="${escapeHtml(c.linkUbicacion)}" target="_blank" rel="noopener" class="cliente-info-link">${clientText('Ver en mapa')}</a>
          </div>
        </div>` : ''}
        <div class="cliente-info-row">
          <span class="cliente-info-icon">💳</span>
          <div class="cliente-info-body">
            <span class="cliente-info-label">${clientText('Límite de crédito')}</span>
            <span class="cliente-info-val">${fmt(c.limiteCredito || 0)}</span>
          </div>
        </div>
      </div>

      ${pendingSales.length ? `
      <div class="cliente-detail-section">
        <div class="cliente-detail-section-title">⚠️ ${clientText('Facturas a crédito pendientes')}</div>
        <div class="table-wrap" style="margin:0">
          <table class="data-table">
            <thead>
              <tr>
                <th>${clientText('Factura')}</th>
                <th>${clientText('Fecha')}</th>
                <th>${clientText('Total')}</th>
                <th>${clientText('Abonado')}</th>
                <th>${clientText('Pendiente')}</th>
              </tr>
            </thead>
            <tbody>
              ${pendingSales.map(sale => `
                <tr>
                  <td style="font-family:var(--font-mono);font-weight:700">${escapeHtml(String(sale.invoiceNumber))}</td>
                  <td style="font-size:0.82rem">${escapeHtml(formatReportDateTime(sale.fecha))}</td>
                  <td style="font-family:var(--font-mono)">${fmt(sale.total)}</td>
                  <td style="font-family:var(--font-mono)">${fmt(sale.recibido)}</td>
                  <td style="font-family:var(--font-mono);font-weight:700;color:var(--warning)">${fmt(sale.pendiente)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}

    </div>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">${clientText('Cerrar')}</button>
    <button class="btn-ghost" onclick="closeAllModals();openClienteModal(${id})">✏ ${clientText('Editar')}</button>
    ${totalPendiente > 0 ? `<button class="btn-primary" onclick="closeAllModals();openClienteCobroModal(${id})">💰 ${clientText('Cobrar')}</button>` : ''}
  `;
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
}

function editCliente(id) { openClienteDetailModal(id); }

function openClienteCobroModal(id) {
  const cliente = DB.clientes.find((item) => item.id === id);
  const clientName = cliente?.nombre || clientText('Cliente');
  const sales = getClientePendingCreditSales(id);
  const totalPendiente = getClienteBalancePendiente(id, cliente?.balance || 0);

  if (!sales.length && !totalPendiente) {
    showToast(clientText('Este cliente no tiene facturas a crédito pendientes.'), 'info');
    return;
  }

  document.getElementById('modal-title').textContent = `${clientText('Cobrar crédito')} · ${clientName}`;
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-grid">
      <div class="span-full" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0.75rem">
        <div class="report-card" style="margin:0">
          <div class="report-card-header">${clientText('Cliente')}</div>
          <div class="report-card-sub" style="color:var(--text);font-weight:700">${escapeHtml(clientName)}</div>
        </div>
        <div class="report-card" style="margin:0">
          <div class="report-card-header">${clientText('Balance pendiente')}</div>
          <div class="report-card-val" style="font-size:1.2rem">${fmt(totalPendiente)}</div>
        </div>
        <div class="report-card" style="margin:0">
          <div class="report-card-header">${clientText('Facturas pendientes')}</div>
          <div class="report-card-val" style="font-size:1.2rem">${sales.length}</div>
        </div>
      </div>

      <div class="form-group">
        <label>${clientText('Monto a cobrar')}</label>
        <input type="number" id="client-credit-payment-amount" class="form-input" min="0.01" step="0.01" value="${totalPendiente > 0 ? totalPendiente.toFixed(2) : ''}">
      </div>
      <div class="form-group">
        <label>${clientText('Método de cobro')}</label>
        <select id="client-credit-payment-method" class="form-input">
          <option value="efectivo">${clientText('Efectivo')}</option>
          <option value="transferencia">${clientText('Transferencia')}</option>
          <option value="tarjeta">${clientText('Tarjeta')}</option>
        </select>
      </div>
      <div class="form-group span-full">
        <label>${clientText('Nota')}</label>
        <input type="text" id="client-credit-payment-note" class="form-input" value="${clientText('Cobro de crédito a cliente')}">
      </div>

      <div class="span-full">
        <div class="table-wrap" style="margin:0">
          <table class="data-table">
            <thead>
              <tr>
                <th>${clientText('Factura')}</th>
                <th>${clientText('Fecha')}</th>
                <th>${clientText('Total')}</th>
                <th>${clientText('Abonado')}</th>
                <th>${clientText('Pendiente')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${sales.map((sale) => `
                <tr>
                  <td style="font-family:var(--font-mono);font-weight:700">${escapeHtml(String(sale.invoiceNumber))}</td>
                  <td style="font-size:0.82rem">${escapeHtml(formatReportDateTime(sale.fecha))}</td>
                  <td style="font-family:var(--font-mono)">${fmt(sale.total)}</td>
                  <td style="font-family:var(--font-mono)">${fmt(sale.recibido)}</td>
                  <td style="font-family:var(--font-mono);font-weight:700;color:var(--warning)">${fmt(sale.pendiente)}</td>
                  <td>
                    <div class="cobro-row-actions">
                      <button class="cobro-row-btn cobro-row-btn--print" title="${clientText('Ver / Imprimir recibo')}"
                        onclick="imprimirFacturaCobro('${sale.invoiceNumber}')">🖨️</button>
                      <button class="cobro-row-btn cobro-row-btn--share" title="${clientText('Compartir por WhatsApp')}"
                        onclick="compartirFacturaCobro('${sale.invoiceNumber}', ${id})">📱</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
  const clienteParaWa = DB.clientes.find(c => c.id === id);
  const tieneWa = Boolean(clienteParaWa?.telefono);

  document.getElementById('modal-footer').innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">${clientText('Cerrar')}</button>
    ${tieneWa ? `<button class="btn-cobro-wa" onclick="notificarCobroWhatsApp(${id})" title="${clientText('Notificar al cliente por WhatsApp')}">
      <span class="btn-cobro-wa-icon">📱</span> WhatsApp
    </button>` : ''}
    <button class="btn-secondary" onclick="abonarFacturaCobro(${totalPendiente})">💰 ${clientText('Abonar')}</button>
    <button class="btn-primary" onclick="saveClienteCobro(${id})">✅ ${clientText('Registrar cobro')}</button>
  `;
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
}

function abonarFacturaCobro(monto) {
  const input = document.getElementById('client-credit-payment-amount');
  if (input) {
    input.value = Number(monto).toFixed(2);
    input.focus();
    input.select();
  }
}
window.abonarFacturaCobro = abonarFacturaCobro;

function imprimirFacturaCobro(invoiceNumber) {
  const venta = (DB.ventas || []).find(v => v.id === invoiceNumber);
  if (!venta) { showToast(clientText('Factura no encontrada.'), 'warning'); return; }
  if (typeof showReceipt === 'function') showReceipt(venta);
}
window.imprimirFacturaCobro = imprimirFacturaCobro;

async function compartirFacturaCobro(invoiceNumber, clienteId) {
  const venta = (DB.ventas || []).find(v => v.id === invoiceNumber);
  const cliente = DB.clientes.find(c => c.id === clienteId);
  if (!venta || !cliente) { showToast(clientText('Factura no encontrada.'), 'warning'); return; }
  if (typeof sendReceiptToWhatsApp !== 'function') { showToast(clientText('WhatsApp no disponible.'), 'error'); return; }
  await sendReceiptToWhatsApp({ ...venta, clienteTelefono: cliente.telefono || '' });
}
window.compartirFacturaCobro = compartirFacturaCobro;

async function notificarCobroWhatsApp(clienteId) {
  const cliente = DB.clientes.find(c => c.id === clienteId);
  if (!cliente) return;

  const rawPhone = cliente.telefono || '';
  const phone = typeof sanitizePhoneForWhatsApp === 'function'
    ? sanitizePhoneForWhatsApp(rawPhone)
    : rawPhone.replace(/\D/g, '').replace(/^(\d{10})$/, '1$1');

  if (!phone) {
    showToast(clientText('Este cliente no tiene teléfono registrado para WhatsApp.'), 'warning');
    return;
  }

  const pendingSales = getClientePendingCreditSales(clienteId);
  if (!pendingSales.length) {
    showToast(clientText('Este cliente no tiene facturas pendientes.'), 'warning');
    return;
  }

  const cfg = DB.config || {};
  const negocio = cfg.nombre || 'Tecno Caja';
  const totalPendiente = getClienteBalancePendiente(clienteId, cliente.balance);
  const montoFmt = Number(totalPendiente).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const mensajeFormal = [
    `*${negocio}*`,
    '',
    `Estimado/a *${cliente.nombre}*,`,
    '',
    'Reciba un cordial saludo. Le informamos que actualmente presenta un balance pendiente con nuestra empresa correspondiente a sus compras realizadas.',
    '',
    '*Detalle de la deuda:*',
    `Monto pendiente: *RD$ ${montoFmt}*`,
    pendingSales.length > 1
      ? `Facturas: ${pendingSales.map(s => s.invoiceNumber).join(', ')}`
      : `Factura: ${pendingSales[0].invoiceNumber}`,
    '',
    'Le agradeceríamos realizar el pago a la mayor brevedad posible para evitar inconvenientes con su servicio o futuras compras.',
    '',
    'Si ya ha realizado el pago, por favor ignore este mensaje. En caso de cualquier duda o aclaración, no dude en contactarnos.',
    '',
    'Gracias por su preferencia.',
    '',
    'Atentamente,',
    `*${negocio}*`,
    cfg.telefono ? `📞 ${cfg.telefono}` : '',
  ].filter(Boolean).join('\n');

  for (let i = 0; i < pendingSales.length; i++) {
    const invoiceId = pendingSales[i].invoiceNumber;
    const venta = (DB.ventas || []).find(v => v.id === invoiceId);

    showToast(
      pendingSales.length > 1
        ? `${clientText('Preparando factura')} ${i + 1}/${pendingSales.length}...`
        : clientText('Preparando mensaje para WhatsApp...'),
      'info'
    );

    const texto = i === 0 ? mensajeFormal : '';

    try {
      // Generar imagen del recibo
      if (venta?.tipoComprobante === 'factura-electronica' && typeof ensureReceiptQrData === 'function') {
        await ensureReceiptQrData(venta);
      }
      const imageDataUrl = venta ? await generateReceiptImageDataUrl(venta) : null;

      if (imageDataUrl && window.novaDesktop?.openWhatsAppChatWithMedia) {
        // Enviar texto (auto-send por insertText+Enter en main.js) + imagen
        await window.novaDesktop.openWhatsAppChatWithMedia(phone, texto, imageDataUrl, 'factura.jpg');
      } else if (venta && typeof sendReceiptToWhatsApp === 'function') {
        // Fallback: abrir WhatsApp con texto pre-llenado y pegar imagen desde portapapeles
        if (texto && window.novaDesktop?.openWhatsAppChat) {
          await window.novaDesktop.openWhatsAppChat(phone, texto, { customerName: cliente.nombre });
          await new Promise(r => setTimeout(r, 1500));
        }
        await sendReceiptToWhatsApp({ ...venta, clienteTelefono: rawPhone });
      } else if (texto && window.novaDesktop?.openWhatsAppChat) {
        await window.novaDesktop.openWhatsAppChat(phone, texto, { customerName: cliente.nombre });
      }
    } catch (err) {
      showToast(err.message || clientText('Error al enviar por WhatsApp.'), 'error');
      return;
    }

    if (i < pendingSales.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  showToast(clientText('Mensaje y factura enviados a WhatsApp.'), 'success');
}
window.notificarCobroWhatsApp = notificarCobroWhatsApp;

async function saveClienteCobro(id) {
  const amount = parseFloat(document.getElementById('client-credit-payment-amount')?.value) || 0;
  const method = document.getElementById('client-credit-payment-method')?.value || 'efectivo';
  const note = document.getElementById('client-credit-payment-note')?.value || '';
  const cliente = DB.clientes.find(c => c.id === id);

  if (amount <= 0) {
    showToast(clientText('El monto del cobro debe ser mayor que cero.'), 'error');
    return;
  }

  try {
    const response = await api.payClientCredit(id, {
      monto: amount,
      metodo: method,
      obs: note,
      ...getActorPayload()
    });

    DB.config = { ...DB.config, ...(response.config || {}) };
    if (response.client) {
      const clientIdx = DB.clientes.findIndex((item) => Number(item.id) === Number(id));
      if (clientIdx >= 0) DB.clientes[clientIdx] = response.client;
    }
    const appliedSales = response.appliedSales || [];
    for (const applied of appliedSales) {
      const saleIdx = (DB.ventas || []).findIndex((sale) => String(sale.id) === String(applied.invoiceNumber));
      if (saleIdx >= 0) {
        const sale = DB.ventas[saleIdx];
        const total = Number(sale.total || 0);
        const prevReceived = Number(sale.recibido || 0);
        const nextReceived = Math.min(total, prevReceived + Number(applied.appliedAmount || 0));
        DB.ventas[saleIdx] = { ...sale, recibido: nextReceived, cambio: 0 };
      }
    }
    closeAllModals();
    loadClientesTable(document.querySelector('#module-clientes .mod-search')?.value || '');
    if (typeof updateReportes === 'function') {
      try { updateReportes(); } catch (reportError) { console.warn('[Tecno Caja] No se pudo refrescar reportes tras cobro cliente:', reportError); }
    }
    if (typeof refreshAuditLogs === 'function') await refreshAuditLogs();
    if (typeof updateNotifications === 'function') updateNotifications();
    showToast(clientText('Cobro registrado correctamente.'), 'success');

    if (typeof showReceipt === 'function') {
      if (appliedSales.length === 1) {
        // Factura única → mostrar el recibo original actualizado (idéntico al de la venta)
        const invoiceId = appliedSales[0].invoiceNumber;
        const ventaOriginal = (DB.ventas || []).find(v => v.id === invoiceId);
        if (ventaOriginal) {
          showReceipt(ventaOriginal, { title: clientText('Recibo de Cobro') });
          return;
        }
      }

      // Múltiples facturas → recibo de cobro resumido
      const cobroVenta = {
        id: appliedSales.map(s => s.invoiceNumber).join(', '),
        tipoComprobante: 'ticket',
        fecha: new Date().toISOString(),
        cliente: response.client?.nombre || cliente?.nombre || '',
        clienteRncCedula: cliente?.cedula || '',
        cajero: DB.currentUser?.nombre || 'Sistema',
        metodo: method,
        recibido: amount,
        cambio: 0,
        total: amount,
        subtotal: amount,
        itbis: 0,
        descuento: 0,
        estadoFiscal: 'pagada',
        tipoPedido: 'mostrador',
        items: appliedSales.map(s => ({
          nombre: `Abono: ${s.invoiceNumber}`,
          qty: 1,
          precio: s.appliedAmount,
          subtotal: s.appliedAmount,
          total: s.appliedAmount,
          itbisRate: 0,
          itbisMonto: 0,
        })),
      };
      showReceipt(cobroVenta, { title: clientText('Recibo de Cobro') });
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function saveCliente(id) {
  const nombre = document.getElementById('cl-nombre').value.trim();
  clearClienteModalError();
  if (!nombre) {
    const message = clientText('Nombre es obligatorio');
    showClienteModalError(message);
    showToast(message, 'error');
    return;
  }
  const data = {
    nombre,
    telefono: document.getElementById('cl-tel').value,
    cedula: document.getElementById('cl-cedula').value,
    direccion: document.getElementById('cl-dir').value,
    referencia: document.getElementById('cl-ref').value,
    linkUbicacion: document.getElementById('cl-mapa').value,
    limiteCredito: document.getElementById('cl-credit-nolimit')?.checked
      ? 0
      : (parseFloat(document.getElementById('cl-limite')?.value) || 0),
  };
  try {
    if (id) {
      const updated = await api.updateClient(id, { ...data, ...getActorPayload() });
      const idx = DB.clientes.findIndex(c => c.id === id);
      if (idx >= 0) DB.clientes[idx] = updated;
      clearClienteModalError();
      showToast(clientText('Cliente actualizado'), 'success');
    } else {
      const created = await api.createClient({ ...data, ...getActorPayload() });
      DB.clientes.push(created);
      if (document.getElementById('module-ventas')?.classList.contains('active')) {
        DB.saleClientId = created.id;
      }
      clearClienteModalError();
      showToast(clientText('Cliente creado'), 'success');
    }
  } catch (error) {
    showClienteModalError(error.message);
    showToast(error.message, 'error');
    return;
  }
  closeAllModals();
  try {
    loadClientesTable();
    if (typeof refreshAuditLogs === 'function') await refreshAuditLogs();
    if (typeof refreshSaleClientOptions === 'function') refreshSaleClientOptions();
    if (typeof syncSaleFiscalControls === 'function') syncSaleFiscalControls();
  } catch (uiError) {
    console.error('[Tecno Caja] Error refrescando UI de clientes:', uiError);
  }
}

async function deleteCliente(id) {
  const cliente = DB.clientes.find((item) => item.id === id);
  if (cliente && getClienteBalancePendiente(id, cliente.balance) > 0) {
    showToast(clientText('No puedes eliminar este cliente porque tiene factura o balance pendiente.'), 'warning');
    return;
  }
  if (!confirm(clientText('¿Eliminar este cliente?'))) return;
  try {
    await api.request(`/api/clients/${id}`, {
      method: 'DELETE',
      body: JSON.stringify(getActorPayload())
    });
    closeAllModals();
    DB.clientes = (DB.clientes || []).filter((item) => Number(item.id) !== Number(id));
    loadClientesTable(document.querySelector('#module-clientes .mod-search')?.value || '');
    if (typeof updateReportes === 'function') {
      try { updateReportes(); } catch (reportError) { console.warn('[Tecno Caja] No se pudo refrescar reportes tras eliminar cliente:', reportError); }
    }
    if (typeof refreshAuditLogs === 'function') await refreshAuditLogs();
    if (typeof refreshSaleClientOptions === 'function') refreshSaleClientOptions();
    if (typeof syncSaleFiscalControls === 'function') syncSaleFiscalControls();
    showToast(clientText('Cliente eliminado'), 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// ===== REPORTES =====
function updateReportes() {
  const period = document.getElementById('reporte-periodo')?.value || 'hoy';
  const ventasPeriodo = getReportSales(period);
  const metrics = getReportMetrics(ventasPeriodo);
  const topProducts = getTopProductsForReport(ventasPeriodo);
  const paymentStats = getMethodTotalsForReport(ventasPeriodo);
  const orderTypeStats = getOrderTypeTotalsForReport(ventasPeriodo);
  const trend = buildReportTrend(ventasPeriodo, period);

  document.getElementById('rep-ventas').textContent = fmt(metrics.total);
  document.getElementById('rep-ventas-count').textContent = `${ventasPeriodo.length} ${reportText('transacciones')} · ${reportText('ticket promedio')} ${fmt(metrics.ticketPromedio)}`;
  document.getElementById('rep-ganancias').textContent = fmt(metrics.ganancia);
  document.getElementById('rep-itbis').textContent = fmt(metrics.itbis);
  document.getElementById('rep-top-product').textContent = topProducts.length ? topProducts[0].nombre : '—';
  document.getElementById('rep-top-qty').textContent = topProducts.length
    ? `${topProducts[0].qty} ${reportText('unidades')} · ${topProducts[0].participacion}% ${reportText('del mix')}`
    : `0 ${reportText('unidades')}`;
  const trendLabel = document.getElementById('rep-trend-label');
  if (trendLabel) trendLabel.textContent = getReportPeriodLabel(period, ventasPeriodo.length);
  const historyCount = document.getElementById('rep-history-count');
  if (historyCount) {
    historyCount.textContent = `${ventasPeriodo.length} ${reportText(ventasPeriodo.length === 1 ? 'factura' : 'facturas')}`;
  }

  renderReportLineChart(trend.labels, trend.values);
  renderReportBars('rep-payment-bars', paymentStats, {
    valueFormatter: (item) => fmt(item.value),
    metaFormatter: (item) => `${item.count} cobro${item.count === 1 ? '' : 's'}`
  });
  renderReportBars('rep-ordertype-bars', orderTypeStats, {
    valueFormatter: (item) => `${item.value} pedido${item.value === 1 ? '' : 's'}`,
    metaFormatter: (item) => item.meta
  });
  renderReportRanking('rep-top-products-list', topProducts);
  renderOperationalStats(metrics);
  loadVentasHistory(ventasPeriodo);

  syncCajaReportSummary();
  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('module-reportes'));
}

function syncCajaReportSummary() {
  const ventasHoy = getReportSales('hoy');
  const total = ventasHoy.reduce((sum, sale) => sum + Number(sale.total || 0), 0);
  const ef = ventasHoy.filter((sale) => sale.metodo === 'efectivo').reduce((sum, sale) => sum + Number(sale.total || 0), 0);
  const tj = ventasHoy.filter((sale) => sale.metodo === 'tarjeta').reduce((sum, sale) => sum + Number(sale.total || 0), 0);
  const tr = ventasHoy.filter((sale) => sale.metodo === 'transferencia').reduce((sum, sale) => sum + Number(sale.total || 0), 0);
  const todayKey = new Date().toISOString().slice(0, 10);
  const gastos = (DB.movimientosCaja || []).reduce((sum, mov) => {
    const amount = Number(mov.monto || 0);
    if (amount >= 0) return sum;
    const parsed = new Date(mov.hora);
    const movementDay = Number.isNaN(parsed.getTime()) ? String(mov.hora || '').slice(0, 10) : parsed.toISOString().slice(0, 10);
    if (movementDay !== todayKey) return sum;
    return sum + Math.abs(amount);
  }, 0);
  const efectivoEl = document.getElementById('res-efectivo');
  const tarjetaEl = document.getElementById('res-tarjeta');
  const transferEl = document.getElementById('res-transfer');
  const totalEl = document.getElementById('res-total');
  const gastosEl = document.getElementById('res-gastos');
  const balanceEl = document.getElementById('res-balance');

  if (efectivoEl) efectivoEl.textContent = fmt(ef);
  if (tarjetaEl) tarjetaEl.textContent = fmt(tj);
  if (transferEl) transferEl.textContent = fmt(tr);
  if (totalEl) totalEl.textContent = fmt(total);
  if (gastosEl) gastosEl.textContent = fmt(gastos);
  if (balanceEl) balanceEl.textContent = fmt(DB.config?.cajaMonto || 0);
}

function loadReporte() {
  updateReportes();
}

function loadVentasHistory(ventas = null) {
  const tbody = document.getElementById('ventas-history-tbody');
  if (!tbody) return;
  const rows = Array.isArray(ventas) ? ventas : getReportSales(document.getElementById('reporte-periodo')?.value || 'hoy');
  tbody.innerHTML = rows.map(v => `
    <tr>
      <td style="font-family:var(--font-mono);font-weight:700;color:var(--accent-light)">${v.id}</td>
      <td>${getTipoComprobanteBadge(v.tipoComprobante)}</td>
      <td style="font-size:0.82rem">${formatReportDateTime(v.fecha)}</td>
      <td>
        <div style="display:flex;flex-direction:column;gap:0.2rem">
          <span>${v.cliente}</span>
          ${v.clienteRncCedula ? `<span class="products-subtle">${v.clienteRncCedula}</span>` : ''}
        </div>
      </td>
      <td style="color:var(--text2)">${v.cajero}</td>
      <td>${getMetodoBadge(v.metodo)}</td>
      <td style="font-family:var(--font-mono);font-weight:700">${fmt(v.total)}</td>
      <td><button class="btn-edit" onclick="showReceiptFromHistory('${v.id}')">🧾 ${appText('reports.action', 'Ver')}</button></td>
    </tr>
  `).join('') || `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text3)">${reportText('No hay ventas registradas en este periodo')}</td></tr>`;
}

function getMetodoBadge(m) {
  const map = {efectivo:'badge-success',tarjeta:'badge-info',transferencia:'badge-warning',credito:'badge-danger',contra_entrega:'badge-warning'};
  const labels = {
    efectivo: `💵 ${reportText('Efectivo')}`,
    tarjeta: `💳 ${reportText('Tarjeta')}`,
    transferencia: `📲 ${reportText('Transferencia')}`,
    credito: `📋 ${reportText('Crédito')}`,
    contra_entrega: `🛵 ${reportText('Contra entrega')}`
  };
  return `<span class="badge ${map[m]||'badge-info'}">${labels[m]||m}</span>`;
}

function getTipoComprobanteBadge(tipo) {
  const map = {
    ticket: 'badge-info',
    'factura-electronica': 'badge-success'
  };
  const labels = {
    ticket: reportText('Ticket'),
    'factura-electronica': reportText('Factura Electrónica')
  };
  return `<span class="badge ${map[tipo] || 'badge-info'}">${labels[tipo] || tipo}</span>`;
}

function showReceiptFromHistory(ventaId) {
  const venta = DB.ventas.find(v => v.id === ventaId);
  if (!venta) return;
  showReceipt(venta);
}

function exportReporte() {
  const period = document.getElementById('reporte-periodo')?.value || 'hoy';
  const ventas = getReportSales(period);
  const metrics = getReportMetrics(ventas);
  const topProducts = getTopProductsForReport(ventas);
  const methods = getMethodTotalsForReport(ventas);

  if (!window.jspdf?.jsPDF) {
    showToast(reportText('No se pudo generar el PDF en este momento.'), 'error');
    return;
  }

  const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
  let y = 44;
  const left = 40;
  const right = 555;
  const brand = DB.config.nombre || 'Tecno Caja';

  doc.setFillColor(17, 24, 39);
  doc.rect(0, 0, 595, 98, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text(brand, left, 46);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(`${reportText('Reporte de ventas')} · ${getReportPeriodLabel(period, ventas.length)}`, left, 68);
  doc.text(`${reportText('Generado')}: ${new Date().toLocaleString(moduleLocale())}`, left, 84);

  y = 130;
  doc.setTextColor(17, 24, 39);
  const summaryBlocks = [
    [reportText('Ventas'), fmt(metrics.total)],
    [reportText('Ganancia'), fmt(metrics.ganancia)],
    ['ITBIS', fmt(metrics.itbis)],
    [reportText('Ticket promedio'), fmt(metrics.ticketPromedio)]
  ];

  summaryBlocks.forEach(([label, value], index) => {
    const x = left + (index * 132);
    doc.setDrawColor(225, 229, 235);
    doc.roundedRect(x, y, 118, 66, 12, 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text(label, x + 12, y + 20);
    doc.setFont('courier', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(17, 24, 39);
    doc.text(value, x + 12, y + 44);
  });

  y += 98;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(reportText('Resumen operativo'), left, y);
  y += 20;

  const operationalLines = [
    `${reportText('Transacciones')}: ${ventas.length}`,
    `${reportText('Producto líder')}: ${topProducts[0]?.nombre || reportText('Sin datos')}${topProducts[0] ? ` (${topProducts[0].qty} ${reportText('uds')})` : ''}`,
    `${reportText('Pedidos delivery')}: ${metrics.deliveryCount}`,
    `${reportText('Cajero líder')}: ${metrics.cajeroLider || reportText('Sin datos')}`
  ];
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  operationalLines.forEach((line) => {
    doc.text(`• ${line}`, left, y);
    y += 18;
  });

  y += 10;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(reportText('Métodos de pago'), left, y);
  y += 18;
  methods.forEach((method) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text(`${method.label}: ${fmt(method.value)} · ${method.count} ${reportText('cobro(s)')}`, left, y);
    y += 16;
  });

  y += 12;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(reportText('Top productos'), left, y);
  y += 18;
  (topProducts.length ? topProducts : [{ nombre: reportText('Sin ventas registradas'), qty: 0, total: 0 }]).slice(0, 5).forEach((item, index) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    const totalText = item.total ? ` · ${fmt(item.total)}` : '';
    doc.text(`${index + 1}. ${item.nombre} · ${item.qty} ${reportText('uds')}${totalText}`, left, y);
    y += 16;
  });

  const fileName = `reporte-${period}-${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.save(fileName);
  showToast(reportText('Reporte exportado correctamente'), 'success');
}

function getReportSales(period = 'hoy') {
  const { start, end } = getReportPeriodRange(period);
  return [...DB.ventas]
    .filter((sale) => {
      const date = getReportDate(sale.fecha);
      return date && date >= start && date <= end;
    })
    .sort((a, b) => getReportDate(b.fecha) - getReportDate(a.fecha));
}

function getReportPeriodRange(period) {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  start.setMilliseconds(0);
  end.setMilliseconds(999);

  if (period === 'hoy') {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  if (period === 'semana') {
    const day = start.getDay();
    const diff = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - diff);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  if (period === 'mes') {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    end.setMonth(end.getMonth() + 1, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  start.setMonth(0, 1);
  start.setHours(0, 0, 0, 0);
  end.setMonth(11, 31);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function getReportDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date;
  const normalized = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(normalized.getTime()) ? null : normalized;
}

function formatReportDateTime(value) {
  const date = getReportDate(value);
  if (!date) return value || '—';
  return date.toLocaleString(moduleLocale(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getReportMetrics(ventas) {
  const total = ventas.reduce((sum, sale) => sum + Number(sale.total || 0), 0);
  const itbis = ventas.reduce((sum, sale) => sum + Number(sale.itbis || 0), 0);
  const ganancia = ventas.reduce((sum, sale) => {
    const costo = (sale.items || []).reduce((carry, item) => {
      const product = DB.productos.find((candidate) => candidate.id === item.id || candidate.nombre === item.nombre);
      return carry + ((Number(product?.precioCompra || 0)) * Number(item.qty || 0));
    }, 0);
    return sum + (Number(sale.total || 0) - costo);
  }, 0);
  const ticketPromedio = ventas.length ? total / ventas.length : 0;

  const topCashier = Object.entries(ventas.reduce((acc, sale) => {
    acc[sale.cajero || 'Sin cajero'] = (acc[sale.cajero || 'Sin cajero'] || 0) + Number(sale.total || 0);
    return acc;
  }, {})).sort((a, b) => b[1] - a[1])[0];

  const peakHour = Object.entries(ventas.reduce((acc, sale) => {
    const date = getReportDate(sale.fecha);
    const label = date ? date.getHours().toString().padStart(2, '0') + ':00' : '—';
    acc[label] = (acc[label] || 0) + Number(sale.total || 0);
    return acc;
  }, {})).sort((a, b) => b[1] - a[1])[0];

  const deliveryCount = ventas.filter((sale) => sale.tipoPedido === 'delivery').length;

  return {
    total,
    itbis,
    ganancia,
    ticketPromedio,
    deliveryCount,
    cajeroLider: topCashier?.[0] || '',
    horaPico: peakHour?.[0] || '—',
    horaPicoMonto: peakHour?.[1] || 0
  };
}

function getTopProductsForReport(ventas) {
  const totals = {};
  let totalQty = 0;
  ventas.forEach((sale) => {
    (sale.items || []).forEach((item) => {
      const key = item.nombre || 'Producto';
      totals[key] = totals[key] || { nombre: key, qty: 0, total: 0 };
      totals[key].qty += Number(item.qty || 0);
      totals[key].total += Number(item.total || 0);
      totalQty += Number(item.qty || 0);
    });
  });

  return Object.values(totals)
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5)
    .map((item) => ({
      ...item,
      participacion: totalQty ? ((item.qty / totalQty) * 100).toFixed(1) : '0.0'
    }));
}

function getMethodTotalsForReport(ventas) {
  const labels = {
    efectivo: reportText('Efectivo'),
    tarjeta: reportText('Tarjeta'),
    transferencia: reportText('Transferencia'),
    credito: reportText('Crédito')
  };
  const counts = {};
  const totals = {};
  ventas.forEach((sale) => {
    const key = sale.metodo || 'efectivo';
    counts[key] = (counts[key] || 0) + 1;
    totals[key] = (totals[key] || 0) + Number(sale.total || 0);
  });
  return Object.keys(labels).map((key) => ({
    key,
    label: labels[key],
    value: totals[key] || 0,
    count: counts[key] || 0
  })).sort((a, b) => b.value - a.value);
}

function getOrderTypeTotalsForReport(ventas) {
  const labels = {
    mostrador: reportText('Mostrador'),
    delivery: reportText('Delivery'),
    recoger: reportText('Recoger'),
    mesa: reportText('Mesa')
  };
  const counts = {};
  ventas.forEach((sale) => {
    const key = sale.tipoPedido || 'mostrador';
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.keys(labels).map((key) => ({
    key,
    label: labels[key],
    value: counts[key] || 0,
    meta: counts[key] ? `${((counts[key] / Math.max(ventas.length, 1)) * 100).toFixed(1)}% ${reportText('del total')}` : reportText('Sin pedidos')
  })).sort((a, b) => b.value - a.value);
}

function buildReportTrend(ventas, period) {
  const dateFormatter = new Intl.DateTimeFormat(moduleLocale(), { day: '2-digit', month: 'short' });
  const monthFormatter = new Intl.DateTimeFormat(moduleLocale(), { month: 'short' });
  const weekdayFormatter = new Intl.DateTimeFormat(moduleLocale(), { weekday: 'short' });
  const groups = new Map();

  ventas.forEach((sale) => {
    const date = getReportDate(sale.fecha);
    if (!date) return;
    let key = '';
    let label = '';

    if (period === 'hoy') {
      key = `${date.getHours()}`;
      label = `${date.getHours().toString().padStart(2, '0')}:00`;
    } else if (period === 'semana') {
      key = date.toISOString().slice(0, 10);
      label = weekdayFormatter.format(date);
    } else if (period === 'mes') {
      key = date.toISOString().slice(0, 10);
      label = dateFormatter.format(date);
    } else {
      key = `${date.getFullYear()}-${date.getMonth()}`;
      label = monthFormatter.format(date);
    }

    const entry = groups.get(key) || { label, total: 0 };
    entry.total += Number(sale.total || 0);
    groups.set(key, entry);
  });

  const ordered = [...groups.entries()]
    .sort((a, b) => {
      if (period === 'hoy') return Number(a[0]) - Number(b[0]);
      return a[0].localeCompare(b[0]);
    })
    .map(([, value]) => value);

  return {
    labels: ordered.map((item) => item.label),
    values: ordered.map((item) => Number(item.total.toFixed(2)))
  };
}

function renderReportLineChart(labels, values) {
  const container = document.getElementById('rep-line-chart');
  const legend = document.getElementById('rep-line-legend');
  if (!container || !legend) return;

  if (!labels.length || !values.length) {
    container.innerHTML = `<div class="report-line-chart-empty">${reportText('No hay ventas suficientes para graficar este periodo.')}</div>`;
    legend.innerHTML = `
      <div class="report-legend-item">
        <div class="report-legend-label">${reportText('Total')}</div>
        <div class="report-legend-value">${fmt(0)}</div>
      </div>
      <div class="report-legend-item">
        <div class="report-legend-label">${reportText('Promedio')}</div>
        <div class="report-legend-value">${fmt(0)}</div>
      </div>
    `;
    return;
  }

  const width = 760;
  const height = 180;
  const paddingX = 18;
  const paddingY = 18;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const usableWidth = width - (paddingX * 2);
  const usableHeight = height - (paddingY * 2);
  const pointGap = labels.length > 1 ? usableWidth / (labels.length - 1) : 0;

  const points = values.map((value, index) => {
    const x = paddingX + (index * pointGap);
    const normalized = (value - min) / Math.max(max - min, 1);
    const y = height - paddingY - (normalized * usableHeight);
    return { x, y, value };
  });

  const polyline = points.map((point) => `${point.x},${point.y}`).join(' ');
  const areaPolyline = [
    `${points[0].x},${height - paddingY}`,
    ...points.map((point) => `${point.x},${point.y}`),
    `${points[points.length - 1].x},${height - paddingY}`
  ].join(' ');
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Tendencia de ventas">
      <defs>
        <linearGradient id="reportAreaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(108,92,231,0.42)" />
          <stop offset="100%" stop-color="rgba(108,92,231,0.02)" />
        </linearGradient>
      </defs>
      <polyline fill="url(#reportAreaGradient)" stroke="none" points="${areaPolyline}"></polyline>
      <polyline fill="none" stroke="#7c6cff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" points="${polyline}"></polyline>
      ${points.map((point) => `
        <circle cx="${point.x}" cy="${point.y}" r="5.5" fill="#7c6cff"></circle>
        <circle cx="${point.x}" cy="${point.y}" r="10" fill="rgba(124,108,255,0.12)"></circle>
      `).join('')}
    </svg>
    <div class="report-line-labels" style="--count:${labels.length}">
      ${labels.map((label) => `<span>${label}</span>`).join('')}
    </div>
  `;

  legend.innerHTML = `
    <div class="report-legend-item">
      <div class="report-legend-label">${reportText('Pico')}</div>
      <div class="report-legend-value">${fmt(Math.max(...values))}</div>
    </div>
    <div class="report-legend-item">
      <div class="report-legend-label">${reportText('Promedio')}</div>
      <div class="report-legend-value">${fmt(avg)}</div>
    </div>
    <div class="report-legend-item">
      <div class="report-legend-label">${reportText('Acumulado')}</div>
      <div class="report-legend-value">${fmt(values.reduce((sum, value) => sum + value, 0))}</div>
    </div>
  `;
}

function renderReportBars(targetId, items, options = {}) {
  const container = document.getElementById(targetId);
  if (!container) return;
  if (!items.length) {
    container.innerHTML = `<div class="report-bar-item"><div class="report-bar-meta">${reportText('No hay datos en este periodo.')}</div></div>`;
    return;
  }

  const max = Math.max(...items.map((item) => Number(item.value || 0)), 1);
  container.innerHTML = items.map((item) => {
    const percent = Math.max(8, (Number(item.value || 0) / max) * 100);
    return `
      <div class="report-bar-item">
        <div class="report-bar-top">
          <span class="report-bar-title">${item.label}</span>
          <span class="report-bar-value">${options.valueFormatter ? options.valueFormatter(item) : item.value}</span>
        </div>
        <div class="report-bar-track"><div class="report-bar-fill" style="width:${percent}%"></div></div>
        <div class="report-bar-meta">${options.metaFormatter ? options.metaFormatter(item) : ''}</div>
      </div>
    `;
  }).join('');
}

function renderReportRanking(targetId, items) {
  const container = document.getElementById(targetId);
  if (!container) return;
  if (!items.length) {
    container.innerHTML = `<div class="report-rank-item"><div class="report-rank-meta">${reportText('Todavía no hay ventas para destacar productos.')}</div></div>`;
    return;
  }

  const max = Math.max(...items.map((item) => item.qty), 1);
  container.innerHTML = items.map((item, index) => `
    <div class="report-rank-item">
      <div class="report-rank-top">
        <span class="report-rank-title">${index + 1}. ${item.nombre}</span>
        <span class="report-rank-value">${item.qty} ${reportText('uds')}</span>
      </div>
      <div class="report-bar-track"><div class="report-bar-fill" style="width:${Math.max(10, (item.qty / max) * 100)}%"></div></div>
      <div class="report-rank-meta">${fmt(item.total)} · ${item.participacion}% ${reportText('del total vendido')}</div>
    </div>
  `).join('');
}

function renderOperationalStats(metrics) {
  const container = document.getElementById('rep-operational-stats');
  if (!container) return;
  const stats = [
    {
      label: reportText('Ticket promedio'),
      value: fmt(metrics.ticketPromedio),
      meta: reportText('Ingreso promedio por venta')
    },
    {
      label: reportText('Hora pico'),
      value: metrics.horaPico || '—',
      meta: metrics.horaPicoMonto ? fmt(metrics.horaPicoMonto) : reportText('Sin movimiento')
    },
    {
      label: reportText('Pedidos delivery'),
      value: `${metrics.deliveryCount}`,
      meta: reportText('Ventas con entrega a domicilio')
    },
    {
      label: reportText('Cajero líder'),
      value: metrics.cajeroLider || reportText('Sin datos'),
      meta: reportText('Mayor facturación del periodo')
    }
  ];

  container.innerHTML = stats.map((item) => `
    <div class="report-mini-stat">
      <div class="report-mini-top">
        <span class="report-mini-title">${item.label}</span>
        <span class="report-mini-value">${item.value}</span>
      </div>
      <div class="report-mini-meta">${item.meta}</div>
    </div>
  `).join('');
}

function getReportPeriodLabel(period, count) {
  const labels = {
    hoy: reportText('Hoy'),
    semana: reportText('Esta semana'),
    mes: reportText('Este mes'),
    año: reportText('Este año'),
    default: reportText('Periodo')
  };
  return `${labels[period] || labels.default} · ${count} ${reportText(count === 1 ? 'venta' : 'ventas')}`;
}

// ===== USUARIOS =====
const USER_ROLE_FALLBACKS = [
  { id: 0, codigo: 'administrador_general', nombre: 'Administrador General', permisos: ['*'] },
  { id: 0, codigo: 'administrador_sucursal', nombre: 'Administrador de Sucursal', permisos: ['ventas', 'caja', 'inventario', 'usuarios'] },
  { id: 0, codigo: 'supervisor', nombre: 'Supervisor', permisos: ['ventas', 'caja', 'reportes_sucursal'] },
  { id: 0, codigo: 'cajero', nombre: 'Cajero', permisos: ['ventas', 'caja'] },
  { id: 0, codigo: 'repartidor', nombre: 'Repartidor (Delivery)', permisos: [] }
];

let USER_MODAL_CONTEXT = { userId: null };

function escapeUserFieldHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeUserRoleCodeClient(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'administrador_general' || normalized === 'administrador') return 'administrador_general';
  if (normalized === 'administrador_sucursal' || normalized === 'administrador sucursal') return 'administrador_sucursal';
  if (normalized === 'supervisor') return 'supervisor';
  if (normalized === 'cajero') return 'cajero';
  if (normalized === 'repartidor' || normalized === 'delivery') return 'repartidor';
  return normalized;
}

function getBusinessStructureModeForUsers() {
  return typeof normalizeBusinessStructureMode === 'function'
    ? normalizeBusinessStructureMode(DB.config?.businessStructureMode)
    : String(DB.config?.businessStructureMode || 'monocaja').trim().toLowerCase();
}

function getRoleCatalogForUsers() {
  const source = Array.isArray(DB.roles) && DB.roles.length ? DB.roles : USER_ROLE_FALLBACKS;
  // Garantizar que repartidor siempre esté disponible aunque la BD no lo tenga aún
  const hasRepartidor = source.some((r) => normalizeUserRoleCodeClient(r.codigo || r.nombre) === 'repartidor');
  const fullSource = hasRepartidor
    ? source
    : [...source, { id: 0, codigo: 'repartidor', nombre: 'Repartidor (Delivery)', permisos: [] }];
  const preferredOrder = ['administrador_general', 'administrador_sucursal', 'supervisor', 'cajero', 'repartidor'];
  return fullSource
    .map((role) => ({
      ...role,
      codigo: normalizeUserRoleCodeClient(role.codigo || role.nombre),
      nombre: role.nombre || role.codigo || 'Rol'
    }))
    .filter((role) => role.codigo)
    .sort((a, b) => {
      const aIndex = preferredOrder.indexOf(a.codigo);
      const bIndex = preferredOrder.indexOf(b.codigo);
      if (aIndex === -1 && bIndex === -1) return String(a.nombre).localeCompare(String(b.nombre));
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    });
}

function getRoleDefinitionForUsers(roleCode) {
  return getRoleCatalogForUsers().find((role) => role.codigo === normalizeUserRoleCodeClient(roleCode)) || null;
}

function getCurrentUserRoleCodeClient() {
  return normalizeUserRoleCodeClient(DB.currentUser?.roleCode || DB.currentUser?.rol);
}

function getCurrentUserRolePermissionsClient() {
  const currentRole = getRoleDefinitionForUsers(getCurrentUserRoleCodeClient());
  return Array.isArray(currentRole?.permisos) ? currentRole.permisos : [];
}

function currentUserCanManageUsersUi() {
  const currentRoleCode = getCurrentUserRoleCodeClient();
  if (currentRoleCode === 'administrador_general' || currentRoleCode === 'administrador_sucursal') {
    return true;
  }
  const permissions = new Set(getCurrentUserRolePermissionsClient());
  return currentRoleCode === 'supervisor' && (permissions.has('*') || permissions.has('usuarios') || permissions.has('usuarios_crear') || permissions.has('gestionar_usuarios'));
}

function currentUserHasGlobalUserScopeUi() {
  return getCurrentUserRoleCodeClient() === 'administrador_general';
}

function canAssignRoleFromUi(roleCode) {
  const actorRoleCode = getCurrentUserRoleCodeClient();
  const nextRoleCode = normalizeUserRoleCodeClient(roleCode);
  if (actorRoleCode === 'administrador_general') return true;
  if (actorRoleCode === 'administrador_sucursal') return nextRoleCode !== 'administrador_general';
  if (actorRoleCode === 'supervisor' && currentUserCanManageUsersUi()) {
    return !['administrador_general', 'administrador_sucursal'].includes(nextRoleCode);
  }
  return false;
}

function getAssignableRolesForUi() {
  return getRoleCatalogForUsers().filter((role) => canAssignRoleFromUi(role.codigo));
}

function getScopedBranchesForUserManagement() {
  const branches = Array.isArray(DB.sucursales) ? DB.sucursales : [];
  if (currentUserHasGlobalUserScopeUi()) return branches;
  const branchId = Number(DB.currentUser?.sucursalId || DB.currentUser?.branchId || DB.config?.activeBranchId || 0) || null;
  return branches.filter((branch) => Number(branch.id) === Number(branchId || 0));
}

function getScopedUsersForUserManagement() {
  const users = Array.isArray(DB.users) ? DB.users : [];
  if (currentUserHasGlobalUserScopeUi()) return users;
  const allowedBranchId = Number(DB.currentUser?.sucursalId || DB.currentUser?.branchId || DB.config?.activeBranchId || 0) || null;
  return users.filter((user) => Number(user?.sucursalId || user?.branchId || 0) === Number(allowedBranchId || 0));
}

function getCashRegistersForUserManagement(branchId) {
  return (Array.isArray(DB.cajasSucursal) ? DB.cajasSucursal : [])
    .filter((cashRegister) => Number(cashRegister.sucursalId || cashRegister.branchId || cashRegister.branch_id || 0) === Number(branchId || 0));
}

function getPrimaryBranchForUsers() {
  return Number(DB.config?.activeBranchId || DB.sucursales?.[0]?.id || 0) || null;
}

function getPrimaryCashRegisterForUsers(branchId) {
  const registers = getCashRegistersForUserManagement(branchId);
  return Number(registers[0]?.id || 0) || null;
}

function roleNeedsBranchUi(roleCode) {
  const code = normalizeUserRoleCodeClient(roleCode);
  return code !== 'administrador_general' && code !== 'repartidor';
}

function roleNeedsCashUi(roleCode) {
  return normalizeUserRoleCodeClient(roleCode) === 'cajero';
}

function isCashierRegisterRequiredUi() {
  return Boolean(DB.config?.cashierRegisterRequired ?? true);
}

function isExclusiveCashierPerRegisterUi() {
  return Boolean(DB.config?.exclusiveCashierPerRegister ?? true);
}

function getCurrentPlanCodeForUsersUi() {
  if (window.TecnoCajaPlans && typeof window.TecnoCajaPlans.getCurrentPlanCode === 'function') {
    return window.TecnoCajaPlans.getCurrentPlanCode();
  }
  return String(DB.config?.planCode || 'basico').trim().toLowerCase() || 'basico';
}

function getCashierLimitForCurrentPlanUi() {
  return getCurrentPlanCodeForUsersUi() === 'basico' ? 3 : null;
}

function countActiveCashiersForCurrentPlanUi(excludeUserId = null) {
  return (Array.isArray(DB.users) ? DB.users : []).filter((user) => {
    if (excludeUserId && Number(user?.id || 0) === Number(excludeUserId || 0)) return false;
    if (String(user?.estado || '').trim().toLowerCase() !== 'activo') return false;
    return normalizeUserRoleCodeClient(user?.roleCode || user?.rol) === 'cajero';
  }).length;
}

function getCashierPlanLimitMessageUi() {
  const limit = getCashierLimitForCurrentPlanUi();
  if (!limit) return '';
  const planCode = getCurrentPlanCodeForUsersUi();
  const planName = window.TecnoCajaPlans?.PLAN_NAMES?.[planCode] || 'Tecno Caja Básico';
  const total = countActiveCashiersForCurrentPlanUi();
  return `${planName}: hasta ${limit} cajeros activos (${total}/${limit}).`;
}

function getBranchNameById(branchId) {
  const branch = (DB.sucursales || []).find((item) => Number(item.id) === Number(branchId || 0));
  return branch?.nombre || userText('Sucursal principal');
}

function getCashRegisterNameById(cashRegisterId) {
  const register = (DB.cajasSucursal || []).find((item) => Number(item.id) === Number(cashRegisterId || 0));
  return register?.nombre || userText('Caja principal');
}

function getUserAssignmentCaption(user) {
  const roleCode = normalizeUserRoleCodeClient(user?.roleCode || user?.rol);
  if (roleCode === 'administrador_general') {
    return userText('Acceso global');
  }
  const branchId = Number(user?.sucursalId || user?.branchId || 0) || null;
  const cashId = Number(user?.cajaId || user?.cashRegisterId || 0) || null;
  const parts = [];
  if (branchId) parts.push(getBranchNameById(branchId));
  if (cashId) parts.push(getCashRegisterNameById(cashId));
  return parts.length ? parts.join(' · ') : userText('Sin asignación fija');
}

function getUserBillingFunctionLabelUi(value) {
  if (window.TecnoCajaBilling?.getBillingFunctionLabelUi) {
    return window.TecnoCajaBilling.getBillingFunctionLabelUi(value);
  }
  return 'Mixta';
}

function getUserBillingFunctionHelpTextUi(value) {
  const normalized = window.TecnoCajaBilling?.normalizeBillingFunctionUi
    ? window.TecnoCajaBilling.normalizeBillingFunctionUi(value)
    : String(value || 'mixta').trim().toLowerCase();

  if (normalized === 'facturacion') {
    return userText('Solo emite la factura y la envía a la cola de cobro. No podrá registrar pagos pendientes.');
  }
  if (normalized === 'cobro') {
    return userText('Solo podrá cobrar facturas pendientes. No podrá emitir ventas nuevas desde el POS.');
  }
  if (normalized === 'centralizadora') {
    return userText('Podrá facturar y cobrar como una cuenta central de operación.');
  }
  return userText('Podrá facturar y cobrar normalmente desde su caja activa.');
}

function getUserBillingFunctionCaptionUi(user) {
  return `${userText('Función')}: ${userText(getUserBillingFunctionLabelUi(user?.tipoFacturacion || 'mixta'))}`;
}

function getRolBadge(userOrRole) {
  const roleCode = normalizeUserRoleCodeClient(typeof userOrRole === 'string' ? userOrRole : (userOrRole?.roleCode || userOrRole?.rol));
  const roleMeta = getRoleDefinitionForUsers(roleCode);
  const label = roleMeta?.nombre || (typeof userOrRole === 'string' ? userOrRole : userOrRole?.rol) || 'Rol';
  const map = {
    administrador_general: 'badge-danger',
    administrador_sucursal: 'badge-warning',
    supervisor: 'badge-info',
    cajero: 'badge-info',
    repartidor: 'badge-success'
  };
  return `<span class="badge ${map[roleCode] || 'badge-info'}">${userText(label)}</span>`;
}

function loadUsuariosTable() {
  const tbody = document.getElementById('usuarios-tbody');
  if (!tbody) return;

  const canManage = currentUserCanManageUsersUi();
  const createButton = document.querySelector('#module-usuarios .module-header .btn-primary');
  const limitNote = document.getElementById('usuarios-plan-limit-note');
  if (createButton) {
    createButton.disabled = !canManage;
    createButton.style.opacity = canManage ? '1' : '0.55';
    createButton.title = canManage ? '' : userText('Tu cuenta no tiene permiso para crear usuarios.');
  }
  if (limitNote) {
    const limitMessage = getCashierPlanLimitMessageUi();
    limitNote.textContent = limitMessage;
    limitNote.classList.toggle('hidden', !limitMessage);
  }

  const scopedUsers = getScopedUsersForUserManagement();
  tbody.innerHTML = scopedUsers.map((user) => {
    const isActive = String(user?.estado || '').trim().toLowerCase() === 'activo';
    const hasFbUid  = Boolean(user?.firebase_uid || user?.firebaseUid);
    const fbBadge   = hasFbUid
      ? `<span title="${escapeUserFieldHtml(user.firebase_uid || user.firebaseUid || '')}" style="color:var(--success,#16a34a);font-size:1rem;cursor:default">🔥</span>`
      : `<span title="${userText('Sin cuenta Firebase — haz clic en Sync Firebase')}" style="color:var(--text3,#9ca3af);font-size:1rem;cursor:default">○</span>`;
    return `
      <tr>
        <td style="font-family:var(--font-mono);font-weight:700">${escapeUserFieldHtml(user.usuario)}</td>
        <td>
          <div style="font-weight:600">${escapeUserFieldHtml(user.nombre)}</div>
          <div class="user-assignment-text">${escapeUserFieldHtml(getUserAssignmentCaption(user))}</div>
          <div class="user-assignment-text">${escapeUserFieldHtml(getUserBillingFunctionCaptionUi(user))}</div>
        </td>
        <td>${getRolBadge(user)}</td>
        <td><span class="badge ${isActive ? 'badge-success' : 'badge-warning'}">${userText(user.estado)}</span></td>
        <td style="text-align:center">${fbBadge}</td>
        <td style="color:var(--text2);font-size:0.82rem">${escapeUserFieldHtml(user.lastLogin || '—')}</td>
        <td>
          ${canManage ? `<button class="btn-edit" style="margin-right:4px" onclick="openEditUserModal(${user.id})">✏ ${userText('Editar')}</button>` : `<span class="user-readonly-pill">${userText('Solo lectura')}</span>`}
        </td>
      </tr>
    `;
  }).join('');

  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('module-usuarios'));
}

/**
 * Sincronización masiva: crea/actualiza la cuenta Firebase Auth de TODOS los
 * usuarios del sistema.  Llama a POST /api/firebase-sync/auth-all.
 */
async function syncAllUsersFirebase() {
  const btn = document.getElementById('btn-sync-all-firebase');
  const origText = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = `⏳ ${userText('Sincronizando...')}`; }
  try {
    const result = await api.request('/api/firebase-sync/auth-all', {
      method: 'POST',
      body: JSON.stringify({}),
      _timeoutMs: 60000,          // puede tardar si hay muchos usuarios
    });
    const msg = userText(
      `Firebase: ${result.synced || 0} sincronizados` +
      (result.skipped ? `, ${result.skipped} omitidos` : '') +
      (result.failed  ? `, ${result.failed} fallidos`  : '')
    );
    showToast(`✅ ${msg}`, result.failed ? 'warning' : 'success');
    // Recargar datos para que los indicadores 🔥 se actualicen
    if (typeof reloadBootstrapData === 'function') {
      await reloadBootstrapData().catch(() => {});
    }
    loadUsuariosTable();
  } catch (err) {
    showToast(err.message || userText('Error al sincronizar con Firebase.'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = origText; }
  }
}

function buildUserModeMessage(roleCode, mode, branchName, cashName) {
  const normalizedRole = normalizeUserRoleCodeClient(roleCode);
  if (mode === 'monocaja') {
    if (normalizedRole === 'cajero') {
      return `${userText('Modo monocaja')}: ${userText('el cajero quedará asignado automáticamente a')} ${branchName} / ${cashName}.`;
    }
    if (normalizedRole === 'administrador_general') {
      return `${userText('Modo monocaja')}: ${userText('este usuario tendrá acceso global y la operación usa la sucursal y caja principal del sistema.')}`;
    }
    return `${userText('Modo monocaja')}: ${userText('este usuario quedará ligado automáticamente a')} ${branchName}.`;
  }
  if (mode === 'multicaja') {
    if (normalizedRole === 'cajero') {
      return `${userText('Modo multicaja')}: ${userText('el cajero debe asignarse a una caja de la sucursal principal.')}`;
    }
    if (normalizedRole === 'administrador_general') {
      return `${userText('Modo multicaja')}: ${userText('el administrador general conserva acceso global sin caja fija.')}`;
    }
    return `${userText('Modo multicaja')}: ${userText('este usuario trabajará dentro de la sucursal principal y la caja será opcional si el rol no la requiere.')}`;
  }
  if (normalizedRole === 'cajero') {
    return `${userText('Modo multisucursal')}: ${userText('selecciona la sucursal y la caja del cajero. Solo se mostrarán las cajas de la sucursal elegida.')}`;
  }
  if (normalizedRole === 'administrador_general') {
    return `${userText('Modo multisucursal')}: ${userText('el administrador general tendrá acceso global y no necesita sucursal ni caja fija.')}`;
  }
  return `${userText('Modo multisucursal')}: ${userText('selecciona la sucursal del usuario. La caja solo aplica cuando el rol la necesita.')}`;
}

function syncUserModalDynamicFields() {
  const roleSelect = document.getElementById('nu-role-code');
  const branchSelect = document.getElementById('nu-branch-id');
  const cashSelect = document.getElementById('nu-cash-register-id');
  const billingSelect = document.getElementById('nu-billing-type');
  if (!roleSelect || !branchSelect || !cashSelect || !billingSelect) return;

  const mode = getBusinessStructureModeForUsers();
  const roleCode = normalizeUserRoleCodeClient(roleSelect.value);
  const isDelivery = roleCode === 'repartidor';

  // Mostrar/ocultar sección de delivery y facturación según el rol
  const billingWrap = document.getElementById('nu-billing-wrap');
  const deliveryInfo = document.getElementById('nu-delivery-info');
  if (billingWrap) billingWrap.classList.toggle('hidden', isDelivery);
  if (deliveryInfo) deliveryInfo.classList.toggle('hidden', !isDelivery);

  // Si es repartidor, no necesita sucursal ni caja — salir aquí
  if (isDelivery) {
    const branchWrap = document.getElementById('nu-branch-wrap');
    const cashWrap = document.getElementById('nu-cash-wrap');
    const branchSummary = document.getElementById('nu-branch-summary');
    const cashSummary = document.getElementById('nu-cash-summary');
    const modeBanner = document.getElementById('nu-mode-banner');
    if (branchWrap) branchWrap.classList.add('hidden');
    if (cashWrap) cashWrap.classList.add('hidden');
    if (branchSummary) { branchSummary.classList.remove('hidden'); branchSummary.textContent = userText('Los repartidores no necesitan sucursal fija.'); }
    if (cashSummary) { cashSummary.classList.remove('hidden'); cashSummary.textContent = userText('Los repartidores no usan caja.'); }
    if (modeBanner) modeBanner.textContent = userText('Repartidor: accede solo a la app Tecno Caja Delivery mediante su correo y contraseña.');
    if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
    return;
  }
  const billingType = billingSelect.value || 'mixta';
  const availableBranches = getScopedBranchesForUserManagement();
  const branchWrap = document.getElementById('nu-branch-wrap');
  const branchSummary = document.getElementById('nu-branch-summary');
  const cashWrap = document.getElementById('nu-cash-wrap');
  const cashSummary = document.getElementById('nu-cash-summary');
  const modeBanner = document.getElementById('nu-mode-banner');
  const scopeBanner = document.getElementById('nu-scope-banner');
  const roleHint = document.getElementById('nu-role-hint');
  const billingHint = document.getElementById('nu-billing-hint');
  const requiresBranch = roleNeedsBranchUi(roleCode);
  const requiresCash = roleNeedsCashUi(roleCode);
  const globalScope = currentUserHasGlobalUserScopeUi();
  const shouldShowBranchSelect = requiresBranch && mode === 'multisucursal' && globalScope && availableBranches.length > 1;

  let branchId = Number(branchSelect.value || 0) || null;
  if (requiresBranch) {
    branchId = shouldShowBranchSelect
      ? (branchId || Number(availableBranches[0]?.id || 0) || getPrimaryBranchForUsers())
      : (Number(DB.currentUser?.sucursalId || DB.currentUser?.branchId || availableBranches[0]?.id || getPrimaryBranchForUsers() || 0) || null);
    branchSelect.value = branchId ? String(branchId) : '';
  } else {
    branchId = null;
    branchSelect.value = '';
  }

  branchWrap.classList.toggle('hidden', !shouldShowBranchSelect);
  if (branchSummary) {
    branchSummary.classList.toggle('hidden', requiresBranch && shouldShowBranchSelect);
    if (!requiresBranch) {
      branchSummary.textContent = userText('Este rol no necesita una sucursal fija.');
    } else {
      branchSummary.textContent = `${userText('Sucursal asignada')}: ${getBranchNameById(branchId)}`;
    }
  }

  const registers = branchId ? getCashRegistersForUserManagement(branchId) : [];
  const selectedCashBefore = Number(cashSelect.value || 0) || Number(USER_MODAL_CONTEXT.cachedCashId || 0) || null;
  const shouldShowCashSelect = requiresCash && (mode === 'multicaja' || mode === 'multisucursal');
  let cashId = null;

  if (mode === 'monocaja') {
    cashId = getPrimaryCashRegisterForUsers(branchId || getPrimaryBranchForUsers());
  } else if (requiresCash) {
    cashId = selectedCashBefore;
    if (cashId && !registers.some((register) => Number(register.id) === Number(cashId))) {
      cashId = null;
    }
    if (!cashId && registers.length === 1 && isCashierRegisterRequiredUi()) {
      cashId = Number(registers[0].id);
    }
  }

  if (shouldShowCashSelect) {
    const placeholder = isCashierRegisterRequiredUi()
      ? userText('Selecciona una caja')
      : userText('Sin caja fija');
    cashSelect.innerHTML = `
      <option value="">${placeholder}</option>
      ${registers.map((register) => `<option value="${register.id}">${escapeUserFieldHtml(register.nombre)}${register.codigo ? ` · ${escapeUserFieldHtml(register.codigo)}` : ''}</option>`).join('')}
    `;
    cashSelect.value = cashId ? String(cashId) : '';
  } else {
    cashSelect.innerHTML = `<option value="">${userText('No aplica')}</option>`;
    cashSelect.value = '';
  }
  USER_MODAL_CONTEXT.cachedCashId = cashId || null;

  cashWrap.classList.toggle('hidden', !shouldShowCashSelect);
  if (cashSummary) {
    const showCashSummary = !shouldShowCashSelect && (mode === 'monocaja' || requiresCash);
    cashSummary.classList.toggle('hidden', !showCashSummary);
    if (mode === 'monocaja') {
      cashSummary.textContent = cashId
        ? `${userText('Caja asignada')}: ${getCashRegisterNameById(cashId)}`
        : userText('No hay caja configurada.');
    } else if (requiresCash && !shouldShowCashSelect) {
      cashSummary.textContent = `${userText('Caja asignada')}: ${getCashRegisterNameById(cashId)}`;
    } else {
      cashSummary.textContent = userText('Este rol no necesita caja fija.');
    }
  }

  if (modeBanner) {
    modeBanner.textContent = buildUserModeMessage(roleCode, mode, getBranchNameById(branchId), getCashRegisterNameById(cashId));
  }
  if (scopeBanner) {
    if (globalScope) {
      scopeBanner.textContent = userText('Tu cuenta puede crear usuarios en cualquier sucursal permitida por el modo actual.');
    } else {
      scopeBanner.textContent = `${userText('Tu alcance actual está limitado a')}: ${getBranchNameById(DB.currentUser?.sucursalId || getPrimaryBranchForUsers())}.`;
    }
  }
  if (roleHint) {
    const roleMeta = getRoleDefinitionForUsers(roleCode);
    const exclusiveNote = requiresCash && isExclusiveCashierPerRegisterUi()
      ? ` ${userText('La asignación exclusiva por caja está activa.')}`
      : '';
    const planLimitNote = roleCode === 'cajero' ? ` ${getCashierPlanLimitMessageUi()}` : '';
    roleHint.textContent = `${userText('Rol seleccionado')}: ${userText(roleMeta?.nombre || roleCode || 'Rol')}. ${userText('Función')}: ${userText(getUserBillingFunctionLabelUi(billingType))}.${exclusiveNote}${planLimitNote}`;
  }
  if (billingHint) {
    billingHint.textContent = getUserBillingFunctionHelpTextUi(billingType);
  }

  if (typeof translateDynamicUi === 'function') translateDynamicUi(document.getElementById('modal-overlay'));
}

function openUserModal(id = null) {
  if (id) return openEditUserModal(id);
  return openCreateUserModal();
}

function collectUserFormPayload(id = null) {
  const roleCode = normalizeUserRoleCodeClient(document.getElementById('nu-role-code')?.value);
  const mode = getBusinessStructureModeForUsers();
  const scopedBranches = getScopedBranchesForUserManagement();
  const globalScope = currentUserHasGlobalUserScopeUi();
  const requiresBranch = roleNeedsBranchUi(roleCode);
  const requiresCash = roleNeedsCashUi(roleCode);
  const branchId = !requiresBranch
    ? null
    : (mode === 'multisucursal' && globalScope && scopedBranches.length > 1
        ? (Number(document.getElementById('nu-branch-id')?.value || 0) || null)
        : (Number(DB.currentUser?.sucursalId || DB.currentUser?.branchId || scopedBranches[0]?.id || getPrimaryBranchForUsers() || 0) || null));
  const cashId = mode === 'monocaja'
    ? getPrimaryCashRegisterForUsers(branchId || getPrimaryBranchForUsers())
    : (!requiresCash ? null : (Number(document.getElementById('nu-cash-register-id')?.value || 0) || null));

  return {
    id,
    nombre: document.getElementById('nu-nombre')?.value.trim() || '',
    usuario: document.getElementById('nu-usuario')?.value.trim() || '',
    email: document.getElementById('nu-email')?.value.trim().toLowerCase() || '',
    password: document.getElementById('nu-pass')?.value || '',
    roleCode,
    billingType: document.getElementById('nu-billing-type')?.value || 'mixta',
    estado: document.getElementById('nu-estado')?.value || 'Activo',
    telefono: document.getElementById('nu-telefono')?.value.trim() || '',
    observacion: document.getElementById('nu-observacion')?.value.trim() || '',
    branchId,
    cashRegisterId: cashId
  };
}

async function saveUser(id = null) {
  if (!currentUserCanManageUsersUi()) {
    showToast(userText('Tu cuenta no tiene permiso para crear o editar usuarios.'), 'warning');
    return;
  }

  const payload = collectUserFormPayload(id);
  const mode = getBusinessStructureModeForUsers();
  const editingId = Number(id || 0) || null;
  const normalizedRole = normalizeUserRoleCodeClient(payload.roleCode);

  if (!payload.nombre || !payload.usuario) {
    showToast(userText('Completa nombre y usuario.'), 'error');
    return;
  }
  if (!normalizedRole) {
    showToast(userText('Debes seleccionar un rol.'), 'error');
    return;
  }
  if (!editingId && payload.password.length < 6) {
    showToast(userText('La contraseña debe tener al menos 6 caracteres.'), 'error');
    return;
  }
  if (editingId && payload.password && payload.password.length < 6) {
    showToast(userText('La contraseña debe tener al menos 6 caracteres.'), 'error');
    return;
  }
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    showToast(userText('El correo no tiene un formato válido.'), 'error');
    return;
  }
  if (normalizedRole === 'cajero' && String(payload.estado || 'Activo').trim().toLowerCase() === 'activo') {
    const cashierLimit = getCashierLimitForCurrentPlanUi();
    if (cashierLimit && countActiveCashiersForCurrentPlanUi(editingId) >= cashierLimit) {
      const planCode = getCurrentPlanCodeForUsersUi();
      const planName = window.TecnoCajaPlans?.PLAN_NAMES?.[planCode] || 'Tecno Caja Básico';
      showToast(`${planName} permite hasta ${cashierLimit} cajeros activos.`, 'warning');
      return;
    }
  }

  const duplicateUser = (DB.users || []).find((item) => item.id !== editingId && String(item.usuario || '').trim().toLowerCase() === payload.usuario.toLowerCase());
  if (duplicateUser) {
    showToast(userText('Ya existe otro usuario con ese nombre de acceso.'), 'error');
    return;
  }
  const duplicateEmail = payload.email
    ? (DB.users || []).find((item) => item.id !== editingId && String(item.email || '').trim().toLowerCase() === payload.email.toLowerCase())
    : null;
  if (duplicateEmail) {
    showToast(userText('Ya existe otro usuario usando ese correo.'), 'error');
    return;
  }

  if (roleNeedsBranchUi(normalizedRole) && !payload.branchId) {
    showToast(userText('Debes asignar una sucursal válida.'), 'error');
    return;
  }
  if (roleNeedsCashUi(normalizedRole) && (mode === 'multicaja' || mode === 'multisucursal') && isCashierRegisterRequiredUi() && !payload.cashRegisterId) {
    showToast(userText('Debes asignar una caja al cajero.'), 'error');
    return;
  }

  if (payload.cashRegisterId) {
    const selectedRegister = (DB.cajasSucursal || []).find((item) => Number(item.id) === Number(payload.cashRegisterId));
    if (!selectedRegister || (payload.branchId && Number(selectedRegister.sucursalId || 0) !== Number(payload.branchId || 0))) {
      showToast(userText('No puedes seleccionar una caja que pertenezca a otra sucursal.'), 'error');
      return;
    }
  }

  if (!currentUserHasGlobalUserScopeUi()) {
    const allowedBranchId = Number(DB.currentUser?.sucursalId || getPrimaryBranchForUsers() || 0) || null;
    if (payload.branchId && Number(payload.branchId) !== Number(allowedBranchId || 0)) {
      showToast(userText('No puedes crear usuarios fuera de tu sucursal.'), 'error');
      return;
    }
  }

  if (normalizedRole === 'cajero' && payload.cashRegisterId && isExclusiveCashierPerRegisterUi()) {
    const duplicateCashier = (DB.users || []).find((item) => {
      if (item.id === editingId) return false;
      if (String(item.estado || '').trim().toLowerCase() !== 'activo') return false;
      return normalizeUserRoleCodeClient(item.roleCode || item.rol) === 'cajero' && Number(item.cajaId || 0) === Number(payload.cashRegisterId || 0);
    });
    if (duplicateCashier) {
      showToast(`${userText('La caja seleccionada ya está asignada al cajero')} ${duplicateCashier.nombre}.`, 'error');
      return;
    }
  }

  try {
    const requestPayload = {
      nombre: payload.nombre,
      usuario: payload.usuario,
      email: payload.email,
      password: payload.password,
      roleCode: payload.roleCode,
      billingType: payload.billingType,
      estado: payload.estado,
      branchId: payload.branchId,
      cashRegisterId: payload.cashRegisterId,
      telefono: payload.telefono,
      observacion: payload.observacion,
      ...getActorPayload()
    };
    const saved = editingId ? await api.updateUser(editingId, requestPayload) : await api.createUser(requestPayload);
    DB.users = Array.isArray(DB.users) ? DB.users : [];
    if (editingId) {
      DB.users = DB.users.map((item) => item.id === editingId ? saved : item);
      if (DB.currentUser?.id === editingId) {
        DB.currentUser = { ...DB.currentUser, ...saved };
        document.querySelector('.user-name').textContent = DB.currentUser.nombre;
        document.querySelector('.user-role').textContent = DB.currentUser.rol;
        document.querySelector('.user-avatar').textContent = DB.currentUser.nombre[0];
        if (typeof syncColaCobróNav === 'function') syncColaCobróNav();
        if (typeof applyRolePermissions === 'function') applyRolePermissions();
      }
    } else {
      const existingIndex = (DB.users || []).findIndex((item) => Number(item.id) === Number(saved.id));
      if (existingIndex === -1) {
        DB.users.push(saved);
      } else {
        DB.users[existingIndex] = saved;
      }
    }
    try { localStorage.removeItem('tecnocaja-login-users-cache'); } catch (_error) {}

    closeAllModals();
    loadUsuariosTable();
    refreshAuditLogs();
    showToast(editingId ? userText('Usuario actualizado correctamente') : userText('Usuario creado correctamente'), 'success');
    if (saved?.firebaseAuthWarning) {
      showToast(saved.firebaseAuthWarning + ' ' + userText('Usa el botón "Sincronizar Firebase" para reintentarlo.'), 'warning');
    } else if (saved?.firebaseAuthSynced && requestPayload.email) {
      showToast(userText('La cuenta Firebase del usuario quedó lista para entrar en la app móvil con correo y contraseña.'), 'success');
    }

    // Si es repartidor, sincronizar automáticamente con Firestore collection 'repartidores'
    if (normalizedRole === 'repartidor' && saved?.id) {
      syncRepartidorToFirestore(saved.id);
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function syncRepartidorToFirestore(posUserId) {
  try {
    const result = await api.request(`/api/delivery/repartidores/sync/${posUserId}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (result?.ok) {
      showToast(userText('Repartidor registrado en la app de delivery correctamente.'), 'success');
    } else {
      showToast(result?.error || userText('No se pudo registrar en la app de delivery. Usa "Sincronizar Firebase" primero.'), 'warning');
    }
  } catch {
    showToast(userText('El usuario se guardó pero no se pudo sincronizar con la app de delivery. Usa "Sincronizar Firebase" primero.'), 'warning');
  }
}

async function syncUserToFirebase(userId) {
  if (!currentUserCanManageUsersUi()) {
    showToast(userText('Tu cuenta no tiene permiso para esta acción.'), 'warning');
    return;
  }
  const btn = document.querySelector('.nu-firebase-sync-btn');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = `⏳ ${userText('Sincronizando...')}`; }
  try {
    const result = await api.request(`/api/users/${userId}/sync-firebase`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    if (result.synced) {
      showToast(userText('¡Usuario sincronizado con Firebase! Ya puede entrar a la app de reportes con su correo y contraseña.'), 'success');
      const userIndex = (DB.users || []).findIndex((u) => u.id === userId);
      if (userIndex !== -1) DB.users[userIndex].googleLinked = true;
    } else {
      showToast(result.message || userText('No se pudo sincronizar con Firebase.'), 'warning');
    }
  } catch (error) {
    showToast(error.message || userText('Error al sincronizar con Firebase.'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
  }
}

async function syncDeliveryUser(userId) {
  if (!currentUserCanManageUsersUi()) {
    showToast(userText('Tu cuenta no tiene permiso para esta acción.'), 'warning');
    return;
  }
  const btn = document.querySelector('.nu-firebase-sync-btn');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = `⏳ ${userText('Sincronizando...')}`; }
  try {
    // Primero asegurar que tenga Firebase Auth
    await api.request(`/api/users/${userId}/sync-firebase`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    // Luego sincronizar a la colección repartidores
    const result = await api.request(`/api/delivery/repartidores/sync/${userId}`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    if (result?.ok) {
      showToast(userText('¡Repartidor sincronizado! Ya puede iniciar sesión en la app Tecno Caja Delivery.'), 'success');
    } else {
      showToast(result?.error || userText('No se pudo registrar en la app de delivery.'), 'warning');
    }
  } catch (error) {
    showToast(error.message || userText('Error al sincronizar repartidor.'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
  }
}

// ══════════════════════════════════════════════════════
// EDIT USER MODAL — EU namespace (tabbed, modern)
// ══════════════════════════════════════════════════════

const EU_STATE = {
  mode:      'edit',
  userId:    null,
  user:      null,
  snapshot:  null,
  activeTab: 'info',
  syncMeta:  null,
};

const EU_ROLE_META = {
  administrador_general:  { icon: '🌐', name: 'Administrador General',   desc: 'Acceso completo al sistema.',            perms: ['ventas','caja','inventario','clientes','reportes','usuarios','configuracion','facturacion_electronica','delivery'] },
  administrador_sucursal: { icon: '🏪', name: 'Admin. Sucursal',         desc: 'Gestiona su sucursal asignada.',         perms: ['ventas','caja','inventario','clientes','reportes','usuarios'] },
  cajero:                 { icon: '💰', name: 'Cajero',                  desc: 'Solo ventas y cobros.',                  perms: ['ventas','caja','clientes'] },
  supervisor:             { icon: '👁',  name: 'Supervisor',              desc: 'Supervisa sin configurar.',              perms: ['ventas','caja','inventario','reportes'] },
  repartidor:             { icon: '🛵', name: 'Delivery',                desc: 'App de delivery y pedidos.',             perms: ['delivery'] },
  contabilidad:           { icon: '📊', name: 'Contabilidad',            desc: 'Solo reportes financieros.',             perms: ['reportes','facturacion_electronica'] },
};

const EU_PERM_META = {
  ventas:                 { icon: '🛒', label: 'Ventas' },
  caja:                   { icon: '💳', label: 'Caja y cobros' },
  inventario:             { icon: '📦', label: 'Inventario' },
  clientes:               { icon: '👥', label: 'Clientes' },
  reportes:               { icon: '📊', label: 'Reportes' },
  usuarios:               { icon: '🔐', label: 'Gestión de usuarios' },
  configuracion:          { icon: '⚙',  label: 'Configuración' },
  facturacion_electronica:{ icon: '🧾', label: 'Facturación electrónica' },
  delivery:               { icon: '🛵', label: 'App Delivery' },
};

function openCreateUserModal() {
  if (!currentUserCanManageUsersUi()) {
    showToast(userText('Tu cuenta no tiene permiso para crear usuarios.'), 'warning');
    return;
  }
  const roles = getAssignableRolesForUi();
  if (!roles.length) {
    showToast(userText('No hay roles disponibles para tu alcance actual.'), 'warning');
    return;
  }
  euOpenUserModal(euBuildDraftUser(), { mode: 'create' });
}

function openEditUserModal(id) {
  if (!currentUserCanManageUsersUi()) {
    showToast(userText('Tu cuenta no tiene permiso para editar usuarios.'), 'warning');
    return;
  }
  const user = getScopedUsersForUserManagement().find(u => u.id === id);
  if (!user) {
    showToast(userText('No puedes editar este usuario.'), 'error');
    return;
  }
  euOpenUserModal(user, { mode: 'edit' });
}

function euOpenUserModal(user, options = {}) {
  const mode = options.mode === 'create' ? 'create' : 'edit';
  EU_STATE.mode = mode;
  EU_STATE.userId = mode === 'edit' ? Number(user?.id || 0) || null : null;
  EU_STATE.user = { ...user };
  EU_STATE.activeTab = 'info';
  EU_STATE.syncMeta = euBuildSyncMeta();

  euRenderHeader(EU_STATE.user);
  euRenderTabInfo(EU_STATE.user);
  euRenderTabPermisos(EU_STATE.user);
  euRenderTabConfig(EU_STATE.user);
  euRenderTabSync(EU_STATE.user);
  euUpdateFooterSyncBtn(EU_STATE.user);

  document.getElementById('eu-overlay').classList.remove('hidden');
  euSwitchTab('info');
  document.getElementById('eu-nombre')?.focus();
  void euRefreshSyncMeta();

  setTimeout(() => {
    EU_STATE.snapshot = euCollectValues();
    euUpdateChanges();
    euSetupChangeDetection();
  }, 50);
}

function euBuildDraftUser() {
  const roles = getAssignableRolesForUi();
  const defaultRoleCode = normalizeUserRoleCodeClient(roles[0]?.codigo || 'cajero');
  const defaultBranchId = Number(DB.currentUser?.sucursalId || DB.currentUser?.branchId || getPrimaryBranchForUsers() || 0) || null;
  const defaultCashId = roleNeedsCashUi(defaultRoleCode)
    ? (Number(getPrimaryCashRegisterForUsers(defaultBranchId || getPrimaryBranchForUsers()) || 0) || null)
    : null;
  return {
    id: null,
    nombre: '',
    usuario: '',
    email: '',
    telefono: '',
    observacion: '',
    roleCode: defaultRoleCode,
    rol: getRoleDefinitionForUsers(defaultRoleCode)?.nombre || 'Usuario',
    estado: 'Activo',
    tipoFacturacion: 'mixta',
    sucursalId: defaultBranchId,
    branchId: defaultBranchId,
    cajaId: defaultCashId,
    cashRegisterId: defaultCashId,
    firebaseUid: '',
    userNumber: '',
  };
}

function euClose() {
  document.getElementById('eu-overlay').classList.add('hidden');
  EU_STATE.mode = 'edit';
  EU_STATE.userId   = null;
  EU_STATE.user     = null;
  EU_STATE.snapshot = null;
  EU_STATE.syncMeta = null;
}

function euCloseOverlay(event) {
  if (event.target.id === 'eu-overlay') euClose();
}

function euSwitchTab(name, btn) {
  EU_STATE.activeTab = name;
  document.querySelectorAll('.eu-tab').forEach(t =>
    t.classList.toggle('eu-tab--active', t.dataset.tab === name));
  document.querySelectorAll('.eu-panel').forEach(p =>
    p.classList.toggle('eu-panel--hidden', p.id !== 'eu-panel-' + name));
  if (name === 'sync' && EU_STATE.user) {
    euRenderTabSync(EU_STATE.user);
  }
}

// ── Render: Header ────────────────────────────────────
function euRenderHeader(user) {
  const roleCode = normalizeUserRoleCodeClient(user?.roleCode || user?.rol);
  const meta = EU_ROLE_META[roleCode] || { name: user?.rol || 'Usuario' };
  document.getElementById('eu-avatar-text').textContent =
    String(user?.nombre || user?.usuario || (EU_STATE.mode === 'create' ? '+' : '?'))[0].toUpperCase();
  document.getElementById('eu-header-title').textContent = userText(EU_STATE.mode === 'create' ? 'Nuevo Usuario' : 'Editar Usuario');
  document.getElementById('eu-header-sub').textContent =
    EU_STATE.mode === 'create'
      ? `${userText('Crear acceso nuevo')} · ${meta.name || roleCode}`
      : `${user?.usuario || ''} · ${meta.name || roleCode}`;
}

// ── Render: Tab 1 — Información ───────────────────────
function euRenderTabInfo(user) {
  document.getElementById('eu-panel-info').innerHTML = `
    <div class="eu-field">
      <label class="eu-label">👤 ${userText('Nombre completo')} <span style="color:#f87171">*</span></label>
      <input id="eu-nombre" class="eu-input" type="text"
             placeholder="${userText('Ej: María Fernández')}"
             value="${escapeUserFieldHtml(user?.nombre || '')}" autocomplete="off">
    </div>
    <div class="eu-field">
      <label class="eu-label">🔖 ${userText('Usuario de acceso')} <span style="color:#f87171">*</span></label>
      <input id="eu-usuario" class="eu-input" type="text"
             placeholder="nombre.usuario"
             value="${escapeUserFieldHtml(user?.usuario || '')}" autocomplete="off">
      <div class="eu-field-error hidden" id="eu-usuario-error">⚠ ${userText('Ya existe otro usuario con ese nombre de acceso')}</div>
    </div>
    <div class="eu-field">
      <label class="eu-label">📧 ${userText('Correo electrónico')} <span title="${userText('Usado para acceso móvil y sincronización Firebase')}" style="cursor:help;opacity:.7">(?)</span></label>
      <input id="eu-email" class="eu-input" type="email"
             placeholder="usuario@negocio.com"
             value="${escapeUserFieldHtml(user?.email || '')}" autocomplete="off">
      <div class="eu-field-error hidden" id="eu-email-error">⚠ ${userText('Introduce un correo válido')}</div>
      <div class="eu-field-error hidden" id="eu-email-duplicate-error">⚠ ${userText('Ya existe otro usuario usando ese correo')}</div>
    </div>
    <div class="eu-field">
      <label class="eu-label">📱 ${userText('Teléfono')}</label>
      <input id="eu-telefono" class="eu-input" type="text"
             placeholder="${userText('Opcional')}"
             value="${escapeUserFieldHtml(user?.telefono || '')}">
    </div>
    <div class="eu-field">
      <label class="eu-label">📝 ${userText('Observación')}</label>
      <textarea id="eu-observacion" class="eu-input" rows="2"
                style="resize:vertical;min-height:58px"
                placeholder="${userText('Notas internas opcionales')}">${escapeUserFieldHtml(user?.observacion || '')}</textarea>
    </div>
  `;
}

// ── Render: Tab 2 — Permisos ──────────────────────────
function euRenderTabPermisos(user) {
  const roles = getAssignableRolesForUi();
  const currentRoleCode = normalizeUserRoleCodeClient(user?.roleCode || user?.rol);
  const currentBranchId = Number(user?.sucursalId || user?.branchId || getPrimaryBranchForUsers() || 0);
  const currentCashId = Number(user?.cajaId || user?.cashRegisterId || getPrimaryCashRegisterForUsers(currentBranchId) || 0);

  const roleCards = roles.map(r => {
    const code = normalizeUserRoleCodeClient(r.codigo);
    const meta = EU_ROLE_META[code] || { icon: '👤', name: r.nombre, desc: '' };
    return `
      <button class="eu-role-card ${code === currentRoleCode ? 'eu-role-card--active' : ''}"
              data-role="${escapeUserFieldHtml(r.codigo)}"
              onclick="euSelectRole('${escapeUserFieldHtml(r.codigo)}', this)">
        <div class="eu-role-icon">${meta.icon}</div>
        <div class="eu-role-name">${escapeUserFieldHtml(meta.name || r.nombre)}</div>
        <div class="eu-role-desc">${escapeUserFieldHtml(meta.desc || '')}</div>
      </button>`;
  }).join('');

  const currentMeta = EU_ROLE_META[currentRoleCode] || { perms: [] };
  const permList = Object.entries(EU_PERM_META).map(([key, pm]) => {
    const on = currentMeta.perms.includes(key);
    return `<div class="eu-perm-item">
      <div class="eu-perm-check ${on ? 'eu-perm-check--on' : 'eu-perm-check--off'}">${on ? '✓' : ''}</div>
      <span>${pm.icon} ${userText(pm.label)}</span>
    </div>`;
  }).join('');

  document.getElementById('eu-panel-permisos').innerHTML = `
    <input type="hidden" id="eu-role-code" value="${currentRoleCode}">
    <div class="eu-section-title">${userText('Seleccionar rol')}</div>
    <div class="eu-roles-grid" id="eu-roles-grid">${roleCards}</div>
    <div class="eu-perms-section">
      <div class="eu-perms-title">${userText('Permisos del rol seleccionado')} <span title="${userText('Los permisos se derivan del rol actual de este usuario')}" style="cursor:help;opacity:.7">(?)</span></div>
      <div class="eu-perm-list" id="eu-perm-list">${permList}</div>
    </div>
    <div id="eu-role-assignment"></div>
  `;
  euRenderRoleAssignment(currentRoleCode, currentBranchId, currentCashId);
}

function euSelectRole(roleCode, btn) {
  document.getElementById('eu-role-code').value = roleCode;
  document.querySelectorAll('.eu-role-card').forEach(c => c.classList.remove('eu-role-card--active'));
  btn.classList.add('eu-role-card--active');
  const code = normalizeUserRoleCodeClient(roleCode);
  const meta = EU_ROLE_META[code] || { perms: [] };
  const list = document.getElementById('eu-perm-list');
  if (list) {
    list.innerHTML = Object.entries(EU_PERM_META).map(([key, pm]) => {
      const on = meta.perms.includes(key);
      return `<div class="eu-perm-item">
        <div class="eu-perm-check ${on ? 'eu-perm-check--on' : 'eu-perm-check--off'}">${on ? '✓' : ''}</div>
        <span>${pm.icon} ${userText(pm.label)}</span>
      </div>`;
    }).join('');
  }
  const branchId = Number(document.getElementById('eu-branch-id')?.value || EU_STATE.user?.sucursalId || EU_STATE.user?.branchId || getPrimaryBranchForUsers() || 0);
  const cashId = Number(document.getElementById('eu-cash-id')?.value || EU_STATE.user?.cajaId || EU_STATE.user?.cashRegisterId || getPrimaryCashRegisterForUsers(branchId) || 0);
  euRenderRoleAssignment(roleCode, branchId, cashId);
  euUpdateChanges();
}

function euUpdateCashDropdown() {
  const branchId = Number(document.getElementById('eu-branch-id')?.value || getPrimaryBranchForUsers() || 0);
  const roleCode = document.getElementById('eu-role-code')?.value || EU_STATE.user?.roleCode || EU_STATE.user?.rol || '';
  euRenderRoleAssignment(roleCode, branchId, Number(document.getElementById('eu-cash-id')?.value || 0));
  euUpdateChanges();
}

function euRenderRoleAssignment(roleCode, branchId, cashId) {
  const container = document.getElementById('eu-role-assignment');
  if (!container) return;

  const normalizedRole = normalizeUserRoleCodeClient(roleCode);
  const mode = getBusinessStructureModeForUsers();
  const scopedBranches = getScopedBranchesForUserManagement();
  const effectiveBranchId = Number(branchId || EU_STATE.user?.sucursalId || EU_STATE.user?.branchId || getPrimaryBranchForUsers() || 0) || null;
  const effectiveCashId = Number(cashId || EU_STATE.user?.cajaId || EU_STATE.user?.cashRegisterId || getPrimaryCashRegisterForUsers(effectiveBranchId) || 0) || null;
  const showBranchSelect = roleNeedsBranchUi(normalizedRole) && mode === 'multisucursal' && scopedBranches.length > 1;
  const showCashSelect = roleNeedsCashUi(normalizedRole) && (mode === 'multicaja' || mode === 'multisucursal');
  const cashRegisters = getCashRegistersForUserManagement(effectiveBranchId || getPrimaryBranchForUsers());

  let html = '';
  if (!roleNeedsBranchUi(normalizedRole) && !roleNeedsCashUi(normalizedRole)) {
    container.innerHTML = `
      <input type="hidden" id="eu-branch-id" value="">
      <input type="hidden" id="eu-cash-id" value="">
    `;
    return;
  }

  html += `<div class="eu-section-title" style="margin-top:0.5rem">${userText('Asignación')}</div>`;

  if (showBranchSelect) {
    const branchOptions = scopedBranches.map((branch) => `
      <option value="${branch.id}" ${Number(branch.id) === Number(effectiveBranchId || 0) ? 'selected' : ''}>
        ${escapeUserFieldHtml(branch.nombre)}
      </option>
    `).join('');
    html += `
      <div class="eu-field">
        <label class="eu-label">🏪 ${userText('Sucursal')}</label>
        <select id="eu-branch-id" class="eu-input" onchange="euUpdateCashDropdown()">${branchOptions}</select>
      </div>
    `;
  } else {
    html += `
      <input type="hidden" id="eu-branch-id" value="${effectiveBranchId || ''}">
      <div class="eu-id-card" style="margin-top:.2rem">
        <div class="eu-id-card-label">🏪 ${userText('Sucursal')}</div>
        <div class="eu-id-card-value ${effectiveBranchId ? '' : 'eu-id-missing'}">${escapeUserFieldHtml(getBranchNameById(effectiveBranchId) || userText('No aplica'))}</div>
      </div>
    `;
  }

  if (showCashSelect) {
    const cashOptions = (cashRegisters.length ? cashRegisters : []).map((register) => `
      <option value="${register.id}" ${Number(register.id) === Number(effectiveCashId || 0) ? 'selected' : ''}>
        ${escapeUserFieldHtml(register.nombre)}
      </option>
    `).join('');
    html += `
      <div class="eu-field">
        <label class="eu-label">🖥 ${userText('Caja')}</label>
        <select id="eu-cash-id" class="eu-input" onchange="euUpdateChanges()">
          <option value="">${userText('Selecciona una caja')}</option>
          ${cashOptions}
        </select>
      </div>
    `;
  } else if (roleNeedsCashUi(normalizedRole)) {
    html += `
      <input type="hidden" id="eu-cash-id" value="${effectiveCashId || ''}">
      <div class="eu-id-card" style="margin-top:.2rem">
        <div class="eu-id-card-label">🖥 ${userText('Caja')}</div>
        <div class="eu-id-card-value ${effectiveCashId ? '' : 'eu-id-missing'}">${escapeUserFieldHtml(getCashRegisterNameById(effectiveCashId) || userText('No disponible'))}</div>
      </div>
    `;
  } else {
    html += `<input type="hidden" id="eu-cash-id" value="">`;
  }

  container.innerHTML = html;
}

// ── Render: Tab 3 — Configuración ─────────────────────
function euRenderTabConfig(user) {
  const isCreate = EU_STATE.mode === 'create';
  const estado      = user?.estado || 'Activo';
  const billingType = user?.tipoFacturacion || 'mixta';
  const statuses = [
    { val: 'Activo',     dot: '🟢', label: userText('Activo') },
    { val: 'Inactivo',   dot: '🔴', label: userText('Inactivo') },
    { val: 'Suspendido', dot: '🟡', label: userText('Suspendido') },
  ];

  document.getElementById('eu-panel-config').innerHTML = `
    <div class="eu-section-title">${userText('Estado de la cuenta')}</div>
    <div class="eu-status-selector">
      ${statuses.map(s => `
        <button class="eu-status-opt ${estado === s.val ? 'eu-status-opt--active' : ''}"
                data-status="${s.val}" onclick="euSelectStatus('${s.val}', this)">
          <span class="eu-status-dot">${s.dot}</span>
          <span>${s.label}</span>
        </button>`).join('')}
    </div>
    <input type="hidden" id="eu-estado" value="${estado}">

    <div class="eu-section-title" style="margin-top:0.25rem">${userText('Función de facturación')}</div>
    <div class="eu-field">
      <label class="eu-label">🧾 ${userText('Función de facturación')} <span title="${userText('Define cómo opera este usuario en caja y facturación')}" style="cursor:help;opacity:.7">(?)</span></label>
      <select id="eu-billing-type" class="eu-input" onchange="euUpdateChanges()">
        <option value="mixta"          ${billingType==='mixta'          ? 'selected':''}>Mixta</option>
        <option value="facturacion"    ${billingType==='facturacion'    ? 'selected':''}>Solo factura</option>
        <option value="cobro"          ${billingType==='cobro'          ? 'selected':''}>Solo cobra</option>
        <option value="centralizadora" ${billingType==='centralizadora' ? 'selected':''}>Centralizadora</option>
      </select>
    </div>

    <div class="eu-section-title" style="margin-top:0.25rem">${userText('Seguridad')}</div>
    <div class="eu-field">
      <label class="eu-label">🔑 ${userText('Nueva contraseña')}
        <span style="font-weight:400;opacity:0.6;font-size:0.73rem">(${userText(isCreate ? 'obligatoria para crear el usuario' : 'vacío = sin cambios')})</span>
      </label>
      <div class="eu-pass-wrap">
        <input id="eu-pass" class="eu-input" type="password"
               placeholder="${userText('Mínimo 6 caracteres')}" style="padding-right:2.5rem"
               oninput="euOnPasswordInput(this.value)" autocomplete="new-password">
        <button class="eu-pass-toggle" type="button" onclick="euTogglePass('eu-pass',this)" aria-label="${userText('Mostrar')}">👁</button>
      </div>
      <div class="eu-strength-bar"><div class="eu-strength-fill" id="eu-strength-fill"></div></div>
      <div class="eu-strength-label hidden" id="eu-strength-label"></div>
    </div>
    <div class="eu-field">
      <label class="eu-label">🔑 ${userText('Confirmar contraseña')}</label>
      <div class="eu-pass-wrap">
        <input id="eu-pass-confirm" class="eu-input" type="password"
               placeholder="${userText('Repetir contraseña')}" style="padding-right:2.5rem"
               oninput="euOnConfirmInput()" autocomplete="new-password">
        <button class="eu-pass-toggle" type="button" onclick="euTogglePass('eu-pass-confirm',this)" aria-label="${userText('Mostrar')}">👁</button>
      </div>
      <div class="eu-field-error hidden" id="eu-pass-match-error">⚠ ${userText('Las contraseñas no coinciden')}</div>
    </div>
  `;
}

function euSelectStatus(val, btn) {
  document.querySelectorAll('.eu-status-opt').forEach(b => b.classList.remove('eu-status-opt--active'));
  btn.classList.add('eu-status-opt--active');
  document.getElementById('eu-estado').value = val;
  euUpdateChanges();
}

function euOnPasswordInput(val) {
  euUpdateChanges();
  const fill  = document.getElementById('eu-strength-fill');
  const label = document.getElementById('eu-strength-label');
  if (!fill || !label) return;
  if (!val) { fill.style.width = '0%'; label.classList.add('hidden'); return; }
  const str = euPasswordStrength(val);
  label.classList.remove('hidden');
  const map = {
    weak:   ['33%','#f87171','eu-strength-label eu-weak',  userText('Contraseña débil')],
    medium: ['66%','#fbbf24','eu-strength-label eu-medium', userText('Contraseña media')],
    strong: ['100%','#22c55e','eu-strength-label eu-strong', userText('Contraseña fuerte')],
  };
  const [w, bg, cls, txt] = map[str];
  fill.style.width = w; fill.style.background = bg;
  label.className = cls; label.textContent = txt;
  euOnConfirmInput();
}

function euOnConfirmInput() {
  const pass    = document.getElementById('eu-pass')?.value || '';
  const confirm = document.getElementById('eu-pass-confirm')?.value || '';
  const err     = document.getElementById('eu-pass-match-error');
  if (!err) return;
  err.classList.toggle('hidden', !confirm || pass === confirm);
}

function euPasswordStrength(pass) {
  let s = 0;
  if (pass.length >= 8)              s++;
  if (pass.length >= 12)             s++;
  if (/[A-Z]/.test(pass))            s++;
  if (/[0-9]/.test(pass))            s++;
  if (/[^A-Za-z0-9]/.test(pass))    s++;
  return s <= 1 ? 'weak' : s <= 3 ? 'medium' : 'strong';
}

function euTogglePass(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? '🔒' : '👁';
}

// ── Render: Tab 4 — Sincronización ────────────────────
function euRenderTabSync(user) {
  const isCreate = EU_STATE.mode === 'create';
  const identity   = euGetIdentityData(user);
  const hasUid     = Boolean(identity.firebaseUid);
  const isDelivery = normalizeUserRoleCodeClient(user?.roleCode || user?.rol) === 'repartidor';
  const canSync = Boolean(EU_STATE.userId);

  document.getElementById('eu-panel-sync').innerHTML = `
    <div class="eu-sync-status-card ${hasUid ? 'eu-sync-ok' : 'eu-sync-warn'}">
      <div class="eu-sync-status-dot">${hasUid ? '🟢' : (isCreate ? '🟡' : '🔴')}</div>
      <div>
        <div class="eu-sync-status-text">${hasUid ? userText('Sincronizado con Firebase') : userText(isCreate ? 'Pendiente de creación' : 'Sin sincronización Firebase')}</div>
        <div class="eu-sync-status-sub">${hasUid ? userText('El usuario puede acceder a las apps móviles') : userText(isCreate ? 'Guarda el usuario para generar sus identificadores y acceso móvil' : 'Requiere sincronización para acceso móvil')}</div>
      </div>
    </div>

    <div class="eu-section-title">${userText('Identidad — Solo lectura')}</div>
    <div class="eu-identity-grid">
      <div class="eu-id-card">
        <div class="eu-id-card-label">🔒 ${userText('Usuario')}</div>
        <div class="eu-id-card-value">${escapeUserFieldHtml(identity.userNumber)}</div>
      </div>
      <div class="eu-id-card">
        <div class="eu-id-card-label">🔥 Firebase UID</div>
        <div class="eu-id-card-value ${hasUid ? '' : 'eu-id-missing'}" title="${escapeUserFieldHtml(identity.firebaseUid)}">
          ${hasUid ? escapeUserFieldHtml(identity.firebaseUid) : userText('No asignado')}
        </div>
      </div>
      <div class="eu-id-card">
        <div class="eu-id-card-label">🏢 ${userText('Business')}</div>
        <div class="eu-id-card-value ${identity.businessId ? '' : 'eu-id-missing'}">${escapeUserFieldHtml(identity.businessId || userText('No disponible'))}</div>
      </div>
      <div class="eu-id-card">
        <div class="eu-id-card-label">📄 ${userText('Licencia')}</div>
        <div class="eu-id-card-value ${identity.licenseId ? '' : 'eu-id-missing'}">${escapeUserFieldHtml(identity.licenseId || userText('No disponible'))}</div>
      </div>
    </div>

    <div class="eu-section-title">${userText('Aplicaciones vinculadas')}</div>
    <div class="eu-sync-apps">
      <div class="eu-sync-app-row">
        <span class="eu-sync-app-icon ${hasUid ? 'ok' : 'warn'}">${hasUid ? '✓' : '○'}</span>
        <span>🔐 Firebase Authentication</span>
      </div>
      <div class="eu-sync-app-row">
        <span class="eu-sync-app-icon ${hasUid ? 'ok' : 'warn'}">${hasUid ? '✓' : '○'}</span>
        <span>📊 ${userText('App Reportes')}</span>
      </div>
      ${isDelivery ? `<div class="eu-sync-app-row">
        <span class="eu-sync-app-icon ${hasUid ? 'ok' : 'warn'}">${hasUid ? '✓' : '○'}</span>
        <span>🛵 ${userText('App Delivery')}</span>
      </div>` : ''}
    </div>

    <div class="eu-section-title">${userText('Acciones de sincronización')}</div>
    <div class="eu-sync-actions">
      <button class="eu-sync-action-btn" id="eu-sync-firebase-btn" onclick="euSyncFirebase()" ${canSync ? '' : 'disabled title="Guarda el usuario primero"'}>🔄 ${userText('Sincronizar ahora')}</button>
      <button class="eu-sync-action-btn" id="eu-repair-btn"        onclick="euRepairSync()" ${canSync ? '' : 'disabled title="Guarda el usuario primero"'}>🧹 ${userText('Reparar sincronización')}</button>
      ${isDelivery ? `<button class="eu-sync-action-btn" id="eu-sync-delivery-btn" onclick="euSyncDelivery()" ${canSync ? '' : 'disabled title="Guarda el usuario primero"'}>🔁 ${userText('Reintentar Delivery')}</button>` : ''}
    </div>
  `;
}

function euUpdateFooterSyncBtn(user) {
  const btn = document.getElementById('eu-footer-sync-btn');
  const saveBtn = document.getElementById('eu-save-btn');
  if (btn) btn.textContent = `🔄 ${userText(EU_STATE.mode === 'create' ? 'Crear y sincronizar' : 'Guardar y sincronizar')}`;
  if (saveBtn) saveBtn.textContent = `${EU_STATE.mode === 'create' ? '➕' : '💾'} ${userText(EU_STATE.mode === 'create' ? 'Crear usuario' : 'Guardar cambios')}`;
}

// ── Change detection ───────────────────────────────────
function euSetupChangeDetection() {
  ['eu-nombre','eu-usuario','eu-email','eu-telefono','eu-observacion',
   'eu-pass','eu-pass-confirm','eu-billing-type','eu-estado','eu-branch-id','eu-cash-id'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', euUpdateChanges);
    el.addEventListener('change', euUpdateChanges);
  });
  document.getElementById('eu-email')?.addEventListener('input', euValidateEmailField);
  document.getElementById('eu-email')?.addEventListener('input', euValidateDuplicateFields);
  document.getElementById('eu-usuario')?.addEventListener('input', euValidateDuplicateFields);
}

function euCollectValues() {
  return {
    nombre:      document.getElementById('eu-nombre')?.value.trim()         || '',
    usuario:     document.getElementById('eu-usuario')?.value.trim()        || '',
    email:       document.getElementById('eu-email')?.value.trim().toLowerCase() || '',
    telefono:    document.getElementById('eu-telefono')?.value.trim()       || '',
    observacion: document.getElementById('eu-observacion')?.value.trim()    || '',
    roleCode:    document.getElementById('eu-role-code')?.value             || '',
    estado:      document.getElementById('eu-estado')?.value                || '',
    billingType: document.getElementById('eu-billing-type')?.value          || '',
    branchId:    document.getElementById('eu-branch-id')?.value             || '',
    cashId:      document.getElementById('eu-cash-id')?.value               || '',
    password:    document.getElementById('eu-pass')?.value                  || '',
  };
}

function euGetChangedFields() {
  if (!EU_STATE.snapshot) return [];
  const cur = euCollectValues();
  return Object.keys(cur).filter(k => {
    if (k === 'password') return Boolean(cur[k]);
    return cur[k] !== EU_STATE.snapshot[k];
  });
}

function euUpdateChanges() {
  const changed = euGetChangedFields();
  const pill    = document.getElementById('eu-changes-pill');
  if (!pill) return;
  const curPass   = euCollectValues().password;
  const realChanges = changed.filter(k => k !== 'password' || curPass);
  if (!realChanges.length) {
    pill.textContent = ''; pill.className = 'eu-changes-pill'; return;
  }
  const labels = { nombre:'Nombre', usuario:'Usuario', email:'Correo', telefono:'Teléfono',
    observacion:'Observación', roleCode:'Rol', estado:'Estado', billingType:'Facturación',
    branchId:'Sucursal', cashId:'Caja', password:'Contraseña' };
  pill.innerHTML = '✏ ' + realChanges.map(k => labels[k] || k).join(', ');
  pill.className = 'eu-changes-pill eu-changed';
}

// ── Save ───────────────────────────────────────────────
async function euSave(options = {}) {
  const isCreateMode = EU_STATE.mode === 'create';
  const values   = euCollectValues();
  const changed  = euGetChangedFields();
  const realChanges = changed.filter(k => k !== 'password' || values.password);
  if (!realChanges.length && !isCreateMode) {
    showToast(userText('Sin cambios detectados'), 'info'); return;
  }

  // Validation
  if (!values.nombre || !values.usuario) {
    showToast(userText('Completa nombre y usuario.'), 'error');
    euSwitchTab('info'); return;
  }
  if (!euValidateEmailField() || !euValidateDuplicateFields()) {
    euSwitchTab('info');
    showToast(userText('Corrige los errores antes de guardar.'), 'error'); return;
  }
  if (!values.roleCode) {
    euSwitchTab('permisos');
    showToast(userText('Debes seleccionar un rol.'), 'error'); return;
  }
  if (isCreateMode && !values.password) {
    euSwitchTab('config');
    showToast(userText('Debes definir una contraseña para el nuevo usuario.'), 'error'); return;
  }
  if (values.password && values.password.length < 6) {
    euSwitchTab('config');
    showToast(userText('La contraseña debe tener al menos 6 caracteres.'), 'error'); return;
  }
  const confirmVal = document.getElementById('eu-pass-confirm')?.value || '';
  if (values.password && confirmVal && values.password !== confirmVal) {
    euSwitchTab('config');
    showToast(userText('Las contraseñas no coinciden.'), 'error'); return;
  }

  const editingId = EU_STATE.userId;
  const mode = getBusinessStructureModeForUsers();
  const normalizedRole = normalizeUserRoleCodeClient(values.roleCode);
  const branchId = Number(values.branchId || 0) || null;
  const cashRegisterId = Number(values.cashId || 0) || null;
  if (normalizedRole === 'cajero' && String(values.estado || 'Activo').trim().toLowerCase() === 'activo') {
    const cashierLimit = getCashierLimitForCurrentPlanUi();
    if (cashierLimit && countActiveCashiersForCurrentPlanUi(editingId) >= cashierLimit) {
      const planCode = getCurrentPlanCodeForUsersUi();
      const planName = window.TecnoCajaPlans?.PLAN_NAMES?.[planCode] || 'Tecno Caja Básico';
      showToast(`${planName} permite hasta ${cashierLimit} cajeros activos.`, 'warning');
      return;
    }
  }
  if (roleNeedsBranchUi(normalizedRole) && !branchId) {
    euSwitchTab('permisos');
    showToast(userText('Debes asignar una sucursal válida.'), 'error'); return;
  }
  if (roleNeedsCashUi(normalizedRole) && (mode === 'multicaja' || mode === 'multisucursal') && isCashierRegisterRequiredUi() && !cashRegisterId) {
    euSwitchTab('permisos');
    showToast(userText('Debes asignar una caja al cajero.'), 'error'); return;
  }
  if (cashRegisterId) {
    const selectedRegister = (DB.cajasSucursal || []).find((item) => Number(item.id) === cashRegisterId);
    if (!selectedRegister || (branchId && Number(selectedRegister.sucursalId || 0) !== Number(branchId || 0))) {
      euSwitchTab('permisos');
      showToast(userText('No puedes seleccionar una caja que pertenezca a otra sucursal.'), 'error'); return;
    }
  }
  if (!currentUserHasGlobalUserScopeUi()) {
    const allowedBranchId = Number(DB.currentUser?.sucursalId || getPrimaryBranchForUsers() || 0) || null;
    if (branchId && Number(branchId) !== Number(allowedBranchId || 0)) {
      euSwitchTab('permisos');
      showToast(userText('No puedes crear usuarios fuera de tu sucursal.'), 'error'); return;
    }
  }
  if (normalizedRole === 'cajero' && cashRegisterId && isExclusiveCashierPerRegisterUi()) {
    const duplicateCashier = (DB.users || []).find((item) => {
      if (item.id === editingId) return false;
      if (String(item.estado || '').trim().toLowerCase() !== 'activo') return false;
      return normalizeUserRoleCodeClient(item.roleCode || item.rol) === 'cajero' && Number(item.cajaId || 0) === Number(cashRegisterId || 0);
    });
    if (duplicateCashier) {
      euSwitchTab('permisos');
      showToast(`${userText('La caja seleccionada ya está asignada al cajero')} ${duplicateCashier.nombre}.`, 'error');
      return;
    }
  }

  const btn = document.getElementById('eu-save-btn');
  const syncBtn = document.getElementById('eu-footer-sync-btn');
  const btns = [btn, syncBtn].filter(Boolean);
  const syncAfterSave = options.syncAfterSave === true;
  const savedButtonText = btn?.textContent || '';
  const savedSyncText = syncBtn?.textContent || '';
  btns.forEach((button) => { button.disabled = true; });
  if (btn) btn.textContent = `⏳ ${userText('Guardando...')}`;
  if (syncAfterSave && syncBtn) syncBtn.textContent = `⏳ ${userText('Guardando y sincronizando...')}`;

  try {
    let saved;
    if (isCreateMode) {
      const payload = {
        nombre: values.nombre,
        usuario: values.usuario,
        email: values.email,
        password: values.password,
        roleCode: values.roleCode,
        billingType: values.billingType,
        estado: values.estado,
        branchId,
        cashRegisterId,
        telefono: values.telefono,
        observacion: values.observacion,
        ...getActorPayload()
      };
      saved = await api.createUser(payload);
      DB.users = Array.isArray(DB.users) ? DB.users : [];
      const existingIndex = DB.users.findIndex((item) => Number(item.id) === Number(saved.id));
      if (existingIndex === -1) DB.users.push(saved);
      else DB.users[existingIndex] = saved;
      EU_STATE.mode = 'edit';
      EU_STATE.userId = saved.id;
      EU_STATE.user = { ...saved };
    } else {
      const payload = { ...getActorPayload() };
      if (realChanges.includes('nombre')) payload.nombre = values.nombre;
      if (realChanges.includes('usuario')) payload.usuario = values.usuario;
      if (realChanges.includes('email')) payload.email = values.email;
      if (realChanges.includes('roleCode')) payload.roleCode = values.roleCode;
      if (realChanges.includes('billingType')) payload.billingType = values.billingType;
      if (realChanges.includes('estado')) payload.estado = values.estado;
      if (realChanges.includes('telefono')) payload.telefono = values.telefono;
      if (realChanges.includes('observacion')) payload.observacion = values.observacion;
      if (realChanges.includes('branchId')) payload.branchId = branchId;
      if (realChanges.includes('cashId')) payload.cashRegisterId = cashRegisterId;
      if (realChanges.includes('password')) payload.password = values.password;

      saved = await api.updateUser(editingId, payload);
      DB.users = (DB.users || []).map(u => u.id === editingId ? { ...u, ...saved } : u);
      EU_STATE.user = { ...EU_STATE.user, ...saved };
      if (DB.currentUser?.id === editingId) {
        DB.currentUser = { ...DB.currentUser, ...saved };
        document.querySelector('.user-name')?.textContent   && (document.querySelector('.user-name').textContent   = DB.currentUser.nombre);
        document.querySelector('.user-role')?.textContent   && (document.querySelector('.user-role').textContent   = DB.currentUser.rol);
        document.querySelector('.user-avatar')?.textContent && (document.querySelector('.user-avatar').textContent = DB.currentUser.nombre[0]);
        if (typeof syncColaCobróNav  === 'function') syncColaCobróNav();
        if (typeof applyRolePermissions === 'function') applyRolePermissions();
      }
    }
    if (normalizedRole === 'repartidor' && saved?.id) {
      syncRepartidorToFirestore(saved.id).catch(() => {});
    }

    euUpdateFooterSyncBtn(EU_STATE.user);
    EU_STATE.snapshot = euCollectValues();
    euUpdateChanges();
    loadUsuariosTable();
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs();
    showToast(userText(isCreateMode ? 'Usuario creado correctamente' : 'Usuario actualizado correctamente'), 'success');
    if (saved?.firebaseAuthWarning) showToast(saved.firebaseAuthWarning, 'warning');
    else if (isCreateMode && saved?.firebaseAuthSynced && values.email) {
      showToast(userText('La cuenta Firebase del usuario quedó lista para entrar en la app móvil con correo y contraseña.'), 'success');
    }
    if (syncAfterSave) {
      await euFooterSync({ skipSave: true });
      euClose();
      return saved;
    }
    euClose();
    return saved;
  } catch (err) {
    showToast(err.message || userText('Error al guardar'), 'error');
  } finally {
    btns.forEach((button) => { button.disabled = false; });
    if (btn) btn.textContent = savedButtonText || `💾 ${userText('Guardar cambios')}`;
    if (syncBtn) syncBtn.textContent = savedSyncText || `🔄 ${userText('Guardar y sincronizar')}`;
  }
}

// ── Footer sync button (routes by role) ───────────────
async function euFooterSync(options = {}) {
  const user = EU_STATE.user;
  if (!user) return;
  if (!options.skipSave) return euSaveAndSync();
  const isDelivery = normalizeUserRoleCodeClient(user?.roleCode || user?.rol) === 'repartidor';
  if (isDelivery) await euSyncDelivery(); else await euSyncFirebase();
}

async function euSaveAndSync() {
  const changes = euGetChangedFields().filter((key) => key !== 'password' || euCollectValues().password);
  if (changes.length) {
    await euSave({ syncAfterSave: true });
    return;
  }
  await euFooterSync({ skipSave: true });
}

// ── Sync actions ───────────────────────────────────────
async function euSyncFirebase() {
  const userId = EU_STATE.userId;
  if (!userId) {
    showToast(userText('Guarda el usuario primero para poder sincronizarlo.'), 'warning');
    return;
  }
  const btn = document.getElementById('eu-sync-firebase-btn') || document.getElementById('eu-footer-sync-btn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = `⏳ ${userText('Sincronizando...')}`; }
  try {
    const result = await api.request('/api/users/' + userId + '/sync-firebase', { method:'POST', body:JSON.stringify({}) });
    if (result.synced) {
      showToast(userText('Usuario sincronizado con Firebase correctamente.'), 'success');
      if (EU_STATE.user) { EU_STATE.user = { ...EU_STATE.user, firebaseUid: result.uid || EU_STATE.user.firebaseUid, firebase_uid: result.uid || EU_STATE.user.firebase_uid }; euRenderTabSync(EU_STATE.user); }
      const u = (DB.users||[]).find(u => u.id === userId);
      if (u) {
        u.firebaseUid = result.uid || u.firebaseUid || '';
        u.firebase_uid = result.uid || u.firebase_uid || '';
        u.googleLinked = Boolean(result.uid || u.googleLinked);
      }
    } else {
      showToast(result.message || userText('No se pudo sincronizar con Firebase.'), 'warning');
    }
  } catch (err) {
    showToast(err.message || userText('Error al sincronizar con Firebase.'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

async function euSyncDelivery() {
  const userId = EU_STATE.userId;
  if (!userId) {
    showToast(userText('Guarda el usuario primero para poder sincronizarlo.'), 'warning');
    return;
  }
  const btn = document.getElementById('eu-sync-delivery-btn') || document.getElementById('eu-footer-sync-btn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = `⏳ ${userText('Sincronizando...')}`; }
  try {
    await api.request('/api/users/' + userId + '/sync-firebase', { method:'POST', body:JSON.stringify({}) });
    const result = await api.request('/api/delivery/repartidores/sync/' + userId, { method:'POST', body:JSON.stringify({}) });
    if (result?.ok) showToast(userText('Repartidor sincronizado con la app Delivery.'), 'success');
    else showToast(result?.error || userText('No se pudo sincronizar con Delivery.'), 'warning');
  } catch (err) {
    showToast(err.message || userText('Error al sincronizar con Delivery.'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

async function euRepairSync() {
  if (!EU_STATE.userId) {
    showToast(userText('Guarda el usuario primero para habilitar esta acción.'), 'warning');
    return;
  }
  const btn = document.getElementById('eu-repair-btn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = `⏳ ${userText('Reparando...')}`; }
  try {
    await api.request('/api/firebase-sync/accounts', { method:'POST', body:JSON.stringify({}) });
    showToast(userText('Sincronización reparada correctamente.'), 'success');
  } catch (err) {
    showToast(err.message || userText('Error al reparar la sincronización.'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

function euBuildSyncMeta() {
  return {
    businessId: String(DB?.config?.firebaseBusinessId || '').trim(),
    licenseId: String(window._lbsLicenseUid || DB?.config?.licenseUid || '').trim(),
  };
}

async function euRefreshSyncMeta() {
  try {
    const status = await api.request('/api/firebase-reports/status');
    EU_STATE.syncMeta = {
      businessId: String(status?.businessId || EU_STATE.syncMeta?.businessId || '').trim(),
      licenseId: String(status?.licenseUid || EU_STATE.syncMeta?.licenseId || window._lbsLicenseUid || '').trim(),
    };
    if (EU_STATE.user) {
      euRenderTabSync(EU_STATE.user);
    }
  } catch (_error) {
    EU_STATE.syncMeta = euBuildSyncMeta();
  }
}

function euGetIdentityData(user) {
  const firebaseUid = String(user?.firebaseUid || user?.firebase_uid || '').trim();
  return {
    firebaseUid,
    userNumber: String(user?.userNumber || (EU_STATE.mode === 'create' ? userText('Se asignará al guardar') : `pos_user_${user?.id || ''}`)).trim(),
    businessId: String(EU_STATE.syncMeta?.businessId || 'pos_' + String(DB?.config?.nombre || 'negocio').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')).trim(),
    licenseId: String(EU_STATE.syncMeta?.licenseId || window._lbsLicenseUid || '').trim(),
  };
}

function euValidateEmailField() {
  const email = document.getElementById('eu-email')?.value.trim().toLowerCase() || '';
  const invalid = Boolean(email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  document.getElementById('eu-email-error')?.classList.toggle('hidden', !invalid);
  if (!invalid) {
    document.getElementById('eu-email-duplicate-error')?.classList.add('hidden');
  }
  return !invalid;
}

function euValidateDuplicateFields() {
  const editingId = EU_STATE.userId;
  const username = document.getElementById('eu-usuario')?.value.trim().toLowerCase() || '';
  const email = document.getElementById('eu-email')?.value.trim().toLowerCase() || '';
  const duplicateUser = Boolean(username && (DB.users || []).find((item) =>
    item.id !== editingId && String(item.usuario || '').trim().toLowerCase() === username
  ));
  const duplicateEmail = Boolean(email && (DB.users || []).find((item) =>
    item.id !== editingId && String(item.email || '').trim().toLowerCase() === email
  ));
  document.getElementById('eu-usuario-error')?.classList.toggle('hidden', !duplicateUser);
  document.getElementById('eu-email-duplicate-error')?.classList.toggle('hidden', !duplicateEmail);
  return !duplicateUser && !duplicateEmail;
}

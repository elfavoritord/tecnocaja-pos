// ===== TECNO CAJA - COBRAR Y FACTURAR (pantalla completa) =====
//
// Solo interfaz. Toda la lógica del cobro (validación, ITBIS, NCF/e-CF,
// impresión, guardado, WhatsApp) sigue en ventas.js: esta pantalla reutiliza
// los mismos IDs y funciones (#monto-recibido, #billing-total, #cambio-val,
// setPayMethod, processSale...) para no tener que tocarla.
//
// Estilos: css/cobro.css, sobre las variables de css/tokens.css.

(function () {
  'use strict';

  // Íconos Lucide compartidos: js/iconos.js (se carga antes que este archivo).
  const ICONS = window.TcIconos ? window.TcIconos.paths : {};

  function icon(name, size = 20) {
    return `<svg class="tc-icon" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  const MAIN_DOCS = [
    { key: 'ticket', label: 'Ticket', hint: 'Sin NCF' },
    { key: 'B02', label: 'B02', hint: 'Consumo' },
    { key: 'B01', label: 'B01', hint: 'Créd. fiscal' },
    { key: 'factura-electronica', label: 'e-CF', hint: 'Electrónico' }
  ];
  // B11/B12/B13/B17 quedan fuera a propósito: son de Compras/Gastos, no de
  // una venta del POS.
  const EXTRA_DOCS = [
    { key: 'B14', label: 'B14', hint: 'Régimen especial' },
    { key: 'B15', label: 'B15', hint: 'Gubernamental' },
    { key: 'B16', label: 'B16', hint: 'Exportaciones' },
    { key: 'B03', label: 'B03', hint: 'Nota de débito' },
    { key: 'B04', label: 'B04', hint: 'Nota de crédito' }
  ];
  const ORDER_TYPES = [
    { key: 'mostrador', label: 'Mostrador' },
    { key: 'delivery', label: 'Delivery' },
    { key: 'recoger', label: 'Para llevar' }
  ];
  const METHODS = [
    { key: 'efectivo', label: 'Efectivo', shortcut: 'F2', icon: 'banknote' },
    { key: 'tarjeta', label: 'Tarjeta', shortcut: 'F3', icon: 'credit-card' },
    { key: 'transferencia', label: 'Transferencia', shortcut: 'F4', icon: 'landmark' },
    { key: 'mixto', label: 'Mixto', shortcut: 'F5', icon: 'copy' },
    { key: 'credito', label: 'Crédito', shortcut: 'F6', icon: 'clock' },
    { key: 'usd', label: 'Dólares', shortcut: 'F7', icon: 'dollar-sign' },
    { key: 'contra_entrega', label: 'Contra entrega', shortcut: 'F8', icon: 'truck' }
  ];

  // RNC/razón social: siempre visibles donde la validación actual los EXIGE
  // (buildBillingValidationBuckets en ventas.js: B01). Donde son opcionales
  // (Ticket, B02, e-CF, B14, B15, B16) quedan detrás de "Agregar RNC", sin
  // perder la posibilidad que tienen hoy. B03/B04 usan el buscador de la
  // factura original en su lugar, igual que antes.
  const RNC_REQUIRED_PRESETS = new Set(['B01']);
  const REFERENCE_PRESETS = new Set(['B03', 'B04']);

  const NO_RATE_HELP = 'Sin tasa del día. Se registra al abrir la caja: Caja → Abrir caja → "Tipo de cambio USD → DOP".';

  let rncRevealed = false;
  let lastPreset = null;
  let resumeOnReopen = false;

  // ── Utilidades ────────────────────────────────────────────────────────────

  function esc(value) {
    return typeof escapeHtml === 'function' ? escapeHtml(value) : String(value ?? '');
  }

  function plainAmount(value) {
    return Number(value || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // "RD$ 2,600.00" / "- RD$ 260.00" → "2,600.00" / "-260.00"
  function stripCurrency(text) {
    const raw = String(text || '').trim();
    const negative = raw.startsWith('-');
    const digits = raw.replace(/[^0-9.,]/g, '');
    if (!digits) return '0.00';
    const isZero = Number(digits.replace(/,/g, '')) === 0;
    return negative && !isZero ? `-${digits}` : digits;
  }

  function textOf(id, fallback = '') {
    return document.getElementById(id)?.textContent || fallback;
  }

  function getSessionRate() {
    return Number(DB.caja?.activeSession?.exchangeRateUsdDop || 0);
  }

  function getActivePreset() {
    return typeof getBillingActiveDocumentPreset === 'function'
      ? getBillingActiveDocumentPreset()
      : 'ticket';
  }

  // ── Markup ────────────────────────────────────────────────────────────────

  function buildClientSection() {
    const activeClientId = DB.saleClientId ? String(DB.saleClientId) : '';
    const clientOptions = (DB.clientes || [])
      .slice()
      .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'))
      .map((c) => `<option value="${c.id}" ${activeClientId === String(c.id) ? 'selected' : ''}>${esc(c.nombre)}${c.cedula ? ` · ${esc(c.cedula)}` : ''}</option>`)
      .join('');

    return `
      <section class="cobro-section cobro-client">
        <div class="cobro-label">Cliente</div>
        <div class="cobro-client-row">
          <button type="button" class="cobro-client-btn" id="cobro-client-btn" onclick="CobroUI.toggleClientPicker()">
            ${icon('user')}
            <span class="cobro-client-name" id="cobro-client-name">Consumidor final</span>
            <span class="cobro-client-doc" id="cobro-client-doc"></span>
            <span class="cobro-client-change">Cambiar</span>
          </button>
          <button type="button" class="tc-btn tc-btn--icon" onclick="toggleBillingQuickClient()" title="Nuevo cliente" aria-label="Nuevo cliente">${icon('plus')}</button>
        </div>

        <!-- Fuente de verdad del cliente para ventas.js (refreshSaleClientOptions, cancelSale) -->
        <select id="sale-client-select" class="tc-hidden" tabindex="-1" aria-hidden="true" onchange="setSaleClient(this.value)">
          <option value="">${typeof getBillingClientOptionLabel === 'function' ? getBillingClientOptionLabel() : 'Consumidor final'}</option>
          ${clientOptions}
        </select>

        <div id="cobro-client-picker" class="tc-popover cobro-popover cobro-client-picker hidden">
          <div class="tc-search">
            ${icon('search', 18)}
            <input type="text" id="cobro-client-search" class="tc-search-input" placeholder="Buscar por nombre, cédula o RNC" autocomplete="off" oninput="CobroUI.renderClientResults(this.value)">
          </div>
          <div id="cobro-client-results" class="cobro-client-results"></div>
        </div>

        <div id="billing-quick-client" class="cobro-sheet hidden">
          <div class="cobro-sheet-head">
            <strong>Nuevo cliente</strong>
            <button type="button" class="tc-btn tc-btn--icon" onclick="toggleBillingQuickClient(false)" aria-label="Cerrar">${icon('x')}</button>
          </div>
          <div class="cobro-grid-2">
            <label class="tc-field cobro-span-2"><span class="tc-field-label">Nombre</span><input id="billing-qc-nombre" type="text" class="tc-input" placeholder="Nombre completo"></label>
            <label class="tc-field"><span class="tc-field-label">Cédula</span><input id="billing-qc-cedula" type="text" class="tc-input" placeholder="Documento"></label>
            <label class="tc-field"><span class="tc-field-label">RNC</span><input id="billing-qc-rnc" type="text" class="tc-input" placeholder="RNC"></label>
            <label class="tc-field"><span class="tc-field-label">Teléfono</span><input id="billing-qc-telefono" type="text" class="tc-input" placeholder="809-000-0000"></label>
            <label class="tc-field"><span class="tc-field-label">WhatsApp</span><input id="billing-qc-whatsapp" type="text" class="tc-input" placeholder="809-000-0000"></label>
            <label class="tc-field cobro-span-2"><span class="tc-field-label">Dirección</span><input id="billing-qc-direccion" type="text" class="tc-input" placeholder="Dirección"></label>
          </div>
          <div class="cobro-sheet-actions">
            <button type="button" class="tc-btn" onclick="toggleBillingQuickClient(false)">Cancelar</button>
            <button type="button" class="tc-btn tc-btn--primary" onclick="saveBillingQuickClient()">Guardar cliente</button>
          </div>
        </div>
      </section>
    `;
  }

  function buildDocumentSection() {
    return `
      <section class="cobro-section cobro-docs-section">
        <div class="cobro-label-row">
          <span class="cobro-label">Comprobante</span>
          <button type="button" class="tc-link" id="cobro-rnc-link" onclick="CobroUI.revealRnc()">${icon('plus', 16)} Agregar RNC</button>
        </div>
        <div class="cobro-docs">
          ${MAIN_DOCS.map((doc) => `
            <button type="button" class="tc-choice cobro-doc" data-preset="${doc.key}" onclick="setSaleDocumentPreset('${doc.key}')">
              <strong>${doc.label}</strong><span>${doc.hint}</span>
            </button>
          `).join('')}
          <button type="button" class="tc-choice cobro-doc cobro-doc-more" id="cobro-doc-more" onclick="CobroUI.toggleDocMenu()" aria-haspopup="true">
            <strong id="cobro-doc-more-label">Más</strong><span id="cobro-doc-more-hint">${icon('chevron-down', 16)}</span>
          </button>
        </div>
        <div id="cobro-doc-menu" class="tc-popover cobro-popover cobro-doc-menu hidden" role="menu">
          ${EXTRA_DOCS.map((doc) => `
            <button type="button" class="tc-menu-item cobro-menu-item" role="menuitem" data-preset="${doc.key}" onclick="CobroUI.chooseExtraDoc('${doc.key}')">
              <strong>${doc.label}</strong><span>${doc.hint}</span>
            </button>
          `).join('')}
        </div>

        <div class="cobro-fiscal">
          <!-- ventas.js muestra/oculta estos bloques según el tipo (setSaleNcfType) -->
          <span id="ncf-none-badge" class="tc-hidden"></span>
          <div id="cobro-rnc-block" class="hidden">
            <div class="ncf-extra-fields cobro-grid-2" id="ncf-rnc-fields">
              <input type="text" id="ncf-rnc-input" class="tc-input" placeholder="RNC o cédula" maxlength="11" aria-label="RNC o cédula"
                oninput="DB.saleRncCliente=this.value.replace(/\\D/g,'').slice(0,11); updateSaleFiscalPreview()">
              <input type="text" id="ncf-razon-input" class="tc-input" placeholder="Razón social" aria-label="Razón social"
                oninput="DB.saleRazonSocial=this.value; updateSaleFiscalPreview()">
            </div>
          </div>
          <div class="ncf-extra-fields cobro-ref-fields" id="ncf-ref-fields" style="display:none">
            <div class="tc-search">
              ${icon('search', 18)}
              <input type="text" id="ncf-ref-input" class="tc-search-input" placeholder="Buscar la factura original" oninput="ncfSearchInvoices(this.value)">
              <button type="button" class="tc-btn tc-btn--icon cobro-flat ncf-ref-clear" onclick="clearNcfRef()" aria-label="Limpiar">${icon('x', 18)}</button>
            </div>
            <div class="ncf-ref-results cobro-ref-results" id="ncf-ref-results"></div>
            <div class="ncf-ref-selected cobro-ref-selected" id="ncf-ref-selected" style="display:none">
              <span id="ncf-ref-selected-text"></span>
              <button type="button" class="tc-btn tc-btn--icon cobro-flat ncf-ref-clear-btn" onclick="clearNcfRef()" aria-label="Quitar">${icon('x', 18)}</button>
            </div>
          </div>
          <div id="sale-fiscal-preview" class="tc-hidden"></div>
        </div>
      </section>
    `;
  }

  function buildOrderSection() {
    return `
      <section class="cobro-section">
        <div class="cobro-label">Tipo de venta</div>
        <div class="cobro-segment">
          ${ORDER_TYPES.map((type) => `
            <button type="button" class="tc-choice cobro-seg" data-order="${type.key}" onclick="setSaleOrderType('${type.key}')">${type.label}</button>
          `).join('')}
        </div>
        <!-- Mismos campos para Delivery y Contra entrega (DB.saleDelivery*): se muestran una sola vez -->
        <div id="billing-delivery-fields" class="cobro-grid-2 cobro-delivery ${String(DB.saleOrderType || 'mostrador') === 'delivery' ? '' : 'hidden'}">
          <select id="sale-delivery-user" class="tc-select" aria-label="Repartidor" onchange="setSaleDeliveryUser(this.value)">
            ${typeof buildDeliveryUserOptions === 'function' ? buildDeliveryUserOptions() : ''}
          </select>
          <input type="text" id="sale-delivery-phone" class="tc-input" placeholder="Teléfono" aria-label="Teléfono de entrega"
            value="${esc(DB.saleDeliveryPhone || '')}" oninput="setSaleDeliveryPhone(this.value)">
          <input type="text" id="sale-delivery-address" class="tc-input" placeholder="Dirección" aria-label="Dirección de entrega"
            value="${esc(DB.saleDeliveryAddress || '')}" oninput="setSaleDeliveryAddress(this.value)">
          <input type="text" id="sale-delivery-reference" class="tc-input" placeholder="Referencia (opcional)" aria-label="Referencia de entrega"
            value="${esc(DB.saleDeliveryReference || '')}" oninput="setSaleDeliveryReference(this.value)">
        </div>
      </section>
    `;
  }

  function buildLeftColumn() {
    return `
      <aside class="cobro-left">
        ${buildClientSection()}
        ${buildDocumentSection()}
        ${buildOrderSection()}

        <section class="cobro-section cobro-products">
          <div class="cobro-label-row">
            <span class="cobro-label">Productos</span>
            <span class="cobro-muted" id="cobro-items-count"></span>
          </div>
          <div id="billing-compact-lines" class="cobro-lines">
            ${typeof buildBillingCompactSummaryRowsMarkup === 'function' ? buildBillingCompactSummaryRowsMarkup() : ''}
          </div>
        </section>

        <div class="cobro-left-actions">
          <button type="button" class="tc-btn tc-btn--soft cobro-add-products" onclick="CobroUI.addProducts()">${icon('plus')} Agregar productos</button>
          <button type="button" class="tc-btn" id="cobro-discount-btn" onclick="openBillingDiscountModal()">${icon('percent')} <span id="cobro-discount-label">Aplicar descuento</span></button>
        </div>

        <!-- Con subtotal gravado/exento (Configuración → separar gravado y
             exento) los totales pasan a dos columnas: así la lista de
             productos no se queda sin espacio. -->
        <div class="cobro-totals" id="cobro-totals">
          <div class="cobro-totals-grid">
            <div class="cobro-totals-row"><span>Subtotal</span><span id="cobro-subtotal">0.00</span></div>
            <div class="cobro-totals-row"><span>Descuento</span><span id="cobro-descuento">0.00</span></div>
            <div class="cobro-totals-row hidden" id="cobro-gravado-row"><span><span class="cobro-totals-prefix">Subtotal </span>gravado</span><span id="cobro-gravado">0.00</span></div>
            <div class="cobro-totals-row hidden" id="cobro-exento-row"><span><span class="cobro-totals-prefix">Subtotal </span>exento</span><span id="cobro-exento">0.00</span></div>
            <div class="cobro-totals-row"><span id="cobro-itbis-label">ITBIS</span><span id="cobro-itbis">0.00</span></div>
            <div class="cobro-totals-row hidden" id="cobro-redondeo-row"><span>Redondeo</span><span id="cobro-redondeo">0.00</span></div>
          </div>
          <div class="cobro-totals-row cobro-totals-total"><span>Total</span><span id="cobro-total-left">RD$ 0.00</span></div>
        </div>
      </aside>
    `;
  }

  function buildMethodButtons(paymentMethod) {
    const hasRate = getSessionRate() > 0;
    return METHODS.map((m) => {
      const isUsd = m.key === 'usd';
      const unavailable = isUsd && !hasRate;
      return `
        <button type="button"
          ${m.key === 'contra_entrega' ? 'id="pay-method-cod"' : ''}
          ${isUsd ? 'id="pay-method-usd"' : ''}
          class="tc-choice cobro-method pay-method ${paymentMethod === m.key ? 'active' : ''} ${unavailable ? 'is-unavailable' : ''}"
          ${unavailable ? 'aria-disabled="true"' : ''}
          onclick="${isUsd ? 'CobroUI.selectUsd(this)' : `setPayMethod('${m.key}', this)`}"
          title="${unavailable ? NO_RATE_HELP : `${m.shortcut}: ${m.label}`}">
          ${icon(m.icon, 22)}
          <span class="cobro-method-name">${m.label}</span>
          <span class="cobro-method-key" ${isUsd ? 'id="cobro-usd-key"' : ''}>${unavailable ? `${m.shortcut} · Sin tasa del día` : m.shortcut}</span>
        </button>
      `;
    }).join('');
  }

  // Campo de monto: el <input> guarda el número tal cual lo lee ventas.js
  // ("3068.00" — parseFloat no entiende separadores de miles) y queda
  // transparente encima; lo que se ve es una copia formateada ("3,068.00")
  // que actualiza refreshAmountMirrors().
  function buildAmountField({ id, oninput, value = '', prefix = '', hintId = '', small = false }) {
    return `
      <div class="cobro-amount ${small ? 'cobro-amount-sm' : ''}">
        ${prefix ? `<span class="cobro-amount-prefix">${prefix}</span>` : ''}
        ${hintId ? `<span class="cobro-amount-hint" id="${hintId}"></span>` : ''}
        <span class="cobro-amount-value is-placeholder" data-mirror-for="${id}">0.00</span>
        <input type="text" inputmode="decimal" id="${id}" class="cobro-amount-input" autocomplete="off" spellcheck="false"
          value="${esc(String(value || ''))}" oninput="${oninput}">
      </div>
    `;
  }

  function buildChangeCard({ cardId, valueId, faltanId, label }) {
    return `
      <div class="cobro-change cambio-neutral" id="${cardId}">
        <span class="cobro-change-label">${label}</span>
        <strong id="${valueId}" class="cobro-change-amount">RD$ 0.00</strong>
        <div id="${faltanId}" class="tc-hidden"></div>
      </div>
    `;
  }

  function buildPaymentPanels(selectedClient) {
    const state = typeof billingModalState === 'object' && billingModalState ? billingModalState : {};
    const cardTypes = typeof BILLING_CARD_TYPES !== 'undefined' ? BILLING_CARD_TYPES : [];
    return `
      <!-- Efectivo -->
      <div class="cobro-area" id="efectivo-area">
        <div class="tc-field">
          <span class="tc-field-label">Recibido</span>
          ${buildAmountField({ id: 'monto-recibido', oninput: 'calcCambio()', prefix: 'RD$' })}
        </div>
        <!-- Montos rápidos según el total (CobroUI.sync → renderQuickAmounts) -->
        <div class="cobro-quick" id="quick-amounts" data-quick-kind="cash"></div>
        ${buildChangeCard({ cardId: 'billing-cambio-card', valueId: 'cambio-val', faltanId: 'billing-cambio-faltan', label: 'Devuelta al cliente' })}
      </div>

      <!-- Tarjeta -->
      <div class="cobro-area" id="tarjeta-area" style="display:none">
        <div class="cobro-grid-2">
          <label class="tc-field"><span class="tc-field-label">Referencia (opcional)</span>
            <input type="text" class="tc-input" value="${esc(state.cardReference || '')}" oninput="updateBillingPaymentDetail('cardReference', this.value)" placeholder="Número de aprobación"></label>
          <label class="tc-field"><span class="tc-field-label">Banco (opcional)</span>
            <input type="text" class="tc-input" value="${esc(state.cardBank || '')}" oninput="updateBillingPaymentDetail('cardBank', this.value)" placeholder="Banco"></label>
          <label class="tc-field"><span class="tc-field-label">Tipo de tarjeta (opcional)</span>
            <select class="tc-select" onchange="updateBillingPaymentDetail('cardType', this.value)">
              <option value="">Sin especificar</option>
              ${cardTypes.map((t) => `<option value="${esc(t)}" ${state.cardType === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
            </select></label>
        </div>
        <div class="cobro-exact-note">Se cobra el monto exacto del total.</div>
      </div>

      <!-- Transferencia -->
      <div class="cobro-area" id="transferencia-area" style="display:none">
        <div class="cobro-grid-2">
          <label class="tc-field"><span class="tc-field-label">Referencia (opcional)</span>
            <input type="text" class="tc-input" value="${esc(state.transferReference || '')}" oninput="updateBillingPaymentDetail('transferReference', this.value)" placeholder="Número de referencia"></label>
          <label class="tc-field"><span class="tc-field-label">Banco (opcional)</span>
            <input type="text" class="tc-input" value="${esc(state.transferBank || '')}" oninput="updateBillingPaymentDetail('transferBank', this.value)" placeholder="Banco"></label>
        </div>
        <div class="cobro-exact-note">Se cobra el monto exacto del total.</div>
      </div>

      <!-- Mixto -->
      <div class="cobro-area" id="mixto-area" style="display:none">
        <div class="cobro-grid-3">
          <div class="tc-field"><span class="tc-field-label">Efectivo</span>
            ${buildAmountField({ id: 'mixto-efectivo', oninput: 'calcMixto()', value: state.mixedCashAmount, small: true })}</div>
          <div class="tc-field"><span class="tc-field-label">Tarjeta</span>
            ${buildAmountField({ id: 'mixto-tarjeta', oninput: 'calcMixto()', value: state.mixedCardAmount, small: true })}</div>
          <div class="tc-field"><span class="tc-field-label">Transferencia</span>
            ${buildAmountField({ id: 'mixto-transferencia', oninput: 'calcMixto()', value: state.mixedTransferAmount, small: true })}</div>
        </div>
        <div class="cobro-mixto-status cobro-mixto-pending" id="mixto-status">
          <span>Pendiente</span><strong id="mixto-pendiente">RD$ 0.00</strong>
        </div>
        <div class="cobro-mixto-status cobro-mixto-change" id="mixto-cambio-row" style="display:none">
          <span>Devuelta</span><strong id="mixto-cambio-val">RD$ 0.00</strong>
        </div>
      </div>

      <!-- Crédito -->
      <div class="cobro-area" id="credito-area" style="display:none">
        <div class="cobro-grid-2">
          <label class="tc-field"><span class="tc-field-label">Vence</span>
            <input type="date" class="tc-input" value="${esc(state.creditDueDate || '')}" oninput="updateBillingPaymentDetail('creditDueDate', this.value)"></label>
          <label class="tc-field"><span class="tc-field-label">Límite de crédito</span>
            <input type="text" class="tc-input" readonly value="${selectedClient ? esc(fmt(Math.max(0, Number(selectedClient.limiteCredito || 0)))) : 'Elige un cliente'}"></label>
          <label class="tc-field cobro-span-2"><span class="tc-field-label">Nota (opcional)</span>
            <textarea class="tc-textarea" rows="2" placeholder="Notas del crédito" oninput="updateBillingPaymentDetail('creditNotes', this.value)">${esc(state.creditNotes || '')}</textarea></label>
        </div>
      </div>

      <!-- Contra entrega -->
      <div class="cobro-area" id="contra-entrega-area" style="display:none">
        <div class="tc-field">
          <span class="tc-field-label">¿Con cuánto pagará el cliente?</span>
          ${buildAmountField({ id: 'monto-recibido-contra-entrega', oninput: 'setSaleDeliveryPayAmount(this.value)', value: DB.saleDeliveryPayAmount || '', prefix: 'RD$' })}
        </div>
        <div class="cobro-quick" data-quick-kind="delivery"></div>
        ${buildChangeCard({ cardId: 'billing-cambio-card-contra-entrega', valueId: 'cambio-val-contra-entrega', faltanId: 'billing-cambio-faltan-contra-entrega', label: 'Cambio que lleva el repartidor' })}
      </div>

      <!-- Dólares: se cobra en US$ con la tasa registrada al abrir la caja; la
           devuelta se da en pesos. calcCambioUsd() (ventas.js) hace el cálculo. -->
      <div class="cobro-area" id="usd-area" style="display:none">
        <div class="cobro-field">
          <div class="cobro-field-head">
            <span class="tc-field-label">Recibido en dólares</span>
            <span class="cobro-field-info" id="cobro-usd-rate"></span>
          </div>
          ${buildAmountField({ id: 'monto-recibido-usd', oninput: 'calcCambioUsd()', prefix: 'US$', hintId: 'cobro-usd-equiv' })}
        </div>
        <div class="cobro-quick" data-quick-kind="usd"></div>
        ${buildChangeCard({ cardId: 'billing-cambio-card-usd', valueId: 'cambio-val-usd', faltanId: 'billing-cambio-faltan-usd', label: 'Devuelta en pesos' })}
        <!-- calcCambioUsd() escribe aquí el total en US$ y la tasa; se muestran arriba con otro formato -->
        <span class="tc-hidden"><span id="billing-usd-equiv-val"></span><span id="billing-usd-rate-label"></span></span>
      </div>
    `;
  }

  function buildCenterColumn(total, paymentMethod, selectedClient) {
    return `
      <main class="cobro-center">
        <div class="cobro-total-block">
          <span class="cobro-total-label">Total a pagar</span>
          <div class="cobro-total-amount">
            <span class="cobro-total-cur" id="cobro-total-cur">${esc(DB.config?.moneda || 'RD$')}</span>
            <span id="cobro-total-value">${plainAmount(total)}</span>
          </div>
          <!-- Fuente del total para los cálculos de ventas.js (calcCambio, setMontoExacto...) -->
          <strong id="billing-total" class="tc-hidden">${typeof fmt === 'function' ? fmt(total) : total}</strong>
          <div id="billing-total-empty" class="tc-hidden"></div>
        </div>

        <div class="cobro-label">Método de pago</div>
        <div class="cobro-methods">
          ${buildMethodButtons(paymentMethod)}
        </div>

        <div class="cobro-panel" id="cobro-panel">
          ${buildPaymentPanels(selectedClient)}
        </div>

        <!-- Compatibilidad con ventas.js: elementos que el cobro anterior tenía y que
             algunas funciones todavía actualizan. No se muestran. -->
        <div class="tc-hidden" aria-hidden="true">
          <div id="billing-compact-method-note"></div>
          <div id="billing-compact-status" style="display:none"></div>
          <div id="billing-client-snapshot"></div>
          <select id="sale-doc-type" onchange="setSaleDocumentType(this.value)">
            <option value="ticket">Ticket / Factura</option>
            <option value="factura-electronica">Factura Electrónica</option>
          </select>
          <select id="sale-order-type" onchange="setSaleOrderType(this.value)">
            <option value="mostrador">Mostrador</option>
            <option value="delivery">Delivery</option>
            <option value="recoger">Para llevar</option>
          </select>
          <select id="sale-kitchen-status" onchange="setSaleKitchenStatus(this.value)"></select>
          <input type="text" id="sale-table-label" value="${esc(DB.saleTableLabel || '')}" oninput="setSaleTableLabel(this.value)">
          <textarea id="sale-order-notes" oninput="setSaleOrderNotes(this.value)">${esc(DB.saleOrderNotes || '')}</textarea>
        </div>
      </main>
    `;
  }

  function buildKeypad() {
    const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '00', '.'];
    return `
      <!-- onpointerdown evita que el botón se quede con el foco: así el campo
           activo sigue siendo el que el cajero estaba llenando. -->
      <aside class="cobro-keypad" id="cobro-keypad" aria-label="Teclado numérico">
        <button type="button" class="cobro-key cobro-key-soft cobro-key-wide" onpointerdown="event.preventDefault()" onclick="CobroUI.pressKey('clear')">Limpiar</button>
        <button type="button" class="cobro-key cobro-key-soft" onpointerdown="event.preventDefault()" onclick="CobroUI.pressKey('back')" aria-label="Borrar">${icon('delete', 28)}</button>
        ${keys.map((key) => `<button type="button" class="cobro-key" onpointerdown="event.preventDefault()" onclick="CobroUI.pressKey('${key}')">${key}</button>`).join('')}
      </aside>
    `;
  }

  function buildOverlays(discountVal) {
    return `
      <div id="billing-discard-guard" class="tc-modal-backdrop hidden">
        <div class="tc-modal" role="dialog" aria-modal="true" aria-labelledby="cobro-discard-title">
          <div class="tc-modal-head" id="cobro-discard-title">¿Salir sin cobrar?</div>
          <div class="tc-modal-body">Se descartará la información de este cobro.</div>
          <div class="tc-modal-foot">
            <button type="button" class="tc-btn" onclick="hideBillingDiscardPrompt()">Seguir cobrando</button>
            <button type="button" class="tc-btn tc-btn--danger" onclick="confirmBillingDiscard()">Salir sin cobrar</button>
          </div>
        </div>
      </div>

      <div id="billing-v3-discount-modal" class="tc-modal-backdrop hidden">
        <div class="tc-modal" role="dialog" aria-modal="true" aria-labelledby="cobro-discount-title">
          <div class="tc-modal-head" id="cobro-discount-title">Descuento general</div>
          <div class="tc-modal-body">
            <label class="tc-field">
              <span class="tc-field-label">Porcentaje</span>
              <span class="cobro-input-suffix">
                <input type="number" id="desc-general" class="tc-input cobro-input-lg" min="0" max="100" placeholder="0"
                  value="${discountVal}" oninput="applyGeneralDiscount(); CobroUI.sync()">
                <span>%</span>
              </span>
            </label>
          </div>
          <div class="tc-modal-foot">
            <button type="button" class="tc-btn" onclick="closeBillingDiscountModal()">Cerrar</button>
            <button type="button" class="tc-btn tc-btn--primary" onclick="closeBillingDiscountModal()">Aplicar</button>
          </div>
        </div>
      </div>
    `;
  }

  function buildMarkup() {
    const total = typeof parseFmt === 'function'
      ? parseFmt(document.getElementById('s-total')?.textContent || '0')
      : 0;
    const paymentMethod = DB.payMethod || 'efectivo';
    const selectedClient = typeof getSelectedSaleClient === 'function' ? getSelectedSaleClient() : null;
    const discountVal = parseFloat(DB.saleGeneralDiscount || 0) || 0;
    rncRevealed = false;
    lastPreset = null;
    lastPanelField = null;
    lastQuickKey = '';

    return `
      <div class="cobro-shell tc-ui" id="cobro-shell">
        ${buildLeftColumn()}
        ${buildCenterColumn(total, paymentMethod, selectedClient)}
        ${buildKeypad()}
        ${buildOverlays(discountVal)}
      </div>
    `;
  }

  // Barra superior: título, número de factura y "Cambios pendientes" (aviso).
  function buildHeader({ docNumber = '', hasDraft = false } = {}) {
    return `
      <span class="cobro-topbar">
        <span class="cobro-topbar-title">Cobrar y facturar</span>
        <span class="cobro-topbar-doc">${esc(docNumber)}</span>
        <span class="cobro-topbar-spacer"></span>
        <span class="cobro-topbar-pending ${hasDraft ? '' : 'hidden'}"><span class="cobro-dot"></span>Cambios pendientes</span>
      </span>
    `;
  }

  // Barra inferior. El aviso de validación va en una línea sobre los botones
  // de cobrar, que quedan desactivados mientras falte algo. "Cobrar e
  // imprimir" es el único botón verde de la pantalla.
  function buildFooter({ disabled = false, submitting = false, validation = [] } = {}) {
    const lockedAttr = submitting ? 'disabled' : '';
    const chargeAttr = disabled || submitting ? 'disabled' : '';
    const warning = [...fiscalWarnings, ...validation][0] || '';
    return `
      <div class="cobro-footer tc-ui">
        <div class="cobro-footer-group">
          <button type="button" class="tc-btn" onclick="requestBillingModalClose({ source: 'cancel' })">Cancelar <kbd class="tc-kbd">Esc</kbd></button>
          <button type="button" class="tc-btn" ${lockedAttr} onclick="CobroUI.suspend()">${icon('circle-pause')} Suspender</button>
          <button type="button" class="tc-btn" ${chargeAttr} onclick="processSale('whatsapp')">${icon('message-circle')} WhatsApp</button>
        </div>
        <div class="cobro-footer-charge">
          <div class="cobro-validation ${warning ? '' : 'is-empty'}" id="cobro-validation" role="status" title="${esc(warning)}">
            ${icon('triangle-alert', 16)}<span id="cobro-validation-text">${esc(warning)}</span>
          </div>
          <div class="cobro-footer-group">
            <button type="button" id="cobro-btn-charge" class="tc-btn" ${chargeAttr} onclick="processSale('charge')">
              ${submitting ? 'Procesando…' : 'Cobrar sin imprimir'} <kbd class="tc-kbd">F9</kbd>
            </button>
            <button type="button" id="cobro-btn-print" class="tc-btn tc-btn--success cobro-btn-print" ${chargeAttr} onclick="processSale('print')">
              ${icon('printer', 22)} ${submitting ? 'Procesando…' : 'Cobrar e imprimir'} <kbd class="tc-kbd">Enter</kbd>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Sincronización visual (la llama syncBillingConfirmSummary en ventas.js) ──

  function syncClient() {
    const client = typeof getSelectedSaleClient === 'function' ? getSelectedSaleClient() : null;
    const nameEl = document.getElementById('cobro-client-name');
    const docEl = document.getElementById('cobro-client-doc');
    if (nameEl) nameEl.textContent = client?.nombre || 'Consumidor final';
    if (docEl) docEl.textContent = client ? (client.rnc || client.cedula || '') : '';
  }

  function syncDocuments() {
    const preset = getActivePreset();
    document.querySelectorAll('#cobro-shell .cobro-doc[data-preset]').forEach((button) => {
      const active = button.dataset.preset === preset;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const extra = EXTRA_DOCS.find((doc) => doc.key === preset);
    const more = document.getElementById('cobro-doc-more');
    const moreLabel = document.getElementById('cobro-doc-more-label');
    const moreHint = document.getElementById('cobro-doc-more-hint');
    if (more) more.classList.toggle('is-active', Boolean(extra));
    if (moreLabel) moreLabel.textContent = extra ? extra.label : 'Más';
    if (moreHint) moreHint.innerHTML = extra ? esc(extra.hint) : icon('chevron-down', 16);
    document.querySelectorAll('#cobro-doc-menu .cobro-menu-item').forEach((item) => {
      item.classList.toggle('is-active', item.dataset.preset === preset);
    });
  }

  function syncFiscal() {
    const preset = String(getActivePreset() || '').toUpperCase();
    if (preset !== lastPreset) {
      rncRevealed = false;
      lastPreset = preset;
    }
    const usesReference = REFERENCE_PRESETS.has(preset);
    const required = RNC_REQUIRED_PRESETS.has(preset);
    const hasValue = Boolean(String(DB.saleRncCliente || '').trim() || String(DB.saleRazonSocial || '').trim());
    const showFields = !usesReference && (required || rncRevealed || hasValue);
    document.getElementById('cobro-rnc-block')?.classList.toggle('hidden', !showFields);
    document.getElementById('cobro-rnc-link')?.classList.toggle('hidden', usesReference || showFields);
  }

  function syncOrderType() {
    const orderType = String(DB.saleOrderType || 'mostrador');
    document.querySelectorAll('#cobro-shell .cobro-seg[data-order]').forEach((button) => {
      const active = button.dataset.order === orderType;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function syncItemsCount() {
    const el = document.getElementById('cobro-items-count');
    if (!el) return;
    const items = Array.isArray(DB.saleItems) ? DB.saleItems : [];
    const lines = items.length;
    const quantities = items.map((item) => Number(item?.qty || 0));
    const allWhole = quantities.every((qty) => Number.isInteger(qty));
    const units = quantities.reduce((sum, qty) => sum + qty, 0);
    const linesText = `${lines} ${lines === 1 ? 'artículo' : 'artículos'}`;
    el.textContent = allWhole && lines
      ? `${linesText}, ${units} ${units === 1 ? 'unidad' : 'unidades'}`
      : linesText;
  }

  function syncTotals() {
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    set('cobro-subtotal', stripCurrency(textOf('s-subtotal', '0')));
    set('cobro-gravado', stripCurrency(textOf('s-subtotal-gravado', '0')));
    set('cobro-exento', stripCurrency(textOf('s-subtotal-exento', '0')));
    set('cobro-descuento', stripCurrency(textOf('s-descuento', '0')));

    // Igual que hoy: gravado/exento solo si el negocio los separa.
    const separate = typeof getSaleTaxConfig === 'function' && Boolean(getSaleTaxConfig().separateTaxableAndExempt);
    document.getElementById('cobro-gravado-row')?.classList.toggle('hidden', !separate);
    document.getElementById('cobro-exento-row')?.classList.toggle('hidden', !separate);
    document.getElementById('cobro-totals')?.classList.toggle('is-detailed', separate);
    set('cobro-itbis', stripCurrency(textOf('s-itbis', '0')));
    set('cobro-itbis-label', textOf('sale-tax-label', 'ITBIS').replace(/[()]/g, '').trim() || 'ITBIS');

    // Redondeo solo cuando existe: cambia el total y hay que poder explicarlo.
    const rounding = typeof parseFmt === 'function' ? parseFmt(textOf('s-redondeo', '0')) : 0;
    document.getElementById('cobro-redondeo-row')?.classList.toggle('hidden', Math.abs(rounding) < 0.01);
    set('cobro-redondeo', `${rounding > 0 ? '+' : ''}${plainAmount(rounding)}`);

    const totalText = textOf('billing-total', textOf('s-total', '0'));
    set('cobro-total-value', stripCurrency(totalText));
    set('cobro-total-left', totalText);
  }

  function syncDiscount() {
    const label = document.getElementById('cobro-discount-label');
    if (!label) return;
    const value = parseFloat(DB.saleGeneralDiscount || 0) || 0;
    label.textContent = value > 0 ? `Descuento ${value}%` : 'Aplicar descuento';
    document.getElementById('cobro-discount-btn')?.classList.toggle('is-active', value > 0);
  }

  function syncUsdAvailability() {
    const button = document.getElementById('pay-method-usd');
    if (!button) return;
    const unavailable = !(getSessionRate() > 0);
    button.classList.toggle('is-unavailable', unavailable);
    if (unavailable) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
    button.title = unavailable ? NO_RATE_HELP : 'F7: Dólares';
    const key = document.getElementById('cobro-usd-key');
    if (key) key.textContent = unavailable ? 'F7 · Sin tasa del día' : 'F7';
  }

  // ventas.js marca las tarjetas de devuelta con cambio-ok/exacto/insuf/neutral;
  // aquí solo se traduce ese estado a texto (sin emojis).
  const CHANGE_LABELS = {
    'billing-cambio-card': { ok: 'Devuelta al cliente', exacto: 'Pago exacto', insuf: 'Falta por cobrar', neutral: 'Devuelta al cliente' },
    'billing-cambio-card-usd': { ok: 'Devuelta en pesos', exacto: 'Pago exacto', insuf: 'Falta por cobrar', neutral: 'Devuelta en pesos' },
    'billing-cambio-card-contra-entrega': { ok: 'Cambio que lleva el repartidor', exacto: 'Pago exacto', insuf: 'Falta por cobrar', neutral: 'Cambio que lleva el repartidor' }
  };

  function syncChangeCards() {
    Object.entries(CHANGE_LABELS).forEach(([cardId, labels]) => {
      const card = document.getElementById(cardId);
      const label = card?.querySelector('.cobro-change-label');
      if (!card || !label) return;
      const state = ['ok', 'exacto', 'insuf'].find((key) => card.classList.contains(`cambio-${key}`)) || 'neutral';
      label.textContent = labels[state];
    });
  }

  // Avisos fiscales de updateSaleFiscalPreview() (ej. e-CF deshabilitada) +
  // validación del cobro (buildBillingValidationBuckets). Se muestra el primero.
  let fiscalWarnings = [];

  function setFiscalWarnings(warnings) {
    fiscalWarnings = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
  }

  // Línea sobre los botones de cobrar (la barra inferior se redibuja con
  // buildFooter, pero no en cada cambio: aquí se mantiene al día).
  function syncValidationLine() {
    const wrap = document.getElementById('cobro-validation');
    const text = document.getElementById('cobro-validation-text');
    if (!wrap || !text) return;
    const validation = typeof buildBillingValidationBuckets === 'function'
      ? buildBillingValidationBuckets().confirm
      : [];
    const first = [...fiscalWarnings, ...validation][0] || '';
    text.textContent = first;
    wrap.title = first;
    wrap.classList.toggle('is-empty', !first);
  }

  function sync() {
    if (!document.getElementById('cobro-shell')) return;
    syncClient();
    syncDocuments();
    syncFiscal();
    syncOrderType();
    syncItemsCount();
    syncTotals();
    syncDiscount();
    syncUsdAvailability();
    renderQuickAmounts();
    syncUsdPanel();
    refreshAmountMirrors();
    syncChangeCards();
    syncValidationLine();
    syncKeypadState();
    if (typeof _applyAvailableNcfDocTypesToPills === 'function') _applyAvailableNcfDocTypesToPills();
  }

  // ── Cliente ───────────────────────────────────────────────────────────────

  function renderClientResults(query = '') {
    const results = document.getElementById('cobro-client-results');
    if (!results) return;
    const needle = String(query || '').trim().toLowerCase();
    const digits = needle.replace(/\D/g, '');
    const clients = (DB.clientes || [])
      .filter((client) => {
        if (!needle) return true;
        const name = String(client.nombre || '').toLowerCase();
        const docs = `${client.cedula || ''} ${client.rnc || ''}`.replace(/\D/g, '');
        return name.includes(needle) || (digits && docs.includes(digits));
      })
      .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'))
      .slice(0, 60);
    const activeId = DB.saleClientId ? String(DB.saleClientId) : '';
    results.innerHTML = `
      <button type="button" class="tc-menu-item cobro-client-option ${activeId ? '' : 'is-active'}" onclick="CobroUI.chooseClient('')">
        <strong>Consumidor final</strong><span>Sin cliente registrado</span>
      </button>
      ${clients.map((client) => `
        <button type="button" class="tc-menu-item cobro-client-option ${activeId === String(client.id) ? 'is-active' : ''}" onclick="CobroUI.chooseClient('${client.id}')">
          <strong>${esc(client.nombre || 'Sin nombre')}</strong>
          <span>${esc([client.rnc || client.cedula, client.telefono].filter(Boolean).join(' · ') || 'Sin documento')}</span>
        </button>
      `).join('')}
      ${clients.length ? '' : '<div class="cobro-empty">Ningún cliente coincide con la búsqueda.</div>'}
    `;
  }

  function toggleClientPicker(force = null) {
    const picker = document.getElementById('cobro-client-picker');
    if (!picker) return;
    const show = force === null ? picker.classList.contains('hidden') : Boolean(force);
    closeOverlays({ except: 'cobro-client-picker' });
    picker.classList.toggle('hidden', !show);
    if (show) {
      const search = document.getElementById('cobro-client-search');
      if (search) search.value = '';
      renderClientResults('');
      setTimeout(() => search?.focus(), 0);
    }
  }

  function chooseClient(id) {
    const select = document.getElementById('sale-client-select');
    if (select) select.value = id ? String(id) : '';
    if (typeof setSaleClient === 'function') setSaleClient(id || '');
    toggleClientPicker(false);
    sync();
  }

  // ── Comprobante ───────────────────────────────────────────────────────────

  function toggleDocMenu(force = null) {
    const menu = document.getElementById('cobro-doc-menu');
    if (!menu) return;
    const show = force === null ? menu.classList.contains('hidden') : Boolean(force);
    closeOverlays({ except: 'cobro-doc-menu' });
    menu.classList.toggle('hidden', !show);
  }

  function chooseExtraDoc(preset) {
    toggleDocMenu(false);
    if (typeof setSaleDocumentPreset === 'function') setSaleDocumentPreset(preset);
  }

  function revealRnc() {
    rncRevealed = true;
    syncFiscal();
    setTimeout(() => document.getElementById('ncf-rnc-input')?.focus(), 0);
  }

  // ── Métodos ───────────────────────────────────────────────────────────────

  function selectUsd(button) {
    if (!(getSessionRate() > 0)) {
      if (typeof showToast === 'function') showToast(NO_RATE_HELP, 'warning');
      return false;
    }
    if (typeof setPayMethod === 'function') setPayMethod('usd', button || document.getElementById('pay-method-usd'));
    return true;
  }

  // ── Montos: formato, montos rápidos y teclado numérico ───────────────────

  // Mismos campos en los que Enter cobra (BILLING_ENTER_AMOUNT_INPUTS en ventas.js).
  const AMOUNT_INPUT_IDS = new Set([
    'monto-recibido',
    'monto-recibido-usd',
    'monto-recibido-contra-entrega',
    'mixto-efectivo',
    'mixto-tarjeta',
    'mixto-transferencia'
  ]);
  const METHOD_AMOUNT_TARGET = {
    efectivo: 'monto-recibido',
    usd: 'monto-recibido-usd',
    contra_entrega: 'monto-recibido-contra-entrega'
  };
  const MIXTO_IDS = ['mixto-efectivo', 'mixto-tarjeta', 'mixto-transferencia'];
  const MAX_INTEGER_DIGITS = 9;
  let lastPanelField = null;
  let lastQuickKey = '';

  // "3068.5" → "3,068.5": separa miles sin tocar los decimales que se escribieron.
  function formatAmountText(raw) {
    const text = String(raw || '');
    if (!text) return '';
    const [intPart, decPart] = text.split('.');
    const grouped = (intPart || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return decPart === undefined ? grouped : `${grouped}.${decPart}`;
  }

  // Solo dígitos y un punto, máximo 2 decimales. Las comas se descartan
  // (al pegar "3,068.00" son separadores de miles).
  function sanitizeAmount(raw) {
    let text = String(raw || '').replace(/,/g, '').replace(/[^0-9.]/g, '');
    const dot = text.indexOf('.');
    if (dot !== -1) text = text.slice(0, dot + 1) + text.slice(dot + 1).replace(/\./g, '');
    const [rawInt, decPart] = text.split('.');
    const intPart = rawInt.replace(/^0+(?=\d)/, '').slice(0, MAX_INTEGER_DIGITS);
    if (decPart === undefined) return intPart;
    return `${intPart || '0'}.${decPart.slice(0, 2)}`;
  }

  function refreshAmountMirrors() {
    document.querySelectorAll('#cobro-shell .cobro-amount-value[data-mirror-for]').forEach((mirror) => {
      const input = document.getElementById(mirror.dataset.mirrorFor);
      const value = input ? input.value : '';
      mirror.textContent = value ? formatAmountText(value) : '0.00';
      mirror.classList.toggle('is-placeholder', !value);
    });
  }

  // Un monto puesto por el sistema (total exacto al abrir, botón rápido) se
  // reemplaza con la primera tecla en vez de seguir escribiéndole al final.
  function isFresh(input) {
    return input.value !== '' && input.value !== (input.dataset.userValue ?? '');
  }

  function isWritableField(el) {
    if (!(el instanceof HTMLElement) || !el.closest('#cobro-shell')) return false;
    if (el.offsetParent === null || el.readOnly || el.disabled) return false;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && ['text', 'search', 'tel', 'number'].includes(el.type);
  }

  function defaultTarget() {
    const method = DB.payMethod || 'efectivo';
    if (method === 'mixto') {
      const field = lastPanelField && MIXTO_IDS.includes(lastPanelField.id)
        ? lastPanelField
        : document.getElementById('mixto-efectivo');
      return isWritableField(field) ? field : null;
    }
    const field = document.getElementById(METHOD_AMOUNT_TARGET[method] || '');
    return isWritableField(field) ? field : null;
  }

  // Campo activo: el que tiene el foco; si no, el último campo usado del
  // panel del método; si no, el monto principal del método. Tarjeta,
  // Transferencia y Crédito no tienen monto: el teclado solo escribe ahí si
  // el cajero tocó un campo (p. ej. la referencia).
  function resolveTarget() {
    if (isWritableField(document.activeElement)) return document.activeElement;
    if (isWritableField(lastPanelField)) return lastPanelField;
    return defaultTarget();
  }

  function applyKey(input, key) {
    const numeric = AMOUNT_INPUT_IDS.has(input.id);
    let value = input.value || '';
    if (key === 'clear') {
      value = '';
    } else if (key === 'back') {
      value = value.slice(0, -1);
    } else {
      if (numeric && isFresh(input)) value = '';
      value += key;
    }
    if (numeric) value = sanitizeAmount(value);
    input.value = value;
    if (document.activeElement !== input) input.focus({ preventScroll: true });
    // El listener de 'input' (abajo) registra el valor y refresca el formato;
    // el oninput del campo hace el cálculo de ventas.js (calcCambio, calcMixto...).
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('.cobro-area')?.querySelectorAll('.cobro-quick-btn.active')
      .forEach((button) => button.classList.remove('active'));
  }

  function pressKey(key) {
    const target = resolveTarget();
    if (target) applyKey(target, key);
    syncKeypadState();
  }

  function syncKeypadState() {
    const keypad = document.getElementById('cobro-keypad');
    if (keypad) keypad.classList.toggle('is-idle', !resolveTarget());
  }

  // Siguiente múltiplo ESTRICTAMENTE mayor (3,000 → 3,100; 3,068 → 3,100).
  function nextMultipleAbove(value, step) {
    return (Math.floor(value / step + 1e-9) + 1) * step;
  }

  // Exacto + siguientes múltiplos de 100, 500, 1,000 y 5,000, sin repetir.
  function cashQuickAmounts(total) {
    if (!(total > 0)) return [];
    return [...new Set([100, 500, 1000, 5000].map((step) => nextMultipleAbove(total, step)))];
  }

  // Billetes de dólar: múltiplo de 5, de 10 y los dos siguientes de 10, y de
  // 50/100 (US$ 51.13 → 55, 60, 70, 80, 100).
  function usdQuickAmounts(usdTotal) {
    if (!(usdTotal > 0)) return [];
    const by10 = nextMultipleAbove(usdTotal, 10);
    return [...new Set([
      nextMultipleAbove(usdTotal, 5), by10, by10 + 10, by10 + 20,
      nextMultipleAbove(usdTotal, 50), nextMultipleAbove(usdTotal, 100)
    ])].sort((a, b) => a - b).slice(0, 5);
  }

  function quickButton({ onclick, label, extraClass = '', id = '', title = '' }) {
    return `<button type="button" class="tc-choice cobro-quick-btn ${extraClass}" ${id ? `id="${id}"` : ''} ${title ? `title="${title}"` : ''} onclick="${onclick}">${label}</button>`;
  }

  function renderQuickAmounts() {
    const total = typeof parseFmt === 'function' ? parseFmt(textOf('billing-total', '0')) : 0;
    const rate = getSessionRate();
    const key = `${total}|${rate}`;
    if (key === lastQuickKey) return;
    lastQuickKey = key;

    const cashValues = cashQuickAmounts(total);
    const cash = document.querySelector('#cobro-shell [data-quick-kind="cash"]');
    if (cash) {
      cash.innerHTML = [
        quickButton({ onclick: 'setMontoExacto(this)', label: 'Exacto', extraClass: 'quick-amount-btn tc-choice--soft', id: 'quick-amount-exact', title: 'Alt+E' }),
        ...cashValues.map((v) => quickButton({ onclick: `setMontoRapido(${v}, this)`, label: formatAmountText(String(v)), extraClass: 'quick-amount-btn' }))
      ].join('');
    }

    // Contra entrega usa la misma lógica: "¿con cuánto pagará el cliente?".
    const delivery = document.querySelector('#cobro-shell [data-quick-kind="delivery"]');
    if (delivery) {
      delivery.innerHTML = [
        quickButton({ onclick: 'setMontoExactoContraEntrega(this)', label: 'Exacto', extraClass: 'billing-v3-quick-btn tc-choice--soft' }),
        ...cashValues.map((v) => quickButton({ onclick: `setMontoRapidoContraEntrega(${v}, this)`, label: formatAmountText(String(v)), extraClass: 'billing-v3-quick-btn' }))
      ].join('');
    }

    const usd = document.querySelector('#cobro-shell [data-quick-kind="usd"]');
    if (usd) {
      const usdValues = rate > 0 ? usdQuickAmounts(total / rate) : [];
      usd.innerHTML = usdValues
        .map((v) => quickButton({ onclick: `CobroUI.setUsdAmount(${v}, this)`, label: `US$ ${formatAmountText(String(v))}` }))
        .join('');
    }
  }

  function setUsdAmount(value, button) {
    const input = document.getElementById('monto-recibido-usd');
    if (!input) return;
    input.value = Number(value).toFixed(2);
    document.querySelectorAll('#cobro-shell [data-quick-kind="usd"] .cobro-quick-btn')
      .forEach((quick) => quick.classList.toggle('active', quick === button));
    input.focus({ preventScroll: true });
    if (typeof calcCambioUsd === 'function') calcCambioUsd();
  }

  function syncUsdPanel() {
    const rate = getSessionRate();
    const total = typeof parseFmt === 'function' ? parseFmt(textOf('billing-total', '0')) : 0;
    const rateEl = document.getElementById('cobro-usd-rate');
    if (rateEl) {
      rateEl.textContent = rate > 0
        ? `Tasa del día: RD$ ${rate.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} por US$ 1 · A cobrar US$ ${plainAmount(total / rate)}`
        : NO_RATE_HELP;
    }
    const equiv = document.getElementById('cobro-usd-equiv');
    if (equiv) {
      const usd = parseFloat(document.getElementById('monto-recibido-usd')?.value || '') || 0;
      equiv.textContent = usd > 0 && rate > 0 ? `Equivale a RD$ ${plainAmount(usd * rate)}` : '';
    }
  }

  function cobroIsOpen() {
    return Boolean(document.getElementById('cobro-shell'))
      && !document.getElementById('modal-overlay')?.classList.contains('hidden')
      && Boolean(document.getElementById('modal-box')?.classList.contains('billing-modal'));
  }

  // Teclado físico: los números van al campo de monto activo aunque el foco
  // esté en un botón (p. ej. después de elegir el método). En los campos de
  // texto (RNC, referencia, búsqueda, dirección...) se escribe normal.
  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !cobroIsOpen()) return;
    let key = null;
    if (/^[0-9]$/.test(event.key)) key = event.key;
    else if (event.key === '.' || event.key === ',' || event.key === 'Decimal') key = '.';
    else if (event.key === 'Backspace') key = 'back';
    else if (event.key === 'Delete') key = 'clear';
    if (!key || hasOpenOverlay()) return;

    const active = document.activeElement;
    const activeIsAmount = Boolean(active && AMOUNT_INPUT_IDS.has(active.id));
    const activeIsTextEntry = Boolean(active)
      && (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable);
    if (!activeIsAmount && activeIsTextEntry) return;

    const target = activeIsAmount ? active : defaultTarget();
    if (!target) return;
    event.preventDefault();
    applyKey(target, key);
  }, true);

  // Lo que entre a un campo de monto (tecleado, pegado o desde el teclado en
  // pantalla) se limpia ANTES de que el oninput del campo haga el cálculo.
  document.addEventListener('input', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !AMOUNT_INPUT_IDS.has(input.id) || !input.closest('#cobro-shell')) return;
    const clean = sanitizeAmount(input.value);
    if (clean !== input.value) input.value = clean;
    input.dataset.userValue = clean;
    refreshAmountMirrors();
  }, true);

  document.addEventListener('focusin', (event) => {
    const el = event.target;
    if (!(el instanceof HTMLElement) || !el.closest('#cobro-shell')) return;
    if (el.closest('#cobro-panel') && isWritableField(el)) lastPanelField = el;
    syncKeypadState();
  });

  document.addEventListener('focusout', () => {
    if (cobroIsOpen()) setTimeout(syncKeypadState, 0);
  });

  // ── Acciones de la barra ─────────────────────────────────────────────────

  // "Agregar productos": vuelve a la pantalla de venta SIN cancelar el cobro.
  // openBillingModal() consulta consumeResume() y, si hay que reanudar, no
  // reinicia cliente, comprobante, tipo de venta ni método.
  function addProducts() {
    resumeOnReopen = true;
    if (typeof closeAllModals === 'function') closeAllModals(true, 'add-products');
    if (typeof focusSalesSearchInput === 'function') focusSalesSearchInput({ force: true });
  }

  // "Suspender": misma función que F4 en la pantalla de venta. suspendSale()
  // dibuja su propio diálogo en el mismo modal; si el cajero lo cancela, al
  // volver a abrir el cobro se conservan sus elecciones.
  function suspend() {
    resumeOnReopen = true;
    if (typeof window.detachBillingKeyHandler === 'function') window.detachBillingKeyHandler();
    if (typeof suspendSale === 'function') suspendSale();
  }

  function consumeResume() {
    const resume = resumeOnReopen;
    resumeOnReopen = false;
    return resume;
  }

  function clearResume() {
    resumeOnReopen = false;
  }

  // ── Superposiciones ──────────────────────────────────────────────────────

  const POPOVER_IDS = ['cobro-client-picker', 'cobro-doc-menu'];

  // Devuelve true si cerró algo (Esc cierra primero lo que esté abierto encima).
  function closeOverlays({ except = null } = {}) {
    let closed = false;
    POPOVER_IDS.forEach((id) => {
      if (id === except) return;
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) {
        el.classList.add('hidden');
        closed = true;
      }
    });
    if (except === null) {
      const quick = document.getElementById('billing-quick-client');
      if (quick && !quick.classList.contains('hidden')) {
        quick.classList.add('hidden');
        closed = true;
      }
      const discount = document.getElementById('billing-v3-discount-modal');
      if (discount && !discount.classList.contains('hidden')) {
        if (typeof closeBillingDiscountModal === 'function') closeBillingDiscountModal();
        else discount.classList.add('hidden');
        closed = true;
      }
    }
    return closed;
  }

  // Enter no cobra mientras haya algo abierto encima de la pantalla.
  function hasOpenOverlay() {
    return [...POPOVER_IDS, 'billing-quick-client', 'billing-v3-discount-modal', 'billing-discard-guard']
      .some((id) => {
        const el = document.getElementById(id);
        return Boolean(el) && !el.classList.contains('hidden');
      });
  }

  document.addEventListener('pointerdown', (event) => {
    if (!document.getElementById('cobro-shell')) return;
    const target = event.target;
    POPOVER_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el || el.classList.contains('hidden')) return;
      const toggle = id === 'cobro-client-picker'
        ? document.getElementById('cobro-client-btn')
        : document.getElementById('cobro-doc-more');
      if (el.contains(target) || toggle?.contains(target)) return;
      el.classList.add('hidden');
    });
  }, true);

  window.CobroUI = {
    icon,
    buildMarkup,
    buildHeader,
    buildFooter,
    sync,
    setFiscalWarnings,
    renderClientResults,
    toggleClientPicker,
    chooseClient,
    toggleDocMenu,
    chooseExtraDoc,
    revealRnc,
    selectUsd,
    setUsdAmount,
    pressKey,
    addProducts,
    suspend,
    consumeResume,
    clearResume,
    closeOverlays,
    hasOpenOverlay,
    getSessionRate,
    NO_RATE_HELP
  };
})();

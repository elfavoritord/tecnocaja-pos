const AUTH_TOKEN_STORAGE_KEY = 'tecnocaja-auth-token';

function getStoredAuthToken() {
  try {
    return String(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '').trim();
  } catch (_error) {
    return '';
  }
}

function setStoredAuthToken(token) {
  try {
    if (token) {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, String(token));
    } else {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
  } catch (_error) {
    // Keep auth resilient even if storage is unavailable.
  }
}

window.getTecnoCajaAuthToken = getStoredAuthToken;
window.setTecnoCajaAuthToken = setStoredAuthToken;
window.clearTecnoCajaAuthToken = () => setStoredAuthToken('');

const api = {
  async request(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (typeof window.shouldBlockTrialModeRequest === 'function' && window.shouldBlockTrialModeRequest(url, method)) {
      const blockedMessage = typeof window.getTrialModeBlockedMessage === 'function'
        ? window.getTrialModeBlockedMessage()
        : 'El modo prueba está activo y esta acción fue bloqueada para no afectar tus datos reales.';
      throw new Error(blockedMessage);
    }

    const authToken = getStoredAuthToken();

    // Timeout de 15 s para todas las peticiones — evita que el UI quede colgado
    // si el servidor local no responde (e.g. MariaDB bloqueado)
    const timeoutMs = options._timeoutMs || 15000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    // Permitir que el caller pase su propio signal combinado
    const signal = options.signal || controller.signal;

    let response;
    try {
      response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(options.headers || {})
        },
        ...options,
        signal
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        throw new Error('El servidor no respondió a tiempo. Verifica que la app esté corriendo correctamente.');
      }
      throw new Error('No se pudo conectar con el servidor local. Intenta nuevamente.');
    }
    clearTimeout(timeoutId);

    let body = null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else if (response.status !== 204) {
      body = await response.text();
    }

    if (!response.ok) {
      const message = body?.error || body || 'Error de comunicación con el servidor';
      throw new Error(message);
    }

    return body;
  },

  login(usuario, password) {
    return this.request('/api/login', {
      method: 'POST',
      body: JSON.stringify({ usuario, password }),
      _timeoutMs: 8000
    });
  },

  loginWithGoogle(idToken) {
    return this.request('/api/login/google', {
      method: 'POST',
      body: JSON.stringify({ idToken })
    });
  },

  linkGoogleLogin(idToken, usuario, password) {
    return this.request('/api/login/google/link', {
      method: 'POST',
      body: JSON.stringify({ idToken, usuario, password })
    });
  },

  getSetupStatus() {
    return this.request('/api/setup/status');
  },

  completeInitialSetup(data) {
    return this.request('/api/setup/complete', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  changeAccessPassword(data) {
    return this.request('/api/account/access-password', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  activateLicense(data) {
    return this.request('/api/license/activate', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  getLicenseStatus(options = {}) {
    const refresh = options && options.refresh ? '?refresh=1' : '';
    return this.request(`/api/license/status${refresh}`);
  },

  verifySecurityPassword(data) {
    return this.request('/api/security-password/verify', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  getBootstrap() {
    return this.request('/api/bootstrap');
  },

  getBusinessTemplates() {
    return this.request('/api/business-templates');
  },

  getBusinessTemplatePreview(type) {
    return this.request(`/api/business-templates/${encodeURIComponent(type)}`);
  },

  getSuspendedSales() {
    return this.request('/api/suspended-sales');
  },

  saveSuspendedSale(data) {
    return this.request('/api/suspended-sales', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  getQuotations() {
    return this.request('/api/quotations');
  },

  saveQuotation(data) {
    return this.request('/api/quotations', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  deleteQuotation(id, data = {}) {
    return this.request(`/api/quotations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify(data)
    });
  },

  deleteSuspendedSale(id, data = {}) {
    return this.request(`/api/suspended-sales/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify(data)
    });
  },

  exportBackup() {
    return this.request('/api/backup/export');
  },

  restoreBackup(payload) {
    return this.request('/api/backup/restore', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  restoreLatestSecureBackup(payload) {
    return this.request('/api/backup/restore-latest', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  resetSystem(payload) {
    return this.request('/api/system/reset', {
      method: 'POST',
      body: JSON.stringify(payload),
      _timeoutMs: 90000
    });
  },

  getAuditLogs() {
    return this.request('/api/audit');
  },

  generateQr(text) {
    return this.request('/api/qrcode', {
      method: 'POST',
      body: JSON.stringify({ text })
    });
  },

  createCategory(data) {
    return this.request('/api/categories', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  fetchConfig() {
    return this.request('/api/config');
  },

  saveConfig(config) {
    return this.request('/api/config', {
      method: 'PUT',
      body: JSON.stringify(config)
    });
  },

  createBranch(data) {
    return this.request('/api/branches', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  createCashRegister(data) {
    return this.request('/api/cash-registers', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  setActiveBusinessStructure(data) {
    return this.request('/api/business-structure/active', {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  createProduct(data) {
    return this.request('/api/products', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  updateProduct(id, data) {
    return this.request(`/api/products/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  deleteProduct(id) {
    return this.request(`/api/products/${id}`, { method: 'DELETE' });
  },

  async importProductsCsv(formData) {
    const authToken = getStoredAuthToken();
    const response = await fetch('/api/products/import-csv', {
      method: 'POST',
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      body: formData
    });

    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      const message = body?.error || body || 'No se pudo importar el CSV de productos.';
      throw new Error(message);
    }

    return body;
  },

  uploadProductImage(id, imageData, actorPayload = {}) {
    return this.request(`/api/products/${id}/image`, {
      method: 'POST',
      body: JSON.stringify({ imageData, ...actorPayload })
    });
  },

  adjustInventory(data) {
    return this.request('/api/inventory/adjust', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  getInventoryMovements(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/api/inventory/movements${query ? `?${query}` : ''}`);
  },

  createClient(data) {
    return this.request('/api/clients', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  createSupplier(data) {
    return this.request('/api/suppliers', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  updateSupplier(id, data) {
    return this.request(`/api/suppliers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  createSupplierInvoice(data) {
    return this.request('/api/supplier-invoices', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  paySupplierInvoice(id, data) {
    return this.request(`/api/supplier-invoices/${id}/payment`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  deleteSupplier(id) {
    return this.request(`/api/suppliers/${id}`, { method: 'DELETE' });
  },

  updateClient(id, data) {
    return this.request(`/api/clients/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  getClientCreditSales(id) {
    return this.request(`/api/clients/${id}/credit-sales`);
  },

  payClientCredit(id, data) {
    return this.request(`/api/clients/${id}/credit-payments`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  deleteClient(id) {
    return this.request(`/api/clients/${id}`, { method: 'DELETE' });
  },

  createUser(data) {
    return this.request('/api/users', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  updateUser(id, data) {
    return this.request(`/api/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  changeSecurityPassword(data) {
    return this.request('/api/security-password/change', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  resetSecurityPassword(data) {
    return this.request('/api/security-password/reset', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  openCash(data) {
    return this.request('/api/cash/open', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  cancelSale(invoiceNumber, data) {
    return this.request(`/api/sales/${encodeURIComponent(invoiceNumber)}/cancel`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    });
  },

  closeCash(data) {
    return this.request('/api/cash/close', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  createCashExpense(data) {
    return this.request('/api/cash/expense', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  createCashIncome(data) {
    return this.request('/api/cash/income', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  cashDrawerEvent(data) {
    return this.request('/api/cash/drawer-event', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  cashCorte(data) {
    return this.request('/api/cash/corte', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  createSale(data) {
    // Si el OfflineManager detectó que el servidor principal no está disponible,
    // guardar la venta localmente en pending_sales en lugar de la BD principal.
    const isOffline = window.offlineManager?.getState?.()?.isOnline === false;
    const endpoint = isOffline ? '/api/offline/save-sale' : '/api/sales';
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  getPendingDeliveryCashSales() {
    return this.request('/api/sales/delivery-cash-pending');
  },

  settleDeliveryCash(invoiceNumber, data) {
    return this.request(`/api/sales/${encodeURIComponent(invoiceNumber)}/settle-delivery-cash`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    });
  },

  updateKitchenStatus(invoiceNumber, data) {
    return this.request(`/api/sales/${encodeURIComponent(invoiceNumber)}/kitchen-status`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    });
  },

  getDeliveryLocations() {
    return this.request('/api/delivery/locations');
  },

  getDiningTables() {
    return this.request('/api/dining-tables');
  },

  getDashboardReport() {
    return this.request('/api/reports/dashboard');
  },

  getMobileConfig() {
    return this.request('/api/mobile/config');
  },

  getMobileSettings() {
    return this.request('/api/mobile/settings');
  },

  updateMobileSettings(data) {
    return this.request('/api/mobile/settings', {
      method: 'PATCH',
      body: JSON.stringify(data)
    });
  },

  regenerateMobileConnectionCode(data = {}) {
    return this.request('/api/mobile/connection-code/regenerate', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  getMobileProducts(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/api/mobile/products${query ? `?${query}` : ''}`);
  },

  registerMobileSession(data) {
    return this.request('/api/mobile/sessions/register', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  getMobileSessions() {
    return this.request('/api/mobile/sessions');
  },

  getMobileSession(id) {
    return this.request(`/api/mobile/sessions/${id}`);
  },

  blockMobileSession(id, data) {
    return this.request(`/api/mobile/sessions/${id}/block`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  deleteMobileSession(id, data = {}) {
    return this.request(`/api/mobile/sessions/${id}`, {
      method: 'DELETE',
      body: JSON.stringify(data)
    });
  },

  addMobileCartItem(sessionId, data) {
    return this.request(`/api/mobile/sessions/${sessionId}/items`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  updateMobileCartItem(sessionId, productId, data) {
    return this.request(`/api/mobile/sessions/${sessionId}/items/${productId}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    });
  },

  clearMobileSession(sessionId) {
    return this.request(`/api/mobile/sessions/${sessionId}/clear`, {
      method: 'POST',
      body: JSON.stringify({})
    });
  },

  updateCashRegister(id, data) {
    return this.request(`/api/cash-registers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  getColaCobro() {
    return this.request('/api/cola-cobro');
  },

  cobrarPendiente(id, data) {
    return this.request(`/api/cola-cobro/${id}/cobrar`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }
};

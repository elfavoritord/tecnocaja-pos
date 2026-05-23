// ===== TECNO_CAJA - UI HELPERS =====

function showToast(msg, type = 'success') {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast hidden';
    document.body?.appendChild(t);
    console.warn('[Tecno Caja] #toast no existía en el DOM. Se creó dinámicamente para evitar bloqueo de UI.');
  }
  t.textContent = typeof window.translateUiString === 'function' ? window.translateUiString(msg) : msg;
  t.className = 'toast toast-' + type;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  const timeoutMs = type === 'error' ? 7000 : type === 'warning' ? 5500 : 3200;
  t._timer = setTimeout(() => t.classList.add('hidden'), timeoutMs);
  if (typeof window.scheduleUiTranslation === 'function') window.scheduleUiTranslation(t);
}

function closeModal(e) {
  if (e.target !== document.getElementById('modal-overlay')) return;
  const modalBox = document.getElementById('modal-box');
  if (modalBox?.classList.contains('billing-modal') && typeof window.requestBillingModalClose === 'function') {
    window.requestBillingModalClose({ source: 'overlay' });
    return;
  }
  closeAllModals();
}

function closeAllModals(force = false, source = 'generic') {
  const modalBox = document.getElementById('modal-box');
  if (!force && modalBox?.classList.contains('billing-modal') && typeof window.requestBillingModalClose === 'function') {
    window.requestBillingModalClose({ source });
    return;
  }
  document.getElementById('modal-overlay').classList.add('hidden');
  const modalBody = document.getElementById('modal-body');
  const modalFooter = document.getElementById('modal-footer');
  [modalBody, modalFooter].forEach((container) => {
    container?.querySelectorAll('button, input, select, textarea').forEach((node) => {
      node.disabled = false;
      node.style.opacity = '';
      node.style.pointerEvents = '';
    });
  });
  if (typeof closeSaleScaleDialog === 'function') {
    closeSaleScaleDialog();
  }
  modalBox?.classList.remove('billing-modal');
  modalBox?.classList.remove('product-modal');
  modalBox?.style.removeProperty('width');
  modalBox?.style.removeProperty('max-width');
  modalBox?.style.removeProperty('height');
  modalBox?.style.removeProperty('max-height');
  modalBox?.querySelectorAll('.billing-resize-handle').forEach((node) => node.remove());
  if (typeof stopBillingModalResize === 'function') stopBillingModalResize();
  if (typeof window.detachBillingKeyHandler === 'function') window.detachBillingKeyHandler();
  if (typeof resetProductScanner === 'function') resetProductScanner();
  if (typeof window.cancelSalesSearchFocus === 'function') window.cancelSalesSearchFocus();
  const activeElement = document.activeElement;
  if (activeElement && activeElement instanceof HTMLElement && activeElement !== document.body && activeElement !== document.documentElement) {
    const isDisabledField = ('disabled' in activeElement && activeElement.disabled) || activeElement.getAttribute('aria-disabled') === 'true';
    if (isDisabledField) activeElement.blur();
  }
  if (typeof window.scheduleSalesSearchFocus === 'function') window.scheduleSalesSearchFocus({ force: true });
}

function requestPrimaryModalClose() {
  const modalBox = document.getElementById('modal-box');
  if (modalBox?.classList.contains('billing-modal') && typeof window.requestBillingModalClose === 'function') {
    window.requestBillingModalClose({ source: 'x' });
    return;
  }
  closeAllModals(true, 'x');
}

// Keyboard shortcuts
window.addEventListener('keydown', function(e) {
  const activeModule = document.querySelector('.module.active');
  const isVentasActive = activeModule?.id === 'module-ventas';
  const targetTag = String(e.target?.tagName || '').toLowerCase();
  const isTypingContext = ['input', 'textarea', 'select'].includes(targetTag) || Boolean(e.target?.isContentEditable);
  const modalHidden = document.getElementById('modal-overlay')?.classList.contains('hidden');
  const receiptHidden = document.getElementById('receipt-overlay')?.classList.contains('hidden');
  const scaleOverlayHidden = !document.getElementById('sale-scale-overlay');
  const billingModalOpen = !modalHidden && document.getElementById('modal-box')?.classList.contains('billing-modal');

  if (billingModalOpen) {
    if (e.key === 'F2') {
      e.preventDefault();
      if (typeof focusBillingClientSelect === 'function') focusBillingClientSelect();
      return;
    }
    if (e.key === 'F4') {
      e.preventDefault();
      if (typeof cycleBillingPaymentMethod === 'function') cycleBillingPaymentMethod();
      return;
    }
    if (e.key === 'F6') {
      e.preventDefault();
      if (typeof cycleBillingDocumentPreset === 'function') cycleBillingDocumentPreset();
      return;
    }
    if (e.key === 'F9') {
      e.preventDefault();
      if (typeof toggleBillingPrintMode === 'function') toggleBillingPrintMode();
      return;
    }
    if (e.key === 'F10') {
      e.preventDefault();
      // F10 fuerza impresión independientemente del modo guardado
      if (typeof processSale === 'function') processSale('print');
      return;
    }
    if (e.key === 'Enter' && targetTag !== 'textarea') {
      e.preventDefault();
      // Usa el modo guardado (imprimir o no imprimir)
      if (typeof processSale === 'function') {
        const mode = typeof getBillingPrintMode === 'function' ? getBillingPrintMode() : true;
        processSale(mode ? 'print' : 'charge');
      }
      return;
    }
  }

  if (e.key === 'F2') {
    e.preventDefault();
    const search = document.getElementById('product-search');
    if (search) { search.focus(); search.select(); }
    return;
  }
  if (e.key === 'F1') {
    e.preventDefault();
    processSale && processSale();
    return;
  }
  if (e.key === 'Escape') {
    if (!modalHidden) {
      const modalBox = document.getElementById('modal-box');
      if (modalBox?.classList.contains('billing-modal') && typeof window.requestBillingModalClose === 'function') {
        e.preventDefault();
        window.requestBillingModalClose({ source: 'escape' });
        return;
      }
    }
    if (isVentasActive && modalHidden && receiptHidden && scaleOverlayHidden && Array.isArray(DB?.saleItems) && DB.saleItems.length && typeof cancelSale === 'function') {
      e.preventDefault();
      cancelSale();
      return;
    }
    e.preventDefault();
    closeAllModals();
    closeReceipt && closeReceipt();
    return;
  }

  if (!isVentasActive) {
    return;
  }

  if (e.key === 'F4') {
    e.preventDefault();
    if (!billingModalOpen && typeof suspendSale === 'function') suspendSale();
  }
  if (e.key === 'F6') {
    e.preventDefault();
    if (!billingModalOpen && typeof recoverSale === 'function') recoverSale();
  }
  if (e.key === 'F8') {
    e.preventDefault();
    if (typeof reprintReceipt === 'function') reprintReceipt();
  }
  if (e.key === 'F9') {
    e.preventDefault();
    if (!billingModalOpen && typeof openQuotationModal === 'function') openQuotationModal();
  }
  if (e.key === 'F10') {
    e.preventDefault();
    if (typeof openBillingModal === 'function') openBillingModal();
  }
}, true);

// Click outside search to close dropdown
document.addEventListener('click', function(e) {
  const dd = document.getElementById('search-dropdown');
  const sw = document.querySelector('.search-wrap');
  if (dd && sw && !sw.contains(e.target)) dd.classList.add('hidden');
  const notif = document.getElementById('topbar-notif');
  if (notif && !notif.contains(e.target) && typeof closeNotifications === 'function') closeNotifications();
});

window.addEventListener('load', function() {
  if (typeof syncConfigForm === 'function') syncConfigForm();
});

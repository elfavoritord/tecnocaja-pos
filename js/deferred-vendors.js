'use strict';

// Conserva las APIs globales existentes, pero evalúa jsPDF recién al exportar.
(() => {
  const pdfActions = [
    'exportReporte',
    'repV2ExportDashboardPDF',
    'repV2ExportFacturasPDF',
    'repV2ExportProductosPDF',
    'repV2ExportSucursalPDF',
    'repV2ExportCajaPDF',
    'repV2ExportUsuarioPDF',
    'repV2ExportMetodosPDF',
    'repV2ExportDevolucionesPDF',
    'repV2ExportDGIIPDF',
    'repV2ExportarParaContador',
    'repV2ExportConsolidadoPDF',
  ];

  for (const name of pdfActions) {
    const original = window[name];
    if (typeof original !== 'function' || original.__vendorDeferred) continue;
    const deferred = async function deferredPdfAction(...args) {
      try {
        await window.VendorLoader.load('jspdf');
        return await original.apply(this, args);
      } catch (error) {
        if (typeof window.showToast === 'function') {
          window.showToast(error.message || 'No se pudo cargar el generador PDF.', 'error');
        } else {
          console.error(error);
        }
        return null;
      }
    };
    deferred.__vendorDeferred = true;
    window[name] = deferred;
  }
})();

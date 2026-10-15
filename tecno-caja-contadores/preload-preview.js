'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Preload aislado para la ventana de vista previa (factura/cotización) —
// solo expone lo mínimo para que el botón flotante "Guardar PDF" pueda
// pedirle al proceso principal que muestre el diálogo de guardado y
// convierta la propia ventana a PDF.
contextBridge.exposeInMainWorld('previewAPI', {
  savePdf(suggestedName) {
    return ipcRenderer.invoke('preview:save-pdf', { suggestedName });
  },
});

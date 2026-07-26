'use strict';

window.VendorLoader = (() => {
  const pending = new Map();
  const definitions = {
    leaflet: {
      css: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
      script: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
      ready: () => Boolean(window.L),
    },
    xlsx: {
      script: 'node_modules/xlsx/dist/xlsx.full.min.js',
      ready: () => Boolean(window.XLSX),
    },
    html2canvas: {
      script: 'node_modules/html2canvas/dist/html2canvas.min.js',
      ready: () => typeof window.html2canvas === 'function',
    },
    jspdf: {
      script: 'node_modules/jspdf/dist/jspdf.umd.min.js',
      ready: () => Boolean(window.jspdf?.jsPDF),
    },
  };

  function loadCss(href) {
    if (document.querySelector(`link[data-vendor-href="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.vendorHref = href;
    document.head.appendChild(link);
  }

  function load(name) {
    const definition = definitions[name];
    if (!definition) return Promise.reject(new Error(`Librería desconocida: ${name}`));
    if (definition.ready()) return Promise.resolve();
    if (pending.has(name)) return pending.get(name);

    const promise = new Promise((resolve, reject) => {
      if (definition.css) loadCss(definition.css);
      const script = document.createElement('script');
      script.src = definition.script;
      script.async = true;
      script.onload = () => definition.ready()
        ? resolve()
        : reject(new Error(`La librería ${name} no quedó disponible.`));
      script.onerror = () => reject(new Error(`No se pudo cargar ${name}.`));
      document.head.appendChild(script);
    }).catch((error) => {
      pending.delete(name);
      throw error;
    });
    pending.set(name, promise);
    return promise;
  }

  window._loadPdfLibs = () => load('jspdf');
  return { load };
})();

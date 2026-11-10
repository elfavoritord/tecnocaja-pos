'use strict';
// Pantallas de las nueve mejoras en Chrome sin cabeza contra el servidor de
// laboratorio de probar-nueve-mejoras.js (--ui). Falla ante cualquier error de
// JavaScript en la página. Deja capturas en <laboratorio>/capturas.
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');

module.exports = async function verificarPantallas({ port, outputDir, datos }) {
  if (![3479, 3481].includes(port)) throw new Error('Esta prueba solo admite los puertos de laboratorio de nueve mejoras.');
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await require('puppeteer').launch({ headless: true });
  const errores = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errores.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_FAILED|favicon/i.test(m.text())) errores.push(`console: ${m.text()}`); });
    await page.setRequestInterception(true);
    page.on('request', (r) => (/^(data:|blob:)/.test(r.url()) || r.url().startsWith(`http://127.0.0.1:${port}/`) ? r.continue() : r.abort()));
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.evaluate(async () => {
      document.getElementById('login-user').value = 'prueba';
      document.getElementById('login-pass').value = 'SoloLaboratorio2026!';
      await doLogin();
    });
    await page.waitForFunction(() => DB.currentUser && window.CajaSegura && window.AjustesVenta && window.Auditoria && window.ItbisSeparado, { timeout: 90000 });
    // Un error atrapado por la app sale como aviso rojo, no como excepción:
    // también cuenta como fallo.
    await page.evaluate(() => {
      const original = window.showToast;
      window.__avisosError = [];
      window.showToast = (mensaje, tipo, ...resto) => { if (tipo === 'error') window.__avisosError.push(String(mensaje)); return original(mensaje, tipo, ...resto); };
    });
    const foto = (nombre) => page.screenshot({ path: path.join(outputDir, `${nombre}.png`) });
    const cerrar = () => page.evaluate(() => closeAllModals());

    // Ventana para pedir datos (la app de escritorio no tiene prompt()): campo
    // obligatorio, Enter para aceptar, Escape cancela, textos escapados y por
    // encima de los modales de Servicios (9999) y del plano de Mesas (5000).
    const formulario = await page.evaluate(async () => {
      const espera = showFormModal('Agregar material', [
        { name: 'descripcion', label: 'Descripción', required: true },
        { name: 'cantidad', label: 'Cantidad', type: 'number', value: '1' },
      ], { confirmText: 'Agregar' });
      const fondo = document.querySelector('.tc-form-modal-fondo');
      const z = Number(getComputedStyle(fondo).zIndex);
      fondo.querySelector('button[type="submit"]').click();
      const exigeDescripcion = document.body.contains(fondo) && /Completa/.test(fondo.textContent);
      const campo = fondo.querySelector('input[name="descripcion"]');
      campo.value = 'Cemento <b>';
      campo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const valores = await espera;
      const cancelado = showPromptModal('Motivo <i>x</i>:');
      const titulo = document.querySelector('.tc-form-modal-fondo p').textContent;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { z, exigeDescripcion, valores, cancelado: await cancelado, titulo, quedan: document.querySelectorAll('.tc-form-modal-fondo').length };
    });
    assert.deepEqual(formulario, { z: 10050, exigeDescripcion: true, valores: { descripcion: 'Cemento <b>', cantidad: '1' }, cancelado: null, titulo: 'Motivo <i>x</i>:', quedan: 0 });

    // Gaveta: los seis motivos y el historial.
    await page.evaluate(async () => { await CajaSegura.cargarConfig({ forzar: true }); showModule('caja', document.querySelector('.nav-item[data-module="caja"]')); });
    await page.waitForFunction(() => document.getElementById('cs-modo-cierre'), { timeout: 20000 });
    for (const motivo of ['conteo', 'cambio', 'retiro', 'consumo', 'gasto', 'otro']) {
      await page.evaluate((m) => { DB.config.cajaAbierta = true; CajaSegura.abrirGaveta(); CajaSegura.elegirMotivo(m); }, motivo);
      const ok = await page.evaluate(() => !document.getElementById('cs-gaveta-ok').disabled);
      assert.ok(ok, `motivo ${motivo} habilita continuar`);
    }
    await page.evaluate(() => { CajaSegura.elegirMotivo('consumo'); CajaSegura.buscarProducto('Pro'); });
    await foto('gaveta-consumo');
    await page.evaluate(() => CajaSegura.abrirHistorialGaveta());
    await page.waitForFunction(() => document.querySelector('#csh-resultado table'), { timeout: 20000 });
    await foto('gaveta-historial');
    await cerrar();

    // Auditoría con detalle.
    await page.evaluate(() => Auditoria.abrir());
    await page.waitForFunction(() => document.querySelector('#aud-resultado-lista table tbody tr'), { timeout: 20000 });
    await page.evaluate(() => Auditoria.detalle(0));
    await page.waitForFunction(() => document.getElementById('aud-detalle'), { timeout: 5000 });
    await foto('auditoria-detalle');
    await page.evaluate(() => document.getElementById('aud-detalle')?.remove());
    await cerrar();

    // ITBIS separado: las tres vistas.
    await page.evaluate(async () => { ItbisSeparado.montar(); document.getElementById('isp-desde').value = '2000-01-01'; document.getElementById('isp-hasta').value = '2099-12-31'; await ItbisSeparado.cargar(); });
    await page.waitForFunction(() => document.querySelector('#isp-contenido .itbis-sep-kpis'), { timeout: 20000 });
    for (const v of ['tickets', 'ecf', 'consolidado']) await page.evaluate((x) => ItbisSeparado.vista(x), v);
    const kpis = await page.evaluate(() => document.querySelectorAll('#isp-contenido .itbis-sep-kpis div').length);
    assert.ok(kpis >= 9, 'KPIs del consolidado');

    // Cancelar / nota de crédito de una factura con historial.
    await page.evaluate((f) => AjustesVenta.abrir(f), datos.factura);
    await page.waitForFunction(() => document.querySelector('.nc-acciones'), { timeout: 20000 });
    await foto('ajustes-factura');
    await page.evaluate((id) => AjustesVenta.verNota(id), datos.returnId);
    await page.waitForFunction(() => document.querySelector('.nc-modal .csr'), { timeout: 20000 });
    await foto('nota-credito');
    await cerrar();

    // Reporte general de clientes y estado de cuenta con detalle de factura.
    await page.evaluate(() => openClientReceivablesReport());
    await page.waitForFunction(() => document.querySelector('#receivables-report-table table'), { timeout: 20000 });
    await page.evaluate(() => { document.getElementById('receivables-status').value = 'all'; renderClientReceivablesReport(); });
    await foto('clientes-reporte-general');
    await page.evaluate((id) => openClientStatement(id), datos.clienteId);
    await page.waitForFunction(() => document.querySelector('#statement-rows table tbody tr'), { timeout: 20000 });
    await page.evaluate((id) => openStatementInvoice(id), datos.saleIdCredito);
    await page.waitForFunction(() => document.getElementById('ec-factura'), { timeout: 20000 });
    await foto('estado-cuenta-factura');
    const pdf = await page.evaluate(async () => Array.from(new Uint8Array((await buildClientStatementPdf(clientStatementReport)).output('arraybuffer'))));
    assert.equal(Buffer.from(pdf).subarray(0, 4).toString(), '%PDF');
    await page.evaluate(() => { document.getElementById('ec-factura')?.remove(); closeAllModals(); });

    // Cobrar: crédito en el pago mixto con saldo, límite y disponible.
    const cobro = await page.evaluate(() => { DB.payMethod = 'mixto'; return CobroUI.buildMarkup(); });
    assert.ok(cobro.includes('id="mixto-credito"') && cobro.includes('cobro-credit-info'), 'crédito y resumen de crédito en Cobrar');

    // Propina desde Mesas: tocar la mesa en el plano deja el pedido como
    // «Mesa» y el carrito muestra la propina aparte del ITBIS.
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.evaluate(async () => {
      const r = await api.request('/api/config/legal-tip', { method: 'PUT', body: JSON.stringify({ enabled: true, alcance: 'todos' }) });
      DB.config = { ...DB.config, ...r.config };
      await api.request('/api/mesas/config', { method: 'PUT', body: JSON.stringify({ activo: true }) });
      showModule('ventas', document.querySelector('.nav-item[data-module="ventas"]'));
      await Mesas.cargar();
      await Mesas.abrir();
    });
    await page.waitForSelector('.mesas-figura[data-id="lab-mesa-1"]', { timeout: 20000 });
    await page.click('.mesas-figura[data-id="lab-mesa-1"]');
    await page.waitForFunction(() => DB.saleOrderType === 'mesa' && window.Mesas.cuentaActiva() && document.body.classList.contains('mesas-consumo-activo'), { timeout: 20000 });
    const propinaMesa = await page.evaluate(async (id) => {
      await addProductById(id);
      const t = calculateCurrentSaleTotals();
      return { propina: t.propinaLegal, total: t.total, fila: !document.getElementById('ventas-sum-propina-row').classList.contains('hidden'),
        texto: document.getElementById('ventas-sum-propina').textContent, pedido: DB.saleOrderType, avisos: [...window.__avisosError] };
    }, datos.mesaProductoId);
    assert.deepEqual(propinaMesa.avisos, [], 'sin avisos de error al abrir la mesa');
    assert.equal(propinaMesa.pedido, 'mesa');
    assert.equal(propinaMesa.propina, 10, 'propina del 10 % sobre el plato de 100');
    assert.equal(propinaMesa.total, 110);
    assert.ok(propinaMesa.fila && /10\.00/.test(propinaMesa.texto), 'la fila de propina se ve en el carrito');
    await foto('mesa-propina');
    // Mostrador: solo con «Consumo en el local»; para llevar nunca.
    const modalidades = await page.evaluate(() => {
      const t = () => calculateCurrentSaleTotals().propinaLegal;
      setSaleOrderType('mostrador'); const mostrador = t();
      setSaleConsumedHere(true); const local = t();
      setSaleOrderType('recoger'); setSaleConsumedHere(true); const llevar = t();
      setSaleOrderType('mesa'); const mesa = t();
      return { mostrador, local, llevar, mesa, avisos: [...window.__avisosError] };
    });
    assert.deepEqual(modalidades, { mostrador: 0, local: 10, llevar: 0, mesa: 10, avisos: [] });
    // Cobrar la mesa con el mismo armado del carrito: la venta, el recibo y la
    // factura A4 llevan la propina aparte.
    const cobrada = await page.evaluate(async () => {
      openBillingModal();
      const metodo = document.querySelector('.pay-method[data-method="efectivo"], .pay-method');
      setPayMethod('efectivo', metodo);
      const recibido = document.getElementById('monto-recibido');
      if (recibido) { recibido.value = '110'; recibido.dispatchEvent(new Event('input', { bubbles: true })); }
      window.CobroUI?.sync?.();
      return null;
    });
    assert.equal(cobrada, null);
    await foto('cobro-mesa-propina');
    const casilla = await page.evaluate(() => {
      const oculta = () => document.getElementById('cobro-consumo-local')?.classList.contains('hidden');
      const fila = () => { const s = document.querySelector('#cobro-shell .cobro-segment'); return { cols: s?.dataset.cols, alto: Math.round(s?.getBoundingClientRect().height || 0) }; };
      const enMesa = oculta(); const segmento = fila();
      setSaleOrderType('mostrador'); window.CobroUI?.sync?.(); const enMostrador = oculta();
      setSaleOrderType('mesa'); window.CobroUI?.sync?.();
      return { enMesa, enMostrador, segmento, lista: Math.round(document.querySelector('#cobro-shell .cobro-lines')?.getBoundingClientRect().height || 0) };
    });
    assert.equal(casilla.enMesa, true, 'en mesa la casilla de consumo local no ocupa espacio');
    assert.equal(casilla.enMostrador, false, 'en mostrador sí aparece');
    assert.equal(casilla.segmento.cols, '4');
    assert.ok(casilla.segmento.alto < 60, `los cuatro tipos en una sola fila (alto ${casilla.segmento.alto})`);
    // Botón «Quitar propina» junto a Agregar productos / Aplicar descuento.
    const botonPropina = await page.evaluate(() => {
      const b = document.getElementById('cobro-propina-btn');
      const fila = document.getElementById('cobro-left-actions');
      const antes = { visible: !b.classList.contains('hidden'), etiqueta: b.textContent.trim(), cols: fila.dataset.cols, alto: Math.round(fila.getBoundingClientRect().height) };
      b.click();
      const quitada = { propina: calculateCurrentSaleTotals().propinaLegal, total: calculateCurrentSaleTotals().total, etiqueta: b.textContent.trim(),
        fila: document.querySelector('[data-legal-tip-label]')?.textContent, activo: b.classList.contains('is-active') };
      return { antes, quitada };
    });
    await foto('cobro-propina-quitada');
    const devuelta = await page.evaluate(() => { document.getElementById('cobro-propina-btn').click(); return calculateCurrentSaleTotals().propinaLegal; });
    assert.deepEqual(botonPropina.antes, { visible: true, etiqueta: 'Quitar propina', cols: '3', alto: botonPropina.antes.alto });
    assert.ok(botonPropina.antes.alto < 70, `los tres botones en una fila (alto ${botonPropina.antes.alto})`);
    assert.deepEqual(botonPropina.quitada, { propina: 0, total: 100, etiqueta: 'Cobrar propina', fila: 'Propina legal (quitada)', activo: true });
    assert.equal(devuelta, 10, 'al volver a pulsar, la propina regresa');
    // La propina quitada no sale como devuelta: el recibido exacto sigue al
    // total; un monto que escribió el cajero se respeta.
    const recibido = await page.evaluate(() => {
      const input = document.getElementById('monto-recibido');
      const boton = document.getElementById('cobro-propina-btn');
      const leer = () => ({ recibido: Number(input.value), devuelta: parseFmt(document.getElementById('cambio-val')?.textContent || '0') });
      const escribir = (v) => { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); };
      setMontoExacto();                     // «Exacto» con propina: 110
      const exacto = leer();
      boton.click(); const exactoQuitada = leer();
      boton.click(); const exactoDevuelta = leer();
      escribir('500');                      // el cliente dio 500
      boton.click(); const escritoQuitada = leer();
      boton.click(); const escritoDevuelta = leer();
      escribir('110');
      return { exacto, exactoQuitada, exactoDevuelta, escritoQuitada, escritoDevuelta };
    });
    assert.deepEqual(recibido.exacto, { recibido: 110, devuelta: 0 });
    assert.deepEqual(recibido.exactoQuitada, { recibido: 100, devuelta: 0 }, 'quitada: el recibido exacto baja a 100, sin devuelta');
    assert.deepEqual(recibido.exactoDevuelta, { recibido: 110, devuelta: 0 }, 'devuelta la propina: vuelve a 110');
    assert.deepEqual(recibido.escritoQuitada, { recibido: 500, devuelta: 400 }, 'monto escrito: se respeta y la devuelta es sin propina');
    assert.deepEqual(recibido.escritoDevuelta, { recibido: 500, devuelta: 390 });
    // Comprobantes: Ticket, E32 y E31 a la vista; la serie B y los demás e-CF
    // en «Más»; sin botón «e-CF» genérico. Solo se elige lo que tiene
    // secuencia: este negocio no tiene el e-CF activo.
    // La lista de comprobantes se pide al servidor y se espera desde aquí: un
    // evaluate que esperaba ese fetch fallaba a veces con «Promise was collected».
    const refrescarDocs = async () => {
      await page.evaluate(() => { window.__tcDocsListo = false; refreshAvailableNcfDocTypes().finally(() => { window.__tcDocsListo = true; }); });
      await page.waitForFunction(() => window.__tcDocsListo === true, { timeout: 20000 });
    };
    const markup = await page.evaluate(() => {
      const div = document.createElement('div');
      div.innerHTML = CobroUI.buildMarkup();
      window.__tcAvisos = [];
      window.__tcShowToast = window.showToast;
      window.__tcDocsAntes = _availableNcfDocTypes;
      window.showToast = (mensaje, tipo, ...resto) => { if (tipo === 'warning') window.__tcAvisos.push(String(mensaje)); return window.__tcShowToast(mensaje, tipo, ...resto); };
      return {
        principales: [...div.querySelectorAll('.cobro-docs .cobro-doc[data-preset]')].map((b) => b.dataset.preset),
        mas: [...div.querySelectorAll('#cobro-doc-menu [data-preset]')].map((b) => b.dataset.preset),
      };
    });
    let docs;
    try {
      await refrescarDocs();
      docs = { ...markup, ...(await page.evaluate(() => {
        const ofrecidos = [..._availableNcfDocTypes];
        const e32Apagado = document.querySelector('#cobro-shell .cobro-doc[data-preset="E32"]')?.classList.contains('is-unavailable');
        setSaleDocumentPreset('E32');
        const e32SinEcf = DB.saleDocumentType;
        // Con secuencias E31/E32 (como un negocio con e-CF): se eligen y E31 pide RNC.
        _availableNcfDocTypes = new Set([...ofrecidos, 'E31', 'E32']);
        setSaleDocumentPreset('E31');
        const e31 = { tipo: DB.saleDocumentType, ecf: DB.saleEcfType, pideRnc: buildBillingValidationBuckets().client.some((m) => /E31/.test(m)) };
        setSaleDocumentPreset('E32'); const e32 = DB.saleEcfType;
        return { ofrecidos, e32Apagado, e32SinEcf, e31, e32, avisos: [...window.__tcAvisos] };
      })) };
    } finally {
      await page.evaluate(() => { _availableNcfDocTypes = window.__tcDocsAntes; setSaleDocumentPreset('ticket'); window.showToast = window.__tcShowToast; });
    }
    assert.deepEqual(docs.principales, ['ticket', 'E32', 'E31'], 'sin botón «e-CF» y sin B02/B01 a la vista');
    assert.deepEqual(docs.mas, ['B02', 'B01', 'B14', 'B15', 'B16', 'B03', 'B04', 'E44', 'E45', 'E46']);
    assert.ok(!docs.ofrecidos.some((t) => /^E/.test(t)), `sin e-CF activo no se ofrece ningún E: ${docs.ofrecidos}`);
    assert.equal(docs.e32Apagado, true, 'E32 se ve apagado sin e-CF activo');
    assert.equal(docs.e32SinEcf, 'ticket', 'E32 no se deja elegir sin e-CF activo');
    assert.ok(docs.avisos.some((m) => /no está activa|deshabilitada/.test(m)), `avisa por qué: ${docs.avisos}`);
    assert.deepEqual(docs.e31, { tipo: 'factura-electronica', ecf: 'E31', pideRnc: true });
    assert.equal(docs.e32, 'E32');
    await refrescarDocs();
    await page.evaluate(() => CobroUI.toggleDocMenu(true));
    await foto('cobro-comprobantes-sin-ecf');
    await page.evaluate(() => CobroUI.toggleDocMenu(false));
    const resultadoCobro = await page.evaluate(async () => {
      const venta = buildSalePayload();
      if (!venta) return { error: 'buildSalePayload devolvió null', avisos: [...window.__avisosError] };
      await Mesas.prepararVenta();
      venta.mesasCuenta = Mesas.cuentaActiva();
      venta.clientRequestId = `ui-mesa-${Date.now()}-abcdef`;
      const r = await api.createSale(venta);
      window.__ventaMesa = r.sale;
      const filas = buildReceiptSummaryRows(r.sale).map((f) => f.join(' '));
      const a4 = buildFormalInvoiceMarkup(r.sale);
      closeAllModals?.();
      const hoja = document.createElement('div');
      hoja.id = 'ui-factura-a4'; hoja.style.cssText = 'position:fixed;inset:0;z-index:9999;overflow:auto;background:#fff';
      hoja.innerHTML = a4; document.body.appendChild(hoja);
      return { payload: { propina: venta.propinaLegal, pedido: venta.tipoPedido, total: venta.total }, venta: { propina: r.sale.propinaLegal, total: r.sale.total },
        recibo: filas.find((f) => /Propina legal/.test(f)) || '', a4: /Propina legal 10%/.test(a4) };
    });
    assert.ok(!resultadoCobro.error, JSON.stringify(resultadoCobro));
    assert.deepEqual(resultadoCobro.payload, { propina: 10, pedido: 'mesa', total: 110 });
    assert.deepEqual(resultadoCobro.venta, { propina: 10, total: 110 });
    assert.match(resultadoCobro.recibo, /10\.00/, 'el recibo muestra la propina');
    assert.equal(resultadoCobro.a4, true, 'la factura A4 muestra la propina');
    await foto('factura-a4-propina');
    await page.evaluate(() => document.getElementById('ui-factura-a4')?.remove());
    await page.evaluate(async () => {
      const r = await api.request('/api/config/legal-tip', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
      DB.config = { ...DB.config, ...r.config };
    });

    // Cierre seguro: se activa en Configuración → Facturación y deja Caja a
    // ciegas con el turno abierto (montos, corte y Reportes del cajero).
    const navDe = (m) => `.nav-item[data-module="${m}"]`;
    // Venta de mesa cobrada: su comprobante se ve antes de volver al plano
    // (el plano, que va por encima de todo, lo tapaba).
    const comprobanteMesa = await page.evaluate(async () => {
      if (document.getElementById('cobro-shell')) closeAllModals(true, 'force');
      // Mismo orden que al cobrar (ventas.js): confirmada, comprobante, carrito limpio, volver.
      Mesas.ventaConfirmada();
      showReceipt(window.__ventaMesa, { pending: false });
      cancelSale();
      Mesas.volverTrasVenta();
      await new Promise((r) => setTimeout(r, 800));
      return { plano: Boolean(document.querySelector('.mesas-pantalla')), recibo: !document.getElementById('receipt-overlay').classList.contains('hidden') };
    });
    assert.deepEqual(comprobanteMesa, { plano: false, recibo: true }, 'el plano espera a que se cierre el comprobante');
    await foto('mesa-comprobante');
    await page.evaluate(() => closeReceipt());
    await page.waitForSelector('.mesas-pantalla', { timeout: 10000 });

    // Meseros/as: ventana propia del plano (la app de escritorio no tiene prompt).
    await page.click('.mesas-pantalla [data-action="meseros"]');
    await page.waitForSelector('.mesas-pantalla .mesas-dialogo form', { timeout: 5000 });
    await page.type('.mesas-dialogo input[name="nombre"]', 'Ana Lab');
    await page.click('.mesas-dialogo form button[type="submit"]');
    await page.waitForFunction(() => /Ana Lab/.test(document.querySelector('.mesas-meseros-lista')?.textContent || ''), { timeout: 10000 });
    await foto('mesas-meseros');
    const aviso = await page.evaluate(() => {
      const t = document.getElementById('toast'); const r = t.getBoundingClientRect();
      return { texto: t.textContent, visible: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#toast') === t };
    });
    assert.ok(/Ana Lab/.test(aviso.texto) && aviso.visible, `el aviso se ve por encima del plano: ${JSON.stringify(aviso)}`);
    await page.evaluate(() => [...document.querySelectorAll('.mesas-meseros-lista [data-mesero]')].find((b) => b.closest('li').textContent.includes('Ana Lab')).click());
    await page.waitForFunction(() => /Ana Lab.*quitado/.test(document.querySelector('.mesas-meseros-lista')?.textContent || ''), { timeout: 10000 });
    await page.click('.mesas-dialogo [data-cerrar]');

    // Entrar a una mesa y volver sin pedir nada no la deja ocupada (ni crea cuenta).
    const estadoMesa = () => page.evaluate(() => {
      const nodo = document.querySelector('.mesas-figura[data-id="lab-mesa-1"]');
      return nodo ? (nodo.classList.contains('is-occupied') ? 'ocupada' : 'disponible') : 'sin-mesa';
    });
    const cuentasMesa = () => page.evaluate(async () => (await (await fetch('/api/mesas/cuentas', { headers: { Authorization: `Bearer ${DB.authToken}` } })).json()).filter((c) => c.elemento_id === 'lab-mesa-1').length);
    const entrarYVolver = async () => {
      await page.click('.mesas-figura[data-id="lab-mesa-1"]');
      await page.waitForSelector('#mesas-cuenta-barra', { timeout: 10000 });
      await page.click('#mesas-consumo-salir'); // «Volver al plano»; el confirm lo acepta la prueba
      await page.waitForSelector('.mesas-figura[data-id="lab-mesa-1"]', { timeout: 10000 });
    };
    await entrarYVolver();
    assert.equal(await estadoMesa(), 'disponible', 'la mesa sin productos sigue disponible');
    assert.equal(await cuentasMesa(), 0, 'no se creó una cuenta vacía');
    // Una cuenta vacía que ya existía (versiones anteriores) no pinta la mesa de rojo y se borra al salir.
    await page.evaluate(async () => {
      await fetch('/api/mesas/cuentas', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` }, body: JSON.stringify({ id: 'cuenta-vacia-lab', elementoId: 'lab-mesa-1', nombre: 'General' }) });
      document.querySelectorAll('.mesas-pantalla').forEach((n) => n.remove());
      await Mesas.abrir();
    });
    await page.waitForSelector('.mesas-figura[data-id="lab-mesa-1"]', { timeout: 10000 });
    assert.equal(await cuentasMesa(), 1);
    assert.equal(await estadoMesa(), 'disponible', 'una cuenta vacía no ocupa la mesa');
    await entrarYVolver();
    assert.equal(await cuentasMesa(), 0, 'la cuenta vacía se borró al volver');

    // Guardar plano: sale del editor al plano de las mesas y avisa.
    await page.click('.mesas-pantalla [data-action="editar"]');
    await page.waitForSelector('.mesas-pantalla [data-action="guardar"]:not([hidden])', { timeout: 5000 });
    await page.click('.mesas-pantalla [data-action="guardar"]');
    await page.waitForFunction(() => /Plano guardado/.test(document.getElementById('toast')?.textContent || '') && !document.querySelector('.mesas-pantalla.mesas-editor-activo'), { timeout: 10000 });
    assert.equal(await page.$eval('.mesas-pantalla h2', (h) => h.textContent), 'Mesas y espacios', 'tras guardar vuelve al plano de mesas');
    await foto('mesas-plano-guardado');

    // Biblioteca de figuras: grupos plegables, búsqueda por sinónimos y
    // figuras nuevas que el servidor acepta al guardar.
    await page.click('.mesas-pantalla [data-action="editar"]');
    await page.waitForSelector('.mesas-biblioteca:not([hidden]) [data-figura="neveraVitrina"]', { timeout: 5000 });
    const biblioteca = await page.evaluate(() => ({ grupos: document.querySelectorAll('.mesas-elementos-grupo').length, figuras: document.querySelectorAll('[data-figura]').length }));
    assert.ok(biblioteca.grupos === 8 && biblioteca.figuras >= 70, JSON.stringify(biblioteca));
    await page.type('.mesas-buscar-elemento', 'refrigerador');
    const halladas = await page.evaluate(() => [...document.querySelectorAll('[data-figura]')].filter((b) => !b.hidden && !b.closest('[hidden]')).map((b) => b.dataset.figura));
    assert.ok(halladas.includes('nevera') && halladas.includes('neveraVitrina') && !halladas.includes('mesa4'), `buscar «refrigerador»: ${halladas}`);
    await page.evaluate(() => { const b = document.querySelector('.mesas-buscar-elemento'); b.value = ''; b.dispatchEvent(new Event('input')); });
    for (const tipo of ['barra', 'neveraVitrina', 'sillonBarberia', 'parqueo', 'terraza']) await page.click(`.mesas-biblioteca [data-figura="${tipo}"]`);
    const encimadas = await page.evaluate(() => {
      const cajas = [...document.querySelectorAll('.mesas-lienzo .mesas-figura:not([data-forma="zona"])')].map((b) => ({ id: b.title, x: parseFloat(b.style.left), y: parseFloat(b.style.top), w: parseFloat(b.style.width), h: parseFloat(b.style.height) }));
      const pares = [];
      cajas.forEach((a, i) => cajas.slice(i + 1).forEach((b) => { if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) pares.push(`${a.id} / ${b.id}`); }));
      return pares;
    });
    assert.deepEqual(encimadas, [], 'las figuras nuevas caen en un hueco libre');
    await foto('mesas-editor-figuras');
    await page.click('.mesas-pantalla [data-action="guardar"]');
    await page.waitForFunction(() => !document.querySelector('.mesas-pantalla.mesas-editor-activo'), { timeout: 10000 });
    const tiposGuardados = await page.evaluate(async () => (await (await fetch('/api/mesas/plano', { headers: { Authorization: `Bearer ${DB.authToken}` } })).json()).elementos.map((e) => e.tipo));
    for (const tipo of ['barra', 'neveraVitrina', 'sillonBarberia', 'parqueo', 'terraza']) assert.ok(tiposGuardados.includes(tipo), `el plano guardó ${tipo}: ${tiposGuardados}`);
    await foto('mesas-plano-figuras');

    // Reservaciones: reservar una mesa libre con anticipo consumible, ver e
    // imprimir su constancia, verla "Reservada", y que al llegar el cliente su
    // cuenta lleve el anticipo y el cobro lo descuente (la factura no cambia).
    const anticiposAntes = await page.evaluate(() => ({ neto: Number(DB.caja?.activeSession?.anticiposReserva?.neto || 0), balance: parseFmt(document.getElementById('res-balance').textContent) }));
    await page.click('.mesas-pantalla [data-action="reservas"]');
    await page.waitForSelector('.mesas-reserva-form', { timeout: 5000 });
    const reservaPrevista = await page.evaluate(() => {
      const f = document.querySelector('.mesas-reserva-form');
      const d = new Date(Date.now() + 20 * 60000);
      f.elementoId.value = 'lab-mesa-1';
      f.fecha.value = MesasReservas.fechaLocal(d);
      f.hora.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      f.cliente.value = 'Familia Lab'; f.telefono.value = '809-555-0199'; f.personas.value = '4'; f.nota.value = 'Cumpleaños';
      f.anticipoMonto.value = '60'; f.anticipoMonto.dispatchEvent(new Event('input'));
      const detalleVisible = !f.querySelector('.mesas-anticipo-detalle').hidden;
      f.anticipoMetodo.value = 'efectivo'; f.anticipoConsumible.checked = true;
      f.requestSubmit();
      return { hoy: f.fecha.value === MesasReservas.fechaLocal(), fecha: f.fecha.value, hora: f.hora.value, detalleVisible };
    });
    assert.equal(reservaPrevista.detalleVisible, true, 'con monto se muestran forma de pago, referencia y consumible');
    await page.waitForSelector('.mesas-constancia', { timeout: 10000 })
      .catch(async (e) => { throw new Error(`${e.message} · aviso: ${await page.evaluate(() => document.getElementById('toast')?.textContent)} · ${JSON.stringify(reservaPrevista)}`); });
    const constancia = await page.$eval('.mesas-constancia', (n) => n.textContent.replace(/\s+/g, ' '));
    assert.match(constancia, /CONSTANCIA DE RESERVA.*Familia Lab.*RD\$ 60\.00.*Efectivo.*Sí: se descuenta de la cuenta/, constancia);
    await foto('mesas-constancia-reserva');
    // La pantalla de Caja lo ve al instante como entrada de dinero: movimiento,
    // fila del resumen del día, ingresos y balance.
    const enCaja = await page.evaluate(() => ({
      movimiento: DB.movimientosCaja[0] ? `${DB.movimientosCaja[0].tipo} ${DB.movimientosCaja[0].monto}` : '',
      neto: Number(DB.caja?.activeSession?.anticiposReserva?.neto || 0),
      fila: !document.getElementById('res-anticipos-row').classList.contains('hidden'),
      ingresos: !document.getElementById('caja-ingreso-anticipos-row').classList.contains('hidden'),
      balance: parseFmt(document.getElementById('res-balance').textContent),
      lista: document.getElementById('movimientos-tbody').textContent.replace(/\s+/g, ' '),
    }));
    assert.equal(enCaja.movimiento, 'Anticipo de reserva 60', JSON.stringify(enCaja));
    assert.equal(Math.round((enCaja.neto - anticiposAntes.neto) * 100), 6000, JSON.stringify({ enCaja, anticiposAntes }));
    assert.ok(enCaja.fila && enCaja.ingresos, 'el resumen del día y los ingresos muestran los anticipos');
    assert.equal(Math.round((enCaja.balance - anticiposAntes.balance) * 100), 6000, 'el balance final suma el anticipo');
    assert.match(enCaja.lista, /Anticipo de reserva.*Entrada.*Familia Lab/, enCaja.lista);
    // Escape cierra solo la ventana de arriba (la constancia), no la lista.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.mesas-constancia') && document.querySelector('.mesas-reserva-lista'), { timeout: 5000 });
    await page.waitForFunction(() => /Familia Lab[\s\S]*Anticipo RD\$ 60\.00/.test(document.querySelector('.mesas-reserva-lista')?.textContent || ''), { timeout: 10000 });
    const choque = await page.evaluate(async (r) => (await fetch('/api/mesas/reservas', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DB.authToken}` },
      body: JSON.stringify({ elementoId: 'lab-mesa-1', cliente: 'Otro cliente', personas: 2, fecha: r.fecha, hora: r.hora }) })).status, reservaPrevista);
    assert.equal(choque, 409, 'la misma mesa no se reserva dos veces a la misma hora');
    await foto('mesas-reservaciones');
    await page.click('.mesas-dialogo [data-cerrar]');
    if (reservaPrevista.hoy) {
      const plano = await page.evaluate(() => ({
        reservada: document.querySelector('.mesas-figura[data-id="lab-mesa-1"]').classList.contains('is-reserved'),
        aviso: document.querySelector('.mesas-figura[data-id="lab-mesa-1"] .mesas-reserva-chip')?.textContent || '',
        leyenda: document.querySelector('.mesas-leyenda [data-estado="reservada"] b')?.textContent,
      }));
      assert.deepEqual({ reservada: plano.reservada, leyenda: plano.leyenda }, { reservada: true, leyenda: '1' }, JSON.stringify(plano));
      assert.match(plano.aviso, /\d{1,2}:\d{2}/, 'la mesa muestra la hora de la reserva');
      await foto('mesas-plano-reservada');
      await page.click('.mesas-figura[data-id="lab-mesa-1"]');
      await page.waitForSelector('.mesas-reserva-ficha', { timeout: 5000 });
      assert.match(await page.$eval('.mesas-reserva-ficha', (n) => n.textContent), /Familia Lab[\s\S]*4 persona[\s\S]*Anticipo RD\$ 60\.00/);
      await page.click('.mesas-dialogo [data-reserva="llego"]');
      await page.waitForSelector('#mesas-cuenta-barra', { timeout: 10000 });
      assert.match(await page.$eval('#mesas-consumo-titulo', (n) => n.textContent), /Familia Lab/, 'la cuenta lleva el nombre de quien reservó');
      assert.match(await page.$eval('#mesas-cuenta-barra', (n) => n.textContent), /Anticipo RD\$ 60\.00 · se descuenta/);
      // Cobro: total de la factura 100, anticipo −60, a pagar 40.
      const enCobro = await page.evaluate(async (id) => {
        await addProductById(id);
        openBillingModal();
        setPayMethod('efectivo', document.querySelector('.pay-method[data-method="efectivo"], .pay-method'));
        setMontoExacto();
        window.CobroUI?.sync?.();
        return { aPagar: document.getElementById('billing-total').textContent, centro: document.getElementById('cobro-total-value').textContent,
          total: document.getElementById('cobro-total-left').textContent, anticipo: document.getElementById('cobro-anticipo').textContent,
          filaVisible: !document.getElementById('cobro-anticipo-row').classList.contains('hidden'), recibido: document.getElementById('monto-recibido').value,
          avisos: buildBillingValidationBuckets().confirm, errores: [...window.__avisosError] };
      }, datos.mesaProductoId);
      assert.deepEqual({ aPagar: /40\.00/.test(enCobro.aPagar), centro: /40\.00/.test(enCobro.centro), total: /100\.00/.test(enCobro.total), anticipo: enCobro.anticipo, fila: enCobro.filaVisible, recibido: enCobro.recibido, avisos: enCobro.avisos, errores: enCobro.errores },
        { aPagar: true, centro: true, total: true, anticipo: '-60.00', fila: true, recibido: '40.00', avisos: [], errores: [] }, JSON.stringify(enCobro));
      await foto('cobro-anticipo-reserva');
      const cobradaReserva = await page.evaluate(async () => {
        const venta = buildSalePayload();
        if (!venta) return { error: 'buildSalePayload devolvió null' };
        await Mesas.prepararVenta();
        venta.mesasCuenta = Mesas.cuentaActiva();
        venta.clientRequestId = `ui-reserva-${Date.now()}-abcdef`;
        const r = await api.createSale(venta);
        closeAllModals?.(true, 'force');
        Mesas.ventaConfirmada(venta);
        const filas = buildThermalPaymentRows(r.sale).map((f) => f.slice(0, 2).join(' '));
        cancelSale();
        Mesas.volverTrasVenta();
        return { payload: { anticipo: venta.anticipoReserva, total: venta.total, recibido: venta.recibido }, venta: { total: r.sale.total, anticipo: r.sale.anticipoReserva, efectivo: r.sale.montoEfectivo }, filas };
      });
      assert.ok(!cobradaReserva.error, JSON.stringify(cobradaReserva));
      assert.deepEqual(cobradaReserva.payload, { anticipo: 60, total: 100, recibido: 40 });
      assert.deepEqual(cobradaReserva.venta, { total: 100, anticipo: 60, efectivo: 40 });
      assert.ok(cobradaReserva.filas.some((f) => /Anticipo reserva -60\.00/.test(f)) && cobradaReserva.filas.some((f) => /Pagado ahora 40\.00/.test(f)), JSON.stringify(cobradaReserva.filas));
      await page.waitForSelector('.mesas-figura[data-id="lab-mesa-1"]', { timeout: 10000 });
      const despues = await page.evaluate(async () => {
        const r = (await (await fetch('/api/mesas/reservas', { headers: { Authorization: `Bearer ${DB.authToken}` } })).json()).find((x) => x.cliente === 'Familia Lab');
        return { estado: r?.estado, anticipo: r?.anticipo?.estado, libre: document.querySelector('.mesas-figura[data-id="lab-mesa-1"]').classList.contains('is-available') };
      });
      assert.deepEqual(despues, { estado: 'cumplida', anticipo: 'aplicado', libre: true });
    }

    await page.evaluate(() => document.querySelectorAll('.mesas-pantalla [data-action="cerrar"]').forEach((b) => b.click()));
    await page.waitForFunction(() => !document.querySelector('.mesas-pantalla') && document.getElementById('modal-overlay').classList.contains('hidden'), { timeout: 10000 });
    const sinCorte = await page.evaluate(() => !document.querySelector('#module-caja .caja-quick-bar [onclick*="openCashCorteModal"]'));
    assert.ok(sinCorte, 'la barra de Caja ya no tiene «Corte de caja»');
    const toggleCierreSeguro = async (valor) => {
      await page.evaluate((sel) => showModule('configuracion', document.querySelector(sel)), navDe('configuracion'));
      await page.waitForFunction(() => { const i = document.getElementById('cfg-cierre-seguro'); return i && !i.disabled; }, { timeout: 20000 });
      // Configuración → Ventas y Facturación → Facturación.
      await page.evaluate((v) => {
        openCfgGroupModal('ventas');
        _cfgDrillSection(document.getElementById('cfg-section-billing-title').closest('.config-section'));
        document.getElementById('cfg-cierre-seguro-section').scrollIntoView({ block: 'center' });
        const i = document.getElementById('cfg-cierre-seguro'); i.checked = v; i.dispatchEvent(new Event('change'));
      }, valor);
      await page.waitForFunction((v) => CajaSegura.cierreSeguro === v, { timeout: 20000 }, valor);
      if (valor) await foto('config-cierre-seguro');
      await page.evaluate(() => closeCfgGroupModal());
    };
    const pantallaCaja = () => page.evaluate((sel) => {
      DB.config.cajaAbierta = true; try { cajaAbierta = true; } catch (_) { /* global */ }
      showModule('caja', document.querySelector(sel));
      syncCajaState();
      return {
        monto: document.getElementById('caja-monto').textContent,
        resumen: [...document.querySelectorAll('#module-caja .caja-resumen .resumen-row span:last-child, #module-caja .caja-resumen .resumen-total span:last-child')].map((e) => e.textContent),
        aviso: document.querySelector('#module-caja .cs-ciego-aviso')?.textContent || '',
        interruptorEnCaja: Boolean(document.querySelector('#module-caja input[type="checkbox"][onchange*="cambiarModo"]')),
      };
    }, navDe('caja'));
    await toggleCierreSeguro(true);
    const ciega = await pantallaCaja();
    assert.match(ciega.monto, /••••••/, `monto de Caja oculto: ${ciega.monto}`);
    assert.ok(ciega.resumen.length >= 8 && ciega.resumen.every((t) => t === '••••••'), `Resumen del día oculto: ${ciega.resumen}`);
    assert.match(ciega.aviso, /al cerrar la caja/);
    assert.equal(ciega.interruptorEnCaja, false, 'el interruptor ya no está en Caja');
    await foto('caja-cierre-seguro');
    await page.evaluate(() => openCashCorteModal());
    const corte = await page.evaluate(() => ({
      titulo: document.getElementById('modal-title').textContent,
      corteConMontos: !document.getElementById('cash-corte-modal')?.classList.contains('hidden'),
      conteo: Boolean(document.getElementById('csa-den-1000')),
    }));
    assert.match(corte.titulo, /conteo a ciegas/); assert.equal(corte.corteConMontos, false, 'no abre el corte con montos'); assert.ok(corte.conteo);
    await page.evaluate(() => { document.getElementById('csa-den-500').value = '1'; CajaSegura.recalcular('csa'); document.getElementById('csa-ok').click(); });
    await page.waitForFunction(() => document.getElementById('modal-title').textContent === 'Conteo guardado', { timeout: 20000 });
    const conteoCiego = await page.evaluate(() => document.getElementById('modal-body').textContent);
    assert.match(conteoCiego, /500\.00/); assert.ok(!/Esperado|Sobrante|Faltante/.test(conteoCiego), conteoCiego);
    await foto('corte-ciego');
    await cerrar();
    const reportes = await page.evaluate((sel) => {
      const avisos = [];
      const original = window.showToast;
      window.showToast = (m, t, ...r) => { avisos.push(String(m)); return original(m, t, ...r); };
      try {
        DB.cajaSegura.veTurnoAbierto = false; // un cajero: no ve reportes de caja
        showModule('reportes', document.querySelector(sel));
        const cajero = document.getElementById('module-reportes').classList.contains('active');
        DB.cajaSegura.veTurnoAbierto = true;
        showModule('reportes', document.querySelector(sel));
        return { cajero, admin: document.getElementById('module-reportes').classList.contains('active'), avisos };
      } finally { DB.cajaSegura.veTurnoAbierto = true; window.showToast = original; }
    }, navDe('reportes'));
    assert.equal(reportes.cajero, false, 'el cajero no entra a Reportes con el turno abierto');
    assert.ok(reportes.avisos.some((m) => /al cerrar la caja/.test(m)), reportes.avisos.join(' | '));
    assert.equal(reportes.admin, true, 'quien ve reportes de caja sí entra');
    await toggleCierreSeguro(false);
    const visible = await pantallaCaja();
    assert.ok(!/•/.test(visible.monto) && visible.resumen.every((t) => /\d/.test(t)) && !visible.aviso, JSON.stringify(visible));
    assert.ok(await page.evaluate(() => !document.getElementById('res-anticipos-row').classList.contains('hidden')
      && /Anticipo de reserva/.test(document.getElementById('movimientos-tbody').textContent)), 'Caja muestra los anticipos de reservas del turno');
    await foto('caja-anticipos-reserva');

    // Con mesas sin cobrar el cierre muestra cuáles son y no pide el conteo.
    const bloqueo = await page.evaluate(async () => {
      const original = api.request.bind(api);
      api.request = async (url, opts) => (String(url).startsWith('/api/caja/cierre/verificar')
        ? { puedeCerrar: false, otraCajaAbierta: false, mensaje: 'x', mesas: [{ cuentaId: 'c', mesa: 'Mesa 7', cuenta: 'General', productos: 3, consumo: 450, actualizada: '2026-11-08T10:00:00' }] }
        : original(url, opts));
      try {
        DB.config.cajaAbierta = true; try { cajaAbierta = true; } catch (_) { /* global */ }
        await CajaSegura.abrirCierre();
        return { modal: document.getElementById('modal-body').textContent, conteo: Boolean(document.getElementById('cs-den-2000')) };
      } finally { api.request = original; closeAllModals(); }
    });
    assert.match(bloqueo.modal, /Mesa 7/); assert.equal(bloqueo.conteo, false, 'no pide el conteo con mesas pendientes');

    // Cierre real por la pantalla: denominaciones, análisis y reporte.
    await page.evaluate(async () => {
      const r = await api.request('/api/caja/config'); if (r.cierreSeguro) await api.request('/api/caja/config', { method: 'PUT', body: JSON.stringify({ cierreSeguro: false }) });
      await CajaSegura.cargarConfig({ forzar: true });
      DB.config.cajaAbierta = true; try { cajaAbierta = true; } catch (_) { /* global */ }
      await CajaSegura.abrirCierre();
    });
    await page.waitForFunction(() => document.getElementById('cs-den-2000'), { timeout: 20000 });
    await page.evaluate(() => { document.getElementById('cs-den-1000').value = '1'; document.getElementById('cs-den-25').value = '2'; CajaSegura.recalcular('cs'); });
    const totalTxt = await page.evaluate(() => document.getElementById('cs-total').textContent);
    assert.match(totalTxt, /1,050\.00/);
    await foto('cierre-conteo');
    await page.evaluate(() => CajaSegura.confirmarCierre());
    await page.waitForFunction(() => document.querySelector('.cs-reporte-modal .csr'), { timeout: 60000 });
    const reporte = await page.evaluate(() => document.querySelector('.cs-reporte-modal').textContent);
    assert.match(reporte, /REPORTE DE CIERRE DE CAJA/); assert.match(reporte, /1\. Efectivo/); assert.match(reporte, /4\. Crédito/);
    await foto('cierre-reporte');
    await page.evaluate(() => CajaSegura.cerrarReporte());
    await page.waitForFunction(() => !document.getElementById('cash-cierre-summary')?.classList.contains('hidden'), { timeout: 20000 });
    await foto('cierre-resumen');
    await new Promise((r) => setTimeout(r, 500));
    errores.push(...(await page.evaluate(() => window.__avisosError || [])).map((m) => `aviso de error: ${m}`));
    assert.deepEqual(errores, [], `errores en la página:\n${errores.join('\n')}`);
    console.log(`OK pantallas: gaveta, historial, auditoría, ITBIS, notas, clientes, cobro, cierre seguro a ciegas y cierre por la interfaz (capturas en ${outputDir})`);
  } finally { await browser.close(); }
};

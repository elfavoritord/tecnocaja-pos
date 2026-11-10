'use strict';
// Pantallas de Compras en Chrome sin cabeza contra el servidor de laboratorio de
// probar-compras.js (--ui): subir un XML, Preparar compra, registrar, borrador
// manual con acciones masivas, configuración y recepción. Falla ante cualquier
// error de JavaScript o aviso rojo. Deja capturas en <laboratorio>/capturas.
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
const { generateEcfXml } = require('../modules/ecf/services/ecf-generator');

module.exports = async function verificarPantallasCompras({ port, outputDir, base }) {
  if (![3491, 3493].includes(port)) throw new Error('Esta prueba solo admite los puertos de laboratorio de compras.');
  fs.mkdirSync(outputDir, { recursive: true });
  const xmlPath = path.join(outputDir, 'E310000000901.xml');
  fs.writeFileSync(xmlPath, generateEcfXml({
    emitter: { rnc: '101000002', razonSocial: 'Distribuidora Lab SRL', nombreComercial: 'Dist Lab', direccion: 'Calle 1', telefono: '8090000001' },
    customer: { rnc: '131000001', nombre: 'Colmado Lab' },
    document: { eNCF: 'E310000000901', tipoeCF: 'E31', tipoIngresos: '01', tipoPago: '1', fechaVencimientoSecuencia: '2027-12-31' },
    items: [
      { name: 'Arroz Selecto 5 lb', quantity: 4, unitPrice: 250, taxRate: 18 },
      { name: 'Queso Crema Lab 8 oz', quantity: 12, unitPrice: 95, taxRate: 18 },
    ],
    issueDate: new Date(),
  }).xml);

  const browser = await require('puppeteer').launch({ headless: true });
  const errores = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errores.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_FAILED|favicon/i.test(m.text())) errores.push(`console: ${m.text()}`); });
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.setRequestInterception(true);
    page.on('request', (r) => (/^(data:|blob:)/.test(r.url()) || r.url().startsWith(`http://127.0.0.1:${port}/`) ? r.continue() : r.abort()));
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.evaluate(async () => {
      document.getElementById('login-user').value = 'prueba';
      document.getElementById('login-pass').value = 'SoloLaboratorio2026!';
      await doLogin();
    });
    await page.waitForFunction(() => DB.currentUser && window.ComprasPreparar && window.ComprasPrecios, { timeout: 90000 });
    await page.evaluate(() => {
      const original = window.showToast;
      window.__avisosError = []; window.__avisos = [];
      window.showToast = (mensaje, tipo, ...resto) => { window.__avisos.push(String(mensaje)); if (tipo === 'error') window.__avisosError.push(String(mensaje)); return original(mensaje, tipo, ...resto); };
      showModule('compras', document.querySelector('.nav-item[data-module="compras"]'));
    });
    const foto = (nombre) => page.screenshot({ path: path.join(outputDir, `${nombre}.png`) });
    await page.waitForSelector('#btn-compras-subir', { visible: true, timeout: 20000 });
    await foto('compras-botones');

    // Subir el XML: con un solo archivo abre «Preparar compra» directo.
    await page.click('#btn-compras-subir');
    await page.waitForSelector('#cp-archivos', { timeout: 10000 });
    await foto('compras-subir');
    const input = await page.$('#cp-archivos');
    await input.uploadFile(xmlPath);
    await page.waitForSelector('#cp-preparar .cp-tabla tbody tr[data-i]', { timeout: 30000 })
      .catch(async (e) => { throw new Error(`${e.message} · avisos: ${JSON.stringify(await page.evaluate(() => window.__avisos))}`); });
    const preparado = await page.evaluate(() => {
      const filas = [...document.querySelectorAll('#cp-preparar tbody tr[data-i]')];
      return { filas: filas.length, badges: filas.map((f) => f.querySelector('.cp-badge')?.textContent.trim()), titulo: document.querySelector('#cp-preparar h2').textContent };
    });
    assert.equal(preparado.filas, 2);
    assert.match(preparado.badges[0], /Existente/);
    assert.match(preparado.badges[1], /Nuevo/);
    assert.match(preparado.titulo, /Distribuidora Lab SRL[\s\S]*E310000000901/);
    // Precio del producto nuevo: 150 con ITBIS incluido → base 127.12.
    const precio = await page.$('#cp-preparar tbody tr[data-i="1"] [data-l="precio"]');
    await precio.click({ clickCount: 3 });
    await precio.type('150');
    await page.select('#cp-preparar tbody tr[data-i="1"] [data-l="modo"]', 'incluido');
    const info = await page.$eval('#cp-preparar tbody tr[data-i="1"] .cp-precio-info', (n) => n.textContent);
    assert.match(info, /Cliente paga RD\$\s?150\.00/);
    await foto('preparar-compra-xml');
    await page.click('#cp-preparar [data-accion="guardar"]');
    await page.waitForFunction(() => /Lista para registrar/.test(document.getElementById('cp-avisos')?.textContent || ''), { timeout: 20000 })
      .catch(async (e) => { throw new Error(`${e.message} · ${await page.$eval('#cp-avisos', (n) => n.textContent)}`); });
    await page.click('#cp-registrar');
    await page.waitForFunction(() => !document.getElementById('cp-preparar') && window.__avisos.some((m) => /Compra #\d+ registrada/.test(m)), { timeout: 60000 })
      .catch(async (e) => { throw new Error(`${e.message} · avisos: ${JSON.stringify(await page.evaluate(() => window.__avisos))}`); });
    const queso = await page.evaluate(async () => {
      const lista = await api.request('/api/products');
      return (Array.isArray(lista) ? lista : lista.products).find((p) => p.nombre === 'Queso Crema Lab 8 oz');
    });
    assert.equal(Number(queso?.precioVenta), 127.12, JSON.stringify(queso));
    await page.evaluate(() => showComprasTab('compras'));
    await page.waitForFunction(() => /E310000000901/.test(document.getElementById('compras-list')?.textContent || ''), { timeout: 20000 });
    await foto('compras-lista');

    // Proveedores: cada tarjeta con su nombre (antes «Total comprado» salía
    // rotulado «Facturas vencidas» porque se renombraban por posición).
    await page.evaluate(() => { applyAppTranslations(); showModule('proveedores', document.querySelector('.nav-item[data-module="proveedores"]')); });
    await page.waitForFunction(() => /RD\$/.test(document.getElementById('prov-balance-total')?.textContent || '') && document.getElementById('prov-balance-total').offsetParent, { timeout: 20000 });
    const tarjetas = await page.evaluate(() => Object.fromEntries(['prov-con-alertas', 'prov-balance-total', 'prov-pendientes', 'prov-vencidas'].map((id) => {
      const card = document.getElementById(id).closest('.report-card');
      return [id, `${card.querySelector('.report-card-header').textContent.trim()} = ${card.querySelector('.report-card-val').textContent.trim()}`];
    })));
    assert.match(tarjetas['prov-balance-total'], /^Total comprado = RD\$\s?[1-9]/, JSON.stringify(tarjetas));
    assert.match(tarjetas['prov-vencidas'], /^Vencido = RD\$\s?0(\.00)?$/, JSON.stringify(tarjetas));
    assert.match(tarjetas['prov-con-alertas'], /^Con alertas = 0$/, JSON.stringify(tarjetas));
    assert.match(tarjetas['prov-pendientes'], /^Por pagar = /, JSON.stringify(tarjetas));
    await foto('proveedores-tarjetas');
    await page.evaluate(() => showModule('compras', document.querySelector('.nav-item[data-module="compras"]')));
    await page.waitForSelector('#btn-compras-nueva', { visible: true, timeout: 20000 });

    // Borrador manual: producto nuevo, uno existente con el buscador y margen masivo.
    await page.click('#btn-compras-nueva');
    await page.waitForSelector('#cp-preparar [data-accion="agregar-nuevo"]', { timeout: 20000 });
    await page.evaluate(() => {
      const raiz = document.getElementById('cp-preparar');
      const prov = raiz.querySelector('[data-e="proveedor.nombre"]');
      prov.value = 'Distribuidora Lab SRL'; prov.dispatchEvent(new Event('input', { bubbles: true }));
      raiz.querySelector('[data-accion="agregar-nuevo"]').click();
    });
    await page.type('#cp-preparar tbody tr[data-i="0"] [data-l="descripcion"]', 'Jugo Lab Naranja 1 L');
    const costo = await page.$('#cp-preparar tbody tr[data-i="0"] [data-l="costoUnitario"]');
    await costo.click({ clickCount: 3 }); await costo.type('80');
    await page.click('#cp-preparar [data-accion="agregar-existente"]');
    await page.waitForSelector('.cp-buscador input', { timeout: 5000 });
    await page.type('.cp-buscador input', 'Coca Cola 2');
    await page.waitForSelector('.cp-buscador li button', { timeout: 5000 });
    await page.click('.cp-buscador li button');
    await page.waitForFunction(() => document.querySelectorAll('#cp-preparar tbody tr[data-i]').length === 2, { timeout: 5000 });
    // Comprobante: con «no da comprobante» solo aparecen los de compra con secuencia
    // (en el laboratorio, B11) y el RNC busca en el registro de la DGII.
    await page.click('#cp-preparar [data-modo="negocio"]');
    await page.waitForSelector('#cp-preparar [data-e="comprobanteNegocio"]', { timeout: 5000 });
    const opciones = await page.$$eval('#cp-preparar [data-e="comprobanteNegocio"] option', (ops) => ops.map((o) => o.value));
    assert.deepEqual(opciones, ['B11', ''], `solo B11 (con secuencia) y «sin comprobante»: ${opciones}`);
    assert.ok(await page.$('.rnc-dropdown[data-cp]'), 'el campo RNC tiene el buscador de la DGII');
    await foto('preparar-comprobante-negocio');
    await page.click('#cp-preparar [data-modo="proveedor"]');
    await page.type('#cp-preparar [data-e="ncf"]', 'E310000000999');
    assert.match(await page.$eval('#cp-tipo-ncf', (n) => n.textContent), /E31 · Crédito fiscal electrónico/);
    await page.click('#cp-preparar [data-accion="sel-todas"]');
    await page.waitForSelector('#cp-masivo:not(.is-oculto)', { timeout: 5000 });
    await page.type('#cp-margen-masivo', '25');
    await page.click('#cp-preparar [data-masivo="margen"]');
    const masivo = await page.evaluate(() => window.ComprasPreparar._estado().payload.lineas.map((l) => Number(l.precio?.valor || 0)));
    assert.ok(masivo[0] === 100, `margen 25 % sobre 80 = 100: ${masivo}`);
    await foto('preparar-compra-manual-masivo');
    await page.click('#cp-preparar [data-accion="descartar"]');
    await page.waitForFunction(() => !document.getElementById('cp-preparar'), { timeout: 20000 });

    // Configuración y recepción con confirmación.
    await page.click('#btn-compras-config');
    await page.waitForSelector('input[name="cp-modo"]', { timeout: 10000 });
    await foto('compras-configuracion');
    await page.evaluate(() => { document.querySelector('input[name="cp-modo"][value="confirmacion"]').checked = true; document.getElementById('cp-cfg-guardar').click(); });
    await page.waitForFunction(() => document.getElementById('modal-overlay').classList.contains('hidden'), { timeout: 10000 });
    const compra = await page.evaluate(async (arrozId) => api.request('/api/purchases', { method: 'POST', body: JSON.stringify({
      uuid: crypto.randomUUID(), encabezado: { proveedor: { rnc: '101000002' }, ncf: 'B0100000950', fechaComprobante: '2026-11-09' },
      lineas: [{ productoId: arrozId, cantidad: 8, costoUnitario: 250, itbisPct: 18 }], ...getBusinessStructurePayload() }) }), Number(base.arroz.id));
    assert.equal(compra.estadoInventario, 'pendiente_recepcion');
    await page.evaluate(() => showComprasTab('recepciones'));
    await page.waitForSelector('#compras-recepciones-list [data-accion="recibir"]', { timeout: 20000 });
    await foto('compras-recepciones');
    await page.click('#compras-recepciones-list [data-accion="recibir"]');
    await page.waitForSelector('#modal-body [data-item]', { timeout: 10000 });
    await page.evaluate(() => { document.querySelector('#modal-body [data-item]').value = '5'; });
    await foto('compras-recibir-mercancia');
    await page.click('#cp-confirmar-recepcion');
    await page.waitForFunction(() => window.__avisos.some((m) => /Recepción registrada: Recibido en parte/.test(m)), { timeout: 20000 });
    await page.evaluate(async () => api.request('/api/purchases/config', { method: 'PUT', body: JSON.stringify({ modoRecepcion: 'automatica' }) }));

    const avisos = await page.evaluate(() => window.__avisosError);
    assert.deepEqual(avisos, [], 'sin avisos rojos');
    assert.deepEqual(errores, [], 'sin errores de JavaScript');
  } finally {
    await browser.close();
  }
};

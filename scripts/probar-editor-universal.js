'use strict';
const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const path = require('path');
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto('http://127.0.0.1:3405', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.evaluate(async () => {
      document.getElementById('login-user').value = 'demo';
      document.getElementById('login-pass').value = 'DemoMesas2026!';
      await doLogin(); setTheme('light');
    });
    await page.waitForFunction(() => DB.currentUser && !document.getElementById('mesas-abrir').classList.contains('hidden'));
    await page.evaluate(() => Mesas.abrir());
    await page.click('[data-action="editar"]');
    await page.type('.mesas-buscar-elemento', 'estanteria');
    assert.equal(await page.$$eval('.mesas-biblioteca [data-figura]', (nodes) => nodes.filter((n) => !n.hidden).length), 1);
    await page.click('[data-figura="estanteria"]');
    const id = await page.$eval('.mesas-figura.seleccionada', (e) => e.dataset.id);
    async function campo(key, value) {
      await page.$eval(`[data-key="${key}"]`, (e, v) => { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, String(value));
    }
    await campo('codigo', 'Estantería de prueba');
    await campo('x', 700); await campo('y', 400);
    await page.$eval('#mesas-color-elemento', (e) => { e.value = '#598b78'; e.dispatchEvent(new Event('change', { bubbles: true })); });
    const otrosAntes = await page.evaluate((key) => [...document.querySelectorAll('.mesas-figura')].filter((e) => e.dataset.id !== key).map((e) => ({ id: e.dataset.id, estilo: e.getAttribute('style') })), id);
    await page.click('[data-texto="mas"]');
    const otrosDespues = await page.evaluate((key) => [...document.querySelectorAll('.mesas-figura')].filter((e) => e.dataset.id !== key).map((e) => ({ id: e.dataset.id, estilo: e.getAttribute('style') })), id);
    assert.deepEqual(otrosDespues, otrosAntes, 'Cambió otro elemento al aumentar el texto');
    await page.click('[data-tamano="mas"]');
    await page.click('[data-giro="90"]');
    assert.equal(await page.$eval('#mesas-angulo', (e) => Number(e.value)), 90);
    await page.click('[data-giro="-90"]');
    assert.equal(await page.$eval('#mesas-angulo', (e) => Number(e.value)), 0);
    await page.$eval('#mesas-angulo', (e) => { e.value = '-45'; e.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await page.$eval('#mesas-angulo', (e) => Number(e.value)), 315);
    await page.click('.mesas-giro-restablecer');
    await page.click('[data-giro="90"]');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    assert.equal(await page.$eval('#mesas-angulo', (e) => Number(e.value)), 0);
    await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
    assert.equal(await page.$eval('#mesas-angulo', (e) => Number(e.value)), 90);
    await page.click('[data-action="guardar"]');
    await page.waitForFunction((key) => document.querySelector(`[data-id="${key}"]`) !== null && !document.querySelector('[data-action="guardar"]').disabled, {}, id);
    const guardado = await page.evaluate(async (key) => {
      const r = await fetch('/api/mesas/plano', { headers: { Authorization: 'Bearer ' + DB.authToken } });
      return (await r.json()).elementos.find((e) => e.id === key);
    }, id);
    assert.equal(guardado.tipo, 'estanteria'); assert.equal(guardado.color, '#598b78'); assert.equal(guardado.x, 688.75);
    assert.equal(guardado.ancho, 172.5); assert.equal(guardado.alto, 103.5); assert.equal(guardado.textoEscala, 1.4375);
    assert.equal(guardado.rotacion, 90);
    // Retirar solo el elemento de prueba creado aquí; conservar el plano del usuario.
    await page.click('#mesas-eliminar'); await page.click('[data-action="guardar"]');
    await page.waitForFunction(() => !document.querySelector('[data-action="guardar"]').disabled);
    await page.$eval('.mesas-buscar-elemento', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
    // Muestra visual transitoria: no se guarda en el plano del usuario.
    let x = 80;
    for (const tipo of ['mesa4', 'mesaRedonda', 'estanteria', 'mostrador', 'puesto', 'planta']) {
      await page.click(`[data-figura="${tipo}"]`);
      await campo('x', x); await campo('y', 540); x += 190;
    }
    await page.click('[data-zoom="ajustar"]');
    await page.screenshot({ path: path.resolve('runtime-data/demo-pos/editor-universal-claro.png') });
    await page.evaluate(() => setTheme('dark'));
    await page.screenshot({ path: path.resolve('runtime-data/demo-pos/editor-universal-oscuro.png') });
    // A 50% de zoom, arrastrar 40 px equivale a 80 unidades del plano.
    await page.evaluate(() => { for (let i = 0; i < 10; i++) document.querySelector('[data-zoom="menos"]').click(); });
    const zoom = await page.$eval('#mesas-zoom-valor', (e) => parseInt(e.textContent) / 100);
    const seleccion = await page.$('.mesas-figura.seleccionada'); const box = await seleccion.boundingBox();
    const antes = await page.$eval('[data-key="x"]', (e) => Number(e.value));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
    const despues = await page.$eval('[data-key="x"]', (e) => Number(e.value));
    assert.ok(Math.abs(despues - antes - 20 / zoom) <= 2, 'Arrastre con zoom incorrecto');
    assert.deepEqual(errors, []);
    console.log('OK: búsqueda, nuevo mobiliario, guardado/lectura de color y tipo, eliminación del elemento de prueba y arrastre con zoom.');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });

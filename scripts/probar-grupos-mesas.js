'use strict';
const p = require('puppeteer');
const assert = require('node:assert/strict');
(async () => {
  const browser = await p.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept());
    const errores = []; page.on('pageerror', (e) => errores.push(e.message));
    await page.setViewport({ width: 1440, height: 950 });
    async function entrar() {
      await page.goto('http://127.0.0.1:3405', { waitUntil: 'networkidle2', timeout: 60000 });
      await page.evaluate(async () => { if (!DB.currentUser) { document.getElementById('login-user').value = 'demo'; document.getElementById('login-pass').value = 'DemoMesas2026!'; await doLogin(); } });
      await page.waitForFunction(() => DB.currentUser && !document.getElementById('mesas-abrir').classList.contains('hidden'));
      await page.evaluate(() => Mesas.abrir()); await page.waitForSelector('[data-action="editar"]');
      await page.click('[data-action="editar"]');
    }
    async function campo(key, value) { await page.$eval(`[data-key="${key}"]`, (e, v) => { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, String(value)); }
    const cantidad = () => page.$$eval('.mesas-figura.seleccionada', (nodes) => nodes.length);
    const geometria = (id) => page.$eval(`[data-id="${id}"]`, (e) => ({ x: parseFloat(e.style.left), y: parseFloat(e.style.top), ancho: parseFloat(e.style.width), alto: parseFloat(e.style.height) }));
    const plano = () => page.evaluate(async () => (await (await fetch('/api/mesas/plano', { headers: { Authorization: 'Bearer ' + DB.authToken } })).json()).elementos);
    async function tecla(key, shift = false) { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.down('Control'); if (shift) await page.keyboard.down('Shift'); await page.keyboard.press(key); if (shift) await page.keyboard.up('Shift'); await page.keyboard.up('Control'); }
    async function guardar() { await page.click('[data-action="guardar"]'); await page.waitForFunction(() => !document.querySelector('[data-action="guardar"]').disabled); }
    await entrar(); const inicial = await plano();
    const ids = [];
    for (let i = 0; i < 2; i++) {
      await page.click('[data-figura="silla"]'); ids.push(await page.$eval('.mesas-figura.seleccionada', (e) => e.dataset.id));
      if (i === 0) {
        await tecla('z'); assert.equal(await page.$$eval('.mesas-figura', (nodes) => nodes.length), inicial.length);
        await tecla('y'); assert.equal(await page.$eval('.mesas-figura.seleccionada', (e) => e.dataset.id), ids[0]);
      }
      await campo('codigo', `Grupo UI ${Date.now()} ${i}`); await campo('x', 700 + i * 150); await campo('y', 650);
    }
    await page.click('[data-zoom="ajustar"]');
    const marco = await page.$eval('.mesas-lienzo', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, escala: r.width / 1600 }; });
    await page.mouse.move(marco.x + 670 * marco.escala, marco.y + 620 * marco.escala); await page.mouse.down();
    await page.mouse.move(marco.x + 960 * marco.escala, marco.y + 760 * marco.escala, { steps: 5 }); await page.mouse.up();
    const marcados = await page.$$eval('.mesas-figura.seleccionada', (nodes) => nodes.map((n) => n.dataset.id));
    assert.ok(ids.every((id) => marcados.includes(id)), 'El recuadro no seleccionó ambos elementos');
    await tecla('a'); assert.equal(await cantidad(), inicial.length + 2);
    await page.keyboard.press('Escape'); assert.equal(await cantidad(), 0);
    await page.keyboard.down('Control'); for (const id of ids) await page.click(`[data-id="${id}"]`); await page.keyboard.up('Control');
    assert.equal(await cantidad(), 2); await tecla('g');
    await tecla('z'); assert.equal(await page.$eval('[data-editor="desagrupar"]', (e) => e.disabled), true);
    await tecla('y'); assert.equal(await page.$eval('[data-editor="desagrupar"]', (e) => e.disabled), false);
    const antes = await Promise.all(ids.map(geometria));
    const box = await (await page.$(`[data-id="${ids[0]}"]`)).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2 + 15, { steps: 5 }); await page.mouse.up();
    const despues = await Promise.all(ids.map(geometria));
    assert.ok(despues[0].x > antes[0].x);
    assert.ok(Math.abs((despues[0].x - antes[0].x) - (despues[1].x - antes[1].x)) < .02);
    await tecla('z'); assert.deepEqual(await Promise.all(ids.map(geometria)), antes, 'Un arrastre debe deshacerse completo');
    await tecla('z', true); assert.deepEqual(await Promise.all(ids.map(geometria)), despues);
    await guardar(); const guardado = (await plano()).filter((e) => ids.includes(e.id));
    assert.ok(guardado[0].grupoId); assert.equal(guardado[0].grupoId, guardado[1].grupoId);
    await tecla('z'); assert.deepEqual(await Promise.all(ids.map(geometria)), antes);
    await tecla('y'); assert.deepEqual(await Promise.all(ids.map(geometria)), despues); await guardar();
    await entrar(); await page.click('[data-zoom="ajustar"]'); await page.click(`[data-id="${ids[0]}"]`); assert.equal(await cantidad(), 2);
    await tecla('g', true); await guardar(); assert.ok((await plano()).filter((e) => ids.includes(e.id)).every((e) => !e.grupoId));
    const tamanosAntes = await Promise.all(ids.map(geometria));
    await page.click('[data-multiple="ampliar"]'); const tamanosDespues = await Promise.all(ids.map(geometria));
    assert.equal(tamanosDespues[0].ancho, tamanosAntes[0].ancho * 1.15); assert.equal(tamanosDespues[1].alto, tamanosAntes[1].alto * 1.15);
    await tecla('d'); assert.equal(await cantidad(), 2);
    const idsCopias = await page.$$eval('.mesas-figura.seleccionada', (nodes) => nodes.map((e) => e.dataset.id));
    await page.keyboard.press('Delete');
    await tecla('z'); assert.deepEqual(await page.$$eval('.mesas-figura.seleccionada', (nodes) => nodes.map((e) => e.dataset.id)), idsCopias);
    await tecla('y');
    // Retira únicamente los dos elementos nuevos de esta prueba.
    await page.keyboard.down('Control'); for (const id of ids) await page.click(`[data-id="${id}"]`); await page.keyboard.up('Control');
    assert.equal(await cantidad(), 2); await page.keyboard.press('Delete'); await guardar();
    const final = await plano(); assert.equal(final.length, inicial.length);
    assert.ok(final.every((e) => inicial.some((a) => a.id === e.id && a.x === e.x && a.y === e.y)));
    assert.deepEqual(errores, []);
    console.log('OK: grupos y selección; deshacer/rehacer creación, agrupación, arrastre completo y eliminación; historial conservado después de guardar.');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });

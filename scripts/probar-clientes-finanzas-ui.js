'use strict';
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
module.exports = async function verifyUi({ port, clientId, outputDir }) {
  if (![3467, 3469].includes(port)) throw new Error('Esta prueba solo admite los puertos de laboratorio de finanzas.');
  const browser = await require('puppeteer').launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', r => /^(data:|blob:)/.test(r.url()) || r.url().startsWith(`http://127.0.0.1:${port}/`) ? r.continue() : r.abort());
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.evaluate(async () => {
      document.getElementById('login-user').value = 'prueba';
      document.getElementById('login-pass').value = 'SoloLaboratorio2026!';
      await doLogin();
    });
    await page.waitForFunction(() => DB.currentUser, { timeout: 60000 });
    await page.evaluate(id => openClientStatement(id), clientId);
    await page.waitForFunction(() => document.getElementById('statement-from') && clientStatementReport?.rows?.length === 2);
    assert.equal(await page.evaluate(() => clientStatementReport.closingBalance),25);
    fs.mkdirSync(outputDir, { recursive: true });
    await page.screenshot({ path: path.join(outputDir,'estado-cuenta.png'), fullPage: true });
    const pdf = await page.evaluate(async () => Array.from(new Uint8Array((await buildClientStatementPdf(clientStatementReport)).output('arraybuffer'))));
    assert.equal(Buffer.from(pdf).subarray(0,4).toString(),'%PDF');
    fs.writeFileSync(path.join(outputDir,'estado-cuenta.pdf'), Buffer.from(pdf));
    await page.evaluate(() => openClientReceivablesReport());
    await page.waitForFunction(() => document.getElementById('receivables-report-table')?.textContent.includes('Cliente crédito'));
    await page.screenshot({ path: path.join(outputDir,'cuentas-por-cobrar.png'), fullPage: true });
    await page.evaluate(async () => {
      await VendorLoader.load('xlsx');
      const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(statementGrid(clientStatementReport)),'Estado');
      if (!XLSX.write(book,{type:'array',bookType:'xlsx'}).byteLength) throw new Error('Excel vacío');
      DB.payMethod = 'mixto';
      const markup = CobroUI.buildMarkup();
      if (!markup.includes('id="mixto-credito"')) throw new Error('Falta crédito en el pago mixto');
    });
    console.log('OK interfaz de estado de cuenta, PDF A4, Excel y cuarto componente de cobro');
  } finally { await browser.close(); }
};

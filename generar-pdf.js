const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  const htmlPath = path.resolve(__dirname, 'manual-tecnocaja.html');
  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'networkidle0', timeout: 30000 });

  // Give fonts time to load
  await new Promise(r => setTimeout(r, 2000));

  await page.pdf({
    path: path.resolve(__dirname, 'Manual-Tecno Caja.pdf'),
    format: 'A4',
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });

  await browser.close();
  console.log('PDF generado: Manual-Tecno Caja.pdf');
})();

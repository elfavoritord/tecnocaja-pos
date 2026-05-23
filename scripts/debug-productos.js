const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.on('console', (msg) => {
    console.log(`[console:${msg.type()}] ${msg.text()}`);
  });

  page.on('pageerror', (error) => {
    console.log(`[pageerror] ${error.message}`);
  });

  await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle' });
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', '1234');
  await page.click('.btn-login');
  await page.waitForTimeout(1500);
  await page.click('[data-module="productos"]');
  await page.waitForTimeout(1200);

  const info = await page.evaluate(() => {
    return {
      hasTbody: Boolean(document.getElementById('products-tbody')),
      rows: document.querySelectorAll('#products-tbody tr').length,
      tbodyHtml: document.getElementById('products-tbody')?.innerHTML?.slice(0, 400) || '',
      stats: {
        total: document.getElementById('products-total-count')?.textContent || null,
        low: document.getElementById('products-low-count')?.textContent || null,
        out: document.getElementById('products-out-count')?.textContent || null
      },
      breadcrumb: document.getElementById('breadcrumb')?.textContent || null,
      appVisible: !document.getElementById('app')?.classList.contains('hidden'),
      dbCount: window.DB?.productos?.length || null
    };
  });

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

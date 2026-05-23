const path = require('path');
const { _electron: electron } = require('playwright');

async function main() {
  const app = await electron.launch({
    args: [path.join(__dirname, '..')]
  });

  const window = await app.firstWindow();
  window.on('console', (msg) => {
    console.log(`[console:${msg.type()}] ${msg.text()}`);
  });
  window.on('pageerror', (error) => {
    console.log(`[pageerror] ${error.message}`);
  });

  await window.waitForTimeout(2500);
  await window.fill('#login-user', 'admin');
  await window.fill('#login-pass', '1234');
  await window.click('.btn-login');
  await window.waitForTimeout(2000);
  await window.click('[data-module="productos"]');
  await window.waitForTimeout(1500);

  const info = await window.evaluate(() => ({
    location: window.location.href,
    hasBanner: !!document.getElementById('products-debug-banner'),
    bannerText: document.getElementById('products-debug-banner')?.textContent || null,
    rows: document.querySelectorAll('#products-tbody tr').length,
    tbodyText: document.getElementById('products-tbody')?.innerText?.slice(0, 300) || '',
    stats: {
      total: document.getElementById('products-total-count')?.textContent || null,
      low: document.getElementById('products-low-count')?.textContent || null,
      out: document.getElementById('products-out-count')?.textContent || null
    },
    breadcrumb: document.getElementById('breadcrumb')?.textContent || null
  }));

  console.log(JSON.stringify(info, null, 2));
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

'use strict';

const fs = require('fs');

const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

// El Chrome que trae puppeteer solo existe en la PC de desarrollo: el instalador no lo
// incluye. En la PC del cliente puppeteer.launch() fallaba y la descarga del Paso 5
// guardaba el mensaje de error con nombre .zip/.pdf, un archivo que no abría. Se usa
// el de puppeteer si está y si no Chrome o Edge (Edge viene con Windows 10/11).
function resolvePdfBrowserPath() {
  try {
    const bundled = require('puppeteer').executablePath();
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch (_) { /* puppeteer sin navegador descargado */ }

  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    localAppData ? `${localAppData}\\Google\\Chrome\\Application\\chrome.exe` : '',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    localAppData ? `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe` : '',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function launchPdfBrowser() {
  const executablePath = resolvePdfBrowserPath();
  if (!executablePath) {
    throw new Error('No se encontró Google Chrome ni Microsoft Edge en esta PC para crear los PDF. Instala uno de los dos y vuelve a intentarlo.');
  }
  const puppeteer = require('puppeteer');
  return puppeteer.launch({ headless: true, executablePath, args: LAUNCH_ARGS });
}

module.exports = {
  resolvePdfBrowserPath,
  launchPdfBrowser,
};

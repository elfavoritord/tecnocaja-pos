'use strict';
// Copia de demostración aislada usando el mismo arranque local de las pruebas.
const path = require('path');
const fs = require('fs');
process.env.TC_E2E_DIR = path.resolve(__dirname, '../runtime-data/demo-pos');
const L = require('./e2e-lan/lib');
const port = 3405;
async function main() {
  try {
    const running = await L.request(port, 'GET', '/api/health', null, '', 2500);
    if (running.status === 200 && running.body?.businessName === 'Demo POS Mesas') {
      console.log('La demo ya está abierta: http://127.0.0.1:3405');
      return;
    }
    throw new Error('El puerto 3405 está ocupado por otra aplicación.');
  } catch (e) {
    if (e.message.includes('ocupado')) throw e;
  }
  if (!fs.existsSync(path.join(L.APP, 'server.js'))) L.prepareSandbox();
  // Fixture de licencia exclusivamente en la copia aislada de desarrollo.
  const fixture = L.seedLicense({ port, userData: path.join(L.WORK, 'datos'), env: { DB_CLIENT: 'sqlite' } });
  if (!fixture.ok) throw new Error(`No se pudo preparar la licencia de pruebas: ${fixture.detail}`);
  const server = L.startServer('demo-pos', {
    port, userData: path.join(L.WORK, 'datos'), env: { DB_CLIENT: 'sqlite' },
  });
  server.on('exit', (code) => { console.log('Servidor demo detenido:', code); process.exitCode = code || 0; });
  await L.waitHttp(port, '/api/setup/status', 180000);
  const status = await L.request(port, 'GET', '/api/setup/status');
  if (status.body?.setupRequired) {
    const setup = await L.request(port, 'POST', '/api/setup/complete', {
      language: 'es', businessType: 'pizzeria', businessStructureMode: 'monocaja',
      businessName: 'Demo POS Mesas', adminName: 'Administrador Demo', adminUser: 'demo',
      adminEmail: 'demo@mesas.example.test', adminPassword: 'DemoMesas2026!',
      openingAmount: 1000, currency: 'RD$',
    });
    if (setup.status !== 201) throw new Error(`Configuración: ${setup.status} ${setup.body?.error || ''}`);
  }
  const login = await L.request(port, 'POST', '/api/login', { usuario: 'demo', password: 'DemoMesas2026!' });
  if (!login.body?.token) throw new Error(`Login: ${login.status} ${login.body?.error || ''}`);
  const enabled = await L.request(port, 'PUT', '/api/mesas/config', { activo: true }, login.body.token);
  if (enabled.status !== 200) throw new Error(`Activación MESAS: ${enabled.status} ${enabled.body?.error || ''}`);
  console.log('DEMO LISTA: http://127.0.0.1:3405 — usuario demo');
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });

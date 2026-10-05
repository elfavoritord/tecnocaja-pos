// Simula la primera validación de licencia con Internet de UNA PC (la prueba
// no tiene Firebase): usa el servicio real de licencias del sandbox, con su
// cifrado por equipo, y solo reemplaza la consulta remota.
const path = require('path');
const APP = process.env.E2E_APP;
const db = require(path.join(APP, 'db.js')); // carga config/app.env de este userData
const { createLicenseService } = require(path.join(APP, 'server', 'licensing', 'license-service.js'));

(async () => {
  const now = new Date();
  const service = createLicenseService({
    query: db.query,
    fetchRemoteLicense: async () => ({
      id: 'lic_e2e_colmado',
      businessName: 'Colmado E2E',
      status: 'active',
      planCode: 'pro',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 365 * 86400000),
      deviceLimit: 5,
      offlineGraceDays: 3,
      devices: {},
    }),
    updateRemoteDevice: async () => ({ allowed: true, activeCount: 2, limit: 5 }),
  });
  const result = await service.resolveState({ force: true, allowRemote: true });
  console.log(JSON.stringify({ source: result.source, canEnter: result.license?.canEnter, rowId: service.getCacheRowId() }));
  process.exit(result.license?.canEnter ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });

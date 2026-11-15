'use strict';

// Licencia local de la copia de certificación (no es un cliente: es la PC de
// Emilio haciendo la certificación DGII de una empresa). Igual que
// scripts/e2e-lan/seed-license.js: usa el servicio real de licencias y solo
// reemplaza la consulta a Firebase. Se repite en cada arranque, así nunca se
// queda sin los días de gracia sin Internet.
const path = require('path');

const APP = process.env.E2E_APP;
const db = require(path.join(APP, 'db.js'));
const { createLicenseService } = require(path.join(APP, 'server', 'licensing', 'license-service.js'));

(async () => {
  const now = new Date();
  const service = createLicenseService({
    query: db.query,
    fetchRemoteLicense: async () => ({
      id: `cert_${process.env.CERT_RNC || 'empresa'}`,
      businessName: process.env.CERT_NOMBRE || 'Certificación e-CF',
      status: 'active',
      planCode: 'pro',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 365 * 86400000),
      deviceLimit: 5,
      offlineGraceDays: 30,
      devices: {},
    }),
    updateRemoteDevice: async () => ({ allowed: true, activeCount: 1, limit: 5 }),
  });
  const result = await service.resolveState({ force: true, allowRemote: true });
  if (typeof db.flushPendingSave === 'function') await db.flushPendingSave();
  console.log(JSON.stringify({ canEnter: result.license?.canEnter }));
  process.exit(result.license?.canEnter ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });

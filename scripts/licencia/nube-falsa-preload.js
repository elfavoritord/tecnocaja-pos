// Se carga con NODE_OPTIONS=--require en el servidor de prueba de licencias
// (scripts/licencia/probar-licencia-pagada.js). La "nube" de la PC (la Sync API
// por la que una PC sin llave de Firebase lee su licencia) es falsa: la licencia
// sale del archivo JSON de TC_LICENCIA_FALSA, que la prueba cambia mientras el
// servidor corre. Nada sale a Internet.
const fs = require('fs');
const path = require('path');

const APP = process.env.E2E_APP;
const ARCHIVO = process.env.TC_LICENCIA_FALSA;
const runtime = require(path.join(APP, 'server', 'services', 'pos-cloud-runtime.js'));
const identidad = require(path.join(APP, 'server', 'security', 'machine-identity.js'));

function escenario() {
  try { return JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch (_) { return {}; }
}

// Lo mismo que devuelve /v1/pos/license de la Sync API: { id, docData, businessName }.
function licencia() {
  const e = escenario();
  const deviceId = identidad.getDeviceId();
  const devices = e.equipoAutorizado === false
    ? { npd_otra_pc: { deviceId: 'npd_otra_pc', hostname: 'OTRA-PC', status: 'active' } }
    : { [deviceId]: { deviceId, hostname: 'CAJA-PRUEBA', status: 'active' } };
  return {
    id: 'pos_e2e_licencia',
    businessName: 'Colmado Licencia',
    docData: {
      status: e.status || 'trial',
      planCode: 'basico',
      ...(e.modalidad ? { modalidad: e.modalidad } : {}),
      issuedAt: e.issuedAt || null,
      expiresAt: e.expiresAt || null,
      trialStartedAt: e.trialStartedAt || null,
      trialEndsAt: e.trialEndsAt || null,
      deviceLimit: 1,
      offlineGraceDays: 3,
      devices,
    },
  };
}

const nube = {
  selectBusiness() {},
  connected: () => true,
  async register() { return { license: licencia() }; },
  async request(action) {
    if (action !== 'license') throw new Error(`La nube de prueba no atiende "${action}".`);
    if (escenario().sinRed) throw Object.assign(new Error('Sin Internet (prueba)'), { code: 'ENOTFOUND' });
    return { license: licencia() };
  },
};

runtime.getConnection = () => nube;

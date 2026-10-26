'use strict';

/**
 * Reactivar producción DGII para un RNC que la DGII ya autorizó (después de
 * reinstalar o reiniciar la configuración local): no exige CerteCF ni el
 * Paso 15 del wizard (que se pierde con el reinicio), pero sí la autenticación
 * real en producción; si falla, se vuelve al ambiente de antes.
 */

const { createEcfService } = require('../modules/ecf/services/ecf.service');

function buildService({ environment = 'testecf', step15 = false, authOk = true } = {}) {
  const emitter = {
    environment, rnc: '40211932609', razon_social: 'Emilio Digital Solutions',
    public_base_url: 'https://pos.example.com', production_status: 'not_configured',
  };
  const service = createEcfService({
    query: async () => [],
    withTransaction: async (work) => work({ query: async () => [] }),
    resolveRequestActorUser: async () => ({ id: 1, nombre: 'Admin', role_code: 'administrador_general' }),
  });
  const upserts = [];
  const audits = [];
  service.ensureReady = async () => {};
  service.repository.getResolvedEmitter = async () => ({ ...emitter });
  service.repository.getLatestCertificationBatchId = async () => null;
  service.repository.upsertEmitter = async (_id, data) => { upserts.push(data); Object.assign(emitter, data); return emitter; };
  service.repository.saveAudit = async (a) => { audits.push(a); };
  service.getCertificateStatus = async () => ({ hasCertificate: true, status: 'valido', isExpired: false, validTo: '2027-05-19' });
  service._readCertWizardState = () => ({ completedSteps: step15 ? [15] : [] });
  service.authService.authenticate = async () => {
    if (!authOk) throw new Error('No se pudo conectar con la DGII');
    return { token: 'tkn', environment: 'ecf', expira: '2026-10-21T20:00:00Z' };
  };
  return { service, emitter, upserts, audits };
}

const confirmar = (extra = {}) => ({ body: { confirmed: true, confirmationText: 'ACTIVAR PRODUCCION', ...extra } });

describe('reactivación de producción DGII', () => {
  test('sin "ya autorizado", desde TesteCF y sin Paso 15 no está lista', async () => {
    const { service } = buildService();
    const st = await service.getProductionActivationStatus();
    expect(st.ready).toBe(false);
    const fallan = st.checklist.items.filter((i) => i.status !== 'ok').map((i) => i.key);
    expect(fallan).toEqual(['environment_certecf', 'wizard_step15']);
  });

  test('con "ya autorizado" no pide CerteCF ni el Paso 15, pero sí lo demás', async () => {
    const { service } = buildService();
    const st = await service.getProductionActivationStatus({ yaAutorizado: true });
    expect(st.ready).toBe(true);
    expect(st.reactivacion).toBe(true);
    const sinUrl = buildService();
    sinUrl.service.repository.getResolvedEmitter = async () => ({ environment: 'testecf', rnc: '40211932609', razon_social: 'X', public_base_url: '', production_status: 'not_configured' });
    const st2 = await sinUrl.service.getProductionActivationStatus({ yaAutorizado: true });
    expect(st2.ready).toBe(false);
    expect(st2.checklist.items.find((i) => i.status !== 'ok').key).toBe('production_url');
  });

  test('reactivar con autenticación DGII correcta deja producción activa', async () => {
    const { service, emitter, audits } = buildService();
    const res = await service.activateProduction(confirmar({ yaAutorizado: true }));
    expect(res.ok).toBe(true);
    expect(emitter.environment).toBe('ecf');
    expect(emitter.production_status).toBe('active');
    expect(audits.map((a) => a.actionName)).toEqual(['production_reactivation_requested', 'production_activated']);
  });

  test('si la autenticación falla al reactivar, vuelve al ambiente de antes y no bloquea nada', async () => {
    const { service, emitter } = buildService({ authOk: false });
    const res = await service.activateProduction(confirmar({ yaAutorizado: true }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/sigues en testecf/);
    expect(emitter.environment).toBe('testecf');
    expect(emitter.production_status).toBe('not_configured');
  });

  test('sin "ya autorizado" la activación sigue exigiendo CerteCF y el Paso 15', async () => {
    const { service } = buildService();
    await expect(service.activateProduction(confirmar())).rejects.toThrow(/CerteCF/);
  });
});

'use strict';

// Activación segura de producción DGII (ambiente 'ecf') — ver plan en
// C:\Users\Emilio Coding IA\.claude\plans\sparkling-cuddling-hanrahan.md
//
// Cobertura: guardas de permiso/confirmación/checklist en activateProduction(),
// el guard de envío en sendPreparedDocument(), y revertProductionToCertification().
// No pega contra DGII real — authService.authenticate se mockea.

const { createEcfService } = require('../modules/ecf/services/ecf.service');

function makeFakeDb(initialEmitter) {
  let emitterRow = initialEmitter ? { id: 1, business_id: 1, ...initialEmitter } : null;
  const auditLog = [];

  const query = jest.fn(async (sql, params = []) => {
    if (/SELECT \* FROM ecf_emitters/i.test(sql)) {
      return emitterRow ? [{ ...emitterRow }] : [];
    }
    if (/UPDATE ecf_emitters/i.test(sql)) {
      const [
        rnc, razon_social, nombre_comercial, direccion, provincia, municipio, telefono, correo,
        environment, certificate_type, certificate_expires_at, validation_status, public_base_url, allowed_origins,
        require_internal_token, internal_token_hash, notes, is_active,
        production_status, production_activated_at, production_activated_by,
      ] = params;
      Object.assign(emitterRow, {
        rnc, razon_social, nombre_comercial, direccion, provincia, municipio, telefono, correo,
        environment, certificate_type, certificate_expires_at, validation_status, public_base_url, allowed_origins,
        require_internal_token, internal_token_hash, notes, is_active,
        production_status, production_activated_at, production_activated_by,
      });
      return { affectedRows: 1 };
    }
    if (/INSERT INTO ecf_emitters/i.test(sql)) {
      const [
        business_id, rnc, razon_social, nombre_comercial, direccion, provincia, municipio, telefono, correo,
        environment, certificate_type, certificate_expires_at, validation_status, public_base_url, allowed_origins,
        require_internal_token, internal_token_hash, notes, is_active,
        production_status, production_activated_at, production_activated_by,
      ] = params;
      emitterRow = {
        id: 1, business_id, rnc, razon_social, nombre_comercial, direccion, provincia, municipio, telefono, correo,
        environment, certificate_type, certificate_expires_at, validation_status, public_base_url, allowed_origins,
        require_internal_token, internal_token_hash, notes, is_active,
        production_status, production_activated_at, production_activated_by,
      };
      return { insertId: 1 };
    }
    if (/INSERT INTO ecf_audit_log/i.test(sql)) {
      auditLog.push(params);
      return { insertId: auditLog.length };
    }
    if (/SELECT \* FROM config/i.test(sql)) return [];
    if (/SELECT \* FROM ecf_certificates/i.test(sql)) return [];
    if (/SELECT .*FROM ecf_sequences/i.test(sql)) return [];
    if (/SELECT certification_batch_id\s+FROM ecf_documents/i.test(sql)) return [];
    if (/SELECT COUNT\(\*\) AS total FROM ecf_documents/i.test(sql)) return [{ total: 0 }];
    return [];
  });

  return { query, auditLog, getEmitterRow: () => emitterRow };
}

const READY_EMITTER = {
  rnc: '40211932609',
  razon_social: 'EMILIO MANAURYS CABRERA',
  environment: 'certecf',
  public_base_url: 'https://ecf.tecnocajapos.com',
  is_active: 1,
  production_status: 'not_configured',
};

function buildService({ emitter = READY_EMITTER, step15Done = true, adminActor = true } = {}) {
  const db = makeFakeDb(emitter);
  const service = createEcfService({
    query: db.query,
    withTransaction: jest.fn(),
    resolveRequestActorUser: async () => (
      adminActor
        ? { id: 1, usuario: 'admin', nombre: 'Emilio', rol: 'administrador', role_code: 'ADMIN' }
        : { id: 2, usuario: 'cajero1', nombre: 'Cajero', rol: 'cajero', role_code: 'CAJERO' }
    ),
  });
  service.ensureReady = async () => {};
  service._readCertWizardState = () => (step15Done ? { completedSteps: [15] } : { completedSteps: [1, 2] });
  service.getCertificateStatus = async () => ({ hasCertificate: true, status: 'valido', isExpired: false, validTo: '2030-01-01' });
  service.authService.authenticate = jest.fn(async () => ({ token: 'PROD-TOKEN', environment: 'ecf', expira: '2030-01-01T00:00:00.000Z' }));
  return { service, db };
}

const VALID_BODY = { confirmed: true, confirmationText: 'ACTIVAR PRODUCCION' };
const reqWith = (body) => ({ body, params: {}, query: {}, headers: {} });

describe('activateProduction()', () => {
  test('rechaza a un usuario no administrador', async () => {
    const { service } = buildService({ adminActor: false });
    await expect(service.activateProduction(reqWith(VALID_BODY))).rejects.toThrow(/administradores/i);
  });

  test('rechaza sin checkbox confirmado', async () => {
    const { service } = buildService();
    await expect(service.activateProduction(reqWith({ ...VALID_BODY, confirmed: false })))
      .rejects.toThrow(/confirmar el checkbox/i);
  });

  test('rechaza si el texto de confirmación no coincide exactamente', async () => {
    const { service } = buildService();
    await expect(service.activateProduction(reqWith({ ...VALID_BODY, confirmationText: 'activar produccion' })))
      .rejects.toThrow(/texto de confirmación/i);
    await expect(service.activateProduction(reqWith({ ...VALID_BODY, confirmationText: 'ACTIVAR PRODUCCION ' })))
      .rejects.toThrow(/texto de confirmación/i);
  });

  test('rechaza si el Paso 15 del wizard no está completado', async () => {
    const { service } = buildService({ step15Done: false });
    await expect(service.activateProduction(reqWith(VALID_BODY))).rejects.toThrow(/no se puede activar producción/i);
  });

  test('rechaza si el ambiente actual no es certecf', async () => {
    const { service } = buildService({ emitter: { ...READY_EMITTER, environment: 'testecf' } });
    await expect(service.activateProduction(reqWith(VALID_BODY))).rejects.toThrow(/no se puede activar producción/i);
  });

  test('con todo válido y autenticación DGII exitosa, activa producción y limpia el token previo', async () => {
    const { service, db } = buildService();
    const clearTokenSpy = jest.spyOn(service.authService, 'clearToken');

    const result = await service.activateProduction(reqWith(VALID_BODY));

    expect(result.ok).toBe(true);
    expect(db.getEmitterRow().environment).toBe('ecf');
    expect(db.getEmitterRow().production_status).toBe('active');
    expect(service.authService.authenticate).toHaveBeenCalledWith({ forceRefresh: true });
    // applyRuntimeConfig('ecf') limpia el token antes de solicitar uno nuevo de producción.
    expect(clearTokenSpy).toHaveBeenCalled();
    expect(db.auditLog.some((row) => row.includes('production_activated'))).toBe(true);
  });

  test('si la autenticación DGII falla, el ambiente queda en ecf pero producción NO queda activa', async () => {
    const { service, db } = buildService();
    service.authService.authenticate = jest.fn(async () => { throw new Error('DGII no respondió'); });

    const result = await service.activateProduction(reqWith(VALID_BODY));

    expect(result.ok).toBe(false);
    expect(db.getEmitterRow().environment).toBe('ecf');
    expect(db.getEmitterRow().production_status).toBe('authentication_failed');
    expect(db.auditLog.some((row) => row.includes('production_activation_auth_failed'))).toBe(true);
  });
});

describe('sendPreparedDocument() — guard de producción', () => {
  test('bloquea el envío si environment="ecf" y producción no está activa', async () => {
    const { service } = buildService({ emitter: { ...READY_EMITTER, environment: 'ecf', production_status: 'authentication_failed' } });
    service.fcService.sendConsumptionSummary = jest.fn();
    service.receptionService.sendSignedEcf = jest.fn();

    await expect(service.sendPreparedDocument({
      id: 1, environment: 'ecf', submission_mode: 'normal', signed_xml_content: '<ECF/>', encf: 'E320000000001',
    })).rejects.toThrow(/producción dgii no está activa/i);

    expect(service.fcService.sendConsumptionSummary).not.toHaveBeenCalled();
    expect(service.receptionService.sendSignedEcf).not.toHaveBeenCalled();
  });

  test('bloquea también el envío RFCE en producción inactiva', async () => {
    const { service } = buildService({ emitter: { ...READY_EMITTER, environment: 'ecf', production_status: 'not_configured' } });
    service.fcService.sendConsumptionSummary = jest.fn();

    await expect(service.sendPreparedDocument({
      id: 2, environment: 'ecf', submission_mode: 'rfce', signed_xml_content: '<RFCE/>', encf: 'E320000000002',
    })).rejects.toThrow(/producción dgii no está activa/i);

    expect(service.fcService.sendConsumptionSummary).not.toHaveBeenCalled();
  });

  test('permite el envío en producción cuando production_status="active"', async () => {
    const { service } = buildService({ emitter: { ...READY_EMITTER, environment: 'ecf', production_status: 'active' } });
    service.receptionService.sendSignedEcf = jest.fn(async () => ({ ok: true }));

    await expect(service.sendPreparedDocument({
      id: 3, environment: 'ecf', submission_mode: 'normal', signed_xml_content: '<ECF/>', encf: 'E320000000003',
    })).resolves.toEqual({ ok: true });

    expect(service.receptionService.sendSignedEcf).toHaveBeenCalledTimes(1);
  });

  test('no bloquea envíos en certecf/testecf (el guard solo aplica a ecf)', async () => {
    const { service } = buildService({ emitter: { ...READY_EMITTER, environment: 'certecf', production_status: 'not_configured' } });
    service.receptionService.sendSignedEcf = jest.fn(async () => ({ ok: true }));

    await expect(service.sendPreparedDocument({
      id: 4, environment: 'certecf', submission_mode: 'normal', signed_xml_content: '<ECF/>', encf: 'E310000000001',
    })).resolves.toEqual({ ok: true });
  });
});

describe('revertProductionToCertification()', () => {
  test('rechaza sin motivo', async () => {
    const { service } = buildService({ emitter: { ...READY_EMITTER, environment: 'ecf', production_status: 'active' } });
    await expect(service.revertProductionToCertification(reqWith({ confirmationText: 'VOLVER A CERTIFICACION' })))
      .rejects.toThrow(/motivo/i);
  });

  test('rechaza si el texto de confirmación no coincide', async () => {
    const { service } = buildService({ emitter: { ...READY_EMITTER, environment: 'ecf', production_status: 'active' } });
    await expect(service.revertProductionToCertification(reqWith({ reason: 'prueba', confirmationText: 'volver' })))
      .rejects.toThrow(/texto de confirmación/i);
  });

  test('con motivo y confirmación correctos, vuelve a certecf y deja auditoría', async () => {
    const { service, db } = buildService({ emitter: { ...READY_EMITTER, environment: 'ecf', production_status: 'active' } });

    const result = await service.revertProductionToCertification(
      reqWith({ reason: 'certificado vencido, corrigiendo', confirmationText: 'VOLVER A CERTIFICACION' }),
    );

    expect(result.ok).toBe(true);
    expect(db.getEmitterRow().environment).toBe('certecf');
    expect(db.getEmitterRow().production_status).toBe('suspended');
    expect(db.auditLog.some((row) => row.includes('production_reverted') && row.some((v) => typeof v === 'string' && v.includes('certificado vencido')))).toBe(true);
  });
});

describe('saveDgiiSettings() — bloquea el atajo directo a producción', () => {
  test('rechaza cambiar a ecf desde el selector genérico de ambiente', async () => {
    const { service } = buildService({ emitter: { ...READY_EMITTER, environment: 'certecf' } });
    await expect(service.saveDgiiSettings(reqWith({ environment: 'ecf' })))
      .rejects.toThrow(/Activar producción DGII/i);
  });

  test('permite guardar otros cambios de configuración sin tocar el ambiente', async () => {
    const { service, db } = buildService({ emitter: { ...READY_EMITTER, environment: 'certecf' } });
    await service.saveDgiiSettings(reqWith({ environment: 'certecf', certificateMode: 'p12' }));
    expect(db.getEmitterRow().environment).toBe('certecf');
  });
});

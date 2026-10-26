'use strict';

/**
 * "Ya me certifiqué antes": un RNC que la DGII ya certificó solo carga su .p12
 * y queda en producción, conectado y con el wizard 15/15. Incluye los dos
 * fallos que impedían a la app instalada conectarse a la DGII: el log de e-CF
 * dentro de app.asar (ENOTDIR) y la contraseña del .p12 cifrada con otra clave.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildReactivatedWizardState,
  createEcfService,
  rncFromCertificateSubject,
} = require('../modules/ecf/services/ecf.service');

const SUBJECT_PERSONA = 'C=DO, surname=CABRERA, givenName=EMILIO MANAURYS, serialNumber=IDCDO-40211932609, CN=EMILIO MANAURYS CABRERA';

function buildService({ emitter: emitterOverrides = {}, authOk = true, certificate = {}, sequences = [] } = {}) {
  const emitter = {
    environment: 'certecf', rnc: '', razon_social: '', production_status: 'not_configured',
    production_activated_at: null, production_activated_by: '', is_active: false,
    ...emitterOverrides,
  };
  const service = createEcfService({
    query: async () => [],
    withTransaction: async (work) => work({ query: async () => [] }),
    resolveRequestActorUser: async () => ({ id: 1, nombre: 'Admin', role_code: 'administrador_general' }),
  });
  const calls = { upserts: [], audits: [], savedCertificates: [], wizard: null };
  service.ensureReady = async () => {};
  service.repository.getResolvedEmitter = async () => ({ ...emitter });
  service.repository.upsertEmitter = async (_id, data) => { calls.upserts.push(data); Object.assign(emitter, data); return emitter; };
  service.repository.saveAudit = async (a) => { calls.audits.push(a); };
  service.repository.listSequences = async () => sequences;
  service._readCertificateUpload = async () => ({ uploaded: { filepath: 'x.p12', originalFilename: 'mio.p12' }, password: 'clave' });
  service._openUploadedCertificate = ({ expectedRnc }) => {
    const subject = certificate.subject || SUBJECT_PERSONA;
    return {
      certificate: {
        subject,
        certificate: { subject: { attributes: [{ shortName: 'CN', value: 'EMILIO MANAURYS CABRERA' }] } },
      },
      validation: {
        subject,
        isValidNow: certificate.isValidNow ?? true,
        isExpired: certificate.isExpired ?? false,
        validTo: '2027-05-19T05:45:08.000Z',
        rncMatch: expectedRnc ? subject.replace(/\D/g, '').includes(expectedRnc) : null,
      },
    };
  };
  service._saveActiveCertificate = async (args) => { calls.savedCertificates.push(args); };
  service._readCertWizardState = () => null;
  service._writeCertWizardState = (state) => { calls.wizard = state; };
  service.startDgiiAuthMaintenance = () => {};
  service.authService.authenticate = async () => {
    if (!authOk) throw new Error('DGII rechazó la semilla');
    return { token: 'tkn', environment: 'ecf', expira: '2026-10-26T13:00:00Z' };
  };
  return { service, emitter, calls };
}

describe('"Ya me certifiqué antes"', () => {
  test('con solo el .p12 deja producción activa, conectada y el wizard 15/15', async () => {
    const produccion = [{ environment: 'ecf', activo: true, isExpired: false, isExhausted: false }];
    const { service, emitter, calls } = buildService({ sequences: produccion });

    const res = await service.reactivateCertifiedEmitter({ body: {} });

    expect(res.ok).toBe(true);
    expect(res.rnc).toBe('40211932609');
    expect(res.pendientes).toEqual([]);
    expect(emitter).toMatchObject({
      environment: 'ecf', production_status: 'active', is_active: true,
      rnc: '40211932609', razon_social: 'EMILIO MANAURYS CABRERA',
    });
    expect(calls.savedCertificates).toHaveLength(1);
    expect(calls.wizard.completedSteps).toHaveLength(15);
    expect(calls.wizard.progress).toBe(100);
    expect(calls.wizard.environment).toBe('ecf');
    expect(calls.wizard.steps[1].data).toMatchObject({ rnc: '40211932609', razonSocial: 'EMILIO MANAURYS CABRERA' });
    expect(service.runtimeState.lastConnection.status).toBe('conectado');
    expect(calls.audits.map((a) => a.actionName)).toEqual(['production_reactivated']);
  });

  test('sin secuencias de producción avisa que faltan (no inventa números)', async () => {
    const pruebas = [{ environment: 'certecf', activo: true, isExpired: false, isExhausted: false }];
    const { service } = buildService({ sequences: pruebas });
    const res = await service.reactivateCertifiedEmitter({ body: {} });
    expect(res.ok).toBe(true);
    expect(res.secuenciasProduccion).toBe(0);
    expect(res.pendientes[0]).toMatch(/secuencias e-NCF/);
  });

  test('si ya estaba en producción conserva la fecha original de activación', async () => {
    const activadaEl = new Date('2026-10-23T14:02:21Z');
    const { service, emitter } = buildService({
      emitter: { environment: 'ecf', rnc: '40211932609', razon_social: 'Emilio', production_status: 'active', production_activated_at: activadaEl, production_activated_by: 'Emilio' },
    });
    await service.reactivateCertifiedEmitter({ body: {} });
    expect(emitter.production_activated_at).toBe(activadaEl);
    expect(emitter.is_active).toBe(true);
  });

  test('si la DGII no acepta el certificado no activa nada', async () => {
    const { service, emitter, calls } = buildService({ authOk: false });
    const res = await service.reactivateCertifiedEmitter({ body: {} });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/DGII no aceptó/);
    expect(emitter.environment).toBe('certecf');
    expect(emitter.production_status).toBe('not_configured');
    expect(emitter.is_active).toBe(false);
    expect(calls.wizard).toBeNull();
    expect(service.config.DGII_ENV).toBe('certecf');
  });

  test('rechaza un certificado de otro RNC sin guardarlo', async () => {
    const { service, calls } = buildService({ emitter: { rnc: '131234567', razon_social: 'Otra SRL' } });
    await expect(service.reactivateCertifiedEmitter({ body: {} })).rejects.toThrow(/no pertenece al RNC 131234567/);
    expect(calls.savedCertificates).toHaveLength(0);
  });

  test('rechaza un certificado vencido', async () => {
    const { service } = buildService({ certificate: { isValidNow: false, isExpired: true } });
    await expect(service.reactivateCertifiedEmitter({ body: {} })).rejects.toThrow(/venció/);
  });
});

describe('ayudantes', () => {
  test('RNC del certificado: empresa (VATDO) antes que la cédula (IDCDO)', () => {
    expect(rncFromCertificateSubject(SUBJECT_PERSONA)).toBe('40211932609');
    expect(rncFromCertificateSubject(`${SUBJECT_PERSONA}, organizationIdentifier=VATDO-131234567`)).toBe('131234567');
    expect(rncFromCertificateSubject('CN=Sin identificador')).toBe('');
  });

  test('el wizard reactivado respeta los datos de una certificación anterior', () => {
    const previo = { startedAt: '2026-08-10T01:12:12Z', steps: { 2: { completedAt: '2026-08-11T00:00:00Z', data: { accepted: 20, total: 20 } } } };
    const estado = buildReactivatedWizardState(previo, { at: '2026-10-26T12:00:00Z', by: 'Emilio', rnc: '40211932609', razonSocial: 'X' });
    expect(estado.startedAt).toBe('2026-08-10T01:12:12Z');
    expect(estado.steps[2].data.accepted).toBe(20);
    expect(estado.steps[14].data.reactivado).toBe(true);
    expect(estado.reactivacion).toEqual({ at: '2026-10-26T12:00:00Z', by: 'Emilio', rnc: '40211932609' });
  });
});

describe('app instalada', () => {
  const envOriginal = { ...process.env };
  afterEach(() => {
    process.env = { ...envOriginal };
  });

  test('el log de e-CF va a la carpeta de datos y nunca frena la operación', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ecf-log-'));
    process.env.TECNO_CAJA_USER_DATA = tmp;
    jest.isolateModules(() => {
      const { createLogger, ROOT_LOG_FILE } = require('../modules/ecf/utils/logger');
      createLogger('prueba').info('Semilla obtenida desde DGII.');
      expect(ROOT_LOG_FILE).toBe(path.join(tmp, 'logs', 'ecf.log'));
      expect(fs.readFileSync(ROOT_LOG_FILE, 'utf8')).toMatch(/Semilla obtenida/);
    });

    // Carpeta imposible (debajo de un archivo), como app.asar en la app instalada.
    const archivo = path.join(tmp, 'app.asar');
    fs.writeFileSync(archivo, 'x');
    process.env.TECNO_CAJA_USER_DATA = archivo;
    jest.isolateModules(() => {
      const { createLogger } = require('../modules/ecf/utils/logger');
      expect(() => createLogger('prueba').info('no debe lanzar')).not.toThrow();
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('la contraseña del .p12 guardada con la clave vieja se sigue leyendo', () => {
    process.env.FISCAL_CERT_SECRET = 'clave-propia-de-esta-pc';
    delete process.env.ECF_SECRET;
    jest.isolateModules(() => {
      const crypto = require('../modules/ecf/services/crypto-service');
      const conClaveVieja = crypto.encryptText('mi-clave-p12', 'tecnocaja-ecf-secret-change-me');
      expect(crypto.decryptTextWithLegacyFallback(conClaveVieja)).toBe('mi-clave-p12');
      expect(crypto.decryptTextWithLegacyFallback(crypto.encryptText('nueva'))).toBe('nueva');
      const conOtraClave = crypto.encryptText('x', 'clave-de-otra-pc');
      expect(() => crypto.decryptTextWithLegacyFallback(conOtraClave)).toThrow();
    });
  });
});

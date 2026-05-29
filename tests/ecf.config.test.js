'use strict';

const { buildEcfConfig, normalizeEnvironmentKey } = require('../modules/ecf/config/ecf.config');

describe('ecf.config', () => {
  test('normaliza alias de ambientes oficiales DGII', () => {
    expect(normalizeEnvironmentKey('test')).toBe('testecf');
    expect(normalizeEnvironmentKey('certificacion')).toBe('certecf');
    expect(normalizeEnvironmentKey('produccion')).toBe('ecf');
  });

  test('resuelve endpoints oficiales por ambiente', () => {
    const config = buildEcfConfig({ DGII_ENV: 'certecf' });
    expect(config.DGII_ENV).toBe('certecf');
    expect(config.DGII_AUTH_URL.toLowerCase()).toContain('/certecf/autenticacion');
    expect(config.DGII_RECEPCION_URL.toLowerCase()).toContain('/certecf/recepcion/api/facturaselectronicas');
    expect(config.DGII_FC_URL.toLowerCase()).toContain('fc.dgii.gov.do/certecf/recepcionfc/api/recepcion/ecf');
  });
});

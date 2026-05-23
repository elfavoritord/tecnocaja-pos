/**
 * tests/config/cors.test.js
 *
 * Valida la política de CORS: localhost OK, LAN gated por flag, desconocidos rechazados.
 */

'use strict';

// Limpiar módulo para poder manipular env entre tests.
function loadCors(envOverrides = {}) {
  const snapshot = { ...process.env };
  Object.assign(process.env, envOverrides);
  jest.resetModules();
  const mod = require('../../server/config/cors');
  process.env = snapshot;
  return mod;
}

describe('config/cors', () => {
  describe('corsOriginCheck', () => {
    it('permite peticiones sin header Origin (Electron, curl)', (done) => {
      const { corsOriginCheck } = loadCors();
      corsOriginCheck(undefined, (err, allow) => {
        expect(err).toBeNull();
        expect(allow).toBe(true);
        done();
      });
    });

    it('permite cualquier puerto de localhost', (done) => {
      const { corsOriginCheck } = loadCors();
      corsOriginCheck('http://localhost:5173', (err, allow) => {
        expect(err).toBeNull();
        expect(allow).toBe(true);
        done();
      });
    });

    it('permite cualquier puerto de 127.0.0.1', (done) => {
      const { corsOriginCheck } = loadCors();
      corsOriginCheck('http://127.0.0.1:9999', (err, allow) => {
        expect(err).toBeNull();
        expect(allow).toBe(true);
        done();
      });
    });

    it('rechaza origen externo por defecto', (done) => {
      const { corsOriginCheck } = loadCors();
      corsOriginCheck('https://atacante.com', (err) => {
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/no permitido/i);
        done();
      });
    });

    it('permite IP LAN cuando POS_ALLOW_LAN=true', (done) => {
      const { corsOriginCheck } = loadCors({ POS_ALLOW_LAN: 'true' });
      corsOriginCheck('http://192.168.1.50:3000', (err, allow) => {
        expect(err).toBeNull();
        expect(allow).toBe(true);
        done();
      });
    });

    it('rechaza IP LAN cuando POS_ALLOW_LAN no está seteado', (done) => {
      const { corsOriginCheck } = loadCors({ POS_ALLOW_LAN: '' });
      corsOriginCheck('http://192.168.1.50:3000', (err) => {
        expect(err).toBeInstanceOf(Error);
        done();
      });
    });

    it('permite origen en CORS_ALLOWED_ORIGINS', (done) => {
      const { corsOriginCheck } = loadCors({
        CORS_ALLOWED_ORIGINS: 'https://tecnocaja.com,https://admin.tecnocaja.com'
      });
      corsOriginCheck('https://tecnocaja.com', (err, allow) => {
        expect(err).toBeNull();
        expect(allow).toBe(true);
        done();
      });
    });
  });

  describe('corsOptions', () => {
    it('expone métodos esperados', () => {
      const { corsOptions } = loadCors();
      expect(corsOptions.credentials).toBe(true);
      expect(corsOptions.methods).toEqual(
        expect.arrayContaining(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'])
      );
    });
  });
});

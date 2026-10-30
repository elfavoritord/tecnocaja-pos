'use strict';

/**
 * tests/ecf.urls-servicio.test.js
 *
 * Pasos 7 y 12 de la certificación: una URL mal escrita (tecno-caja-ect-gateway) pasó
 * la validación porque un 404 contaba como bueno, y la DGII reinició la prueba.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const https = require('https');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { createEcfService, resolvePublicBaseUrl } = require('../modules/ecf/services/ecf.service');
const { createDgiiPublicRouter } = require('../server/routes/dgii-public.routes');

const GATEWAY = 'https://tecno-caja-ecf-gateway-1052855422372.us-east1.run.app';

describe('validateServiceUrls', () => {
  const service = createEcfService({ query: jest.fn(async () => []), withTransaction: jest.fn(), resolveRequestActorUser: jest.fn() });

  afterEach(() => jest.restoreAllMocks());

  function respondeCon(statusCode) {
    jest.spyOn(https, 'get').mockImplementation((_url, _options, callback) => {
      const req = new EventEmitter();
      setImmediate(() => callback({ statusCode, resume() {} }));
      return req;
    });
  }

  async function validar() {
    return service.validateServiceUrls({ body: { urls: { semilla: `${GATEWAY}/fe/autenticacion/api/semilla` } } });
  }

  test('un 200 es válido', async () => {
    respondeCon(200);
    expect((await validar()).ok).toBe(true);
  });

  test('un 404 no es válido: es lo que da un error de escritura en la URL', async () => {
    respondeCon(404);
    const result = await validar();
    expect(result.ok).toBe(false);
    expect(result.errors[0].reason).toMatch(/no existe/);
  });

  test.each([401, 403, 500, 503])('un %i no es válido', async (status) => {
    respondeCon(status);
    expect((await validar()).ok).toBe(false);
  });
});

describe('resolvePublicBaseUrl', () => {
  const original = process.env.ECF_GATEWAY_BASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.ECF_GATEWAY_BASE_URL;
    else process.env.ECF_GATEWAY_BASE_URL = original;
  });

  test('sin URL guardada usa el gateway', () => {
    delete process.env.ECF_GATEWAY_BASE_URL;
    expect(resolvePublicBaseUrl('')).toBe(GATEWAY);
    expect(resolvePublicBaseUrl(null)).toBe(GATEWAY);
  });

  test('la variable de entorno reemplaza al gateway por defecto', () => {
    process.env.ECF_GATEWAY_BASE_URL = 'https://otro.example.com/';
    expect(resolvePublicBaseUrl('')).toBe('https://otro.example.com');
  });

  test('la URL guardada siempre manda', () => {
    process.env.ECF_GATEWAY_BASE_URL = 'https://otro.example.com';
    expect(resolvePublicBaseUrl('https://mi-tunel.example.com')).toBe('https://mi-tunel.example.com');
  });
});

describe('rutas públicas locales /fe', () => {
  const app = express();
  app.use(createDgiiPublicRouter());

  test.each(['/fe/autenticacion/api/semilla', '/fe/recepcion/api/ecf', '/fe/aprobacioncomercial/api/ecf'])(
    'GET %s responde 200 para pasar la comprobación con túnel propio',
    async (ruta) => {
      expect((await request(app).get(ruta)).status).toBe(200);
    }
  );
});

describe('botón de copiar del asistente', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'ecf-cert-wizard.js'), 'utf8');

  test('la URL va escapada: las comillas del JSON rompían el onclick y el botón no copiaba', () => {
    expect(source).not.toMatch(/_copyText\(\$\{JSON\.stringify/);
    expect(source).toContain('_copyText(${h(JSON.stringify(item.url))})');
    expect(source).toContain('_copyText(${h(JSON.stringify(base + p))})');
  });
});

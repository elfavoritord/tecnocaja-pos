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

describe('venta con e-CF sin rango cargado', () => {
  const service = createEcfService({ query: jest.fn(async () => []), withTransaction: jest.fn(), resolveRequestActorUser: jest.fn() });

  function conRangos(filas) {
    const exec = jest.fn(async () => filas);
    return { exec, args: { exec, environment: 'ecf', branchId: 1, cashRegisterId: 2 } };
  }

  test('sin rango se frena y dice qué falta', async () => {
    const { args } = conRangos([]);
    await expect(service.assertSaleHasSequence({ ...args, buyerTaxId: '' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'ECF_SIN_SECUENCIA', details: { tipoEcf: 'E32' } });
  });

  test('con RNC del comprador busca E31; sin RNC, E32', async () => {
    const { exec, args } = conRangos([{ numero_final: 100, proximo_numero: 1, fecha_vencimiento: '2099-12-31' }]);
    await service.assertSaleHasSequence({ ...args, buyerTaxId: '132839676' });
    expect(exec.mock.calls[0][1]).toEqual([1, 'E31', 'ecf', 1, 2]);
    await service.assertSaleHasSequence({ ...args, buyerTaxId: '' });
    expect(exec.mock.calls[1][1]).toEqual([1, 'E32', 'ecf', 1, 2]);
  });

  test('un rango agotado o vencido no cuenta', async () => {
    const agotado = conRangos([{ numero_final: 100, proximo_numero: 101, fecha_vencimiento: null }]);
    await expect(service.assertSaleHasSequence({ ...agotado.args, buyerTaxId: '' })).rejects.toThrow(/no se cobró/);
    const vencido = conRangos([{ numero_final: 100, proximo_numero: 1, fecha_vencimiento: '2020-01-01' }]);
    await expect(service.assertSaleHasSequence({ ...vencido.args, buyerTaxId: '' })).rejects.toThrow(/no se cobró/);
  });

  test('la consulta corre en SQLite y respeta ambiente, sucursal y caja', async () => {
    const SQL = await require('sql.js')();
    const db = new SQL.Database();
    db.run(`CREATE TABLE ecf_sequences (business_id INT, branch_id INT, cash_register_id INT, tipo_comprobante TEXT, environment TEXT,
      numero_final INT, proximo_numero INT, fecha_vencimiento TEXT, activo INT, deleted_at TEXT)`);
    db.run(`INSERT INTO ecf_sequences VALUES
      (1, NULL, NULL, 'E31', 'certecf', 100, 1, NULL, 1, NULL),
      (1, 5, NULL, 'E32', 'ecf', 100, 1, NULL, 1, NULL),
      (1, NULL, NULL, 'E33', 'ecf', 100, 1, NULL, 0, NULL)`);
    const exec = async (sql, params) => {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    };
    const hay = (tipoComprobante, environment, branchId) => service.repository.hasAvailableSequence({
      exec, tipoComprobante, environment, branchId, cashRegisterId: 2,
    });
    await expect(hay('E31', 'certecf', 1)).resolves.toBe(true);
    await expect(hay('E31', 'ecf', 1)).resolves.toBe(false);
    await expect(hay('E32', 'ecf', 5)).resolves.toBe(true);
    await expect(hay('E32', 'ecf', 6)).resolves.toBe(false);
    await expect(hay('E33', 'ecf', 1)).resolves.toBe(false);
  });

  test('con e-CF inactivo no se comprueba nada', async () => {
    service.ensureReady = jest.fn(async () => {});
    service.repository.getResolvedEmitter = jest.fn(async () => ({ is_active: false, environment: 'ecf' }));
    await expect(service.getActiveSaleEnvironment()).resolves.toBeNull();
    service.repository.getResolvedEmitter = jest.fn(async () => ({ is_active: true, environment: 'ecf' }));
    await expect(service.getActiveSaleEnvironment()).resolves.toBe('ecf');
  });

  test('si no se puede leer el ambiente, la venta no se frena', async () => {
    service.ensureReady = jest.fn(async () => { throw new Error('sin base'); });
    await expect(service.getActiveSaleEnvironment()).resolves.toBeNull();
  });
});

describe('botón de copiar del asistente', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'ecf-cert-wizard.js'), 'utf8');

  test('la URL va escapada: las comillas del JSON rompían el onclick y el botón no copiaba', () => {
    expect(source).not.toMatch(/_copyText\(\$\{JSON\.stringify/);
    expect(source).toContain('_copyText(${h(JSON.stringify(item.url))})');
    expect(source).toContain('_copyText(${h(JSON.stringify(base + p))})');
  });
});

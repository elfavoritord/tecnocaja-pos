'use strict';

/**
 * tests/routes/platform.routes.test.js
 *
 * Verifica que las rutas de plataforma estén correctamente definidas
 * y que el endpoint de diagnóstico inseguro haya sido eliminado.
 */

const express = require('express');
const request = require('supertest');

function buildApp(overrides = {}) {
  const mockQuery = overrides.query || jest.fn().mockResolvedValue([]);
  const createPlatformRouter = require('../../server/routes/platform.routes');
  const app = express();
  app.use(express.json());
  app.use('/api/platform', createPlatformRouter({ query: mockQuery }));
  return { app, mockQuery };
}

describe('platform.routes', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.resetAllMocks();
  });

  describe('Seguridad', () => {
    it('GET /api/platform/debug-firestore debe devolver 404 (endpoint eliminado)', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/api/platform/debug-firestore');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/platform/contadores/buscar', () => {
    it('devuelve [] si el query q tiene menos de 2 caracteres', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/api/platform/contadores/buscar')
        .query({ q: 'a' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('devuelve [] si q está vacío', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/api/platform/contadores/buscar');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('llama a query con LIKE cuando Firestore no está disponible', async () => {
      jest.mock('../../modules/firebase-admin', () => {
        throw new Error('Firebase no disponible');
      });

      const mockRows = [
        { id: 1, nombre_firma: 'Emilio Contadores', responsable: 'Emilio', rnc: '131880681', telefono: '809-000-0000', correo: 'test@test.com', logo_url: null }
      ];
      const mockQuery = jest.fn().mockResolvedValue(mockRows);
      const createPlatformRouter = require('../../server/routes/platform.routes');
      const app = express();
      app.use(express.json());
      app.use('/api/platform', createPlatformRouter({ query: mockQuery }));

      const res = await request(app)
        .get('/api/platform/contadores/buscar')
        .query({ q: 'emilio' });

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('LIKE'),
        expect.any(Array)
      );
    });
  });

  describe('POST /api/platform/registrar-negocio', () => {
    it('devuelve 400 si falta nombre_negocio', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post('/api/platform/registrar-negocio')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/nombre_negocio/i);
    });

    it('registra un negocio nuevo cuando no existe cloud_business_id', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce([{ cloud_business_id: null }]) // SELECT config
        .mockResolvedValueOnce({ insertId: 42 })              // INSERT cloud_businesses
        .mockResolvedValueOnce([])                            // UPDATE config
        ;

      const createPlatformRouter = require('../../server/routes/platform.routes');
      const app = express();
      app.use(express.json());
      app.use('/api/platform', createPlatformRouter({ query: mockQuery }));

      const res = await request(app)
        .post('/api/platform/registrar-negocio')
        .send({ nombre_negocio: 'Colmado El Buen Gusto', business_mode: 'independent' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.new).toBe(true);
      expect(typeof res.body.cloudId).toBe('string');
      expect(res.body.cloudId).toHaveLength(32);
    });

    it('actualiza negocio existente cuando ya hay cloud_business_id', async () => {
      const existingCloudId = 'abc123def456abc123def456abc12345';
      const mockQuery = jest.fn()
        .mockResolvedValueOnce([{ cloud_business_id: existingCloudId }]) // SELECT config
        .mockResolvedValueOnce([])                                        // UPDATE cloud_businesses
        ;

      const createPlatformRouter = require('../../server/routes/platform.routes');
      const app = express();
      app.use(express.json());
      app.use('/api/platform', createPlatformRouter({ query: mockQuery }));

      const res = await request(app)
        .post('/api/platform/registrar-negocio')
        .send({ nombre_negocio: 'Colmado El Buen Gusto', business_mode: 'independent' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.new).toBe(false);
      expect(res.body.cloudId).toBe(existingCloudId);
    });
  });

  describe('GET /api/platform/mi-negocio', () => {
    it('devuelve registrado: false si no hay cloud_business_id', async () => {
      const mockQuery = jest.fn().mockResolvedValue([{ cloud_business_id: null }]);
      const createPlatformRouter = require('../../server/routes/platform.routes');
      const app = express();
      app.use(express.json());
      app.use('/api/platform', createPlatformRouter({ query: mockQuery }));

      const res = await request(app).get('/api/platform/mi-negocio');
      expect(res.status).toBe(200);
      expect(res.body.registrado).toBe(false);
    });
  });
});

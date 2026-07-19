'use strict';

/**
 * tests/routes/crm.routes.test.js
 *
 * Verifica los endpoints de seguimientos/CRM: validaciones básicas,
 * completar/reabrir, y el filtro de agenda por pendientes/fechas.
 */

const express = require('express');
const request = require('supertest');

function buildApp({ query } = {}) {
  const { createCrmRouter } = require('../../server/routes/crm.routes');
  const mockQuery = query || jest.fn().mockResolvedValue([]);
  const resolveRequestActorUser = jest.fn().mockResolvedValue({ id: 1, usuario: 'admin' });

  const app = express();
  app.use(express.json());
  app.use('/api/crm', createCrmRouter({ query: mockQuery, resolveRequestActorUser }));
  return { app, mockQuery, resolveRequestActorUser };
}

describe('crm.routes', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.resetAllMocks();
  });

  describe('GET /api/crm/seguimientos', () => {
    it('devuelve 400 si falta clienteId', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/api/crm/seguimientos');
      expect(res.status).toBe(400);
    });

    it('devuelve la lista mapeada para un cliente', async () => {
      const mockQuery = jest.fn().mockResolvedValue([
        { id: 1, client_id: 5, tipo: 'tarea', titulo: 'Llamar', descripcion: null, fecha_programada: '2026-07-20', completado: 0, created_by_user_name: 'admin', created_at: '2026-07-17', completed_at: null },
      ]);
      const { app } = buildApp({ query: mockQuery });
      const res = await request(app).get('/api/crm/seguimientos').query({ clienteId: 5 });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].titulo).toBe('Llamar');
      expect(res.body[0].completado).toBe(false);
    });
  });

  describe('POST /api/crm/seguimientos', () => {
    it('devuelve 400 si falta título', async () => {
      const { app } = buildApp();
      const res = await request(app).post('/api/crm/seguimientos').send({ clientId: 5, tipo: 'nota' });
      expect(res.status).toBe(400);
    });

    it('devuelve 400 si el tipo no es válido', async () => {
      const { app } = buildApp();
      const res = await request(app).post('/api/crm/seguimientos').send({ clientId: 5, tipo: 'invalido', titulo: 'X' });
      expect(res.status).toBe(400);
    });

    it('crea el seguimiento cuando los datos son válidos', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ insertId: 9 })
        .mockResolvedValueOnce([{ id: 9, client_id: 5, tipo: 'tarea', titulo: 'Llamar', descripcion: null, fecha_programada: null, completado: 0, created_by_user_name: 'admin', created_at: '2026-07-17', completed_at: null }]);
      const { app } = buildApp({ query: mockQuery });
      const res = await request(app).post('/api/crm/seguimientos').send({ clientId: 5, tipo: 'tarea', titulo: 'Llamar' });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe(9);
    });
  });

  describe('PUT /api/crm/seguimientos/:id/completar y /reabrir', () => {
    it('marca como completado', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ affectedRows: 1 });
      const { app } = buildApp({ query: mockQuery });
      const res = await request(app).put('/api/crm/seguimientos/9/completar');
      expect(res.status).toBe(200);
      expect(mockQuery.mock.calls[0][0]).toMatch(/completado=1/);
    });

    it('reabre un seguimiento completado', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ affectedRows: 1 });
      const { app } = buildApp({ query: mockQuery });
      const res = await request(app).put('/api/crm/seguimientos/9/reabrir');
      expect(res.status).toBe(200);
      expect(mockQuery.mock.calls[0][0]).toMatch(/completado=0/);
    });
  });

  describe('GET /api/crm/agenda', () => {
    it('filtra solo pendientes por defecto', async () => {
      const mockQuery = jest.fn().mockResolvedValue([]);
      const { app } = buildApp({ query: mockQuery });
      await request(app).get('/api/crm/agenda');
      expect(mockQuery.mock.calls[0][0]).toMatch(/f\.completado = 0/);
    });

    it('incluye completados cuando soloPendientes=0', async () => {
      const mockQuery = jest.fn().mockResolvedValue([]);
      const { app } = buildApp({ query: mockQuery });
      await request(app).get('/api/crm/agenda').query({ soloPendientes: '0' });
      expect(mockQuery.mock.calls[0][0]).not.toMatch(/f\.completado = 0/);
    });
  });
});

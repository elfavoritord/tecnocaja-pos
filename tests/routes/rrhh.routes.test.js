'use strict';

/**
 * tests/routes/rrhh.routes.test.js
 *
 * Verifica los endpoints de RRHH: validaciones básicas de empleados,
 * asistencia (upsert por día) y permisos (aprobar/rechazar).
 */

const express = require('express');
const request = require('supertest');

function buildApp({ query, actor } = {}) {
  const { createRrhhRouter } = require('../../server/routes/rrhh.routes');
  const mockQuery = query || jest.fn().mockResolvedValue([]);
  const resolveRequestActorUser = jest.fn().mockResolvedValue(
    actor !== undefined ? actor : { id: 1, usuario: 'admin', role_code: 'administrador_general' }
  );
  const userRoleHasPermission = jest.fn().mockReturnValue(false);

  const app = express();
  app.use(express.json());
  app.use('/api/rrhh', createRrhhRouter({ query: mockQuery, resolveRequestActorUser, userRoleHasPermission }));
  return { app, mockQuery };
}

describe('rrhh.routes', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.resetAllMocks();
  });

  describe('Permisos de acceso', () => {
    it('devuelve 403 si el rol no tiene permiso rrhh', async () => {
      const { app } = buildApp({ actor: { id: 2, role_code: 'cajero' } });
      const res = await request(app).get('/api/rrhh/empleados');
      expect(res.status).toBe(403);
    });

    it('permite acceso a administrador_general', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/api/rrhh/empleados');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/rrhh/empleados', () => {
    it('devuelve 400 si falta el nombre', async () => {
      const { app } = buildApp();
      const res = await request(app).post('/api/rrhh/empleados').send({ cargo: 'Cajero' });
      expect(res.status).toBe(400);
    });

    it('crea el empleado cuando el nombre está presente', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ insertId: 3 })
        .mockResolvedValueOnce([{ id: 3, nombre: 'Juan Pérez', estado: 'activo' }]);
      const { app } = buildApp({ query: mockQuery });
      const res = await request(app).post('/api/rrhh/empleados').send({ nombre: 'Juan Pérez' });
      expect(res.status).toBe(201);
      expect(res.body.nombre).toBe('Juan Pérez');
    });
  });

  describe('POST /api/rrhh/asistencia', () => {
    it('devuelve 400 si el estado no es válido', async () => {
      const { app } = buildApp();
      const res = await request(app).post('/api/rrhh/asistencia').send({ employeeId: 1, fecha: '2026-07-17', estado: 'de-vacaciones' });
      expect(res.status).toBe(400);
    });

    it('inserta cuando no existe registro previo para ese día', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce([]) // SELECT existente -> vacío
        .mockResolvedValueOnce({ insertId: 9 }) // INSERT
        .mockResolvedValueOnce([{ id: 9, employee_id: 1, fecha: '2026-07-17', estado: 'presente' }]); // SELECT final
      const { app } = buildApp({ query: mockQuery });
      const res = await request(app).post('/api/rrhh/asistencia').send({ employeeId: 1, fecha: '2026-07-17', estado: 'presente' });
      expect(res.status).toBe(201);
      const calls = mockQuery.mock.calls.map(c => c[0]);
      expect(calls.some(sql => /INSERT INTO hr_attendance/i.test(sql))).toBe(true);
      expect(calls.some(sql => /UPDATE hr_attendance/i.test(sql))).toBe(false);
    });

    it('actualiza cuando ya existe registro para ese día', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce([{ id: 9 }]) // SELECT existente -> encontrado
        .mockResolvedValueOnce({ affectedRows: 1 }) // UPDATE
        .mockResolvedValueOnce([{ id: 9, employee_id: 1, fecha: '2026-07-17', estado: 'tardanza' }]);
      const { app } = buildApp({ query: mockQuery });
      const res = await request(app).post('/api/rrhh/asistencia').send({ employeeId: 1, fecha: '2026-07-17', estado: 'tardanza' });
      expect(res.status).toBe(201);
      const calls = mockQuery.mock.calls.map(c => c[0]);
      expect(calls.some(sql => /UPDATE hr_attendance/i.test(sql))).toBe(true);
      expect(calls.some(sql => /INSERT INTO hr_attendance/i.test(sql))).toBe(false);
    });
  });

  describe('PUT /api/rrhh/permisos/:id/aprobar y /rechazar', () => {
    it('aprueba una solicitud pendiente', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce([{ id: 5, estado: 'pendiente' }])
        .mockResolvedValueOnce({ affectedRows: 1 });
      const { app } = buildApp({ query: mockQuery });
      const res = await request(app).put('/api/rrhh/permisos/5/aprobar');
      expect(res.status).toBe(200);
      expect(mockQuery.mock.calls[1][0]).toMatch(/estado='aprobado'/);
    });

    it('devuelve 400 si la solicitud ya fue resuelta', async () => {
      const mockQuery = jest.fn().mockResolvedValueOnce([{ id: 5, estado: 'aprobado' }]);
      const { app } = buildApp({ query: mockQuery });
      const res = await request(app).put('/api/rrhh/permisos/5/rechazar');
      expect(res.status).toBe(400);
    });
  });
});

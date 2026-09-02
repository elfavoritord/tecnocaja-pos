'use strict';

/**
 * recursos.routes.js — Datos auxiliares para los formularios del modo servicios
 * (empleados para asignar a órdenes/proyectos, sin exigir permiso de RRHH).
 *
 *  GET /api/servicios/recursos/empleados
 */

const express = require('express');
const { makeServiceGuard } = require('./_common');

function createRecursosRouter(deps) {
  const { query } = deps;
  const guard = makeServiceGuard(deps);
  const router = express.Router();
  router.use(guard.requireService());

  router.get('/empleados', async (_req, res) => {
    try {
      const rows = await query(
        `SELECT id, nombre, cargo, departamento FROM hr_employees
         WHERE estado = 'activo' ORDER BY nombre LIMIT 500`
      ).catch(() => []);
      res.json(rows.map((r) => ({ id: r.id, nombre: r.nombre, cargo: r.cargo || '', departamento: r.departamento || '' })));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createRecursosRouter };

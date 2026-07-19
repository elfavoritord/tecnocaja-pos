'use strict';

/**
 * rrhh.routes.js — Recursos Humanos: Empleados, Asistencia, Permisos
 * Factory pattern con inyección de dependencias.
 *
 * No calcula nómina ni pagos — es registro de personal, no un módulo
 * financiero. "Nómina" (cálculo de pago, TSS, deducciones) es un módulo
 * separado y futuro.
 *
 * Rutas:
 *  GET    /api/rrhh/empleados
 *  POST   /api/rrhh/empleados
 *  PUT    /api/rrhh/empleados/:id
 *  DELETE /api/rrhh/empleados/:id
 *  GET    /api/rrhh/asistencia?empleadoId=&desde=&hasta=
 *  POST   /api/rrhh/asistencia
 *  GET    /api/rrhh/permisos?empleadoId=&estado=
 *  POST   /api/rrhh/permisos
 *  PUT    /api/rrhh/permisos/:id/aprobar
 *  PUT    /api/rrhh/permisos/:id/rechazar
 */

const express = require('express');

const ASISTENCIA_ESTADOS = ['presente', 'ausente', 'tardanza', 'permiso'];
const PERMISO_TIPOS = ['vacaciones', 'personal', 'enfermedad', 'otro'];

async function ensureSchema(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS hr_employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INT DEFAULT NULL,
      nombre VARCHAR(160) NOT NULL,
      cedula VARCHAR(40) DEFAULT NULL,
      telefono VARCHAR(40) DEFAULT NULL,
      email VARCHAR(160) DEFAULT NULL,
      cargo VARCHAR(120) DEFAULT NULL,
      departamento VARCHAR(120) DEFAULT NULL,
      fecha_ingreso DATE DEFAULT NULL,
      salario_base DECIMAL(12,2) DEFAULT NULL,
      horario VARCHAR(160) DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'activo',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      CONSTRAINT fk_hr_employees_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS hr_attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INT NOT NULL,
      fecha DATE NOT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'presente',
      hora_entrada VARCHAR(10) DEFAULT NULL,
      hora_salida VARCHAR(10) DEFAULT NULL,
      nota VARCHAR(255) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (employee_id, fecha),
      CONSTRAINT fk_hr_attendance_employee FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS hr_leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INT NOT NULL,
      tipo VARCHAR(20) NOT NULL DEFAULT 'personal',
      fecha_inicio DATE NOT NULL,
      fecha_fin DATE NOT NULL,
      motivo VARCHAR(255) DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      aprobado_por_user_id INT DEFAULT NULL,
      aprobado_por_nombre VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME DEFAULT NULL,
      CONSTRAINT fk_hr_leave_employee FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE,
      CONSTRAINT fk_hr_leave_approver FOREIGN KEY (aprobado_por_user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await grantRrhhPermission(query);
}

// Otorga el permiso 'rrhh' al rol administrador_general si aún no lo tiene,
// sin tocar los demás permisos. Idempotente.
async function grantRrhhPermission(query) {
  const roles = await query(
    "SELECT id, codigo, permisos FROM roles WHERE codigo = 'administrador_general'"
  ).catch(() => []);
  for (const role of roles) {
    let perms = [];
    try { perms = JSON.parse(role.permisos || '[]'); } catch (_) { perms = []; }
    if (!Array.isArray(perms)) perms = [];
    if (perms.includes('rrhh')) continue;
    perms.push('rrhh');
    await query('UPDATE roles SET permisos = ? WHERE id = ?', [JSON.stringify(perms), role.id]).catch(() => {});
  }
}

function mapEmployee(row) {
  return {
    id: row.id,
    userId: row.user_id,
    nombre: row.nombre,
    cedula: row.cedula || '',
    telefono: row.telefono || '',
    email: row.email || '',
    cargo: row.cargo || '',
    departamento: row.departamento || '',
    fechaIngreso: row.fecha_ingreso,
    salarioBase: row.salario_base === null ? null : Number(row.salario_base),
    horario: row.horario || '',
    estado: row.estado,
  };
}

function mapAttendance(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    fecha: row.fecha,
    estado: row.estado,
    horaEntrada: row.hora_entrada,
    horaSalida: row.hora_salida,
    nota: row.nota || '',
  };
}

function mapLeaveRequest(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    tipo: row.tipo,
    fechaInicio: row.fecha_inicio,
    fechaFin: row.fecha_fin,
    motivo: row.motivo || '',
    estado: row.estado,
    aprobadoPorNombre: row.aprobado_por_nombre,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function createRrhhRouter({ query, resolveRequestActorUser, userRoleHasPermission }) {
  const router = express.Router();

  function canManageRrhh(actor) {
    const roleCode = String(actor?.role_code || actor?.rol || '').trim().toLowerCase();
    if (roleCode === 'administrador_general') return true;
    return userRoleHasPermission(actor, 'rrhh');
  }

  async function requireRrhh(req, res, next) {
    try {
      const actor = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
      if (!canManageRrhh(actor)) {
        return res.status(403).json({ error: 'No tienes permiso para acceder a Recursos Humanos.' });
      }
      req.authUser = actor;
      next();
    } catch (e) {
      res.status(401).json({ error: e.message || 'Sesión inválida o expirada.' });
    }
  }

  router.use(requireRrhh);

  // ── Empleados ────────────────────────────────────────────────────────────

  router.get('/empleados', async (req, res) => {
    try {
      let sql = 'SELECT * FROM hr_employees WHERE 1=1';
      const params = [];
      if (req.query.estado) { sql += ' AND estado = ?'; params.push(req.query.estado); }
      sql += ' ORDER BY nombre ASC';
      const rows = await query(sql, params);
      res.json(rows.map(mapEmployee));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/empleados', async (req, res) => {
    const { nombre, cedula, telefono, email, cargo, departamento, fechaIngreso, salarioBase, horario, userId } = req.body || {};
    if (!nombre) return res.status(400).json({ error: 'El nombre es requerido.' });
    try {
      const { insertId } = await query(`
        INSERT INTO hr_employees (user_id, nombre, cedula, telefono, email, cargo, departamento, fecha_ingreso, salario_base, horario)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [userId || null, nombre, cedula || null, telefono || null, email || null, cargo || null, departamento || null, fechaIngreso || null, salarioBase || null, horario || null]);
      const [created] = await query('SELECT * FROM hr_employees WHERE id=?', [insertId]);
      res.status(201).json(mapEmployee(created));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/empleados/:id', async (req, res) => {
    const id = Number(req.params.id);
    try {
      const [existing] = await query('SELECT * FROM hr_employees WHERE id=?', [id]);
      if (!existing) return res.status(404).json({ error: 'Empleado no encontrado.' });
      const b = req.body || {};
      await query(`
        UPDATE hr_employees
        SET nombre=?, cedula=?, telefono=?, email=?, cargo=?, departamento=?, fecha_ingreso=?, salario_base=?, horario=?, estado=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `, [
        b.nombre ?? existing.nombre,
        b.cedula ?? existing.cedula,
        b.telefono ?? existing.telefono,
        b.email ?? existing.email,
        b.cargo ?? existing.cargo,
        b.departamento ?? existing.departamento,
        b.fechaIngreso ?? existing.fecha_ingreso,
        b.salarioBase ?? existing.salario_base,
        b.horario ?? existing.horario,
        b.estado ?? existing.estado,
        id,
      ]);
      const [updated] = await query('SELECT * FROM hr_employees WHERE id=?', [id]);
      res.json(mapEmployee(updated));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/empleados/:id', async (req, res) => {
    try {
      await query('DELETE FROM hr_employees WHERE id=?', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Asistencia ───────────────────────────────────────────────────────────

  router.get('/asistencia', async (req, res) => {
    try {
      let sql = 'SELECT * FROM hr_attendance WHERE 1=1';
      const params = [];
      if (req.query.empleadoId) { sql += ' AND employee_id = ?'; params.push(req.query.empleadoId); }
      if (req.query.desde) { sql += ' AND fecha >= ?'; params.push(req.query.desde); }
      if (req.query.hasta) { sql += ' AND fecha <= ?'; params.push(req.query.hasta); }
      sql += ' ORDER BY fecha DESC';
      const rows = await query(sql, params);
      res.json(rows.map(mapAttendance));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/asistencia', async (req, res) => {
    const { employeeId, fecha, estado, horaEntrada, horaSalida, nota } = req.body || {};
    if (!employeeId || !fecha) return res.status(400).json({ error: 'employeeId y fecha son requeridos.' });
    if (!ASISTENCIA_ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado de asistencia inválido.' });
    try {
      const existing = await query('SELECT id FROM hr_attendance WHERE employee_id=? AND fecha=?', [employeeId, fecha]);
      if (existing.length) {
        await query(`
          UPDATE hr_attendance SET estado=?, hora_entrada=?, hora_salida=?, nota=? WHERE employee_id=? AND fecha=?
        `, [estado, horaEntrada || null, horaSalida || null, nota || null, employeeId, fecha]);
      } else {
        await query(`
          INSERT INTO hr_attendance (employee_id, fecha, estado, hora_entrada, hora_salida, nota)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [employeeId, fecha, estado, horaEntrada || null, horaSalida || null, nota || null]);
      }
      const [row] = await query('SELECT * FROM hr_attendance WHERE employee_id=? AND fecha=?', [employeeId, fecha]);
      res.status(201).json(mapAttendance(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Permisos ─────────────────────────────────────────────────────────────

  router.get('/permisos', async (req, res) => {
    try {
      let sql = 'SELECT * FROM hr_leave_requests WHERE 1=1';
      const params = [];
      if (req.query.empleadoId) { sql += ' AND employee_id = ?'; params.push(req.query.empleadoId); }
      if (req.query.estado) { sql += ' AND estado = ?'; params.push(req.query.estado); }
      sql += ' ORDER BY created_at DESC';
      const rows = await query(sql, params);
      res.json(rows.map(mapLeaveRequest));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/permisos', async (req, res) => {
    const { employeeId, tipo, fechaInicio, fechaFin, motivo } = req.body || {};
    if (!employeeId || !fechaInicio || !fechaFin) {
      return res.status(400).json({ error: 'employeeId, fechaInicio y fechaFin son requeridos.' });
    }
    if (!PERMISO_TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de permiso inválido.' });
    try {
      const { insertId } = await query(`
        INSERT INTO hr_leave_requests (employee_id, tipo, fecha_inicio, fecha_fin, motivo)
        VALUES (?, ?, ?, ?, ?)
      `, [employeeId, tipo, fechaInicio, fechaFin, motivo || null]);
      const [created] = await query('SELECT * FROM hr_leave_requests WHERE id=?', [insertId]);
      res.status(201).json(mapLeaveRequest(created));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/permisos/:id/aprobar', async (req, res) => {
    try {
      const [existing] = await query('SELECT * FROM hr_leave_requests WHERE id=?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Solicitud no encontrada.' });
      if (existing.estado !== 'pendiente') return res.status(400).json({ error: 'Esta solicitud ya fue resuelta.' });
      const actor = req.authUser;
      await query(`
        UPDATE hr_leave_requests SET estado='aprobado', aprobado_por_user_id=?, aprobado_por_nombre=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?
      `, [actor?.id || null, actor?.usuario || actor?.nombre || null, req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/permisos/:id/rechazar', async (req, res) => {
    try {
      const [existing] = await query('SELECT * FROM hr_leave_requests WHERE id=?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Solicitud no encontrada.' });
      if (existing.estado !== 'pendiente') return res.status(400).json({ error: 'Esta solicitud ya fue resuelta.' });
      const actor = req.authUser;
      await query(`
        UPDATE hr_leave_requests SET estado='rechazado', aprobado_por_user_id=?, aprobado_por_nombre=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?
      `, [actor?.id || null, actor?.usuario || actor?.nombre || null, req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createRrhhRouter, ensureSchema };

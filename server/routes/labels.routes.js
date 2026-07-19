'use strict';

/**
 * labels.routes.js — Centro de Etiquetas (Label Manager) v1
 * Factory pattern con inyección de dependencias.
 *
 * v1: plantillas fijas con campos on/off (sin editor visual libre) e
 * impresión vía diálogo nativo de Windows (sin comandos ZPL/EPL/TSPL).
 *
 * Rutas:
 *  GET    /api/labels/templates
 *  GET    /api/labels/templates/:id
 *  POST   /api/labels/templates
 *  PUT    /api/labels/templates/:id
 *  DELETE /api/labels/templates/:id
 *  POST   /api/labels/print-log
 *  GET    /api/labels/print-log
 *  GET    /api/labels/print-log/:id
 */

const express = require('express');

const TAMANOS_VALIDOS = ['30x20', '50x30'];

const PLANTILLAS_SISTEMA = [
  {
    slug: 'basica-precio',
    nombre: 'Básica: Nombre + Precio',
    descripcion: 'Precio grande y legible para góndola.',
    tamanoKey: '30x20',
    camposConfig: {
      mostrarNombre: true, fuenteNombrePx: 10,
      mostrarPrecio: true, fuentePrecioPx: 18,
      mostrarCodigo: true, fuenteCodigoPx: 8,
      mostrarBarcode: false, mostrarQR: false,
      mostrarMarca: false, mostrarCategoria: false,
    },
  },
  {
    slug: 'completa-barcode',
    nombre: 'Completa con código de barras',
    descripcion: 'Para reposición e inventario, escaneable en caja.',
    tamanoKey: '50x30',
    camposConfig: {
      mostrarNombre: true, fuenteNombrePx: 11,
      mostrarPrecio: true, fuentePrecioPx: 16,
      mostrarCodigo: true, fuenteCodigoPx: 9,
      mostrarBarcode: true, mostrarQR: false,
      mostrarMarca: true, fuenteMarcaPx: 8,
      mostrarCategoria: false,
    },
  },
  {
    slug: 'qr-info',
    nombre: 'QR + datos',
    descripcion: 'Incluye QR y categoría para productos con info ampliada.',
    tamanoKey: '50x30',
    camposConfig: {
      mostrarNombre: true, fuenteNombrePx: 10,
      mostrarPrecio: true, fuentePrecioPx: 14,
      mostrarCodigo: false, mostrarBarcode: false,
      mostrarQR: true,
      mostrarMarca: false,
      mostrarCategoria: true, fuenteCategoriaPx: 7,
    },
  },
];

async function ensureSchema(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS label_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug VARCHAR(60) NOT NULL UNIQUE,
      nombre VARCHAR(120) NOT NULL,
      descripcion VARCHAR(255) DEFAULT NULL,
      tamano_key VARCHAR(30) NOT NULL DEFAULT '50x30',
      campos_config TEXT NOT NULL DEFAULT '{}',
      activa TINYINT(1) NOT NULL DEFAULT 1,
      es_sistema TINYINT(1) NOT NULL DEFAULT 0,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS label_print_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INT DEFAULT NULL,
      template_nombre_snapshot VARCHAR(120) NOT NULL,
      tamano_key VARCHAR(30) NOT NULL,
      modo VARCHAR(20) NOT NULL DEFAULT 'rapida',
      total_etiquetas INT NOT NULL DEFAULT 0,
      total_productos INT NOT NULL DEFAULT 0,
      lineas TEXT NOT NULL,
      usuario_id INT DEFAULT NULL,
      usuario_nombre_snapshot VARCHAR(120) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_label_print_log_template FOREIGN KEY (template_id) REFERENCES label_templates(id) ON DELETE SET NULL
    )
  `);

  for (const t of PLANTILLAS_SISTEMA) {
    await query(`
      INSERT OR IGNORE INTO label_templates (slug, nombre, descripcion, tamano_key, campos_config, es_sistema)
      VALUES (?, ?, ?, ?, ?, 1)
    `, [t.slug, t.nombre, t.descripcion, t.tamanoKey, JSON.stringify(t.camposConfig)]);
  }

  await grantLabelsPermission(query);
}

// Otorga el permiso 'imprimir_etiquetas' al rol administrador_general si aún
// no lo tiene, sin tocar los demás permisos. Idempotente.
async function grantLabelsPermission(query) {
  const roles = await query(
    "SELECT id, codigo, permisos FROM roles WHERE codigo = 'administrador_general'"
  ).catch(() => []);
  for (const role of roles) {
    let perms = [];
    try { perms = JSON.parse(role.permisos || '[]'); } catch (_) { perms = []; }
    if (!Array.isArray(perms)) perms = [];
    if (perms.includes('imprimir_etiquetas')) continue;
    perms.push('imprimir_etiquetas');
    await query('UPDATE roles SET permisos = ? WHERE id = ?', [JSON.stringify(perms), role.id]).catch(() => {});
  }
}

function parseCamposConfig(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function mapTemplate(row) {
  return {
    id: row.id,
    slug: row.slug,
    nombre: row.nombre,
    descripcion: row.descripcion || '',
    tamanoKey: row.tamano_key,
    camposConfig: parseCamposConfig(row.campos_config),
    activa: Boolean(row.activa),
    esSistema: Boolean(row.es_sistema),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseLineas(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function mapPrintLogRow(row, { includeLineas } = {}) {
  const base = {
    id: row.id,
    templateId: row.template_id,
    templateNombreSnapshot: row.template_nombre_snapshot,
    tamanoKey: row.tamano_key,
    modo: row.modo,
    totalEtiquetas: row.total_etiquetas,
    totalProductos: row.total_productos,
    usuarioNombreSnapshot: row.usuario_nombre_snapshot,
    createdAt: row.created_at,
  };
  if (includeLineas) base.lineas = parseLineas(row.lineas);
  return base;
}

function createLabelsRouter({ query, resolveRequestActorUser, userRoleHasPermission }) {
  const router = express.Router();

  function canManageLabels(actor) {
    const roleCode = String(actor?.role_code || actor?.rol || '').trim().toLowerCase();
    if (roleCode === 'administrador_general') return true;
    return userRoleHasPermission(actor, 'imprimir_etiquetas');
  }

  async function requireLabels(req, res, next) {
    try {
      const actor = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
      if (!canManageLabels(actor)) {
        return res.status(403).json({ error: 'No tienes permiso para imprimir etiquetas.' });
      }
      req.authUser = actor;
      next();
    } catch (e) {
      res.status(401).json({ error: e.message || 'Sesión inválida o expirada.' });
    }
  }

  router.use(requireLabels);

  // ── Plantillas ───────────────────────────────────────────────────────────

  router.get('/templates', async (req, res) => {
    try {
      let sql = 'SELECT * FROM label_templates WHERE 1=1';
      const params = [];
      if (req.query.activa === '1') { sql += ' AND activa = 1'; }
      sql += ' ORDER BY es_sistema DESC, nombre ASC';
      const rows = await query(sql, params);
      res.json(rows.map(mapTemplate));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/templates/:id', async (req, res) => {
    try {
      const [row] = await query('SELECT * FROM label_templates WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Plantilla no encontrada.' });
      res.json(mapTemplate(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/templates', async (req, res) => {
    const { nombre, descripcion, tamanoKey, camposConfig } = req.body || {};
    if (!nombre) return res.status(400).json({ error: 'El nombre es requerido.' });
    if (!TAMANOS_VALIDOS.includes(tamanoKey)) {
      return res.status(400).json({ error: `Tamaño inválido. Usa: ${TAMANOS_VALIDOS.join(', ')}` });
    }
    try {
      const actor = req.authUser;
      const slug = `custom-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
      const { insertId } = await query(`
        INSERT INTO label_templates (slug, nombre, descripcion, tamano_key, campos_config, es_sistema, created_by_user_id, created_by_user_name)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `, [
        slug, nombre, descripcion || null, tamanoKey,
        JSON.stringify(camposConfig && typeof camposConfig === 'object' ? camposConfig : {}),
        actor?.id || null, actor?.usuario || actor?.nombre || null,
      ]);
      const [created] = await query('SELECT * FROM label_templates WHERE id=?', [insertId]);
      res.status(201).json(mapTemplate(created));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/templates/:id', async (req, res) => {
    try {
      const [existing] = await query('SELECT * FROM label_templates WHERE id=?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Plantilla no encontrada.' });
      if (existing.es_sistema) {
        return res.status(403).json({ error: 'Las plantillas predefinidas no se pueden editar. Duplícala para personalizarla.' });
      }
      const b = req.body || {};
      if (b.tamanoKey && !TAMANOS_VALIDOS.includes(b.tamanoKey)) {
        return res.status(400).json({ error: `Tamaño inválido. Usa: ${TAMANOS_VALIDOS.join(', ')}` });
      }
      await query(`
        UPDATE label_templates
        SET nombre=?, descripcion=?, tamano_key=?, campos_config=?, activa=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `, [
        b.nombre ?? existing.nombre,
        b.descripcion ?? existing.descripcion,
        b.tamanoKey ?? existing.tamano_key,
        b.camposConfig && typeof b.camposConfig === 'object' ? JSON.stringify(b.camposConfig) : existing.campos_config,
        b.activa === undefined ? existing.activa : (b.activa ? 1 : 0),
        req.params.id,
      ]);
      const [updated] = await query('SELECT * FROM label_templates WHERE id=?', [req.params.id]);
      res.json(mapTemplate(updated));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/templates/:id', async (req, res) => {
    try {
      const [existing] = await query('SELECT * FROM label_templates WHERE id=?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Plantilla no encontrada.' });
      if (existing.es_sistema) {
        return res.status(403).json({ error: 'Las plantillas predefinidas no se pueden eliminar.' });
      }
      await query('DELETE FROM label_templates WHERE id=?', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Historial de impresiones ────────────────────────────────────────────

  router.post('/print-log', async (req, res) => {
    const { templateId, tamanoKey, modo, lineas } = req.body || {};
    if (!Array.isArray(lineas) || !lineas.length) {
      return res.status(400).json({ error: 'lineas es requerido y debe tener al menos un producto.' });
    }
    if (!TAMANOS_VALIDOS.includes(tamanoKey)) {
      return res.status(400).json({ error: `Tamaño inválido. Usa: ${TAMANOS_VALIDOS.join(', ')}` });
    }
    try {
      let templateNombreSnapshot = 'Plantilla personalizada';
      if (templateId) {
        const [tpl] = await query('SELECT nombre FROM label_templates WHERE id=?', [templateId]);
        if (tpl) templateNombreSnapshot = tpl.nombre;
      }
      const totalEtiquetas = lineas.reduce((sum, l) => sum + (Number(l.cantidad) || 0), 0);
      const actor = req.authUser;
      const { insertId } = await query(`
        INSERT INTO label_print_log
          (template_id, template_nombre_snapshot, tamano_key, modo, total_etiquetas, total_productos, lineas, usuario_id, usuario_nombre_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        templateId || null, templateNombreSnapshot, tamanoKey, modo || 'rapida',
        totalEtiquetas, lineas.length, JSON.stringify(lineas),
        actor?.id || null, actor?.usuario || actor?.nombre || 'Usuario',
      ]);
      const [created] = await query('SELECT * FROM label_print_log WHERE id=?', [insertId]);
      res.status(201).json(mapPrintLogRow(created, { includeLineas: true }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/print-log', async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      let sql = 'SELECT * FROM label_print_log WHERE 1=1';
      const params = [];
      if (req.query.usuarioId) { sql += ' AND usuario_id = ?'; params.push(req.query.usuarioId); }
      sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      const rows = await query(sql, params);
      res.json(rows.map((r) => mapPrintLogRow(r)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/print-log/:id', async (req, res) => {
    try {
      const [row] = await query('SELECT * FROM label_print_log WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Registro no encontrado.' });
      res.json(mapPrintLogRow(row, { includeLineas: true }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createLabelsRouter, ensureSchema };

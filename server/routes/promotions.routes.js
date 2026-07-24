// ══════════════════════════════════════════════════════════════════════════════
//  promotions.routes.js — Tecno Caja
//  Centro de Promociones — Fase 1 (tipo "oferta_precio").
//  Factory pattern con DI, igual que delivery.routes.js / network.routes.js.
//  Montado en /api/promotions por server.js.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const {
  computePromotionStatus,
  resolveActivePromotions,
  resolveActiveQuantityRules,
} = require('../services/promotion-engine');

const PROMOTION_TIPOS = ['oferta_precio', 'descuento_por_cantidad'];

function createPromotionsRouter({ query, resolveRequestActorUser, userRoleHasPermission, ensurePromotionsExtensions }) {
  const router = express.Router();

  // Memoiza la creación de tablas/columnas — igual que ensureReady() en
  // network.routes.js, para no repetir los CREATE TABLE IF NOT EXISTS en
  // cada request.
  let _ready = false;
  async function ensureReady() {
    if (_ready) return;
    await ensurePromotionsExtensions();
    _ready = true;
  }
  router.use(async (req, res, next) => {
    try {
      await ensureReady();
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  function canManagePromotions(actor) {
    return userRoleHasPermission(actor, 'promociones');
  }

  function isAdminLevel(actor) {
    const roleCode = String(actor?.role_code || actor?.rol || '').trim().toLowerCase();
    return roleCode === 'administrador_general' || roleCode === 'administrador_sucursal';
  }

  async function requireManagePermission(req) {
    const actor = await resolveRequestActorUser(req, { required: true });
    if (!canManagePromotions(actor)) {
      const err = new Error('No tienes permiso para administrar promociones.');
      err.statusCode = 403;
      throw err;
    }
    return actor;
  }

  // Valida contra la pestaña Configuración (permitir permanentes / futuras) —
  // lanza un error 400 legible si la promoción que se intenta guardar viola
  // una regla que el administrador configuró.
  async function assertAgainstPromotionConfig({ permanente, fechaInicio }) {
    const rows = await query(
      'SELECT promotions_enabled, promotions_allow_permanent, promotions_allow_future FROM config WHERE id = 1 LIMIT 1',
    );
    const cfg = rows[0] || {};
    if (Number(cfg.promotions_enabled) === 0) {
      const err = new Error('Las promociones están desactivadas globalmente en Configuración.');
      err.statusCode = 400;
      throw err;
    }
    if (permanente && Number(cfg.promotions_allow_permanent) === 0) {
      const err = new Error('Las promociones permanentes están desactivadas en Configuración.');
      err.statusCode = 400;
      throw err;
    }
    if (fechaInicio && Number(cfg.promotions_allow_future) === 0) {
      const todayKey = new Date().toISOString().slice(0, 10);
      if (String(fechaInicio).slice(0, 10) > todayKey) {
        const err = new Error('Las promociones programadas a futuro están desactivadas en Configuración.');
        err.statusCode = 400;
        throw err;
      }
    }
  }

  async function nextCodigoInterno() {
    const rows = await query('SELECT COUNT(*) AS total FROM promotions');
    const next = Number(rows?.[0]?.total || 0) + 1;
    return `PROMO-${String(next).padStart(6, '0')}`;
  }

  async function writeAuditLog({ promotionId, nombre, accion, usuarioId, detalle }) {
    await query(
      `INSERT INTO promotion_audit_log (promotion_id, promotion_nombre_snapshot, accion, usuario_id, detalle)
       VALUES (?, ?, ?, ?, ?)`,
      [promotionId, nombre, accion, usuarioId || null, detalle ? JSON.stringify(detalle) : null],
    );
  }

  function mapPromotionRow(row) {
    return {
      id: row.id,
      codigoInterno: row.codigo_interno,
      nombre: row.nombre,
      tipo: row.tipo,
      descripcion: row.descripcion || '',
      deshabilitada: Number(row.deshabilitada) === 1,
      prioridad: Number(row.prioridad || 0),
      permanente: Number(row.permanente) === 1,
      fechaInicio: row.fecha_inicio,
      fechaFin: row.fecha_fin,
      horaInicio: row.hora_inicio,
      horaFin: row.hora_fin,
      color: row.color || '',
      textoPromocion: row.texto_promocion || '',
      acumulable: Number(row.acumulable) === 1,
      exclusiva: Number(row.exclusiva) === 1,
      sucursalId: row.sucursal_id,
      productoId: row.producto_id,
      productoNombre: row.producto_nombre,
      productoCodigo: row.producto_codigo,
      precioOriginal: row.precio_original !== undefined ? Number(row.precio_original) : null,
      precioPromocion: row.precio_promocion !== undefined ? Number(row.precio_promocion) : null,
      cantidadMinima: row.cantidad_minima !== undefined && row.cantidad_minima !== null ? Number(row.cantidad_minima) : null,
      estado: computePromotionStatus(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ── GET /api/promotions ──────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      await requireManagePermission(req);
      const rows = await query(
        `SELECT p.*, pp.producto_id, pp.precio_original, pp.precio_promocion, pp.cantidad_minima,
                pr.nombre AS producto_nombre, pr.codigo AS producto_codigo
         FROM promotions p
         LEFT JOIN promotion_products pp ON pp.promotion_id = p.id
         LEFT JOIN products pr ON pr.id = pp.producto_id
         ORDER BY p.created_at DESC`,
      );
      let promotions = rows.map(mapPromotionRow);
      const { estado } = req.query;
      if (estado) promotions = promotions.filter((p) => p.estado === estado);
      res.json({ promotions });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // ── GET /api/promotions/active-map ───────────────────────────────────────
  // Consumida por el POS (precio en el carrito) y por la caché offline —
  // requiere sesión válida, pero NO el permiso 'promociones' (cualquier
  // cajero necesita esto para que el precio se aplique correctamente).
  router.get('/active-map', async (req, res) => {
    try {
      await resolveRequestActorUser(req, { required: true });
      const sucursalId = req.query.sucursalId ? Number(req.query.sucursalId) : null;
      const [activeMap, quantityMap] = await Promise.all([
        resolveActivePromotions({ query, sucursalId }),
        resolveActiveQuantityRules({ query, sucursalId }),
      ]);
      res.json({ activeMap, quantityMap });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // ── GET /api/promotions/:id ──────────────────────────────────────────────
  router.get('/:id', async (req, res) => {
    try {
      await requireManagePermission(req);
      const rows = await query(
        `SELECT p.*, pp.producto_id, pp.precio_original, pp.precio_promocion, pp.cantidad_minima,
                pr.nombre AS producto_nombre, pr.codigo AS producto_codigo
         FROM promotions p
         LEFT JOIN promotion_products pp ON pp.promotion_id = p.id
         LEFT JOIN products pr ON pr.id = pp.producto_id
         WHERE p.id = ? LIMIT 1`,
        [req.params.id],
      );
      if (!rows.length) return res.status(404).json({ error: 'Promoción no encontrada.' });
      res.json({ promotion: mapPromotionRow(rows[0]) });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // ── POST /api/promotions ─────────────────────────────────────────────────
  router.post('/', async (req, res) => {
    try {
      const actor = await requireManagePermission(req);
      const body = req.body || {};

      const nombre = String(body.nombre || '').trim();
      const productoId = Number(body.productoId || 0);
      const precioPromocion = Number(body.precioPromocion);
      const tipo = String(body.tipo || 'oferta_precio').trim();
      if (!nombre) return res.status(400).json({ error: 'El nombre de la promoción es obligatorio.' });
      if (!PROMOTION_TIPOS.includes(tipo)) {
        return res.status(400).json({ error: 'Tipo de promoción no reconocido.' });
      }
      if (!productoId) return res.status(400).json({ error: 'Debes seleccionar un producto.' });
      if (!Number.isFinite(precioPromocion) || precioPromocion <= 0) {
        return res.status(400).json({ error: 'El precio de oferta debe ser mayor a 0.' });
      }

      let cantidadMinima = null;
      if (tipo === 'descuento_por_cantidad') {
        cantidadMinima = Number(body.cantidadMinima);
        if (!Number.isInteger(cantidadMinima) || cantidadMinima < 2) {
          return res.status(400).json({ error: 'La cantidad mínima debe ser un número entero de 2 o más.' });
        }
      }

      const productRows = await query(
        'SELECT id, nombre, precio_venta, precio_compra, branch_id FROM products WHERE id = ? LIMIT 1',
        [productoId],
      );
      if (!productRows.length) return res.status(404).json({ error: 'El producto seleccionado no existe.' });
      const product = productRows[0];

      const sucursalId = body.sucursalId ? Number(body.sucursalId) : null;
      if (sucursalId && product.branch_id && Number(product.branch_id) !== sucursalId) {
        return res.status(400).json({
          error: 'El producto seleccionado pertenece a otra sucursal — no coincide con la sucursal de esta promoción.',
        });
      }

      if (precioPromocion >= Number(product.precio_venta)) {
        return res.status(400).json({ error: 'El precio de oferta debe ser menor al precio normal del producto.' });
      }
      const cost = Number(product.precio_compra || 0);
      if (cost > 0 && precioPromocion < cost && !isAdminLevel(actor)) {
        return res.status(403).json({
          error: `El precio de oferta (RD$ ${precioPromocion.toFixed(2)}) queda por debajo del costo (RD$ ${cost.toFixed(2)}). Solo un administrador puede crear esta promoción.`,
        });
      }

      if (tipo === 'descuento_por_cantidad') {
        const existingRuleRows = await query(
          `SELECT p.id FROM promotions p JOIN promotion_products pp ON pp.promotion_id = p.id
           WHERE p.tipo = 'descuento_por_cantidad' AND p.deshabilitada = 0 AND pp.producto_id = ? LIMIT 1`,
          [productoId],
        );
        if (existingRuleRows.length) {
          return res.status(400).json({
            error: 'Este producto ya tiene un Descuento por Cantidad activo. Desactívalo o edítalo en vez de crear otro.',
          });
        }
      }

      const permanente = Boolean(body.permanente);
      await assertAgainstPromotionConfig({ permanente, fechaInicio: body.fechaInicio });
      const codigoInterno = await nextCodigoInterno();
      const result = await query(
        `INSERT INTO promotions
          (codigo_interno, nombre, tipo, descripcion, deshabilitada, prioridad, permanente,
           fecha_inicio, fecha_fin, hora_inicio, hora_fin, color, texto_promocion,
           acumulable, exclusiva, sucursal_id, creado_por, actualizado_por)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          codigoInterno,
          nombre,
          tipo,
          String(body.descripcion || '').trim() || null,
          Number(body.prioridad || 0),
          permanente ? 1 : 0,
          permanente ? null : (body.fechaInicio || null),
          permanente ? null : (body.fechaFin || null),
          body.horaInicio || null,
          body.horaFin || null,
          body.color || null,
          String(body.textoPromocion || '').trim() || null,
          body.acumulable ? 1 : 0,
          body.exclusiva ? 1 : 0,
          sucursalId,
          actor.id || null,
          actor.id || null,
        ],
      );
      const promotionId = Number(result.insertId);

      await query(
        `INSERT INTO promotion_products (promotion_id, producto_id, precio_original, precio_promocion, cantidad_minima)
         VALUES (?, ?, ?, ?, ?)`,
        [promotionId, productoId, Number(product.precio_venta), precioPromocion, cantidadMinima],
      );

      await writeAuditLog({
        promotionId,
        nombre,
        accion: 'creada',
        usuarioId: actor.id,
        detalle: { productoId, precioOriginal: Number(product.precio_venta), precioPromocion, tipo, cantidadMinima },
      });

      res.json({ ok: true, promotionId, codigoInterno });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // ── PUT /api/promotions/:id ──────────────────────────────────────────────
  router.put('/:id', async (req, res) => {
    try {
      const actor = await requireManagePermission(req);
      const promotionId = Number(req.params.id);
      const existingRows = await query('SELECT * FROM promotions WHERE id = ? LIMIT 1', [promotionId]);
      if (!existingRows.length) return res.status(404).json({ error: 'Promoción no encontrada.' });
      const existing = existingRows[0];
      const body = req.body || {};

      const nombre = String(body.nombre || '').trim();
      const precioPromocion = Number(body.precioPromocion);
      const tipo = existing.tipo || 'oferta_precio'; // el tipo es inmutable tras crear la promoción — se ignora body.tipo
      if (!nombre) return res.status(400).json({ error: 'El nombre de la promoción es obligatorio.' });
      if (!Number.isFinite(precioPromocion) || precioPromocion <= 0) {
        return res.status(400).json({ error: 'El precio de oferta debe ser mayor a 0.' });
      }

      let cantidadMinima = null;
      if (tipo === 'descuento_por_cantidad') {
        cantidadMinima = Number(body.cantidadMinima);
        if (!Number.isInteger(cantidadMinima) || cantidadMinima < 2) {
          return res.status(400).json({ error: 'La cantidad mínima debe ser un número entero de 2 o más.' });
        }
      }

      const productRows = await query(
        'SELECT producto_id FROM promotion_products WHERE promotion_id = ? LIMIT 1',
        [promotionId],
      );
      if (!productRows.length) return res.status(404).json({ error: 'La promoción no tiene producto asociado.' });
      const productoId = Number(productRows[0].producto_id);

      const productInfoRows = await query(
        'SELECT nombre, precio_venta, precio_compra, branch_id FROM products WHERE id = ? LIMIT 1',
        [productoId],
      );
      const product = productInfoRows[0];
      if (!product) return res.status(404).json({ error: 'El producto de esta promoción ya no existe.' });

      const sucursalId = body.sucursalId ? Number(body.sucursalId) : null;
      if (sucursalId && product.branch_id && Number(product.branch_id) !== sucursalId) {
        return res.status(400).json({
          error: 'El producto de esta promoción pertenece a otra sucursal — no coincide con la sucursal que quieres asignarle.',
        });
      }

      if (precioPromocion >= Number(product.precio_venta)) {
        return res.status(400).json({ error: 'El precio de oferta debe ser menor al precio normal del producto.' });
      }
      const cost = Number(product.precio_compra || 0);
      if (cost > 0 && precioPromocion < cost && !isAdminLevel(actor)) {
        return res.status(403).json({
          error: `El precio de oferta (RD$ ${precioPromocion.toFixed(2)}) queda por debajo del costo (RD$ ${cost.toFixed(2)}). Solo un administrador puede editar esta promoción por debajo del costo.`,
        });
      }

      const permanente = Boolean(body.permanente);
      await assertAgainstPromotionConfig({ permanente, fechaInicio: body.fechaInicio });
      await query(
        `UPDATE promotions SET
           nombre = ?, descripcion = ?, prioridad = ?, permanente = ?,
           fecha_inicio = ?, fecha_fin = ?, hora_inicio = ?, hora_fin = ?,
           color = ?, texto_promocion = ?, acumulable = ?, exclusiva = ?,
           sucursal_id = ?, actualizado_por = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          nombre,
          String(body.descripcion || '').trim() || null,
          Number(body.prioridad || 0),
          permanente ? 1 : 0,
          permanente ? null : (body.fechaInicio || null),
          permanente ? null : (body.fechaFin || null),
          body.horaInicio || null,
          body.horaFin || null,
          body.color || null,
          String(body.textoPromocion || '').trim() || null,
          body.acumulable ? 1 : 0,
          body.exclusiva ? 1 : 0,
          sucursalId,
          actor.id || null,
          promotionId,
        ],
      );
      await query(
        'UPDATE promotion_products SET precio_original = ?, precio_promocion = ?, cantidad_minima = ? WHERE promotion_id = ?',
        [Number(product.precio_venta), precioPromocion, cantidadMinima, promotionId],
      );

      await writeAuditLog({
        promotionId,
        nombre,
        accion: 'editada',
        usuarioId: actor.id,
        detalle: { precioOriginal: Number(product.precio_venta), precioPromocion },
      });

      res.json({ ok: true });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // ── POST /api/promotions/:id/toggle ──────────────────────────────────────
  router.post('/:id/toggle', async (req, res) => {
    try {
      const actor = await requireManagePermission(req);
      const promotionId = Number(req.params.id);
      const rows = await query('SELECT id, nombre, deshabilitada FROM promotions WHERE id = ? LIMIT 1', [promotionId]);
      if (!rows.length) return res.status(404).json({ error: 'Promoción no encontrada.' });
      const nextDisabled = Number(rows[0].deshabilitada) === 1 ? 0 : 1;
      await query('UPDATE promotions SET deshabilitada = ?, actualizado_por = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [nextDisabled, actor.id || null, promotionId]);
      await writeAuditLog({
        promotionId,
        nombre: rows[0].nombre,
        accion: nextDisabled ? 'desactivada' : 'activada',
        usuarioId: actor.id,
      });
      res.json({ ok: true, deshabilitada: Boolean(nextDisabled) });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // ── DELETE /api/promotions/:id ───────────────────────────────────────────
  router.delete('/:id', async (req, res) => {
    try {
      const actor = await requireManagePermission(req);
      const promotionId = Number(req.params.id);
      const rows = await query('SELECT id, nombre FROM promotions WHERE id = ? LIMIT 1', [promotionId]);
      if (!rows.length) return res.status(404).json({ error: 'Promoción no encontrada.' });

      await writeAuditLog({
        promotionId,
        nombre: rows[0].nombre,
        accion: 'eliminada',
        usuarioId: actor.id,
      });
      await query('DELETE FROM promotion_products WHERE promotion_id = ?', [promotionId]);
      await query('DELETE FROM promotions WHERE id = ?', [promotionId]);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // ── GET /api/promotions/:id/audit-log ────────────────────────────────────
  router.get('/:id/audit-log', async (req, res) => {
    try {
      await requireManagePermission(req);
      const rows = await query(
        `SELECT al.*, u.nombre AS usuario_nombre
         FROM promotion_audit_log al
         LEFT JOIN users u ON u.id = al.usuario_id
         WHERE al.promotion_id = ?
         ORDER BY al.created_at DESC`,
        [req.params.id],
      );
      res.json({
        entries: rows.map((r) => ({
          id: r.id,
          accion: r.accion,
          usuario: r.usuario_nombre || 'Sistema',
          detalle: r.detalle ? JSON.parse(r.detalle) : null,
          createdAt: r.created_at,
        })),
      });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // ── GET /api/promotions/reports/audit-log ────────────────────────────────
  // Historial combinado de TODAS las promociones (creadas/editadas/activadas/
  // desactivadas/eliminadas) — a diferencia de /:id/audit-log que es por una
  // sola promoción. Nunca se borra, ni siquiera si la promoción se elimina.
  router.get('/reports/audit-log', async (req, res) => {
    try {
      await requireManagePermission(req);
      const rows = await query(
        `SELECT al.*, u.nombre AS usuario_nombre
         FROM promotion_audit_log al
         LEFT JOIN users u ON u.id = al.usuario_id
         ORDER BY al.created_at DESC LIMIT 300`,
      );
      res.json({
        entries: rows.map((r) => ({
          id: r.id,
          promotionId: r.promotion_id,
          promotionNombre: r.promotion_nombre_snapshot,
          accion: r.accion,
          usuario: r.usuario_nombre || 'Sistema',
          detalle: r.detalle ? JSON.parse(r.detalle) : null,
          createdAt: r.created_at,
        })),
      });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // ── GET /api/promotions/dashboard ────────────────────────────────────────
  router.get('/reports/dashboard', async (req, res) => {
    try {
      await requireManagePermission(req);

      const allPromos = await query('SELECT * FROM promotions');
      const withStatus = allPromos.map((p) => ({ ...p, estado: computePromotionStatus(p) }));
      const activeMap = await resolveActivePromotions({ query });
      const productosEnPromocion = Object.keys(activeMap).length;

      const [salesAgg] = await query(
        `SELECT COUNT(DISTINCT sale_id) AS ventasConPromo,
                COUNT(DISTINCT s.client_id) AS clientesBeneficiados,
                SUM((si.original_price - si.price) * si.qty) AS montoDescontado,
                SUM((si.price - COALESCE(pr.precio_compra, 0)) * si.qty) AS gananciaObtenida
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN products pr ON pr.id = si.product_id
         WHERE si.promotion_id IS NOT NULL`,
      );

      const topPromoRows = await query(
        `SELECT p.id, p.nombre, COUNT(*) AS ventas
         FROM sale_items si
         JOIN promotions p ON p.id = si.promotion_id
         WHERE si.promotion_id IS NOT NULL
         GROUP BY p.id, p.nombre
         ORDER BY ventas DESC LIMIT 1`,
      );

      const proximaVencer = withStatus
        .filter((p) => p.estado === 'activa' && !p.permanente && p.fecha_fin)
        .sort((a, b) => new Date(a.fecha_fin) - new Date(b.fecha_fin))[0] || null;

      res.json({
        promocionesActivas: withStatus.filter((p) => p.estado === 'activa').length,
        promocionesProgramadas: withStatus.filter((p) => p.estado === 'programada').length,
        promocionesVencidas: withStatus.filter((p) => p.estado === 'vencida').length,
        promocionesPermanentes: withStatus.filter((p) => Number(p.permanente) === 1).length,
        productosEnPromocion,
        ventasConPromo: Number(salesAgg?.ventasConPromo || 0),
        clientesBeneficiados: Number(salesAgg?.clientesBeneficiados || 0),
        montoDescontado: Number(salesAgg?.montoDescontado || 0),
        gananciaObtenida: Number(salesAgg?.gananciaObtenida || 0),
        promocionMasUtilizada: topPromoRows[0] ? { id: topPromoRows[0].id, nombre: topPromoRows[0].nombre, ventas: Number(topPromoRows[0].ventas) } : null,
        promocionProximaVencer: proximaVencer ? { id: proximaVencer.id, nombre: proximaVencer.nombre, fechaFin: proximaVencer.fecha_fin } : null,
      });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // ── GET /api/promotions/reports/stats ────────────────────────────────────
  router.get('/reports/stats', async (req, res) => {
    try {
      await requireManagePermission(req);

      const rows = await query(
        `SELECT p.id, p.codigo_interno, p.nombre,
                COUNT(*) AS ventas,
                SUM(si.qty) AS unidadesVendidas,
                SUM((si.original_price - si.price) * si.qty) AS montoDescontado,
                SUM((si.price - COALESCE(pr.precio_compra, 0)) * si.qty) AS gananciaGenerada,
                COUNT(DISTINCT s.client_id) AS clientesBeneficiados,
                pr.nombre AS productoNombre
         FROM sale_items si
         JOIN promotions p ON p.id = si.promotion_id
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN products pr ON pr.id = si.product_id
         WHERE si.promotion_id IS NOT NULL
         GROUP BY p.id, p.codigo_interno, p.nombre, pr.nombre
         ORDER BY ventas DESC`,
      );

      const allPromoIds = (await query('SELECT id, nombre, codigo_interno FROM promotions'));
      const usedIds = new Set(rows.map((r) => Number(r.id)));
      const neverUsed = allPromoIds.filter((p) => !usedIds.has(Number(p.id)));

      res.json({
        promotions: rows.map((r) => ({
          id: r.id,
          codigoInterno: r.codigo_interno,
          nombre: r.nombre,
          producto: r.productoNombre || '',
          ventas: Number(r.ventas || 0),
          unidadesVendidas: Number(r.unidadesVendidas || 0),
          montoDescontado: Number(r.montoDescontado || 0),
          gananciaGenerada: Number(r.gananciaGenerada || 0),
          clientesBeneficiados: Number(r.clientesBeneficiados || 0),
        })),
        neverUsed: neverUsed.map((p) => ({ id: p.id, nombre: p.nombre, codigoInterno: p.codigo_interno })),
      });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // ── GET/PUT /api/promotions/config ───────────────────────────────────────
  router.get('/settings/config', async (req, res) => {
    try {
      await requireManagePermission(req);
      const rows = await query(
        `SELECT promotions_enabled, promotions_allow_permanent, promotions_allow_future,
                promotions_default_priority, promotions_default_color
         FROM config WHERE id = 1 LIMIT 1`,
      );
      const cfg = rows[0] || {};
      res.json({
        enabled: cfg.promotions_enabled === undefined ? true : Boolean(cfg.promotions_enabled),
        allowPermanent: cfg.promotions_allow_permanent === undefined ? true : Boolean(cfg.promotions_allow_permanent),
        allowFuture: cfg.promotions_allow_future === undefined ? true : Boolean(cfg.promotions_allow_future),
        defaultPriority: Number(cfg.promotions_default_priority ?? 0),
        defaultColor: cfg.promotions_default_color || '#22c55e',
      });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.put('/settings/config', async (req, res) => {
    try {
      await requireManagePermission(req);
      const body = req.body || {};
      await query(
        `UPDATE config SET
           promotions_enabled = ?, promotions_allow_permanent = ?, promotions_allow_future = ?,
           promotions_default_priority = ?, promotions_default_color = ?
         WHERE id = 1`,
        [
          body.enabled ? 1 : 0,
          body.allowPermanent ? 1 : 0,
          body.allowFuture ? 1 : 0,
          Number(body.defaultPriority || 0),
          body.defaultColor || '#22c55e',
        ],
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createPromotionsRouter;

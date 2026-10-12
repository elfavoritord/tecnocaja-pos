// ══════════════════════════════════════════════════════════════════════════════
//  tienda-online.routes.js — Tecno Caja
//  Tienda Online: configuración, productos publicados y Pedidos Online.
//  Factory con DI (mismo patrón que promotions.routes.js). Montado en
//  /api/tienda-online por server.js. La lógica vive en server/tienda-online/.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { ESTADOS, ESTADO_ETIQUETAS, METODOS_PAGO, MAX_FOTOS_PRODUCTO, normalizarSlug } = require('../tienda-online/contrato');
const { leerFotosExtra } = require('../tienda-online/fotos');

const STOCK_MODES = ['inventario', 'ilimitado'];

function createTiendaOnlineRouter({
  tienda,
  resolveRequestActorUser,
  isGlobalAdministratorUser,
  userRoleHasPermission,
  userCanManageProductCatalog = () => false,
  getUserScopeBranchId = () => null,
  writeAuditLog = async () => {},
  processBannerImage = null,
  query,
  nowSql,
}) {
  const router = express.Router();
  router.use(express.json({ limit: '8mb' }));

  router.use(async (req, res, next) => {
    try {
      await tienda.ensureReady();
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  function wrap(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        const status = Number(error.statusCode || 500);
        if (status >= 500) console.error('[tienda-online]', error);
        res.status(status).json({
          error: error.message || 'Error inesperado.',
          code: error.code || undefined,
          avisos: error.avisos || undefined,
          por: error.por || undefined,
        });
      }
    };
  }

  function forbidden(message) {
    const error = new Error(message);
    error.statusCode = 403;
    return error;
  }

  function canConfigure(actor) {
    return isGlobalAdministratorUser(actor) || userRoleHasPermission(actor, 'tienda_online', 'gestionar_configuracion_global');
  }

  function canPublishProducts(actor) {
    return canConfigure(actor) || userCanManageProductCatalog(actor);
  }

  async function requireActor(req) {
    return resolveRequestActorUser(req, { required: true });
  }

  async function requireConfig(req) {
    const actor = await requireActor(req);
    if (!canConfigure(actor)) throw forbidden('Solo el administrador puede configurar la tienda online.');
    return actor;
  }

  function actorName(actor) {
    return actor?.nombre || actor?.usuario || 'Sistema';
  }

  function audit(actor, actionName, detail) {
    writeAuditLog({
      userId: actor?.id || null,
      userName: actorName(actor),
      userRole: actor?.role_name || actor?.rol || 'Sistema',
      moduleName: 'Tienda online',
      actionName,
      detail,
    }).catch(() => {});
  }

  // ── Estado y configuración ───────────────────────────────────────────────

  router.get('/estado', wrap(async (req, res) => {
    await requireActor(req);
    res.json(await tienda.getStatus());
  }));

  router.get('/config', wrap(async (req, res) => {
    await requireConfig(req);
    const store = await tienda.settingsStore.read();
    const branches = await query(`SELECT id, nombre, estado FROM branches WHERE estado <> 'Eliminada' ORDER BY id`);
    const categorias = await query('SELECT DISTINCT categoria FROM products ORDER BY categoria');
    res.json({
      ...store,
      url: tienda.publicUrl(store.slug),
      metodosPago: METODOS_PAGO,
      sucursales: branches.map((b) => ({ id: Number(b.id), nombre: b.nombre })),
      categorias: categorias.map((c) => c.categoria).filter(Boolean),
      estado: await tienda.getStatus(),
    });
  }));

  router.put('/config', wrap(async (req, res) => {
    const actor = await requireConfig(req);
    const before = await tienda.settingsStore.read();
    const body = req.body || {};
    const saved = await tienda.settingsStore.write({
      enabled: body.enabled,
      slug: body.slug,
      branchId: body.branchId,
      settings: body.settings,
    }, { userName: actorName(actor) });

    // Reservar el nombre de una vez (si hay Internet) para avisar ya si está ocupado.
    let aviso = null;
    if (saved.enabled && saved.slug && saved.slug !== before.slug) {
      try {
        const claim = await tienda.nube.claimSlug(saved.slug, { previousSlug: before.slug || '', sucursalId: saved.branchId });
        if (!claim.ok) {
          await tienda.settingsStore.write({ slug: before.slug || '', enabled: before.enabled }, { userName: actorName(actor) });
          const error = new Error(`La dirección "${saved.slug}" ya la usa otro negocio. Elige otra.`);
          error.statusCode = 409;
          error.code = 'SLUG_EN_USO';
          throw error;
        }
        tienda.publisher.reset();
      } catch (error) {
        if (error.code === 'SLUG_EN_USO') throw error;
        aviso = 'Guardado. La dirección se confirmará cuando haya Internet.';
      }
    }
    if (before.enabled !== saved.enabled) {
      audit(actor, saved.enabled ? 'Tienda online activada' : 'Tienda online desactivada', saved.slug || '');
    } else {
      audit(actor, 'Configuración de tienda online guardada', saved.slug || '');
    }
    tienda.publisher.run({ force: true }).catch(() => {});
    res.json({ ...saved, url: tienda.publicUrl(saved.slug), aviso });
  }));

  router.post('/config/banner', wrap(async (req, res) => {
    const actor = await requireConfig(req);
    const dataUrl = String(req.body?.dataUrl || '');
    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(dataUrl)) {
      const error = new Error('Sube una imagen PNG, JPG o WEBP.');
      error.statusCode = 400;
      throw error;
    }
    const optimized = processBannerImage ? await processBannerImage(dataUrl) : dataUrl;
    await tienda.settingsStore.writeBanner(optimized);
    audit(actor, 'Banner de tienda online cambiado', '');
    tienda.publisher.run({ force: true }).catch(() => {});
    res.json({ ok: true, banner: optimized });
  }));

  router.delete('/config/banner', wrap(async (req, res) => {
    const actor = await requireConfig(req);
    await tienda.settingsStore.writeBanner(null);
    audit(actor, 'Banner de tienda online quitado', '');
    tienda.publisher.run({ force: true }).catch(() => {});
    res.json({ ok: true });
  }));

  router.get('/config/banner', wrap(async (req, res) => {
    await requireConfig(req);
    res.json({ banner: await tienda.settingsStore.readBanner() });
  }));

  router.get('/slug-sugerido', wrap(async (req, res) => {
    await requireConfig(req);
    res.json({ slug: normalizarSlug(req.query.nombre || '') });
  }));

  router.post('/publicar', wrap(async (req, res) => {
    await requireConfig(req);
    const result = await tienda.publisher.run({ force: true });
    res.json({ ...result, estado: await tienda.getStatus() });
  }));

  router.post('/sincronizar', wrap(async (req, res) => {
    await requireActor(req);
    await tienda.sync.runAll();
    res.json(await tienda.getStatus());
  }));

  // ── Productos publicados ─────────────────────────────────────────────────

  router.get('/productos', wrap(async (req, res) => {
    const actor = await requireActor(req);
    if (!canPublishProducts(actor)) throw forbidden('No tienes permiso para publicar productos.');
    const buscar = String(req.query.buscar || '').trim().slice(0, 80);
    const categoria = String(req.query.categoria || '').trim().slice(0, 60);
    const filtro = String(req.query.filtro || 'todos');
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
    const page = Math.max(1, Number(req.query.page) || 1);
    let where = `WHERE estado <> 'Eliminado'`;
    const params = [];
    if (buscar) {
      where += ' AND (nombre LIKE ? OR codigo LIKE ?)';
      params.push(`%${buscar}%`, `%${buscar}%`);
    }
    if (categoria) { where += ' AND categoria = ?'; params.push(categoria); }
    if (filtro === 'publicados') where += ' AND online_enabled = 1';
    if (filtro === 'no_publicados') where += ' AND online_enabled = 0';
    if (filtro === 'destacados') where += ' AND online_featured = 1';
    const rows = await query(
      `SELECT id, codigo, nombre, categoria, precio_venta, estado, stock, tracks_stock,
              online_enabled, online_description, online_featured, online_order, online_stock_mode, online_images,
              CASE WHEN image_local IS NOT NULL OR image_url IS NOT NULL THEN 1 ELSE 0 END AS tiene_imagen
         FROM products ${where}
        ORDER BY online_enabled DESC, categoria, nombre
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params,
    );
    const total = await query(`SELECT COUNT(*) AS n FROM products ${where}`, params);
    const publicados = await query('SELECT COUNT(*) AS n FROM products WHERE online_enabled = 1');
    res.json({
      productos: rows.map((r) => ({
        id: Number(r.id),
        codigo: r.codigo,
        nombre: r.nombre,
        categoria: r.categoria,
        precio: Number(r.precio_venta || 0),
        activo: String(r.estado || 'Activo') === 'Activo',
        stock: Number(r.stock || 0),
        controlaStock: Number(r.tracks_stock ?? 1) !== 0,
        publicado: Number(r.online_enabled || 0) === 1,
        descripcion: r.online_description || '',
        destacado: Number(r.online_featured || 0) === 1,
        orden: Number(r.online_order || 0),
        modoExistencia: r.online_stock_mode || 'inventario',
        tieneImagen: Number(r.tiene_imagen || 0) === 1,
        fotosExtra: leerFotosExtra(r.online_images).length,
      })),
      total: Number(total[0]?.n || 0),
      publicados: Number(publicados[0]?.n || 0),
      page,
      limit,
    });
  }));

  router.get('/productos/:id', wrap(async (req, res) => {
    await requireActor(req);
    const rows = await query(
      `SELECT id, online_enabled, online_description, online_featured, online_order, online_stock_mode,
              online_images, image_local, image_url
         FROM products WHERE id = ? LIMIT 1`,
      [Number(req.params.id)],
    );
    if (!rows[0]) {
      const error = new Error('Producto no encontrado.');
      error.statusCode = 404;
      throw error;
    }
    const r = rows[0];
    res.json({
      id: Number(r.id),
      publicado: Number(r.online_enabled || 0) === 1,
      descripcion: r.online_description || '',
      destacado: Number(r.online_featured || 0) === 1,
      orden: Number(r.online_order || 0),
      modoExistencia: r.online_stock_mode || 'inventario',
      // La principal es la del producto (la misma que publica catalog.js).
      fotoPrincipal: r.image_local || (/^https:\/\//i.test(String(r.image_url || '')) ? r.image_url : null),
      tieneFotoPrincipal: Boolean(r.image_local || r.image_url),
      fotos: leerFotosExtra(r.online_images),
      maxFotos: MAX_FOTOS_PRODUCTO - 1,
    });
  }));

  // ── Fotos adicionales del producto (carrusel de la tienda) ──────────────

  async function requireFotos(req) {
    const actor = await requireActor(req);
    if (!canPublishProducts(actor)) throw forbidden('No tienes permiso para cambiar las fotos de la tienda.');
    return actor;
  }

  function trasCambioDeFotos(actor, accion, r) {
    audit(actor, accion, r.producto.nombre);
    tienda.publisher.run({ force: true }).catch(() => {});
    return { fotos: r.fotos, maxFotos: r.max };
  }

  router.post('/productos/:id/fotos', wrap(async (req, res) => {
    const actor = await requireFotos(req);
    const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(String(req.body?.dataUrl || ''));
    if (!match) {
      const error = new Error('Sube una imagen PNG, JPG o WEBP.');
      error.statusCode = 400;
      throw error;
    }
    const r = await tienda.fotos.agregar(Number(req.params.id), Buffer.from(match[2], 'base64'));
    res.json(trasCambioDeFotos(actor, 'Foto agregada a la tienda online', r));
  }));

  router.delete('/productos/:id/fotos/:n', wrap(async (req, res) => {
    const actor = await requireFotos(req);
    const r = await tienda.fotos.quitar(Number(req.params.id), Number(req.params.n));
    res.json(trasCambioDeFotos(actor, 'Foto quitada de la tienda online', r));
  }));

  router.post('/productos/:id/fotos/:n/mover', wrap(async (req, res) => {
    const actor = await requireFotos(req);
    const r = await tienda.fotos.mover(Number(req.params.id), Number(req.params.n), Number(req.body?.dir));
    res.json(trasCambioDeFotos(actor, 'Orden de fotos de la tienda online cambiado', r));
  }));

  router.put('/productos/:id', wrap(async (req, res) => {
    const actor = await requireActor(req);
    if (!canPublishProducts(actor)) throw forbidden('No tienes permiso para publicar productos.');
    const id = Number(req.params.id);
    const rows = await query('SELECT id, nombre FROM products WHERE id = ? LIMIT 1', [id]);
    if (!rows[0]) {
      const error = new Error('Producto no encontrado.');
      error.statusCode = 404;
      throw error;
    }
    const body = req.body || {};
    const sets = [];
    const params = [];
    if (body.publicado !== undefined) { sets.push('online_enabled = ?'); params.push(body.publicado ? 1 : 0); }
    if (body.descripcion !== undefined) { sets.push('online_description = ?'); params.push(String(body.descripcion || '').trim().slice(0, 500) || null); }
    if (body.destacado !== undefined) { sets.push('online_featured = ?'); params.push(body.destacado ? 1 : 0); }
    if (body.orden !== undefined) { sets.push('online_order = ?'); params.push(Math.max(-9999, Math.min(9999, Math.round(Number(body.orden) || 0)))); }
    if (body.modoExistencia !== undefined) {
      sets.push('online_stock_mode = ?');
      params.push(STOCK_MODES.includes(body.modoExistencia) ? body.modoExistencia : 'inventario');
    }
    if (sets.length) {
      await query(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
      if (body.publicado !== undefined) {
        audit(actor, body.publicado ? 'Producto publicado en tienda online' : 'Producto quitado de la tienda online', rows[0].nombre);
      }
      tienda.publisher.run({ force: true }).catch(() => {});
    }
    res.json({ ok: true });
  }));

  router.post('/productos/masivo', wrap(async (req, res) => {
    const actor = await requireActor(req);
    if (!canPublishProducts(actor)) throw forbidden('No tienes permiso para publicar productos.');
    const accion = String(req.body?.accion || '');
    const acciones = {
      publicar: 'online_enabled = 1',
      ocultar: 'online_enabled = 0',
      destacar: 'online_featured = 1',
      quitar_destacado: 'online_featured = 0',
    };
    if (!acciones[accion]) {
      const error = new Error('Acción no válida.');
      error.statusCode = 400;
      throw error;
    }
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n) => n > 0).slice(0, 2000);
    const categoria = String(req.body?.categoria || '').trim();
    let result;
    if (ids.length) {
      result = await query(`UPDATE products SET ${acciones[accion]} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    } else if (categoria) {
      result = await query(`UPDATE products SET ${acciones[accion]} WHERE categoria = ? AND estado = 'Activo'`, [categoria]);
    } else if (req.body?.todos === true && accion === 'publicar') {
      result = await query(`UPDATE products SET ${acciones[accion]} WHERE estado = 'Activo'`);
    } else {
      const error = new Error('Indica los productos o la categoría.');
      error.statusCode = 400;
      throw error;
    }
    audit(actor, 'Publicación masiva en tienda online', `${accion} · ${categoria || `${ids.length} producto(s)`}`);
    tienda.publisher.run({ force: true }).catch(() => {});
    res.json({ ok: true, cambiados: Number(result?.affectedRows || 0) });
  }));

  // ── Pedidos online ───────────────────────────────────────────────────────

  function scopeBranch(actor) {
    return getUserScopeBranchId(actor) || null;
  }

  async function assertOrderInScope(actor, id) {
    const row = await tienda.orders.getRow(id);
    if (!row) {
      const error = new Error('Pedido no encontrado.');
      error.statusCode = 404;
      throw error;
    }
    const scope = scopeBranch(actor);
    if (scope && row.branch_id && Number(row.branch_id) !== Number(scope)) {
      throw forbidden('Este pedido es de otra sucursal.');
    }
    return row;
  }

  router.get('/pedidos/resumen', wrap(async (req, res) => {
    const actor = await requireActor(req);
    const store = await tienda.settingsStore.read();
    res.json({ activa: store.enabled, ...(await tienda.orders.summary({ branchId: scopeBranch(actor) })) });
  }));

  router.get('/pedidos', wrap(async (req, res) => {
    const actor = await requireActor(req);
    const result = await tienda.orders.list({
      estado: String(req.query.estado || ''),
      desde: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.desde || '')) ? req.query.desde : '',
      hasta: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.hasta || '')) ? req.query.hasta : '',
      buscar: String(req.query.buscar || ''),
      branchId: scopeBranch(actor),
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ ...result, estados: ESTADO_ETIQUETAS });
  }));

  router.get('/pedidos/:id', wrap(async (req, res) => {
    const actor = await requireActor(req);
    await assertOrderInScope(actor, Number(req.params.id));
    const branchId = Number(req.query.branchId || 0) || scopeBranch(actor);
    res.json(await tienda.orders.get(Number(req.params.id), { branchId }));
  }));

  router.post('/pedidos/:id/estado', wrap(async (req, res) => {
    const actor = await requireActor(req);
    const id = Number(req.params.id);
    await assertOrderInScope(actor, id);
    const estado = String(req.body?.estado || '');
    if (!Object.values(ESTADOS).includes(estado)) {
      const error = new Error('Estado no válido.');
      error.statusCode = 400;
      throw error;
    }
    const pedido = await tienda.orders.changeStatus(id, estado, { motivo: req.body?.motivo || '', actor });
    audit(actor, 'Estado de pedido online', `#${pedido.numero} → ${ESTADO_ETIQUETAS[estado]}`);
    tienda.sync.pushOnce().catch(() => {});
    res.json(pedido);
  }));

  router.post('/pedidos/:id/preparar-venta', wrap(async (req, res) => {
    const actor = await requireActor(req);
    const id = Number(req.params.id);
    await assertOrderInScope(actor, id);
    const draft = await tienda.orders.prepareForSale(id, {
      actor,
      branchId: Number(req.body?.branchId || 0) || scopeBranch(actor),
      force: req.body?.forzar === true,
    });
    res.json(draft);
  }));

  router.post('/pedidos/:id/liberar', wrap(async (req, res) => {
    const actor = await requireActor(req);
    const id = Number(req.params.id);
    await assertOrderInScope(actor, id);
    await tienda.orders.releaseLock(id, actor, { anyUser: canConfigure(actor) && req.body?.forzar === true });
    res.json({ ok: true });
  }));

  // ── Reportes ─────────────────────────────────────────────────────────────

  router.get('/reportes', wrap(async (req, res) => {
    const actor = await requireActor(req);
    const today = nowSql().slice(0, 10);
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.desde || '')) ? req.query.desde : `${today.slice(0, 8)}01`;
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.hasta || '')) ? req.query.hasta : today;
    res.json(await tienda.orders.stats({ desde, hasta, branchId: scopeBranch(actor) }));
  }));

  return router;
}

module.exports = createTiendaOnlineRouter;

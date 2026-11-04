// ══════════════════════════════════════════════════════════════════════════════
//  combos-personalizados.routes.js — Tecno Caja
//  Combos personalizados de precio fijo. Factory con dependencias inyectadas,
//  igual que combos.routes.js. Montado en /api/combos-personalizados.
//
//  La venta NO pasa por aquí: POST /api/sales recibe las líneas del combo
//  marcadas con `comboPersonalizado` y las valida con
//  combos-personalizados.service.js → prepararVenta().
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const svc = require('../services/combos-personalizados.service');

function createCombosPersonalizadosRouter({
  query,
  addColumnIfMissing,
  resolveRequestActorUser,
  userRoleHasPermission,
  isGlobalAdministratorUser,
  userCanManageGlobalConfig,
  saveProductImageBuffer,
  decodeDataUrlImage,
  removeLocalProductImage,
  writeAuditLog,
}) {
  const router = express.Router();

  let _ready = null;
  function ensureReady() {
    if (!_ready) {
      _ready = svc.ensureCustomCombosSchema({ query, addColumnIfMissing }).catch((error) => {
        _ready = null;
        throw error;
      });
    }
    return _ready;
  }

  router.use(async (req, res, next) => {
    try {
      await ensureReady();
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  function fail(message, statusCode = 400) {
    return Object.assign(new Error(message), { statusCode });
  }

  function wrap(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        res.status(Number(error.statusCode || 500)).json({ error: error.message || 'Error en combos personalizados.' });
      }
    };
  }

  function actorInfo(actor) {
    return {
      userId: actor?.id || null,
      userName: actor?.nombre || actor?.usuario || 'Sistema',
      userRole: actor?.rol || actor?.role_code || 'Sistema',
    };
  }

  function audit(actor, actionName, detail) {
    return Promise.resolve(writeAuditLog({ ...actorInfo(actor), moduleName: 'Promociones', actionName, detail })).catch(() => {});
  }

  // Combos y productos habilitados: el permiso de Promociones (o administrador
  // general), igual que los combos promocionales. El cajero solo los vende.
  async function requireManager(req) {
    const actor = await resolveRequestActorUser(req, { required: true });
    if (!isGlobalAdministratorUser(actor) && !userRoleHasPermission(actor, 'promociones')) {
      throw fail('No tienes permiso para administrar combos.', 403);
    }
    return actor;
  }

  async function cargarCombo(id) {
    const rows = await query('SELECT * FROM custom_combos WHERE id = ? LIMIT 1', [Number(id)]);
    if (!rows[0]) throw fail('Combo no encontrado.', 404);
    return rows[0];
  }

  async function ventasDe(ids) {
    const mapa = new Map();
    const lista = [...new Set(ids.map(Number).filter((id) => id > 0))];
    if (!lista.length) return mapa;
    const rows = await query(
      `SELECT custom_combo_id AS id, COUNT(DISTINCT sale_id) AS n FROM sale_items
        WHERE custom_combo_id IN (${lista.map(() => '?').join(', ')}) GROUP BY custom_combo_id`,
      lista
    );
    for (const r of rows) mapa.set(Number(r.id), Number(r.n || 0));
    return mapa;
  }

  // Lo que necesita la pantalla de Ventas y la de Apariencia: cualquier usuario
  // con sesión (el cajero arma combos, pero solo ve los activos).
  router.get('/estado', wrap(async (req, res) => {
    const actor = await resolveRequestActorUser(req, { required: true });
    const administra = isGlobalAdministratorUser(actor) || userRoleHasPermission(actor, 'promociones');
    const estado = await svc.cargarEstado(query, { soloActivos: !administra });
    res.json({ ...estado, puedeAdministrar: administra, puedeConfigurar: userCanManageGlobalConfig(actor) });
  }));

  // Activar/desactivar y opciones: lo mismo que el resto de Configuración.
  router.put('/config', wrap(async (req, res) => {
    const actor = await resolveRequestActorUser(req, { required: true });
    if (!userCanManageGlobalConfig(actor)) {
      throw fail('La configuración global solo puede ser cambiada por el administrador general.', 403);
    }
    const cambios = svc.configParaGuardar(req.body || {});
    const columnas = Object.keys(cambios);
    if (!columnas.length) throw fail('No llegó ningún cambio.');
    await query(`UPDATE config SET ${columnas.map((c) => `${c} = ?`).join(', ')} WHERE id = 1`, columnas.map((c) => cambios[c]));
    const estado = await svc.cargarEstado(query);
    const etiquetas = {
      custom_combos_enabled: 'función',
      custom_combos_show_images: 'imágenes',
      custom_combos_allow_qty: 'cantidades',
    };
    const accion = Object.prototype.hasOwnProperty.call(cambios, 'custom_combos_enabled')
      ? (cambios.custom_combos_enabled ? 'Combos personalizados activados' : 'Combos personalizados desactivados')
      : 'Configuración de combos personalizados';
    await audit(actor, accion, columnas.map((c) => `${etiquetas[c] || c}: ${cambios[c] ? 'sí' : 'no'}`).join(' · '));
    res.json(estado);
  }));

  router.get('/combos', wrap(async (req, res) => {
    await requireManager(req);
    const rows = await query('SELECT * FROM custom_combos ORDER BY sort_order ASC, precio ASC, id ASC');
    const ventas = await ventasDe(rows.map((r) => r.id));
    res.json({ combos: rows.map((row) => svc.mapCombo(row, ventas.get(Number(row.id)))) });
  }));

  router.post('/combos', wrap(async (req, res) => {
    const actor = await requireManager(req);
    const { errores, datos } = svc.validarComboPayload(req.body || {});
    if (errores.length) throw fail(errores[0]);
    const repetido = await query('SELECT id FROM custom_combos WHERE LOWER(nombre) = LOWER(?) LIMIT 1', [datos.nombre]);
    if (repetido[0]) throw fail('Ya existe un combo con ese nombre.', 409);
    const result = await query(
      `INSERT INTO custom_combos (nombre, descripcion, precio, estado, color, sort_order, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [datos.nombre, datos.descripcion || null, datos.precio, datos.activo ? 'Activo' : 'Inactivo', datos.color || null, datos.orden, actor?.id || null]
    );
    const combo = svc.mapCombo(await cargarCombo(result.insertId));
    await audit(actor, 'Combo sugerido creado', `${combo.nombre}${combo.precio > 0 ? ` · precio sugerido RD$ ${combo.precio.toFixed(2)}` : ''}`);
    res.status(201).json({ combo });
  }));

  router.put('/combos/:id', wrap(async (req, res) => {
    const actor = await requireManager(req);
    const previo = await cargarCombo(req.params.id);
    const { errores, datos } = svc.validarComboPayload(req.body || {});
    if (errores.length) throw fail(errores[0]);
    const repetido = await query('SELECT id FROM custom_combos WHERE LOWER(nombre) = LOWER(?) AND id <> ? LIMIT 1', [datos.nombre, Number(previo.id)]);
    if (repetido[0]) throw fail('Ya existe un combo con ese nombre.', 409);
    await query(
      `UPDATE custom_combos
          SET nombre = ?, descripcion = ?, precio = ?, estado = ?, color = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [datos.nombre, datos.descripcion || null, datos.precio, datos.activo ? 'Activo' : 'Inactivo', datos.color || null, datos.orden, Number(previo.id)]
    );
    const cambios = [];
    if (previo.nombre !== datos.nombre) cambios.push(`nombre "${previo.nombre}" → "${datos.nombre}"`);
    if (Number(previo.precio || 0).toFixed(2) !== datos.precio.toFixed(2)) cambios.push(`precio ${Number(previo.precio || 0).toFixed(2)} → ${datos.precio.toFixed(2)}`);
    if ((String(previo.estado || 'Activo') !== 'Inactivo') !== datos.activo) cambios.push(datos.activo ? 'activado' : 'desactivado');
    const combo = svc.mapCombo(await cargarCombo(previo.id), (await ventasDe([previo.id])).get(Number(previo.id)));
    await audit(actor, 'Combo personalizado editado', `${combo.nombre}${cambios.length ? ` · ${cambios.join(' · ')}` : ''}`);
    res.json({ combo });
  }));

  router.post('/combos/:id/estado', wrap(async (req, res) => {
    const actor = await requireManager(req);
    const previo = await cargarCombo(req.params.id);
    const activo = req.body?.activo !== false;
    await query('UPDATE custom_combos SET estado = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [activo ? 'Activo' : 'Inactivo', Number(previo.id)]);
    await audit(actor, activo ? 'Combo personalizado activado' : 'Combo personalizado desactivado', previo.nombre);
    const combo = svc.mapCombo(await cargarCombo(previo.id), (await ventasDe([previo.id])).get(Number(previo.id)));
    res.json({ combo });
  }));

  // Un combo que ya se vendió no se borra (las ventas guardan su foto, pero el
  // reporte lo agrupa por id): se desactiva.
  router.delete('/combos/:id', wrap(async (req, res) => {
    const actor = await requireManager(req);
    const previo = await cargarCombo(req.params.id);
    const vendidos = (await ventasDe([previo.id])).get(Number(previo.id)) || 0;
    if (vendidos > 0) {
      throw fail(`El combo "${previo.nombre}" ya tiene ${vendidos} venta(s): desactívalo en vez de borrarlo.`, 409);
    }
    await query('DELETE FROM custom_combos WHERE id = ?', [Number(previo.id)]);
    await removeLocalProductImage(previo.image_local).catch(() => {});
    await audit(actor, 'Combo personalizado eliminado', `${previo.nombre} · RD$ ${Number(previo.precio || 0).toFixed(2)}`);
    res.json({ ok: true });
  }));

  router.post('/combos/:id/imagen', express.json({ limit: '20mb' }), wrap(async (req, res) => {
    const actor = await requireManager(req);
    const previo = await cargarCombo(req.params.id);
    const imageData = String(req.body?.imageData || '').trim();
    if (!imageData) throw fail('No llegó ninguna imagen.');
    let saved;
    try {
      saved = await saveProductImageBuffer({ productId: `combo-personalizado-${previo.id}`, productName: previo.nombre, buffer: decodeDataUrlImage(imageData) });
    } catch (error) {
      throw fail(`No se pudo procesar la imagen: ${error.message}`);
    }
    await removeLocalProductImage(previo.image_local).catch(() => {});
    await query('UPDATE custom_combos SET image_local = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [saved.imageLocal || null, Number(previo.id)]);
    await audit(actor, 'Imagen de combo personalizado guardada', previo.nombre);
    res.json({ combo: svc.mapCombo(await cargarCombo(previo.id)) });
  }));

  router.delete('/combos/:id/imagen', wrap(async (req, res) => {
    const actor = await requireManager(req);
    const previo = await cargarCombo(req.params.id);
    await removeLocalProductImage(previo.image_local).catch(() => {});
    await query('UPDATE custom_combos SET image_local = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [Number(previo.id)]);
    await audit(actor, 'Imagen de combo personalizado eliminada', previo.nombre);
    res.json({ combo: svc.mapCombo(await cargarCombo(previo.id)) });
  }));

  // "Disponible para combos" de uno o varios productos: { ids: [..], habilitado }.
  async function cambiarProductos(actor, ids, habilitado) {
    const lista = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((id) => id > 0))];
    if (!lista.length) throw fail('No llegó ningún producto.');
    const rows = await query(
      `SELECT id, nombre, sale_mode, product_type FROM products WHERE id IN (${lista.map(() => '?').join(', ')})`,
      lista
    );
    if (rows.length !== lista.length) throw fail('Uno de los productos no existe.', 404);
    if (habilitado) {
      const malo = rows.find((row) => svc.motivoNoHabilitable(row));
      if (malo) throw fail(`"${malo.nombre}" no se puede usar en combos: ${svc.motivoNoHabilitable(malo)}.`);
    }
    await query(
      `UPDATE products SET combo_personalizado = ? WHERE id IN (${lista.map(() => '?').join(', ')})`,
      [habilitado ? 1 : 0, ...lista]
    );
    const nombres = rows.map((r) => r.nombre);
    await audit(
      actor,
      habilitado ? 'Productos habilitados para combos' : 'Productos quitados de combos',
      `${nombres.slice(0, 10).join(', ')}${nombres.length > 10 ? ` y ${nombres.length - 10} más` : ''}`
    );
  }

  router.put('/productos/:id', wrap(async (req, res) => {
    const actor = await requireManager(req);
    await cambiarProductos(actor, [req.params.id], req.body?.habilitado === true);
    const estado = await svc.cargarEstado(query);
    res.json({ productoIds: estado.productoIds });
  }));

  router.put('/productos', wrap(async (req, res) => {
    const actor = await requireManager(req);
    await cambiarProductos(actor, req.body?.ids, req.body?.habilitado === true);
    const estado = await svc.cargarEstado(query);
    res.json({ productoIds: estado.productoIds });
  }));

  router.get('/reporte', wrap(async (req, res) => {
    await requireManager(req);
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.desde || '')) ? String(req.query.desde) : null;
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.hasta || '')) ? String(req.query.hasta) : null;
    res.json(await svc.construirReporte(query, { desde, hasta }));
  }));

  return router;
}

module.exports = createCombosPersonalizadosRouter;

// ══════════════════════════════════════════════════════════════════════════════
//  combos.routes.js — Tecno Caja
//  Combos promocionales (Centro de Promociones → Combos promocionales).
//  Factory con dependencias inyectadas, igual que promotions.routes.js.
//  Montado en /api/combos por server.js. La venta NO pasa por aquí: el combo es
//  un producto más del catálogo y POST /api/sales descuenta sus componentes.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const combos = require('../services/combos.service');

function createCombosRouter({
  query,
  withTransaction,
  addColumnIfMissing,
  resolveRequestActorUser,
  userRoleHasPermission,
  isGlobalAdministratorUser,
  getProductCatalogBranchScope,
  resolveStockBranchId,
  ensureUniqueProductCode,
  ensureUniqueProductBarcode,
  ensureUniqueProductName,
  saveProductImageBuffer,
  decodeDataUrlImage,
  removeLocalProductImage,
  writeAuditLog,
  afterCombosChanged,
}) {
  const router = express.Router();

  let _ready = false;
  async function ensureReady() {
    if (_ready) return;
    await combos.ensureCombosSchema({ query, addColumnIfMissing });
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

  function fail(message, statusCode = 400) {
    return Object.assign(new Error(message), { statusCode });
  }

  // Crear, editar, precios, composición, activar/desactivar y reportes: el
  // permiso de Promociones (o administrador general). El cajero solo vende.
  async function requireManager(req) {
    const actor = await resolveRequestActorUser(req, { required: true });
    if (!isGlobalAdministratorUser(actor) && !userRoleHasPermission(actor, 'promociones')) {
      throw fail('No tienes permiso para administrar combos.', 403);
    }
    return actor;
  }

  function wrap(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        res.status(Number(error.statusCode || 500)).json({ error: error.message || 'Error en combos.' });
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

  function parseMetadata(value) {
    try {
      const parsed = JSON.parse(String(value || '{}'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  async function stockForProducts(ids, branchId) {
    const stockById = new Map();
    const unique = [...new Set(ids.map(Number).filter((id) => id > 0))];
    if (!unique.length) return stockById;
    const marks = unique.map(() => '?').join(', ');
    const productRows = await query(`SELECT id, stock FROM products WHERE id IN (${marks})`, unique);
    for (const row of productRows) stockById.set(Number(row.id), Number(row.stock || 0));
    if (branchId) {
      const branchRows = await query(
        `SELECT product_id, stock FROM inventory_by_branch WHERE branch_id = ? AND product_id IN (${marks})`,
        [branchId, ...unique]
      ).catch(() => []);
      for (const row of branchRows) stockById.set(Number(row.product_id), Number(row.stock || 0));
    }
    return stockById;
  }

  function mapCombo(row, componentes, stockById, ventas) {
    const totales = combos.computeComboTotals(componentes, row.precio_venta);
    const meta = parseMetadata(row.business_metadata);
    return {
      id: Number(row.id),
      codigo: row.codigo,
      nombre: row.nombre,
      descripcion: String(meta.comboDescripcion || ''),
      categoria: row.categoria,
      precio: Number(row.precio_venta || 0),
      activo: String(row.estado || 'Activo') !== 'Inactivo',
      aplicaItbis: Boolean(Number(row.aplica_itbis || 0)),
      imagenLocal: row.image_local || '',
      imagenUrl: row.image_url || '',
      branchId: row.branch_id === null || row.branch_id === undefined ? null : Number(row.branch_id),
      componentes: componentes.map((c) => ({ ...c, existencia: stockById.has(c.id) ? stockById.get(c.id) : null })),
      totales,
      disponible: combos.computeComboAvailability(componentes, stockById),
      sinComponentes: componentes.length === 0,
      ventas: ventas || { unidades: 0, ingresos: 0 },
      actualizado: row.updated_at || null,
    };
  }

  async function loadCombos({ actor, id = null }) {
    const scope = getProductCatalogBranchScope(actor);
    const params = [combos.COMBO_PRODUCT_TYPE];
    let where = 'p.product_type = ?';
    if (id) {
      where += ' AND p.id = ?';
      params.push(Number(id));
    }
    if (scope !== null) {
      where += ' AND (p.branch_id IS NULL OR p.branch_id = ?)';
      params.push(scope);
    }
    const rows = await query(`SELECT p.* FROM products p WHERE ${where} ORDER BY p.nombre`, params);
    const ids = rows.map((r) => Number(r.id));
    const byCombo = await combos.loadComponentsByCombo(query, ids);
    const componentIds = [...byCombo.values()].flat().map((c) => c.id);
    const stockById = await stockForProducts(componentIds, await resolveStockBranchId(actor));
    const ventasById = new Map();
    if (ids.length) {
      const ventas = await query(
        `SELECT si.product_id, SUM(si.qty) AS unidades, SUM(si.line_total) AS ingresos
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE si.product_id IN (${ids.map(() => '?').join(', ')})
            AND si.combo_snapshot IS NOT NULL
            AND COALESCE(s.fiscal_status, '') <> 'cancelada'
          GROUP BY si.product_id`,
        ids
      ).catch(() => []);
      for (const v of ventas) {
        ventasById.set(Number(v.product_id), { unidades: Number(v.unidades || 0), ingresos: combos.roundMoney(v.ingresos) });
      }
    }
    return rows.map((row) => mapCombo(row, byCombo.get(Number(row.id)) || [], stockById, ventasById.get(Number(row.id))));
  }

  // Valida los componentes contra el catálogo real y arma la fila del producto.
  async function prepareComponents(conn, datos, comboId = null) {
    const ids = datos.componentes.map((c) => c.id);
    const rows = await conn.query(
      `SELECT id, codigo, nombre, product_type, precio_compra, precio_venta, aplica_itbis
         FROM products WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ids
    );
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    for (const c of datos.componentes) {
      const product = byId.get(c.id);
      if (!product) throw fail(`El producto ${c.id} ya no existe en el catálogo.`);
      if (comboId && Number(product.id) === Number(comboId)) throw fail('Un combo no puede contenerse a sí mismo.');
      if (String(product.product_type || '') === combos.COMBO_PRODUCT_TYPE) {
        throw fail(`"${product.nombre}" es un combo: un combo no puede llevar otro combo adentro.`);
      }
    }
    const costo = combos.roundMoney(datos.componentes.reduce((sum, c) => sum + Number(byId.get(c.id).precio_compra || 0) * c.cantidad, 0));
    const todosGravados = datos.componentes.every((c) => Number(byId.get(c.id).aplica_itbis || 0) === 1);
    return { costo, todosGravados };
  }

  async function saveComponents(conn, comboId, componentes) {
    await conn.query('DELETE FROM product_combo_items WHERE combo_product_id = ?', [comboId]);
    let orden = 0;
    for (const c of componentes) {
      await conn.query(
        `INSERT INTO product_combo_items (combo_product_id, component_product_id, quantity, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [comboId, c.id, c.cantidad, orden]
      );
      orden += 1;
    }
  }

  router.get('/', wrap(async (req, res) => {
    const actor = await requireManager(req);
    res.json({ combos: await loadCombos({ actor }) });
  }));

  router.get('/config', wrap(async (req, res) => {
    await requireManager(req);
    const rows = await query('SELECT combo_invoice_display FROM config WHERE id = 1 LIMIT 1');
    res.json({ presentacionFactura: combos.normalizeComboInvoiceDisplay(rows[0]?.combo_invoice_display) });
  }));

  router.put('/config', wrap(async (req, res) => {
    const actor = await requireManager(req);
    const modo = String(req.body?.presentacionFactura || '');
    if (!combos.COMBO_INVOICE_DISPLAY_MODES.includes(modo)) throw fail('Presentación de combos no válida.');
    await query('UPDATE config SET combo_invoice_display = ? WHERE id = 1', [modo]);
    await writeAuditLog({
      ...actorInfo(actor),
      moduleName: 'Promociones',
      actionName: 'Presentación de combos en facturas',
      detail: modo === 'desglosado' ? 'Desglosado con sus componentes' : 'Un solo artículo',
    }).catch(() => {});
    res.json({ presentacionFactura: modo });
  }));

  // Reporte: unidades, ingresos, costo histórico (de la foto de cada venta),
  // margen y componentes consumidos. Ventas canceladas fuera; devoluciones restadas.
  router.get('/reportes/resumen', wrap(async (req, res) => {
    await requireManager(req);
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.desde || '')) ? String(req.query.desde) : null;
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.hasta || '')) ? String(req.query.hasta) : null;
    const params = [];
    let fecha = '';
    if (desde) { fecha += ' AND s.created_at >= ?'; params.push(`${desde} 00:00:00`); }
    if (hasta) { fecha += ' AND s.created_at <= ?'; params.push(`${hasta} 23:59:59`); }
    const lineas = await query(
      `SELECT si.id, si.product_id, si.qty, si.line_total, si.price, si.combo_snapshot,
              s.id AS sale_id, s.created_at, u.nombre AS cajero
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN users u ON u.id = s.user_id
        WHERE si.combo_snapshot IS NOT NULL
          AND COALESCE(s.fiscal_status, '') <> 'cancelada'${fecha}
        ORDER BY s.created_at DESC`,
      params
    );
    const devueltas = new Map();
    if (lineas.length) {
      const ids = lineas.map((l) => Number(l.id));
      const rows = await query(
        `SELECT sale_item_id, SUM(qty_returned) AS qty FROM sale_return_items
          WHERE sale_item_id IN (${ids.map(() => '?').join(', ')}) GROUP BY sale_item_id`,
        ids
      ).catch(() => []);
      for (const r of rows) devueltas.set(Number(r.sale_item_id), Number(r.qty || 0));
    }
    const porCombo = new Map();
    for (const linea of lineas) {
      const snapshot = combos.parseComboSnapshot(linea.combo_snapshot);
      if (!snapshot) continue;
      const qty = Math.max(0, Number(linea.qty || 0) - (devueltas.get(Number(linea.id)) || 0));
      if (!(qty > 0)) continue;
      const proporcion = Number(linea.qty || 0) > 0 ? qty / Number(linea.qty) : 0;
      const key = Number(linea.product_id || snapshot.comboId);
      if (!porCombo.has(key)) {
        porCombo.set(key, {
          comboId: key, codigo: snapshot.codigo, nombre: snapshot.nombre,
          unidades: 0, ingresos: 0, costo: 0, ventas: 0, ultimaVenta: null, cajeros: new Set(), componentes: new Map(),
        });
      }
      const acc = porCombo.get(key);
      acc.unidades = combos.roundQty(acc.unidades + qty);
      acc.ingresos = combos.roundMoney(acc.ingresos + Number(linea.line_total || 0) * proporcion);
      acc.ventas += 1;
      if (!acc.ultimaVenta || String(linea.created_at) > String(acc.ultimaVenta)) acc.ultimaVenta = linea.created_at;
      if (linea.cajero) acc.cajeros.add(linea.cajero);
      for (const c of snapshot.componentes) {
        const consumido = combos.roundQty(qty * Number(c.cantidad || 0));
        acc.costo = combos.roundMoney(acc.costo + consumido * Number(c.costoUnitario || 0));
        const prev = acc.componentes.get(c.id) || { id: c.id, codigo: c.codigo, nombre: c.nombre, cantidad: 0 };
        prev.cantidad = combos.roundQty(prev.cantidad + consumido);
        acc.componentes.set(c.id, prev);
      }
    }
    const filas = [...porCombo.values()].map((acc) => {
      const ganancia = combos.roundMoney(acc.ingresos - acc.costo);
      return {
        comboId: acc.comboId,
        codigo: acc.codigo,
        nombre: acc.nombre,
        unidades: acc.unidades,
        ventas: acc.ventas,
        ingresos: acc.ingresos,
        precioPromedio: acc.unidades > 0 ? combos.roundMoney(acc.ingresos / acc.unidades) : 0,
        costo: acc.costo,
        ganancia,
        margenPct: acc.ingresos > 0 ? Math.round((ganancia / acc.ingresos) * 10000) / 100 : 0,
        ultimaVenta: acc.ultimaVenta,
        cajeros: [...acc.cajeros],
        componentes: [...acc.componentes.values()],
      };
    }).sort((a, b) => b.ingresos - a.ingresos);
    res.json({ desde, hasta, combos: filas });
  }));

  router.get('/:id', wrap(async (req, res) => {
    const actor = await requireManager(req);
    const [combo] = await loadCombos({ actor, id: req.params.id });
    if (!combo) throw fail('Combo no encontrado.', 404);
    res.json({ combo });
  }));

  router.get('/:id/ventas', wrap(async (req, res) => {
    await requireManager(req);
    // s.* y no columnas sueltas: ncf/encf no existen en todas las bases.
    const rows = await query(
      `SELECT s.*, si.id AS sale_item_id, si.qty, si.price, si.line_total, si.combo_snapshot, u.nombre AS cajero
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN users u ON u.id = s.user_id
        WHERE si.product_id = ? AND si.combo_snapshot IS NOT NULL
        ORDER BY s.id DESC
        LIMIT 200`,
      [Number(req.params.id)]
    );
    res.json({
      ventas: rows.map((r) => {
        const snapshot = combos.parseComboSnapshot(r.combo_snapshot);
        return {
          factura: r.encf || r.ncf || r.invoice_number,
          fecha: r.created_at,
          cajero: r.cajero || '',
          cantidad: Number(r.qty || 0),
          precio: Number(r.price || 0),
          total: Number(r.line_total || 0),
          cancelada: String(r.fiscal_status || '') === 'cancelada',
          nombre: snapshot?.nombre || '',
          componentes: snapshot?.componentes || [],
        };
      }),
    });
  }));

  router.post('/', wrap(async (req, res) => {
    const actor = await requireManager(req);
    const { errores, datos } = combos.validateComboPayload(req.body || {});
    if (errores.length) throw fail(errores[0]);
    const branchId = getProductCatalogBranchScope(actor);
    const created = await withTransaction(async (conn) => {
      const { costo, todosGravados } = await prepareComponents(conn, datos);
      await ensureUniqueProductCode(datos.codigo, null, conn, branchId);
      await ensureUniqueProductBarcode(datos.codigo, null, conn, branchId);
      await ensureUniqueProductName(datos.nombre, null, conn, branchId);
      await conn.query('INSERT OR IGNORE INTO categories (nombre) VALUES (?)', [datos.categoria]);
      const result = await conn.query(
        `INSERT INTO products
          (codigo, barcode, nombre, categoria, marca, unidad, sale_mode, precio_compra, precio_venta, stock, stock_min,
           estado, product_type, is_combo, aplica_itbis, itbis_modo, itbis_monto, preparation_time_minutes,
           business_metadata, tracks_stock, discount_percent, discount_until_stock_out, branch_id)
         VALUES (?, ?, ?, ?, NULL, 'Unidad', 'unidad', ?, ?, 0, 0, ?, ?, 1, ?, 'porcentaje', 0, 0, ?, 0, 0, 0, ?)`,
        [
          datos.codigo, datos.codigo, datos.nombre, datos.categoria, costo, datos.precio,
          datos.activo ? 'Activo' : 'Inactivo', combos.COMBO_PRODUCT_TYPE,
          (datos.aplicaItbis === null ? todosGravados : datos.aplicaItbis) ? 1 : 0,
          JSON.stringify({ comboDescripcion: datos.descripcion }),
          branchId,
        ]
      );
      const comboId = Number(result.insertId);
      await saveComponents(conn, comboId, datos.componentes);
      return comboId;
    });
    await writeAuditLog({
      ...actorInfo(actor), moduleName: 'Promociones', actionName: 'Combo creado',
      detail: `${datos.codigo} · ${datos.nombre} · RD$ ${datos.precio.toFixed(2)} · ${datos.componentes.length} producto(s)`,
    }).catch(() => {});
    await afterCombosChanged([created]).catch((e) => console.warn('[combos] Tras crear:', e.message));
    const [combo] = await loadCombos({ actor, id: created });
    res.status(201).json({ combo });
  }));

  router.put('/:id', wrap(async (req, res) => {
    const actor = await requireManager(req);
    const comboId = Number(req.params.id);
    const { errores, datos } = combos.validateComboPayload(req.body || {});
    if (errores.length) throw fail(errores[0]);
    const scope = getProductCatalogBranchScope(actor);
    let previo = null;
    await withTransaction(async (conn) => {
      const rows = await conn.query('SELECT * FROM products WHERE id = ? LIMIT 1', [comboId]);
      previo = rows[0];
      if (!previo || String(previo.product_type || '') !== combos.COMBO_PRODUCT_TYPE) throw fail('Combo no encontrado.', 404);
      if (scope !== null && Number(previo.branch_id || 0) !== scope) throw fail('No puedes editar un combo de otra sucursal.', 403);
      const branchId = previo.branch_id === null || previo.branch_id === undefined ? null : Number(previo.branch_id);
      const { costo, todosGravados } = await prepareComponents(conn, datos, comboId);
      await ensureUniqueProductCode(datos.codigo, comboId, conn, branchId);
      await ensureUniqueProductBarcode(datos.codigo, comboId, conn, branchId);
      await ensureUniqueProductName(datos.nombre, comboId, conn, branchId);
      await conn.query('INSERT OR IGNORE INTO categories (nombre) VALUES (?)', [datos.categoria]);
      const meta = { ...parseMetadata(previo.business_metadata), comboDescripcion: datos.descripcion };
      // tracks_stock 0 y stock 0 siempre: la existencia de un combo es la de sus
      // componentes (un combo viejo con stock propio deja de usarlo aquí).
      await conn.query(
        `UPDATE products
            SET codigo = ?, barcode = ?, nombre = ?, categoria = ?, precio_compra = ?, precio_venta = ?,
                estado = ?, is_combo = 1, aplica_itbis = ?, business_metadata = ?, tracks_stock = 0, stock = 0
          WHERE id = ?`,
        [
          datos.codigo, datos.codigo, datos.nombre, datos.categoria, costo, datos.precio,
          datos.activo ? 'Activo' : 'Inactivo',
          (datos.aplicaItbis === null ? todosGravados : datos.aplicaItbis) ? 1 : 0,
          JSON.stringify(meta), comboId,
        ]
      );
      await saveComponents(conn, comboId, datos.componentes);
    });
    const cambios = [];
    if (previo.nombre !== datos.nombre) cambios.push(`nombre "${previo.nombre}" → "${datos.nombre}"`);
    if (combos.roundMoney(previo.precio_venta) !== datos.precio) cambios.push(`precio ${Number(previo.precio_venta || 0).toFixed(2)} → ${datos.precio.toFixed(2)}`);
    await writeAuditLog({
      ...actorInfo(actor), moduleName: 'Promociones', actionName: 'Combo editado',
      detail: `${datos.codigo} · ${datos.nombre}${cambios.length ? ` · ${cambios.join(' · ')}` : ''} · ${datos.componentes.length} producto(s)`,
    }).catch(() => {});
    await afterCombosChanged([comboId]).catch((e) => console.warn('[combos] Tras editar:', e.message));
    const [combo] = await loadCombos({ actor, id: comboId });
    res.json({ combo });
  }));

  router.post('/:id/estado', wrap(async (req, res) => {
    const actor = await requireManager(req);
    const comboId = Number(req.params.id);
    const activo = req.body?.activo !== false;
    const rows = await query('SELECT id, codigo, nombre, product_type, branch_id FROM products WHERE id = ? LIMIT 1', [comboId]);
    const row = rows[0];
    if (!row || String(row.product_type || '') !== combos.COMBO_PRODUCT_TYPE) throw fail('Combo no encontrado.', 404);
    const scope = getProductCatalogBranchScope(actor);
    if (scope !== null && Number(row.branch_id || 0) !== scope) throw fail('No puedes cambiar un combo de otra sucursal.', 403);
    if (activo) {
      const comps = await query('SELECT COUNT(*) AS n FROM product_combo_items WHERE combo_product_id = ?', [comboId]);
      if (!Number(comps[0]?.n || 0)) throw fail('Agrega productos al combo antes de activarlo.');
    }
    await query('UPDATE products SET estado = ? WHERE id = ?', [activo ? 'Activo' : 'Inactivo', comboId]);
    await writeAuditLog({
      ...actorInfo(actor), moduleName: 'Promociones', actionName: activo ? 'Combo activado' : 'Combo desactivado',
      detail: `${row.codigo} · ${row.nombre}`,
    }).catch(() => {});
    await afterCombosChanged([comboId]).catch((e) => console.warn('[combos] Tras cambiar estado:', e.message));
    const [combo] = await loadCombos({ actor, id: comboId });
    res.json({ combo });
  }));

  router.post('/:id/imagen', express.json({ limit: '20mb' }), wrap(async (req, res) => {
    const actor = await requireManager(req);
    const comboId = Number(req.params.id);
    const imageData = String(req.body?.imageData || '').trim();
    if (!imageData) throw fail('No llegó ninguna imagen.');
    const rows = await query('SELECT id, nombre, image_local, product_type FROM products WHERE id = ? LIMIT 1', [comboId]);
    const row = rows[0];
    if (!row || String(row.product_type || '') !== combos.COMBO_PRODUCT_TYPE) throw fail('Combo no encontrado.', 404);
    let saved;
    try {
      saved = await saveProductImageBuffer({ productId: comboId, productName: row.nombre, buffer: decodeDataUrlImage(imageData) });
    } catch (error) {
      throw fail(`No se pudo procesar la imagen: ${error.message}`);
    }
    await removeLocalProductImage(row.image_local);
    await query('UPDATE products SET image_url = NULL, image_local = ? WHERE id = ?', [saved.imageLocal || null, comboId]);
    await writeAuditLog({ ...actorInfo(actor), moduleName: 'Promociones', actionName: 'Imagen de combo guardada', detail: row.nombre }).catch(() => {});
    await afterCombosChanged([comboId]).catch(() => {});
    const [combo] = await loadCombos({ actor, id: comboId });
    res.json({ combo });
  }));

  router.delete('/:id/imagen', wrap(async (req, res) => {
    const actor = await requireManager(req);
    const comboId = Number(req.params.id);
    const rows = await query('SELECT id, nombre, image_local, product_type FROM products WHERE id = ? LIMIT 1', [comboId]);
    const row = rows[0];
    if (!row || String(row.product_type || '') !== combos.COMBO_PRODUCT_TYPE) throw fail('Combo no encontrado.', 404);
    await removeLocalProductImage(row.image_local);
    await query('UPDATE products SET image_url = NULL, image_local = NULL WHERE id = ?', [comboId]);
    await writeAuditLog({ ...actorInfo(actor), moduleName: 'Promociones', actionName: 'Imagen de combo eliminada', detail: row.nombre }).catch(() => {});
    await afterCombosChanged([comboId]).catch(() => {});
    const [combo] = await loadCombos({ actor, id: comboId });
    res.json({ combo });
  }));

  return router;
}

module.exports = createCombosRouter;

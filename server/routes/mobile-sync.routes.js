/**
 * mobile-sync.routes.js
 *
 * Sincronización de solo lectura (pull) desde esta instalación de Tecno Caja
 * Windows hacia la app Android (Tecno_Caja_POS_Android_Pro). Alcance v1:
 * catálogo (productos), clientes, proveedores -- deliberadamente NO incluye
 * subir ventas/caja/ajustes de inventario todavía (fase 2, requiere mucho
 * más cuidado: doble conteo de stock, numeración de NCF, sesiones de caja
 * concurrentes). Ver [[project_android_pro_backend_recon]] en memoria.
 *
 * Auth propia (no la de `sesiones_activas`): valida el Bearer opaco emitido
 * por POST /api/mobile-auth/login, vía verifyMobileAccessToken.
 *
 * `products.categoria` es texto libre (no hay categoria_id en Windows), así
 * que se manda tal cual -- el lado Flutter hace find-or-create por nombre.
 * `products.stock` es el agregado entre sucursales; el stock real por
 * sucursal vive en `inventory_by_branch` (fila creada de forma perezosa la
 * primera vez que se mueve inventario ahí) -- por eso el LEFT JOIN con
 * COALESCE hacia products.stock como respaldo para negocios monocaja que
 * nunca han tocado esa tabla.
 *
 * Rutas registradas bajo /api/mobile-sync:
 *   GET /productos?branchId=
 *   GET /clientes
 *   GET /proveedores
 */

const express = require('express');
const { verifyMobileAccessToken } = require('./mobile-auth.routes');

module.exports = function createMobileSyncRouter(deps) {
  const { query } = deps;
  const router = express.Router();

  router.use(async (req, res, next) => {
    try {
      const authHeader = String(req.headers.authorization || '');
      const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const result = await verifyMobileAccessToken(query, accessToken);
      if (!result) {
        return res.status(401).json({ error: 'Sesión móvil inválida o expirada. Vuelve a iniciar sesión.' });
      }
      req.mobileUser = result.user;
      req.mobileDeviceId = result.mobileDeviceId;
      query('UPDATE mobile_devices SET last_seen_at = ? WHERE id = ?', [new Date(), result.mobileDeviceId]).catch(() => {});
      next();
    } catch (error) {
      next(error);
    }
  });

  async function resolveBranchId(requestedBranchId) {
    const requested = Number(requestedBranchId || 0) || null;
    if (requested) {
      const rows = await query('SELECT id FROM branches WHERE id = ? LIMIT 1', [requested]);
      if (rows.length) return requested;
    }
    const fallbackRows = await query("SELECT id FROM branches WHERE estado = 'Activa' ORDER BY id LIMIT 1");
    return Number(fallbackRows[0]?.id || 0) || null;
  }

  router.get('/productos', async (req, res, next) => {
    try {
      const branchId = await resolveBranchId(req.query.branchId);
      const rows = await query(
        `SELECT p.id, p.codigo, p.nombre, p.categoria, p.marca, p.unidad, p.precio_compra, p.precio_venta,
                p.stock_min AS product_stock_min, p.estado, p.aplica_itbis, p.branch_id,
                COALESCE(ib.stock, p.stock) AS stock,
                COALESCE(ib.stock_min, p.stock_min) AS stock_min
         FROM products p
         LEFT JOIN inventory_by_branch ib ON ib.product_id = p.id AND ib.branch_id = ?
         WHERE p.estado = 'Activo' AND (p.branch_id IS NULL OR p.branch_id = ?)
         ORDER BY p.nombre ASC`,
        [branchId, branchId]
      );
      res.json({
        branchId: branchId ? String(branchId) : null,
        productos: rows.map((p) => ({
          id: String(p.id),
          sku: p.codigo || null,
          nombre: p.nombre,
          categoria: p.categoria || null,
          marca: p.marca || null,
          unidadMedida: p.unidad || 'Unidad',
          precioCompra: Number(p.precio_compra || 0),
          precioVenta: Number(p.precio_venta || 0),
          itbisIncluido: false,
          tasaItbis: Number(p.aplica_itbis) ? 0.18 : 0,
          stock: Number(p.stock || 0),
          stockMinimo: Number(p.stock_min || 0),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/clientes', async (req, res, next) => {
    try {
      const rows = await query(
        `SELECT id, nombre, telefono, email, direccion, cedula, limite_credito, balance
         FROM clients ORDER BY nombre ASC`
      );
      res.json({
        clientes: rows.map((c) => ({
          id: String(c.id),
          nombre: c.nombre,
          telefono: c.telefono || null,
          email: c.email || null,
          direccion: c.direccion || null,
          cedulaRnc: c.cedula || null,
          limiteCredito: Number(c.limite_credito || 0),
          balance: Number(c.balance || 0),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/proveedores', async (req, res, next) => {
    try {
      const rows = await query(
        `SELECT id, nombre, empresa, telefono, email, rnc, contacto, direccion, visit_days, payment_terms_days
         FROM suppliers WHERE estado = 'Activo' ORDER BY nombre ASC`
      );
      res.json({
        proveedores: rows.map((s) => ({
          id: String(s.id),
          nombre: s.nombre,
          empresaProveedora: s.empresa || null,
          telefono: s.telefono || null,
          email: s.email || null,
          rnc: s.rnc || null,
          contacto: s.contacto || null,
          direccion: s.direccion || null,
          diasVisita: s.visit_days || null,
          terminosPagoDias: s.payment_terms_days === null ? null : Number(s.payment_terms_days),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};

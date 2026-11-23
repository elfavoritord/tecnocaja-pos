'use strict';
// Catálogo desde la pantalla de venta (Emilio, 2026-11-23). Quien vende
// (permiso 'ventas', también el cajero) puede, sin entrar a Productos:
//  - POST /api/products/venta/rapido: guardar el producto que agrega con "+"
//    (Agregar producto rápido) o al escanear un código que no está (Producto
//    nuevo). Queda activo, en "General", por unidad y sin control de
//    existencia. Si ya hay uno con ese nombre (o ese código), se usa ese con
//    su precio: no se duplica.
//  - POST /api/products/venta/:id/precio: dejar en el producto el precio que
//    se cambió con F3 (antes era solo para esa venta). Nunca en productos por
//    peso ni en combos, igual que F3 (server/sales/precio-manual.js).
// Todo queda en la auditoría (Productos), el precio con el de antes y el nuevo.
// Va bajo /api/products para que las otras cajas refresquen el catálogo
// (server/realtime/catalogo-en-vivo.js).

const express = require('express');
const { PRECIO_MAXIMO } = require('../sales/precio-manual');

const PREFIJO_CODIGO = 'RAP-';

function httpError(message, statusCode = 400, code = undefined) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}
const limpiarNombre = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 150);
function leerPrecio(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0 || n > PRECIO_MAXIMO) throw httpError('Escribe un precio mayor que cero.');
  return Math.round(n * 100) / 100;
}
const esPorPeso = (row) => String(row?.sale_mode || '').toLowerCase() === 'peso';
const esCombo = (row) => String(row?.product_type || '').toLowerCase() === 'combo' || Number(row?.is_combo || 0) === 1;
const estaActivo = (row) => String(row?.estado || 'Activo').toLowerCase() !== 'inactivo';

// Siguiente código libre de la serie RAP-0001, RAP-0002…
function siguienteCodigo(codigos = []) {
  const mayor = codigos.reduce((max, c) => {
    const m = String(c || '').toUpperCase().match(/^RAP-(\d+)$/);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return `${PREFIJO_CODIGO}${String(mayor + 1).padStart(4, '0')}`;
}

function createVentaCatalogoRouter(deps) {
  const {
    query, withTransaction, resolveRequestActorUser, getActor, writeAuditLog, userRoleHasPermission,
    getProductCatalogBranchScope, createProductInTransaction, mapProductRow,
    prepararProductos = async () => {}, publicarProductoNuevo = async () => false, alGuardarProducto = () => {},
  } = deps;
  const router = express.Router();

  async function vendedor(req) {
    const user = await resolveRequestActorUser(req, { required: true });
    if (!userRoleHasPermission(user, 'ventas')) throw httpError('Este usuario no tiene permiso para vender.', 403);
    return user;
  }

  async function auditar(req, entrada) {
    try {
      await writeAuditLog({ ...getActor(req), moduleName: 'Productos', ...entrada });
    } catch (error) {
      console.warn('[venta-catalogo] No se pudo registrar en la auditoría:', error.message);
    }
  }

  router.post('/rapido', async (req, res) => {
    const user = await vendedor(req);
    const nombre = limpiarNombre(req.body?.nombre);
    if (!nombre) throw httpError('Escribe el nombre del producto.');
    const precio = leerPrecio(req.body?.precio);
    const codigoEscrito = String(req.body?.codigo || '').trim().slice(0, 80);
    await prepararProductos();

    // ¿Ya está? Por código (si lo escribieron o escanearon) o por nombre.
    const existentes = await query(
      codigoEscrito
        ? 'SELECT * FROM products WHERE LOWER(codigo) = LOWER(?) OR LOWER(barcode) = LOWER(?) OR LOWER(nombre) = LOWER(?) ORDER BY id LIMIT 5'
        : 'SELECT * FROM products WHERE LOWER(nombre) = LOWER(?) ORDER BY id LIMIT 5',
      codigoEscrito ? [codigoEscrito, codigoEscrito, nombre] : [nombre]
    );
    const existente = existentes.find(estaActivo) || existentes[0];
    if (existente) {
      if (!estaActivo(existente)) {
        throw httpError(`Ya hay un producto "${existente.nombre}" inactivo en Productos.`, 409, 'PRODUCTO_INACTIVO');
      }
      return res.json({ creado: false, product: mapProductRow(existente) });
    }

    const categorias = await query("SELECT nombre FROM categories WHERE LOWER(nombre) = 'general' LIMIT 1").catch(() => []);
    const actor = getActor(req);
    const catalogBranchId = getProductCatalogBranchScope(user);
    let resultado = null;
    for (let intento = 0; !resultado; intento += 1) {
      try {
        resultado = await withTransaction(async (conn) => {
          const codigo = codigoEscrito || siguienteCodigo((await conn.query(
            "SELECT codigo FROM products WHERE UPPER(codigo) LIKE 'RAP-%'"
          )).map((f) => f.codigo));
          return createProductInTransaction(conn, {
            catalogBranchId, actor,
            data: {
              codigo, barcode: codigo, nombre, categoria: categorias[0]?.nombre || 'General', marca: '',
              unidad: 'Unidad', saleMode: 'unidad', precioCompra: 0, precioVenta: precio, stock: 0, stockMin: 0,
              estado: 'Activo', tipoProducto: 'general', tracksStock: false,
              aplicaItbis: req.body?.aplicaItbis === true, itbisModo: 'porcentaje', itbisMonto: 0,
            },
          });
        });
      } catch (error) {
        // Otra caja tomó el mismo RAP-000N a la vez: se prueba con el siguiente.
        if (!codigoEscrito && intento < 2 && Number(error.statusCode) === 409 && /c[óo]digo/i.test(error.message)) continue;
        throw error;
      }
    }
    let row = resultado.row;
    if (await publicarProductoNuevo(row.id)) {
      row = (await query('SELECT * FROM products WHERE id = ? LIMIT 1', [row.id]))[0] || row;
    }
    await auditar(req, {
      actionName: 'Producto creado desde la venta',
      detail: `${row.codigo} · ${row.nombre} · precio ${precio.toFixed(2)} · sin control de existencia`,
    });
    alGuardarProducto(row, resultado.branchId, 'crear_producto');
    res.status(201).json({ creado: true, product: mapProductRow(row) });
  });

  router.post('/:id/precio', async (req, res) => {
    await vendedor(req);
    const precio = leerPrecio(req.body?.precio);
    await prepararProductos();
    const id = Number(req.params.id);
    const [row] = Number.isInteger(id) && id > 0 ? await query('SELECT * FROM products WHERE id = ? LIMIT 1', [id]) : [];
    if (!row) throw httpError('Producto no encontrado.', 404);
    if (esPorPeso(row)) throw httpError('Los productos por peso no cambian de precio en la venta.');
    if (esCombo(row)) throw httpError('El precio de un combo se cambia en Promociones → Combos.');
    const antes = Number(row.precio_venta || 0);
    if (Math.round(antes * 100) === Math.round(precio * 100)) return res.json({ cambiado: false, product: mapProductRow(row) });

    await query('UPDATE products SET precio_venta = ? WHERE id = ?', [precio, id]);
    const [nuevo] = await query('SELECT * FROM products WHERE id = ? LIMIT 1', [id]);
    await auditar(req, {
      actionName: 'Precio cambiado desde la venta',
      detail: `${row.codigo} · ${row.nombre} · antes ${antes.toFixed(2)} · ahora ${precio.toFixed(2)}`,
      before: { precio: antes }, after: { precio },
    });
    alGuardarProducto(nuevo, null, 'precio_desde_venta');
    res.json({ cambiado: true, product: mapProductRow(nuevo) });
  });

  return router;
}

module.exports = { createVentaCatalogoRouter, siguienteCodigo };

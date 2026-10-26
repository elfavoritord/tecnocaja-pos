'use strict';
/**
 * pending-servicios.js — Servicios del catálogo de la Empresa de Servicios
 * (svc_services) que el contador agrega, edita o da de baja desde su portal.
 *
 * Viajan en la misma cola que los productos
 * (licencias/{uid}/productos_pendientes, con tipo 'servicio') y los aplica
 * apply-pending-products.js. Mismas reglas que el Catálogo de servicios del
 * POS (server/routes/servicios/catalogo.routes.js): nombre obligatorio,
 * precio (sin ITBIS) e ITBIS % no negativos, y "eliminar" es una baja lógica
 * (activo = 0): las facturas viejas siguen apuntando al servicio.
 *
 * Un POS que no es Empresa de Servicios vende servicios como productos sin
 * control de inventario: ahí se rechaza con ese aviso.
 */

const { ensureServiciosSchema } = require('../routes/servicios/schema');
const { importarServicios } = require('../routes/servicios/catalogo-import');

function createPendingServicios({ query, ensureSchema = ensureServiciosSchema }) {
  async function esEmpresaDeServicios() {
    const rows = await query('SELECT service_company FROM config WHERE id = 1 LIMIT 1').catch(() => []);
    return Number(rows[0]?.service_company || 0) === 1;
  }

  // Categoría por nombre, como la crea el POS. 'General' = sin categoría.
  async function categoriaId(nombre) {
    const limpio = String(nombre || '').trim();
    if (!limpio || limpio.toLowerCase() === 'general') return null;
    const [cat] = await query('SELECT id FROM svc_service_categories WHERE LOWER(nombre) = LOWER(?) LIMIT 1', [limpio]);
    if (cat) return cat.id;
    const r = await query('INSERT INTO svc_service_categories (nombre) VALUES (?)', [limpio]);
    return r.insertId;
  }

  // Otro servicio activo con el mismo nombre o código.
  async function buscarIgual(datos, excluirId = null) {
    const rows = await query(
      `SELECT id, codigo, nombre FROM svc_services
       WHERE activo = 1
         AND (LOWER(nombre) = LOWER(?) OR (? <> '' AND LOWER(COALESCE(codigo, '')) = LOWER(?)))
         AND (? IS NULL OR id <> ?)
       ORDER BY id LIMIT 1`,
      [datos.nombre, datos.codigo, datos.codigo, excluirId, excluirId]
    );
    return rows[0] || null;
  }

  function leer(request) {
    const nombre = String(request.nombre || '').trim();
    if (!nombre) throw new Error('El nombre del servicio es obligatorio.');
    return {
      codigo: String(request.codigo || '').trim(),
      nombre,
      descripcion: String(request.descripcion || '').trim() || null,
      categoria: request.categoria,
      precio: Math.max(0, Number(request.precioVenta || 0)),
      itbisPct: Math.max(0, Number(request.itbisPct ?? 0)),
      unidad: String(request.unidad || '').trim() || 'servicio',
    };
  }

  // → { servicioId, accion, detalle, duplicado }
  async function aplicar(request) {
    if (!(await esEmpresaDeServicios())) {
      throw new Error('Este negocio no es Empresa de Servicios: agrega el servicio como producto sin control de inventario.');
    }
    await ensureSchema(query);
    const accion = ['editar', 'eliminar'].includes(request.accion) ? request.accion : 'crear';
    const servicioId = Number(request.servicioId || 0) || null;

    if (accion === 'eliminar') {
      if (!servicioId) throw new Error('Falta el servicio a dar de baja.');
      const r = await query("UPDATE svc_services SET activo = 0, updated_at = datetime('now') WHERE id = ?", [servicioId]);
      // Si ya no estaba, el objetivo (que no se ofrezca) ya se cumplió.
      return { servicioId, accion, detalle: `Servicio #${servicioId}`, duplicado: !r.affectedRows };
    }

    // Importado de un CSV en el portal: igual que importar en el POS (crea o
    // actualiza por código/nombre, solo las columnas que traía el archivo).
    if (request.importado && accion === 'crear') {
      const fila = {
        codigo: request.codigo, nombre: request.nombre, descripcion: request.descripcion, categoria: request.categoria,
        unidad: request.unidad, precio: request.precioVenta, itbisPct: request.itbisPct, campos: request.campos,
      };
      const r = await importarServicios(query, [fila]);
      if (r.errores.length) throw new Error(r.errores[0]);
      return {
        servicioId: r.ids[0] || null,
        accion: r.actualizados ? 'editar' : 'crear',
        detalle: `${String(request.nombre || request.codigo || '').trim()} (importado de CSV)`,
        duplicado: false,
      };
    }

    const d = leer(request);
    if (accion === 'editar') {
      if (!servicioId) throw new Error('Falta el servicio a editar.');
      const [actual] = await query('SELECT id FROM svc_services WHERE id = ?', [servicioId]);
      if (!actual) throw new Error('El servicio ya no existe en el POS.');
      const otro = await buscarIgual(d, servicioId);
      if (otro) throw new Error(`Ya existe otro servicio con ese nombre o código (${otro.nombre}).`);
      await query(
        `UPDATE svc_services SET codigo = ?, nombre = ?, descripcion = ?, categoria_id = ?, precio = ?, itbis_pct = ?,
           unidad = ?, activo = 1, updated_at = datetime('now') WHERE id = ?`,
        [d.codigo || null, d.nombre, d.descripcion, await categoriaId(d.categoria), d.precio, d.itbisPct, d.unidad, servicioId]
      );
      return { servicioId, accion, detalle: `${d.nombre} · RD$ ${d.precio.toFixed(2)}`, duplicado: false };
    }

    const igual = await buscarIgual(d);
    if (igual) return { servicioId: igual.id, accion, detalle: d.nombre, duplicado: true };
    const r = await query(
      `INSERT INTO svc_services (codigo, nombre, descripcion, categoria_id, precio, itbis_pct, unidad, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [d.codigo || null, d.nombre, d.descripcion, await categoriaId(d.categoria), d.precio, d.itbisPct, d.unidad]
    );
    return { servicioId: r.insertId, accion, detalle: `${d.nombre} · RD$ ${d.precio.toFixed(2)}`, duplicado: false };
  }

  return { aplicar };
}

module.exports = { createPendingServicios };

'use strict';

/**
 * server/tienda-online/solicitudes.js
 *
 * Solicitudes de cotización, cita o consulta que llegan de la tienda. No son pedidos:
 * no tocan inventario ni precios, y nunca se convierten solas en factura. El negocio
 * las revisa y decide.
 */

const ESTADOS_SOLICITUD = ['nueva', 'en_revision', 'confirmada', 'convertida', 'descartada'];

function texto(valor, max) {
  return String(valor ?? '').trim().slice(0, max);
}

function fechaSql(valor, respaldo) {
  if (!valor) return respaldo;
  const d = typeof valor?.toDate === 'function' ? valor.toDate() : new Date(valor);
  return Number.isNaN(d.getTime()) ? respaldo : d.toISOString().slice(0, 19).replace('T', ' ');
}

function mapSolicitud(row) {
  return {
    id: Number(row.id),
    cloudId: row.cloud_id,
    tipo: row.tipo,
    estado: row.estado,
    productoId: row.product_id ? Number(row.product_id) : null,
    articulo: row.product_name || '',
    precio: row.price === null || row.price === undefined ? null : Number(row.price),
    servicioId: row.servicio_id ? Number(row.servicio_id) : null,
    cliente: { nombre: row.customer_name, telefono: row.customer_phone || '', email: row.customer_email || '' },
    mensaje: row.message || '',
    fecha: row.preferred_date || '',
    hora: row.preferred_time || '',
    referencia: row.reference || '',
    creadoEn: row.cloud_created_at || row.received_at,
    actualizadoEn: row.updated_at,
  };
}

function createSolicitudes({ query, nowSql, nube, emit = () => {}, logger = console }) {
  async function importar(id, d) {
    const nombre = texto(d?.cliente?.nombre, 160);
    if (!nombre) return { inserted: false, rechazada: true };
    const antes = await query('SELECT id FROM online_requests WHERE cloud_id = ? LIMIT 1', [id]);
    if (antes.length) return { inserted: false };
    const ahora = nowSql();
    const r = await query(
      `INSERT OR IGNORE INTO online_requests
        (cloud_id, tipo, estado, product_id, product_name, price, customer_name, customer_phone, customer_email,
         message, preferred_date, preferred_time, cloud_created_at, received_at, updated_at)
       VALUES (?, ?, 'nueva', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, texto(d.tipo, 20) || 'consulta', Number(d.productoId || 0) || null, texto(d.articulo, 255),
        d.precio === null || d.precio === undefined ? null : Number(d.precio), nombre, texto(d.cliente.telefono, 40),
        texto(d.cliente.email, 160), texto(d.mensaje, 1000), texto(d.fecha, 10), texto(d.hora, 5),
        fechaSql(d.creadoEn, ahora), ahora, ahora,
      ],
    );
    return { inserted: Number(r?.affectedRows ?? 1) > 0 };
  }

  /** Trae lo pendiente de la nube. Cada solicitud se marca una sola vez. */
  async function recibirPendientes() {
    const docs = await nube.fetchPendingSolicitudes(50);
    let nuevas = 0;
    for (const doc of docs) {
      try {
        const r = await importar(doc.id, doc.data || {});
        await nube.markSolicitudImportada(doc.id);
        if (r.inserted) nuevas += 1;
      } catch (error) {
        logger.warn?.(`[tienda-online] No se pudo recibir la solicitud ${doc.id}:`, error.message);
      }
    }
    if (nuevas) emit('tienda-online:nueva-solicitud', { nuevas });
    return { nuevas };
  }

  async function listar({ estado = '' } = {}) {
    const params = [];
    let where = '';
    if (ESTADOS_SOLICITUD.includes(estado)) {
      where = 'WHERE r.estado = ?';
      params.push(estado);
    }
    // servicio_id: en una Empresa de Servicios, para crear la cotización o la cita.
    const conServicio = await query(
      `SELECT r.*, s.id AS servicio_id
         FROM online_requests r LEFT JOIN svc_services s ON s.product_id = r.product_id
         ${where} ORDER BY r.id DESC LIMIT 300`,
      params,
    ).catch(() => null);
    const filas = conServicio || await query(`SELECT r.* FROM online_requests r ${where} ORDER BY r.id DESC LIMIT 300`, params);
    return filas.map(mapSolicitud);
  }

  async function contarNuevas() {
    const [f] = await query("SELECT COUNT(*) AS n FROM online_requests WHERE estado = 'nueva'");
    return Number(f?.n || 0);
  }

  async function cambiar(id, { estado, referencia }) {
    if (!ESTADOS_SOLICITUD.includes(estado)) {
      const error = new Error('Estado inválido.');
      error.statusCode = 400;
      throw error;
    }
    const r = await query('UPDATE online_requests SET estado = ?, reference = ?, updated_at = ? WHERE id = ?', [estado, texto(referencia, 120), nowSql(), Number(id)]);
    if (!Number(r?.affectedRows ?? 1)) {
      const error = new Error('Solicitud no encontrada.');
      error.statusCode = 404;
      throw error;
    }
    const [fila] = await query('SELECT * FROM online_requests WHERE id = ?', [Number(id)]);
    return mapSolicitud(fila);
  }

  return { recibirPendientes, importar, listar, contarNuevas, cambiar };
}

module.exports = { ESTADOS_SOLICITUD, createSolicitudes, mapSolicitud };

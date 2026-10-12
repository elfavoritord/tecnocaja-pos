'use strict';

/**
 * server/tienda-online/orders.js
 *
 * Pedidos online dentro del POS (tablas online_orders / _items / _events).
 *
 * El POS es el centro: aquí se reciben, se revisan, cambian de estado y se
 * preparan para cobrarse con el flujo NORMAL de Ventas (POST /api/sales). La
 * venta y el pedido se ligan dentro de la misma transacción de la venta
 * (claimForSaleInTx): si dos cajas cobran el mismo pedido, la segunda falla y
 * se deshace completa (factura, NCF, inventario y caja).
 */

const {
  ESTADOS_CONVERTIBLES,
  ESTADOS_FINALES,
  ESTADO_ETIQUETAS,
  METODOS_PAGO,
} = require('./contrato');

const TRANSICIONES = Object.freeze({
  nuevo: ['confirmado', 'rechazado', 'cancelado'],
  confirmado: ['en_preparacion', 'listo', 'en_camino', 'entregado', 'cancelado'],
  en_preparacion: ['listo', 'en_camino', 'entregado', 'cancelado'],
  listo: ['en_camino', 'entregado', 'cancelado'],
  en_camino: ['entregado', 'cancelado'],
});

const BLOQUEO_MINUTOS = 10;

function httpError(message, statusCode = 400, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function texto(value, max = 255) {
  // eslint-disable-next-line no-control-regex -- quitar caracteres de control es justo la idea
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(num(value) * 100) / 100;
}

function digitos(value) {
  return String(value || '').replace(/\D/g, '');
}

function aFecha(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'object' && value._seconds !== undefined) return new Date(Number(value._seconds) * 1000);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Las fechas locales se guardan en hora de RD (UTC-4, sin horario de verano).
function sqlDateToIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) return new Date(s.replace(' ', 'T') + '-04:00').toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseSettings(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

/** Método de cobro sugerido en el POS para el método que eligió el cliente. */
function metodoPosSugerido(metodo, tipoEntrega) {
  const delivery = tipoEntrega === 'delivery';
  if (metodo === 'transferencia') return 'transferencia';
  if (metodo === 'tarjeta') return 'tarjeta';
  if (metodo === 'efectivo' || metodo === 'contra_entrega') return delivery ? 'contra_entrega' : 'efectivo';
  return 'efectivo';
}

function mapOrderRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    cloudId: row.cloud_id,
    numero: Number(row.order_number),
    estado: row.status,
    estadoEtiqueta: ESTADO_ETIQUETAS[row.status] || row.status,
    sucursalId: row.branch_id === null || row.branch_id === undefined ? null : Number(row.branch_id),
    cliente: {
      nombre: row.customer_name,
      telefono: row.customer_phone || '',
      whatsapp: row.customer_whatsapp || '',
      email: row.customer_email || '',
      clientId: row.client_id ? Number(row.client_id) : null,
    },
    entrega: {
      tipo: row.delivery_type,
      zona: row.delivery_zone || '',
      direccion: row.delivery_address || '',
      sector: row.delivery_sector || '',
      referencia: row.delivery_reference || '',
      municipio: row.delivery_municipio || '',
      provincia: row.delivery_provincia || '',
      costo: num(row.delivery_fee),
      itbis: num(row.delivery_fee_tax),
    },
    pago: { metodo: row.payment_method || '', etiqueta: row.payment_label || '' },
    comprobante: {
      solicitado: Number(row.invoice_requested || 0) === 1,
      rnc: row.invoice_rnc || '',
      razonSocial: row.invoice_name || '',
    },
    notas: row.notes || '',
    totales: {
      subtotal: num(row.subtotal),
      descuento: num(row.discount),
      itbis: num(row.tax),
      ahorroPromociones: num(row.promo_savings),
      delivery: num(row.delivery_fee),
      deliveryItbis: num(row.delivery_fee_tax),
      total: num(row.total),
    },
    moneda: row.currency || 'RD$',
    venta: row.sale_id ? {
      id: Number(row.sale_id),
      factura: row.sale_invoice_number || '',
      convertidaEn: row.converted_at || null,
      convertidaPor: row.converted_by_user_name || '',
    } : null,
    enProceso: row.processing_until ? {
      por: row.processing_by_name || '',
      usuarioId: row.processing_by_user_id ? Number(row.processing_by_user_id) : null,
      hasta: row.processing_until,
    } : null,
    despachadoEn: row.dispatched_at || null,
    entregadoEn: row.delivered_at || null,
    motivoCancelacion: row.cancel_reason || '',
    creadoEnNube: row.cloud_created_at || null,
    recibidoEn: row.received_at,
    actualizadoEn: row.updated_at,
    sincronizado: Number(row.cloud_sync_pending || 0) === 0,
    errorSincronizacion: row.cloud_sync_error || '',
    articulos: row.item_count === undefined ? undefined : Number(row.item_count || 0),
  };
}

function mapItemRow(row) {
  return {
    id: Number(row.id),
    productoId: row.product_id ? Number(row.product_id) : null,
    codigo: row.product_code || '',
    nombre: row.product_name,
    unidad: row.unit_label || 'Unidad',
    modoVenta: row.sale_mode || 'unidad',
    cantidad: num(row.qty),
    precioUnitario: num(row.unit_price),
    precioOriginal: row.original_price === null || row.original_price === undefined ? null : num(row.original_price),
    promocionId: row.promotion_id ? Number(row.promotion_id) : null,
    promocionNombre: row.promotion_name || '',
    descuentoPct: num(row.discount_rate),
    itbisModo: row.tax_mode || null,
    itbisTasa: num(row.tax_rate),
    itbisMontoUnit: num(row.tax_unit_amount),
    subtotal: num(row.subtotal),
    descuento: num(row.discount),
    itbis: num(row.tax),
    total: num(row.line_total),
  };
}

function createOrdersService({
  query,
  withTransaction,
  nowSql,
  formatSqlDate,
  mapClientRow = (row) => row,
  notifier = null,
  emit = () => {},
  logger = console,
}) {
  function plusMinutes(minutes) {
    return formatSqlDate(new Date(Date.now() + minutes * 60 * 1000));
  }

  async function addEvent(runner, orderId, { tipo, desde = null, hacia = null, detalle = '', actor = null }) {
    await runner.query(
      `INSERT INTO online_order_events (order_id, event_type, from_status, to_status, detail, user_id, user_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, tipo, desde, hacia, texto(detalle, 500) || null, actor?.id || null, texto(actor?.nombre || actor?.usuario || '', 160) || null, nowSql()],
    );
  }

  const db = { query };

  async function getRow(id, runner = db) {
    const rows = await runner.query('SELECT * FROM online_orders WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  // ── Recepción desde la nube ───────────────────────────────────────────────

  /**
   * Guarda un pedido que llegó de la nube. Idempotente por cloud_id: si ya
   * existe no hace nada (una reconexión o un reintento nunca lo duplica).
   */
  async function importOrder(cloudId, data, { licenseId = '' } = {}) {
    const id = texto(cloudId, 64);
    if (!id) throw httpError('Pedido sin identificador.');
    if (licenseId && data.licenseId && data.licenseId !== licenseId) {
      throw httpError('El pedido pertenece a otra licencia.', 403);
    }
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) throw httpError('El pedido no tiene productos.');
    const cliente = data.cliente || {};
    const entrega = data.entrega || {};
    const pago = data.pago || {};
    const comprobante = data.comprobante || {};
    const totales = data.totales || {};
    const now = nowSql();
    const creado = aFecha(data.creadoEn);

    const result = await withTransaction(async (conn) => {
      const insert = await conn.query(
        `INSERT OR IGNORE INTO online_orders
          (cloud_id, order_number, license_id, store_slug, branch_id, status,
           customer_name, customer_phone, customer_whatsapp, customer_email,
           delivery_type, delivery_zone, delivery_address, delivery_sector, delivery_reference,
           delivery_municipio, delivery_provincia, delivery_fee, delivery_fee_tax,
           payment_method, payment_label, invoice_requested, invoice_rnc, invoice_name, notes,
           subtotal, discount, tax, promo_savings, total, currency,
           cloud_created_at, received_at, updated_at, cloud_sync_pending)
         VALUES (?, ?, ?, ?, ?, 'nuevo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          id,
          Number(data.numero) || 0,
          texto(data.licenseId, 64) || null,
          texto(data.slug, 80) || null,
          Number(data.sucursalId || 0) || null,
          texto(cliente.nombre, 160) || 'Cliente',
          texto(cliente.telefono, 40) || null,
          texto(cliente.whatsapp, 40) || null,
          texto(cliente.email, 160) || null,
          entrega.tipo === 'delivery' ? 'delivery' : 'retiro',
          texto(entrega.zonaNombre, 120) || null,
          texto(entrega.direccion, 255) || null,
          texto(entrega.sector, 120) || null,
          texto(entrega.referencia, 255) || null,
          texto(entrega.municipio, 120) || null,
          texto(entrega.provincia, 120) || null,
          round2(totales.delivery),
          round2(totales.deliveryItbis),
          texto(pago.metodo, 40) || null,
          texto(pago.etiqueta || METODOS_PAGO[pago.metodo] || '', 120) || null,
          comprobante.solicitado ? 1 : 0,
          texto(digitos(comprobante.rnc), 20) || null,
          texto(comprobante.razonSocial, 160) || null,
          texto(data.notas, 1000) || null,
          round2(totales.subtotal),
          round2(totales.descuento),
          round2(totales.itbis),
          round2(totales.ahorroPromociones),
          round2(totales.total),
          texto(data.moneda, 10) || 'RD$',
          creado ? formatSqlDate(creado) : null,
          now,
          now,
        ],
      );
      if (!Number(insert?.affectedRows || 0)) return { inserted: false };
      const rows = await conn.query('SELECT id FROM online_orders WHERE cloud_id = ? LIMIT 1', [id]);
      const orderId = Number(rows[0].id);
      for (const item of items) {
        await conn.query(
          `INSERT INTO online_order_items
            (order_id, product_id, product_code, product_name, unit_label, sale_mode, qty, unit_price,
             original_price, promotion_id, promotion_name, discount_rate, tax_mode, tax_rate, tax_unit_amount,
             subtotal, discount, tax, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderId,
            Number(item.productoId || 0) || null,
            texto(item.codigo, 60) || null,
            texto(item.nombre, 255) || 'Producto',
            texto(item.unidad, 40) || 'Unidad',
            ['peso', 'medida'].includes(item.modoVenta) ? item.modoVenta : 'unidad',
            round2(item.cantidad),
            round2(item.precioUnitario),
            item.precioOriginal === null || item.precioOriginal === undefined ? null : round2(item.precioOriginal),
            Number(item.promocionId || 0) || null,
            texto(item.promocionNombre, 150) || null,
            round2(item.descuentoPct),
            item.itbisModo ? texto(item.itbisModo, 20) : null,
            round2(item.itbisTasa),
            round2(item.itbisMontoUnit),
            round2(item.subtotal),
            round2(item.descuento),
            round2(item.itbis),
            round2(item.total),
          ],
        );
      }
      await addEvent(conn, orderId, { tipo: 'estado', hacia: 'nuevo', detalle: 'Pedido recibido desde la tienda online' });
      return { inserted: true, orderId };
    });

    if (result.inserted) {
      // El cliente queda en Clientes desde que llega el pedido (no hace falta cobrarlo).
      await vincularCliente(result.orderId).catch((error) => {
        logger.warn?.('[tienda-online] No se pudo guardar el cliente del pedido:', error.message);
      });
    }
    if (result.inserted && notifier) {
      const row = await getRow(result.orderId);
      await notifier.enqueueForStatus(mapOrderRow(row), 'nuevo').catch((error) => {
        logger.warn?.('[tienda-online] No se pudo preparar el aviso al cliente:', error.message);
      });
    }
    return result;
  }

  /**
   * Busca el cliente del pedido en Clientes (por teléfono/WhatsApp o correo)
   * y, si no está, lo crea. Liga el pedido al cliente y avisa a las pantallas.
   */
  async function vincularCliente(orderId) {
    const row = await getRow(orderId);
    if (!row || row.client_id) return null;
    const { row: clientRow, creado } = await findOrCreateClient(row);
    if (!clientRow?.id) return null;
    await query('UPDATE online_orders SET client_id = ? WHERE id = ? AND client_id IS NULL', [clientRow.id, orderId]);
    await addEvent(db, orderId, {
      tipo: 'cliente',
      detalle: creado ? `Cliente ${clientRow.nombre} agregado a Clientes` : `Cliente ${clientRow.nombre} ya estaba en Clientes`,
    });
    if (creado) emit('tienda-online:cliente', { client: mapClientRow(clientRow) });
    return { clientId: Number(clientRow.id), creado };
  }

  /** Pedidos que llegaron antes de esta función: se ligan a su cliente una vez. */
  async function vincularClientesPendientes(limit = 200) {
    const rows = await query(
      `SELECT id FROM online_orders WHERE client_id IS NULL AND status <> 'rechazado' ORDER BY id LIMIT ${Number(limit) || 200}`,
    );
    let creados = 0;
    for (const r of rows) {
      const res = await vincularCliente(Number(r.id)).catch(() => null);
      if (res?.creado) creados += 1;
    }
    return { revisados: rows.length, creados };
  }

  // ── Consultas ─────────────────────────────────────────────────────────────

  async function list({ estado = '', desde = '', hasta = '', buscar = '', branchId = null, limit = 50, offset = 0 } = {}) {
    let where = 'WHERE 1=1';
    const params = [];
    if (estado === 'activos') {
      where += ` AND o.status NOT IN ('entregado', 'cancelado', 'rechazado')`;
    } else if (estado) {
      where += ' AND o.status = ?';
      params.push(estado);
    }
    if (desde) { where += ' AND o.received_at >= ?'; params.push(`${desde} 00:00:00`); }
    if (hasta) { where += ' AND o.received_at <= ?'; params.push(`${hasta} 23:59:59`); }
    if (buscar) {
      const like = `%${texto(buscar, 60)}%`;
      where += ' AND (o.customer_name LIKE ? OR o.customer_phone LIKE ? OR CAST(o.order_number AS CHAR) LIKE ? OR o.sale_invoice_number LIKE ?)';
      params.push(like, like, like, like);
    }
    if (branchId) { where += ' AND (o.branch_id = ? OR o.branch_id IS NULL)'; params.push(branchId); }
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const rows = await query(
      `SELECT o.*, (SELECT COUNT(*) FROM online_order_items i WHERE i.order_id = o.id) AS item_count
         FROM online_orders o ${where}
        ORDER BY CASE WHEN o.status = 'nuevo' THEN 0 ELSE 1 END, o.id DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params,
    );
    const totalRows = await query(`SELECT COUNT(*) AS total FROM online_orders o ${where}`, params);
    return { pedidos: rows.map(mapOrderRow), total: Number(totalRows[0]?.total || 0) };
  }

  async function summary({ branchId = null } = {}) {
    const scope = branchId ? ' AND (branch_id = ? OR branch_id IS NULL)' : '';
    const params = branchId ? [branchId] : [];
    const rows = await query(
      `SELECT status, COUNT(*) AS n FROM online_orders
        WHERE status NOT IN ('entregado', 'cancelado', 'rechazado')${scope}
        GROUP BY status`,
      params,
    );
    const porEstado = {};
    let activos = 0;
    for (const row of rows) {
      porEstado[row.status] = Number(row.n || 0);
      activos += Number(row.n || 0);
    }
    const pendientes = await query('SELECT COUNT(*) AS n FROM online_orders WHERE cloud_sync_pending = 1');
    const ultimo = await query('SELECT MAX(id) AS id FROM online_orders');
    return {
      nuevos: porEstado.nuevo || 0,
      activos,
      porEstado,
      sinSincronizar: Number(pendientes[0]?.n || 0),
      ultimoId: Number(ultimo[0]?.id || 0),
    };
  }

  /** Existencia de varios productos en una sucursal (mismo criterio que la venta). */
  async function branchStock(productIds, branchId) {
    const ids = [...new Set(productIds.map(Number).filter((n) => n > 0))];
    if (!ids.length) return new Map();
    const marks = ids.map(() => '?').join(',');
    const rows = await query(
      `SELECT p.id, p.nombre, p.estado, p.precio_venta, p.tracks_stock, p.online_enabled, p.stock AS legacy_stock,
              ib.stock AS branch_stock,
              (SELECT COUNT(*) FROM inventory_by_branch x WHERE x.product_id = p.id) AS inv_rows
         FROM products p
         LEFT JOIN inventory_by_branch ib ON ib.product_id = p.id AND ib.branch_id = ?
        WHERE p.id IN (${marks})`,
      [branchId || 0, ...ids],
    );
    const primary = await query('SELECT id FROM branches ORDER BY id LIMIT 1');
    const primaryId = Number(primary[0]?.id || 0) || null;
    const out = new Map();
    for (const row of rows) {
      let stock = 0;
      if (row.branch_stock !== null && row.branch_stock !== undefined) stock = num(row.branch_stock);
      else if (Number(row.inv_rows || 0) === 0 && branchId && Number(branchId) === primaryId) stock = num(row.legacy_stock);
      out.set(Number(row.id), {
        nombre: row.nombre,
        activo: String(row.estado || 'Activo') === 'Activo',
        precio: num(row.precio_venta),
        controlaStock: Number(row.tracks_stock ?? 1) !== 0,
        publicado: Number(row.online_enabled || 0) === 1,
        stock,
      });
    }
    return out;
  }

  async function get(id, { branchId = null } = {}) {
    const row = await getRow(id);
    if (!row) return null;
    const order = mapOrderRow(row);
    const itemRows = await query('SELECT * FROM online_order_items WHERE order_id = ? ORDER BY id', [id]);
    order.items = itemRows.map(mapItemRow);
    const events = await query('SELECT * FROM online_order_events WHERE order_id = ? ORDER BY id', [id]);
    order.historial = events.map((e) => ({
      tipo: e.event_type,
      desde: e.from_status,
      hacia: e.to_status,
      detalle: e.detail || '',
      usuario: e.user_name || '',
      fecha: e.created_at,
    }));
    if (row.sale_id) {
      // ncf existe desde ensureNcfExtensions; una base muy vieja puede no tenerla.
      const sale = await query(
        `SELECT id, invoice_number, ncf, total, payment_method, document_type, fiscal_status, order_type,
                delivery_name_snapshot, delivery_status, created_at
           FROM sales WHERE id = ? LIMIT 1`,
        [row.sale_id],
      ).catch(() => query(
        `SELECT id, invoice_number, total, payment_method, document_type, fiscal_status, order_type,
                delivery_name_snapshot, delivery_status, created_at
           FROM sales WHERE id = ? LIMIT 1`,
        [row.sale_id],
      ));
      if (sale[0]) {
        order.venta = {
          ...order.venta,
          factura: sale[0].invoice_number,
          ncf: sale[0].ncf || '',
          total: num(sale[0].total),
          metodoPago: sale[0].payment_method,
          comprobante: sale[0].document_type,
          estadoFiscal: sale[0].fiscal_status,
          repartidor: sale[0].delivery_name_snapshot || '',
          estadoEntrega: sale[0].delivery_status || '',
          fecha: sale[0].created_at,
        };
      }
    }
    // Revisión contra el POS de hoy (existencia de la sucursal y precio actual).
    const stockMap = await branchStock(order.items.map((i) => i.productoId).filter(Boolean), branchId || order.sucursalId);
    order.revision = order.items.map((item) => {
      const actual = item.productoId ? stockMap.get(item.productoId) : null;
      return {
        itemId: item.id,
        existe: Boolean(actual),
        activo: actual ? actual.activo : false,
        precioActual: actual ? actual.precio : null,
        controlaStock: actual ? actual.controlaStock : false,
        existencia: actual ? actual.stock : null,
        suficiente: actual ? (!actual.controlaStock || actual.stock >= item.cantidad) : false,
      };
    });
    return order;
  }

  // ── Estados ───────────────────────────────────────────────────────────────

  function validarTransicion(row, nuevo) {
    const actual = row.status;
    if (actual === nuevo) throw httpError(`El pedido ya está ${ESTADO_ETIQUETAS[nuevo] || nuevo}.`, 409);
    if (ESTADOS_FINALES.includes(actual)) {
      throw httpError(`El pedido está ${ESTADO_ETIQUETAS[actual] || actual} y ya no cambia de estado.`, 409);
    }
    if (!(TRANSICIONES[actual] || []).includes(nuevo)) {
      throw httpError(`No se puede pasar de ${ESTADO_ETIQUETAS[actual] || actual} a ${ESTADO_ETIQUETAS[nuevo] || nuevo}.`, 409);
    }
    if ((nuevo === 'en_camino' || nuevo === 'entregado') && !row.sale_id) {
      throw httpError('Primero convierte el pedido en venta (cobro / factura) y luego márcalo como despachado o entregado.', 409, { code: 'REQUIERE_VENTA' });
    }
    if (nuevo === 'en_camino' && row.delivery_type !== 'delivery') {
      throw httpError('Este pedido es para retirar en tienda; no lleva delivery.', 409);
    }
    if ((nuevo === 'cancelado' || nuevo === 'rechazado') && row.sale_id) {
      throw httpError(`Este pedido ya se facturó (${row.sale_invoice_number || 'venta'}). Anula primero esa factura desde Movimientos y luego cancela el pedido.`, 409, { code: 'TIENE_VENTA' });
    }
  }

  async function changeStatus(id, nuevo, { motivo = '', actor = null } = {}) {
    const row = await getRow(id);
    if (!row) throw httpError('Pedido no encontrado.', 404);
    validarTransicion(row, nuevo);
    const now = nowSql();
    const reason = (nuevo === 'cancelado' || nuevo === 'rechazado') ? (texto(motivo, 255) || null) : null;
    const result = await query(
      `UPDATE online_orders
          SET status = ?, updated_at = ?, cloud_sync_pending = 1, change_seq = change_seq + 1,
              cancel_reason = COALESCE(?, cancel_reason),
              dispatched_at = CASE WHEN ? = 'en_camino' THEN ? ELSE dispatched_at END,
              delivered_at = CASE WHEN ? = 'entregado' THEN ? ELSE delivered_at END,
              processing_by_user_id = CASE WHEN ? IN ('cancelado', 'rechazado') THEN NULL ELSE processing_by_user_id END,
              processing_by_name = CASE WHEN ? IN ('cancelado', 'rechazado') THEN NULL ELSE processing_by_name END,
              processing_until = CASE WHEN ? IN ('cancelado', 'rechazado') THEN NULL ELSE processing_until END
        WHERE id = ? AND status = ?`,
      [nuevo, now, reason, nuevo, now, nuevo, now, nuevo, nuevo, nuevo, id, row.status],
    );
    if (!Number(result?.affectedRows || 0)) {
      throw httpError('El pedido cambió en otra caja. Actualiza la lista y vuelve a intentarlo.', 409, { code: 'CAMBIO_CONCURRENTE' });
    }
    await addEvent(db, id, { tipo: 'estado', desde: row.status, hacia: nuevo, detalle: reason || '', actor });
    const updated = await getRow(id);
    if (notifier) {
      await notifier.enqueueForStatus(mapOrderRow(updated), nuevo, { motivo: reason || '' }).catch((error) => {
        logger.warn?.('[tienda-online] No se pudo preparar el aviso al cliente:', error.message);
      });
    }
    emit('tienda-online:cambio', { id: Number(id), estado: nuevo });
    return mapOrderRow(updated);
  }

  // ── Conversión en venta ───────────────────────────────────────────────────

  async function findOrCreateClient(row) {
    const tel = digitos(row.customer_whatsapp || row.customer_phone);
    if (tel.length >= 7) {
      const ultimos = tel.slice(-10);
      const candidatos = await query(
        `SELECT * FROM clients WHERE telefono IS NOT NULL AND telefono LIKE ? LIMIT 60`,
        [`%${tel.slice(-4)}`],
      );
      const match = candidatos.find((c) => {
        const d = digitos(c.telefono);
        return d.length >= 7 && (d.slice(-10) === ultimos || ultimos.endsWith(d) || d.endsWith(ultimos));
      });
      if (match) return { row: match, creado: false };
    }
    const email = texto(row.customer_email, 160).toLowerCase();
    if (email) {
      const byEmail = await query('SELECT * FROM clients WHERE LOWER(email) = ? LIMIT 1', [email]);
      if (byEmail[0]) return { row: byEmail[0], creado: false };
    }
    const direccion = [row.delivery_address, row.delivery_sector, row.delivery_municipio, row.delivery_provincia]
      .filter(Boolean).join(', ').slice(0, 255);
    const insert = await query(
      `INSERT INTO clients (nombre, telefono, email, direccion, reference_note, sync_origin)
       VALUES (?, ?, ?, ?, ?, 'tienda_online')`,
      [
        texto(row.customer_name, 160) || 'Cliente tienda online',
        texto(row.customer_whatsapp || row.customer_phone, 40) || null,
        email || null,
        direccion || null,
        texto(row.delivery_reference, 255) || null,
      ],
    );
    const created = await query('SELECT * FROM clients WHERE id = ? LIMIT 1', [insert.insertId]);
    return { row: created[0], creado: true };
  }

  /**
   * Revisa el pedido contra el POS y devuelve el borrador para cargarlo en el
   * carrito de Ventas. Marca el pedido "en proceso" para avisar a las demás
   * cajas (la protección real contra doble cobro está en claimForSaleInTx).
   */
  async function prepareForSale(id, { actor, branchId = null, force = false } = {}) {
    const row = await getRow(id);
    if (!row) throw httpError('Pedido no encontrado.', 404);
    if (row.sale_id) {
      throw httpError(`Este pedido ya se convirtió en la venta ${row.sale_invoice_number || ''}.`, 409, { code: 'YA_CONVERTIDO' });
    }
    if (!ESTADOS_CONVERTIBLES.includes(row.status)) {
      throw httpError(`Un pedido ${ESTADO_ETIQUETAS[row.status] || row.status} no se puede cobrar.`, 409);
    }
    const now = nowSql();
    const actorId = Number(actor?.id || 0) || null;
    const lock = await query(
      `UPDATE online_orders
          SET processing_by_user_id = ?, processing_by_name = ?, processing_until = ?
        WHERE id = ? AND sale_id IS NULL
          AND (processing_until IS NULL OR processing_until < ? OR processing_by_user_id = ? OR ? = 1)`,
      [actorId, texto(actor?.nombre || actor?.usuario || 'Usuario', 160), plusMinutes(BLOQUEO_MINUTOS), id, now, actorId || 0, force ? 1 : 0],
    );
    if (!Number(lock?.affectedRows || 0)) {
      const current = await getRow(id);
      if (current?.sale_id) {
        throw httpError(`Este pedido ya se convirtió en la venta ${current.sale_invoice_number || ''}.`, 409, { code: 'YA_CONVERTIDO' });
      }
      throw httpError(`${current?.processing_by_name || 'Otra caja'} está cobrando este pedido ahora mismo.`, 409, {
        code: 'EN_PROCESO',
        por: current?.processing_by_name || '',
      });
    }

    const order = await get(id, { branchId: branchId || row.branch_id });
    const settingsRows = await query('SELECT settings_json FROM online_store_settings WHERE id = 1 LIMIT 1');
    const settings = parseSettings(settingsRows[0]?.settings_json);
    const respetarPrecio = settings.conversion?.precio !== 'actual';

    const avisos = [];
    if (branchId && row.branch_id && Number(branchId) !== Number(row.branch_id)) {
      avisos.push({ tipo: 'aviso', texto: 'Este pedido es de otra sucursal: se facturará y descontará el inventario de la sucursal de esta caja.' });
    }
    const items = [];
    order.items.forEach((item, index) => {
      const rev = order.revision[index];
      if (!item.productoId || !rev.existe) {
        avisos.push({ tipo: 'error', texto: `${item.nombre} ya no existe en el POS: no se agregará.` });
        return;
      }
      if (!rev.activo) {
        avisos.push({ tipo: 'error', texto: `${item.nombre} está inactivo en el POS: no se agregará.` });
        return;
      }
      if (rev.controlaStock && !rev.suficiente) {
        avisos.push({ tipo: 'aviso', texto: `${item.nombre}: piden ${item.cantidad} y hay ${rev.existencia} en la sucursal.` });
      }
      if (rev.precioActual !== null && Math.abs(rev.precioActual - (item.precioOriginal ?? item.precioUnitario)) > 0.009) {
        avisos.push({
          tipo: 'info',
          texto: respetarPrecio
            ? `${item.nombre}: el precio cambió (hoy ${rev.precioActual.toFixed(2)}); se respeta el del pedido (${item.precioUnitario.toFixed(2)}).`
            : `${item.nombre}: el precio cambió; se cobrará el precio actual (${rev.precioActual.toFixed(2)}).`,
        });
      }
      items.push({
        productoId: item.productoId,
        nombre: item.nombre,
        cantidad: item.cantidad,
        precioPactado: respetarPrecio ? item.precioUnitario : null,
        precioOriginal: item.precioOriginal,
        promocionId: item.promocionId,
        promocionNombre: item.promocionNombre,
      });
    });
    if (!items.length) {
      await releaseLock(id, actor).catch(() => {});
      throw httpError('Ningún producto del pedido se puede vender hoy en el POS. Revisa el pedido o recházalo.', 409, { avisos });
    }

    // Normalmente ya se ligó al llegar el pedido; si no (o lo borraron), se busca o crea ahora.
    let clientRow = row.client_id
      ? (await query('SELECT * FROM clients WHERE id = ? LIMIT 1', [row.client_id]))[0] || null
      : null;
    let creado = false;
    if (!clientRow) {
      ({ row: clientRow, creado } = await findOrCreateClient(row));
      if (clientRow?.id) await query('UPDATE online_orders SET client_id = ? WHERE id = ?', [clientRow.id, id]);
    }
    if (creado) avisos.push({ tipo: 'info', texto: `Se creó el cliente ${clientRow.nombre} en Clientes.` });

    const rnc = digitos(row.invoice_rnc);
    let ncfType = null;
    if (Number(row.invoice_requested || 0) === 1) {
      if ([9, 11].includes(rnc.length)) {
        ncfType = 'B01';
        avisos.push({ tipo: 'info', texto: `El cliente pidió comprobante fiscal a nombre de ${row.invoice_name || rnc} (RNC ${rnc}).` });
      } else {
        avisos.push({ tipo: 'aviso', texto: 'El cliente pidió comprobante fiscal pero el RNC no es válido; confírmalo antes de facturar.' });
      }
    }

    const direccion = [row.delivery_address, row.delivery_sector, row.delivery_municipio, row.delivery_provincia]
      .filter(Boolean).join(', ');
    const delivery = row.delivery_type === 'delivery';
    await addEvent(db, id, { tipo: 'cobro', detalle: 'Cargado en Ventas para cobrar', actor });
    emit('tienda-online:cambio', { id: Number(id), estado: row.status, enProceso: true });

    return {
      // telefono: a dónde se manda la factura por WhatsApp al cobrar.
      pedido: { id: Number(id), numero: Number(row.order_number), cliente: row.customer_name, telefono: texto(row.customer_whatsapp || row.customer_phone, 40) },
      items,
      cliente: clientRow ? mapClientRow(clientRow) : null,
      tipoPedido: delivery ? 'delivery' : 'recoger',
      telefono: texto(row.customer_whatsapp || row.customer_phone, 40),
      direccion,
      referencia: row.delivery_reference || '',
      delivery: delivery && num(row.delivery_fee) > 0 ? {
        nombre: `Envío a domicilio${row.delivery_zone ? ` (${row.delivery_zone})` : ''}`,
        costo: num(row.delivery_fee),
        aplicaItbis: num(row.delivery_fee_tax) > 0,
      } : null,
      metodoPago: metodoPosSugerido(row.payment_method, row.delivery_type),
      montoContraEntrega: num(row.total),
      ncfType,
      rnc: ncfType ? rnc : '',
      razonSocial: ncfType ? (row.invoice_name || '') : '',
      notas: [`Pedido online #${row.order_number}`, row.notes].filter(Boolean).join(' · ').slice(0, 500),
      totalPedido: num(row.total),
      avisos,
    };
  }

  async function releaseLock(id, actor = null, { anyUser = false } = {}) {
    const actorId = Number(actor?.id || 0) || 0;
    await query(
      `UPDATE online_orders
          SET processing_by_user_id = NULL, processing_by_name = NULL, processing_until = NULL
        WHERE id = ? AND sale_id IS NULL AND (processing_by_user_id = ? OR ? = 1)`,
      [id, actorId, anyUser ? 1 : 0],
    );
    emit('tienda-online:cambio', { id: Number(id) });
  }

  /**
   * Precios del pedido por producto, para que POST /api/sales respete lo que
   * el cliente pagó. Se leen de la base local (nunca del navegador).
   */
  async function agreedPricesInTx(conn, orderId) {
    const settingsRows = await conn.query('SELECT settings_json FROM online_store_settings WHERE id = 1 LIMIT 1');
    if (parseSettings(settingsRows[0]?.settings_json).conversion?.precio === 'actual') return new Map();
    const rows = await conn.query(
      'SELECT product_id, unit_price, original_price, promotion_id FROM online_order_items WHERE order_id = ? ORDER BY id',
      [orderId],
    );
    const map = new Map();
    for (const row of rows) {
      const productId = Number(row.product_id || 0);
      if (!productId || map.has(productId)) continue;
      map.set(productId, {
        price: num(row.unit_price),
        originalPrice: row.original_price === null || row.original_price === undefined ? null : num(row.original_price),
        promotionId: row.promotion_id ? Number(row.promotion_id) : null,
      });
    }
    return map;
  }

  /**
   * Liga el pedido a la venta DENTRO de la transacción de POST /api/sales.
   * Si el pedido ya tiene venta (otra caja, doble clic, reintento) lanza 409 y
   * la venta completa se deshace.
   */
  async function claimForSaleInTx(conn, { orderId, saleId, invoiceNumber, clientId = null, actor = null }) {
    const now = nowSql();
    const result = await conn.query(
      `UPDATE online_orders
          SET sale_id = ?, sale_invoice_number = ?, converted_at = ?, converted_by_user_id = ?,
              converted_by_user_name = ?, client_id = COALESCE(client_id, ?),
              status = CASE WHEN status = 'nuevo' THEN 'confirmado' ELSE status END,
              processing_by_user_id = NULL, processing_by_name = NULL, processing_until = NULL,
              cloud_sync_pending = 1, change_seq = change_seq + 1, updated_at = ?
        WHERE id = ? AND sale_id IS NULL
          AND status IN ('nuevo', 'confirmado', 'en_preparacion', 'listo')`,
      [saleId, invoiceNumber, now, actor?.id || null, texto(actor?.nombre || actor?.usuario || '', 160) || null, clientId || null, now, orderId],
    );
    if (!Number(result?.affectedRows || 0)) {
      const rows = await conn.query('SELECT status, sale_invoice_number FROM online_orders WHERE id = ? LIMIT 1', [orderId]);
      if (!rows[0]) throw httpError('El pedido online ya no existe.', 404);
      if (rows[0].sale_invoice_number) {
        throw httpError(`Este pedido online ya se cobró en la venta ${rows[0].sale_invoice_number}. No se registró otra venta.`, 409, { code: 'YA_CONVERTIDO' });
      }
      throw httpError(`El pedido online está ${ESTADO_ETIQUETAS[rows[0].status] || rows[0].status} y no se puede cobrar.`, 409);
    }
    await conn.query(`UPDATE sales SET online_order_id = ?, sync_origin = 'tienda_online' WHERE id = ?`, [orderId, saleId]);
    await addEvent(conn, orderId, { tipo: 'venta', detalle: `Convertido en la venta ${invoiceNumber}`, actor });
  }

  /** Factura anulada: el pedido queda libre para volver a cobrarse. */
  async function onSaleCancelledInTx(conn, sale, actor = null) {
    const orderId = Number(sale?.online_order_id || 0);
    if (!orderId) return null;
    const now = nowSql();
    const result = await conn.query(
      `UPDATE online_orders
          SET sale_id = NULL, sale_invoice_number = NULL, converted_at = NULL, converted_by_user_id = NULL,
              converted_by_user_name = NULL,
              status = CASE WHEN status IN ('en_camino', 'entregado') THEN 'listo' ELSE status END,
              cloud_sync_pending = 1, change_seq = change_seq + 1, updated_at = ?
        WHERE id = ? AND sale_id = ?`,
      [now, orderId, sale.id],
    );
    if (Number(result?.affectedRows || 0)) {
      await addEvent(conn, orderId, {
        tipo: 'venta',
        detalle: `Factura ${sale.invoice_number} anulada; el pedido puede cobrarse de nuevo`,
        actor,
      });
      return orderId;
    }
    return null;
  }

  /** Estado de entrega de la venta (panel Delivery) → estado del pedido. */
  async function onSaleDeliveryStatus(saleId, estadoEntrega, actor = null) {
    const rows = await query('SELECT id, status FROM online_orders WHERE sale_id = ? LIMIT 1', [saleId]);
    const row = rows[0];
    if (!row) return null;
    const destino = estadoEntrega === 'en_camino' ? 'en_camino' : estadoEntrega === 'entregado' ? 'entregado' : null;
    if (!destino || row.status === destino || ESTADOS_FINALES.includes(row.status)) return null;
    if (!(TRANSICIONES[row.status] || []).includes(destino)) return null;
    return changeStatus(row.id, destino, { actor }).catch((error) => {
      logger.warn?.('[tienda-online] No se pudo seguir el estado de entrega:', error.message);
      return null;
    });
  }

  // ── Reportes ──────────────────────────────────────────────────────────────

  async function stats({ desde, hasta, branchId = null }) {
    const d = `${desde} 00:00:00`;
    const h = `${hasta} 23:59:59`;
    const scopeO = branchId ? ' AND (branch_id = ? OR branch_id IS NULL)' : '';
    const pO = branchId ? [d, h, branchId] : [d, h];
    const porEstado = await query(
      `SELECT status, COUNT(*) AS pedidos, COALESCE(SUM(total), 0) AS total
         FROM online_orders WHERE received_at BETWEEN ? AND ?${scopeO} GROUP BY status`,
      pO,
    );
    const porDia = await query(
      `SELECT DATE(received_at) AS dia, COUNT(*) AS pedidos, COALESCE(SUM(total), 0) AS total
         FROM online_orders WHERE received_at BETWEEN ? AND ?${scopeO}
          AND status NOT IN ('cancelado', 'rechazado')
        GROUP BY DATE(received_at) ORDER BY dia`,
      pO,
    );
    const entrega = await query(
      `SELECT delivery_type AS tipo, COUNT(*) AS pedidos, COALESCE(SUM(delivery_fee), 0) AS cobrado
         FROM online_orders WHERE received_at BETWEEN ? AND ?${scopeO}
          AND status NOT IN ('cancelado', 'rechazado')
        GROUP BY delivery_type`,
      pO,
    );
    const clientes = await query(
      `SELECT customer_name AS nombre, customer_phone AS telefono, COUNT(*) AS pedidos, COALESCE(SUM(total), 0) AS total
         FROM online_orders WHERE received_at BETWEEN ? AND ?${scopeO}
          AND status NOT IN ('cancelado', 'rechazado')
        GROUP BY customer_name, customer_phone ORDER BY total DESC LIMIT 10`,
      pO,
    );
    const scopeS = branchId ? ' AND COALESCE(s.billed_branch_id, s.branch_id) = ?' : '';
    const pS = branchId ? [d, h, branchId] : [d, h];
    const ventas = await query(
      `SELECT COUNT(*) AS facturas, COALESCE(SUM(s.total), 0) AS total, COALESCE(SUM(s.tax), 0) AS itbis
         FROM sales s
        WHERE s.sync_origin = 'tienda_online' AND s.created_at BETWEEN ? AND ?
          AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'${scopeS}`,
      pS,
    );
    const productos = await query(
      `SELECT si.product_id AS id, COALESCE(si.item_name, p.nombre, 'Producto') AS nombre,
              COALESCE(SUM(si.qty), 0) AS cantidad, COALESCE(SUM(si.line_total), 0) AS total
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN products p ON p.id = si.product_id
        WHERE s.sync_origin = 'tienda_online' AND s.created_at BETWEEN ? AND ?
          AND COALESCE(s.fiscal_status, 'emitida') <> 'cancelada'${scopeS}
        GROUP BY si.product_id, COALESCE(si.item_name, p.nombre, 'Producto')
        ORDER BY total DESC LIMIT 10`,
      pS,
    );
    const toNum = (rows, keys) => rows.map((r) => {
      const out = { ...r };
      for (const k of keys) out[k] = num(r[k]);
      if (out.dia instanceof Date) out.dia = out.dia.toISOString().slice(0, 10);
      return out;
    });
    return {
      desde,
      hasta,
      porEstado: toNum(porEstado, ['pedidos', 'total']),
      porDia: toNum(porDia, ['pedidos', 'total']),
      entrega: toNum(entrega, ['pedidos', 'cobrado']),
      clientes: toNum(clientes, ['pedidos', 'total']),
      ventas: { facturas: num(ventas[0]?.facturas), total: num(ventas[0]?.total), itbis: num(ventas[0]?.itbis) },
      productos: toNum(productos, ['cantidad', 'total']),
    };
  }

  // ── Para el envío a la nube ───────────────────────────────────────────────

  async function itemProductIds(orderId) {
    const rows = await query('SELECT product_id FROM online_order_items WHERE order_id = ? AND product_id IS NOT NULL', [orderId]);
    return rows.map((r) => Number(r.product_id)).filter((n) => n > 0);
  }

  async function pendingSync(limit = 20) {
    return query(
      'SELECT * FROM online_orders WHERE cloud_sync_pending = 1 ORDER BY updated_at, id LIMIT ?',
      [limit],
    );
  }

  async function historyForCloud(orderId) {
    const events = await query(
      `SELECT to_status, detail, created_at FROM online_order_events
        WHERE order_id = ? AND event_type = 'estado' ORDER BY id`,
      [orderId],
    );
    return events.map((e) => ({ estado: e.to_status, en: sqlDateToIso(e.created_at), nota: e.detail || '' }));
  }

  async function markSynced(row, { liberada = false } = {}) {
    await query(
      `UPDATE online_orders
          SET cloud_sync_pending = CASE WHEN change_seq = ? THEN 0 ELSE 1 END,
              cloud_sync_attempts = 0, cloud_sync_error = NULL, cloud_synced_at = ?,
              reservation_released = CASE WHEN ? = 1 THEN 1 ELSE reservation_released END
        WHERE id = ?`,
      [Number(row.change_seq || 0), nowSql(), liberada ? 1 : 0, row.id],
    );
  }

  async function markSyncError(row, message) {
    await query(
      `UPDATE online_orders SET cloud_sync_attempts = cloud_sync_attempts + 1, cloud_sync_error = ? WHERE id = ?`,
      [texto(message, 255), row.id],
    );
  }

  return {
    TRANSICIONES,
    importOrder,
    vincularCliente,
    vincularClientesPendientes,
    list,
    summary,
    get,
    getRow,
    changeStatus,
    prepareForSale,
    releaseLock,
    agreedPricesInTx,
    claimForSaleInTx,
    onSaleCancelledInTx,
    onSaleDeliveryStatus,
    branchStock,
    stats,
    itemProductIds,
    pendingSync,
    historyForCloud,
    markSynced,
    markSyncError,
    mapOrderRow,
  };
}

module.exports = { createOrdersService, mapOrderRow, mapItemRow, metodoPosSugerido, sqlDateToIso, TRANSICIONES };

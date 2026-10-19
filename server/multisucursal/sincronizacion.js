'use strict';

/**
 * server/multisucursal/sincronizacion.js — Motor de sincronización de ESTA
 * sucursal con la central (Fase 5). Solo corre en la PC principal de la
 * sucursal y solo si está enlazada (token de equipo).
 *
 * Un ciclo (cada minuto, o al pulsar "Sincronizar ahora"):
 *   1. detectar(): busca en la base lo que cambió y lo anota en sync_outbox,
 *      en una transacción local por registro (la marca del registro y su
 *      evento se guardan juntos). No toca la ruta de la venta: la venta se
 *      guarda como siempre y aquí se detecta después por su marca.
 *        - ventas nuevas o que cambiaron de estado (anulada, devuelta)
 *        - precio, costo, existencia y disponibilidad de cada producto
 *        - en la principal: productos y usuarios publicados a la empresa
 *   2. enviar(): sube la bandeja de salida en lotes. Un evento solo queda
 *      'sincronizado' cuando la central lo confirma; si no hay Internet se
 *      reintenta con espera creciente (bandejas.js).
 *   3. recibir(): baja por cursor el catálogo, los usuarios, los cambios de
 *      precio explícitos y los rangos NCF. El cursor se guarda después de
 *      cada página: una descarga cortada sigue donde quedó.
 *   4. ncf.ajustar(): activa el siguiente rango NCF si el actual se agotó.
 * Cada ciclo queda en sync_bitacora (duración, eventos, bytes, resultado).
 *
 * Internet nunca bloquea la venta: todo esto corre en segundo plano.
 */

const crypto = require('crypto');
const { createMigrationContext } = require('../migrations/runner');
const { maestroProducto, huellaProducto, maestroUsuario, huellaUsuario, listaJson } = require('./catalogo-local');
const { ESTADOS_SALIDA } = require('./bandejas');

const STREAMS = ['usuarios', 'catalogo', 'comandos', 'ncf'];
const LOTE_SUBIDA = 200;
const PAGINA_BAJADA = 200;
const MAX_LOTES_POR_CICLO = 20;
const DIAS_HISTORIAL_VENTAS = 90;
const BITACORA_MAXIMA = 2000;
const VERDE_MS = 30 * 60 * 1000;

const ETIQUETAS = {
  usuarios: 'usuarios de la empresa',
  catalogo: 'catálogo de la empresa',
  comandos: 'cambios de precio',
  ncf: 'rangos NCF',
};

// event_id determinista para lo que baja (sync_inbox es la puerta de
// idempotencia: el mismo cambio aplicado dos veces se ignora).
function idCambio(stream, clave, version) {
  const h = crypto.createHash('sha1').update(`${stream}|${clave}|${version}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function createSincronizacion({
  query,
  withTransaction,
  dialect = 'sqlite',
  identidad,
  bandejas,
  enlace,
  ncf,
  now = () => new Date(),
  logger = console,
  auditar = async () => {},
  alAplicar = () => {},
  cicloMs = 60 * 1000,
}) {
  const ctxEsquema = createMigrationContext({ query, dialect });
  const cacheColumnas = new Map();
  let timers = [];
  let enCurso = null;
  let progreso = null;
  let ultimoError = null;
  let prontoTimer = null;

  async function tieneColumna(tabla, columna) {
    const clave = `${tabla}.${columna}`;
    if (!cacheColumnas.has(clave)) cacheColumnas.set(clave, await ctxEsquema.hasColumn(tabla, columna).catch(() => false));
    return cacheColumnas.get(clave);
  }

  const concat = (...partes) => (dialect === 'mysql' ? `CONCAT(${partes.join(', ')})` : partes.join(' || '));
  const aTexto = (col) => (dialect === 'mysql' ? `CAST(${col} AS CHAR)` : `CAST(${col} AS TEXT)`);
  const MARCA_VENTA = concat('sale_status', "'|'", "CASE WHEN canceled_at IS NULL THEN '0' ELSE '1' END");
  const MARCA_PRODUCTO = concat(aTexto('precio_venta'), "'|'", aTexto('precio_compra'), "'|'", aTexto('stock'), "'|'", 'estado');

  async function contexto() {
    const ident = await identidad.obtener();
    const e = await enlace.estado();
    return {
      companyUuid: ident.empresa.uuid,
      branchUuid: ident.sucursal.uuid,
      branchId: ident.sucursal.id,
      businessId: ident.empresa.id,
      esPrincipal: Boolean(e?.vinculado && e?.sucursal?.esPrincipal),
      vinculado: Boolean(e?.vinculado),
    };
  }

  // ── 1. Detectar ───────────────────────────────────────────────────────────

  // Cada registro en su propia transacción corta. Si uno falla (por ejemplo,
  // MariaDB lo tenía bloqueado una venta en ese instante), se sigue con los
  // demás y se reintenta en el próximo ciclo.
  let fallosDeteccion = 0;
  async function porFila(trabajo) {
    try {
      return await withTransaction(trabajo);
    } catch (error) {
      fallosDeteccion += 1;
      logger.warn?.('[multisucursal] No se pudo anotar un cambio (se reintenta en el próximo ciclo):', error.message);
      return null;
    }
  }

  async function prepararHistorialVentas() {
    if (await bandejas.leerCursor(query, 'inicio:ventas')) return;
    // Al enlazar: suben los últimos 90 días (reportes de la central); lo más
    // viejo se marca como ya enviado.
    const limite = new Date(now().getTime() - DIAS_HISTORIAL_VENTAS * 86400000).toISOString().slice(0, 10);
    await query(`UPDATE sales SET sync_marca = ${MARCA_VENTA} WHERE sync_marca IS NULL AND created_at < ?`, [limite]);
    await bandejas.guardarCursor(query, 'inicio:ventas', now().toISOString());
  }

  async function payloadVenta(conn, venta) {
    const items = await conn.query(
      `SELECT si.qty, si.price, si.tax_amount, si.line_total, si.item_name, p.uuid AS product_uuid, p.codigo, p.nombre
         FROM sale_items si LEFT JOIN products p ON p.id = si.product_id
        WHERE si.sale_id = ?`,
      [venta.id]
    );
    const cajero = await conn.query('SELECT nombre FROM users WHERE id = ? LIMIT 1', [venta.user_id]).catch(() => []);
    return {
      factura: venta.invoice_number,
      fecha: String(venta.created_at || ''),
      fechaOperativa: venta.operative_date ? String(venta.operative_date).slice(0, 10) : String(venta.created_at || '').slice(0, 10),
      subtotal: Number(venta.subtotal || 0),
      descuento: Number(venta.discount || 0),
      itbis: Number(venta.tax || 0),
      total: Number(venta.total || 0),
      metodoPago: venta.payment_method,
      estado: venta.sale_status,
      anulada: Boolean(venta.canceled_at),
      ncf: venta.ncf || null,
      tipoNcf: venta.ncf_type || null,
      cliente: venta.client_name_snapshot || null,
      cajero: cajero[0]?.nombre || null,
      items: items.map((it) => ({
        productUuid: it.product_uuid || null,
        codigo: it.codigo || '',
        nombre: it.item_name || it.nombre || '',
        cantidad: Number(it.qty || 0),
        precio: Number(it.price || 0),
        itbis: Number(it.tax_amount || 0),
        total: Number(it.line_total || 0),
      })),
    };
  }

  async function detectarVentas(ctx) {
    await prepararHistorialVentas();
    const filas = await query(
      `SELECT id FROM sales WHERE sync_marca IS NULL OR sync_marca <> ${MARCA_VENTA} ORDER BY id LIMIT 500`
    );
    let n = 0;
    for (const { id } of filas) {
      await porFila(async (conn) => {
        const [venta] = await conn.query('SELECT * FROM sales WHERE id = ? LIMIT 1', [id]);
        if (!venta) return;
        const marca = `${venta.sale_status}|${venta.canceled_at ? '1' : '0'}`;
        if (venta.sync_marca === marca) return;
        const uuid = await identidad.asegurarUuid(conn.query.bind(conn), 'sales', id);
        await bandejas.registrarSalida(conn, {
          companyUuid: ctx.companyUuid, branchUuid: ctx.branchUuid, entityType: 'venta', entityUuid: uuid,
          operation: 'registrar', payload: await payloadVenta(conn, venta),
        });
        await conn.query('UPDATE sales SET sync_marca = ? WHERE id = ?', [marca, id]);
        n += 1;
      });
    }
    return n;
  }

  async function detectarProductosSucursal(ctx) {
    const filas = await query(
      `SELECT id FROM products WHERE sucursal_marca IS NULL OR sucursal_marca <> ${MARCA_PRODUCTO} ORDER BY id LIMIT 1000`
    );
    let n = 0;
    for (const { id } of filas) {
      await porFila(async (conn) => {
        const [p] = await conn.query(
          `SELECT id, codigo, nombre, precio_venta, precio_compra, stock, estado, sucursal_marca, ${MARCA_PRODUCTO} AS marca
             FROM products WHERE id = ? LIMIT 1`,
          [id]
        );
        if (!p || p.sucursal_marca === p.marca) return;
        const uuid = await identidad.asegurarUuid(conn.query.bind(conn), 'products', id);
        await bandejas.registrarSalida(conn, {
          companyUuid: ctx.companyUuid, branchUuid: ctx.branchUuid, entityType: 'producto_sucursal', entityUuid: uuid,
          operation: 'actualizar',
          payload: {
            codigo: p.codigo, nombre: p.nombre, precio: Number(p.precio_venta || 0), costo: Number(p.precio_compra || 0),
            stock: Number(p.stock || 0), estado: p.estado, marcaTiempo: now().toISOString(),
          },
        });
        await conn.query('UPDATE products SET sucursal_marca = ? WHERE id = ?', [p.marca, id]);
        n += 1;
      });
    }
    return n;
  }

  // Solo la principal publica productos a la empresa.
  async function detectarCatalogoPublicado(ctx) {
    if (!ctx.esPrincipal) return 0;
    const filas = await query(
      `SELECT * FROM products
        WHERE origen_catalogo = 'local' AND (alcance_empresa <> 'local' OR catalogo_hash IS NOT NULL)
        ORDER BY id LIMIT 2000`
    );
    let n = 0;
    for (const row of filas) {
      const retirar = row.alcance_empresa === 'local';
      const h = retirar ? null : huellaProducto(row);
      if (!retirar && h === row.catalogo_hash) continue;
      await porFila(async (conn) => {
        const uuid = await identidad.asegurarUuid(conn.query.bind(conn), 'products', row.id);
        await bandejas.registrarSalida(conn, {
          companyUuid: ctx.companyUuid, branchUuid: ctx.branchUuid, entityType: 'producto', entityUuid: uuid,
          operation: retirar ? 'retirar' : 'publicar',
          payload: retirar ? {} : {
            ...maestroProducto(row),
            alcance: row.alcance_empresa,
            sucursales: row.alcance_empresa === 'sucursales' ? listaJson(row.sucursales_empresa) || [] : [],
            precioSugerido: Number(row.precio_venta || 0),
            costoSugerido: Number(row.precio_compra || 0),
          },
        });
        await conn.query('UPDATE products SET catalogo_hash = ? WHERE id = ?', [h, row.id]);
        n += 1;
      });
    }
    return n;
  }

  async function detectarUsuariosPublicados(ctx) {
    if (!ctx.esPrincipal) return 0;
    const filas = await query(
      `SELECT u.*, r.codigo AS role_code FROM users u LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.origen_usuario = 'local' AND (u.sucursales_empresa IS NOT NULL OR u.usuario_hash IS NOT NULL)
        ORDER BY u.id LIMIT 1000`
    );
    let n = 0;
    for (const row of filas) {
      const retirar = !listaJson(row.sucursales_empresa)?.length;
      const h = retirar ? null : huellaUsuario(row, row.role_code);
      if (!retirar && h === row.usuario_hash) continue;
      if (retirar && !row.usuario_hash) continue;
      await porFila(async (conn) => {
        const uuid = await identidad.asegurarUuid(conn.query.bind(conn), 'users', row.id);
        await bandejas.registrarSalida(conn, {
          companyUuid: ctx.companyUuid, branchUuid: ctx.branchUuid, entityType: 'usuario', entityUuid: uuid,
          operation: retirar ? 'retirar' : 'publicar',
          payload: retirar ? {} : { ...maestroUsuario(row, row.role_code), sucursales: listaJson(row.sucursales_empresa) },
        });
        await conn.query('UPDATE users SET usuario_hash = ? WHERE id = ?', [h, row.id]);
        n += 1;
      });
    }
    return n;
  }

  async function detectar() {
    const ctx = await contexto();
    if (!ctx.companyUuid || !ctx.branchUuid) return { ventas: 0, productos: 0, catalogo: 0, usuarios: 0, fallos: 0 };
    fallosDeteccion = 0;
    return {
      ventas: await detectarVentas(ctx),
      productos: await detectarProductosSucursal(ctx),
      catalogo: await detectarCatalogoPublicado(ctx),
      usuarios: await detectarUsuariosPublicados(ctx),
      fallos: fallosDeteccion,
    };
  }

  // ── 2. Enviar ─────────────────────────────────────────────────────────────

  async function enviar(contadores) {
    for (let lote = 0; lote < MAX_LOTES_POR_CICLO; lote += 1) {
      const pendientes = await bandejas.pendientes(query, { limite: LOTE_SUBIDA });
      if (!pendientes.length) return;
      progreso = { etapa: 'Subiendo cambios', hechos: contadores.enviados, total: contadores.enviados + pendientes.length };
      const cuerpo = {
        eventos: pendientes.map((e) => ({
          eventId: e.event_id, entityType: e.entity_type, entityUuid: e.entity_uuid,
          operation: e.operation, version: e.entity_version, payload: e.payload,
        })),
      };
      contadores.bytesEnviados += Buffer.byteLength(JSON.stringify(cuerpo), 'utf8');
      contadores.enviados += pendientes.length;
      let r;
      try {
        r = await enlace.llamarSync('POST', '/v1/eventos', cuerpo);
      } catch (error) {
        // El código va al inicio: así se sabe cuáles fallaron solo por la red.
        for (const e of pendientes) await bandejas.marcarError(query, e.event_id, `${error.code || 'ERROR'}: ${error.message}`);
        throw error;
      }
      contadores.bytesRecibidos += Buffer.byteLength(JSON.stringify(r || {}), 'utf8');
      const resultados = Array.isArray(r?.resultados) ? r.resultados : [];
      const confirmados = resultados.filter((x) => x.resultado === 'ok' || x.resultado === 'duplicado').map((x) => x.eventId);
      await bandejas.confirmar(query, confirmados);
      contadores.confirmados += confirmados.length;
      for (const x of resultados.filter((y) => y.resultado === 'rechazado')) {
        await bandejas.marcarError(query, x.eventId, `${x.code || 'RECHAZADO'}: ${x.motivo || ''}`, { rechazado: true });
        contadores.rechazados += 1;
        contadores.detalles.push({ eventId: x.eventId, code: x.code, motivo: x.motivo });
      }
      if (pendientes.length < LOTE_SUBIDA) return;
    }
  }

  // ── 3. Recibir y aplicar ──────────────────────────────────────────────────

  async function registrarConflicto(conn, { entityType, entityUuid, clave, localId, payload, motivo }) {
    const existe = await conn.query('SELECT id FROM sync_conflictos WHERE entity_type = ? AND entity_uuid = ? LIMIT 1', [entityType, entityUuid]);
    if (existe.length) {
      await conn.query(
        "UPDATE sync_conflictos SET payload = ?, motivo = ?, clave = ?, local_id = ?, estado = 'pendiente', resuelto_at_utc = NULL WHERE id = ?",
        [JSON.stringify(payload), motivo, clave, localId, existe[0].id]
      );
    } else {
      await conn.query(
        `INSERT INTO sync_conflictos (entity_type, entity_uuid, clave, local_id, payload, motivo, estado, created_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?)`,
        [entityType, entityUuid, clave, localId, JSON.stringify(payload), motivo, now().toISOString()]
      );
    }
  }

  async function asegurarCategoria(conn, nombre) {
    const existe = await conn.query('SELECT id FROM categories WHERE nombre = ? LIMIT 1', [nombre]).catch(() => []);
    if (!existe.length) await conn.query('INSERT INTO categories (nombre) VALUES (?)', [nombre]).catch(() => {});
  }

  async function columnasProducto(d) {
    const cols = {
      codigo: d.codigo, nombre: d.nombre, categoria: d.categoria, marca: d.marca || null, unidad: d.unidad,
      sale_mode: d.saleMode, product_type: d.productType, aplica_itbis: d.aplicaItbis ? 1 : 0,
      itbis_modo: d.itbisModo === 'monto' ? 'monto' : 'porcentaje', itbis_monto: Number(d.itbisMonto || 0),
      tracks_stock: d.tracksStock === false ? 0 : 1,
    };
    if (await tieneColumna('products', 'barcode')) cols.barcode = d.barcode || d.codigo;
    return cols;
  }

  // Producto del catálogo de la empresa. `vincularA`: id local elegido a mano
  // para un conflicto (mismo código, otra identidad).
  async function aplicarProducto(conn, item, { vincularA = null } = {}) {
    const [local] = vincularA
      ? await conn.query('SELECT * FROM products WHERE id = ? LIMIT 1', [vincularA])
      : await conn.query('SELECT * FROM products WHERE uuid = ? LIMIT 1', [item.uuid]);
    // La principal es la que lo publicó: no se aplica a sí misma.
    if (local && local.origen_catalogo === 'local' && local.alcance_empresa !== 'local') return 'propio';
    if (!item.asignado) {
      if (local && local.origen_catalogo === 'central') {
        await conn.query("UPDATE products SET estado = 'Inactivo', catalogo_estado = 'Inactivo', catalogo_version = ? WHERE id = ?", [item.version, local.id]);
        return 'desasignado';
      }
      return 'no_asignado';
    }
    const d = item.datos || {};
    const cols = await columnasProducto(d);
    if (local) {
      if (!vincularA && Number(local.catalogo_version || 0) >= Number(item.version)) return 'al_dia';
      // La disponibilidad local solo cambia si la central cambió su estado.
      const estado = local.catalogo_estado !== d.estado || vincularA ? d.estado : local.estado;
      const sets = Object.keys(cols).map((c) => `${c} = ?`).join(', ');
      if (vincularA) await conn.query('UPDATE products SET uuid = NULL WHERE uuid = ? AND id <> ?', [item.uuid, local.id]);
      await conn.query(
        `UPDATE products SET ${sets}, estado = ?, uuid = ?, origen_catalogo = 'central', alcance_empresa = 'local',
                catalogo_version = ?, catalogo_estado = ? WHERE id = ?`,
        [...Object.values(cols), estado, item.uuid, item.version, d.estado, local.id]
      );
      await asegurarCategoria(conn, d.categoria);
      return vincularA ? 'vinculado' : 'actualizado';
    }
    const choque = await conn.query(
      `SELECT id, codigo, nombre FROM products WHERE (codigo = ?${cols.barcode ? ' OR barcode = ?' : ''}) LIMIT 1`,
      cols.barcode ? [d.codigo, cols.barcode] : [d.codigo]
    );
    if (choque.length) {
      await registrarConflicto(conn, {
        entityType: 'producto', entityUuid: item.uuid, clave: d.codigo, localId: choque[0].id, payload: item,
        motivo: `Ya hay un producto local con el código ${d.codigo} (${choque[0].nombre}).`,
      });
      return 'conflicto';
    }
    const columnas = { ...cols, precio_compra: Number(d.costoSugerido || 0), precio_venta: Number(d.precioSugerido || 0), stock: 0, stock_min: 0 };
    const nombres = Object.keys(columnas);
    await conn.query(
      `INSERT INTO products (${nombres.join(', ')}, estado, uuid, origen_catalogo, alcance_empresa, catalogo_version, catalogo_estado)
       VALUES (${nombres.map(() => '?').join(', ')}, ?, ?, 'central', 'local', ?, ?)`,
      [...Object.values(columnas), d.estado, item.uuid, item.version, d.estado]
    );
    await asegurarCategoria(conn, d.categoria);
    return 'creado';
  }

  async function aplicarUsuario(conn, item, ctx, { vincularA = null } = {}) {
    const [local] = vincularA
      ? await conn.query('SELECT * FROM users WHERE id = ? LIMIT 1', [vincularA])
      : await conn.query('SELECT * FROM users WHERE uuid = ? LIMIT 1', [item.uuid]);
    if (local && local.origen_usuario === 'local' && local.sucursales_empresa) return 'propio';
    if (!item.asignado) {
      if (local && local.origen_usuario === 'central') {
        await conn.query("UPDATE users SET estado = 'Inactivo', usuario_version = ? WHERE id = ?", [item.version, local.id]);
        await conn.query("UPDATE user_branch_access SET estado = 'Inactivo' WHERE user_id = ?", [local.id]).catch(() => {});
        return 'desasignado';
      }
      return 'no_asignado';
    }
    const d = item.datos || {};
    const roles = await conn.query('SELECT id FROM roles WHERE codigo = ? LIMIT 1', [d.roleCode]).catch(() => []);
    const roleId = roles[0]?.id || null;
    const conFacturacion = await tieneColumna('users', 'tipo_facturacion');
    let userId;
    if (local) {
      if (!vincularA && Number(local.usuario_version || 0) >= Number(item.version)) return 'al_dia';
      if (vincularA) await conn.query('UPDATE users SET uuid = NULL WHERE uuid = ? AND id <> ?', [item.uuid, local.id]);
      await conn.query(
        `UPDATE users SET usuario = ?, nombre = ?, rol = ?, role_id = ?, password = '', password_hash = ?, estado = ?,
                branch_id = ?, sucursal_id = ?, uuid = ?, origen_usuario = 'central', sucursales_empresa = NULL,
                usuario_version = ?${conFacturacion ? ', tipo_facturacion = COALESCE(?, tipo_facturacion)' : ''}
          WHERE id = ?`,
        [d.usuario, d.nombre, d.rol, roleId, d.passwordHash, d.estado, ctx.branchId, ctx.branchId, item.uuid, item.version,
          ...(conFacturacion ? [d.tipoFacturacion] : []), local.id]
      );
      userId = local.id;
    } else {
      const choque = await conn.query('SELECT id, nombre FROM users WHERE LOWER(usuario) = LOWER(?) LIMIT 1', [d.usuario]);
      if (choque.length) {
        await registrarConflicto(conn, {
          entityType: 'usuario', entityUuid: item.uuid, clave: d.usuario, localId: choque[0].id, payload: item,
          motivo: `Ya hay un usuario local "${d.usuario}" (${choque[0].nombre}).`,
        });
        return 'conflicto';
      }
      const emailLibre = d.email
        ? !(await conn.query('SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1', [d.email])).length
        : false;
      const r = await conn.query(
        `INSERT INTO users (usuario, email, password, password_hash, nombre, rol, role_id, estado, last_login, branch_id, sucursal_id,
                            uuid, origen_usuario, usuario_version${conFacturacion ? ', tipo_facturacion' : ''})
         VALUES (?, ?, '', ?, ?, ?, ?, ?, '—', ?, ?, ?, 'central', ?${conFacturacion ? ', ?' : ''})`,
        [d.usuario, emailLibre ? d.email : null, d.passwordHash, d.nombre, d.rol, roleId, d.estado, ctx.branchId, ctx.branchId,
          item.uuid, item.version, ...(conFacturacion ? [d.tipoFacturacion || 'mixta'] : [])]
      );
      userId = r.insertId;
    }
    if (ctx.branchId) {
      const acceso = await conn.query('SELECT id FROM user_branch_access WHERE user_id = ? AND branch_id = ? LIMIT 1', [userId, ctx.branchId]).catch(() => null);
      if (acceso && !acceso.length) {
        await conn.query(
          "INSERT INTO user_branch_access (user_id, branch_id, access_type, estado, origen) VALUES (?, ?, 'principal', ?, 'central')",
          [userId, ctx.branchId, d.estado]
        ).catch(() => {});
      } else if (acceso) {
        await conn.query('UPDATE user_branch_access SET estado = ? WHERE user_id = ? AND branch_id = ?', [d.estado, userId, ctx.branchId]).catch(() => {});
      }
    }
    return vincularA ? 'vinculado' : (local ? 'actualizado' : 'creado');
  }

  // La auditoría se escribe DESPUÉS de la transacción (`notas`).
  async function aplicarComando(conn, item, notas) {
    if (item.tipo !== 'precio') return 'ignorado';
    const [p] = await conn.query('SELECT id, codigo, nombre, precio_venta FROM products WHERE uuid = ? LIMIT 1', [item.productUuid]);
    if (!p) return 'sin_producto';
    await conn.query('UPDATE products SET precio_venta = ? WHERE id = ?', [Number(item.precio), p.id]);
    notas.push(['Precio cambiado por la principal', `${p.codigo} · ${p.nombre}: ${p.precio_venta} → ${item.precio}`]);
    return 'aplicado';
  }

  // Dentro de las transacciones solo hay consultas a la base (nada de red ni
  // archivos): en SQLite así ninguna otra petición se mete en medio.
  async function aplicarItem(stream, item, ctx) {
    const clave = item.uuid || item.id || item.rangoUuid;
    const eventId = idCambio(stream, clave, item.version ?? item.seq);
    if (stream === 'ncf') {
      // registrar() es idempotente por rango_uuid.
      return ncf.registrar(item);
    }
    const notas = [];
    const r = await withTransaction(async (conn) => {
      const nuevo = await bandejas.registrarEntrada(conn, {
        eventId, companyUuid: ctx.companyUuid, branchUuid: item.origenBranchUuid || null,
        entityType: stream, entityUuid: String(clave).slice(0, 36), version: item.version || 1,
      });
      if (nuevo === 'duplicado') return 'duplicado';
      let res;
      if (stream === 'catalogo') res = await aplicarProducto(conn, item);
      else if (stream === 'usuarios') res = await aplicarUsuario(conn, item, ctx);
      else res = await aplicarComando(conn, item, notas);
      await bandejas.marcarEntrada(conn, eventId, res === 'conflicto' || res === 'sin_producto' ? 'rechazado' : 'aplicado', res === 'conflicto' ? 'conflicto' : null);
      return res;
    });
    for (const [accion, detalle] of notas) await auditar(accion, detalle).catch(() => {});
    return r;
  }

  async function recibir(contadores, ctx) {
    for (const stream of STREAMS) {
      let desde = Number(await bandejas.leerCursor(query, `bajada:${stream}`) || 0);
      let primera = true;
      let hechos = 0;
      let total = null;
      for (let pagina = 0; pagina < 500; pagina += 1) {
        const r = await enlace.llamarSync('GET', `/v1/cambios?tipo=${stream}&desde=${desde}&limite=${PAGINA_BAJADA}${primera ? '&contar=1' : ''}`);
        contadores.bytesRecibidos += Buffer.byteLength(JSON.stringify(r || {}), 'utf8');
        if (primera && Number.isFinite(Number(r?.pendientes))) total = Number(r.pendientes);
        primera = false;
        const items = Array.isArray(r?.items) ? r.items : [];
        for (const item of items) {
          const resultado = await aplicarItem(stream, item, ctx);
          contadores.recibidos += 1;
          hechos += 1;
          if (resultado === 'conflicto') contadores.conflictos += 1;
          else if (!['duplicado', 'al_dia', 'propio', 'no_asignado', 'sin_cambios', 'ignorado'].includes(resultado)) contadores.aplicados += 1;
          progreso = { etapa: `Descargando ${ETIQUETAS[stream]}`, hechos, total: total ?? hechos };
        }
        if (items.length) {
          desde = Number(r.siguiente);
          await bandejas.guardarCursor(query, `bajada:${stream}`, String(desde));
        }
        if (!r?.hayMas) break;
      }
    }
    if (contadores.aplicados) alAplicar();
  }

  // ── Ciclo ─────────────────────────────────────────────────────────────────

  async function registrarBitacora(fila) {
    await query(
      `INSERT INTO sync_bitacora (started_at_utc, finished_at_utc, duracion_ms, resultado, enviados, confirmados, rechazados,
                             recibidos, aplicados, conflictos, bytes_enviados, bytes_recibidos, detalle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fila.inicio, fila.fin, fila.duracion, fila.resultado, fila.enviados, fila.confirmados, fila.rechazados,
        fila.recibidos, fila.aplicados, fila.conflictos, fila.bytesEnviados, fila.bytesRecibidos, fila.detalle]
    ).catch(() => {});
    const max = await query('SELECT MAX(id) AS id FROM sync_bitacora').catch(() => []);
    const tope = Number(max[0]?.id || 0) - BITACORA_MAXIMA;
    if (tope > 0) await query('DELETE FROM sync_bitacora WHERE id <= ?', [tope]).catch(() => {});
  }

  async function ejecutarCiclo() {
    const inicio = now();
    const contadores = {
      enviados: 0, confirmados: 0, rechazados: 0, recibidos: 0, aplicados: 0, conflictos: 0,
      bytesEnviados: 0, bytesRecibidos: 0, detalles: [],
    };
    let resultado = 'ok';
    let detectados = null;
    try {
      const ctx = await contexto();
      if (!ctx.vinculado) return { omitido: 'sin_enlace' };
      progreso = { etapa: 'Revisando cambios', hechos: 0, total: 0 };
      detectados = await detectar();
      await enviar(contadores);
      await recibir(contadores, ctx);
      // Hay conexión con la central: lo que falló solo por falta de red sale
      // ya, sin esperar su espera creciente (que puede llegar a 1 hora).
      await query(
        'UPDATE sync_outbox SET next_attempt_at_utc = NULL WHERE status = ? AND last_error LIKE ?',
        [ESTADOS_SALIDA.ERROR, 'SIN_CONEXION%']
      );
      progreso = { etapa: 'Rangos NCF', hechos: 0, total: 0 };
      await ncf.ajustar();
      // Lo reanudado y lo que generó ajustar() (estado de rangos) sube en este mismo ciclo.
      await enviar(contadores);
      if (contadores.rechazados || contadores.conflictos) resultado = 'parcial';
      ultimoError = null;
    } catch (error) {
      resultado = ['SIN_CONEXION', 'SIN_CONFIGURAR'].includes(error.code) ? 'sin_conexion' : 'error';
      ultimoError = { codigo: error.code || null, mensaje: error.message, at: now().toISOString() };
      contadores.detalles.push({ error: error.message, code: error.code || null });
      if (resultado === 'error') logger.warn?.('[multisucursal] Ciclo de sincronización con error:', error.message);
    } finally {
      progreso = null;
    }
    const fin = now();
    const fila = {
      ...contadores,
      inicio: inicio.toISOString(),
      fin: fin.toISOString(),
      duracion: fin.getTime() - inicio.getTime(),
      resultado,
      detalle: JSON.stringify({ detectados, detalles: contadores.detalles.slice(0, 20) }),
    };
    await registrarBitacora(fila);
    return { resultado, detectados, ...contadores, duracionMs: fila.duracion };
  }

  // Un solo ciclo a la vez; quien llama mientras corre recibe el mismo.
  function ciclo() {
    if (!enCurso) {
      enCurso = ejecutarCiclo().finally(() => { enCurso = null; });
    }
    return enCurso;
  }

  // Un cambio local (producto o usuario publicado): ciclo en unos segundos.
  function pronto(ms = 5000) {
    if (!timers.length) return;
    clearTimeout(prontoTimer);
    prontoTimer = setTimeout(() => { ciclo().catch(() => {}); }, ms);
    if (typeof prontoTimer.unref === 'function') prontoTimer.unref();
  }

  // ── Conflictos (resolución manual) ────────────────────────────────────────

  async function listarConflictos() {
    const filas = await query("SELECT id, entity_type, entity_uuid, clave, local_id, motivo, created_at_utc FROM sync_conflictos WHERE estado = 'pendiente' ORDER BY id").catch(() => []);
    return filas.map((f) => ({
      id: f.id, tipo: f.entity_type, uuid: f.entity_uuid, clave: f.clave, localId: f.local_id, motivo: f.motivo, creado: f.created_at_utc,
    }));
  }

  // "Vincular": el registro local pasa a ser el de la empresa (toma su
  // identidad y sus datos maestros; conserva precio, existencia e historial).
  async function resolverConflicto(id, accion = 'vincular') {
    const [c] = await query("SELECT * FROM sync_conflictos WHERE id = ? AND estado = 'pendiente' LIMIT 1", [Number(id)]);
    if (!c) return { ok: false, motivo: 'Conflicto no encontrado o ya resuelto.' };
    if (accion === 'ignorar') {
      await query("UPDATE sync_conflictos SET estado = 'ignorado', resuelto_at_utc = ? WHERE id = ?", [now().toISOString(), c.id]);
      return { ok: true, resultado: 'ignorado' };
    }
    const ctx = await contexto();
    const item = JSON.parse(c.payload);
    const r = await withTransaction(async (conn) => {
      const res = c.entity_type === 'producto'
        ? await aplicarProducto(conn, item, { vincularA: c.local_id })
        : await aplicarUsuario(conn, item, ctx, { vincularA: c.local_id });
      await conn.query("UPDATE sync_conflictos SET estado = 'resuelto', resuelto_at_utc = ? WHERE id = ?", [now().toISOString(), c.id]);
      return res;
    });
    await auditar('Conflicto de sincronización resuelto', `${c.entity_type} ${c.clave}: ${r}`).catch(() => {});
    alAplicar();
    return { ok: true, resultado: r };
  }

  async function resolverTodos(accion = 'vincular') {
    const lista = await listarConflictos();
    let n = 0;
    for (const c of lista) {
      const r = await resolverConflicto(c.id, accion);
      if (r.ok) n += 1;
    }
    return { resueltos: n };
  }

  // Reintentar ya: lo que la central rechazó (por ejemplo, después de corregir
  // un código repetido en la principal) y lo que espera por un error.
  async function reintentarRechazados() {
    const r = await query(
      'UPDATE sync_outbox SET status = ?, next_attempt_at_utc = NULL WHERE status IN (?, ?)',
      [ESTADOS_SALIDA.PENDIENTE, ESTADOS_SALIDA.RECHAZADO, ESTADOS_SALIDA.ERROR]
    );
    return { reintentados: Number(r?.affectedRows || 0) };
  }

  // ── Acciones de la principal ──────────────────────────────────────────────

  let cacheSucursales = null;
  async function sucursalesEmpresa({ refrescar = false } = {}) {
    if (!refrescar && cacheSucursales && now().getTime() - cacheSucursales.at < 5 * 60 * 1000) return cacheSucursales.lista;
    const r = await enlace.llamarSync('GET', '/v1/sucursales');
    cacheSucursales = { at: now().getTime(), lista: r.sucursales || [] };
    return cacheSucursales.lista;
  }

  async function exigirPrincipal() {
    const ctx = await contexto();
    if (!ctx.esPrincipal) {
      const error = new Error('Solo la sucursal principal administra el catálogo y los usuarios de la empresa.');
      error.statusCode = 403;
      error.code = 'SOLO_PRINCIPAL';
      throw error;
    }
    return ctx;
  }

  // Publica a la empresa todo el catálogo activo de la principal (paso inicial
  // al volverse multisucursal). Los productos ya publicados no cambian.
  async function publicarCatalogo() {
    await exigirPrincipal();
    const r = await query(
      "UPDATE products SET alcance_empresa = 'global' WHERE origen_catalogo = 'local' AND alcance_empresa = 'local' AND estado = 'Activo'"
    );
    pronto(1000);
    return { publicados: Number(r?.affectedRows || 0) };
  }

  // Cambio de precio explícito en las sucursales elegidas (la única forma en
  // que un precio local cambia desde fuera). El producto tiene que estar
  // publicado a la empresa.
  async function precioEnSucursales({ productId, codigo, precio, sucursales }) {
    const ctx = await exigirPrincipal();
    const valor = Math.round(Number(precio) * 100) / 100;
    if (!(valor > 0)) {
      const error = new Error('El precio debe ser mayor que cero.');
      error.statusCode = 400;
      throw error;
    }
    const lista = [...new Set((Array.isArray(sucursales) ? sucursales : []).map((s) => String(s).toLowerCase()))];
    if (!lista.length) {
      const error = new Error('Elige al menos una sucursal.');
      error.statusCode = 400;
      throw error;
    }
    const [p] = productId
      ? await query('SELECT id, uuid, codigo, nombre, alcance_empresa FROM products WHERE id = ? LIMIT 1', [Number(productId)])
      : await query('SELECT id, uuid, codigo, nombre, alcance_empresa FROM products WHERE codigo = ? LIMIT 1', [String(codigo || '').trim()]);
    if (!p || p.alcance_empresa === 'local' || !p.uuid) {
      const error = new Error('Ese producto no está publicado en el catálogo de la empresa.');
      error.statusCode = 409;
      throw error;
    }
    const otras = lista.filter((s) => s !== ctx.branchUuid);
    const eventId = await withTransaction(async (conn) => {
      // En esta misma sucursal el precio se cambia ya.
      if (lista.includes(ctx.branchUuid)) await conn.query('UPDATE products SET precio_venta = ? WHERE id = ?', [valor, p.id]);
      if (!otras.length) return null;
      return bandejas.registrarSalida(conn, {
        companyUuid: ctx.companyUuid, branchUuid: ctx.branchUuid, entityType: 'comando_precio', entityUuid: p.uuid,
        operation: 'crear', payload: { productUuid: p.uuid, precio: valor, sucursales: otras },
      });
    });
    await auditar('Precio en varias sucursales', `${p.codigo} · ${p.nombre}: ${valor} en ${lista.length} sucursal(es)`).catch(() => {});
    pronto(1000);
    return { eventId, producto: { id: p.id, codigo: p.codigo, nombre: p.nombre }, precio: valor, sucursales: lista };
  }

  // ── Estado (pantalla e indicador de la barra) ─────────────────────────────

  async function estado() {
    const [resumen, conflictos, rechazados, ultimos, okRows] = await Promise.all([
      bandejas.resumen(query).catch(() => null),
      listarConflictos(),
      query(
        'SELECT event_id, entity_type, entity_uuid, last_error, created_at_utc FROM sync_outbox WHERE status = ? ORDER BY id DESC LIMIT 20',
        [ESTADOS_SALIDA.RECHAZADO]
      ).catch(() => []),
      query('SELECT * FROM sync_bitacora ORDER BY id DESC LIMIT 1').catch(() => []),
      query("SELECT finished_at_utc FROM sync_bitacora WHERE resultado IN ('ok', 'parcial') ORDER BY id DESC LIMIT 1").catch(() => []),
    ]);
    const salida = resumen?.salida || {};
    const pendientes = Number(salida.pendiente || 0) + Number(salida.error || 0);
    const ultimo = ultimos[0] || null;
    const ultimaOk = okRows[0]?.finished_at_utc || null;
    const edadOk = ultimaOk ? now().getTime() - new Date(ultimaOk).getTime() : Infinity;

    let indicador;
    if (progreso) {
      const pct = progreso.total ? Math.min(100, Math.round((progreso.hechos / progreso.total) * 100)) : null;
      indicador = { nivel: 'sincronizando', texto: `${progreso.etapa}${progreso.total ? ` ${progreso.hechos} / ${progreso.total}` : '…'}`, porcentaje: pct };
    } else if (rechazados.length || conflictos.length) {
      indicador = { nivel: 'error', texto: `${rechazados.length + conflictos.length} cambio(s) necesitan revisión` };
    } else if (ultimo && ultimo.resultado === 'sin_conexion') {
      indicador = { nivel: 'sin_conexion', texto: pendientes ? `Sin conexión · ${pendientes} pendiente(s), vendiendo normal` : 'Sin conexión con la central, vendiendo normal' };
    } else if (ultimo && ultimo.resultado === 'error') {
      indicador = { nivel: 'error', texto: `Error al sincronizar: ${ultimoError?.mensaje || 'revisa el detalle'}` };
    } else if (pendientes) {
      indicador = { nivel: 'pendientes', texto: `${pendientes} cambio(s) por subir` };
    } else if (edadOk < VERDE_MS) {
      indicador = { nivel: 'sincronizado', texto: 'Sincronizado' };
    } else {
      indicador = { nivel: 'pendientes', texto: ultimaOk ? 'Sin sincronizar hace más de 30 min' : 'Todavía no ha sincronizado' };
    }

    return {
      activo: timers.length > 0,
      sincronizando: Boolean(progreso),
      progreso,
      indicador,
      pendientes,
      salida,
      pendienteDesde: resumen?.pendienteDesde || null,
      ultimaSincronizacion: ultimaOk,
      ultimoCiclo: ultimo ? {
        resultado: ultimo.resultado, inicio: ultimo.started_at_utc, fin: ultimo.finished_at_utc, duracionMs: Number(ultimo.duracion_ms),
        enviados: Number(ultimo.enviados), confirmados: Number(ultimo.confirmados), rechazados: Number(ultimo.rechazados),
        recibidos: Number(ultimo.recibidos), aplicados: Number(ultimo.aplicados), conflictos: Number(ultimo.conflictos),
        bytesEnviados: Number(ultimo.bytes_enviados), bytesRecibidos: Number(ultimo.bytes_recibidos),
      } : null,
      ultimoError,
      rechazados: rechazados.map((r) => ({ eventId: r.event_id, tipo: r.entity_type, uuid: r.entity_uuid, error: r.last_error, creado: r.created_at_utc })),
      conflictos,
      ncf: await ncf.listar().catch(() => []),
    };
  }

  async function bitacora(limite = 50) {
    const max = Math.max(1, Math.min(500, Number(limite) || 50));
    return query(`SELECT * FROM sync_bitacora ORDER BY id DESC LIMIT ${max}`).catch(() => []);
  }

  // Para el latido: conflictos y uso de los rangos NCF.
  async function extrasLatido() {
    const [conflictos, uso, okRows] = await Promise.all([
      query("SELECT COUNT(*) AS n FROM sync_conflictos WHERE estado = 'pendiente'").catch(() => [{ n: 0 }]),
      ncf.usoParaLatido().catch(() => []),
      query("SELECT finished_at_utc FROM sync_bitacora WHERE resultado IN ('ok', 'parcial') ORDER BY id DESC LIMIT 1").catch(() => []),
    ]);
    return {
      pendientes: { conflictos: Number(conflictos[0]?.n || 0) },
      ncf: uso,
      ultimaSincronizacion: okRows[0]?.finished_at_utc || null,
    };
  }

  function detener() {
    timers.forEach((t) => clearTimeout(t) || clearInterval(t));
    timers = [];
    clearTimeout(prontoTimer);
  }

  function iniciar({ primeraEsperaMs = 30000 } = {}) {
    detener();
    const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };
    timers.push(unref(setTimeout(() => { ciclo().catch(() => {}); }, primeraEsperaMs)));
    timers.push(unref(setInterval(() => { ciclo().catch(() => {}); }, cicloMs)));
    return true;
  }

  return {
    ciclo,
    pronto,
    detectar,
    estado,
    bitacora,
    extrasLatido,
    listarConflictos,
    resolverConflicto,
    resolverTodos,
    reintentarRechazados,
    sucursalesEmpresa,
    publicarCatalogo,
    precioEnSucursales,
    iniciar,
    detener,
  };
}

module.exports = { createSincronizacion, idCambio, STREAMS };

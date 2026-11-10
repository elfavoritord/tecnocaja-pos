'use strict';
// Compras de proveedores (fase A). Una sola ruta para registrar una compra:
// la pantalla clásica, «Preparar compra» (borradores de XML, Excel/CSV o a mano)
// y, más adelante, la cola del Portal de Contadores. Reglas:
// - Un borrador no toca inventario, cuentas por pagar ni la DGII.
// - Registrar es idempotente por uuid (repetir devuelve la misma compra) y no
//   acepta una factura ya registrada (proveedor + NCF/e-NCF o el mismo archivo).
// - Los productos nuevos se crean solos al registrar (sin códigos de barras
//   inventados); los parecidos nunca se unen sin confirmación.
// - Solo las líneas con control de inventario suben existencias, y según la
//   modalidad del negocio: automática (al registrar, una sola vez) o con
//   confirmación de la mercancía (recepción, total o parcial).
// - Cambiar precio, ITBIS o control de inventario de un producto que ya existe
//   exige el permiso de Productos.

const crypto = require('crypto');
const M = require('../../../js/pos-money');
const Precios = require('../../../js/compras-precios');
const { emparejarLinea, normalizarTexto, codigoBarrasValido } = require('./emparejar-productos');
const { ensureComprasFaseA } = require('./esquema');

const TOLERANCIA_TOTAL = M.cents('1.00'); // diferencia de redondeo aceptada contra la factura
const TIPOS_LINEA = ['inventario', 'sin_inventario', 'servicio_gasto'];
// Lo que un proveedor le emite al negocio por una compra (el tipo sale del NCF).
const TIPOS_PROVEEDOR = Object.freeze({
  E31: 'Crédito fiscal electrónico', E32: 'Consumo electrónico', E44: 'Régimen especial electrónico', E45: 'Gubernamental electrónico',
  B01: 'Crédito fiscal', B02: 'Consumo', B14: 'Régimen especial', B15: 'Gubernamental',
});
// Lo que emite el negocio cuando el proveedor no da comprobante (con su secuencia).
const TIPOS_NEGOCIO = Object.freeze({ E41: 'Comprobante de compras electrónico', B11: 'Comprobante de compras' });

const fail = (message, statusCode = 400, extra = {}) => Object.assign(new Error(message), { statusCode, ...extra });
const c = (v) => M.cents(Number(v || 0).toFixed(2));
const n = (x) => M.number(x);
const soloDigitos = (v) => String(v || '').replace(/\D/g, '');
const ahora = () => new Date().toISOString();
const dos = (x) => String(x).padStart(2, '0');
const hoyLocal = () => { const d = new Date(); return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`; };
const afectadas = (r) => Number(r?.affectedRows ?? r?.rowsAffected ?? 0);
const actorNombre = (a) => a?.nombre || a?.usuario || 'Sistema';
const fechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(String(f || '')) && !Number.isNaN(new Date(`${f}T12:00:00`).getTime());

// Subtotal de una línea: cantidad × costo − descuento (centavos). La cantidad puede llevar decimales (kg, lb).
function montosLinea(l) {
  const bruto = M.quantity(c(l.costoUnitario), Number(l.cantidad || 0).toFixed(3));
  const sub = bruto - c(l.descuento);
  const itbis = Number(l.itbisPct) > 0 ? M.percent(sub, Number(l.itbisPct)) : 0n;
  return { bruto, subtotal: sub, itbis };
}

function totalesDe(lineas, descuentoGeneral = 0) {
  let subtotal = 0n, itbis = 0n;
  for (const l of lineas) { const m = montosLinea(l); subtotal += m.subtotal; itbis += m.itbis; }
  const descuento = c(descuentoGeneral);
  return { subtotal, descuento, itbis, total: subtotal - descuento + itbis };
}

function crearServicioCompras(deps) {
  const {
    query, withTransaction, getDbClient = () => 'sqlite', isMysqlDeployment = () => false,
    changeBranchInventoryStock, registerInventoryMovement, createProductInTransaction, prepararProductos = async () => {},
    insertSupplierRow, resolveSupplierInvoiceStatus, writeAuditLog = async () => {}, getConfig = async () => ({}),
    afterProductsChanged = async () => {}, alCrearProducto = async () => {}, resolverAlcanceCatalogo = () => null,
    // Siguiente NCF de la serie B (B11) dentro de la transacción (server.js getNextNcfFromSequence).
    getNextNcf = null,
  } = deps;

  let listo = null;
  function ensureSchema() {
    if (!listo) listo = ensureComprasFaseA(query, { getDbClient, withTransaction }).catch((e) => { listo = null; throw e; });
    return listo;
  }

  // ── Configuración por empresa ──────────────────────────────────────────────
  async function leerConfig() {
    await ensureSchema();
    const [row] = await query('SELECT compras_modo_recepcion, compras_margen_defecto, compras_tipo_margen, compras_precio_modo, compras_contador_permitido FROM config WHERE id = 1');
    const cfg = await Promise.resolve(getConfig()).catch(() => ({}));
    const tasa = Number(cfg?.itbis ?? 18);
    return {
      modoRecepcion: row?.compras_modo_recepcion === 'confirmacion' ? 'confirmacion' : 'automatica',
      margenDefecto: row?.compras_margen_defecto === null || row?.compras_margen_defecto === undefined ? null : Number(row.compras_margen_defecto),
      tipoMargen: row?.compras_tipo_margen === 'venta' ? 'venta' : 'costo',
      precioModo: ['base', 'incluido', 'exento'].includes(row?.compras_precio_modo) ? row.compras_precio_modo : 'base',
      tasaItbis: Number.isFinite(tasa) ? tasa : 18,
      rncNegocio: String(cfg?.rnc || ''),
      // El contador vinculado registra compras desde su portal (por defecto sí).
      contadorRegistra: row?.compras_contador_permitido === undefined || row?.compras_contador_permitido === null
        ? true : Number(row.compras_contador_permitido) !== 0,
    };
  }
  async function guardarConfig(body) {
    await ensureSchema();
    const modo = body?.modoRecepcion === 'confirmacion' ? 'confirmacion' : 'automatica';
    const margen = body?.margenDefecto === null || body?.margenDefecto === '' || body?.margenDefecto === undefined ? null : Number(body.margenDefecto);
    if (margen !== null && (!Number.isFinite(margen) || margen < 0 || margen >= 1000)) throw fail('El margen por defecto no es válido.');
    const tipoMargen = body?.tipoMargen === 'venta' ? 'venta' : 'costo';
    if (tipoMargen === 'venta' && margen !== null && margen >= 100) throw fail('El margen sobre la venta debe ser menor de 100 %.');
    const precioModo = ['base', 'incluido', 'exento'].includes(body?.precioModo) && body.precioModo !== 'exento' ? body.precioModo : 'base';
    await query('UPDATE config SET compras_modo_recepcion = ?, compras_margen_defecto = ?, compras_tipo_margen = ?, compras_precio_modo = ? WHERE id = 1',
      [modo, margen, tipoMargen, precioModo]);
    if (typeof body?.contadorRegistra === 'boolean') {
      await query('UPDATE config SET compras_contador_permitido = ? WHERE id = 1', [body.contadorRegistra ? 1 : 0]);
    }
    return leerConfig();
  }

  // ── Datos de apoyo ─────────────────────────────────────────────────────────
  async function productosCatalogo(branchId) {
    return query(
      `SELECT id, codigo, barcode, nombre, unidad, estado, precio_venta, precio_compra, aplica_itbis, itbis_modo, tracks_stock, product_type, branch_id
         FROM products WHERE (branch_id IS NULL OR branch_id = ?) AND COALESCE(product_type, 'general') NOT IN ('combo')`,
      [branchId || 0]
    );
  }
  async function buscarProveedor(runner, proveedor = {}) {
    if (proveedor.id) {
      const [s] = await runner.query('SELECT * FROM suppliers WHERE id = ? LIMIT 1', [Number(proveedor.id)]);
      if (s) return s;
    }
    const rnc = soloDigitos(proveedor.rnc);
    const todos = await runner.query('SELECT * FROM suppliers');
    if (rnc) {
      const porRnc = todos.find((s) => soloDigitos(s.rnc) === rnc);
      if (porRnc) return porRnc;
    }
    const nombre = normalizarTexto(proveedor.nombre);
    if (!rnc && nombre) return todos.find((s) => normalizarTexto(s.nombre) === nombre) || null;
    return null;
  }

  // ── Preparar: reconoce proveedor y productos, calcula y avisa ──────────────
  // payload = { encabezado, lineas, documentoId? } (el de un borrador)
  // → { payload, resumen, avisos, bloqueos }
  async function preparar(payload, { branchId, cache = null } = {}) {
    await ensureSchema();
    const cfg = await leerConfig();
    const encabezado = { ...(payload?.encabezado || {}) };
    const lineasIn = Array.isArray(payload?.lineas) ? payload.lineas : [];
    const avisos = [...(payload?.avisos || []).filter((a) => a && a.nivel === 'aviso')];
    const bloqueos = [];
    const bloquea = (t) => bloqueos.push(t);

    const proveedor = await buscarProveedor({ query }, encabezado.proveedor || {});
    encabezado.proveedor = proveedor
      ? { id: Number(proveedor.id), nombre: proveedor.nombre, rnc: proveedor.rnc || encabezado.proveedor?.rnc || '', nuevo: false }
      : { id: null, nombre: String(encabezado.proveedor?.nombre || '').trim(), rnc: soloDigitos(encabezado.proveedor?.rnc), nuevo: true };
    if (!encabezado.proveedor.id && !encabezado.proveedor.nombre) bloquea('Indica el proveedor (nombre o RNC).');
    const rnc = soloDigitos(encabezado.proveedor.rnc);
    if (rnc && rnc.length !== 9 && rnc.length !== 11) bloquea('El RNC/cédula del proveedor debe tener 9 u 11 dígitos.');
    if (!fechaValida(encabezado.fechaComprobante)) bloquea('Indica la fecha de la factura.');
    if (encabezado.condicionPago === 'credito' && !fechaValida(encabezado.fechaVencimiento)) bloquea('Indica la fecha de vencimiento de la compra a crédito.');
    const ncf = String(encabezado.ncf || '').trim().toUpperCase().replace(/[\s-]/g, '');
    encabezado.ncf = ncf;
    // Comprobante: o lo dio el proveedor (su NCF/e-NCF, el tipo sale del número) o lo
    // emite el negocio (E41/B11, con su secuencia). Nunca los dos.
    const comprobanteNegocio = String(encabezado.comprobanteNegocio || (encabezado.emitirE41 ? 'E41' : '')).toUpperCase();
    if (comprobanteNegocio && !TIPOS_NEGOCIO[comprobanteNegocio]) bloquea(`${comprobanteNegocio} no es un comprobante de compra que emita el negocio.`);
    if (ncf) {
      if (!/^(B\d{10}|E\d{12})$/.test(ncf)) {
        bloquea('El NCF del proveedor no tiene el formato de la DGII: B + 10 dígitos o E + 12 dígitos.');
      } else {
        const tipo = ncf.slice(0, 3);
        if (!TIPOS_PROVEEDOR[tipo]) bloquea(`${tipo} no es un comprobante que un proveedor emita por una compra.`);
        encabezado.tipoComprobante = tipo;
        if ((tipo === 'B02' || tipo === 'E32') && !avisos.some((a) => /consumo/i.test(a.texto || ''))) {
          avisos.push({ nivel: 'aviso', texto: 'Comprobante de consumo: no da crédito fiscal de ITBIS.' });
        }
      }
      if (comprobanteNegocio) bloquea('El proveedor ya te dio comprobante: no se emite comprobante de compra.');
    } else if (!comprobanteNegocio) {
      encabezado.tipoComprobante = '';
    }
    encabezado.comprobanteNegocio = ncf ? '' : comprobanteNegocio;
    encabezado.emitirE41 = encabezado.comprobanteNegocio === 'E41';
    if (!String(encabezado.numeroDocumento || '').trim() && !ncf && !encabezado.comprobanteNegocio) bloquea('Indica el número de factura del proveedor o su NCF.');

    // Factura ya registrada (mismo proveedor y NCF/e-NCF).
    if (proveedor && ncf) {
      const [dup] = await query("SELECT id FROM purchases WHERE supplier_id = ? AND UPPER(ncf) = ? AND estado <> 'anulada' LIMIT 1", [Number(proveedor.id), ncf]);
      if (dup) bloquea(`Esta factura (${ncf}) ya está registrada en la compra #${dup.id}.`);
      const [gasto] = await query("SELECT id FROM expenses WHERE supplier_id = ? AND UPPER(ncf) = ? AND estado <> 'anulado' LIMIT 1", [Number(proveedor.id), ncf]).catch(() => []);
      if (gasto) bloquea(`Esta factura (${ncf}) ya está registrada como gasto #${gasto.id}.`);
    }
    if (payload?.documentoId) {
      const [doc] = await query('SELECT sha256 FROM purchase_documents WHERE id = ?', [payload.documentoId]);
      if (doc) {
        const [ya] = await query('SELECT purchase_id FROM purchase_documents WHERE sha256 = ? AND purchase_id IS NOT NULL LIMIT 1', [doc.sha256]);
        if (ya) bloquea(`Este mismo archivo ya se registró en la compra #${ya.purchase_id}.`);
      }
    }

    // Un lote de facturas (Excel) comparte el catálogo leído una vez.
    const productos = cache?.productos || await productosCatalogo(branchId);
    if (cache) cache.productos = productos;
    const porId = new Map(productos.map((p) => [Number(p.id), p]));
    const equivalencias = proveedor
      ? await query('SELECT product_id, codigo_proveedor, descripcion_normalizada FROM product_supplier_codes WHERE supplier_id = ?', [Number(proveedor.id)]).catch(() => [])
      : [];
    const nombresNuevos = new Map();
    if (!lineasIn.length) bloquea('La compra no tiene líneas.');

    const lineas = lineasIn.map((entrada, i) => {
      const l = { ...entrada, clave: entrada.clave || `l${i + 1}` };
      const etiqueta = `Línea ${i + 1}${l.descripcion ? ` («${String(l.descripcion).slice(0, 40)}»)` : ''}`;
      l.cantidad = Number(l.cantidad || 0);
      l.costoUnitario = Number(l.costoUnitario || 0);
      l.descuento = Number(l.descuento || 0);
      l.itbisPct = Number(l.itbisPct ?? cfg.tasaItbis);
      l.avisos = [];
      if (!(l.cantidad > 0)) bloquea(`${etiqueta}: la cantidad debe ser mayor que cero.`);
      if (!(l.costoUnitario >= 0)) bloquea(`${etiqueta}: el costo no es válido.`);
      if (l.descuento < 0 || c(l.descuento) > M.quantity(c(l.costoUnitario), l.cantidad.toFixed(3))) bloquea(`${etiqueta}: el descuento no es válido.`);
      if (!(l.itbisPct >= 0 && l.itbisPct <= 100)) bloquea(`${etiqueta}: el ITBIS % no es válido.`);
      if (!TIPOS_LINEA.includes(l.tipoLinea)) l.tipoLinea = null;

      if (l.tipoLinea === 'servicio_gasto') {
        l.productoId = null; l.accion = 'sin_producto'; l.controlaInventario = false;
        if (!String(l.descripcion || '').trim()) bloquea(`${etiqueta}: falta la descripción del servicio o gasto.`);
        return l;
      }
      // Producto: el que eligió el usuario, el reconocido, o uno nuevo.
      // «Nuevo» elegido por el usuario se respeta; uno puesto solo se vuelve a buscar
      // (pudo crearse el producto mientras el borrador esperaba).
      if (l.productoId && porId.has(Number(l.productoId))) {
        l.productoId = Number(l.productoId); l.accion = 'existente'; l.metodo = l.metodo || 'elegido';
      } else if (l.accion !== 'nuevo' || l.decision !== 'usuario') {
        const r = emparejarLinea(l, { productos, equivalencias });
        l.productoId = r.productoId; l.metodo = r.metodo; l.sugerencias = r.sugerencias;
        l.accion = r.productoId ? 'existente' : (r.sugerencias.length ? 'elegir' : 'nuevo');
      }
      if (l.accion === 'elegir') bloquea(`${etiqueta}: elige el producto (hay parecidos) o márcalo como nuevo.`);
      if (l.accion === 'existente') {
        const p = porId.get(l.productoId);
        l.producto = { id: Number(p.id), codigo: p.codigo, nombre: p.nombre, precioVenta: Number(p.precio_venta || 0), costoAnterior: Number(p.precio_compra || 0),
          aplicaItbis: Boolean(Number(p.aplica_itbis)), tracksStock: Number(p.tracks_stock ?? 1) !== 0, estado: p.estado, unidad: p.unidad };
        if (typeof l.controlaInventario !== 'boolean') l.controlaInventario = l.producto.tracksStock;
        if (String(p.itbis_modo) === 'monto') l.avisos.push('El producto tiene ITBIS de monto fijo: su precio se cambia en Productos.');
        if (l.producto.costoAnterior && Math.abs(l.producto.costoAnterior - l.costoUnitario) >= 0.005) {
          l.avisos.push(`El costo cambia de RD$ ${l.producto.costoAnterior.toFixed(2)} a RD$ ${l.costoUnitario.toFixed(2)}.`);
        }
      } else if (l.accion === 'nuevo') {
        l.productoId = null;
        const nombre = String(l.descripcion || '').trim();
        if (nombre.length < 2) bloquea(`${etiqueta}: escribe el nombre del producto nuevo.`);
        const clave = normalizarTexto(nombre);
        if (productos.some((p) => normalizarTexto(p.nombre) === clave)) bloquea(`${etiqueta}: ya existe un producto con ese nombre; elígelo.`);
        if (nombresNuevos.has(clave)) bloquea(`${etiqueta}: el producto nuevo se repite en la línea ${nombresNuevos.get(clave)}.`);
        nombresNuevos.set(clave, i + 1);
        if (typeof l.controlaInventario !== 'boolean') l.controlaInventario = true;
        if (l.codigoBarras && !codigoBarrasValido(l.codigoBarras)) l.avisos.push('El código de barras no es válido: se guarda como código del proveedor.');
      }
      l.tipoLinea = l.controlaInventario ? 'inventario' : 'sin_inventario';

      // Precio de venta: el escrito, el del margen por defecto, o el actual del producto.
      const precio = l.precio && Number(l.precio.valor) > 0 ? { ...l.precio } : null;
      if (precio) {
        if (!precio.modo) precio.modo = cfg.precioModo;
        try {
          const calc = Precios.precioVenta({ modo: precio.modo, precio: precio.valor, tasa: cfg.tasaItbis });
          precio.calculado = calc;
          if (!calc.exacto) l.avisos.push(calc.aviso);
          if (precio.modo === 'exento' && !precio.exentoConfirmado) bloquea(`${etiqueta}: confirma que el producto está exento de ITBIS por ley.`);
          const g = Precios.ganancia({ costo: l.costoUnitario, base: calc.base });
          precio.ganancia = g;
          if (g.perdida) l.avisos.push('El precio de venta queda por debajo del costo.');
        } catch (e) { bloquea(`${etiqueta}: ${e.message}`); }
        l.precio = precio;
      } else if (l.accion === 'nuevo' && cfg.margenDefecto !== null) {
        const valor = Precios.precioDesdeMargen({ costo: l.costoUnitario, margen: cfg.margenDefecto, tipo: cfg.tipoMargen, modo: cfg.precioModo === 'exento' ? 'base' : cfg.precioModo, tasa: cfg.tasaItbis });
        const calc = Precios.precioVenta({ modo: cfg.precioModo === 'exento' ? 'base' : cfg.precioModo, precio: valor, tasa: cfg.tasaItbis });
        l.precio = { modo: calc.modo, valor, calculado: calc, ganancia: Precios.ganancia({ costo: l.costoUnitario, base: calc.base }), sugerido: true };
      } else {
        l.precio = null;
      }
      if (l.accion === 'nuevo' && !l.precio) l.avisos.push('Sin precio de venta: el producto se crea inactivo (no se puede vender) hasta ponerle precio.');
      const m = montosLinea(l);
      l.subtotal = n(m.subtotal); l.itbis = n(m.itbis);
      return l;
    });

    const tot = totalesDe(lineas, encabezado.descuento);
    const resumen = { subtotal: n(tot.subtotal), descuento: n(tot.descuento), itbis: n(tot.itbis), total: n(tot.total), documento: null, diferencia: 0 };
    if (!(tot.total > 0n)) bloquea('El total de la compra debe ser mayor que cero.');
    const doc = encabezado.totalesDocumento;
    if (doc && Number(doc.total) > 0) {
      const dif = tot.total - c(doc.total);
      resumen.documento = { subtotal: Number(doc.subtotal || 0), itbis: Number(doc.itbis || 0), total: Number(doc.total) };
      resumen.diferencia = n(dif);
      const abs = dif < 0n ? -dif : dif;
      if (abs > TOLERANCIA_TOTAL) bloquea(`Los totales no cuadran con la factura: calculado RD$ ${n(tot.total).toFixed(2)}, factura RD$ ${Number(doc.total).toFixed(2)}. Revisa cantidades, costos e ITBIS.`);
      else if (abs > 0n) avisos.push({ nivel: 'aviso', texto: `Diferencia de redondeo de RD$ ${n(abs).toFixed(2)}: se registra el total de la factura.` });
    }
    for (const a of payload?.avisos || []) if (a?.nivel === 'error') bloquea(a.texto);
    if (encabezado.comprobanteNegocio || (comprobanteNegocio && ncf)) {
      if (encabezado.documentoOrigen === 'xml_ecf') bloquea('Esta compra ya tiene el comprobante electrónico del proveedor: no se emite comprobante de compra.');
      else if (encabezado.comprobanteNegocio && rnc.length !== 9 && rnc.length !== 11) {
        bloquea(`Para emitir el ${encabezado.comprobanteNegocio} el proveedor debe tener RNC o cédula (9 u 11 dígitos).`);
      }
    }
    return { payload: { ...payload, encabezado, lineas }, resumen, avisos, bloqueos, config: cfg };
  }

  // ── Registrar ──────────────────────────────────────────────────────────────
  // ctx = { actor, branchId, puedeCambiarProductos, puedeCrearProductos, draftId, draftVersion }
  async function registrar(payload, ctx) {
    await ensureSchema();
    const { actor, branchId } = ctx;
    if (!branchId) throw fail('Indica la sucursal de la compra.');
    const uuid = String(payload?.uuid || ctx.draftId || '').trim() || crypto.randomUUID();
    if (!/^[A-Za-z0-9-]{8,80}$/.test(uuid)) throw fail('Identificador de compra no válido.');

    // Reintento de la misma compra: se devuelve la ya registrada.
    const [previa] = await query('SELECT id, branch_id FROM purchases WHERE uuid = ? LIMIT 1', [uuid]);
    if (previa) {
      if (Number(previa.branch_id) !== Number(branchId)) throw fail('Esa compra es de otra sucursal.', 403);
      return { purchaseId: Number(previa.id), repetida: true, productosCreados: [] };
    }

    const prep = await preparar(payload, { branchId });
    if (prep.bloqueos.length) throw fail(prep.bloqueos[0], 409, { bloqueos: prep.bloqueos });
    const { encabezado, lineas } = prep.payload;
    const cfg = prep.config;

    for (const [i, l] of lineas.entries()) {
      if (l.accion === 'nuevo' && !ctx.puedeCrearProductos) throw fail(`Línea ${i + 1}: no tienes permiso para crear productos.`, 403);
      if (l.accion === 'existente') {
        const cambiaPrecio = Boolean(l.precio && !l.precio.sugerido && l.precio.cambiar !== false && l.precio.calculado
          && (Math.abs(l.precio.calculado.base - l.producto.precioVenta) >= 0.005 || l.precio.calculado.aplicaItbis !== l.producto.aplicaItbis));
        const cambiaInventario = l.controlaInventario !== l.producto.tracksStock;
        l.cambiaPrecio = cambiaPrecio; l.cambiaInventario = cambiaInventario;
        if ((cambiaPrecio || cambiaInventario) && !ctx.puedeCambiarProductos) {
          throw fail(`Línea ${i + 1}: cambiar el precio, el ITBIS o el control de inventario de «${l.producto.nombre}» requiere el permiso de Productos.`, 403);
        }
      }
    }

    const tot = totalesDe(lineas, encabezado.descuento);
    const doc = encabezado.totalesDocumento && Number(encabezado.totalesDocumento.total) > 0 ? encabezado.totalesDocumento : null;
    // Con la factura a la vista, lo que se debe es su total (la diferencia es solo de redondeo).
    const itbisFinal = doc ? c(doc.itbis) : tot.itbis;
    const totalFinal = doc ? c(doc.total) : tot.total;
    const ajuste = totalFinal - tot.total;
    const condicion = encabezado.condicionPago === 'credito' ? 'credito' : 'contado';
    const modo = cfg.modoRecepcion;
    const hayInventario = lineas.some((l) => l.tipoLinea === 'inventario');
    const estadoInventario = !hayInventario ? 'no_aplica' : (modo === 'confirmacion' ? 'pendiente_recepcion' : 'recibido_total');
    let numeroDocumento = String(encabezado.numeroDocumento || encabezado.ncf || (encabezado.emitirE41 ? 'E41' : '')).trim().slice(0, 60);
    let ncfFinal = encabezado.ncf || null;
    let tipoFinal = String(encabezado.tipoComprobante || '').slice(0, 10) || null;
    if (encabezado.comprobanteNegocio === 'B11' && !getNextNcf) throw fail('Este equipo no puede emitir comprobantes B11.', 409);
    const tipoBienes = Number.isInteger(Number(encabezado.tipoBienesServicios)) && Number(encabezado.tipoBienesServicios) >= 1 && Number(encabezado.tipoBienesServicios) <= 11
      ? Number(encabezado.tipoBienesServicios) : 9;
    const formaPago = Number.isInteger(Number(encabezado.formaPago)) && Number(encabezado.formaPago) >= 1 && Number(encabezado.formaPago) <= 7
      ? Number(encabezado.formaPago) : (condicion === 'credito' ? 4 : null);
    const isrTipo = Number.isInteger(Number(encabezado.isrTipoRetencion)) && Number(encabezado.isrTipoRetencion) >= 1 && Number(encabezado.isrTipoRetencion) <= 9
      ? Number(encabezado.isrTipoRetencion) : null;
    const catalogBranchId = resolverAlcanceCatalogo(actor);
    const actorProducto = { userId: actor.id, userName: actorNombre(actor) };
    if (lineas.some((l) => l.accion === 'nuevo')) await prepararProductos();

    let resultado;
    try {
      resultado = await withTransaction(async (conn) => {
        // Proveedor: el existente (bloqueado mientras dura la compra, para que dos
        // cajas no registren la misma factura a la vez) o uno nuevo.
        let proveedor = encabezado.proveedor.id ? (await conn.query('SELECT * FROM suppliers WHERE id = ?', [encabezado.proveedor.id]))[0] : null;
        if (proveedor) {
          await conn.query('UPDATE suppliers SET nombre = nombre WHERE id = ?', [proveedor.id]);
        } else {
          const id = await insertSupplierRow(conn, { nombre: encabezado.proveedor.nombre || `Proveedor ${encabezado.proveedor.rnc}`, rnc: encabezado.proveedor.rnc || null });
          proveedor = (await conn.query('SELECT * FROM suppliers WHERE id = ?', [id]))[0];
        }
        const supplierId = Number(proveedor.id);
        const [otra] = await conn.query('SELECT id FROM purchases WHERE uuid = ? LIMIT 1', [uuid]);
        if (otra) return { purchaseId: Number(otra.id), repetida: true, productosCreados: [], productosTocados: [] };
        if (encabezado.ncf) {
          const [dup] = await conn.query("SELECT id FROM purchases WHERE supplier_id = ? AND UPPER(ncf) = ? AND estado <> 'anulada' LIMIT 1", [supplierId, encabezado.ncf]);
          if (dup) throw fail(`Esta factura (${encabezado.ncf}) ya está registrada en la compra #${dup.id}.`, 409);
        }
        // B11: el negocio emite su comprobante de compras con la secuencia de la serie B
        // (si la compra no se guarda, el número no se gasta). El E41 se emite al terminar.
        if (encabezado.comprobanteNegocio === 'B11') {
          const asignado = await getNextNcf(conn, 'B11', branchId);
          ncfFinal = asignado.ncf; tipoFinal = 'B11';
          if (!numeroDocumento) numeroDocumento = asignado.ncf;
        }

        // Productos nuevos y cambios autorizados de los existentes.
        const productosCreados = [], productosTocados = new Set();
        for (const l of lineas) {
          if (l.accion === 'nuevo') {
            const calc = l.precio?.calculado || null;
            const barras = codigoBarrasValido(l.codigoBarras) ? String(l.codigoBarras).trim() : '';
            const codigo = await codigoLibre(conn, [barras, String(l.codigo || '').trim()]);
            const creado = await createProductInTransaction(conn, {
              catalogBranchId, actor: actorProducto,
              data: {
                codigo, barcode: barras || codigo, nombre: String(l.descripcion).trim().slice(0, 160), categoria: String(l.categoria || 'GENERAL').slice(0, 80),
                unidad: String(l.unidad || 'Unidad').slice(0, 40), saleMode: 'unidad', precioCompra: l.costoUnitario,
                precioVenta: calc ? calc.base : 0, stock: 0, stockMin: 0, estado: calc && calc.base > 0 ? 'Activo' : 'Inactivo',
                tipoProducto: 'general', aplicaItbis: calc ? calc.aplicaItbis : l.itbisPct > 0, itbisModo: 'porcentaje',
                tracksStock: l.controlaInventario, branchId,
              },
            });
            l.productoId = Number(creado.row.id);
            l.productoCreado = true;
            productosCreados.push(l.productoId);
          } else if (l.accion === 'existente' && (l.cambiaPrecio || l.cambiaInventario)) {
            const calc = l.precio?.calculado;
            if (l.cambiaPrecio) {
              await conn.query(
                `UPDATE products SET precio_venta = ?, aplica_itbis = ?, itbis_modo = 'porcentaje',
                   estado = CASE WHEN LOWER(COALESCE(estado, '')) = 'inactivo' AND COALESCE(precio_venta, 0) <= 0 AND ? > 0 THEN 'Activo' ELSE estado END
                 WHERE id = ?`,
                [calc.base, calc.aplicaItbis ? 1 : 0, calc.base, l.productoId]
              );
            }
            if (l.cambiaInventario) await conn.query('UPDATE products SET tracks_stock = ? WHERE id = ?', [l.controlaInventario ? 1 : 0, l.productoId]);
          }
          if (l.productoId) productosTocados.add(l.productoId);
        }

        const ins = await conn.query(
          `INSERT INTO purchases
            (uuid, supplier_id, branch_id, numero_documento, ncf, tipo_ncf, fecha_comprobante, fecha_recepcion,
             condicion_pago, fecha_vencimiento, subtotal, descuento, itbis, total, estado, notas,
             created_by_user_id, created_by_user_name, tipo_bienes_servicios, forma_pago, itbis_retenido, isr_tipo_retencion,
             isr_monto_retencion, ncf_modificado, estado_inventario, documento_origen, encf_proveedor, codigo_seguridad, ajuste_redondeo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activa', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuid, supplierId, branchId, numeroDocumento, ncfFinal, tipoFinal,
            encabezado.fechaComprobante, fechaValida(encabezado.fechaRecepcion) ? encabezado.fechaRecepcion : encabezado.fechaComprobante,
            condicion, condicion === 'credito' ? encabezado.fechaVencimiento : null, n(tot.subtotal), n(tot.descuento), n(itbisFinal), n(totalFinal),
            String(encabezado.notas || '').slice(0, 255) || null, actor.id || null, actorNombre(actor), tipoBienes, formaPago,
            Math.max(0, Number(encabezado.itbisRetenido || 0)), isrTipo, Math.max(0, Number(encabezado.isrMontoRetencion || 0)),
            String(encabezado.ncfModificado || '').trim() || null, estadoInventario, String(encabezado.documentoOrigen || 'manual').slice(0, 20),
            encabezado.encfProveedor || null, encabezado.codigoSeguridad || null, n(ajuste)]
        );
        const purchaseId = Number(ins.insertId);

        for (const l of lineas) {
          const m = montosLinea(l);
          const recibe = l.tipoLinea === 'inventario' && modo === 'automatica';
          await conn.query(
            `INSERT INTO purchase_items (purchase_id, product_id, codigo, nombre, cantidad, costo_unitario, itbis_pct, subtotal,
               tipo_linea, descripcion, unidad, codigo_proveedor, descuento, controla_inventario, cantidad_recibida, producto_creado)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [purchaseId, l.productoId || null, String(l.producto?.codigo || l.codigo || '').slice(0, 60), String(l.producto?.nombre || l.descripcion || '').slice(0, 160),
              l.cantidad, l.costoUnitario, l.itbisPct, n(m.subtotal), l.tipoLinea, String(l.descripcion || '').slice(0, 200) || null,
              String(l.unidad || '').slice(0, 40) || null, String(l.codigoProveedor || '').slice(0, 80) || null, l.descuento,
              l.tipoLinea === 'inventario' ? 1 : 0, l.tipoLinea === 'inventario' ? (recibe ? l.cantidad : 0) : null, l.productoCreado ? 1 : 0]
          );
          if (recibe) {
            const cambio = await changeBranchInventoryStock(conn, { productId: l.productoId, branchId, quantityDelta: Math.abs(l.cantidad), preventNegative: false });
            await registerInventoryMovement(conn, {
              productId: l.productoId, branchId, tipo: 'compra', cantidad: Math.abs(l.cantidad),
              stockAnterior: cambio.previousStock, stockNuevo: cambio.nextStock, costoUnitario: l.costoUnitario,
              referenciaTipo: 'compra', referenciaId: String(purchaseId), notas: `Entrada por compra #${purchaseId} · ${numeroDocumento}`,
              usuarioId: actor.id, usuarioNombre: actorNombre(actor),
            });
          }
          if (l.productoId) {
            // Último costo (como siempre) y su historial: nada se sobrescribe sin dejar rastro.
            const anterior = l.productoCreado ? null : Number(l.producto?.costoAnterior ?? 0);
            await conn.query('UPDATE products SET precio_compra = ? WHERE id = ?', [l.costoUnitario, l.productoId]);
            await conn.query('INSERT INTO product_cost_history (product_id, supplier_id, purchase_id, branch_id, costo_anterior, costo_nuevo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [l.productoId, supplierId, purchaseId, branchId, anterior, l.costoUnitario, ahora()]);
            await guardarEquivalencia(conn, supplierId, l);
          }
        }

        const pagado = condicion === 'contado' ? n(totalFinal) : 0;
        const pendiente = condicion === 'contado' ? 0 : n(totalFinal);
        const vence = condicion === 'credito' ? encabezado.fechaVencimiento : null;
        const inv = await conn.query(
          `INSERT INTO supplier_invoices (supplier_id, invoice_number, issued_at, due_at, total_amount, paid_amount, pending_amount, status, notes, ncf, tipo_ncf, itbis_amount, purchase_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [supplierId, numeroDocumento, encabezado.fechaComprobante, vence, n(totalFinal), pagado, pendiente,
            resolveSupplierInvoiceStatus({ pending_amount: pendiente, due_at: vence }), `Generada automáticamente por Compra #${purchaseId}`,
            ncfFinal, tipoFinal, n(itbisFinal), purchaseId]
        );
        await conn.query('UPDATE purchases SET supplier_invoice_id = ? WHERE id = ?', [Number(inv.insertId), purchaseId]);
        if (condicion === 'contado') {
          await conn.query(
            `INSERT INTO supplier_payments (supplier_id, invoice_id, monto, metodo_pago, fecha_pago, notas, created_by, purchase_id)
             VALUES (?, ?, ?, 'Efectivo', ?, ?, ?, ?)`,
            [supplierId, Number(inv.insertId), n(totalFinal), encabezado.fechaComprobante, `Pago automático al registrar Compra #${purchaseId} (contado)`, actorNombre(actor), purchaseId]
          );
        }
        if (ctx.draftId) {
          const r = await conn.query(
            `UPDATE purchase_drafts SET estado = 'registrada', purchase_id = ?, version = version + 1, updated_at = ?, updated_by_user_name = ?
             WHERE id = ? AND estado IN ('borrador', 'requiere_revision')${Number.isInteger(ctx.draftVersion) ? ' AND version = ?' : ''}`,
            [purchaseId, ahora(), actorNombre(actor), ctx.draftId, ...(Number.isInteger(ctx.draftVersion) ? [ctx.draftVersion] : [])]
          );
          if (afectadas(r) !== 1) throw fail('El borrador cambió en otra caja o ya se registró. Recárgalo.', 409);
          await conn.query('UPDATE purchase_documents SET purchase_id = ? WHERE draft_id = ?', [purchaseId, ctx.draftId]);
        }
        return { purchaseId, repetida: false, productosCreados, productosTocados: [...productosTocados], supplierId, proveedorNombre: proveedor.nombre };
      });
    } catch (error) {
      // Dos registros simultáneos de la misma compra: el índice único de uuid frena el segundo.
      if (/uuid|unique|duplicate/i.test(String(error?.message || '')) && !/factura|borrador/i.test(String(error?.message || ''))) {
        const [ya] = await query('SELECT id FROM purchases WHERE uuid = ? LIMIT 1', [uuid]);
        if (ya) return { purchaseId: Number(ya.id), repetida: true, productosCreados: [] };
      }
      throw error;
    }
    if (resultado.repetida) return resultado;

    for (const id of resultado.productosCreados) await Promise.resolve(alCrearProducto(id)).catch(() => {});
    Promise.resolve(afterProductsChanged(resultado.productosTocados, { motivo: 'compra' })).catch(() => {});
    const nuevos = resultado.productosCreados.length;
    await Promise.resolve(writeAuditLog({
      userId: actor.id, userName: actorNombre(actor), userRole: String(actor?.role_code || actor?.rol || ''), moduleName: 'Compras', actionName: 'Compra registrada',
      branchId, documentRef: ncfFinal || numeroDocumento, amount: n(totalFinal),
      after: { purchaseId: resultado.purchaseId, uuid, origen: encabezado.documentoOrigen || 'manual', lineas: lineas.length, productosNuevos: resultado.productosCreados,
        cambiosProducto: lineas.filter((l) => l.cambiaPrecio || l.cambiaInventario).map((l) => ({ productoId: l.productoId, precio: l.cambiaPrecio ? l.precio.calculado : undefined, controlaInventario: l.cambiaInventario ? l.controlaInventario : undefined })),
        exentosConfirmados: lineas.filter((l) => l.precio?.modo === 'exento').map((l) => l.productoId), estadoInventario, ajusteRedondeo: n(ajuste) },
      detail: `${resultado.proveedorNombre} · ${numeroDocumento} · RD$ ${n(totalFinal).toFixed(2)} · ${condicion}${nuevos ? ` · ${nuevos} producto(s) nuevo(s)` : ''}${estadoInventario === 'pendiente_recepcion' ? ' · mercancía por recibir' : ''}`,
    })).catch(() => {});
    return { ...resultado, lineas, encabezado, estadoInventario, total: n(totalFinal), ncf: ncfFinal, tipoNcf: tipoFinal };
  }

  // Código interno libre para un producto nuevo: el de barras real o el de la
  // factura si no están usados; si no, P + número. Nunca un código de barras inventado.
  async function codigoLibre(conn, preferidos) {
    for (const cod of preferidos.filter(Boolean)) {
      const [usado] = await conn.query('SELECT id FROM products WHERE codigo = ? OR barcode = ? LIMIT 1', [cod, cod]);
      if (!usado) return cod.slice(0, 60);
    }
    const [max] = await conn.query('SELECT MAX(id) AS m FROM products');
    let k = Number(max?.m || 0) + 1;
    for (;;) {
      const cod = `P${String(k).padStart(6, '0')}`;
      const [usado] = await conn.query('SELECT id FROM products WHERE codigo = ? OR barcode = ? LIMIT 1', [cod, cod]);
      if (!usado) return cod;
      k += 1;
    }
  }

  async function guardarEquivalencia(conn, supplierId, l) {
    const codigo = String(l.codigoProveedor || '').trim();
    const desc = normalizarTexto(l.descripcion);
    if (!codigo && !desc) return;
    const clave = codigo ? `c:${codigo.toLowerCase()}` : `d:${desc}`.slice(0, 220);
    const [existe] = await conn.query('SELECT id FROM product_supplier_codes WHERE supplier_id = ? AND clave = ?', [supplierId, clave]);
    if (existe) {
      await conn.query('UPDATE product_supplier_codes SET product_id = ?, unidad = ?, updated_at = ? WHERE id = ?', [l.productoId, l.unidad || null, ahora(), existe.id]);
    } else {
      await conn.query('INSERT INTO product_supplier_codes (supplier_id, clave, codigo_proveedor, descripcion_normalizada, product_id, unidad, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [supplierId, clave, codigo || null, codigo ? null : desc.slice(0, 200), l.productoId, l.unidad || null, ahora()]);
    }
  }

  // ── Recepción de mercancía (modalidad con confirmación) ────────────────────
  // body = { uuid, lineas: [{ itemId, cantidad }], notas, cerrar }
  async function confirmarRecepcion(purchaseId, body, { actor, assertBranch }) {
    await ensureSchema();
    const uuid = String(body?.uuid || '').trim();
    if (!/^[A-Za-z0-9-]{8,80}$/.test(uuid)) throw fail('Identificador de recepción no válido.');
    const pedido = new Map((Array.isArray(body?.lineas) ? body.lineas : []).map((x) => [Number(x.itemId), Number(x.cantidad || 0)]));
    const notas = String(body?.notas || '').trim().slice(0, 300);
    const cerrar = body?.cerrar === true;
    const res = await withTransaction(async (conn) => {
      const [repetida] = await conn.query('SELECT id FROM purchase_receipts WHERE uuid = ?', [uuid]);
      if (repetida) return { repetida: true };
      const [p] = await conn.query(`SELECT * FROM purchases WHERE id = ?${isMysqlDeployment() ? ' FOR UPDATE' : ''}`, [Number(purchaseId)]);
      if (!p) throw fail('Compra no encontrada.', 404);
      if (assertBranch) assertBranch(p.branch_id);
      if (p.estado !== 'activa') throw fail('La compra está anulada.', 409);
      if (!['pendiente_recepcion', 'recibido_parcial'].includes(p.estado_inventario)) throw fail('Esta compra no tiene mercancía pendiente de recibir.', 409);
      const items = await conn.query("SELECT * FROM purchase_items WHERE purchase_id = ? AND tipo_linea = 'inventario' ORDER BY id", [p.id]);
      let algo = false, diferencias = false;
      const ins = await conn.query('INSERT INTO purchase_receipts (uuid, purchase_id, branch_id, notas, cierra_con_diferencia, created_by_user_id, created_by_user_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [uuid, p.id, p.branch_id, notas || null, cerrar ? 1 : 0, actor.id || null, actorNombre(actor), ahora()]);
      const receiptId = Number(ins.insertId);
      for (const it of items) {
        const cantidad = pedido.has(Number(it.id)) ? pedido.get(Number(it.id)) : 0;
        if (!Number.isFinite(cantidad) || cantidad < 0) throw fail(`Cantidad recibida no válida para «${it.nombre}».`);
        const yaRecibida = Number(it.cantidad_recibida || 0);
        const pendiente = Number(it.cantidad) - yaRecibida;
        const diferencia = Number((yaRecibida + cantidad - Number(it.cantidad)).toFixed(3));
        if (diferencia > 0 && !notas) throw fail(`Llegó más de lo facturado de «${it.nombre}»: escribe una nota.`);
        if (cantidad === 0 && !(cerrar && pendiente > 0)) continue;
        algo = algo || cantidad > 0;
        if (diferencia !== 0) diferencias = true;
        await conn.query('INSERT INTO purchase_receipt_lines (receipt_id, purchase_item_id, product_id, cantidad, diferencia) VALUES (?, ?, ?, ?, ?)',
          [receiptId, it.id, it.product_id, cantidad, diferencia]);
        if (cantidad > 0) {
          const cambio = await changeBranchInventoryStock(conn, { productId: it.product_id, branchId: p.branch_id, quantityDelta: cantidad, preventNegative: false });
          await registerInventoryMovement(conn, {
            productId: it.product_id, branchId: p.branch_id, tipo: 'compra', cantidad,
            stockAnterior: cambio.previousStock, stockNuevo: cambio.nextStock, costoUnitario: Number(it.costo_unitario || 0),
            referenciaTipo: 'recepcion_compra', referenciaId: String(p.id), notas: `Recepción de compra #${p.id}${notas ? ` · ${notas}` : ''}`,
            usuarioId: actor.id, usuarioNombre: actorNombre(actor),
          });
          await conn.query('UPDATE purchase_items SET cantidad_recibida = ? WHERE id = ?', [Number((yaRecibida + cantidad).toFixed(3)), it.id]);
        }
      }
      if (!algo && !cerrar) throw fail('Indica cuánto llegó de al menos un producto.');
      const despues = await conn.query("SELECT cantidad, cantidad_recibida FROM purchase_items WHERE purchase_id = ? AND tipo_linea = 'inventario'", [p.id]);
      const completo = despues.every((x) => Number(x.cantidad_recibida || 0) >= Number(x.cantidad) - 0.0005);
      const estado = completo || cerrar ? 'recibido_total' : 'recibido_parcial';
      await conn.query('UPDATE purchases SET estado_inventario = ? WHERE id = ?', [estado, p.id]);
      return { repetida: false, receiptId, estado, diferencias, productos: items.map((x) => Number(x.product_id)).filter(Boolean), branchId: p.branch_id };
    });
    if (!res.repetida) {
      Promise.resolve(afterProductsChanged(res.productos, { motivo: 'recepcion_compra' })).catch(() => {});
      await Promise.resolve(writeAuditLog({
        userId: actor.id, userName: actorNombre(actor), moduleName: 'Compras', actionName: 'Mercancía recibida', branchId: res.branchId,
        documentRef: String(purchaseId), after: { receiptId: res.receiptId, estado: res.estado, diferencias: res.diferencias, cerrar },
        detail: `Compra #${purchaseId} · ${res.estado === 'recibido_total' ? 'recibida completa' : 'recepción parcial'}${res.diferencias ? ' · con diferencias' : ''}${notas ? ` · ${notas}` : ''}`,
      })).catch(() => {});
    }
    return res;
  }

  // Al anular: cuánto de cada línea entró al inventario (solo eso se revierte).
  // Compras de antes de esta versión (sin tipo de línea) entraban completas.
  function cantidadARevertir(item) {
    if (item.tipo_linea === null || item.tipo_linea === undefined) return Number(item.cantidad || 0);
    if (item.tipo_linea !== 'inventario') return 0;
    return Number(item.cantidad_recibida || 0);
  }

  return { ensureSchema, leerConfig, guardarConfig, preparar, registrar, confirmarRecepcion, cantidadARevertir, totalesDe, montosLinea, hoyLocal };
}

module.exports = { crearServicioCompras, montosLinea, totalesDe, TIPOS_LINEA, TIPOS_PROVEEDOR, TIPOS_NEGOCIO };

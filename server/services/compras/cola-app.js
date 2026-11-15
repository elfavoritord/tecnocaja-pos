'use strict';

/**
 * Compras que el dueño (o un administrador) registra desde la app de reportes.
 *
 * La app deja cada factura del proveedor en businesses/{negocio}/appCompras/{uuid}
 * con status «pendiente» y su uid en createdBy (las reglas de Firestore no dejan
 * ponerse el de otro). Esta PC principal la toma y la registra por la ruta única
 * de compras (registrar), igual que las del contador (motor en cola-compras.js):
 *  - quien la manda tiene que ser del negocio y, si es usuario del POS, tener el
 *    permiso «Registrar compras» (compras.crear) en el POS;
 *  - un administrador de sucursal registra solo en su sucursal;
 *  - lo que escribió la app se vuelve a limpiar aquí (la app no es de confianza);
 *  - no cambia precios ni el control de inventario de productos existentes; sí
 *    crea productos nuevos (sin código de barras inventado);
 *  - el negocio no emite comprobante de compra (E41/B11) desde la app.
 */

const { createColaCompras } = require('./cola-compras');

const MAX_LINEAS = 200;

function fallo(texto) {
  return Object.assign(new Error(texto), { statusCode: 400 });
}
function texto(valor, max) {
  // eslint-disable-next-line no-control-regex
  return String(valor == null ? '' : valor).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}
function numero(valor) {
  const n = Number(String(valor == null ? '' : valor).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : NaN;
}
function fechaValida(f) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(`${f}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
}

// Las mismas reglas que el Portal de Contadores (tecno-caja-contadores/server/compras-portal.js).
function limpiarCompraApp(d) {
  const e = d?.encabezado || {};
  const proveedor = { nombre: texto(e.proveedor?.nombre, 200), rnc: texto(e.proveedor?.rnc, 20).replace(/[^0-9]/g, '') };
  if (!proveedor.nombre && !proveedor.rnc) throw fallo('Indica el proveedor (nombre o RNC).');
  if (proveedor.rnc && ![9, 11].includes(proveedor.rnc.length)) throw fallo('El RNC o cédula del proveedor debe tener 9 u 11 dígitos.');
  const fecha = texto(e.fechaComprobante, 10);
  if (!fechaValida(fecha)) throw fallo('Indica la fecha de la factura.');
  const ncf = texto(e.ncf, 20).toUpperCase();
  if (ncf && !/^(B\d{10}|E\d{12})$/.test(ncf)) throw fallo('El NCF del proveedor no tiene el formato de la DGII (B + 10 dígitos o E + 12).');
  const condicion = e.condicionPago === 'credito' ? 'credito' : 'contado';
  const vence = condicion === 'credito' ? texto(e.fechaVencimiento, 10) : '';
  if (vence && !fechaValida(vence)) throw fallo('La fecha de vencimiento no es válida.');
  if (vence && vence < fecha) throw fallo('La fecha de vencimiento no puede ser antes de la factura.');
  const descuento = Math.max(0, numero(e.descuento) || 0);
  const encabezado = {
    proveedor, ncf, fechaComprobante: fecha, condicionPago: condicion, fechaVencimiento: vence,
    numeroDocumento: texto(e.numeroDocumento, 60) || ncf,
    notas: texto(e.notas, 200),
    descuento,
    ...(Number.isInteger(Number(e.tipoBienesServicios)) && Number(e.tipoBienesServicios) > 0 ? { tipoBienesServicios: Number(e.tipoBienesServicios) } : {}),
    ...(e.totalesDocumento && numero(e.totalesDocumento.total) > 0 ? {
      totalesDocumento: {
        subtotal: Math.max(0, numero(e.totalesDocumento.subtotal) || 0),
        itbis: Math.max(0, numero(e.totalesDocumento.itbis) || 0),
        total: numero(e.totalesDocumento.total),
      },
    } : {}),
  };
  const entrada = Array.isArray(d?.lineas) ? d.lineas : [];
  if (!entrada.length) throw fallo('Agrega al menos un producto o concepto.');
  if (entrada.length > MAX_LINEAS) throw fallo(`Máximo ${MAX_LINEAS} líneas por compra.`);
  const lineas = entrada.map((l, i) => {
    const cantidad = numero(l?.cantidad);
    const costo = numero(l?.costoUnitario);
    const itbis = l?.itbisPct === '' || l?.itbisPct == null ? 18 : numero(l.itbisPct);
    const descripcion = texto(l?.descripcion, 200);
    const productoId = Number(l?.productoId || 0);
    if (!descripcion && !productoId) throw fallo(`Línea ${i + 1}: falta la descripción.`);
    if (!(cantidad > 0)) throw fallo(`Línea ${i + 1}: la cantidad debe ser mayor que cero.`);
    if (!(costo >= 0)) throw fallo(`Línea ${i + 1}: el costo no es válido.`);
    if (!(itbis >= 0 && itbis <= 100)) throw fallo(`Línea ${i + 1}: el ITBIS % no es válido.`);
    const servicio = l?.tipoLinea === 'servicio_gasto';
    const existente = !servicio && Number.isInteger(productoId) && productoId > 0;
    const nuevo = !servicio && !existente;
    const precioValor = numero(l?.precio?.valor);
    return {
      descripcion, cantidad, costoUnitario: costo, itbisPct: itbis, descuento: Math.max(0, numero(l?.descuento) || 0),
      codigo: texto(l?.codigo, 60), codigoBarras: texto(l?.codigoBarras, 40).replace(/\s+/g, ''), unidad: texto(l?.unidad, 40),
      ...(servicio ? { tipoLinea: 'servicio_gasto' } : {}),
      ...(existente ? { productoId, accion: 'existente', decision: 'usuario' } : {}),
      ...(nuevo ? { accion: 'nuevo', decision: 'usuario', controlaInventario: l?.controlaInventario !== false } : {}),
      ...(nuevo && precioValor > 0 ? { precio: { modo: l.precio.modo === 'base' ? 'base' : 'incluido', valor: precioValor } } : {}),
    };
  });
  return { encabezado, lineas };
}

function createColaComprasApp({
  getBusinessId,                 // async () => id del negocio en businesses/{id} (el de la app de reportes)
  usuarioApp,                    // createUsuarioApp(...)
  ...deps                        // servicio, query, getDb, getBranchId, esPrincipal, writeAuditLog, alRegistrar, ahora, quien, logger
}) {
  const fuente = {
    nombre: 'app',
    versionDocumento: 'app-1',
    negocio: async () => String((await getBusinessId()) || '').trim(),
    cola: (db, negocio) => db.collection('businesses').doc(negocio).collection('appCompras'),
    contexto: async () => ({}),
    async validar(d, ctx) {
      const quien = await usuarioApp.resolver(ctx.db, ctx.negocio, d.createdBy);
      if (quien.rechazo) return { rechazo: quien.rechazo };
      if (!quien.puede('compras.crear')) return { rechazo: 'Tu usuario no tiene el permiso «Registrar compras» en el POS.' };
      const { encabezado, lineas } = limpiarCompraApp(d);
      const pedida = Number(d.branchId || 0) || null;
      if (quien.sucursal && pedida && pedida !== quien.sucursal) {
        return { rechazo: 'Solo puedes registrar compras de tu sucursal.' };
      }
      const branchId = quien.sucursal || pedida || null;
      if (branchId && ctx.sucursales && !ctx.sucursales.has(branchId)) throw fallo('Esa sucursal no existe en el POS.');
      return {
        actor: quien.actor,
        branchId,
        payload: {
          encabezado: {
            ...encabezado,
            comprobanteNegocio: '', emitirE41: false, documentoOrigen: 'app_reportes',
            notas: [encabezado.notas, `Registrada desde la app de reportes por ${quien.nombre}`].filter(Boolean).join(' · ').slice(0, 250),
          },
          lineas,
        },
        opciones: { puedeCrearProductos: true, puedeCambiarProductos: false },
      };
    },
    auditoria: (d, actor, id) => ({
      userRole: actor.role_name || actor.role_code || 'App de reportes', actionName: 'Compra registrada desde la app de reportes',
      detail: `${d.encabezado?.proveedor?.nombre || ''} · ${d.encabezado?.ncf || ''} · app de reportes (${id})`,
    }),
  };
  // Sucursales del POS, para no registrar en una que no existe.
  const contextoBase = fuente.contexto;
  fuente.contexto = async (...args) => {
    const filas = await deps.query('SELECT id FROM branches').catch(() => []);
    return { ...(await contextoBase(...args)), sucursales: new Set(filas.map((f) => Number(f.id))) };
  };
  return createColaCompras(fuente, deps);
}

module.exports = { createColaComprasApp, limpiarCompraApp };

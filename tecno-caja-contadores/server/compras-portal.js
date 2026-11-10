'use strict';

/**
 * Compras que el contador registra desde el portal para uno de sus negocios.
 *
 * El portal no toca la base del POS: deja la compra en
 *   licencias/{licencia}/compras_pendientes/{uuid}
 * y el POS principal del negocio la registra por su ruta única de compras
 * (server/services/compras/cola-portal.js en el POS), con el uuid como llave
 * para no registrarla dos veces. Estados:
 *   pendiente → procesando → registrada
 *                          ↘ requiere_correccion (el contador corrige y reenvía)
 *                          ↘ rechazada (el negocio desactivó al contador o ya no es su contador)
 *   pendiente / requiere_correccion → cancelada (el contador la quita)
 *
 *   GET  /api/compras-portal/:businessId            lista (más nuevas primero)
 *   POST /api/compras-portal/:businessId/leer       { nombre, base64 } → facturas leídas (XML e-CF, Excel, CSV)
 *   POST /api/compras-portal/:businessId            { encabezado, lineas, documento? } → la deja en la cola
 *   PUT  /api/compras-portal/:businessId/:id        corregir y reenviar (requiere_correccion)
 *   POST /api/compras-portal/:businessId/:id/cancelar
 */

const crypto = require('crypto');
const { leerXmlEcf } = require('./compras/lector-xml-ecf');
const { leerTabla } = require('./compras/lector-tabla');

const POS_VIEJO = 'Este negocio tiene una versión de Tecno Caja que todavía no recibe compras desde el portal: que actualice el POS primero.';
const ESTADOS_EDITABLES = ['requiere_correccion'];
const ESTADOS_CANCELABLES = ['pendiente', 'requiere_correccion'];
const MAX_LINEAS = 500;
const MAX_DOCUMENTO = 600 * 1024;

const texto = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const numero = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const fallo = (mensaje, status = 400) => Object.assign(new Error(mensaje), { status });

// Lo que viaja a la cola: solo los campos que la ruta de compras del POS usa.
function limpiarCompra(body) {
  const e = body?.encabezado || {};
  const proveedor = { nombre: texto(e.proveedor?.nombre, 200), rnc: texto(e.proveedor?.rnc, 20).replace(/[^0-9]/g, '') };
  if (!proveedor.nombre && !proveedor.rnc) throw fallo('Indica el proveedor (nombre o RNC).');
  if (proveedor.rnc && ![9, 11].includes(proveedor.rnc.length)) throw fallo('El RNC o cédula del proveedor debe tener 9 u 11 dígitos.');
  const fecha = texto(e.fechaComprobante, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw fallo('Indica la fecha de la factura.');
  const ncf = texto(e.ncf, 20).toUpperCase();
  if (ncf && !/^(B\d{10}|E\d{12})$/.test(ncf)) throw fallo('El NCF del proveedor no tiene el formato de la DGII (B + 10 dígitos o E + 12).');
  const condicion = e.condicionPago === 'credito' ? 'credito' : 'contado';
  const encabezado = {
    proveedor, ncf, fechaComprobante: fecha, condicionPago: condicion,
    fechaVencimiento: condicion === 'credito' ? texto(e.fechaVencimiento, 10) : '',
    numeroDocumento: texto(e.numeroDocumento, 60) || ncf,
    notas: texto(e.notas, 250),
    documentoOrigen: ['xml_ecf', 'tabla'].includes(e.documentoOrigen) ? e.documentoOrigen : 'portal',
    tipoBienesServicios: Number.isInteger(Number(e.tipoBienesServicios)) ? Number(e.tipoBienesServicios) : null,
    descuento: Math.max(0, numero(e.descuento) || 0),
    ...(e.encfProveedor ? { encfProveedor: texto(e.encfProveedor, 20) } : {}),
    ...(e.codigoSeguridad ? { codigoSeguridad: texto(e.codigoSeguridad, 10) } : {}),
    ...(e.totalesDocumento && Number(e.totalesDocumento.total) > 0 ? {
      totalesDocumento: {
        subtotal: numero(e.totalesDocumento.subtotal) || 0, itbis: numero(e.totalesDocumento.itbis) || 0,
        total: numero(e.totalesDocumento.total) || 0,
      },
    } : {}),
  };
  if (condicion === 'credito' && encabezado.fechaVencimiento && !/^\d{4}-\d{2}-\d{2}$/.test(encabezado.fechaVencimiento)) {
    throw fallo('La fecha de vencimiento no es válida.');
  }
  const lineasIn = Array.isArray(body?.lineas) ? body.lineas : [];
  if (!lineasIn.length) throw fallo('Agrega al menos una línea.');
  if (lineasIn.length > MAX_LINEAS) throw fallo(`Máximo ${MAX_LINEAS} líneas por compra.`);
  const lineas = lineasIn.map((l, i) => {
    const cantidad = numero(l.cantidad);
    const costo = numero(l.costoUnitario);
    const itbis = l.itbisPct === '' || l.itbisPct == null ? 18 : numero(l.itbisPct);
    const descripcion = texto(l.descripcion, 200);
    if (!descripcion && !l.productoId) throw fallo(`Línea ${i + 1}: falta la descripción.`);
    if (!(cantidad > 0)) throw fallo(`Línea ${i + 1}: la cantidad debe ser mayor que cero.`);
    if (!(costo >= 0)) throw fallo(`Línea ${i + 1}: el costo no es válido.`);
    if (!(itbis >= 0 && itbis <= 100)) throw fallo(`Línea ${i + 1}: el ITBIS % no es válido.`);
    const servicio = l.tipoLinea === 'servicio_gasto';
    const nuevo = !servicio && !l.productoId && l.accion === 'nuevo';
    const precio = nuevo && numero(l.precio?.valor) > 0
      ? { modo: ['base', 'incluido'].includes(l.precio.modo) ? l.precio.modo : 'incluido', valor: numero(l.precio.valor) }
      : null;
    return {
      descripcion, cantidad, costoUnitario: costo, itbisPct: itbis, descuento: Math.max(0, numero(l.descuento) || 0),
      codigo: texto(l.codigo, 60), codigoBarras: texto(l.codigoBarras, 40), codigoProveedor: texto(l.codigoProveedor, 80), unidad: texto(l.unidad, 40),
      ...(servicio ? { tipoLinea: 'servicio_gasto' } : {}),
      ...(l.productoId && !servicio ? { productoId: Number(l.productoId), accion: 'existente', decision: 'usuario' } : {}),
      ...(nuevo ? { accion: 'nuevo', decision: 'usuario', controlaInventario: l.controlaInventario !== false } : {}),
      ...(precio ? { precio } : {}),
    };
  });
  const documento = body?.documento && typeof body.documento.contenido === 'string' && body.documento.contenido.length <= MAX_DOCUMENTO
    ? { nombre: texto(body.documento.nombre, 120), tipo: texto(body.documento.tipo, 60) || 'application/xml', contenido: body.documento.contenido }
    : null;
  return { encabezado, lineas, documento };
}

// Total aproximado para la lista del portal (el POS calcula el definitivo).
function totalAproximado(lineas, descuento = 0) {
  let total = 0;
  for (const l of lineas) {
    const base = Math.max(0, l.cantidad * l.costoUnitario - (l.descuento || 0));
    total += base + base * (l.itbisPct / 100);
  }
  return Math.round((total - descuento) * 100) / 100;
}

function vista(id, d) {
  return {
    id, estado: d.status, proveedor: d.encabezado?.proveedor || {}, ncf: d.encabezado?.ncf || '',
    fecha: d.encabezado?.fechaComprobante || '', totalAproximado: d.totalAproximado || 0, lineas: (d.lineas || []).length,
    contadorNombre: d.contadorNombre || '', createdAt: d.createdAt, updatedAt: d.updatedAt,
    purchaseId: d.purchaseId || null, totalRegistrado: d.totalRegistrado ?? null, productosCreados: d.productosCreados || 0,
    mensaje: d.mensaje || d.errorMessage || '', bloqueos: d.bloqueos || [], avisos: d.avisos || [],
    registradaEn: d.registradaEn || null, tieneDocumento: Boolean(d.documento),
  };
}

function registrarRutasComprasPortal(app, { col, COL_LICENCIAS, requireAuth, isoNow }) {
  async function negocioDelContador(req) {
    const doc = await col(COL_LICENCIAS).doc(req.params.businessId).get();
    if (!doc.exists || doc.data().contadorId !== req.contador.contadorDocId) throw fallo('No tienes acceso a ese negocio.', 403);
    return { ref: doc.ref, datos: doc.data() };
  }
  const responder = (res, e) => res.status(e.status || 500).json({ error: e.message });

  app.get('/api/compras-portal/:businessId', requireAuth, async (req, res) => {
    try {
      const { ref, datos } = await negocioDelContador(req);
      const snap = await ref.collection('compras_pendientes').orderBy('createdAt', 'desc').limit(150).get();
      res.json({
        soportado: Number(datos.comprasPortalVersion || 0) >= 1,
        rncNegocio: datos.rnc || datos.perfilNegocio?.rnc || '',
        compras: snap.docs.map((d) => vista(d.id, d.data())),
      });
    } catch (e) { responder(res, e); }
  });

  // Una compra con sus líneas (para corregirla); el archivo original no viaja.
  app.get('/api/compras-portal/:businessId/:id', requireAuth, async (req, res) => {
    try {
      const { ref } = await negocioDelContador(req);
      const doc = await ref.collection('compras_pendientes').doc(String(req.params.id)).get();
      if (!doc.exists) throw fallo('No existe esa compra.', 404);
      const d = doc.data();
      res.json({ ...vista(doc.id, d), encabezado: d.encabezado || {}, lineas: d.lineas || [] });
    } catch (e) { responder(res, e); }
  });

  // Lee la factura del proveedor con los mismos lectores del POS (no guarda nada).
  app.post('/api/compras-portal/:businessId/leer', requireAuth, async (req, res) => {
    try {
      const { datos } = await negocioDelContador(req);
      const nombre = texto(req.body?.nombre, 160);
      const buffer = Buffer.from(String(req.body?.base64 || ''), 'base64');
      if (!buffer.length) throw fallo('El archivo está vacío.');
      if (buffer.length > 5 * 1024 * 1024) throw fallo('El archivo pasa de 5 MB.');
      if (/\.xml$/i.test(nombre) || buffer.slice(0, 200).toString('utf8').includes('<')) {
        const r = leerXmlEcf(buffer.toString('utf8'), { rncNegocio: datos.rnc || datos.perfilNegocio?.rnc || '' });
        const xml = buffer.toString('utf8');
        return res.json({
          facturas: [{ encabezado: r.encabezado, lineas: r.lineas, avisos: r.avisos }],
          documento: xml.length <= MAX_DOCUMENTO ? { nombre, tipo: 'application/xml', contenido: xml } : null,
        });
      }
      if (/\.(xlsx|xls|csv)$/i.test(nombre)) {
        const r = leerTabla(buffer, nombre);
        return res.json({ facturas: r.facturas, errores: r.errores || [] });
      }
      throw fallo('Sube el XML del e-CF del proveedor o el Excel/CSV con la plantilla de compras.');
    } catch (e) { responder(res, e); }
  });

  app.post('/api/compras-portal/:businessId', requireAuth, async (req, res) => {
    try {
      const { ref, datos } = await negocioDelContador(req);
      if (Number(datos.comprasPortalVersion || 0) < 1) throw fallo(POS_VIEJO, 409);
      const compra = limpiarCompra(req.body);
      // La misma factura del mismo proveedor no se manda dos veces (el POS también lo revisa).
      if (compra.encabezado.ncf && compra.encabezado.proveedor.rnc) {
        const iguales = await ref.collection('compras_pendientes').where('encabezado.ncf', '==', compra.encabezado.ncf).get();
        const repetida = iguales.docs.find((d) => d.data().encabezado?.proveedor?.rnc === compra.encabezado.proveedor.rnc && d.data().status !== 'cancelada');
        if (repetida) throw fallo(`Esa factura (${compra.encabezado.ncf}) ya se envió a este negocio.`, 409);
      }
      const id = crypto.randomUUID();
      const ahora = isoNow();
      const docu = {
        ...compra, status: 'pendiente', totalAproximado: totalAproximado(compra.lineas, compra.encabezado.descuento),
        contadorId: req.contador.contadorDocId, contadorNombre: req.contador.nombre_firma || req.contador.nombre || '',
        contadorEmail: req.contador.email || '', createdAt: ahora, updatedAt: ahora, intentos: 0,
      };
      await ref.collection('compras_pendientes').doc(id).set(docu);
      res.status(201).json(vista(id, docu));
    } catch (e) { responder(res, e); }
  });

  app.put('/api/compras-portal/:businessId/:id', requireAuth, async (req, res) => {
    try {
      const { ref } = await negocioDelContador(req);
      const docRef = ref.collection('compras_pendientes').doc(String(req.params.id));
      const compra = limpiarCompra(req.body);
      const cambios = {
        ...compra, status: 'pendiente', totalAproximado: totalAproximado(compra.lineas, compra.encabezado.descuento),
        bloqueos: [], mensaje: '', updatedAt: isoNow(),
      };
      // Sin archivo nuevo, se queda el original.
      if (!compra.documento) delete cambios.documento;
      const actual = await ref.firestore.runTransaction(async (tx) => {
        const doc = await tx.get(docRef);
        if (!doc.exists) throw fallo('No existe esa compra.', 404);
        if (!ESTADOS_EDITABLES.includes(doc.data().status)) throw fallo('Solo se corrige una compra que el negocio devolvió para corregir.', 409);
        tx.update(docRef, cambios);
        return doc;
      });
      res.json(vista(actual.id, { ...actual.data(), ...cambios }));
    } catch (e) { responder(res, e); }
  });

  app.post('/api/compras-portal/:businessId/:id/cancelar', requireAuth, async (req, res) => {
    try {
      const { ref } = await negocioDelContador(req);
      const docRef = ref.collection('compras_pendientes').doc(String(req.params.id));
      // En una transacción: si el POS la tomó en ese mismo instante, no se cancela.
      await ref.firestore.runTransaction(async (tx) => {
        const actual = await tx.get(docRef);
        if (!actual.exists) throw fallo('No existe esa compra.', 404);
        if (!ESTADOS_CANCELABLES.includes(actual.data().status)) throw fallo('Esa compra ya no se puede quitar (ya la está registrando el negocio o ya quedó).', 409);
        tx.update(docRef, { status: 'cancelada', updatedAt: isoNow() });
      });
      res.json({ ok: true });
    } catch (e) { responder(res, e); }
  });
}

module.exports = { registrarRutasComprasPortal, limpiarCompra, totalAproximado };

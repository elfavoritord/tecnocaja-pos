'use strict';

/**
 * Compras que el contador registra desde su portal (fase C).
 *
 * El portal deja cada compra en licencias/{licencia}/compras_pendientes/{uuid}
 * (tecno-caja-contadores/server/compras-portal.js). Esta PC (la principal del
 * negocio) la toma y la registra por la ruta única de compras (registrar), con
 * el uuid como llave: un reintento nunca duplica la compra, el inventario ni la
 * cuenta por pagar.
 *
 *   pendiente → procesando → registrada
 *                          ↘ requiere_correccion (con los motivos: el contador corrige y reenvía)
 *                          ↘ rechazada (el negocio apagó la opción o ese contador ya no es el suyo)
 *
 * El contador registra directo (decisión de Emilio, 2026-11-10), pero:
 *  - el negocio lo puede apagar (Compras → Configuración: «Mi contador registra compras»);
 *  - solo el contador vinculado a la licencia (contadorId) puede;
 *  - no cambia precios ni el control de inventario de productos existentes
 *    (eso sigue siendo del permiso Productos del negocio); sí crea productos nuevos.
 * Nunca frena la venta: corre en segundo plano y sin Internet no hace nada.
 */

const LEASE_MS = 10 * 60 * 1000;
const MAX_INTENTOS = 5;

function createColaComprasPortal({
  servicio,                     // crearServicioCompras(...): registrar, leerConfig, ensureSchema
  query,
  getDb,                        // () => Firestore (Admin SDK) o null
  getLicenseUid = () => String(process.env.TECNO_CAJA_LICENSE_UID || '').trim(),
  getBranchId,                  // () => sucursal donde se registra (la de esta PC principal)
  esPrincipal = () => true,
  writeAuditLog = async () => {},
  alRegistrar = () => {},       // refrescar la app de reportes y el espejo del portal
  ahora = () => new Date().toISOString(),
  quien = () => '',
  logger = console,
}) {
  let corriendo = null;

  function cola(db, licencia) {
    return db.collection('licencias').doc(licencia).collection('compras_pendientes');
  }

  // La toma solo si sigue pendiente (o si otra PC la dejó a medias hace rato).
  async function tomar(db, ref) {
    return db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return null;
      const d = doc.data();
      const viejo = d.status === 'procesando' && Date.now() - new Date(d.procesandoEn || 0).getTime() > LEASE_MS;
      if (d.status !== 'pendiente' && !viejo) return null;
      tx.update(ref, { status: 'procesando', procesandoEn: ahora(), procesandoPor: quien(), intentos: Number(d.intentos || 0) + 1, updatedAt: ahora() });
      return d;
    });
  }

  function payloadDe(id, d) {
    const e = d.encabezado || {};
    return {
      uuid: id,
      encabezado: {
        ...e,
        // Lo que manda el portal es una compra del proveedor: el negocio no emite comprobante de compra.
        comprobanteNegocio: '', emitirE41: false,
        documentoOrigen: ['xml_ecf', 'tabla'].includes(e.documentoOrigen) ? e.documentoOrigen : 'portal',
        notas: [e.notas, `Registrada por el contador ${d.contadorNombre || ''} desde su portal`].filter(Boolean).join(' · ').slice(0, 250),
      },
      lineas: Array.isArray(d.lineas) ? d.lineas : [],
    };
  }

  async function guardarDocumento(purchaseId, d, actorNombre) {
    const docu = d.documento;
    if (!docu || typeof docu.contenido !== 'string' || !purchaseId) return;
    const crypto = require('crypto');
    const sha256 = crypto.createHash('sha256').update(docu.contenido).digest('hex');
    const [ya] = await query('SELECT id FROM purchase_documents WHERE sha256 = ? LIMIT 1', [sha256]).catch(() => []);
    if (ya) return;
    await query(
      `INSERT INTO purchase_documents (id, draft_id, purchase_id, nombre, tipo, tamano, sha256, contenido, version_extractor, created_by_user_name, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), purchaseId, String(docu.nombre || 'factura-proveedor.xml').slice(0, 200), String(docu.tipo || 'application/xml').slice(0, 80),
        Buffer.byteLength(docu.contenido), sha256, Buffer.from(docu.contenido).toString('base64'), 'portal-1', actorNombre, ahora()]
    ).catch((e) => logger.warn('[compras-portal] No se guardó el documento original:', e.message));
  }

  async function procesarUna(db, licencia, doc, { licenciaDatos, cfg, branchId }) {
    const ref = doc.ref;
    const d = await tomar(db, ref);
    if (!d) return 'omitida';
    const terminar = (cambios) => ref.update({ ...cambios, updatedAt: ahora() }).catch(() => {});

    if (!cfg.contadorRegistra) {
      await terminar({ status: 'rechazada', mensaje: 'El negocio desactivó las compras registradas por su contador (Compras → Configuración).' });
      return 'rechazada';
    }
    if (!d.contadorId || d.contadorId !== licenciaDatos?.contadorId) {
      await terminar({ status: 'rechazada', mensaje: 'Ese contador ya no está vinculado a este negocio.' });
      return 'rechazada';
    }
    const actor = { id: null, nombre: `Contador: ${d.contadorNombre || 'sin nombre'}`, usuario: d.contadorEmail || 'contador', role_code: 'contador', rol: 'contador' };
    try {
      const r = await servicio.registrar(payloadDe(doc.id, d), {
        actor, branchId, puedeCrearProductos: true, puedeCambiarProductos: false,
      });
      const [fila] = await query('SELECT total FROM purchases WHERE id = ? LIMIT 1', [r.purchaseId]).catch(() => []);
      await guardarDocumento(r.purchaseId, d, actor.nombre);
      await terminar({
        status: 'registrada', purchaseId: Number(r.purchaseId), totalRegistrado: Number(fila?.total ?? r.total ?? 0),
        productosCreados: (r.productosCreados || []).length, repetida: Boolean(r.repetida),
        avisos: [], bloqueos: [], mensaje: r.repetida ? 'Ya estaba registrada (no se duplicó).' : '', registradaEn: ahora(),
      });
      if (!r.repetida) {
        await Promise.resolve(writeAuditLog({
          userId: null, userName: actor.nombre, userRole: 'Contador', moduleName: 'Compras', actionName: 'Compra registrada por el contador',
          documentRef: d.encabezado?.ncf || doc.id, amount: Number(fila?.total || 0),
          detail: `${d.encabezado?.proveedor?.nombre || ''} · ${d.encabezado?.ncf || ''} · desde el portal del contador (${doc.id})`,
        })).catch(() => {});
        Promise.resolve(alRegistrar()).catch(() => {});
      }
      return 'registrada';
    } catch (error) {
      const bloqueos = Array.isArray(error.bloqueos) ? error.bloqueos.map((b) => (typeof b === 'string' ? b : b?.texto || String(b))) : [];
      // Datos que el contador tiene que corregir (no cuadra, falta algo, factura repetida…).
      if (bloqueos.length || (Number(error.statusCode) >= 400 && Number(error.statusCode) < 500)) {
        await terminar({ status: 'requiere_correccion', bloqueos: bloqueos.length ? bloqueos : [error.message], mensaje: error.message });
        return 'requiere_correccion';
      }
      // Falla de esta PC (base ocupada, etc.): vuelve a la cola, hasta 5 veces.
      const intentos = Number(d.intentos || 0) + 1;
      await terminar(intentos >= MAX_INTENTOS
        ? { status: 'requiere_correccion', bloqueos: [`No se pudo registrar en el POS: ${error.message}`], mensaje: error.message }
        : { status: 'pendiente', mensaje: `Reintentando: ${error.message}` });
      logger.warn('[compras-portal] No se pudo registrar:', error.message);
      return 'error';
    }
  }

  async function procesar() {
    if (corriendo) return corriendo;
    corriendo = (async () => {
      const licencia = getLicenseUid();
      if (!licencia || !esPrincipal()) return { omitido: true };
      let db;
      try { db = getDb(); } catch (_) { db = null; }
      if (!db) return { omitido: true };
      const pendientes = await cola(db, licencia).where('status', 'in', ['pendiente', 'procesando']).limit(25).get();
      if (pendientes.empty) return { registradas: 0 };
      await servicio.ensureSchema();
      const licenciaDoc = await db.collection('licencias').doc(licencia).get();
      const contexto = { licenciaDatos: licenciaDoc.exists ? licenciaDoc.data() : null, cfg: await servicio.leerConfig(), branchId: await getBranchId() };
      if (!contexto.branchId) return { omitido: true, motivo: 'sin sucursal' };
      const resultado = { registradas: 0, correcciones: 0, rechazadas: 0, errores: 0 };
      for (const doc of pendientes.docs) {
        const r = await procesarUna(db, licencia, doc, contexto);
        if (r === 'registrada') resultado.registradas += 1;
        else if (r === 'requiere_correccion') resultado.correcciones += 1;
        else if (r === 'rechazada') resultado.rechazadas += 1;
        else if (r === 'error') resultado.errores += 1;
      }
      return resultado;
    })().catch((e) => { logger.warn('[compras-portal]', e.message); return { error: e.message }; })
      .finally(() => { corriendo = null; });
    return corriendo;
  }

  // Se entera en segundos de una compra nueva (como productos_pendientes); si el
  // listener se cae, el temporizador del servidor la toma igual.
  let desuscribir = null;
  function escuchar() {
    if (desuscribir) return true;
    const licencia = getLicenseUid();
    let db;
    try { db = getDb(); } catch (_) { db = null; }
    if (!licencia || !db) return false;
    desuscribir = cola(db, licencia).where('status', '==', 'pendiente').onSnapshot(
      (snap) => { if (!snap.empty) procesar(); },
      (err) => { logger.warn('[compras-portal] listener:', err.message); desuscribir = null; }
    );
    return true;
  }

  return { procesar, escuchar, payloadDe };
}

module.exports = { createColaComprasPortal };

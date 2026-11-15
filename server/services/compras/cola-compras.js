'use strict';

/**
 * Motor de las colas de compras que llegan por Firestore y que esta PC (la
 * principal del negocio) registra por la ruta única de compras (registrar),
 * con el id del documento como uuid: un reintento nunca duplica la compra, el
 * inventario ni la cuenta por pagar.
 *
 *   pendiente → procesando → registrada
 *                          ↘ requiere_correccion (con los motivos: quien la mandó corrige y reenvía)
 *                          ↘ rechazada (no tiene permiso o el negocio apagó la opción)
 *
 * Cada origen pone sus reglas en una «fuente»:
 *   - cola-portal.js → el contador, desde su portal (licencias/{id}/compras_pendientes).
 *   - cola-app.js    → el dueño o un administrador, desde la app de reportes
 *                      (businesses/{id}/appCompras).
 *
 * fuente = {
 *   nombre,                               // para los avisos del log
 *   negocio: async (deps) => id,          // documento raíz de la cola
 *   cola: (db, id) => CollectionReference,
 *   contexto: async (db, id, deps) => ({}),
 *   validar: async (d, ctx) => ({ rechazo }) | ({ actor, payload, opciones, branchId? })
 *            (lanza un error 4xx si hay que corregir algo del documento),
 *   auditoria: (d, actor, docId, fila) => { userRole, actionName, detail },
 *   versionDocumento: 'portal-1',         // purchase_documents.version_extractor
 * }
 * Nunca frena la venta: corre en segundo plano y sin Internet no hace nada.
 */

const LEASE_MS = 10 * 60 * 1000;
const MAX_INTENTOS = 5;

function createColaCompras(fuente, deps) {
  const {
    servicio, query, getDb, getBranchId,
    esPrincipal = () => true,
    writeAuditLog = async () => {},
    alRegistrar = () => {},
    ahora = () => new Date().toISOString(),
    quien = () => '',
    logger = console,
  } = deps;
  let corriendo = null;
  const etiqueta = `[compras-${fuente.nombre}]`;

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
        Buffer.byteLength(docu.contenido), sha256, Buffer.from(docu.contenido).toString('base64'), fuente.versionDocumento || fuente.nombre, actorNombre, ahora()]
    ).catch((e) => logger.warn(`${etiqueta} No se guardó el documento original:`, e.message));
  }

  function aCorregir(error) {
    const bloqueos = Array.isArray(error.bloqueos) ? error.bloqueos.map((b) => (typeof b === 'string' ? b : b?.texto || String(b))) : [];
    if (bloqueos.length || (Number(error.statusCode) >= 400 && Number(error.statusCode) < 500)) {
      return { status: 'requiere_correccion', bloqueos: bloqueos.length ? bloqueos : [error.message], mensaje: error.message };
    }
    return null;
  }

  async function procesarUna(db, doc, ctx) {
    const ref = doc.ref;
    const d = await tomar(db, ref);
    if (!d) return 'omitida';
    const terminar = (cambios) => ref.update({ ...cambios, updatedAt: ahora() }).catch(() => {});

    let validado;
    try {
      validado = await fuente.validar(d, ctx, doc.id);
    } catch (error) {
      const corregir = aCorregir(error);
      if (corregir) { await terminar(corregir); return 'requiere_correccion'; }
      await terminar({ status: 'pendiente', mensaje: `Reintentando: ${error.message}` });
      logger.warn(`${etiqueta} No se pudo validar:`, error.message);
      return 'error';
    }
    if (validado.rechazo) {
      await terminar({ status: 'rechazada', mensaje: validado.rechazo });
      return 'rechazada';
    }
    const { actor, payload, opciones = {} } = validado;
    const branchId = validado.branchId || ctx.branchId;
    try {
      const r = await servicio.registrar({ ...payload, uuid: doc.id }, { actor, branchId, ...opciones });
      const [fila] = await query('SELECT total FROM purchases WHERE id = ? LIMIT 1', [r.purchaseId]).catch(() => []);
      await guardarDocumento(r.purchaseId, d, actor.nombre);
      await terminar({
        status: 'registrada', purchaseId: Number(r.purchaseId), totalRegistrado: Number(fila?.total ?? r.total ?? 0),
        productosCreados: (r.productosCreados || []).length, repetida: Boolean(r.repetida),
        avisos: [], bloqueos: [], mensaje: r.repetida ? 'Ya estaba registrada (no se duplicó).' : '', registradaEn: ahora(),
      });
      if (!r.repetida) {
        const a = fuente.auditoria(d, actor, doc.id, fila) || {};
        await Promise.resolve(writeAuditLog({
          userId: actor.id || null, userName: actor.nombre, userRole: a.userRole || '', moduleName: 'Compras', actionName: a.actionName || 'Compra registrada',
          documentRef: d.encabezado?.ncf || doc.id, amount: Number(fila?.total || 0), detail: a.detail || '',
        })).catch(() => {});
        Promise.resolve(alRegistrar()).catch(() => {});
      }
      return 'registrada';
    } catch (error) {
      // Datos que hay que corregir (no cuadra, falta algo, factura repetida…).
      const corregir = aCorregir(error);
      if (corregir) { await terminar(corregir); return 'requiere_correccion'; }
      // Falla de esta PC (base ocupada, etc.): vuelve a la cola, hasta 5 veces.
      const intentos = Number(d.intentos || 0) + 1;
      await terminar(intentos >= MAX_INTENTOS
        ? { status: 'requiere_correccion', bloqueos: [`No se pudo registrar en el POS: ${error.message}`], mensaje: error.message }
        : { status: 'pendiente', mensaje: `Reintentando: ${error.message}` });
      logger.warn(`${etiqueta} No se pudo registrar:`, error.message);
      return 'error';
    }
  }

  async function procesar() {
    if (corriendo) return corriendo;
    corriendo = (async () => {
      const negocio = await fuente.negocio(deps);
      if (!negocio || !esPrincipal()) return { omitido: true };
      let db;
      try { db = getDb(); } catch (_) { db = null; }
      if (!db) return { omitido: true };
      const pendientes = await fuente.cola(db, negocio).where('status', 'in', ['pendiente', 'procesando']).limit(25).get();
      if (pendientes.empty) return { registradas: 0 };
      await servicio.ensureSchema();
      const ctx = { ...(await fuente.contexto(db, negocio, deps)), negocio, db, branchId: await getBranchId() };
      if (!ctx.branchId) return { omitido: true, motivo: 'sin sucursal' };
      const resultado = { registradas: 0, correcciones: 0, rechazadas: 0, errores: 0 };
      for (const doc of pendientes.docs) {
        const r = await procesarUna(db, doc, ctx);
        if (r === 'registrada') resultado.registradas += 1;
        else if (r === 'requiere_correccion') resultado.correcciones += 1;
        else if (r === 'rechazada') resultado.rechazadas += 1;
        else if (r === 'error') resultado.errores += 1;
      }
      return resultado;
    })().catch((e) => { logger.warn(etiqueta, e.message); return { error: e.message }; })
      .finally(() => { corriendo = null; });
    return corriendo;
  }

  // Se entera en segundos de una compra nueva; si el listener se cae, el
  // temporizador del servidor la toma igual.
  let desuscribir = null;
  async function escuchar() {
    if (desuscribir) return true;
    const negocio = await fuente.negocio(deps);
    let db;
    try { db = getDb(); } catch (_) { db = null; }
    if (!negocio || !db) return false;
    desuscribir = fuente.cola(db, negocio).where('status', '==', 'pendiente').onSnapshot(
      (snap) => { if (!snap.empty) procesar(); },
      (err) => { logger.warn(`${etiqueta} listener:`, err.message); desuscribir = null; }
    );
    return true;
  }

  return { procesar, escuchar };
}

module.exports = { createColaCompras, LEASE_MS, MAX_INTENTOS };

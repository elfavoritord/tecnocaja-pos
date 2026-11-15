'use strict';

/**
 * Pedidos de documentos de la app de reportes (TCP Reportes).
 *
 * La app no habla con esta PC: deja el pedido en
 * businesses/{negocio}/appSolicitudes/{id} = { tipo, parametros, createdBy, status: 'pendiente' }
 * y la PC principal, si está encendida y con Internet, lo atiende:
 *
 *   pendiente → procesando → lista  (pdf + resumen)
 *                          ↘ error  (mensaje)
 *
 * El PDF va como bytes en el mismo documento si cabe, o partido en
 * appSolicitudes/{id}/partes/{n} (Firestore no deja documentos de más de 1 MB).
 * Los pedidos se borran solos a los 3 días. Nunca frena la venta: corre en
 * segundo plano, de uno en uno.
 */

const LEASE_MS = 3 * 60 * 1000;
const PARTE_BYTES = 700 * 1024;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const VIDA_MS = 3 * 24 * 3600 * 1000;

function createSolicitudesApp({
  getDb,                     // () => Firestore (Admin SDK) o null
  getBusinessId,             // async () => id del negocio de la app de reportes
  esPrincipal = () => true,
  usuarioApp,                // createUsuarioApp(...)
  generadores,               // { factura, estado_cuenta } (createDocumentosApp)
  ahora = () => new Date(),
  quien = () => '',
  logger = console,
}) {
  let corriendo = null;
  let ultimaLimpieza = 0;

  const cola = (db, negocio) => db.collection('businesses').doc(negocio).collection('appSolicitudes');

  async function tomar(db, ref) {
    return db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return null;
      const d = doc.data();
      const viejo = d.status === 'procesando' && Date.now() - new Date(d.procesandoEn || 0).getTime() > LEASE_MS;
      if (d.status !== 'pendiente' && !viejo) return null;
      tx.update(ref, { status: 'procesando', procesandoEn: ahora().toISOString(), procesandoPor: quien(), updatedAt: ahora().toISOString() });
      return d;
    });
  }

  async function guardarPdf(ref, pdf) {
    if (pdf.length <= PARTE_BYTES) return { pdf, partes: 0 };
    const partes = Math.ceil(pdf.length / PARTE_BYTES);
    for (let i = 0; i < partes; i += 1) {
      await ref.collection('partes').doc(String(i)).set({ i, data: pdf.subarray(i * PARTE_BYTES, (i + 1) * PARTE_BYTES) });
    }
    return { partes };
  }

  async function atender(db, negocio, doc) {
    const ref = doc.ref;
    const d = await tomar(db, ref);
    if (!d) return 'omitida';
    const terminar = (cambios) => ref.update({ ...cambios, updatedAt: ahora().toISOString() }).catch(() => {});
    try {
      const generar = generadores[String(d.tipo || '')];
      if (typeof generar !== 'function') {
        await terminar({ status: 'error', mensaje: 'Esta versión del POS no sabe preparar ese documento. Actualiza el POS.' });
        return 'error';
      }
      const usuario = await usuarioApp.resolver(db, negocio, d.createdBy);
      if (usuario.rechazo) { await terminar({ status: 'error', mensaje: usuario.rechazo }); return 'error'; }
      const r = await generar(d.parametros || {}, usuario);
      const pdf = Buffer.isBuffer(r.pdf) ? r.pdf : Buffer.from(r.pdf || []);
      if (!pdf.length) throw Object.assign(new Error('El PDF salió vacío.'), { statusCode: 500 });
      if (pdf.length > MAX_PDF_BYTES) throw Object.assign(new Error('El documento es demasiado grande para mandarlo a la app. Acorta el período.'), { statusCode: 400 });
      const guardado = await guardarPdf(ref, pdf);
      await terminar({
        status: 'lista', titulo: r.titulo || '', archivo: r.archivo || 'documento.pdf', tamano: pdf.length,
        resumen: r.resumen || {}, mensaje: '', listaEn: ahora().toISOString(), ...guardado,
      });
      return 'lista';
    } catch (error) {
      const delUsuario = Number(error.statusCode) >= 400 && Number(error.statusCode) < 500;
      if (!delUsuario) logger.warn('[app-reportes] No se pudo preparar el documento:', error.message);
      await terminar({ status: 'error', mensaje: delUsuario ? error.message : `La PC no pudo preparar el documento: ${error.message}` });
      return 'error';
    }
  }

  async function limpiar(db, negocio) {
    if (Date.now() - ultimaLimpieza < 6 * 3600 * 1000) return;
    ultimaLimpieza = Date.now();
    // createdAt lo pone Firestore (request.time, lo exigen las reglas): se compara con una fecha.
    const limite = new Date(Date.now() - VIDA_MS);
    const viejas = await cola(db, negocio).where('createdAt', '<', limite).limit(40).get().catch(() => null);
    for (const doc of viejas?.docs || []) {
      const creada = doc.data()?.createdAt;
      const ms = typeof creada?.toMillis === 'function' ? creada.toMillis() : (creada instanceof Date ? creada.getTime() : NaN);
      if (!(ms < limite.getTime())) continue;
      const partes = await doc.ref.collection('partes').get().catch(() => null);
      for (const p of partes?.docs || []) await p.ref.delete().catch(() => {});
      await doc.ref.delete().catch(() => {});
    }
  }

  async function procesar() {
    if (corriendo) return corriendo;
    corriendo = (async () => {
      const negocio = String((await getBusinessId()) || '').trim();
      if (!negocio || !esPrincipal()) return { omitido: true };
      let db;
      try { db = getDb(); } catch (_) { db = null; }
      if (!db) return { omitido: true };
      const pendientes = await cola(db, negocio).where('status', 'in', ['pendiente', 'procesando']).limit(10).get();
      const resultado = { listas: 0, errores: 0 };
      for (const doc of pendientes.docs) {
        const r = await atender(db, negocio, doc);
        if (r === 'lista') resultado.listas += 1;
        else if (r === 'error') resultado.errores += 1;
      }
      await limpiar(db, negocio).catch(() => {});
      return resultado;
    })().catch((e) => { logger.warn('[app-reportes]', e.message); return { error: e.message }; })
      .finally(() => { corriendo = null; });
    return corriendo;
  }

  let desuscribir = null;
  async function escuchar() {
    if (desuscribir) return true;
    const negocio = String((await getBusinessId()) || '').trim();
    let db;
    try { db = getDb(); } catch (_) { db = null; }
    if (!negocio || !db) return false;
    desuscribir = cola(db, negocio).where('status', '==', 'pendiente').onSnapshot(
      (snap) => { if (!snap.empty) procesar(); },
      (err) => { logger.warn('[app-reportes] listener:', err.message); desuscribir = null; }
    );
    return true;
  }

  return { procesar, escuchar };
}

module.exports = { createSolicitudesApp, PARTE_BYTES };

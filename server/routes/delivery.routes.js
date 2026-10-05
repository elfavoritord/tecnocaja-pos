/**
 * Rutas de gestión de pedidos de delivery
 * Integración entre Tecno Caja POS y la app de repartidores
 *
 * Firestore collections: pedidos_delivery, repartidores
 *
 * Aislamiento por negocio: pedidos_delivery y repartidores son colecciones
 * GLOBALES del proyecto Firebase (la app de repartidores las lee por
 * repartidorId) y las comparten todos los clientes. Este panel solo muestra
 * lo que es de ESTE negocio:
 *  - pedidos con licenseId = licencia de esta instalación;
 *  - pedidos viejos (sin licenseId) solo si coinciden con una venta delivery
 *    de esta base de datos: misma factura, mismo repartidor y mismo total;
 *  - repartidores que son usuarios de esta base de datos.
 */

const express = require('express');

const ESTADOS_PEDIDO = ['asignado', 'en_camino', 'entregado', 'incidencia'];
const MAX_PEDIDOS = 200;
// Lectura sin orden mientras no exista el índice compuesto en Firestore.
const MAX_LECTURA_SIN_INDICE = 300;
const FIRESTORE_FAILED_PRECONDITION = 9;
const FIRESTORE_IN_LIMIT = 10;

function defaultGetFirestore() {
  try {
    const { getFirestore } = require('../../modules/firebase-admin');
    return getFirestore();
  } catch {
    return null;
  }
}

function createDeliveryRouter({ query, getTenantId = () => '', getFirestore = defaultGetFirestore }) {
  const router = express.Router();

  function normalizeNullableCoordinate(value) {
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function normalizeOptionalText(value) {
    if (value === undefined || value === null) return '';
    const text = String(value).trim();
    if (!text || text.toLowerCase() === 'null' || text.toLowerCase() === 'undefined') {
      return '';
    }
    return text;
  }

  function serverTimestamp() {
    try {
      const { FieldValue } = require('firebase-admin/firestore');
      return FieldValue.serverTimestamp();
    } catch {
      return new Date().toISOString();
    }
  }

  function currentTenantId() {
    return normalizeOptionalText(getTenantId());
  }

  function timestampMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (ts._seconds !== undefined && ts._seconds !== null) return Number(ts._seconds) * 1000;
    const parsed = new Date(ts).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function sortByCreado(pedidos) {
    return pedidos.sort((a, b) => timestampMs(b.creadoEn) - timestampMs(a.creadoEn));
  }

  function docsToList(snap) {
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  // ── Datos locales (esta base de datos = este negocio) ─────────────────────

  async function getLocalFirebaseUids() {
    try {
      const rows = await query(
        "SELECT firebase_uid FROM users WHERE firebase_uid IS NOT NULL AND firebase_uid <> ''",
      );
      return new Set((rows || []).map((row) => normalizeOptionalText(row.firebase_uid)).filter(Boolean));
    } catch (err) {
      console.warn('[delivery] No se pudieron leer los usuarios locales:', err.message);
      return new Set();
    }
  }

  /** Ventas delivery locales con repartidor vinculado a Firebase: factura → { uid, total }. */
  async function getLocalDeliverySales() {
    try {
      const rows = await query(
        `SELECT s.invoice_number, s.total, u.firebase_uid
           FROM sales s
           INNER JOIN users u ON u.id = s.delivery_user_id
          WHERE s.order_type = 'delivery'
            AND u.firebase_uid IS NOT NULL AND u.firebase_uid <> ''
          ORDER BY s.id DESC
          LIMIT 2000`,
      );
      const sales = new Map();
      for (const row of rows || []) {
        const invoice = normalizeOptionalText(row.invoice_number);
        if (invoice && !sales.has(invoice)) {
          sales.set(invoice, { uid: normalizeOptionalText(row.firebase_uid), total: Number(row.total || 0) });
        }
      }
      return sales;
    } catch (err) {
      console.warn('[delivery] No se pudieron leer las ventas delivery locales:', err.message);
      return new Map();
    }
  }

  function belongsToTenant(pedido, { tenantId, sales }) {
    const owner = normalizeOptionalText(pedido?.licenseId);
    if (owner) return Boolean(tenantId) && owner === tenantId;
    // Pedido viejo sin licencia: solo si es una venta delivery de esta base.
    const sale = sales.get(normalizeOptionalText(pedido?.numeroFactura));
    return Boolean(sale)
      && sale.uid === normalizeOptionalText(pedido?.repartidorId)
      && Math.abs(sale.total - Number(pedido?.total || 0)) < 0.01;
  }

  async function loadTenantContext() {
    const sales = await getLocalDeliverySales();
    return { tenantId: currentTenantId(), sales };
  }

  // ── Lecturas filtradas en Firestore ───────────────────────────────────────

  let warnedMissingIndex = false;
  function warnMissingIndex(err) {
    if (warnedMissingIndex) return;
    warnedMissingIndex = true;
    console.warn(
      '[delivery] Falta un índice de Firestore para pedidos_delivery (ver firestore.indexes.json; '
      + 'se crea con "firebase deploy --only firestore:indexes"). Mientras tanto se lee sin orden.',
      err.message,
    );
  }

  /** Ejecuta la consulta ordenada; si falta el índice compuesto, la repite sin orden. */
  async function getOrdered(baseQuery, limit) {
    try {
      return docsToList(await baseQuery.orderBy('creadoEn', 'desc').limit(limit).get());
    } catch (err) {
      if (Number(err?.code) !== FIRESTORE_FAILED_PRECONDITION) throw err;
      warnMissingIndex(err);
      const list = docsToList(await baseQuery.limit(MAX_LECTURA_SIN_INDICE).get());
      return sortByCreado(list).slice(0, limit);
    }
  }

  async function fetchTenantPedidos(db, tenantId, { estado, limit }) {
    if (!tenantId) return [];
    let base = db.collection('pedidos_delivery').where('licenseId', '==', tenantId);
    if (estado) base = base.where('estado', '==', estado);
    return getOrdered(base, limit);
  }

  /** Pedidos viejos (sin licenseId) de los repartidores de las ventas locales. */
  async function fetchLegacyPedidos(db, sales, { estado, limit }) {
    const uids = [...new Set([...sales.values()].map((sale) => sale.uid).filter(Boolean))];
    if (!uids.length) return [];
    const estados = estado ? [estado] : ESTADOS_PEDIDO;
    const perEstado = estado ? limit : Math.ceil(limit / 2);
    const out = [];
    try {
      for (const group of chunk(uids, FIRESTORE_IN_LIMIT)) {
        for (const est of estados) {
          const base = db.collection('pedidos_delivery')
            .where('repartidorId', 'in', group)
            .where('estado', '==', est);
          out.push(...await getOrdered(base, perEstado));
        }
      }
    } catch (err) {
      // Los pedidos viejos son de mejor esfuerzo: nunca tumban el panel.
      console.warn('[delivery] No se pudieron leer pedidos anteriores:', err.message);
    }
    return out;
  }

  async function loadOwnPedidos(db, { estado = '', repartidorId = '', limit = 100 } = {}) {
    const ctx = await loadTenantContext();
    const [own, legacy] = await Promise.all([
      fetchTenantPedidos(db, ctx.tenantId, { estado, limit }),
      fetchLegacyPedidos(db, ctx.sales, { estado, limit }),
    ]);
    const byId = new Map();
    for (const pedido of [...own, ...legacy]) {
      if (byId.has(pedido.id) || !belongsToTenant(pedido, ctx)) continue;
      if (estado && pedido.estado !== estado) continue;
      if (repartidorId && pedido.repartidorId !== repartidorId) continue;
      byId.set(pedido.id, pedido);
    }
    return sortByCreado([...byId.values()]).slice(0, limit);
  }

  function parseLimit(value, fallback) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, MAX_PEDIDOS);
  }

  // ──────────────────────────────────────────────
  // REPARTIDORES
  // ──────────────────────────────────────────────

  /**
   * POST /api/delivery/repartidores
   * Crea o actualiza un repartidor en Firestore a partir de un usuario POS.
   * Requiere: uid (firebase_uid de un usuario de este negocio), nombre, email
   */
  router.post('/repartidores', async (req, res) => {
    try {
      const { uid, nombre, email, telefono } = req.body;
      if (!uid || !nombre || !email) {
        return res.status(400).json({
          ok: false,
          error: 'Faltan campos: uid, nombre, email',
        });
      }
      const localUids = await getLocalFirebaseUids();
      if (!localUids.has(normalizeOptionalText(uid))) {
        return res.status(403).json({ ok: false, error: 'Ese repartidor no es un usuario de este negocio.' });
      }
      const db = getFirestore();
      if (!db) return res.status(503).json({ ok: false, error: 'Firebase no disponible' });

      await db.collection('repartidores').doc(uid).set(
        {
          uid,
          nombre,
          email,
          telefono: telefono || '',
          activo: true,
          rol: 'repartidor',
          ultimaUbicacion: null,
          pedidoActual: null,
          actualizadoEn: serverTimestamp(),
        },
        { merge: true },
      );
      return res.json({ ok: true });
    } catch (err) {
      console.error('[delivery] Error creando repartidor:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/delivery/repartidores/sync/:posUserId
   * Sincroniza un usuario POS existente a la colección repartidores de Firestore.
   * Lee desde la BD local y escribe en Firestore.
   */
  router.post('/repartidores/sync/:posUserId', async (req, res) => {
    try {
      const posUserId = Number(req.params.posUserId);
      if (!posUserId) return res.status(400).json({ ok: false, error: 'ID inválido' });

      const rows = await query(
        'SELECT id, nombre, email, telefono, firebase_uid, estado FROM users WHERE id = ? LIMIT 1',
        [posUserId],
      );
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });

      const user = rows[0];
      if (!user.firebase_uid) {
        return res.status(409).json({
          ok: false,
          error: 'El usuario no tiene Firebase UID. Primero usa "Sincronizar Firebase" para crear su acceso.',
        });
      }

      const db = getFirestore();
      if (!db) return res.status(503).json({ ok: false, error: 'Firebase no disponible' });

      await db.collection('repartidores').doc(user.firebase_uid).set(
        {
          uid: user.firebase_uid,
          nombre: user.nombre,
          email: user.email,
          telefono: user.telefono || '',
          activo: String(user.estado || '').trim().toLowerCase() === 'activo',
          rol: 'repartidor',
          ultimaUbicacion: null,
          pedidoActual: null,
          actualizadoEn: serverTimestamp(),
        },
        { merge: true },
      );

      return res.json({ ok: true, uid: user.firebase_uid });
    } catch (err) {
      console.error('[delivery] Error sincronizando repartidor:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * PATCH /api/delivery/repartidores/:uid/activo
   * Activa o desactiva un repartidor de este negocio en Firestore.
   */
  router.patch('/repartidores/:uid/activo', async (req, res) => {
    try {
      const { activo } = req.body;
      const localUids = await getLocalFirebaseUids();
      if (!localUids.has(normalizeOptionalText(req.params.uid))) {
        return res.status(404).json({ ok: false, error: 'Repartidor no encontrado en este negocio.' });
      }
      const db = getFirestore();
      if (!db) return res.status(503).json({ ok: false, error: 'Firebase no disponible' });

      await db.collection('repartidores').doc(req.params.uid).update({
        activo: Boolean(activo),
        actualizadoEn: serverTimestamp(),
      });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Perfiles de repartidor de los usuarios de este negocio (solo activos). */
  async function loadOwnRepartidores(db) {
    const uids = [...await getLocalFirebaseUids()];
    if (!uids.length) return [];
    const refs = uids.map((uid) => db.collection('repartidores').doc(uid));
    const snaps = await db.getAll(...refs);
    return snaps
      .filter((snap) => snap.exists && snap.data()?.activo === true)
      .map((snap) => ({ uid: snap.id, ...snap.data() }));
  }

  /**
   * GET /api/delivery/repartidores
   * Lista los repartidores activos de este negocio (para el mapa del admin).
   */
  router.get('/repartidores', async (req, res) => {
    try {
      const db = getFirestore();
      if (!db) return res.status(503).json({ ok: false, error: 'Firebase no disponible' });

      const repartidores = await loadOwnRepartidores(db);
      return res.json({ ok: true, repartidores });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/delivery/ubicaciones/stream
   * Server-Sent Events: transmite en tiempo real las ubicaciones de los
   * repartidores de este negocio (uno escucha por usuario local con Firebase).
   */
  router.get('/ubicaciones/stream', async (req, res) => {
    const db = getFirestore();
    if (!db) {
      res.status(503).json({ ok: false, error: 'Firebase no disponible' });
      return;
    }

    const uids = [...await getLocalFirebaseUids()];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Keep-alive cada 25s para evitar que el proxy corte la conexión
    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);

    const current = new Map();
    const reported = new Set();
    // Primera emisión cuando todos los escuchas respondieron; luego, en cada cambio.
    const emit = () => {
      if (reported.size < uids.length) return;
      res.write(`data: ${JSON.stringify([...current.values()])}\n\n`);
    };

    const unsubscribers = uids.map((uid) => db
      .collection('repartidores')
      .doc(uid)
      .onSnapshot(
        (snap) => {
          reported.add(snap.id);
          const data = snap.exists ? snap.data() : null;
          if (data && data.activo === true) {
            current.set(snap.id, {
              uid: snap.id,
              nombre: data.nombre || '',
              ultimaUbicacion: data.ultimaUbicacion || null,
              pedidoActual: data.pedidoActual || null,
            });
          } else {
            current.delete(snap.id);
          }
          emit();
        },
        (err) => {
          console.error('[delivery/sse] Error en snapshot:', err.message);
          reported.add(uid);
          res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
        },
      ));

    // Sin repartidores propios: lista vacía de inmediato (el mapa no espera).
    if (!uids.length) emit();

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    });
  });

  // ──────────────────────────────────────────────
  // PEDIDOS DELIVERY
  // ──────────────────────────────────────────────

  /**
   * POST /api/delivery/pedidos
   * Crea un pedido de delivery en Firestore (llamado desde el POS al asignar delivery).
   */
  router.post('/pedidos', async (req, res) => {
    try {
      const {
        numeroFactura,
        clienteNombre,
        clienteTelefono,
        clienteDireccion,
        clienteReferencia,
        clienteLocationLink,
        clienteLat,
        clienteLng,
        negocioNombre,
        repartidorId,
        repartidorNombre,
        total,
        productos,
        notasInternas,
      } = req.body;

      if (!numeroFactura || !repartidorId || !clienteNombre) {
        return res.status(400).json({
          ok: false,
          error: 'Faltan campos requeridos: numeroFactura, repartidorId, clienteNombre',
        });
      }

      const tenantId = currentTenantId();
      if (!tenantId) {
        return res.status(409).json({
          ok: false,
          error: 'Este equipo no tiene licencia vinculada; no se puede enviar el pedido a la app de repartidores.',
        });
      }
      const localUids = await getLocalFirebaseUids();
      if (!localUids.has(normalizeOptionalText(repartidorId))) {
        return res.status(403).json({ ok: false, error: 'Ese repartidor no es un usuario de este negocio.' });
      }

      const db = getFirestore();
      if (!db) return res.status(503).json({ ok: false, error: 'Firebase no disponible' });

      const now = serverTimestamp();
      const clienteLatNormalized = normalizeNullableCoordinate(clienteLat);
      const clienteLngNormalized = normalizeNullableCoordinate(clienteLng);
      const pedidoRef = await db.collection('pedidos_delivery').add({
        licenseId: tenantId,
        numeroFactura: normalizeOptionalText(numeroFactura),
        clienteNombre: normalizeOptionalText(clienteNombre),
        clienteTelefono: normalizeOptionalText(clienteTelefono),
        clienteDireccion: normalizeOptionalText(clienteDireccion),
        clienteReferencia: normalizeOptionalText(clienteReferencia),
        clienteLocationLink: normalizeOptionalText(clienteLocationLink),
        clienteLat: clienteLatNormalized,
        clienteLng: clienteLngNormalized,
        negocioNombre: normalizeOptionalText(negocioNombre),
        repartidorId: normalizeOptionalText(repartidorId),
        repartidorNombre: normalizeOptionalText(repartidorNombre),
        estado: 'asignado',
        total: parseFloat(total) || 0,
        productos: productos || [],
        notasInternas: normalizeOptionalText(notasInternas) || null,
        incidencias: [],
        creadoEn: now,
        actualizadoEn: now,
        entregadoEn: null,
      });

      return res.json({ ok: true, pedidoId: pedidoRef.id });
    } catch (err) {
      console.error('[delivery] Error creando pedido:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/delivery/pedidos
   * Lista los pedidos de delivery de este negocio (para el panel admin del POS).
   */
  router.get('/pedidos', async (req, res) => {
    try {
      const { estado, repartidorId, limite } = req.query;
      const db = getFirestore();
      if (!db) return res.status(503).json({ ok: false, error: 'Firebase no disponible' });

      const pedidos = await loadOwnPedidos(db, {
        estado: ESTADOS_PEDIDO.includes(estado) ? estado : '',
        repartidorId: normalizeOptionalText(repartidorId),
        limit: parseLimit(limite, 100),
      });
      return res.json({ ok: true, pedidos });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/delivery/stats
   * Resumen de los pedidos recientes de este negocio para el panel del POS.
   */
  router.get('/stats', async (req, res) => {
    try {
      const db = getFirestore();
      if (!db) return res.status(503).json({ ok: false, error: 'Firebase no disponible' });

      const pedidos = await loadOwnPedidos(db, { limit: MAX_PEDIDOS });
      const stats = {
        asignado: pedidos.filter((p) => p.estado === 'asignado').length,
        en_camino: pedidos.filter((p) => p.estado === 'en_camino').length,
        entregado: pedidos.filter((p) => p.estado === 'entregado').length,
        incidencia: pedidos.filter((p) => p.estado === 'incidencia').length,
      };
      return res.json({ ok: true, stats });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/delivery/pedidos/:id
   * Solo devuelve el pedido si es de este negocio.
   */
  router.get('/pedidos/:id', async (req, res) => {
    try {
      const db = getFirestore();
      if (!db) return res.status(503).json({ ok: false, error: 'Firebase no disponible' });

      const doc = await db.collection('pedidos_delivery').doc(req.params.id).get();
      const pedido = doc.exists ? { id: doc.id, ...doc.data() } : null;
      if (!pedido || !belongsToTenant(pedido, await loadTenantContext())) {
        return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
      }
      return res.json({ ok: true, pedido });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = createDeliveryRouter;

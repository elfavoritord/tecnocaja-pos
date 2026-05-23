/**
 * Rutas de gestión de pedidos de delivery
 * Integración entre Tecno Caja POS y la app de repartidores
 *
 * Firestore collections: pedidos_delivery, repartidores
 */

const express = require('express');

function createDeliveryRouter({ query }) {
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

  function getFirestore() {
    try {
      const { getFirestore: _getFS } = require('../../modules/firebase-admin');
      return _getFS();
    } catch {
      return null;
    }
  }

  function serverTimestamp() {
    try {
      const { FieldValue } = require('firebase-admin/firestore');
      return FieldValue.serverTimestamp();
    } catch {
      return new Date().toISOString();
    }
  }

  // ──────────────────────────────────────────────
  // REPARTIDORES
  // ──────────────────────────────────────────────

  /**
   * POST /api/delivery/repartidores
   * Crea o actualiza un repartidor en Firestore a partir de un usuario POS.
   * Requiere: uid (firebase_uid), nombre, email
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
   * Activa o desactiva un repartidor en Firestore.
   */
  router.patch('/repartidores/:uid/activo', async (req, res) => {
    try {
      const { activo } = req.body;
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

  /**
   * GET /api/delivery/repartidores
   * Lista repartidores activos desde Firestore (para el mapa del admin).
   */
  router.get('/repartidores', async (req, res) => {
    try {
      const db = getFirestore();
      if (!db) return res.status(503).json({ ok: false, error: 'Firebase no disponible' });

      const snap = await db.collection('repartidores').where('activo', '==', true).get();
      const repartidores = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
      return res.json({ ok: true, repartidores });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/delivery/ubicaciones/stream
   * Server-Sent Events: transmite ubicaciones de repartidores en tiempo real.
   * El cliente recibe un evento cada vez que algún repartidor mueve el GPS.
   */
  router.get('/ubicaciones/stream', (req, res) => {
    const db = getFirestore();
    if (!db) {
      res.status(503).json({ ok: false, error: 'Firebase no disponible' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Keep-alive cada 25s para evitar que el proxy corte la conexión
    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);

    const unsubscribe = db
      .collection('repartidores')
      .where('activo', '==', true)
      .onSnapshot(
        (snap) => {
          const repartidores = snap.docs.map((d) => {
            const data = d.data();
            return {
              uid: d.id,
              nombre: data.nombre || '',
              ultimaUbicacion: data.ultimaUbicacion || null,
              pedidoActual: data.pedidoActual || null,
            };
          });
          res.write(`data: ${JSON.stringify(repartidores)}\n\n`);
        },
        (err) => {
          console.error('[delivery/sse] Error en snapshot:', err.message);
          res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
        },
      );

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
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

      const db = getFirestore();
      if (!db) return res.status(503).json({ ok: false, error: 'Firebase no disponible' });

      const now = serverTimestamp();
      const clienteLatNormalized = normalizeNullableCoordinate(clienteLat);
      const clienteLngNormalized = normalizeNullableCoordinate(clienteLng);
      const pedidoRef = await db.collection('pedidos_delivery').add({
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
   * Lista pedidos de delivery (para el panel admin del POS).
   * Evita índices compuestos filtrando en memoria después del orderBy simple.
   */
  router.get('/pedidos', async (req, res) => {
    try {
      const { estado, repartidorId, limite = 100 } = req.query;
      const db = getFirestore();
      if (!db) return res.status(503).json({ ok: false, error: 'Firebase no disponible' });

      const snap = await db
        .collection('pedidos_delivery')
        .orderBy('creadoEn', 'desc')
        .limit(parseInt(limite) || 100)
        .get();

      let pedidos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (estado) pedidos = pedidos.filter((p) => p.estado === estado);
      if (repartidorId) pedidos = pedidos.filter((p) => p.repartidorId === repartidorId);

      return res.json({ ok: true, pedidos });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/delivery/stats
   * Resumen de pedidos del día para el panel del POS.
   */
  router.get('/stats', async (req, res) => {
    try {
      const db = getFirestore();
      if (!db) return res.status(503).json({ ok: false, error: 'Firebase no disponible' });

      const snap = await db
        .collection('pedidos_delivery')
        .orderBy('creadoEn', 'desc')
        .limit(200)
        .get();

      const pedidos = snap.docs.map((d) => d.data());
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
   */
  router.get('/pedidos/:id', async (req, res) => {
    try {
      const db = getFirestore();
      if (!db) return res.status(503).json({ ok: false, error: 'Firebase no disponible' });

      const doc = await db.collection('pedidos_delivery').doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
      return res.json({ ok: true, pedido: { id: doc.id, ...doc.data() } });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = createDeliveryRouter;

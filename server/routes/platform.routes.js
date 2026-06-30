'use strict';

/**
 * platform.routes.js — Endpoints públicos de plataforma
 *
 * GET  /api/platform/contadores/buscar?q=term  — busca en Firestore (Admin) con fallback a MariaDB
 * POST /api/platform/registrar-negocio
 * GET  /api/platform/mi-negocio
 */

const express = require('express');
const crypto  = require('crypto');

// Lazy-load para no romper si Firebase no está configurado
function getFirestoreDb() {
  try {
    const { getFirestore } = require('../../modules/firebase-admin');
    const db = getFirestore();
    return db;
  } catch (e) {
    console.error('[platform] getFirestoreDb ERROR:', e.message);
    return null;
  }
}

// Actualiza contadorId/contadorNombre en el documento Firestore licencias del negocio
async function _syncContadorToFirestore(query, contadorId, contadorNombre) {
  const db = getFirestoreDb();
  if (!db) return;
  const [cfg] = await query('SELECT cloud_business_id FROM config WHERE id=1');
  const bizId = cfg?.cloud_business_id;
  if (!bizId) return;

  const COL_LICENCIAS = process.env.FIREBASE_ADMIN_LICENSES_COLLECTION || 'licencias';

  if (contadorId) {
    // Obtener nombre desde Firestore si no tenemos uno
    let nombre = contadorNombre;
    if (!nombre) {
      try {
        const cDoc = await db.collection('contadores').doc(String(contadorId)).get();
        if (cDoc.exists) nombre = cDoc.data().nombre_firma || '';
      } catch (_) {}
    }
    await db.collection(COL_LICENCIAS).doc(bizId).update({
      contadorId: String(contadorId),
      contadorNombre: nombre || '',
      businessStructureMode: 'accountant_client',
    });
  } else {
    await db.collection(COL_LICENCIAS).doc(bizId).update({
      contadorId: null,
      contadorNombre: null,
      businessStructureMode: 'independent',
    });
  }
}

function createPlatformRouter({ query }) {
  const router = express.Router();

  // ── Buscar contadores ──────────────────────────────────────────────────────
  // Primero busca en Firestore (donde guarda Tecno Caja Admin).
  // Si Firestore no está disponible, cae a MariaDB local.
  router.get('/contadores/buscar', async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json([]);

    // ── Intento Firestore ──────────────────────────────────────────────────
    const db = getFirestoreDb();
    console.log('[platform/contadores/buscar] Firestore disponible:', !!db, '| q:', q);

    if (db) {
      try {
        // Sin filtro de estado: traer todos y filtrar en memoria para evitar índices compuestos
        const snap = await db.collection('contadores').get();
        console.log('[platform/contadores/buscar] Firestore docs totales:', snap.size);

        const results = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(c => (c.estado || '').toLowerCase() !== 'suspendido')  // excluir suspendidos
          .filter(c =>
            (c.nombre_firma || '').toLowerCase().includes(q) ||
            (c.rnc          || '').toLowerCase().includes(q) ||
            (c.correo       || '').toLowerCase().includes(q) ||
            (c.telefono     || '').toLowerCase().includes(q) ||
            (c.responsable  || '').toLowerCase().includes(q)
          )
          .slice(0, 20)
          .map(c => ({
            id:           c.id,
            nombre_firma: c.nombre_firma || '',
            responsable:  c.responsable  || '',
            rnc:          c.rnc          || '',
            telefono:     c.telefono     || '',
            correo:       c.correo       || '',
            logo_url:     c.logo_url     || null,
          }));

        console.log('[platform/contadores/buscar] Resultados filtrados:', results.length);
        return res.json(results);
      } catch (e) {
        console.error('[platform] Firestore buscar contadores ERROR:', e.message);
      }
    }

    // ── Fallback MariaDB ───────────────────────────────────────────────────
    console.log('[platform/contadores/buscar] Usando fallback MariaDB');
    try {
      const like = `%${q}%`;
      const rows = await query(`
        SELECT id, nombre_firma, responsable, rnc, telefono, correo, logo_url
        FROM contadores WHERE estado = 'activo'
          AND (nombre_firma LIKE ? OR rnc LIKE ? OR correo LIKE ? OR telefono LIKE ?)
        LIMIT 20
      `, [like, like, like, like]);
      console.log('[platform/contadores/buscar] MariaDB resultados:', rows.length);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Registrar/actualizar negocio ───────────────────────────────────────────
  router.post('/registrar-negocio', async (req, res) => {
    const { nombre_negocio, rnc, propietario, telefono, correo, contador_id, business_mode, plan } = req.body;
    if (!nombre_negocio) return res.status(400).json({ error: 'nombre_negocio es requerido.' });

    try {
      const isAccountantClient = business_mode === 'accountant_client' && contador_id;
      const trialStart = isAccountantClient ? new Date() : null;
      const trialEnd   = isAccountantClient ? new Date(Date.now() + 30 * 86400000) : null;
      const licStatus  = isAccountantClient ? 'trial' : 'pending';

      const [configRow] = await query('SELECT cloud_business_id FROM config WHERE id=1');
      const existingCloudId = configRow?.cloud_business_id;

      if (existingCloudId) {
        await query(`
          UPDATE cloud_businesses SET nombre_negocio=?, rnc=?, propietario=?, telefono=?, correo=?,
            contador_id=COALESCE(?, contador_id), business_mode=?, last_sync_at=NOW(), updated_at=NOW()
          WHERE cloud_id=?
        `, [nombre_negocio, rnc || null, propietario || null, telefono || null, correo || null,
            contador_id || null, business_mode || 'independent', existingCloudId]);

        if (contador_id) {
          const [cont] = await query('SELECT nombre_firma FROM contadores WHERE id=?', [contador_id]);
          await query('UPDATE config SET business_mode=?, accountant_id=?, accountant_name=? WHERE id=1',
            [business_mode, contador_id, cont?.nombre_firma || null]);
        }

        return res.json({ ok: true, cloudId: existingCloudId, new: false });
      }

      const cloudId = crypto.randomBytes(16).toString('hex');

      const { insertId } = await query(`
        INSERT INTO cloud_businesses
          (cloud_id, nombre_negocio, rnc, propietario, telefono, correo, contador_id, plan, license_status, trial_start_date, trial_end_date, business_mode, last_sync_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [cloudId, nombre_negocio, rnc || null, propietario || null, telefono || null, correo || null,
          isAccountantClient ? contador_id : null,
          plan || 'basico', licStatus, trialStart, trialEnd,
          business_mode || 'independent']);

      if (isAccountantClient) {
        await query(`
          INSERT INTO licencias (cloud_business_id, plan, status, activated_at, activated_by, notes)
          VALUES (?, ?, 'trial', NOW(), 'sistema', 'Prueba automática 30 días — contador asociado')
        `, [insertId, plan || 'basico']);

        // Nombre del contador: buscar en Firestore primero, luego MariaDB
        let contNombre = null;
        const db2 = getFirestoreDb();
        if (db2) {
          try {
            const cDoc = await db2.collection('contadores').doc(String(contador_id)).get();
            if (cDoc.exists) contNombre = cDoc.data().nombre_firma || null;
          } catch {}
        }
        if (!contNombre) {
          const [cont] = await query('SELECT nombre_firma FROM contadores WHERE id=?', [contador_id]).catch(() => [null]);
          contNombre = cont?.nombre_firma || null;
        }

        await query(`
          INSERT INTO solicitudes (cloud_business_id, contador_id, tipo, status, descripcion)
          VALUES (?, ?, 'activar_licencia', 'pendiente', ?)
        `, [insertId, contador_id, `Nuevo negocio bajo contador ${contNombre || ''}: ${nombre_negocio}. Prueba 30 días activa.`]);

        await query('UPDATE config SET business_mode=?, accountant_id=?, accountant_name=?, cloud_business_id=? WHERE id=1',
          [business_mode, contador_id, contNombre, cloudId]);

        // Parchar el doc de Firestore licencias con contadorId/contadorNombre
        const db3 = getFirestoreDb();
        if (db3) {
          const businessKey = `pos:tecno-caja-${(nombre_negocio || '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}`;
          try {
            const licSnap = await db3.collection('licencias').where('businessKey', '==', businessKey).limit(1).get();
            if (!licSnap.empty) {
              await licSnap.docs[0].ref.update({ contadorId: String(contador_id), contadorNombre: contNombre || null });
            }
          } catch (e) { console.warn('[platform] No se pudo parchar licencia Firestore:', e.message); }
        }
      } else {
        await query('UPDATE config SET business_mode=?, cloud_business_id=? WHERE id=1',
          [business_mode || 'independent', cloudId]);
      }

      res.json({ ok: true, cloudId, new: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Contador asignado al negocio actual ───────────────────────────────────
  router.get('/mi-contador', async (req, res) => {
    try {
      const [cfg] = await query('SELECT accountant_id, accountant_name FROM config WHERE id=1');
      if (!cfg?.accountant_id) return res.json({ found: false });

      // Intentar obtener datos completos desde tabla contadores (plataforma)
      let contData = null;
      try {
        const [row] = await query(`
          SELECT c.id, c.nombre_firma, c.responsable, c.telefono, c.whatsapp,
                 c.correo, c.logo_url, c.estado, u.email
          FROM contadores c
          LEFT JOIN users u ON u.id = c.user_id
          WHERE c.id = ?
          LIMIT 1
        `, [cfg.accountant_id]);
        if (row) contData = row;
      } catch (_) { /* tabla puede no existir aún */ }

      if (contData) {
        return res.json({
          found:       true,
          nombre:      contData.nombre_firma || cfg.accountant_name || '',
          responsable: contData.responsable  || '',
          telefono:    contData.telefono     || '',
          whatsapp:    contData.whatsapp     || '',
          email:       contData.email        || contData.correo || '',
          logo_url:    contData.logo_url     || null,
          estado:      contData.estado       || 'activo',
          verified:    true,
        });
      }

      // Fallback: solo nombre guardado en config
      return res.json({
        found:   true,
        nombre:  cfg.accountant_name || '',
        verified: false,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Asignar contador al negocio ───────────────────────────────────────────
  router.post('/asignar-contador', async (req, res) => {
    try {
      const { contador_id, nombre_firma } = req.body || {};
      if (!contador_id) return res.status(400).json({ error: 'contador_id requerido.' });

      // 1. Guardar en config local
      await query(
        'UPDATE config SET accountant_id=?, accountant_name=? WHERE id=1',
        [contador_id, nombre_firma || '']
      );

      // 2. Sincronizar con Firestore licencias (para que el Admin lo vea)
      _syncContadorToFirestore(query, contador_id, nombre_firma || '').catch(() => {});

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Desvincular contador ────────────────────────────────────────────────
  router.post('/desvincular-contador', async (req, res) => {
    try {
      await query('UPDATE config SET accountant_id=NULL, accountant_name=NULL WHERE id=1');

      // Sincronizar con Firestore
      _syncContadorToFirestore(query, null, null).catch(() => {});

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Estado del negocio actual ──────────────────────────────────────────────
  router.get('/mi-negocio', async (req, res) => {
    try {
      const [cfg] = await query('SELECT business_mode, cloud_business_id, accountant_id, accountant_name FROM config WHERE id=1');
      if (!cfg?.cloud_business_id) return res.json({ registrado: false });

      const [biz] = await query(`
        SELECT cb.*, c.nombre_firma AS contador_nombre, c.telefono AS contador_telefono, c.correo AS contador_correo
        FROM cloud_businesses cb
        LEFT JOIN contadores c ON c.id = cb.contador_id
        WHERE cb.cloud_id=?
      `, [cfg.cloud_business_id]);

      res.json({ registrado: true, negocio: biz || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createPlatformRouter;

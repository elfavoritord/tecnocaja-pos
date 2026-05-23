'use strict';

// ─── Definición de planes ────────────────────────────────────────────────────

const PLAN_LEVELS = { basico: 1, pro: 2, plus: 3 };

const PLAN_NAMES = {
  basico: 'Tecno Caja Básico',
  pro:    'Tecno Caja Pro',
  plus:   'Tecno Caja Plus',
};

// Feature → plan mínimo requerido
const PLAN_FEATURE_MAP = {
  // ── Disponibles en todos los planes ──────────────────────────────────────
  ventas:        'basico',
  productos:     'basico',
  inventario:    'basico',
  clientes:      'basico',
  proveedores:   'basico',
  caja:          'basico',
  reportes:      'basico',
  usuarios:      'basico',
  configuracion: 'basico',
  // ── Plan Pro ──────────────────────────────────────────────────────────────
  posmovil:           'pro',
  movimientos:        'pro',
  multicaja:          'pro',
  multiusuario:       'pro',
  delivery:           'pro',
  reportes_avanzados: 'pro',
  auditoria:          'pro',
  // ── Plan Plus ─────────────────────────────────────────────────────────────
  multisucursal:  'plus',
  admin_global:   'plus',
  firebase_admin: 'plus',
};

// business_structure_mode ↔ plan_code
const MODE_TO_PLAN = {
  monocaja:       'basico',
  multicaja:      'pro',
  multisucursal:  'plus',
};
const PLAN_TO_MODE = {
  basico: 'monocaja',
  pro:    'multicaja',
  plus:   'multisucursal',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hasFeature(feature, planCode) {
  const required = PLAN_FEATURE_MAP[feature] || 'basico';
  return (PLAN_LEVELS[planCode || 'basico'] || 1) >= (PLAN_LEVELS[required] || 1);
}

function planForMode(mode) {
  return MODE_TO_PLAN[mode] || 'basico';
}
function modeForPlan(planCode) {
  return PLAN_TO_MODE[planCode] || 'monocaja';
}

// ─── Migración DB ─────────────────────────────────────────────────────────────

async function ensurePlanExtensions(query) {
  const cols = [
    [`plan_code`,       `VARCHAR(20) NOT NULL DEFAULT 'basico'`],
    [`plan_name`,       `VARCHAR(50) NOT NULL DEFAULT 'Tecno Caja Básico'`],
    [`plan_expires_at`, `DATETIME DEFAULT NULL`],
  ];
  for (const [col, def] of cols) {
    await query(`ALTER TABLE config ADD COLUMN ${col} ${def}`).catch(() => {});
  }
  // Sincronizar plan_code con business_structure_mode existente
  await query(`
    UPDATE config
    SET
      plan_code = CASE business_structure_mode
        WHEN 'multisucursal' THEN 'plus'
        WHEN 'multicaja'     THEN 'pro'
        ELSE 'basico'
      END,
      plan_name = CASE business_structure_mode
        WHEN 'multisucursal' THEN 'Tecno Caja Plus'
        WHEN 'multicaja'     THEN 'Tecno Caja Pro'
        ELSE 'Tecno Caja Básico'
      END
    WHERE id = 1
      AND (plan_code IS NULL OR plan_code = 'basico')
  `).catch(() => {});
}

// ─── Sync desde Firestore ────────────────────────────────────────────────────

async function syncLicenseFromFirebase(query) {
  try {
    const { fetchRemotePosLicenseState } = require('./firebase-admin');
    const [configRows, adminRows] = await Promise.all([
      query('SELECT business_name, plan_code, business_structure_mode FROM config WHERE id = 1 LIMIT 1').catch(() => []),
      query(
        `SELECT firebase_uid
         FROM users
         WHERE rol IN ('admin','super_admin','administrador')
           AND firebase_uid IS NOT NULL
           AND firebase_uid != ''
         ORDER BY id ASC
         LIMIT 1`
      ).catch(() => []),
    ]);
    const currentRow  = configRows[0] || {};
    const currentPlan = String(currentRow.plan_code || 'basico').toLowerCase();
    const currentMode = String(currentRow.business_structure_mode || '').toLowerCase();
    const derivedPlan = planForMode(currentMode);
    const localPlan   = (PLAN_LEVELS[currentPlan] || 1) >= (PLAN_LEVELS[derivedPlan] || 1) ? currentPlan : derivedPlan;
    const remote = await fetchRemotePosLicenseState({
      business_name: currentRow.business_name,
      principalFirebaseUid: adminRows[0]?.firebase_uid || null,
    });
    if (!remote) return null;

    const remotePlan  = String(remote.planCode || '').toLowerCase();
    const planCode    = PLAN_LEVELS[remotePlan] ? remotePlan : localPlan;
    const status      = String(remote.status || 'trial').toLowerCase();
    const expiresRaw  = remote.trialEndsAt || null;
    const expiresStr  = expiresRaw ? expiresRaw.toISOString().slice(0, 19).replace('T', ' ') : null;
    const structMode  = modeForPlan(planCode);

    await query(
      `UPDATE config
       SET plan_code = ?, plan_name = ?, plan_expires_at = ?,
           license_status = ?, business_structure_mode = ?
       WHERE id = 1`,
      [planCode, PLAN_NAMES[planCode] || planCode, expiresStr, status, structMode]
    );

    console.log(`[plans] Licencia sincronizada: ${PLAN_NAMES[planCode]} (${status})`);
    return { planCode, status, planExpiresAt: expiresRaw };
  } catch (err) {
    console.warn('[plans] No se pudo sincronizar licencia de Firebase:', err.message);
    return null;
  }
}

// ─── Middleware requirePlan ──────────────────────────────────────────────────
// Uso en server.js:  app.post('/ruta', plans.requirePlan('pro', query), handler)

function requirePlan(minPlanCode, query, resolveLicenseState) {
  return async (req, res, next) => {
    try {
      let current = '';
      let currentStatus = '';

      if (typeof resolveLicenseState === 'function') {
        const resolved = await resolveLicenseState();
        current = String(resolved?.license?.planCode || '').toLowerCase();
        currentStatus = String(resolved?.license?.status || '').toLowerCase();
      }

      if (!current) {
        const rows = await query('SELECT plan_code, business_structure_mode, license_status FROM config WHERE id = 1');
        const stored = String(rows[0]?.plan_code || 'basico').toLowerCase();
        const mode = String(rows[0]?.business_structure_mode || '').toLowerCase();
        const derived = MODE_TO_PLAN[mode] || 'basico';
        currentStatus = String(rows[0]?.license_status || '').toLowerCase();
        current = (PLAN_LEVELS[stored] || 1) >= (PLAN_LEVELS[derived] || 1) ? stored : derived;
      }

      if (currentStatus && !['active', 'trial'].includes(currentStatus)) {
        return res.status(403).json({
          error: 'La licencia actual no permite usar esta función.',
          upgradeRequired: false,
          currentPlan: current || 'basico',
          requiredPlan: minPlanCode,
        });
      }

      if ((PLAN_LEVELS[current] || 1) < (PLAN_LEVELS[minPlanCode] || 1)) {
        return res.status(403).json({
          error: `Esta función requiere ${PLAN_NAMES[minPlanCode] || minPlanCode}. Plan actual: ${PLAN_NAMES[current] || current}.`,
          upgradeRequired: true,
          currentPlan:  current,
          requiredPlan: minPlanCode,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  PLAN_LEVELS,
  PLAN_NAMES,
  PLAN_FEATURE_MAP,
  hasFeature,
  planForMode,
  modeForPlan,
  ensurePlanExtensions,
  syncLicenseFromFirebase,
  requirePlan,
};

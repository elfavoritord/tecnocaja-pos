'use strict';

/**
 * Genera los JSON de ejemplo que publica el Centro de Control (con el negocio
 * de prueba de tests/sync/control-center.fixture.js) dentro de la app de
 * reportes: reporte app/test/fixtures/control_center/*.json.
 *
 * Las pruebas de Flutter leen esos archivos para comprobar que la app entiende
 * exactamente lo que publica el POS. Correr de nuevo si cambia el formato:
 *
 *   node scripts/control-center/export-app-fixtures.js
 */

const fs = require('fs');
const path = require('path');
const snapshotLib = require('../../server/sync/control-center/snapshot');
const { clean } = require('../../server/sync/control-center/publisher');
const { mapSequence } = require('../../server/routes/fiscal-sequences.routes');
const { NOW, createDb } = require('../../tests/sync/control-center.fixture');

const OUT_DIR = path.join(__dirname, '..', '..', 'reporte app', 'test', 'fixtures', 'control_center');

// Firestore guarda las fechas como Timestamp; en el JSON van como texto ISO
// (la app acepta ambos).
function toJson(value) {
  return JSON.parse(JSON.stringify(clean(value), (key, v) => (v instanceof Date ? v.toISOString() : v)));
}

async function main() {
  const { db, query } = await createDb();
  try {
    const snapshot = await snapshotLib.collectSnapshot({
      query,
      now: NOW,
      full: true,
      mapSequence,
      syncInfo: {
        generatedAt: NOW,
        generatedAtText: '2026-10-05 14:30:00',
        generatedBy: { serverId: 'srv_demo', hostname: 'PC-PRINCIPAL', role: 'principal', appVersion: '1.4.3' },
        internet: { online: true, lastCheckAt: NOW.toISOString() },
        cloud: { ready: true, lastSyncAt: NOW.toISOString(), pending: 0, errors: 0, lastError: null },
        pendingEcf: 0,
      },
    });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const write = (name, data) => {
      fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), `${JSON.stringify(toJson({ ...data, generatedAt: NOW }), null, 2)}\n`);
    };
    const all = snapshotLib.buildScopeDocuments(snapshot, null);
    for (const [kind, data] of Object.entries(all)) write(kind, data);
    const norte = snapshotLib.buildScopeDocuments(snapshot, '2');
    write('summary_b2', norte.summary);
    write('catalog_p0_b2', norte.catalog_p0);
    for (const doc of snapshotLib.buildDayDocuments(snapshot, ['2026-10-04', '2026-10-05'], null)) {
      write(`day_${doc.id}`, doc.data);
    }
    console.log(`Fixtures escritos en ${OUT_DIR}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

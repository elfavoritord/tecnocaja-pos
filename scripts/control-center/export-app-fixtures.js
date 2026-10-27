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
const { mapSequence, mapEcfSequenceReadOnly } = require('../../server/routes/fiscal-sequences.routes');
const { versionDe } = require('../../server/sync/control-center/fotos');

// PNG de 1×1 para la foto de ejemplo (la app solo necesita poder leerla).
const FOTO_EJEMPLO = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const { NOW, createDb, createServiceDb } = require('../../tests/sync/control-center.fixture');

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
      mapEcfSequence: mapEcfSequenceReadOnly,
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
    // Lo que hace control-center/fotos.js al publicar: la foto de Arroz.
    const [conFoto] = await query("SELECT id, image_local FROM products WHERE image_local IS NOT NULL AND image_local <> ''");
    const arroz = snapshot.products.find((p) => String(p.id) === String(conFoto.id));
    arroz.photo = versionDe(conFoto.image_local);
    write('foto_1', { kind: 'productPhoto', productId: String(arroz.id), mime: 'image/png', data: FOTO_EJEMPLO, version: arroz.photo, branchIds: ['1', '2'] });
    const all = snapshotLib.buildScopeDocuments(snapshot, null);
    for (const [kind, data] of Object.entries(all)) write(kind, data);
    const norte = snapshotLib.buildScopeDocuments(snapshot, '2');
    write('summary_b2', norte.summary);
    write('catalog_p0_b2', norte.catalog_p0);
    for (const doc of snapshotLib.buildDayDocuments(snapshot, ['2026-10-04', '2026-10-05'], null)) {
      write(`day_${doc.id}`, doc.data);
    }

    // Empresa de servicios (Tecnología): lo que cambia en la app.
    const servicios = await createServiceDb();
    try {
      const snap = await snapshotLib.collectSnapshot({ query: servicios.query, now: NOW, full: true, syncInfo: snapshot.syncInfo });
      const docs = snapshotLib.buildScopeDocuments(snap, null);
      for (const kind of ['summary', 'sales', 'services', 'customers', 'fiscal']) write(`${kind}_servicios`, docs[kind]);
    } finally {
      servicios.db.close();
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

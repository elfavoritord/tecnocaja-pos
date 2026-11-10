'use strict';
/**
 * Respaldos en la nube sin llave en la PC, de punta a punta contra Backblaze real
 * (carpeta backups/pos_lab_intermediario_*), con la Sync API corriendo aquí mismo
 * (Firestore en memoria). No toca la base del POS ni la DGII.
 *
 *   node scripts/probar-nube-intermediario.js
 *
 * 1. La PC (licencia + equipo registrado) sube su respaldo cifrado con su clave
 *    propia, lo lista, lo comprueba y deja la clave guardada en el servicio.
 * 2. Se «formatea»: sin licencia, sin clave y sin llave en app.env.
 * 3. El dueño entra con su cuenta: ve el respaldo, lo baja y lo abre con la clave
 *    guardada. La PC formateada con su licencia recupera también la clave.
 * 4. Otra licencia no ve nada de este negocio. Al final se borra lo subido.
 */
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(REPO, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));

const LIC = `pos_lab_intermediario_${Date.now()}`;
const OTRA = 'pos_lab_otro_negocio';
const resultados = [];
const ok = (nombre, cond, detalle = '') => { resultados.push({ nombre, ok: Boolean(cond) }); console.log(`${cond ? 'OK   ' : 'FALLA'} ${nombre}${detalle ? ` — ${detalle}` : ''}`); };

function firestoreFalso(datos) {
  const cols = new Map(Object.entries(datos).map(([c, d]) => [c, new Map(Object.entries(d))]));
  const col = (n) => { if (!cols.has(n)) cols.set(n, new Map()); return cols.get(n); };
  const snap = (n, id) => ({ id, exists: col(n).has(id), data: () => col(n).get(id) });
  const ref = (n, id) => ({ get: async () => snap(n, id), set: async (d, o = {}) => { col(n).set(id, o.merge ? { ...(col(n).get(id) || {}), ...d } : d); } });
  return {
    _col: col,
    collection: (n) => ({
      doc: (id) => ref(n, id),
      where: (campo, _op, v) => ({ limit: () => ({ get: async () => ({ docs: [...col(n).entries()].filter(([, d]) => d[campo] === v).map(([id]) => snap(n, id)) }) }) }),
    }),
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => { r.set(d, o); } }),
  };
}

(async () => {
  // La Sync API con la llave real del bucket (la que tendrá Cloud Run) y su secreto.
  const { createApp } = require(path.join(REPO, 'cloud/sync-api/lib/app'));
  const { crearAlmacenB2 } = require(path.join(REPO, 'cloud/sync-api/lib/almacen-b2'));
  const almacen = crearAlmacenB2(env);
  const deviceId = require(path.join(REPO, 'server/security/machine-identity')).getDeviceDescriptor().deviceId;
  const db = firestoreFalso({
    licencias: {
      [LIC]: { businessName: 'Lab Intermediario', ownerEmail: 'dueno@lab.do', devices: { [deviceId]: { status: 'active' } } },
      [OTRA]: { businessName: 'Otro', ownerEmail: 'otro@lab.do', devices: { dev_otro: { status: 'active' } } },
    },
  });
  const app = createApp({
    db, almacen, secretoRespaldos: crypto.randomBytes(32).toString('hex'),
    verificarIdToken: async (t) => {
      if (t === 'token-dueno') return { email: 'dueno@lab.do', auth_time: Date.now() / 1000 - 30 };
      if (t === 'token-otro') return { email: 'otro@lab.do', auth_time: Date.now() / 1000 - 30 };
      throw new Error('token inválido');
    },
  });
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const subidos = [];

  try {
    // El POS: sin llave de Backblaze en app.env, con licencia y su clave propia.
    for (const k of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_ENDPOINT', 'R2_BUCKET']) delete process.env[k];
    process.env.TECNO_CAJA_SYNC_URL = `http://127.0.0.1:${servidor.address().port}`;
    process.env.TECNO_CAJA_LICENSE_UID = LIC;
    process.env.TECNO_CAJA_SECURITY_PASSWORD = 'clave-propia-del-lab-2026';
    const r2 = require(path.join(REPO, 'server/services/r2-storage'));
    const nube = require(path.join(REPO, 'server/services/nube-intermediario'));
    const { createTcbakBuffer, parseTcbakBufferCon } = require(path.join(REPO, 'server/services/backup-format'));

    ok('Sin llave en la PC: usa el servicio de Tecno Caja', r2.modo() === 'tecnocaja' && r2.isConfigured(), r2.modo());
    ok('La nube responde para su carpeta', await r2.isR2Available(true, r2.backupPrefix(LIC)).catch(() => false));

    const payload = { formatVersion: '2', exportedAt: new Date().toISOString(), businessName: 'Lab Intermediario', businessId: LIC, stats: { ventas: 3 }, data: { sales: [{ id: 1 }, { id: 2 }, { id: 3 }] } };
    const archivo = await createTcbakBuffer(payload, process.env.TECNO_CAJA_SECURITY_PASSWORD);
    const key = r2.backupKey(LIC, `TecnoCaja_Diario_Lab_${Date.now()}.tcbak`);
    const subida = await r2.upload(key, archivo, { businessId: LIC });
    subidos.push(key);
    ok('Sube el respaldo y la nube confirma tamaño y huella', subida.sha256 === crypto.createHash('sha256').update(archivo).digest('hex'));
    const lista = await r2.listObjects(r2.backupPrefix(LIC));
    ok('Lo lista con el formato de siempre (Key, Size, LastModified)', lista.some((o) => o.Key === key && o.Size === archivo.length && o.LastModified instanceof Date));

    const guardar = await nube.sincronizarClave({ persistEnv: () => { throw new Error('no debía escribir'); } });
    ok('Su clave propia queda guardada en el servicio (cifrada)', guardar.guardada === true
      && !JSON.stringify(db._col('respaldos_claves').get(LIC)).includes('clave-propia-del-lab-2026'));

    // Otra licencia no ve nada de este negocio (en una PC que no es la de este negocio).
    nube._reiniciar();
    process.env.TECNO_CAJA_LICENSE_UID = OTRA;
    await nube.entrarComoDueno('token-otro');
    let ajeno = null;
    try { await r2.listObjects(r2.backupPrefix(LIC)); } catch (e) { ajeno = e; }
    ok('Otro dueño no puede listar este negocio', ajeno && /no es de esta PC|no es tuyo|OTRO_NEGOCIO/.test(`${ajeno.message} ${ajeno.code}`), ajeno?.message);
    let ajenaBaja = null;
    try { await r2.download(key); } catch (e) { ajenaBaja = e; }
    ok('Otro dueño no puede bajar el respaldo', Boolean(ajenaBaja));

    // «Formateo»: sin licencia, sin clave propia, sin llave.
    nube._reiniciar();
    delete process.env.TECNO_CAJA_LICENSE_UID;
    delete process.env.TECNO_CAJA_SECURITY_PASSWORD;
    ok('PC formateada sin cuenta: no tiene nube', r2.modo() === 'ninguno');
    await r2.entrarComoDueno('token-dueno');
    ok('Con la cuenta del dueño, la PC formateada ve la nube', r2.modo() === 'tecnocaja');
    const delDueno = await r2.listObjects(r2.backupPrefix(LIC));
    ok('El dueño ve el respaldo de su negocio', delDueno.some((o) => o.Key === key));
    const bajado = await r2.download(key);
    ok('Lo baja igualito', Buffer.compare(bajado, archivo) === 0);
    const claveGuardada = await nube.clave(LIC);
    const abierto = await parseTcbakBufferCon(bajado, ['', claveGuardada.clave, 'Seguridad2026']);
    ok('Lo abre con la clave guardada del negocio', abierto.payload.data.sales.length === 3 && abierto.claveUsada === 'clave-propia-del-lab-2026');
    let subirComoDueno = null;
    try { await r2.upload(r2.backupKey(LIC, 'intruso.tcbak'), Buffer.from('x')); } catch (e) { subirComoDueno = e; }
    ok('El dueño no sube ni pisa respaldos desde otra PC', Boolean(subirComoDueno));

    // Ya restaurada con su licencia: la PC recupera su clave sola.
    nube._reiniciar();
    process.env.TECNO_CAJA_LICENSE_UID = LIC;
    let escrito = null;
    const recuperar = await nube.sincronizarClave({ persistEnv: (v) => { escrito = v; } });
    ok('La PC restaurada recupera su clave de respaldos', recuperar.recuperada === true && escrito?.TECNO_CAJA_SECURITY_PASSWORD === 'clave-propia-del-lab-2026');

    await r2.remove(key);
    subidos.length = 0;
    ok('Borra su respaldo viejo (retención)', !(await r2.listObjects(r2.backupPrefix(LIC))).some((o) => o.Key === key));
  } catch (error) {
    ok('Sin errores inesperados', false, error.stack || error.message);
  } finally {
    for (const k of subidos) await almacen.borrar(k).catch(() => {});
    servidor.close();
  }
  const fallas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - fallas.length}/${resultados.length} comprobaciones OK`);
  process.exit(fallas.length ? 1 : 0);
})();

'use strict';

/**
 * Prueba las reglas de Firestore del Centro de Control (firestore.rules)
 * contra el EMULADOR local de Firestore. No toca el proyecto real.
 *
 * Uso (con Java 17 basta la versión 1.18.2 del emulador):
 *   java -jar cloud-firestore-emulator-v1.18.2.jar --host=127.0.0.1 --port=8089
 *   set FIRESTORE_EMULATOR_HOST=127.0.0.1:8089
 *   node scripts/control-center/check-firestore-rules.js
 * O con Java 21+: firebase emulators:exec --only firestore --project demo-tc "node scripts/control-center/check-firestore-rules.js"
 */
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = 'demo-tc';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function token(uid) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, user_id: uid,
    iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: 'password', identities: {} },
  })}.`;
}
function value(v) {
  if (v === null) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)])) } };
  return { stringValue: String(v) };
}
async function req(method, path, auth, body) {
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers: auth ? { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify({ fields: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, value(v)])) }) : undefined,
  });
  return res.status;
}
const seed = (path, data) => req('PATCH', path, 'owner', data);

async function loadRules() {
  const content = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'firestore.rules'), 'utf8');
  const res = await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Reglas rechazadas por el emulador (${res.status}): ${text}`);
  console.log('Reglas cargadas en el emulador');
}

async function main() {
  await loadRules();
  await seed('users/uOwner', { role: 'admin', businessId: 'b1', businessIds: ['b1'], branchIds: [] });
  await seed('users/uBranch', { role: 'branch_admin', businessId: 'b1', businessIds: ['b1'], branchIds: ['2'] });
  await seed('users/uSup', { role: 'supervisor', businessId: 'b1', businessIds: ['b1'], branchIds: ['2'] });
  await seed('users/uOther', { role: 'admin', businessId: 'b2', businessIds: ['b2'], branchIds: [] });
  await seed('users/uSingle', { role: 'branch_admin', businessId: 'b3', businessIds: ['b3'], branchIds: ['7'] });
  await seed('businesses/b1/controlCenter/summary', { scope: 'all', branchIds: ['1', '2'] });
  await seed('businesses/b1/controlCenter/summary_b1', { scope: 'branch', branchIds: ['1'] });
  await seed('businesses/b1/controlCenter/summary_b2', { scope: 'branch', branchIds: ['2'] });
  await seed('businesses/b1/controlCenter/meta', { backfill: { version: 1 } });
  await seed('businesses/b1/dailyStats/2026-10-05', { scope: 'all', branchIds: ['1', '2'] });
  await seed('businesses/b1/dailyStats/2026-10-05_b2', { scope: 'branch', branchIds: ['2'] });
  await seed('businesses/b1/terminals/srv1', { role: 'principal' });
  await seed('businesses/b3/controlCenter/summary', { scope: 'all', branchIds: ['7'] });

  const cases = [
    ['dueño lee el resumen general', 'GET', 'businesses/b1/controlCenter/summary', 'uOwner', 200],
    ['dueño lee resumen de sucursal', 'GET', 'businesses/b1/controlCenter/summary_b1', 'uOwner', 200],
    ['dueño lee meta', 'GET', 'businesses/b1/controlCenter/meta', 'uOwner', 200],
    ['dueño lee un día', 'GET', 'businesses/b1/dailyStats/2026-10-05', 'uOwner', 200],
    ['dueño pide un día sin documento', 'GET', 'businesses/b1/dailyStats/2026-01-01', 'uOwner', 404],
    ['dueño lista días', 'GET', 'businesses/b1/dailyStats', 'uOwner', 200],
    ['dueño lista equipos', 'GET', 'businesses/b1/terminals', 'uOwner', 200],
    ['dueño NO escribe', 'PATCH', 'businesses/b1/controlCenter/summary', 'uOwner', 403],
    ['admin sucursal NO lee el general', 'GET', 'businesses/b1/controlCenter/summary', 'uBranch', 403],
    ['admin sucursal lee la suya', 'GET', 'businesses/b1/controlCenter/summary_b2', 'uBranch', 200],
    ['admin sucursal NO lee otra sucursal', 'GET', 'businesses/b1/controlCenter/summary_b1', 'uBranch', 403],
    ['admin sucursal NO lee meta', 'GET', 'businesses/b1/controlCenter/meta', 'uBranch', 403],
    ['admin sucursal NO lee el día general', 'GET', 'businesses/b1/dailyStats/2026-10-05', 'uBranch', 403],
    ['admin sucursal lee su día', 'GET', 'businesses/b1/dailyStats/2026-10-05_b2', 'uBranch', 200],
    ['admin sucursal: día sin documento', 'GET', 'businesses/b1/dailyStats/2026-01-01_b2', 'uBranch', 404],
    ['admin sucursal NO lista días', 'GET', 'businesses/b1/dailyStats', 'uBranch', 403],
    ['admin sucursal lista equipos', 'GET', 'businesses/b1/terminals', 'uBranch', 200],
    ['negocio de 1 sucursal: su admin lee el general', 'GET', 'businesses/b3/controlCenter/summary', 'uSingle', 200],
    ['supervisor NO lee', 'GET', 'businesses/b1/controlCenter/summary_b2', 'uSup', 403],
    ['supervisor NO ve equipos', 'GET', 'businesses/b1/terminals', 'uSup', 403],
    ['admin de OTRO negocio NO lee', 'GET', 'businesses/b1/controlCenter/summary', 'uOther', 403],
    ['admin de OTRO negocio NO lee días', 'GET', 'businesses/b1/dailyStats/2026-10-05', 'uOther', 403],
    ['sin sesión NO lee', 'GET', 'businesses/b1/controlCenter/summary', null, 403],
  ];
  let failed = 0;
  for (const [name, method, path, uid, expected] of cases) {
    const auth = uid ? token(uid) : null;
    const body = method === 'PATCH' ? { scope: 'hack' } : undefined;
    let status = await req(method, path, auth, body);
    if (!uid && status === 401) status = 403;
    const ok = status === expected;
    if (!ok) failed += 1;
    console.log(`${ok ? 'OK  ' : 'FALLA'} ${name} — esperado ${expected}, obtuvo ${status}`);
  }
  console.log(failed ? `\n${failed} caso(s) fallaron` : `\n${cases.length}/${cases.length} casos OK`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

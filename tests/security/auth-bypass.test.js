'use strict';

/**
 * tests/security/auth-bypass.test.js
 *
 * Fase 2 — C1: hasta esta corrección, cualquier petición sin Bearer token
 * que incluyera `actorUserId=<id>` en el body/query quedaba autenticada
 * como ese usuario (con su rol y permisos completos) — sin clave, sin token.
 * server.js es un monolito con efectos secundarios de arranque pesados
 * (MariaDB, Firebase, WhatsApp Web, Socket.IO) que no se puede instanciar
 * de forma aislada en un test; el resto de la suite de este repo (ver
 * tests/quick-sale.test.js) ya verifica invariantes de server.js leyendo su
 * código fuente en vez de levantarlo — este test sigue esa misma convención
 * para el middleware de autenticación y sus guardas.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');

describe('C1 — actorUserId ya no autentica', () => {
  test('el middleware global ya no acepta actorUserId sin token por defecto', () => {
    // El fallback viejo solo puede activarse ahora con el interruptor de
    // emergencia explícito, nunca por defecto.
    expect(serverSrc).toContain('LEGACY_ACTOR_FALLBACK_ENABLED');
    expect(serverSrc).toContain("process.env.TECNO_CAJA_LEGACY_ACTOR_FALLBACK");
    // La rama "sin token" del middleware global debe intentar primero el
    // canal firmado interno, y solo caer al fallback viejo bajo el flag.
    const middlewareBlock = serverSrc.slice(
      serverSrc.indexOf('app.use(async (req, _res, next) => {'),
      serverSrc.indexOf('app.use(async (req, _res, next) => {') + 2000
    );
    expect(middlewareBlock).toContain('verifyInternalRequest(req)');
    expect(middlewareBlock).toContain('req.isInternalSystemCall = true');
    expect(middlewareBlock).toContain('else if (LEGACY_ACTOR_FALLBACK_ENABLED)');
  });

  test('resolveRequestActorUser ya no resuelve identidad desde actorUserId por defecto', () => {
    const fnStart = serverSrc.indexOf('async function resolveRequestActorUser(req, options = {}) {');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = serverSrc.slice(fnStart, fnStart + 900);
    expect(fnBody).toContain('if (LEGACY_ACTOR_FALLBACK_ENABLED) {');
    // La llamada a getRequestActorFallbackId debe quedar DENTRO del if del
    // interruptor de emergencia, no accesible por defecto.
    const legacyBlockStart = fnBody.indexOf('if (LEGACY_ACTOR_FALLBACK_ENABLED) {');
    const beforeLegacyBlock = fnBody.slice(0, legacyBlockStart);
    expect(beforeLegacyBlock).not.toContain('getRequestActorFallbackId');
  });

  test('getActor() no confía en actorUserName/actorUserRole del body salvo llamada interna firmada', () => {
    const fnStart = serverSrc.indexOf('function getActor(req) {');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = serverSrc.slice(fnStart, fnStart + 1100);
    expect(fnBody).toContain('req.isInternalSystemCall || LEGACY_ACTOR_FALLBACK_ENABLED');
    expect(fnBody).toContain("return { userId: null, userName: 'Sistema', userRole: 'Sistema' };");
  });

  test('los endpoints que antes no tenían NINGÚN control de acceso ahora exigen sesión o llamada interna', () => {
    expect(serverSrc).toContain('function requireUserOrInternal(req) {');
    expect(serverSrc).toMatch(/app\.post\('\/api\/backup\/auto-save', async \(req, res\) => \{\s*requireUserOrInternal\(req\);/);
    expect(serverSrc).toMatch(/app\.post\('\/api\/security-password\/verify', loginLimiter, async \(req, res\) => \{\s*requireUserOrInternal\(req\);/);

    const respaldosSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'respaldos.routes.js'), 'utf8');
    expect(respaldosSrc).toContain("if (!req.authUser && !req.isInternalSystemCall)");
  });

  test('ensureAdministrator/ensureNotCashier siguen leyendo SOLO req.authUser (nunca el body directamente)', () => {
    const adminFnStart = serverSrc.indexOf('function ensureAdministrator(req) {');
    const cashierFnStart = serverSrc.indexOf('function ensureNotCashier(req) {');
    expect(adminFnStart).toBeGreaterThan(-1);
    expect(cashierFnStart).toBeGreaterThan(-1);
    const adminFnBody = serverSrc.slice(adminFnStart, adminFnStart + 200);
    const cashierFnBody = serverSrc.slice(cashierFnStart, cashierFnStart + 200);
    expect(adminFnBody).not.toContain('req.body');
    expect(cashierFnBody).not.toContain('req.body');
    expect(adminFnBody).toContain('getRequestRoleCode(req)');
  });
});

describe('C1 — electron/main.js usa el canal firmado interno + token real cuando hay sesión', () => {
  test('postJson adjunta la firma interna y, si hay authToken, el Bearer real', () => {
    const fnStart = mainSrc.indexOf("function postJson(url, payload, method = 'POST', options = {}) {");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = mainSrc.slice(fnStart, fnStart + 700);
    expect(fnBody).toContain('...buildInternalHeaders()');
    expect(fnBody).toContain('headers.Authorization = `Bearer ${options.authToken}`');
  });

  test('las 4 llamadas internas ya no mandan actorUserId como única credencial', () => {
    expect(mainSrc).toContain('async function getRendererAuthToken()');
    expect(mainSrc).toContain('window.getTecnoCajaAuthToken');
    expect(mainSrc).toMatch(/createAutoBackup\(actor = \{\}\) \{[\s\S]{0,400}getRendererAuthToken\(\)/);
    expect(mainSrc).toMatch(/verifySecurityPassword\(password\) \{[\s\S]{0,200}getRendererAuthToken\(\)/);
    expect(mainSrc).toMatch(/updateWhatsAppPasteGuideEnabled\(enabled, actor = \{\}\) \{[\s\S]{0,200}getRendererAuthToken\(\)/);
  });
});

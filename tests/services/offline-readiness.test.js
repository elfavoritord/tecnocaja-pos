'use strict';
const createRouter = require('../../server/routes/offline-readiness.routes');
function endpoint(deps) { return createRouter(deps).stack.find((r) => r.route).route.stack[0].handle; }
function response() { return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } }; }
test('diagnostica Google sin contraseña y autorización pendiente sin consultar la nube', async () => {
  const resolveState = jest.fn(async () => ({ source: 'blocked', license: { canEnter: false, blockedCode: 'activation_required', message: 'Validar equipo.' } }));
  const handle = endpoint({ resolveRequestActorUser: async () => ({ id: 1 }), query: async () => [{ password: '', password_hash: null }], licenseService: { resolveState }, internetMonitor: { getStatus: () => ({ online: false }) } });
  const res = response(); await handle({}, res);
  expect(resolveState).toHaveBeenCalledWith({ allowRemote: false });
  expect(res.body.ready).toBe(false);
  expect(res.body.actions).toHaveLength(2);
  expect(res.body.blockedCode).toBe('activation_required');
  expect(res.body.password_hash).toBeUndefined();
});
test('la contraseña y la licencia locales permiten entrar aunque no haya internet', async () => {
  const handle = endpoint({ resolveRequestActorUser: async () => ({ id: 1 }), query: async () => [{ password_hash: 'hash-fixture' }], licenseService: { resolveState: async () => ({ source: 'cache', license: { canEnter: true } }) }, internetMonitor: { getStatus: () => ({ online: false }) } });
  const res = response(); await handle({}, res);
  expect(res.body.ready).toBe(true); expect(res.body.internet).toBe(false);
});
test('exige sesión para mostrar el diagnóstico de la cuenta', async () => {
  const handle = endpoint({ resolveRequestActorUser: async () => { throw Object.assign(new Error('Inicia sesión'), { statusCode: 401 }); } });
  const res = response(); await handle({}, res);
  expect(res.statusCode).toBe(401);
});

'use strict';

/**
 * Restaurar o reinstalar desde la pantalla de inicio encima de un negocio ya
 * configurado ("Reinstalar una app existente"):
 *  - server/security/autorizacion-reemplazo.js (permiso temporal firmado)
 *  - server/routes/setup-reemplazo.routes.js (POST /api/setup/autorizar-reemplazo)
 *  - server/routes/respaldos.routes.js → setupOnly (exige el permiso si ya hay negocio)
 */

const {
  emitirAutorizacionReemplazo,
  verificarAutorizacionReemplazo,
  leerAutorizacionReemplazo,
  DURACION_MS
} = require('../server/security/autorizacion-reemplazo');
const createSetupReemplazoRouter = require('../server/routes/setup-reemplazo.routes');
const createRespaldosRouter = require('../server/routes/respaldos.routes');

function appFalsa() {
  const rutas = {};
  const registrar = (metodo) => (ruta, ...handlers) => { rutas[`${metodo} ${ruta}`] = handlers; };
  return {
    rutas,
    locals: { backupPendingUploadTimer: true }, // que no arranque el temporizador real
    post: registrar('POST'),
    get: registrar('GET'),
    put: registrar('PUT'),
    delete: registrar('DELETE'),
    use() {}
  };
}

function resFalsa() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function ejecutar(handlers, req) {
  const res = resFalsa();
  let i = 0;
  const siguiente = async () => {
    const h = handlers[i++];
    if (h) await h(req, res, siguiente);
  };
  await siguiente();
  return res;
}

describe('autorizacion-reemplazo', () => {
  test('un permiso recién emitido es válido', () => {
    expect(verificarAutorizacionReemplazo(emitirAutorizacionReemplazo())).toBe(true);
  });

  test('vence a los 20 minutos', () => {
    const ahora = Date.now();
    const token = emitirAutorizacionReemplazo(ahora);
    expect(verificarAutorizacionReemplazo(token, ahora + DURACION_MS - 1000)).toBe(true);
    expect(verificarAutorizacionReemplazo(token, ahora + DURACION_MS + 1000)).toBe(false);
  });

  test('un permiso alterado o inventado no vale', () => {
    const [datos, firma] = emitirAutorizacionReemplazo().split('.');
    const otrosDatos = Buffer.from(JSON.stringify({ exp: Date.now() + 9e9 })).toString('base64url');
    expect(verificarAutorizacionReemplazo(`${otrosDatos}.${firma}`)).toBe(false);
    expect(verificarAutorizacionReemplazo(`${datos}.x${firma.slice(1)}`)).toBe(false);
    expect(verificarAutorizacionReemplazo('')).toBe(false);
    expect(verificarAutorizacionReemplazo('basura')).toBe(false);
  });

  test('se lee de la cabecera o del cuerpo', () => {
    expect(leerAutorizacionReemplazo({ headers: { 'x-tc-reemplazo': 'a' } })).toBe('a');
    expect(leerAutorizacionReemplazo({ headers: {}, body: { reemplazoToken: 'b' } })).toBe('b');
    expect(leerAutorizacionReemplazo({ headers: {} })).toBe('');
  });
});

describe('POST /api/setup/autorizar-reemplazo', () => {
  const usuarios = {
    emilio: { id: 1, usuario: 'emilio', nombre: 'Emilio', password: 'clave-admin', role_code: 'administrador_general' },
    ana: { id: 2, usuario: 'ana', nombre: 'Ana', password: 'clave-cajera', role_code: 'cajero' }
  };
  const auditoria = [];
  const app = appFalsa();
  createSetupReemplazoRouter({
    app,
    query: async (_sql, [usuario]) => (usuarios[usuario] ? [usuarios[usuario]] : []),
    getSecurityPassword: async () => 'clave-seguridad',
    ensureUserExtensions: async () => {},
    userPasswordMatches: (user, password) => user.password === password,
    isGlobalAdministratorUser: (user) => user.role_code === 'administrador_general',
    writeAuditLog: async (entrada) => { auditoria.push(entrada); }
  });
  const handlers = app.rutas['POST /api/setup/autorizar-reemplazo'];

  test('con la clave de seguridad devuelve un permiso válido', async () => {
    const res = await ejecutar(handlers, { body: { claveSeguridad: 'clave-seguridad' } });
    expect(res.statusCode).toBe(200);
    expect(verificarAutorizacionReemplazo(res.body.token)).toBe(true);
    expect(res.body.expiraEnMinutos).toBe(20);
  });

  test('con un administrador general devuelve un permiso válido y queda en auditoría', async () => {
    const res = await ejecutar(handlers, { body: { usuario: 'emilio', password: 'clave-admin' } });
    expect(res.statusCode).toBe(200);
    expect(verificarAutorizacionReemplazo(res.body.token)).toBe(true);
    expect(auditoria.at(-1)).toMatchObject({ userId: 1, actionName: 'Autorización para reemplazar el negocio' });
  });

  test.each([
    [{ claveSeguridad: 'otra' }, 403],
    [{ usuario: 'emilio', password: 'mala' }, 401],
    [{ usuario: 'nadie', password: 'x' }, 401],
    [{ usuario: 'ana', password: 'clave-cajera' }, 403],
    [{}, 400]
  ])('%j → %i sin permiso', async (body, codigo) => {
    const res = await ejecutar(handlers, { body });
    expect(res.statusCode).toBe(codigo);
    expect(res.body.token).toBeUndefined();
  });
});

describe('setupOnly en /api/respaldos/setup/*', () => {
  function rutasDeRespaldo({ setupCompleted, usuarios }) {
    const app = appFalsa();
    createRespaldosRouter({
      app,
      query: async (sql) => {
        if (/setup_completed/i.test(sql)) return [{ setup_completed: setupCompleted }];
        if (/COUNT\(\*\) AS total FROM users/i.test(sql)) return [{ total: usuarios }];
        return [];
      },
      getActor: () => ({}),
      writeAuditLog: async () => {},
      ensureAdministrator: () => {},
      isGlobalAdministratorUser: () => true,
      resolveRequestActorUser: async () => ({})
    });
    return app.rutas;
  }

  // Solo el middleware: el handler real se reemplaza para no tocar la nube.
  async function probarSetupOnly(rutas, req) {
    const [setupOnly] = rutas['POST /api/respaldos/setup/cloud/auth'];
    let paso = false;
    const res = await ejecutar([setupOnly, () => { paso = true; }], req);
    return { paso, res };
  }

  test('instalación nueva: deja pasar sin permiso', async () => {
    const { paso } = await probarSetupOnly(rutasDeRespaldo({ setupCompleted: 0, usuarios: 0 }), { headers: {}, body: {} });
    expect(paso).toBe(true);
  });

  test('negocio configurado sin permiso: lo bloquea y explica cómo seguir', async () => {
    const { paso, res } = await probarSetupOnly(rutasDeRespaldo({ setupCompleted: 1, usuarios: 3 }), { headers: {}, body: {} });
    expect(paso).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('REEMPLAZO_NO_AUTORIZADO');
    expect(res.body.error).toContain('Reinstalar una app existente');
  });

  test('negocio configurado con permiso: deja pasar y marca el reemplazo', async () => {
    const req = { headers: { 'x-tc-reemplazo': emitirAutorizacionReemplazo() }, body: {} };
    const { paso } = await probarSetupOnly(rutasDeRespaldo({ setupCompleted: 1, usuarios: 3 }), req);
    expect(paso).toBe(true);
    expect(req.reemplazaNegocio).toBe(true);
  });

  test('un permiso vencido no sirve', async () => {
    const req = { headers: { 'x-tc-reemplazo': emitirAutorizacionReemplazo(Date.now() - DURACION_MS - 1000) }, body: {} };
    const { paso, res } = await probarSetupOnly(rutasDeRespaldo({ setupCompleted: 1, usuarios: 3 }), req);
    expect(paso).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

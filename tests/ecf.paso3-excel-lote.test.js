'use strict';
// Paso 3 (Aprobaciones Comerciales): el Excel lo arma la DGII con e-CF que ella
// aceptó en el Paso 2, de cualquier intento. Antes se exigía que los 11 e-NCF
// estuvieran en el ÚLTIMO lote de esta PC y un Excel bueno se rechazaba con "no
// pertenece al último lote" (2026-11-16). Ahora se miran todos los aceptados y,
// si alguno no está, el usuario puede confirmar y enviar.
const { PassThrough } = require('stream');
const XLSX = require('xlsx');
const { createEcfService } = require('../modules/ecf/services/ecf.service');

const RNC_EMISOR = '132967161';
const RNC_COMPRADOR = '131880681';
const ENCFS = [
  'E310000000001', 'E310000000004', 'E310000000005', 'E310000000006',
  'E330000000001', 'E340000000002', 'E340000000003',
  'E440000000013', 'E440000000014', 'E450000000003', 'E450000000007',
];

function excelPaso3() {
  const filas = ENCFS.map((encf) => ({
    RNCEmisor: RNC_EMISOR, eNCF: encf, FechaEmision: '16-11-2026', MontoTotal: 118,
    RNCComprador: RNC_COMPRADOR, Estado: 1, FechaHoraAprobacionComercial: '16-11-2026 12:37:06',
  }));
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), 'ACECF');
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
}

// Petición multipart como la que manda el asistente (FormData).
function peticion(campos = {}) {
  const limite = '----tecnocaja-prueba';
  const partes = [];
  for (const [k, v] of Object.entries(campos)) {
    partes.push(Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  partes.push(Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="excel"; filename="${RNC_COMPRADOR}-16112026123706.xlsx"\r\n`
    + 'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'));
  partes.push(excelPaso3());
  partes.push(Buffer.from(`\r\n--${limite}--\r\n`));
  const cuerpo = Buffer.concat(partes);
  const req = new PassThrough();
  req.headers = { 'content-type': `multipart/form-data; boundary=${limite}`, 'content-length': String(cuerpo.length) };
  req.method = 'POST';
  req.end(cuerpo);
  return req;
}

function servicio(aceptadosEnEstaPC) {
  const s = createEcfService({
    query: async () => [],
    withTransaction: async (work) => work({ query: async () => [] }),
    resolveRequestActorUser: async () => ({ id: 1, nombre: 'Admin', role_code: 'administrador_general' }),
  });
  s.ensureReady = async () => {};
  s.getCurrentActor = async () => ({ id: 1 });
  s.applyRuntimeConfig = () => {};
  s.resolveCertificate = async () => ({});
  s.repository.query = async (sql) => (/estado_dgii IN/.test(sql) ? aceptadosEnEstaPC.map((encf) => ({ encf })) : []);
  // Pasar la validación local = llegar a autenticarse con la DGII (aquí se corta).
  s.authService.authenticate = async () => { throw Object.assign(new Error('LLEGÓ A LA DGII'), { llego: true }); };
  return s;
}

async function intentar(s, campos) {
  try {
    await s.processAprobacionComercialTestSet(peticion({ environment: 'certecf', ...campos }));
    return { llego: false };
  } catch (error) {
    return { llego: Boolean(error.llego), error };
  }
}

test('e-CF aceptados en otro lote de esta PC: se envía sin preguntar', async () => {
  // Los 11 están aceptados aquí, repartidos en varios intentos.
  const r = await intentar(servicio(ENCFS), {});
  expect(r.llego).toBe(true);
});

test('si alguno no está aceptado en esta PC, pregunta (409) en vez de bloquear', async () => {
  const r = await intentar(servicio(ENCFS.slice(4)), {});
  expect(r.llego).toBe(false);
  expect(r.error.statusCode).toBe(409);
  expect(r.error.details).toMatchObject({ code: 'ACECF_FUERA_DE_LOTE' });
  expect(r.error.details.faltan).toEqual(ENCFS.slice(0, 4));
  expect(r.error.message).not.toMatch(/último lote/);
});

test('con la confirmación del usuario se envía igual', async () => {
  const r = await intentar(servicio(ENCFS.slice(4)), { confirmarFueraDeLote: '1' });
  expect(r.llego).toBe(true);
});

test('sin nada de certificación en esta PC (Paso 2 en otra PC) se envía sin preguntar', async () => {
  const r = await intentar(servicio([]), {});
  expect(r.llego).toBe(true);
});

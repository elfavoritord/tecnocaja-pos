'use strict';

// La PC principal reinstalada (su TECNO_CAJA_LICENSE_UID es la licencia de la
// empresa) no se puede unir como sucursal: hacerlo marcaba la licencia de la
// EMPRESA con `sucursalDe` (se escondía del panel, perdía nombre y correo del
// dueño) y la empresa se quedaba sin principal. Caso Grupo Alimcar, 2026-11-18.

const { createAsistenteSucursal } = require('../../server/multisucursal/asistente-sucursal');

const EMPRESA = 'pos_empresa';
const OTRA = 'pos_otra_empresa';

function armar({ licenciaPropia }) {
  const activarConDueno = jest.fn(async () => ({}));
  const registrarLicencia = jest.fn(async () => null);
  const asistente = createAsistenteSucursal({
    query: async () => [],
    withTransaction: async (fn) => fn({ query: async () => [] }),
    getSetupStatus: async () => ({ setupRequired: true }),
    crearHashClave: async () => 'hash',
    registrarLicencia,
    getLicenciaPropia: () => licenciaPropia,
    logger: { warn() {}, info() {}, error() {} },
    multisucursal: {
      enlace: {
        activarConDueno,
        empresasDelDueno: async () => ({
          dueno: { email: 'dueno@correo.test' },
          empresas: [
            {
              licenseId: EMPRESA,
              nombre: 'GRUPO PRUEBA SRL',
              sucursales: [
                { branchUuid: 'b-principal', nombre: 'Plaza', estado: 'activa', esPrincipal: true },
                { branchUuid: 'b-norte', nombre: 'Norte', estado: 'activa', esPrincipal: false },
              ],
            },
            {
              licenseId: OTRA,
              nombre: 'Otra empresa',
              sucursales: [{ branchUuid: 'b-otra', nombre: 'Sur', estado: 'activa', esPrincipal: false }],
            },
          ],
        }),
      },
    },
  });
  return { asistente, activarConDueno, registrarLicencia };
}

describe('asistente de sucursal: la PC que tiene la licencia de la empresa', () => {
  test('la lista marca la empresa de esta PC (y solo esa)', async () => {
    const { asistente } = armar({ licenciaPropia: EMPRESA });
    const { empresas } = await asistente.empresasDelDueno('token');
    expect(empresas.find((e) => e.licenseId === EMPRESA).deEstaPc).toBe(true);
    expect(empresas.find((e) => e.licenseId === OTRA).deEstaPc).toBeUndefined();
  });

  test('no se une como sucursal: no enlaza ni toca la licencia', async () => {
    const { asistente, activarConDueno, registrarLicencia } = armar({ licenciaPropia: EMPRESA });
    await expect(asistente.unirse({
      idToken: 'token', licenseId: EMPRESA, branchUuid: 'b-norte', email: 'dueno@correo.test', clave: 'clave-1234',
    })).rejects.toMatchObject({ code: 'ES_LA_EMPRESA', statusCode: 409 });
    expect(activarConDueno).not.toHaveBeenCalled();
    expect(registrarLicencia).not.toHaveBeenCalled();
  });

  test('una PC con otra licencia (o sin licencia) sigue llegando al enlace', async () => {
    for (const licenciaPropia of ['pos_pc_nueva', '']) {
      const { asistente, activarConDueno } = armar({ licenciaPropia });
      const { empresas } = await asistente.empresasDelDueno('token');
      expect(empresas.some((e) => e.deEstaPc)).toBe(false);
      // El enlace falso no devuelve nada útil: basta con que se haya llamado.
      await asistente.unirse({
        idToken: 'token', licenseId: EMPRESA, branchUuid: 'b-norte', email: 'dueno@correo.test', clave: 'clave-1234',
      }).catch(() => {});
      expect(activarConDueno).toHaveBeenCalledTimes(1);
    }
  });
});

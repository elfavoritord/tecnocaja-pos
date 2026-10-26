'use strict';

/**
 * Portal del contador: las sucursales conectadas por Internet (cada una con
 * su PC y su licencia propia con `sucursalDe`) aparecen en el negocio, con sus
 * reportes y totales (tecno-caja-contadores/server/multisucursal/
 * sucursales-conectadas.js). Contra el emulador de Firestore:
 *   npm run test:multisucursal-central
 */

const enEmulador = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const describir = enEmulador ? describe : describe.skip;
jest.setTimeout(60000);

const PROYECTO = 'demo-tecnocaja';
const { createSucursalesCentral } = require('../../../server/multisucursal/central/sucursales');
const { createSucursalesConectadas, idDeSucursal } = require('../../../tecno-caja-contadores/server/multisucursal/sucursales-conectadas');

const LIC = 'pos_empresa_portal';
const EMILIO = { tipo: 'super_admin', uid: 'emilio', nombre: 'Emilio' };

describir('Portal del contador: sucursales conectadas', () => {
  let db;
  let central;
  let portal;

  beforeAll(() => {
    const admin = require('firebase-admin');
    db = admin.initializeApp({ projectId: PROYECTO }, `portal-${Date.now()}`).firestore();
  });

  beforeEach(async () => {
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
    await fetch(`http://${host}:${port}/emulator/v1/projects/${PROYECTO}/databases/(default)/documents`, { method: 'DELETE' });
    central = createSucursalesCentral({ db });
    portal = createSucursalesConectadas({ getDb: () => db });
    await db.collection('licencias').doc(LIC).set({ businessName: 'Anthony Prueba', status: 'active', posStats: { ventasHoy: 1000, ventasMes: 5000 } });
    await central.fijarLimite(LIC, 3, EMILIO);
  });

  const propias = [{ id: 1, nombre: 'Sucursal Principal', cajas: [] }];

  test('sin sucursales en la central, la lista queda como la publica la principal', async () => {
    expect(await portal.sucursales(LIC, propias)).toEqual(propias);
  });

  test('lista, filas y totales de las sucursales conectadas', async () => {
    const principal = await central.crear(LIC, { nombre: 'Principal' }, EMILIO);
    const norte = await central.crear(LIC, { nombre: 'Norte', codigo: 'NOR' }, EMILIO);
    const sur = await central.crear(LIC, { nombre: 'Sur' }, EMILIO);
    // La PC de Norte publica sus reportes bajo su propia licencia.
    await db.collection('licencias').doc('pos_pc_norte').set({
      businessName: 'Anthony Prueba · Norte', sucursalDe: { licenseId: LIC, branchUuid: norte.branchUuid, sucursal: 'Norte' },
      posStats: { ventasHoy: 250, ventasMes: 900 },
    });
    await db.collection('licencias').doc('pos_pc_norte').collection('reportes').doc('ventas').set({
      rows: [{ factura: 'FAC-1001', total: 250, branchId: 1, sucursal: 'Sucursal Principal' }],
    });
    // Otra empresa con una PC de sucursal: no se mezcla.
    await db.collection('licencias').doc('pos_pc_ajena').set({ sucursalDe: { licenseId: 'otra', branchUuid: norte.branchUuid } });

    // Las sucursales locales de la principal no salen aparte (se veían dobles):
    // la lista es la de la central.
    const conLocales = [...propias, { id: 2, nombre: 'Norte', cajas: [] }, { id: 3, nombre: 'Sucursal Principal', cajas: [] }];
    const lista = await portal.sucursales(LIC, conLocales);
    expect(lista.map((s) => s.nombre)).toEqual(['Principal', 'Norte', 'Sur']);
    expect(lista[0]).toMatchObject({ id: idDeSucursal(principal.branchUuid), principal: true, branchUuid: principal.branchUuid });
    expect(lista[1]).toMatchObject({ id: idDeSucursal(norte.branchUuid), conectada: true, branchUuid: norte.branchUuid, tienePc: true, codigo: 'NOR' });
    expect(lista[2]).toMatchObject({ id: idDeSucursal(sur.branchUuid), conectada: true, tienePc: false });
    expect(lista[1].id).toBeGreaterThan(1e9);

    // Las filas de Norte llevan el id de Norte (no el id local de su PC).
    expect(await portal.filas(LIC, 'ventas')).toEqual([
      expect.objectContaining({ factura: 'FAC-1001', branchId: idDeSucursal(norte.branchUuid), sucursal: 'Norte' }),
    ]);
    expect(await portal.filas(LIC, 'facturas')).toEqual([]);

    // Lo que publica la principal (de cualquiera de sus sucursales locales) es de la principal.
    expect(await portal.filasDeLaPrincipal(LIC, [{ factura: 'FAC-9', branchId: 2, sucursal: 'Norte' }, { factura: 'FAC-10' }])).toEqual([
      expect.objectContaining({ factura: 'FAC-9', branchId: idDeSucursal(principal.branchUuid), sucursal: 'Principal' }),
      expect.objectContaining({ factura: 'FAC-10', branchId: idDeSucursal(principal.branchUuid), sucursal: 'Principal' }),
    ]);

    expect(await portal.sumarStats(LIC, { ventasHoy: 1000, ventasMes: 5000, ultimaSync: 'x' })).toEqual({ ventasHoy: 1250, ventasMes: 5900, ultimaSync: 'x' });
  });

  test('una sucursal desactivada no aparece; una PC en la papelera no suma', async () => {
    await central.crear(LIC, { nombre: 'Principal' }, EMILIO);
    const norte = await central.crear(LIC, { nombre: 'Norte' }, EMILIO);
    await central.cambiarEstado(LIC, norte.branchUuid, 'inactiva', EMILIO);
    expect((await portal.sucursales(LIC, propias)).map((s) => s.nombre)).toEqual(['Sucursal Principal']);
    // Sin otras sucursales activas, las filas de la principal quedan como las publica.
    expect(await portal.filasDeLaPrincipal(LIC, [{ factura: 'FAC-9', branchId: 2 }])).toEqual([{ factura: 'FAC-9', branchId: 2 }]);
    await db.collection('licencias').doc('pos_pc_borrada').set({ deleted: true, sucursalDe: { licenseId: LIC, branchUuid: norte.branchUuid }, posStats: { ventasHoy: 99 } });
    expect(await portal.sumarStats(LIC, { ventasHoy: 1 })).toEqual({ ventasHoy: 1 });
  });
});

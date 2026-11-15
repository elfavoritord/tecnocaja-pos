'use strict';
// Compras que manda la app de reportes (server/services/compras/cola-app.js):
// cola de Firestore en memoria y la ruta real de compras sobre SQLite.
jest.mock('../../db', () => ({ getDbClient: () => 'sqlite' }));
const { firestoreFalso, baseCompras, usuariosPos } = require('./helpers');
const { createColaComprasApp, limpiarCompraApp } = require('../../server/services/compras/cola-app');

const NEG = 'pos_negocio1';
const USUARIOS = [
  { id: 1, nombre: 'Emilio', estado: 'Activo', role_code: 'administrador_general', role_permissions: [] },
  { id: 2, nombre: 'Ana (Yamasá)', estado: 'Activo', role_code: 'administrador_sucursal', branch_id: 2, role_permissions: ['compras.crear'] },
  { id: 3, nombre: 'Luis', estado: 'Activo', role_code: 'supervisor', role_permissions: ['ventas'] },
  { id: 4, nombre: 'Viejo', estado: 'Inactivo', role_code: 'administrador_general', role_permissions: [] },
];
const PERFILES = {
  'users/uEmilio': { role: 'admin', posUserId: 1, businessId: NEG, businessIds: [NEG], displayName: 'Emilio' },
  'users/uAna': { role: 'branch_admin', posUserId: 2, businessId: NEG, businessIds: [NEG], branchIds: ['2'] },
  'users/uLuis': { role: 'branch_admin', posUserId: 3, businessId: NEG, businessIds: [NEG] },
  'users/uViejo': { role: 'admin', posUserId: 4, businessId: NEG, businessIds: [NEG] },
  'users/uDueno': { role: 'businessOwner', businessId: NEG, businessIds: [NEG], displayName: 'Dueña' },
  'users/uOtro': { role: 'admin', posUserId: 1, businessId: 'pos_otro', businessIds: ['pos_otro'] },
};

const compra = (uid, extra = {}) => ({
  status: 'pendiente', createdBy: uid, createdAt: new Date('2026-11-10T12:00:00Z'),
  encabezado: { proveedor: { nombre: 'Distribuidora Uno', rnc: '101000002' }, ncf: 'B0100000077', fechaComprobante: '2026-11-09', condicionPago: 'contado' },
  lineas: [
    { productoId: 1, descripcion: 'Arroz Selecto 5 lb', cantidad: 10, costoUnitario: 250, itbisPct: 18 },
    { descripcion: 'Habichuelas Rojas 1 lb', cantidad: 6, costoUnitario: 60, itbisPct: 18, precio: { modo: 'incluido', valor: 90 } },
  ],
  ...extra,
});

async function montar(cola) {
  const { query, servicio } = await baseCompras();
  // La app usa un uuid como id (el POS exige 8+ caracteres): aquí, «compra-app-<nombre>».
  const db = firestoreFalso({ ...PERFILES, ...Object.fromEntries(Object.entries(cola).map(([id, d]) => [`businesses/${NEG}/appCompras/compra-app-${id}`, d])) });
  const auditoria = [];
  const avisos = [];
  const c = createColaComprasApp({
    servicio, query, getDb: () => db, getBusinessId: async () => NEG, getBranchId: async () => 1,
    usuarioApp: usuariosPos(USUARIOS), writeAuditLog: async (a) => auditoria.push(a), alRegistrar: () => avisos.push('sync'),
    logger: { warn: () => {} },
  });
  const estado = (id) => db._docs.get(`businesses/${NEG}/appCompras/compra-app-${id}`);
  return { query, db, cola: c, estado, auditoria, avisos };
}

describe('Compras desde la app de reportes', () => {
  test('el administrador la registra: inventario, producto nuevo, auditoría con su nombre', async () => {
    const { query, cola, estado, auditoria, avisos } = await montar({ 'app-0001': compra('uEmilio') });
    expect(await cola.procesar()).toMatchObject({ registradas: 1 });
    const e = estado('app-0001');
    expect(e).toMatchObject({ status: 'registrada', productosCreados: 1 });
    expect(e.totalRegistrado).toBeCloseTo(10 * 250 * 1.18 + 6 * 60 * 1.18, 2);
    const [p] = await query('SELECT stock FROM products WHERE id = 1');
    expect(Number(p.stock)).toBe(15);
    const [compraRow] = await query('SELECT branch_id, documento_origen, notas FROM purchases');
    expect(compraRow).toMatchObject({ branch_id: 1, documento_origen: 'app_reportes' });
    expect(compraRow.notas).toMatch(/app de reportes por Emilio/);
    expect(auditoria[0]).toMatchObject({ userName: 'Emilio', actionName: 'Compra registrada desde la app de reportes' });
    expect(avisos).toEqual(['sync']);
  });

  test('reintentada no se duplica', async () => {
    const { query, cola, db } = await montar({ 'app-0002': compra('uEmilio') });
    await cola.procesar();
    const ruta = `businesses/${NEG}/appCompras/compra-app-app-0002`;
    db._docs.set(ruta, { ...db._docs.get(ruta), status: 'pendiente' });
    await cola.procesar();
    const filas = await query('SELECT COUNT(*) AS n FROM purchases');
    expect(Number(filas[0].n)).toBe(1);
    const [p] = await query('SELECT stock FROM products WHERE id = 1');
    expect(Number(p.stock)).toBe(15);
  });

  test('el administrador de sucursal registra en la suya, y no en otra', async () => {
    const { query, cola, estado } = await montar({
      'app-0003': compra('uAna'),
      'app-0004': compra('uAna', { branchId: '1', encabezado: { ...compra('x').encabezado, ncf: 'B0100000078' } }),
    });
    await cola.procesar();
    expect(estado('app-0003').status).toBe('registrada');
    const [row] = await query('SELECT branch_id FROM purchases');
    expect(Number(row.branch_id)).toBe(2);
    expect(estado('app-0004')).toMatchObject({ status: 'rechazada', mensaje: expect.stringMatching(/tu sucursal/) });
  });

  test('sin permiso de compras, desactivado, de otro negocio o sin usuario del POS: rechazada', async () => {
    const { query, cola, estado } = await montar({
      a: compra('uLuis'), b: compra('uViejo'), c: compra('uOtro'), d: compra('uNadie'),
    });
    await cola.procesar();
    expect(estado('a')).toMatchObject({ status: 'rechazada', mensaje: expect.stringMatching(/Registrar compras/) });
    expect(estado('b')).toMatchObject({ status: 'rechazada', mensaje: expect.stringMatching(/desactivado/) });
    expect(estado('c')).toMatchObject({ status: 'rechazada', mensaje: expect.stringMatching(/no pertenece/) });
    expect(estado('d')).toMatchObject({ status: 'rechazada', mensaje: expect.stringMatching(/no pertenece/) });
    expect(Number((await query('SELECT COUNT(*) AS n FROM purchases'))[0].n)).toBe(0);
  });

  test('la dueña de la licencia (sin usuario del POS) puede', async () => {
    const { cola, estado } = await montar({ e: compra('uDueno') });
    await cola.procesar();
    const { status, mensaje } = estado('e');
    expect({ status, mensaje }).toEqual({ status: 'registrada', mensaje: '' });
  });

  test('datos malos de la app vuelven para corregir sin tocar nada', async () => {
    const { query, cola, estado } = await montar({
      f: compra('uEmilio', { encabezado: { ...compra('x').encabezado, ncf: 'B01-77' } }),
      g: compra('uEmilio', { lineas: [{ descripcion: 'Algo', cantidad: 0, costoUnitario: 5 }] }),
      h: compra('uEmilio', { lineas: [{ descripcion: 'Arroz selecto 5 lb.', cantidad: 1, costoUnitario: 5 }] }),
    });
    await cola.procesar();
    expect(estado('f')).toMatchObject({ status: 'requiere_correccion', mensaje: expect.stringMatching(/formato de la DGII/) });
    expect(estado('g')).toMatchObject({ status: 'requiere_correccion', mensaje: expect.stringMatching(/cantidad/) });
    // Nombre casi igual a uno que ya existe: no se crea un duplicado, hay que elegir.
    expect(estado('h').status).toBe('requiere_correccion');
    expect(Number((await query('SELECT COUNT(*) AS n FROM purchases'))[0].n)).toBe(0);
  });

  test('la misma factura del proveedor no entra dos veces', async () => {
    const { cola, estado } = await montar({ i: compra('uEmilio'), j: compra('uEmilio') });
    await cola.procesar();
    const estados = [estado('i').status, estado('j').status].sort();
    expect(estados).toEqual(['registrada', 'requiere_correccion']);
  });

  test('cancelada o ya registrada no se toca', async () => {
    const { cola, estado } = await montar({ k: compra('uEmilio', { status: 'cancelada' }), l: compra('uEmilio', { status: 'registrada', purchaseId: 7 }) });
    expect(await cola.procesar()).toMatchObject({ registradas: 0 });
    expect(estado('k').status).toBe('cancelada');
    expect(estado('l')).toMatchObject({ status: 'registrada', purchaseId: 7 });
  });
});

describe('limpiarCompraApp', () => {
  test('no se fía de la app: recorta, valida fechas y no deja cambiar productos existentes', () => {
    const r = limpiarCompraApp({
      encabezado: { proveedor: { nombre: '  Uno  ', rnc: '1-01-00000-2' }, ncf: 'e310000000001', fechaComprobante: '2026-11-09', condicionPago: 'credito', fechaVencimiento: '2026-12-09' },
      lineas: [
        { productoId: '1', descripcion: 'x', cantidad: '2', costoUnitario: '10.5', precio: { modo: 'base', valor: 99 }, controlaInventario: false },
        { descripcion: 'Flete', tipoLinea: 'servicio_gasto', cantidad: 1, costoUnitario: 300, itbisPct: 0 },
      ],
    });
    expect(r.encabezado).toMatchObject({ proveedor: { nombre: 'Uno', rnc: '101000002' }, ncf: 'E310000000001', condicionPago: 'credito', fechaVencimiento: '2026-12-09' });
    expect(r.lineas[0]).toEqual(expect.objectContaining({ productoId: 1, accion: 'existente', cantidad: 2, costoUnitario: 10.5 }));
    expect(r.lineas[0].precio).toBeUndefined();
    expect(r.lineas[0].controlaInventario).toBeUndefined();
    expect(r.lineas[1]).toEqual(expect.objectContaining({ tipoLinea: 'servicio_gasto', itbisPct: 0 }));
    expect(() => limpiarCompraApp({ encabezado: { proveedor: { nombre: 'A' }, fechaComprobante: '2026-02-30' }, lineas: [{}] })).toThrow(/fecha/);
    expect(() => limpiarCompraApp({ encabezado: { proveedor: { nombre: 'A' }, fechaComprobante: '2026-11-09', condicionPago: 'credito', fechaVencimiento: '2026-11-01' }, lineas: [{ descripcion: 'a', cantidad: 1, costoUnitario: 1 }] })).toThrow(/vencimiento/);
    expect(() => limpiarCompraApp({ encabezado: { proveedor: { rnc: '123' }, fechaComprobante: '2026-11-09' }, lineas: [] })).toThrow(/9 u 11/);
  });
});

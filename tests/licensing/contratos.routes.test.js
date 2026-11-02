'use strict';

// Panel: contrato, servicios y pagos, con el Firestore en memoria. El POS lee el
// resultado con el servicio real de licencias (última parte del archivo).

const express = require('express');
const request = require('supertest');
const { createFakeFirestore } = require('../helpers/fake-firestore');
const { createContratosRouter, sumarMeses } = require('../../tecno-caja-admin/routes/contratos.routes');
const { resolverServicios } = require('../../server/licensing/servicios');

const AHORA = new Date('2026-11-02T12:00:00.000Z');
const ID = 'pos_negocio_1';
const DIA = 86400000;

function montar(docs = {}) {
  const db = createFakeFirestore({
    [`licencias/${ID}`]: { businessName: 'Colmado', status: 'trial', planCode: 'basico', devices: { a: { deviceId: 'a', hostname: 'CAJA-1' } } },
    ...docs,
  });
  const auditoria = [];
  let now = AHORA;
  const app = express();
  app.use(express.json());
  app.use(createContratosRouter({
    db,
    requireAuth: (req, _res, next) => { req.adminUser = { email: 'emilio@prueba.test' }; next(); },
    audit: async (actor, accion, objetivo, detalle) => { auditoria.push({ actor, accion, objetivo, detalle }); },
    now: () => now,
  }));
  return { app, db, auditoria, avanzar: (ms) => { now = new Date(now.getTime() + ms); } };
}

const licencia = async (db) => (await db.collection('licencias').doc(ID).get()).data();
const contrato = (app, cuerpo) => request(app).put(`/api/negocios/${ID}/contrato`).send(cuerpo);
const pagar = (app, cuerpo) => request(app).post(`/api/negocios/${ID}/pagos`).send(cuerpo);
const permanente = { plan: 'basico', modalidad: 'LIFETIME_NO_SUBSCRIPTION' };

describe('licencia permanente', () => {
  test('queda activa, sin vencimiento, con e-CF y soporte aparte', async () => {
    const { app, db, auditoria } = montar();
    const r = await contrato(app, permanente);
    expect(r.status).toBe(200);
    const d = await licencia(db);
    expect(d).toMatchObject({ status: 'active', modalidad: 'LIFETIME_NO_SUBSCRIPTION', expiresAt: null, trialEndsAt: null, deviceLimit: 1 });
    expect(r.body.servicios.ecf.estado).toBe('inactivo');
    expect(r.body.servicios.soporte.estado).toBe('inactivo');
    expect(r.body.servicios.respaldoLocal.permitido).toBe(true);
    expect(r.body.servicios.respaldoNube.permitido).toBe(true);
    expect(r.body.servicios.actualizaciones.permitido).toBe(true);
    expect(auditoria[0].accion).toBe('contrato.cambio');
  });

  test('su pago no se puede renovar ni cobrar dos veces', async () => {
    const { app } = montar();
    await contrato(app, permanente);
    const uno = await pagar(app, { clave: 'pago-licencia-1', concepto: 'licencia', periodo: 'unico', monto: 25000 });
    expect(uno.status).toBe(200);
    const dos = await pagar(app, { clave: 'pago-licencia-2', concepto: 'licencia', periodo: 'mensual', monto: 800 });
    expect(dos.status).toBe(409);
    expect(dos.body.code).toBe('PERMANENTE_NO_SE_RENUEVA');
  });

  test('e-CF después: se conserva la permanente y el servicio tiene su vigencia', async () => {
    const { app, db, avanzar } = montar();
    await contrato(app, permanente);
    const r = await pagar(app, { clave: 'pago-ecf-0001', concepto: 'ecf', periodo: 'anual', monto: 18000 });
    expect(r.status).toBe(200);
    expect(r.body.modalidad).toBe('LIFETIME_NO_SUBSCRIPTION');
    expect(r.body.status).toBe('active');
    expect(r.body.expiresAt).toBeNull();
    expect(r.body.servicios.ecf.estado).toBe('activo');
    expect(new Date(r.body.servicios.ecf.venceEn).toISOString().slice(0, 10)).toBe('2027-11-02');

    avanzar(366 * DIA);
    const d = await licencia(db);
    const luego = resolverServicios(d.servicios, new Date(AHORA.getTime() + 366 * DIA));
    expect(luego.ecf.estado).toBe('vencido');
    expect(luego.ecf.permitido).toBe(false);
    expect(luego.respaldoNube.permitido).toBe(true);
    expect(d.status).toBe('active');
  });
});

describe('suscripción', () => {
  const mensual = { plan: 'pro', modalidad: 'mensual', venceEn: '2026-12-02T12:00:00.000Z' };

  test('hay que decir hasta cuándo', async () => {
    const { app } = montar();
    expect((await contrato(app, { plan: 'pro', modalidad: 'mensual' })).status).toBe(400);
  });

  test('renovar un mes suma un mes sin perder días', async () => {
    const { app, db } = montar();
    await contrato(app, mensual);
    const r = await pagar(app, { clave: 'pago-mes-0001', concepto: 'licencia', periodo: 'mensual', monto: 1400 });
    expect(r.status).toBe(200);
    expect((await licencia(db)).expiresAt.toISOString().slice(0, 10)).toBe('2027-01-02');
  });

  test('el pago anual da 12 meses', async () => {
    const { app, db } = montar();
    await contrato(app, { plan: 'basico', modalidad: 'anual', venceEn: '2026-11-03T00:00:00.000Z' });
    await pagar(app, { clave: 'pago-anual-01', concepto: 'licencia', periodo: 'anual', monto: 7200 });
    expect((await licencia(db)).expiresAt.toISOString().slice(0, 10)).toBe('2027-11-03');
  });

  test('pagar tarde cuenta desde hoy y reactiva', async () => {
    const { app, db } = montar();
    await contrato(app, { plan: 'basico', modalidad: 'mensual', venceEn: '2026-11-03T00:00:00.000Z' });
    await db.collection('licencias').doc(ID).set({ expiresAt: new Date('2026-06-01T00:00:00.000Z'), status: 'expired' }, { merge: true });
    await pagar(app, { clave: 'pago-tarde-01', concepto: 'licencia', periodo: 'mensual', monto: 800 });
    const d = await licencia(db);
    expect(d.status).toBe('active');
    expect(d.expiresAt.toISOString().slice(0, 10)).toBe('2026-12-02');
  });

  test('repetir el mismo pago no cobra ni extiende dos veces', async () => {
    const { app, db, auditoria } = montar();
    await contrato(app, mensual);
    const cuerpo = { clave: 'pago-doble-01', concepto: 'licencia', periodo: 'mensual', monto: 1400 };
    await pagar(app, cuerpo);
    const antes = (await licencia(db)).expiresAt.getTime();
    const otra = await pagar(app, cuerpo);
    expect(otra.body.repetido).toBe(true);
    expect((await licencia(db)).expiresAt.getTime()).toBe(antes);
    const pagos = await db.collection(`licencias/${ID}/pagos`).get();
    expect(pagos.size).toBe(1);
    expect(auditoria.filter((a) => a.accion === 'contrato.pago.licencia')).toHaveLength(1);
  });

  test('la implementación se cobra una sola vez', async () => {
    const { app } = montar();
    await contrato(app, mensual);
    expect((await pagar(app, { clave: 'pago-impl-001', concepto: 'implementacion', monto: 14000 })).status).toBe(200);
    const dos = await pagar(app, { clave: 'pago-impl-002', concepto: 'implementacion', monto: 14000 });
    expect(dos.status).toBe(409);
    expect(dos.body.code).toBe('IMPLEMENTACION_YA_PAGADA');
    // La de un equipo nuevo sí es otro cobro.
    expect((await pagar(app, { clave: 'pago-impl-003', concepto: 'implementacion_adicional', monto: 2500 })).status).toBe(200);
  });
});

describe('cambios y servicios', () => {
  test('los adicionales cambian las computadoras contratadas', async () => {
    const { app, db } = montar();
    const r = await contrato(app, { plan: 'plus', modalidad: 'LIFETIME_NO_SUBSCRIPTION', computadorasExtra: 1, sucursalesExtra: 1 });
    expect(r.body.contrato).toMatchObject({ computadoras: 4, sucursales: 3 });
    const d = await licencia(db);
    expect(d.deviceLimit).toBe(4);
    expect(d.business_structure_mode).toBe('multisucursal');
  });

  test('Básico no acepta adicionales', async () => {
    const { app } = montar();
    expect((await contrato(app, { ...permanente, computadorasExtra: 1 })).status).toBe(400);
  });

  test('cambiar de plan conserva los servicios contratados', async () => {
    const { app } = montar();
    await contrato(app, permanente);
    await pagar(app, { clave: 'pago-ecf-0002', concepto: 'ecf', periodo: 'mensual', monto: 1500 });
    const r = await contrato(app, { plan: 'pro', modalidad: 'LIFETIME_NO_SUBSCRIPTION' });
    expect(r.body.planCode).toBe('pro');
    expect(r.body.servicios.ecf.estado).toBe('activo');
    expect(r.body.computadorasContratadas).toBe(2);
  });

  test('suspender soporte no toca la licencia ni el e-CF', async () => {
    const { app, db } = montar();
    await contrato(app, permanente);
    await request(app).post(`/api/negocios/${ID}/servicios/soporte`).send({ accion: 'activar', venceEn: '2027-01-01T00:00:00.000Z' });
    await request(app).post(`/api/negocios/${ID}/servicios/ecf`).send({ accion: 'activar', venceEn: '2027-01-01T00:00:00.000Z' });
    const r = await request(app).post(`/api/negocios/${ID}/servicios/soporte`).send({ accion: 'suspender' });
    expect(r.body.servicios.soporte.estado).toBe('suspendido');
    expect(r.body.servicios.ecf.estado).toBe('activo');
    expect((await licencia(db)).status).toBe('active');
  });

  test('activar un servicio exige fecha futura; respaldos no se suspenden por aquí', async () => {
    const { app } = montar();
    await contrato(app, permanente);
    expect((await request(app).post(`/api/negocios/${ID}/servicios/ecf`).send({ accion: 'activar' })).status).toBe(400);
    expect((await request(app).post(`/api/negocios/${ID}/servicios/respaldoNube`).send({ accion: 'suspender' })).status).toBe(400);
  });

  test('todo queda en el historial y el contrato lo devuelve con los pagos', async () => {
    const { app } = montar();
    await contrato(app, permanente);
    await pagar(app, { clave: 'pago-impl-010', concepto: 'implementacion', monto: 8000, metodo: 'transferencia' });
    const r = await request(app).get(`/api/negocios/${ID}/contrato`);
    expect(r.body.pagos).toHaveLength(1);
    expect(r.body.pagos[0]).toMatchObject({ montoCentavos: 800000, moneda: 'DOP', metodo: 'transferencia', registradoPor: 'emilio@prueba.test' });
    expect(r.body.historial.map((h) => h.action)).toEqual(expect.arrayContaining(['cambio', 'pago.implementacion']));
    expect(r.body.computadorasActivas).toBe(1);
    expect(r.body.equipos[0].hostname).toBe('CAJA-1');
  });
});

describe('precios del panel', () => {
  test('el cálculo es del servidor y usa lo guardado', async () => {
    const { app, auditoria } = montar();
    await request(app).put('/api/precios-licencia').send({ permanente: { basico: 25000, pro: 'x' }, ecf: { mensual: 1500 } });
    const c = await request(app).post('/api/precios-licencia/cotizar').send({ plan: 'basico', modalidad: 'LIFETIME_NO_SUBSCRIPTION', servicios: { ecf: 'mensual' } });
    expect(c.body.totales.total).toBe(2650000);
    expect(c.body.pendientes).toEqual([]);
    expect(auditoria[0].accion).toBe('precios.actualizados');
    const p = await request(app).get('/api/precios-licencia');
    expect(p.body.catalogo.planes.find((x) => x.codigo === 'pro').permanente).toBeNull();
  });

  test('el cliente no manda el precio al cotizar', async () => {
    const { app } = montar();
    const c = await request(app).post('/api/precios-licencia/cotizar').send({ plan: 'basico', modalidad: 'mensual', precios: { permanente: { basico: 1 } }, mensual: 1 });
    expect(c.body.totales.total).toBe(80000);
  });
});

test('sumar meses no se pasa de mes', () => {
  expect(sumarMeses(new Date('2026-01-31T12:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
  expect(sumarMeses(new Date('2026-11-02T12:00:00Z'), 12).toISOString().slice(0, 10)).toBe('2027-11-02');
});

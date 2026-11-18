'use strict';
// Por qué E31/E32 salen apagados en Cobrar (2026-11-17, "las secuencias están
// activas pero no me sale activa"): explainSaleTypes da el motivo de cada tipo
// con las mismas reglas que usableSequences.
const { createEcfService } = require('../modules/ecf/services/ecf.service');

function servicio({ emisor = { is_active: 1, environment: 'ecf' }, rangos = [], permitido = true, mensaje = null } = {}) {
  const s = createEcfService({ query: async () => [] });
  s.ensureReady = async () => {};
  s.repository.getResolvedEmitter = async () => emisor;
  s.repository.query = async () => rangos;
  s.servicioPermitido = () => permitido;
  s.servicioMensaje = () => mensaje;
  return s;
}

const rango = (extra = {}) => ({
  tipo_comprobante: 'E32', environment: 'ecf', activo: 1, branch_id: null, cash_register_id: null,
  numero_final: 100, proximo_numero: 5, fecha_vencimiento: null, ...extra,
});

const explicar = (s) => s.explainSaleTypes({ branchId: 1, cashRegisterId: 1, tipos: ['E31', 'E32'] });

test('con un rango de producción usable, E32 está disponible', async () => {
  const r = await explicar(servicio({ rangos: [rango()] }));
  expect(r.tipos.E32).toEqual({ disponible: true, motivo: null });
  expect(r.tipos.E31.motivo).toMatch(/No hay rango E31/);
});

test('emisor apagado: lo dice en general', async () => {
  const r = await explicar(servicio({ emisor: { is_active: 0, environment: 'ecf' } }));
  expect(r.general).toMatch(/no está activa en este negocio/);
});

test('licencia con el e-CF detenido: da el aviso de la licencia', async () => {
  const r = await explicar(servicio({ permitido: false, mensaje: 'La licencia venció: la facturación electrónica quedó detenida hasta renovar.' }));
  expect(r.general).toMatch(/licencia venció/);
});

test('rango cargado para certificación con el sistema en producción', async () => {
  const r = await explicar(servicio({ rangos: [rango({ environment: 'certecf' })] }));
  expect(r.tipos.E32.disponible).toBe(false);
  expect(r.tipos.E32.motivo).toMatch(/registrado para certificación, no para producción/);
});

test('sistema todavía en certificación con el rango de producción', async () => {
  const r = await explicar(servicio({ emisor: { is_active: 1, environment: 'certecf' }, rangos: [rango()] }));
  expect(r.tipos.E32.motivo).toMatch(/todavía está en certificación/);
});

test('rango desactivado, de otra caja, vencido o agotado', async () => {
  expect((await explicar(servicio({ rangos: [rango({ activo: 0 })] }))).tipos.E32.motivo).toMatch(/desactivado/);
  expect((await explicar(servicio({ rangos: [rango({ cash_register_id: 9 })] }))).tipos.E32.motivo).toMatch(/otra sucursal o caja/);
  expect((await explicar(servicio({ rangos: [rango({ fecha_vencimiento: '2020-12-31' })] }))).tipos.E32.motivo).toMatch(/venció el 31\/12\/2020/);
  expect((await explicar(servicio({ rangos: [rango({ proximo_numero: 101 })] }))).tipos.E32.motivo).toMatch(/todos los números/);
});

test('Estado del e-CF: la licencia sin el servicio sale como observación', async () => {
  const s = servicio({ permitido: false });
  s.dgiiAuthBootstrapPromise = Promise.resolve();
  s.repository.getResolvedEmitter = async () => ({ is_active: 1, environment: 'ecf', rnc: '132967161', razon_social: 'GRUPO', direccion: 'Calle 1' });
  s.getCertificateStatus = async () => ({ hasCertificate: true, isExpired: false, validTo: '2027-11-12' });
  s.repository.listSequences = async () => [{ environment: 'ecf', activo: 1, isExpired: false, isExhausted: false }];
  let estado;
  try { estado = await s.getSystemStatus(); } catch (error) { estado = { error: error.message }; }
  const item = estado.checklist?.items?.find((i) => i.key === 'license_service');
  expect(item).toMatchObject({ status: 'warning' });
  expect(item.message).toMatch(/no está activo en la licencia/);
  expect(estado.checklist.summary.warning).toBe(1);
});

test('E31 sin la fecha de vencimiento de la DGII', async () => {
  const r = await explicar(servicio({ rangos: [rango({ tipo_comprobante: 'E31' })] }));
  expect(r.tipos.E31.motivo).toMatch(/fecha de vencimiento/);
});

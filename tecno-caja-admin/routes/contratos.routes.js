'use strict';

/**
 * contratos.routes.js — Contrato comercial de cada licencia, desde el panel.
 *
 * Toda cuenta se hace aquí con server/licensing/precios.js; el panel solo muestra.
 * Cada cambio deja rastro en audit_logs y en license_history. Los pagos llevan una
 * clave única: repetir la petición no cobra ni extiende dos veces.
 *
 * GET  /api/precios-licencia             — catálogo + precios guardados
 * PUT  /api/precios-licencia             — permanente, e-CF y soporte
 * POST /api/precios-licencia/cotizar             — motor de cálculo
 * GET  /api/negocios/:id/contrato         — contrato, servicios, pagos e historial
 * PUT  /api/negocios/:id/contrato         — plan, modalidad y adicionales
 * POST /api/negocios/:id/servicios/:svc   — activar | suspender | reactivar
 * POST /api/negocios/:id/pagos            — registrar un pago (renueva si corresponde)
 */

const express = require('express');
const {
  MODALIDADES, MESES_SERVICIO_ANUAL, PLANES, catalogo, cotizar, limitesDelPlan,
} = require('../../server/licensing/precios');
const {
  MODALIDAD_PERMANENTE, SERVICIOS_DE_PAGO, normalizarModalidad, resolverServicios, serviciosIniciales,
} = require('../../server/licensing/servicios');

const DOC_PRECIOS = 'precios_licencias';
const CONCEPTOS_PAGO = ['licencia', 'implementacion', 'implementacion_adicional', 'adicional', 'ecf', 'soporte'];

function falla(mensaje, statusCode = 400, code = undefined) {
  return Object.assign(new Error(mensaje), { statusCode, code });
}

function fechaDe(valor) {
  if (!valor) return null;
  const d = typeof valor?.toDate === 'function' ? valor.toDate() : new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

const iso = (valor) => fechaDe(valor)?.toISOString() || null;

/** Suma meses sin pasarse de mes: 31 de enero + 1 mes = 28 de febrero. */
function sumarMeses(desde, meses) {
  const d = new Date(desde.getTime());
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + meses);
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimo));
  return d;
}

const mesesDe = (periodo) => (periodo === 'anual' ? MESES_SERVICIO_ANUAL : 1);

/** Pagar antes de tiempo no pierde días; pagar tarde cuenta desde hoy. */
function nuevaVigencia(actual, periodo, now) {
  const base = fechaDe(actual);
  return sumarMeses(base && base.getTime() > now.getTime() ? base : now, mesesDe(periodo));
}

function createContratosRouter({
  db, requireAuth, audit, now = () => new Date(), coleccionLicencias = 'licencias', coleccionHistorial = 'license_history',
}) {
  const router = express.Router();
  const refLicencia = (id) => db.collection(coleccionLicencias).doc(id);
  const refPrecios = () => db.collection('admin_config').doc(DOC_PRECIOS);

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      const status = Number(e.statusCode) || 500;
      if (status >= 500) console.error('[contratos]', e);
      res.status(status).json({ error: e.message, code: e.code });
    }
  };

  async function preciosGuardados() {
    const snap = await refPrecios().get();
    return snap.exists ? snap.data() : {};
  }

  async function leer(id) {
    const snap = await refLicencia(id).get();
    if (!snap.exists) throw falla('Negocio no encontrado.', 404);
    return snap.data();
  }

  async function dejarRastro(req, id, data, accion, detalle) {
    const actor = req.adminUser?.email || 'admin';
    await audit(actor, `contrato.${accion}`, id, detalle);
    await db.collection(coleccionHistorial).add({
      business_id: id,
      businessKey: data.businessKey || id,
      businessName: data.businessName || '—',
      plan: data.planCode || '—',
      status: data.status || '—',
      action: accion,
      activated_by: actor,
      notes: detalle,
      created_at: now().toISOString(),
    }).catch(() => {});
  }

  function vistaContrato(id, d) {
    const devices = d.devices && typeof d.devices === 'object' ? Object.values(d.devices) : [];
    const contrato = d.contrato || null;
    return {
      id,
      negocio: d.businessName || '—',
      rnc: d.rnc || '',
      licenseId: d.licenseId || id,
      planCode: d.planCode || d.plan_code || 'basico',
      modalidad: normalizarModalidad(d.modalidad),
      status: d.status || 'trial',
      expiresAt: iso(d.expiresAt),
      contrato: contrato ? {
        ...contrato,
        fechaAdquisicion: iso(contrato.fechaAdquisicion),
        fechaImplementacion: iso(contrato.fechaImplementacion),
      } : null,
      computadorasActivas: devices.length,
      computadorasContratadas: Number(d.deviceLimit || 0),
      equipos: devices.map((x) => ({ deviceId: x.deviceId, hostname: x.hostname || '—', lastSeenAt: iso(x.lastSeenAt) })),
      servicios: resolverServicios(d.servicios, now()),
    };
  }

  router.get('/api/precios-licencia', requireAuth, wrap(async (_req, res) => {
    const guardados = await preciosGuardados();
    res.json({ catalogo: catalogo(guardados), guardados });
  }));

  router.put('/api/precios-licencia', requireAuth, wrap(async (req, res) => {
    const b = req.body || {};
    const limpio = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));
    const guardar = {
      permanente: { basico: limpio(b.permanente?.basico), pro: limpio(b.permanente?.pro), plus: limpio(b.permanente?.plus) },
      ecf: { mensual: limpio(b.ecf?.mensual), anual: limpio(b.ecf?.anual) },
      soporte: { mensual: limpio(b.soporte?.mensual), anual: limpio(b.soporte?.anual) },
      actualizadoEn: now().toISOString(),
    };
    await refPrecios().set(guardar);
    await audit(req.adminUser?.email || 'admin', 'precios.actualizados', 'admin_config', JSON.stringify(guardar));
    res.json({ ok: true, catalogo: catalogo(guardar), guardados: guardar });
  }));

  router.post('/api/precios-licencia/cotizar', requireAuth, wrap(async (req, res) => {
    const guardados = await preciosGuardados();
    res.json(cotizar({ ...(req.body || {}), precios: guardados }));
  }));

  router.get('/api/negocios/:id/contrato', requireAuth, wrap(async (req, res) => {
    const d = await leer(req.params.id);
    const [pagos, historial] = await Promise.all([
      refLicencia(req.params.id).collection('pagos').get(),
      db.collection(coleccionHistorial).where('business_id', '==', req.params.id).get().catch(() => null),
    ]);
    res.json({
      ...vistaContrato(req.params.id, d),
      pagos: pagos.docs.map((x) => ({ id: x.id, ...x.data() })).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))),
      historial: (historial?.docs || []).map((x) => x.data()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 50),
    });
  }));

  router.put('/api/negocios/:id/contrato', requireAuth, wrap(async (req, res) => {
    const id = req.params.id;
    const b = req.body || {};
    const modalidad = normalizarModalidad(b.modalidad);
    if (!modalidad) throw falla('Indica la modalidad: mensual, anual o pago único.');
    if (!Object.prototype.hasOwnProperty.call(PLANES, b.plan)) throw falla('Plan inválido.');
    const computadorasExtra = Number(b.computadorasExtra || 0);
    const sucursalesExtra = Number(b.sucursalesExtra || 0);
    const limites = limitesDelPlan(b.plan, { computadorasExtra, sucursalesExtra });
    const plan = PLANES[b.plan];
    const ahora = now();

    const d = await leer(id);
    const fechaAdquisicion = fechaDe(b.fechaAdquisicion) || fechaDe(d.contrato?.fechaAdquisicion) || ahora;
    const fechaImplementacion = fechaDe(b.fechaImplementacion) || fechaDe(d.contrato?.fechaImplementacion) || null;
    const cambio = {
      planCode: plan.codigo,
      plan_code: plan.codigo,
      planName: `Tecno Caja ${plan.nombre}`,
      plan_name: `Tecno Caja ${plan.nombre}`,
      businessStructureMode: plan.modo,
      business_structure_mode: plan.modo,
      modalidad,
      deviceLimit: limites.computadoras,
      contrato: {
        plan: plan.codigo,
        modalidad,
        computadorasExtra,
        sucursalesExtra,
        computadoras: limites.computadoras,
        sucursales: limites.sucursales,
        fechaAdquisicion,
        fechaImplementacion,
        implementacionPagada: Boolean(d.contrato?.implementacionPagada),
        notas: String(b.notas || d.contrato?.notas || '').slice(0, 500),
      },
      updatedAt: ahora,
      syncedAt: ahora,
    };
    // Los servicios ya contratados no se tocan al cambiar de plan.
    if (!d.servicios) cambio.servicios = serviciosIniciales(modalidad);

    if (modalidad === MODALIDAD_PERMANENTE) {
      cambio.status = 'active';
      cambio.expiresAt = null;
      cambio.trialStartedAt = null;
      cambio.trialEndsAt = null;
    } else {
      const vence = fechaDe(b.venceEn) || fechaDe(d.expiresAt);
      if (!vence) throw falla('Indica hasta cuándo está pagada la licencia.');
      cambio.expiresAt = vence;
      cambio.trialStartedAt = null;
      cambio.trialEndsAt = null;
      if (vence.getTime() > ahora.getTime()) cambio.status = 'active';
    }
    await refLicencia(id).set(cambio, { merge: true });
    const guardado = { ...d, ...cambio };
    await dejarRastro(req, id, guardado, 'cambio', `Plan ${plan.nombre}, ${modalidad}, ${limites.computadoras} computadoras, ${limites.sucursales} sucursales`);
    res.json(vistaContrato(id, guardado));
  }));

  router.post('/api/negocios/:id/servicios/:servicio', requireAuth, wrap(async (req, res) => {
    const { id, servicio } = req.params;
    if (!SERVICIOS_DE_PAGO.includes(servicio)) throw falla('Servicio inválido.');
    const { accion, venceEn } = req.body || {};
    if (!['activar', 'suspender', 'reactivar'].includes(accion)) throw falla('Acción inválida.');
    const d = await leer(id);
    const actuales = d.servicios || serviciosIniciales(normalizarModalidad(d.modalidad));
    const actual = actuales[servicio] || { estado: 'inactivo', venceEn: null };
    const vence = accion === 'suspender' ? fechaDe(actual.venceEn) : (fechaDe(venceEn) || fechaDe(actual.venceEn));
    if (accion !== 'suspender' && (!vence || vence.getTime() <= now().getTime())) {
      throw falla('Indica hasta cuándo queda pagado el servicio.');
    }
    const servicios = { ...actuales, [servicio]: { estado: accion === 'suspender' ? 'suspendido' : 'activo', venceEn: vence || null } };
    // Solo cambia ese servicio: ni el estado ni el plan ni la modalidad de la licencia.
    await refLicencia(id).set({ servicios, updatedAt: now() }, { merge: true });
    const guardado = { ...d, servicios };
    await dejarRastro(req, id, guardado, `servicio.${servicio}.${accion}`, `Vence: ${iso(vence) || 'sin fecha'}`);
    res.json(vistaContrato(id, guardado));
  }));

  router.post('/api/negocios/:id/pagos', requireAuth, wrap(async (req, res) => {
    const { id } = req.params;
    const b = req.body || {};
    const clave = String(b.clave || '').trim();
    if (!/^[\w-]{8,80}$/.test(clave)) throw falla('Falta la clave única del pago.');
    if (!CONCEPTOS_PAGO.includes(b.concepto)) throw falla('Concepto inválido.');
    const periodo = ['licencia', 'adicional', 'ecf', 'soporte'].includes(b.concepto) ? b.periodo : 'unico';
    if (periodo !== 'unico' && periodo !== 'mensual' && periodo !== 'anual') throw falla('Indica si el pago es mensual o anual.');
    const monto = Math.round(Number(b.monto) * 100);
    if (!Number.isFinite(monto) || monto <= 0) throw falla('El monto debe ser mayor que cero.');

    const ref = refLicencia(id);
    const refPago = ref.collection('pagos').doc(clave);
    const ahora = now();
    const resultado = await db.runTransaction(async (tx) => {
      const [snap, previo] = await Promise.all([tx.get(ref), tx.get(refPago)]);
      if (!snap.exists) throw falla('Negocio no encontrado.', 404);
      const d = snap.data();
      if (previo.exists) return { repetido: true, d, pago: previo.data() };

      const permanente = normalizarModalidad(d.modalidad) === MODALIDAD_PERMANENTE;
      if (b.concepto === 'implementacion' && d.contrato?.implementacionPagada) {
        throw falla('La implementación ya se cobró. Se paga una sola vez.', 409, 'IMPLEMENTACION_YA_PAGADA');
      }
      if (b.concepto === 'licencia' && permanente && d.contrato?.licenciaPagada) {
        throw falla('Esta licencia es de pago único y ya está pagada: no se renueva.', 409, 'PERMANENTE_NO_SE_RENUEVA');
      }
      const cambio = { updatedAt: ahora };
      const contrato = { ...(d.contrato || {}) };
      if (b.concepto === 'implementacion') {
        contrato.implementacionPagada = true;
        contrato.fechaImplementacion = contrato.fechaImplementacion || ahora;
        cambio.contrato = contrato;
      }
      if (b.concepto === 'licencia') {
        if (permanente) {
          contrato.licenciaPagada = true;
          cambio.contrato = contrato;
        } else {
          cambio.expiresAt = nuevaVigencia(d.expiresAt, periodo, ahora);
          cambio.status = 'active';
          cambio.trialStartedAt = null;
          cambio.trialEndsAt = null;
        }
      }
      if (SERVICIOS_DE_PAGO.includes(b.concepto)) {
        const actuales = d.servicios || serviciosIniciales(normalizarModalidad(d.modalidad));
        cambio.servicios = {
          ...actuales,
          [b.concepto]: { estado: 'activo', venceEn: nuevaVigencia(actuales[b.concepto]?.venceEn, periodo, ahora) },
        };
      }
      const pago = {
        concepto: b.concepto,
        periodo,
        montoCentavos: monto,
        moneda: 'DOP',
        metodo: String(b.metodo || '').slice(0, 40),
        referencia: String(b.referencia || '').slice(0, 120),
        nota: String(b.nota || '').slice(0, 300),
        fecha: ahora.toISOString(),
        registradoPor: req.adminUser?.email || 'admin',
      };
      tx.set(refPago, pago);
      tx.set(ref, cambio, { merge: true });
      return { repetido: false, d: { ...d, ...cambio }, pago };
    });
    if (!resultado.repetido) {
      await dejarRastro(req, id, resultado.d, `pago.${b.concepto}`, `RD$${(monto / 100).toFixed(2)} ${periodo}`);
    }
    res.json({ ...vistaContrato(id, resultado.d), repetido: resultado.repetido, pago: resultado.pago });
  }));

  return router;
}

module.exports = { MODALIDADES, createContratosRouter, nuevaVigencia, sumarMeses };

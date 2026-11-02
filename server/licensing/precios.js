'use strict';

// Precios oficiales de Tecno Caja y motor de cálculo. Es la única fuente: la usan
// el POS (pantalla de planes) y el panel del administrador (cotizador y pagos).
// Los montos van en centavos enteros de peso dominicano: nunca se suman decimales.
//
// null = Emilio todavía no definió ese precio. Se puede poner desde el panel; hasta
// entonces se muestra "Consultar" y no se puede cobrar.
//
// La implementación se cobra una sola vez y va siempre en su propio renglón: una
// renovación nunca la incluye.

const MODALIDADES = {
  MENSUAL: 'mensual',
  ANUAL: 'anual',
  PERMANENTE: 'LIFETIME_NO_SUBSCRIPTION',
};

const MESES_PAGADOS_ANUAL = 9;
const MESES_SERVICIO_ANUAL = 12;
const MAX_ADICIONALES = 500;

const rd = (pesos) => Math.round(pesos * 100);

/** Los códigos (basico, pro, plus) son los que ya tienen las licencias guardadas. */
const PLANES = {
  basico: {
    codigo: 'basico',
    nombre: 'Básico',
    modo: 'monocaja',
    mensual: rd(800),
    implementacion: rd(8000),
    computadoras: 1,
    sucursales: 1,
    computadoraExtraMensual: null,
    computadoraExtraImplementacion: null,
    sucursalExtraMensual: null,
    sucursalExtraImplementacion: null,
    descripcion: 'Para un negocio con una sola computadora.',
  },
  pro: {
    codigo: 'pro',
    nombre: 'MultiCaja',
    modo: 'multicaja',
    mensual: rd(1400),
    implementacion: rd(14000),
    computadoras: 2,
    sucursales: 1,
    computadoraExtraMensual: rd(500),
    computadoraExtraImplementacion: rd(2500),
    sucursalExtraMensual: null,
    sucursalExtraImplementacion: null,
    descripcion: 'Para un local con varias cajas conectadas.',
  },
  plus: {
    codigo: 'plus',
    nombre: 'MultiSucursal',
    modo: 'multisucursal',
    mensual: rd(1800),
    implementacion: rd(16000),
    computadoras: 2, // una por sucursal
    sucursales: 2,
    computadoraExtraMensual: rd(500),
    computadoraExtraImplementacion: rd(3500),
    sucursalExtraMensual: rd(800),
    sucursalExtraImplementacion: null,
    descripcion: 'Para varios locales: incluye una computadora por sucursal.',
  },
};

/** Lo que falta por definir. Se sobrescribe con lo que Emilio guarde en el panel. */
const PRECIOS_POR_DEFINIR = {
  permanente: { basico: null, pro: null, plus: null },
  ecf: { mensual: null, anual: null },
  soporte: { mensual: null, anual: null },
};

const INCLUYE = {
  suscripcion: [
    'Ventas, caja, inventario, clientes, proveedores y reportes',
    'Respaldo local y en la nube',
    'Actualizaciones del sistema',
  ],
  permanente: [
    'Licencia permanente: sin mensualidad y sin vencimiento',
    'Ventas, caja, inventario, clientes, proveedores y reportes del plan elegido',
    'Respaldo local y en la nube',
    'Actualizaciones del sistema',
  ],
  permanenteNoIncluye: [
    'Facturación electrónica DGII (se puede contratar después, sin volver a comprar)',
    'Soporte técnico',
    'Servicios adicionales que se contraten por separado',
  ],
};

const REQUISITOS = [
  'Computadora con Windows 10 u 11 de 64 bits',
  'Internet no es necesario para vender. Se usa para el respaldo en la nube, las actualizaciones, la facturación electrónica y la tienda online',
  'Opcional: impresora térmica, gaveta de dinero, lector de código de barras y báscula',
];

function error(mensaje, code = 'COTIZACION_INVALIDA') {
  return Object.assign(new Error(mensaje), { statusCode: 400, code });
}

function cantidad(valor, nombre) {
  const n = Number(valor ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > MAX_ADICIONALES) throw error(`${nombre}: indica un número entero entre 0 y ${MAX_ADICIONALES}.`);
  return n;
}

function planDe(codigo) {
  const plan = Object.prototype.hasOwnProperty.call(PLANES, codigo) ? PLANES[codigo] : null;
  if (!plan) throw error('Plan inválido. Opciones: basico, pro, plus.');
  return plan;
}

/** El cliente paga 9 meses y recibe 12. */
function anualDesdeMensual(mensual) {
  return mensual === null || mensual === undefined ? null : mensual * MESES_PAGADOS_ANUAL;
}

/** Pesos que escribió Emilio en el panel → centavos. Lo que no sea válido queda sin definir. */
function preciosDefinidos(guardados = {}) {
  const leer = (valor) => {
    const n = Number(valor);
    return valor !== null && valor !== '' && valor !== undefined && Number.isFinite(n) && n >= 0 && n <= 100000000 ? rd(n) : null;
  };
  return {
    permanente: {
      basico: leer(guardados.permanente?.basico),
      pro: leer(guardados.permanente?.pro),
      plus: leer(guardados.permanente?.plus),
    },
    ecf: { mensual: leer(guardados.ecf?.mensual), anual: leer(guardados.ecf?.anual) },
    soporte: { mensual: leer(guardados.soporte?.mensual), anual: leer(guardados.soporte?.anual) },
  };
}

function limitesDelPlan(codigo, { computadorasExtra = 0, sucursalesExtra = 0 } = {}) {
  const plan = planDe(codigo);
  const extraPc = cantidad(computadorasExtra, 'Computadoras adicionales');
  const extraSuc = cantidad(sucursalesExtra, 'Sucursales adicionales');
  if (extraPc && plan.computadoraExtraMensual === null) throw error(`El plan ${plan.nombre} no admite computadoras adicionales: cambia a MultiCaja.`);
  if (extraSuc && plan.sucursalExtraMensual === null) throw error(`El plan ${plan.nombre} no admite sucursales adicionales: cambia a MultiSucursal.`);
  // Cada sucursal adicional trae su computadora.
  return { computadoras: plan.computadoras + extraPc + extraSuc, sucursales: plan.sucursales + extraSuc };
}

/**
 * @param {object} o
 * @param {string} o.plan basico | pro | plus
 * @param {string} o.modalidad mensual | anual | LIFETIME_NO_SUBSCRIPTION
 * @param {boolean} [o.incluirImplementacion] solo la compra inicial, nunca una renovación
 * @param {object} [o.servicios] { ecf: 'mensual'|'anual', soporte: 'mensual'|'anual' }
 * @param {object} [o.precios] lo guardado en el panel (en pesos)
 * @returns {{ lineas, totales, pendientes, limites }}
 */
function cotizar({
  plan: codigo, modalidad, computadorasExtra = 0, sucursalesExtra = 0, incluirImplementacion = false, servicios = {}, precios = {},
} = {}) {
  const plan = planDe(codigo);
  if (!Object.values(MODALIDADES).includes(modalidad)) throw error('Modalidad inválida. Opciones: mensual, anual o pago único.');
  const extraPc = cantidad(computadorasExtra, 'Computadoras adicionales');
  const extraSuc = cantidad(sucursalesExtra, 'Sucursales adicionales');
  const limites = limitesDelPlan(codigo, { computadorasExtra: extraPc, sucursalesExtra: extraSuc });
  const definidos = preciosDefinidos(precios);
  const anual = modalidad === MODALIDADES.ANUAL;
  const permanente = modalidad === MODALIDADES.PERMANENTE;
  const periodo = permanente ? 'unico' : anual ? 'anual' : 'mensual';
  const delPeriodo = (mensual) => (anual ? anualDesdeMensual(mensual) : mensual);

  const lineas = [];
  const pendientes = [];
  const agregar = (tipo, concepto, cuantos, unitario, per) => {
    if (!cuantos) return;
    if (unitario === null || unitario === undefined) pendientes.push(concepto);
    lineas.push({
      tipo, concepto, cantidad: cuantos, periodo: per, unitario: unitario ?? null, total: unitario === null || unitario === undefined ? null : unitario * cuantos,
    });
  };

  if (permanente) agregar('licencia', `Licencia permanente ${plan.nombre}`, 1, definidos.permanente[codigo], 'unico');
  else agregar('licencia', `Licencia ${plan.nombre}`, 1, delPeriodo(plan.mensual), periodo);

  // A la licencia permanente no se le ha definido precio por equipo o sucursal adicional.
  agregar('adicional', 'Computadora adicional', extraPc, permanente ? null : delPeriodo(plan.computadoraExtraMensual), periodo);
  agregar('adicional', 'Sucursal adicional', extraSuc, permanente ? null : delPeriodo(plan.sucursalExtraMensual), periodo);

  if (incluirImplementacion) {
    agregar('implementacion', `Implementación ${plan.nombre}`, 1, plan.implementacion, 'unico');
    agregar('implementacion', 'Implementación de computadora adicional', extraPc, plan.computadoraExtraImplementacion, 'unico');
    agregar('implementacion', 'Implementación de sucursal adicional', extraSuc, plan.sucursalExtraImplementacion, 'unico');
  }

  for (const [clave, nombre] of [['ecf', 'Facturación electrónica'], ['soporte', 'Soporte técnico']]) {
    const per = servicios?.[clave];
    if (!per) continue;
    if (per !== 'mensual' && per !== 'anual') throw error(`${nombre}: indica mensual o anual.`);
    agregar('servicio', nombre, 1, definidos[clave][per], per);
  }

  const suma = (tipo) => lineas.filter((l) => l.tipo === tipo).reduce((s, l) => s + (l.total || 0), 0);
  const totales = {
    licencia: suma('licencia'),
    adicionales: suma('adicional'),
    implementacion: suma('implementacion'),
    servicios: suma('servicio'),
  };
  totales.recurrente = permanente ? totales.servicios : totales.licencia + totales.adicionales + totales.servicios;
  totales.total = totales.licencia + totales.adicionales + totales.implementacion + totales.servicios;
  return { plan: codigo, modalidad, periodo, lineas, totales, pendientes, limites };
}

function formatoRD(centavos) {
  if (centavos === null || centavos === undefined) return 'Consultar';
  const decimales = centavos % 100 === 0 ? 0 : 2;
  return `RD$${(centavos / 100).toLocaleString('en-US', { minimumFractionDigits: decimales, maximumFractionDigits: decimales })}`;
}

/** Todo lo que necesita una pantalla de precios. */
function catalogo(precios = {}) {
  const definidos = preciosDefinidos(precios);
  return {
    moneda: 'DOP',
    mesesPagadosAnual: MESES_PAGADOS_ANUAL,
    mesesServicioAnual: MESES_SERVICIO_ANUAL,
    planes: Object.values(PLANES).map((p) => ({
      ...p,
      anual: anualDesdeMensual(p.mensual),
      computadoraExtraAnual: anualDesdeMensual(p.computadoraExtraMensual),
      sucursalExtraAnual: anualDesdeMensual(p.sucursalExtraMensual),
      permanente: definidos.permanente[p.codigo],
    })),
    servicios: { ecf: definidos.ecf, soporte: definidos.soporte },
    incluye: INCLUYE,
    requisitos: REQUISITOS,
  };
}

module.exports = {
  MODALIDADES,
  MESES_PAGADOS_ANUAL,
  MESES_SERVICIO_ANUAL,
  PLANES,
  PRECIOS_POR_DEFINIR,
  anualDesdeMensual,
  catalogo,
  cotizar,
  formatoRD,
  limitesDelPlan,
  preciosDefinidos,
};

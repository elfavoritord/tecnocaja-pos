'use strict';

/**
 * server/sync/control-center/servicios.js
 *
 * Empresas de servicios (business_type srv_* / config.service_company): no
 * tienen inventario ni cajas. La app de reportes les muestra lo que manejan:
 * lo cobrado, las facturas por cobrar, las cotizaciones y el trabajo de su
 * tipo de servicio (órdenes, proyectos, contratos…).
 *
 *   perfilDelNegocio(config, servicio) → appMode, vertical y módulos. Los
 *       módulos salen de js/business-config.js, la misma lista que arma el
 *       menú del POS: si un tipo de servicio no tiene "Órdenes" en el POS,
 *       tampoco aparece en la app.
 *   collectServicios(query, periods) → filas de las tablas svc_* (solo lectura).
 *   buildServicios(raw, …) → controlCenter/services de un alcance y su
 *       versión liviana para el resumen.
 *
 * Las facturas de servicios ya van espejadas en `sales`, así que lo facturado
 * sale de las ventas de siempre; aquí va lo que el espejo no cubre: los cobros
 * (svc_invoice_payments) y el saldo real de cada factura.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const periodsLib = require('./periods');
const labels = require('./labels');
const { num, round2 } = require('./facts');

const MAX_ITEMS = 25;
const MAX_INVOICES = 40;
const MAX_DEBTORS = 30;
const MAX_PAYMENTS = 15;
const CONTRATO_POR_VENCER_DIAS = 30;
const CALENDARIO_DIAS = 7;
const RESERVA_SALIDA_DIAS = 7;

// ── Perfil del negocio ──────────────────────────────────────────────────────

// Módulo del POS (js/business-config.js) → módulo de trabajo en la app.
const MODULO_POS = {
  'srv-cotizaciones': 'cotizaciones',
  'srv-ordenes': 'ordenes',
  'srv-proyectos': 'proyectos',
  'srv-contratos': 'contratos',
  'srv-calendario': 'calendario',
  'srv-seguridad': 'seguridad',
  'srv-mantenimiento': 'mantenimiento',
  'srv-reservaciones': 'reservaciones',
  'srv-campanas': 'campanas',
  'srv-obras': 'obras',
};

let perfilesPos = null;

// js/business-config.js es código del navegador (cuelga todo de window): se
// corre aparte, una sola vez. Si no se puede leer, cada negocio de servicios
// queda con cotizaciones, que todos tienen.
function perfilesDelPos() {
  if (perfilesPos) return perfilesPos;
  try {
    const file = path.join(__dirname, '..', '..', '..', 'js', 'business-config.js');
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { timeout: 1000 });
    perfilesPos = sandbox.window.businessConfig || {};
  } catch (_error) {
    perfilesPos = {};
  }
  return perfilesPos;
}

function esServicio(config = {}, servicio = {}) {
  return String(config.business_type || '').startsWith('srv_') || Number(servicio.service_company || 0) === 1;
}

function perfilDelNegocio(config = {}, servicio = {}) {
  if (!esServicio(config, servicio)) return { appMode: 'pos', vertical: null, verticalLabel: null, modules: [] };
  const vertical = String(servicio.service_vertical || config.business_type || '').trim() || null;
  const perfil = perfilesDelPos()[vertical] || {};
  const modules = [...new Set((perfil.modules || []).map((m) => MODULO_POS[m]).filter(Boolean))];
  return {
    appMode: 'servicios',
    vertical,
    verticalLabel: perfil.verticalMeta?.label || 'Empresa de servicios',
    modules: modules.length ? modules : ['cotizaciones'],
  };
}

// ── Lectura ─────────────────────────────────────────────────────────────────

function dia(value) {
  return value ? periodsLib.toDayKey(value) : null;
}

const MODULOS = {
  cotizaciones: {
    label: 'Cotizaciones',
    openLabel: 'abiertas',
    attentionLabel: 'vencidas',
    amountLabel: 'Monto abierto',
    sql: `SELECT id, numero, client_name, branch_id, fecha, validez_dias, estado, total
            FROM svc_quotations WHERE estado IN ('borrador', 'enviada', 'aprobada')
           ORDER BY fecha DESC, id DESC LIMIT 500`,
    item: (r, today) => {
      const vence = dia(r.fecha) ? periodsLib.addDays(dia(r.fecha), num(r.validez_dias)) : null;
      return {
        number: r.numero,
        title: r.client_name || 'Cliente sin nombre',
        // En el POS ya no hay borrador ni enviada: lo abierto es "aprobada".
        status: 'aprobada',
        date: vence,
        dateLabel: 'Válida hasta',
        amount: round2(num(r.total)),
        late: Boolean(vence) && vence < today,
      };
    },
    alert: (n) => `${n} cotizaci${n === 1 ? 'ón vencida' : 'ones vencidas'} sin facturar`,
  },
  ordenes: {
    label: 'Órdenes de trabajo',
    openLabel: 'abiertas',
    attentionLabel: 'atrasadas',
    sql: `SELECT id, numero, titulo, client_name, branch_id, estado, prioridad, responsable_nombre, fecha_programada, hora
            FROM svc_work_orders WHERE estado IN ('pendiente', 'asignada', 'en_proceso')
           ORDER BY fecha_programada, id LIMIT 500`,
    item: (r, today) => ({
      number: r.numero,
      title: r.titulo || 'Orden de trabajo',
      client: r.client_name || null,
      status: r.estado,
      note: [r.responsable_nombre, r.prioridad && r.prioridad !== 'normal' ? `Prioridad ${r.prioridad}` : null, r.hora]
        .filter(Boolean).join(' · ') || null,
      date: dia(r.fecha_programada),
      dateLabel: 'Programada',
      late: Boolean(dia(r.fecha_programada)) && dia(r.fecha_programada) < today,
    }),
    alert: (n) => `${n} orden${n === 1 ? '' : 'es'} de trabajo atrasada${n === 1 ? '' : 's'}`,
  },
  proyectos: {
    label: 'Proyectos',
    openLabel: 'activos',
    attentionLabel: 'atrasados',
    amountLabel: 'Presupuesto',
    sql: `SELECT id, numero, nombre, client_name, branch_id, estado, avance_pct, fecha_entrega, presupuesto, responsable_nombre
            FROM svc_projects WHERE estado IN ('planificacion', 'en_progreso', 'pausado')
           ORDER BY fecha_entrega, id LIMIT 500`,
    item: (r, today) => ({
      number: r.numero,
      title: r.nombre || 'Proyecto',
      client: r.client_name || null,
      status: r.estado,
      note: r.responsable_nombre || null,
      date: dia(r.fecha_entrega),
      dateLabel: 'Entrega',
      amount: round2(num(r.presupuesto)),
      progress: Math.max(0, Math.min(100, Math.round(num(r.avance_pct)))),
      late: Boolean(dia(r.fecha_entrega)) && dia(r.fecha_entrega) < today,
    }),
    alert: (n) => `${n} proyecto${n === 1 ? '' : 's'} pasado${n === 1 ? '' : 's'} de la fecha de entrega`,
  },
  contratos: {
    label: 'Contratos',
    openLabel: 'activos',
    attentionLabel: 'por vencer',
    amountLabel: 'Monto de los contratos',
    sql: `SELECT id, numero, titulo, client_name, branch_id, estado, monto, frecuencia, fecha_fin
            FROM svc_contracts WHERE estado = 'activo'
           ORDER BY fecha_fin, id LIMIT 500`,
    item: (r, today) => {
      const fin = dia(r.fecha_fin);
      return {
        number: r.numero,
        title: r.titulo || 'Contrato',
        client: r.client_name || null,
        status: fin && fin < today ? 'vencido' : 'activo',
        note: r.frecuencia ? `Cobro ${String(r.frecuencia).toLowerCase()}` : null,
        date: fin,
        dateLabel: 'Termina',
        amount: round2(num(r.monto)),
        late: Boolean(fin) && fin <= periodsLib.addDays(today, CONTRATO_POR_VENCER_DIAS),
      };
    },
    alert: (n) => `${n} contrato${n === 1 ? '' : 's'} vence${n === 1 ? '' : 'n'} en ${CONTRATO_POR_VENCER_DIAS} días o menos`,
  },
  calendario: {
    label: 'Servicios programados',
    openLabel: `próximos ${CALENDARIO_DIAS} días`,
    attentionLabel: 'atrasados',
    sql: `SELECT id, titulo, client_name, branch_id, estado, fecha, hora, empleado_nombre
            FROM svc_scheduled_services WHERE estado IN ('programado', 'reprogramado')
           ORDER BY fecha, hora, id LIMIT 500`,
    // Solo lo atrasado y lo de los próximos días; lo lejano no cuenta.
    keep: (item, today) => item.date && item.date <= periodsLib.addDays(today, CALENDARIO_DIAS),
    countOpen: (item, today) => item.date >= today,
    item: (r, today) => ({
      number: null,
      title: r.titulo || 'Servicio',
      client: r.client_name || null,
      status: r.estado,
      note: [r.hora, r.empleado_nombre].filter(Boolean).join(' · ') || null,
      date: dia(r.fecha),
      dateLabel: 'Fecha',
      late: Boolean(dia(r.fecha)) && dia(r.fecha) < today,
    }),
    alert: (n) => `${n} servicio${n === 1 ? '' : 's'} programado${n === 1 ? '' : 's'} sin hacer`,
  },
  seguridad: {
    label: 'Puestos de seguridad',
    openLabel: 'activos',
    attentionLabel: null,
    amountLabel: 'Tarifa mensual',
    sql: `SELECT id, numero, nombre, client_name, branch_id, estado, ubicacion, guardias_requeridos, tarifa_mensual
            FROM svc_security_posts WHERE estado = 'activo'
           ORDER BY nombre, id LIMIT 500`,
    item: (r) => ({
      number: r.numero,
      title: r.nombre || 'Puesto',
      client: r.client_name || null,
      status: r.estado,
      note: [`${num(r.guardias_requeridos)} guardia${num(r.guardias_requeridos) === 1 ? '' : 's'}`, r.ubicacion].filter(Boolean).join(' · '),
      amount: round2(num(r.tarifa_mensual)),
      late: false,
    }),
  },
  mantenimiento: {
    label: 'Mantenimientos',
    openLabel: 'planes activos',
    attentionLabel: 'vencidos',
    // Los planes no llevan sucursal: la del equipo.
    sql: `SELECT mp.id, mp.titulo, mp.tipo, mp.estado, mp.proxima_fecha, mp.responsable_nombre,
                 e.nombre AS equipo, e.client_name, e.branch_id
            FROM svc_maintenance_plans mp
            LEFT JOIN svc_equipment e ON e.id = mp.equipment_id
           WHERE mp.estado = 'activo'
           ORDER BY mp.proxima_fecha, mp.id LIMIT 500`,
    item: (r, today) => ({
      number: null,
      title: r.titulo || 'Mantenimiento',
      client: r.client_name || null,
      status: r.estado,
      note: [r.equipo, r.responsable_nombre].filter(Boolean).join(' · ') || null,
      date: dia(r.proxima_fecha),
      dateLabel: 'Próximo',
      late: Boolean(dia(r.proxima_fecha)) && dia(r.proxima_fecha) < today,
    }),
    alert: (n) => `${n} mantenimiento${n === 1 ? '' : 's'} vencido${n === 1 ? '' : 's'}`,
  },
  reservaciones: {
    label: 'Reservaciones',
    openLabel: 'activas',
    attentionLabel: 'salen pronto con saldo',
    amountLabel: 'Saldo pendiente',
    sql: `SELECT id, numero, titulo, client_name, branch_id, estado, destino, fecha_salida, total, saldo
            FROM svc_reservations WHERE estado IN ('cotizada', 'confirmada', 'en_curso')
           ORDER BY fecha_salida, id LIMIT 500`,
    item: (r, today) => {
      const salida = dia(r.fecha_salida);
      const saldo = round2(num(r.saldo));
      return {
        number: r.numero,
        title: r.titulo || 'Reservación',
        client: r.client_name || null,
        status: r.estado,
        note: r.destino || null,
        date: salida,
        dateLabel: 'Salida',
        amount: saldo,
        late: saldo > 0.009 && Boolean(salida) && salida <= periodsLib.addDays(today, RESERVA_SALIDA_DIAS),
      };
    },
    alert: (n) => `${n} reservaci${n === 1 ? 'ón sale' : 'ones salen'} pronto con saldo pendiente`,
  },
  campanas: {
    label: 'Campañas',
    openLabel: 'activas',
    attentionLabel: 'pasadas de fecha',
    amountLabel: 'Presupuesto',
    sql: `SELECT id, numero, nombre, client_name, branch_id, estado, canal, fecha_fin, presupuesto
            FROM svc_campaigns WHERE estado IN ('planificacion', 'activa', 'pausada')
           ORDER BY fecha_fin, id LIMIT 500`,
    item: (r, today) => ({
      number: r.numero,
      title: r.nombre || 'Campaña',
      client: r.client_name || null,
      status: r.estado,
      note: r.canal ? `Canal ${r.canal}` : null,
      date: dia(r.fecha_fin),
      dateLabel: 'Termina',
      amount: round2(num(r.presupuesto)),
      late: Boolean(dia(r.fecha_fin)) && dia(r.fecha_fin) < today,
    }),
    alert: (n) => `${n} campaña${n === 1 ? '' : 's'} pasada${n === 1 ? '' : 's'} de su fecha de fin`,
  },
  obras: {
    label: 'Obras',
    openLabel: 'en curso',
    attentionLabel: 'atrasadas',
    amountLabel: 'Presupuesto',
    sql: `SELECT id, numero, nombre, client_name, branch_id, estado, avance_pct, fecha_fin_estimada, presupuesto, responsable_nombre
            FROM svc_construction_sites WHERE estado IN ('en_curso', 'pausada')
           ORDER BY fecha_fin_estimada, id LIMIT 500`,
    item: (r, today) => ({
      number: r.numero,
      title: r.nombre || 'Obra',
      client: r.client_name || null,
      status: r.estado,
      note: r.responsable_nombre || null,
      date: dia(r.fecha_fin_estimada),
      dateLabel: 'Entrega estimada',
      amount: round2(num(r.presupuesto)),
      progress: Math.max(0, Math.min(100, Math.round(num(r.avance_pct)))),
      late: Boolean(dia(r.fecha_fin_estimada)) && dia(r.fecha_fin_estimada) < today,
    }),
    alert: (n) => `${n} obra${n === 1 ? '' : 's'} pasada${n === 1 ? '' : 's'} de la entrega estimada`,
  },
};

const ESTADO_LABELS = {
  aprobada: 'Abierta',
  pendiente: 'Pendiente',
  asignada: 'Asignada',
  en_proceso: 'En proceso',
  planificacion: 'Planificación',
  en_progreso: 'En progreso',
  pausado: 'Pausado',
  pausada: 'Pausada',
  activo: 'Activo',
  activa: 'Activa',
  vencido: 'Vencido',
  programado: 'Programado',
  reprogramado: 'Reprogramado',
  cotizada: 'Cotizada',
  confirmada: 'Confirmada',
  en_curso: 'En curso',
  parcial: 'Pago parcial',
};

function estadoLabel(code) {
  return ESTADO_LABELS[code] || labels.humanize(code || '');
}

/**
 * Filas de las tablas svc_* del negocio (todas las sucursales; el alcance se
 * aplica al armar cada documento). Una consulta que falle deja su parte vacía
 * y avisa en `warnings`.
 */
async function collectServicios(query, periods, { modules = [], warnings = [] } = {}) {
  const safe = async (label, sql, params = []) => {
    try {
      return await query(sql, params);
    } catch (error) {
      warnings.push(`servicios (${label}): ${String(error?.message || error).slice(0, 160)}`);
      return [];
    }
  };
  const p = periods.periods;
  const paymentsFrom = [p.week.fromDay, p.month.fromDay, p.yesterday.fromDay].sort()[0];

  const [openInvoices, payments, recentPayments, ...moduleRows] = await Promise.all([
    safe('facturas por cobrar',
      `SELECT id, numero, client_id, client_name, branch_id, fecha, vencimiento, total, balance, estado
         FROM svc_invoices
        WHERE estado IN ('pendiente', 'parcial') AND balance > 0.009
        ORDER BY COALESCE(vencimiento, fecha), id`),
    safe('cobros',
      `SELECT p.fecha, COALESCE(p.metodo, 'efectivo') AS pm, p.branch_id AS b,
              COUNT(*) AS n, COALESCE(SUM(p.monto), 0) AS total
         FROM svc_invoice_payments p
        WHERE p.anulado_at IS NULL AND p.fecha BETWEEN ? AND ?
        GROUP BY p.fecha, COALESCE(p.metodo, 'efectivo'), p.branch_id`,
      [paymentsFrom, periods.today]),
    safe('últimos cobros',
      `SELECT p.id, p.fecha, p.monto, COALESCE(p.metodo, 'efectivo') AS pm, p.branch_id AS b,
              p.created_by_user_name AS user_name, i.numero, i.client_name
         FROM svc_invoice_payments p
         LEFT JOIN svc_invoices i ON i.id = p.invoice_id
        WHERE p.anulado_at IS NULL
        ORDER BY p.fecha DESC, p.id DESC
        LIMIT 60`),
    ...modules.map((key) => (MODULOS[key] ? safe(MODULOS[key].label.toLowerCase(), MODULOS[key].sql) : Promise.resolve([]))),
  ]);

  const work = {};
  modules.forEach((key, i) => { work[key] = moduleRows[i] || []; });
  return { openInvoices, payments, recentPayments, work };
}

// ── Documentos ──────────────────────────────────────────────────────────────

function inScope(branchId, scopeKey) {
  return scopeKey === null || (branchId !== null && branchId !== undefined && String(branchId) === scopeKey);
}

function byLateThenDate(a, b) {
  if (a.late !== b.late) return a.late ? -1 : 1;
  if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.date && !b.date) return -1;
  if (!a.date && b.date) return 1;
  return 0;
}

function buildCollections(rows, periods, scopeKey, catalog) {
  const p = periods.periods;
  const ranges = { today: p.today, yesterday: p.yesterday, week: p.week, month: p.month };
  const out = {};
  for (const key of Object.keys(ranges)) out[key] = { count: 0, amount: 0 };
  const byMethod = new Map();
  for (const r of rows) {
    if (!inScope(r.b, scopeKey)) continue;
    const day = dia(r.fecha);
    for (const [key, range] of Object.entries(ranges)) {
      if (day >= range.fromDay && day <= range.toDay) {
        out[key].count += num(r.n);
        out[key].amount = round2(out[key].amount + num(r.total));
      }
    }
    if (day >= p.month.fromDay && day <= p.month.toDay) {
      const code = String(r.pm);
      const acc = byMethod.get(code) || { code, label: labels.paymentLabel(code, catalog.paymentLabels), amount: 0, count: 0 };
      acc.amount = round2(acc.amount + num(r.total));
      acc.count += num(r.n);
      byMethod.set(code, acc);
    }
  }
  out.monthByMethod = [...byMethod.values()].sort((a, b) => b.amount - a.amount);
  return out;
}

function buildReceivables(rows, today, scopeKey) {
  const invoices = [];
  const debtors = new Map();
  let total = 0;
  let overdueCount = 0;
  let overdueAmount = 0;
  for (const r of rows) {
    if (!inScope(r.branch_id, scopeKey)) continue;
    const balance = round2(num(r.balance));
    const date = dia(r.fecha);
    const due = dia(r.vencimiento);
    const late = Boolean(due) && due < today;
    total = round2(total + balance);
    if (late) {
      overdueCount += 1;
      overdueAmount = round2(overdueAmount + balance);
    }
    invoices.push({
      id: String(r.id),
      number: r.numero,
      client: r.client_name || 'Cliente sin nombre',
      date,
      dueDate: due,
      total: round2(num(r.total)),
      balance,
      status: r.estado,
      statusLabel: estadoLabel(r.estado),
      late,
      daysOverdue: late ? periodsLib.diffDays(due, today) : 0,
      branchId: r.branch_id ? String(r.branch_id) : null,
    });
    const key = r.client_id ? `c${r.client_id}` : `n${String(r.client_name || '').trim().toLowerCase()}`;
    const debtor = debtors.get(key) || { name: r.client_name || 'Cliente sin nombre', invoices: 0, balance: 0, overdue: false, oldestDate: null };
    debtor.invoices += 1;
    debtor.balance = round2(debtor.balance + balance);
    debtor.overdue = debtor.overdue || late;
    if (date && (!debtor.oldestDate || date < debtor.oldestDate)) debtor.oldestDate = date;
    debtors.set(key, debtor);
  }
  invoices.sort((a, b) => b.daysOverdue - a.daysOverdue || String(a.dueDate || a.date).localeCompare(String(b.dueDate || b.date)));
  const debtorList = [...debtors.values()]
    .map((d) => ({ ...d, oldestDays: d.oldestDate ? periodsLib.diffDays(d.oldestDate, today) : null }))
    .sort((a, b) => b.balance - a.balance);
  return {
    total,
    invoices: invoices.length,
    overdueCount,
    overdueAmount,
    debtorsCount: debtorList.length,
    items: invoices.slice(0, MAX_INVOICES),
    debtors: debtorList.slice(0, MAX_DEBTORS),
  };
}

function buildModule(key, rows, today, scopeKey) {
  const def = MODULOS[key];
  let items = [];
  for (const r of rows) {
    if (!inScope(r.branch_id, scopeKey)) continue;
    const item = {
      id: String(r.id),
      number: null,
      client: null,
      note: null,
      date: null,
      dateLabel: null,
      amount: null,
      progress: null,
      ...def.item(r, today),
      branchId: r.branch_id ? String(r.branch_id) : null,
    };
    item.statusLabel = estadoLabel(item.status);
    if (def.keep && !def.keep(item, today)) continue;
    items.push(item);
  }
  const open = def.countOpen ? items.filter((i) => def.countOpen(i, today)).length : items.length;
  const attention = def.attentionLabel ? items.filter((i) => i.late).length : 0;
  const amount = def.amountLabel ? round2(items.reduce((sum, i) => sum + (i.amount || 0), 0)) : null;
  items = items.sort(byLateThenDate);
  return {
    key,
    label: def.label,
    open,
    openLabel: def.openLabel,
    attention,
    attentionLabel: def.attentionLabel,
    amount,
    amountLabel: def.amountLabel || null,
    items: items.slice(0, MAX_ITEMS),
    more: Math.max(0, items.length - MAX_ITEMS),
  };
}

/**
 * controlCenter/services del alcance (`scopeKey` null = todo el negocio) y su
 * versión liviana para el resumen. null si el negocio no es de servicios.
 */
function buildServicios({ profile, raw, periods, scopeKey = null, catalog }) {
  if (!profile || profile.appMode !== 'servicios' || !raw) return null;
  const today = periods.today;
  const collections = buildCollections(raw.payments || [], periods, scopeKey, catalog);
  const receivables = buildReceivables(raw.openInvoices || [], today, scopeKey);
  const modules = profile.modules
    .filter((key) => MODULOS[key])
    .map((key) => buildModule(key, raw.work?.[key] || [], today, scopeKey));
  const recentPayments = (raw.recentPayments || [])
    .filter((r) => inScope(r.b, scopeKey))
    .slice(0, MAX_PAYMENTS)
    .map((r) => ({
      id: String(r.id),
      date: dia(r.fecha),
      amount: round2(num(r.monto)),
      method: labels.paymentLabel(r.pm, catalog.paymentLabels),
      invoice: r.numero || null,
      client: r.client_name || 'Cliente sin nombre',
      user: r.user_name || null,
    }));

  const doc = {
    vertical: profile.vertical,
    verticalLabel: profile.verticalLabel,
    collections,
    receivables,
    recentPayments,
    modules,
  };
  const light = {
    collections: {
      today: collections.today,
      yesterday: collections.yesterday,
      week: collections.week,
      month: collections.month,
    },
    receivables: {
      total: receivables.total,
      invoices: receivables.invoices,
      overdueCount: receivables.overdueCount,
      overdueAmount: receivables.overdueAmount,
      debtorsCount: receivables.debtorsCount,
    },
    modules: modules.map(({ items: _items, more: _more, ...m }) => m),
  };
  return { doc, light };
}

/** Alertas propias de una empresa de servicios. */
function serviciosAlerts(services, money) {
  if (!services) return [];
  const out = [];
  const r = services.receivables;
  if (r.overdueCount > 0) {
    out.push({
      id: 'services-overdue',
      severity: 'warning',
      category: 'receivables',
      module: 'receivables',
      count: r.overdueCount,
      title: `${r.overdueCount} factura${r.overdueCount === 1 ? '' : 's'} vencida${r.overdueCount === 1 ? '' : 's'} sin cobrar`,
      message: `Total: ${money(r.overdueAmount)}.`,
    });
  }
  for (const m of services.modules) {
    const def = MODULOS[m.key];
    if (!def?.alert || m.attention <= 0) continue;
    out.push({
      id: `services-${m.key}`,
      severity: 'warning',
      category: 'services',
      module: `services:${m.key}`,
      count: m.attention,
      title: def.alert(m.attention),
      message: m.items.filter((i) => i.late).slice(0, 3).map((i) => i.title).join(', '),
    });
  }
  return out;
}

module.exports = {
  MODULOS,
  perfilDelNegocio,
  collectServicios,
  buildServicios,
  serviciosAlerts,
};

'use strict';

/**
 * server/sync/control-center/alerts.js
 *
 * Centro de alertas: reglas simples sobre las secciones ya armadas. Cada
 * alerta dice a qué módulo de la app lleva (`module`) para que sea accionable.
 * Severidad: critical (rojo), warning (naranja), info (azul), success (verde).
 *
 * Las alertas que dependen de la hora del teléfono (POS sin publicar hace
 * rato, terminal sin conexión) las calcula la app, no el POS.
 */

const CASH_DIFFERENCE_TOLERANCE = 5; // mismo criterio que "Cerrada ⚠" del POS
const ECF_PENDING_MINUTES = 30;

function money(value) {
  const n = Number(value) || 0;
  return `RD$ ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function names(list, max = 3, field = 'name') {
  const shown = list.slice(0, max).map((item) => item[field]).filter(Boolean);
  const rest = list.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} y ${rest} más` : shown.join(', ');
}

function minutesSince(wallText, nowText) {
  const from = Date.parse(String(wallText || '').replace(' ', 'T'));
  const to = Date.parse(String(nowText || '').replace(' ', 'T'));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 60000);
}

function buildAlerts({ inventory, cash, receivables, fiscal, delivery, sync, today, nowText, branchKey = null }) {
  const alerts = [];
  const push = (alert) => alerts.push({ branchId: branchKey, count: 1, ...alert });

  if (inventory) {
    if (inventory.outOfStockCount > 0) {
      push({
        id: 'inventory-out',
        severity: 'critical',
        category: 'inventory',
        module: 'inventory',
        count: inventory.outOfStockCount,
        title: `${inventory.outOfStockCount} producto${inventory.outOfStockCount === 1 ? '' : 's'} agotado${inventory.outOfStockCount === 1 ? '' : 's'}`,
        message: names(inventory.outOfStock),
      });
    }
    if (inventory.lowStockCount > 0) {
      push({
        id: 'inventory-low',
        severity: 'warning',
        category: 'inventory',
        module: 'inventory',
        count: inventory.lowStockCount,
        title: `${inventory.lowStockCount} producto${inventory.lowStockCount === 1 ? '' : 's'} con inventario bajo`,
        message: names(inventory.lowStock),
      });
    }
  }

  if (fiscal) {
    const rejected = fiscal.documents.filter((d) => d.group === 'rejected');
    if (rejected.length > 0) {
      push({
        id: 'ecf-rejected',
        severity: 'critical',
        category: 'fiscal',
        module: 'fiscal',
        count: rejected.length,
        title: `${rejected.length} e-CF rechazado${rejected.length === 1 ? '' : 's'} por la DGII`,
        message: names(rejected, 3, 'encf'),
      });
    }
    if (fiscal.open.error > 0) {
      push({
        id: 'ecf-error',
        severity: 'critical',
        category: 'fiscal',
        module: 'fiscal',
        count: fiscal.open.error,
        title: `${fiscal.open.error} e-CF con error`,
        message: 'Revisa el módulo Facturación electrónica del POS.',
      });
    }
    const waiting = fiscal.open.pending + fiscal.open.inProcess;
    const waitingMinutes = minutesSince(fiscal.open.oldestAt, nowText);
    if (waiting > 0 && (waitingMinutes === null || waitingMinutes >= ECF_PENDING_MINUTES)) {
      push({
        id: 'ecf-pending',
        severity: 'warning',
        category: 'fiscal',
        module: 'fiscal',
        count: waiting,
        title: `${waiting} e-CF pendiente${waiting === 1 ? '' : 's'} de la DGII`,
        message: fiscal.open.oldestAt ? `El más antiguo es del ${fiscal.open.oldestAt.slice(0, 16)}.` : '',
      });
    }
    for (const seq of fiscal.sequences) {
      if (!['vencido', 'agotado', 'proximo_agotarse'].includes(seq.status)) continue;
      const critical = seq.status !== 'proximo_agotarse';
      push({
        id: `ncf-${seq.type}-${seq.branchId || 'global'}`,
        severity: critical ? 'critical' : 'warning',
        category: 'fiscal',
        module: 'fiscal',
        title: seq.status === 'vencido'
          ? `Secuencia ${seq.type} vencida`
          : seq.status === 'agotado'
            ? `Secuencia ${seq.type} agotada`
            : `Secuencia ${seq.type} por agotarse`,
        message: seq.status === 'proximo_agotarse'
          ? `Quedan ${seq.available} comprobantes${seq.branchName ? ` (${seq.branchName})` : ''}.`
          : 'Solicita una nueva secuencia a la DGII.',
      });
    }
  }

  if (cash) {
    const differences = cash.closings.filter((c) => (
      c.difference !== null
      && Math.abs(Number(c.difference)) > CASH_DIFFERENCE_TOLERANCE
      && c.closedAt
      && (minutesSince(c.closedAt, nowText) ?? 0) <= 48 * 60
    ));
    for (const c of differences.slice(0, 5)) {
      push({
        id: `cash-diff-${c.id}`,
        severity: 'critical',
        category: 'cash',
        module: 'cash',
        title: `Diferencia de caja: ${c.registerName}`,
        message: `${Number(c.difference) > 0 ? 'Sobrante' : 'Faltante'} de ${money(Math.abs(c.difference))} al cerrar (${String(c.closedAt).slice(0, 16)}).`,
      });
    }
    const stale = cash.registers.filter((r) => r.session?.staleOpen);
    if (stale.length > 0) {
      push({
        id: 'cash-stale-open',
        severity: 'warning',
        category: 'cash',
        module: 'cash',
        count: stale.length,
        title: `${stale.length} caja${stale.length === 1 ? '' : 's'} pendiente${stale.length === 1 ? '' : 's'} de cierre`,
        message: `${names(stale)} sigue${stale.length === 1 ? '' : 'n'} abierta${stale.length === 1 ? '' : 's'} desde un día anterior.`,
      });
    }
  }

  if (receivables && receivables.overdueDebtorsCount > 0) {
    push({
      id: 'receivables-overdue',
      severity: 'warning',
      category: 'receivables',
      module: 'receivables',
      count: receivables.overdueDebtorsCount,
      title: `${receivables.overdueDebtorsCount} cliente${receivables.overdueDebtorsCount === 1 ? '' : 's'} con deuda de más de 30 días`,
      message: `Total: ${money(receivables.overdueAmount)}.`,
    });
  }

  if (delivery) {
    if (delivery.pendingCash.count > 0) {
      push({
        id: 'delivery-cash',
        severity: 'warning',
        category: 'delivery',
        module: 'delivery',
        count: delivery.pendingCash.count,
        title: `${delivery.pendingCash.count} cobro${delivery.pendingCash.count === 1 ? '' : 's'} contra entrega sin liquidar`,
        message: `Total: ${money(delivery.pendingCash.amount)}.`,
      });
    }
    const incidents = delivery.active.filter((o) => o.status === 'incidencia');
    if (incidents.length > 0) {
      push({
        id: 'delivery-incidents',
        severity: 'warning',
        category: 'delivery',
        module: 'delivery',
        count: incidents.length,
        title: `${incidents.length} pedido${incidents.length === 1 ? '' : 's'} con incidencia`,
        message: names(incidents, 3, 'invoice'),
      });
    }
  }

  if (sync) {
    if (Number(sync.cloud?.errors || 0) > 0) {
      push({
        id: 'sync-errors',
        severity: 'info',
        category: 'sync',
        module: 'sync',
        count: Number(sync.cloud.errors),
        title: `${sync.cloud.errors} elemento${Number(sync.cloud.errors) === 1 ? '' : 's'} con error de sincronización`,
        message: sync.cloud.lastError ? String(sync.cloud.lastError).slice(0, 160) : 'Se reintentará automáticamente.',
      });
    } else if (Number(sync.cloud?.pending || 0) > 20) {
      push({
        id: 'sync-pending',
        severity: 'info',
        category: 'sync',
        module: 'sync',
        count: Number(sync.cloud.pending),
        title: `${sync.cloud.pending} datos esperando subir a la nube`,
        message: 'Se suben solos cuando hay Internet.',
      });
    }
    if (Number(sync.pendingEcf || 0) > 0) {
      push({
        id: 'sync-ecf-deferred',
        severity: 'info',
        category: 'sync',
        module: 'fiscal',
        count: Number(sync.pendingEcf),
        title: `${sync.pendingEcf} e-CF firmado${Number(sync.pendingEcf) === 1 ? '' : 's'} sin Internet`,
        message: 'Se envían a la DGII cuando vuelve la conexión.',
      });
    }
  }

  const order = { critical: 0, warning: 1, info: 2, success: 3 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity]);
  return alerts.map((a) => ({ ...a, day: today }));
}

module.exports = { buildAlerts, CASH_DIFFERENCE_TOLERANCE };

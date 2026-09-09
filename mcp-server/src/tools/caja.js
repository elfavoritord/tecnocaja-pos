import { z } from 'zod';
import { money, num, reply, errorReply } from '../lib/format.js';

export function registerCajaTools(server, pos) {
  server.registerTool(
    'estado_caja',
    {
      title: 'Estado de caja',
      description:
        'Sesiones de caja recientes (aperturas/cierres): monto inicial, esperado vs. contado, diferencia, ingresos/egresos y si sigue abierta.',
      inputSchema: {
        limite: z.number().int().min(1).max(50).optional().describe('Cuántas sesiones (def. 10)'),
        soloAbiertas: z.boolean().optional().describe('Solo sesiones abiertas ahora mismo'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limite = 10, soloAbiertas = false }) => {
      try {
        const data = await pos.get('/api/reports/cash-open-close');
        let rows = Array.isArray(data) ? data : data.rows || data.sessions || [];
        if (soloAbiertas) rows = rows.filter((r) => String(r.status || '').toLowerCase() === 'open');
        const shown = rows.slice(0, limite);

        const lines = shown.map((r) => {
          const abierta = String(r.status || '').toLowerCase() === 'open';
          const dif = Number(r.difference_amount ?? r.difference ?? 0);
          return [
            `- #${r.id} ${r.branch_name || ''}${r.cash_register_name ? ` / ${r.cash_register_name}` : ''}`,
            abierta ? '· ABIERTA' : '· cerrada',
            `· inicial ${money(r.opened_amount)}`,
            abierta
              ? `· en caja ${money(r.current_amount)}`
              : `· esperado ${money(r.expected_amount)} vs contado ${money(r.counted_amount)} (dif ${money(dif)})`,
          ].join(' ');
        });

        const abiertas = rows.filter((r) => String(r.status || '').toLowerCase() === 'open').length;
        return reply(
          [`Sesiones de caja (${abiertas} abierta(s) de ${rows.length}):`, ...lines].join('\n'),
          shown
        );
      } catch (e) {
        return errorReply(e);
      }
    }
  );

  server.registerTool(
    'movimientos_caja',
    {
      title: 'Movimientos de caja recientes',
      description:
        'Últimos movimientos de efectivo registrados en caja (ventas, ingresos, gastos, retiros, cobros de crédito) tomados del snapshot del POS.',
      inputSchema: {
        limite: z.number().int().min(1).max(50).optional().describe('Cuántos movimientos (def. 20)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limite = 20 }) => {
      try {
        const boot = await pos.getBootstrap();
        const movs = [...(boot.movimientosCaja || []), ...(boot.cobrosCredito || [])]
          .sort((a, b) => String(b.hora || '').localeCompare(String(a.hora || '')))
          .slice(0, limite);
        if (!movs.length) return reply('Sin movimientos de caja en el snapshot actual.', []);
        const lines = movs.map(
          (m) => `- ${m.hora || 's/f'} · ${m.tipo} · ${money(m.monto)}${m.obs ? ` · ${m.obs}` : ''} · ${m.usuarioNombre || ''}`
        );
        return reply([`Últimos ${movs.length} movimientos de caja:`, ...lines].join('\n'), movs);
      } catch (e) {
        return errorReply(e);
      }
    }
  );

  server.registerTool(
    'cuentas_por_cobrar',
    {
      title: 'Cuentas por cobrar y por pagar',
      description:
        'Total y detalle de crédito de clientes pendiente de cobro y de facturas de proveedores pendientes de pago, con el balance neto.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const d = await pos.get('/api/reports/advanced/cuentas-pagar-cobrar');
        const s = d.summary || {};
        const t = [
          'Cuentas:',
          `- Por cobrar (clientes): ${money(s.totalReceivable)}`,
          `- Por pagar (proveedores): ${money(s.totalPayable)}`,
          `- Balance neto: ${money(s.netBalance)}`,
        ].join('\n');
        return reply(t, d);
      } catch (e) {
        return errorReply(e);
      }
    }
  );
}

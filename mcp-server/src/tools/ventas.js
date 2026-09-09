import { z } from 'zod';
import { money, num, resolveRange, reply, errorReply } from '../lib/format.js';

const rangeShape = {
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Fecha inicio YYYY-MM-DD'),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Fecha fin YYYY-MM-DD'),
  rango: z
    .enum(['hoy', 'ayer', 'semana', 'mes'])
    .optional()
    .describe('Atajo de rango; ignora desde/hasta si se envía'),
  branchId: z.number().int().positive().optional().describe('ID de sucursal para filtrar'),
};

export function registerVentasTools(server, pos) {
  server.registerTool(
    'ventas_resumen',
    {
      title: 'Resumen de ventas',
      description:
        'KPIs de ventas de un período: total facturado, dinero que entró a caja, ganancia, margen, ITBIS, crédito pendiente y desglose por método de pago. Usa "rango" (hoy/ayer/semana/mes) o "desde"/"hasta".',
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { desde, hasta } = resolveRange(args);
        const k = await pos.get('/api/reports/advanced/kpis', { desde, hasta, branchId: args.branchId });
        const t = [
          `Ventas ${desde === hasta ? `del ${desde}` : `de ${desde} a ${hasta}`}${args.branchId ? ` (sucursal ${args.branchId})` : ''}:`,
          `- Total facturado: ${money(k.total_facturado)}`,
          `- Entró a caja: ${money(k.total_ventas)}`,
          `- Ganancia: ${money(k.ganancia)} (margen ${k.margen}%)`,
          `- ITBIS cobrado: ${money(k.itbis ?? k.tax)}`,
          `- Crédito pendiente del período: ${money(k.credito)}`,
          `- Efectivo ${money(k.efectivo)} · Tarjeta ${money(k.tarjeta)} · Transferencia ${money(k.transferencia)}`,
        ].join('\n');
        return reply(t, k);
      } catch (e) {
        return errorReply(e);
      }
    }
  );

  server.registerTool(
    'ventas_por_dia',
    {
      title: 'Ventas por día',
      description:
        'Serie diaria de ventas (facturas, total neto que entró a caja e ITBIS) para graficar tendencia en un rango de fechas.',
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { desde, hasta } = resolveRange(args);
        const rows = await pos.get('/api/reports/advanced/ventas-dia', { desde, hasta, branchId: args.branchId });
        const total = rows.reduce((s, r) => s + Number(r.total || 0), 0);
        const lines = rows.map((r) => `- ${r.dia}: ${money(r.total)} (${num(r.facturas)} facturas)`);
        return reply([`Ventas por día ${desde} → ${hasta} · total ${money(total)}`, ...lines].join('\n'), rows);
      } catch (e) {
        return errorReply(e);
      }
    }
  );

  server.registerTool(
    'ventas_por_metodo_pago',
    {
      title: 'Ventas por método de pago',
      description:
        'Total y número de facturas por método de pago (efectivo, tarjeta, transferencia, crédito) y cobros de crédito del período, por separado.',
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { desde, hasta } = resolveRange(args);
        const data = await pos.get('/api/reports/advanced/metodos-pago', { desde, hasta, branchId: args.branchId });
        const rows = Array.isArray(data) ? data : data.rows || data.metodos || [];
        const lines = rows.map((r) => `- ${r.metodo}: ${money(r.total)} (${num(r.facturas)} facturas)`);
        return reply([`Métodos de pago ${desde} → ${hasta}`, ...lines].join('\n'), data);
      } catch (e) {
        return errorReply(e);
      }
    }
  );

  server.registerTool(
    'ganancias',
    {
      title: 'Ganancias y rentabilidad',
      description:
        'Utilidad del período: ingreso, ganancia bruta y desglose de ganancia por categoría, por sucursal y por producto.',
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { desde, hasta } = resolveRange(args);
        const data = await pos.get('/api/reports/advanced/ganancias', { desde, hasta, branchId: args.branchId });
        const s = data.summary || data.resumen || data;
        const t = [
          `Ganancias ${desde} → ${hasta}:`,
          `- Ingreso: ${money(s.revenue ?? s.ingreso)}`,
          `- Ganancia: ${money(s.profit ?? s.ganancia)}`,
        ].join('\n');
        return reply(t, data);
      } catch (e) {
        return errorReply(e);
      }
    }
  );

  server.registerTool(
    'dashboard_hoy',
    {
      title: 'Dashboard de hoy',
      description:
        'Foto rápida del día en curso: ventas por tipo de orden (mostrador/delivery/recoger), productos agotados, horas pico y top productos.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const d = await pos.get('/api/reports/dashboard');
        const agotados = (d.productosAgotados || []).map((p) => `  · ${p.nombre} (stock ${p.stock}/${p.stockMin})`);
        const t = [
          'Dashboard de hoy:',
          `- Mostrador ${num(d.ventasMostrador)} · Delivery ${num(d.ventasDelivery)} · Para recoger ${num(d.ventasRecoger)}`,
          `- Productos agotados/bajo mínimo: ${d.productosAgotados?.length || 0}`,
          ...agotados,
        ].join('\n');
        return reply(t, d);
      } catch (e) {
        return errorReply(e);
      }
    }
  );
}

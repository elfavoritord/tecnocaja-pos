import { z } from 'zod';
import { money, num, resolveRange, reply, errorReply } from '../lib/format.js';

export function registerFiscalTools(server, pos) {
  server.registerTool(
    'reporte_dgii',
    {
      title: 'Reporte fiscal DGII (ITBIS / NCF)',
      description:
        'Resumen fiscal de un período: total facturado, monto gravado vs. exento, ITBIS cobrado, ITBIS crédito fiscal, ITBIS a pagar y desglose por tipo de NCF (B01/B02/B14/…).',
      inputSchema: {
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        rango: z.enum(['hoy', 'ayer', 'semana', 'mes']).optional(),
        branchId: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { desde, hasta } = resolveRange(args);
        const d = await pos.get('/api/reports/advanced/dgii', { desde, hasta, branchId: args.branchId });
        const porNcf = (d.porNcf || []).map(
          (r) => `  · ${r.tipoNcf}: ${num(r.facturas)} facturas · ${money(r.total)} · ITBIS ${money(r.itbis)}`
        );
        const t = [
          `Reporte DGII ${desde} → ${hasta}:`,
          `- Facturas: ${num(d.totalFacturas)} · Facturado: ${money(d.totalFacturado)}`,
          `- Gravado: ${money(d.montoGravado)} · Exento: ${money(d.montoExento)}`,
          `- ITBIS cobrado: ${money(d.itbisCobrado)}`,
          `- ITBIS crédito fiscal (compras): ${money(d.itbisCredito)}`,
          `- ITBIS a pagar: ${money(d.itbisPagar)}`,
          'Por tipo de NCF:',
          ...porNcf,
        ].join('\n');
        return reply(t, d);
      } catch (e) {
        return errorReply(e);
      }
    }
  );
}

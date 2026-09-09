import { z } from 'zod';
import { money, num, resolveRange, reply, errorReply } from '../lib/format.js';

export function registerClientesTools(server, pos) {
  server.registerTool(
    'buscar_cliente',
    {
      title: 'Buscar cliente',
      description:
        'Busca clientes por nombre, teléfono, cédula/RNC o email (coincidencia parcial). Devuelve su balance de crédito pendiente y límite de crédito. Los datos vienen del snapshot del POS (se refresca cada pocos minutos).',
      inputSchema: {
        texto: z.string().min(1).describe('Nombre, teléfono, cédula/RNC o email'),
        limite: z.number().int().min(1).max(50).optional().describe('Máx. resultados (def. 15)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ texto, limite = 15 }) => {
      try {
        const boot = await pos.getBootstrap();
        const clientes = boot.clientes || [];
        const q = texto.toLowerCase().trim();
        const hits = clientes
          .filter((c) => {
            const hay = `${c.nombre || ''} ${c.telefono || ''} ${c.cedula || ''} ${c.email || ''}`.toLowerCase();
            return hay.includes(q);
          })
          .slice(0, limite);

        if (!hits.length) return reply(`Sin clientes para "${texto}".`, []);

        const lines = hits.map((c) => {
          const deuda = Number(c.balance || 0);
          return `- ${c.nombre}${c.telefono ? ` · ${c.telefono}` : ''}${c.cedula ? ` · ${c.cedula}` : ''} · deuda ${money(
            deuda
          )}${c.limiteCredito ? ` / límite ${money(c.limiteCredito)}` : ''}`;
        });
        return reply([`${hits.length} cliente(s) para "${texto}":`, ...lines].join('\n'), hits);
      } catch (e) {
        return errorReply(e);
      }
    }
  );

  server.registerTool(
    'top_clientes',
    {
      title: 'Mejores clientes del período',
      description:
        'Ranking de clientes por monto comprado en un rango de fechas: número de facturas, total comprado, ticket promedio, última compra y balance pendiente.',
      inputSchema: {
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        rango: z.enum(['hoy', 'ayer', 'semana', 'mes']).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { desde, hasta } = resolveRange(args);
        const rows = await pos.get('/api/reports/advanced/clientes', { desde, hasta });
        if (!rows.length) return reply(`Sin compras de clientes registradas ${desde} → ${hasta}.`, []);
        const lines = rows.map(
          (r, i) =>
            `${i + 1}. ${r.nombre} · ${money(r.totalComprado)} en ${num(r.facturas)} facturas · ticket ${money(
              r.ticketPromedio
            )} · última ${String(r.ultimaCompra || '').slice(0, 10)}`
        );
        return reply([`Top clientes ${desde} → ${hasta}:`, ...lines].join('\n'), rows);
      } catch (e) {
        return errorReply(e);
      }
    }
  );
}

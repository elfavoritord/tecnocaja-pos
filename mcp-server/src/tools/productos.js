import { z } from 'zod';
import { money, num, resolveRange, reply, errorReply } from '../lib/format.js';

export function registerProductosTools(server, pos) {
  server.registerTool(
    'buscar_producto',
    {
      title: 'Buscar producto',
      description:
        'Busca productos del catálogo por nombre, código o código de barras (coincidencia parcial). Devuelve precio de venta, costo, stock y categoría.',
      inputSchema: {
        texto: z.string().min(1).describe('Nombre, código o código de barras a buscar'),
        limite: z.number().int().min(1).max(50).optional().describe('Máx. resultados (def. 15)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ texto, limite = 15 }) => {
      try {
        const { products = [] } = await pos.get('/api/products');
        const q = texto.toLowerCase().trim();
        const hits = products
          .filter((p) => {
            const hay = `${p.nombre || ''} ${p.codigo || ''} ${p.barcode || ''}`.toLowerCase();
            return hay.includes(q);
          })
          .slice(0, limite);

        if (!hits.length) return reply(`Sin resultados para "${texto}".`, []);

        const lines = hits.map(
          (p) =>
            `- ${p.nombre} [${p.codigo || 's/c'}] · venta ${money(p.precioVenta ?? p.precio_venta)} · costo ${money(
              p.precioCompra ?? p.precio_compra
            )} · stock ${num(p.stock)} · ${p.categoria || 'sin categoría'}`
        );
        return reply(
          [`${hits.length} producto(s) para "${texto}":`, ...lines].join('\n'),
          hits.map((p) => ({
            id: p.id,
            nombre: p.nombre,
            codigo: p.codigo,
            barcode: p.barcode,
            precioVenta: p.precioVenta ?? p.precio_venta,
            precioCompra: p.precioCompra ?? p.precio_compra,
            stock: p.stock,
            stockMin: p.stockMin ?? p.stock_min,
            categoria: p.categoria,
            estado: p.estado,
          }))
        );
      } catch (e) {
        return errorReply(e);
      }
    }
  );

  server.registerTool(
    'stock_bajo',
    {
      title: 'Productos bajo mínimo',
      description:
        'Lista los productos cuyo stock está en o por debajo del mínimo, por sucursal. Útil para saber qué reponer.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const rows = await pos.get('/api/reports/low-stock');
        if (!rows.length) return reply('Ningún producto está bajo mínimo. 👍', []);
        const lines = rows
          .slice(0, 100)
          .map(
            (r) =>
              `- [${r.sucursal}] ${r.nombre} [${r.codigo || 's/c'}] · stock ${num(r.stock)} / mín ${num(r.stockMin)}`
          );
        return reply([`${rows.length} producto(s) bajo mínimo:`, ...lines].join('\n'), rows);
      } catch (e) {
        return errorReply(e);
      }
    }
  );

  server.registerTool(
    'inventario_por_sucursal',
    {
      title: 'Inventario por sucursal',
      description:
        'Existencias de todos los productos por sucursal (stock, mínimo, precio de venta y costo). Puede ser una lista larga.',
      inputSchema: {
        sucursal: z.string().optional().describe('Filtra por nombre de sucursal (parcial)'),
        limite: z.number().int().min(1).max(500).optional().describe('Máx. filas (def. 200)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sucursal, limite = 200 }) => {
      try {
        let rows = await pos.get('/api/reports/inventory-by-branch');
        if (sucursal) {
          const s = sucursal.toLowerCase();
          rows = rows.filter((r) => String(r.sucursal || '').toLowerCase().includes(s));
        }
        const shown = rows.slice(0, limite);
        const valorCosto = rows.reduce((a, r) => a + Number(r.stock || 0) * Number(r.precioCompra || 0), 0);
        const lines = shown.map(
          (r) => `- [${r.sucursal}] ${r.nombre} · stock ${num(r.stock)} / mín ${num(r.stockMin)}`
        );
        return reply(
          [
            `Inventario${sucursal ? ` (sucursal ~"${sucursal}")` : ''}: ${rows.length} líneas · valor a costo ${money(
              valorCosto
            )}`,
            ...lines,
            shown.length < rows.length ? `… (${rows.length - shown.length} más, sube "limite" para ver todo)` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          shown
        );
      } catch (e) {
        return errorReply(e);
      }
    }
  );

  server.registerTool(
    'top_productos',
    {
      title: 'Productos más vendidos',
      description:
        'Ranking de productos por cantidad vendida en un rango de fechas, con total vendido, precio promedio y participación.',
      inputSchema: {
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        rango: z.enum(['hoy', 'ayer', 'semana', 'mes']).optional(),
        limite: z.number().int().min(1).max(100).optional().describe('Máx. productos (def. 20)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { desde, hasta } = resolveRange(args);
        const rows = await pos.get('/api/reports/advanced/productos', {
          desde,
          hasta,
          limit: args.limite || 20,
        });
        const lines = rows.map(
          (r, i) =>
            `${i + 1}. ${r.nombre} · ${num(r.cantidad)} uds · ${money(r.totalVendido)} · ${r.participacion}%`
        );
        return reply([`Top productos ${desde} → ${hasta}:`, ...lines].join('\n'), rows);
      } catch (e) {
        return errorReply(e);
      }
    }
  );
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerVentasTools } from './tools/ventas.js';
import { registerProductosTools } from './tools/productos.js';
import { registerCajaTools } from './tools/caja.js';
import { registerClientesTools } from './tools/clientes.js';
import { registerFiscalTools } from './tools/fiscal.js';

/**
 * Crea un McpServer con todas las herramientas de solo lectura registradas.
 * `pos` es el cliente devuelto por createPosClient().
 */
export function buildMcpServer(pos, { name = 'tecno-caja-pos', version = '0.1.0' } = {}) {
  const server = new McpServer(
    { name, version },
    {
      instructions:
        'Herramientas de SOLO LECTURA sobre el sistema Tecno Caja POS (colmado/tienda en República Dominicana). ' +
        'Sirven para consultar ventas, ganancias, inventario, caja, clientes y reportes fiscales DGII. ' +
        'Los montos están en pesos dominicanos (DOP). Ninguna herramienta modifica datos.',
    }
  );

  registerVentasTools(server, pos);
  registerProductosTools(server, pos);
  registerCajaTools(server, pos);
  registerClientesTools(server, pos);
  registerFiscalTools(server, pos);

  return server;
}

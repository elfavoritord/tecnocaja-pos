/**
 * probe.mjs — Probador rápido del MCP usando el token de máquina (sin OAuth).
 *
 * Uso (desde mcp-server/):
 *   node probe.mjs                              → llama ventas_resumen (rango hoy)
 *   node probe.mjs list                         → lista las herramientas
 *   node probe.mjs stock_bajo                   → herramienta sin argumentos
 *   node probe.mjs ventas_resumen rango=mes     → argumentos como clave=valor
 *   node probe.mjs top_productos rango=mes limite=10
 */
import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const PORT = process.env.MCP_PORT || '3400';
const TOKEN = process.env.MCP_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('Falta MCP_ACCESS_TOKEN en .env (el probador usa el token de máquina).');
  process.exit(1);
}

const arg = process.argv[2] || 'ventas_resumen';
const rest = process.argv.slice(3);

let args = {};
if (rest.length === 1 && rest[0].trim().startsWith('{')) {
  args = JSON.parse(rest[0]); // por si alguien pasa JSON de una
} else if (rest.length) {
  for (const pair of rest) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const k = pair.slice(0, i);
    let v = pair.slice(i + 1);
    if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    else if (v === 'true' || v === 'false') v = v === 'true';
    args[k] = v;
  }
} else if (arg === 'ventas_resumen') {
  args = { rango: 'hoy' };
}

const body =
  arg === 'list'
    ? { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    : { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: arg, arguments: args } };

const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${TOKEN}`,
  },
  body: JSON.stringify(body),
});

let text = await res.text();
if ((res.headers.get('content-type') || '').includes('event-stream')) {
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  text = line ? line.slice(6) : text;
}

try {
  const j = JSON.parse(text);
  if (j.error) {
    console.log(`\n[${res.status}] error MCP:`, j.error.message);
  } else if (arg === 'list') {
    console.log('\nHerramientas:\n' + j.result.tools.map((t) => ` - ${t.name}: ${t.title || ''}`).join('\n'));
  } else {
    const out = (j.result?.content || []).map((c) => c.text).join('\n\n');
    console.log('\n' + (out || JSON.stringify(j.result, null, 2)));
  }
} catch {
  console.log(`\n[${res.status}]`, text);
}

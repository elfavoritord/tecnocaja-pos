# Tecno Caja — Servidor MCP (solo lectura del POS, OAuth 2.1)

Servidor [MCP (Model Context Protocol)](https://modelcontextprotocol.io) que le da a **Claude** y **ChatGPT** acceso de **solo lectura** a los datos del POS Tecno Caja: ventas, ganancias, inventario, caja y clientes.

- **No modifica nada.** Todas las herramientas son consultas.
- Habla con el backend del POS (`server.js`, puerto 3399) por HTTP, reusando su lógica y su autenticación. **No toca la base de datos directamente.**
- Transporte **Streamable HTTP** (stateless) en el puerto `3400`.
- **Autenticación OAuth 2.1** con login propio (usuario/clave que tú defines), Dynamic Client Registration y PKCE — el flujo que esperan los conectores de ChatGPT y Claude web/móvil.
- Proceso aparte: no se toca `server.js` ni el monolito.

## Herramientas expuestas

| Herramienta | Qué devuelve |
|---|---|
| `ventas_resumen` | KPIs de un período: facturado, caja, ganancia, margen, ITBIS, crédito, métodos de pago |
| `ventas_por_dia` | Serie diaria de ventas para tendencia |
| `ventas_por_metodo_pago` | Total y nº de facturas por método de pago |
| `ganancias` | Utilidad del período con desglose por categoría/sucursal/producto |
| `dashboard_hoy` | Foto del día: órdenes por tipo, agotados, horas pico |
| `buscar_producto` | Busca por nombre/código/barcode → precio, costo, stock |
| `stock_bajo` | Productos en o bajo el mínimo, por sucursal |
| `inventario_por_sucursal` | Existencias completas por sucursal + valor a costo |
| `top_productos` | Ranking de más vendidos en un rango |
| `estado_caja` | Sesiones de caja: apertura/cierre, esperado vs contado, diferencia |
| `movimientos_caja` | Últimos movimientos de efectivo (del snapshot del POS) |
| `cuentas_por_cobrar` | Crédito de clientes por cobrar + facturas de proveedores por pagar |
| `buscar_cliente` | Busca por nombre/teléfono/cédula/email → deuda y límite |
| `top_clientes` | Mejores clientes por monto comprado en un rango |
| `reporte_dgii` | Resumen fiscal: gravado/exento, ITBIS cobrado/crédito/a pagar, por tipo de NCF |

Rangos: casi todas aceptan `rango` (`hoy`/`ayer`/`semana`/`mes`) o `desde`/`hasta` en `YYYY-MM-DD`.

## Puesta en marcha

### 1. Instalar

```bash
cd mcp-server
npm install
```

### 2. Crear un usuario dedicado en el POS

En el POS: **Configuración → Usuarios → Nuevo**. Rol **administrador** (necesita ver Reportes). Anota usuario y contraseña. No reutilices el usuario del dueño.

### 3. Túnel Cloudflare con nombre fijo (obligatorio para OAuth)

OAuth necesita una URL pública **estable** (el `redirect_uri` y el `issuer` no pueden cambiar en cada reinicio), así que el *quick tunnel* no sirve para dejarlo conectado.

```powershell
winget install --id Cloudflare.cloudflared -e     # si no lo tienes
cloudflared tunnel login
cloudflared tunnel create mcp-tecnocaja
# Enruta un hostname tuyo (DNS gestionado por Cloudflare) al túnel:
cloudflared tunnel route dns mcp-tecnocaja mcp.tudominio.com
```

Config del túnel (`~/.cloudflared/config.yml` o el que uses):

```yaml
tunnel: mcp-tecnocaja
credentials-file: C:\Users\TU_USUARIO\.cloudflared\<id>.json
ingress:
  - hostname: mcp.tudominio.com
    service: http://127.0.0.1:3400
  - service: http_status:404
```

### 4. Configurar `.env`

```bash
cp .env.example .env
```

Rellena:

- `MCP_PUBLIC_URL` — la URL pública **https** del túnel, ej. `https://mcp.tudominio.com` (sin barra final).
- `MCP_AUTH_USER` / `MCP_AUTH_PASSWORD` — el usuario/clave con el que **tú** inicias sesión al conectar el conector.
- `POS_MCP_USER` / `POS_MCP_PASSWORD` — el usuario del POS del paso 2.
- `MCP_ACCESS_TOKEN` — *opcional*. Si lo pones, se acepta como Bearer sin pasar por OAuth (cómodo para Claude Code / curl). Déjalo vacío para exigir OAuth siempre.

### 5. Arrancar

Con el POS corriendo (`npm run desktop` en la raíz):

```powershell
# opción A: servidor + túnel juntos
.\scripts\start-mcp-with-tunnel.ps1 -Tunnel mcp-tecnocaja

# opción B: por separado
cd mcp-server ; npm start
# y en otra terminal:
cloudflared tunnel run mcp-tecnocaja
```

Comprueba: `curl https://mcp.tudominio.com/healthz` y
`curl https://mcp.tudominio.com/.well-known/oauth-authorization-server`.

## Conectar los clientes

### ChatGPT

Ajustes → **Conectores** → *Modo desarrollador* → **Agregar**:

- URL del servidor MCP: `https://mcp.tudominio.com/mcp`
- Autenticación: **OAuth** (ChatGPT descubre solo los endpoints, se registra por DCR y abre el login).
- Se abre la pantalla *"Conectar con tecno-caja-pos"* → entra con `MCP_AUTH_USER` / `MCP_AUTH_PASSWORD`.

### Claude (web / móvil / escritorio)

Ajustes → **Conectores** → **Agregar conector personalizado**:

- URL: `https://mcp.tudominio.com/mcp`
- Claude hace el mismo flujo OAuth y muestra el login.

### Claude Code (local, sin OAuth)

Con `MCP_ACCESS_TOKEN` definido en el `.env`:

```bash
claude mcp add tecno-caja --transport http http://127.0.0.1:3400/mcp \
  --header "Authorization: Bearer EL_MCP_ACCESS_TOKEN"
```

Sin token de máquina, usa el shim `mcp-remote`, que también hace el baile OAuth:

```json
{
  "mcpServers": {
    "tecno-caja": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.tudominio.com/mcp"]
    }
  }
}
```

## Cómo funciona la autenticación

```
Cliente (ChatGPT/Claude)                 MCP server (este proyecto)
  │  POST /mcp  (sin token)                     │
  │ ───────────────────────────────────────────►│  401 + WWW-Authenticate:
  │ ◄───────────────────────────────────────────┤  resource_metadata=".../oauth-protected-resource/mcp"
  │  GET /.well-known/oauth-protected-resource/mcp   → { authorization_servers:[issuer] }
  │  GET /.well-known/oauth-authorization-server     → { authorize, token, register, S256 }
  │  POST /register  (DCR)                            → { client_id }
  │  GET /authorize?...&code_challenge=...       │  render pantalla de login (usuario/clave)
  │  POST /oauth/login  (credenciales)           │  valida → 302 redirect_uri?code=...
  │  POST /token  (code + code_verifier PKCE)    │  → { access_token, refresh_token }
  │  POST /mcp  Authorization: Bearer <access>   │  ✓ herramientas disponibles
```

- **PKCE S256 obligatorio** (lo verifica la SDK de MCP).
- **Access token**: opaco, en memoria, caduca en `MCP_TOKEN_TTL_SEC` (1 h por defecto).
- **Refresh token**: opaco, persistido en `mcp-server/.oauth-store.json`, se **rota** en cada uso.
- **Clientes DCR**: persistidos en el mismo archivo (sobreviven reinicios → no hay que reconectar el conector).
- `MCP_AUTH_USER`/`MCP_AUTH_PASSWORD` se comparan en tiempo constante (hash SHA-256 + `timingSafeEqual`).
- El **token de máquina** (`MCP_ACCESS_TOKEN`) es un atajo opcional que se salta OAuth; si no lo defines, solo entra quien complete el flujo.

## Tests

```bash
cd mcp-server
npm test          # node --test: pos-client + OAuth provider + herramientas (transport en memoria)
```

## Notas de diseño

- **Stateless**: cada request HTTP a `/mcp` crea su propio `McpServer` + transporte y los descarta.
- **Re-login automático** contra el POS si devuelve `401`.
- **Snapshot con TTL**: `buscar_cliente` y `movimientos_caja` usan el `data` del login del POS (no hay endpoint REST para listar clientes), refrescado cada `POS_BOOTSTRAP_TTL_MS`.
- **El MCP es su propio Authorization Server** (login propio). Si algún día quieres login con Google / usuarios del POS, se cambia el `OAuthServerProvider` en `src/oauth/provider.js` sin tocar el resto.
- **Fase 2 / 3** (pendientes): conectar `tecno-caja-contadores` y la plataforma SaaS Firestore como backends adicionales del mismo MCP, con prefijo de herramienta.

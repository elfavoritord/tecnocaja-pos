# Offline-First Multicaja/Multisucursal - Especificación Técnica

## Versión: 1.0
## Fecha: May 2, 2026

---

## 1. VISIÓN GENERAL

Sistema que permite que una PC secundaria autorizada en una red multicaja/multisucursal continúe operando (vendiendo, cobrando, movimientos de caja) aunque pierda conexión temporalmente con la PC principal, y se sincronice automáticamente cuando vuelve la conexión.

### 1.1 Flujo de Vida de una Terminal Secundaria

```
1. PRIMER ARRANQUE (sin terminal-config.json)
   ↓
2. Mostrar overlay "Conectar a servidor principal"
   ↓
3. Buscar/escribir IP del servidor principal (auto-discovery)
   ↓
4. Conectar y autenticar como admin/supervisor
   ↓
5. Asignar sucursal + caja + rol
   ↓
6. Descargar CACHÉ LOCAL (productos, clientes, usuarios, config)
   ↓
7. Guardar terminal-config.json + datos en BD local offline_cache_*
   ↓
8. ONLINE: Pueda trabajar
   ↓
9. PIERDE CONEXIÓN: Detecta automáticamente
   ↓
10. OFFLINE: Continúa vendiendo con inventario cacheado
    - Marca ventas: origin='offline', pending_sync=1, terminal_id
    ↓
11. RECUPERA CONEXIÓN: Detecta automáticamente
    ↓
12. SINCRONIZACIÓN: Sube ventas pendientes → Principal
    - Principal valida + descuenta inventario
    - Descargar nuevos productos/clientes/config
    - Marcar como syncronizado
    ↓
13. Volver a ONLINE

```

---

## 2. ARQUITECTURA OFFLINE

### 2.1 Almacenamiento Local (SQLite en secundaria)

```
Tablas nuevas en BD secundaria:

┌─ CACHÉ ─────────────────────────────────────────────┐
│                                                       │
│  offline_terminal_cache                              │
│    - id, terminal_id, principal_host                 │
│    - principal_base_url, branch_id, cash_register_id │
│    - last_full_sync (timestamp)                      │
│    - is_online (boolean)                             │
│    - sync_status (online/offline/syncing)            │
│                                                       │
│  offline_cache_products                              │
│    - product_id, codigo, nombre, precio_venta        │
│    - stock_cached, last_updated                      │
│                                                       │
│  offline_cache_clients                               │
│    - client_id, nombre, cedula, balance              │
│    - limite_credito, last_updated                    │
│                                                       │
│  offline_cache_users                                 │
│    - user_id, usuario, nombre, rol, permisos         │
│    - puede_vender, puede_cobrar, last_updated        │
│                                                       │
│  offline_cache_config                                │
│    - config_key, config_value, last_updated          │
│    (invoice_next_number, tax_rate, etc.)             │
│                                                       │
│  offline_cache_payment_methods                       │
│    - id, codigo, nombre, last_updated                │
│                                                       │
└─────────────────────────────────────────────────────┘

┌─ PENDIENTES ─────────────────────────────────────────┐
│                                                        │
│  pending_sales                                        │
│    - id, terminal_id, offline_invoice_id              │
│    - sale_data (JSON serialized)                      │
│    - status (pending/syncing/synced/error)            │
│    - error_message, created_at, synced_at             │
│                                                        │
│  pending_sale_items                                   │
│    - id, pending_sale_id, item_data (JSON)            │
│                                                        │
│  pending_cash_movements                               │
│    - id, terminal_id, movement_type, amount           │
│    - status (pending/synced/error)                    │
│    - created_at, synced_at                            │
│                                                        │
│  sync_log                                             │
│    - id, terminal_id, sync_phase                      │
│    - items_uploaded, items_downloaded                 │
│    - error_count, started_at, completed_at            │
│    - result (ok/partial/error)                        │
│                                                        │
└─────────────────────────────────────────────────────┘
```

### 2.2 Detección de Conexión (Cliente)

```javascript
// Monitor en js/app.js o nuevo js/offline-manager.js

class OfflineManager {
  constructor() {
    this.isOnline = navigator.onLine;
    this.syncInterval = null;
    this.checkInterval = 2000; // cada 2 seg
  }

  init() {
    window.addEventListener('online', () => this.onlineRecovered());
    window.addEventListener('offline', () => this.offlineDetected());
    this.startHealthCheck();
  }

  async healthCheck() {
    try {
      const res = await fetch('/api/health', { timeout: 1500 });
      return res.ok;
    } catch {
      return false;
    }
  }

  async offlineDetected() {
    this.isOnline = false;
    showOfflineBanner('Trabajando sin conexión con el servidor principal');
    // Permitir venta en modo offline
  }

  async onlineRecovered() {
    this.isOnline = true;
    hideOfflineBanner();
    // Iniciar sincronización automática
    await this.triggerSync();
  }

  async triggerSync() {
    // Llamar a /api/offline/sync-pending
  }
}
```

---

## 3. FLUJO DE VENTA OFFLINE

### 3.1 Crear Venta (origen=offline)

```
Cuando terminal.isOnline = false:

1. Usuario completa venta normalmente
2. Sistema genera ID local:
   - Formato: {terminalId}#{secuencial}#{timestamp}
   - Ejemplo: a1b2c3d4#0001#1714761600000
   ↓
3. Guardar en pending_sales:
   {
     terminal_id: "a1b2c3d4",
     offline_invoice_id: "a1b2c3d4#0001#1714761600000",
     origin: "offline",
     sale_data: {
       items: [...],
       total: 1500.00,
       payment_method: "efectivo",
       client_id: null,
       user_id: 5,
       created_at: "2026-05-02T10:30:00Z",
       terminal_branch_id: 2,
       terminal_cash_register_id: 14
     },
     status: "pending",
     created_at: "2026-05-02T10:30:05Z"
   }
   ↓
4. Restar del inventario cacheado LOCALMENTE
   (No tocar BD principal hasta sync)
   ↓
5. Mostrar comprobante local (mark como OFFLINE)
   ↓
6. Registrar en pending_cash_movements
   {
     terminal_id: "a1b2c3d4",
     movement_type: "venta_offline",
     amount: 1500.00,
     reference_sale_id: "a1b2c3d4#0001#1714761600000",
     status: "pending"
   }
```

### 3.2 Cobrar Pendiente (origen=offline)

```
Si cliente compró a crédito:

1. Registrar pago en pending_cash_movements
   {
     terminal_id: "a1b2c3d4",
     movement_type: "cobro_pendiente_offline",
     amount: 500.00,
     reference_sale_id: "a1b2c3d4#0001#1714761600000",
     client_id: 42,
     status: "pending"
   }
   ↓
2. Reducir balance local del cliente en offline_cache_clients
   ↓
3. Marcar como sincronización pendiente
```

---

## 4. SINCRONIZACIÓN (cuando vuelve conexión)

### 4.1 Fases de Sincronización

```
FASE 1: UPLOAD (terminal → principal)
─────────────────────────────────────

POST /api/offline/sync-pending
{
  terminal_id: "a1b2c3d4",
  pending_sales: [
    { offline_id, sale_data, items },
    { offline_id, sale_data, items }
  ],
  pending_movements: [
    { type, amount, reference_sale_id }
  ]
}

Servidor principal:
1. Valida que terminal_id sea conocido
2. Para cada pending_sale:
   - Genera invoice_number único
   - Descuenta inventario de la sucursal
   - Inserta en BD principal con origin='terminal_secondary', terminal_id
   - Retorna { offline_id, real_invoice_number, status }
3. Retorna lista de inserciones exitosas + errores
4. Registra en sync_log


FASE 2: DOWNLOAD (principal → terminal)
──────────────────────────────────────

GET /api/offline/sync-updates?lastSync=...

Servidor principal retorna:
{
  products: [productos actualizados],
  clients: [clientes nuevos/actualizados],
  config: {nueva configuración},
  payment_methods: [métodos actualizados],
  status: "ok"
}

Terminal actualiza:
- offline_cache_products
- offline_cache_clients
- offline_cache_config
- offline_cache_payment_methods
- sync_log con timestamp


FASE 3: CONFIRM (terminal → principal)
──────────────────────────────────────

POST /api/offline/sync-confirm
{
  terminal_id: "a1b2c3d4",
  synced_ids: ["a1b2c3d4#0001#...", ...],
  last_sync_timestamp: "2026-05-02T11:00:00Z"
}

Servidor principal:
- Marca como sincronizado en sync_log
- Envía confirmación
```

### 4.2 Manejo de Duplicados

```
Cada pending_sale tiene ID único:
  offline_id = terminal_id + timestamp + secuencial

Si sincronización falla a medio camino:
1. Terminal reintenta
2. Servidor verifica offline_id en tabla principal
3. Si ya existe → retorna el invoice_number existente
   (no duplica)
4. Terminal marca como sincronizado

Tabla en principal:
  offline_sync_map (
    offline_id STRING UNIQUE,
    real_invoice_id INT,
    terminal_id,
    synced_at
  )
```

---

## 5. RESTRICCIONES EN MODO OFFLINE

### 5.1 PERMITIDO (can_*):

- ✅ Ver productos cacheados
- ✅ Buscar/filtrar clientes cacheados
- ✅ Crear ventas
- ✅ Cobrar ventas pendientes
- ✅ Imprimir comprobante local
- ✅ Registrar movimientos de caja
- ✅ Ver usuarios autorizados
- ✅ Cambiar de usuario (si está en caché)

### 5.2 NO PERMITIDO (cannot_*):

- ❌ Crear productos
- ❌ Editar precios globales
- ❌ Crear clientes nuevos
- ❌ Eliminar ventas
- ❌ Cambiar configuración fiscal
- ❌ Crear usuarios administradores
- ❌ Exportar base de datos
- ❌ Ver datos de otras sucursales
- ❌ Anular cierres de caja

---

## 6. ESTADOS VISUALES

### 6.1 Indicadores en UI

```
┌────────────────────────────────────────┐
│ BANNER DE CONEXIÓN (TOP)               │
│                                         │
│ 🟢 Online - Conectado a: 192.168.1.100 │ (verde)
│ 🔴 Offline - Trabajando localmente     │ (rojo)
│ 🟡 Sincronizando... 45%                │ (amarillo, con barra)
│ 🔵 Sincronización completada           │ (azul)
│ 🔴 Error en sincronización             │ (rojo oscuro, click para reintentar)
│                                         │
└────────────────────────────────────────┘

┌────────────────────────────────────────┐
│ BADGE EN VENTAS (OFFLINE)              │
│                                         │
│ [Venta] Ticket #1001                   │
│ 🔄 Pendiente sincronización            │
│ Total: RD$ 1,500.00                    │
│                                         │
└────────────────────────────────────────┘
```

### 6.2 Panel de Pendientes

```
Panel → "Sincronización" (nueva tab)

┌─────────────────────────────────────────┐
│ ESTADO GENERAL                          │
│ ────────────────────────────────────    │
│ Modo: OFFLINE / ONLINE                  │
│ Última sincronización: 2h ago           │
│                                         │
│ PENDIENTES DE SINCRONIZAR               │
│ ────────────────────────────────────    │
│ • 12 ventas                             │
│ • 5 pagos cobrados                      │
│ • 8 movimientos de caja                 │
│                                         │
│ INVENTARIO LOCAL (OFFLINE)              │
│ ────────────────────────────────────    │
│ Productos cacheados: 487                │
│ Última actualización: 1h ago            │
│ [↻ Actualizar] (si online)              │
│                                         │
│ ERRORES DE SINCRONIZACIÓN               │
│ ────────────────────────────────────    │
│ • Venta #0001: Inventario insuficiente  │
│   [Revisar] [Descartar]                 │
│                                         │
│ [SINCRONIZAR AHORA] (activo si hay pendientes)
│                                         │
└─────────────────────────────────────────┘
```

---

## 7. SEGURIDAD

### 7.1 Validación

- ✅ Terminal debe tener terminal-config.json válido
- ✅ Terminal debe estar autorizada en principal
- ✅ Usuario debe estar en offline_cache_users
- ✅ offline_id debe ser único (prevent duplicados)
- ✅ Validar firma/token local para ventas offline

### 7.2 Datos Sensibles

- ❌ NO guardar contraseñas en caché (solo hash)
- ❌ NO guardar info fiscal sensible en local
- ✅ Guardar permisos/rol de usuario
- ✅ Guardar productos + precios (no son sensibles)
- ✅ Guardar clientes (teléfono, dirección, OK)

---

## 8. TABLAS NUEVAS EN BD

(Ver sección 2.1 para detalle SQL)

```sql
-- En BD SECUNDARIA (SQLite local)
offline_terminal_cache
offline_cache_products
offline_cache_clients
offline_cache_users
offline_cache_config
offline_cache_payment_methods
pending_sales
pending_sale_items
pending_cash_movements
sync_log

-- En BD PRINCIPAL (MySQL, para mapeo)
offline_sync_map (offline_id → real_invoice_id)
```

---

## 9. ENDPOINTS NUEVOS

### Backend (server.js)

```
POST   /api/offline/prepare-terminal
       → Descargar caché completo para terminal (primera vez)

GET    /api/offline/sync-updates?lastSync=...
       → Descargar actualizaciones (productos, clientes, config)

POST   /api/offline/sync-pending
       → Subir ventas + movimientos pendientes

POST   /api/offline/sync-confirm
       → Confirmar que sincronización se completó

GET    /api/offline/status
       → Ver estado actual (online/offline/syncing, pendientes, etc.)

POST   /api/offline/cancel-pending
       → Cancelar venta offline (solo modo offline)

GET    /api/health
       → Health check (usado para detectar conexión)
```

---

## 10. FASES DE IMPLEMENTACIÓN

### Fase 1: Schema + Helpers (semana 1)
- Agregar tablas SQL
- Crear funciones de caché en server.js
- Endpoints básicos

### Fase 2: Detección + UI (semana 2)
- Monitor de conexión en frontend
- Banners visuales
- Panel de sincronización

### Fase 3: Ventas Offline (semana 2-3)
- Lógica de venta sin conexión
- Generación de ID único offline
- Almacenamiento en pending_sales

### Fase 4: Sincronización (semana 3-4)
- Upload de pending → principal
- Download de actualizaciones
- Manejo de duplicados + errores

### Fase 5: Testing + Hardening (semana 4)
- Pruebas de desconexión
- Conflictos de inventario
- Recovery de fallos

---

## 11. MÉTRICAS DE ÉXITO

- ✅ Terminal secundaria opera 100% offline
- ✅ Sin duplicados en ventas sincronizadas
- ✅ Sincronización < 30 seg (100 ventas)
- ✅ Recuperación automática de errores
- ✅ UI clara de estado online/offline
- ✅ Panel de pendientes funcional

---

## Fin de Especificación

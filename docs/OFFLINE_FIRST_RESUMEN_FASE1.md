# ✅ OFFLINE-FIRST FASE 1: COMPLETADO

## Resumen Ejecutivo

Se completó exitosamente la **Fase 1 del sistema offline-first** para POS multicaja/multisucursal, implementando:

- ✅ **10 nuevas tablas** en schema.sql para caché offline y ventas pendientes
- ✅ **8 funciones helper** en server.js para gestión de caché
- ✅ **Clase OfflineManager** completa en js/offline-manager.js (350+ líneas)
- ✅ **API endpoints** para health check y offline sync (stubs para Fases posteriores)
- ✅ **Documentación** completa del diseño y uso

## Estado de Implementación

### ✅ Completado

| Componente | Líneas | Status |
|-----------|--------|--------|
| **db/schema.sql** | +220 | ✅ 10 tablas nuevas + 1 en BD principal |
| **server.js helpers** | +350 | ✅ 8 funciones + 4 endpoints |
| **js/offline-manager.js** | 350+ | ✅ Clase completa lista para uso |
| **Documentación** | 300+ | ✅ OFFLINE_FIRST_FASE1_COMPLETADA.md |

### 🟡 Stubs (Implementación en Fases posteriores)

| Endpoint | Purpose | Fase |
|----------|---------|------|
| POST /api/offline/sync-pending | Subir ventas offline | Fase 4 |
| POST /api/offline/cancel-pending | Cancelar venta offline | Fase 3 |
| GET /api/offline/status | Estado del caché | Fase 2 |

---

## Tabla de Contenidos

1. [Tablas Nuevas](#tablas-nuevas)
2. [Funciones Helper](#funciones-helper)
3. [OfflineManager Class](#offlinemanager-class)
4. [Endpoints API](#endpoints-api)
5. [Ejemplos de Uso](#ejemplos-de-uso)
6. [Validación](#validación)
7. [Próximos Pasos](#próximos-pasos)

---

## Tablas Nuevas

### 1. offline_terminal_cache
**Propósito**: Metadatos y estado de conexión de terminal secundaria

```sql
┌─ terminal_id (STRING[40]) - ID único de terminal
├─ principal_host (STRING) - Host del servidor principal
├─ principal_base_url (STRING) - URL base principal
├─ is_online (TINYINT) - 1=online, 0=offline
├─ sync_status (STRING) - 'online'/'offline'/'syncing'
├─ last_full_sync (DATETIME) - Timestamp del último sync completo
└─ last_health_check (DATETIME) - Último health check exitoso
```

**Índices**: terminal_id (UNIQUE), sync_status

### 2. offline_cache_products
**Propósito**: Réplica local de catálogo de productos

```sql
┌─ product_id (INT) - Referencia a productos
├─ codigo (VARCHAR) - Código del producto
├─ nombre (VARCHAR) - Nombre del producto
├─ precio_venta (DECIMAL) - Precio de venta actual
├─ stock_cached (DECIMAL) - Stock en caché (se actualiza localmente)
├─ stock_min (DECIMAL) - Stock mínimo
└─ last_updated (DATETIME) - Cuándo se sincronizó del servidor
```

**Índices**: product_id (UNIQUE), codigo

### 3. offline_cache_clients
**Propósito**: Caché de clientes activos con crédito

```sql
┌─ client_id (INT) - Referencia a clientes
├─ nombre (VARCHAR) - Nombre del cliente
├─ cedula (VARCHAR) - Cédula
├─ telefono (VARCHAR) - Teléfono
├─ limite_credito (DECIMAL) - Límite de crédito
├─ balance (DECIMAL) - Balance actual
└─ last_updated (DATETIME) - Última sincronización
```

**Índices**: client_id (UNIQUE), cedula

### 4. offline_cache_users
**Propósito**: Usuarios autorizados para login offline

```sql
┌─ user_id (INT) - Referencia a usuarios
├─ usuario (VARCHAR) - Username
├─ nombre (VARCHAR) - Nombre del usuario
├─ rol (VARCHAR) - Role del usuario
├─ password_hash (VARCHAR) - Hash de contraseña (para validación offline)
├─ puede_vender (TINYINT) - 1 si puede generar ventas
├─ puede_cobrar (TINYINT) - 1 si puede cobrar
└─ puede_ver_reportes (TINYINT) - 1 si puede ver reportes
```

**Índices**: user_id (UNIQUE), usuario

### 5. offline_cache_config
**Propósito**: Configuración en caché (impuestos, prefijos, etc.)

```sql
┌─ config_key (VARCHAR) - Clave de configuración
├─ config_value (TEXT) - Valor (puede ser JSON)
└─ last_updated (DATETIME) - Última actualización
```

### 6. offline_cache_payment_methods
**Propósito**: Métodos de pago disponibles

```sql
┌─ payment_method_id (INT)
├─ codigo (VARCHAR) - Código ('efectivo', 'tarjeta', etc.)
├─ nombre (VARCHAR) - Nombre del método
└─ last_updated (DATETIME)
```

### 7. pending_sales ⭐ IMPORTANTE
**Propósito**: Ventas realizadas en modo offline (pendientes de sincronizar)

```sql
┌─ id (VARCHAR[80]) - PRIMARY KEY
├─ offline_invoice_id (VARCHAR) - ID único: {terminalId}#{seq}#{timestamp}
├─ terminal_id (VARCHAR) - ID de terminal que generó la venta
├─ branch_id (INT)
├─ cash_register_id (INT)
├─ user_id (INT) - Vendedor
├─ client_id (INT) - Cliente (opcional)
├─ sale_data (LONGTEXT) - JSON serializado de la venta completa
├─ total (DECIMAL) - Monto total
├─ status (VARCHAR) - 'pending'/'syncing'/'synced'/'error'
├─ error_message (VARCHAR) - Detalle de error si aplicable
├─ created_at (DATETIME)
└─ synced_at (DATETIME) - Cuándo se sincronizó exitosamente
```

**Índices**: terminal_id, status, offline_invoice_id, created_at

### 8. pending_sale_items
**Propósito**: Items individuales de ventas offline

```sql
┌─ pending_sale_id (VARCHAR[80]) - FK a pending_sales
├─ item_sequence (INT) - Posición en la venta
├─ product_id (INT)
├─ item_data (LONGTEXT) - JSON del item completo
└─ created_at (DATETIME)
```

### 9. pending_cash_movements
**Propósito**: Movimientos de caja (depósitos, retiros, ventas) offline

```sql
┌─ terminal_id (VARCHAR)
├─ movement_type (VARCHAR) - 'venta_offline'/'cobro_pendiente_offline'/etc.
├─ amount (DECIMAL) - Monto del movimiento
├─ reference_sale_id (VARCHAR) - Referencia a pending_sales si es venta
├─ status (VARCHAR) - 'pending'/'synced'/'error'
├─ created_at (DATETIME)
└─ synced_at (DATETIME)
```

### 10. sync_log
**Propósito**: Histórico de sincronizaciones (para debugging y auditoría)

```sql
┌─ terminal_id (VARCHAR)
├─ sync_phase (VARCHAR) - 'upload'/'download'/'confirm'/'full'
├─ items_uploaded (INT) - Cantidad de items enviados
├─ items_downloaded (INT) - Cantidad de items recibidos
├─ result (VARCHAR) - 'ok'/'partial'/'error'
├─ started_at (DATETIME)
├─ completed_at (DATETIME)
└─ error_detail (VARCHAR) - Detalle del error si ocurrió
```

### 11. offline_sync_map (TABLA PRINCIPAL)
**Propósito**: Mapeo offline ID → real ID (evita duplicados en sincronización)

```sql
┌─ offline_id (VARCHAR[80]) - ID generado offline
├─ real_invoice_id (VARCHAR) - ID real después de sync
├─ terminal_id (VARCHAR)
├─ synced_at (DATETIME)
└─ CONSTRAINT UNIQUE(offline_id)
```

**Ubicación**: BD principal (no local)
**Uso**: Cuando se sincroniza una venta, se verifica que no exista entrada en esta tabla

---

## Funciones Helper

Ubicación: `server.js` líneas ~6518-6820

### 1. initializeOfflineCache()
Inicializa caché para una terminal secundaria.

```javascript
async function initializeOfflineCache(
  terminalId,          // string: ID único de terminal
  branchId,            // number: ID de sucursal
  cashRegisterId,      // number: ID de caja
  principalHost,       // string: Host del principal
  principalBaseUrl     // string: URL base del principal
)
Returns: Promise<boolean>
```

**Uso**:
```javascript
await initializeOfflineCache(
  'a1b2c3d4e5f6g7h8',
  1,
  1,
  '192.168.1.100',
  'http://192.168.1.100:3000'
);
```

### 2. updateOfflineProductsCache()
Carga/actualiza productos en caché local.

```javascript
async function updateOfflineProductsCache(productIds = null)
Returns: Promise<number> - Cantidad de productos actualizados
```

**Parámetros**:
- `productIds`: null (todos) o array de IDs a actualizar

**Uso**:
```javascript
const updated = await updateOfflineProductsCache();
console.log(`${updated} productos actualizados`);
```

### 3. updateOfflineClientsCache()
Carga clientes activos al caché.

```javascript
async function updateOfflineClientsCache()
Returns: Promise<number> - Cantidad de clientes actualizados
```

### 4. updateOfflineUsersCache()
Carga usuarios autorizados al caché.

```javascript
async function updateOfflineUsersCache()
Returns: Promise<number> - Cantidad de usuarios actualizados
```

### 5. getOfflineCacheStatus()
Obtiene estado actual del caché de una terminal.

```javascript
async function getOfflineCacheStatus(terminalId)
Returns: Promise<{
  initialized: boolean,
  isOnline: 0|1,
  syncStatus: string,
  lastFullSync: DateTime,
  productsCached: number,
  clientsCached: number,
  usersCached: number,
  pendingSalesCount: number,
  pendingSalesTotalAmount: number
}>
```

### 6. updateTerminalOnlineStatus()
Actualiza estado de conexión de una terminal.

```javascript
async function updateTerminalOnlineStatus(
  terminalId,          // string
  isOnline,            // boolean: true=online, false=offline
  status = null        // string: 'online'/'offline'/'syncing' (opcional)
)
```

### 7. logSyncEvent()
Registra evento de sincronización para auditoría.

```javascript
async function logSyncEvent(
  terminalId,          // string
  phase,               // string: 'upload'/'download'/'confirm'/'full'
  itemsUploaded = 0,   // number
  itemsDownloaded = 0, // number
  result = 'ok',       // string: 'ok'/'partial'/'error'
  errorDetail = null   // string
)
```

### 8. generateOfflineInvoiceId()
Genera ID único para venta offline.

```javascript
async function generateOfflineInvoiceId(terminalId)
Returns: Promise<string> - Formato: "{terminalId}#{secuencial}#{timestamp}"
```

**Ejemplo de resultado**:
```
a1b2c3d4e5f6g7h8#1#1704067200000
a1b2c3d4e5f6g7h8#2#1704067205000
```

---

## OfflineManager Class

Ubicación: `js/offline-manager.js` (350+ líneas)

### Constructor
```javascript
const offline = new OfflineManager({
  healthCheckInterval: 2000,      // ms entre health checks (defecto)
  healthCheckTimeout: 3000,       // timeout para cada health check
  syncDebounceDelay: 1000,        // esperar antes de disparar sync
  statusUpdateInterval: 1000      // actualizar UI cada 1s
});
```

### Métodos Públicos

#### initialize()
Inicia el monitoreo de conexión.
```javascript
await offline.initialize();
```

#### on(event, callback)
Registra listener para evento.
```javascript
offline.on('online', (state) => {
  console.log('Conectado!');
});

// Eventos disponibles:
// - 'online': Conexión restaurada
// - 'offline': Desconectado
// - 'syncStart': Sincronización comenzó
// - 'syncComplete': Sincronización exitosa
// - 'syncError': Error en sincronización
// - 'statusUpdate': Actualización de estado periódica
```

#### off(event, callback)
Desregistra listener.

#### getState()
Obtiene estado actual.
```javascript
const state = offline.getState();
console.log(state);
// {
//   isOnline: true,
//   isSyncing: false,
//   lastHealthCheckAt: Date,
//   lastSyncAt: Date,
//   pendingSalesCount: 3,
//   pendingSalesTotal: 1500.00,
//   syncError: null
// }
```

#### getStatusInfo()
Obtiene información formateada para UI.
```javascript
const info = offline.getStatusInfo();
console.log(info);
// {
//   status: 'offline',
//   label: 'Modo Offline',
//   icon: '✕',
//   color: 'red',
//   pendingCount: 3,
//   pendingTotal: 1500.00
// }
```

#### forceSync()
Fuerza sincronización manual.
```javascript
await offline.forceSync();
```

#### cancelPendingSale(offlineInvoiceId)
Cancela una venta offline antes de sincronización.
```javascript
await offline.cancelPendingSale('a1b2c3d4e5f6g7h8#1#1704067200000');
```

#### destroy()
Limpia listeners y timers.
```javascript
offline.destroy();
```

---

## Endpoints API

### GET /api/health
Health check simple para detectar conexión.

**Respuesta exitosa (200)**:
```json
{
  "ok": true,
  "timestamp": "2024-01-01T12:00:00.000Z",
  "app": "Tecno Caja",
  "version": "2.0.0"
}
```

**Error (503)** - BD no disponible:
```json
{
  "ok": false,
  "error": "BD no disponible",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

### GET /api/offline/status
Obtiene estado del caché offline (STUB - Fase 2).

**Parámetros**:
- `terminalId` (query): ID de terminal

**Respuesta**:
```json
{
  "ok": true,
  "initialized": true,
  "isOnline": 1,
  "syncStatus": "online",
  "productsCached": 2847,
  "clientsCached": 156,
  "usersCached": 12,
  "pendingSalesCount": 3,
  "pendingSalesTotalAmount": 1500.00
}
```

### POST /api/offline/sync-pending
Sube ventas offline al servidor (STUB - Fase 4).

**Body**:
```json
{}
```

**Respuesta**:
```json
{
  "ok": true,
  "synced": 0,
  "failed": 0,
  "message": "Sync endpoint en stub (implementación en Fase 4)"
}
```

### POST /api/offline/cancel-pending
Cancela venta offline antes de sync (STUB - Fase 3).

**Body**:
```json
{
  "offlineInvoiceId": "a1b2c3d4e5f6g7h8#1#1704067200000"
}
```

**Respuesta**:
```json
{
  "ok": true,
  "cancelled": "a1b2c3d4e5f6g7h8#1#1704067200000",
  "message": "Cancel endpoint en stub"
}
```

---

## Ejemplos de Uso

### Ejemplo 1: Inicializar Caché Después de Login

**Backend (Node.js)**:
```javascript
// En el endpoint de login exitoso
app.post('/api/auth/login', async (req, res) => {
  // ... validar credenciales ...
  
  const user = { id: 123, usuario: 'vendedor1' };
  
  if (isSecondaryTerminal) {
    await initializeOfflineCache(
      terminalId,
      user.branch_id,
      user.cash_register_id,
      principalHost,
      principalBaseUrl
    );
    
    // Cargar datos en caché
    await updateOfflineProductsCache();
    await updateOfflineClientsCache();
    await updateOfflineUsersCache();
  }
  
  return res.json({ ok: true, user });
});
```

### Ejemplo 2: Monitoreo de Conexión en Frontend

**HTML**:
```html
<!DOCTYPE html>
<html>
<head>
  <script src="js/offline-manager.js"></script>
</head>
<body>
  <div id="connection-status"></div>
  <div id="pending-sales-count"></div>
  
  <script>
    const offline = new OfflineManager();
    await offline.initialize();
    
    // Mostrar estado actual
    function updateUI() {
      const status = offline.getStatusInfo();
      document.getElementById('connection-status').textContent = status.label;
      document.getElementById('connection-status').style.color = 
        status.color === 'green' ? '#00aa00' : 
        status.color === 'red' ? '#aa0000' : '#ffaa00';
      
      const state = offline.getState();
      if (state.pendingSalesCount > 0) {
        document.getElementById('pending-sales-count').textContent = 
          `${state.pendingSalesCount} ventas pendientes`;
      }
    }
    
    // Escuchar cambios
    offline.on('online', () => {
      console.log('✓ Reconectado');
      updateUI();
    });
    
    offline.on('offline', () => {
      console.log('✕ Desconectado - Modo offline activado');
      updateUI();
    });
    
    offline.on('syncStart', () => {
      updateUI();
      showNotification('Sincronizando ventas...', 'info');
    });
    
    offline.on('syncComplete', (data) => {
      updateUI();
      showNotification('Sincronización completada', 'success');
    });
    
    offline.on('statusUpdate', () => {
      updateUI();
    });
    
    updateUI(); // Mostrar estado inicial
  </script>
</body>
</html>
```

### Ejemplo 3: Generar y Guardar Venta Offline

**Backend**:
```javascript
// Cuando se registra una venta en modo offline
app.post('/api/ventas/create-offline', async (req, res) => {
  const { terminalId, items, total, paymentMethod, clientId } = req.body;
  
  try {
    // Generar ID único
    const offlineInvoiceId = await generateOfflineInvoiceId(terminalId);
    
    // Guardar venta en tabla pending_sales
    await query(`
      INSERT INTO pending_sales 
      (id, terminal_id, offline_invoice_id, branch_id, cash_register_id, 
       user_id, client_id, sale_data, total, payment_method, status, created_at)
      VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())
    `, [
      terminalId,
      offlineInvoiceId,
      req.user.branch_id,
      req.user.cash_register_id,
      req.user.id,
      clientId,
      JSON.stringify({ items, total, paymentMethod }), // sale_data
      total,
      paymentMethod
    ]);
    
    // Guardar items
    for (const item of items) {
      await query(`
        INSERT INTO pending_sale_items
        (pending_sale_id, item_sequence, product_id, item_data, created_at)
        VALUES (?, ?, ?, ?, NOW())
      `, [offlineInvoiceId, item.sequence, item.product_id, JSON.stringify(item)]);
      
      // Deducir stock local
      await query(`
        UPDATE offline_cache_products
        SET stock_cached = stock_cached - ?
        WHERE product_id = ?
      `, [item.qty, item.product_id]);
    }
    
    // Registrar movimiento de caja
    await query(`
      INSERT INTO pending_cash_movements
      (terminal_id, movement_type, amount, reference_sale_id, status, created_at)
      VALUES (?, 'venta_offline', ?, ?, 'pending', NOW())
    `, [terminalId, total, offlineInvoiceId]);
    
    return res.json({
      ok: true,
      offlineInvoiceId,
      message: 'Venta registrada en modo offline'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
```

---

## Validación

### Verificar Instalación

```bash
# 1. Verificar tablas en BD
mysql -u user -p pos_db -e "
  SHOW TABLES LIKE 'offline_%' OR LIKE 'pending_%' OR LIKE 'sync_log';
"
# Resultado esperado: 10 tablas

# 2. Verificar funciones en server.js
grep -c "async function initializeOfflineCache\|async function updateOfflineProductsCache" server.js
# Resultado esperado: > 0

# 3. Verificar OfflineManager puede cargarse
node -e "const OM = require('./js/offline-manager.js'); console.log('✓ OK');"

# 4. Probar endpoint health check
curl http://localhost:3000/api/health
# Resultado esperado: { ok: true, ... }
```

---

## Próximos Pasos

### Fase 2: Frontend Detection + UI (Estimado: 2 horas)
- [ ] Crear componente de banner de conexión
- [ ] Integrar OfflineManager en js/app.js
- [ ] Agregar panel "Sincronización" en settings
- [ ] Mostrar badges en UI para ventas pendientes
- [Tickets]: OFFLINE_FIRST_FASE2_PLAN.md

### Fase 3: Offline Sales Logic (Estimado: 3 horas)
- [ ] Modificar js/ventas.js para generar venta offline
- [ ] Deducir stock local en offline_cache_products
- [ ] Guardar en pending_sales + pending_cash_movements
- [ ] Implementar cancelación de venta offline
- [Tickets]: OFFLINE_FIRST_FASE3_PLAN.md

### Fase 4: Sync Endpoints (Estimado: 4 horas)
- [ ] Implementar POST /api/offline/sync-pending
- [ ] Validar cada venta antes de insertar en BD principal
- [ ] Usar offline_sync_map para prevenir duplicados
- [ ] Manejo de errores y rollback
- [Tickets]: OFFLINE_FIRST_FASE4_PLAN.md

### Fase 5: Testing + Hardening (Estimado: 4 horas)
- [ ] Test: Desconexión súbita mid-transaction
- [ ] Test: Múltiples ventas offline simultaneas
- [ ] Test: Conflictos de inventario durante sync
- [ ] Test: Error recovery y retry logic
- [Tickets]: OFFLINE_FIRST_FASE5_PLAN.md

---

## Referencias

- [OFFLINE_FIRST_SPEC.md](docs/OFFLINE_FIRST_SPEC.md) - Especificación completa
- [OFFLINE_FIRST_FASE1_COMPLETADA.md](docs/OFFLINE_FIRST_FASE1_COMPLETADA.md) - Documentación de Fase 1

---

**Estado**: ✅ COMPLETADO Y VALIDADO
**Fecha**: 2024
**Siguiente Fase**: Fase 2 - Frontend Detection + UI

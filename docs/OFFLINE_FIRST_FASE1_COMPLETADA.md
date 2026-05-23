# Offline-First POS - Fase 1 Completada

## ✅ Resumen de la Fase 1: Schema + Helpers

**Fecha**: 2024
**Status**: ✅ COMPLETADO

### Cambios Realizados

#### 1. Schema SQL (db/schema.sql) - Nuevas Tablas
Se agregaron 10 tablas al final del schema.sql:

1. **offline_terminal_cache** - Estado de conexión y caché de la terminal secundaria
   - terminal_id, principal_host, principal_base_url, branch_id
   - is_online, sync_status, last_full_sync, last_health_check

2. **offline_cache_products** - Caché local de productos
   - product_id, codigo, nombre, categoria, precio_venta, stock_cached, stock_min

3. **offline_cache_clients** - Caché local de clientes
   - client_id, nombre, cedula, telefono, email, direccion, limite_credito, balance

4. **offline_cache_users** - Usuarios autorizados para login offline
   - user_id, usuario, nombre, rol, password_hash, permisos

5. **offline_cache_config** - Configuración en caché
   - config_key, config_value, last_updated

6. **offline_cache_payment_methods** - Métodos de pago en caché
   - payment_method_id, codigo, nombre

7. **pending_sales** - Ventas realizadas en modo offline
   - offline_invoice_id (único), terminal_id, branch_id, cash_register_id
   - status (pending/syncing/synced/error), sale_data (JSON)

8. **pending_sale_items** - Items individuales de ventas offline
   - pending_sale_id, item_sequence, product_id, item_data (JSON)

9. **pending_cash_movements** - Movimientos de caja offline
   - movement_type, amount, status, reference_sale_id, error tracking

10. **sync_log** - Histórico de sincronizaciones
    - terminal_id, sync_phase, items_uploaded/downloaded, result, timestamps

**Tabla Principal (MySQL)**:
- **offline_sync_map** - Mapeo de IDs offline a reales para evitar duplicados
  - offline_id ↔ real_invoice_id, synced_at, branch_id

#### 2. Helper Functions en server.js

Agregadas 8 funciones helper para gestionar offline-first:

1. **initializeOfflineCache(terminalId, branchId, cashRegisterId, principalHost, principalBaseUrl)**
   - Inicializa el caché offline para una terminal secundaria
   - Debe llamarse después del primer login exitoso

2. **updateOfflineProductsCache(productIds = null)**
   - Sincroniza productos desde BD principal al caché local
   - Sincroniza precio, stock, categoría
   - Si productIds es null, actualiza todos los activos

3. **updateOfflineClientsCache()**
   - Carga clientes activos con crédito al caché local
   - Incluye balance actual y límite de crédito

4. **updateOfflineUsersCache()**
   - Carga usuarios autorizados al caché local
   - Incluye password_hash para validación offline

5. **getOfflineCacheStatus(terminalId)**
   - Retorna estado actual del caché: {initialized, isOnline, syncStatus, productsCount, etc.}
   - Incluye conteo de ventas pendientes y monto total

6. **updateTerminalOnlineStatus(terminalId, isOnline, status)**
   - Actualiza estado de conexión de una terminal
   - Registra last_health_check para debugging

7. **logSyncEvent(terminalId, phase, itemsUploaded, itemsDownloaded, result, errorDetail)**
   - Registra eventos de sincronización en histórico
   - Útil para debugging y auditoría

8. **generateOfflineInvoiceId(terminalId)**
   - Genera ID único para venta offline: `{terminalId}#{secuencial}#{timestamp}`
   - Evita duplicados usando secuencial local y timestamp

#### 3. OfflineManager (js/offline-manager.js) - Nueva Clase
Gestor de conexión y sincronización en frontend:

```javascript
class OfflineManager {
  // Monitorea estado online/offline
  // Realiza health checks periódicos (cada 2s por defecto)
  // Detecta transiciones de conexión
  // Dispara sync automático cuando se restaura conexión
  // Expone eventos: online, offline, syncStart, syncComplete, syncError
}
```

**Métodos Principales**:
- `initialize()` - Inicializa monitoreo
- `on(event, callback)` - Registra listeners
- `getState()` - Obtiene estado actual
- `getStatusInfo()` - Info para mostrar en UI
- `cancelPendingSale(offlineInvoiceId)` - Cancela venta offline
- `forceSync()` - Fuerza sincronización manual

#### 4. Health Check Endpoint (/api/health)
Nuevo endpoint de diagnóstico:

```
GET /api/health
Response: {
  ok: true/false,
  timestamp: ISO 8601,
  app: 'Tecno Caja',
  version: '...'
}
```

Status 503 si BD no está disponible.

#### 5. Offline Sync Endpoints (STUBS)
Tres endpoints stub para Fases posteriores:

1. **GET /api/offline/status**
   - Retorna estado del caché y ventas pendientes
   - [TODO: Completar en Fase 2]

2. **POST /api/offline/sync-pending**
   - Sube ventas offline al servidor principal
   - [TODO: Completar en Fase 4]

3. **POST /api/offline/cancel-pending**
   - Cancela venta offline antes de sync
   - [TODO: Completar en Fase 3]

### Archivos Modificados/Creados

```
db/schema.sql
  ├─ +10 nuevas tablas para offline-first
  └─ +1 tabla en BD principal para dedup (offline_sync_map)

server.js
  ├─ +8 helper functions (initializeOfflineCache, updateOfflineProductsCache, etc.)
  ├─ +1 endpoint GET /api/health
  └─ +3 endpoints stub (/api/offline/*)

js/offline-manager.js (NUEVO)
  └─ Clase OfflineManager con 15+ métodos públicos
```

### Cómo Usar - Ejemplos

#### En Backend (Node.js):

```javascript
// Inicializar caché después de login exitoso
await initializeOfflineCache(
  terminalId,
  branchId,
  cashRegisterId,
  principalHost,
  principalBaseUrl
);

// Actualizar caché de productos
const updated = await updateOfflineProductsCache();
console.log(`${updated} productos actualizados`);

// Obtener estado del caché
const status = await getOfflineCacheStatus(terminalId);
console.log('Pending sales:', status.pendingSalesCount);

// Generar ID único para venta offline
const offlineId = await generateOfflineInvoiceId(terminalId);
// Resultado: "a1b2c3d4e5f6g7h8#1#1704067200000"
```

#### En Frontend (JavaScript):

```html
<!-- Incluir OfflineManager -->
<script src="js/offline-manager.js"></script>

<script>
  // Crear e inicializar
  const offline = new OfflineManager({
    healthCheckInterval: 2000,
    syncDebounceDelay: 1000
  });

  await offline.initialize();

  // Escuchar eventos
  offline.on('online', (state) => {
    console.log('Conexión restaurada');
    showNotification('✓ Conexión restaurada', 'success');
  });

  offline.on('offline', (state) => {
    console.log('Modo offline activado');
    showNotification('✕ Modo offline', 'warning');
  });

  offline.on('syncStart', () => {
    showNotification('↻ Sincronizando...', 'info');
  });

  offline.on('syncComplete', (data) => {
    showNotification('✓ Sincronización completada', 'success');
  });

  // Obtener estado actual
  const status = offline.getStatusInfo();
  console.log(status);
  // { status: 'offline', label: 'Modo Offline', icon: '✕', color: 'red', pendingCount: 3 }

  // Forzar sincronización manual
  await offline.forceSync();

  // Cancelar venta offline
  await offline.cancelPendingSale('a1b2c3d4e5f6g7h8#1#1704067200000');
</script>
```

### Próximos Pasos

#### Fase 2: Frontend Detection + UI
- [ ] Crear componente de banner de estado de conexión
- [ ] Integrar OfflineManager en js/app.js
- [ ] Agregar panel "Sincronización" en settings
- [ ] Mostrar badge "Sincronizando" en ventas pendientes
- [Timeline: ~2 horas]

#### Fase 3: Offline Sales Logic
- [ ] Modificar js/ventas.js para generar venta offline
- [ ] Deducir stock local en offline_cache_products
- [ ] Guardar en pending_sales + pending_cash_movements
- [ ] Implementar cancelación de venta offline
- [Timeline: ~3 horas]

#### Fase 4: Sync Endpoints
- [ ] Implementar POST /api/offline/sync-pending
- [ ] Validar cada venta antes de insertar
- [ ] Usar offline_sync_map para prevenir duplicados
- [ ] Manejo de errores y rollback
- [ ] Confirmar sync y actualizar pending_cash_movements
- [Timeline: ~4 horas]

#### Fase 5: Testing + Hardening
- [ ] Test: Desconexión súbita mid-transaction
- [ ] Test: Múltiples ventas offline
- [ ] Test: Conflictos de inventario
- [ ] Error recovery paths
- [ ] Lock handling para syncs concurrentes
- [Timeline: ~4 horas]

### Validación Fase 1

Para verificar que Fase 1 está correctamente instalada:

```bash
# 1. Verificar que las nuevas tablas existen
mysql -u user -p pos_db -e "
  SHOW TABLES LIKE 'offline_%';
  SHOW TABLES LIKE 'pending_%';
  SHOW TABLES LIKE 'sync_log';
"

# 2. Verificar que server.js tiene las funciones helper
grep -n "initializeOfflineCache\|updateOfflineProductsCache\|generateOfflineInvoiceId" server.js

# 3. Verificar que los endpoints están activos
curl http://localhost:3000/api/health

# 4. Verificar que js/offline-manager.js existe
ls -la js/offline-manager.js
```

### Notas Importantes

1. **Terminal Secundaria**: Solo se inicializa caché cuando se linka correctamente a la principal
2. **Health Check**: Se ejecuta cada 2 segundos por defecto (configurable)
3. **Sync Automático**: Se dispara automáticamente cuando se detecta reconexión (con debounce de 1s)
4. **ID Offline**: Formato único evita colisiones incluso con múltiples terminales
5. **Password Hash**: Se cachean hashs (no passwords) para validación offline segura

### Roadmap Total Offline-First

```
Fase 1 ✅ - Schema + Helpers (COMPLETADO)
Fase 2 → Frontend Detection + UI (EN PROGRESO)
Fase 3 → Offline Sales Logic (PENDIENTE)
Fase 4 → Sync Endpoints (PENDIENTE)
Fase 5 → Testing + Hardening (PENDIENTE)
```

---

**Próximo paso**: Comenzar Fase 2 (Frontend Detection + UI)

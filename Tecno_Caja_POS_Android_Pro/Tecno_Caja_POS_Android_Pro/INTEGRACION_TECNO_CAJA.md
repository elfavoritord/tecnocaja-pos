# Integración con Tecno Caja POS Windows

No se debe exponer MariaDB directamente a Internet.

## Flujo recomendado
- Windows mantiene MariaDB local.
- Un servicio Express autenticado publica cambios a la nube.
- Flutter consulta y sincroniza por empresa, sucursal y caja.
- Cada registro usa UUID, `updatedAt`, `version`, `deviceId` y `syncStatus`.
- Las ventas e inventario se procesan de forma transaccional para evitar duplicados.

## Endpoints sugeridos
- POST /auth/link-device
- GET/POST /sync/products
- GET/POST /sync/customers
- POST /sales
- POST /cash-sessions
- GET /reports/summary
- POST /devices/revoke

## Seguridad
JWT de corta duración, refresh tokens, TLS, App Check, roles, auditoría y aislamiento estricto por tenantId.

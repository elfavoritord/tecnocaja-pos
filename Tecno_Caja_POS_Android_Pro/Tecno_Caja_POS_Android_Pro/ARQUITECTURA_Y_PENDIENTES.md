# Arquitectura objetivo

## Capas
1. Flutter Android: UI, estado, base local e impresión.
2. SQLite local: productos, ventas, clientes y cola de sincronización.
3. Backend cloud: autenticación, empresas, sucursales, licencias, auditoría y sincronización.
4. Conector Windows: API Express segura entre MariaDB y la nube.

## Próximas implementaciones reales
- Repositorios SQLite completos y migraciones.
- Firebase Auth + Google Sign-In.
- Firestore o backend propio multiempresa.
- API REST/WebSocket del POS Windows.
- Resolución de conflictos con versionado, UUID y timestamps de servidor.
- Emparejamiento Bluetooth, permisos Android e impresión física.
- Escáner de barras con cámara.
- Sincronización de stock transaccional.
- Apertura/cierre de caja y auditoría.
- e-CF mediante backend seguro; nunca guardar certificados fiscales en el teléfono sin protección.
- Pruebas unitarias, integración, seguridad y publicación Play Store.

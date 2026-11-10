# Permisos por usuario

Pedido de Emilio (2026-11-08): "activa bien los roles para poder seleccionar lo que sí
verdaderamente puede hacer cada usuario" y "mejora el panel de agregar usuarios".

## Cómo funciona

- Cada usuario tiene un **rol** y, opcionalmente, **permisos propios**
  (`users.permisos_usuario`, JSON). `NULL` = los de su rol, exactamente como antes.
- El catálogo de permisos está en `js/permisos-catalogo.js` (lo usan servidor y pantalla):
  grupos con etiqueta, los códigos que el sistema ya revisaba (`abrir_caja`,
  `anular_ventas`, `compras.crear`, `gestionar_configuracion_global`…), el mapa
  **módulo del menú → permiso** y `porDefecto(rol)`, lo que cada rol puede hacer hoy
  (lista de la base + atajos por rol). Al personalizar se parte de ahí.
- Servidor (`server/security/permisos-usuario.js` + `server.js`):
  - `userRoleHasPermission` usa la lista propia si existe; así obedecen todas las
    revisiones finas (compras, gastos, NCF, caja general, auditoría, configuración).
  - Los atajos por rol (`userCanOpenCash/CloseCash/MakeCorte/OpenDrawer/VoidSales/
    ReturnSales/ViewCashReports`, `canManageUsersWithRole`, `userCanManageProductCatalog`)
    deciden por la lista cuando el usuario está personalizado (`userHasCustomPermissions`).
  - `ensureNotCashier(req, permiso)`: usuario personalizado → exige ese permiso
    (productos, inventario, configuración); los demás → regla de siempre.
  - Solo el **administrador general** personaliza; al administrador general no se le
    quitan permisos; una lista igual a la del rol se guarda como `NULL`; al cambiar de
    rol sin mandar permisos vuelve a los del rol nuevo; cada cambio va a la auditoría
    ("Permisos del usuario", antes/después).
  - Sin internet: `offline_cache_users.permisos_usuario` → el login local respeta lo mismo.
- Pantalla (`js/app.js`): con permisos propios, `currentUserCan` usa solo su lista y el
  menú (`canAccessModule`) sale del mapa de módulos; los módulos sin regla siguen la de siempre.

**Regla para código nuevo:** un atajo por rol nuevo (`isCashierUser(user) → true`) debe
preguntar antes `userHasCustomPermissions(user)` y decidir por el permiso; si no, el
usuario personalizado se lo salta.

## Panel de usuario

`#eu-overlay` (index.html) + `eu*` en `js/clientes.js`: dos columnas, sin pestañas.
Datos de la persona (usuario sugerido desde el nombre), Acceso y seguridad (estado,
contraseña con generador, función en caja), Rol y permisos (tarjetas de rol, dónde
trabaja, "Qué puede hacer" por casillas con insignia Según el rol / Personalizado y
"Volver a los permisos del rol") y Acceso a las apps móviles (plegable, solo al editar).
Un usuario nuevo arranca como Cajero. La lista de usuarios marca "Personalizado".

## Corregido de paso

- Al editar un usuario y cambiarle el rol, el servidor se quedaba con el anterior
  (`role_id` guardado ganaba al rol elegido). Ahora manda el rol elegido.

## Límites

- Módulos cuyo servidor no revisaba permisos (leer reportes, clientes…) quedan protegidos
  por el menú; las acciones que ya tenían control en el servidor quedan protegidas por la lista.
- Multisucursal: los permisos propios no viajan todavía a las PCs de sucursal (allá
  aplican los del rol).

## Pruebas

- `npx jest tests/permisos tests/security`
- `npm run test:permisos` (SQLite y MariaDB, con pantallas): `scripts/probar-permisos-usuarios.js`

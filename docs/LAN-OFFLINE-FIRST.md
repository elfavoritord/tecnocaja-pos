# Tecno Caja — Red local primero (LAN-first / offline-first)

Auditoría y cambios para que Tecno Caja funcione completo en una red local sin
Internet, con N cajas. Fecha: 2026-10-05. Rama: `fase-2-seguridad`.

Regla de diseño: **Internet es una mejora, no un requisito para vender.** La
venta, la caja, el inventario, los clientes, los reportes, la impresión y el
NCF trabajan contra la base de la LAN. Lo que necesita Internet (Firebase,
DGII, nube) va en cola y se envía cuando vuelve, sin borrar nada local antes
de tener confirmación.

---

## A. Diagnóstico

### Problemas encontrados y corregidos

| # | Problema | Efecto real | Gravedad |
|---|----------|-------------|----------|
| 1 | El POS esperaba a Firebase/licencia/perfil de contador en cada consulta aunque no hubiera Internet | Login y pantallas lentas (timeouts) sin Internet | Alta |
| 2 | `index.html` cargaba el módulo de Firebase Web al abrir | Sin Internet la pantalla de inicio dependía de un script remoto | Media |
| 3 | El indicador decía "Sin Internet" para todo | Si el problema era la PC principal, el cajero buscaba el fallo en el lugar equivocado | Media |
| 4 | Una venta reintentada (respuesta perdida, doble clic, tiempo agotado) se registraba dos veces | Ventas duplicadas en multicaja | Alta |
| 5 | La sincronización de contingencia anotaba "ya subida" después de la venta, fuera de la transacción | Un corte de red en medio duplicaba la venta al reintentar | Alta |
| 6 | Una venta de contingencia que ya había entrado en línea se volvía a subir | Duplicado al volver la principal | Alta |
| 7 | Sin Internet, el e-CF fallaba y quedaba marcado como enviado | Se perdía el envío a DGII | Alta |
| 8 | Las cajas guardaban la IP de la principal; si el router (DHCP) le cambiaba la IP, la caja quedaba sin servidor | "Servidor no responde" hasta reconfigurar a mano | Alta |
| 9 | Regla de firewall del instalador abierta a cualquier red | Puerto 3399 expuesto más allá de la LAN | Media |
| 10 | **Ventas simultáneas fallaban** en MariaDB 12 (la que trae el instalador): error 1020 "Record has changed since last read in table 'config'" | Con 2 cajas cobrando a la vez entraban 3 de 20 ventas | **Crítica** |
| 11 | El stock se calcula leyendo y luego escribiendo; dos ventas a la vez podían pisarse el descuento | Inventario incorrecto en multicaja | **Crítica** |
| 12 | **La caché de licencia era una sola fila en la base compartida**, cifrada con la llave de cada PC | Al caerse Internet, todas las cajas menos la última que validó quedaban bloqueadas con "manipulación de licencia" | **Crítica** |
| 13 | Las rutas de contingencia (`/api/offline/*`) no recibían la sesión del cajero | La caja terminal NO podía vender con la principal caída (401 siempre) | **Crítica** |
| 14 | El número de venta de contingencia se repetía (#2, #2) si dos ventas caían en el mismo segundo | Tickets de contingencia con número repetido | Baja |
| 15 | Si la principal se apagaba (o se cerraba Tecno Caja) en plena subida de las ventas de contingencia, esas ventas quedaban en "error"/"subiendo" y **nunca más se reintentaban** | Ventas que jamás llegaban a la principal | **Crítica** |

Los puntos 10 a 15 se descubrieron con la prueba de punta a punta (sección D);
las pruebas unitarias no los veían porque solo aparecen con MariaDB real y
dos servidores a la vez.

### Clasificación de funciones

🟢 funciona solo con la LAN · 🟡 usa Internet pero no bloquea (cola / diferido) · 🔴 necesita Internet

| Función | Estado | Nota |
|---------|:------:|------|
| Abrir el POS y entrar (usuario y clave) | 🟢 | Licencia desde la caché firmada de cada PC |
| Ventas, cobro, cambio, descuentos, promociones | 🟢 | |
| NCF (B01, B02, B14, B15…) | 🟢 | Secuencias en la base de la LAN |
| Caja: apertura, entradas/salidas, corte, cierre | 🟢 | |
| Productos, inventario, compras, proveedores | 🟢 | |
| Clientes, crédito | 🟢 | |
| Reportes locales | 🟢 | |
| Impresora térmica, gaveta, lector de código, balanzas | 🟢 | No dependen de Internet |
| Multicaja en la LAN (N cajas) | 🟢 | Contra la PC principal |
| Caja terminal con la principal caída (contingencia) | 🟢 | Solo "terminal completa"; se sube al volver la principal |
| Encontrar la principal aunque cambie su IP | 🟢 | Por nombre de equipo y búsqueda en la LAN |
| Respaldos locales (`.novaseguro`) | 🟢 | |
| e-CF: firma | 🟢 | Se firma con el certificado local |
| e-CF: envío a DGII | 🟡 | Queda pendiente con su e-NCF y sale solo al volver Internet |
| Sincronización con Firebase / app de reportes / app móvil | 🟡 | Cola `firebase_sync_queue`, reintenta sola |
| Validación remota de licencia | 🟡 | Licencia activada: sin límite de días sin Internet (copia firmada local). Prueba: hasta 3 días sin Internet |
| Respaldos en la nube | 🟡 | |
| Consulta de RNC | 🟡 | Usa el padrón ya descargado; actualizarlo necesita Internet |
| Mapa de delivery | 🟡 | Los mapas se cargan de Internet; el pedido sí se registra |
| Login con Google | 🔴 | Muestra aviso y se entra con usuario y clave |
| Recepción DGII `/fe/*` (túnel Cloudflare) | 🔴 | Por naturaleza: DGII llama desde Internet |
| Primera activación de licencia de una PC nueva | 🔴 | Una sola vez por PC |
| Multisucursal entre locales distintos | 🔴 | Por VPN/Tailscale, que va sobre Internet; dentro de cada local la LAN sigue funcionando |

---

## B. Cambios realizados

### Detección de Internet y modos

- `server/network/internet-monitor.js` (nuevo): una sola verificación real (DNS + TCP 443), estados *desconocido / con Internet / sin Internet*, eventos de cambio. Revisa cada 20 s con Internet y cada 8 s sin Internet.
- `server/sync/firebase-sync-service.js`: usa el monitor; al volver Internet procesa la cola.
- `server/licensing/license-service.js`: si ya se sabe que no hay Internet, no espera a Firebase.
- `server.js`: el login no busca el perfil del contador sin Internet; el e-CF recibe `internetOffline`.
- `server/routes/connectivity.routes.js` (nuevo): `GET /api/connectivity` con rol, modo, base de datos (latencia), Internet, nube y pendientes (nube, e-CF, contingencia). Modos: `normal`, `local`, `contingencia`, `sin_bd`.

### Pantalla

- `js/sync-monitor.js` (reescrito): indicador de la barra y ventana "Estado de conexión":
  - 🟢 Conectado (LAN + Internet)
  - 🟡 **Modo local activo**: la LAN está bien y no hay Internet; se vende normal
  - 🟡 Contingencia: la caja vende con su copia local
  - 🔴 **Servidor LAN desconectado**: el problema es la PC principal, no Internet
- `js/offline-status-bar.js`: sin Internet ya no alarma al cajero.
- `index.html` / `js/app.js`: Firebase Web se carga solo al pedir "Entrar con Google".

### Ventas sin duplicados

- `server/sales/sale-idempotency.js` (nuevo): cada intento de cobro lleva `clientRequestId` (`js/ventas.js`); índice único en `sales.client_request_id`. Un reintento devuelve la venta ya registrada (`duplicate: true`) y la pantalla avisa "ya estaba registrada: no se duplicó".
- `server/routes/offline.routes.js`: la marca "ya subida" se escribe dentro de la misma transacción de la venta; una copia de contingencia de una venta que ya entró en línea se salta.
- `db-local.js`: el número de venta de contingencia ya no se repite.

### Varias cajas a la vez (correcciones críticas)

- `server.js` (`POST /api/sales`) y `server/routes/offline.routes.js`: la venta toma primero el lock del contador de facturas y después lee stock, NCF y crédito. Así ninguna venta pisa el inventario de otra y MariaDB 12 ya no rechaza ventas simultáneas.
- `db.js`: el error 1020 de MariaDB se reintenta solo, igual que los tranques. La protección `innodb_snapshot_isolation` **se deja encendida a propósito**: es la que impide perder descuentos de inventario en otras pantallas.

### Licencia en multicaja

- `server/licensing/license-service.js`: una licencia **activada** ya no exige conectarse cada 3 días. Funciona con su copia firmada local, y se revisan en la PC la fecha de vencimiento, la firma, el reloj y el límite de equipos. Internet solo se usa para enterarse de renovaciones, suspensiones o cambios de plan cuando hay conexión. El límite de días sin Internet queda solo para la prueba.
- `server/licensing/license-service.js`: cada PC guarda su caché de licencia en su propia fila de `license_cache`. Las instalaciones anteriores leen la fila vieja y pasan a la suya en la siguiente escritura. La seguridad no cambia: cada caché sigue cifrada y firmada con la llave de su PC.

### Contingencia de la caja terminal

- `server/middleware/offline-session.js` (nuevo): las rutas `/api/offline/*` reconocen la sesión del cajero desde el caché de sesiones en memoria, sin tocar la base caída. También funciona con el login local de contingencia (`/api/auth/offline-login`).
- `server/routes/offline.routes.js`: antes de cada subida, lo que quedó a medias (`syncing`) o falló por red/base vuelve solo a la cola; los errores de datos quedan para revisión. Una sola subida a la vez.

Qué puede hacer hoy una **terminal completa** con la principal apagada:

| Función | Sin la principal |
|---------|:----------------:|
| Entrar con usuario y clave (usuarios que ya existían cuando la caja estuvo conectada) | ✔ |
| Vender, cobrar, imprimir ticket, abrir gaveta | ✔ |
| Buscar productos y clientes (copia local, se refresca cada minuto mientras hay conexión) | ✔ |
| Crear producto, ajustar inventario, ingreso/gasto de caja, proveedores | ✔ quedan pendientes |
| NCF en el ticket | ✘ se asigna al sincronizar; el ticket sale con número provisional |
| e-CF | ✘ al sincronizar queda como ticket con nota para refacturar (comportamiento anterior, no se cambió) |
| Corte / cierre de caja | ✘ necesita la principal |
| Ver ventas de las otras cajas y reportes generales | ✘ |
| Cliente liviano | ✘ no vende sin la principal |

### e-CF sin Internet

- `modules/ecf/services/ecf.service.js` y `modules/ecf/models/ecf.repository.js`: sin Internet el e-CF se firma y queda **pendiente con su e-NCF** (columnas `deferred_signed_xml` y `deferred_at`), sin marcarse como enviado. Se envía el mismo XML firmado.
- `server/sync/ecf-deferred-dispatch.js` (nuevo): al volver Internet (y cada 5 min) envía los pendientes. Solo lo hace la PC principal y nunca en dos corridas a la vez. Si la red se vuelve a caer, el documento sigue pendiente.
- La lógica fiscal no se cambió: mismo XML, misma secuencia y mismo tratamiento de la respuesta que el envío en línea.

### Encontrar el servidor en la LAN (DHCP / cambio de IP)

- `server/network/server-identity.js` (nuevo): la principal tiene un `serverId` fijo que anuncia en `/api/network/identify` junto con su nombre de equipo.
- `server/network/lan-discovery.js` (nuevo): busca primero por nombre de equipo y después en la red /24, y reconoce a la principal por su `serverId`, no por la IP.
- `server/network/principal-watcher.js` (nuevo, terminal completa): cada 30 s comprueba la principal. Si no responde, la busca, actualiza `DB_HOST` y recarga la conexión.
- `electron/main.js` (cliente liviano): al abrir, si la principal no está en la IP guardada, la busca y abre la nueva dirección. Con la ventana abierta la revisa cada 20 s y, si falla dos veces, la busca y recarga desde la nueva dirección.
- La IP manual sigue disponible desde el asistente y desde Red.

### Firewall y seguridad

- `scripts/configurar-firewall-lan.ps1` (nuevo): abre TCP 3399, y opcionalmente 3306 para terminales completas, **solo para la red local y Tailscale** (`LocalSubnet,100.64.0.0/10`).
- `build/installer.nsh`: la regla del instalador queda limitada igual; al desinstalar se borra también la regla de la base.
- `js/network-manager.js`, `electron/preload.js`, `electron/main.js`: en *Red* se ve el estado del firewall y se configura con un botón (pide permiso de administrador solo al pulsarlo).
- No cambió: bind por defecto `127.0.0.1` (la LAN solo se abre en la principal multicaja), CORS solo localhost/LAN, MariaDB nunca hacia Internet y `DGII_REQUIRE_INTERNAL_TOKEN=false`.

---

## C. Arquitectura final

```
                         Internet (opcional)
        Firebase · DGII e-CF · nube · Tailscale (multisucursal)
                               ▲
                               │ cola / diferido, nunca bloquea la venta
┌──────────────────────────────┴───────────────────────────────┐
│ PC PRINCIPAL                                                 │
│  Electron → Express :3399 (0.0.0.0 solo en multicaja)        │
│           → MariaDB :3306 (solo LAN si hay terminales        │
│             completas)                                       │
│  serverId fijo · monitor de Internet · despachador e-CF      │
└──────────────▲──────────────────────────────▲────────────────┘
               │ HTTP :3399 (LAN)              │ MariaDB :3306 (LAN)
┌──────────────┴─────────────┐  ┌─────────────┴────────────────┐
│ CAJA "CLIENTE LIVIANO"     │  │ CAJA "TERMINAL COMPLETA"     │
│ Electron abre              │  │ Express propio → MariaDB     │
│ http://PRINCIPAL:3399      │  │ de la principal              │
│ Sin principal no vende     │  │ + copia local SQLite para    │
│ Se reubica sola si cambia  │  │   contingencia               │
│ la IP                      │  │ + vigilante de la principal  │
└────────────────────────────┘  └──────────────────────────────┘
```

Estados que ve el cajero:

| Base LAN | Internet | Modo | Indicador |
|----------|----------|------|-----------|
| ✔ | ✔ | `normal` | 🟢 Conectado |
| ✔ | ✘ | `local` | 🟡 Modo local activo (se vende normal) |
| ✘ (terminal completa) | — | `contingencia` | 🟡 Vendiendo con copia local; N pendientes |
| ✘ | — | `sin_bd` | 🔴 Servidor LAN desconectado |

Así va una venta:
1. La pantalla genera `clientRequestId` y lo reutiliza si reintenta el mismo carrito.
2. La transacción toma el lock del contador, valida stock, NCF y caja, inserta y descuenta.
3. Responde al cajero (con o sin Internet, el tiempo es el mismo).
4. Después, y aparte: cola Firebase y e-CF (en línea, o pendiente si no hay Internet).

---

## D. Pruebas realizadas

### Prueba de punta a punta (MariaDB real, dos servidores)

`npm run test:e2e-lan`: usa el MariaDB empaquetado en una carpeta temporal, una
copia del proyecto sin `.env` ni Firebase, una PC principal (puerto 3490) y una
caja terminal (3491). No toca datos reales.

La caja terminal llega a la base por `127.0.0.2`: sigue siendo la misma PC,
pero el servidor la trata como otra PC de la LAN, igual que en una
instalación real. Los servidores de prueba solo escuchan en esta PC.

Resultado final: **41/41 comprobaciones OK**.

| Escenario | Resultado |
|-----------|-----------|
| Internet ON: venta | OK (~0,6–1 s) |
| Internet OFF + LAN ON: login, productos, 3 ventas, gasto de caja, reporte, cliente nuevo | OK; las ventas tardan lo mismo que con Internet |
| Internet vuelve | Vuelve a modo `normal` |
| Licencia: la principal valida después que la caja | Cada una en su fila; la caja entra |
| 20 ventas simultáneas desde 2 cajas | 20/20, facturas únicas, stock −20 exacto, total = suma de sucursales |
| El mismo cobro enviado 4 veces (3 a la vez desde 2 cajas + 1 tarde) | 1 sola venta, misma factura para todos, `duplicate=true` |
| Principal caída | Terminal en `contingencia`, `/api/health` 503 |
| Contingencia: login local + 3 ventas (una era copia de una venta ya hecha en línea) | OK, 3 pendientes |
| La caja intenta subir con la principal todavía caída | Fallan las 3 por red (ECONNREFUSED) y vuelven solas a la cola |
| La caja 2 se enciende con la principal apagada | Abre en contingencia (7 s en la prueba; hasta ~25 s si la PC principal está apagada de verdad), el login normal falla por la base, el login local entra y vende |
| Vuelve la principal y se sincroniza | +3 ventas, 1 saltada por duplicada; al repetir la sincronización entran 0; facturas únicas |

Antes de las correcciones 10 a 13, esta misma prueba daba: 3/20 ventas
simultáneas, la caja sin poder entrar ("licencia") y las ventas de
contingencia rechazadas con 401.

Medición aparte con el servidor ya caliente (6 ventas seguidas): 0,59–0,74 s
con Internet y 0,55–0,79 s sin Internet.

### Pruebas automáticas (Jest)

`npm test`: **62 suites, 400 pruebas, todas OK.** Las nuevas o ampliadas:

- `tests/network/internet-monitor.test.js`, `lan-discovery.test.js`, `principal-watcher.test.js`
- `tests/routes/connectivity.routes.test.js`
- `tests/services/sale-idempotency.test.js`
- `tests/ecf.deferred-offline.test.js`
- `tests/middleware/offline-session.test.js`
- `tests/licensing/license-service.test.js` (multicaja con dos PC y paso desde la fila vieja)
- `tests/db-txn-retry.test.js` (1020 y reintento de la misma venta)
- `tests/offline/offline-sync-retry.test.js` (qué errores de subida se reintentan solos)

### Guía de prueba en una LAN real (2 PC)

**Preparación (con Internet, una sola vez)**

1. Generar el instalador con estos cambios (`npm run build:desktop`) e instalar la **misma versión** en las dos PC. Las dos deben estar en el mismo router o switch.
2. **PC 1 (principal):** asistente → Multicaja → crear red nueva. Anotar la clave de red.
3. PC 1 → Configuración → Sucursales y cajas → crear **"Caja 2"**.
4. PC 1 → Red → Firewall: marcar **"También la base de datos"** y pulsar **"Permitir cajas de la red"**. Sin la base abierta, la caja 2 no puede unirse como terminal completa.
5. **PC 2:** asistente → Multicaja → unirse a una red existente → "Buscar" (o escribir la IP de la PC 1, que sale con `ipconfig`). Entrar con usuario, clave y clave de red, elegir "Caja 2", finalizar y esperar el reinicio.
6. Entrar una vez en la PC 2 con cada usuario que vaya a cobrar allí (eso llena la copia local) y abrir la caja 2.

**Prueba 1: sin Internet, con la LAN funcionando**

7. Desconectar **el cable de Internet del router** (el que viene del proveedor), no el de las PC. Si el módem del proveedor también es el router, desconectar la fibra o el coaxial; la LAN sigue funcionando.
8. En ~30 s las dos PC muestran 🟡 "Modo local activo". Al pulsar el indicador se abre "Estado de conexión".
9. Vender en las dos PC al mismo tiempo: las facturas deben ser consecutivas, sin repetirse, y el stock debe bajar exacto.
10. Imprimir ticket y abrir la gaveta en las dos.

**Prueba 2: principal apagada**

11. Cerrar Tecno Caja en la PC 1, o apagarla.
12. La PC 2 pasa a 🟡 contingencia en ~15 s y sigue vendiendo. El ticket sale con número provisional y sin NCF.
13. Reiniciar la PC 2 con la PC 1 todavía apagada: debe abrir y entrar con usuario y clave (login local).
14. Encender la PC 1. En menos de 1 minuto la PC 2 sube sola las ventas pendientes. En la PC 1 → Ventas aparecen una sola vez, con número FAC y NCF.

**Prueba 3: cambio de IP**

15. Cambiar la IP de la PC 1 (otra IP fija, o una reserva distinta en el router) y reiniciarla. La PC 2 debe encontrarla sola en ~1 minuto, sin reconfigurar nada.

---

## E. Riesgos pendientes y decisiones

| Riesgo | Detalle | Propuesta |
|--------|---------|-----------|
| Licencia sin Internet | **Resuelto**: una licencia activada ya no tiene límite de días sin Internet. Solo se bloquea por causas locales: vencimiento de su fecha, firma inválida, reloj atrasado o límite de equipos. La prueba sigue con 3 días | Si se suspende una licencia desde el panel, esa PC se entera la próxima vez que tenga Internet |
| Primera activación de una PC nueva | Cada PC necesita Internet una vez para su licencia | Opcional: que la principal "avale" a las cajas por LAN (cambio de licencias, no hecho) |
| Cliente liviano sin contingencia | Si se apaga la principal, esa caja no vende | Usar "terminal completa" en cajas críticas |
| NCF en contingencia | El ticket sale sin NCF; se asigna al sincronizar | **Decisión de Emilio + contador**: reservar un bloque de NCF por caja mientras hay conexión, para que el ticket salga con NCF real |
| Corte de caja en contingencia | Necesita la principal | Guardarlo pendiente y aplicarlo al volver |
| Stock en contingencia | Cada caja descuenta su copia; al sincronizar manda la principal | Aceptable para periodos cortos |
| Terminal completa usa MariaDB directo en la LAN (3306) | No sale a Internet; el firewall limita a la LAN y Tailscale | A futuro, terminal vía API (Fase 3) |
| Inventario fuera de la venta | Compras y ajustes simultáneos a una venta pueden dar error 1020; el usuario reintenta (no se pierde stock) | Aplicar el mismo lock en compras y ajustes si aparece en uso real |
| e-CF: error de red en el **primer** envío | Ruta anterior a este trabajo: marca `sent_at`; reenviar avanza la secuencia | Revisar con cuidado fiscal antes de tocar |
| Reenvío de RFCE (`resendDocument`) | Roto desde antes | Corregir aparte |
| Reportes "legacy" | Pierden eventos ocurridos sin Internet; el resumen diario es por incrementos | Migrar al sync nuevo (cola) |
| Reportes: `businessId` | Se dejó como estaba (decisión de Emilio) | — |
| Descubrimiento solo en /24 | En redes más grandes se usa la IP manual | — |
| Mapa de delivery | Necesita Internet para los mapas | — |
| Tiempo de login (~2 s) | `getBootstrapData` carga todo el catálogo; no depende de Internet | Optimizar en otra fase |

### Variables de entorno

| Variable | Uso |
|----------|-----|
| `TECNO_CAJA_SERVER_ID` | Identidad fija de la principal (se genera sola) |
| `TECNO_CAJA_LICENSE_OFFLINE_GRACE_DAYS` | Días que la **prueba** puede trabajar sin Internet (por defecto 3). No aplica a licencias activadas |
| `TECNO_CAJA_SIMULATE_NO_INTERNET=1` | Solo pruebas: simula sin Internet |
| `TECNO_CAJA_ALLOW_CONNECTIVITY_SIMULATION=1` | Solo pruebas: habilita `POST /api/connectivity/simulate` (solo desde 127.0.0.1) |
| `DB_LOCK_WAIT_TIMEOUT_SECONDS` | Espera máxima de un lock entre cajas (por defecto 8 s) |

# Prompt — Tecno Caja POS multiplataforma (Windows + Android)

Versión corregida del prompt original de Emilio. El cambio principal: la sincronización NO pasa a
depender de Firebase — se reutiliza la API Express + el sistema offline (`db-local.js` +
`server/routes/offline.routes.js`) que ya está construido y probado para multicaja. Firebase se queda
exactamente donde está hoy: autenticación de la app Flutter de reportes (`reporte app/`), sin tocarla.

---

Quiero que actúes como un desarrollador Senior Full Stack con experiencia en Electron, JavaScript,
HTML, CSS, Node.js, Android y Capacitor.

## OBJETIVO PRINCIPAL

Tengo un sistema de Punto de Venta llamado **Tecno Caja POS**, desarrollado en Electron + Express
(Node.js) + MariaDB embebida, con frontend en JavaScript/HTML/CSS vanilla (`js/`, `css/`). Quiero
mantener la versión de escritorio exactamente como funciona hoy y crear, además, una versión Android
(tablets y teléfonos) que **consuma la misma API Express** (`server.js` + `server/routes/*`), no un
backend nuevo.

**No quiero desarrollar otra aplicación desde cero ni otro backend.** Un solo proyecto, dos clientes
(Electron para Windows, Capacitor para Android) hablando con el mismo Express en ambos casos —en
Windows embebido localmente, en Android contra el servidor de la PC principal en la red local o vía
túnel/nube igual que hoy hace la PC secundaria en modo multicaja.

## ANÁLISIS INICIAL (antes de tocar código)

- Revisar `docs/ARCHITECTURE.md` y la sección "Fase actual" de `CLAUDE.md` — el proyecto está en Fase 1
  de modularización del monolito `server.js`; no arrancar Android hasta confirmar que no choca con ese
  trabajo en curso.
- Identificar qué de `electron/main.js` es exclusivo de Windows (lanzar `mariadbd.exe`, ventana nativa)
  vs. qué del frontend (`js/`, `css/`, `index.html`) es reusable tal cual en Capacitor.
- Confirmar que **no** hay dos apps Android compitiendo: la app Flutter de `reporte app/` ya cubre
  reportes desde el celular para roles admin/supervisor. Esta nueva app Capacitor es para el
  **punto de venta completo** en tablet, no para reportes — dejar explícito el límite entre ambas.
- Proponer la estructura de carpetas antes de mover nada (ej. `capacitor/` como wrapper nuevo,
  `js/` y `css/` compartidos sin duplicar).

## SINCRONIZACIÓN Y OFFLINE (la parte que se corrigió)

- El backbone de datos sigue siendo **MariaDB + Express**, no Firestore.
- El cliente Android reutiliza el mismo sistema offline que ya existe para PCs secundarias:
  `db-local.js` (SQLite local) + endpoints `/api/offline/*` (`offline.routes.js`). Si el tablet pierde
  conexión con el servidor, cae al mismo flujo: caché local, `pending_sales`, sync al reconectar,
  política de conflictos "el servidor gana".
- **Firebase no cambia de rol**: sigue siendo solo autenticación/sync de usuarios para la app Flutter de
  reportes (`modules/firebase-admin.js`). No se usa Firestore como base de datos de ventas/inventario.
- Tiempo real entre dispositivos (PC ↔ tablets) se resuelve con **Socket.IO**, que el proyecto ya usa,
  no con listeners de Firestore.

## RESPONSIVE Y UX TÁCTIL

Todo el sistema debe adaptarse a teléfonos y tablets (7"–12") sin scroll horizontal: botones grandes,
menús táctiles, carga rápida, modo claro/oscuro. Esto implica trabajo real de CSS/responsive sobre
`css/` existente — no es gratis, es la parte más grande del esfuerzo de frontend. Respeta la regla de
`CLAUDE.md` de no reescribir en React/Vue: se adapta el HTML/CSS/JS vanilla actual.

## IMPRESIÓN, CÁMARA, NOTIFICACIONES

- Impresión térmica ESC/POS (58/80mm) vía Bluetooth/USB OTG/Wi-Fi desde Android, con un módulo
  desacoplado (interfaz común, implementación por transporte) para no acoplar el resto del código a una
  librería de impresión específica.
- Cámara para código de barras/QR y fotos de producto/comprobantes.
- Notificaciones push locales para stock bajo, cierre de caja, nueva venta.

## SEGURIDAD Y RENDIMIENTO

Mantener autenticación, roles, permisos y auditoría exactamente como están (`CLAUDE.md`: nunca CORS
abierto, nunca bind fuera de `127.0.0.1` sin `POS_ALLOW_LAN`). Optimizar para tablets económicas:
memoria, batería, tiempos de carga.

## PROCESO DE TRABAJO

Módulo por módulo, sin big-bang. En cada etapa: analizar, explicar qué y por qué, mostrar el código,
esperar aprobación antes de seguir. Mantener Windows funcionando igual en cada paso — no cambios
grandes sin respaldo (`CLAUDE.md`: "no hacer cambios grandes sin backup").

Orden sugerido:
1. Terminar (o al menos estabilizar) la Fase 1 de modularización de `server.js` antes de sumar Android
   como segundo frente grande.
2. Prototipo Capacitor mínimo: empaquetar el frontend actual sin cambios, apuntando a un Express ya
   corriendo, solo para validar que Capacitor + WebView funcionan con este stack.
3. Responsive del frontend existente (sin Capacitor todavía) — se beneficia también la versión Windows
   en pantallas pequeñas.
4. Integrar impresión/cámara/notificaciones nativas vía plugins de Capacitor.
5. Validar el flujo offline en tablet real usando el sistema `/api/offline/*` ya existente.

## RESULTADO FINAL

- Windows (Electron) funcionando exactamente igual que hoy.
- Android (Capacitor) como cliente del mismo Express + MariaDB, reusando el sistema offline existente.
- Firebase sin cambios de alcance (solo auth de la app Flutter de reportes).
- Un solo código base de frontend compartido entre ambas plataformas.
- Documentado y aprobado módulo por módulo, no de una sola vez.

Funciones futuras (fuera de este alcance, solo como visión a largo plazo, no comprometerse a nada
todavía): mesas para restaurantes, KDS, meseros, delivery, multisucursal, pagos QR — evaluar cada una
por separado cuando llegue el momento, no diseñar para todas ahora.

# Tecno Caja — cliente Android (Capacitor)

Este wrapper **no empaqueta** `js/`, `css/` ni `index.html` dentro del APK. La
app carga esas páginas directo desde el Express que ya corre en la PC
principal (o el túnel/VPN configurado), igual que hoy hace el modo
"thin-client" de la versión Electron. Por eso `www/index.html` es solo un
placeholder de error — nunca se ve en uso normal.

## Requisitos ya verificados en esta máquina

- Node 24 / npm 11 ✅
- Java 17 (OpenJDK Microsoft) ✅
- Android SDK en `%LOCALAPPDATA%\Android\Sdk` ✅ (instalado, `ANDROID_HOME` no
  estaba seteado en la shell — no hace falta, `local.properties` ya apunta ahí)
- Para abrir el proyecto en la UI de Android Studio (recomendado para correr
  en emulador/dispositivo con debugging visual) hace falta tenerlo instalado
  aparte; para compilar por línea de comandos no es necesario.

## Antes de compilar o correr: apuntar al servidor correcto

`capacitor.config.json` tiene hardcodeado:

```json
"server": { "url": "http://192.168.100.62:3000", "cleartext": true }
```

Eso es la IP LAN de esta máquina de desarrollo detectada en esta sesión y el
puerto por defecto de `npm start`/`npm run dev` (`PORT=3000` en
`.env.example`). **Esto es solo para el prototipo — no es el modelo final**
de conexión (eso lo resuelve el Paso 5, una pantalla de configuración de
servidor como la que ya existe para el modo thin-client de Electron). Antes
de probar:

1. Confirma la IP LAN real de la PC donde corre el servidor (`ipconfig`) y el
   puerto real (`3000` con `npm start`, o `3399` si es la app de Electron
   empaquetada — ver `docs/ARCHITECTURE.md`).
2. En esa PC, en `.env`, pon `POS_ALLOW_LAN=true` (por defecto es `false` —
   con `false` el servidor solo escucha en `127.0.0.1` y el celular/tablet no
   va a poder alcanzarlo aunque esté en la misma red).
3. Edita `url` en `capacitor.config.json` con esa IP:puerto.
4. Corre `npx cap sync android` para que el cambio se propague al proyecto
   nativo.
5. El celular/tablet debe estar en la **misma red LAN** que la PC (o
   conectado al mismo Tailscale/túnel Cloudflare si se prueba fuera de la
   LAN).

`cleartext: true` + `android:usesCleartextTraffic="true"` (ya seteado a mano
en `android/app/src/main/AndroidManifest.xml`, porque Capacitor 8 solo
inyecta ese atributo automáticamente cuando hay plugins Cordova de por
medio) permiten tráfico HTTP plano — el servidor de Tecno Caja no tiene TLS
en LAN. Si en el futuro se sirve por HTTPS (túnel Cloudflare, por ejemplo),
esto deja de ser necesario para esa ruta.

## Comandos

```bash
# Instalar dependencias (ya hecho en este scaffold inicial)
npm install

# Después de tocar capacitor.config.json o agregar plugins:
npx cap sync android

# Abrir en Android Studio (recomendado para correr en emulador/dispositivo):
npx cap open android

# Compilar APK debug por línea de comandos (requiere Android SDK):
cd android && ./gradlew.bat assembleDebug
# APK queda en android/app/build/outputs/apk/debug/app-debug.apk
```

## Qué falta después de este prototipo (ver plan en `docs/prompt-android-multiplataforma-tecnocaja.md`)

- Auditar los ~47 usos sin guardar de `window.novaDesktop` en `js/` (impresión,
  gaveta, actualizaciones) — en Android ese puente no existe y van a tronar
  hasta que se blinden o se reemplacen por un shim con plugins de Capacitor.
- Responsive real de `css/` para pantallas de teléfono/tablet.
- Plugins nativos para impresión ESC/POS (Bluetooth/USB OTG), cámara
  (código de barras/QR) y notificaciones locales.
- Pantalla de configuración de servidor dinámica (reemplaza la URL fija de
  `capacitor.config.json` por algo guardado en el dispositivo, igual que
  `terminal:save-thin-client-config` en Electron).
- Cliente offline Android que hable el protocolo de
  `server/routes/offline.routes.js` (no reusa `db-local.js` tal cual — ese
  archivo es un módulo Node, no corre en el WebView).

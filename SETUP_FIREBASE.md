# 🔥 GUÍA DE CONFIGURACIÓN FIREBASE

## ¿QUÉ HACER?

Debes preparar tu proyecto Firebase para que:
1. Tecno Caja suba datos automáticamente ✓ (YA HECHO)
2. Tu app Flutter lea reportes desde la nube ✓ (NUEVAS INSTRUCCIONES)
3. Reglas de seguridad protejan los datos ✓ (NUEVAS INSTRUCCIONES)

---

## PASO 1: Verificar Proyecto Firebase Existente

Tu app Flutter YA usa Firebase. El ID de tu proyecto es:
```
inversiones-martinez-14703
```

✓ Verifica que el proyecto exista en:
https://console.firebase.google.com

---

## PASO 2: Crear Estructura de Firestore

### 1. Ve a Firestore Database
- Firebase Console → Tu Proyecto → "Firestore Database"
- Si aún no existe, haz clic en "Create database"
- Selecciona: "Start in production mode"
- Región: "nam5 (us-central)" o la más cercana

### 2. Crea las colecciones base (pueden estar vacías):

```
businesses/
  └ 1/ (ID de tu empresa)
      └ branches/
          └ 1/ (ID de tu rama principal)
              ├ sales/ (colección)
              ├ cash_closings/ (colección)
              ├ inventory/ (colección)
              └ daily_reports/ (colección)

users/
  └ user_uid/ (ID de usuario Firebase Auth)
      └ assigned_businesses: [1] (array de IDs de empresas)
```

**IMPORTANTE:** Las colecciones se crean automáticamente cuando Tecno Caja sube el primer documento.

---

## PASO 3: Aplicar Reglas de Seguridad

### 1. Ve a Firestore → "Rules"

### 2. Reemplaza TODO el contenido con esto:

📄 **Copia el contenido de `FIRESTORE_RULES.txt`**

### 3. Haz clic en "Publish"

✓ Las reglas están ahora activas.

---

## PASO 4: Configurar Firebase Admin en Tecno Caja

Tecno Caja NECESITA credenciales de Firebase Admin para sincronizar.

### 1. En Firebase Console:

- Ve a "Project Settings" (⚙️ arriba a la derecha)
- Selecciona la pestaña "Service Accounts"
- Haz clic en "Generate New Private Key"
- Se descargará un archivo JSON (guardalo con cuidado 🔒)

### 2. En tu servidor Tecno Caja:

Asegúrate de que `modules/firebase-admin.js` tenga las credenciales correctas.

Opción A (Recomendada):
```bash
# Crear variable de entorno
export FIREBASE_KEY_PATH=/ruta/al/archivo/descargar.json
```

Opción B:
```javascript
// En modules/firebase-admin.js
const admin = require('firebase-admin');

const serviceAccount = require('/ruta/al/archivo/descargado.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'inversiones-martinez-14703'
});
```

---

## PASO 5: Actualizar App Flutter

### 1. Cambiar `tecnocaja_api_settings_service.dart`

Tu app Flutter intenta conectar a `http://127.0.0.1:3399` pero esto ya NO es necesario.

```dart
// ANTES:
final baseUrl = await TecnoCajaApiSettingsService.instance.getBaseUrl();
// Intentaba conectar a servidor local

// DESPUÉS:
// Solo usar Firestore directamente (ya lo hace)
```

### 2. Verificar Repositorios

Los repositorios YA usan Firestore:
- `sales_repository.dart` ✓
- `dashboard_repository.dart` ✓
- `auth_repository.dart` ✓

**Cambio necesario:** Remover la línea que usa `PosSessionService`:

```dart
// EN auth_repository.dart línea ~75
// REMOVER ESTO:
await PosSessionService.instance.clearSession();

// PORQUE ya no necesita un servidor local
```

### 3. Crear usuario de prueba en Firebase Auth

1. Firebase Console → Authentication → Users
2. Haz clic en "Add user"
3. Crea un usuario de prueba:
   - Email: `test@example.com`
   - Password: `TempPassword123!`
4. Copia el UID del usuario

### 4. Crear documento de usuario en Firestore

```javascript
// Estructura a crear manualmente (una vez)
{
  "uid": "user_uid_aqui",
  "nombre": "Tu Nombre",
  "email": "test@example.com",
  "rol": "owner",
  "assigned_businesses": [1],
  "created_at": new Date()
}
```

Crea el documento en: `users/{uid}`

---

## PASO 6: Probar Todo

### 1. Iniciar Tecno Caja

```bash
npm run desktop
# O: npm start
```

Abre la página de configuración:
- Navega a: `http://localhost:3399/html/firebase-config.html`

### 2. Crear una venta en Tecno Caja

- Completa una venta normal
- Márcala como "Pagada"

### 3. Verificar sincronización

- En `firebase-config.html`, deberías ver:
  - ✓ "Sincronizado" en verde
  - 1 item en la cola
  - En Firebase Console → Firestore, debería aparecer el documento

### 4. Abrir app Flutter

```bash
cd reporte\ app
flutter run
# O para web:
flutter run -d chrome
```

- Inicia sesión con el usuario de prueba
- Abre la pantalla de reportes
- Deberías ver la venta que acabas de crear ✓

---

## TROUBLESHOOTING

### ❌ "No hay conexión a Firebase"

**Solución:**
- Verifica que `FIREBASE_API_KEY` en `firebase_options.dart` sea correcto
- Verifica que el proyecto Firebase exista
- Verifica CORS si es web

### ❌ "No puedo ver los datos en Flutter"

**Solución:**
- Verifica que `assigned_businesses` en Firebase inclua el ID de tu empresa
- Verifica que las reglas de Firestore estén publicadas
- Verifica que el usuario esté autenticado (check Auth.currentUser)

### ❌ "Tecno Caja no sincroniza"

**Solución:**
- Abre `firebase-config.html` y verifica el estado
- Busca errores en la consola del servidor
- Verifica que `firebase-admin.js` tenga credenciales correctas
- Verifica conexión a internet

### ❌ "Error 403 en Firestore"

**Solución:**
- Verifica que `assigned_businesses` contenga el ID de la empresa
- Verifica que las reglas se hayan publicado
- Verifica que el usuario está autenticado (no es anónimo)

---

## SIGUIENTE PASO

Una vez que todo funcione:

1. Personaliza los campos de `assigned_businesses` para cada usuario
2. Agrega más empresas si es necesario
3. Habilita autenticación adicional (Google, Apple, etc.)
4. Configura backups automáticos

---

## IMPORTANTE 🔒

- **NUNCA** compartas el archivo JSON de Firebase Admin
- **SIEMPRE** usa variables de entorno para credenciales
- **REVISA** regularmente los logs de sincronización
- **PRUEBA** en desarrollo antes de producción

---

¡Listo! Tu sistema de sincronización está completo. 🚀

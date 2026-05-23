# Guía: conectar el POS con la app Flutter "Reporte" (reporte-sistema-pos)

Esta guía te lleva paso a paso desde cero hasta tener la app móvil/desktop de Flutter leyendo datos en tiempo real del POS.

---

## 1. ¿Qué se hizo del lado del POS?

Se añadieron **dos módulos nuevos** al backend del POS:

1. `modules/firebase-reports-sync.js`
   - Escribe cada venta / apertura de caja / cierre / gasto / ingreso / producto / cliente / usuario a Firestore **en el formato exacto que la app Flutter espera**.
   - Fire-and-forget: si Firebase se cae o no está configurado, el POS sigue funcionando.
   - businessId se toma de `TECNO_CAJA_LICENSE_UID` (la licencia única de tu negocio).

2. `modules/firebase-reports-bootstrap.js`
   - Backfill inicial: lee el estado completo de MariaDB y lo empuja a Firestore.
   - Se usa UNA SOLA VEZ cuando el POS se conecta por primera vez al nuevo proyecto Firebase.

Y se engancharon hooks de sincronización en estos endpoints del POS:

- `POST /api/sales` → escribe venta + (si es crédito) receivable
- `POST /api/cash/open` → abre cashRegister en Firestore
- `POST /api/cash/close` → cierra cashRegister
- `POST /api/cash/expense` → cashMovement + expense
- `POST /api/cash/income` → cashMovement
- `POST /api/products` y `PUT /api/products/:id` → syncProduct
- `POST/PUT/DELETE /api/clients/:id` → syncCustomer / deleteCustomer
- `POST/PUT /api/users/:id` → ensureFirebaseUser (crea cuenta Firebase Auth + users/{uid})
- `POST /api/branches` + `DELETE /api/branches/:id` → syncBranch
- `POST/PUT /api/cash-registers` → syncCashRegister

También se agregaron estos endpoints administrativos nuevos:

- `GET  /api/firebase-reports/status` — verifica si el sync está activo.
- `POST /api/firebase-reports/bootstrap` — backfill completo (ver sección 5).
- `POST /api/firebase-reports/user/:id` — re-enviar un usuario POS a Firebase Auth.

---

## 2. Crear el proyecto Firebase (si aún no existe)

Si ya tienes `reporte-sistema-pos` saltáte este paso. Si no:

1. Ve a <https://console.firebase.google.com> y crea un proyecto llamado `reporte-sistema-pos`.
2. **Habilita Authentication**:
   - Authentication → Sign-in method → Email/Password → Enable.
3. **Habilita Firestore**:
   - Firestore Database → Create database → modo producción → región cercana (us-east1 o us-central1).
4. **Habilita Storage** (para fotos de productos, opcional):
   - Storage → Get started → modo producción.
5. **Crea una cuenta de servicio**:
   - Project Settings → Service accounts → Generate new private key → descarga el JSON.
   - Guárdalo en un sitio seguro como `firebase-service-account.json` **FUERA del repositorio** (o añádelo al `.gitignore`).

---

## 3. Configurar el POS (lado Node/Electron)

En tu archivo `.env` del POS (ver `.env.example` si no existe) añade o edita:

```bash
# Credencial de servicio para Firebase Admin SDK (ruta absoluta o JSON en una línea)
TECNO_CAJA_FIREBASE_SERVICE_ACCOUNT=C:\Users\Emilio\secure\firebase-service-account.json

# ID único de este negocio en la nube (cualquier string estable — recomiendo `pos_<hex>`)
TECNO_CAJA_LICENSE_UID=pos_263f4a2b0bde
```

> El `TECNO_CAJA_LICENSE_UID` es la clave que liga todos los datos de **este POS** con **tus apps Flutter**. Cópialo porque lo usarás en la app móvil (sección 4).

Reinicia el POS:

```bash
npm run desktop
```

Verifica que quedó activo:

```bash
curl http://127.0.0.1:3399/api/firebase-reports/status
```

Debe responder `{ "enabled": true, "businessId": "pos_263f4a2b0bde", ... }`.

Si `enabled: false`, revisa los logs de Electron/servidor — probablemente la ruta del service account está mal.

---

## 4. Configurar la app Flutter (reporte app)

La app Flutter debe apuntar al **mismo proyecto Firebase** que usa el POS.

1. Instalá el CLI de FlutterFire si no lo tenés:

   ```bash
   dart pub global activate flutterfire_cli
   ```

2. Desde la carpeta `reporte app/`:

   ```bash
   cd "C:\Users\Emilio Coding IA\Desktop\sistema pos completo\reporte app"
   flutterfire configure --project=reporte-sistema-pos
   ```

   Esto regenera `lib/firebase_options.dart` para Android / iOS / Windows / macOS / Web.

3. Añadí (o ajustá) la variable del `businessId` en el código de la app para que **coincida con el POS**. Busca algo como:

   ```dart
   // lib/core/constants/app_strings.dart
   static const String kDefaultBusinessId = 'pos_263f4a2b0bde';
   ```

   Si no existe esa constante todavía, el modelo `UserModel` ya resuelve `businessId` del documento `users/{uid}` en Firestore — el POS lo guarda automáticamente al crear/editar usuarios, así que **no tenés que hardcodear nada**.

4. Compilá:

   ```bash
   flutter pub get
   flutter run         # debug en tu device
   flutter build apk   # release Android
   flutter build ios   # release iOS (en Mac)
   ```

---

## 5. Backfill inicial (la primera vez)

Esto sube TODO lo que ya tenés en el POS (sucursales, cajas, productos, clientes, últimas ventas, movimientos de caja) a Firestore, para que la app no se vea vacía la primera vez.

Desde el POS (cualquier cliente HTTP, o con curl si tenés permisos de admin):

```bash
curl -X POST http://127.0.0.1:3399/api/firebase-reports/bootstrap \
     -H "x-user-id: <tu-id-admin>" \
     -H "Content-Type: application/json"
```

Respuesta esperada (ejemplo):

```json
{
  "ok": true,
  "businessId": "pos_263f4a2b0bde",
  "branches": 3,
  "cashRegisters": 5,
  "products": 412,
  "customers": 87,
  "sales": 1249,
  "receivables": 14,
  "expenses": 68,
  "errors": []
}
```

Tarda entre 10 segundos y un par de minutos, dependiendo del volumen.

A partir de ahí, **cada nueva venta/cierre/gasto/producto se escribe en tiempo real** — no hay que volver a bootstrappear.

---

## 6. Crear el primer usuario para la app Flutter

Los empleados del POS se migran automáticamente a Firebase Auth cuando:

- **Creás un usuario nuevo**: `POST /api/users` → se dispara `ensureFirebaseUser` si el usuario trae email y password.
- **Editás un usuario**: `PUT /api/users/:id` → idem.
- **Usuarios ya existentes**: se pueden empujar con el endpoint manual:

  ```bash
  curl -X POST http://127.0.0.1:3399/api/firebase-reports/user/<id> \
       -H "Content-Type: application/json" \
       -d '{"password": "contraseña-temporal-para-la-app"}'
  ```

Requisitos para que Firebase Auth acepte la cuenta:
- email válido (no vacío)
- password con **al menos 6 caracteres**
- estado = Activo

Los roles se mapean así entre POS → Flutter:

| POS                        | Flutter (`UserRole`)  | Permisos en la app                           |
|----------------------------|-----------------------|----------------------------------------------|
| `administrador` / `admin`  | `admin`               | Ve todas las sucursales                      |
| `gerente` / `branch_admin` | `branchAdmin`         | Ve solo su sucursal                          |
| `supervisor`               | `supervisor`          | Ve solo su sucursal, módulos permitidos      |

---

## 7. Esquema de datos en Firestore

Para que puedas entender qué escribe el POS y qué lee Flutter:

```
businesses/
  {businessId}/                          ← ej: pos_263f4a2b0bde
    name, rnc, address, currency, planCode, licenseStatus

    branches/{branchId}                  ← sucursales
    cashRegisters/{cashRegisterId}       ← cajas (incluye sesión activa)
    cashMovements/{movId}                ← entradas/salidas/retiros/gastos
    products/{productId}                 ← catálogo
    customers/{customerId}               ← clientes
    sales/{invoiceNumber}                ← ventas (con items incluidos)
    expenses/{expenseId}                 ← egresos (duplicado de salidas)
    receivables/{receivableId}           ← cuentas por cobrar
    inventoryMovements/{movId}           ← historial de stock
    alerts/{alertId}                     ← notificaciones push

users/
  {firebaseUid}/                         ← perfil a nivel raíz
    displayName, email, role, isActive,
    businessId, businessIds[], branchIds[], allowedModules[]
```

---

## 8. Reglas de seguridad de Firestore (mínimas sugeridas)

En la consola de Firebase, Firestore → Rules, pegá esto (ajustá según necesites):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Cada user lee su propio perfil
    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if false; // solo el POS (admin SDK) escribe
    }

    // Data del negocio: solo lectura para usuarios autenticados que pertenezcan al business
    match /businesses/{businessId}/{document=**} {
      allow read: if request.auth != null &&
                  get(/databases/$(database)/documents/users/$(request.auth.uid))
                    .data.businessIds.hasAny([businessId]);
      allow write: if false; // solo el POS (admin SDK) escribe
    }
  }
}
```

---

## 9. Troubleshooting

| Síntoma                                            | Causa probable                                              | Solución                                                                                                   |
|----------------------------------------------------|-------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| `/api/firebase-reports/status` → `enabled: false`  | Falta o está mal la credencial de servicio                 | Verificar `TECNO_CAJA_FIREBASE_SERVICE_ACCOUNT` en `.env` y reiniciar.                                        |
| Las ventas no aparecen en la app                   | El bootstrap nunca se ejecutó                              | `POST /api/firebase-reports/bootstrap`                                                                     |
| Un empleado nuevo no puede loguearse en la app     | No tenía contraseña al crearse                             | `POST /api/firebase-reports/user/<id>` con `{"password": "..."}` mínimo 6 caracteres.                      |
| App Flutter dice "user has no business"            | El doc `users/{uid}` no tiene `businessIds`                | Re-ejecutar el endpoint del punto anterior — siempre escribe `businessIds: [businessId]`.                  |
| Ventas aparecen con pequeño retraso                | Normal: fire-and-forget con batching de Firestore          | Debería llegar en < 1 segundo. Si tarda >10s, revisa conexión.                                             |
| Logs dicen `[reports-sync] syncX falló`            | Error de permisos / reglas                                 | Revisar reglas Firestore y que el service account tenga rol "Firebase Admin SDK Administrator Service Agent". |
| Hay datos duplicados                               | Bootstrap se ejecutó varias veces con IDs distintos        | Firestore usa `merge: true`, pero si cambiaste `TECNO_CAJA_LICENSE_UID` en medio, se creó otro `businessId`.  |

---

## 10. Variables de entorno importantes

| Variable                              | Requerida | Descripción                                                                     |
|---------------------------------------|-----------|---------------------------------------------------------------------------------|
| `TECNO_CAJA_FIREBASE_SERVICE_ACCOUNT`    | Sí        | Ruta al JSON o el JSON en sí (una línea). Necesario para el sync.               |
| `TECNO_CAJA_LICENSE_UID`                 | Sí        | businessId estable para este POS. Si lo cambiás, todos los datos "empiezan de nuevo". |
| `TECNO_CAJA_FIREBASE_CLIENTS_COLLECTION` | No        | Colección de clientes en el proyecto legacy (se mantiene por compatibilidad). |

---

## 11. Qué NO hace esto (todavía)

- No borra ventas de Firestore si las cancelás en el POS — `markSaleCancelled` está implementado pero hay que engancharlo en `/api/sales/:id/cancel` cuando armes ese endpoint.
- No sincroniza inventario en tiempo real (cada vez que cambia stock) — solo al crear/editar el producto o cuando se vende.
- No tiene compresión de payload — si tenés > 10k ventas/mes pensá en hacer agregados diarios.
- No hace migración automática de datos del proyecto `inversiones-martinez-14703` al nuevo. Si querés eso, hay que hacer un script aparte.

---

## 12. Checklist final antes de soltarlo a producción

- [ ] Service account generado y guardado seguro (NUNCA commitearlo).
- [ ] `.env` con `TECNO_CAJA_FIREBASE_SERVICE_ACCOUNT` y `TECNO_CAJA_LICENSE_UID`.
- [ ] `GET /api/firebase-reports/status` responde `enabled: true`.
- [ ] `POST /api/firebase-reports/bootstrap` ejecutado exitosamente.
- [ ] Al menos un usuario admin migrado con contraseña (`ensureFirebaseUser`).
- [ ] App Flutter configurada con `flutterfire configure` al mismo proyecto.
- [ ] Login exitoso con el mismo email/password del POS.
- [ ] Dashboard muestra sucursales, ventas del día, clientes.
- [ ] Reglas de Firestore puestas (sección 8).
- [ ] Probada una venta nueva desde el POS → aparece en la app en < 5 segundos.

---

¿Dudas? Todo el código vive en:

- `modules/firebase-reports-sync.js` — mappers POS → Firestore
- `modules/firebase-reports-bootstrap.js` — backfill
- `server.js` (líneas 17, 24-86, endpoints marcados con `// ── Sync reporte-sistema-pos`) — hooks
- `reporte app/lib/data/models/user_model.dart` — modelo que la app consume

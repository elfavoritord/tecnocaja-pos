# Setup 2 PCs en la misma red para Tecno Caja

## Resumen corto

Sí puedes trabajar con 2 PCs, pero debe ser en modo centralizado:

- No uses `DB_CLIENT=sqlite`.
- No uses la base `.db` local para dos equipos.
- Lo correcto es `DB_CLIENT=mysql`.

## Nuevo flujo automático

Desde esta versión, Tecno Caja puede preparar automáticamente el equipo principal para LAN cuando trabajas con `DB_CLIENT=mysql`:

- habilita el perfil HTTP del principal para aceptar conexiones de la red en el siguiente reinicio
- prepara MariaDB/MySQL local para escuchar en la LAN en el siguiente reinicio
- genera un usuario MySQL dedicado para terminales secundarias
- permite que la PC secundaria se vincule desde el wizard usando:
  - IP o URL del equipo principal
  - usuario administrador
  - contraseña
  - clave de red

La PC secundaria ya no necesita editar `.env` manualmente si el principal fue preparado correctamente.

## Importante sobre el primer reinicio del principal

Si el equipo principal estaba abierto antes de activar `multicaja`, `sucursal` o `multisucursal`, la publicación real en LAN necesita un reinicio de Tecno Caja para que:

- el servidor HTTP pase a `0.0.0.0`
- MariaDB/MySQL local pase a `0.0.0.0`

Después de ese reinicio, la terminal secundaria ya puede vincularse sola desde el wizard.

## Arquitectura recomendada

```text
PC PRINCIPAL
- Tecno Caja Desktop
- MySQL/MariaDB central
- Caja principal

PC SECUNDARIA
- Tecno Caja Desktop
- Se conecta al mismo MySQL/MariaDB central
- Caja secundaria
```

Cada PC ejecuta su propio Electron + servidor local, pero ambas trabajan contra la misma base central.

## Caso 1: dos cajas en la misma sucursal

Usa:

- modo `multicaja`
- plan `Pro`

## Caso 2: dos sucursales diferentes

Usa:

- modo `multisucursal`
- plan `Plus`

## Paso 1. Preparar el servidor MySQL/MariaDB central

Si lo vas a instalar en la PC principal:

1. Instala MariaDB/MySQL como servicio de Windows.
2. Configura el listener para aceptar conexiones de red.
3. Abre el puerto `3306` en el firewall.
4. Crea la base y el usuario del sistema.

Ejemplo SQL:

```sql
CREATE DATABASE tecnocaja CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'tecnocaja'@'%' IDENTIFIED BY 'TuClaveFuerteAqui';
GRANT ALL PRIVILEGES ON tecnocaja.* TO 'tecnocaja'@'%';
FLUSH PRIVILEGES;
```

En el archivo de configuración de MariaDB/MySQL:

```ini
[mysqld]
bind-address=0.0.0.0
port=3306
```

Luego reinicia el servicio.

## Paso 2. Inicializar el esquema de Tecno Caja

En la PC principal, con las variables apuntando a ese MySQL:

```env
DB_CLIENT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=tecnocaja
DB_PASSWORD=TuClaveFuerteAqui
DB_NAME=tecnocaja
```

Ejecuta:

```powershell
npm install
npm run db:init:mysql
```

Si ya tienes datos en SQLite:

```powershell
npm run db:migrate:mysql
```

## Paso 3. Configurar la PC principal

Archivo `.env` sugerido en la PC principal:

```env
PORT=3399
DB_CLIENT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=tecnocaja
DB_PASSWORD=TuClaveFuerteAqui
DB_NAME=tecnocaja

POS_ALLOW_LAN=false
POS_BIND_HOST=127.0.0.1
TECNO_CAJA_MYSQL_ALLOW_LAN=false
TECNO_CAJA_MYSQL_BIND_HOST=127.0.0.1

FIREBASE_PROJECT_ID=tu-proyecto
FIREBASE_SERVICE_ACCOUNT_PATH=C:\Ruta\firebase-key.json
TECNO_CAJA_LICENSE_UID=lic_xxx
TECNO_CAJA_LICENSE_REQUIRE_SIGNATURE=true
```

Notas:

- El wizard del equipo principal puede cambiar estos valores automáticamente cuando eliges `multicaja`, `sucursal` o `multisucursal`.
- Tras ese cambio, reinicia Tecno Caja una vez para que queden activos en la LAN.

## Paso 4. Configurar la PC secundaria

Supongamos que la IP LAN de la PC principal es `192.168.1.50`.

Si usarás el flujo nuevo del wizard, no necesitas editar `.env` a mano en la secundaria.

Solo como respaldo manual, este sería el `.env` esperado:

```env
PORT=3399
DB_CLIENT=mysql
DB_HOST=192.168.1.50
DB_PORT=3306
DB_USER=tecnocaja
DB_PASSWORD=TuClaveFuerteAqui
DB_NAME=tecnocaja

POS_ALLOW_LAN=false
POS_BIND_HOST=127.0.0.1

FIREBASE_PROJECT_ID=tu-proyecto
FIREBASE_SERVICE_ACCOUNT_PATH=C:\Ruta\firebase-key.json
TECNO_CAJA_LICENSE_UID=lic_xxx
TECNO_CAJA_LICENSE_REQUIRE_SIGNATURE=true
```

Importante:

- En la secundaria, `DB_HOST` debe ser la IP del servidor MySQL central.
- Si la secundaria no puede abrir `192.168.1.50:3306`, el problema es red/firewall/MySQL, no Tecno Caja.

## Paso 5. Flujo correcto de instalación

### En la PC principal

1. Ejecuta Tecno Caja.
2. Haz la configuración inicial.
3. Si son dos cajas de la misma sucursal:
   - elige `Multicaja`
4. Si son dos ubicaciones distintas:
   - elige `Multisucursal`
5. Define una `clave de red`.
6. Crea el administrador principal.
7. Termina la instalación.
8. Dentro del sistema, crea:
   - la segunda caja si será multicaja
   - o la segunda sucursal y su caja si será multisucursal

### En la PC secundaria

1. Instala Tecno Caja.
2. Ejecuta Tecno Caja.
3. En la pantalla inicial usa:
   - `Reinstalar una app existente`
4. Selecciona:
   - `Multicaja` si será otra caja de la misma sucursal
   - `Sucursal` o `Multisucursal` si será una terminal de otra sucursal
5. Elige:
   - `Conectar a un sistema existente`
6. Ingresa:
   - IP o URL del equipo principal
   - usuario administrador
   - contraseña
   - clave de red
7. Selecciona:
   - sucursal
   - caja
8. Finaliza la vinculación.
9. La app aplicará el perfil y se reiniciará sola.

## Paso 6. Licencia para 2 PCs

Con el endurecimiento nuevo de licencias, ahora debes considerar dos cosas:

1. `deviceLimit`
2. firma por dispositivo

### Requisito mínimo

Tu documento de licencia en Firebase debe permitir 2 equipos:

```json
{
  "licenseId": "lic_xxx",
  "status": "active",
  "planCode": "pro",
  "deviceLimit": 2,
  "offlineGraceDays": 3
}
```

### Firma por dispositivo

La firma usa `device_id` dentro del payload.

Eso implica que para 2 PCs no basta con una sola firma fija si el backend firma por dispositivo.

Debes manejar una de estas dos estrategias:

1. `deviceSignatures[deviceId]` en Firestore
2. un backend que regenere la firma cuando autorices un nuevo dispositivo

Ejemplo:

```json
{
  "licenseId": "lic_xxx",
  "status": "active",
  "planCode": "pro",
  "deviceLimit": 2,
  "offlineGraceDays": 3,
  "deviceSignatures": {
    "npd_pc_1": "firma_1",
    "npd_pc_2": "firma_2"
  }
}
```

Si no haces esto, la segunda PC quedará bloqueada por firma inválida aunque tenga acceso a la base.

## Paso 7. Validación rápida

### Desde la PC secundaria

Prueba conectividad al MySQL central:

```powershell
Test-NetConnection 192.168.1.50 -Port 3306
```

Debe responder `TcpTestSucceeded : True`.

## Problemas comunes

### La secundaria no conecta

Revisa:

- firewall de Windows en la principal
- `bind-address=0.0.0.0`
- puerto `3306`
- usuario MySQL con acceso remoto
- IP correcta en `DB_HOST`

### Las dos PCs abren pero no comparten datos

Causa típica:

- una sigue en `sqlite`
- o ambas apuntan a bases MySQL distintas

### La segunda PC se bloquea por licencia

Revisa:

- `deviceLimit >= 2`
- licencia activa en Firebase
- firma para el `deviceId` de la segunda PC

## Configuración recomendada final

### Principal

```env
DB_CLIENT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=tecnocaja
DB_PASSWORD=TuClaveFuerteAqui
DB_NAME=tecnocaja
```

### Secundaria

```env
DB_CLIENT=mysql
DB_HOST=192.168.1.50
DB_PORT=3306
DB_USER=tecnocaja
DB_PASSWORD=TuClaveFuerteAqui
DB_NAME=tecnocaja
```

## Recomendación práctica

Si quieres la instalación más estable para 2 PCs:

- usa la PC principal solo como servidor de base + caja principal
- usa la secundaria como otra caja
- no compartas SQLite
- no dependas del MariaDB embebido para red
- deja la licencia en Firebase con `deviceLimit=2` y firma por dispositivo

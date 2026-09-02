# Comandos rápidos de soporte (PC de cliente, Windows)

Cheatsheet armado a partir de una sesión real de soporte remoto (activar multicaja en una
instalación existente de un restaurante, agosto 2026). Todo esto se corre en la consola
(`cmd` o PowerShell) de la PC del cliente vía acceso remoto.

## 0. Encontrar dónde vive la config real de esta instalación

Instalaciones nuevas usan `Tecno Caja` como nombre de carpeta; instalaciones viejas (o
algunas hechas antes del rebrand) siguen usando el nombre interno legado `pos-system`.
**No asumas cuál es** — confírmalo con el log de arranque:

```
type "%TEMP%\tecnocaja-electron-startup.log"
```

Busca la línea `User data:` — esa es la carpeta real (`AppData\Roaming\Tecno Caja` o
`AppData\Roaming\pos-system`). Todo lo demás (`config\app.env`, `data\tecnocaja.db`,
`logs\`) cuelga de esa carpeta, sea cual sea.

## 1. Activar modo MySQL centralizado en una instalación que ya tenía datos

> **Desde v1.3.27 esto es AUTOMÁTICO.** En la app, Configuración → Estructura del
> negocio → **Multicaja / Multisucursal** → Guardar. La app pide confirmación, hace una
> copia de seguridad del `.db` (`tecnocaja.db.pre-mysql-<fecha>.bak`, junto al original),
> reinicia sola y migra los datos a MariaDB en el arranque. Si la migración falla, vuelve
> sola a SQLite con los datos intactos y muestra el error (marcador
> `config\pending-db-migration.json.failed`). El asistente de "empresa nueva" que elige
> Multicaja también cambia a MySQL solo, sin migración (no hay datos que mover).
>
> Lo de abajo es el **procedimiento manual** — sólo si el automático falló o para soporte
> remoto sin abrir la app.

Necesario antes de poder vincular una segunda caja/sucursal por LAN o Tailscale — una
instalación monocaja normalmente corre en SQLite (`DB_CLIENT=sqlite`, el default), que no
se puede compartir entre PCs.

1. Cierra Tecno Caja.
2. Edita `<carpeta de datos>\config\app.env` (créalo si no existe) y cambia/agrega:
   ```
   DB_CLIENT=mysql
   ```
   No toques el resto de las líneas — ese archivo ya trae secretos reales
   (`TECNO_CAJA_LICENSE_STORAGE_SECRET`, `TECNO_CAJA_DB_KEY_SALT`, etc.).
3. Abre Tecno Caja. La primera vez instala/arranca MariaDB embebida — puede tardar 1-2
   minutos. Si aparece la pantalla de "configuración inicial" en vez del login normal, es
   la señal correcta (está viendo una MySQL vacía) — **no la completes**, sigue al paso 2.

## 2. Migrar los datos reales de SQLite a la MySQL nueva

El `.db` en disco está **cifrado en reposo** con una llave atada al hardware de la PC
(`server/security/local-machine-crypto.js`) — por eso este script solo funciona corrido en
la MISMA PC donde vive el archivo real. Necesita Node.js instalado (`winget install
OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements` si no lo
tiene, luego abrir una consola nueva).

Desde la carpeta del proyecto (o cualquier copia del repo con `npm install` hecho):

```
npm run db:migrate:mysql -- --dry-run
```

Revisa el resumen (cuántos registros por tabla), y si se ve bien, corre la migración real
(usa `INSERT IGNORE`, no borra ni duplica nada):

```
npm run db:migrate:mysql
```

Si no tienes el repo a mano en esa PC, corre el script suelto apuntando explícitamente al
`.db` real (la ruta la sacas del log de arranque, paso 0):

```
node scripts/migrate-sqlite-to-mysql.js --sqlite="C:\Users\<usuario>\AppData\Roaming\<Tecno Caja|pos-system>\data\tecnocaja.db"
```

**Gotcha `businesses`/`config`:** esas dos tablas traen una fila "de fábrica" genérica
desde `db/schema.sql` (`business_name='Tecno Caja'`, `business_structure_mode='monocaja'`,
etc.) que colisiona por ID con la fila real, y `INSERT IGNORE` no la pisa — el negocio
quedaría con RNC/nombre genéricos y en modo monocaja (y la principal **no** podría publicar
la red). Para forzarlas, corre la migración con `--force-identity` (hace upsert de esas dos
filas):

```
npm run db:migrate:mysql -- --force-identity
```

**Gotcha "FALTA TABLA":** si la migración corta con `FALTA TABLA` / `Migracion incompleta`,
es que corriste el script contra una MySQL a la que el POS todavía no se conectó (las tablas
de secuencias fiscales las crea el POS al arrancar, no `db/schema.sql`). Abre Tecno Caja una
vez contra la MySQL nueva (deja que llegue al login o a la pantalla de configuración inicial,
sin completarla) y vuelve a correr la migración. Desde agosto 2026 el script también intenta
crear esas tablas él mismo (`ensureRuntimeTables`), así que normalmente no debería pasar.

## 3. Verificar que MariaDB está publicada en la LAN

```
netstat -an | findstr 3306
```

- `0.0.0.0:3306 LISTENING` → bien, accesible desde otras PCs/Tailscale.
- `127.0.0.1:3306` → solo localhost, la secundaria no va a poder conectar.

Si dice `127.0.0.1` después de activar multicaja/sucursal y reiniciar la app, el motor de
MariaDB ya estaba corriendo antes del cambio y no relee su config solo (arreglado en el
código desde agosto 2026 — `scripts/ensure-local-mysql.js`, reinicia el motor solo cuando
detecta el cambio de bind). Si por algún motivo sigue pasando en una versión vieja, el
fallback manual es:

```
sc stop TecnoCajaMariaDB
sc start TecnoCajaMariaDB
```

Si da `ERROR 1060` (no existe como servicio), es que corre como proceso suelto — mátalo
desde una consola **como administrador** y reabre Tecno Caja para que lo relance con la
config nueva:

```
taskkill /F /IM mariadbd.exe
```

## 4. Probar conectividad Tailscale/LAN hacia la principal

Desde la PC secundaria, con la IP Tailscale de la principal (ojo con no confundir cuál es
cuál — verifícalo en el ícono de Tailscale de cada PC, "This device: ..."):

```
Test-NetConnection <IP-tailscale-principal> -Port 3399
Test-NetConnection <IP-tailscale-principal> -Port 3306
```

Ambos deben responder `TcpTestSucceeded : True`.

## 5. Desinstalar Tecno Caja por completo (sin reiniciar ni formatear Windows)

Ya existe un desinstalador oficial completo — no hace falta un script aparte
(`build/installer.nsh`, hook `customUnInstall`):

```
"%LOCALAPPDATA%\Programs\Tecno Caja\Uninstall Tecno Caja.exe"
```

Detiene y elimina el servicio/proceso de MariaDB y la regla de Firewall siempre, y
pregunta si además quieres borrar TODOS los datos (base de datos, respaldos, imágenes,
config — incluye tanto la carpeta `Tecno Caja` como la legada `pos-system`, más
`ProgramData` y `Documents\TecnoCaja`). Responde según si vas a reinstalar de cero o
vas a migrar los datos.

`/S` lo corre silencioso para el asistente, pero la pregunta de "¿eliminar todos los
datos?" sigue apareciendo y esperando el clic — no queda 100% desatendido.

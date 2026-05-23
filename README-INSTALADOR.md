# Instalador Profesional POS System

## Descripción
Sistema POS moderno y profesional empaquetado con Electron, backend Node.js Express y base de datos SQLite embebida.

## Requisitos Previos
- No es necesario instalar un servidor de base de datos externo
- **Windows 10/11** (compatible con otras versiones pero probado en estas)

## Instalación

### 1. Preparativos
No es necesario instalar MariaDB ni MySQL. El sistema usa SQLite en un archivo local para que la app sea portátil.

### 2. Ejecutar el Instalador
1. Descarga el archivo `Super mercado Emilio Pos Setup X.X.X.exe`
2. Ejecuta el instalador como administrador
3. Sigue las instrucciones del asistente
4. Elige la ubicación de instalación (por defecto: `C:\Program Files\Super mercado Emilio Pos`)

### 3. Primera Ejecución
1. Abre la aplicación desde el acceso directo en el escritorio o menú inicio
2. Si es la primera vez, se inicializará automáticamente la base de datos
3. Completa el asistente de configuración inicial

## Funcionalidades del Instalador
- ✅ Empaquetado completo con Electron Builder
- ✅ Instalador NSIS para Windows
- ✅ Inicialización automática de base de datos
- ✅ Verificación automática de prerrequisitos de Windows
- ✅ Instalación automática de Microsoft Visual C++ Redistributable x64 si falta
- ✅ Creación de accesos directos
- ✅ Desinstalador integrado

## Prerrequisitos automáticos
- En la primera instalación, el `Setup.exe` verifica si Windows ya tiene `Microsoft Visual C++ Redistributable x64`.
- Si no está instalado, Tecno Caja intenta instalarlo automáticamente antes de terminar la instalación.
- Si colocas `vc_redist.x64.exe` junto al instalador, se usará esa copia local primero.
- Si no existe una copia local, el instalador intentará descargarla automáticamente desde Microsoft.
- Si no hay Internet y tampoco existe `vc_redist.x64.exe` junto al instalador, la instalación se detendrá con un mensaje claro para evitar que la app quede incompleta.

## Estructura del Proyecto
```
/main (Electron)
/backend (Express API)
/database (configuración DB)
/renderer (interfaz UI)
/build (configuración electron-builder)
```

## Configuración de Electron Builder
```json
{
  "win": {
    "target": {
      "target": "nsis",
      "arch": ["x64"]
    }
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true
  }
}
```

## Construir el Instalador
```bash
npm run build:desktop
```

## Manejo de Errores
- Si la base de datos SQLite no se inicializa: mostrar mensaje de error claro
- Logs de errores en `%TEMP%/tecnocaja-electron-startup.log`
- Verificación automática de conexión a DB
- Si falta Visual C++ Redistributable x64: instalar automáticamente o avisar exactamente qué archivo falta

## Licencia
Este proyecto incluye un sistema de licencia trial de 15 días.

## Soporte
Para soporte técnico, contacta al desarrollador.

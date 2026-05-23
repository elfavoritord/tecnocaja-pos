# ⚡ Tecno Caja — Sistema de Punto de Venta

Sistema POS moderno con frontend web y backend `Node.js + SQLite embebido`.

## MySQL Centralizado

Tecno Caja ahora puede trabajar en dos modos:

- `DB_CLIENT=sqlite`: modo local tradicional con archivo `.db`
- `DB_CLIENT=mysql`: modo centralizado para varias PCs, cajas y sucursales

### Variables recomendadas para MySQL

```env
DB_CLIENT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=123456
DB_NAME=tecnocaja
```

### Scripts nuevos

- `npm run db:init:mysql`: crea la base MySQL y carga `db/schema.sql`
- `npm run db:migrate:mysql`: migra los datos desde tu SQLite actual hacia MySQL

## 🚀 Puesta en Marcha

1. No necesitas un servidor de base de datos externo; SQLite funciona en un archivo local.
2. La base de datos se almacenará en `./data/tecnocaja.db` por defecto.
3. Instala dependencias:
   `npm install`
4. Inicializa la base de datos:
   `npm run db:init`
5. Inicia la aplicación:
   `npm start`
6. Abre:
   `http://localhost:3000`

## 💻 Modo Escritorio con Electron

1. Inicializa la base si aún no lo has hecho:
   `npm run db:init`
2. Abre la app de escritorio:
   `npm run desktop`

Electron levanta el servidor local automáticamente y abre Tecno Caja en una ventana nativa.

## 📱 POS Móvil por WiFi

Tecno Caja ahora incluye un módulo `POS Móvil` dentro del escritorio y una app Flutter en [flutter_mobile_pos](C:/Users/Emilio%20Coding%20IA/Desktop/pos-system/flutter_mobile_pos) para usar el teléfono como carrito remoto.

### Backend WiFi

- El servidor escucha en `0.0.0.0`, así que puede recibir conexiones desde tu red local.
- Socket.IO sincroniza productos y carrito en tiempo real.
- El módulo `POS Móvil` del escritorio muestra la IP de la PC, sesiones conectadas y un QR para el teléfono.

### App Flutter

1. Entra a [flutter_mobile_pos](C:/Users/Emilio%20Coding%20IA/Desktop/pos-system/flutter_mobile_pos)
2. Instala dependencias:
   `flutter pub get`
3. Ejecuta en tu teléfono o emulador:
   `flutter run`
4. En `Ajustes`, coloca la IP WiFi de tu PC, por ejemplo:
   `http://192.168.1.50:3399`

La app móvil permite:
- configurar IP del POS
- buscar productos
- escanear códigos de barra
- agregar al carrito
- editar cantidades
- vaciar carrito
- sincronizarse en tiempo real con Electron usando Socket.IO

## 🔐 Acceso Demo

- Usuario: `admin`
- Contraseña: `1234`
- Otros usuarios: `cajero1 / 1234`, `supervisor / 1234`

## ✅ Módulos conectados a la base de datos local

- Ventas
- Productos
- Inventario
- Clientes
- Caja
- Reportes
- Usuarios
- Configuración

## 📋 Módulos Incluidos

| Módulo | Funciones |
|---|---|
| 🛒 **Ventas** | Búsqueda, escaneo, cobro, recibo, suspender/recuperar |
| 📦 **Productos** | CRUD completo, exportar CSV |
| 📊 **Inventario** | Stock, alertas, ajustes manuales |
| 👥 **Clientes** | Registro, crédito, balance |
| 💰 **Caja** | Apertura/cierre, resumen del día |
| 📈 **Reportes** | Ventas, ganancias, ITBIS, historial |
| 🔐 **Usuarios** | Roles (Admin, Cajero, Supervisor) |
| ⚙️ **Configuración** | Negocio, facturación, temas, colores |

## ⌨️ Atajos de Teclado

| Tecla | Acción |
|---|---|
| `F2` | Enfocar búsqueda de productos |
| `F1` | Procesar venta (cobrar) |
| `Enter` | Agregar producto seleccionado |
| `↑ ↓` | Navegar resultados de búsqueda |
| `Esc` | Cerrar modal / dropdown |

## 💳 Métodos de Pago
- Efectivo (con cambio automático)
- Tarjeta
- Transferencia
- Crédito

## 🖨️ Impresión
- Compatible con impresoras térmicas 58mm y 80mm
- Soporte para impresoras normales (A4)
- Vista previa antes de imprimir
- Generación automática de recibo

## 🎨 Personalización
- Modo claro y oscuro
- 5 colores de acento disponibles
- Datos del negocio configurables

## 📁 Archivos clave

- `server.js`: API y servidor web
- `electron/main.js`: proceso principal de Electron
- `electron/preload.js`: puente seguro para la app de escritorio
- `db/schema.sql`: esquema y datos semilla
- `scripts/init-db.js`: inicializador de SQLite portátil
- `js/api.js`: cliente frontend para la API

---
**Tecno Caja v1.1** — Sistema POS Profesional para Negocios

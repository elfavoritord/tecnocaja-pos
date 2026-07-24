# Tecno Caja POS Android Pro (MVP ampliado)

Proyecto Flutter demostrativo con interfaz funcional y arquitectura inicial para convertir Tecno Caja POS en un ecosistema Android + Windows.

## Incluye ahora
- Inicio de sesión y entrada visual con Google (demo local).
- Dashboard, productos, ventas, carrito y cobro.
- Datos de prueba y creación local de productos.
- Módulos preparados: clientes, proveedores, caja, cotizaciones, reportes, usuarios y configuración.
- Simulación de conexión online/offline y vinculación con Windows.
- Dependencias declaradas para SQLite, Firebase, Google Sign-In, escáner e impresión Bluetooth ESC/POS 58 mm.
- Diseño adaptable a teléfonos y tabletas.

## Importante
Esto es un MVP ampliado y código base, no el producto comercial terminado. Firebase, Google, Bluetooth, DGII y la sincronización real necesitan credenciales, configuración nativa y la API segura del sistema Windows.

## Ejecutar
1. Instalar Flutter estable y Android Studio.
2. En esta carpeta: `flutter pub get`.
3. Crear plataformas si hace falta: `flutter create .`.
4. Ejecutar: `flutter run`.

Consulta `ARQUITECTURA_Y_PENDIENTES.md` e `INTEGRACION_TECNO_CAJA.md`.

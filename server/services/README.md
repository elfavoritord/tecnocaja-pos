# `server/services/`

Lógica de negocio pura, independiente de HTTP.

Reglas:
- No usar `req` ni `res`. Solo tipos de dominio.
- Devolver resultados o lanzar errores tipados.
- Cada servicio recibe la capa de datos por inyección (no hacer `require('../db')` directo).

Ejemplo esperado:
```js
// server/services/ventas.service.js
module.exports = function createVentasService({ ventasRepo, productosRepo, auditLogger }) {
  async function crearVenta(input) {
    // validaciones, cálculo de totales, descuentos, movimiento de inventario
    // delega persistencia al repo
  }
  return { crearVenta, anularVenta, ... };
};
```

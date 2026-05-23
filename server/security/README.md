# `server/security/`

Primitivas de seguridad reutilizables.

- `backup-crypto.js` — Cifrado/descifrado AES-256-GCM de respaldos `.novaseguro`
  con rotación de contraseñas y compatibilidad hacia atrás (fallback al password
  legado cuando el usuario rota credenciales).

Convenciones:
- No depender de la capa HTTP ni de la BD desde aquí.
- Funciones puras cuando sea posible.
- Tests unitarios obligatorios para cada helper en `tests/security/`.

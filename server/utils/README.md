# `server/utils/`

Helpers pequeños y reutilizables sin estado.

Candidatos a extraer (de `server.js`):
- `normalizeDateTime`, `parseStoredDateTime`, `formatSqlDateTimeLocal` → `dates.js`
- Helpers de dinero / redondeo → `money.js`
- Helpers de NCF (comprobantes fiscales DGII) → `ncf.js`
- Generación de códigos únicos (SKU, folios) → `codes.js`

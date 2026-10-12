# Tecno Caja — Tienda online (Cloud Run)

Servicio público de la tienda en línea de cada negocio. **No factura**: solo
muestra el catálogo que publica el POS y deja los pedidos en Firestore; el POS
los recibe y los cobra con su flujo normal. Arquitectura completa:
[`docs/TIENDA-ONLINE.md`](../../docs/TIENDA-ONLINE.md).

- `GET /t/:slug` — la tienda (catálogo, carrito, checkout)
- `GET /t/:slug/pedido/:id?k=…` — seguimiento del pedido
- `GET /api/tiendas/:slug` — catálogo público (sin costos)
- `POST /api/tiendas/:slug/cotizar` — totales del carrito
- `POST /api/tiendas/:slug/pedidos` — crear pedido (idempotente, reserva existencia en transacción)
- `GET /api/tiendas/:slug/pedidos/:id?k=…` — estado del pedido
- `GET /health`

`vendor/` es una copia de `server/tienda-online/contrato.js`,
`server/tienda-online/calculo-pedido.js` y `server/services/promotion-engine.js`
(misma lógica que el POS). Se regenera con `npm run vendor-sync` — correrlo
antes de cada deploy.

## Correr local

```bash
cd cloud/tienda-online
npm install
npm test
```

Las pruebas usan un Firestore en memoria (`tests/helpers/fake-firestore.js` del
repo). La prueba de punta a punta con el POS está en `tests/tienda-online/`.

## Desplegar

Mismo proyecto que el gateway e-CF (`reporte-sistema-pos`, us-east1):

```bash
npm run vendor-sync
gcloud run deploy tecno-caja-tienda --source . --region us-east1 \
  --allow-unauthenticated \
  --update-env-vars FIRESTORE_PROJECT_ID=reporte-sistema-pos,TZ=America/Santo_Domingo
```

Usa `--update-env-vars` (nunca `--set-env-vars`, borra lo demás). En
**PowerShell** pon el flag completo entre comillas simples
(`'--update-env-vars=FIRESTORE_PROJECT_ID=reporte-sistema-pos,TZ=America/Santo_Domingo'`):
sin comillas la coma parte el argumento, `FIRESTORE_PROJECT_ID` queda con
basura y toda la API responde 500 (Firestore `CONSUMER_INVALID`, código 7).
Después de desplegar, comprobar `GET /api/tiendas/<slug>` (no solo `/health`).

Si cambias algo de `public/`, sube el `?v=N` de los enlaces en
`public/index.html`: los estáticos se cachean 1 hora y, sin eso, el navegador
mezcla el JS viejo con el HTML nuevo. La imagen
debe ser Node 22: firebase-admin 14.5 / `@google-cloud/firestore` 9 piden
Node ≥ 22 y con Node 20 npm se salta Firestore sin avisar (el contenedor no arranca). La cuenta de
servicio necesita `roles/datastore.user`. Si la URL que devuelve no es
`https://tecno-caja-tienda-1052855422372.us-east1.run.app`, configúrala en el
POS con `TECNO_CAJA_TIENDA_URL`.

# Tecno Caja e-CF Gateway

Servicio independiente (Cloud Run) que responde a los endpoints públicos que DGII
llama durante la certificación e-CF y en producción:

- `GET /health`
- `GET /fe/autenticacion/api/semilla`
- `POST /fe/autenticacion/api/validacioncertificado`
- `POST /fe/recepcion/api/ecf`
- `POST /fe/aprobacioncomercial/api/ecf`
- `GET /admin/received` (token de administrador o de empresa, lo consume el POS)
- `GET|POST /admin/tenants` (solo administrador)
- `PUT /admin/tenants/:rnc/certificate` (administrador o la propia empresa)

No reemplaza el módulo e-CF del POS (`modules/ecf/`) ni sus endpoints locales
en `server/routes/dgii-public.routes.js`. Existe para que esas 3 URLs del
**Paso 7** de certificación DGII sigan respondiendo aunque la PC de Emilio
esté apagada.

## Multiempresa: misma URL, datos de cada empresa

Todos los clientes registran ante DGII **las mismas 3 URLs**. El Gateway sabe
de quién es cada documento por el RNC del XML:

| Llamada de DGII | Empresa dueña | Se guarda en |
|---|---|---|
| Recepción e-CF | `RNCComprador` | `ecf_gateway_tenants/{rnc}/received` |
| Aprobación comercial | `RNCEmisor` | `ecf_gateway_tenants/{rnc}/approvals` |

- El ARECF se firma con el certificado **de esa empresa** (el que se le subió
  al Gateway, o el que subió desde la app Android). El `CERT_PATH` solo se usa
  para la empresa por defecto (`GATEWAY_DEFAULT_RNC`); nunca se firma a nombre
  de otra empresa con él — si una empresa no tiene certificado, su ARECF sale
  sin firmar y el log lo dice.
- Un e-CF para un RNC que no es cliente se responde con ARECF Estado 1,
  motivo 4 ("RNC Comprador no corresponde") y no se guarda.
- Cada cliente tiene su **token de empresa** (`<rnc>.<secreto>`): con él su POS
  solo ve sus documentos. En Firestore solo se guarda el hash.
- Lo recibido antes del modo multiempresa (`ecf_gateway_received` /
  `ecf_gateway_approvals`) se sigue mostrando como de la empresa por defecto.
- Sin `GATEWAY_DEFAULT_RNC` el Gateway funciona como antes (una sola empresa).

### Dar de alta un cliente

```bash
GW=https://tecno-caja-ecf-gateway-1052855422372.us-east1.run.app
ADMIN=<GATEWAY_ADMIN_TOKEN>

# 1. Registrar la empresa — devuelve su token UNA sola vez, guárdalo.
curl -X POST $GW/admin/tenants -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"rnc":"131000001","nombre":"Colmado Ejemplo"}'

# 2. Subir su certificado .p12 (se valida la clave y se cifra con Cloud KMS).
curl -X PUT $GW/admin/tenants/131000001/certificate -H "Authorization: Bearer $ADMIN" \
  -F "certificado=@certificado-cliente.p12" -F "password=<clave del .p12>"

# Ver empresas registradas (sin tokens ni certificados).
curl $GW/admin/tenants -H "Authorization: Bearer $ADMIN"

# Desactivar una empresa / regenerar su token.
curl -X POST $GW/admin/tenants -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" -d '{"rnc":"131000001","active":false}'
curl -X POST $GW/admin/tenants -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" -d '{"rnc":"131000001","rotateToken":true}'
```

3. En el `.env` del POS del cliente: `ECF_GATEWAY_BASE_URL=$GW`,
   `ECF_GATEWAY_TOKEN=<su token>` y `DGII_RNC=<su RNC>`.
4. En el portal DGII del cliente (Paso 7) van las mismas 3 URLs de siempre:
   `$GW/fe/autenticacion/api/semilla`, `$GW/fe/recepcion/api/ecf`,
   `$GW/fe/aprobacioncomercial/api/ecf`.

## Correr local

```bash
cd cloud/ecf-gateway
npm install
cp .env.example .env   # y llena GATEWAY_ADMIN_TOKEN
npm run dev
```

Prueba rápida:

```bash
curl http://localhost:8080/health

curl -X POST http://localhost:8080/fe/recepcion/api/ecf \
  -H "Content-Type: application/xml" \
  --data-binary @"../../ecf/DGII_CARGAR_AHORA_4_XML_VERIFICADOS/<algún XML de ejemplo>"
```

## Tests

```bash
npm test
```

Usa un store en memoria (`NODE_ENV=test`, ver `lib/store.js`) — no requiere
credenciales de GCP para correr.

## Desplegar a Cloud Run

Requiere `gcloud` CLI autenticado con acceso al proyecto Firebase/GCP que ya
usa Tecno Caja (`reporte-sistema-pos` — ver `.firebaserc` en la raíz del repo).
No se crea un proyecto nuevo.

```bash
gcloud config set project reporte-sistema-pos

gcloud run deploy tecno-caja-ecf-gateway \
  --source . \
  --region us-east1 \
  --allow-unauthenticated \
  --set-env-vars DGII_ENVIRONMENT=CERT,GATEWAY_DEFAULT_RNC=40211932609,GATEWAY_BUSINESS_ID=tecnocaja-emilio,FIRESTORE_PROJECT_ID=reporte-sistema-pos \
  --set-env-vars GATEWAY_ADMIN_TOKEN=<token generado>
```

El comando imprime la URL pública, algo como:

```
https://tecno-caja-ecf-gateway-xxxxxxxxxx-ue.a.run.app
```

Esa es la URL base que va en **Configuración → DGII → URL Base** del POS
(reemplaza la URL del túnel Cloudflare). El wizard de certificación
(`js/ecf-cert-wizard.js`, Paso 7) deriva automáticamente las 3 URLs a partir
de esa base.

### Permisos de Firestore

El servicio necesita que la cuenta de servicio de Cloud Run tenga el rol
`roles/datastore.user` (o `Cloud Datastore User`) sobre el proyecto, para
poder leer/escribir en Firestore. Si usas la cuenta de servicio por defecto
de Compute Engine, este rol normalmente ya viene asignado; si no:

```bash
gcloud projects add-iam-policy-binding reporte-sistema-pos \
  --member="serviceAccount:<CUENTA-DE-SERVICIO>@developer.gserviceaccount.com" \
  --role="roles/datastore.user"
```

### Ver logs

```bash
gcloud run services logs read tecno-caja-ecf-gateway --region us-east1 --limit 100
```

### Actualizar (nuevo deploy)

Usa `--update-env-vars` (no `--set-env-vars`, que borra las variables y los
secretos ya montados como `CERT_PATH`/`CERT_PASSWORD`):

```bash
npm run vendor-sync
gcloud run deploy tecno-caja-ecf-gateway --source . --region us-east1 \
  --update-env-vars GATEWAY_DEFAULT_RNC=40211932609
```

Crea una nueva revisión y mueve el 100% del tráfico a ella automáticamente.
La cuenta de servicio necesita además `roles/cloudkms.cryptoKeyEncrypterDecrypter`
sobre `tecno-caja-fiscal/certificate-vault` (ya lo tiene) para cifrar y abrir
los certificados de cada empresa.

### Rollback

```bash
gcloud run revisions list --service tecno-caja-ecf-gateway --region us-east1
gcloud run services update-traffic tecno-caja-ecf-gateway \
  --region us-east1 --to-revisions <REVISION-ANTERIOR>=100
```

## Qué NO hace (todavía)

- No firma el ack JSON de Aprobación Comercial (solo el ARECF de recepción).
- No tiene cola de reintentos.
- La semilla y la validación de certificado (`/fe/autenticacion/*`) siguen
  siendo respuestas fijas, iguales para todas las empresas.

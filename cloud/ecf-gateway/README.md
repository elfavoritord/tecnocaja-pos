# Tecno Caja e-CF Gateway

Servicio independiente (Cloud Run) que responde a los endpoints públicos que DGII
llama durante la certificación e-CF y en producción:

- `GET /health`
- `GET /fe/autenticacion/api/semilla`
- `POST /fe/autenticacion/api/validacioncertificado`
- `POST /fe/recepcion/api/ecf`
- `POST /fe/aprobacioncomercial/api/ecf`
- `GET /admin/received` (protegido con `GATEWAY_ADMIN_TOKEN`, lo consume el POS)

No reemplaza el módulo e-CF del POS (`modules/ecf/`) ni sus endpoints locales
en `server/routes/dgii-public.routes.js`. Existe para que esas 3 URLs del
**Paso 7** de certificación DGII sigan respondiendo aunque la PC de Emilio
esté apagada.

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
  --set-env-vars DGII_ENVIRONMENT=CERT,GATEWAY_BUSINESS_ID=tecnocaja-emilio,FIRESTORE_PROJECT_ID=reporte-sistema-pos \
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

Repite el mismo comando `gcloud run deploy` — crea una nueva revisión y
mueve el 100% del tráfico a ella automáticamente.

### Rollback

```bash
gcloud run revisions list --service tecno-caja-ecf-gateway --region us-east1
gcloud run services update-traffic tecno-caja-ecf-gateway \
  --region us-east1 --to-revisions <REVISION-ANTERIOR>=100
```

## Qué NO hace (todavía)

- No firma digitalmente el Acuse de Recibo ni el ack de Aprobación Comercial
  (el stub local tampoco lo hace hoy; falta confirmar contra el manual
  técnico DGII si es requerido).
- No aísla por empresa/RNC — es single-tenant (`GATEWAY_BUSINESS_ID` fijo).
  El campo `businessId` ya queda guardado en cada documento para poder migrar
  a multiempresa después sin reescribir el modelo de datos.
- No tiene cola de reintentos ni Secret Manager para certificados — no firma
  nada, así que no maneja certificados `.p12`.

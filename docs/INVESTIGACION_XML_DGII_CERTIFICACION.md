# Investigación: XML Enviados a DGII para Certificación

**Fecha**: 2026-07-27  
**Estado**: 4 facturas electrónicas verificadas y listas para carga

---

## 📋 Resumen Ejecutivo

TecnoCaja ha generado **4 facturas electrónicas (e-CF tipo 32)** que han pasado validación XSD y firma digital. Estas facturas están en la carpeta:

```
ecf/DGII_CARGAR_AHORA_4_XML_VERIFICADOS/
├── LOTE_20260617203504/          ← 4 XML originales + verificación
├── LOTE_20260617211127/          ← Lotes adicionales
├── LOTE_20260617212723/          ← Lotes adicionales
└── PORTAL_VERIFICADO/             ← Copia verificada por DGII
```

---

## 🔐 Autenticación: Semilla Firmada

**Archivo**: `semilla-firmada.xml`

```xml
<SemillaModel>
  <valor>Q18CICq3gDJdJHUp32pID/w5PV1VnZqSyO55ss6JIaz8J8v...</valor>
  <fecha>2026-05-19T16:47:45.5242432-04:00</fecha>
  <Signature>
    <!-- Firmado con certificado digital VIAFORMA (RNC: 40211932609) -->
    <X509Certificate>MIIHYjCCBUqgAwIBAgIUbZcE+tZypEOBrPNf8jWq0MYOqS4w...</X509Certificate>
  </Signature>
</SemillaModel>
```

**Detalles del Certificado**:
- Entidad: **EMILIO MANAURYS CABRERA** (RNC IDCDO-40211932609)
- Emisor: VIAFORMA QUALIFIED CERTIFICATES (Autoridad Certificadora Dominicana)
- Válido desde: 2026-05-19 hasta 2027-05-19
- Algoritmo: RSA-SHA256
- Tipo: Qualified Certificate for Natural Person - Tax Procedures

---

## 📄 Facturas Electrónicas (e-CF Tipo 32)

### Lote Verificado: LOTE_20260617203504

**Generado**: 2026-06-18T00:35:04.803Z

| Archivo | eNCF | CodigoSeguridad | SHA256 | Estado |
|---------|------|-----------------|--------|--------|
| `40211932609E320000000011.xml` | E320000000011 | `rJPvt8` | `728408F2...` | ✅ XSD+Firma OK |
| `40211932609E320000000012.xml` | E320000000012 | `DB8RHX` | `42F7C805...` | ✅ XSD+Firma OK |
| `40211932609E320000000014.xml` | E320000000014 | `ThqAOr` | `5E0EAF68...` | ✅ XSD+Firma OK |
| `40211932609E320000000015.xml` | E320000000015 | `eF4hF/` | `1907DF9D...` | ✅ XSD+Firma OK |

### Estructura de Facturas (Ejemplo: E320000000011)

```xml
<ECF>
  <Encabezado>
    <Version>1.0</Version>
    <IdDoc>
      <TipoeCF>32</TipoeCF>           ← Comprobante Fiscal de Consumo
      <eNCF>E320000000011</eNCF>      ← Número ECF (16 dígitos)
      <IndicadorMontoGravado>0</IndicadorMontoGravado>
      <TipoIngresos>01</TipoIngresos>
      <TipoPago>1</TipoPago>          ← 1=Efectivo, 2=Cheque, etc.
    </IdDoc>
    
    <Emisor>
      <RNCEmisor>40211932609</RNCEmisor>
      <RazonSocialEmisor>DOCUMENTOS ELECTRONICOS PRUEBA FACTURA...</RazonSocialEmisor>
      <NombreComercial>DOCUMENTOS ELECTRONICOS</NombreComercial>
      <DireccionEmisor>AVE. ISABEL AGUIAR NO. 269, ZONA INDUSTRIAL DE HERRERA</DireccionEmisor>
      <TablaTelefonoEmisor>
        <TelefonoEmisor>809-472-7676</TelefonoEmisor>
      </TablaTelefonoEmisor>
      <CorreoEmisor>DOCUMENTOSELECTRONICOS@123.COM</CorreoEmisor>
      <FechaEmision>01-04-2020</FechaEmision>
    </Emisor>
    
    <Comprador>
      <RNCComprador>131880681</RNCComprador>
      <RazonSocialComprador>DOCUMENTOS ELECTRONICOS DE 03</RazonSocialComprador>
      <CorreoComprador>DOCUMENTOSELECTRONICOSDE0612345678969789@123.COM</CorreoComprador>
      <DireccionComprador>AVE. ISABEL AGUIAR NO. 269...</DireccionComprador>
      <MunicipioComprador>170203</MunicipioComprador>
      <ProvinciaComprador>170000</ProvinciaComprador>
      <TelefonoAdicional>809-472-7676</TelefonoAdicional>
    </Comprador>
    
    <Totales>
      <MontoGravadoTotal>34,000.00</MontoGravadoTotal>
      <MontoGravadoI1>34,000.00</MontoGravadoI1>
      <ITBIS1>18</ITBIS1>             ← Tasa ITBIS (IVA) 18%
      <TotalITBIS>6,120.00</TotalITBIS>
      <MontoTotal>40,120.00</MontoTotal>
    </Totales>
  </Encabezado>
  
  <DetallesItems>
    <Item>
      <NumeroLinea>1</NumeroLinea>
      <IndicadorFacturacion>1</IndicadorFacturacion>
      <NombreItem>Cargador</NombreItem>
      <IndicadorBienoServicio>1</IndicadorBienoServicio>  ← 1=Bien, 2=Servicio
      <CantidadItem>1</CantidadItem>
      <UnidadMedida>55</UnidadMedida>  ← Catálogo DGII
      <PrecioUnitarioItem>5000.00</PrecioUnitarioItem>
      <MontoItem>5000.00</MontoItem>
    </Item>
    <!-- Más items... -->
  </DetallesItems>
</ECF>
```

**Características del Lote**:
- ✅ Todas son de **Consumo (E32)** — menores a RD$250,000
- ✅ Moneda: RD$ (Pesos Dominicanos)
- ✅ ITBIS al 18%
- ✅ Firmadas digitalmente (XSD validado)

---

## 🌐 Endpoints DGII Expuestos

**Archivo**: `server/routes/dgii-public.routes.js`

El backend expone estos endpoints en `/fe/` (para simulación local y certificación):

### 1. GET `/fe/autenticacion/api/semilla`

Obtiene un seed (semilla) aleatorio para iniciar autenticación:

```http
GET /fe/autenticacion/api/semilla HTTP/1.1

200 OK
Content-Type: application/xml

<?xml version="1.0" encoding="utf-8"?>
<SemillaModel>
  <valor>3A5B8F...</valor>
  <fecha>2026-07-27T10:30:45.123Z</fecha>
</SemillaModel>
```

**Implementación**: Genera 16 bytes aleatorios en cada llamada (sin persistencia).

---

### 2. POST `/fe/autenticacion/api/validacioncertificado`

Envía certificado para validación (request/response DGII):

```http
POST /fe/autenticacion/api/validacioncertificado HTTP/1.1
Content-Type: application/xml

<CertificateValidation>
  <!-- Certificado DER-encoded o contenido -->
</CertificateValidation>

200 OK
Content-Type: application/json

{
  "status": "certificado_validado",
  "mensaje": "Certificado recibido y validado correctamente.",
  "timestamp": "2026-07-27T10:30:45.123Z"
}
```

**Lo que guarda**: Cada validación se almacena en `storage/ecf/received/validacion-cert-*.json` con IP del cliente.

---

### 3. POST `/fe/recepcion/api/ecf`

Envía factura electrónica para recepción:

```http
POST /fe/recepcion/api/ecf HTTP/1.1
Content-Type: application/xml

<?xml version="1.0" encoding="utf-8"?>
<ECF>
  <!-- Estructura completa de factura -->
</ECF>

200 OK
Content-Type: application/xml

<?xml version="1.0" encoding="utf-8"?>
<ARECF>
  <DetalleAcusedeRecibo>
    <Version>1.0</Version>
    <RNCEmisor>40211932609</RNCEmisor>
    <RNCComprador>131880681</RNCComprador>
    <eNCF>E320000000011</eNCF>
    <Estado>0</Estado>
    <FechaHoraAcuseRecibo>27-07-2026 10:30:45</FechaHoraAcuseRecibo>
  </DetalleAcusedeRecibo>
</ARECF>
```

**Extrae de la factura**:
- `RNCEmisor`, `RNCComprador`, `eNCF`
- Los almacena en `storage/ecf/received/recepcion-ecf-*.json`

---

### 4. POST `/fe/aprobacioncomercial/api/ecf`

Envía solicitud de aprobación comercial posterior (para modificaciones):

```http
POST /fe/aprobacioncomercial/api/ecf HTTP/1.1
Content-Type: application/xml

<?xml version="1.0" encoding="utf-8"?>
<ECF>
  <!-- Datos completos o parciales para aprobación -->
</ECF>

200 OK
Content-Type: application/json

{
  "status": "recibido",
  "mensaje": "Aprobación comercial recibida correctamente.",
  "encf": "E320000000011",
  "timestamp": "2026-07-27T10:30:45.123Z"
}
```

---

## 🔒 Seguridad de Endpoints

**Corrección (2026-07-27)**: `server/middleware/dgii-auth.js` **no existe en el código activo** — solo en `backups/`/`backup_ecf_antiguo/`. No está `require()`ado ni aplicado en `server.js`, `modules/ecf/index.js` ni `dgii-public.routes.js`.

Se decidió **no reconectarlo**: `/fe/*` es un webhook que llama **DGII directamente** durante certificación/producción. DGII, como llamador externo, no puede enviar un token secreto nuestro — activar esta protección rechazaría el 100% de las llamadas reales de DGII, no solo las no autorizadas. `.env` tiene `DGII_REQUIRE_INTERNAL_TOKEN=false` a propósito.

**Estado real hoy**: `/fe/*` es público sin autenticación por token, y así debe quedar. La trazabilidad de quién llamó (IP, timestamp, payload) ya se guarda vía `saveReceived()` en `storage/ecf/received/` — ver sección de Almacenamiento Local más abajo.

---

## 📊 Esquemas XSD Disponibles

La carpeta `ecf/` contiene esquemas XSD para validación de tipos de documentos:

| Archivo | Tipo | Descripción |
|---------|------|-------------|
| `e-CF 31 v.1.0.xsd` | e-CF 31 | Comprobante Fiscal Especial |
| `e-CF 32 v.1.0.xsd` | e-CF 32 | **Comprobante Fiscal de Consumo** ← *En lote actual* |
| `e-CF 33 v.1.0.xsd` | e-CF 33 | Comprobante de Nota de Crédito |
| `e-CF 34 v.1.0.xsd` | e-CF 34 | Comprobante de Nota de Débito |
| `e-CF 41 v.1.0.xsd` | e-CF 41 | Comprobante Fiscal por Exportaciones |
| `e-CF 43 v.1.0.xsd` | e-CF 43 | Comprobante de Excención |
| `e-CF 44 v.1.0.xsd` | e-CF 44 | Comprobante Fiscal de Consumo Especial |
| `e-CF 45 v.1.0.xsd` | e-CF 45 | Sustanciación de Crédito Fiscal |
| `e-CF 46 v.1.0.xsd` | e-CF 46 | Comprobante por Actividad de Juegos |
| `e-CF 47 v.1.0.xsd` | e-CF 47 | Comprobante de Venta de Moneda Extranjera |
| `ACECF v.1.0.xsd` | ACECF | Acuse de Recibo de e-CF |
| `ANECF v.1.0.xsd` | ANECF | Acuse Negativo de e-CF |
| `ARECF v1.0.xsd` | ARECF | Acuse de Recepción de e-CF |
| `RFCE v1.0.xsd` | RFCE | Recepción Fiscal de Comprobante Electrónico |

---

## 📦 Almacenamiento Local

### Directorio: `storage/ecf/received/`

Todos los XML y solicitudes se guardan en formato JSON para auditoría:

```json
{
  "id": "recepcion-ecf-1687022444123",
  "type": "recepcion-ecf",
  "receivedAt": "2026-06-18T00:35:04.803Z",
  "meta": {
    "rncEmisor": "40211932609",
    "rncComprador": "131880681",
    "encf": "E320000000011",
    "ip": "127.0.0.1"
  },
  "payload": "<?xml version=\"1.0\"...>"
}
```

**Tipos registrados**:
- `semilla` — Solicitudes de semilla
- `validacion-cert` — Validaciones de certificado
- `recepcion-ecf` — Facturas recibidas
- `aprobacion-comercial` — Solicitudes de aprobación

---

## 🎯 Próximos Pasos Recomendados

1. **Enviar lote a DGII de Certificación**:
   - Usar los 4 XML verificados de `LOTE_20260617203504/`
   - Incluir semilla-firmada.xml
   - Portal DGII para certificación de emisor electrónico

2. **Validar QR generado**:
   - El URL de QR será: `https://ecf.dgii.gov.do/testecf/ConsultaTimbre?RNC=40211932609&eNCF=E320000000011&Codigo=<security_code>`
   - Reemplazar `testecf` por `ecf` en producción

3. **Configuración de Ambientes**:
   - `.env` variable `DGII_ENV` puede ser:
     - `testecf` — Ambiente de pruebas DGII
     - `certecf` — Ambiente de certificación DGII
     - `ecf` — Ambiente de producción

4. **Activar Cloudflare Tunnel**:
   - Para exponer `/fe/*` a DGII sin abrir puertos
   - Script: `.\scripts\start-with-tunnel.ps1 -Tunnel tecnocaja-pos`

---

## 📝 Notas

- **NombreComercial omitido**: Como especifica VERIFICACION.txt, los 4 XML tienen `NombreComercial` sin datos en los XML finales (protección de datos)
- **Fechas de emisión**: 01-04-2020 (datos de prueba, ajustar en producción)
- **RNC de Prueba**: 40211932609 y 131880681 son RNCs de DGII para homologación
- **Código de Seguridad**: Generado por DGII (6 caracteres alfanuméricos)

---

## 📄 Referencias

- Carpeta: `/ecf/Proceso de Certificacion para ser Emisor Electronico.pdf`
- Documento: [NovaPOS-Plan-Evolucion.md](../NovaPOS-Plan-Evolucion.md)
- Arquitectura: [docs/ARCHITECTURE.md](./ARCHITECTURE.md)

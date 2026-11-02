# Licencias, precios y contratos de Tecno Caja

Auditoría del 2 de noviembre de 2026 y plan por etapas. Los conteos salen de una lectura de Firestore que no modificó nada.

## 1. Cómo estaba

### Licencias actuales

Hay 27 documentos en `licencias`:

| Dato | Resultado |
|---|---|
| Estado | 17 activas, 9 en prueba, 1 vencida |
| Plan | 11 `basico`, 7 `plus`, 6 `standalone`, 2 `mobile_trial`, 1 `pro` |
| Firmadas | 0 |
| Límite de equipos | 21 con 1, 1 con 4, 5 sin dato |
| Validadas en los últimos 30 días | 21 |

No había pagos, implementaciones ni servicios registrados. `suscripciones` tiene 2 plantillas de factura que no están ligadas a la licencia.

### Problemas encontrados

| # | Problema | Riesgo | Estado |
|---|---|---|---|
| 1 | `firebase-key.json`, llave de administrador del proyecto, va dentro del instalador público. Con ella cualquiera puede escribir su licencia como activa. | Crítico | Pendiente, etapas 3 y 4 |
| 2 | Ninguna licencia está firmada y la firma no se exige. `TECNO_CAJA_LICENSE_PUBLIC_KEY` no está configurada. | Crítico | Pendiente, etapa 3 |
| 3 | `/api/license/set-plan` deja al administrador del cliente subirse el plan, y el POS lo escribe en `licencias`. | Alto | Corregido si tiene contrato; el resto, etapa 3 |
| 4 | El panel marcaba "cancelada" y el POS lo leía como prueba: cancelar no cortaba nada. | Alto | Corregido |
| 5 | La licencia tenía un solo estado: el e-CF, el soporte y los respaldos no se podían controlar por separado. | Alto | Corregido, sin frenar a nadie sin contrato |
| 6 | No existía el pago único: "Activar" solo borra la fecha, y no queda registro de qué se vendió. | Medio | Corregido |
| 7 | `deviceId` depende de la MAC, del nombre del equipo y de la versión de Windows: cambia solo y cuenta como otra PC. Al pasar el límite el cliente ve "expirada". | Medio | Mensaje corregido en la permanente; identificador, etapa 4 |
| 8 | Sin Internet, una licencia activa sin fecha sigue funcionando para siempre, aunque se haya suspendido. | Medio | Decisión de Emilio, etapa 3 |
| 9 | Restaurar un respaldo viejo sin Internet recupera el caché viejo de la licencia. Al conectarse manda el servidor. | Medio | Pendiente, etapa 3 |
| 10 | La página web decía "Consultar" a la vista y USD 149/19/99 en los datos para buscadores. | Bajo | Corregido |
| 11 | Instaladores hasta la 1.6.8 traían un certificado `.p12` y XML de prueba, y siguen descargables. | Alto | Quitado desde la 1.6.9; falta decidir sobre los viejos |

### De qué dependía la licencia

- Entrar al sistema (`canEnter`) y crear cajas o sucursales (`requirePlan`).
- **No dependen de ella:** ventas ya dentro, respaldos, actualizaciones ni e-CF. Por eso la licencia permanente ya cumple que estos servicios sigan funcionando.

## 2. Lo que se hizo

### Precios (`server/licensing/precios.js`)

Es la única fuente de precios, en centavos enteros. La usan el POS y el panel, y la página web se generó con ella. La implementación va siempre en su propio renglón y una renovación no la incluye.

Los códigos `basico`, `pro` y `plus` no cambiaron, porque las licencias guardadas los usan. Se muestran como Básico, MultiCaja y MultiSucursal.

**Precios sin definir:** pago único de cada plan, e-CF, soporte técnico, implementación de una sucursal adicional, y computadora o sucursal adicional en pago único. Se muestran como "Consultar" y no entran en ningún total.

### Servicios (`server/licensing/servicios.js`)

Cada servicio tiene su estado y su fecha. Una licencia sin `servicios` no se restringe: así no se afecta a ningún cliente actual hasta registrarle su contrato.

### Licencia permanente

`modalidad: LIFETIME_NO_SUBSCRIPTION` en la licencia. No vence, no se bloquea por el reloj y, en un equipo no autorizado, no aparece como vencida. Suspenderla a mano sigue funcionando.

### e-CF

`assertSaleHasSequence` rechaza la venta con `ECF_SERVICIO_INACTIVO` si el contrato no lo permite. El cajero puede cobrar sin comprobante electrónico. La revisión solo mira la memoria, porque corre con el candado de `config` tomado.

No se frena lo ya emitido: el reenvío de rechazados y las notas de crédito siguen disponibles.

### Panel (`tecno-caja-admin/routes/contratos.routes.js`, `public/js/contratos.js`)

- Módulo **Planes y precios**: tabla, precios por definir y cotizador.
- Botón **Contrato** en cada negocio: plan, modalidad, adicionales, servicios, pagos, equipos e historial.
- Cada pago lleva una clave única: repetirlo no cobra ni alarga dos veces.
- Todo cambio queda en `audit_logs` y `license_history`.
- **Datos nuevos en `licencias/{id}`:** `modalidad`, `contrato`, `servicios` y la subcolección `pagos`.
- Con `contrato`, el POS deja de escribir plan, estado y fechas en la licencia.
- **Reglas de Firestore:** no hacen falta cambios. `licencias` ya está cerrada a clientes (`allow read, write: if false`); el riesgo real es el problema 1.

### POS

Configuración → Datos del Negocio → **Ver planes y precios**. Lee `/api/planes/catalogo`, es solo lectura, y muestra el plan y los servicios de esa licencia.

## 3. Lo que falta

### Etapa 3: firma digital

1. Firmar con Ed25519 desde un servidor seguro; la llave privada nunca sale de ahí. Primero se firma con todas las licencias en modo de observación.
2. El POS verifica con la llave pública y solo registra lo que encuentra. Sin bloquear a nadie.
3. Cuando todas las licencias activas estén firmadas y las PCs actualizadas, se exige la firma.
4. Cerrar `/api/license/set-plan`.
5. Atar el caché a la última validación para que restaurar un respaldo no recupere estados viejos.

### Etapa 4: equipos y llave de Firebase

1. Pasar lo que hoy se hace con `firebase-key.json` a la Sync API, con el token de cada PC.
2. Sacar la llave del instalador y cambiarla cuando ninguna PC la use.
3. Identificador de instalación estable, activación por equipo con firma, y reemplazo de equipo desde el panel.

### Etapa 5: migración de clientes

Ninguna licencia se convierte sola. Para cada una de las 27, Emilio decide desde el panel:

1. Cuáles son pago único, mensuales o anuales, y si `standalone` y `mobile_trial` pasan a Básico.
2. Registrar el contrato y lo pagado.
3. **Antes de guardar a un cliente que ya factura e-CF, activarle el servicio con su fecha.** Si no, deja de poder emitir.

Es reversible: quitar `contrato` y `servicios` del documento devuelve la licencia al modo anterior.

## 4. Las 20 pruebas pedidas

| # | Escenario | Estado | Prueba |
|---|---|---|---|
| 1 | Activar licencia permanente | Pasa | `contratos.routes.test.js` |
| 2 | Permanente sin Internet | Pasa | `permanente.test.js` |
| 3 | Respaldo local en permanente | Pasa: no depende de la licencia | Estado del servicio; no se corrió un respaldo real |
| 4 | Respaldo en la nube en permanente | Pasa: no depende de la licencia | Estado del servicio; no se corrió un respaldo real |
| 5 | Actualización en permanente | Pasa: no depende de la licencia | Estado del servicio; no se corrió una actualización real |
| 6 | e-CF después | Pasa | `contratos.routes.test.js` |
| 7 | e-CF vencido no bloquea el programa | Pasa | Las dos pruebas |
| 8 | Suspender soporte | Pasa | `contratos.routes.test.js` y pantalla |
| 9 | Renovación mensual | Pasa | `contratos.routes.test.js` |
| 10 | Renovación anual | Pasa | `contratos.routes.test.js` |
| 11 | Tres meses gratis | Pasa | `precios.test.js` |
| 12 | PC adicional en MultiCaja | Pasa | `precios.test.js` |
| 13 | Sucursal adicional | Pasa | `precios.test.js` |
| 14 | PC adicional en una sucursal | Pasa | `precios.test.js` |
| 15 | Copiar la instalación a otra PC | **Pendiente** | Etapa 4; el límite de equipos sí está probado |
| 16 | Reinstalar Windows | **Pendiente** | Etapa 4; hoy cuenta como otra PC y se libera a mano |
| 17 | Restaurar un respaldo | **Pendiente** | Etapa 3 |
| 18 | Alterar una licencia | **Parcial** | El caché alterado se detecta; alterar el documento en Firebase requiere la firma, etapa 3 |
| 19 | Volver a tener Internet | Pasa | `permanente.test.js` |
| 20 | Cambio de plan | Pasa | `contratos.routes.test.js` |

**Cómo correrlas:** `npx jest tests/licensing` y `node tests/licensing/ui/probar-pantallas-licencia.js`.

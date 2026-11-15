'use strict';

/**
 * Compras que el contador registra desde su portal (fase C).
 *
 * El portal deja cada compra en licencias/{licencia}/compras_pendientes/{uuid}
 * (tecno-caja-contadores/server/compras-portal.js). Esta PC (la principal del
 * negocio) la toma y la registra por la ruta única de compras (registrar), con
 * el uuid como llave. El motor (toma, estados, reintentos) está en
 * cola-compras.js, el mismo de las compras que manda la app de reportes.
 *
 * El contador registra directo (decisión de Emilio, 2026-11-10), pero:
 *  - el negocio lo puede apagar (Compras → Configuración: «Mi contador registra compras»);
 *  - solo el contador vinculado a la licencia (contadorId) puede;
 *  - no cambia precios ni el control de inventario de productos existentes
 *    (eso sigue siendo del permiso Productos del negocio); sí crea productos nuevos.
 * Nunca frena la venta: corre en segundo plano y sin Internet no hace nada.
 */

const { createColaCompras } = require('./cola-compras');

function payloadDe(id, d) {
  const e = d.encabezado || {};
  return {
    uuid: id,
    encabezado: {
      ...e,
      // Lo que manda el portal es una compra del proveedor: el negocio no emite comprobante de compra.
      comprobanteNegocio: '', emitirE41: false,
      documentoOrigen: ['xml_ecf', 'tabla'].includes(e.documentoOrigen) ? e.documentoOrigen : 'portal',
      notas: [e.notas, `Registrada por el contador ${d.contadorNombre || ''} desde su portal`].filter(Boolean).join(' · ').slice(0, 250),
    },
    lineas: Array.isArray(d.lineas) ? d.lineas : [],
  };
}

function createColaComprasPortal({
  getLicenseUid = () => String(process.env.TECNO_CAJA_LICENSE_UID || '').trim(),
  ...deps                        // servicio, query, getDb, getBranchId, esPrincipal, writeAuditLog, alRegistrar, ahora, quien, logger
}) {
  const fuente = {
    nombre: 'portal',
    versionDocumento: 'portal-1',
    negocio: async () => getLicenseUid(),
    cola: (db, licencia) => db.collection('licencias').doc(licencia).collection('compras_pendientes'),
    async contexto(db, licencia) {
      const licenciaDoc = await db.collection('licencias').doc(licencia).get();
      return { licenciaDatos: licenciaDoc.exists ? licenciaDoc.data() : null, cfg: await deps.servicio.leerConfig() };
    },
    async validar(d, ctx, id) {
      if (!ctx.cfg.contadorRegistra) {
        return { rechazo: 'El negocio desactivó las compras registradas por su contador (Compras → Configuración).' };
      }
      if (!d.contadorId || d.contadorId !== ctx.licenciaDatos?.contadorId) {
        return { rechazo: 'Ese contador ya no está vinculado a este negocio.' };
      }
      return {
        actor: { id: null, nombre: `Contador: ${d.contadorNombre || 'sin nombre'}`, usuario: d.contadorEmail || 'contador', role_code: 'contador', rol: 'contador' },
        payload: payloadDe(id, d),
        opciones: { puedeCrearProductos: true, puedeCambiarProductos: false },
      };
    },
    auditoria: (d, actor, id) => ({
      userRole: 'Contador', actionName: 'Compra registrada por el contador',
      detail: `${d.encabezado?.proveedor?.nombre || ''} · ${d.encabezado?.ncf || ''} · desde el portal del contador (${id})`,
    }),
  };
  return { ...createColaCompras(fuente, deps), payloadDe };
}

module.exports = { createColaComprasPortal, payloadDe };

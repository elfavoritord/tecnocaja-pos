'use strict';

/**
 * Documentos que la app de reportes le pide a esta PC (la principal):
 *   factura       → la factura A4 de una venta (o la de Facturación, en la
 *                   Empresa de Servicios), en PDF, para mandársela al cliente.
 *   estado_cuenta → el estado de cuenta de un cliente, en PDF, con el resumen
 *                   para verlo en el teléfono.
 * Los datos y la hoja son los mismos del POS; aquí solo se arma el PDF.
 */

const QRCode = require('qrcode');
const { htmlFactura } = require('./factura-de-venta');
const { pdfEstadoCuenta } = require('./estado-cuenta-pdf');
const { estadoCuentaServicios } = require('./estado-cuenta-servicios');

const MAX_FACTURAS_RESUMEN = 60;

function fallo(texto, statusCode = 400) {
  return Object.assign(new Error(texto), { statusCode });
}
function nombreArchivo(base) {
  return `${String(base || 'documento').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 80)}.pdf`;
}
function fechaCorta(valor) {
  if (valor instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${valor.getFullYear()}-${p(valor.getMonth() + 1)}-${p(valor.getDate())} ${p(valor.getHours())}:${p(valor.getMinutes())}`;
  }
  return String(valor || '').replace('T', ' ').slice(0, 16);
}

function createDocumentosApp({
  query,
  getConfig,                    // () => config del POS (nombre, rnc, logo, plantilla, color, moneda…)
  obtenerVentaImprimible,       // (factura) => la venta de /api/sales/:factura/receipt, o null
  estadoDeCuenta,               // (clientId, {from,to}) => client-statement.build del POS
  facturaServicioHtml = null,   // (svcInvoiceId) => HTML A4 de Facturación (Empresa de Servicios)
  mapClientRow,
  puedeVerCuentas = () => true, // (usuarioPos) => bool (canViewReceivables del POS)
  htmlAPdf,                     // (html) => Buffer
}) {
  async function config() {
    return (await Promise.resolve(getConfig()).catch(() => ({}))) || {};
  }

  async function factura(parametros = {}, quien) {
    if (!quien.puede('reportes', 'ventas', 'clientes')) throw fallo('Tu usuario no puede ver facturas en el POS.', 403);
    const numero = String(parametros.factura || parametros.invoiceNumber || '').trim().slice(0, 60);
    if (!numero) throw fallo('Falta el número de la factura.');
    const venta = await obtenerVentaImprimible(numero);
    if (!venta) throw fallo('Esa factura no está en el POS.', 404);
    const sucursalVenta = Number(venta.sucursalInventarioId || venta.sucursalFacturoId || venta.sucursalId || 0) || null;
    if (quien.sucursal && sucursalVenta && sucursalVenta !== quien.sucursal) throw fallo('Esa factura es de otra sucursal.', 403);
    const cfg = await config();

    let html = null;
    if (cfg.serviceCompany && facturaServicioHtml && venta.ventaId) {
      const [svc] = await query('SELECT id FROM svc_invoices WHERE sale_id = ? LIMIT 1', [venta.ventaId]).catch(() => []);
      if (svc) html = await facturaServicioHtml(Number(svc.id));
    }
    if (!html) {
      const qrDataUrl = venta.qrUrl ? await QRCode.toDataURL(String(venta.qrUrl), { margin: 1, width: 240 }).catch(() => '') : '';
      html = htmlFactura(venta, cfg, { qrDataUrl });
    }
    const pdf = await htmlAPdf(html);
    const documento = venta.encf || venta.ncf || venta.id;
    return {
      titulo: `Factura ${documento}`,
      archivo: nombreArchivo(`Factura_${documento}`),
      pdf,
      resumen: {
        factura: venta.id, documento, fecha: fechaCorta(venta.fecha), cliente: venta.razonSocialCliente || venta.cliente || 'Consumidor Final',
        clienteDocumento: venta.clienteRncCedula || '', clienteTelefono: venta.clienteTelefono || '',
        total: Number(venta.total || 0), cancelada: Boolean(venta.cancelada),
      },
    };
  }

  async function estadoCuenta(parametros = {}, quien) {
    if (!quien.esDueno && !puedeVerCuentas(quien.usuarioPos)) throw fallo('Tu usuario no puede ver las cuentas de los clientes en el POS.', 403);
    const clientId = Number(parametros.clienteId || parametros.clientId || 0);
    if (!Number.isInteger(clientId) || clientId <= 0) throw fallo('Falta el cliente.');
    const from = String(parametros.desde || '').slice(0, 10);
    const to = String(parametros.hasta || '').slice(0, 10);
    const cfg = await config();
    const report = cfg.serviceCompany
      ? await estadoCuentaServicios({ query, mapClientRow, clientId, from, to })
      : await estadoDeCuenta(clientId, { from, to });
    const negocio = { nombre: cfg.nombre, rnc: cfg.rnc, direccion: cfg.direccion, telefono: cfg.telefono, moneda: cfg.moneda || 'RD$' };
    const pdf = pdfEstadoCuenta(report, negocio);
    const c = report.client || {};
    const abiertas = (report.facturas || []).filter((f) => f.estado === 'abierta' || f.estado === 'vencida');
    return {
      titulo: `Estado de cuenta · ${c.nombre || 'Cliente'}`,
      archivo: nombreArchivo(`Estado_de_cuenta_${c.nombre || clientId}_${report.fechaCorte}`),
      pdf,
      resumen: {
        cliente: c.nombre || '', clienteDocumento: c.rnc || c.cedula || '', clienteTelefono: c.telefonoFormateado || c.telefono || '',
        fechaCorte: report.fechaCorte, desde: from, hasta: to,
        saldoActual: Number(report.currentBalance || 0), deudaVigente: Number(report.deudaVigente || 0), deudaVencida: Number(report.deudaVencida || 0),
        limiteCredito: report.sinLimite ? null : Number(report.limiteCredito || 0), disponible: report.disponible,
        movimientos: (report.rows || []).length,
        facturasAbiertas: abiertas.slice(0, MAX_FACTURAS_RESUMEN).map((f) => ({
          documento: f.documento, fecha: String(f.fecha || '').slice(0, 10), vence: f.vence || null,
          pendiente: Number(f.pendiente || 0), estado: f.estado, diasAtraso: Number(f.diasAtraso || 0),
        })),
        masFacturas: Math.max(0, abiertas.length - MAX_FACTURAS_RESUMEN),
      },
    };
  }

  return { factura, estado_cuenta: estadoCuenta };
}

/** HTML → PDF con el Chrome/Edge de la PC (el mismo que usa la certificación e-CF). */
function crearHtmlAPdf({ launchPdfBrowser = require('../../../modules/ecf/utils/pdf-browser.util').launchPdfBrowser } = {}) {
  return async function htmlAPdf(html) {
    const browser = await launchPdfBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
      return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
    } finally {
      await browser.close().catch(() => {});
    }
  };
}

module.exports = { createDocumentosApp, crearHtmlAPdf, nombreArchivo };

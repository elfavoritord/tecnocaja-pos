'use strict';

// Solicitudes de un cliente: cotización, cita o consulta sobre un servicio. No son
// pedidos: no reservan existencia ni calculan totales, y no se vuelven factura solas.
// Se reciben en el POS, donde el negocio revisa y confirma las condiciones.

const crypto = require('crypto');
const { rutas, opcionesServicios } = require('../vendor/tienda-online/contrato');

const TIPOS = ['cotizacion', 'cita', 'consulta'];

function texto(value, max) {
  // eslint-disable-next-line no-control-regex -- quitar caracteres de control es justo la idea
  return String(value ?? '').replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function httpError(message, statusCode = 400, campo) {
  return Object.assign(new Error(message), { statusCode, campo });
}

const KEY_RE = /^[A-Za-z0-9_-]{16,80}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function validarSolicitud(body = {}) {
  if (texto(body.website, 50)) throw httpError('Solicitud no válida.', 400, 'website');
  const idempotencyKey = String(body.idempotencyKey || '');
  if (!KEY_RE.test(idempotencyKey)) throw httpError('Falta el identificador de la solicitud. Recarga la página.', 400);
  if (!TIPOS.includes(body.tipo)) throw httpError('Elige qué quieres solicitar.', 400, 'tipo');
  const nombre = texto(body.cliente?.nombre, 120);
  if (nombre.length < 2) throw httpError('Escribe tu nombre.', 400, 'nombre');
  const telefono = String(body.cliente?.telefono || '').replace(/\D/g, '');
  if (telefono.length < 10 || telefono.length > 15) throw httpError('Escribe un teléfono válido (10 dígitos).', 400, 'telefono');
  const email = texto(body.cliente?.email, 160).toLowerCase();
  if (email && !EMAIL_RE.test(email)) throw httpError('El correo no es válido.', 400, 'email');
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(body.fecha || '')) ? String(body.fecha) : '';
  const hora = /^\d{2}:\d{2}$/.test(String(body.hora || '')) ? String(body.hora) : '';
  if (body.tipo === 'cita' && !fecha) throw httpError('Elige la fecha de la cita.', 400, 'fecha');
  return {
    idempotencyKey,
    tipo: body.tipo,
    productoId: Number(body.productoId || 0) || null,
    cliente: { nombre, telefono, email },
    mensaje: texto(body.mensaje, 1000),
    fecha,
    hora,
  };
}

async function crearSolicitud({ db, FieldValue, tienda, datos }) {
  const { licenseId, perfil, lista } = tienda;
  const opciones = opcionesServicios(perfil);
  if (datos.tipo === 'cotizacion' && !opciones.cotizacion) throw httpError('Esta tienda no recibe solicitudes de cotización.', 409);
  if (datos.tipo === 'cita' && !opciones.cita) throw httpError('Esta tienda no recibe solicitudes de cita.', 409);

  let articulo = '';
  let precio = null;
  if (datos.productoId) {
    const p = lista.find((x) => Number(x.id) === datos.productoId);
    if (!p) throw httpError('Ese servicio ya no está disponible.', 409);
    articulo = String(p.nombre || '');
    if (opciones.mostrarPrecio) precio = Number(p.precio || 0);
  }

  // Doble clic o reintento: la misma clave es la misma solicitud.
  const id = crypto.createHash('sha256').update(`${licenseId}:${datos.idempotencyKey}`).digest('hex').slice(0, 32);
  const ref = db.doc(rutas.solicitud(licenseId, id));
  const repetida = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return true;
    tx.set(ref, {
      tipo: datos.tipo,
      productoId: datos.productoId,
      articulo,
      precio,
      cliente: datos.cliente,
      mensaje: datos.mensaje,
      fecha: datos.fecha,
      hora: datos.hora,
      importada: false,
      creadoEn: FieldValue.serverTimestamp(),
    });
    return false;
  });
  return { id, repetida };
}

module.exports = { TIPOS, crearSolicitud, validarSolicitud };

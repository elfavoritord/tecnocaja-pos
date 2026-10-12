'use strict';

/**
 * server/tienda-online/settings.js
 *
 * Configuración de la tienda (tabla online_store_settings, una sola fila).
 * Todo lo que llega del navegador se normaliza aquí: tipos, largos y rangos.
 */

const { METODOS_PAGO, normalizarSlug, slugValido } = require('./contrato');

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function texto(value, max = 255) {
  // eslint-disable-next-line no-control-regex -- quitar caracteres de control es justo la idea
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function textoLargo(value, max = 1000) {
  // eslint-disable-next-line no-control-regex -- deja los saltos de línea, quita el resto
  return String(value ?? '').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function monto(value, max = 1000000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(max, Math.round(n * 100) / 100);
}

function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function hora(value, fallback) {
  const v = String(value || '').trim();
  return HORA_RE.test(v) ? v : fallback;
}

function color(value) {
  const v = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : '#10b981';
}

function horarioPorDefecto() {
  return DIAS.map((_, dia) => ({ dia, abierto: true, abre: '08:00', cierra: '20:00' }));
}

function defaultSettings() {
  return {
    nombre: '',
    descripcion: '',
    telefono: '',
    whatsapp: '',
    direccion: '',
    email: '',
    colorPrimario: '#10b981',
    horario: { dias: horarioPorDefecto(), aceptarFueraDeHorario: true, nota: '' },
    pedidoMinimo: 0,
    retiro: { habilitado: true, instrucciones: '' },
    delivery: { habilitado: true, costoBase: 0, aplicaItbis: false, zonas: [], instrucciones: '' },
    pagos: {
      efectivo: { habilitado: true, instrucciones: '' },
      transferencia: { habilitado: false, instrucciones: '' },
      tarjeta: { habilitado: false, instrucciones: '' },
      contra_entrega: { habilitado: true, instrucciones: '' },
      otro: { habilitado: false, etiqueta: '', instrucciones: '' },
    },
    comprobanteFiscal: true,
    mostrarAgotados: true,
    categoriasOrden: [],
    notificaciones: { whatsappDueno: false, whatsappCliente: false },
    // 'pedido' = al facturar se respeta el precio con que el cliente compró;
    // 'actual' = se cobra el precio vigente del POS.
    conversion: { precio: 'pedido' },
    // Arquitectura lista para "reservar inventario al recibir el pedido".
    // Hoy la reserva solo protege la tienda (dos clientes en línea no pueden
    // comprar la última unidad); las ventas del mostrador no la ven.
    inventario: { reservarAlRecibir: false },
  };
}

function normalizarHorario(input = {}) {
  const base = horarioPorDefecto();
  const dias = Array.isArray(input.dias) ? input.dias : [];
  for (const dia of dias) {
    const idx = Number(dia?.dia);
    if (!Number.isInteger(idx) || idx < 0 || idx > 6) continue;
    base[idx] = {
      dia: idx,
      abierto: bool(dia.abierto, true),
      abre: hora(dia.abre, '08:00'),
      cierra: hora(dia.cierra, '20:00'),
    };
  }
  return {
    dias: base,
    aceptarFueraDeHorario: bool(input.aceptarFueraDeHorario, true),
    nota: texto(input.nota, 200),
  };
}

function normalizarZonas(zonas) {
  const out = [];
  const vistos = new Set();
  for (const zona of Array.isArray(zonas) ? zonas.slice(0, 60) : []) {
    const nombre = texto(zona?.nombre, 80);
    if (!nombre) continue;
    let id = texto(zona?.id, 40).replace(/[^a-zA-Z0-9_-]/g, '') || normalizarSlug(nombre).slice(0, 30) || `z${out.length + 1}`;
    while (vistos.has(id)) id = `${id}-${out.length + 1}`;
    vistos.add(id);
    out.push({ id, nombre, costo: monto(zona?.costo, 100000), activa: bool(zona?.activa, true) });
  }
  return out;
}

function normalizarPagos(input = {}) {
  const out = {};
  for (const codigo of Object.keys(METODOS_PAGO)) {
    const src = input?.[codigo] || {};
    out[codigo] = {
      habilitado: bool(src.habilitado, codigo === 'efectivo'),
      instrucciones: textoLargo(src.instrucciones, 400),
    };
    if (codigo === 'otro') out[codigo].etiqueta = texto(src.etiqueta, 60);
  }
  return out;
}

/** Combina lo guardado con lo nuevo y normaliza todo el objeto. */
function normalizarSettings(input = {}, previo = defaultSettings()) {
  const merged = { ...defaultSettings(), ...previo, ...input };
  return {
    nombre: texto(merged.nombre, 120),
    descripcion: textoLargo(merged.descripcion, 600),
    telefono: texto(merged.telefono, 40),
    whatsapp: texto(merged.whatsapp, 40),
    direccion: texto(merged.direccion, 255),
    email: texto(merged.email, 160),
    colorPrimario: color(merged.colorPrimario),
    horario: normalizarHorario(merged.horario),
    pedidoMinimo: monto(merged.pedidoMinimo, 1000000),
    retiro: {
      habilitado: bool(merged.retiro?.habilitado, true),
      instrucciones: textoLargo(merged.retiro?.instrucciones, 400),
    },
    delivery: {
      habilitado: bool(merged.delivery?.habilitado, true),
      costoBase: monto(merged.delivery?.costoBase, 100000),
      aplicaItbis: bool(merged.delivery?.aplicaItbis, false),
      zonas: normalizarZonas(merged.delivery?.zonas),
      instrucciones: textoLargo(merged.delivery?.instrucciones, 400),
    },
    pagos: normalizarPagos(merged.pagos),
    comprobanteFiscal: bool(merged.comprobanteFiscal, true),
    mostrarAgotados: bool(merged.mostrarAgotados, true),
    categoriasOrden: (Array.isArray(merged.categoriasOrden) ? merged.categoriasOrden : [])
      .map((c) => texto(c, 60)).filter(Boolean).slice(0, 200),
    notificaciones: {
      whatsappDueno: bool(merged.notificaciones?.whatsappDueno, false),
      whatsappCliente: bool(merged.notificaciones?.whatsappCliente, false),
    },
    conversion: { precio: merged.conversion?.precio === 'actual' ? 'actual' : 'pedido' },
    inventario: { reservarAlRecibir: bool(merged.inventario?.reservarAlRecibir, false) },
  };
}

function parseJson(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function createSettingsStore({ query, nowSql }) {
  async function read() {
    const rows = await query('SELECT * FROM online_store_settings WHERE id = 1 LIMIT 1');
    const row = rows[0] || {};
    return {
      // existe = hay fila de configuración (sin fila no se sabe si está activa).
      existe: Boolean(rows[0]),
      enabled: Number(row.enabled || 0) === 1,
      slug: row.slug || '',
      branchId: Number(row.branch_id || 0) || null,
      settings: normalizarSettings(parseJson(row.settings_json)),
      hasBanner: Boolean(row.banner_data),
      updatedAt: row.updated_at || null,
      updatedBy: row.updated_by || null,
    };
  }

  async function readBanner() {
    const rows = await query('SELECT banner_data FROM online_store_settings WHERE id = 1 LIMIT 1');
    return rows[0]?.banner_data || null;
  }

  /**
   * @param {object} patch  { enabled?, slug?, branchId?, settings? }
   * @returns la configuración guardada
   */
  async function write(patch = {}, { userName = 'Sistema' } = {}) {
    const current = await read();
    let slug = current.slug;
    if (patch.slug !== undefined) {
      const candidate = normalizarSlug(patch.slug);
      if (candidate && !slugValido(candidate)) {
        const error = new Error('La dirección de la tienda debe tener entre 3 y 40 letras, números o guiones, y no puede ser una palabra reservada.');
        error.statusCode = 400;
        throw error;
      }
      slug = candidate;
    }
    const enabled = patch.enabled === undefined ? current.enabled : bool(patch.enabled);
    if (enabled && !slug) {
      const error = new Error('Elige la dirección (nombre corto) de tu tienda antes de activarla.');
      error.statusCode = 400;
      throw error;
    }
    const branchId = patch.branchId === undefined ? current.branchId : (Number(patch.branchId || 0) || null);
    const settings = patch.settings ? normalizarSettings(patch.settings, current.settings) : current.settings;
    await query(
      `UPDATE online_store_settings
          SET enabled = ?, slug = ?, branch_id = ?, settings_json = ?, updated_at = ?, updated_by = ?
        WHERE id = 1`,
      [enabled ? 1 : 0, slug || null, branchId, JSON.stringify(settings), nowSql(), texto(userName, 160)],
    );
    return read();
  }

  async function writeBanner(dataUrl) {
    await query('UPDATE online_store_settings SET banner_data = ?, updated_at = ? WHERE id = 1', [dataUrl || null, nowSql()]);
  }

  return { read, readBanner, write, writeBanner };
}

module.exports = {
  DIAS,
  defaultSettings,
  normalizarSettings,
  createSettingsStore,
};

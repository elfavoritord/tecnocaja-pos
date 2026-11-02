'use strict';

/**
 * Cuándo volver a pedir la confirmación de reinicio de una actualización ya descargada.
 * Se guarda en la carpeta de datos de ESTA computadora, así que cada caja lleva la suya y
 * un cierre del POS no olvida un "más tarde". Sin Electron, para poder probarlo.
 */

const UNA_HORA_MS = 60 * 60 * 1000;

function esMasNueva(a, b) {
  const partes = (v) => String(v || '').split('-')[0].split('.').map((n) => Number(n) || 0);
  const [x, y] = [partes(a), partes(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

function crearRecordatorio({ leer, guardar, versionActual, ahora = Date.now }) {
  let estado = null;
  try { estado = leer() || null; } catch (_) { estado = null; }
  if (!estado || !esMasNueva(estado.version, versionActual)) {
    // Ya se instaló o el archivo no sirve: no queda nada pendiente de una vez anterior.
    if (estado) { try { guardar(null); } catch (_) { /* no frena el arranque */ } }
    estado = null;
  }
  // El instalador sigue en disco y se validó: solo se avisa después de saberlo en esta sesión.
  let lista = false;

  const fijar = (cambios) => {
    estado = { ...estado, ...cambios };
    try { guardar(estado); } catch (_) { /* el aviso sigue funcionando en memoria */ }
  };

  return {
    // Un "más tarde" vigente se respeta aunque se haya vuelto a abrir el POS o haya salido otra versión.
    descargada(version) {
      lista = true;
      const proximoAviso = estado && estado.proximoAviso > ahora() ? estado.proximoAviso : ahora();
      fijar({ version, proximoAviso });
    },
    debeAvisar() {
      return Boolean(lista && estado && ahora() >= estado.proximoAviso);
    },
    // Se vio el aviso: si nadie contesta, vuelve dentro de una hora.
    mostrado() {
      if (estado) fijar({ proximoAviso: ahora() + UNA_HORA_MS });
    },
    posponer() {
      if (estado) fijar({ proximoAviso: ahora() + UNA_HORA_MS });
    },
    // Empezó una venta con el aviso en pantalla: se retira y vuelve al quedar libre.
    aplazar() {
      if (estado) fijar({ proximoAviso: ahora() });
    },
    estado: () => (estado ? { ...estado, lista } : null),
  };
}

module.exports = { crearRecordatorio, esMasNueva, UNA_HORA_MS };

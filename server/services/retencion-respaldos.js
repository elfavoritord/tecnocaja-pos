'use strict';

/**
 * retencion-respaldos.js — Qué respaldos se guardan y cuáles se borran
 * (carpeta local y Backblaze, mismas reglas). Decisión de Emilio (2026-10-19):
 *
 *  - Automático: UNA copia por día ("TecnoCaja_Diario_<negocio>_<AAAA-MM-DD>"),
 *    local y en la nube. Cada respaldo automático del día reemplaza la copia
 *    de hoy con los datos más recientes.
 *  - Se conservan solo 2 copias automáticas: la de hoy y la del día anterior
 *    que tenga copia (si la PC no se usó ayer, la del último día que se usó).
 *    Las más viejas se borran, incluidas las "_AUTO_" de antes de este cambio.
 *  - Los respaldos manuales y las copias de seguridad previas (PRE-…) no son
 *    automáticos: se conservan los N más recientes (backup_retener_cantidad).
 *  - "TecnoCaja_Revisar_…": un respaldo automático que parecía vacío (ver
 *    pareceVacio). No reemplaza la copia del día ni hace borrar la de ayer;
 *    se guardan los 3 más recientes para revisarlos.
 */

const DIAS_AUTOMATICOS = 2;
const REVISAR_MAX = 3;

function pad(n) {
  return String(n).padStart(2, '0');
}

// Fecha del día en la hora de esta PC (no UTC: de noche ya sería mañana).
function fechaLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nombreSeguro(businessName) {
  return (businessName || 'TecnoCaja')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9\-_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 30);
}

function nombreDiario(businessName, fecha = new Date()) {
  return `TecnoCaja_Diario_${nombreSeguro(businessName)}_${fechaLocal(fecha)}.tcbak`;
}

function nombreRevisar(businessName, fecha = new Date()) {
  const hora = `${pad(fecha.getHours())}h${pad(fecha.getMinutes())}`;
  return `TecnoCaja_Revisar_${nombreSeguro(businessName)}_${fechaLocal(fecha)}_${hora}.tcbak`;
}

const RE_DIARIO = /^TecnoCaja_Diario_.*_(\d{4}-\d{2}-\d{2})\.tcbak$/;

function esDiario(nombre) {
  return RE_DIARIO.test(nombre);
}

function esAutomatico(nombre) {
  return esDiario(nombre) || /_AUTO_/.test(nombre);
}

function esParaRevisar(nombre) {
  return /^TecnoCaja_Revisar_/.test(nombre);
}

function diaDe(archivo) {
  const m = RE_DIARIO.exec(archivo.nombre);
  if (m) return m[1];
  const fecha = archivo.fecha instanceof Date ? archivo.fecha : new Date(archivo.fecha || 0);
  return fechaLocal(fecha);
}

const masNuevoPrimero = (a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0);

/**
 * @param {Array<{nombre: string, fecha: Date|string}>} archivos
 * @param {{ otrosMax?: number }} opciones  cuántos manuales/PRE conservar
 * @returns {string[]} nombres a borrar
 */
function aBorrar(archivos, { otrosMax = 5 } = {}) {
  const lista = (archivos || []).filter((a) => a && /\.(tcbak|novaseguro)$/.test(a.nombre || ''));
  const borrar = [];

  // Automáticos: la copia más nueva de cada uno de los 2 días más recientes.
  const porDia = new Map();
  lista.filter((a) => esAutomatico(a.nombre)).forEach((a) => {
    const dia = diaDe(a);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(a);
  });
  const dias = [...porDia.keys()].sort().reverse();
  dias.forEach((dia, i) => {
    const delDia = porDia.get(dia).sort(masNuevoPrimero);
    const conservar = i < DIAS_AUTOMATICOS ? 1 : 0;
    delDia.slice(conservar).forEach((a) => borrar.push(a.nombre));
  });

  lista.filter((a) => esParaRevisar(a.nombre)).sort(masNuevoPrimero)
    .slice(REVISAR_MAX).forEach((a) => borrar.push(a.nombre));

  lista.filter((a) => !esAutomatico(a.nombre) && !esParaRevisar(a.nombre)).sort(masNuevoPrimero)
    .slice(Math.max(1, otrosMax)).forEach((a) => borrar.push(a.nombre));

  return borrar;
}

// Un respaldo automático que parece de una base vacía o reiniciada no debe
// reemplazar la copia buena del día (ni hacer borrar la de ayer): pasa cuando
// la base se pierde y la app arranca en blanco, y al cerrarla se respaldaría
// la base vacía encima de la buena.
function pareceVacio(actual = {}, anterior = null) {
  if (Number(actual.usuarios || 0) === 0) return true;
  if (!anterior) return false;
  const teniaDatos = Number(anterior.ventas || 0) > 0 || Number(anterior.productos || 0) > 0;
  const ahoraNada = Number(actual.ventas || 0) === 0 && Number(actual.productos || 0) === 0;
  return teniaDatos && ahoraNada;
}

module.exports = {
  DIAS_AUTOMATICOS,
  fechaLocal,
  nombreDiario,
  nombreRevisar,
  esDiario,
  esAutomatico,
  esParaRevisar,
  aBorrar,
  pareceVacio,
};

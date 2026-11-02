'use strict';
// Avisos de comprobantes por agotarse para el contador. Parte del espejo que
// publica cada POS (ncf_aplicadas) y de lo que el contador ya registró y el POS
// no ha aplicado (ncf_pendientes): con eso sabe cuándo pedir más a la DGII sin
// entrar a cada negocio ni molestar al cliente.
//
// Se mira por tipo y sucursal, no por rango: si ya hay otro rango cargado o en
// cola que da para seguir, no hay nada que pedir.

const QUEDAN_AVISO = 50;
const QUEDAN_URGENTE = 15;
const PORCENTAJE_AVISO = 0.10;
const PORCENTAJE_URGENTE = 0.02;
const DIAS_AVISO = 30;
const DIAS_URGENTE = 7;

function diasEntre(hoy, fecha) {
  const a = Date.parse(`${String(hoy).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(fecha).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function estaActiva(seq, hoy) {
  if (seq.status === 'suspendido' || seq.status === 'cancelado' || seq.status === 'eliminado') return false;
  if ((seq.effectiveStatus || seq.status) === 'vencido' || (seq.effectiveStatus || seq.status) === 'agotado') return false;
  const dias = seq.expirationDate ? diasEntre(hoy, seq.expirationDate) : null;
  if (dias !== null && dias < 0) return false;
  return quedanDe(seq) > 0;
}

function quedanDe(seq) {
  const quedan = seq.totalAvailable ?? (Number(seq.endNumber) - Number(seq.nextNumber) + 1);
  return Math.max(0, Number(quedan) || 0);
}

function totalDe(seq) {
  const total = Number(seq.totalAuthorized) || (Number(seq.endNumber) - Number(seq.startNumber) + 1);
  return Math.max(1, total || 1);
}

function esElectronico(seq) {
  return /^E/i.test(String(seq.documentType || ''));
}

function comprobantes(n) {
  return `${Number(n).toLocaleString('es-DO')} comprobante${n === 1 ? '' : 's'}`;
}

/**
 * @returns {Array<{nivel: string, documentType: string, quedan: number, msg: string}>}
 */
function alertasDeSecuencias({ aplicadas = [], pendientes = [], hoy }) {
  const secuencias = aplicadas.filter((seq) => seq.documentType && !['suspendido', 'cancelado', 'eliminado'].includes(seq.status));
  // Un emisor electrónico ya no usa los B: un B viejo agotado no es un pendiente.
  const usaElectronicos = secuencias.some((seq) => esElectronico(seq) && estaActiva(seq, hoy));
  const enCola = new Set(
    pendientes
      .filter((p) => (p.action || 'create') === 'create' && p.status === 'pendiente')
      .map((p) => String(p.documentType || '').toUpperCase())
  );

  const grupos = new Map();
  for (const seq of secuencias) {
    if (usaElectronicos && !esElectronico(seq)) continue;
    const clave = `${seq.documentType}|${seq.branchId || ''}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(seq);
  }

  const alertas = [];
  for (const rangos of grupos.values()) {
    const { documentType, branchName } = rangos[0];
    if (enCola.has(String(documentType).toUpperCase())) continue;
    const lugar = branchName && branchName !== 'Global' ? ` (${branchName})` : '';
    const activos = rangos.filter((seq) => estaActiva(seq, hoy));

    if (!activos.length) {
      const vencida = rangos.some((seq) => (seq.effectiveStatus || seq.status) === 'vencido');
      alertas.push({
        nivel: 'critico', documentType, quedan: 0,
        msg: `${documentType}${lugar}: ${vencida ? 'la secuencia venció' : 'se acabaron los comprobantes'}. Pide más a la DGII y regístralos aquí.`,
      });
      continue;
    }

    const quedan = activos.reduce((suma, seq) => suma + quedanDe(seq), 0);
    const total = activos.reduce((suma, seq) => suma + totalDe(seq), 0);
    const porcentaje = quedan / total;
    // Si algún rango activo no vence, la fecha no apura.
    const dias = activos.every((seq) => seq.expirationDate)
      ? Math.max(...activos.map((seq) => diasEntre(hoy, seq.expirationDate) ?? Infinity))
      : null;

    const motivos = [];
    let nivel = null;
    if (quedan <= QUEDAN_URGENTE || porcentaje < PORCENTAJE_URGENTE) {
      nivel = 'urgente';
      motivos.push(`quedan solo ${comprobantes(quedan)}`);
    } else if (quedan <= QUEDAN_AVISO || porcentaje < PORCENTAJE_AVISO) {
      nivel = 'advertencia';
      motivos.push(`quedan ${comprobantes(quedan)}`);
    }
    if (dias !== null && dias <= DIAS_AVISO) {
      if (dias <= DIAS_URGENTE) nivel = 'urgente';
      else nivel = nivel || 'advertencia';
      motivos.push(dias === 0 ? 'vence hoy' : `vence en ${dias} día${dias === 1 ? '' : 's'}`);
    }
    if (nivel) {
      alertas.push({ nivel, documentType, quedan, msg: `${documentType}${lugar}: ${motivos.join(' y ')}. Pide más a la DGII.` });
    }
  }
  return alertas;
}

module.exports = { alertasDeSecuencias };

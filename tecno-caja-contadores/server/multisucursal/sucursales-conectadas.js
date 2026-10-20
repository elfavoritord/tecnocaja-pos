'use strict';

/**
 * Sucursales conectadas (multisucursal por Internet) en el portal del contador.
 *
 * Cada PC de sucursal tiene su propia base y publica sus reportes (ventas,
 * facturas, productos, cierres…) bajo SU documento de licencia
 * (licencias/{id} con `sucursalDe` = la empresa), no bajo el de la empresa:
 * así ninguna escribe sobre los datos de la principal. Las sucursales de la
 * empresa están en licencias/{empresa}/sucursales (las crean Emilio o el
 * contador). Aquí se juntan con lo que publica la principal para que el
 * portal vea la empresa entera.
 *
 * El portal filtra por un número de sucursal: cada sucursal conectada lleva
 * uno estable sacado de su uuid (idDeSucursal), lejos de los ids locales.
 */

const BASE_ID = 1e9;

function idDeSucursal(branchUuid) {
  const hex = String(branchUuid || '').replace(/[^0-9a-f]/gi, '').slice(0, 7);
  const n = parseInt(hex, 16);
  return hex && Number.isFinite(n) ? BASE_ID + n : null;
}

// Totales del tablero (posStats) que se suman entre sucursales.
const CAMPOS_SUMABLES = ['ventasHoy', 'ventasTotal', 'ventasMes', 'facturasEmitidas', 'itbisMes', 'productosActivos', 'bajoInventario', 'cxcPendiente'];

function createSucursalesConectadas({ getDb, colLicencias = 'licencias' }) {
  const licencia = (id) => getDb().collection(colLicencias).doc(String(id));

  async function centrales(licenseId) {
    const snap = await licencia(licenseId).collection('sucursales').get();
    return snap.docs.map((d) => ({ branchUuid: d.id, ...d.data() }));
  }

  // Documentos de licencia de las PC de sucursal de esta empresa.
  async function pcsDeSucursal(licenseId) {
    const snap = await getDb().collection(colLicencias).where('sucursalDe.licenseId', '==', String(licenseId)).get();
    return snap.docs
      .filter((d) => !d.data().deleted)
      .map((d) => ({ id: d.id, branchUuid: d.data().sucursalDe?.branchUuid || '', nombre: d.data().sucursalDe?.sucursal || '', data: d.data() }));
  }

  // Lista de sucursales del negocio para el portal: las que publica el POS de
  // la principal (`propias`, con sus ids locales) más las demás sucursales de
  // la empresa. Sin sucursales en la central, queda como antes.
  async function sucursales(licenseId, propias = []) {
    const lista = await centrales(licenseId).catch(() => []);
    const otras = lista.filter((s) => !s.esPrincipal && s.estado === 'activa');
    if (!otras.length) return propias;
    const pcs = await pcsDeSucursal(licenseId).catch(() => []);
    return [
      ...propias,
      ...otras.map((s) => ({
        id: idDeSucursal(s.branchUuid),
        nombre: s.nombre || 'Sucursal',
        codigo: s.codigo || '',
        direccion: s.direccion || '',
        telefono: s.telefono || '',
        encargado: s.encargado || '',
        estado: 'Activa',
        cajas: [],
        branchUuid: s.branchUuid,
        conectada: true,
        tienePc: pcs.some((p) => p.branchUuid === s.branchUuid),
      })),
    ];
  }

  // Filas de licencias/{pc}/reportes/{tab} de cada PC de sucursal, marcadas
  // con su sucursal.
  async function filas(licenseId, tab) {
    const pcs = await pcsDeSucursal(licenseId).catch(() => []);
    const partes = await Promise.all(pcs.map(async (pc) => {
      const doc = await licencia(pc.id).collection('reportes').doc(String(tab)).get().catch(() => null);
      if (!doc?.exists) return [];
      const id = idDeSucursal(pc.branchUuid);
      return (doc.data().rows || []).map((r) => ({
        ...r, branchId: id, branch_id: id, sucursalId: id, sucursal_id: id, sucursal: pc.nombre || r.sucursal || '',
      }));
    }));
    return partes.flat();
  }

  // Totales del tablero con las sucursales sumadas.
  async function sumarStats(licenseId, stats = {}) {
    const pcs = await pcsDeSucursal(licenseId).catch(() => []);
    if (!pcs.length) return stats;
    const total = { ...stats };
    for (const pc of pcs) {
      const s = pc.data.posStats || {};
      for (const campo of CAMPOS_SUMABLES) {
        if (s[campo] != null) total[campo] = Number(total[campo] || 0) + Number(s[campo] || 0);
      }
    }
    return total;
  }

  return { sucursales, filas, sumarStats, pcsDeSucursal };
}

module.exports = { createSucursalesConectadas, idDeSucursal };

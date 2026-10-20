'use strict';

/**
 * licencias-del-dueno.js — Los negocios (licencias) cuyo dueño es un correo.
 * Lo usa "Restaurar desde la nube" en una PC recién instalada o formateada:
 * el dueño entra con su cuenta de Tecno Caja y ve los respaldos de sus
 * negocios aunque esta PC todavía no tenga licencia.
 *
 * El correo del dueño está en `correo` (lo escribe el POS al sincronizar sus
 * cuentas), `ownerEmail` o `email` de la licencia.
 */

const CAMPOS = ['correo', 'ownerEmail', 'email'];

function createLicenciasDelDueno({ getFirestore, coleccion = 'licencias' }) {
  return async function licenciasDelCorreo(email) {
    const correo = String(email || '').trim().toLowerCase();
    if (!correo) return [];
    const db = getFirestore();
    if (!db) throw new Error('Firebase no está configurado en esta PC.');
    const docs = new Map();
    for (const campo of CAMPOS) {
      const snap = await db.collection(coleccion).where(campo, '==', correo).limit(25).get();
      snap.docs.forEach((d) => docs.set(d.id, d));
    }
    // Las PC de sucursal de sus empresas (su licencia propia no lleva el
    // correo del dueño).
    for (const empresa of [...docs.values()].filter((d) => !d.data().sucursalDe)) {
      const snap = await db.collection(coleccion).where('sucursalDe.licenseId', '==', empresa.id).limit(50).get();
      snap.docs.forEach((d) => docs.set(d.id, d));
    }
    return [...docs.values()]
      .filter((d) => !d.data().deleted)
      .map((d) => {
        const x = d.data();
        const sucursal = x.sucursalDe?.sucursal ? ` · ${x.sucursalDe.sucursal}` : '';
        return {
          licenseId: d.id,
          nombre: `${x.sucursalDe?.empresa || x.businessName || x.razon_social || d.id}${sucursal}`,
          esSucursal: Boolean(x.sucursalDe),
        };
      })
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
  };
}

module.exports = { createLicenciasDelDueno };

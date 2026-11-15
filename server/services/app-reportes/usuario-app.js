'use strict';

/**
 * Quién pide algo desde la app de reportes (TCP Reportes).
 *
 * La app escribe en Firestore con su sesión de Firebase; las reglas solo dejan
 * escribir a usuarios del negocio con rol de administrador, y guardan su uid en
 * `createdBy`. Aquí esta PC (la principal) vuelve a mirar quién es antes de hacer
 * nada: su perfil users/{uid} (lo escribe el POS con la llave de administrador) y,
 * si es un usuario del POS (posUserId), ese usuario con sus permisos de siempre.
 * Así un permiso quitado en el POS se respeta también en la app.
 */

const ROLES_DUENO = new Set(['superadmin', 'businessowner', 'owner']);

function createUsuarioApp({
  getUserWithRoleContextById,   // (id) => usuario del POS con role_code / role_permissions
  isGlobalAdministratorUser,    // (usuario) => bool
  userRoleHasPermission,        // (usuario, ...permisos) => bool
  getUserScopeBranchId,         // (usuario) => sucursal a la que está atado, o null
}) {
  function rechazo(texto) {
    return { rechazo: texto };
  }

  /**
   * @returns {Promise<{rechazo:string}|{uid, nombre, usuarioPos, esDueno, sucursal, puede:(…permisos)=>bool, actor}>}
   */
  async function resolver(db, negocio, uid) {
    const id = String(uid || '').trim();
    if (!id) return rechazo('La solicitud no dice quién la mandó.');
    const snap = await db.collection('users').doc(id).get();
    const perfil = snap.exists ? (snap.data() || {}) : null;
    const negocios = [perfil?.businessId, ...(Array.isArray(perfil?.businessIds) ? perfil.businessIds : [])].map(String);
    if (!perfil || !negocios.includes(String(negocio))) return rechazo('Ese usuario no pertenece a este negocio.');
    if (perfil.isActive === false) return rechazo('Ese usuario está desactivado.');
    const nombre = String(perfil.displayName || perfil.email || 'Usuario de la app').slice(0, 120);
    const rol = String(perfil.role || '').trim().toLowerCase();
    const posUserId = Number(perfil.posUserId || 0) || null;

    if (!posUserId) {
      // El dueño de la licencia (o un administrador general viejo, de antes de que
      // el perfil guardara el usuario del POS) puede todo, como en el POS.
      if (!ROLES_DUENO.has(rol) && rol !== 'admin') {
        return rechazo('Tu usuario de la app no está ligado a un usuario del POS. Pídele al dueño que lo revise en Configuración → Usuarios.');
      }
      return {
        uid: id, nombre, usuarioPos: null, esDueno: true, sucursal: null,
        puede: () => true,
        actor: { id: null, nombre: `${nombre} (app)`, usuario: perfil.email || 'app', role_code: 'administrador_general', rol: 'administrador_general' },
      };
    }

    const usuario = await getUserWithRoleContextById(posUserId);
    const estado = String(usuario?.estado || 'Activo').trim().toLowerCase();
    if (!usuario || estado !== 'activo') return rechazo('Tu usuario ya no existe o está desactivado en el POS.');
    const esAdmin = Boolean(isGlobalAdministratorUser(usuario));
    return {
      uid: id, nombre: String(usuario.nombre || nombre), usuarioPos: usuario, esDueno: esAdmin,
      sucursal: esAdmin ? null : (Number(getUserScopeBranchId(usuario) || 0) || null),
      puede: (...permisos) => esAdmin || Boolean(userRoleHasPermission(usuario, ...permisos)),
      actor: { ...usuario, nombre: String(usuario.nombre || usuario.usuario || nombre) },
    };
  }

  return { resolver };
}

module.exports = { createUsuarioApp };

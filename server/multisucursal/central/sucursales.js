'use strict';

/**
 * server/multisucursal/central/sucursales.js — Reglas centrales de sucursales
 * (Firestore). Fase 3 del proyecto multisucursal.
 *
 * FUENTE ÚNICA de estas reglas. La usan:
 *   - tecno-caja-admin (panel de Emilio)           → require directo.
 *   - tecno-caja-contadores (portal del contador)   → copia por vendor-sync.
 *   - la Sync API (Fase 3b)                         → canjear códigos.
 *
 * Quién puede qué (decisión de Emilio, 2026-10-19):
 *   - super_admin (Emilio): fija el límite de sucursales de cada empresa,
 *     crea/edita/activa/desactiva sucursales y genera códigos de equipo.
 *   - contador: SOLO en las empresas que tiene asignadas (licencias.contadorId)
 *     crea y edita los datos de sucursales y genera códigos, dentro del
 *     límite. No cambia el límite ni activa/desactiva.
 *   - El dueño del negocio no crea sucursales.
 *
 * Firestore:
 *   licencias/{licenseId}                     companyUuid, maxSucursales
 *   licencias/{licenseId}/sucursales/{uuid}   datos de cada sucursal
 *   licencias/{licenseId}/sucursales_historial/{auto}   auditoría
 *   activaciones_equipo/{sha256(código)}      código de un solo uso, 24 h
 *   equipos_sync/{equipoId}                   PC que sincroniza una sucursal (hash del token)
 *
 * Todo se escribe en transacción: dos personas creando a la vez no pueden
 * pasarse del límite.
 */

const crypto = require('crypto');

const COL_LICENCIAS = 'licencias';
const SUB_SUCURSALES = 'sucursales';
const SUB_HISTORIAL = 'sucursales_historial';
const COL_ACTIVACIONES = 'activaciones_equipo';
// Equipos que sincronizan (uno activo por sucursal). Lo lee la Sync API para
// autenticar cada petición por el hash de su token.
const COL_EQUIPOS = 'equipos_sync';

const LIMITE_MINIMO = 1;
const LIMITE_MAXIMO = 200;
const VIGENCIA_CODIGO_MS = 24 * 60 * 60 * 1000;
// Sin I, L, O, 0 ni 1: se dictan por teléfono sin confusiones.
const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const ESTADOS = Object.freeze({ ACTIVA: 'activa', INACTIVA: 'inactiva' });
const ESTADOS_EQUIPO = Object.freeze({ ACTIVO: 'activo', REEMPLAZADO: 'reemplazado', REVOCADO: 'revocado' });
const ACCIONES = Object.freeze({
  VER: 'ver',
  FIJAR_LIMITE: 'fijar_limite',
  CREAR: 'crear',
  EDITAR: 'editar',
  CAMBIAR_ESTADO: 'cambiar_estado',
  GENERAR_CODIGO: 'generar_codigo',
  REVOCAR_EQUIPO: 'revocar_equipo',
  // Rangos NCF por sucursal (sincronizacion-central.js): el contador lleva lo
  // fiscal de sus empresas, así que también los asigna.
  ASIGNAR_NCF: 'asignar_ncf',
});
const MENSAJES_SOLO_ADMIN = Object.freeze({
  [ACCIONES.FIJAR_LIMITE]: 'Solo el administrador de Tecno Caja puede cambiar cuántas sucursales tiene una empresa.',
  [ACCIONES.CAMBIAR_ESTADO]: 'Solo el administrador de Tecno Caja puede activar o desactivar sucursales.',
  [ACCIONES.REVOCAR_EQUIPO]: 'Solo el administrador de Tecno Caja puede revocar equipos.',
});

const PERMISOS_CONTADOR = new Set([ACCIONES.VER, ACCIONES.CREAR, ACCIONES.EDITAR, ACCIONES.GENERAR_CODIGO, ACCIONES.ASIGNAR_NCF]);

class ErrorSucursales extends Error {
  constructor(mensaje, codigo, status = 400) {
    super(mensaje);
    this.code = codigo;
    this.statusCode = status;
  }
}

function texto(valor, max) {
  return String(valor == null ? '' : valor).trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizarCodigoSucursal(valor) {
  return texto(valor, 40).toUpperCase();
}

function normalizarCodigoActivacion(valor) {
  return String(valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashCodigo(codigo) {
  return crypto.createHash('sha256').update(normalizarCodigoActivacion(codigo), 'utf8').digest('hex');
}

function aFecha(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate();
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

function limiteDe(licencia) {
  const n = Number(licencia?.maxSucursales);
  return Number.isInteger(n) && n >= LIMITE_MINIMO ? n : LIMITE_MINIMO;
}

function validarActor(actor) {
  if (!actor || !['super_admin', 'contador'].includes(actor.tipo) || !actor.uid) {
    throw new ErrorSucursales('No tienes permiso para administrar sucursales.', 'SIN_PERMISO', 403);
  }
}

// Lanza si el actor no puede hacer `accion` sobre esa licencia.
function autorizar(actor, accion, licenciaId, licencia) {
  validarActor(actor);
  if (actor.tipo === 'super_admin') return;
  if (!PERMISOS_CONTADOR.has(accion)) {
    throw new ErrorSucursales(MENSAJES_SOLO_ADMIN[accion] || 'No tienes permiso para esta acción.', 'SIN_PERMISO', 403);
  }
  const asignado = String(licencia?.contadorId || '').trim();
  if (!asignado || asignado !== String(actor.contadorId || '').trim()) {
    throw new ErrorSucursales(`Esta empresa no está asignada a tu firma (${licenciaId}).`, 'SIN_PERMISO', 403);
  }
}

function validarDatos(datos, { parcial = false } = {}) {
  const limpio = {};
  const campos = {
    nombre: 160, codigo: 40, direccion: 255, telefono: 40, encargado: 160,
  };
  for (const [campo, max] of Object.entries(campos)) {
    if (!parcial || Object.prototype.hasOwnProperty.call(datos || {}, campo)) {
      limpio[campo] = campo === 'codigo' ? normalizarCodigoSucursal(datos?.[campo]) : texto(datos?.[campo], max);
    }
  }
  if ((!parcial || 'nombre' in limpio) && limpio.nombre.length < 2) {
    throw new ErrorSucursales('El nombre de la sucursal es obligatorio.', 'DATOS_INVALIDOS');
  }
  return limpio;
}

function quien(actor) {
  return {
    tipo: actor.tipo,
    uid: actor.uid,
    nombre: texto(actor.nombre || actor.email || '', 160),
    ...(actor.contadorId ? { contadorId: String(actor.contadorId) } : {}),
  };
}

function createSucursalesCentral({
  db,
  randomUUID = () => crypto.randomUUID(),
  randomInt = (max) => crypto.randomInt(max),
  now = () => new Date(),
}) {
  if (!db || typeof db.collection !== 'function') throw new Error('Se necesita una instancia de Firestore.');

  const licenciaRef = (id) => db.collection(COL_LICENCIAS).doc(String(id));
  const sucursalesRef = (id) => licenciaRef(id).collection(SUB_SUCURSALES);
  const historialRef = (id) => licenciaRef(id).collection(SUB_HISTORIAL);

  async function leerLicencia(tx, licenseId) {
    const snap = await tx.get(licenciaRef(licenseId));
    if (!snap.exists) throw new ErrorSucursales('Empresa no encontrada.', 'NO_ENCONTRADA', 404);
    const data = snap.data();
    if (data.deleted) throw new ErrorSucursales('La empresa está en la papelera.', 'NO_ENCONTRADA', 404);
    return data;
  }

  function registrarHistorial(tx, licenseId, accion, actor, detalle) {
    tx.set(historialRef(licenseId).doc(), { accion, actor: quien(actor), detalle, at: now() });
  }

  function aVista(snap) {
    const d = snap.data();
    return {
      branchUuid: snap.id,
      nombre: d.nombre,
      codigo: d.codigo || '',
      direccion: d.direccion || '',
      telefono: d.telefono || '',
      encargado: d.encargado || '',
      estado: d.estado,
      esPrincipal: Boolean(d.esPrincipal),
      version: Number(d.version || 1),
      creadaPor: d.creadaPor || null,
      createdAt: aFecha(d.createdAt)?.toISOString() || null,
      updatedAt: aFecha(d.updatedAt)?.toISOString() || null,
    };
  }

  async function resumen(licenseId, actor) {
    const lic = await leerLicencia({ get: (ref) => ref.get() }, licenseId);
    autorizar(actor, ACCIONES.VER, licenseId, lic);
    const snap = await sucursalesRef(licenseId).get();
    const sucursales = snap.docs.map(aVista).sort((a, b) => {
      if (a.esPrincipal !== b.esPrincipal) return a.esPrincipal ? -1 : 1;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
    const activas = sucursales.filter((s) => s.estado === ESTADOS.ACTIVA).length;
    return {
      licenseId: String(licenseId),
      businessName: lic.businessName || lic.razon_social || '',
      companyUuid: lic.companyUuid || null,
      maxSucursales: limiteDe(lic),
      activas,
      disponibles: Math.max(0, limiteDe(lic) - activas),
      sucursales,
    };
  }

  async function fijarLimite(licenseId, maximo, actor) {
    const nuevo = Number(maximo);
    if (!Number.isInteger(nuevo) || nuevo < LIMITE_MINIMO || nuevo > LIMITE_MAXIMO) {
      throw new ErrorSucursales(`El límite debe ser un número entre ${LIMITE_MINIMO} y ${LIMITE_MAXIMO}.`, 'DATOS_INVALIDOS');
    }
    return db.runTransaction(async (tx) => {
      const lic = await leerLicencia(tx, licenseId);
      autorizar(actor, ACCIONES.FIJAR_LIMITE, licenseId, lic);
      const activas = (await tx.get(sucursalesRef(licenseId).where('estado', '==', ESTADOS.ACTIVA))).size;
      if (nuevo < activas) {
        throw new ErrorSucursales(
          `La empresa tiene ${activas} sucursales activas. Desactiva alguna antes de bajar el límite a ${nuevo}.`,
          'LIMITE_MENOR_QUE_ACTIVAS', 409
        );
      }
      const anterior = limiteDe(lic);
      tx.update(licenciaRef(licenseId), { maxSucursales: nuevo, updatedAt: now() });
      registrarHistorial(tx, licenseId, 'limite', actor, { anterior, nuevo });
      return { maxSucursales: nuevo, activas };
    });
  }

  async function crear(licenseId, datos, actor) {
    validarActor(actor);
    return db.runTransaction(async (tx) => {
      const lic = await leerLicencia(tx, licenseId);
      // Primero el permiso: a quien no tiene acceso no se le dice nada de los datos.
      autorizar(actor, ACCIONES.CREAR, licenseId, lic);
      const limpio = validarDatos(datos);

      const todas = await tx.get(sucursalesRef(licenseId));
      const activas = todas.docs.filter((d) => d.data().estado === ESTADOS.ACTIVA).length;
      const maximo = limiteDe(lic);
      if (activas >= maximo) {
        throw new ErrorSucursales(
          `Esta empresa ya tiene ${activas} de ${maximo} sucursales permitidas. Solo el administrador de Tecno Caja puede ampliar el límite.`,
          'LIMITE_SUCURSALES', 409
        );
      }
      if (limpio.codigo && todas.docs.some((d) => d.data().codigo === limpio.codigo)) {
        throw new ErrorSucursales(`Ya existe una sucursal con el código ${limpio.codigo}.`, 'CODIGO_DUPLICADO', 409);
      }

      let companyUuid = lic.companyUuid;
      if (!companyUuid) {
        companyUuid = randomUUID();
        tx.update(licenciaRef(licenseId), { companyUuid, updatedAt: now() });
      }
      const branchUuid = randomUUID();
      const sucursal = {
        ...limpio,
        companyUuid,
        estado: ESTADOS.ACTIVA,
        esPrincipal: todas.empty,
        version: 1,
        creadaPor: quien(actor),
        createdAt: now(),
        updatedAt: now(),
      };
      tx.set(sucursalesRef(licenseId).doc(branchUuid), sucursal);
      registrarHistorial(tx, licenseId, 'crear', actor, { branchUuid, nombre: limpio.nombre });
      return { branchUuid, companyUuid, ...limpio, estado: sucursal.estado, esPrincipal: sucursal.esPrincipal };
    });
  }

  async function editar(licenseId, branchUuid, cambios, actor) {
    validarActor(actor);
    return db.runTransaction(async (tx) => {
      const lic = await leerLicencia(tx, licenseId);
      autorizar(actor, ACCIONES.EDITAR, licenseId, lic);
      const ref = sucursalesRef(licenseId).doc(String(branchUuid));
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ErrorSucursales('Sucursal no encontrada.', 'NO_ENCONTRADA', 404);
      const limpio = validarDatos(cambios, { parcial: true });
      if (!Object.keys(limpio).length) throw new ErrorSucursales('No hay cambios.', 'DATOS_INVALIDOS');
      if (limpio.codigo) {
        const todas = await tx.get(sucursalesRef(licenseId));
        if (todas.docs.some((d) => d.id !== snap.id && d.data().codigo === limpio.codigo)) {
          throw new ErrorSucursales(`Ya existe una sucursal con el código ${limpio.codigo}.`, 'CODIGO_DUPLICADO', 409);
        }
      }
      const antes = snap.data();
      const version = Number(antes.version || 1) + 1;
      tx.update(ref, { ...limpio, version, updatedAt: now(), editadaPor: quien(actor) });
      const cambiados = Object.fromEntries(Object.entries(limpio).filter(([k, v]) => antes[k] !== v).map(([k, v]) => [k, { antes: antes[k] ?? '', despues: v }]));
      registrarHistorial(tx, licenseId, 'editar', actor, { branchUuid: snap.id, cambios: cambiados });
      return { branchUuid: snap.id, version };
    });
  }

  async function cambiarEstado(licenseId, branchUuid, estado, actor) {
    if (!Object.values(ESTADOS).includes(estado)) throw new ErrorSucursales('Estado inválido.', 'DATOS_INVALIDOS');
    return db.runTransaction(async (tx) => {
      const lic = await leerLicencia(tx, licenseId);
      autorizar(actor, ACCIONES.CAMBIAR_ESTADO, licenseId, lic);
      const ref = sucursalesRef(licenseId).doc(String(branchUuid));
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ErrorSucursales('Sucursal no encontrada.', 'NO_ENCONTRADA', 404);
      const actual = snap.data().estado;
      if (actual === estado) return { branchUuid: snap.id, estado };
      if (estado === ESTADOS.ACTIVA) {
        const activas = (await tx.get(sucursalesRef(licenseId).where('estado', '==', ESTADOS.ACTIVA))).size;
        if (activas >= limiteDe(lic)) {
          throw new ErrorSucursales(
            `No se puede reactivar: la empresa ya tiene ${activas} de ${limiteDe(lic)} sucursales. Sube el límite primero.`,
            'LIMITE_SUCURSALES', 409
          );
        }
      }
      tx.update(ref, { estado, version: Number(snap.data().version || 1) + 1, updatedAt: now() });
      registrarHistorial(tx, licenseId, estado === ESTADOS.ACTIVA ? 'activar' : 'desactivar', actor, { branchUuid: snap.id });
      return { branchUuid: snap.id, estado };
    });
  }

  function nuevoCodigo() {
    let s = '';
    for (let i = 0; i < 8; i += 1) s += ALFABETO_CODIGO[randomInt(ALFABETO_CODIGO.length)];
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  }

  // Código para autorizar UN equipo en ESA sucursal. Se muestra una sola vez:
  // en Firestore solo queda su hash.
  async function generarCodigo(licenseId, branchUuid, actor) {
    for (let intento = 0; intento < 5; intento += 1) {
      const codigo = nuevoCodigo();
      const ref = db.collection(COL_ACTIVACIONES).doc(hashCodigo(codigo));
      try {
        return await db.runTransaction(async (tx) => {
          const lic = await leerLicencia(tx, licenseId);
          autorizar(actor, ACCIONES.GENERAR_CODIGO, licenseId, lic);
          const suc = await tx.get(sucursalesRef(licenseId).doc(String(branchUuid)));
          if (!suc.exists) throw new ErrorSucursales('Sucursal no encontrada.', 'NO_ENCONTRADA', 404);
          if (suc.data().estado !== ESTADOS.ACTIVA) {
            throw new ErrorSucursales('La sucursal está desactivada.', 'SUCURSAL_INACTIVA', 409);
          }
          if ((await tx.get(ref)).exists) throw new ErrorSucursales('colisión', 'COLISION');
          const venceEn = new Date(now().getTime() + VIGENCIA_CODIGO_MS);
          tx.set(ref, {
            licenseId: String(licenseId),
            branchUuid: suc.id,
            companyUuid: suc.data().companyUuid || lic.companyUuid || null,
            venceEn,
            usado: false,
            creadoPor: quien(actor),
            createdAt: now(),
          });
          registrarHistorial(tx, licenseId, 'codigo_equipo', actor, { branchUuid: suc.id, venceEn: venceEn.toISOString() });
          return { codigo, branchUuid: suc.id, venceEn: venceEn.toISOString() };
        });
      } catch (error) {
        if (error.code !== 'COLISION') throw error;
      }
    }
    throw new ErrorSucursales('No se pudo generar un código, intenta de nuevo.', 'COLISION', 503);
  }

  // Lecturas y validaciones de un canje (dentro de una transacción, antes de
  // cualquier escritura).
  async function leerCanje(tx, codigo) {
    const ref = db.collection(COL_ACTIVACIONES).doc(hashCodigo(codigo));
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ErrorSucursales('Código de activación inválido.', 'CODIGO_INVALIDO', 404);
    const act = snap.data();
    if (act.usado) throw new ErrorSucursales('Este código ya se usó. Pide uno nuevo.', 'CODIGO_USADO', 409);
    if (aFecha(act.venceEn) <= now()) throw new ErrorSucursales('Este código venció. Pide uno nuevo.', 'CODIGO_VENCIDO', 410);
    const lic = await leerLicencia(tx, act.licenseId);
    if (['suspended', 'cancelled'].includes(lic.status)) {
      throw new ErrorSucursales('La licencia de la empresa no está activa.', 'LICENCIA_INACTIVA', 403);
    }
    const suc = await tx.get(sucursalesRef(act.licenseId).doc(act.branchUuid));
    if (!suc.exists || suc.data().estado !== ESTADOS.ACTIVA) {
      throw new ErrorSucursales('La sucursal de este código ya no está activa.', 'SUCURSAL_INACTIVA', 409);
    }
    return { ref, act, lic, suc };
  }

  function identidadDe({ act, lic, suc }) {
    return {
      licenseId: act.licenseId,
      companyUuid: suc.data().companyUuid || lic.companyUuid,
      sucursal: aVista(suc),
      businessName: lic.businessName || lic.razon_social || '',
    };
  }

  // Valida y consume el código sin registrar equipo.
  async function canjearCodigo(codigo, equipo = {}) {
    return db.runTransaction(async (tx) => {
      const canje = await leerCanje(tx, codigo);
      tx.update(canje.ref, {
        usado: true,
        usadoEn: now(),
        usadoPor: { deviceId: texto(equipo.deviceId, 80), hostname: texto(equipo.hostname, 120) },
      });
      return identidadDe(canje);
    });
  }

  // Activación de un equipo (Sync API), todo en UNA transacción: consume el
  // código, deja como 'reemplazado' al equipo que tenía la sucursal (una
  // sucursal = un nodo que sincroniza; dos bases no pueden hablar por la
  // misma sucursal) y registra el nuevo con el hash de su token.
  async function activarEquipo(codigo, equipo = {}, { equipoId, tokenHash }) {
    if (!equipoId || !/^[a-f0-9]{64}$/.test(String(tokenHash || ''))) throw new Error('Falta equipoId o tokenHash.');
    return db.runTransaction(async (tx) => {
      const canje = await leerCanje(tx, codigo);
      // Una PC que ya tiene la licencia de una empresa no se activa con el
      // código de otra (y el código no se gasta).
      const licenciaDelEquipo = texto(equipo.licenseId, 160);
      if (licenciaDelEquipo && licenciaDelEquipo !== canje.act.licenseId) {
        throw new ErrorSucursales('Este código es de otra empresa. Esta PC tiene la licencia de otro negocio.', 'OTRA_EMPRESA', 409);
      }
      const sucursalKey = `${canje.act.licenseId}/${canje.suc.id}`;
      const anteriores = await tx.get(db.collection(COL_EQUIPOS).where('sucursalKey', '==', sucursalKey));
      const datosEquipo = {
        deviceId: texto(equipo.deviceId, 80),
        hostname: texto(equipo.hostname, 120),
        serverId: texto(equipo.serverId, 40),
        appVersion: texto(equipo.appVersion, 20),
      };

      tx.update(canje.ref, { usado: true, usadoEn: now(), usadoPor: { ...datosEquipo, equipoId } });
      const reemplazados = [];
      for (const doc of anteriores.docs) {
        if (doc.data().estado !== ESTADOS_EQUIPO.ACTIVO) continue;
        tx.update(doc.ref, { estado: ESTADOS_EQUIPO.REEMPLAZADO, reemplazadoEn: now(), reemplazadoPor: equipoId });
        reemplazados.push(doc.id);
      }
      const identidad = identidadDe(canje);
      tx.set(db.collection(COL_EQUIPOS).doc(equipoId), {
        ...datosEquipo,
        licenseId: identidad.licenseId,
        companyUuid: identidad.companyUuid,
        branchUuid: canje.suc.id,
        sucursalKey,
        tokenHash,
        estado: ESTADOS_EQUIPO.ACTIVO,
        activadoEn: now(),
        ultimaConexion: now(),
      });
      tx.set(historialRef(identidad.licenseId).doc(), {
        accion: 'equipo_activado',
        actor: { tipo: 'equipo', uid: equipoId, nombre: datosEquipo.hostname },
        detalle: { branchUuid: canje.suc.id, equipoId, reemplazados },
        at: now(),
      });
      return { ...identidad, equipoId, reemplazados };
    });
  }

  function vistaEquipo(doc) {
    const d = doc.data();
    return {
      equipoId: doc.id,
      branchUuid: d.branchUuid,
      hostname: d.hostname || '',
      appVersion: d.appVersion || '',
      estado: d.estado,
      activadoEn: aFecha(d.activadoEn)?.toISOString() || null,
      ultimaConexion: aFecha(d.ultimaConexion)?.toISOString() || null,
      ultimaSincronizacion: aFecha(d.ultimaSincronizacion)?.toISOString() || null,
      latido: d.latido || null,
    };
  }

  // Equipos de la empresa (nunca devuelve el hash del token).
  async function listarEquipos(licenseId, actor) {
    const lic = await leerLicencia({ get: (ref) => ref.get() }, licenseId);
    autorizar(actor, ACCIONES.VER, licenseId, lic);
    const snap = await db.collection(COL_EQUIPOS).where('licenseId', '==', String(licenseId)).get();
    return snap.docs.map(vistaEquipo).sort((a, b) => String(b.activadoEn).localeCompare(String(a.activadoEn)));
  }

  // Revocar un equipo (robado, dañado, vendido): deja de poder sincronizar.
  async function revocarEquipo(licenseId, equipoId, actor) {
    return db.runTransaction(async (tx) => {
      const lic = await leerLicencia(tx, licenseId);
      autorizar(actor, ACCIONES.REVOCAR_EQUIPO, licenseId, lic);
      const ref = db.collection(COL_EQUIPOS).doc(String(equipoId));
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().licenseId !== String(licenseId)) {
        throw new ErrorSucursales('Equipo no encontrado.', 'NO_ENCONTRADO', 404);
      }
      if (snap.data().estado === ESTADOS_EQUIPO.REVOCADO) return { equipoId: snap.id, estado: ESTADOS_EQUIPO.REVOCADO };
      tx.update(ref, { estado: ESTADOS_EQUIPO.REVOCADO, revocadoEn: now(), revocadoPor: quien(actor) });
      registrarHistorial(tx, licenseId, 'equipo_revocado', actor, { equipoId: snap.id, branchUuid: snap.data().branchUuid });
      return { equipoId: snap.id, estado: ESTADOS_EQUIPO.REVOCADO };
    });
  }

  let sincronizacion = null;
  return {
    resumen, fijarLimite, crear, editar, cambiarEstado, generarCodigo, canjearCodigo,
    activarEquipo, listarEquipos, revocarEquipo,
    // Rangos NCF y resumen de ventas (sincronizacion-central.js), con la misma
    // base. Se carga aquí adentro porque ese módulo a su vez usa este.
    get sincronizacion() {
      if (!sincronizacion) {
        // eslint-disable-next-line global-require
        const { createSincronizacionCentral } = require('./sincronizacion-central');
        sincronizacion = createSincronizacionCentral({ db, now, randomUUID });
      }
      return sincronizacion;
    },
  };
}

module.exports = {
  createSucursalesCentral,
  ErrorSucursales,
  ESTADOS,
  ESTADOS_EQUIPO,
  ACCIONES,
  COL_EQUIPOS,
  LIMITE_MINIMO,
  LIMITE_MAXIMO,
  hashCodigo,
  normalizarCodigoActivacion,
  // Para sincronizacion-central.js (mismas reglas de permisos y auditoría).
  autorizar,
  quien,
  aFecha,
  COL_LICENCIAS,
  SUB_SUCURSALES,
  SUB_HISTORIAL,
};

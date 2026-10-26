'use strict';

/**
 * server/multisucursal/central/sincronizacion-central.js — Reglas centrales de
 * la sincronización entre sucursales (Fases 4, 5 y 7). FUENTE ÚNICA, igual que
 * sucursales.js. La usan:
 *   - la Sync API (eventos que suben las sucursales y cambios que bajan) → copia por vendor-sync.
 *   - el panel de Emilio y el portal del contador (rangos NCF, resumen de ventas).
 *
 * Reglas de conflicto (prompt maestro §7):
 *   - Catálogo maestro: gana la central. Lo publica SOLO la sucursal principal.
 *   - Precio y existencia: son de cada sucursal. La central solo los registra
 *     (para reportes); nunca los manda de vuelta, salvo un cambio de precio
 *     explícito en varias sucursales (comando).
 *   - Ventas: inmutables. Una venta que vuelve a llegar solo puede cambiar de
 *     estado (anulada, devuelta); el total y las líneas no se tocan.
 *   - Usuarios: gana la central (los publica la principal).
 *   - NCF: un número asignado a una sucursal nunca se vuelve a asignar, ni
 *     siquiera si el rango se anula. Igual para los e-NCF (serie E): la DGII
 *     los autoriza por RNC y la empresa los reparte entre sus sucursales.
 *
 * Firestore (todo bajo licencias/{licenseId}, cerrado a clientes; solo Admin SDK):
 *   sync/contador                         seq creciente de la empresa (cursores)
 *   catalogo/{productUuid}                producto maestro (seq, version, alcance)
 *   catalogo_codigos/{sha256(código)}     código único en la empresa
 *   usuarios/{userUuid}                   usuario de la empresa (hash de su clave, nunca la clave)
 *   usuarios_nombres/{sha256(usuario)}    nombre de usuario único en la empresa
 *   ncf_tipos/{tipo}                      todos los rangos dados de ese tipo (para no repetir números)
 *   sucursales/{b}/eventos_recibidos/{eventId}   idempotencia
 *   sucursales/{b}/ventas/{saleUuid}             venta (inmutable)
 *   sucursales/{b}/resumen_diario/{fecha}        ventas y total del día (fecha operativa)
 *   sucursales/{b}/productos/{productUuid}       precio, costo y existencia de esa sucursal
 *   sucursales/{b}/precio_historial/{auto}       cambios de precio
 *   sucursales/{b}/comandos/{auto}               precio en varias sucursales (seq)
 *   sucursales/{b}/ncf_rangos/{rangoUuid}        rango NCF de esa sucursal (seq)
 *
 * Una lectura por cursor (`seq` > cursor) recupera todo lo que una sucursal se
 * perdió estando desconectada: no depende de escuchas en tiempo real.
 */

const crypto = require('crypto');
const {
  ErrorSucursales, ESTADOS, ACCIONES, autorizar, quien, aFecha, COL_LICENCIAS, SUB_SUCURSALES, SUB_HISTORIAL,
} = require('./sucursales');

const TIPOS_EVENTO = Object.freeze({
  VENTA: 'venta',
  PRODUCTO_SUCURSAL: 'producto_sucursal',
  PRODUCTO: 'producto',
  USUARIO: 'usuario',
  COMANDO_PRECIO: 'comando_precio',
  NCF_RANGO: 'ncf_rango',
});
const STREAMS = Object.freeze(['catalogo', 'usuarios', 'comandos', 'ncf']);
const TIPOS_NCF = Object.freeze([
  'B01', 'B02', 'B03', 'B04', 'B11', 'B12', 'B13', 'B14', 'B15', 'B16', 'B17',
  'E31', 'E32', 'E33', 'E34', 'E41', 'E43', 'E44', 'E45', 'E46', 'E47',
]);
const ESTADOS_NCF_SUCURSAL = Object.freeze(['en_espera', 'en_uso', 'agotado', 'rechazado', 'anulado']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EVENTOS = 200;
const MAX_ITEMS = 500;
const LIMITE_CAMBIOS = 500;
const NCF_MAXIMO = 99999999;
// El e-NCF lleva 10 dígitos, pero la tabla ncf_rangos_central del POS guarda
// los números en INT: hasta 2,147,483,647. La DGII no da números tan altos.
const ECF_MAXIMO = 2147483647;
const ZONA_RD_MS = 4 * 60 * 60 * 1000; // UTC-4 todo el año (sin horario de verano)

// Un evento que la central no acepta por sus datos: la sucursal lo marca
// "rechazado" y no lo reintenta sola (queda para revisión).
class ErrorEvento extends Error {
  constructor(mensaje, codigo) {
    super(mensaje);
    this.code = codigo;
  }
}

function texto(valor, max) {
  return String(valor == null ? '' : valor).trim().replace(/\s+/g, ' ').slice(0, max);
}

function numero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function entero(valor) {
  const n = Number(valor);
  return Number.isInteger(n) ? n : NaN;
}

function sha256(valor) {
  return crypto.createHash('sha256').update(String(valor), 'utf8').digest('hex');
}

function fechaRd(fecha) {
  return new Date(fecha.getTime() - ZONA_RD_MS).toISOString().slice(0, 10);
}

function exigirUuid(valor, que) {
  const v = String(valor || '').toLowerCase();
  if (!UUID.test(v)) throw new ErrorEvento(`${que} sin identificador válido.`, 'DATOS_INVALIDOS');
  return v;
}

function createSincronizacionCentral({ db, now = () => new Date(), randomUUID = () => crypto.randomUUID() }) {
  if (!db || typeof db.collection !== 'function') throw new Error('Se necesita una instancia de Firestore.');

  const licRef = (licenseId) => db.collection(COL_LICENCIAS).doc(String(licenseId));
  const sucRef = (licenseId, branchUuid) => licRef(licenseId).collection(SUB_SUCURSALES).doc(String(branchUuid));
  const contadorRef = (licenseId) => licRef(licenseId).collection('sync').doc('contador');
  const coleccionStream = (ctx, stream) => {
    if (stream === 'catalogo') return licRef(ctx.licenseId).collection('catalogo');
    if (stream === 'usuarios') return licRef(ctx.licenseId).collection('usuarios');
    if (stream === 'comandos') return sucRef(ctx.licenseId, ctx.branchUuid).collection('comandos');
    return sucRef(ctx.licenseId, ctx.branchUuid).collection('ncf_rangos');
  };

  // Reserva `n` números de la secuencia de la empresa dentro de la transacción.
  // Como todas las escrituras con seq leen y escriben este documento, Firestore
  // las serializa: un cursor nunca salta un cambio que todavía no se veía.
  async function reservarSeq(tx, licenseId) {
    const ref = contadorRef(licenseId);
    const snap = await tx.get(ref);
    let actual = Number(snap.exists ? snap.data().seq || 0 : 0);
    return {
      siguiente() { actual += 1; return actual; },
      guardar() { tx.set(ref, { seq: actual, actualizadoEn: now() }); },
    };
  }

  async function leerSucursalesDeEmpresa(tx, licenseId, uuids) {
    const unicos = [...new Set(uuids)];
    const snaps = await Promise.all(unicos.map((u) => tx.get(sucRef(licenseId, u))));
    const faltan = snaps.filter((s) => !s.exists).map((s) => s.id);
    if (faltan.length) throw new ErrorEvento(`Sucursal que no es de esta empresa: ${faltan.join(', ')}`, 'SUCURSAL_AJENA');
    return snaps;
  }

  function soloPrincipal(ctx, que) {
    if (!ctx.esPrincipal) {
      throw new ErrorEvento(`Solo la sucursal principal publica ${que} de la empresa.`, 'SOLO_PRINCIPAL');
    }
  }

  function listaSucursales(valor, { permitirTodas = false } = {}) {
    const lista = Array.isArray(valor) ? valor.map((v) => String(v || '').toLowerCase()) : [];
    if (permitirTodas && lista.includes('*')) return ['*'];
    for (const u of lista) if (!UUID.test(u)) throw new ErrorEvento('Lista de sucursales inválida.', 'DATOS_INVALIDOS');
    return [...new Set(lista)].slice(0, 200);
  }

  // ── Efectos de cada evento ────────────────────────────────────────────────
  // Cada uno hace TODAS sus lecturas y devuelve una función que escribe
  // (Firestore exige leer antes de escribir dentro de la transacción).

  async function efectoVenta(tx, ctx, ev) {
    const p = ev.payload || {};
    const uuid = exigirUuid(ev.entityUuid, 'Venta');
    const ref = sucRef(ctx.licenseId, ctx.branchUuid).collection('ventas').doc(uuid);
    const snap = await tx.get(ref);
    const previa = snap.exists ? snap.data() : null;

    const estado = texto(p.estado, 20) || 'pagada';
    const anulada = Boolean(p.anulada);
    const contada = estado === 'pagada' && !anulada;

    let base = previa;
    if (!base) {
      const fechaOperativa = FECHA.test(String(p.fechaOperativa || '')) ? p.fechaOperativa : String(p.fecha || '').slice(0, 10);
      if (!FECHA.test(fechaOperativa)) throw new ErrorEvento('Venta sin fecha válida.', 'DATOS_INVALIDOS');
      const items = (Array.isArray(p.items) ? p.items : []).slice(0, MAX_ITEMS).map((it) => ({
        productUuid: UUID.test(String(it?.productUuid || '')) ? String(it.productUuid).toLowerCase() : null,
        codigo: texto(it?.codigo, 60),
        nombre: texto(it?.nombre, 255),
        cantidad: numero(it?.cantidad),
        precio: numero(it?.precio),
        itbis: numero(it?.itbis),
        total: numero(it?.total),
      }));
      base = {
        uuid,
        factura: texto(p.factura, 40),
        fecha: texto(p.fecha, 30),
        fechaOperativa,
        subtotal: numero(p.subtotal),
        descuento: numero(p.descuento),
        itbis: numero(p.itbis),
        total: numero(p.total),
        metodoPago: texto(p.metodoPago, 20),
        ncf: texto(p.ncf, 19) || null,
        tipoNcf: texto(p.tipoNcf, 5) || null,
        cliente: texto(p.cliente, 160) || null,
        cajero: texto(p.cajero, 120) || null,
        items,
        recibidaEn: now(),
      };
    }

    let resumenRef = null;
    let resumen = null;
    if (Boolean(previa?.contada) !== contada) {
      resumenRef = sucRef(ctx.licenseId, ctx.branchUuid).collection('resumen_diario').doc(base.fechaOperativa);
      const r = await tx.get(resumenRef);
      resumen = r.exists ? r.data() : { ventas: 0, total: 0 };
    }

    return () => {
      tx.set(ref, { ...base, estado, anulada, contada, actualizadaEn: now() });
      if (resumenRef) {
        const signo = contada ? 1 : -1;
        tx.set(resumenRef, {
          fecha: base.fechaOperativa,
          ventas: Math.max(0, Number(resumen.ventas || 0) + signo),
          total: numero(Number(resumen.total || 0) + signo * Number(base.total || 0)),
          actualizadoEn: now(),
        });
      }
    };
  }

  async function efectoProductoSucursal(tx, ctx, ev) {
    const p = ev.payload || {};
    const productUuid = exigirUuid(ev.entityUuid, 'Producto');
    const ref = sucRef(ctx.licenseId, ctx.branchUuid).collection('productos').doc(productUuid);
    const snap = await tx.get(ref);
    const previo = snap.exists ? snap.data() : null;
    const marca = texto(p.marcaTiempo, 30) || now().toISOString();
    // Un reintento viejo no pisa un estado más nuevo de esa misma sucursal.
    if (previo && String(previo.marcaTiempo || '') > marca) return () => {};
    const precio = numero(p.precio);
    return () => {
      tx.set(ref, {
        productUuid,
        codigo: texto(p.codigo, 60),
        nombre: texto(p.nombre, 160),
        precio,
        costo: numero(p.costo),
        stock: numero(p.stock),
        estado: texto(p.estado, 20) || 'Activo',
        marcaTiempo: marca,
        actualizadoEn: now(),
      });
      if (previo && numero(previo.precio) !== precio) {
        tx.set(sucRef(ctx.licenseId, ctx.branchUuid).collection('precio_historial').doc(), {
          productUuid, codigo: texto(p.codigo, 60), nombre: texto(p.nombre, 160), antes: numero(previo.precio), despues: precio, at: now(),
        });
      }
    };
  }

  function datosProducto(p) {
    const codigo = texto(p.codigo, 40);
    const nombre = texto(p.nombre, 160);
    if (!codigo || !nombre) throw new ErrorEvento('Producto sin código o sin nombre.', 'DATOS_INVALIDOS');
    return {
      codigo,
      barcode: texto(p.barcode, 60) || codigo,
      nombre,
      categoria: texto(p.categoria, 60) || 'General',
      marca: texto(p.marca, 80) || null,
      unidad: texto(p.unidad, 40) || 'Unidad',
      saleMode: texto(p.saleMode, 20) || 'unidad',
      productType: texto(p.productType, 30) || 'general',
      aplicaItbis: Boolean(p.aplicaItbis),
      itbisModo: p.itbisModo === 'monto' ? 'monto' : 'porcentaje',
      itbisMonto: numero(p.itbisMonto),
      tracksStock: p.tracksStock !== false,
      estado: p.estado === 'Inactivo' ? 'Inactivo' : 'Activo',
      precioSugerido: numero(p.precioSugerido),
      costoSugerido: numero(p.costoSugerido),
    };
  }

  async function efectoProducto(tx, ctx, ev) {
    soloPrincipal(ctx, 'el catálogo');
    const uuid = exigirUuid(ev.entityUuid, 'Producto');
    const catalogo = licRef(ctx.licenseId).collection('catalogo');
    const ref = catalogo.doc(uuid);
    const snap = await tx.get(ref);
    const previo = snap.exists ? snap.data() : null;
    const seq = await reservarSeq(tx, ctx.licenseId);

    if (ev.operation === 'retirar') {
      if (!previo || previo.retirado) return () => {};
      return () => {
        tx.set(ref, { retirado: true, version: Number(previo.version || 0) + 1, seq: seq.siguiente(), actualizadoEn: now() }, { merge: true });
        seq.guardar();
      };
    }

    const p = ev.payload || {};
    const datos = datosProducto(p);
    const alcance = p.alcance === 'sucursales' ? 'sucursales' : 'global';
    const sucursales = alcance === 'sucursales' ? listaSucursales(p.sucursales) : [];
    if (alcance === 'sucursales' && !sucursales.length) throw new ErrorEvento('Elige al menos una sucursal para el producto.', 'DATOS_INVALIDOS');
    await leerSucursalesDeEmpresa(tx, ctx.licenseId, sucursales);

    // El código es único en la empresa (un producto retirado lo libera).
    const codigoRef = licRef(ctx.licenseId).collection('catalogo_codigos').doc(sha256(datos.codigo.toUpperCase()));
    const codigoSnap = await tx.get(codigoRef);
    const duenoCodigo = codigoSnap.exists ? codigoSnap.data().uuid : null;
    if (duenoCodigo && duenoCodigo !== uuid) {
      const otro = await tx.get(catalogo.doc(duenoCodigo));
      if (otro.exists && !otro.data().retirado) {
        throw new ErrorEvento(`El código ${datos.codigo} ya lo usa otro producto de la empresa (${otro.data().nombre}).`, 'CODIGO_DUPLICADO');
      }
    }
    const codigoViejoRef = previo && previo.codigo && previo.codigo.toUpperCase() !== datos.codigo.toUpperCase()
      ? licRef(ctx.licenseId).collection('catalogo_codigos').doc(sha256(previo.codigo.toUpperCase()))
      : null;

    return () => {
      tx.set(ref, {
        ...datos,
        uuid,
        alcance,
        sucursales,
        retirado: false,
        version: Number(previo?.version || 0) + 1,
        seq: seq.siguiente(),
        origenBranchUuid: ctx.branchUuid,
        creadoEn: previo?.creadoEn || now(),
        actualizadoEn: now(),
      });
      tx.set(codigoRef, { uuid, codigo: datos.codigo });
      if (codigoViejoRef) tx.delete(codigoViejoRef);
      seq.guardar();
    };
  }

  async function efectoUsuario(tx, ctx, ev) {
    soloPrincipal(ctx, 'los usuarios');
    const uuid = exigirUuid(ev.entityUuid, 'Usuario');
    const usuarios = licRef(ctx.licenseId).collection('usuarios');
    const ref = usuarios.doc(uuid);
    const snap = await tx.get(ref);
    const previo = snap.exists ? snap.data() : null;
    const seq = await reservarSeq(tx, ctx.licenseId);

    if (ev.operation === 'retirar') {
      if (!previo || previo.retirado) return () => {};
      return () => {
        tx.set(ref, { retirado: true, version: Number(previo.version || 0) + 1, seq: seq.siguiente(), actualizadoEn: now() }, { merge: true });
        seq.guardar();
      };
    }

    const p = ev.payload || {};
    const usuario = texto(p.usuario, 60);
    const nombre = texto(p.nombre, 120);
    const passwordHash = String(p.passwordHash || '');
    if (!usuario || !nombre) throw new ErrorEvento('Usuario sin nombre de acceso o sin nombre.', 'DATOS_INVALIDOS');
    // Solo la huella scrypt de la clave; nunca la clave.
    if (!/^[a-z0-9_-]+:[0-9a-f]{16,}:[0-9a-f]{32,}$/i.test(passwordHash)) {
      throw new ErrorEvento(`El usuario ${usuario} no tiene una clave protegida para enviar.`, 'SIN_CLAVE_PROTEGIDA');
    }
    const sucursales = listaSucursales(p.sucursales, { permitirTodas: true });
    if (!sucursales.length) throw new ErrorEvento('Elige al menos una sucursal para el usuario.', 'DATOS_INVALIDOS');
    if (sucursales[0] !== '*') await leerSucursalesDeEmpresa(tx, ctx.licenseId, sucursales);

    const nombreRef = licRef(ctx.licenseId).collection('usuarios_nombres').doc(sha256(usuario.toLowerCase()));
    const nombreSnap = await tx.get(nombreRef);
    const dueno = nombreSnap.exists ? nombreSnap.data().uuid : null;
    if (dueno && dueno !== uuid) {
      const otro = await tx.get(usuarios.doc(dueno));
      if (otro.exists && !otro.data().retirado) {
        throw new ErrorEvento(`El usuario ${usuario} ya existe en la empresa.`, 'USUARIO_DUPLICADO');
      }
    }
    const nombreViejoRef = previo && previo.usuario && previo.usuario.toLowerCase() !== usuario.toLowerCase()
      ? licRef(ctx.licenseId).collection('usuarios_nombres').doc(sha256(previo.usuario.toLowerCase()))
      : null;

    return () => {
      tx.set(ref, {
        uuid,
        usuario,
        nombre,
        email: texto(p.email, 160) || null,
        roleCode: texto(p.roleCode, 60) || 'cajero',
        rol: texto(p.rol, 40) || 'Cajero',
        tipoFacturacion: texto(p.tipoFacturacion, 20) || null,
        passwordHash,
        estado: p.estado === 'Inactivo' ? 'Inactivo' : 'Activo',
        sucursales,
        retirado: false,
        version: Number(previo?.version || 0) + 1,
        seq: seq.siguiente(),
        origenBranchUuid: ctx.branchUuid,
        creadoEn: previo?.creadoEn || now(),
        actualizadoEn: now(),
      });
      tx.set(nombreRef, { uuid });
      if (nombreViejoRef) tx.delete(nombreViejoRef);
      seq.guardar();
    };
  }

  // Cambio de precio explícito en varias sucursales (acción del dueño en la
  // principal). Es la ÚNICA vía por la que la central toca un precio local.
  async function efectoComandoPrecio(tx, ctx, ev) {
    soloPrincipal(ctx, 'cambios de precio');
    const p = ev.payload || {};
    const productUuid = exigirUuid(p.productUuid, 'Producto');
    const precio = numero(p.precio);
    if (!(precio > 0)) throw new ErrorEvento('El precio debe ser mayor que cero.', 'DATOS_INVALIDOS');
    const sucursales = listaSucursales(p.sucursales);
    if (!sucursales.length) throw new ErrorEvento('Elige al menos una sucursal.', 'DATOS_INVALIDOS');
    const producto = await tx.get(licRef(ctx.licenseId).collection('catalogo').doc(productUuid));
    if (!producto.exists || producto.data().retirado) {
      throw new ErrorEvento('Ese producto no está en el catálogo de la empresa.', 'NO_ENCONTRADO');
    }
    await leerSucursalesDeEmpresa(tx, ctx.licenseId, sucursales);
    const seq = await reservarSeq(tx, ctx.licenseId);
    return () => {
      for (const destino of sucursales) {
        tx.set(sucRef(ctx.licenseId, destino).collection('comandos').doc(), {
          tipo: 'precio',
          productUuid,
          codigo: producto.data().codigo,
          nombre: producto.data().nombre,
          precio,
          seq: seq.siguiente(),
          origenBranchUuid: ctx.branchUuid,
          at: now(),
        });
      }
      seq.guardar();
      tx.set(licRef(ctx.licenseId).collection(SUB_HISTORIAL).doc(), {
        accion: 'precio_varias_sucursales',
        actor: { tipo: 'equipo', uid: ctx.equipoId || null, nombre: ctx.hostname || '' },
        detalle: { productUuid, codigo: producto.data().codigo, precio, sucursales },
        at: now(),
      });
    };
  }

  // Una sucursal que ya facturaba antes de enlazarse avisa los rangos que
  // tenía cargados (operation 'reportar'). Quedan a su nombre, igual que uno
  // asignado desde el panel, para que la central no le dé esos números a otra
  // sucursal. Si chocan con un rango de otra sucursal se rechaza: hay que
  // revisarlo a mano (dos sucursales pudieron emitir el mismo número).
  async function efectoNcfRangoReportado(tx, ctx, ev) {
    const p = ev.payload || {};
    const rangoUuid = exigirUuid(p.rangoUuid || ev.entityUuid, 'Rango NCF');
    const tipo = texto(p.tipo, 5).toUpperCase();
    const desde = entero(p.desde);
    const hasta = entero(p.hasta);
    const vence = texto(p.vence, 10);
    if (!TIPOS_NCF.includes(tipo)) throw new ErrorEvento('Tipo de comprobante inválido.', 'DATOS_INVALIDOS');
    const maximo = tipo.startsWith('E') ? ECF_MAXIMO : NCF_MAXIMO;
    if (!Number.isInteger(desde) || !Number.isInteger(hasta) || desde < 1 || hasta < desde || hasta > maximo) {
      throw new ErrorEvento('Rango inválido.', 'DATOS_INVALIDOS');
    }
    if (vence && !FECHA.test(vence)) throw new ErrorEvento('Fecha de vencimiento inválida.', 'DATOS_INVALIDOS');
    if (!['en_uso', 'agotado'].includes(p.estado)) throw new ErrorEvento('Estado de rango NCF inválido.', 'DATOS_INVALIDOS');
    const ref = sucRef(ctx.licenseId, ctx.branchUuid).collection('ncf_rangos').doc(rangoUuid);
    const tipoRef = licRef(ctx.licenseId).collection('ncf_tipos').doc(tipo);
    const [snap, tipoSnap] = await Promise.all([tx.get(ref), tx.get(tipoRef)]);
    const siguiente = entero(p.siguiente);
    if (snap.exists) {
      return () => tx.set(ref, {
        estadoSucursal: p.estado, ...(Number.isInteger(siguiente) ? { siguiente } : {}), actualizadoSucursalEn: now(),
      }, { merge: true });
    }
    const dados = tipoSnap.exists ? tipoSnap.data().rangos || [] : [];
    const choque = dados.find((r) => desde <= r.hasta && hasta >= r.desde);
    if (choque) {
      throw new ErrorEvento(
        `Los ${tipo} ${desde}–${hasta} que esta sucursal ya tenía chocan con el rango ${choque.desde}–${choque.hasta} de otra sucursal. Revísalo con tu contador.`,
        'RANGO_SOLAPADO'
      );
    }
    const seq = await reservarSeq(tx, ctx.licenseId);
    return () => {
      tx.set(ref, {
        tipo, desde, hasta, vence: vence || null, autorizacion: texto(p.autorizacion, 60) || null,
        estado: 'asignado', origen: 'sucursal', estadoSucursal: p.estado,
        ...(Number.isInteger(siguiente) ? { siguiente } : {}),
        seq: seq.siguiente(),
        creadoPor: { tipo: 'equipo', uid: ctx.equipoId || null, nombre: ctx.hostname || '' },
        creadoEn: now(),
      });
      tx.set(tipoRef, { rangos: [...dados, { rangoUuid, branchUuid: ctx.branchUuid, desde, hasta, anulado: false }] });
      seq.guardar();
      tx.set(licRef(ctx.licenseId).collection(SUB_HISTORIAL).doc(), {
        accion: 'ncf_reportado',
        actor: { tipo: 'equipo', uid: ctx.equipoId || null, nombre: ctx.hostname || '' },
        detalle: { branchUuid: ctx.branchUuid, rangoUuid, tipo, desde, hasta },
        at: now(),
      });
    };
  }

  async function efectoNcfRango(tx, ctx, ev) {
    if (ev.operation === 'reportar') return efectoNcfRangoReportado(tx, ctx, ev);
    const p = ev.payload || {};
    const rangoUuid = exigirUuid(p.rangoUuid || ev.entityUuid, 'Rango NCF');
    if (!ESTADOS_NCF_SUCURSAL.includes(p.estado)) throw new ErrorEvento('Estado de rango NCF inválido.', 'DATOS_INVALIDOS');
    const ref = sucRef(ctx.licenseId, ctx.branchUuid).collection('ncf_rangos').doc(rangoUuid);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ErrorEvento('Ese rango NCF no es de esta sucursal.', 'NO_ENCONTRADO');
    const siguiente = entero(p.siguiente);
    return () => {
      tx.set(ref, {
        estadoSucursal: p.estado,
        ...(Number.isInteger(siguiente) ? { siguiente } : {}),
        motivoSucursal: texto(p.motivo, 255) || null,
        actualizadoSucursalEn: now(),
      }, { merge: true });
    };
  }

  const EFECTOS = {
    [TIPOS_EVENTO.VENTA]: efectoVenta,
    [TIPOS_EVENTO.PRODUCTO_SUCURSAL]: efectoProductoSucursal,
    [TIPOS_EVENTO.PRODUCTO]: efectoProducto,
    [TIPOS_EVENTO.USUARIO]: efectoUsuario,
    [TIPOS_EVENTO.COMANDO_PRECIO]: efectoComandoPrecio,
    [TIPOS_EVENTO.NCF_RANGO]: efectoNcfRango,
  };

  // ctx = { licenseId, branchUuid, esPrincipal, equipoId, hostname }: lo pone
  // la Sync API a partir del token, NUNCA de lo que diga el evento.
  async function procesarEvento(ctx, ev) {
    const eventId = String(ev?.eventId || '').toLowerCase();
    if (!UUID.test(eventId)) return { eventId: ev?.eventId || null, resultado: 'rechazado', code: 'DATOS_INVALIDOS', motivo: 'Evento sin event_id válido.' };
    const efecto = EFECTOS[ev.entityType];
    if (!efecto) return { eventId, resultado: 'rechazado', code: 'TIPO_DESCONOCIDO', motivo: `Tipo de evento desconocido: ${ev.entityType}` };
    const recibido = sucRef(ctx.licenseId, ctx.branchUuid).collection('eventos_recibidos').doc(eventId);
    try {
      return await db.runTransaction(async (tx) => {
        if ((await tx.get(recibido)).exists) return { eventId, resultado: 'duplicado' };
        const escribir = await efecto(tx, ctx, ev);
        escribir();
        tx.set(recibido, {
          tipo: ev.entityType, entidad: String(ev.entityUuid || ''), operacion: String(ev.operation || ''), at: now(),
        });
        return { eventId, resultado: 'ok' };
      });
    } catch (error) {
      if (error instanceof ErrorEvento) return { eventId, resultado: 'rechazado', code: error.code, motivo: error.message };
      throw error;
    }
  }

  // Uno por uno y en orden: dos eventos de la misma entidad se aplican como
  // ocurrieron en la sucursal.
  async function procesarEventos(ctx, eventos) {
    const lista = Array.isArray(eventos) ? eventos.slice(0, MAX_EVENTOS) : [];
    const resultados = [];
    for (const ev of lista) resultados.push(await procesarEvento(ctx, ev));
    return resultados;
  }

  function vistaCambio(stream, ctx, snap) {
    const d = snap.data();
    const seq = Number(d.seq || 0);
    if (stream === 'catalogo' || stream === 'usuarios') {
      const lista = d.sucursales || [];
      const asignado = !d.retirado && (
        stream === 'catalogo'
          ? d.alcance === 'global' || lista.includes(ctx.branchUuid)
          : lista.includes('*') || lista.includes(ctx.branchUuid)
      );
      if (!asignado) return { uuid: snap.id, seq, version: Number(d.version || 0), asignado: false };
      const { seq: _s, creadoEn: _c, actualizadoEn: _a, retirado: _r, origenBranchUuid, ...datos } = d;
      return { uuid: snap.id, seq, version: Number(d.version || 0), asignado: true, origenBranchUuid, datos };
    }
    if (stream === 'comandos') {
      return { id: snap.id, seq, tipo: d.tipo, productUuid: d.productUuid, codigo: d.codigo, precio: d.precio };
    }
    return {
      rangoUuid: snap.id, seq, tipo: d.tipo, desde: d.desde, hasta: d.hasta, vence: d.vence || null,
      autorizacion: d.autorizacion || null, estado: d.estado,
    };
  }

  // Lo que cambió para esta sucursal desde el cursor, en páginas. La primera
  // página dice cuántos faltan en total (para la barra de progreso).
  async function cambios(ctx, stream, desde = 0, limite = 200, { contar = false } = {}) {
    if (!STREAMS.includes(stream)) throw new ErrorSucursales('Tipo de cambios desconocido.', 'DATOS_INVALIDOS', 400);
    const cursor = Math.max(0, Number(desde) || 0);
    const max = Math.max(1, Math.min(LIMITE_CAMBIOS, Number(limite) || 200));
    const base = coleccionStream(ctx, stream).where('seq', '>', cursor);
    // count() existe desde firebase-admin 11; con versiones viejas (el portal
    // del contador usa la 10) se cuentan los documentos sin traer sus datos.
    const contarPendientes = () => (typeof base.count === 'function'
      ? base.count().get().then((r) => r.data().count)
      : base.select().get().then((s) => s.size));
    const [snap, total] = await Promise.all([
      base.orderBy('seq').limit(max).get(),
      contar ? contarPendientes() : Promise.resolve(null),
    ]);
    const items = snap.docs.map((d) => vistaCambio(stream, ctx, d));
    return {
      stream,
      items,
      siguiente: items.length ? items[items.length - 1].seq : cursor,
      hayMas: items.length === max,
      ...(total == null ? {} : { pendientes: total }),
    };
  }

  // Del latido: hasta qué número va cada rango en uso (para el panel).
  async function registrarUsoNcf(ctx, lista) {
    const usos = (Array.isArray(lista) ? lista : []).slice(0, 50)
      .filter((u) => UUID.test(String(u?.rangoUuid || '')) && Number.isInteger(Number(u.siguiente)));
    if (!usos.length) return 0;
    const refs = usos.map((u) => sucRef(ctx.licenseId, ctx.branchUuid).collection('ncf_rangos').doc(String(u.rangoUuid).toLowerCase()));
    // Solo rangos que existen y son de esta sucursal (set con merge crearía uno).
    const existentes = await Promise.all(refs.map((ref) => ref.get()));
    const batch = db.batch();
    let n = 0;
    existentes.forEach((snap, i) => {
      if (!snap.exists) return;
      batch.set(refs[i], { siguiente: Number(usos[i].siguiente), usoReportadoEn: now() }, { merge: true });
      n += 1;
    });
    if (n) await batch.commit();
    return n;
  }

  // ── Panel de Emilio y portal del contador ─────────────────────────────────

  async function leerLicencia(tx, licenseId) {
    const snap = await tx.get(licRef(licenseId));
    if (!snap.exists || snap.data().deleted) throw new ErrorSucursales('Empresa no encontrada.', 'NO_ENCONTRADA', 404);
    return snap.data();
  }

  function vistaRango(branchUuid, snap) {
    const d = snap.data();
    const total = Number(d.hasta) - Number(d.desde) + 1;
    const siguiente = Number.isInteger(d.siguiente) ? d.siguiente : null;
    return {
      rangoUuid: snap.id,
      branchUuid,
      tipo: d.tipo,
      desde: d.desde,
      hasta: d.hasta,
      vence: d.vence || null,
      autorizacion: d.autorizacion || null,
      estado: d.estado,
      // 'sucursal': lo tenía la PC antes de enlazarse y lo avisó; 'central': del panel.
      origen: d.origen || 'central',
      estadoSucursal: d.estadoSucursal || null,
      motivoSucursal: d.motivoSucursal || null,
      siguiente,
      disponibles: siguiente == null ? total : Math.max(0, Number(d.hasta) - siguiente + 1),
      total,
      creadoPor: d.creadoPor || null,
      creadoEn: aFecha(d.creadoEn)?.toISOString() || null,
    };
  }

  // Asigna a una sucursal un sub-rango de la autorización de la DGII. Ningún
  // número puede estar en otro rango de la empresa (de ninguna sucursal, ni
  // anulado): así dos sucursales desconectadas nunca emiten el mismo NCF.
  async function asignarRangoNcf(licenseId, branchUuid, datos, actor) {
    return db.runTransaction(async (tx) => {
      const lic = await leerLicencia(tx, licenseId);
      autorizar(actor, ACCIONES.ASIGNAR_NCF, licenseId, lic);
      const tipo = texto(datos?.tipo, 5).toUpperCase();
      const desde = entero(datos?.desde);
      const hasta = entero(datos?.hasta);
      const vence = texto(datos?.vence, 10);
      if (!TIPOS_NCF.includes(tipo)) throw new ErrorSucursales('Tipo de comprobante inválido (B01, B02… o E31, E32…).', 'DATOS_INVALIDOS');
      const maximo = tipo.startsWith('E') ? ECF_MAXIMO : NCF_MAXIMO;
      if (!Number.isInteger(desde) || !Number.isInteger(hasta) || desde < 1 || hasta < desde || hasta > maximo) {
        throw new ErrorSucursales(`El rango debe ir de un número a otro mayor o igual (1 a ${maximo}).`, 'DATOS_INVALIDOS');
      }
      if (vence && !FECHA.test(vence)) throw new ErrorSucursales('La fecha de vencimiento va como AAAA-MM-DD.', 'DATOS_INVALIDOS');
      const suc = await tx.get(sucRef(licenseId, branchUuid));
      if (!suc.exists) throw new ErrorSucursales('Sucursal no encontrada.', 'NO_ENCONTRADA', 404);
      if (suc.data().estado !== ESTADOS.ACTIVA) throw new ErrorSucursales('La sucursal está desactivada.', 'SUCURSAL_INACTIVA', 409);

      const tipoRef = licRef(licenseId).collection('ncf_tipos').doc(tipo);
      const tipoSnap = await tx.get(tipoRef);
      const dados = tipoSnap.exists ? tipoSnap.data().rangos || [] : [];
      const choque = dados.find((r) => desde <= r.hasta && hasta >= r.desde);
      if (choque) {
        throw new ErrorSucursales(
          `Esos números chocan con el rango ${tipo} ${choque.desde}–${choque.hasta} ya asignado${choque.anulado ? ' (anulado: sus números no se reutilizan)' : ''}.`,
          'RANGO_SOLAPADO', 409
        );
      }
      const seq = await reservarSeq(tx, licenseId);
      const rangoUuid = randomUUID();
      const doc = {
        tipo, desde, hasta, vence: vence || null, autorizacion: texto(datos?.autorizacion, 60) || null,
        estado: 'asignado', seq: seq.siguiente(), creadoPor: quien(actor), creadoEn: now(),
      };
      tx.set(sucRef(licenseId, branchUuid).collection('ncf_rangos').doc(rangoUuid), doc);
      tx.set(tipoRef, { rangos: [...dados, { rangoUuid, branchUuid, desde, hasta, anulado: false }] });
      seq.guardar();
      tx.set(licRef(licenseId).collection(SUB_HISTORIAL).doc(), {
        accion: 'ncf_asignado', actor: quien(actor), detalle: { branchUuid, rangoUuid, tipo, desde, hasta }, at: now(),
      });
      return { rangoUuid, ...doc, creadoEn: now().toISOString() };
    });
  }

  // Anular un rango que la sucursal todavía no empezó a usar. Sus números
  // quedan reservados (no se vuelven a dar).
  async function anularRangoNcf(licenseId, branchUuid, rangoUuid, actor) {
    return db.runTransaction(async (tx) => {
      const lic = await leerLicencia(tx, licenseId);
      autorizar(actor, ACCIONES.ASIGNAR_NCF, licenseId, lic);
      const ref = sucRef(licenseId, branchUuid).collection('ncf_rangos').doc(String(rangoUuid));
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ErrorSucursales('Rango no encontrado.', 'NO_ENCONTRADO', 404);
      const d = snap.data();
      if (d.estado === 'anulado') return { rangoUuid: snap.id, estado: 'anulado' };
      if (['en_uso', 'agotado'].includes(d.estadoSucursal)) {
        throw new ErrorSucursales('La sucursal ya está usando ese rango; no se puede anular.', 'RANGO_EN_USO', 409);
      }
      const tipoRef = licRef(licenseId).collection('ncf_tipos').doc(d.tipo);
      const tipoSnap = await tx.get(tipoRef);
      const seq = await reservarSeq(tx, licenseId);
      tx.set(ref, { estado: 'anulado', seq: seq.siguiente(), anuladoPor: quien(actor), anuladoEn: now() }, { merge: true });
      tx.set(tipoRef, { rangos: (tipoSnap.data()?.rangos || []).map((r) => (r.rangoUuid === snap.id ? { ...r, anulado: true } : r)) });
      seq.guardar();
      tx.set(licRef(licenseId).collection(SUB_HISTORIAL).doc(), {
        accion: 'ncf_anulado', actor: quien(actor), detalle: { branchUuid, rangoUuid: snap.id, tipo: d.tipo, desde: d.desde, hasta: d.hasta }, at: now(),
      });
      return { rangoUuid: snap.id, estado: 'anulado' };
    });
  }

  async function listarSucursales(licenseId) {
    const snap = await licRef(licenseId).collection(SUB_SUCURSALES).get();
    return snap.docs
      .map((d) => ({ branchUuid: d.id, nombre: d.data().nombre, estado: d.data().estado, esPrincipal: Boolean(d.data().esPrincipal) }))
      .sort((a, b) => Number(b.esPrincipal) - Number(a.esPrincipal) || String(a.nombre).localeCompare(String(b.nombre), 'es'));
  }

  async function listarRangosNcf(licenseId, actor) {
    const lic = await leerLicencia({ get: (ref) => ref.get() }, licenseId);
    autorizar(actor, ACCIONES.VER, licenseId, lic);
    const sucursales = await listarSucursales(licenseId);
    const porSucursal = await Promise.all(sucursales.map(async (s) => {
      const snap = await sucRef(licenseId, s.branchUuid).collection('ncf_rangos').get();
      return snap.docs.map((d) => ({ ...vistaRango(s.branchUuid, d), sucursal: s.nombre }));
    }));
    return porSucursal.flat().sort((a, b) => a.tipo.localeCompare(b.tipo) || a.desde - b.desde);
  }

  // Ventas por sucursal (hoy, ayer y los últimos 30 días), con lo que ya
  // llegó a la central. La sucursal que tiene eventos sin subir lo dice en su
  // latido (pendientes) y el panel lo muestra junto a estas cifras.
  async function resumenOperacion(licenseId, actor, { dias = 30 } = {}) {
    const lic = await leerLicencia({ get: (ref) => ref.get() }, licenseId);
    autorizar(actor, ACCIONES.VER, licenseId, lic);
    const hoy = fechaRd(now());
    const ayer = fechaRd(new Date(now().getTime() - 86400000));
    const desde = fechaRd(new Date(now().getTime() - Math.max(1, Math.min(366, dias)) * 86400000));
    const sucursales = await listarSucursales(licenseId);
    const filas = await Promise.all(sucursales.map(async (s) => {
      const snap = await sucRef(licenseId, s.branchUuid).collection('resumen_diario').where('fecha', '>=', desde).get();
      const porDia = snap.docs.map((d) => ({ fecha: d.data().fecha, ventas: Number(d.data().ventas || 0), total: numero(d.data().total) }));
      const de = (f) => porDia.find((d) => d.fecha === f) || { fecha: f, ventas: 0, total: 0 };
      return {
        ...s,
        hoy: de(hoy),
        ayer: de(ayer),
        periodo: {
          desde,
          ventas: porDia.reduce((a, d) => a + d.ventas, 0),
          total: numero(porDia.reduce((a, d) => a + d.total, 0)),
        },
        dias: porDia.sort((a, b) => a.fecha.localeCompare(b.fecha)),
      };
    }));
    return {
      hoy,
      sucursales: filas,
      total: {
        hoy: numero(filas.reduce((a, f) => a + f.hoy.total, 0)),
        periodo: numero(filas.reduce((a, f) => a + f.periodo.total, 0)),
      },
    };
  }

  return {
    procesarEvento,
    procesarEventos,
    cambios,
    registrarUsoNcf,
    asignarRangoNcf,
    anularRangoNcf,
    listarRangosNcf,
    resumenOperacion,
  };
}

module.exports = {
  createSincronizacionCentral,
  ErrorEvento,
  TIPOS_EVENTO,
  STREAMS,
  TIPOS_NCF,
  MAX_EVENTOS,
  LIMITE_CAMBIOS,
};

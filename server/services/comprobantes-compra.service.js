'use strict';

// Comprobantes fiscales que el negocio emite por sus compras y gastos: E41
// (compras a quien no da comprobante), E43 (gastos menores) y E47 (pagos al
// exterior). Cada uno tiene su propio registro y estado, separado de la compra o
// el gasto, para no confundir «compra registrada» con «comprobante aceptado».
//
// Estados:
//   pendiente_aprobacion → (aprobar) autorizado → en_envio → en_proceso
//                                                         ↘ aceptado | aceptado_condicional | rechazado
//   pendiente_aprobacion → (no aprobar) anulado;  rechazado/autorizado → (anular) anulado
// - «en_envio»: firmado y saliendo (o esperando Internet para salir).
// - «en_proceso»: la DGII lo recibió (hay TrackID) y aún no responde. Un TrackID
//   no es una aceptación.
// - El e-NCF se escribe en la compra o el gasto solo cuando la DGII lo acepta;
//   uno rechazado nunca queda como comprobante de la compra.
//
// Modalidad (Configuración de compras, por empresa):
// - «directa» (como siempre): sale al registrar.
// - «aprobacion»: sale solo cuando lo aprueba el administrador general o quien
//   tenga el permiso «comprobantes_compra.aprobar». Lo que pide alguien con ese
//   permiso sale enseguida (aprobado por él mismo).
//
// Idempotencia: una sola solicitud activa por compra o gasto (índice único en
// activo_clave) y el envío usa el origen «purchase:<id>» / «expense:<id>» que el
// módulo e-CF ya usa para no firmar ni enviar dos veces el mismo comprobante.

const crypto = require('crypto');

const TIPOS = {
  E41: 'Comprobante de compras',
  E43: 'Gastos menores',
  E47: 'Pagos al exterior',
};
const ESTADOS = {
  pendiente_aprobacion: 'Pendiente de aprobación',
  autorizado: 'Autorizado',
  en_envio: 'Firmado, enviándose',
  en_proceso: 'En proceso en la DGII',
  aceptado: 'Aceptado',
  aceptado_condicional: 'Aceptado condicional',
  rechazado: 'Rechazado',
  anulado: 'Anulado',
};
const ABIERTOS = ['en_envio', 'en_proceso'];
const MODALIDADES = ['directa', 'aprobacion'];
const ORIGENES = { compra: 'purchase', gasto: 'expense' };

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const afectadas = (r) => Number(r?.affectedRows ?? r?.rowsAffected ?? r?.changes ?? 0);
const nombreDe = (a) => a?.nombre || a?.usuario || 'Sistema';
const json = (v, def) => { try { return v ? JSON.parse(v) : def; } catch (_) { return def; } };

// Estado del módulo e-CF → estado del comprobante.
function estadoDesdeEcf(estadoDgii, conTrack) {
  const e = String(estadoDgii || '').toLowerCase();
  if (e === 'aceptado' || e === 'aceptado_condicional') return e;
  if (e === 'rechazado' || e === 'bloqueado') return 'rechazado';
  if (['enviado', 'en_proceso', 'procesando'].includes(e)) return 'en_proceso';
  if (['error_consulta', 'error_auth'].includes(e)) return conTrack ? 'en_proceso' : 'autorizado';
  if (['firmado', 'pendiente', 'diferido', 'contingencia'].includes(e)) return 'en_envio';
  if (e === 'error') return 'autorizado';
  return conTrack ? 'en_proceso' : 'en_envio';
}

// Reparte un monto (en centavos exactos) entre líneas según su peso.
function repartir(monto, pesos) {
  const total = Math.round(Number(monto || 0) * 100);
  const suma = pesos.reduce((t, p) => t + Math.max(0, p), 0);
  if (!total || !suma) return pesos.map(() => 0);
  let resto = total;
  const partes = pesos.map((p, i) => {
    if (i === pesos.length - 1) return resto;
    const parte = Math.floor((total * Math.max(0, p)) / suma);
    resto -= parte;
    return parte;
  });
  return partes.map((c) => c / 100);
}

function crearServicioComprobantesCompra({
  query,
  emitir,                      // (args) => emitirEcfDeOperacion(args): { ok, encf, estado, documentId, trackId, error }
  revisar = async () => ({ ok: true, errores: [] }), // (args) => previewStandaloneDocument(args)
  consultarEstado = null,       // (documentId) => queryDocumentStatus(documentId)
  constructores = null,         // crearConstructoresComprobante({ query }): datos desde la compra o el gasto
  sinInternet = () => false,
  writeAuditLog = async () => {},
  ahora = () => new Date().toISOString().slice(0, 19).replace('T', ' '),
}) {
  let esquema = null;
  function ensureSchema() {
    if (!esquema) {
      esquema = (async () => {
        await query(`
          CREATE TABLE IF NOT EXISTS comprobantes_compra (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid VARCHAR(40) NOT NULL,
            origen VARCHAR(40) NOT NULL,
            activo_clave VARCHAR(40) DEFAULT NULL,
            tipo_ecf VARCHAR(5) NOT NULL,
            branch_id INT DEFAULT NULL,
            estado VARCHAR(30) NOT NULL,
            beneficiario VARCHAR(160) DEFAULT NULL,
            rnc VARCHAR(20) DEFAULT NULL,
            monto_total DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            datos TEXT,
            validacion TEXT,
            solicitado_por_id INT DEFAULT NULL,
            solicitado_por VARCHAR(120) DEFAULT NULL,
            solicitado_at DATETIME DEFAULT NULL,
            aprobado_por_id INT DEFAULT NULL,
            aprobado_por VARCHAR(120) DEFAULT NULL,
            aprobado_at DATETIME DEFAULT NULL,
            aprobacion VARCHAR(20) DEFAULT NULL,
            motivo VARCHAR(255) DEFAULT NULL,
            ecf_document_id INT DEFAULT NULL,
            encf VARCHAR(20) DEFAULT NULL,
            track_id VARCHAR(120) DEFAULT NULL,
            mensaje VARCHAR(500) DEFAULT NULL,
            intentos INT NOT NULL DEFAULT 0,
            enviado_at DATETIME DEFAULT NULL,
            resuelto_at DATETIME DEFAULT NULL,
            consultado_at DATETIME DEFAULT NULL,
            version INT NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT NULL,
            updated_at DATETIME DEFAULT NULL
          )
        `);
        await query(`
          CREATE TABLE IF NOT EXISTS comprobantes_compra_eventos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            comprobante_id INT NOT NULL,
            accion VARCHAR(60) NOT NULL,
            estado_antes VARCHAR(30) DEFAULT NULL,
            estado_despues VARCHAR(30) DEFAULT NULL,
            usuario_id INT DEFAULT NULL,
            usuario VARCHAR(120) DEFAULT NULL,
            detalle TEXT,
            created_at DATETIME DEFAULT NULL
          )
        `);
        for (const sql of [
          'CREATE UNIQUE INDEX ux_comprobantes_compra_uuid ON comprobantes_compra (uuid)',
          'CREATE UNIQUE INDEX ux_comprobantes_compra_activo ON comprobantes_compra (activo_clave)',
          'CREATE INDEX ix_comprobantes_compra_estado ON comprobantes_compra (estado)',
          'CREATE INDEX ix_comprobantes_compra_eventos ON comprobantes_compra_eventos (comprobante_id)',
        ]) {
          try { await query(sql); } catch (error) {
            const m = String(error?.message || '').toLowerCase();
            if (!m.includes('exist') && !m.includes('duplicate')) throw error;
          }
        }
        try { await query("ALTER TABLE config ADD COLUMN comprobantes_compra_modalidad VARCHAR(20) DEFAULT 'directa'"); } catch (error) {
          const m = String(error?.message || '').toLowerCase();
          if (!m.includes('duplicate') && !m.includes('exist')) throw error;
        }
      })().catch((e) => { esquema = null; throw e; });
    }
    return esquema;
  }

  async function leerModalidad() {
    await ensureSchema();
    const [fila] = await query('SELECT comprobantes_compra_modalidad AS m FROM config LIMIT 1').catch(() => []);
    return MODALIDADES.includes(fila?.m) ? fila.m : 'directa';
  }

  async function guardarModalidad(modalidad, actor) {
    if (!MODALIDADES.includes(modalidad)) throw fail('Modalidad inválida: directa o aprobacion.');
    await ensureSchema();
    const antes = await leerModalidad();
    await query('UPDATE config SET comprobantes_compra_modalidad = ?', [modalidad]);
    await Promise.resolve(writeAuditLog({
      userId: actor?.id, userName: nombreDe(actor), userRole: String(actor?.role_code || actor?.rol || ''),
      moduleName: 'Compras', actionName: 'Modalidad de comprobantes de compra',
      before: { modalidad: antes }, after: { modalidad },
      detail: modalidad === 'aprobacion' ? 'E41, E43 y E47 salen solo con aprobación' : 'E41, E43 y E47 salen al registrar',
    })).catch(() => {});
    return modalidad;
  }

  async function fila(id) {
    const [f] = await query('SELECT * FROM comprobantes_compra WHERE id = ? LIMIT 1', [Number(id)]);
    if (!f) throw fail('Comprobante no encontrado.', 404);
    return f;
  }

  async function evento(comprobanteId, accion, antes, despues, actor, detalle) {
    await query(
      `INSERT INTO comprobantes_compra_eventos (comprobante_id, accion, estado_antes, estado_despues, usuario_id, usuario, detalle, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [comprobanteId, accion, antes || null, despues || null, actor?.id || null, actor ? nombreDe(actor) : 'Sistema',
        detalle === undefined || detalle === null ? null : (typeof detalle === 'string' ? detalle : JSON.stringify(detalle)), ahora()]
    ).catch(() => {});
  }

  // Cambio de estado solo si nadie lo cambió antes (versión): dos cajas no envían dos veces.
  async function mover(c, desde, cambios, actor, accion, detalle) {
    const sets = Object.keys(cambios);
    const r = await query(
      `UPDATE comprobantes_compra SET ${sets.map((k) => `${k} = ?`).join(', ')}, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND estado IN (${desde.map(() => '?').join(', ')})`,
      [...sets.map((k) => cambios[k]), ahora(), c.id, c.version, ...desde]
    );
    // La versión siempre cambia, así que una fila tocada cuenta 1 en MariaDB y en SQLite.
    if (afectadas(r) !== 1) throw fail('Este comprobante cambió en otra caja. Recarga la lista.', 409);
    const despues = await fila(c.id);
    await evento(c.id, accion, c.estado, despues.estado, actor, detalle);
    return despues;
  }

  // El e-NCF aceptado pasa a ser el comprobante de la compra o del gasto.
  async function aplicarEnOrigen(c) {
    const [tipo, id] = String(c.origen).split(':');
    if (!c.encf) return;
    if (tipo === 'purchase') {
      await query(
        'UPDATE purchases SET ncf = ?, tipo_ncf = ?, numero_documento = CASE WHEN numero_documento = ? THEN ? ELSE numero_documento END WHERE id = ?',
        [c.encf, c.tipo_ecf, c.tipo_ecf, c.encf, Number(id)]
      );
      await query('UPDATE supplier_invoices SET ncf = ?, tipo_ncf = ? WHERE purchase_id = ?', [c.encf, c.tipo_ecf, Number(id)]).catch(() => {});
    } else if (tipo === 'expense') {
      await query('UPDATE expenses SET ncf = ?, tipo_ncf = ? WHERE id = ?', [c.encf, c.tipo_ecf, Number(id)]);
    }
  }

  function vista(c, eventos = null) {
    const [tipo, id] = String(c.origen).split(':');
    return {
      id: Number(c.id), uuid: c.uuid, tipoEcf: c.tipo_ecf, tipoNombre: TIPOS[c.tipo_ecf] || c.tipo_ecf,
      origen: { tipo: tipo === 'purchase' ? 'compra' : 'gasto', id: Number(id) },
      estado: c.estado, estadoNombre: ESTADOS[c.estado] || c.estado,
      beneficiario: c.beneficiario, rnc: c.rnc, montoTotal: Number(c.monto_total || 0), branchId: c.branch_id,
      validacion: json(c.validacion, { errores: [], avisos: [] }),
      solicitadoPor: c.solicitado_por, solicitadoAt: c.solicitado_at,
      aprobadoPor: c.aprobado_por, aprobadoAt: c.aprobado_at, aprobacion: c.aprobacion, motivo: c.motivo,
      ecfDocumentId: c.ecf_document_id ? Number(c.ecf_document_id) : null, encf: c.encf, trackId: c.track_id,
      mensaje: c.mensaje, intentos: Number(c.intentos || 0), enviadoAt: c.enviado_at, resueltoAt: c.resuelto_at,
      version: Number(c.version), createdAt: c.created_at, updatedAt: c.updated_at,
      ...(eventos ? { eventos } : {}),
    };
  }

  // Lo que se responde a la compra o el gasto (compatible con el «ecf» de antes).
  function resultadoCorto(c) {
    const pendiente = c.estado === 'pendiente_aprobacion';
    const malo = ['rechazado', 'anulado'].includes(c.estado) || (c.estado === 'autorizado' && c.mensaje);
    return {
      ok: !malo, comprobanteId: Number(c.id), tipoEcf: c.tipo_ecf, estado: c.estado, encf: c.encf || null,
      documentId: c.ecf_document_id ? Number(c.ecf_document_id) : null, trackId: c.track_id || null,
      pendienteAprobacion: pendiente, ...(pendiente ? { mensaje: 'Pendiente de aprobación del administrador.' } : {}),
      ...(c.estado === 'en_envio' && c.mensaje ? { pending: true, mensaje: c.mensaje } : {}),
      ...(malo ? { error: c.mensaje || c.motivo || 'El comprobante no salió.' } : {}),
    };
  }

  async function revisarDatos(c) {
    const datos = json(c.datos, {});
    const r = await Promise.resolve(revisar({ tipoEcf: c.tipo_ecf, ...datos, branchId: c.branch_id })).catch((e) => ({ ok: false, errores: [e.message] }));
    return { errores: r?.errores || [], avisos: r?.avisos || [] };
  }

  async function enviar(c, actor) {
    const enEnvio = await mover(c, ['autorizado', 'rechazado'], { estado: 'en_envio', intentos: Number(c.intentos || 0) + 1, mensaje: null, enviado_at: ahora() },
      actor, c.estado === 'rechazado' ? 'Reenviado' : 'Enviado a la DGII');
    const datos = json(enEnvio.datos, {});
    const r = await Promise.resolve(emitir({
      tipoEcf: enEnvio.tipo_ecf, customer: datos.customer || {}, items: datos.items || [], document: datos.document || {},
      origen: enEnvio.origen, branchId: enEnvio.branch_id,
      context: { userId: actor?.id || null, userName: nombreDe(actor), userRole: String(actor?.role_code || actor?.rol || '') },
    })).catch((e) => ({ ok: false, error: e.message }));

    const conTrack = Boolean(r?.trackId);
    const estado = r?.documentId ? estadoDesdeEcf(r.estado, conTrack) : 'autorizado';
    const cambios = {
      estado, ecf_document_id: r?.documentId || enEnvio.ecf_document_id || null, encf: r?.encf || enEnvio.encf || null,
      track_id: r?.trackId || null,
      mensaje: String(r?.error || r?.mensaje || (estado === 'autorizado' ? 'No se pudo enviar.' : '') || '').slice(0, 500) || null,
      resuelto_at: ['aceptado', 'aceptado_condicional', 'rechazado'].includes(estado) ? ahora() : null,
    };
    // Mientras va saliendo nadie más lo toca: este cambio no compite por versión.
    await query(
      `UPDATE comprobantes_compra SET ${Object.keys(cambios).map((k) => `${k} = ?`).join(', ')}, version = version + 1, updated_at = ? WHERE id = ?`,
      [...Object.values(cambios), ahora(), enEnvio.id]
    );
    const final = await fila(enEnvio.id);
    await evento(final.id, `Respuesta: ${ESTADOS[final.estado] || final.estado}`, 'en_envio', final.estado, actor,
      { encf: final.encf, trackId: final.track_id, mensaje: final.mensaje });
    if (['aceptado', 'aceptado_condicional'].includes(final.estado)) await aplicarEnOrigen(final);
    return final;
  }

  /**
   * Pide el comprobante de una compra o un gasto ya registrados.
   * @param {object} p { origen: { tipo: 'compra'|'gasto', id }, tipoEcf, branchId, datos: { customer, items, document },
   *                     resumen: { beneficiario, rnc, total }, actor, puedeAprobar }
   */
  async function solicitar({ origen, tipoEcf, branchId = null, datos, resumen = {}, actor, puedeAprobar = false }) {
    await ensureSchema();
    const tipo = String(tipoEcf || '').toUpperCase();
    if (!TIPOS[tipo]) throw fail(`${tipo || 'Ese tipo'} no es un comprobante de compras o gastos (E41, E43 o E47).`);
    const prefijo = ORIGENES[origen?.tipo];
    if (!prefijo || !Number(origen?.id)) throw fail('Indica la compra o el gasto del comprobante.');
    const clave = `${prefijo}:${Number(origen.id)}`;

    const [ya] = await query('SELECT * FROM comprobantes_compra WHERE activo_clave = ? LIMIT 1', [clave]);
    if (ya) return { comprobante: vista(ya), ecf: resultadoCorto(ya), repetido: true };

    const modalidad = await leerModalidad();
    const directo = modalidad === 'directa' || puedeAprobar;
    const momento = ahora();
    let id;
    try {
      const ins = await query(
        `INSERT INTO comprobantes_compra (uuid, origen, activo_clave, tipo_ecf, branch_id, estado, beneficiario, rnc, monto_total, datos,
           solicitado_por_id, solicitado_por, solicitado_at, aprobado_por_id, aprobado_por, aprobado_at, aprobacion, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), clave, clave, tipo, branchId, directo ? 'autorizado' : 'pendiente_aprobacion',
          String(resumen.beneficiario || '').slice(0, 160) || null, String(resumen.rnc || '').replace(/\D/g, '') || null,
          Number(resumen.total || 0), JSON.stringify(datos || {}),
          actor?.id || null, nombreDe(actor), momento,
          directo ? actor?.id || null : null, directo ? nombreDe(actor) : null, directo ? momento : null,
          directo ? (modalidad === 'directa' ? 'directa' : 'por_quien_aprueba') : null, momento, momento]
      );
      id = Number(ins.insertId);
    } catch (error) {
      // Dos registros a la vez de la misma compra: el índice único frena el segundo.
      if (/unique|duplicate/i.test(String(error?.message || ''))) {
        const [otro] = await query('SELECT * FROM comprobantes_compra WHERE activo_clave = ? LIMIT 1', [clave]);
        if (otro) return { comprobante: vista(otro), ecf: resultadoCorto(otro), repetido: true };
      }
      throw error;
    }
    let c = await fila(id);
    await evento(id, 'Solicitado', null, c.estado, actor, { modalidad, origen: clave, total: resumen.total });
    const validacion = await revisarDatos(c);
    // Con errores no sale nada (ni se gasta número): queda autorizado con el motivo
    // para corregir y reintentar.
    const frenado = directo && validacion.errores.length > 0;
    await query('UPDATE comprobantes_compra SET validacion = ?, mensaje = ? WHERE id = ?',
      [JSON.stringify(validacion), frenado ? `No salió: ${validacion.errores.slice(0, 3).join(' | ')}`.slice(0, 500) : null, id]);
    c = await fila(id);
    await Promise.resolve(writeAuditLog({
      userId: actor?.id, userName: nombreDe(actor), userRole: String(actor?.role_code || actor?.rol || ''),
      moduleName: 'Compras', actionName: directo ? `${tipo} solicitado` : `${tipo} pendiente de aprobación`,
      documentRef: clave, amount: Number(resumen.total || 0), detail: `${TIPOS[tipo]} · ${resumen.beneficiario || ''} · ${modalidad}`,
    })).catch(() => {});
    if (directo && !frenado) c = await enviar(c, actor);
    return { comprobante: vista(c), ecf: resultadoCorto(c), repetido: false };
  }

  // Arma los datos desde la compra o el gasto guardados y lo pide. Si faltan datos
  // (p. ej. el proveedor sin RNC), la operación ya quedó: se devuelve el error.
  async function solicitarDe({ tipo, id, tipoEcf, actor, puedeAprobar = false, extra = {} }) {
    if (!constructores) throw fail('Este equipo no arma comprobantes de compra.', 500);
    let armado;
    try {
      armado = tipo === 'compra'
        ? await constructores.deCompra(id, tipoEcf)
        : await constructores.deGasto(id, tipoEcf, extra);
    } catch (error) {
      return { comprobante: null, ecf: { ok: false, tipoEcf, error: error.message }, repetido: false };
    }
    return solicitar({
      origen: { tipo, id }, tipoEcf, branchId: armado.branchId, datos: armado.datos, resumen: armado.resumen, actor, puedeAprobar,
    });
  }

  async function aprobar(id, actor) {
    await ensureSchema();
    const c = await fila(id);
    if (c.estado !== 'pendiente_aprobacion') throw fail(`Este comprobante ya está «${ESTADOS[c.estado] || c.estado}».`, 409);
    const validacion = await revisarDatos(c);
    if (validacion.errores.length) {
      await query('UPDATE comprobantes_compra SET validacion = ? WHERE id = ?', [JSON.stringify(validacion), c.id]);
      throw Object.assign(fail(`No se puede emitir todavía: ${validacion.errores.slice(0, 2).join(' | ')}`, 422), { errores: validacion.errores });
    }
    const autorizado = await mover(c, ['pendiente_aprobacion'], {
      estado: 'autorizado', aprobado_por_id: actor?.id || null, aprobado_por: nombreDe(actor), aprobado_at: ahora(), aprobacion: 'manual',
      validacion: JSON.stringify(validacion),
    }, actor, 'Aprobado');
    await Promise.resolve(writeAuditLog({
      userId: actor?.id, userName: nombreDe(actor), userRole: String(actor?.role_code || actor?.rol || ''),
      moduleName: 'Compras', actionName: `${c.tipo_ecf} aprobado`, documentRef: c.origen, amount: Number(c.monto_total || 0),
      detail: `Solicitado por ${c.solicitado_por || ''}`,
    })).catch(() => {});
    return vista(await enviar(autorizado, actor));
  }

  async function noAprobar(id, motivo, actor) {
    await ensureSchema();
    const texto = String(motivo || '').trim();
    if (texto.length < 3) throw fail('Escribe por qué no se aprueba.');
    const c = await fila(id);
    if (c.estado !== 'pendiente_aprobacion') throw fail(`Este comprobante ya está «${ESTADOS[c.estado] || c.estado}».`, 409);
    const r = await mover(c, ['pendiente_aprobacion'], { estado: 'anulado', activo_clave: null, motivo: texto.slice(0, 255), resuelto_at: ahora() }, actor, 'No aprobado', texto);
    return vista(r);
  }

  async function reintentar(id, actor) {
    await ensureSchema();
    const c = await fila(id);
    if (!['autorizado', 'rechazado'].includes(c.estado)) throw fail(`Solo se reintenta un comprobante autorizado que no salió o uno rechazado (está «${ESTADOS[c.estado] || c.estado}»).`, 409);
    if (sinInternet() && c.estado === 'rechazado') throw fail('Sin Internet: vuelve a intentarlo cuando haya conexión.', 409);
    const validacion = await revisarDatos(c);
    if (validacion.errores.length) {
      await query('UPDATE comprobantes_compra SET validacion = ?, mensaje = ? WHERE id = ?',
        [JSON.stringify(validacion), `No salió: ${validacion.errores.slice(0, 3).join(' | ')}`.slice(0, 500), c.id]);
      throw Object.assign(fail(`No se puede emitir todavía: ${validacion.errores.slice(0, 2).join(' | ')}`, 422), { errores: validacion.errores });
    }
    return vista(await enviar(await fila(c.id), actor));
  }

  async function anular(id, motivo, actor) {
    await ensureSchema();
    const texto = String(motivo || '').trim();
    if (texto.length < 3) throw fail('Escribe el motivo.');
    const c = await fila(id);
    if (['aceptado', 'aceptado_condicional'].includes(c.estado)) {
      throw fail('Un comprobante aceptado por la DGII no se anula aquí: se corrige con una nota de crédito.', 409);
    }
    if (!['autorizado', 'rechazado', 'pendiente_aprobacion'].includes(c.estado)) {
      throw fail(`No se puede anular mientras está «${ESTADOS[c.estado] || c.estado}».`, 409);
    }
    const r = await mover(c, ['autorizado', 'rechazado', 'pendiente_aprobacion'], { estado: 'anulado', activo_clave: null, motivo: texto.slice(0, 255), resuelto_at: ahora() }, actor, 'Anulado', texto);
    return vista(r);
  }

  // Trae el resultado de la DGII de lo que salió y aún no tiene respuesta final.
  async function sincronizar({ consultar = true, limite = 10 } = {}) {
    await ensureSchema();
    const abiertos = await query(
      `SELECT c.*, d.estado_dgii AS doc_estado, d.track_id AS doc_track, d.error_message AS doc_error, d.encf AS doc_encf
       FROM comprobantes_compra c LEFT JOIN ecf_documents d ON d.id = c.ecf_document_id
       WHERE c.estado IN (${ABIERTOS.map(() => '?').join(', ')}) ORDER BY c.id LIMIT 50`,
      ABIERTOS
    ).catch(() => []);
    let consultas = 0;
    const cambiados = [];
    for (const c of abiertos) {
      // Envío cortado a mitad (se cerró el programa): se busca su documento por el
      // origen; si nunca llegó a crearse, vuelve a «autorizado» para reintentarlo.
      if (!c.ecf_document_id) {
        const [doc] = await query(
          'SELECT id, estado_dgii, track_id, error_message, encf FROM ecf_documents WHERE origen = ? AND tipo_ecf = ? ORDER BY id DESC LIMIT 1',
          [c.origen, c.tipo_ecf]
        ).catch(() => []);
        const viejo = Date.now() - new Date(String(c.enviado_at || c.updated_at || '').replace(' ', 'T')).getTime() > 5 * 60 * 1000;
        if (doc) {
          await query('UPDATE comprobantes_compra SET ecf_document_id = ?, encf = ? WHERE id = ?', [doc.id, doc.encf, c.id]);
          Object.assign(c, { ecf_document_id: doc.id, encf: doc.encf, doc_estado: doc.estado_dgii, doc_track: doc.track_id, doc_error: doc.error_message, doc_encf: doc.encf });
        } else {
          if (viejo) {
            try {
              await mover(c, ABIERTOS, { estado: 'autorizado', mensaje: 'El envío se interrumpió antes de salir. Reintenta.' }, null, 'Envío interrumpido');
              cambiados.push(Number(c.id));
            } catch (_) { /* otro proceso lo tomó */ }
          }
          continue;
        }
      }
      let estadoDoc = c.doc_estado;
      let mensaje = c.doc_error;
      if (consultar && consultarEstado && c.doc_track && ['enviado', 'en_proceso', 'procesando', 'error_consulta'].includes(String(estadoDoc)) && consultas < limite && !sinInternet()) {
        consultas += 1;
        const r = await Promise.resolve(consultarEstado(Number(c.ecf_document_id))).catch(() => null);
        if (r?.estado) { estadoDoc = r.estado; mensaje = r.mensaje || mensaje; }
      }
      if (!estadoDoc) continue;
      const nuevo = estadoDesdeEcf(estadoDoc, Boolean(c.doc_track));
      if (nuevo === c.estado && (c.track_id || null) === (c.doc_track || null)) continue;
      // Un error sin TrackID devuelve a «autorizado» para poder reintentar.
      const cambios = {
        estado: nuevo, track_id: c.doc_track || c.track_id || null, encf: c.doc_encf || c.encf,
        mensaje: nuevo === 'aceptado' ? null : (String(mensaje || '').slice(0, 500) || null),
        resuelto_at: ['aceptado', 'aceptado_condicional', 'rechazado'].includes(nuevo) ? ahora() : null,
      };
      try {
        const actualizado = await mover(c, ABIERTOS, cambios, null, `Respuesta: ${ESTADOS[nuevo] || nuevo}`, { estadoDgii: estadoDoc, mensaje });
        if (['aceptado', 'aceptado_condicional'].includes(actualizado.estado)) await aplicarEnOrigen(actualizado);
        cambiados.push(Number(c.id));
      } catch (_) { /* otro proceso lo movió: la próxima vuelta lo ve */ }
    }
    return { revisados: abiertos.length, cambiados };
  }

  async function listar({ estado = null, tipo = null, branchId = null, limite = 200 } = {}) {
    await ensureSchema();
    const cond = [];
    const params = [];
    if (estado === 'abiertos') { cond.push(`c.estado IN ('pendiente_aprobacion', 'autorizado', 'en_envio', 'en_proceso', 'rechazado')`); }
    else if (estado) { cond.push('c.estado = ?'); params.push(String(estado)); }
    if (tipo) { cond.push('c.tipo_ecf = ?'); params.push(String(tipo).toUpperCase()); }
    if (branchId) { cond.push('c.branch_id = ?'); params.push(Number(branchId)); }
    const filas = await query(
      `SELECT c.* FROM comprobantes_compra c ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''} ORDER BY c.id DESC LIMIT ${Math.min(500, Math.max(1, Number(limite) || 200))}`,
      params
    );
    return filas.map((f) => vista(f));
  }

  async function detalle(id) {
    await ensureSchema();
    const c = await fila(id);
    const eventos = await query('SELECT * FROM comprobantes_compra_eventos WHERE comprobante_id = ? ORDER BY id', [c.id]);
    return vista(c, eventos.map((e) => ({
      accion: e.accion, estadoAntes: e.estado_antes, estadoDespues: e.estado_despues, usuario: e.usuario,
      detalle: json(e.detalle, e.detalle), at: e.created_at,
    })));
  }

  async function deOrigen(tipo, id) {
    await ensureSchema();
    const prefijo = ORIGENES[tipo];
    if (!prefijo) return [];
    const filas = await query('SELECT * FROM comprobantes_compra WHERE origen = ? ORDER BY id DESC', [`${prefijo}:${Number(id)}`]);
    return filas.map((f) => vista(f));
  }

  async function resumen({ branchId = null } = {}) {
    await ensureSchema();
    const filas = await query(
      `SELECT estado, COUNT(*) AS n FROM comprobantes_compra WHERE estado IN ('pendiente_aprobacion', 'autorizado', 'en_envio', 'en_proceso', 'rechazado')
       ${branchId ? 'AND branch_id = ?' : ''} GROUP BY estado`,
      branchId ? [Number(branchId)] : []
    ).catch(() => []);
    const r = { pendiente_aprobacion: 0, autorizado: 0, en_envio: 0, en_proceso: 0, rechazado: 0 };
    for (const f of filas) r[f.estado] = Number(f.n || 0);
    return r;
  }

  return {
    ensureSchema, leerModalidad, guardarModalidad, solicitar, solicitarDe, aprobar, noAprobar, reintentar, anular,
    sincronizar, listar, detalle, deOrigen, resumen,
  };
}

module.exports = { crearServicioComprobantesCompra, repartir, estadoDesdeEcf, TIPOS, ESTADOS, MODALIDADES };

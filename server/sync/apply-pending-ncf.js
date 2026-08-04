'use strict';
/**
 * apply-pending-ncf.js
 *
 * Consume la cola de secuencias NCF que un contador registró/editó/suspendió
 * desde el Portal del Contador (tecno-caja-contadores) para este negocio. El
 * Portal no tiene acceso directo a la base de datos local del POS — solo
 * puede dejar una "solicitud pendiente" en Firestore. Este módulo es quien
 * realmente la aplica, la próxima vez que este POS sincroniza (mismos
 * disparadores que sync-pos-stats.js / apply-pending-products.js: abrir
 * caja, cerrar caja, crear venta).
 *
 * Firestore: licencias/{licenseUid}/ncf_pendientes/{autoId}
 *   status: 'pendiente' | 'aplicado' | 'error'
 *   action: 'create' (default) | 'edit' | 'suspend' | 'delete'
 *   targetLocalSequenceId — solo en 'edit'/'suspend'/'delete', el id local (columna
 *   `id` de ncf_authorized_sequences) que el propio POS le devolvió al
 *   Portal cuando se aplicó el 'create' original (ver localSequenceId abajo).
 *   branchId: número | null — null/vacío = rango global (todas las
 *   sucursales). El Portal solo deja elegir entre las sucursales que este
 *   mismo POS ya sincronizó, pero igual se revalida aquí contra la base
 *   local por si esa sucursal se eliminó entre que el contador la eligió y
 *   que este POS sincronizó (mismo criterio que productos_pendientes).
 *
 * 'edit'/'suspend' revalidan las MISMAS reglas que los endpoints manuales
 * PUT /:id y POST /:id/suspend de fiscal-sequences.routes.js — no se puede
 * tocar el número inicial, no se puede bajar el final por debajo de lo ya
 * usado. 'delete' es una excepción a propósito: a diferencia de DELETE /:id
 * local (que bloquea si la secuencia ya tuvo uso), aquí se permite eliminar
 * siempre, usada o no (decisión explícita de Emilio) — sigue siendo
 * soft-delete, nunca borra la fila ni afecta los NCF ya emitidos con ese
 * rango. Cambiar el próximo número o reactivar una ya suspendida/eliminada
 * sigue exclusivo del dueño en el POS.
 *
 * Solo NCF tradicional (B01-B17) — el e-CF ya se certifica aparte con la
 * DGII, no se autoriza por rango manual, no aplica esta cola.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  findOverlappingSequence, VALID_DOCUMENT_TYPES, ATTACHMENT_MIME_EXTENSIONS, MAX_ATTACHMENT_BYTES,
} = require('../routes/fiscal-sequences.routes');

function getLicenseUid() {
  return String(process.env.TECNO_CAJA_LICENSE_UID || '').trim();
}

function getDb() {
  const { getFirestore } = require('../../modules/firebase-admin');
  return getFirestore();
}

/**
 * @param {Function} query — de db.js
 * @param {Function} withTransaction — de db.js
 * @param {Function} writeAuditLog — de server.js
 * @param {Function} isMysqlDeployment — de server.js
 * @param {string} attachmentsDir — carpeta local donde guardar el documento de autorización (FISCAL_ATTACHMENTS_DIR)
 * @param {string} attachmentsWebPath — prefijo web para el archivo guardado (FISCAL_ATTACHMENTS_WEB_PATH)
 */
function createApplyPendingNcfService({ query, withTransaction, writeAuditLog, isMysqlDeployment, attachmentsDir, attachmentsWebPath }) {
  // Decodifica un data:mime;base64,... y lo guarda en attachmentsDir, o
  // devuelve null si el formato/tipo no es válido — mismas reglas que el
  // endpoint manual POST /api/fiscal-sequences/:id/attachment.
  function saveAttachment(sequenceId, dataUrl) {
    const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/.exec(String(dataUrl || ''));
    if (!match) return null;
    const ext = ATTACHMENT_MIME_EXTENSIONS[match[1].toLowerCase()];
    if (!ext) return null;
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_ATTACHMENT_BYTES) return null;

    const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
    const fileName = `ncf-${sequenceId}-${hash}.${ext}`;
    fs.mkdirSync(attachmentsDir, { recursive: true });
    fs.writeFileSync(path.join(attachmentsDir, fileName), buffer);
    return `${attachmentsWebPath}/${fileName}`.replace(/\\/g, '/');
  }

  // exec: la conexión a usar para el INSERT — `query` plano para 'create'
  // (fuera de transacción), o `conn.query` cuando se llama desde dentro de
  // withTransaction (edit/suspend). Usar el `query` global del pool DENTRO
  // de una transacción abierta se cuelga (una segunda conexión del pool
  // espera indefinidamente mientras la primera sigue con la fila bloqueada
  // por FOR UPDATE) — confirmado en pruebas. Por el mismo motivo, el log
  // general (`writeAuditLog`, que internamente también usa el pool plano)
  // NUNCA se llama desde aquí — el caller lo hace después de que la
  // transacción ya cerró (ver applyPendingNcfRequests).
  async function recordAudit({ exec, sequenceId, action, reason, contadorNombre, dataBefore, dataAfter }) {
    await exec(
      `INSERT INTO ncf_authorized_sequence_audit
         (ncf_authorized_sequence_id, action, reason, user_name, data_before, data_after)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        sequenceId, action, reason || null, `Contador: ${contadorNombre}`,
        dataBefore ? JSON.stringify(dataBefore) : null, dataAfter ? JSON.stringify(dataAfter) : null,
      ]
    );
  }

  async function logGeneral({ sequenceId, action, reason, contadorNombre }) {
    try {
      await writeAuditLog({
        userId: null, userName: `Contador: ${contadorNombre}`, userRole: 'Contador',
        moduleName: 'Secuencias Fiscales', actionName: action,
        detail: `Secuencia #${sequenceId} (vía Portal del Contador)${reason ? ` — ${reason}` : ''}`,
      });
    } catch (auditError) {
      console.warn('[apply-pending-ncf] No se pudo registrar auditoría general:', auditError.message);
    }
  }

  async function applyCreate(request, contadorNombre) {
    const documentType = String(request.documentType || '').toUpperCase().trim();
    if (!VALID_DOCUMENT_TYPES.includes(documentType)) {
      throw new Error(`Tipo de comprobante inválido: ${documentType}.`);
    }
    const startNumber = Number(request.startNumber);
    const endNumber = Number(request.endNumber);
    if (!Number.isFinite(startNumber) || !Number.isFinite(endNumber) || startNumber < 1 || startNumber > endNumber) {
      throw new Error('El rango de números no es válido.');
    }
    const authorizationReference = String(request.authorizationReference || '').trim();
    if (!authorizationReference) {
      throw new Error('Falta la referencia de autorización DGII.');
    }

    // Revalidar la sucursal elegida contra la base local — si ya no existe
    // (se eliminó después de que el contador la eligió), cae a global en vez
    // de fallar todo el registro (mismo criterio que apply-pending-products.js).
    let branchId = null;
    const requestedBranchId = Number(request.branchId || 0) || null;
    if (requestedBranchId) {
      const branchRows = await query(
        `SELECT id FROM branches WHERE id = ? AND estado <> 'Eliminada' LIMIT 1`,
        [requestedBranchId]
      ).catch(() => []);
      branchId = branchRows.length ? requestedBranchId : null;
    }

    const duplicate = await query(
      `SELECT id FROM ncf_authorized_sequences
       WHERE document_type = ? AND ((branch_id = ?) OR (branch_id IS NULL AND ? IS NULL))
         AND start_number = ? AND end_number = ? AND deleted_at IS NULL`,
      [documentType, branchId, branchId, startNumber, endNumber]
    );
    if (duplicate[0]) throw new Error('Ya existe una secuencia registrada con este mismo rango.');

    const overlap = await findOverlappingSequence(query, { documentType, branchId, startNumber, endNumber });
    if (overlap) {
      const fmt = (n) => `${documentType}${String(n).padStart(8, '0')}`;
      throw new Error(`Se cruza con la autorización ya registrada ${fmt(overlap.start_number)}–${fmt(overlap.end_number)}.`);
    }

    const authDate = /^\d{4}-\d{2}-\d{2}$/.test(String(request.authorizationDate || '')) ? request.authorizationDate : null;
    const expDate = /^\d{4}-\d{2}-\d{2}$/.test(String(request.expirationDate || '')) ? request.expirationDate : null;

    const result = await query(
      `INSERT INTO ncf_authorized_sequences
         (branch_id, series, document_type, document_name, prefix, start_number, end_number, next_number,
          authorization_date, expiration_date, authorization_reference, status, notes)
       VALUES (?, 'B', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)`,
      [
        branchId, documentType, documentType, documentType, startNumber, endNumber, startNumber,
        authDate, expDate, authorizationReference,
        `Registrado por contador: ${contadorNombre}.${request.notes ? ` ${request.notes}` : ''}`,
      ]
    );
    const sequenceId = result.insertId;

    // Adjunto — si viene, se guarda localmente igual que el endpoint manual
    // de subida. Si el registro trae referencia Y adjunto, satisface la
    // misma condición que ya exige POST /:id/activate, así que se activa
    // directo — nunca se activa sin ambos (mismo invariante de seguridad,
    // solo automatizado).
    let authorizationFileUrl = null;
    if (request.attachmentData) {
      authorizationFileUrl = saveAttachment(sequenceId, request.attachmentData);
    }
    if (authorizationFileUrl) {
      await query(
        "UPDATE ncf_authorized_sequences SET authorization_file_url = ?, status = 'activo' WHERE id = ?",
        [authorizationFileUrl, sequenceId]
      );
    }

    const auditReason = `Registrado desde el Portal del Contador (${contadorNombre})`;
    await recordAudit({
      exec: query, sequenceId, action: 'create_from_contador', reason: auditReason,
      contadorNombre, dataAfter: { documentType, startNumber, endNumber, authorizationReference },
    });

    return { sequenceId, auditAction: 'create_from_contador', auditReason };
  }

  async function applyEdit(request, contadorNombre) {
    const targetId = Number(request.targetLocalSequenceId || 0);
    if (!targetId) throw new Error('Falta indicar qué secuencia editar.');

    return withTransaction(async (conn) => {
      const [seq] = await conn.query(
        `SELECT * FROM ncf_authorized_sequences WHERE id = ? AND deleted_at IS NULL${isMysqlDeployment() ? ' FOR UPDATE' : ''}`,
        [targetId]
      );
      if (!seq) throw new Error(`La secuencia #${targetId} ya no existe en este POS.`);

      // Mismas reglas que PUT /:id local — nunca se toca el número inicial,
      // y el final no puede bajar de lo ya usado.
      const wasUsed = seq.next_number > seq.start_number;
      const endNumber = request.endNumber != null ? Number(request.endNumber) : seq.end_number;
      if (wasUsed && Number(request.endNumber) < seq.next_number - 1) {
        throw new Error('No se puede reducir el rango por debajo de los números ya utilizados.');
      }
      if (seq.start_number > endNumber) throw new Error('El número final no puede ser menor que el inicial.');

      const authDate = /^\d{4}-\d{2}-\d{2}$/.test(String(request.authorizationDate || '')) ? request.authorizationDate : seq.authorization_date;
      const expDate = /^\d{4}-\d{2}-\d{2}$/.test(String(request.expirationDate || '')) ? request.expirationDate : seq.expiration_date;
      const dataBefore = { ...seq };

      await conn.query(
        `UPDATE ncf_authorized_sequences SET
           document_name = ?, end_number = ?, authorization_date = ?, expiration_date = ?,
           authorization_reference = ?, notes = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [
          request.documentName || seq.document_name, endNumber, authDate, expDate,
          request.authorizationReference || seq.authorization_reference,
          request.notes ? `${seq.notes || ''} · Editado por contador: ${contadorNombre}. ${request.notes}`.trim() : seq.notes,
          targetId,
        ]
      );

      const auditReason = request.notes || `Editado desde el Portal del Contador (${contadorNombre})`;
      await recordAudit({
        exec: conn.query, sequenceId: targetId, action: 'edit_from_contador', reason: auditReason,
        contadorNombre, dataBefore, dataAfter: { endNumber, authDate, expDate, authorizationReference: request.authorizationReference },
      });

      return { sequenceId: targetId, auditAction: 'edit_from_contador', auditReason };
    });
  }

  async function applySuspend(request, contadorNombre) {
    const targetId = Number(request.targetLocalSequenceId || 0);
    if (!targetId) throw new Error('Falta indicar qué secuencia suspender.');
    const reason = String(request.reason || '').trim();
    if (!reason) throw new Error('Falta el motivo de la suspensión.');

    return withTransaction(async (conn) => {
      const [seq] = await conn.query(
        `SELECT * FROM ncf_authorized_sequences WHERE id = ? AND deleted_at IS NULL${isMysqlDeployment() ? ' FOR UPDATE' : ''}`,
        [targetId]
      );
      if (!seq) throw new Error(`La secuencia #${targetId} ya no existe en este POS.`);

      await conn.query(
        "UPDATE ncf_authorized_sequences SET status = 'suspendido', updated_at = datetime('now') WHERE id = ?",
        [targetId]
      );

      await recordAudit({
        exec: conn.query, sequenceId: targetId, action: 'suspend_from_contador', reason, contadorNombre,
        dataBefore: { status: seq.status }, dataAfter: { status: 'suspendido' },
      });

      return { sequenceId: targetId, auditAction: 'suspend_from_contador', auditReason: reason };
    });
  }

  async function applyDelete(request, contadorNombre) {
    const targetId = Number(request.targetLocalSequenceId || 0);
    if (!targetId) throw new Error('Falta indicar qué secuencia eliminar.');
    const reason = String(request.reason || '').trim() || `Eliminada desde el Portal del Contador (${contadorNombre})`;

    return withTransaction(async (conn) => {
      const [seq] = await conn.query(
        `SELECT * FROM ncf_authorized_sequences WHERE id = ? AND deleted_at IS NULL${isMysqlDeployment() ? ' FOR UPDATE' : ''}`,
        [targetId]
      );
      if (!seq) throw new Error(`La secuencia #${targetId} ya no existe en este POS.`);

      // A diferencia de DELETE /:id local (que bloquea si ya se usó algún
      // número), aquí se permite eliminar sin esa restricción — decisión
      // explícita de Emilio: el contador puede limpiar cualquier secuencia,
      // usada o no. Sigue siendo soft-delete (deleted_at), nunca borra la
      // fila físicamente ni afecta los NCF ya emitidos con ese rango.
      await conn.query(
        "UPDATE ncf_authorized_sequences SET deleted_at = datetime('now'), deletion_reason = ? WHERE id = ?",
        [reason, targetId]
      );

      await recordAudit({
        exec: conn.query, sequenceId: targetId, action: 'delete_from_contador', reason, contadorNombre,
        dataBefore: { status: seq.status }, dataAfter: { deleted: true },
      });

      return { sequenceId: targetId, auditAction: 'delete_from_contador', auditReason: reason };
    });
  }

  async function applyPendingNcfRequests() {
    const licenseUid = getLicenseUid();
    if (!licenseUid) {
      return { ok: false, reason: 'TECNO_CAJA_LICENSE_UID no configurado' };
    }

    let db;
    try {
      db = getDb();
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    if (!db) return { ok: false, reason: 'Firebase no disponible' };

    const pendingCol = db.collection('licencias').doc(licenseUid).collection('ncf_pendientes');

    let snapshot;
    try {
      snapshot = await pendingCol.where('status', '==', 'pendiente').get();
    } catch (e) {
      console.warn('[apply-pending-ncf] No se pudo leer la cola:', e.message);
      return { ok: false, reason: e.message };
    }

    if (snapshot.empty) return { ok: true, applied: 0, failed: 0 };

    let applied = 0;
    let failed = 0;

    for (const doc of snapshot.docs) {
      const request = doc.data() || {};
      const contadorNombre = request.contadorNombre || 'sin nombre';
      const action = request.action || 'create';

      try {
        let outcome;
        if (action === 'edit') outcome = await applyEdit(request, contadorNombre);
        else if (action === 'suspend') outcome = await applySuspend(request, contadorNombre);
        else if (action === 'delete') outcome = await applyDelete(request, contadorNombre);
        else outcome = await applyCreate(request, contadorNombre);

        // Fuera de cualquier transacción a propósito — writeAuditLog usa el
        // pool plano, y ya no hay ninguna conexión de transacción abierta
        // en este punto (withTransaction ya hizo commit y liberó la suya).
        await logGeneral({ sequenceId: outcome.sequenceId, action: outcome.auditAction, reason: outcome.auditReason, contadorNombre });

        await doc.ref.update({
          status: 'aplicado',
          localSequenceId: outcome.sequenceId,
          appliedAt: new Date().toISOString(),
        });
        applied += 1;
      } catch (error) {
        await doc.ref.update({
          status: 'error',
          errorMessage: error.message || 'No se pudo procesar la solicitud de NCF.',
          appliedAt: new Date().toISOString(),
        }).catch(() => {});
        failed += 1;
      }
    }

    console.log(`[apply-pending-ncf] ${licenseUid}: ${applied} aplicado(s), ${failed} con error.`);
    return { ok: true, applied, failed };
  }

  return { applyPendingNcfRequests };
}

module.exports = { createApplyPendingNcfService };

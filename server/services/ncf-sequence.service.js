'use strict';

// Asignación de NCF (Números de Comprobante Fiscal) — extraído de server.js para
// que sea testeable sin cargar el monolito completo (Firebase, MySQL, wa-bot, etc.).
// Delega a ncf_authorized_sequences (registro manual con autorización DGII real,
// ver server/routes/fiscal-sequences.routes.js) o al sistema legacy ncf_sequences
// según el flag config.ncf_authorized_sequences_v2_enabled — salvaguarda de
// reversión sin redeploy mientras se confirma en producción real. Misma firma y
// mismo retorno { ncf, fechaVencimiento } en ambos casos para no tocar los
// call-sites (server.js POST /api/sales, offline.routes.js).

const NCF_LABELS = {
  B01: 'Crédito Fiscal',
  B02: 'Consumidor Final',
  B03: 'Nota de Débito',
  B04: 'Nota de Crédito',
  B11: 'Comprobante de Compras',
  B12: 'Registro Único de Ingresos',
  B13: 'Gastos Menores',
  B14: 'Régimen Especial',
  B15: 'Gubernamental',
  B16: 'Comprobante para Exportaciones',
  B17: 'Comprobante para Pagos al Exterior'
};

function createNcfSequenceService({ isMysqlDeployment }) {
  async function getNextNcfLegacy(conn, ncfType, branchId) {
    const seqs = await conn.query(
      `SELECT * FROM ncf_sequences WHERE ncf_type = ? AND activa = 1
       AND (branch_id = ? OR branch_id IS NULL)
       ORDER BY branch_id DESC LIMIT 1${isMysqlDeployment() ? ' FOR UPDATE' : ''}`,
      [ncfType, branchId || null]
    );
    if (!seqs[0]) {
      const err = new Error(`No hay secuencia configurada para ${ncfType}. Créala en Configuración → Comprobantes.`);
      err.statusCode = 409;
      throw err;
    }
    const seq = seqs[0];
    if (seq.siguiente_numero > seq.maximo) {
      const err = new Error(`La secuencia ${ncfType} ha alcanzado su límite (${seq.maximo}). Solicita nuevas secuencias a la DGII.`);
      err.statusCode = 409;
      throw err;
    }
    const ncfNumber = seq.siguiente_numero;
    const ncf = `${ncfType}${String(ncfNumber).padStart(8, '0')}`;
    await conn.query(
      'UPDATE ncf_sequences SET siguiente_numero = siguiente_numero + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [seq.id]
    );
    return { ncf, fechaVencimiento: seq.fecha_vencimiento || null };
  }

  async function getNextNcfAuthorized(conn, ncfType, branchId) {
    const seqs = await conn.query(
      `SELECT * FROM ncf_authorized_sequences WHERE document_type = ? AND status = 'activo' AND deleted_at IS NULL
       AND (branch_id = ? OR branch_id IS NULL)
       ORDER BY branch_id DESC LIMIT 1${isMysqlDeployment() ? ' FOR UPDATE' : ''}`,
      [ncfType, branchId || null]
    );
    if (!seqs[0]) {
      const err = new Error(`No hay secuencia activa para ${ncfType}. Regístrala y actívala en Configuración → Comprobantes fiscales.`);
      err.statusCode = 409;
      throw err;
    }
    const seq = seqs[0];
    const today = new Date().toISOString().slice(0, 10);
    if (seq.expiration_date && String(seq.expiration_date) < today) {
      const err = new Error(`La secuencia ${ncfType} venció el ${seq.expiration_date}. Solicita una nueva autorización a la DGII.`);
      err.statusCode = 409;
      throw err;
    }
    if (seq.next_number > seq.end_number) {
      await conn.query("UPDATE ncf_authorized_sequences SET status = 'agotado', updated_at = datetime('now') WHERE id = ?", [seq.id]);
      const err = new Error(`La secuencia ${ncfType} se agotó (rango ${seq.start_number}-${seq.end_number}). Registra una nueva autorización de la DGII.`);
      err.statusCode = 409;
      throw err;
    }
    const ncfNumber = seq.next_number;
    const ncf = `${ncfType}${String(ncfNumber).padStart(8, '0')}`;
    const nextAfter = ncfNumber + 1;
    const newStatus = nextAfter > seq.end_number ? 'agotado' : seq.status;
    await conn.query(
      "UPDATE ncf_authorized_sequences SET next_number = ?, last_used_number = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
      [nextAfter, ncfNumber, newStatus, seq.id]
    );
    return { ncf, fechaVencimiento: seq.expiration_date || null };
  }

  async function getNextNcf(conn, ncfType, branchId) {
    const [cfg] = await conn.query('SELECT ncf_authorized_sequences_v2_enabled FROM config WHERE id = 1 LIMIT 1');
    if (cfg && Number(cfg.ncf_authorized_sequences_v2_enabled)) {
      return getNextNcfAuthorized(conn, ncfType, branchId);
    }
    return getNextNcfLegacy(conn, ncfType, branchId);
  }

  // Resumen de secuencias serie B activas que están por vencer o con pocos
  // números disponibles — alimenta la campanita de notificaciones (ver
  // js/app.js buildNotifications()), mismo patrón que ya usa e-CF
  // (ecfModule.service.getExpiringSequencesSummary).
  async function getSequencesWarningSummary(query, { expiryThresholdDays = 30, lowCountThreshold = 20 } = {}) {
    const rows = await query(
      `SELECT fs.document_type, fs.next_number, fs.end_number, fs.expiration_date, b.nombre AS branch_name
       FROM ncf_authorized_sequences fs
       LEFT JOIN branches b ON b.id = fs.branch_id
       WHERE fs.series = 'B' AND fs.status = 'activo' AND fs.deleted_at IS NULL`
    );
    const now = Date.now();
    const dayMs = 86400000;
    return rows
      .map((row) => {
        const disponibles = Math.max(0, Number(row.end_number || 0) - Number(row.next_number || 0) + 1);
        const diasParaVencer = row.expiration_date
          ? Math.ceil((new Date(row.expiration_date).getTime() - now) / dayMs)
          : null;
        return {
          tipoComprobante: row.document_type,
          branchName: row.branch_name || null,
          disponibles,
          diasParaVencer,
          isExpired: diasParaVencer !== null && diasParaVencer < 0,
          isLow: disponibles <= lowCountThreshold,
        };
      })
      .filter((item) => item.isLow || (item.diasParaVencer !== null && item.diasParaVencer <= expiryThresholdDays))
      .sort((a, b) => {
        // Más urgente primero: vencidas/agotadas antes que las que solo están bajas.
        const urgencyA = a.isExpired ? -1000 : Math.min(a.disponibles, a.diasParaVencer ?? Infinity);
        const urgencyB = b.isExpired ? -1000 : Math.min(b.disponibles, b.diasParaVencer ?? Infinity);
        return urgencyA - urgencyB;
      });
  }

  return { getNextNcf, getNextNcfLegacy, getNextNcfAuthorized, getSequencesWarningSummary };
}

module.exports = { createNcfSequenceService, NCF_LABELS };

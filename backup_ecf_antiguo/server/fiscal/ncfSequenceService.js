// ══════════════════════════════════════════════════════════════════════════════
//  ncfSequenceService.js  —  Tecno Caja e-CF / DGII
//  Gestión de secuencias e-NCF por empresa, sucursal y caja.
//  Garantiza unicidad, sin duplicados, sin usar secuencias vencidas o agotadas.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const { writeFiscalAuditLog } = require('./fiscalExtensions');

// ── Tipos de e-CF válidos ─────────────────────────────────────────────────────
const ECF_TYPES = {
  'E31': { label: 'Crédito Fiscal',         code: '31' },
  'E32': { label: 'Consumidor Final',        code: '32' },
  'E33': { label: 'Nota de Débito',          code: '33' },
  'E34': { label: 'Nota de Crédito',         code: '34' },
  'E41': { label: 'Compras',                 code: '41' },
  'E43': { label: 'Gastos Menores',          code: '43' },
  'E44': { label: 'Regímenes Especiales',    code: '44' },
  'E45': { label: 'Gubernamental',           code: '45' },
  'E46': { label: 'Exportaciones',           code: '46' },
  'E47': { label: 'Pagos al Exterior',       code: '47' }
};

function isValidEcfType(tipo) {
  return Object.keys(ECF_TYPES).includes(String(tipo || '').toUpperCase().trim());
}

/**
 * Lista todas las secuencias de una empresa.
 */
async function listSequences(queryFn, businessId) {
  const rows = await queryFn(`
    SELECT fs.*,
           b.nombre  AS branch_name,
           cr.nombre AS cash_register_name
    FROM fiscal_sequences fs
    LEFT JOIN branches     b  ON b.id  = fs.branch_id
    LEFT JOIN cash_registers cr ON cr.id = fs.cash_register_id
    WHERE fs.business_id = ?
    ORDER BY fs.tipo_comprobante, fs.branch_id, fs.cash_register_id
  `, [businessId]);

  return rows.map(r => ({
    id:               r.id,
    businessId:       r.business_id,
    branchId:         r.branch_id,
    branchName:       r.branch_name || 'Global',
    cashRegisterId:   r.cash_register_id,
    cashRegisterName: r.cash_register_name || 'Global',
    tipoComprobante:  r.tipo_comprobante,
    label:            ECF_TYPES[r.tipo_comprobante]?.label || r.tipo_comprobante,
    prefijo:          r.prefijo,
    serie:            r.serie,
    desde:            r.desde,
    hasta:            r.hasta,
    proximo:          r.proximo,
    fechaAutorizacion: r.fecha_autorizacion,
    fechaVencimiento:  r.fecha_vencimiento,
    activo:           !!r.activo,
    isExpired:        r.fecha_vencimiento ? new Date(r.fecha_vencimiento) < new Date() : false,
    isExhausted:      r.proximo > r.hasta,
    remaining:        Math.max(0, r.hasta - r.proximo + 1),
    createdAt:        r.created_at
  }));
}

/**
 * Crea una nueva secuencia e-NCF.
 */
async function createSequence(queryFn, {
  businessId, branchId, cashRegisterId, tipoComprobante,
  prefijo, desde, hasta, fechaAutorizacion, fechaVencimiento,
  createdBy, userId, ipAddress
}) {
  const tipo = String(tipoComprobante || '').toUpperCase().trim();
  if (!isValidEcfType(tipo)) {
    const err = new Error(`Tipo de comprobante inválido: ${tipo}. Válidos: ${Object.keys(ECF_TYPES).join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const serie    = ECF_TYPES[tipo].code;
  const prefijoV = String(prefijo || 'E').slice(0, 3).toUpperCase();
  const desdeV   = Math.max(1, Number(desde) || 1);
  const hastaV   = Math.max(desdeV, Number(hasta) || 9999999999);
  const bId      = Number(branchId) || null;
  const crId     = Number(cashRegisterId) || null;
  const fechaAut = fechaAutorizacion || null;
  const fechaVen = fechaVencimiento || null;

  // Verificar duplicado — compatible SQLite y MySQL (no usa <=>)
  const existing = await queryFn(`
    SELECT id FROM fiscal_sequences
    WHERE business_id = ?
      AND (branch_id = ? OR (branch_id IS NULL AND ? IS NULL))
      AND (cash_register_id = ? OR (cash_register_id IS NULL AND ? IS NULL))
      AND tipo_comprobante = ?
      AND activo = 1
    LIMIT 1
  `, [businessId, bId, bId, crId, crId, tipo]);
  if (existing[0]) {
    const err = new Error(`Ya existe una secuencia activa de tipo ${tipo} para esa sucursal/caja.`);
    err.statusCode = 409;
    throw err;
  }

  const result = await queryFn(`
    INSERT INTO fiscal_sequences
      (business_id, branch_id, cash_register_id, tipo_comprobante, prefijo, serie,
       desde, hasta, proximo, fecha_autorizacion, fecha_vencimiento, activo, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `, [businessId, bId, crId, tipo, prefijoV, serie, desdeV, hastaV, desdeV, fechaAut, fechaVen, createdBy || null]);

  await writeFiscalAuditLog(queryFn, {
    businessId, userId,
    action: 'secuencia_ecf_creada',
    description: `Secuencia ${tipo} creada. Rango: ${desdeV}-${hastaV}. Sucursal: ${bId || 'Global'}`,
    ipAddress
  });

  return { id: result.insertId, tipo, prefijo: prefijoV, serie, desde: desdeV, hasta: hastaV };
}

/**
 * Actualiza una secuencia existente (solo si no ha sido usada extensivamente).
 */
async function updateSequence(queryFn, id, updates, { businessId, userId, ipAddress } = {}) {
  const rows = await queryFn('SELECT * FROM fiscal_sequences WHERE id = ? AND business_id = ?', [id, businessId]);
  if (!rows[0]) throw Object.assign(new Error('Secuencia no encontrada.'), { statusCode: 404 });
  const seq = rows[0];
  if (!seq.activo) throw Object.assign(new Error('No se puede modificar una secuencia inactiva.'), { statusCode: 409 });

  const allowedFields = ['hasta', 'fecha_vencimiento', 'fecha_autorizacion', 'proximo'];
  const setClauses    = [];
  const values        = [];

  for (const [k, v] of Object.entries(updates)) {
    if (!allowedFields.includes(k)) continue;
    if (k === 'proximo') {
      const nextValue = Math.max(1, Number(v) || 0);
      if (!nextValue) {
        throw Object.assign(new Error('El siguiente numero debe ser mayor que cero.'), { statusCode: 400 });
      }
      if (nextValue < Number(seq.proximo || 0)) {
        throw Object.assign(new Error('No se puede retroceder el siguiente numero de una secuencia ya utilizada.'), { statusCode: 409 });
      }
      if (nextValue > Number(seq.hasta || 0)) {
        throw Object.assign(new Error('El siguiente numero no puede superar el limite final de la secuencia.'), { statusCode: 400 });
      }
      if ((nextValue - Number(seq.proximo || 0)) > 1) {
        throw Object.assign(new Error('No se permiten saltos manuales mayores a un numero consecutivo.'), { statusCode: 409 });
      }
      setClauses.push(`${k} = ?`);
      values.push(nextValue);
      continue;
    }
    setClauses.push(`${k} = ?`);
    values.push(v);
  }
  if (!setClauses.length) return { ok: true, msg: 'Sin cambios.' };

  setClauses.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  await queryFn(`UPDATE fiscal_sequences SET ${setClauses.join(', ')} WHERE id = ?`, values);
  await writeFiscalAuditLog(queryFn, {
    businessId, userId,
    action: 'secuencia_ecf_modificada',
    description: `Secuencia ID ${id} modificada: ${JSON.stringify(updates)}`,
    ipAddress
  });
  return { ok: true };
}

/**
 * Desactiva una secuencia. Las usadas nunca se eliminan.
 */
async function disableSequence(queryFn, id, { businessId, userId, ipAddress } = {}) {
  const rows = await queryFn('SELECT * FROM fiscal_sequences WHERE id = ? AND business_id = ?', [id, businessId]);
  if (!rows[0]) throw Object.assign(new Error('Secuencia no encontrada.'), { statusCode: 404 });

  await queryFn('UPDATE fiscal_sequences SET activo = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  await writeFiscalAuditLog(queryFn, {
    businessId, userId,
    action: 'secuencia_ecf_desactivada',
    description: `Secuencia ID ${id} (${rows[0].tipo_comprobante}) desactivada.`,
    ipAddress
  });
  return { ok: true };
}

/**
 * Reserva el próximo e-NCF de forma atómica (usa UPDATE ... LIMIT 1 + SELECT).
 * ¡NUNCA llamar fuera de una transacción para evitar duplicados!
 * @param {Object} conn  — conexión de BD (con .query())
 * @returns {{ encf, sequenceId, proximo }}
 */
async function reserveNextENCF(conn, { businessId, branchId, cashRegisterId, tipoComprobante }) {
  const tipo    = String(tipoComprobante || '').toUpperCase().trim();
  const bId     = Number(branchId) || null;
  const crId    = Number(cashRegisterId) || null;
  const today   = new Date().toISOString().split('T')[0]; // YYYY-MM-DD, compatible SQLite + MySQL
  const isMySQL = String(process.env.DB_CLIENT || 'sqlite').trim().toLowerCase() === 'mysql';

  // Buscar secuencia disponible (prioridad: caja > sucursal > global)
  const sql = `
    SELECT * FROM fiscal_sequences
    WHERE business_id = ?
      AND tipo_comprobante = ?
      AND activo = 1
      AND proximo <= hasta
      AND (fecha_vencimiento IS NULL OR fecha_vencimiento >= ?)
      AND (
            (cash_register_id = ?)
         OR (cash_register_id IS NULL AND branch_id = ?)
         OR (cash_register_id IS NULL AND branch_id IS NULL)
      )
    ORDER BY
      CASE
        WHEN cash_register_id = ?    THEN 0
        WHEN branch_id = ?           THEN 1
        ELSE                              2
      END
    LIMIT 1
    ${isMySQL ? 'FOR UPDATE' : ''}
  `;
  const rows = await conn.query(sql, [businessId, tipo, today, crId, bId, crId, bId]);

  if (!rows[0]) {
    const err = new Error(`Sin secuencia e-NCF disponible para tipo ${tipo}. Crea o reactiva una secuencia en Configuración Fiscal.`);
    err.statusCode = 409;
    throw err;
  }

  const seq    = rows[0];
  const numero = seq.proximo;
  const encf   = buildENCF(seq.prefijo, seq.serie, numero);

  // Reservar (incrementar proximo)
  await conn.query(
    'UPDATE fiscal_sequences SET proximo = proximo + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [seq.id]
  );

  return { encf, sequenceId: seq.id, proximo: numero };
}

/**
 * Construye el e-NCF en formato DGII: [prefijo][tipo][numero_10_digits]
 * Ejemplo: E3100000000001
 */
function buildENCF(prefijo, serie, numero) {
  return `${prefijo}${serie}${String(numero).padStart(10, '0')}`;
}

/**
 * Valida que un e-NCF no esté ya registrado (anti-duplicado).
 */
async function preventDuplicateENCF(queryFn, businessId, encf) {
  const rows = await queryFn(
    'SELECT id FROM ecf_documents WHERE business_id = ? AND encf = ? LIMIT 1',
    [businessId, encf]
  );
  if (rows[0]) {
    const err = new Error(`El e-NCF ${encf} ya existe. No se pueden emitir e-NCF duplicados.`);
    err.statusCode = 409;
    throw err;
  }
}

/**
 * Determina el tipo de e-CF según las características de la venta.
 */
function selectEcfType({ clientRnc, isDebitNote, isCreditNote, isReturn, isPurchase }) {
  if (isDebitNote)  return 'E33';
  if (isCreditNote || isReturn) return 'E34';
  if (isPurchase)              return 'E41';
  if (clientRnc)               return 'E31';
  return 'E32';
}

module.exports = {
  ECF_TYPES,
  listSequences,
  createSequence,
  updateSequence,
  disableSequence,
  reserveNextENCF,
  buildENCF,
  preventDuplicateENCF,
  selectEcfType,
};

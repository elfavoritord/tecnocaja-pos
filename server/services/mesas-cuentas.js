'use strict';
const crypto = require('crypto');
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
async function ensure(query, addColumnIfMissing) {
  if (addColumnIfMissing) {
    await addColumnIfMissing('sales', 'mesas_mesero_nombre', 'VARCHAR(100) DEFAULT NULL');
    // Anticipo de reserva descontado en la venta (server/services/mesas-anticipos.js).
    await addColumnIfMissing('sales', 'reserva_id', 'VARCHAR(80) DEFAULT NULL');
    await addColumnIfMissing('sales', 'reserva_anticipo', 'DECIMAL(12,2) DEFAULT NULL');
  }
  await query(`CREATE TABLE IF NOT EXISTS mesas_cuentas (id VARCHAR(80) PRIMARY KEY,
    branch_id INTEGER NOT NULL, elemento_id VARCHAR(80) NOT NULL, nombre VARCHAR(100) NOT NULL,
    version INTEGER NOT NULL DEFAULT 0, estado VARCHAR(20) NOT NULL DEFAULT 'abierta',
    draft_json LONGTEXT NOT NULL, user_id INTEGER NOT NULL, sale_id INTEGER DEFAULT NULL,
    updated_at VARCHAR(40) NOT NULL)`);
  await query(`CREATE TABLE IF NOT EXISTS mesas_meseros (id VARCHAR(80) PRIMARY KEY,
    branch_id INTEGER NOT NULL, nombre VARCHAR(100) NOT NULL, telefono VARCHAR(40) NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1)`);
}
function validarDraft(draft) {
  if (!draft || !Array.isArray(draft.items) || draft.items.length > 2000) throw fail('Consumo inválido.', 400);
  for (const item of draft.items) {
    if (!Number.isFinite(Number(item.qty)) || Number(item.qty) <= 0 || !Number.isFinite(Number(item.precio)) || Number(item.precio) < 0) throw fail('Cantidad o precio inválido.', 400);
  }
  if (JSON.stringify(draft).length > 500000) throw fail('La cuenta supera el tamaño admitido.', 400);
  return draft;
}
// Se ejecuta DENTRO de la transacción de venta existente, tras su lock de caja.
async function validarCobro(conn, sale, branchId) {
  if (!sale.mesasCuenta) return null;
  const { id, version } = sale.mesasCuenta;
  const rows = await conn.query('SELECT * FROM mesas_cuentas WHERE id = ? AND branch_id = ?', [id, branchId]);
  const row = rows[0];
  if (!row || row.estado !== 'abierta' || Number(row.version) !== version) throw fail('La cuenta cambió o ya fue cobrada. Recarga MESAS.');
  const draft = JSON.parse(row.draft_json);
  // Cuenta abierta al llegar el cliente de una reserva (su anticipo se descuenta al cobrar).
  row.reservaId = typeof draft.reservaId === 'string' && draft.reservaId ? draft.reservaId.slice(0, 80) : null;
  if (draft.meseroId) {
    const meseros = await conn.query('SELECT nombre FROM mesas_meseros WHERE id = ? AND branch_id = ?', [draft.meseroId, branchId]);
    row.meseroNombre = meseros[0]?.nombre || '';
  }
  const resumen = (items) => items.map((i) => [Number(i.id), Number(i.qty), Number(i.precio), Number(i.descuento || 0)]);
  if (JSON.stringify(resumen(draft.items)) !== JSON.stringify(resumen(sale.items))) throw fail('Guarda los cambios de consumo antes de cobrar.');
  if (sale.pendienteCobro || ['contra_entrega'].includes(sale.metodo)) throw fail('Esta cuenta requiere un cobro confirmado desde la caja.');
  const result = await conn.query("UPDATE mesas_cuentas SET estado = 'cobrando', version = version + 1 WHERE id = ? AND version = ? AND estado = 'abierta'", [id, version]);
  if (Number(result.affectedRows ?? result.rowsAffected) !== 1) throw fail('Otra caja está cobrando esta cuenta.');
  return row;
}
module.exports = { ensure, validarDraft, validarCobro, fail, nuevoId: () => crypto.randomUUID() };

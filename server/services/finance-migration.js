'use strict';
// Columnas y tablas de las nueve mejoras financieras. Todo es aditivo
// (nullable o con default): las instalaciones existentes conservan sus datos.
async function ensureFinanceColumns(addColumnIfMissing) {
  for (const [name, type] of Object.entries({
    legal_tip_amount: 'DECIMAL(12,2) NOT NULL DEFAULT 0', consumed_here: 'TINYINT(1) NOT NULL DEFAULT 0',
    financial_version: 'INT NOT NULL DEFAULT 0',
    cash_amount: 'DECIMAL(12,2) DEFAULT NULL', card_amount: 'DECIMAL(12,2) DEFAULT NULL',
    transfer_amount: 'DECIMAL(12,2) DEFAULT NULL', credit_amount: 'DECIMAL(12,2) NOT NULL DEFAULT 0',
    credit_adjustment: 'DECIMAL(12,2) NOT NULL DEFAULT 0', credit_due_date: 'DATE DEFAULT NULL', payment_details: 'TEXT DEFAULT NULL',
    // Estado real de cobros que no son efectivo: una tarjeta queda "aprobada"
    // por el verifón y se puede marcar reversada; una transferencia queda
    // pendiente hasta que alguien la confirme contra el banco.
    card_status: 'VARCHAR(20) DEFAULT NULL', transfer_status: 'VARCHAR(20) DEFAULT NULL',
    transfer_confirmed_by: 'VARCHAR(120) DEFAULT NULL', transfer_confirmed_at: 'DATETIME DEFAULT NULL',
    // Turno en el que se recibió el efectivo de un contra entrega.
    delivery_cash_session_id: 'INT DEFAULT NULL',
    // Cancelación: cómo se trató el dinero ('efectivo' = salió de la caja con
    // su movimiento; 'sin_reembolso' = se quedó; 'devolucion' = lo resolvió la
    // nota de crédito). NULL = cancelación anterior a este cambio.
    cancel_refund_mode: 'VARCHAR(20) DEFAULT NULL', cancel_cash_movement_id: 'INT DEFAULT NULL',
  })) await addColumnIfMissing('sales', name, type);
  await addColumnIfMissing('config', 'legal_tip_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
  // A qué productos se aplica: 'todos' (lo normal en un restaurante: todo lo
  // que se consume en el local) o 'marcados' (solo los productos marcados).
  await addColumnIfMissing('config', 'legal_tip_scope', "VARCHAR(20) NOT NULL DEFAULT 'todos'");
  // Política del negocio (la ley no fija un mínimo): cobrarla solo desde un
  // consumo, sin ITBIS. 0 = siempre.
  await addColumnIfMissing('config', 'legal_tip_min_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  // El cajero quitó la propina en esa venta (queda en la venta y en la auditoría).
  await addColumnIfMissing('sales', 'legal_tip_waived', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('sales', 'legal_tip_waived_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
}

// Cierre seguro, arqueos y aperturas de gaveta (mejoras 8 y 9).
async function ensureCajaSegura(query, addColumnIfMissing) {
  await query(`
    CREATE TABLE IF NOT EXISTS cash_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count_uuid VARCHAR(64) NOT NULL,
      cash_session_id INT NOT NULL,
      branch_id INT DEFAULT NULL,
      cash_register_id INT DEFAULT NULL,
      kind VARCHAR(20) NOT NULL DEFAULT 'arqueo',
      denominations_json TEXT NOT NULL,
      counted_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      expected_amount DECIMAL(12,2) DEFAULT NULL,
      difference_amount DECIMAL(12,2) DEFAULT NULL,
      notes VARCHAR(255) DEFAULT NULL,
      counted_by_user_id INT DEFAULT NULL,
      counted_by_user_name VARCHAR(120) DEFAULT NULL,
      device_id VARCHAR(160) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query('CREATE UNIQUE INDEX idx_cash_counts_uuid ON cash_counts (count_uuid)').catch(ignoreDuplicateIndex);
  await query('CREATE INDEX idx_cash_counts_session ON cash_counts (cash_session_id)').catch(ignoreDuplicateIndex);

  await query(`
    CREATE TABLE IF NOT EXISTS cash_drawer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_uuid VARCHAR(64) NOT NULL,
      cash_session_id INT DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      cash_register_id INT DEFAULT NULL,
      device_id VARCHAR(160) DEFAULT NULL,
      user_id INT DEFAULT NULL,
      user_name VARCHAR(120) DEFAULT NULL,
      origin VARCHAR(20) NOT NULL DEFAULT 'manual',
      reason VARCHAR(30) NOT NULL,
      description VARCHAR(500) DEFAULT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      cash_in DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      cash_out DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      destination VARCHAR(160) DEFAULT NULL,
      responsible VARCHAR(160) DEFAULT NULL,
      evidence VARCHAR(255) DEFAULT NULL,
      cash_movement_id INT DEFAULT NULL,
      cash_count_id INT DEFAULT NULL,
      sale_ref VARCHAR(60) DEFAULT NULL,
      items_json TEXT DEFAULT NULL,
      drawer_requested TINYINT(1) NOT NULL DEFAULT 1,
      drawer_status VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      drawer_error VARCHAR(255) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query('CREATE UNIQUE INDEX idx_drawer_events_uuid ON cash_drawer_events (event_uuid)').catch(ignoreDuplicateIndex);
  await query('CREATE INDEX idx_drawer_events_session ON cash_drawer_events (cash_session_id)').catch(ignoreDuplicateIndex);

  await addColumnIfMissing('config', 'secure_cash_close', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('cash_closings', 'denominations_json', 'TEXT DEFAULT NULL');
  await addColumnIfMissing('cash_closings', 'report_json', 'LONGTEXT DEFAULT NULL');
  await addColumnIfMissing('cash_closings', 'secure_mode', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('cash_closings', 'card_terminal_total', 'DECIMAL(12,2) DEFAULT NULL');
  await addColumnIfMissing('sale_returns', 'cash_session_id', 'INT DEFAULT NULL');
  await addColumnIfMissing('sale_returns', 'restock', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('sale_returns', 'tax_returned', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('sale_returns', 'legal_tip_returned', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('sale_returns', 'adjustment_kind', 'VARCHAR(30) DEFAULT NULL');
  await addColumnIfMissing('sale_returns', 'fiscal_document', 'VARCHAR(40) DEFAULT NULL');
  // Notas de crédito (mejora 4): reintento sin duplicar, cómo se devolvió el
  // dinero y si el ITBIS se puede rebajar (más de 30 días: no).
  await addColumnIfMissing('sale_returns', 'request_id', 'VARCHAR(100) DEFAULT NULL');
  await addColumnIfMissing('sale_returns', 'refund_breakdown', 'TEXT DEFAULT NULL');
  await addColumnIfMissing('sale_returns', 'tax_affects', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('sale_return_items', 'restocked', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing('sale_return_items', 'net_amount', 'DECIMAL(12,2) DEFAULT NULL');
  await addColumnIfMissing('sale_return_items', 'tax_rate', 'DECIMAL(6,2) DEFAULT NULL');
  await addColumnIfMissing('sale_return_items', 'tax_amount', 'DECIMAL(12,2) DEFAULT NULL');
  await addColumnIfMissing('sale_return_items', 'legal_tip_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await query('CREATE UNIQUE INDEX idx_sale_returns_request ON sale_returns (request_id)').catch(ignoreDuplicateIndex);
}

function ignoreDuplicateIndex(error) {
  if (!/already exists|duplicate key name/i.test(String(error?.message || ''))) throw error;
}

module.exports = { ensureFinanceColumns, ensureCajaSegura };

'use strict';
// Tablas y columnas de Compras de proveedores (fase A): borradores «Preparar
// compra», documento original, recepciones de mercancía, equivalencias con el
// proveedor e historial de costos. Todo se agrega sin borrar nada: las compras
// viejas siguen funcionando igual.

async function columnas(query, cliente, tabla) {
  const rows = cliente === 'mysql'
    ? await query(`SHOW COLUMNS FROM \`${tabla}\``).catch(() => [])
    : await query(`PRAGMA table_info(${tabla})`).catch(() => []);
  return rows.map((r) => ({
    nombre: String(r.name || r.Field || '').toLowerCase(),
    obligatorio: cliente === 'mysql' ? String(r.Null || '').toUpperCase() === 'NO' : Number(r.notnull) === 1,
  }));
}

async function agregarColumna(query, cliente, tabla, columna, definicion) {
  const existentes = await columnas(query, cliente, tabla);
  if (existentes.some((c) => c.nombre === columna.toLowerCase())) return;
  try {
    await query(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
  } catch (error) {
    const m = String(error?.message || '').toLowerCase();
    if (!m.includes('duplicate column')) throw error;
  }
}

async function indice(query, nombre, sql) {
  try { await query(sql); } catch (error) {
    const m = String(error?.message || '').toLowerCase();
    if (!m.includes('already exists') && !m.includes('duplicate key name')) throw error;
  }
  return nombre;
}

// purchase_items.product_id pasa a opcional: una línea de servicio o gasto de la
// factura no es un producto del catálogo. En SQLite hay que rehacer la tabla
// (con los mismos datos, dentro de una transacción).
async function productoOpcional(query, cliente, withTransaction) {
  const col = (await columnas(query, cliente, 'purchase_items')).find((c) => c.nombre === 'product_id');
  if (!col || !col.obligatorio) return false;
  if (cliente === 'mysql') {
    await query('ALTER TABLE purchase_items MODIFY product_id INT NULL');
    return true;
  }
  if (!withTransaction) return false; // se hace en el próximo arranque, con transacción
  const [tabla] = await query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'purchase_items'");
  const original = String(tabla?.sql || '');
  const nueva = original
    .replace(/CREATE TABLE\s+("?)purchase_items\1/i, 'CREATE TABLE purchase_items__nueva')
    .replace(/product_id\s+INT(EGER)?\s+NOT NULL/i, 'product_id INT DEFAULT NULL');
  if (nueva === original || !/purchase_items__nueva/.test(nueva) || /product_id\s+INT(EGER)?\s+NOT NULL/i.test(nueva)) {
    throw new Error('No se pudo preparar el cambio de purchase_items (product_id opcional).');
  }
  const nombres = (await columnas(query, cliente, 'purchase_items')).map((c) => c.nombre).join(', ');
  await withTransaction(async (conn) => {
    await conn.query('DROP TABLE IF EXISTS purchase_items__nueva');
    await conn.query(nueva);
    await conn.query(`INSERT INTO purchase_items__nueva (${nombres}) SELECT ${nombres} FROM purchase_items`);
    const [a] = await conn.query('SELECT COUNT(*) AS n FROM purchase_items');
    const [b] = await conn.query('SELECT COUNT(*) AS n FROM purchase_items__nueva');
    if (Number(a?.n) !== Number(b?.n)) throw new Error('La copia de purchase_items no coincide; no se cambia nada.');
    await conn.query('DROP TABLE purchase_items');
    await conn.query('ALTER TABLE purchase_items__nueva RENAME TO purchase_items');
  });
  return true;
}

async function ensureComprasFaseA(query, { getDbClient, withTransaction } = {}) {
  const cliente = typeof getDbClient === 'function' ? getDbClient() : 'sqlite';
  const col = (tabla, columna, definicion) => agregarColumna(query, cliente, tabla, columna, definicion);

  await query(`CREATE TABLE IF NOT EXISTS purchase_drafts (
    id VARCHAR(80) PRIMARY KEY,
    branch_id INT DEFAULT NULL,
    origen VARCHAR(20) NOT NULL DEFAULT 'manual',
    estado VARCHAR(20) NOT NULL DEFAULT 'borrador',
    titulo VARCHAR(200) DEFAULT NULL,
    payload_json LONGTEXT NOT NULL,
    avisos_json LONGTEXT DEFAULT NULL,
    version INT NOT NULL DEFAULT 0,
    purchase_id INT DEFAULT NULL,
    created_by_user_id INT DEFAULT NULL,
    created_by_user_name VARCHAR(120) DEFAULT NULL,
    updated_by_user_name VARCHAR(120) DEFAULT NULL,
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40) NOT NULL
  )`);
  await query(`CREATE TABLE IF NOT EXISTS purchase_documents (
    id VARCHAR(80) PRIMARY KEY,
    draft_id VARCHAR(80) DEFAULT NULL,
    purchase_id INT DEFAULT NULL,
    nombre VARCHAR(200) NOT NULL,
    tipo VARCHAR(80) NOT NULL,
    tamano INT NOT NULL DEFAULT 0,
    sha256 VARCHAR(64) NOT NULL,
    contenido LONGTEXT DEFAULT NULL,
    extraccion_json LONGTEXT DEFAULT NULL,
    version_extractor VARCHAR(40) DEFAULT NULL,
    created_by_user_name VARCHAR(120) DEFAULT NULL,
    created_at VARCHAR(40) NOT NULL
  )`);
  await query(`CREATE TABLE IF NOT EXISTS purchase_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid VARCHAR(80) NOT NULL,
    purchase_id INT NOT NULL,
    branch_id INT DEFAULT NULL,
    notas VARCHAR(300) DEFAULT NULL,
    cierra_con_diferencia INT NOT NULL DEFAULT 0,
    created_by_user_id INT DEFAULT NULL,
    created_by_user_name VARCHAR(120) DEFAULT NULL,
    created_at VARCHAR(40) NOT NULL
  )`);
  await query(`CREATE TABLE IF NOT EXISTS purchase_receipt_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id INT NOT NULL,
    purchase_item_id INT NOT NULL,
    product_id INT DEFAULT NULL,
    cantidad DECIMAL(12,3) NOT NULL,
    diferencia DECIMAL(12,3) NOT NULL DEFAULT 0
  )`);
  await query(`CREATE TABLE IF NOT EXISTS product_supplier_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INT NOT NULL,
    clave VARCHAR(220) NOT NULL,
    codigo_proveedor VARCHAR(80) DEFAULT NULL,
    descripcion_normalizada VARCHAR(200) DEFAULT NULL,
    product_id INT NOT NULL,
    unidad VARCHAR(40) DEFAULT NULL,
    updated_at VARCHAR(40) NOT NULL
  )`);
  await query(`CREATE TABLE IF NOT EXISTS product_cost_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INT NOT NULL,
    supplier_id INT DEFAULT NULL,
    purchase_id INT DEFAULT NULL,
    branch_id INT DEFAULT NULL,
    costo_anterior DECIMAL(12,2) DEFAULT NULL,
    costo_nuevo DECIMAL(12,2) NOT NULL,
    created_at VARCHAR(40) NOT NULL
  )`);

  await col('purchases', 'uuid', 'VARCHAR(80) DEFAULT NULL');
  await col('purchases', 'estado_inventario', "VARCHAR(30) NOT NULL DEFAULT 'recibido_total'");
  await col('purchases', 'documento_origen', "VARCHAR(20) NOT NULL DEFAULT 'manual'");
  await col('purchases', 'encf_proveedor', 'VARCHAR(30) DEFAULT NULL');
  await col('purchases', 'codigo_seguridad', 'VARCHAR(20) DEFAULT NULL');
  await col('purchases', 'ajuste_redondeo', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00');
  await col('purchase_items', 'tipo_linea', 'VARCHAR(20) DEFAULT NULL');
  await col('purchase_items', 'descripcion', 'VARCHAR(200) DEFAULT NULL');
  await col('purchase_items', 'unidad', 'VARCHAR(40) DEFAULT NULL');
  await col('purchase_items', 'codigo_proveedor', 'VARCHAR(80) DEFAULT NULL');
  await col('purchase_items', 'descuento', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00');
  await col('purchase_items', 'controla_inventario', 'INT DEFAULT NULL');
  await col('purchase_items', 'cantidad_recibida', 'DECIMAL(12,3) DEFAULT NULL');
  await col('purchase_items', 'producto_creado', 'INT NOT NULL DEFAULT 0');
  await col('config', 'compras_modo_recepcion', "VARCHAR(20) NOT NULL DEFAULT 'automatica'");
  await col('config', 'compras_margen_defecto', 'DECIMAL(6,2) DEFAULT NULL');
  await col('config', 'compras_tipo_margen', "VARCHAR(10) NOT NULL DEFAULT 'costo'");
  await col('config', 'compras_precio_modo', "VARCHAR(10) NOT NULL DEFAULT 'base'");
  // Compras que registra el contador desde su portal (fase C). El negocio lo puede apagar.
  await col('config', 'compras_contador_permitido', 'INT NOT NULL DEFAULT 1');

  await indice(query, 'idx_purchases_uuid', 'CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_uuid ON purchases (uuid)');
  await indice(query, 'idx_purchase_receipts_uuid', 'CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_receipts_uuid ON purchase_receipts (uuid)');
  await indice(query, 'idx_psc_clave', 'CREATE UNIQUE INDEX IF NOT EXISTS idx_psc_clave ON product_supplier_codes (supplier_id, clave)');
  await indice(query, 'idx_pdoc_sha', 'CREATE INDEX IF NOT EXISTS idx_pdoc_sha ON purchase_documents (sha256)');
  await indice(query, 'idx_pdrafts_estado', 'CREATE INDEX IF NOT EXISTS idx_pdrafts_estado ON purchase_drafts (estado, branch_id)');

  await productoOpcional(query, cliente, withTransaction);
}

module.exports = { ensureComprasFaseA, productoOpcional, columnas };

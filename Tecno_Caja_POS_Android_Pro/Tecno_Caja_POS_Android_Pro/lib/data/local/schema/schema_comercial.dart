import 'sync_columns.dart';

/// Clientes, proveedores, compras y cuentas por cobrar/pagar.
class SchemaComercial {
  const SchemaComercial._();

  static const String clientes = '''
    CREATE TABLE IF NOT EXISTS clientes (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      telefono TEXT,
      whatsapp TEXT,
      email TEXT,
      direccion TEXT,
      cedula_rnc TEXT,
      tipo_comprobante_preferido TEXT,
      limite_credito REAL NOT NULL DEFAULT 0,
      balance REAL NOT NULL DEFAULT 0,
      notas TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      ${SyncColumns.full}
    )
  ''';

  static const String clientePagos = '''
    CREATE TABLE IF NOT EXISTS cliente_pagos (
      id TEXT PRIMARY KEY,
      cliente_id TEXT NOT NULL,
      venta_id TEXT,
      monto REAL NOT NULL,
      metodo_pago TEXT NOT NULL,
      fecha_pago TEXT NOT NULL,
      nota TEXT,
      ${SyncColumns.full}
    )
  ''';

  static const String proveedores = '''
    CREATE TABLE IF NOT EXISTS proveedores (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      empresa_proveedora TEXT,
      telefono TEXT,
      email TEXT,
      rnc TEXT,
      contacto TEXT,
      direccion TEXT,
      dias_visita TEXT,
      terminos_pago_dias INTEGER,
      activo INTEGER NOT NULL DEFAULT 1,
      ${SyncColumns.full}
    )
  ''';

  static const String compras = '''
    CREATE TABLE IF NOT EXISTS compras (
      id TEXT PRIMARY KEY,
      proveedor_id TEXT NOT NULL,
      numero_factura TEXT,
      fecha_emision TEXT NOT NULL,
      fecha_vencimiento TEXT,
      monto_total REAL NOT NULL DEFAULT 0,
      monto_pagado REAL NOT NULL DEFAULT 0,
      monto_pendiente REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      documento_path TEXT,
      recibida INTEGER NOT NULL DEFAULT 0,
      ${SyncColumns.full}
    )
  ''';

  static const String compraItems = '''
    CREATE TABLE IF NOT EXISTS compra_items (
      id TEXT PRIMARY KEY,
      compra_id TEXT NOT NULL,
      producto_id TEXT NOT NULL,
      cantidad REAL NOT NULL,
      costo_unitario REAL NOT NULL,
      subtotal REAL NOT NULL,
      ${SyncColumns.full}
    )
  ''';

  static const String proveedorPagos = '''
    CREATE TABLE IF NOT EXISTS proveedor_pagos (
      id TEXT PRIMARY KEY,
      proveedor_id TEXT NOT NULL,
      compra_id TEXT,
      monto REAL NOT NULL,
      metodo_pago TEXT NOT NULL,
      fecha_pago TEXT NOT NULL,
      nota TEXT,
      ${SyncColumns.full}
    )
  ''';

  static List<String> indexes() => [
        ...SyncColumns.commonIndexes('clientes'),
        'CREATE INDEX IF NOT EXISTS idx_clientes_nombre ON clientes(nombre)',
        'CREATE INDEX IF NOT EXISTS idx_cliente_pagos_cliente ON cliente_pagos(cliente_id)',
        ...SyncColumns.commonIndexes('proveedores'),
        'CREATE INDEX IF NOT EXISTS idx_compras_proveedor ON compras(proveedor_id)',
        'CREATE INDEX IF NOT EXISTS idx_compras_estado ON compras(estado)',
        'CREATE INDEX IF NOT EXISTS idx_compra_items_compra ON compra_items(compra_id)',
        'CREATE INDEX IF NOT EXISTS idx_proveedor_pagos_proveedor ON proveedor_pagos(proveedor_id)',
      ];

  static List<String> all() => [
        clientes,
        clientePagos,
        proveedores,
        compras,
        compraItems,
        proveedorPagos,
        ...indexes(),
      ];
}

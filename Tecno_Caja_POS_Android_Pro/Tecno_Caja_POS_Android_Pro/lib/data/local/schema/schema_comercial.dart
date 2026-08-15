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
      nombre_comercial TEXT,
      estado_dgii TEXT,
      tipo_contribuyente TEXT,
      categoria_dgii TEXT,
      dgii_consultado_en TEXT,
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

  static const String gastosOperativos = '''
    CREATE TABLE IF NOT EXISTS gastos_operativos (
      id TEXT PRIMARY KEY,
      proveedor_id TEXT,
      categoria TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      ncf TEXT,
      fecha_comprobante TEXT NOT NULL,
      monto_total REAL NOT NULL DEFAULT 0,
      itbis REAL NOT NULL DEFAULT 0,
      metodo_pago TEXT NOT NULL DEFAULT 'efectivo',
      estado TEXT NOT NULL DEFAULT 'registrado',
      documento_path TEXT,
      ${SyncColumns.full}
    )
  ''';

  static const String clienteSeguimientos = '''
    CREATE TABLE IF NOT EXISTS cliente_seguimientos (
      id TEXT PRIMARY KEY,
      cliente_id TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'nota',
      titulo TEXT NOT NULL,
      detalle TEXT,
      fecha_programada TEXT,
      completado INTEGER NOT NULL DEFAULT 0,
      completado_en TEXT,
      ${SyncColumns.full}
    )
  ''';

  static List<String> indexes() => [
        ...SyncColumns.commonIndexes('clientes'),
        'CREATE INDEX IF NOT EXISTS idx_clientes_nombre ON clientes(nombre)',
        'CREATE INDEX IF NOT EXISTS idx_clientes_documento ON clientes(empresa_id, cedula_rnc)',
        'CREATE INDEX IF NOT EXISTS idx_cliente_pagos_cliente ON cliente_pagos(cliente_id)',
        ...SyncColumns.commonIndexes('proveedores'),
        'CREATE INDEX IF NOT EXISTS idx_compras_proveedor ON compras(proveedor_id)',
        'CREATE INDEX IF NOT EXISTS idx_compras_estado ON compras(estado)',
        'CREATE INDEX IF NOT EXISTS idx_compra_items_compra ON compra_items(compra_id)',
        'CREATE INDEX IF NOT EXISTS idx_proveedor_pagos_proveedor ON proveedor_pagos(proveedor_id)',
        'CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos_operativos(fecha_comprobante)',
        'CREATE INDEX IF NOT EXISTS idx_gastos_categoria ON gastos_operativos(categoria)',
        ...SyncColumns.commonIndexes('gastos_operativos'),
        'CREATE INDEX IF NOT EXISTS idx_cliente_seguimientos_cliente ON cliente_seguimientos(cliente_id)',
        'CREATE INDEX IF NOT EXISTS idx_cliente_seguimientos_programada ON cliente_seguimientos(fecha_programada)',
        ...SyncColumns.commonIndexes('cliente_seguimientos'),
      ];

  static List<String> all() => [
        clientes,
        clientePagos,
        proveedores,
        compras,
        compraItems,
        proveedorPagos,
        gastosOperativos,
        clienteSeguimientos,
        ...indexes(),
      ];
}

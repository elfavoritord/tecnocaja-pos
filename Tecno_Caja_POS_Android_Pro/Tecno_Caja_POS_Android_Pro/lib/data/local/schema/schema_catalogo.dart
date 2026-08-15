import 'sync_columns.dart';

/// Catalogo: categorias, productos y todo lo relacionado a inventario.
class SchemaCatalogo {
  const SchemaCatalogo._();

  static const String categorias = '''
    CREATE TABLE IF NOT EXISTS categorias (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      color TEXT,
      icono TEXT,
      orden INTEGER NOT NULL DEFAULT 0,
      activa INTEGER NOT NULL DEFAULT 1,
      ${SyncColumns.full}
    )
  ''';

  static const String productos = '''
    CREATE TABLE IF NOT EXISTS productos (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      descripcion TEXT,
      sku TEXT,
      plu TEXT,
      codigo_barras TEXT,
      categoria_id TEXT,
      marca TEXT,
      unidad_medida TEXT NOT NULL DEFAULT 'unidad',
      es_paquete INTEGER NOT NULL DEFAULT 0,
      contenido_paquete REAL,
      precio_compra REAL NOT NULL DEFAULT 0,
      precio_venta REAL NOT NULL DEFAULT 0,
      precio_minimo REAL,
      tasa_itbis REAL NOT NULL DEFAULT 0.18,
      itbis_incluido INTEGER NOT NULL DEFAULT 1,
      impuestos_adicionales_json TEXT,
      imagen_path TEXT,
      stock_minimo REAL NOT NULL DEFAULT 0,
      proveedor_id TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      favorito INTEGER NOT NULL DEFAULT 0,
      es_compuesto INTEGER NOT NULL DEFAULT 0,
      tiene_variantes INTEGER NOT NULL DEFAULT 0,
      tiene_lotes INTEGER NOT NULL DEFAULT 0,
      controla_vencimiento INTEGER NOT NULL DEFAULT 0,
      laboratorio TEXT,
      principio_activo TEXT,
      presentacion TEXT,
      concentracion TEXT,
      registro_sanitario TEXT,
      es_controlado INTEGER NOT NULL DEFAULT 0,
      ubicacion TEXT,
      ${SyncColumns.full}
    )
  ''';

  static const String productoVariantes = '''
    CREATE TABLE IF NOT EXISTS producto_variantes (
      id TEXT PRIMARY KEY,
      producto_id TEXT NOT NULL,
      tipo TEXT NOT NULL,
      valor TEXT NOT NULL,
      sku_variante TEXT,
      codigo_barras_variante TEXT,
      precio_venta_override REAL,
      activo INTEGER NOT NULL DEFAULT 1,
      ${SyncColumns.full}
    )
  ''';

  static const String productoLotes = '''
    CREATE TABLE IF NOT EXISTS producto_lotes (
      id TEXT PRIMARY KEY,
      producto_id TEXT NOT NULL,
      numero_lote TEXT,
      fecha_fabricacion TEXT,
      fecha_vencimiento TEXT,
      cantidad REAL NOT NULL DEFAULT 0,
      costo_unitario REAL,
      proveedor_id TEXT,
      ${SyncColumns.full}
    )
  ''';

  static const String ventaItemLotes = '''
    CREATE TABLE IF NOT EXISTS venta_item_lotes (
      id TEXT PRIMARY KEY,
      venta_id TEXT NOT NULL,
      venta_item_id TEXT NOT NULL,
      producto_id TEXT NOT NULL,
      lote_id TEXT NOT NULL,
      numero_lote TEXT,
      fecha_vencimiento TEXT,
      cantidad REAL NOT NULL,
      revertido INTEGER NOT NULL DEFAULT 0,
      ${SyncColumns.full}
    )
  ''';

  static const String productoComponentes = '''
    CREATE TABLE IF NOT EXISTS producto_componentes (
      id TEXT PRIMARY KEY,
      producto_padre_id TEXT NOT NULL,
      producto_componente_id TEXT NOT NULL,
      cantidad REAL NOT NULL DEFAULT 1,
      ${SyncColumns.full}
    )
  ''';

  /// Stock real por sucursal (fuente de verdad), igual de espiritu a
  /// inventory_by_branch del backend Windows.
  static const String inventarioSucursal = '''
    CREATE TABLE IF NOT EXISTS inventario_sucursal (
      id TEXT PRIMARY KEY,
      producto_id TEXT NOT NULL,
      stock REAL NOT NULL DEFAULT 0,
      stock_minimo REAL NOT NULL DEFAULT 0,
      ubicacion TEXT,
      ${SyncColumns.full}
    )
  ''';

  /// Kardex: todo cambio de stock queda como movimiento, nunca se pisa la
  /// cantidad directamente (evita descuentos dobles y permite auditoria).
  static const String movimientosInventario = '''
    CREATE TABLE IF NOT EXISTS movimientos_inventario (
      id TEXT PRIMARY KEY,
      producto_id TEXT NOT NULL,
      tipo_movimiento TEXT NOT NULL,
      cantidad REAL NOT NULL,
      stock_anterior REAL NOT NULL,
      stock_nuevo REAL NOT NULL,
      costo_unitario REAL,
      referencia_tipo TEXT,
      referencia_id TEXT,
      sucursal_origen_id TEXT,
      sucursal_destino_id TEXT,
      nota TEXT,
      ${SyncColumns.full}
    )
  ''';

  static List<String> indexes() => [
        'CREATE INDEX IF NOT EXISTS idx_productos_codigo_barras ON productos(codigo_barras)',
        'CREATE INDEX IF NOT EXISTS idx_productos_sku ON productos(sku)',
        'CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(categoria_id)',
        'CREATE INDEX IF NOT EXISTS idx_productos_activo ON productos(activo)',
        ...SyncColumns.commonIndexes('productos'),
        'CREATE INDEX IF NOT EXISTS idx_variantes_producto ON producto_variantes(producto_id)',
        'CREATE INDEX IF NOT EXISTS idx_lotes_producto ON producto_lotes(producto_id)',
        'CREATE INDEX IF NOT EXISTS idx_lotes_vencimiento ON producto_lotes(fecha_vencimiento)',
        ...SyncColumns.commonIndexes('producto_lotes'),
        'CREATE INDEX IF NOT EXISTS idx_venta_item_lotes_venta ON venta_item_lotes(venta_id)',
        'CREATE INDEX IF NOT EXISTS idx_venta_item_lotes_item ON venta_item_lotes(venta_item_id)',
        'CREATE INDEX IF NOT EXISTS idx_venta_item_lotes_lote ON venta_item_lotes(lote_id)',
        ...SyncColumns.commonIndexes('venta_item_lotes'),
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_inventario_producto_sucursal ON inventario_sucursal(producto_id, sucursal_id)',
        'CREATE INDEX IF NOT EXISTS idx_movimientos_producto ON movimientos_inventario(producto_id)',
        'CREATE INDEX IF NOT EXISTS idx_movimientos_sucursal ON movimientos_inventario(sucursal_id)',
        ...SyncColumns.commonIndexes('categorias'),
      ];

  static List<String> all() => [
        categorias,
        productos,
        productoVariantes,
        productoLotes,
        ventaItemLotes,
        productoComponentes,
        inventarioSucursal,
        movimientosInventario,
        ...indexes(),
      ];
}

import 'sync_columns.dart';

/// Ofertas y promociones.
class SchemaMarketing {
  const SchemaMarketing._();

  static const String ofertas = '''
    CREATE TABLE IF NOT EXISTS ofertas (
      id TEXT PRIMARY KEY,
      codigo_interno TEXT,
      nombre TEXT NOT NULL,
      tipo TEXT NOT NULL,
      valor_descuento REAL,
      cantidad_minima REAL,
      cantidad_regalo REAL,
      fecha_inicio TEXT,
      fecha_fin TEXT,
      hora_inicio TEXT,
      hora_fin TEXT,
      dias_semana_json TEXT,
      categoria_id TEXT,
      acumulable INTEGER NOT NULL DEFAULT 0,
      exclusiva INTEGER NOT NULL DEFAULT 0,
      prioridad INTEGER NOT NULL DEFAULT 0,
      activa INTEGER NOT NULL DEFAULT 1,
      ${SyncColumns.full}
    )
  ''';

  static const String ofertaProductos = '''
    CREATE TABLE IF NOT EXISTS oferta_productos (
      id TEXT PRIMARY KEY,
      oferta_id TEXT NOT NULL,
      producto_id TEXT NOT NULL,
      ${SyncColumns.full}
    )
  ''';

  static List<String> indexes() => [
        ...SyncColumns.commonIndexes('ofertas'),
        'CREATE INDEX IF NOT EXISTS idx_ofertas_activa ON ofertas(activa)',
        'CREATE INDEX IF NOT EXISTS idx_oferta_productos_oferta ON oferta_productos(oferta_id)',
        'CREATE INDEX IF NOT EXISTS idx_oferta_productos_producto ON oferta_productos(producto_id)',
      ];

  static List<String> all() => [ofertas, ofertaProductos, ...indexes()];
}

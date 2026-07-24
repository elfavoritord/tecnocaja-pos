import 'sync_columns.dart';

/// Ventas, cotizaciones, caja y turnos.
class SchemaVentas {
  const SchemaVentas._();

  static const String ventas = '''
    CREATE TABLE IF NOT EXISTS ventas (
      id TEXT PRIMARY KEY,
      numero_factura TEXT,
      tipo_documento TEXT NOT NULL DEFAULT 'ticket',
      cliente_id TEXT,
      sesion_caja_id TEXT,
      usuario_id TEXT NOT NULL,
      subtotal REAL NOT NULL DEFAULT 0,
      descuento_monto REAL NOT NULL DEFAULT 0,
      descuento_porcentaje REAL NOT NULL DEFAULT 0,
      itbis REAL NOT NULL DEFAULT 0,
      impuestos_adicionales REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      moneda TEXT NOT NULL DEFAULT 'DOP',
      tasa_cambio REAL,
      monto_recibido REAL,
      cambio REAL,
      redondeo_aplicado REAL NOT NULL DEFAULT 0,
      metodo_pago TEXT NOT NULL DEFAULT 'efectivo',
      pagos_combinados_json TEXT,
      estado TEXT NOT NULL DEFAULT 'completada',
      motivo_anulacion TEXT,
      nota TEXT,
      encf TEXT,
      tipo_ecf TEXT,
      ecf_estado TEXT,
      ecf_track_id TEXT,
      ecf_qr_url TEXT,
      ecf_error TEXT,
      ${SyncColumns.full}
    )
  ''';

  static const String ventaItems = '''
    CREATE TABLE IF NOT EXISTS venta_items (
      id TEXT PRIMARY KEY,
      venta_id TEXT NOT NULL,
      producto_id TEXT NOT NULL,
      nombre_producto_snapshot TEXT NOT NULL,
      cantidad REAL NOT NULL,
      precio_unitario REAL NOT NULL,
      precio_original REAL,
      descuento_monto REAL NOT NULL DEFAULT 0,
      descuento_porcentaje REAL NOT NULL DEFAULT 0,
      tasa_itbis REAL NOT NULL DEFAULT 0,
      subtotal_linea REAL NOT NULL,
      oferta_id TEXT,
      nota TEXT,
      ${SyncColumns.full}
    )
  ''';

  static const String cotizaciones = '''
    CREATE TABLE IF NOT EXISTS cotizaciones (
      id TEXT PRIMARY KEY,
      numero TEXT,
      cliente_id TEXT,
      usuario_id TEXT NOT NULL,
      subtotal REAL NOT NULL DEFAULT 0,
      descuento REAL NOT NULL DEFAULT 0,
      impuestos REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      fecha_emision TEXT NOT NULL,
      fecha_vencimiento TEXT,
      estado TEXT NOT NULL DEFAULT 'borrador',
      nota TEXT,
      venta_id_generada TEXT,
      ${SyncColumns.full}
    )
  ''';

  static const String cotizacionItems = '''
    CREATE TABLE IF NOT EXISTS cotizacion_items (
      id TEXT PRIMARY KEY,
      cotizacion_id TEXT NOT NULL,
      producto_id TEXT NOT NULL,
      nombre_producto_snapshot TEXT NOT NULL,
      cantidad REAL NOT NULL,
      precio_unitario REAL NOT NULL,
      descuento REAL NOT NULL DEFAULT 0,
      subtotal_linea REAL NOT NULL,
      ${SyncColumns.full}
    )
  ''';

  static const String sesionesCaja = '''
    CREATE TABLE IF NOT EXISTS sesiones_caja (
      id TEXT PRIMARY KEY,
      usuario_apertura_id TEXT NOT NULL,
      usuario_cierre_id TEXT,
      monto_apertura REAL NOT NULL DEFAULT 0,
      monto_esperado REAL,
      monto_contado REAL,
      diferencia REAL,
      estado TEXT NOT NULL DEFAULT 'abierta',
      abierta_en TEXT NOT NULL,
      cerrada_en TEXT,
      tasa_cambio_usd REAL,
      nota_cierre TEXT,
      ${SyncColumns.full}
    )
  ''';

  /// Incluye gastos: `tipo = 'gasto'` -- mismo modelo que cash_movements del
  /// backend Windows (no hay tabla "gastos" separada alla, ver
  /// project_android_pro_backend_recon en memoria).
  static const String movimientosCaja = '''
    CREATE TABLE IF NOT EXISTS movimientos_caja (
      id TEXT PRIMARY KEY,
      sesion_caja_id TEXT NOT NULL,
      tipo TEXT NOT NULL,
      categoria_gasto TEXT,
      monto REAL NOT NULL,
      descripcion TEXT,
      usuario_id TEXT NOT NULL,
      ocurrido_en TEXT NOT NULL,
      ${SyncColumns.full}
    )
  ''';

  static List<String> indexes() => [
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_factura ON ventas(numero_factura)',
        'CREATE INDEX IF NOT EXISTS idx_ventas_sesion ON ventas(sesion_caja_id)',
        'CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas(cliente_id)',
        'CREATE INDEX IF NOT EXISTS idx_ventas_estado ON ventas(estado)',
        'CREATE INDEX IF NOT EXISTS idx_ventas_creado ON ventas(creado_en)',
        ...SyncColumns.commonIndexes('ventas'),
        'CREATE INDEX IF NOT EXISTS idx_venta_items_venta ON venta_items(venta_id)',
        'CREATE INDEX IF NOT EXISTS idx_venta_items_producto ON venta_items(producto_id)',
        'CREATE INDEX IF NOT EXISTS idx_cotizaciones_cliente ON cotizaciones(cliente_id)',
        'CREATE INDEX IF NOT EXISTS idx_cotizaciones_estado ON cotizaciones(estado)',
        'CREATE INDEX IF NOT EXISTS idx_cotizacion_items_cotizacion ON cotizacion_items(cotizacion_id)',
        'CREATE INDEX IF NOT EXISTS idx_sesiones_caja_estado ON sesiones_caja(estado)',
        ...SyncColumns.commonIndexes('sesiones_caja'),
        'CREATE INDEX IF NOT EXISTS idx_movimientos_caja_sesion ON movimientos_caja(sesion_caja_id)',
        'CREATE INDEX IF NOT EXISTS idx_movimientos_caja_tipo ON movimientos_caja(tipo)',
      ];

  static List<String> all() => [
        ventas,
        ventaItems,
        cotizaciones,
        cotizacionItems,
        sesionesCaja,
        movimientosCaja,
        ...indexes(),
      ];
}

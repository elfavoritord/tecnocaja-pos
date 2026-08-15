import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:path/path.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';
import 'package:sqflite_common_ffi_web/sqflite_ffi_web.dart';

import 'schema/schema_catalogo.dart';
import 'schema/schema_comercial.dart';
import 'schema/schema_core.dart';
import 'schema/schema_marketing.dart';
import 'schema/schema_sistema.dart';
import 'schema/schema_ventas.dart';
import 'schema/sync_columns.dart';

/// Base de datos local unica. Offline-first: toda la app lee/escribe aqui
/// primero: la sincronizacion con la nube/Windows es un proceso aparte
/// (ver data/sync) que nunca bloquea una venta o consulta.
class AppDatabase {
  AppDatabase._();

  static final AppDatabase instance = AppDatabase._();

  static const int schemaVersion = 10;
  static const String fileName = 'tecno_caja_pos.db';

  Database? _db;

  Future<Database> get database async {
    final existing = _db;
    if (existing != null) return existing;
    final opened = await _open();
    _db = opened;
    return opened;
  }

  Future<Database> _open() async {
    late final String path;
    if (kIsWeb) {
      // No hay filesystem real en el navegador: sqlite corre sobre WASM y
      // persiste en IndexedDB, identificado solo por nombre (ver
      // sqflite_common_ffi_web -- requiere web/sqlite3.wasm y
      // web/sqflite_sw.js generados con `dart run sqflite_common_ffi_web:setup`).
      // Se usa la variante "no web worker" (todo corre en el hilo principal,
      // sin SharedWorker): la variante con worker devolvia
      // `unsupported result null` al abrir la base en el dev server local de
      // `flutter run -d chrome`, probablemente por falta de las cabeceras
      // COOP/COEP que ese protocolo espera. Sin cross-tab safety, pero
      // suficiente para pruebas locales de un solo tab.
      databaseFactory = databaseFactoryFfiWebNoWebWorker;
      path = fileName;
    } else {
      final dir = await getApplicationDocumentsDirectory();
      path = join(dir.path, fileName);
    }
    return openDatabase(
      path,
      version: schemaVersion,
      onConfigure: (db) async {
        await db.execute('PRAGMA foreign_keys = ON');
      },
      onCreate: (db, version) async {
        final batch = db.batch();
        for (final statement in _allStatements()) {
          batch.execute(statement);
        }
        await batch.commit(noResult: true);
      },
      onUpgrade: _onUpgrade,
    );
  }

  List<String> _allStatements() => [
        ...SchemaCore.all(),
        ...SchemaCatalogo.all(),
        ...SchemaComercial.all(),
        ...SchemaVentas.all(),
        ...SchemaMarketing.all(),
        ...SchemaSistema.all(),
      ];

  /// v1 -> v2, etc. se agregan aqui con ALTER TABLE / CREATE TABLE IF NOT
  /// EXISTS incrementales cuando cambie el esquema. Nunca DROP de tablas con
  /// datos del usuario -- ver CLAUDE.md / seccion 31 del alcance ("no borrar
  /// datos existentes").
  Future<void> _onUpgrade(Database db, int oldVersion, int newVersion) async {
    if (oldVersion < 2) {
      await db.execute(
          'ALTER TABLE configuracion ADD COLUMN fiscal_usa_comprobantes INTEGER NOT NULL DEFAULT 0');
      await db.execute(
          'ALTER TABLE configuracion ADD COLUMN fiscal_modo_comprobante TEXT');
      await db.execute(
          "ALTER TABLE configuracion ADD COLUMN fiscal_ambiente TEXT NOT NULL DEFAULT 'certificacion'");
    }
    if (oldVersion < 3) {
      await db.execute(
          'ALTER TABLE configuracion ADD COLUMN sucursal_seleccionada_id TEXT');
      await db.execute(
          'ALTER TABLE configuracion ADD COLUMN caja_seleccionada_id TEXT');
    }
    if (oldVersion < 4) {
      await db.execute(SchemaVentas.deliveryOrdenes);
      for (final statement in [
        'CREATE INDEX IF NOT EXISTS idx_delivery_venta ON delivery_ordenes(venta_id)',
        'CREATE INDEX IF NOT EXISTS idx_delivery_estado ON delivery_ordenes(estado)',
        'CREATE INDEX IF NOT EXISTS idx_delivery_repartidor ON delivery_ordenes(repartidor_id)',
        ...SyncColumns.commonIndexes('delivery_ordenes'),
      ]) {
        await db.execute(statement);
      }
    }
    if (oldVersion < 5) {
      await db.execute(SchemaComercial.gastosOperativos);
      await db.execute(SchemaComercial.clienteSeguimientos);
      for (final statement in [
        'CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos_operativos(fecha_comprobante)',
        'CREATE INDEX IF NOT EXISTS idx_gastos_categoria ON gastos_operativos(categoria)',
        ...SyncColumns.commonIndexes('gastos_operativos'),
        'CREATE INDEX IF NOT EXISTS idx_cliente_seguimientos_cliente ON cliente_seguimientos(cliente_id)',
        'CREATE INDEX IF NOT EXISTS idx_cliente_seguimientos_programada ON cliente_seguimientos(fecha_programada)',
        ...SyncColumns.commonIndexes('cliente_seguimientos'),
      ]) {
        await db.execute(statement);
      }
    }
    if (oldVersion < 6) {
      await _addColumnIfMissing(
          db, 'ventas', 'tipo_pedido', "TEXT NOT NULL DEFAULT 'mostrador'");
      await _addColumnIfMissing(
          db, 'ventas', 'cocina_estado', "TEXT NOT NULL DEFAULT 'na'");
      await _addColumnIfMissing(db, 'ventas', 'mesa_label', 'TEXT');
      await _addColumnIfMissing(db, 'ventas', 'order_notes', 'TEXT');
      await db.execute(SchemaVentas.mesasRestaurante);
      for (final statement in [
        'CREATE INDEX IF NOT EXISTS idx_ventas_tipo_pedido ON ventas(tipo_pedido)',
        'CREATE INDEX IF NOT EXISTS idx_ventas_cocina_estado ON ventas(cocina_estado)',
        'CREATE INDEX IF NOT EXISTS idx_mesas_estado ON mesas_restaurante(estado)',
        ...SyncColumns.commonIndexes('mesas_restaurante'),
      ]) {
        await db.execute(statement);
      }
    }
    if (oldVersion < 7) {
      await db.execute(SchemaSistema.rrhhAsistencias);
      for (final statement in [
        'CREATE INDEX IF NOT EXISTS idx_rrhh_usuario ON rrhh_asistencias(usuario_id)',
        'CREATE INDEX IF NOT EXISTS idx_rrhh_entrada ON rrhh_asistencias(entrada_en)',
        ...SyncColumns.commonIndexes('rrhh_asistencias'),
      ]) {
        await db.execute(statement);
      }
    }
    if (oldVersion < 8) {
      await _addColumnIfMissing(db, 'configuracion', 'business_type', 'TEXT');
      await _addColumnIfMissing(
        db,
        'configuracion',
        'business_capabilities_json',
        "TEXT NOT NULL DEFAULT '[]'",
      );
    }
    if (oldVersion < 9) {
      for (final column in <String, String>{
        'controla_vencimiento': 'INTEGER NOT NULL DEFAULT 0',
        'laboratorio': 'TEXT',
        'principio_activo': 'TEXT',
        'presentacion': 'TEXT',
        'concentracion': 'TEXT',
        'registro_sanitario': 'TEXT',
        'es_controlado': 'INTEGER NOT NULL DEFAULT 0',
      }.entries) {
        await _addColumnIfMissing(
          db,
          'productos',
          column.key,
          column.value,
        );
      }
      await _addColumnIfMissing(
          db, 'producto_lotes', 'fecha_fabricacion', 'TEXT');
      await _addColumnIfMissing(db, 'producto_lotes', 'proveedor_id', 'TEXT');
      await db.execute(SchemaCatalogo.ventaItemLotes);
      for (final statement in [
        'CREATE INDEX IF NOT EXISTS idx_venta_item_lotes_venta ON venta_item_lotes(venta_id)',
        'CREATE INDEX IF NOT EXISTS idx_venta_item_lotes_item ON venta_item_lotes(venta_item_id)',
        'CREATE INDEX IF NOT EXISTS idx_venta_item_lotes_lote ON venta_item_lotes(lote_id)',
        ...SyncColumns.commonIndexes('venta_item_lotes'),
      ]) {
        await db.execute(statement);
      }
    }
    if (oldVersion < 10) {
      for (final column in <String, String>{
        'nombre_comercial': 'TEXT',
        'estado_dgii': 'TEXT',
        'tipo_contribuyente': 'TEXT',
        'categoria_dgii': 'TEXT',
        'dgii_consultado_en': 'TEXT',
      }.entries) {
        await _addColumnIfMissing(
          db,
          'clientes',
          column.key,
          column.value,
        );
      }
      await db.execute(
        "UPDATE clientes SET cedula_rnc = REPLACE(REPLACE(cedula_rnc, '-', ''), ' ', '') WHERE cedula_rnc IS NOT NULL",
      );
      await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_clientes_documento ON clientes(empresa_id, cedula_rnc)',
      );
    }
  }

  Future<void> _addColumnIfMissing(
      Database db, String table, String column, String definition) async {
    final info = await db.rawQuery('PRAGMA table_info($table)');
    final exists = info.any((row) => row['name'] == column);
    if (!exists) {
      await db.execute('ALTER TABLE $table ADD COLUMN $column $definition');
    }
  }

  Future<void> close() async {
    final db = _db;
    if (db != null) {
      await db.close();
      _db = null;
    }
  }
}

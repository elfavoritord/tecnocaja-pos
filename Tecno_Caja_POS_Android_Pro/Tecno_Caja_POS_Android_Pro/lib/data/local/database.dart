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

/// Base de datos local unica. Offline-first: toda la app lee/escribe aqui
/// primero: la sincronizacion con la nube/Windows es un proceso aparte
/// (ver data/sync) que nunca bloquea una venta o consulta.
class AppDatabase {
  AppDatabase._();

  static final AppDatabase instance = AppDatabase._();

  static const int schemaVersion = 3;
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
  }

  Future<void> close() async {
    final db = _db;
    if (db != null) {
      await db.close();
      _db = null;
    }
  }
}

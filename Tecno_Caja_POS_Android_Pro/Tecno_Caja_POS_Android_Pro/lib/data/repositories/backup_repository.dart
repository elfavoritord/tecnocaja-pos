import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';

class BackupRepository {
  BackupRepository(this._db);

  final Database _db;

  static const tables = [
    'empresas',
    'sucursales',
    'cajas',
    'usuarios',
    'configuracion',
    'categorias',
    'productos',
    'producto_variantes',
    'producto_lotes',
    'producto_componentes',
    'inventario_sucursal',
    'movimientos_inventario',
    'clientes',
    'cliente_pagos',
    'cliente_seguimientos',
    'proveedores',
    'compras',
    'proveedor_pagos',
    'gastos_operativos',
    'ventas',
    'venta_items',
    'venta_item_lotes',
    'cotizaciones',
    'cotizacion_items',
    'sesiones_caja',
    'movimientos_caja',
    'delivery_ordenes',
    'mesas_restaurante',
    'ofertas',
    'oferta_productos',
    'registro_auditoria',
    'rrhh_asistencias',
    'licencia_cache',
  ];

  Future<String> exportJson(String empresaId) async {
    final payload = <String, Object?>{
      'format': 'tecno_caja_mobile_backup',
      'version': 1,
      'empresa_id': empresaId,
      'created_at': DateTime.now().toIso8601String(),
      'tables': <String, Object?>{},
    };
    final tableData = payload['tables'] as Map<String, Object?>;
    for (final table in tables) {
      try {
        final filter = _filterFor(table, empresaId);
        final rows = await _db.query(
          table,
          where: filter.$1,
          whereArgs: filter.$2,
        );
        tableData[table] = rows;
      } catch (_) {
        tableData[table] = const [];
      }
    }
    return const JsonEncoder.withIndent('  ').convert(payload);
  }

  Future<Map<String, int>> counts(String empresaId) async {
    final result = <String, int>{};
    for (final table in tables) {
      try {
        final filter = _filterFor(table, empresaId);
        final rows = await _db.rawQuery(
          filter.$1 == null
              ? 'SELECT COUNT(*) AS total FROM $table'
              : 'SELECT COUNT(*) AS total FROM $table WHERE ${filter.$1}',
          filter.$2,
        );
        result[table] = (rows.first['total'] as num?)?.toInt() ?? 0;
      } catch (_) {
        result[table] = 0;
      }
    }
    return result;
  }

  (String?, List<Object?>?) _filterFor(String table, String empresaId) {
    if (table == 'empresas') return ('id = ?', [empresaId]);
    if (table == 'configuracion' ||
        table == 'licencia_cache' ||
        table == 'permisos_usuario') {
      return (null, null);
    }
    return ('empresa_id = ?', [empresaId]);
  }
}

final backupRepositoryProvider = Provider<BackupRepository>((ref) {
  return BackupRepository(ref.watch(databaseProvider));
});

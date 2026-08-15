import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';

class AsistenciaRrhh {
  const AsistenciaRrhh({
    required this.id,
    required this.usuarioId,
    required this.usuarioNombre,
    required this.entradaEn,
    required this.salidaEn,
    required this.nota,
    required this.version,
  });

  final String id;
  final String usuarioId;
  final String usuarioNombre;
  final DateTime entradaEn;
  final DateTime? salidaEn;
  final String? nota;
  final int version;

  factory AsistenciaRrhh.fromMap(Map<String, Object?> map) {
    return AsistenciaRrhh(
      id: map['id'] as String,
      usuarioId: map['usuario_id'] as String,
      usuarioNombre:
          '${map['nombre'] ?? ''} ${map['apellido'] ?? ''}'.trim().isEmpty
              ? map['usuario']?.toString() ?? 'Usuario'
              : '${map['nombre'] ?? ''} ${map['apellido'] ?? ''}'.trim(),
      entradaEn: DateTime.parse(map['entrada_en'] as String),
      salidaEn: map['salida_en'] == null
          ? null
          : DateTime.tryParse(map['salida_en'].toString()),
      nota: map['nota'] as String?,
      version: (map['version'] as int?) ?? 1,
    );
  }
}

class RrhhRepository {
  RrhhRepository(this._db);

  final Database _db;

  Future<List<AsistenciaRrhh>> asistencias(String empresaId) async {
    final rows = await _db.rawQuery(
      '''
      SELECT a.*, u.nombre, u.apellido, u.usuario
      FROM rrhh_asistencias a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.empresa_id = ? AND a.eliminado = 0
      ORDER BY a.entrada_en DESC
      LIMIT 200
      ''',
      [empresaId],
    );
    return rows.map(AsistenciaRrhh.fromMap).toList();
  }

  Future<AsistenciaRrhh?> abierta(String usuarioId) async {
    final rows = await _db.rawQuery(
      '''
      SELECT a.*, u.nombre, u.apellido, u.usuario
      FROM rrhh_asistencias a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.usuario_id = ? AND a.salida_en IS NULL AND a.eliminado = 0
      ORDER BY a.entrada_en DESC
      LIMIT 1
      ''',
      [usuarioId],
    );
    return rows.isEmpty ? null : AsistenciaRrhh.fromMap(rows.first);
  }

  Future<void> entrada({
    required String empresaId,
    required String usuarioId,
    String? sucursalId,
    String? cajaId,
    String? dispositivoId,
  }) async {
    final existing = await abierta(usuarioId);
    if (existing != null) return;
    final now = DateTime.now().toIso8601String();
    await _db.insert('rrhh_asistencias', {
      'id': IdGenerator.newId(),
      'usuario_id': usuarioId,
      'entrada_en': now,
      'empresa_id': empresaId,
      'sucursal_id': sucursalId,
      'caja_id': cajaId,
      'usuario_creador_id': usuarioId,
      'dispositivo_id': dispositivoId,
      'creado_en': now,
      'actualizado_en': now,
      'version': 1,
      'sync_estado': 'pendiente',
      'eliminado': 0,
    });
  }

  Future<void> salida(AsistenciaRrhh asistencia) {
    return _db.update(
      'rrhh_asistencias',
      {
        'salida_en': DateTime.now().toIso8601String(),
        'actualizado_en': DateTime.now().toIso8601String(),
        'version': asistencia.version + 1,
        'sync_estado': 'pendiente',
      },
      where: 'id = ?',
      whereArgs: [asistencia.id],
    );
  }
}

final rrhhRepositoryProvider = Provider<RrhhRepository>((ref) {
  return RrhhRepository(ref.watch(databaseProvider));
});

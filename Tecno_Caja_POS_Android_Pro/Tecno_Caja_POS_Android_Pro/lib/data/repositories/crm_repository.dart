import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';

class ClienteSeguimiento {
  const ClienteSeguimiento({
    required this.id,
    required this.clienteId,
    required this.clienteNombre,
    required this.tipo,
    required this.titulo,
    required this.detalle,
    required this.fechaProgramada,
    required this.completado,
    required this.empresaId,
    required this.version,
  });

  final String id;
  final String clienteId;
  final String clienteNombre;
  final String tipo;
  final String titulo;
  final String? detalle;
  final DateTime? fechaProgramada;
  final bool completado;
  final String empresaId;
  final int version;

  factory ClienteSeguimiento.fromMap(Map<String, Object?> map) {
    return ClienteSeguimiento(
      id: map['id'] as String,
      clienteId: map['cliente_id'] as String,
      clienteNombre: map['cliente_nombre']?.toString() ?? 'Cliente',
      tipo: map['tipo']?.toString() ?? 'nota',
      titulo: map['titulo']?.toString() ?? 'Seguimiento',
      detalle: map['detalle'] as String?,
      fechaProgramada: map['fecha_programada'] == null
          ? null
          : DateTime.tryParse(map['fecha_programada'].toString()),
      completado: (map['completado'] as int? ?? 0) == 1,
      empresaId: map['empresa_id'] as String,
      version: (map['version'] as int?) ?? 1,
    );
  }
}

class CrmRepository {
  CrmRepository(this._db);

  final Database _db;

  Future<List<ClienteSeguimiento>> deEmpresa(String empresaId) async {
    final rows = await _db.rawQuery(
      '''
      SELECT s.*, c.nombre AS cliente_nombre
      FROM cliente_seguimientos s
      LEFT JOIN clientes c ON c.id = s.cliente_id
      WHERE s.empresa_id = ? AND s.eliminado = 0
      ORDER BY s.completado ASC, s.fecha_programada ASC, s.actualizado_en DESC
      ''',
      [empresaId],
    );
    return rows.map(ClienteSeguimiento.fromMap).toList();
  }

  Future<ClienteSeguimiento> crear({
    required String empresaId,
    required String usuarioId,
    required String clienteId,
    required String tipo,
    required String titulo,
    String? detalle,
    DateTime? fechaProgramada,
    String? sucursalId,
    String? cajaId,
    String? dispositivoId,
  }) async {
    final now = DateTime.now().toIso8601String();
    final id = IdGenerator.newId();
    await _db.insert('cliente_seguimientos', {
      'id': id,
      'cliente_id': clienteId,
      'tipo': tipo,
      'titulo': titulo,
      'detalle': detalle,
      'fecha_programada': fechaProgramada?.toIso8601String(),
      'completado': 0,
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
    final rows = await deEmpresa(empresaId);
    return rows.firstWhere((item) => item.id == id);
  }

  Future<void> completar(ClienteSeguimiento seguimiento, bool completado) {
    return _db.update(
      'cliente_seguimientos',
      {
        'completado': completado ? 1 : 0,
        'completado_en': completado ? DateTime.now().toIso8601String() : null,
        'actualizado_en': DateTime.now().toIso8601String(),
        'version': seguimiento.version + 1,
        'sync_estado': 'pendiente',
      },
      where: 'id = ?',
      whereArgs: [seguimiento.id],
    );
  }
}

final crmRepositoryProvider = Provider<CrmRepository>((ref) {
  return CrmRepository(ref.watch(databaseProvider));
});

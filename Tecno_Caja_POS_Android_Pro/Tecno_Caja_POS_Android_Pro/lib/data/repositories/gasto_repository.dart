import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';

class GastoOperativo {
  const GastoOperativo({
    required this.id,
    required this.proveedorNombre,
    required this.categoria,
    required this.descripcion,
    required this.ncf,
    required this.fechaComprobante,
    required this.montoTotal,
    required this.itbis,
    required this.metodoPago,
    required this.estado,
    required this.empresaId,
    required this.version,
  });

  final String id;
  final String? proveedorNombre;
  final String categoria;
  final String descripcion;
  final String? ncf;
  final DateTime fechaComprobante;
  final double montoTotal;
  final double itbis;
  final String metodoPago;
  final String estado;
  final String empresaId;
  final int version;

  factory GastoOperativo.fromMap(Map<String, Object?> map) {
    return GastoOperativo(
      id: map['id'] as String,
      proveedorNombre: map['proveedor_nombre'] as String?,
      categoria: map['categoria']?.toString() ?? 'General',
      descripcion: map['descripcion']?.toString() ?? 'Gasto',
      ncf: map['ncf'] as String?,
      fechaComprobante: DateTime.parse(map['fecha_comprobante'] as String),
      montoTotal: (map['monto_total'] as num?)?.toDouble() ?? 0,
      itbis: (map['itbis'] as num?)?.toDouble() ?? 0,
      metodoPago: map['metodo_pago']?.toString() ?? 'efectivo',
      estado: map['estado']?.toString() ?? 'registrado',
      empresaId: map['empresa_id'] as String,
      version: (map['version'] as int?) ?? 1,
    );
  }
}

class GastoRepository {
  GastoRepository(this._db);

  final Database _db;

  Future<List<GastoOperativo>> deEmpresa(String empresaId) async {
    final rows = await _db.rawQuery(
      '''
      SELECT g.*, p.nombre AS proveedor_nombre
      FROM gastos_operativos g
      LEFT JOIN proveedores p ON p.id = g.proveedor_id
      WHERE g.empresa_id = ? AND g.eliminado = 0
      ORDER BY g.fecha_comprobante DESC, g.actualizado_en DESC
      ''',
      [empresaId],
    );
    return rows.map(GastoOperativo.fromMap).toList();
  }

  Future<GastoOperativo> crear({
    required String empresaId,
    required String usuarioId,
    required String categoria,
    required String descripcion,
    required DateTime fechaComprobante,
    required double montoTotal,
    double itbis = 0,
    String metodoPago = 'efectivo',
    String? proveedorId,
    String? ncf,
    String? sucursalId,
    String? cajaId,
    String? dispositivoId,
  }) async {
    final now = DateTime.now().toIso8601String();
    final id = IdGenerator.newId();
    await _db.insert('gastos_operativos', {
      'id': id,
      'proveedor_id': proveedorId,
      'categoria': categoria,
      'descripcion': descripcion,
      'ncf': ncf,
      'fecha_comprobante': fechaComprobante.toIso8601String(),
      'monto_total': montoTotal,
      'itbis': itbis,
      'metodo_pago': metodoPago,
      'estado': 'registrado',
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
    return rows.firstWhere((gasto) => gasto.id == id);
  }

  Future<void> anular(GastoOperativo gasto) async {
    await _db.update(
      'gastos_operativos',
      {
        'estado': 'anulado',
        'actualizado_en': DateTime.now().toIso8601String(),
        'version': gasto.version + 1,
        'sync_estado': 'pendiente',
      },
      where: 'id = ?',
      whereArgs: [gasto.id],
    );
  }
}

final gastoRepositoryProvider = Provider<GastoRepository>((ref) {
  return GastoRepository(ref.watch(databaseProvider));
});

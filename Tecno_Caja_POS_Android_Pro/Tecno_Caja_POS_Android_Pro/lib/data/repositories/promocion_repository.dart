import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';

class PromocionResumen {
  const PromocionResumen({
    required this.id,
    required this.nombre,
    required this.tipo,
    required this.valorDescuento,
    required this.cantidadMinima,
    required this.fechaInicio,
    required this.fechaFin,
    required this.activa,
    required this.empresaId,
    required this.version,
    required this.productos,
  });

  final String id;
  final String nombre;
  final String tipo;
  final double? valorDescuento;
  final double? cantidadMinima;
  final DateTime? fechaInicio;
  final DateTime? fechaFin;
  final bool activa;
  final String empresaId;
  final int version;
  final List<String> productos;

  factory PromocionResumen.fromMap(Map<String, Object?> map) {
    final productosRaw = map['productos']?.toString();
    return PromocionResumen(
      id: map['id'] as String,
      nombre: map['nombre'] as String,
      tipo: map['tipo']?.toString() ?? 'porcentaje',
      valorDescuento: (map['valor_descuento'] as num?)?.toDouble(),
      cantidadMinima: (map['cantidad_minima'] as num?)?.toDouble(),
      fechaInicio: map['fecha_inicio'] == null
          ? null
          : DateTime.tryParse(map['fecha_inicio'].toString()),
      fechaFin: map['fecha_fin'] == null
          ? null
          : DateTime.tryParse(map['fecha_fin'].toString()),
      activa: (map['activa'] as int? ?? 1) == 1,
      empresaId: map['empresa_id'] as String,
      version: (map['version'] as int?) ?? 1,
      productos: productosRaw == null || productosRaw.isEmpty
          ? const []
          : productosRaw.split('||'),
    );
  }
}

class PromocionRepository {
  PromocionRepository(this._db);

  final Database _db;

  Future<List<PromocionResumen>> deEmpresa(String empresaId) async {
    final rows = await _db.rawQuery(
      '''
      SELECT o.*,
             GROUP_CONCAT(p.nombre, '||') AS productos
      FROM ofertas o
      LEFT JOIN oferta_productos op ON op.oferta_id = o.id AND op.eliminado = 0
      LEFT JOIN productos p ON p.id = op.producto_id
      WHERE o.empresa_id = ? AND o.eliminado = 0
      GROUP BY o.id
      ORDER BY o.activa DESC, o.actualizado_en DESC
      ''',
      [empresaId],
    );
    return rows.map(PromocionResumen.fromMap).toList();
  }

  Future<PromocionResumen?> porId(String id) async {
    final rows = await _db.rawQuery(
      '''
      SELECT o.*,
             GROUP_CONCAT(p.nombre, '||') AS productos
      FROM ofertas o
      LEFT JOIN oferta_productos op ON op.oferta_id = o.id AND op.eliminado = 0
      LEFT JOIN productos p ON p.id = op.producto_id
      WHERE o.id = ? AND o.eliminado = 0
      GROUP BY o.id
      LIMIT 1
      ''',
      [id],
    );
    return rows.isEmpty ? null : PromocionResumen.fromMap(rows.first);
  }

  Future<PromocionResumen> crear({
    required String empresaId,
    required String usuarioId,
    required String nombre,
    required String tipo,
    required double valorDescuento,
    required List<String> productoIds,
    double cantidadMinima = 1,
    String? sucursalId,
    String? cajaId,
    String? dispositivoId,
  }) async {
    final now = DateTime.now().toIso8601String();
    final id = IdGenerator.newId();
    await _db.transaction((txn) async {
      await txn.insert('ofertas', {
        'id': id,
        'codigo_interno': 'PROMO-${DateTime.now().millisecondsSinceEpoch}',
        'nombre': nombre,
        'tipo': tipo,
        'valor_descuento': valorDescuento,
        'cantidad_minima': cantidadMinima,
        'activa': 1,
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
      for (final productoId in productoIds) {
        await txn.insert('oferta_productos', {
          'id': IdGenerator.newId(),
          'oferta_id': id,
          'producto_id': productoId,
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
    });
    final creada = await porId(id);
    return creada!;
  }

  Future<void> cambiarActiva(PromocionResumen promocion, bool activa) async {
    await _db.update(
      'ofertas',
      {
        'activa': activa ? 1 : 0,
        'actualizado_en': DateTime.now().toIso8601String(),
        'version': promocion.version + 1,
        'sync_estado': 'pendiente',
      },
      where: 'id = ?',
      whereArgs: [promocion.id],
    );
  }

  Future<void> eliminar(PromocionResumen promocion) async {
    final now = DateTime.now().toIso8601String();
    await _db.transaction((txn) async {
      await txn.update(
        'oferta_productos',
        {'eliminado': 1, 'actualizado_en': now, 'sync_estado': 'pendiente'},
        where: 'oferta_id = ?',
        whereArgs: [promocion.id],
      );
      await txn.update(
        'ofertas',
        {
          'eliminado': 1,
          'actualizado_en': now,
          'version': promocion.version + 1,
          'sync_estado': 'pendiente',
        },
        where: 'id = ?',
        whereArgs: [promocion.id],
      );
    });
  }
}

final promocionRepositoryProvider = Provider<PromocionRepository>((ref) {
  return PromocionRepository(ref.watch(databaseProvider));
});

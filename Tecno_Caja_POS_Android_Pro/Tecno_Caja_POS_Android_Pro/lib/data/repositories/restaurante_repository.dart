import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';

class MesaRestaurante {
  const MesaRestaurante({
    required this.id,
    required this.etiqueta,
    required this.zona,
    required this.estado,
    required this.ventaIdActual,
    required this.capacidad,
    required this.nota,
    required this.version,
  });

  final String id;
  final String etiqueta;
  final String? zona;
  final String estado;
  final String? ventaIdActual;
  final int? capacidad;
  final String? nota;
  final int version;

  factory MesaRestaurante.fromMap(Map<String, Object?> map) {
    return MesaRestaurante(
      id: map['id'] as String,
      etiqueta: map['etiqueta']?.toString() ?? 'Mesa',
      zona: map['zona'] as String?,
      estado: map['estado']?.toString() ?? 'libre',
      ventaIdActual: map['venta_id_actual'] as String?,
      capacidad: (map['capacidad'] as num?)?.toInt(),
      nota: map['nota'] as String?,
      version: (map['version'] as int?) ?? 1,
    );
  }
}

class CocinaTicket {
  const CocinaTicket({
    required this.id,
    required this.numeroFactura,
    required this.tipoPedido,
    required this.estado,
    required this.mesa,
    required this.nota,
    required this.total,
    required this.creadoEn,
  });

  final String id;
  final String numeroFactura;
  final String tipoPedido;
  final String estado;
  final String? mesa;
  final String? nota;
  final double total;
  final DateTime creadoEn;

  factory CocinaTicket.fromMap(Map<String, Object?> map) {
    return CocinaTicket(
      id: map['id'] as String,
      numeroFactura: map['numero_factura']?.toString() ?? 'Pedido',
      tipoPedido: map['tipo_pedido']?.toString() ?? 'mostrador',
      estado: map['cocina_estado']?.toString() ?? 'na',
      mesa: map['mesa_label'] as String?,
      nota: map['order_notes'] as String? ?? map['nota'] as String?,
      total: (map['total'] as num?)?.toDouble() ?? 0,
      creadoEn: DateTime.parse(map['creado_en'] as String),
    );
  }
}

class RestauranteRepository {
  RestauranteRepository(this._db);

  final Database _db;

  Future<List<MesaRestaurante>> mesas(String empresaId) async {
    final rows = await _db.query(
      'mesas_restaurante',
      where: 'empresa_id = ? AND eliminado = 0',
      whereArgs: [empresaId],
      orderBy: 'zona ASC, etiqueta ASC',
    );
    return rows.map(MesaRestaurante.fromMap).toList();
  }

  Future<MesaRestaurante> crearMesa({
    required String empresaId,
    required String usuarioId,
    required String etiqueta,
    String? zona,
    int? capacidad,
    String? sucursalId,
    String? cajaId,
    String? dispositivoId,
  }) async {
    final now = DateTime.now().toIso8601String();
    final id = IdGenerator.newId();
    await _db.insert('mesas_restaurante', {
      'id': id,
      'etiqueta': etiqueta,
      'zona': zona,
      'estado': 'libre',
      'capacidad': capacidad,
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
    final all = await mesas(empresaId);
    return all.firstWhere((mesa) => mesa.id == id);
  }

  Future<void> cambiarMesaEstado(MesaRestaurante mesa, String estado) {
    return _db.update(
      'mesas_restaurante',
      {
        'estado': estado,
        'actualizado_en': DateTime.now().toIso8601String(),
        'version': mesa.version + 1,
        'sync_estado': 'pendiente',
      },
      where: 'id = ?',
      whereArgs: [mesa.id],
    );
  }

  Future<List<CocinaTicket>> cocina(String empresaId) async {
    final rows = await _db.query(
      'ventas',
      where:
          "empresa_id = ? AND eliminado = 0 AND cocina_estado != 'na' AND estado != 'anulada'",
      whereArgs: [empresaId],
      orderBy:
          "CASE cocina_estado WHEN 'pendiente' THEN 0 WHEN 'preparando' THEN 1 ELSE 2 END, creado_en ASC",
      limit: 100,
    );
    return rows.map(CocinaTicket.fromMap).toList();
  }

  Future<void> cambiarCocinaEstado(CocinaTicket ticket, String estado) {
    return _db.update(
      'ventas',
      {
        'cocina_estado': estado,
        'actualizado_en': DateTime.now().toIso8601String(),
        'sync_estado': 'pendiente',
      },
      where: 'id = ?',
      whereArgs: [ticket.id],
    );
  }
}

final restauranteRepositoryProvider = Provider<RestauranteRepository>((ref) {
  return RestauranteRepository(ref.watch(databaseProvider));
});

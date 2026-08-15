import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';

class DeliveryOrden {
  const DeliveryOrden({
    required this.id,
    required this.ventaId,
    required this.factura,
    required this.repartidorId,
    required this.estado,
    required this.clienteNombre,
    required this.telefono,
    required this.direccion,
    required this.referencia,
    required this.ubicacionUrl,
    required this.montoCobrar,
    required this.montoRecibido,
    required this.cambio,
    required this.creadoEn,
    required this.entregadoEn,
    required this.empresaId,
    required this.sucursalId,
    required this.cajaId,
    required this.version,
  });

  final String id;
  final String ventaId;
  final String factura;
  final String? repartidorId;
  final String estado;
  final String clienteNombre;
  final String? telefono;
  final String? direccion;
  final String? referencia;
  final String? ubicacionUrl;
  final double montoCobrar;
  final double? montoRecibido;
  final double? cambio;
  final DateTime creadoEn;
  final DateTime? entregadoEn;
  final String empresaId;
  final String? sucursalId;
  final String? cajaId;
  final int version;

  factory DeliveryOrden.fromMap(Map<String, Object?> map) {
    return DeliveryOrden(
      id: map['id'] as String,
      ventaId: map['venta_id'] as String,
      factura: map['numero_factura']?.toString() ?? map['venta_id'].toString(),
      repartidorId: map['repartidor_id'] as String?,
      estado: map['estado']?.toString() ?? 'pendiente',
      clienteNombre: map['cliente_nombre']?.toString() ?? 'Cliente',
      telefono: map['telefono'] as String?,
      direccion: map['direccion'] as String?,
      referencia: map['referencia'] as String?,
      ubicacionUrl: map['ubicacion_url'] as String?,
      montoCobrar: (map['monto_cobrar'] as num?)?.toDouble() ?? 0,
      montoRecibido: (map['monto_recibido'] as num?)?.toDouble(),
      cambio: (map['cambio'] as num?)?.toDouble(),
      creadoEn: DateTime.parse(map['creado_en'] as String),
      entregadoEn: map['entregado_en'] == null
          ? null
          : DateTime.tryParse(map['entregado_en'].toString()),
      empresaId: map['empresa_id'] as String,
      sucursalId: map['sucursal_id'] as String?,
      cajaId: map['caja_id'] as String?,
      version: (map['version'] as int?) ?? 1,
    );
  }
}

class DeliveryRepository {
  DeliveryRepository(this._db);

  final Database _db;

  Future<List<DeliveryOrden>> deEmpresa(
    String empresaId, {
    String estado = 'todos',
    String? repartidorId,
  }) async {
    final where = <String>['d.empresa_id = ?', 'd.eliminado = 0'];
    final args = <Object?>[empresaId];
    if (estado != 'todos') {
      where.add('d.estado = ?');
      args.add(estado);
    }
    if (repartidorId != null) {
      where.add('(d.repartidor_id IS NULL OR d.repartidor_id = ?)');
      args.add(repartidorId);
    }
    final rows = await _db.rawQuery(
      '''
      SELECT d.*, v.numero_factura
      FROM delivery_ordenes d
      LEFT JOIN ventas v ON v.id = d.venta_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.actualizado_en DESC
      ''',
      args,
    );
    return rows.map(DeliveryOrden.fromMap).toList();
  }

  Future<List<Map<String, Object?>>> ventasElegibles(String empresaId) {
    return _db.rawQuery(
      '''
      SELECT v.id, v.numero_factura, v.total, v.creado_en, c.nombre AS cliente_nombre
      FROM ventas v
      LEFT JOIN clientes c ON c.id = v.cliente_id
      LEFT JOIN delivery_ordenes d ON d.venta_id = v.id AND d.eliminado = 0
      WHERE v.empresa_id = ?
        AND v.estado = 'completada'
        AND v.eliminado = 0
        AND d.id IS NULL
      ORDER BY v.creado_en DESC
      LIMIT 100
      ''',
      [empresaId],
    );
  }

  Future<DeliveryOrden> crear({
    required String empresaId,
    required String ventaId,
    required double montoCobrar,
    required String usuarioId,
    String? sucursalId,
    String? cajaId,
    String? repartidorId,
    String? clienteNombre,
    String? telefono,
    String? direccion,
    String? referencia,
    String? ubicacionUrl,
    String? dispositivoId,
  }) async {
    final now = DateTime.now().toIso8601String();
    final id = IdGenerator.newId();
    await _db.insert('delivery_ordenes', {
      'id': id,
      'venta_id': ventaId,
      'repartidor_id': repartidorId,
      'estado': 'pendiente',
      'cliente_nombre': clienteNombre,
      'telefono': telefono,
      'direccion': direccion,
      'referencia': referencia,
      'ubicacion_url': ubicacionUrl,
      'monto_cobrar': montoCobrar,
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
    return rows.firstWhere((orden) => orden.id == id);
  }

  Future<void> cambiarEstado(
    DeliveryOrden orden,
    String estado, {
    String? repartidorId,
    double? montoRecibido,
  }) async {
    final cambio =
        montoRecibido == null ? null : montoRecibido - orden.montoCobrar;
    await _db.update(
      'delivery_ordenes',
      {
        'estado': estado,
        'repartidor_id': repartidorId ?? orden.repartidorId,
        'monto_recibido': montoRecibido,
        'cambio': cambio == null ? null : (cambio < 0 ? 0 : cambio),
        'entregado_en':
            estado == 'entregado' ? DateTime.now().toIso8601String() : null,
        'actualizado_en': DateTime.now().toIso8601String(),
        'version': orden.version + 1,
        'sync_estado': 'pendiente',
      },
      where: 'id = ?',
      whereArgs: [orden.id],
    );
  }
}

final deliveryRepositoryProvider = Provider<DeliveryRepository>((ref) {
  return DeliveryRepository(ref.watch(databaseProvider));
});

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';

class CompraResumen {
  const CompraResumen({
    required this.id,
    required this.empresaId,
    required this.proveedorId,
    required this.proveedorNombre,
    required this.numeroFactura,
    required this.fechaEmision,
    required this.fechaVencimiento,
    required this.montoTotal,
    required this.montoPagado,
    required this.montoPendiente,
    required this.estado,
    required this.recibida,
    required this.version,
  });

  final String id;
  final String empresaId;
  final String proveedorId;
  final String proveedorNombre;
  final String? numeroFactura;
  final DateTime fechaEmision;
  final DateTime? fechaVencimiento;
  final double montoTotal;
  final double montoPagado;
  final double montoPendiente;
  final String estado;
  final bool recibida;
  final int version;

  factory CompraResumen.fromMap(Map<String, Object?> map) {
    return CompraResumen(
      id: map['id'] as String,
      empresaId: map['empresa_id'] as String,
      proveedorId: map['proveedor_id'] as String,
      proveedorNombre: map['proveedor_nombre']?.toString() ?? 'Proveedor',
      numeroFactura: map['numero_factura'] as String?,
      fechaEmision: DateTime.parse(map['fecha_emision'] as String),
      fechaVencimiento: map['fecha_vencimiento'] == null
          ? null
          : DateTime.tryParse(map['fecha_vencimiento'].toString()),
      montoTotal: (map['monto_total'] as num?)?.toDouble() ?? 0,
      montoPagado: (map['monto_pagado'] as num?)?.toDouble() ?? 0,
      montoPendiente: (map['monto_pendiente'] as num?)?.toDouble() ?? 0,
      estado: map['estado']?.toString() ?? 'pendiente',
      recibida: (map['recibida'] as int? ?? 0) == 1,
      version: (map['version'] as int?) ?? 1,
    );
  }
}

class CompraRepository {
  CompraRepository(this._db);

  final Database _db;

  Future<List<CompraResumen>> deEmpresa(String empresaId) async {
    final rows = await _db.rawQuery(
      '''
      SELECT c.*, p.nombre AS proveedor_nombre
      FROM compras c
      LEFT JOIN proveedores p ON p.id = c.proveedor_id
      WHERE c.empresa_id = ? AND c.eliminado = 0
      ORDER BY c.fecha_emision DESC, c.actualizado_en DESC
      ''',
      [empresaId],
    );
    return rows.map(CompraResumen.fromMap).toList();
  }

  Future<CompraResumen?> porId(String id) async {
    final rows = await _db.rawQuery(
      '''
      SELECT c.*, p.nombre AS proveedor_nombre
      FROM compras c
      LEFT JOIN proveedores p ON p.id = c.proveedor_id
      WHERE c.id = ? AND c.eliminado = 0
      LIMIT 1
      ''',
      [id],
    );
    return rows.isEmpty ? null : CompraResumen.fromMap(rows.first);
  }

  Future<CompraResumen> crearFactura({
    required String empresaId,
    required String proveedorId,
    required DateTime fechaEmision,
    required double montoTotal,
    required String usuarioId,
    String? sucursalId,
    String? cajaId,
    String? numeroFactura,
    DateTime? fechaVencimiento,
    double montoPagado = 0,
    bool recibida = true,
    String? dispositivoId,
  }) async {
    final now = DateTime.now().toIso8601String();
    final id = IdGenerator.newId();
    final pagado = montoPagado.clamp(0, montoTotal).toDouble();
    final pendiente = (montoTotal - pagado).clamp(0, montoTotal).toDouble();
    final estado = pendiente <= 0
        ? 'pagada'
        : pagado > 0
            ? 'parcial'
            : 'pendiente';

    await _db.transaction((txn) async {
      await txn.insert('compras', {
        'id': id,
        'proveedor_id': proveedorId,
        'numero_factura': numeroFactura,
        'fecha_emision': fechaEmision.toIso8601String(),
        'fecha_vencimiento': fechaVencimiento?.toIso8601String(),
        'monto_total': montoTotal,
        'monto_pagado': pagado,
        'monto_pendiente': pendiente,
        'estado': estado,
        'recibida': recibida ? 1 : 0,
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
      if (pagado > 0) {
        await _insertarPago(
          txn,
          empresaId: empresaId,
          sucursalId: sucursalId,
          cajaId: cajaId,
          proveedorId: proveedorId,
          compraId: id,
          monto: pagado,
          metodoPago: 'efectivo',
          usuarioId: usuarioId,
          dispositivoId: dispositivoId,
          now: now,
          nota: 'Abono inicial',
        );
      }
    });

    final compra = await porId(id);
    return compra!;
  }

  Future<CompraResumen> abonar({
    required CompraResumen compra,
    required double monto,
    required String metodoPago,
    required String usuarioId,
    String? sucursalId,
    String? cajaId,
    String? dispositivoId,
    String? nota,
  }) async {
    if (monto <= 0) return compra;
    final abono = monto.clamp(0, compra.montoPendiente).toDouble();
    final nuevoPagado = compra.montoPagado + abono;
    final nuevoPendiente = (compra.montoTotal - nuevoPagado)
        .clamp(0, compra.montoTotal)
        .toDouble();
    final estado = nuevoPendiente <= 0 ? 'pagada' : 'parcial';
    final now = DateTime.now().toIso8601String();

    await _db.transaction((txn) async {
      await txn.update(
        'compras',
        {
          'monto_pagado': nuevoPagado,
          'monto_pendiente': nuevoPendiente,
          'estado': estado,
          'actualizado_en': now,
          'version': compra.version + 1,
          'sync_estado': 'pendiente',
        },
        where: 'id = ?',
        whereArgs: [compra.id],
      );
      await _insertarPago(
        txn,
        empresaId: compra.empresaId,
        sucursalId: sucursalId,
        cajaId: cajaId,
        proveedorId: compra.proveedorId,
        compraId: compra.id,
        monto: abono,
        metodoPago: metodoPago,
        usuarioId: usuarioId,
        dispositivoId: dispositivoId,
        now: now,
        nota: nota,
      );
    });

    final actualizada = await porId(compra.id);
    return actualizada!;
  }

  static Future<void> _insertarPago(
    Transaction txn, {
    required String empresaId,
    required String? sucursalId,
    required String? cajaId,
    required String proveedorId,
    required String compraId,
    required double monto,
    required String metodoPago,
    required String usuarioId,
    required String? dispositivoId,
    required String now,
    String? nota,
  }) {
    return txn.insert('proveedor_pagos', {
      'id': IdGenerator.newId(),
      'proveedor_id': proveedorId,
      'compra_id': compraId,
      'monto': monto,
      'metodo_pago': metodoPago,
      'fecha_pago': now,
      'nota': nota,
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
}

final compraRepositoryProvider = Provider<CompraRepository>((ref) {
  return CompraRepository(ref.watch(databaseProvider));
});

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';
import '../../domain/calculo_venta.dart';
import '../../domain/entities/producto.dart';

class LineaCotizacionSolicitada {
  const LineaCotizacionSolicitada({
    required this.producto,
    required this.cantidad,
    this.descuento = 0,
  });

  final Producto producto;
  final double cantidad;
  final double descuento;
}

class CotizacionResumen {
  const CotizacionResumen({
    required this.id,
    required this.numero,
    required this.clienteId,
    required this.clienteNombre,
    required this.usuarioId,
    required this.subtotal,
    required this.descuento,
    required this.impuestos,
    required this.total,
    required this.fechaEmision,
    required this.fechaVencimiento,
    required this.estado,
    required this.nota,
    required this.ventaIdGenerada,
    required this.empresaId,
    required this.sucursalId,
    required this.cajaId,
    required this.version,
  });

  final String id;
  final String? numero;
  final String? clienteId;
  final String? clienteNombre;
  final String usuarioId;
  final double subtotal;
  final double descuento;
  final double impuestos;
  final double total;
  final DateTime fechaEmision;
  final DateTime? fechaVencimiento;
  final String estado;
  final String? nota;
  final String? ventaIdGenerada;
  final String empresaId;
  final String? sucursalId;
  final String? cajaId;
  final int version;

  factory CotizacionResumen.fromMap(Map<String, Object?> map) {
    return CotizacionResumen(
      id: map['id'] as String,
      numero: map['numero'] as String?,
      clienteId: map['cliente_id'] as String?,
      clienteNombre: map['cliente_nombre'] as String?,
      usuarioId: map['usuario_id'] as String,
      subtotal: (map['subtotal'] as num?)?.toDouble() ?? 0,
      descuento: (map['descuento'] as num?)?.toDouble() ?? 0,
      impuestos: (map['impuestos'] as num?)?.toDouble() ?? 0,
      total: (map['total'] as num?)?.toDouble() ?? 0,
      fechaEmision: DateTime.parse(map['fecha_emision'] as String),
      fechaVencimiento: map['fecha_vencimiento'] == null
          ? null
          : DateTime.tryParse(map['fecha_vencimiento'].toString()),
      estado: map['estado']?.toString() ?? 'borrador',
      nota: map['nota'] as String?,
      ventaIdGenerada: map['venta_id_generada'] as String?,
      empresaId: map['empresa_id'] as String,
      sucursalId: map['sucursal_id'] as String?,
      cajaId: map['caja_id'] as String?,
      version: (map['version'] as int?) ?? 1,
    );
  }
}

class CotizacionItemResumen {
  const CotizacionItemResumen({
    required this.id,
    required this.cotizacionId,
    required this.productoId,
    required this.nombreProducto,
    required this.cantidad,
    required this.precioUnitario,
    required this.descuento,
    required this.subtotalLinea,
  });

  final String id;
  final String cotizacionId;
  final String productoId;
  final String nombreProducto;
  final double cantidad;
  final double precioUnitario;
  final double descuento;
  final double subtotalLinea;

  factory CotizacionItemResumen.fromMap(Map<String, Object?> map) {
    return CotizacionItemResumen(
      id: map['id'] as String,
      cotizacionId: map['cotizacion_id'] as String,
      productoId: map['producto_id'] as String,
      nombreProducto: map['nombre_producto_snapshot'] as String,
      cantidad: (map['cantidad'] as num?)?.toDouble() ?? 0,
      precioUnitario: (map['precio_unitario'] as num?)?.toDouble() ?? 0,
      descuento: (map['descuento'] as num?)?.toDouble() ?? 0,
      subtotalLinea: (map['subtotal_linea'] as num?)?.toDouble() ?? 0,
    );
  }
}

class CotizacionRepository {
  CotizacionRepository(this._db);

  final Database _db;

  Future<List<CotizacionResumen>> deEmpresa(String empresaId) async {
    final rows = await _db.rawQuery(
      '''
      SELECT q.*, c.nombre AS cliente_nombre
      FROM cotizaciones q
      LEFT JOIN clientes c ON c.id = q.cliente_id
      WHERE q.empresa_id = ? AND q.eliminado = 0
      ORDER BY q.fecha_emision DESC, q.actualizado_en DESC
      ''',
      [empresaId],
    );
    return rows.map(CotizacionResumen.fromMap).toList();
  }

  Future<CotizacionResumen?> porId(String id) async {
    final rows = await _db.rawQuery(
      '''
      SELECT q.*, c.nombre AS cliente_nombre
      FROM cotizaciones q
      LEFT JOIN clientes c ON c.id = q.cliente_id
      WHERE q.id = ? AND q.eliminado = 0
      LIMIT 1
      ''',
      [id],
    );
    return rows.isEmpty ? null : CotizacionResumen.fromMap(rows.first);
  }

  Future<List<CotizacionItemResumen>> itemsDe(String cotizacionId) async {
    final rows = await _db.query(
      'cotizacion_items',
      where: 'cotizacion_id = ? AND eliminado = 0',
      whereArgs: [cotizacionId],
      orderBy: 'creado_en ASC',
    );
    return rows.map(CotizacionItemResumen.fromMap).toList();
  }

  Future<CotizacionResumen> crear({
    required String empresaId,
    required String usuarioId,
    required List<LineaCotizacionSolicitada> lineas,
    String? clienteId,
    String? sucursalId,
    String? cajaId,
    DateTime? fechaVencimiento,
    String? nota,
    String? dispositivoId,
  }) async {
    if (lineas.isEmpty) {
      throw ArgumentError('La cotización no tiene productos.');
    }
    final calculo = CalculadoraVenta.calcular(
      items: lineas
          .map(
            (linea) => ItemCalculo(
              productoId: linea.producto.id,
              cantidad: linea.cantidad,
              precioUnitario: linea.producto.precioVenta,
              tasaItbis: linea.producto.tasaItbis,
              itbisIncluido: linea.producto.itbisIncluido,
              descuentoMonto: linea.descuento,
            ),
          )
          .toList(),
    );
    final now = DateTime.now();
    final id = IdGenerator.newId();
    final numero = await _siguienteNumero(empresaId);

    await _db.transaction((txn) async {
      await txn.insert('cotizaciones', {
        'id': id,
        'numero': numero,
        'cliente_id': clienteId,
        'usuario_id': usuarioId,
        'subtotal': calculo.subtotal,
        'descuento': calculo.descuentoTotal,
        'impuestos': calculo.itbis,
        'total': calculo.total,
        'fecha_emision': now.toIso8601String(),
        'fecha_vencimiento': fechaVencimiento?.toIso8601String(),
        'estado': 'pendiente',
        'nota': nota,
        'empresa_id': empresaId,
        'sucursal_id': sucursalId,
        'caja_id': cajaId,
        'usuario_creador_id': usuarioId,
        'dispositivo_id': dispositivoId,
        'creado_en': now.toIso8601String(),
        'actualizado_en': now.toIso8601String(),
        'version': 1,
        'sync_estado': 'pendiente',
        'eliminado': 0,
      });

      for (final linea in lineas) {
        final item = ItemCalculo(
          productoId: linea.producto.id,
          cantidad: linea.cantidad,
          precioUnitario: linea.producto.precioVenta,
          tasaItbis: linea.producto.tasaItbis,
          itbisIncluido: linea.producto.itbisIncluido,
          descuentoMonto: linea.descuento,
        );
        await txn.insert('cotizacion_items', {
          'id': IdGenerator.newId(),
          'cotizacion_id': id,
          'producto_id': linea.producto.id,
          'nombre_producto_snapshot': linea.producto.nombre,
          'cantidad': linea.cantidad,
          'precio_unitario': linea.producto.precioVenta,
          'descuento': item.descuentoTotal,
          'subtotal_linea': item.totalLinea,
          'empresa_id': empresaId,
          'sucursal_id': sucursalId,
          'caja_id': cajaId,
          'usuario_creador_id': usuarioId,
          'dispositivo_id': dispositivoId,
          'creado_en': now.toIso8601String(),
          'actualizado_en': now.toIso8601String(),
          'version': 1,
          'sync_estado': 'pendiente',
          'eliminado': 0,
        });
      }
    });

    final creada = await porId(id);
    return creada!;
  }

  Future<void> marcarConvertida({
    required CotizacionResumen cotizacion,
    required String ventaId,
  }) async {
    await _db.update(
      'cotizaciones',
      {
        'estado': 'convertida',
        'venta_id_generada': ventaId,
        'actualizado_en': DateTime.now().toIso8601String(),
        'version': cotizacion.version + 1,
        'sync_estado': 'pendiente',
      },
      where: 'id = ?',
      whereArgs: [cotizacion.id],
    );
  }

  Future<void> anular(CotizacionResumen cotizacion) async {
    await _db.update(
      'cotizaciones',
      {
        'estado': 'anulada',
        'actualizado_en': DateTime.now().toIso8601String(),
        'version': cotizacion.version + 1,
        'sync_estado': 'pendiente',
      },
      where: 'id = ?',
      whereArgs: [cotizacion.id],
    );
  }

  Future<String> _siguienteNumero(String empresaId) async {
    final rows = await _db.rawQuery(
      '''
      SELECT COUNT(*) AS total
      FROM cotizaciones
      WHERE empresa_id = ? AND eliminado = 0
      ''',
      [empresaId],
    );
    final next = ((rows.first['total'] as num?)?.toInt() ?? 0) + 1;
    return 'COT-${next.toString().padLeft(8, '0')}';
  }
}

final cotizacionRepositoryProvider = Provider<CotizacionRepository>((ref) {
  return CotizacionRepository(ref.watch(databaseProvider));
});

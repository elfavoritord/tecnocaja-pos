import '../../core/constants/sync_estado.dart';

class ProductoLote {
  const ProductoLote({
    required this.id,
    required this.productoId,
    this.numeroLote,
    this.fechaFabricacion,
    this.fechaVencimiento,
    required this.cantidad,
    this.costoUnitario,
    this.proveedorId,
    required this.empresaId,
    this.sucursalId,
    this.dispositivoId,
    required this.creadoEn,
    required this.actualizadoEn,
    this.version = 1,
    this.syncEstado = SyncEstado.pendiente,
    this.sincronizadoEn,
    this.remotoId,
    this.eliminado = false,
  });

  final String id;
  final String productoId;
  final String? numeroLote;
  final DateTime? fechaFabricacion;
  final DateTime? fechaVencimiento;
  final double cantidad;
  final double? costoUnitario;
  final String? proveedorId;
  final String empresaId;
  final String? sucursalId;
  final String? dispositivoId;
  final DateTime creadoEn;
  final DateTime actualizadoEn;
  final int version;
  final SyncEstado syncEstado;
  final DateTime? sincronizadoEn;
  final String? remotoId;
  final bool eliminado;

  DateTime get _today {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day);
  }

  int? get daysUntilExpiration => fechaVencimiento?.difference(_today).inDays;
  bool get expired => daysUntilExpiration != null && daysUntilExpiration! < 0;

  String get expirationStatus {
    final days = daysUntilExpiration;
    if (days == null) return 'Sin fecha';
    if (days < 0) return 'Vencido';
    if (days <= 7) return 'Vence en 7 días';
    if (days <= 30) return 'Vence en 30 días';
    if (days <= 60) return 'Vence en 60 días';
    if (days <= 90) return 'Vence en 90 días';
    return 'Vigente';
  }

  Map<String, Object?> toMap() => {
        'id': id,
        'producto_id': productoId,
        'numero_lote': numeroLote,
        'fecha_fabricacion': _dateOnly(fechaFabricacion),
        'fecha_vencimiento': _dateOnly(fechaVencimiento),
        'cantidad': cantidad,
        'costo_unitario': costoUnitario,
        'proveedor_id': proveedorId,
        'empresa_id': empresaId,
        'sucursal_id': sucursalId,
        'caja_id': null,
        'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(),
        'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version,
        'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(),
        'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory ProductoLote.fromMap(Map<String, Object?> map) => ProductoLote(
        id: map['id'] as String,
        productoId: map['producto_id'] as String,
        numeroLote: map['numero_lote'] as String?,
        fechaFabricacion: _parseDate(map['fecha_fabricacion']),
        fechaVencimiento: _parseDate(map['fecha_vencimiento']),
        cantidad: (map['cantidad'] as num?)?.toDouble() ?? 0,
        costoUnitario: (map['costo_unitario'] as num?)?.toDouble(),
        proveedorId: map['proveedor_id'] as String?,
        empresaId: map['empresa_id'] as String,
        sucursalId: map['sucursal_id'] as String?,
        dispositivoId: map['dispositivo_id'] as String?,
        creadoEn: DateTime.parse(map['creado_en'] as String),
        actualizadoEn: DateTime.parse(map['actualizado_en'] as String),
        version: map['version'] as int? ?? 1,
        syncEstado: SyncEstadoX.desde(map['sync_estado'] as String?),
        sincronizadoEn: map['sincronizado_en'] == null
            ? null
            : DateTime.parse(map['sincronizado_en'] as String),
        remotoId: map['remoto_id'] as String?,
        eliminado: (map['eliminado'] as int? ?? 0) == 1,
      );

  static String? _dateOnly(DateTime? value) =>
      value?.toIso8601String().substring(0, 10);

  static DateTime? _parseDate(Object? value) =>
      DateTime.tryParse(value?.toString() ?? '');
}

import '../../core/constants/sync_estado.dart';

/// Stock real de un producto en una sucursal (fuente de verdad). El campo
/// `stockMinimo` en Producto es solo el default sugerido al crear el
/// producto; el que manda para alertas es el de aqui, por sucursal.
class InventarioSucursal {
  const InventarioSucursal({
    required this.id,
    required this.productoId,
    required this.sucursalId,
    required this.empresaId,
    this.stock = 0,
    this.stockMinimo = 0,
    this.ubicacion,
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
  final String sucursalId;
  final String empresaId;
  final double stock;
  final double stockMinimo;
  final String? ubicacion;
  final String? dispositivoId;
  final DateTime creadoEn;
  final DateTime actualizadoEn;
  final int version;
  final SyncEstado syncEstado;
  final DateTime? sincronizadoEn;
  final String? remotoId;
  final bool eliminado;

  bool get stockBajo => stock <= stockMinimo && stockMinimo > 0;
  bool get agotado => stock <= 0;

  InventarioSucursal copyWith({double? stock, double? stockMinimo, String? ubicacion}) {
    return InventarioSucursal(
      id: id, productoId: productoId, sucursalId: sucursalId, empresaId: empresaId,
      stock: stock ?? this.stock, stockMinimo: stockMinimo ?? this.stockMinimo,
      ubicacion: ubicacion ?? this.ubicacion, dispositivoId: dispositivoId,
      creadoEn: creadoEn, actualizadoEn: DateTime.now(), version: version + 1,
      syncEstado: SyncEstado.pendiente, sincronizadoEn: sincronizadoEn, remotoId: remotoId,
      eliminado: eliminado,
    );
  }

  Map<String, Object?> toMap() => {
        'id': id, 'producto_id': productoId, 'sucursal_id': sucursalId, 'empresa_id': empresaId,
        'stock': stock, 'stock_minimo': stockMinimo, 'ubicacion': ubicacion,
        'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(), 'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version, 'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(), 'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory InventarioSucursal.fromMap(Map<String, Object?> map) => InventarioSucursal(
        id: map['id'] as String,
        productoId: map['producto_id'] as String,
        sucursalId: map['sucursal_id'] as String,
        empresaId: map['empresa_id'] as String,
        stock: (map['stock'] as num?)?.toDouble() ?? 0,
        stockMinimo: (map['stock_minimo'] as num?)?.toDouble() ?? 0,
        ubicacion: map['ubicacion'] as String?,
        dispositivoId: map['dispositivo_id'] as String?,
        creadoEn: DateTime.parse(map['creado_en'] as String),
        actualizadoEn: DateTime.parse(map['actualizado_en'] as String),
        version: map['version'] as int? ?? 1,
        syncEstado: SyncEstadoX.desde(map['sync_estado'] as String?),
        sincronizadoEn: map['sincronizado_en'] != null ? DateTime.parse(map['sincronizado_en'] as String) : null,
        remotoId: map['remoto_id'] as String?,
        eliminado: (map['eliminado'] as int? ?? 0) == 1,
      );
}

/// Kardex: cada cambio de stock queda registrado (nunca se pisa la cantidad
/// directamente), para poder auditar y para que la sincronizacion resuelva
/// conflictos por movimientos en vez de por "ultimo valor gana".
class MovimientoInventario {
  const MovimientoInventario({
    required this.id,
    required this.productoId,
    required this.sucursalId,
    required this.empresaId,
    required this.tipoMovimiento,
    required this.cantidad,
    required this.stockAnterior,
    required this.stockNuevo,
    this.costoUnitario,
    this.referenciaTipo,
    this.referenciaId,
    this.sucursalOrigenId,
    this.sucursalDestinoId,
    this.nota,
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
  final String sucursalId;
  final String empresaId;
  final String tipoMovimiento;
  final double cantidad;
  final double stockAnterior;
  final double stockNuevo;
  final double? costoUnitario;
  final String? referenciaTipo;
  final String? referenciaId;
  final String? sucursalOrigenId;
  final String? sucursalDestinoId;
  final String? nota;
  final String? dispositivoId;
  final DateTime creadoEn;
  final DateTime actualizadoEn;
  final int version;
  final SyncEstado syncEstado;
  final DateTime? sincronizadoEn;
  final String? remotoId;
  final bool eliminado;

  Map<String, Object?> toMap() => {
        'id': id, 'producto_id': productoId, 'sucursal_id': sucursalId, 'empresa_id': empresaId,
        'tipo_movimiento': tipoMovimiento, 'cantidad': cantidad, 'stock_anterior': stockAnterior,
        'stock_nuevo': stockNuevo, 'costo_unitario': costoUnitario,
        'referencia_tipo': referenciaTipo, 'referencia_id': referenciaId,
        'sucursal_origen_id': sucursalOrigenId, 'sucursal_destino_id': sucursalDestinoId,
        'nota': nota, 'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(), 'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version, 'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(), 'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory MovimientoInventario.fromMap(Map<String, Object?> map) => MovimientoInventario(
        id: map['id'] as String,
        productoId: map['producto_id'] as String,
        sucursalId: map['sucursal_id'] as String,
        empresaId: map['empresa_id'] as String,
        tipoMovimiento: map['tipo_movimiento'] as String,
        cantidad: (map['cantidad'] as num).toDouble(),
        stockAnterior: (map['stock_anterior'] as num).toDouble(),
        stockNuevo: (map['stock_nuevo'] as num).toDouble(),
        costoUnitario: (map['costo_unitario'] as num?)?.toDouble(),
        referenciaTipo: map['referencia_tipo'] as String?,
        referenciaId: map['referencia_id'] as String?,
        sucursalOrigenId: map['sucursal_origen_id'] as String?,
        sucursalDestinoId: map['sucursal_destino_id'] as String?,
        nota: map['nota'] as String?,
        dispositivoId: map['dispositivo_id'] as String?,
        creadoEn: DateTime.parse(map['creado_en'] as String),
        actualizadoEn: DateTime.parse(map['actualizado_en'] as String),
        version: map['version'] as int? ?? 1,
        syncEstado: SyncEstadoX.desde(map['sync_estado'] as String?),
        sincronizadoEn: map['sincronizado_en'] != null ? DateTime.parse(map['sincronizado_en'] as String) : null,
        remotoId: map['remoto_id'] as String?,
        eliminado: (map['eliminado'] as int? ?? 0) == 1,
      );
}

/// Fila de lectura para la pantalla de Inventario: [InventarioSucursal] mas
/// los campos de [Producto] que hacen falta mostrar en la lista, sin cargar
/// la entidad Producto completa por cada renglon.
class ItemInventario {
  const ItemInventario({
    required this.inventarioId,
    required this.productoId,
    required this.nombre,
    this.sku,
    this.codigoBarras,
    required this.unidadMedida,
    required this.stock,
    required this.stockMinimo,
    this.precioVenta = 0,
  });

  final String inventarioId;
  final String productoId;
  final String nombre;
  final String? sku;
  final String? codigoBarras;
  final String unidadMedida;
  final double stock;
  final double stockMinimo;
  final double precioVenta;

  bool get stockBajo => stock <= stockMinimo && stockMinimo > 0;
  bool get agotado => stock <= 0;

  factory ItemInventario.fromMap(Map<String, Object?> map) => ItemInventario(
        inventarioId: map['inventario_id'] as String,
        productoId: map['producto_id'] as String,
        nombre: map['nombre'] as String,
        sku: map['sku'] as String?,
        codigoBarras: map['codigo_barras'] as String?,
        unidadMedida: map['unidad_medida'] as String? ?? 'unidad',
        stock: (map['stock'] as num?)?.toDouble() ?? 0,
        stockMinimo: (map['stock_minimo'] as num?)?.toDouble() ?? 0,
        precioVenta: (map['precio_venta'] as num?)?.toDouble() ?? 0,
      );
}

class TipoMovimientoInventario {
  static const venta = 'venta';
  static const compra = 'compra';
  static const devolucion = 'devolucion';
  static const ajuste = 'ajuste';
  static const transferenciaSalida = 'transferencia_salida';
  static const transferenciaEntrada = 'transferencia_entrada';
  static const perdida = 'perdida';
  static const vencimiento = 'vencimiento';
  static const entradaManual = 'entrada_manual';
  static const salidaManual = 'salida_manual';
}

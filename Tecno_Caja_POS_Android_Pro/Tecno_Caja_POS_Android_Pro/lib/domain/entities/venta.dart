import '../../core/constants/sync_estado.dart';

class EstadoVenta {
  static const completada = 'completada';
  static const suspendida = 'suspendida';
  static const anulada = 'anulada';
  static const cotizacionConvertida = 'cotizacion_convertida';
}

class TipoDocumentoVenta {
  static const ticket = 'ticket';
  static const facturaCreditoFiscal = 'factura_credito_fiscal';
  static const facturaConsumo = 'factura_consumo';
  static const notaCredito = 'nota_credito';
  static const notaDebito = 'nota_debito';
}

class MetodoPago {
  static const efectivo = 'efectivo';
  static const tarjeta = 'tarjeta';
  static const transferencia = 'transferencia';
  static const credito = 'credito';
  static const combinado = 'combinado';
}

class Venta {
  const Venta({
    required this.id,
    this.numeroFactura,
    this.tipoDocumento = TipoDocumentoVenta.ticket,
    this.clienteId,
    this.sesionCajaId,
    required this.usuarioId,
    this.subtotal = 0,
    this.descuentoMonto = 0,
    this.descuentoPorcentaje = 0,
    this.itbis = 0,
    this.impuestosAdicionales = 0,
    this.total = 0,
    this.moneda = 'DOP',
    this.tasaCambio,
    this.montoRecibido,
    this.cambio,
    this.redondeoAplicado = 0,
    this.metodoPago = MetodoPago.efectivo,
    this.estado = EstadoVenta.completada,
    this.motivoAnulacion,
    this.nota,
    this.encf,
    this.tipoEcf,
    this.ecfEstado,
    this.ecfTrackId,
    this.ecfQrUrl,
    this.ecfError,
    required this.empresaId,
    this.sucursalId,
    this.cajaId,
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
  final String? numeroFactura;
  final String tipoDocumento;
  final String? clienteId;
  final String? sesionCajaId;
  final String usuarioId;
  final double subtotal;
  final double descuentoMonto;
  final double descuentoPorcentaje;
  final double itbis;
  final double impuestosAdicionales;
  final double total;
  final String moneda;
  final double? tasaCambio;
  final double? montoRecibido;
  final double? cambio;
  final double redondeoAplicado;
  final String metodoPago;
  final String estado;
  final String? motivoAnulacion;
  final String? nota;
  final String? encf;
  final String? tipoEcf;
  final String? ecfEstado;
  final String? ecfTrackId;
  final String? ecfQrUrl;
  final String? ecfError;
  final String empresaId;
  final String? sucursalId;
  final String? cajaId;
  final String? dispositivoId;
  final DateTime creadoEn;
  final DateTime actualizadoEn;
  final int version;
  final SyncEstado syncEstado;
  final DateTime? sincronizadoEn;
  final String? remotoId;
  final bool eliminado;

  Venta copyWith({
    String? estado, String? motivoAnulacion, String? encf, String? tipoEcf, String? ecfEstado,
    String? ecfTrackId, String? ecfQrUrl, String? ecfError, String? numeroFactura,
  }) {
    return Venta(
      id: id, tipoDocumento: tipoDocumento, clienteId: clienteId, sesionCajaId: sesionCajaId,
      usuarioId: usuarioId, subtotal: subtotal, descuentoMonto: descuentoMonto,
      descuentoPorcentaje: descuentoPorcentaje, itbis: itbis, impuestosAdicionales: impuestosAdicionales,
      total: total, moneda: moneda, tasaCambio: tasaCambio, montoRecibido: montoRecibido,
      cambio: cambio, redondeoAplicado: redondeoAplicado, metodoPago: metodoPago,
      numeroFactura: numeroFactura ?? this.numeroFactura,
      estado: estado ?? this.estado, motivoAnulacion: motivoAnulacion ?? this.motivoAnulacion,
      nota: nota, encf: encf ?? this.encf, tipoEcf: tipoEcf ?? this.tipoEcf,
      ecfEstado: ecfEstado ?? this.ecfEstado, ecfTrackId: ecfTrackId ?? this.ecfTrackId,
      ecfQrUrl: ecfQrUrl ?? this.ecfQrUrl, ecfError: ecfError ?? this.ecfError,
      empresaId: empresaId, sucursalId: sucursalId, cajaId: cajaId, dispositivoId: dispositivoId,
      creadoEn: creadoEn, actualizadoEn: DateTime.now(), version: version + 1,
      syncEstado: SyncEstado.pendiente, sincronizadoEn: sincronizadoEn, remotoId: remotoId,
      eliminado: eliminado,
    );
  }

  Map<String, Object?> toMap() => {
        'id': id, 'numero_factura': numeroFactura, 'tipo_documento': tipoDocumento,
        'cliente_id': clienteId, 'sesion_caja_id': sesionCajaId, 'usuario_id': usuarioId,
        'subtotal': subtotal, 'descuento_monto': descuentoMonto, 'descuento_porcentaje': descuentoPorcentaje,
        'itbis': itbis, 'impuestos_adicionales': impuestosAdicionales, 'total': total,
        'moneda': moneda, 'tasa_cambio': tasaCambio, 'monto_recibido': montoRecibido,
        'cambio': cambio, 'redondeo_aplicado': redondeoAplicado, 'metodo_pago': metodoPago,
        'estado': estado, 'motivo_anulacion': motivoAnulacion, 'nota': nota,
        'encf': encf, 'tipo_ecf': tipoEcf, 'ecf_estado': ecfEstado, 'ecf_track_id': ecfTrackId,
        'ecf_qr_url': ecfQrUrl, 'ecf_error': ecfError,
        'empresa_id': empresaId, 'sucursal_id': sucursalId, 'caja_id': cajaId,
        'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(), 'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version, 'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(), 'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory Venta.fromMap(Map<String, Object?> map) => Venta(
        id: map['id'] as String,
        numeroFactura: map['numero_factura'] as String?,
        tipoDocumento: map['tipo_documento'] as String? ?? TipoDocumentoVenta.ticket,
        clienteId: map['cliente_id'] as String?,
        sesionCajaId: map['sesion_caja_id'] as String?,
        usuarioId: map['usuario_id'] as String,
        subtotal: (map['subtotal'] as num?)?.toDouble() ?? 0,
        descuentoMonto: (map['descuento_monto'] as num?)?.toDouble() ?? 0,
        descuentoPorcentaje: (map['descuento_porcentaje'] as num?)?.toDouble() ?? 0,
        itbis: (map['itbis'] as num?)?.toDouble() ?? 0,
        impuestosAdicionales: (map['impuestos_adicionales'] as num?)?.toDouble() ?? 0,
        total: (map['total'] as num?)?.toDouble() ?? 0,
        moneda: map['moneda'] as String? ?? 'DOP',
        tasaCambio: (map['tasa_cambio'] as num?)?.toDouble(),
        montoRecibido: (map['monto_recibido'] as num?)?.toDouble(),
        cambio: (map['cambio'] as num?)?.toDouble(),
        redondeoAplicado: (map['redondeo_aplicado'] as num?)?.toDouble() ?? 0,
        metodoPago: map['metodo_pago'] as String? ?? MetodoPago.efectivo,
        estado: map['estado'] as String? ?? EstadoVenta.completada,
        motivoAnulacion: map['motivo_anulacion'] as String?,
        nota: map['nota'] as String?,
        encf: map['encf'] as String?,
        tipoEcf: map['tipo_ecf'] as String?,
        ecfEstado: map['ecf_estado'] as String?,
        ecfTrackId: map['ecf_track_id'] as String?,
        ecfQrUrl: map['ecf_qr_url'] as String?,
        ecfError: map['ecf_error'] as String?,
        empresaId: map['empresa_id'] as String,
        sucursalId: map['sucursal_id'] as String?,
        cajaId: map['caja_id'] as String?,
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

class VentaItem {
  const VentaItem({
    required this.id,
    required this.ventaId,
    required this.productoId,
    required this.nombreProductoSnapshot,
    required this.cantidad,
    required this.precioUnitario,
    this.precioOriginal,
    this.descuentoMonto = 0,
    this.descuentoPorcentaje = 0,
    this.tasaItbis = 0,
    required this.subtotalLinea,
    this.ofertaId,
    this.nota,
    required this.empresaId,
    this.sucursalId,
    this.cajaId,
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
  final String ventaId;
  final String productoId;
  final String nombreProductoSnapshot;
  final double cantidad;
  final double precioUnitario;
  final double? precioOriginal;
  final double descuentoMonto;
  final double descuentoPorcentaje;
  final double tasaItbis;
  final double subtotalLinea;
  final String? ofertaId;
  final String? nota;
  final String empresaId;
  final String? sucursalId;
  final String? cajaId;
  final String? dispositivoId;
  final DateTime creadoEn;
  final DateTime actualizadoEn;
  final int version;
  final SyncEstado syncEstado;
  final DateTime? sincronizadoEn;
  final String? remotoId;
  final bool eliminado;

  Map<String, Object?> toMap() => {
        'id': id, 'venta_id': ventaId, 'producto_id': productoId,
        'nombre_producto_snapshot': nombreProductoSnapshot, 'cantidad': cantidad,
        'precio_unitario': precioUnitario, 'precio_original': precioOriginal,
        'descuento_monto': descuentoMonto, 'descuento_porcentaje': descuentoPorcentaje,
        'tasa_itbis': tasaItbis, 'subtotal_linea': subtotalLinea, 'oferta_id': ofertaId,
        'nota': nota, 'empresa_id': empresaId, 'sucursal_id': sucursalId, 'caja_id': cajaId,
        'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(), 'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version, 'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(), 'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory VentaItem.fromMap(Map<String, Object?> map) => VentaItem(
        id: map['id'] as String,
        ventaId: map['venta_id'] as String,
        productoId: map['producto_id'] as String,
        nombreProductoSnapshot: map['nombre_producto_snapshot'] as String,
        cantidad: (map['cantidad'] as num).toDouble(),
        precioUnitario: (map['precio_unitario'] as num).toDouble(),
        precioOriginal: (map['precio_original'] as num?)?.toDouble(),
        descuentoMonto: (map['descuento_monto'] as num?)?.toDouble() ?? 0,
        descuentoPorcentaje: (map['descuento_porcentaje'] as num?)?.toDouble() ?? 0,
        tasaItbis: (map['tasa_itbis'] as num?)?.toDouble() ?? 0,
        subtotalLinea: (map['subtotal_linea'] as num).toDouble(),
        ofertaId: map['oferta_id'] as String?,
        nota: map['nota'] as String?,
        empresaId: map['empresa_id'] as String,
        sucursalId: map['sucursal_id'] as String?,
        cajaId: map['caja_id'] as String?,
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

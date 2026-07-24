import '../../core/constants/sync_estado.dart';

class EstadoSesionCaja {
  static const abierta = 'abierta';
  static const cerrada = 'cerrada';
}

class SesionCaja {
  const SesionCaja({
    required this.id,
    required this.usuarioAperturaId,
    this.usuarioCierreId,
    this.montoApertura = 0,
    this.montoEsperado,
    this.montoContado,
    this.diferencia,
    this.estado = EstadoSesionCaja.abierta,
    required this.abiertaEn,
    this.cerradaEn,
    this.tasaCambioUsd,
    this.notaCierre,
    required this.empresaId,
    required this.sucursalId,
    required this.cajaId,
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
  final String usuarioAperturaId;
  final String? usuarioCierreId;
  final double montoApertura;
  final double? montoEsperado;
  final double? montoContado;
  final double? diferencia;
  final String estado;
  final DateTime abiertaEn;
  final DateTime? cerradaEn;
  final double? tasaCambioUsd;
  final String? notaCierre;
  final String empresaId;
  final String sucursalId;
  final String cajaId;
  final String? dispositivoId;
  final DateTime creadoEn;
  final DateTime actualizadoEn;
  final int version;
  final SyncEstado syncEstado;
  final DateTime? sincronizadoEn;
  final String? remotoId;
  final bool eliminado;

  bool get estaAbierta => estado == EstadoSesionCaja.abierta;

  SesionCaja copyWith({
    String? usuarioCierreId, double? montoEsperado, double? montoContado, double? diferencia,
    String? estado, DateTime? cerradaEn, String? notaCierre,
  }) {
    return SesionCaja(
      id: id, usuarioAperturaId: usuarioAperturaId,
      usuarioCierreId: usuarioCierreId ?? this.usuarioCierreId,
      montoApertura: montoApertura, montoEsperado: montoEsperado ?? this.montoEsperado,
      montoContado: montoContado ?? this.montoContado, diferencia: diferencia ?? this.diferencia,
      estado: estado ?? this.estado, abiertaEn: abiertaEn, cerradaEn: cerradaEn ?? this.cerradaEn,
      tasaCambioUsd: tasaCambioUsd, notaCierre: notaCierre ?? this.notaCierre,
      empresaId: empresaId, sucursalId: sucursalId, cajaId: cajaId, dispositivoId: dispositivoId,
      creadoEn: creadoEn, actualizadoEn: DateTime.now(), version: version + 1,
      syncEstado: SyncEstado.pendiente, sincronizadoEn: sincronizadoEn, remotoId: remotoId,
      eliminado: eliminado,
    );
  }

  Map<String, Object?> toMap() => {
        'id': id, 'usuario_apertura_id': usuarioAperturaId, 'usuario_cierre_id': usuarioCierreId,
        'monto_apertura': montoApertura, 'monto_esperado': montoEsperado,
        'monto_contado': montoContado, 'diferencia': diferencia, 'estado': estado,
        'abierta_en': abiertaEn.toIso8601String(), 'cerrada_en': cerradaEn?.toIso8601String(),
        'tasa_cambio_usd': tasaCambioUsd, 'nota_cierre': notaCierre,
        'empresa_id': empresaId, 'sucursal_id': sucursalId, 'caja_id': cajaId,
        'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(), 'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version, 'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(), 'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory SesionCaja.fromMap(Map<String, Object?> map) => SesionCaja(
        id: map['id'] as String,
        usuarioAperturaId: map['usuario_apertura_id'] as String,
        usuarioCierreId: map['usuario_cierre_id'] as String?,
        montoApertura: (map['monto_apertura'] as num?)?.toDouble() ?? 0,
        montoEsperado: (map['monto_esperado'] as num?)?.toDouble(),
        montoContado: (map['monto_contado'] as num?)?.toDouble(),
        diferencia: (map['diferencia'] as num?)?.toDouble(),
        estado: map['estado'] as String? ?? EstadoSesionCaja.abierta,
        abiertaEn: DateTime.parse(map['abierta_en'] as String),
        cerradaEn: map['cerrada_en'] != null ? DateTime.parse(map['cerrada_en'] as String) : null,
        tasaCambioUsd: (map['tasa_cambio_usd'] as num?)?.toDouble(),
        notaCierre: map['nota_cierre'] as String?,
        empresaId: map['empresa_id'] as String,
        sucursalId: map['sucursal_id'] as String,
        cajaId: map['caja_id'] as String,
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

class TipoMovimientoCaja {
  static const entrada = 'entrada';
  static const salida = 'salida';
  static const gasto = 'gasto';
  static const retiro = 'retiro';
  static const deposito = 'deposito';
  static const ventaEfectivo = 'venta_efectivo';
}

class MovimientoCaja {
  const MovimientoCaja({
    required this.id,
    required this.sesionCajaId,
    required this.tipo,
    this.categoriaGasto,
    required this.monto,
    this.descripcion,
    required this.usuarioId,
    required this.ocurridoEn,
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
  final String sesionCajaId;
  final String tipo;
  final String? categoriaGasto;
  final double monto;
  final String? descripcion;
  final String usuarioId;
  final DateTime ocurridoEn;
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
        'id': id, 'sesion_caja_id': sesionCajaId, 'tipo': tipo, 'categoria_gasto': categoriaGasto,
        'monto': monto, 'descripcion': descripcion, 'usuario_id': usuarioId,
        'ocurrido_en': ocurridoEn.toIso8601String(),
        'empresa_id': empresaId, 'sucursal_id': sucursalId, 'caja_id': cajaId,
        'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(), 'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version, 'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(), 'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory MovimientoCaja.fromMap(Map<String, Object?> map) => MovimientoCaja(
        id: map['id'] as String,
        sesionCajaId: map['sesion_caja_id'] as String,
        tipo: map['tipo'] as String,
        categoriaGasto: map['categoria_gasto'] as String?,
        monto: (map['monto'] as num).toDouble(),
        descripcion: map['descripcion'] as String?,
        usuarioId: map['usuario_id'] as String,
        ocurridoEn: DateTime.parse(map['ocurrido_en'] as String),
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

import '../../core/constants/sync_estado.dart';

class Cliente {
  const Cliente({
    required this.id,
    required this.nombre,
    this.telefono,
    this.whatsapp,
    this.email,
    this.direccion,
    this.cedulaRnc,
    this.tipoComprobantePreferido,
    this.limiteCredito = 0,
    this.balance = 0,
    this.notas,
    this.activo = true,
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
  final String nombre;
  final String? telefono;
  final String? whatsapp;
  final String? email;
  final String? direccion;
  final String? cedulaRnc;
  final String? tipoComprobantePreferido;
  final double limiteCredito;
  final double balance;
  final String? notas;
  final bool activo;
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

  double get creditoDisponible => (limiteCredito - balance).clamp(0, double.infinity).toDouble();

  Cliente copyWith({
    String? nombre, String? telefono, String? whatsapp, String? email, String? direccion,
    String? cedulaRnc, double? limiteCredito, double? balance, String? notas, bool? activo,
  }) {
    return Cliente(
      id: id, empresaId: empresaId, sucursalId: sucursalId, dispositivoId: dispositivoId,
      nombre: nombre ?? this.nombre, telefono: telefono ?? this.telefono,
      whatsapp: whatsapp ?? this.whatsapp, email: email ?? this.email,
      direccion: direccion ?? this.direccion, cedulaRnc: cedulaRnc ?? this.cedulaRnc,
      tipoComprobantePreferido: tipoComprobantePreferido, limiteCredito: limiteCredito ?? this.limiteCredito,
      balance: balance ?? this.balance, notas: notas ?? this.notas, activo: activo ?? this.activo,
      creadoEn: creadoEn, actualizadoEn: DateTime.now(), version: version + 1,
      syncEstado: SyncEstado.pendiente, sincronizadoEn: sincronizadoEn, remotoId: remotoId,
      eliminado: eliminado,
    );
  }

  Map<String, Object?> toMap() => {
        'id': id, 'nombre': nombre, 'telefono': telefono, 'whatsapp': whatsapp, 'email': email,
        'direccion': direccion, 'cedula_rnc': cedulaRnc,
        'tipo_comprobante_preferido': tipoComprobantePreferido, 'limite_credito': limiteCredito,
        'balance': balance, 'notas': notas, 'activo': activo ? 1 : 0,
        'empresa_id': empresaId, 'sucursal_id': sucursalId, 'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(), 'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version, 'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(), 'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory Cliente.fromMap(Map<String, Object?> map) => Cliente(
        id: map['id'] as String,
        nombre: map['nombre'] as String,
        telefono: map['telefono'] as String?,
        whatsapp: map['whatsapp'] as String?,
        email: map['email'] as String?,
        direccion: map['direccion'] as String?,
        cedulaRnc: map['cedula_rnc'] as String?,
        tipoComprobantePreferido: map['tipo_comprobante_preferido'] as String?,
        limiteCredito: (map['limite_credito'] as num?)?.toDouble() ?? 0,
        balance: (map['balance'] as num?)?.toDouble() ?? 0,
        notas: map['notas'] as String?,
        activo: (map['activo'] as int? ?? 1) == 1,
        empresaId: map['empresa_id'] as String,
        sucursalId: map['sucursal_id'] as String?,
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

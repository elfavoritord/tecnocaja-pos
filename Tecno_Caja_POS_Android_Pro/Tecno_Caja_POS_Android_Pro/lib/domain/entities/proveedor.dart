import '../../core/constants/sync_estado.dart';

class Proveedor {
  const Proveedor({
    required this.id,
    required this.nombre,
    this.empresaProveedora,
    this.telefono,
    this.email,
    this.rnc,
    this.contacto,
    this.direccion,
    this.diasVisita,
    this.terminosPagoDias,
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
  final String? empresaProveedora;
  final String? telefono;
  final String? email;
  final String? rnc;
  final String? contacto;
  final String? direccion;
  final String? diasVisita;
  final int? terminosPagoDias;
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

  Proveedor copyWith({
    String? nombre, String? empresaProveedora, String? telefono, String? email, String? rnc,
    String? contacto, String? direccion, String? diasVisita, int? terminosPagoDias, bool? activo,
  }) {
    return Proveedor(
      id: id, empresaId: empresaId, sucursalId: sucursalId, dispositivoId: dispositivoId,
      nombre: nombre ?? this.nombre, empresaProveedora: empresaProveedora ?? this.empresaProveedora,
      telefono: telefono ?? this.telefono, email: email ?? this.email, rnc: rnc ?? this.rnc,
      contacto: contacto ?? this.contacto, direccion: direccion ?? this.direccion,
      diasVisita: diasVisita ?? this.diasVisita, terminosPagoDias: terminosPagoDias ?? this.terminosPagoDias,
      activo: activo ?? this.activo,
      creadoEn: creadoEn, actualizadoEn: DateTime.now(), version: version + 1,
      syncEstado: SyncEstado.pendiente, sincronizadoEn: sincronizadoEn, remotoId: remotoId,
      eliminado: eliminado,
    );
  }

  Map<String, Object?> toMap() => {
        'id': id, 'nombre': nombre, 'empresa_proveedora': empresaProveedora, 'telefono': telefono,
        'email': email, 'rnc': rnc, 'contacto': contacto, 'direccion': direccion,
        'dias_visita': diasVisita, 'terminos_pago_dias': terminosPagoDias, 'activo': activo ? 1 : 0,
        'empresa_id': empresaId, 'sucursal_id': sucursalId, 'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(), 'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version, 'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(), 'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory Proveedor.fromMap(Map<String, Object?> map) => Proveedor(
        id: map['id'] as String,
        nombre: map['nombre'] as String,
        empresaProveedora: map['empresa_proveedora'] as String?,
        telefono: map['telefono'] as String?,
        email: map['email'] as String?,
        rnc: map['rnc'] as String?,
        contacto: map['contacto'] as String?,
        direccion: map['direccion'] as String?,
        diasVisita: map['dias_visita'] as String?,
        terminosPagoDias: map['terminos_pago_dias'] as int?,
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

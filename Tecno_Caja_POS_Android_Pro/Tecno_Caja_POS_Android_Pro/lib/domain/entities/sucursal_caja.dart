import '../../core/constants/sync_estado.dart';

class Sucursal {
  const Sucursal({
    required this.id,
    required this.empresaId,
    required this.nombre,
    this.codigo,
    this.direccion,
    this.telefono,
    this.encargadoUsuarioId,
    this.activa = true,
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
  final String empresaId;
  final String nombre;
  final String? codigo;
  final String? direccion;
  final String? telefono;
  final String? encargadoUsuarioId;
  final bool activa;
  final String? dispositivoId;
  final DateTime creadoEn;
  final DateTime actualizadoEn;
  final int version;
  final SyncEstado syncEstado;
  final DateTime? sincronizadoEn;
  final String? remotoId;
  final bool eliminado;

  Sucursal copyWith({String? nombre, String? codigo, String? direccion, String? telefono, String? encargadoUsuarioId, bool? activa, DateTime? actualizadoEn, SyncEstado? syncEstado}) {
    return Sucursal(
      id: id,
      empresaId: empresaId,
      nombre: nombre ?? this.nombre,
      codigo: codigo ?? this.codigo,
      direccion: direccion ?? this.direccion,
      telefono: telefono ?? this.telefono,
      encargadoUsuarioId: encargadoUsuarioId ?? this.encargadoUsuarioId,
      activa: activa ?? this.activa,
      dispositivoId: dispositivoId,
      creadoEn: creadoEn,
      actualizadoEn: actualizadoEn ?? this.actualizadoEn,
      version: version + 1,
      syncEstado: syncEstado ?? SyncEstado.pendiente,
      sincronizadoEn: sincronizadoEn,
      remotoId: remotoId,
      eliminado: eliminado,
    );
  }

  Map<String, Object?> toMap() => {
        'id': id, 'empresa_id': empresaId, 'nombre': nombre, 'codigo': codigo,
        'direccion': direccion, 'telefono': telefono, 'encargado_usuario_id': encargadoUsuarioId,
        'activa': activa ? 1 : 0, 'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(), 'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version, 'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(), 'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory Sucursal.fromMap(Map<String, Object?> map) => Sucursal(
        id: map['id'] as String,
        empresaId: map['empresa_id'] as String,
        nombre: map['nombre'] as String,
        codigo: map['codigo'] as String?,
        direccion: map['direccion'] as String?,
        telefono: map['telefono'] as String?,
        encargadoUsuarioId: map['encargado_usuario_id'] as String?,
        activa: (map['activa'] as int? ?? 1) == 1,
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

class Caja {
  const Caja({
    required this.id,
    required this.empresaId,
    required this.sucursalId,
    required this.nombre,
    this.codigo,
    this.activa = true,
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
  final String empresaId;
  final String sucursalId;
  final String nombre;
  final String? codigo;
  final bool activa;
  final String? dispositivoId;
  final DateTime creadoEn;
  final DateTime actualizadoEn;
  final int version;
  final SyncEstado syncEstado;
  final DateTime? sincronizadoEn;
  final String? remotoId;
  final bool eliminado;

  Caja copyWith({String? nombre, String? codigo, bool? activa, DateTime? actualizadoEn, SyncEstado? syncEstado}) {
    return Caja(
      id: id, empresaId: empresaId, sucursalId: sucursalId,
      nombre: nombre ?? this.nombre, codigo: codigo ?? this.codigo,
      activa: activa ?? this.activa, dispositivoId: dispositivoId,
      creadoEn: creadoEn, actualizadoEn: actualizadoEn ?? this.actualizadoEn,
      version: version + 1, syncEstado: syncEstado ?? SyncEstado.pendiente,
      sincronizadoEn: sincronizadoEn, remotoId: remotoId, eliminado: eliminado,
    );
  }

  Map<String, Object?> toMap() => {
        'id': id, 'empresa_id': empresaId, 'sucursal_id': sucursalId, 'nombre': nombre,
        'codigo': codigo, 'activa': activa ? 1 : 0, 'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(), 'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version, 'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(), 'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory Caja.fromMap(Map<String, Object?> map) => Caja(
        id: map['id'] as String,
        empresaId: map['empresa_id'] as String,
        sucursalId: map['sucursal_id'] as String,
        nombre: map['nombre'] as String,
        codigo: map['codigo'] as String?,
        activa: (map['activa'] as int? ?? 1) == 1,
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

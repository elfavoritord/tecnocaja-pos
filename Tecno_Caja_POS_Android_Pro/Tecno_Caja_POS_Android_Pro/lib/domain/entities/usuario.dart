import '../../core/constants/roles.dart';
import '../../core/constants/sync_estado.dart';

class Usuario {
  const Usuario({
    required this.id,
    required this.empresaId,
    this.sucursalId,
    required this.nombre,
    this.apellido,
    required this.usuario,
    this.email,
    this.telefono,
    this.rol = RolBase.cajero,
    this.pinHash,
    this.fotoPath,
    this.firebaseUid,
    this.activo = true,
    this.ultimoAccesoEn,
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
  final String? sucursalId;
  final String nombre;
  final String? apellido;
  final String usuario;
  final String? email;
  final String? telefono;
  final RolBase rol;
  final String? pinHash;
  final String? fotoPath;
  final String? firebaseUid;
  final bool activo;
  final DateTime? ultimoAccesoEn;
  final String? dispositivoId;
  final DateTime creadoEn;
  final DateTime actualizadoEn;
  final int version;
  final SyncEstado syncEstado;
  final DateTime? sincronizadoEn;
  final String? remotoId;
  final bool eliminado;

  String get nombreCompleto => apellido == null || apellido!.isEmpty ? nombre : '$nombre $apellido';

  Usuario copyWith({
    String? nombre, String? apellido, String? email, String? telefono, RolBase? rol,
    String? pinHash, String? fotoPath, String? firebaseUid, bool? activo,
    DateTime? ultimoAccesoEn, DateTime? actualizadoEn, SyncEstado? syncEstado,
  }) {
    return Usuario(
      id: id, empresaId: empresaId, sucursalId: sucursalId,
      nombre: nombre ?? this.nombre, apellido: apellido ?? this.apellido, usuario: usuario,
      email: email ?? this.email, telefono: telefono ?? this.telefono, rol: rol ?? this.rol,
      pinHash: pinHash ?? this.pinHash, fotoPath: fotoPath ?? this.fotoPath,
      firebaseUid: firebaseUid ?? this.firebaseUid, activo: activo ?? this.activo,
      ultimoAccesoEn: ultimoAccesoEn ?? this.ultimoAccesoEn, dispositivoId: dispositivoId,
      creadoEn: creadoEn, actualizadoEn: actualizadoEn ?? this.actualizadoEn,
      version: version + 1, syncEstado: syncEstado ?? SyncEstado.pendiente,
      sincronizadoEn: sincronizadoEn, remotoId: remotoId, eliminado: eliminado,
    );
  }

  Map<String, Object?> toMap() => {
        'id': id, 'empresa_id': empresaId, 'sucursal_id': sucursalId, 'nombre': nombre,
        'apellido': apellido, 'usuario': usuario, 'email': email, 'telefono': telefono,
        'rol': rol.name, 'pin_hash': pinHash, 'foto_path': fotoPath, 'firebase_uid': firebaseUid,
        'activo': activo ? 1 : 0, 'ultimo_acceso_en': ultimoAccesoEn?.toIso8601String(),
        'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(), 'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version, 'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(), 'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory Usuario.fromMap(Map<String, Object?> map) => Usuario(
        id: map['id'] as String,
        empresaId: map['empresa_id'] as String,
        sucursalId: map['sucursal_id'] as String?,
        nombre: map['nombre'] as String,
        apellido: map['apellido'] as String?,
        usuario: map['usuario'] as String,
        email: map['email'] as String?,
        telefono: map['telefono'] as String?,
        rol: RolBase.values.firstWhere((r) => r.name == map['rol'], orElse: () => RolBase.cajero),
        pinHash: map['pin_hash'] as String?,
        fotoPath: map['foto_path'] as String?,
        firebaseUid: map['firebase_uid'] as String?,
        activo: (map['activo'] as int? ?? 1) == 1,
        ultimoAccesoEn: map['ultimo_acceso_en'] != null ? DateTime.parse(map['ultimo_acceso_en'] as String) : null,
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

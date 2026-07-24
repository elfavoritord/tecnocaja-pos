import '../../core/constants/sync_estado.dart';

class Categoria {
  const Categoria({
    required this.id,
    required this.empresaId,
    required this.nombre,
    this.color,
    this.icono,
    this.orden = 0,
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
  final String? color;
  final String? icono;
  final int orden;
  final bool activa;
  final String? dispositivoId;
  final DateTime creadoEn;
  final DateTime actualizadoEn;
  final int version;
  final SyncEstado syncEstado;
  final DateTime? sincronizadoEn;
  final String? remotoId;
  final bool eliminado;

  Categoria copyWith({String? nombre, String? color, String? icono, int? orden, bool? activa}) {
    return Categoria(
      id: id, empresaId: empresaId, nombre: nombre ?? this.nombre, color: color ?? this.color,
      icono: icono ?? this.icono, orden: orden ?? this.orden, activa: activa ?? this.activa,
      dispositivoId: dispositivoId, creadoEn: creadoEn, actualizadoEn: DateTime.now(),
      version: version + 1, syncEstado: SyncEstado.pendiente, sincronizadoEn: sincronizadoEn,
      remotoId: remotoId, eliminado: eliminado,
    );
  }

  Map<String, Object?> toMap() => {
        'id': id, 'empresa_id': empresaId, 'nombre': nombre, 'color': color, 'icono': icono,
        'orden': orden, 'activa': activa ? 1 : 0, 'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(), 'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version, 'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(), 'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory Categoria.fromMap(Map<String, Object?> map) => Categoria(
        id: map['id'] as String,
        empresaId: map['empresa_id'] as String,
        nombre: map['nombre'] as String,
        color: map['color'] as String?,
        icono: map['icono'] as String?,
        orden: map['orden'] as int? ?? 0,
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

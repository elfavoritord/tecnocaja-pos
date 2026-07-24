import '../../core/constants/sync_estado.dart';

class Empresa {
  const Empresa({
    required this.id,
    required this.nombre,
    this.nombreComercial,
    this.rncCedula,
    this.direccion,
    this.telefono,
    this.email,
    this.tipoNegocio,
    this.pais = 'RD',
    this.provincia,
    this.monedaPrincipal = 'DOP',
    this.logoPath,
    this.tipoPlan = 'trial',
    this.tasaItbisDefault = 0.18,
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
  final String? nombreComercial;
  final String? rncCedula;
  final String? direccion;
  final String? telefono;
  final String? email;
  final String? tipoNegocio;
  final String pais;
  final String? provincia;
  final String monedaPrincipal;
  final String? logoPath;
  final String tipoPlan;
  final double tasaItbisDefault;
  final String? dispositivoId;
  final DateTime creadoEn;
  final DateTime actualizadoEn;
  final int version;
  final SyncEstado syncEstado;
  final DateTime? sincronizadoEn;
  final String? remotoId;
  final bool eliminado;

  Empresa copyWith({
    String? nombre,
    String? nombreComercial,
    String? rncCedula,
    String? direccion,
    String? telefono,
    String? email,
    String? tipoNegocio,
    String? provincia,
    String? monedaPrincipal,
    String? logoPath,
    String? tipoPlan,
    double? tasaItbisDefault,
    DateTime? actualizadoEn,
    int? version,
    SyncEstado? syncEstado,
    DateTime? sincronizadoEn,
    String? remotoId,
    bool? eliminado,
  }) {
    return Empresa(
      id: id,
      nombre: nombre ?? this.nombre,
      nombreComercial: nombreComercial ?? this.nombreComercial,
      rncCedula: rncCedula ?? this.rncCedula,
      direccion: direccion ?? this.direccion,
      telefono: telefono ?? this.telefono,
      email: email ?? this.email,
      tipoNegocio: tipoNegocio ?? this.tipoNegocio,
      pais: pais,
      provincia: provincia ?? this.provincia,
      monedaPrincipal: monedaPrincipal ?? this.monedaPrincipal,
      logoPath: logoPath ?? this.logoPath,
      tipoPlan: tipoPlan ?? this.tipoPlan,
      tasaItbisDefault: tasaItbisDefault ?? this.tasaItbisDefault,
      dispositivoId: dispositivoId,
      creadoEn: creadoEn,
      actualizadoEn: actualizadoEn ?? this.actualizadoEn,
      version: version ?? this.version,
      syncEstado: syncEstado ?? this.syncEstado,
      sincronizadoEn: sincronizadoEn ?? this.sincronizadoEn,
      remotoId: remotoId ?? this.remotoId,
      eliminado: eliminado ?? this.eliminado,
    );
  }

  Map<String, Object?> toMap() => {
        'id': id,
        'nombre': nombre,
        'nombre_comercial': nombreComercial,
        'rnc_cedula': rncCedula,
        'direccion': direccion,
        'telefono': telefono,
        'email': email,
        'tipo_negocio': tipoNegocio,
        'pais': pais,
        'provincia': provincia,
        'moneda_principal': monedaPrincipal,
        'logo_path': logoPath,
        'tipo_plan': tipoPlan,
        'tasa_itbis_default': tasaItbisDefault,
        'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(),
        'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version,
        'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(),
        'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory Empresa.fromMap(Map<String, Object?> map) => Empresa(
        id: map['id'] as String,
        nombre: map['nombre'] as String,
        nombreComercial: map['nombre_comercial'] as String?,
        rncCedula: map['rnc_cedula'] as String?,
        direccion: map['direccion'] as String?,
        telefono: map['telefono'] as String?,
        email: map['email'] as String?,
        tipoNegocio: map['tipo_negocio'] as String?,
        pais: map['pais'] as String? ?? 'RD',
        provincia: map['provincia'] as String?,
        monedaPrincipal: map['moneda_principal'] as String? ?? 'DOP',
        logoPath: map['logo_path'] as String?,
        tipoPlan: map['tipo_plan'] as String? ?? 'trial',
        tasaItbisDefault: (map['tasa_itbis_default'] as num?)?.toDouble() ?? 0.18,
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

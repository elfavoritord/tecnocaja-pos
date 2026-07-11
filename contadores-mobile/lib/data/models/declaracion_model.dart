import 'package:cloud_firestore/cloud_firestore.dart';

class DeclaracionModel {
  final String id;
  final String contadorId;
  final String? clienteId;
  final String? clienteNombre;
  final String tipo;
  final String periodo;
  final String estado;
  final DateTime? fechaLimite;
  final DateTime? fechaEnvio;
  final String? observaciones;
  final String? numeroConfirmacion;
  final double? montoDeclarado;
  final double? montoPagado;
  final List<String> archivos;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  const DeclaracionModel({
    required this.id,
    required this.contadorId,
    required this.tipo,
    required this.periodo,
    required this.estado,
    this.clienteId,
    this.clienteNombre,
    this.fechaLimite,
    this.fechaEnvio,
    this.observaciones,
    this.numeroConfirmacion,
    this.montoDeclarado,
    this.montoPagado,
    this.archivos = const [],
    this.createdAt,
    this.updatedAt,
  });

  bool get isPendiente => estado == 'pendiente';
  bool get isEnviada => estado == 'enviada';
  bool get isAprobada => estado == 'aprobada';
  bool get isVencida {
    if (estado == 'vencida') return true;
    if (fechaLimite == null) return false;
    return fechaLimite!.isBefore(DateTime.now()) && !isEnviada && !isAprobada;
  }

  int get diasRestantes {
    if (fechaLimite == null) return 0;
    return fechaLimite!.difference(DateTime.now()).inDays;
  }

  factory DeclaracionModel.fromFirestore(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return DeclaracionModel.fromMap(doc.id, data);
  }

  factory DeclaracionModel.fromMap(String id, Map<String, dynamic> data) {
    DateTime? toDate(dynamic v) => v is Timestamp ? v.toDate() : null;

    return DeclaracionModel(
      id: id,
      contadorId: data['contadorId'] as String? ?? '',
      clienteId: data['clienteId'] as String?,
      clienteNombre: data['clienteNombre'] as String?,
      tipo: data['tipo'] as String? ?? '',
      periodo: data['periodo'] as String? ?? '',
      estado: data['estado'] as String? ?? 'pendiente',
      fechaLimite: toDate(data['fechaLimite']),
      fechaEnvio: toDate(data['fechaEnvio']),
      observaciones: data['observaciones'] as String?,
      numeroConfirmacion: data['numeroConfirmacion'] as String?,
      montoDeclarado: (data['montoDeclarado'] as num?)?.toDouble(),
      montoPagado: (data['montoPagado'] as num?)?.toDouble(),
      archivos: List<String>.from(data['archivos'] as List? ?? []),
      createdAt: toDate(data['createdAt']),
      updatedAt: toDate(data['updatedAt']),
    );
  }

  Map<String, dynamic> toFirestore() => {
        'contadorId': contadorId,
        if (clienteId != null) 'clienteId': clienteId,
        if (clienteNombre != null) 'clienteNombre': clienteNombre,
        'tipo': tipo,
        'periodo': periodo,
        'estado': estado,
        if (fechaLimite != null) 'fechaLimite': Timestamp.fromDate(fechaLimite!),
        if (fechaEnvio != null) 'fechaEnvio': Timestamp.fromDate(fechaEnvio!),
        if (observaciones != null) 'observaciones': observaciones,
        if (numeroConfirmacion != null) 'numeroConfirmacion': numeroConfirmacion,
        if (montoDeclarado != null) 'montoDeclarado': montoDeclarado,
        if (montoPagado != null) 'montoPagado': montoPagado,
        'archivos': archivos,
        'updatedAt': FieldValue.serverTimestamp(),
      };

  DeclaracionModel copyWith({
    String? estado,
    DateTime? fechaEnvio,
    String? observaciones,
    String? numeroConfirmacion,
    double? montoDeclarado,
    double? montoPagado,
    List<String>? archivos,
  }) =>
      DeclaracionModel(
        id: id,
        contadorId: contadorId,
        clienteId: clienteId,
        clienteNombre: clienteNombre,
        tipo: tipo,
        periodo: periodo,
        estado: estado ?? this.estado,
        fechaLimite: fechaLimite,
        fechaEnvio: fechaEnvio ?? this.fechaEnvio,
        observaciones: observaciones ?? this.observaciones,
        numeroConfirmacion: numeroConfirmacion ?? this.numeroConfirmacion,
        montoDeclarado: montoDeclarado ?? this.montoDeclarado,
        montoPagado: montoPagado ?? this.montoPagado,
        archivos: archivos ?? this.archivos,
        createdAt: createdAt,
        updatedAt: updatedAt,
      );
}

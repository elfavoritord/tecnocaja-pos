import 'package:cloud_firestore/cloud_firestore.dart';

class UserModel {
  final String uid;
  final String contadorDocId;
  final String email;
  final String fullName;
  final String nombreFirma;
  final String responsable;
  final String rnc;
  final String telefono;
  final String correo;
  final String? logoUrl;
  final bool isColaborador;
  final String? colaboradorId;
  final String? tipo;
  final String? estado;
  final List<String> clientesAsignados;
  final String? parentContadorId;

  const UserModel({
    required this.uid,
    required this.contadorDocId,
    required this.email,
    required this.fullName,
    required this.nombreFirma,
    required this.responsable,
    required this.rnc,
    required this.telefono,
    required this.correo,
    this.logoUrl,
    this.isColaborador = false,
    this.colaboradorId,
    this.tipo,
    this.estado,
    this.clientesAsignados = const [],
    this.parentContadorId,
  });

  bool get isActive => estado == null || estado == 'activo' || estado == 'active';

  String get displayName => nombreFirma.isNotEmpty ? nombreFirma : fullName;

  factory UserModel.fromMap(String uid, Map<String, dynamic> map) {
    return UserModel(
      uid: uid,
      contadorDocId: map['contadorDocId'] as String? ?? uid,
      email: map['email'] as String? ?? '',
      fullName: map['fullName'] as String? ?? '',
      nombreFirma: map['nombre_firma'] as String? ?? '',
      responsable: map['responsable'] as String? ?? '',
      rnc: map['rnc'] as String? ?? '',
      telefono: map['telefono'] as String? ?? '',
      correo: map['correo'] as String? ?? map['email'] as String? ?? '',
      logoUrl: map['logo_url'] as String?,
      isColaborador: map['isColaborador'] as bool? ?? false,
      colaboradorId: map['colaboradorId'] as String?,
      tipo: map['tipo'] as String?,
      estado: map['estado'] as String?,
      clientesAsignados: List<String>.from(map['clientesAsignados'] as List? ?? []),
      parentContadorId: map['parentContadorId'] as String?,
    );
  }

  Map<String, dynamic> toMap() => {
        'uid': uid,
        'contadorDocId': contadorDocId,
        'email': email,
        'fullName': fullName,
        'nombre_firma': nombreFirma,
        'responsable': responsable,
        'rnc': rnc,
        'telefono': telefono,
        'correo': correo,
        'logo_url': logoUrl,
        'isColaborador': isColaborador,
        'colaboradorId': colaboradorId,
        'tipo': tipo,
        'estado': estado,
        'clientesAsignados': clientesAsignados,
        'parentContadorId': parentContadorId,
      };

  UserModel copyWith({
    String? nombreFirma,
    String? responsable,
    String? rnc,
    String? telefono,
    String? correo,
    String? logoUrl,
  }) =>
      UserModel(
        uid: uid,
        contadorDocId: contadorDocId,
        email: email,
        fullName: fullName,
        nombreFirma: nombreFirma ?? this.nombreFirma,
        responsable: responsable ?? this.responsable,
        rnc: rnc ?? this.rnc,
        telefono: telefono ?? this.telefono,
        correo: correo ?? this.correo,
        logoUrl: logoUrl ?? this.logoUrl,
        isColaborador: isColaborador,
        colaboradorId: colaboradorId,
        tipo: tipo,
        estado: estado,
        clientesAsignados: clientesAsignados,
        parentContadorId: parentContadorId,
      );
}

class ClienteModel {
  final String id;
  final String contadorId;
  final String businessName;
  final String? rnc;
  final String? propietario;
  final String? correo;
  final String? telefono;
  final String? direccion;
  final String status;
  final String? planCode;
  final DateTime? expiresAt;
  final DateTime? trialEndsAt;
  final DateTime? syncedAt;
  final DateTime? createdAt;
  final int? diasRestantes;
  final Map<String, dynamic> extra;

  const ClienteModel({
    required this.id,
    required this.contadorId,
    required this.businessName,
    this.rnc,
    this.propietario,
    this.correo,
    this.telefono,
    this.direccion,
    this.status = 'trial',
    this.planCode,
    this.expiresAt,
    this.trialEndsAt,
    this.syncedAt,
    this.createdAt,
    this.diasRestantes,
    this.extra = const {},
  });

  bool get isActivo => status.toLowerCase() == 'active';
  bool get isTrial => status.toLowerCase() == 'trial';
  bool get isVencido => status.toLowerCase() == 'expired' || status.toLowerCase() == 'cancelled';
  bool get isSuspendido => status.toLowerCase() == 'suspended';

  DateTime? get vencimiento => status.toLowerCase() == 'active' ? expiresAt : (trialEndsAt ?? expiresAt);

  factory ClienteModel.fromFirestore(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return ClienteModel.fromMap(doc.id, data);
  }

  factory ClienteModel.fromMap(String id, Map<String, dynamic> data) {
    Timestamp? toTs(dynamic v) => v is Timestamp ? v : null;
    DateTime? toDate(dynamic v) => toTs(v)?.toDate();

    return ClienteModel(
      id: id,
      contadorId: data['contadorId'] as String? ?? '',
      businessName: data['businessName'] as String? ?? data['businessKey'] as String? ?? id,
      rnc: data['rnc'] as String?,
      propietario: data['propietario'] as String?,
      correo: data['correo'] as String? ?? data['email'] as String?,
      telefono: data['telefono'] as String?,
      direccion: data['direccion'] as String?,
      status: data['status'] as String? ?? 'trial',
      planCode: data['planCode'] as String? ?? data['plan_code'] as String?,
      expiresAt: toDate(data['expiresAt']),
      trialEndsAt: toDate(data['trialEndsAt']),
      syncedAt: toDate(data['syncedAt']),
      createdAt: toDate(data['createdAt']),
      diasRestantes: data['diasRestantes'] as int?,
      extra: Map<String, dynamic>.from(data),
    );
  }

  Map<String, dynamic> toFirestore() => {
        'contadorId': contadorId,
        'businessName': businessName,
        if (rnc != null) 'rnc': rnc,
        if (propietario != null) 'propietario': propietario,
        if (correo != null) 'correo': correo,
        if (telefono != null) 'telefono': telefono,
        if (direccion != null) 'direccion': direccion,
        'status': status,
        if (planCode != null) 'planCode': planCode,
        'updatedAt': FieldValue.serverTimestamp(),
      };
}

import 'package:cloud_firestore/cloud_firestore.dart';

class AgendaEventModel {
  final String id;
  final String contadorId;
  final String titulo;
  final String? descripcion;
  final DateTime fechaInicio;
  final DateTime? fechaFin;
  final bool todoElDia;
  final String? clienteId;
  final String? clienteNombre;
  final String tipo;
  final String color;
  final bool recordatorio;
  final int? minutosAntes;
  final DateTime? createdAt;

  const AgendaEventModel({
    required this.id,
    required this.contadorId,
    required this.titulo,
    required this.fechaInicio,
    required this.tipo,
    required this.color,
    this.descripcion,
    this.fechaFin,
    this.todoElDia = false,
    this.clienteId,
    this.clienteNombre,
    this.recordatorio = false,
    this.minutosAntes,
    this.createdAt,
  });

  factory AgendaEventModel.fromFirestore(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return AgendaEventModel.fromMap(doc.id, data);
  }

  factory AgendaEventModel.fromMap(String id, Map<String, dynamic> data) {
    DateTime? toDate(dynamic v) => v is Timestamp ? v.toDate() : null;

    return AgendaEventModel(
      id: id,
      contadorId: data['contadorId'] as String? ?? '',
      titulo: data['titulo'] as String? ?? '',
      descripcion: data['descripcion'] as String?,
      fechaInicio: toDate(data['fechaInicio']) ?? DateTime.now(),
      fechaFin: toDate(data['fechaFin']),
      todoElDia: data['todoElDia'] as bool? ?? false,
      clienteId: data['clienteId'] as String?,
      clienteNombre: data['clienteNombre'] as String?,
      tipo: data['tipo'] as String? ?? 'cita',
      color: data['color'] as String? ?? '#2563EB',
      recordatorio: data['recordatorio'] as bool? ?? false,
      minutosAntes: data['minutosAntes'] as int?,
      createdAt: toDate(data['createdAt']),
    );
  }

  Map<String, dynamic> toFirestore() => {
        'contadorId': contadorId,
        'titulo': titulo,
        if (descripcion != null) 'descripcion': descripcion,
        'fechaInicio': Timestamp.fromDate(fechaInicio),
        if (fechaFin != null) 'fechaFin': Timestamp.fromDate(fechaFin!),
        'todoElDia': todoElDia,
        if (clienteId != null) 'clienteId': clienteId,
        if (clienteNombre != null) 'clienteNombre': clienteNombre,
        'tipo': tipo,
        'color': color,
        'recordatorio': recordatorio,
        if (minutosAntes != null) 'minutosAntes': minutosAntes,
        'updatedAt': FieldValue.serverTimestamp(),
      };

  static const tipos = ['cita', 'reunion', 'vencimiento', 'recordatorio', 'otro'];
  static const colores = [
    '#2563EB', '#7C3AED', '#10B981', '#F59E0B',
    '#EF4444', '#0EA5E9', '#EC4899', '#14B8A6',
  ];
}

class DocumentoModel {
  final String id;
  final String contadorId;
  final String? clienteId;
  final String? clienteNombre;
  final String nombre;
  final String tipo;
  final String url;
  final String? storageRef;
  final int? tamanoBytes;
  final String? descripcion;
  final String? categoria;
  final DateTime? createdAt;
  final String uploadedBy;

  const DocumentoModel({
    required this.id,
    required this.contadorId,
    required this.nombre,
    required this.tipo,
    required this.url,
    required this.uploadedBy,
    this.clienteId,
    this.clienteNombre,
    this.storageRef,
    this.tamanoBytes,
    this.descripcion,
    this.categoria,
    this.createdAt,
  });

  String get extension => nombre.contains('.') ? nombre.split('.').last.toLowerCase() : '';

  bool get esPdf => extension == 'pdf';
  bool get esImagen => ['jpg', 'jpeg', 'png', 'gif', 'webp'].contains(extension);
  bool get esExcel => ['xls', 'xlsx'].contains(extension);
  bool get esWord => ['doc', 'docx'].contains(extension);
  bool get esXml => extension == 'xml';

  String get tamanoLabel {
    if (tamanoBytes == null) return '';
    if (tamanoBytes! < 1024) return '${tamanoBytes} B';
    if (tamanoBytes! < 1024 * 1024) return '${(tamanoBytes! / 1024).toStringAsFixed(1)} KB';
    return '${(tamanoBytes! / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  factory DocumentoModel.fromFirestore(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return DocumentoModel.fromMap(doc.id, data);
  }

  factory DocumentoModel.fromMap(String id, Map<String, dynamic> data) {
    DateTime? toDate(dynamic v) => v is Timestamp ? v.toDate() : null;

    return DocumentoModel(
      id: id,
      contadorId: data['contadorId'] as String? ?? '',
      clienteId: data['clienteId'] as String?,
      clienteNombre: data['clienteNombre'] as String?,
      nombre: data['nombre'] as String? ?? '',
      tipo: data['tipo'] as String? ?? '',
      url: data['url'] as String? ?? '',
      storageRef: data['storageRef'] as String?,
      tamanoBytes: data['tamanoBytes'] as int?,
      descripcion: data['descripcion'] as String?,
      categoria: data['categoria'] as String?,
      createdAt: toDate(data['createdAt']),
      uploadedBy: data['uploadedBy'] as String? ?? '',
    );
  }

  Map<String, dynamic> toFirestore() => {
        'contadorId': contadorId,
        if (clienteId != null) 'clienteId': clienteId,
        if (clienteNombre != null) 'clienteNombre': clienteNombre,
        'nombre': nombre,
        'tipo': tipo,
        'url': url,
        if (storageRef != null) 'storageRef': storageRef,
        if (tamanoBytes != null) 'tamanoBytes': tamanoBytes,
        if (descripcion != null) 'descripcion': descripcion,
        if (categoria != null) 'categoria': categoria,
        'uploadedBy': uploadedBy,
        'createdAt': FieldValue.serverTimestamp(),
      };

  static const categorias = ['declaraciones', 'contratos', 'estados_financieros', 'facturas', 'otros'];
}

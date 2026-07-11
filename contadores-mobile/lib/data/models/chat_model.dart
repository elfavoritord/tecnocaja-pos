import 'package:cloud_firestore/cloud_firestore.dart';

class ChatRoomModel {
  final String id;
  final String contadorId;
  final String? clienteId;
  final String? clienteNombre;
  final String? ultimoMensaje;
  final DateTime? ultimoMensajeAt;
  final String? ultimoMensajePor;
  final int noLeidos;
  final bool activo;

  const ChatRoomModel({
    required this.id,
    required this.contadorId,
    this.clienteId,
    this.clienteNombre,
    this.ultimoMensaje,
    this.ultimoMensajeAt,
    this.ultimoMensajePor,
    this.noLeidos = 0,
    this.activo = true,
  });

  factory ChatRoomModel.fromFirestore(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    DateTime? toDate(dynamic v) => v is Timestamp ? v.toDate() : null;

    return ChatRoomModel(
      id: doc.id,
      contadorId: data['contadorId'] as String? ?? '',
      clienteId: data['clienteId'] as String?,
      clienteNombre: data['clienteNombre'] as String?,
      ultimoMensaje: data['ultimoMensaje'] as String?,
      ultimoMensajeAt: toDate(data['ultimoMensajeAt']),
      ultimoMensajePor: data['ultimoMensajePor'] as String?,
      noLeidos: data['noLeidos'] as int? ?? 0,
      activo: data['activo'] as bool? ?? true,
    );
  }
}

class ChatMessageModel {
  final String id;
  final String roomId;
  final String senderId;
  final String senderNombre;
  final String contenido;
  final String tipo;
  final bool leido;
  final DateTime? createdAt;
  final String? archivoUrl;
  final String? archivoNombre;

  const ChatMessageModel({
    required this.id,
    required this.roomId,
    required this.senderId,
    required this.senderNombre,
    required this.contenido,
    required this.tipo,
    this.leido = false,
    this.createdAt,
    this.archivoUrl,
    this.archivoNombre,
  });

  bool get esTexto => tipo == 'texto';
  bool get esArchivo => tipo == 'archivo';
  bool get esImagen => tipo == 'imagen';

  factory ChatMessageModel.fromFirestore(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    DateTime? toDate(dynamic v) => v is Timestamp ? v.toDate() : null;

    return ChatMessageModel(
      id: doc.id,
      roomId: data['roomId'] as String? ?? '',
      senderId: data['senderId'] as String? ?? '',
      senderNombre: data['senderNombre'] as String? ?? '',
      contenido: data['contenido'] as String? ?? '',
      tipo: data['tipo'] as String? ?? 'texto',
      leido: data['leido'] as bool? ?? false,
      createdAt: toDate(data['createdAt']),
      archivoUrl: data['archivoUrl'] as String?,
      archivoNombre: data['archivoNombre'] as String?,
    );
  }

  Map<String, dynamic> toFirestore() => {
        'roomId': roomId,
        'senderId': senderId,
        'senderNombre': senderNombre,
        'contenido': contenido,
        'tipo': tipo,
        'leido': leido,
        'createdAt': FieldValue.serverTimestamp(),
        if (archivoUrl != null) 'archivoUrl': archivoUrl,
        if (archivoNombre != null) 'archivoNombre': archivoNombre,
      };
}

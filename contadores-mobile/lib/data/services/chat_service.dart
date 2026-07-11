import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/chat_model.dart';

class ChatService {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  // ── Salas de chat ──────────────────────────────────────────────────────────
  Stream<List<ChatRoomModel>> watchRooms(String contadorDocId) {
    return _db
        .collection('chat_rooms')
        .where('contadorId', isEqualTo: contadorDocId)
        .where('activo', isEqualTo: true)
        .orderBy('ultimoMensajeAt', descending: true)
        .snapshots()
        .map((s) => s.docs.map(ChatRoomModel.fromFirestore).toList());
  }

  Future<ChatRoomModel> getOrCreateRoom(
    String contadorDocId,
    String clienteId,
    String clienteNombre,
  ) async {
    final snap = await _db
        .collection('chat_rooms')
        .where('contadorId', isEqualTo: contadorDocId)
        .where('clienteId', isEqualTo: clienteId)
        .limit(1)
        .get();

    if (snap.docs.isNotEmpty) {
      return ChatRoomModel.fromFirestore(snap.docs.first);
    }

    final ref = await _db.collection('chat_rooms').add({
      'contadorId': contadorDocId,
      'clienteId': clienteId,
      'clienteNombre': clienteNombre,
      'noLeidos': 0,
      'activo': true,
      'createdAt': FieldValue.serverTimestamp(),
    });

    final doc = await ref.get();
    return ChatRoomModel.fromFirestore(doc);
  }

  // ── Mensajes ───────────────────────────────────────────────────────────────
  Stream<List<ChatMessageModel>> watchMessages(String roomId) {
    return _db
        .collection('chat_rooms')
        .doc(roomId)
        .collection('messages')
        .orderBy('createdAt', descending: false)
        .limitToLast(100)
        .snapshots()
        .map((s) => s.docs.map(ChatMessageModel.fromFirestore).toList());
  }

  Future<void> sendMessage(String roomId, ChatMessageModel msg) async {
    final batch = _db.batch();

    final msgRef = _db.collection('chat_rooms').doc(roomId).collection('messages').doc();
    batch.set(msgRef, msg.toFirestore());

    final roomRef = _db.collection('chat_rooms').doc(roomId);
    batch.update(roomRef, {
      'ultimoMensaje': msg.contenido,
      'ultimoMensajeAt': FieldValue.serverTimestamp(),
      'ultimoMensajePor': msg.senderId,
    });

    await batch.commit();
  }

  Future<void> markAsRead(String roomId, String userId) async {
    final unread = await _db
        .collection('chat_rooms')
        .doc(roomId)
        .collection('messages')
        .where('leido', isEqualTo: false)
        .where('senderId', isNotEqualTo: userId)
        .get();

    if (unread.docs.isEmpty) return;

    final batch = _db.batch();
    for (final doc in unread.docs) {
      batch.update(doc.reference, {'leido': true});
    }
    batch.update(_db.collection('chat_rooms').doc(roomId), {'noLeidos': 0});
    await batch.commit();
  }
}

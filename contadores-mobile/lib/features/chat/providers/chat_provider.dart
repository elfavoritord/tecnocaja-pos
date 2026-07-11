import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../data/models/chat_model.dart';
import '../../../data/services/chat_service.dart';
import '../../auth/providers/auth_provider.dart';

final chatServiceProvider = Provider<ChatService>((ref) => ChatService());

final chatRoomsProvider = StreamProvider<List<ChatRoomModel>>((ref) {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  if (profile == null) return const Stream.empty();
  return ref.read(chatServiceProvider).watchRooms(profile.contadorDocId);
});

final chatMessagesProvider = StreamProvider.family<List<ChatMessageModel>, String>((ref, roomId) {
  return ref.read(chatServiceProvider).watchMessages(roomId);
});

class ChatSendNotifier extends StateNotifier<AsyncValue<void>> {
  final ChatService _service;
  final String _roomId;
  final String _senderId;
  final String _senderNombre;

  ChatSendNotifier(this._service, this._roomId, this._senderId, this._senderNombre)
      : super(const AsyncValue.data(null));

  Future<void> send(String texto) async {
    if (texto.trim().isEmpty) return;
    state = const AsyncValue.loading();
    try {
      final msg = ChatMessageModel(
        id: '',
        roomId: _roomId,
        senderId: _senderId,
        senderNombre: _senderNombre,
        contenido: texto.trim(),
        tipo: 'texto',
      );
      await _service.sendMessage(_roomId, msg);
      state = const AsyncValue.data(null);
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<void> markRead() async {
    await _service.markAsRead(_roomId, _senderId).catchError((_) {});
  }
}

final chatSendProvider = StateNotifierProvider.autoDispose.family<ChatSendNotifier, AsyncValue<void>, String>((ref, roomId) {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  return ChatSendNotifier(
    ref.read(chatServiceProvider),
    roomId,
    profile?.uid ?? '',
    profile?.displayName ?? 'Contador',
  );
});

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:timeago/timeago.dart' as timeago;
import '../../../core/constants/app_colors.dart';
import '../../../core/utils/formatters.dart';
import '../../../data/models/chat_model.dart';
import '../providers/chat_provider.dart';

class ChatListScreen extends ConsumerWidget {
  const ChatListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roomsAsync = ref.watch(chatRoomsProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Mensajes')),
      body: roomsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(e.toString(), style: const TextStyle(color: AppColors.error))),
        data: (rooms) => rooms.isEmpty
            ? const _EmptyView()
            : ListView.builder(
                padding: const EdgeInsets.symmetric(vertical: 8),
                itemCount: rooms.length,
                itemBuilder: (_, i) => _RoomTile(room: rooms[i]),
              ),
      ),
    );
  }
}

class _RoomTile extends StatelessWidget {
  final ChatRoomModel room;
  const _RoomTile({required this.room});

  @override
  Widget build(BuildContext context) {
    final nombre = room.clienteNombre ?? 'Chat ${room.id.substring(0, 6)}';
    final hora = room.ultimoMensajeAt != null ? timeago.format(room.ultimoMensajeAt!, locale: 'es') : '';

    return InkWell(
      onTap: () => context.push('/chat/${room.id}', extra: nombre),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            Stack(
              children: [
                CircleAvatar(
                  radius: 26,
                  backgroundColor: AppColors.primary.withValues(alpha: 0.12),
                  child: Text(
                    Formatters.iniciales(nombre),
                    style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w700, fontSize: 16),
                  ),
                ),
                if (room.noLeidos > 0)
                  Positioned(
                    right: 0,
                    top: 0,
                    child: Container(
                      width: 18, height: 18,
                      decoration: const BoxDecoration(color: AppColors.error, shape: BoxShape.circle),
                      alignment: Alignment.center,
                      child: Text('${room.noLeidos}', style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w700)),
                    ),
                  ),
              ],
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          nombre,
                          style: TextStyle(fontWeight: room.noLeidos > 0 ? FontWeight.w700 : FontWeight.w600, fontSize: 15),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (hora.isNotEmpty)
                        Text(hora, style: const TextStyle(color: AppColors.textTertiary, fontSize: 11)),
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text(
                    room.ultimoMensaje ?? 'Sin mensajes',
                    style: TextStyle(
                      color: room.noLeidos > 0 ? AppColors.textPrimary : AppColors.textSecondary,
                      fontWeight: room.noLeidos > 0 ? FontWeight.w500 : FontWeight.normal,
                      fontSize: 13,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyView extends StatelessWidget {
  const _EmptyView();

  @override
  Widget build(BuildContext context) => const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.chat_bubble_outline_rounded, size: 64, color: AppColors.textTertiary),
            SizedBox(height: 16),
            Text('No hay conversaciones activas', style: TextStyle(color: AppColors.textSecondary, fontSize: 15)),
            SizedBox(height: 8),
            Text('Los chats con clientes aparecerán aquí', style: TextStyle(color: AppColors.textTertiary, fontSize: 13)),
          ],
        ),
      );
}

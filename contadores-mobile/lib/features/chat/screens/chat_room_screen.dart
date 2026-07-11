import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../../core/constants/app_colors.dart';
import '../../../data/models/chat_model.dart';
import '../../auth/providers/auth_provider.dart';
import '../providers/chat_provider.dart';

class ChatRoomScreen extends ConsumerStatefulWidget {
  final String roomId;
  final String clienteNombre;

  const ChatRoomScreen({super.key, required this.roomId, required this.clienteNombre});

  @override
  ConsumerState<ChatRoomScreen> createState() => _ChatRoomScreenState();
}

class _ChatRoomScreenState extends ConsumerState<ChatRoomScreen> {
  final _msgCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(chatSendProvider(widget.roomId).notifier).markRead();
    });
  }

  @override
  void dispose() {
    _msgCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    if (_scrollCtrl.hasClients) {
      _scrollCtrl.animateTo(
        _scrollCtrl.position.maxScrollExtent,
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOut,
      );
    }
  }

  Future<void> _send() async {
    final txt = _msgCtrl.text.trim();
    if (txt.isEmpty) return;
    _msgCtrl.clear();
    await ref.read(chatSendProvider(widget.roomId).notifier).send(txt);
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
  }

  @override
  Widget build(BuildContext context) {
    final msgsAsync = ref.watch(chatMessagesProvider(widget.roomId));
    final profile = ref.watch(userProfileProvider).valueOrNull;
    final myUid = profile?.uid ?? '';

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(widget.clienteNombre, style: const TextStyle(fontSize: 16)),
            const Text('En línea', style: TextStyle(fontSize: 11, color: AppColors.success)),
          ],
        ),
        actions: [
          IconButton(icon: const Icon(Icons.call_outlined), onPressed: () {}),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: msgsAsync.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => Center(child: Text(e.toString())),
              data: (msgs) {
                if (msgs.isEmpty) {
                  return const Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.chat_bubble_outline_rounded, size: 48, color: AppColors.textTertiary),
                        SizedBox(height: 12),
                        Text('Inicia la conversación', style: TextStyle(color: AppColors.textSecondary)),
                      ],
                    ),
                  );
                }
                WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
                return ListView.builder(
                  controller: _scrollCtrl,
                  padding: const EdgeInsets.all(16),
                  itemCount: msgs.length,
                  itemBuilder: (_, i) {
                    final msg = msgs[i];
                    final isMe = msg.senderId == myUid;
                    final showDate = i == 0 || !_isSameDay(msgs[i - 1].createdAt, msg.createdAt);
                    return Column(
                      children: [
                        if (showDate) _DateDivider(date: msg.createdAt),
                        _MessageBubble(msg: msg, isMe: isMe),
                      ],
                    );
                  },
                );
              },
            ),
          ),
          _InputBar(controller: _msgCtrl, onSend: _send),
        ],
      ),
    );
  }

  bool _isSameDay(DateTime? a, DateTime? b) {
    if (a == null || b == null) return false;
    return a.year == b.year && a.month == b.month && a.day == b.day;
  }
}

class _DateDivider extends StatelessWidget {
  final DateTime? date;
  const _DateDivider({this.date});

  @override
  Widget build(BuildContext context) {
    if (date == null) return const SizedBox.shrink();
    final label = _label(date!);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(
        children: [
          const Expanded(child: Divider()),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Text(label, style: const TextStyle(fontSize: 12, color: AppColors.textTertiary)),
          ),
          const Expanded(child: Divider()),
        ],
      ),
    );
  }

  String _label(DateTime d) {
    final now = DateTime.now();
    if (d.year == now.year && d.month == now.month && d.day == now.day) return 'Hoy';
    final ayer = now.subtract(const Duration(days: 1));
    if (d.year == ayer.year && d.month == ayer.month && d.day == ayer.day) return 'Ayer';
    return DateFormat('d MMMM yyyy', 'es_DO').format(d);
  }
}

class _MessageBubble extends StatelessWidget {
  final ChatMessageModel msg;
  final bool isMe;
  const _MessageBubble({required this.msg, required this.isMe});

  @override
  Widget build(BuildContext context) {
    final hora = msg.createdAt != null ? DateFormat('HH:mm').format(msg.createdAt!) : '';

    return Align(
      alignment: isMe ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 6),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.75),
        decoration: BoxDecoration(
          color: isMe ? AppColors.primary : Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(18),
            topRight: const Radius.circular(18),
            bottomLeft: Radius.circular(isMe ? 18 : 4),
            bottomRight: Radius.circular(isMe ? 4 : 18),
          ),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (!isMe)
              Padding(
                padding: const EdgeInsets.only(bottom: 2),
                child: Text(msg.senderNombre, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: isMe ? Colors.white70 : AppColors.primary)),
              ),
            Text(
              msg.contenido,
              style: TextStyle(fontSize: 15, color: isMe ? Colors.white : Theme.of(context).colorScheme.onSurface),
            ),
            const SizedBox(height: 4),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(hora, style: TextStyle(fontSize: 10, color: isMe ? Colors.white60 : AppColors.textTertiary)),
                if (isMe) ...[
                  const SizedBox(width: 4),
                  Icon(msg.leido ? Icons.done_all_rounded : Icons.done_rounded, size: 14, color: msg.leido ? Colors.lightBlueAccent : Colors.white60),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _InputBar extends StatelessWidget {
  final TextEditingController controller;
  final VoidCallback onSend;

  const _InputBar({required this.controller, required this.onSend});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.fromLTRB(12, 8, 12, 8 + MediaQuery.of(context).viewInsets.bottom),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border(top: BorderSide(color: AppColors.lightBorder)),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: controller,
                textCapitalization: TextCapitalization.sentences,
                maxLines: 4,
                minLines: 1,
                decoration: InputDecoration(
                  hintText: 'Escribe un mensaje...',
                  filled: true,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: BorderSide.none),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                ),
                onSubmitted: (_) => onSend(),
              ),
            ),
            const SizedBox(width: 8),
            IconButton.filled(
              onPressed: onSend,
              icon: const Icon(Icons.send_rounded),
              style: IconButton.styleFrom(backgroundColor: AppColors.primary, foregroundColor: Colors.white),
            ),
          ],
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors/app_exception.dart';
import '../../core/theme/app_colors.dart';
import '../../data/repositories/whatsapp_bot_repository.dart';

class WhatsappBotScreen extends ConsumerStatefulWidget {
  const WhatsappBotScreen({super.key});

  @override
  ConsumerState<WhatsappBotScreen> createState() => _WhatsappBotScreenState();
}

class _WhatsappBotScreenState extends ConsumerState<WhatsappBotScreen> {
  final _ownerCtrl = TextEditingController();
  final _owner2Ctrl = TextEditingController();
  final _apiKeyCtrl = TextEditingController();
  final _instructionsCtrl = TextEditingController();
  String _provider = 'none';
  WhatsappBotStatus? _status;
  String? _error;
  bool _loading = true;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _ownerCtrl.dispose();
    _owner2Ctrl.dispose();
    _apiKeyCtrl.dispose();
    _instructionsCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final repo = ref.read(whatsappBotRepositoryProvider);
      final results = await Future.wait([
        repo.status(),
        repo.savedKeys(),
        repo.instructions(),
      ]);
      final status = results[0] as WhatsappBotStatus;
      final keys = results[1] as Map<String, Object?>;
      final instructions = results[2] as String;
      if (!mounted) return;
      setState(() {
        _status = status;
        _provider = keys['provider']?.toString() ?? 'none';
        _ownerCtrl.text = keys['ownerPhone']?.toString() ?? '';
        _owner2Ctrl.text = keys['ownerPhone2']?.toString() ?? '';
        _instructionsCtrl.text = instructions;
        _loading = false;
      });
    } on AppException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'No se pudo cargar WhatsApp Bot: $e';
        _loading = false;
      });
    }
  }

  Future<void> _start() async {
    if (_ownerCtrl.text.trim().isEmpty) return;
    setState(() => _saving = true);
    try {
      await ref.read(whatsappBotRepositoryProvider).start(
            ownerPhone: _ownerCtrl.text.trim(),
            ownerPhone2: _owner2Ctrl.text.trim(),
            provider: _provider,
            apiKey: _apiKeyCtrl.text.trim(),
          );
      await _load();
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _stop() async {
    setState(() => _saving = true);
    try {
      await ref.read(whatsappBotRepositoryProvider).stop();
      await _load();
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _saveInstructions() async {
    setState(() => _saving = true);
    try {
      await ref
          .read(whatsappBotRepositoryProvider)
          .saveInstructions(_instructionsCtrl.text);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Instrucciones guardadas.')),
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('WhatsApp Bot')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_error != null)
                    Card(
                      color: AppColors.danger.withValues(alpha: 0.08),
                      child: ListTile(
                        leading: const Icon(Icons.error_outline,
                            color: AppColors.danger),
                        title: const Text('Bot no disponible'),
                        subtitle: Text(_error!),
                        trailing: IconButton(
                          onPressed: _load,
                          icon: const Icon(Icons.refresh),
                        ),
                      ),
                    )
                  else
                    _StatusCard(status: _status),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _ownerCtrl,
                    keyboardType: TextInputType.phone,
                    decoration:
                        const InputDecoration(labelText: 'Teléfono dueño'),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _owner2Ctrl,
                    keyboardType: TextInputType.phone,
                    decoration: const InputDecoration(
                        labelText: 'Teléfono dueño secundario'),
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue: _provider,
                    decoration:
                        const InputDecoration(labelText: 'Proveedor IA'),
                    items: const [
                      DropdownMenuItem(value: 'none', child: Text('Sin IA')),
                      DropdownMenuItem(
                          value: 'chatgpt', child: Text('ChatGPT')),
                      DropdownMenuItem(value: 'claude', child: Text('Claude')),
                      DropdownMenuItem(value: 'gemini', child: Text('Gemini')),
                    ],
                    onChanged: (value) {
                      if (value != null) setState(() => _provider = value);
                    },
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _apiKeyCtrl,
                    obscureText: true,
                    decoration: const InputDecoration(
                      labelText: 'API key nueva',
                      helperText:
                          'Opcional: deja vacío para usar la guardada en el POS.',
                    ),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: FilledButton.icon(
                          onPressed: _saving ? null : _start,
                          icon: const Icon(Icons.play_arrow),
                          label: const Text('Iniciar'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _saving ? null : _stop,
                          icon: const Icon(Icons.stop),
                          label: const Text('Detener'),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  Text('Instrucciones',
                      style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _instructionsCtrl,
                    minLines: 5,
                    maxLines: 10,
                    decoration: const InputDecoration(
                      alignLabelWithHint: true,
                      labelText: 'Comportamiento del bot',
                    ),
                  ),
                  const SizedBox(height: 12),
                  FilledButton.icon(
                    onPressed: _saving ? null : _saveInstructions,
                    icon: const Icon(Icons.save_outlined),
                    label: const Text('Guardar instrucciones'),
                  ),
                ],
              ),
            ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.status});

  final WhatsappBotStatus? status;

  @override
  Widget build(BuildContext context) {
    final value = status;
    final ready = value?.ready ?? false;
    return Card(
      color: (ready ? AppColors.success : AppColors.warning)
          .withValues(alpha: 0.08),
      child: ListTile(
        leading: Icon(
          ready ? Icons.check_circle_outline : Icons.qr_code_2,
          color: ready ? AppColors.success : AppColors.warning,
        ),
        title: Text(ready ? 'Bot listo' : 'Bot pendiente'),
        subtitle: Text(value?.message ?? value?.status ?? 'Sin estado'),
      ),
    );
  }
}

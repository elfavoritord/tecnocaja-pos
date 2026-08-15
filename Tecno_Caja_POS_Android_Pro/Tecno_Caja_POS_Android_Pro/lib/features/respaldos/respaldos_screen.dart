import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../data/auth/auth_controller.dart';
import '../../data/repositories/backup_repository.dart';

class RespaldosScreen extends ConsumerStatefulWidget {
  const RespaldosScreen({super.key});

  @override
  ConsumerState<RespaldosScreen> createState() => _RespaldosScreenState();
}

class _RespaldosScreenState extends ConsumerState<RespaldosScreen> {
  bool _exportando = false;
  int _revision = 0;

  Future<void> _exportar() async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;
    setState(() => _exportando = true);
    try {
      final json =
          await ref.read(backupRepositoryProvider).exportJson(empresaId);
      await Share.share(json, subject: 'Respaldo Tecno Caja móvil');
    } finally {
      if (mounted) setState(() => _exportando = false);
    }
  }

  Future<Map<String, int>> _counts() async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return const {};
    return ref.read(backupRepositoryProvider).counts(empresaId);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Respaldos')),
      body: FutureBuilder<Map<String, int>>(
        key: ValueKey(_revision),
        future: _counts(),
        builder: (context, snapshot) {
          final counts = snapshot.data ?? const <String, int>{};
          return RefreshIndicator(
            onRefresh: () async => setState(() => _revision++),
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Respaldo local',
                            style: Theme.of(context).textTheme.titleLarge),
                        const SizedBox(height: 8),
                        const Text(
                          'Exporta una copia JSON de los datos locales de este dispositivo.',
                        ),
                        const SizedBox(height: 16),
                        SizedBox(
                          width: double.infinity,
                          child: FilledButton.icon(
                            onPressed: _exportando ? null : _exportar,
                            icon: _exportando
                                ? const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                        strokeWidth: 2),
                                  )
                                : const Icon(Icons.ios_share),
                            label: Text(_exportando
                                ? 'Preparando...'
                                : 'Exportar respaldo'),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Text('Contenido',
                    style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                if (snapshot.connectionState != ConnectionState.done)
                  const Padding(
                    padding: EdgeInsets.all(32),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else
                  for (final entry in counts.entries)
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      title: Text(entry.key),
                      trailing: Text('${entry.value}'),
                    ),
              ],
            ),
          );
        },
      ),
    );
  }
}

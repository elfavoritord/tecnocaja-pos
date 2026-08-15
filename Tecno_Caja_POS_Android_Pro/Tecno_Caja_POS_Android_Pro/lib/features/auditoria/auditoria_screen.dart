import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';

class AuditoriaScreen extends ConsumerStatefulWidget {
  const AuditoriaScreen({super.key});

  @override
  ConsumerState<AuditoriaScreen> createState() => _AuditoriaScreenState();
}

class _AuditoriaScreenState extends ConsumerState<AuditoriaScreen> {
  final _busquedaCtrl = TextEditingController();
  String _entidad = 'todas';
  int _revision = 0;

  @override
  void dispose() {
    _busquedaCtrl.dispose();
    super.dispose();
  }

  Future<List<Map<String, Object?>>> _cargar() async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return const [];
    final where = <String>['empresa_id = ?'];
    final args = <Object?>[empresaId];
    if (_entidad != 'todas') {
      where.add('entidad_tipo = ?');
      args.add(_entidad);
    }
    final search = _busquedaCtrl.text.trim();
    if (search.isNotEmpty) {
      where.add('(accion LIKE ? OR entidad_id LIKE ? OR detalle_json LIKE ?)');
      args.addAll(['%$search%', '%$search%', '%$search%']);
    }
    return ref.read(databaseProvider).query(
          'registro_auditoria',
          where: where.join(' AND '),
          whereArgs: args,
          orderBy: 'ocurrido_en DESC',
          limit: 500,
        );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Auditoría')),
      body: FutureBuilder<List<Map<String, Object?>>>(
        key: ValueKey(_revision),
        future: _cargar(),
        builder: (context, snapshot) {
          final rows = snapshot.data ?? const <Map<String, Object?>>[];
          final entidades = {
            'todas',
            ...rows
                .map((r) => r['entidad_tipo']?.toString())
                .whereType<String>(),
          }.toList();
          return RefreshIndicator(
            onRefresh: () async => setState(() => _revision++),
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _busquedaCtrl,
                        decoration: const InputDecoration(
                          prefixIcon: Icon(Icons.search),
                          hintText: 'Buscar acción, entidad o detalle',
                        ),
                        onSubmitted: (_) => setState(() => _revision++),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Buscar',
                      onPressed: () => setState(() => _revision++),
                      icon: const Icon(Icons.manage_search),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue:
                      entidades.contains(_entidad) ? _entidad : 'todas',
                  decoration: const InputDecoration(labelText: 'Entidad'),
                  items: [
                    for (final entidad in entidades)
                      DropdownMenuItem(
                        value: entidad,
                        child: Text(entidad == 'todas' ? 'Todas' : entidad),
                      ),
                  ],
                  onChanged: (value) {
                    if (value == null) return;
                    setState(() {
                      _entidad = value;
                      _revision++;
                    });
                  },
                ),
                const SizedBox(height: 16),
                if (snapshot.connectionState != ConnectionState.done)
                  const Padding(
                    padding: EdgeInsets.all(48),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (rows.isEmpty)
                  const Padding(
                    padding: EdgeInsets.all(48),
                    child: Center(child: Text('No hay eventos de auditoría')),
                  )
                else
                  for (final row in rows) ...[
                    Card(
                      margin: EdgeInsets.zero,
                      child: ListTile(
                        leading:
                            const CircleAvatar(child: Icon(Icons.fact_check)),
                        title: Text(row['accion']?.toString() ?? 'Acción'),
                        subtitle: Text(
                          [
                            row['entidad_tipo']?.toString() ?? 'sistema',
                            _formatDate(row['ocurrido_en']),
                          ].join(' · '),
                        ),
                        trailing: row['sincronizado'] == 1
                            ? const Icon(Icons.cloud_done_outlined)
                            : const Icon(Icons.cloud_upload_outlined),
                        onTap: () => _mostrarDetalle(context, row),
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
              ],
            ),
          );
        },
      ),
    );
  }

  String _formatDate(Object? value) {
    final parsed = DateTime.tryParse(value?.toString() ?? '');
    return parsed == null ? 'Sin fecha' : Formatters.dateTime(parsed);
  }

  void _mostrarDetalle(BuildContext context, Map<String, Object?> row) {
    final raw = row['detalle_json']?.toString();
    Object? parsed;
    if (raw != null && raw.isNotEmpty) {
      try {
        parsed = const JsonEncoder.withIndent('  ').convert(jsonDecode(raw));
      } catch (_) {
        parsed = raw;
      }
    }
    showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(row['accion']?.toString() ?? 'Detalle'),
        content: SingleChildScrollView(
          child: SelectableText(
            [
              'Entidad: ${row['entidad_tipo'] ?? '-'}',
              'ID: ${row['entidad_id'] ?? '-'}',
              'Usuario: ${row['usuario_id'] ?? '-'}',
              'Dispositivo: ${row['dispositivo_id'] ?? '-'}',
              'Fecha: ${_formatDate(row['ocurrido_en'])}',
              if (parsed != null) '\n$parsed',
            ].join('\n'),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cerrar'),
          ),
        ],
      ),
    );
  }
}

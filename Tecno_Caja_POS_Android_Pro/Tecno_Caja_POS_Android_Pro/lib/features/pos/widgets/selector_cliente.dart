import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/providers/service_providers.dart';
import '../../../core/utils/formatters.dart';
import '../../../data/repositories/cliente_repository.dart';
import '../../../domain/entities/cliente.dart';

Future<Cliente?> mostrarSelectorCliente(BuildContext context, String empresaId) {
  return showModalBottomSheet<Cliente>(
    context: context,
    isScrollControlled: true,
    builder: (context) => _SelectorClienteSheet(empresaId: empresaId),
  );
}

class _SelectorClienteSheet extends ConsumerStatefulWidget {
  const _SelectorClienteSheet({required this.empresaId});
  final String empresaId;

  @override
  ConsumerState<_SelectorClienteSheet> createState() => _SelectorClienteSheetState();
}

class _SelectorClienteSheetState extends ConsumerState<_SelectorClienteSheet> {
  final _busquedaCtrl = TextEditingController();
  List<Cliente> _resultados = [];
  bool _creando = false;

  @override
  void initState() {
    super.initState();
    _buscar('');
  }

  @override
  void dispose() {
    _busquedaCtrl.dispose();
    super.dispose();
  }

  Future<void> _buscar(String termino) async {
    final repo = ref.read(clienteRepositoryProvider);
    final resultados = termino.isEmpty ? await repo.deEmpresa(widget.empresaId) : await repo.buscar(widget.empresaId, termino);
    if (mounted) setState(() => _resultados = resultados);
  }

  Future<void> _crearRapido() async {
    final nombre = _busquedaCtrl.text.trim();
    if (nombre.isEmpty) return;
    setState(() => _creando = true);
    try {
      final deviceId = await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      final cliente = await ref.read(clienteRepositoryProvider).crear(
            empresaId: widget.empresaId,
            nombre: nombre,
            dispositivoId: deviceId,
          );
      if (mounted) Navigator.of(context).pop(cliente);
    } finally {
      if (mounted) setState(() => _creando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final sinResultados = _resultados.isEmpty && _busquedaCtrl.text.isNotEmpty;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        child: SizedBox(
          height: MediaQuery.of(context).size.height * 0.75,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                Text('Seleccionar cliente', style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 12),
                TextField(
                  controller: _busquedaCtrl,
                  autofocus: true,
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Nombre, teléfono o cédula'),
                  onChanged: _buscar,
                ),
                const SizedBox(height: 8),
                Expanded(
                  child: sinResultados
                      ? Center(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text('Sin resultados para "${_busquedaCtrl.text}"'),
                              const SizedBox(height: 12),
                              FilledButton.icon(
                                onPressed: _creando ? null : _crearRapido,
                                icon: const Icon(Icons.person_add_alt),
                                label: Text(_creando ? 'Creando...' : 'Crear "${_busquedaCtrl.text}"'),
                              ),
                            ],
                          ),
                        )
                      : ListView.builder(
                          itemCount: _resultados.length,
                          itemBuilder: (context, index) {
                            final cliente = _resultados[index];
                            return ListTile(
                              leading: const CircleAvatar(child: Icon(Icons.person_outline)),
                              title: Text(cliente.nombre),
                              subtitle: cliente.balance > 0
                                  ? Text('Debe ${Formatters.currency(cliente.balance)}')
                                  : Text(cliente.telefono ?? ''),
                              onTap: () => Navigator.of(context).pop(cliente),
                            );
                          },
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

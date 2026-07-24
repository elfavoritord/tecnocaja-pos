import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/repositories/cliente_repository.dart';
import '../../domain/entities/cliente.dart';
import 'cliente_detalle_screen.dart';
import 'cliente_form_screen.dart';

class ClientesScreen extends ConsumerStatefulWidget {
  const ClientesScreen({super.key});

  @override
  ConsumerState<ClientesScreen> createState() => _ClientesScreenState();
}

class _ClientesScreenState extends ConsumerState<ClientesScreen> {
  final _busquedaCtrl = TextEditingController();
  List<Cliente> _clientes = [];
  bool _cargando = true;
  bool _soloConDeuda = false;

  @override
  void initState() {
    super.initState();
    _cargar('');
  }

  @override
  void dispose() {
    _busquedaCtrl.dispose();
    super.dispose();
  }

  Future<void> _cargar(String termino) async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;
    setState(() => _cargando = true);
    final repo = ref.read(clienteRepositoryProvider);
    var clientes = termino.isEmpty ? await repo.deEmpresa(empresaId) : await repo.buscar(empresaId, termino);
    if (_soloConDeuda) {
      clientes = clientes.where((c) => c.balance > 0).toList();
    }
    if (mounted) setState(() { _clientes = clientes; _cargando = false; });
  }

  Future<void> _abrirDetalle([Cliente? cliente]) async {
    if (cliente == null) {
      final creado = await Navigator.of(context).push<bool>(
        MaterialPageRoute(builder: (context) => const ClienteFormScreen()),
      );
      if (creado == true) await _cargar(_busquedaCtrl.text);
      return;
    }
    await Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (context) => ClienteDetalleScreen(cliente: cliente)),
    );
    await _cargar(_busquedaCtrl.text);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Clientes'),
        actions: [
          IconButton(
            icon: Icon(_soloConDeuda ? Icons.filter_alt : Icons.filter_alt_outlined),
            tooltip: 'Solo con cuenta por cobrar',
            onPressed: () {
              setState(() => _soloConDeuda = !_soloConDeuda);
              _cargar(_busquedaCtrl.text);
            },
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(64),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: TextField(
              controller: _busquedaCtrl,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Buscar cliente', filled: true),
              onChanged: _cargar,
            ),
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _abrirDetalle(),
        icon: const Icon(Icons.person_add_alt),
        label: const Text('Cliente'),
      ),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _clientes.isEmpty
              ? const Center(child: Text('No hay clientes todavía'))
              : ListView.builder(
                  itemCount: _clientes.length,
                  itemBuilder: (context, index) {
                    final cliente = _clientes[index];
                    return ListTile(
                      leading: const CircleAvatar(child: Icon(Icons.person_outline)),
                      title: Text(cliente.nombre),
                      subtitle: Text(cliente.telefono ?? cliente.email ?? ''),
                      trailing: cliente.balance > 0
                          ? Text(
                              Formatters.currency(cliente.balance),
                              style: const TextStyle(color: AppColors.danger, fontWeight: FontWeight.bold),
                            )
                          : null,
                      onTap: () => _abrirDetalle(cliente),
                    );
                  },
                ),
    );
  }
}

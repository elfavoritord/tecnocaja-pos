import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/auth/auth_controller.dart';
import '../../data/repositories/proveedor_repository.dart';
import '../../domain/entities/proveedor.dart';
import 'proveedor_form_screen.dart';

class ProveedoresScreen extends ConsumerStatefulWidget {
  const ProveedoresScreen({super.key});

  @override
  ConsumerState<ProveedoresScreen> createState() => _ProveedoresScreenState();
}

class _ProveedoresScreenState extends ConsumerState<ProveedoresScreen> {
  final _busquedaCtrl = TextEditingController();
  List<Proveedor> _proveedores = [];
  bool _cargando = true;

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
    final repo = ref.read(proveedorRepositoryProvider);
    final proveedores = termino.isEmpty ? await repo.deEmpresa(empresaId) : await repo.buscar(empresaId, termino);
    if (mounted) setState(() { _proveedores = proveedores; _cargando = false; });
  }

  Future<void> _abrirFormulario([Proveedor? proveedor]) async {
    final guardado = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (context) => ProveedorFormScreen(proveedor: proveedor)),
    );
    if (guardado == true) await _cargar(_busquedaCtrl.text);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Proveedores'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(64),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: TextField(
              controller: _busquedaCtrl,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Buscar proveedor', filled: true),
              onChanged: _cargar,
            ),
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _abrirFormulario(),
        icon: const Icon(Icons.add_business_outlined),
        label: const Text('Proveedor'),
      ),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _proveedores.isEmpty
              ? const Center(child: Text('No hay proveedores todavía'))
              : ListView.builder(
                  itemCount: _proveedores.length,
                  itemBuilder: (context, index) {
                    final proveedor = _proveedores[index];
                    return ListTile(
                      leading: const CircleAvatar(child: Icon(Icons.local_shipping_outlined)),
                      title: Text(proveedor.nombre),
                      subtitle: Text([
                        if (proveedor.contacto != null && proveedor.contacto!.isNotEmpty) proveedor.contacto!,
                        if (proveedor.telefono != null && proveedor.telefono!.isNotEmpty) proveedor.telefono!,
                      ].join(' · ')),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => _abrirFormulario(proveedor),
                    );
                  },
                ),
    );
  }
}

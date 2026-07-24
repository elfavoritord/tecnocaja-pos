import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/repositories/producto_repository.dart';
import '../../domain/entities/producto.dart';
import 'producto_form_screen.dart';

class ProductosScreen extends ConsumerStatefulWidget {
  const ProductosScreen({super.key});

  @override
  ConsumerState<ProductosScreen> createState() => _ProductosScreenState();
}

class _ProductosScreenState extends ConsumerState<ProductosScreen> {
  final _busquedaCtrl = TextEditingController();
  List<Producto> _productos = [];
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
    final repo = ref.read(productoRepositoryProvider);
    final productos = termino.isEmpty ? await repo.deEmpresa(empresaId) : await repo.buscar(empresaId, termino);
    if (mounted) setState(() { _productos = productos; _cargando = false; });
  }

  Future<void> _abrirFormulario([Producto? producto]) async {
    final guardado = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (context) => ProductoFormScreen(producto: producto)),
    );
    if (guardado == true) await _cargar(_busquedaCtrl.text);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Productos'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(64),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: TextField(
              controller: _busquedaCtrl,
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Buscar por nombre, SKU o código',
                filled: true,
              ),
              onChanged: _cargar,
            ),
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _abrirFormulario(),
        icon: const Icon(Icons.add),
        label: const Text('Producto'),
      ),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _productos.isEmpty
              ? const Center(child: Text('No hay productos todavía'))
              : ListView.builder(
                  itemCount: _productos.length,
                  itemBuilder: (context, index) {
                    final producto = _productos[index];
                    return ListTile(
                      leading: CircleAvatar(
                        child: Text(producto.nombre.isNotEmpty ? producto.nombre[0].toUpperCase() : '?'),
                      ),
                      title: Text(producto.nombre),
                      subtitle: Text([
                        if (producto.sku != null && producto.sku!.isNotEmpty) 'SKU: ${producto.sku}',
                        if (producto.codigoBarras != null && producto.codigoBarras!.isNotEmpty) producto.codigoBarras!,
                      ].join(' · ')),
                      trailing: Text(
                        Formatters.currency(producto.precioVenta),
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      onTap: () => _abrirFormulario(producto),
                    );
                  },
                ),
    );
  }
}

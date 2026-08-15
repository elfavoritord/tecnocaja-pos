import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/printing/unified_printer_service.dart';
import '../../data/repositories/producto_repository.dart';
import '../../domain/entities/producto.dart';

class LabelPrintScreen extends ConsumerStatefulWidget {
  const LabelPrintScreen({super.key});

  @override
  ConsumerState<LabelPrintScreen> createState() => _LabelPrintScreenState();
}

class _LabelPrintScreenState extends ConsumerState<LabelPrintScreen> {
  final _searchController = TextEditingController();
  List<Producto> _products = const [];
  bool _loading = true;
  String? _printingId;

  @override
  void initState() {
    super.initState();
    _load('');
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _load(String query) async {
    final companyId = ref.read(authControllerProvider).empresaId;
    if (companyId == null) {
      return;
    }
    setState(() => _loading = true);
    final repository = ref.read(productoRepositoryProvider);
    final products = query.trim().isEmpty
        ? await repository.deEmpresa(companyId)
        : await repository.buscar(companyId, query.trim());
    if (mounted) {
      setState(() {
        _products = products;
        _loading = false;
      });
    }
  }

  Future<void> _print(Producto product) async {
    var quantity = 1;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text(product.nombre),
          content: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              IconButton(
                onPressed: quantity > 1
                    ? () => setDialogState(() => quantity--)
                    : null,
                icon: const Icon(Icons.remove_circle_outline),
              ),
              Text('$quantity etiquetas',
                  style: Theme.of(context).textTheme.titleMedium),
              IconButton(
                onPressed: () => setDialogState(() => quantity++),
                icon: const Icon(Icons.add_circle_outline),
              ),
            ],
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Cancelar')),
            FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Imprimir')),
          ],
        ),
      ),
    );
    if (confirmed != true) {
      return;
    }
    setState(() => _printingId = product.id);
    try {
      await ref
          .read(unifiedPrinterServiceProvider)
          .printLabels(product, quantity);
      _message('$quantity etiqueta(s) enviada(s).');
    } catch (error) {
      _message('$error');
    } finally {
      if (mounted) setState(() => _printingId = null);
    }
  }

  void _message(String text) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: const Text('Etiquetas y códigos'),
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(64),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: TextField(
                controller: _searchController,
                onChanged: _load,
                decoration: const InputDecoration(
                  hintText: 'Buscar producto o código',
                  prefixIcon: Icon(Icons.search),
                  filled: true,
                ),
              ),
            ),
          ),
        ),
        body: _loading
            ? const Center(child: CircularProgressIndicator())
            : _products.isEmpty
                ? const Center(child: Text('No hay productos para etiquetar'))
                : ListView.separated(
                    itemCount: _products.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final product = _products[index];
                      return ListTile(
                        leading:
                            const CircleAvatar(child: Icon(Icons.qr_code_2)),
                        title: Text(product.nombre),
                        subtitle: Text(product.codigoBarras ??
                            product.sku ??
                            'Sin código de barras'),
                        trailing: _printingId == product.id
                            ? const SizedBox(
                                width: 22,
                                height: 22,
                                child:
                                    CircularProgressIndicator(strokeWidth: 2),
                              )
                            : Text(Formatters.currency(product.precioVenta)),
                        onTap:
                            _printingId == null ? () => _print(product) : null,
                      );
                    },
                  ),
      );
}

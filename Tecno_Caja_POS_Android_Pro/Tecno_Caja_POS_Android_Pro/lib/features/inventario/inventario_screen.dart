import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../core/theme/app_colors.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/inventario_repository.dart';
import '../../domain/entities/inventario.dart';
import 'movimientos_producto_screen.dart';

class InventarioScreen extends ConsumerStatefulWidget {
  const InventarioScreen({super.key});

  @override
  ConsumerState<InventarioScreen> createState() => _InventarioScreenState();
}

class _InventarioScreenState extends ConsumerState<InventarioScreen> {
  final _busquedaCtrl = TextEditingController();
  List<ItemInventario> _items = [];
  bool _cargando = true;
  bool _soloStockBajo = false;
  String? _sucursalId;
  String? _empresaId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _cargarInicial());
  }

  @override
  void dispose() {
    _busquedaCtrl.dispose();
    super.dispose();
  }

  Future<void> _cargarInicial() async {
    final sucursal = await ref.read(sucursalActivaProvider.future);
    _sucursalId = sucursal?.id;
    _empresaId = ref.read(authControllerProvider).empresaId;
    await _cargar('');
  }

  Future<void> _cargar(String termino) async {
    if (_sucursalId == null) {
      if (mounted) setState(() { _items = []; _cargando = false; });
      return;
    }
    setState(() => _cargando = true);
    final items = await ref.read(inventarioRepositoryProvider).deSucursalConProducto(
          _sucursalId!,
          termino: termino,
          soloStockBajo: _soloStockBajo,
        );
    if (mounted) setState(() { _items = items; _cargando = false; });
  }

  Future<void> _ajustarStock(ItemInventario item) async {
    final resultado = await showDialog<(double, String)>(
      context: context,
      builder: (context) => _DialogoAjusteStock(item: item),
    );
    if (resultado == null) return;
    final (cantidad, nota) = resultado;
    if (cantidad == 0) return;

    final deviceId = await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
    try {
      await ref.read(inventarioRepositoryProvider).registrarMovimiento(
            productoId: item.productoId,
            sucursalId: _sucursalId!,
            empresaId: _empresaId!,
            tipoMovimiento: cantidad > 0 ? TipoMovimientoInventario.entradaManual : TipoMovimientoInventario.salidaManual,
            cantidad: cantidad,
            nota: nota.isEmpty ? null : nota,
            dispositivoId: deviceId,
          );
      await _cargar(_busquedaCtrl.text);
    } on InsufficientStockException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message), backgroundColor: AppColors.danger));
      }
    }
  }

  void _verHistorial(ItemInventario item) {
    Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (context) => MovimientosProductoScreen(productoId: item.productoId, nombreProducto: item.nombre)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Inventario'),
        actions: [
          IconButton(
            icon: Icon(_soloStockBajo ? Icons.warning_amber_rounded : Icons.warning_amber_outlined),
            tooltip: 'Solo stock bajo',
            onPressed: () {
              setState(() => _soloStockBajo = !_soloStockBajo);
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
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Buscar producto', filled: true),
              onChanged: _cargar,
            ),
          ),
        ),
      ),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _sucursalId == null
              ? const Center(child: Text('No hay una sucursal activa todavía.'))
              : _items.isEmpty
                  ? const Center(child: Text('No hay productos con inventario todavía'))
                  : ListView.builder(
                      itemCount: _items.length,
                      itemBuilder: (context, index) {
                        final item = _items[index];
                        return ListTile(
                          leading: CircleAvatar(
                            backgroundColor: (item.agotado ? AppColors.danger : (item.stockBajo ? AppColors.warning : AppColors.success))
                                .withValues(alpha: 0.15),
                            child: Icon(
                              item.agotado ? Icons.remove_circle_outline : Icons.inventory_2_outlined,
                              color: item.agotado ? AppColors.danger : (item.stockBajo ? AppColors.warning : AppColors.success),
                            ),
                          ),
                          title: Text(item.nombre),
                          subtitle: Text('${item.sku ?? item.codigoBarras ?? ''} · mín. ${item.stockMinimo.toStringAsFixed(0)}'),
                          trailing: Text(
                            '${item.stock.toStringAsFixed(item.stock.truncateToDouble() == item.stock ? 0 : 2)} ${item.unidadMedida}',
                            style: TextStyle(
                              fontWeight: FontWeight.bold,
                              color: item.agotado ? AppColors.danger : (item.stockBajo ? AppColors.warning : null),
                            ),
                          ),
                          onTap: () => _ajustarStock(item),
                          onLongPress: () => _verHistorial(item),
                        );
                      },
                    ),
    );
  }
}

class _DialogoAjusteStock extends StatefulWidget {
  const _DialogoAjusteStock({required this.item});

  final ItemInventario item;

  @override
  State<_DialogoAjusteStock> createState() => _DialogoAjusteStockState();
}

class _DialogoAjusteStockState extends State<_DialogoAjusteStock> {
  final _formKey = GlobalKey<FormState>();
  final _cantidadCtrl = TextEditingController();
  final _notaCtrl = TextEditingController();
  bool _entrada = true;

  @override
  void dispose() {
    _cantidadCtrl.dispose();
    _notaCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.item.nombre),
      content: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Stock actual: ${widget.item.stock.toStringAsFixed(2)} ${widget.item.unidadMedida}', style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 12),
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: true, label: Text('Entrada'), icon: Icon(Icons.add)),
                ButtonSegment(value: false, label: Text('Salida'), icon: Icon(Icons.remove)),
              ],
              selected: {_entrada},
              onSelectionChanged: (s) => setState(() => _entrada = s.first),
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _cantidadCtrl,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: InputDecoration(labelText: 'Cantidad (${widget.item.unidadMedida})'),
              validator: (v) {
                final parsed = double.tryParse((v ?? '').replaceAll(',', '.'));
                if (parsed == null || parsed <= 0) return 'Ingresa una cantidad válida.';
                return null;
              },
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _notaCtrl,
              decoration: const InputDecoration(labelText: 'Motivo (opcional)', hintText: 'Ej. conteo físico, merma...'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancelar')),
        FilledButton(
          onPressed: () {
            if (!_formKey.currentState!.validate()) return;
            final cantidad = double.parse(_cantidadCtrl.text.replaceAll(',', '.'));
            Navigator.of(context).pop((_entrada ? cantidad : -cantidad, _notaCtrl.text.trim()));
          },
          child: const Text('Guardar'),
        ),
      ],
    );
  }
}

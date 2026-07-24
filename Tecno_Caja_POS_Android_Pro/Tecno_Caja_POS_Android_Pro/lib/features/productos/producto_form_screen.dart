import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/service_providers.dart';
import '../../core/utils/validators.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/producto_repository.dart';
import '../../domain/entities/categoria.dart';
import '../../domain/entities/producto.dart';
import '../../widgets/loading_button.dart';

class ProductoFormScreen extends ConsumerStatefulWidget {
  const ProductoFormScreen({super.key, this.producto, this.codigoBarrasInicial});

  final Producto? producto;

  /// Prellenado al crear un producto nuevo desde el escaner del POS cuando
  /// el codigo leido no coincide con ningun producto existente.
  final String? codigoBarrasInicial;

  @override
  ConsumerState<ProductoFormScreen> createState() => _ProductoFormScreenState();
}

class _ProductoFormScreenState extends ConsumerState<ProductoFormScreen> {
  final _formKey = GlobalKey<FormState>();
  late final _nombreCtrl = TextEditingController(text: widget.producto?.nombre);
  late final _descripcionCtrl = TextEditingController(text: widget.producto?.descripcion);
  late final _skuCtrl = TextEditingController(text: widget.producto?.sku);
  late final _codigoBarrasCtrl = TextEditingController(text: widget.producto?.codigoBarras ?? widget.codigoBarrasInicial);
  late final _marcaCtrl = TextEditingController(text: widget.producto?.marca);
  late final _precioVentaCtrl = TextEditingController(text: widget.producto?.precioVenta.toStringAsFixed(2) ?? '');
  late final _precioCompraCtrl = TextEditingController(text: widget.producto?.precioCompra.toStringAsFixed(2) ?? '0');
  late final _stockMinimoCtrl = TextEditingController(text: widget.producto?.stockMinimo.toStringAsFixed(0) ?? '0');
  late final _stockInicialCtrl = TextEditingController(text: '0');
  late final _tasaItbisCtrl = TextEditingController(text: ((widget.producto?.tasaItbis ?? 0.18) * 100).toStringAsFixed(0));

  String? _categoriaId;
  bool _itbisIncluido = true;
  bool _favorito = false;
  bool _activo = true;
  bool _cargando = false;
  List<Categoria> _categorias = [];

  bool get _esNuevo => widget.producto == null;

  @override
  void initState() {
    super.initState();
    _categoriaId = widget.producto?.categoriaId;
    _itbisIncluido = widget.producto?.itbisIncluido ?? true;
    _favorito = widget.producto?.favorito ?? false;
    _activo = widget.producto?.activo ?? true;
    _cargarCategorias();
  }

  Future<void> _cargarCategorias() async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;
    final categorias = await ref.read(productoRepositoryProvider).categoriasDe(empresaId);
    if (mounted) setState(() => _categorias = categorias);
  }

  @override
  void dispose() {
    _nombreCtrl.dispose();
    _descripcionCtrl.dispose();
    _skuCtrl.dispose();
    _codigoBarrasCtrl.dispose();
    _marcaCtrl.dispose();
    _precioVentaCtrl.dispose();
    _precioCompraCtrl.dispose();
    _stockMinimoCtrl.dispose();
    _stockInicialCtrl.dispose();
    _tasaItbisCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    if (!_formKey.currentState!.validate()) return;
    final auth = ref.read(authControllerProvider);
    if (auth.empresaId == null) return;

    setState(() => _cargando = true);
    try {
      final deviceId = await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      final repo = ref.read(productoRepositoryProvider);
      final precioVenta = double.parse(_precioVentaCtrl.text.replaceAll(',', '.'));
      final precioCompra = double.tryParse(_precioCompraCtrl.text.replaceAll(',', '.')) ?? 0;
      final tasaItbis = (double.tryParse(_tasaItbisCtrl.text.replaceAll(',', '.')) ?? 18) / 100;
      final stockMinimo = double.tryParse(_stockMinimoCtrl.text.replaceAll(',', '.')) ?? 0;

      if (_esNuevo) {
        final sucursal = await ref.read(sucursalActivaProvider.future);
        await repo.crear(
          empresaId: auth.empresaId!,
          nombre: _nombreCtrl.text.trim(),
          descripcion: _descripcionCtrl.text.trim().isEmpty ? null : _descripcionCtrl.text.trim(),
          sku: _skuCtrl.text.trim().isEmpty ? null : _skuCtrl.text.trim(),
          codigoBarras: _codigoBarrasCtrl.text.trim().isEmpty ? null : _codigoBarrasCtrl.text.trim(),
          categoriaId: _categoriaId,
          marca: _marcaCtrl.text.trim().isEmpty ? null : _marcaCtrl.text.trim(),
          precioVenta: precioVenta,
          precioCompra: precioCompra,
          tasaItbis: tasaItbis,
          itbisIncluido: _itbisIncluido,
          stockMinimo: stockMinimo,
          dispositivoId: deviceId,
          stockInicial: double.tryParse(_stockInicialCtrl.text.replaceAll(',', '.')) ?? 0,
          sucursalParaStock: sucursal?.id,
        );
      } else {
        final actualizado = widget.producto!.copyWith(
          nombre: _nombreCtrl.text.trim(),
          descripcion: _descripcionCtrl.text.trim(),
          sku: _skuCtrl.text.trim(),
          codigoBarras: _codigoBarrasCtrl.text.trim(),
          categoriaId: _categoriaId,
          marca: _marcaCtrl.text.trim(),
          precioVenta: precioVenta,
          precioCompra: precioCompra,
          tasaItbis: tasaItbis,
          itbisIncluido: _itbisIncluido,
          stockMinimo: stockMinimo,
          favorito: _favorito,
          activo: _activo,
        );
        await repo.actualizar(actualizado);
      }

      if (mounted) Navigator.of(context).pop(true);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _duplicar() async {
    if (widget.producto == null) return;
    final deviceId = await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
    await ref.read(productoRepositoryProvider).duplicar(widget.producto!, dispositivoId: deviceId);
    if (mounted) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_esNuevo ? 'Nuevo producto' : 'Editar producto'),
        actions: [
          if (!_esNuevo) IconButton(icon: const Icon(Icons.copy_outlined), tooltip: 'Duplicar', onPressed: _duplicar),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextFormField(
                  controller: _nombreCtrl,
                  decoration: const InputDecoration(labelText: 'Nombre'),
                  validator: (v) => Validators.required(v, label: 'El nombre'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _descripcionCtrl,
                  decoration: const InputDecoration(labelText: 'Descripción (opcional)'),
                  maxLines: 2,
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        controller: _skuCtrl,
                        decoration: const InputDecoration(labelText: 'SKU'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: TextFormField(
                        controller: _codigoBarrasCtrl,
                        decoration: const InputDecoration(labelText: 'Código de barras'),
                        keyboardType: TextInputType.number,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String?>(
                  initialValue: _categoriaId,
                  decoration: const InputDecoration(labelText: 'Categoría'),
                  items: [
                    const DropdownMenuItem(value: null, child: Text('Sin categoría')),
                    ..._categorias.map((c) => DropdownMenuItem(value: c.id, child: Text(c.nombre))),
                  ],
                  onChanged: (v) => setState(() => _categoriaId = v),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _marcaCtrl,
                  decoration: const InputDecoration(labelText: 'Marca (opcional)'),
                ),
                const SizedBox(height: 20),
                Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        controller: _precioVentaCtrl,
                        decoration: const InputDecoration(labelText: 'Precio de venta', prefixText: 'RD\$ '),
                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        validator: (v) => Validators.positiveNumber(v, label: 'El precio de venta'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: TextFormField(
                        controller: _precioCompraCtrl,
                        decoration: const InputDecoration(labelText: 'Precio de compra', prefixText: 'RD\$ '),
                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        controller: _tasaItbisCtrl,
                        decoration: const InputDecoration(labelText: 'ITBIS %'),
                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        title: const Text('ITBIS incluido'),
                        value: _itbisIncluido,
                        onChanged: (v) => setState(() => _itbisIncluido = v),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                if (_esNuevo)
                  TextFormField(
                    controller: _stockInicialCtrl,
                    decoration: const InputDecoration(labelText: 'Stock inicial'),
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _stockMinimoCtrl,
                  decoration: const InputDecoration(labelText: 'Stock mínimo (alerta)'),
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Producto favorito'),
                  subtitle: const Text('Aparece primero en el punto de venta'),
                  value: _favorito,
                  onChanged: (v) => setState(() => _favorito = v),
                ),
                if (!_esNuevo)
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Activo'),
                    subtitle: const Text('Si lo desactivas, no aparecerá en el punto de venta'),
                    value: _activo,
                    onChanged: (v) => setState(() => _activo = v),
                  ),
                const SizedBox(height: 20),
                LoadingButton(label: 'Guardar', isLoading: _cargando, onPressed: _guardar),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

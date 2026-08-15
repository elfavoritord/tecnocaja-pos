import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/service_providers.dart';
import '../../core/business/business_capabilities.dart';
import '../../core/errors/app_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/producto_repository.dart';
import '../../data/repositories/configuracion_repository.dart';
import '../../domain/entities/categoria.dart';
import '../../domain/entities/producto.dart';
import '../../domain/entities/producto_lote.dart';
import '../../widgets/loading_button.dart';

class ProductoFormScreen extends ConsumerStatefulWidget {
  const ProductoFormScreen(
      {super.key, this.producto, this.codigoBarrasInicial});

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
  late final _descripcionCtrl =
      TextEditingController(text: widget.producto?.descripcion);
  late final _skuCtrl = TextEditingController(text: widget.producto?.sku);
  late final _codigoBarrasCtrl = TextEditingController(
      text: widget.producto?.codigoBarras ?? widget.codigoBarrasInicial);
  late final _marcaCtrl = TextEditingController(text: widget.producto?.marca);
  late final _precioVentaCtrl = TextEditingController(
      text: widget.producto?.precioVenta.toStringAsFixed(2) ?? '');
  late final _precioCompraCtrl = TextEditingController(
      text: widget.producto?.precioCompra.toStringAsFixed(2) ?? '0');
  late final _stockMinimoCtrl = TextEditingController(
      text: widget.producto?.stockMinimo.toStringAsFixed(0) ?? '0');
  late final _stockInicialCtrl = TextEditingController(text: '0');
  late final _tasaItbisCtrl = TextEditingController(
      text: ((widget.producto?.tasaItbis ?? 0.18) * 100).toStringAsFixed(0));
  late final _laboratorioCtrl =
      TextEditingController(text: widget.producto?.laboratorio);
  late final _principioActivoCtrl =
      TextEditingController(text: widget.producto?.principioActivo);
  late final _presentacionCtrl =
      TextEditingController(text: widget.producto?.presentacion);
  late final _concentracionCtrl =
      TextEditingController(text: widget.producto?.concentracion);
  late final _registroSanitarioCtrl =
      TextEditingController(text: widget.producto?.registroSanitario);
  final _numeroLoteInicialCtrl = TextEditingController();

  String? _categoriaId;
  bool _itbisIncluido = true;
  bool _favorito = false;
  bool _activo = true;
  bool _controlaVencimiento = false;
  bool _esControlado = false;
  DateTime? _fechaFabricacionInicial;
  DateTime? _fechaVencimientoInicial;
  bool _cargando = false;
  List<Categoria> _categorias = [];
  List<ProductoLote> _lotes = [];

  bool get _esNuevo => widget.producto == null;

  @override
  void initState() {
    super.initState();
    _categoriaId = widget.producto?.categoriaId;
    _itbisIncluido = widget.producto?.itbisIncluido ?? true;
    _favorito = widget.producto?.favorito ?? false;
    _activo = widget.producto?.activo ?? true;
    _controlaVencimiento = widget.producto?.controlaVencimiento ?? false;
    _esControlado = widget.producto?.esControlado ?? false;
    _cargarCategorias();
    _cargarLotes();
  }

  Future<void> _cargarCategorias() async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;
    final categorias =
        await ref.read(productoRepositoryProvider).categoriasDe(empresaId);
    if (mounted) setState(() => _categorias = categorias);
  }

  Future<void> _cargarLotes() async {
    final producto = widget.producto;
    if (producto == null) return;
    final lotes =
        await ref.read(productoRepositoryProvider).lotesDe(producto.id);
    if (mounted) setState(() => _lotes = lotes);
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
    _laboratorioCtrl.dispose();
    _principioActivoCtrl.dispose();
    _presentacionCtrl.dispose();
    _concentracionCtrl.dispose();
    _registroSanitarioCtrl.dispose();
    _numeroLoteInicialCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    if (!_formKey.currentState!.validate()) return;
    final auth = ref.read(authControllerProvider);
    if (auth.empresaId == null) return;

    final stockInicial =
        double.tryParse(_stockInicialCtrl.text.replaceAll(',', '.')) ?? 0;
    if (_esNuevo &&
        _controlaVencimiento &&
        stockInicial > 0 &&
        _fechaVencimientoInicial == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Indica la fecha de vencimiento del lote inicial.'),
        ),
      );
      return;
    }

    setState(() => _cargando = true);
    try {
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      final repo = ref.read(productoRepositoryProvider);
      final precioVenta =
          double.parse(_precioVentaCtrl.text.replaceAll(',', '.'));
      final precioCompra =
          double.tryParse(_precioCompraCtrl.text.replaceAll(',', '.')) ?? 0;
      final tasaItbis =
          (double.tryParse(_tasaItbisCtrl.text.replaceAll(',', '.')) ?? 18) /
              100;
      final stockMinimo =
          double.tryParse(_stockMinimoCtrl.text.replaceAll(',', '.')) ?? 0;

      if (_esNuevo) {
        final sucursal = await ref.read(sucursalActivaProvider.future);
        await repo.crear(
          empresaId: auth.empresaId!,
          nombre: _nombreCtrl.text.trim(),
          descripcion: _descripcionCtrl.text.trim().isEmpty
              ? null
              : _descripcionCtrl.text.trim(),
          sku: _skuCtrl.text.trim().isEmpty ? null : _skuCtrl.text.trim(),
          codigoBarras: _codigoBarrasCtrl.text.trim().isEmpty
              ? null
              : _codigoBarrasCtrl.text.trim(),
          categoriaId: _categoriaId,
          marca: _marcaCtrl.text.trim().isEmpty ? null : _marcaCtrl.text.trim(),
          precioVenta: precioVenta,
          precioCompra: precioCompra,
          tasaItbis: tasaItbis,
          itbisIncluido: _itbisIncluido,
          stockMinimo: stockMinimo,
          dispositivoId: deviceId,
          stockInicial:
              double.tryParse(_stockInicialCtrl.text.replaceAll(',', '.')) ?? 0,
          sucursalParaStock: sucursal?.id,
          controlaVencimiento: _controlaVencimiento,
          laboratorio: _emptyToNull(_laboratorioCtrl.text),
          principioActivo: _emptyToNull(_principioActivoCtrl.text),
          presentacion: _emptyToNull(_presentacionCtrl.text),
          concentracion: _emptyToNull(_concentracionCtrl.text),
          registroSanitario: _emptyToNull(_registroSanitarioCtrl.text),
          esControlado: _esControlado,
          numeroLoteInicial: _emptyToNull(_numeroLoteInicialCtrl.text),
          fechaFabricacionInicial: _fechaFabricacionInicial,
          fechaVencimientoInicial: _fechaVencimientoInicial,
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
          tieneLotes: _controlaVencimiento || widget.producto!.tieneLotes,
          controlaVencimiento: _controlaVencimiento,
          laboratorio: _laboratorioCtrl.text.trim(),
          principioActivo: _principioActivoCtrl.text.trim(),
          presentacion: _presentacionCtrl.text.trim(),
          concentracion: _concentracionCtrl.text.trim(),
          registroSanitario: _registroSanitarioCtrl.text.trim(),
          esControlado: _esControlado,
        );
        await repo.actualizar(actualizado);
      }

      if (mounted) Navigator.of(context).pop(true);
    } on AppException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _agregarLote() async {
    final producto = widget.producto;
    if (producto == null) return;
    final data = await showDialog<_NuevoLoteData>(
      context: context,
      builder: (context) => const _NuevoLoteDialog(),
    );
    if (data == null) return;
    final sucursal = await ref.read(sucursalActivaProvider.future);
    final deviceId =
        await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
    try {
      await ref.read(productoRepositoryProvider).crearLote(
            producto: producto,
            cantidad: data.cantidad,
            numeroLote: data.numeroLote,
            fechaFabricacion: data.fechaFabricacion,
            fechaVencimiento: data.fechaVencimiento,
            costoUnitario: data.costoUnitario,
            sucursalId: sucursal?.id,
            dispositivoId: deviceId,
          );
      await _cargarLotes();
    } on AppException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    }
  }

  static String? _emptyToNull(String value) {
    final trimmed = value.trim();
    return trimmed.isEmpty ? null : trimmed;
  }

  Future<void> _duplicar() async {
    if (widget.producto == null) return;
    final deviceId =
        await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
    await ref
        .read(productoRepositoryProvider)
        .duplicar(widget.producto!, dispositivoId: deviceId);
    if (mounted) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(configuracionControllerProvider).valueOrNull;
    final medicationEnabled = config?.businessCapabilities
            .contains(BusinessCapability.medication.code) ??
        false;
    return Scaffold(
      appBar: AppBar(
        title: Text(_esNuevo ? 'Nuevo producto' : 'Editar producto'),
        actions: [
          if (!_esNuevo)
            IconButton(
                icon: const Icon(Icons.copy_outlined),
                tooltip: 'Duplicar',
                onPressed: _duplicar),
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
                if (medicationEnabled) ...[
                  const SizedBox(height: 20),
                  Text('Datos del medicamento',
                      style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _laboratorioCtrl,
                    decoration: const InputDecoration(labelText: 'Laboratorio'),
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _principioActivoCtrl,
                    decoration:
                        const InputDecoration(labelText: 'Principio activo'),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: TextFormField(
                          controller: _presentacionCtrl,
                          decoration:
                              const InputDecoration(labelText: 'Presentación'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: TextFormField(
                          controller: _concentracionCtrl,
                          decoration:
                              const InputDecoration(labelText: 'Concentración'),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _registroSanitarioCtrl,
                    decoration:
                        const InputDecoration(labelText: 'Registro sanitario'),
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Producto controlado'),
                    value: _esControlado,
                    onChanged: (value) => setState(() => _esControlado = value),
                  ),
                ],
                const SizedBox(height: 12),
                TextFormField(
                  controller: _descripcionCtrl,
                  decoration: const InputDecoration(
                      labelText: 'Descripción (opcional)'),
                  maxLines: 2,
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Controlar vencimiento'),
                  subtitle:
                      const Text('Usa lotes y bloquea productos vencidos'),
                  value: _controlaVencimiento,
                  onChanged: (value) =>
                      setState(() => _controlaVencimiento = value),
                ),
                if (_esNuevo && _controlaVencimiento) ...[
                  TextFormField(
                    controller: _numeroLoteInicialCtrl,
                    decoration:
                        const InputDecoration(labelText: 'Número de lote'),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: _DateButton(
                          label: 'Fabricación',
                          value: _fechaFabricacionInicial,
                          onChanged: (value) =>
                              setState(() => _fechaFabricacionInicial = value),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: _DateButton(
                          label: 'Vencimiento',
                          value: _fechaVencimientoInicial,
                          onChanged: (value) =>
                              setState(() => _fechaVencimientoInicial = value),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                ],
                if (!_esNuevo && _controlaVencimiento) ...[
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text('Lotes',
                          style: Theme.of(context).textTheme.titleMedium),
                      IconButton(
                        tooltip: 'Agregar lote',
                        onPressed: _agregarLote,
                        icon: const Icon(Icons.add_box_outlined),
                      ),
                    ],
                  ),
                  if (_lotes.isEmpty)
                    const Text('No hay lotes registrados.')
                  else
                    for (final lote in _lotes)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(
                          lote.expired
                              ? Icons.block
                              : Icons.inventory_2_outlined,
                          color: lote.expired
                              ? Theme.of(context).colorScheme.error
                              : null,
                        ),
                        title: Text(lote.numeroLote ?? 'Sin número de lote'),
                        subtitle: Text(
                          '${lote.expirationStatus} · ${lote.fechaVencimiento?.toIso8601String().substring(0, 10) ?? "Sin fecha"}',
                        ),
                        trailing: Text(lote.cantidad.toStringAsFixed(2)),
                      ),
                ],
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
                        decoration: const InputDecoration(
                            labelText: 'Código de barras'),
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
                    const DropdownMenuItem(
                        value: null, child: Text('Sin categoría')),
                    ..._categorias.map((c) =>
                        DropdownMenuItem(value: c.id, child: Text(c.nombre))),
                  ],
                  onChanged: (v) => setState(() => _categoriaId = v),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _marcaCtrl,
                  decoration:
                      const InputDecoration(labelText: 'Marca (opcional)'),
                ),
                const SizedBox(height: 20),
                Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        controller: _precioVentaCtrl,
                        decoration: const InputDecoration(
                            labelText: 'Precio de venta', prefixText: 'RD\$ '),
                        keyboardType: const TextInputType.numberWithOptions(
                            decimal: true),
                        validator: (v) => Validators.positiveNumber(v,
                            label: 'El precio de venta'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: TextFormField(
                        controller: _precioCompraCtrl,
                        decoration: const InputDecoration(
                            labelText: 'Precio de compra', prefixText: 'RD\$ '),
                        keyboardType: const TextInputType.numberWithOptions(
                            decimal: true),
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
                        keyboardType: const TextInputType.numberWithOptions(
                            decimal: true),
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
                    decoration:
                        const InputDecoration(labelText: 'Stock inicial'),
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                  ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _stockMinimoCtrl,
                  decoration:
                      const InputDecoration(labelText: 'Stock mínimo (alerta)'),
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
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
                    subtitle: const Text(
                        'Si lo desactivas, no aparecerá en el punto de venta'),
                    value: _activo,
                    onChanged: (v) => setState(() => _activo = v),
                  ),
                const SizedBox(height: 20),
                LoadingButton(
                    label: 'Guardar',
                    isLoading: _cargando,
                    onPressed: _guardar),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _DateButton extends StatelessWidget {
  const _DateButton({
    required this.label,
    required this.value,
    required this.onChanged,
  });

  final String label;
  final DateTime? value;
  final ValueChanged<DateTime> onChanged;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: () async {
        final now = DateTime.now();
        final selected = await showDatePicker(
          context: context,
          initialDate: value ?? now,
          firstDate: DateTime(now.year - 20),
          lastDate: DateTime(now.year + 30),
        );
        if (selected != null) onChanged(selected);
      },
      icon: const Icon(Icons.calendar_month_outlined),
      label: Text(
        value == null ? label : value!.toIso8601String().substring(0, 10),
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}

class _NuevoLoteData {
  const _NuevoLoteData({
    required this.cantidad,
    required this.fechaVencimiento,
    this.numeroLote,
    this.fechaFabricacion,
    this.costoUnitario,
  });

  final double cantidad;
  final DateTime fechaVencimiento;
  final String? numeroLote;
  final DateTime? fechaFabricacion;
  final double? costoUnitario;
}

class _NuevoLoteDialog extends StatefulWidget {
  const _NuevoLoteDialog();

  @override
  State<_NuevoLoteDialog> createState() => _NuevoLoteDialogState();
}

class _NuevoLoteDialogState extends State<_NuevoLoteDialog> {
  final _numeroCtrl = TextEditingController();
  final _cantidadCtrl = TextEditingController();
  final _costoCtrl = TextEditingController();
  DateTime? _fabricacion;
  DateTime? _vencimiento;
  String? _error;

  @override
  void dispose() {
    _numeroCtrl.dispose();
    _cantidadCtrl.dispose();
    _costoCtrl.dispose();
    super.dispose();
  }

  void _submit() {
    final cantidad =
        double.tryParse(_cantidadCtrl.text.trim().replaceAll(',', '.'));
    if (cantidad == null || cantidad <= 0 || _vencimiento == null) {
      setState(() => _error =
          'Indica una cantidad mayor que cero y la fecha de vencimiento.');
      return;
    }
    Navigator.of(context).pop(
      _NuevoLoteData(
        cantidad: cantidad,
        fechaVencimiento: _vencimiento!,
        numeroLote:
            _numeroCtrl.text.trim().isEmpty ? null : _numeroCtrl.text.trim(),
        fechaFabricacion: _fabricacion,
        costoUnitario:
            double.tryParse(_costoCtrl.text.trim().replaceAll(',', '.')),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Agregar lote'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: _numeroCtrl,
              decoration: const InputDecoration(labelText: 'Número de lote'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _cantidadCtrl,
              decoration: const InputDecoration(labelText: 'Cantidad'),
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _costoCtrl,
              decoration: const InputDecoration(labelText: 'Costo unitario'),
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
            ),
            const SizedBox(height: 12),
            _DateButton(
              label: 'Fecha de fabricación',
              value: _fabricacion,
              onChanged: (value) => setState(() => _fabricacion = value),
            ),
            const SizedBox(height: 8),
            _DateButton(
              label: 'Fecha de vencimiento',
              value: _vencimiento,
              onChanged: (value) => setState(() => _vencimiento = value),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancelar'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Guardar lote')),
      ],
    );
  }
}

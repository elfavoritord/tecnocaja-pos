import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../../../core/config/routes.dart';
import '../../../../core/constants/app_colors.dart';
import '../../../../data/models/inventory_model.dart';
import '../../../../data/models/user_model.dart';
import '../../../../data/repositories/product_write_repository.dart';
import '../../../../features/auth/providers/auth_provider.dart';
import '../../../../shared/widgets/app_empty_state.dart';
import '../../../../shared/widgets/report_scaffold.dart';

final _productCategoryStreamProvider = StreamProvider.autoDispose
    .family<List<ProductCategoryOption>, String>((ref, businessId) {
      return ProductWriteRepository().watchCategories(businessId);
    });

class ProductManageScreen extends ConsumerStatefulWidget {
  final ProductModel? product;

  const ProductManageScreen({super.key, this.product});

  @override
  ConsumerState<ProductManageScreen> createState() =>
      _ProductManageScreenState();
}

class _ProductManageScreenState extends ConsumerState<ProductManageScreen> {
  final _formKey = GlobalKey<FormState>();
  final _repo = ProductWriteRepository();
  final _name = TextEditingController();
  final _barcode = TextEditingController();
  final _brand = TextEditingController();
  final _cost = TextEditingController(text: '0');
  final _price = TextEditingController();
  final _stock = TextEditingController(text: '0');
  final _minStock = TextEditingController(text: '0');
  Uint8List? _imageBytes;
  String? _imageName;
  String _unit = 'unidad';
  String? _selectedCategory;
  bool _appliesTax = false;
  bool _isActive = true;
  bool _saving = false;
  String? _errorMessage;
  bool _allowNoBarcode = false;
  bool _duplicateOverride = false;
  Timer? _availabilityTimer;
  bool _checkingAvailability = false;
  String? _availabilityError;
  List<ProductDuplicateCandidate> _availabilityCandidates = [];

  @override
  void initState() {
    super.initState();
    final product = widget.product;
    if (product != null) {
      _name.text = product.name;
      _barcode.text = product.barcode ?? product.sku ?? '';
      _selectedCategory = product.category.isEmpty ? null : product.category;
      _brand.text = product.brand;
      _cost.text = product.cost.toStringAsFixed(2);
      _price.text = product.price.toStringAsFixed(2);
      _stock.text = product.stock.toString();
      _minStock.text = product.minStock.toString();
      if (['unidad', 'libra', 'paquete', 'caja'].contains(product.unit)) {
        _unit = product.unit;
      }
      _appliesTax = product.appliesTax;
      _isActive = product.isActive;
      _allowNoBarcode = _barcode.text.trim().isEmpty;
    }
    _name.addListener(_scheduleAvailabilityCheck);
    _barcode.addListener(_scheduleAvailabilityCheck);
    _brand.addListener(_scheduleAvailabilityCheck);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _scheduleAvailabilityCheck();
    });
  }

  @override
  void dispose() {
    _availabilityTimer?.cancel();
    _name.dispose();
    _barcode.dispose();
    _brand.dispose();
    _cost.dispose();
    _price.dispose();
    _stock.dispose();
    _minStock.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final businessId = ref.watch(activeBusinessIdProvider);
    final profile = ref.watch(currentUserProfileProvider).valueOrNull;
    final categoriesAsync = businessId == null || businessId.isEmpty
        ? const AsyncValue<List<ProductCategoryOption>>.data([])
        : ref.watch(_productCategoryStreamProvider(businessId));
    final loadedCategories = categoriesAsync.valueOrNull;
    final canManage =
        profile?.role == UserRole.admin ||
        profile?.role == UserRole.branchAdmin;

    if (businessId == null || businessId.isEmpty || profile == null) {
      return const Scaffold(
        body: AppErrorState(message: 'No hay sesión activa.'),
      );
    }
    if (!canManage) {
      return const Scaffold(
        body: AppErrorState(
          message: 'Solo administradores pueden agregar o editar productos.',
        ),
      );
    }

    return ReportScaffold(
      title: widget.product == null ? 'Agregar Producto' : 'Editar Producto',
      actions: [
        IconButton(
          tooltip: 'Guardar',
          onPressed:
              _saving || loadedCategories == null || loadedCategories.isEmpty
              ? null
              : () => _save(
                  businessId,
                  profile,
                  _mergeCurrentCategory(loadedCategories),
                ),
          icon: _saving
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.save_outlined),
        ),
      ],
      body: Form(
        key: _formKey,
        child: categoriesAsync.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => AppErrorState(
            message: 'No se pudieron cargar las categorías del POS: $error',
            onRetry: () =>
                ref.invalidate(_productCategoryStreamProvider(businessId)),
          ),
          data: (categories) => _buildForm(
            businessId: businessId,
            profile: profile,
            categories: _mergeCurrentCategory(categories),
          ),
        ),
      ),
    );
  }

  Widget _buildForm({
    required String businessId,
    required UserModel profile,
    required List<ProductCategoryOption> categories,
  }) {
    final isGeneralAdmin = profile.role == UserRole.admin;
    final categoryNames = categories.map((item) => item.name).toSet();
    final selectedCategory = categoryNames.contains(_selectedCategory)
        ? _selectedCategory
        : null;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
      children: [
        if (_errorMessage != null) ...[
          _InlineError(message: _errorMessage!),
          const SizedBox(height: 12),
        ],
        if (categories.isEmpty) ...[
          const _InlineError(
            message:
                'No hay categorías sincronizadas desde el POS. Crea o sincroniza categorías en Tecno Caja POS antes de agregar productos.',
          ),
          const SizedBox(height: 12),
        ],
        _SyncNotice(product: widget.product),
        const SizedBox(height: 12),
        _SectionCard(
          title: 'Datos del producto',
          icon: Icons.inventory_2_outlined,
          children: [
            _field(_name, 'Nombre del producto', required: true),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: _field(
                    _barcode,
                    'Código de barra',
                    required: !_allowNoBarcode,
                    enabled: !_allowNoBarcode,
                  ),
                ),
                const SizedBox(width: 10),
                IconButton.filledTonal(
                  tooltip: 'Usar cámara',
                  onPressed: _saving || _allowNoBarcode ? null : _scanBarcode,
                  icon: const Icon(Icons.qr_code_scanner_rounded),
                ),
              ],
            ),
            _AvailabilityText(
              text: _barcodeAvailabilityText(),
              status: _barcodeAvailabilityStatus(),
            ),
            if (isGeneralAdmin) ...[
              const SizedBox(height: 4),
              SwitchListTile(
                value: _allowNoBarcode,
                onChanged: _saving
                    ? null
                    : (value) => setState(() {
                        _allowNoBarcode = value;
                        if (value) _barcode.clear();
                        _scheduleAvailabilityCheck();
                      }),
                contentPadding: EdgeInsets.zero,
                title: const Text('Producto sin código'),
                subtitle: const Text(
                  'Solo usar cuando el producto no tenga código de barra.',
                ),
              ),
            ],
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              initialValue: selectedCategory,
              decoration: const InputDecoration(labelText: 'Categoría del POS'),
              items: categories
                  .map(
                    (category) => DropdownMenuItem(
                      value: category.name,
                      child: Text(category.name),
                    ),
                  )
                  .toList(),
              validator: (value) => value == null || value.trim().isEmpty
                  ? 'Selecciona una categoría del POS'
                  : null,
              onChanged: _saving
                  ? null
                  : (value) => setState(() {
                      _selectedCategory = value;
                      _scheduleAvailabilityCheck();
                    }),
            ),
            _AvailabilityText(
              text: _nameAvailabilityText(),
              status: _nameAvailabilityStatus(),
            ),
            const SizedBox(height: 10),
            _field(_brand, 'Marca opcional'),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              initialValue: _unit,
              decoration: const InputDecoration(labelText: 'Unidad de venta'),
              items: const [
                DropdownMenuItem(value: 'unidad', child: Text('Unidad')),
                DropdownMenuItem(value: 'libra', child: Text('Libra')),
                DropdownMenuItem(value: 'paquete', child: Text('Paquete')),
                DropdownMenuItem(value: 'caja', child: Text('Caja')),
              ],
              onChanged: _saving
                  ? null
                  : (value) => setState(() => _unit = value ?? 'unidad'),
            ),
          ],
        ),
        const SizedBox(height: 12),
        _SectionCard(
          title: 'Precio e inventario',
          icon: Icons.payments_outlined,
          children: [
            Row(
              children: [
                Expanded(child: _numberField(_cost, 'Costo', allowZero: true)),
                const SizedBox(width: 10),
                Expanded(child: _numberField(_price, 'Precio de venta')),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(child: _intField(_stock, 'Stock inicial')),
                const SizedBox(width: 10),
                Expanded(child: _intField(_minStock, 'Stock mínimo')),
              ],
            ),
            const SizedBox(height: 8),
            SwitchListTile(
              value: _appliesTax,
              onChanged: (v) => setState(() => _appliesTax = v),
              contentPadding: EdgeInsets.zero,
              title: const Text('Aplica ITBIS'),
            ),
            SwitchListTile(
              value: _isActive,
              onChanged: (v) => setState(() => _isActive = v),
              contentPadding: EdgeInsets.zero,
              title: const Text('Producto activo'),
            ),
          ],
        ),
        const SizedBox(height: 12),
        _SectionCard(
          title: 'Imagen opcional',
          icon: Icons.image_outlined,
          children: [
            if (_imageBytes != null)
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Image.memory(
                  _imageBytes!,
                  height: 140,
                  fit: BoxFit.cover,
                ),
              )
            else
              Container(
                height: 100,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  border: Border.all(color: AppColors.lightBorder),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(_imageName ?? 'Sin imagen seleccionada'),
              ),
            const SizedBox(height: 10),
            FilledButton.icon(
              onPressed: _saving ? null : _pickImage,
              icon: const Icon(Icons.photo_library_outlined),
              label: const Text('Seleccionar imagen'),
            ),
          ],
        ),
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: _saving || categories.isEmpty
              ? null
              : () => _save(businessId, profile, categories),
          icon: const Icon(Icons.cloud_upload_outlined),
          label: Text(_saving ? 'Guardando...' : 'Guardar en la nube'),
        ),
      ],
    );
  }

  Widget _field(
    TextEditingController controller,
    String label, {
    bool required = false,
    bool enabled = true,
  }) {
    return TextFormField(
      controller: controller,
      enabled: enabled,
      decoration: InputDecoration(labelText: label),
      validator: required
          ? (value) => (value == null || value.trim().isEmpty)
                ? 'Campo obligatorio'
                : null
          : null,
    );
  }

  Widget _numberField(
    TextEditingController controller,
    String label, {
    bool allowZero = false,
  }) {
    return TextFormField(
      controller: controller,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      decoration: InputDecoration(labelText: label),
      validator: (value) {
        final number =
            double.tryParse((value ?? '').replaceAll(',', '.')) ?? -1;
        if (allowZero ? number < 0 : number <= 0) {
          return allowZero ? 'No negativo' : 'Mayor que cero';
        }
        return null;
      },
    );
  }

  Widget _intField(TextEditingController controller, String label) {
    return TextFormField(
      controller: controller,
      keyboardType: TextInputType.number,
      decoration: InputDecoration(labelText: label),
      validator: (value) {
        final number = int.tryParse(value ?? '') ?? -1;
        return number < 0 ? 'No negativo' : null;
      },
    );
  }

  Future<void> _scanBarcode() async {
    final value = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const _BarcodeScannerScreen()),
    );
    if (value == null || value.trim().isEmpty) return;
    setState(() {
      _errorMessage = null;
      _barcode.text = value.trim();
      _allowNoBarcode = false;
    });
    _scheduleAvailabilityCheck();
  }

  Future<void> _pickImage() async {
    try {
      final picked = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        imageQuality: 82,
      );
      if (picked == null) return;
      final bytes = await picked.readAsBytes();
      if (!mounted) return;
      setState(() {
        _errorMessage = null;
        _imageBytes = bytes;
        _imageName = picked.name;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _errorMessage = 'No se pudo seleccionar la imagen: $error';
      });
    }
  }

  void _scheduleAvailabilityCheck() {
    _availabilityTimer?.cancel();
    if (!mounted) return;
    final businessId = ref.read(activeBusinessIdProvider);
    if (businessId == null || businessId.isEmpty) return;

    final hasName = _name.text.trim().isNotEmpty;
    final hasBarcode = !_allowNoBarcode && _barcode.text.trim().isNotEmpty;
    if (!hasName && !hasBarcode) {
      setState(() {
        _checkingAvailability = false;
        _availabilityError = null;
        _availabilityCandidates = [];
      });
      return;
    }

    setState(() {
      _checkingAvailability = true;
      _availabilityError = null;
    });
    _availabilityTimer = Timer(const Duration(milliseconds: 450), () {
      _checkAvailability(businessId);
    });
  }

  Future<void> _checkAvailability(String businessId) async {
    try {
      final candidates = await _repo.findDuplicateCandidates(
        businessId: businessId,
        currentDocId: widget.product?.id,
        name: _name.text,
        barcode: _allowNoBarcode ? '' : _barcode.text,
        category: _selectedCategory ?? '',
        brand: _brand.text,
      );
      if (!mounted) return;
      setState(() {
        _availabilityCandidates = candidates;
        _availabilityError = null;
        _checkingAvailability = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _availabilityError = error.toString().replaceFirst('Exception: ', '');
        _availabilityCandidates = [];
        _checkingAvailability = false;
      });
    }
  }

  String? _barcodeAvailabilityText() {
    if (_allowNoBarcode) return 'Producto sin código activado.';
    final barcode = _barcode.text.trim();
    if (barcode.isEmpty) return null;
    if (_checkingAvailability) return 'Validando código...';
    if (_availabilityError != null) return _availabilityError;
    final duplicate = _availabilityCandidates
        .where((candidate) => candidate.sameBarcode)
        .map((candidate) => candidate.product)
        .firstOrNull;
    if (duplicate != null) {
      return 'Ese código ya está registrado en: ${duplicate.name}';
    }
    return 'Código disponible.';
  }

  _AvailabilityStatus _barcodeAvailabilityStatus() {
    if (_checkingAvailability) return _AvailabilityStatus.checking;
    if (_availabilityError != null) return _AvailabilityStatus.warning;
    if (_availabilityCandidates.any((candidate) => candidate.sameBarcode)) {
      return _AvailabilityStatus.error;
    }
    return _AvailabilityStatus.available;
  }

  String? _nameAvailabilityText() {
    final name = _name.text.trim();
    if (name.isEmpty) return null;
    if (_checkingAvailability) return 'Validando nombre...';
    if (_availabilityError != null) return null;
    final duplicate = _availabilityCandidates
        .where((candidate) => candidate.sameName || candidate.similarName)
        .map((candidate) => candidate.product)
        .firstOrNull;
    if (duplicate != null) {
      return 'Producto parecido encontrado: ${duplicate.name}';
    }
    return 'Nombre disponible.';
  }

  _AvailabilityStatus _nameAvailabilityStatus() {
    if (_checkingAvailability) return _AvailabilityStatus.checking;
    if (_availabilityCandidates.any(
      (candidate) => candidate.sameName || candidate.similarName,
    )) {
      return _AvailabilityStatus.warning;
    }
    return _AvailabilityStatus.available;
  }

  Future<void> _save(
    String businessId,
    UserModel profile,
    List<ProductCategoryOption> categories, {
    String? overrideDocId,
    bool skipDuplicateAlert = false,
  }) async {
    if (!_formKey.currentState!.validate()) return;
    if (!categories.any((item) => item.name == _selectedCategory)) {
      setState(() {
        _errorMessage = 'Selecciona una categoría sincronizada desde el POS.';
      });
      return;
    }
    if (_barcode.text.trim().isEmpty && !_allowNoBarcode) {
      setState(() {
        _errorMessage = 'Debes colocar el código de barra.';
      });
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _saving = true;
      _errorMessage = null;
    });
    try {
      if (!skipDuplicateAlert && !_duplicateOverride) {
        final duplicates = await _repo.findDuplicateCandidates(
          businessId: businessId,
          currentDocId: overrideDocId ?? widget.product?.id,
          name: _name.text,
          barcode: _allowNoBarcode ? '' : _barcode.text,
          category: _selectedCategory ?? '',
          brand: _brand.text,
        );
        if (duplicates.isNotEmpty) {
          if (!mounted) return;
          setState(() => _saving = false);
          final action = await _showDuplicateDialog(profile, duplicates);
          if (!mounted ||
              action == null ||
              action.type == _DuplicateActionType.cancel) {
            return;
          }
          if (action.type == _DuplicateActionType.viewExisting) {
            context.pushReplacement(AppRoutes.productManage, extra: action.product);
            return;
          }
          if (action.type == _DuplicateActionType.updateExisting) {
            await _save(
              businessId,
              profile,
              categories,
              overrideDocId: action.product!.id,
              skipDuplicateAlert: true,
            );
            return;
          }
          if (action.type == _DuplicateActionType.createAnyway) {
            _duplicateOverride = true;
            await _save(
              businessId,
              profile,
              categories,
              skipDuplicateAlert: true,
            );
            return;
          }
        }
      }

      await _repo.saveProduct(
        businessId: businessId,
        user: profile,
        input: ProductWriteInput(
          docId: overrideDocId ?? widget.product?.id,
          name: _name.text,
          barcode: _allowNoBarcode ? '' : _barcode.text,
          category: _selectedCategory ?? '',
          brand: _brand.text,
          unit: _unit,
          cost: double.tryParse(_cost.text.replaceAll(',', '.')) ?? 0,
          price: double.tryParse(_price.text.replaceAll(',', '.')) ?? 0,
          stock: int.tryParse(_stock.text) ?? 0,
          minStock: int.tryParse(_minStock.text) ?? 0,
          appliesTax: _appliesTax,
          isActive: _isActive,
          branchId: profile.branchIds.isNotEmpty
              ? profile.branchIds.first
              : null,
          imageBytes: _imageBytes,
          currentImageUrl: widget.product?.imageUrl,
          allowNoBarcode: _allowNoBarcode,
        ),
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Producto guardado. El POS lo sincronizará automáticamente.',
          ),
        ),
      );
      context.pop();
    } catch (error) {
      if (!mounted) return;
      final message = error.toString().replaceFirst('Exception: ', '');
      setState(() => _errorMessage = message);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(message)));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  List<ProductCategoryOption> _mergeCurrentCategory(
    List<ProductCategoryOption> categories,
  ) {
    final current = _selectedCategory?.trim();
    if (current == null || current.isEmpty) return categories;
    if (categories.any(
      (item) => item.name.toLowerCase() == current.toLowerCase(),
    )) {
      return categories;
    }
    if (widget.product == null) return categories;
    return [
      ...categories,
      ProductCategoryOption(id: 'current-${widget.product!.id}', name: current),
    ]..sort((a, b) => a.name.compareTo(b.name));
  }

  Future<_DuplicateAction?> _showDuplicateDialog(
    UserModel profile,
    List<ProductDuplicateCandidate> duplicates,
  ) {
    final hardBarcodeDuplicate = duplicates.any((item) => item.sameBarcode);
    final primary = duplicates.first;
    final canCreateAnyway =
        profile.role == UserRole.admin && !hardBarcodeDuplicate;

    return showDialog<_DuplicateAction>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Producto parecido encontrado'),
        content: SizedBox(
          width: 420,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Ya existe un producto parecido o con el mismo código de barra.',
                ),
                const SizedBox(height: 12),
                ...duplicates.take(4).map(_DuplicateProductPreview.new),
                if (hardBarcodeDuplicate) ...[
                  const SizedBox(height: 8),
                  const Text(
                    'No se permite duplicar código de barra.',
                    style: TextStyle(
                      color: AppColors.error,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(
              context,
              const _DuplicateAction(_DuplicateActionType.cancel),
            ),
            child: const Text('Cancelar'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(
              context,
              _DuplicateAction(
                _DuplicateActionType.viewExisting,
                product: primary.product,
              ),
            ),
            child: const Text('Ver producto existente'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(
              context,
              _DuplicateAction(
                _DuplicateActionType.updateExisting,
                product: primary.product,
              ),
            ),
            child: const Text('Actualizar existente'),
          ),
          if (canCreateAnyway)
            FilledButton(
              onPressed: () => Navigator.pop(
                context,
                const _DuplicateAction(_DuplicateActionType.createAnyway),
              ),
              child: const Text('Crear de todos modos'),
            ),
        ],
      ),
    );
  }
}

enum _AvailabilityStatus { available, warning, error, checking }

class _AvailabilityText extends StatelessWidget {
  final String? text;
  final _AvailabilityStatus status;

  const _AvailabilityText({required this.text, required this.status});

  @override
  Widget build(BuildContext context) {
    if (text == null || text!.trim().isEmpty) return const SizedBox.shrink();
    final color = switch (status) {
      _AvailabilityStatus.available => AppColors.success,
      _AvailabilityStatus.warning => AppColors.warning,
      _AvailabilityStatus.error => AppColors.error,
      _AvailabilityStatus.checking => AppColors.primary,
    };
    return Padding(
      padding: const EdgeInsets.only(top: 4, left: 4),
      child: Text(
        text!,
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

enum _DuplicateActionType { cancel, viewExisting, updateExisting, createAnyway }

class _DuplicateAction {
  final _DuplicateActionType type;
  final ProductModel? product;

  const _DuplicateAction(this.type, {this.product});
}

class _DuplicateProductPreview extends StatelessWidget {
  final ProductDuplicateCandidate candidate;

  const _DuplicateProductPreview(this.candidate);

  @override
  Widget build(BuildContext context) {
    final product = candidate.product;
    final created = product.createdAt == null
        ? 'Sin fecha'
        : '${product.createdAt!.day.toString().padLeft(2, '0')}/'
              '${product.createdAt!.month.toString().padLeft(2, '0')}/'
              '${product.createdAt!.year}';
    final origin = product.origin == 'app_reporte' ? 'App de Reporte' : 'POS';

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AppColors.lightBackground,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.lightBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            product.name,
            style: const TextStyle(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 4),
          Text(
            'Código: ${product.barcode?.isNotEmpty == true ? product.barcode : product.sku ?? 'Sin código'}',
          ),
          Text(
            'Categoría: ${product.category.isEmpty ? 'Sin categoría' : product.category}',
          ),
          Text('Precio: ${product.price.toStringAsFixed(2)}'),
          Text('Stock actual: ${product.stock}'),
          Text('Fecha de creación: $created'),
          Text('Origen: $origin'),
        ],
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  final String message;

  const _InlineError({required this.message});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.errorLight,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.error.withValues(alpha: 0.25)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.error_outline_rounded, color: AppColors.error),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(
                color: AppColors.error,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _BarcodeScannerScreen extends StatelessWidget {
  const _BarcodeScannerScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Escanear código')),
      body: MobileScanner(
        onDetect: (capture) {
          final value = capture.barcodes
              .map((barcode) => barcode.rawValue)
              .whereType<String>()
              .firstWhere((value) => value.trim().isNotEmpty, orElse: () => '');
          if (value.isNotEmpty) Navigator.of(context).pop(value);
        },
      ),
    );
  }
}

class _SectionCard extends StatelessWidget {
  final String title;
  final IconData icon;
  final List<Widget> children;

  const _SectionCard({
    required this.title,
    required this.icon,
    required this.children,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Theme.of(context).cardColor,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.lightBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 20, color: AppColors.primary),
              const SizedBox(width: 8),
              Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
            ],
          ),
          const SizedBox(height: 12),
          ...children,
        ],
      ),
    );
  }
}

class _SyncNotice extends StatelessWidget {
  final ProductModel? product;

  const _SyncNotice({this.product});

  @override
  Widget build(BuildContext context) {
    final status = product?.syncStatus ?? 'pending';
    final synced = product?.synced ?? false;
    final color = synced
        ? AppColors.success
        : status == 'error'
        ? AppColors.error
        : AppColors.warning;
    final text = product == null
        ? 'Se guardará primero en la nube y luego el POS lo recibirá automáticamente.'
        : synced
        ? 'Producto sincronizado con Tecno Caja POS.'
        : status == 'error'
        ? 'Producto con error de sincronización: ${product?.syncError ?? ''}'
        : 'Producto pendiente de sincronizar con Tecno Caja POS.';

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          Icon(Icons.cloud_sync_outlined, color: color),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: TextStyle(color: color, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}

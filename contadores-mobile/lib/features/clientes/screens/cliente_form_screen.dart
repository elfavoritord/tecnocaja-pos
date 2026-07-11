import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../data/models/user_model.dart';
import '../../../data/services/dgii_service.dart';
import '../../auth/providers/auth_provider.dart';
import '../providers/clientes_provider.dart';

class ClienteFormScreen extends ConsumerStatefulWidget {
  final String? clienteId;
  final ClienteModel? cliente;

  const ClienteFormScreen({super.key, this.clienteId, this.cliente});

  @override
  ConsumerState<ClienteFormScreen> createState() => _ClienteFormScreenState();
}

class _ClienteFormScreenState extends ConsumerState<ClienteFormScreen> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _nombreCtrl;
  late final TextEditingController _rncCtrl;
  late final TextEditingController _propietarioCtrl;
  late final TextEditingController _correoCtrl;
  late final TextEditingController _telefonoCtrl;
  late final TextEditingController _direccionCtrl;

  Timer? _dgiiTimer;
  bool _dgiiLoading = false;
  DgiiResult? _dgiiResult;
  String? _dgiiError;

  bool get _isEdit => widget.clienteId != null;

  @override
  void initState() {
    super.initState();
    final c = widget.cliente;
    _nombreCtrl = TextEditingController(text: c?.businessName ?? '');
    _rncCtrl = TextEditingController(text: c?.rnc ?? '');
    _propietarioCtrl = TextEditingController(text: c?.propietario ?? '');
    _correoCtrl = TextEditingController(text: c?.correo ?? '');
    _telefonoCtrl = TextEditingController(text: c?.telefono ?? '');
    _direccionCtrl = TextEditingController(text: c?.direccion ?? '');

    _rncCtrl.addListener(_onRncChanged);
  }

  void _onRncChanged() {
    final digits = _rncCtrl.text.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.length < 9) {
      _dgiiTimer?.cancel();
      if (_dgiiResult != null || _dgiiError != null) {
        setState(() { _dgiiResult = null; _dgiiError = null; });
      }
      return;
    }

    _dgiiTimer?.cancel();
    _dgiiTimer = Timer(const Duration(milliseconds: 700), () => _buscarDgii(digits));
  }

  Future<void> _buscarDgii(String digits) async {
    setState(() { _dgiiLoading = true; _dgiiResult = null; _dgiiError = null; });

    final result = await DgiiService.buscar(digits);

    if (!mounted) return;
    setState(() { _dgiiLoading = false; });

    if (result == null) {
      setState(() { _dgiiError = DgiiService.mensajeError(digits); });
      return;
    }

    setState(() { _dgiiResult = result; });

    // Auto-fill solo si los campos están vacíos
    if (_nombreCtrl.text.trim().isEmpty) {
      _nombreCtrl.text = result.nombreComercialDisplay?.isNotEmpty == true
          ? result.nombreComercialDisplay!
          : result.nombreDisplay;
    }
    if (_propietarioCtrl.text.trim().isEmpty && result.isFisico) {
      _propietarioCtrl.text = result.nombreDisplay;
    }
  }

  void _aplicarDgii() {
    if (_dgiiResult == null) return;
    _nombreCtrl.text = _dgiiResult!.nombreComercialDisplay?.isNotEmpty == true
        ? _dgiiResult!.nombreComercialDisplay!
        : _dgiiResult!.nombreDisplay;
    if (_dgiiResult!.isFisico) {
      _propietarioCtrl.text = _dgiiResult!.nombreDisplay;
    }
  }

  @override
  void dispose() {
    _dgiiTimer?.cancel();
    _nombreCtrl.dispose();
    _rncCtrl.dispose();
    _propietarioCtrl.dispose();
    _correoCtrl.dispose();
    _telefonoCtrl.dispose();
    _direccionCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    final profile = ref.read(userProfileProvider).valueOrNull;
    if (profile == null) return;

    final cliente = ClienteModel(
      id: widget.clienteId ?? '',
      contadorId: profile.contadorDocId,
      businessName: _nombreCtrl.text.trim(),
      rnc: _rncCtrl.text.trim().isEmpty ? null : _rncCtrl.text.trim(),
      propietario: _propietarioCtrl.text.trim().isEmpty ? null : _propietarioCtrl.text.trim(),
      correo: _correoCtrl.text.trim().isEmpty ? null : _correoCtrl.text.trim(),
      telefono: _telefonoCtrl.text.trim().isEmpty ? null : _telefonoCtrl.text.trim(),
      direccion: _direccionCtrl.text.trim().isEmpty ? null : _direccionCtrl.text.trim(),
    );

    final ok = await ref.read(clienteFormProvider.notifier).save(cliente, id: widget.clienteId);
    if (ok && mounted) context.pop();
  }

  @override
  Widget build(BuildContext context) {
    final formState = ref.watch(clienteFormProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text(_isEdit ? 'Editar cliente' : 'Nuevo cliente'),
        actions: [
          TextButton(
            onPressed: formState.isLoading ? null : _submit,
            child: const Text('Guardar'),
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (formState.hasError)
                Container(
                  margin: const EdgeInsets.only(bottom: 16),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: AppColors.errorLight, borderRadius: BorderRadius.circular(10)),
                  child: Text(formState.error.toString(), style: const TextStyle(color: AppColors.error)),
                ),

              _buildSection('Información básica', [
                // Campo RNC con búsqueda DGII
                TextFormField(
                  controller: _rncCtrl,
                  keyboardType: TextInputType.number,
                  decoration: InputDecoration(
                    labelText: 'RNC / Cédula',
                    prefixIcon: const Icon(Icons.badge_outlined),
                    suffixIcon: _dgiiLoading
                        ? const Padding(
                            padding: EdgeInsets.all(12),
                            child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
                          )
                        : _dgiiResult != null
                            ? const Icon(Icons.check_circle_rounded, color: AppColors.success)
                            : null,
                  ),
                ),

                // Banner resultado DGII
                if (_dgiiResult != null) ...[
                  const SizedBox(height: 8),
                  _DgiiBanner(
                    result: _dgiiResult!,
                    onAplicar: _aplicarDgii,
                  ),
                ],
                if (_dgiiError != null) ...[
                  const SizedBox(height: 8),
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: AppColors.warningLight,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.info_outline, color: AppColors.warning, size: 16),
                        const SizedBox(width: 8),
                        Expanded(child: Text(_dgiiError!, style: const TextStyle(fontSize: 12, color: AppColors.warning))),
                      ],
                    ),
                  ),
                ],

                const SizedBox(height: 16),
                TextFormField(
                  controller: _nombreCtrl,
                  textCapitalization: TextCapitalization.words,
                  decoration: const InputDecoration(
                    labelText: 'Nombre de empresa *',
                    prefixIcon: Icon(Icons.business_outlined),
                  ),
                  validator: (v) => v == null || v.trim().isEmpty ? 'Campo requerido' : null,
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _propietarioCtrl,
                  textCapitalization: TextCapitalization.words,
                  decoration: const InputDecoration(
                    labelText: 'Propietario',
                    prefixIcon: Icon(Icons.person_outline),
                  ),
                ),
              ]),

              const SizedBox(height: 16),
              _buildSection('Contacto', [
                TextFormField(
                  controller: _correoCtrl,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(labelText: 'Correo electrónico', prefixIcon: Icon(Icons.email_outlined)),
                  validator: (v) {
                    if (v != null && v.isNotEmpty && !v.contains('@')) return 'Correo inválido';
                    return null;
                  },
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _telefonoCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'Teléfono', prefixIcon: Icon(Icons.phone_outlined)),
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _direccionCtrl,
                  textCapitalization: TextCapitalization.sentences,
                  maxLines: 2,
                  decoration: const InputDecoration(
                    labelText: 'Dirección',
                    prefixIcon: Icon(Icons.location_on_outlined),
                    alignLabelWithHint: true,
                  ),
                ),
              ]),

              const SizedBox(height: 32),
              ElevatedButton(
                onPressed: formState.isLoading ? null : _submit,
                child: formState.isLoading
                    ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : Text(_isEdit ? 'Actualizar cliente' : 'Registrar cliente'),
              ),
              const SizedBox(height: 40),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSection(String title, List<Widget> children) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14, color: AppColors.textSecondary)),
            const SizedBox(height: 16),
            ...children,
          ],
        ),
      ),
    );
  }
}

class _DgiiBanner extends StatelessWidget {
  final DgiiResult result;
  final VoidCallback onAplicar;

  const _DgiiBanner({required this.result, required this.onAplicar});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.success.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.success.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.verified_rounded, color: AppColors.success, size: 16),
              const SizedBox(width: 6),
              const Text('Encontrado en DGII', style: TextStyle(fontSize: 12, color: AppColors.success, fontWeight: FontWeight.w600)),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: result.isActivo ? AppColors.success.withValues(alpha: 0.15) : AppColors.error.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  result.estado,
                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: result.isActivo ? AppColors.success : AppColors.error),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(result.nombreDisplay, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
          if (result.nombreComercialDisplay != null && result.nombreComercialDisplay != result.nombreDisplay) ...[
            const SizedBox(height: 2),
            Text(result.nombreComercialDisplay!, style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
          ],
          if (result.categoria != null && result.categoria!.isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(result.categoria!, style: const TextStyle(fontSize: 11, color: AppColors.textTertiary), maxLines: 1, overflow: TextOverflow.ellipsis),
          ],
          const SizedBox(height: 10),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: onAplicar,
              icon: const Icon(Icons.auto_fix_high_rounded, size: 16),
              label: const Text('Aplicar datos al formulario'),
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.success,
                side: const BorderSide(color: AppColors.success),
                padding: const EdgeInsets.symmetric(vertical: 8),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

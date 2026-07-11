import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/fiscal_calendar.dart';
import '../../../core/utils/app_date_utils.dart';
import '../../../data/models/declaracion_model.dart';
import '../../auth/providers/auth_provider.dart';
import '../providers/declaraciones_provider.dart';

class DeclaracionFormScreen extends ConsumerStatefulWidget {
  final String? clienteId;
  final String? clienteNombre;
  final DeclaracionModel? declaracion;

  const DeclaracionFormScreen({super.key, this.clienteId, this.clienteNombre, this.declaracion});

  @override
  ConsumerState<DeclaracionFormScreen> createState() => _DeclaracionFormScreenState();
}

class _DeclaracionFormScreenState extends ConsumerState<DeclaracionFormScreen> {
  final _formKey = GlobalKey<FormState>();
  late String _tipo;
  late String _estado;
  String _periodo = '';
  DateTime? _fechaLimite;
  final _obsCtrl = TextEditingController();
  final _montoCtrl = TextEditingController();
  final _periodoCtrl = TextEditingController();

  bool get _isEdit => widget.declaracion != null;

  @override
  void initState() {
    super.initState();
    final d = widget.declaracion;
    _tipo = d?.tipo ?? FiscalCalendar.tiposDeclaracion.first;
    _estado = d?.estado ?? 'pendiente';
    _periodo = d?.periodo ?? _currentPeriodo();
    _periodoCtrl.text = _periodo;
    _fechaLimite = d?.fechaLimite;
    _obsCtrl.text = d?.observaciones ?? '';
    _montoCtrl.text = d?.montoDeclarado?.toString() ?? '';
  }

  String _currentPeriodo() {
    final now = DateTime.now();
    return '${now.year}-${now.month.toString().padLeft(2, '0')}';
  }

  @override
  void dispose() {
    _obsCtrl.dispose();
    _montoCtrl.dispose();
    _periodoCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickFecha() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _fechaLimite ?? DateTime.now().add(const Duration(days: 20)),
      firstDate: DateTime(2020),
      lastDate: DateTime(2030),
      helpText: 'Fecha límite',
    );
    if (picked != null) setState(() => _fechaLimite = picked);
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    final profile = ref.read(userProfileProvider).valueOrNull;
    if (profile == null) return;

    final dec = DeclaracionModel(
      id: widget.declaracion?.id ?? '',
      contadorId: profile.contadorDocId,
      clienteId: widget.clienteId,
      clienteNombre: widget.clienteNombre,
      tipo: _tipo,
      periodo: _periodoCtrl.text.trim(),
      estado: _estado,
      fechaLimite: _fechaLimite,
      observaciones: _obsCtrl.text.trim().isEmpty ? null : _obsCtrl.text.trim(),
      montoDeclarado: double.tryParse(_montoCtrl.text.replaceAll(',', '.')),
    );

    final ok = await ref.read(declaracionFormProvider.notifier).save(dec, id: widget.declaracion?.id);
    if (ok && mounted) context.pop();
  }

  @override
  Widget build(BuildContext context) {
    final formState = ref.watch(declaracionFormProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text(_isEdit ? 'Editar declaración' : 'Nueva declaración'),
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
                _ErrorBanner(message: formState.error.toString()),

              if (widget.clienteNombre != null)
                Card(
                  color: AppColors.primarySurface,
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      children: [
                        const Icon(Icons.business_rounded, color: AppColors.primary, size: 18),
                        const SizedBox(width: 8),
                        Text(widget.clienteNombre!, style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.primary)),
                      ],
                    ),
                  ),
                ),
              const SizedBox(height: 16),

              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Tipo de declaración *', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13, color: AppColors.textSecondary)),
                      const SizedBox(height: 12),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: FiscalCalendar.tiposDeclaracion.map((t) => ChoiceChip(
                          label: Text(t),
                          selected: _tipo == t,
                          onSelected: (_) => setState(() => _tipo = t),
                        )).toList(),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),

              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Detalles', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
                      const SizedBox(height: 16),
                      TextFormField(
                        controller: _periodoCtrl,
                        decoration: const InputDecoration(labelText: 'Período (YYYY-MM) *', prefixIcon: Icon(Icons.calendar_today_outlined), hintText: '2025-01'),
                        validator: (v) {
                          if (v == null || v.trim().isEmpty) return 'Campo requerido';
                          if (!RegExp(r'^\d{4}-\d{2}$').hasMatch(v.trim())) return 'Formato: YYYY-MM';
                          return null;
                        },
                      ),
                      const SizedBox(height: 16),
                      InkWell(
                        onTap: _pickFecha,
                        borderRadius: BorderRadius.circular(12),
                        child: InputDecorator(
                          decoration: const InputDecoration(labelText: 'Fecha límite', prefixIcon: Icon(Icons.event_outlined)),
                          child: Text(
                            _fechaLimite != null ? AppDateUtils.formatFecha(_fechaLimite) : 'Seleccionar fecha',
                            style: TextStyle(color: _fechaLimite != null ? null : AppColors.textTertiary),
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      TextFormField(
                        controller: _montoCtrl,
                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        decoration: const InputDecoration(labelText: 'Monto declarado (RD\$)', prefixIcon: Icon(Icons.attach_money_rounded)),
                      ),
                      const SizedBox(height: 16),
                      DropdownButtonFormField<String>(
                        initialValue: _estado,
                        decoration: const InputDecoration(labelText: 'Estado', prefixIcon: Icon(Icons.info_outline_rounded)),
                        items: FiscalCalendar.estadosDeclaracion.map((s) => DropdownMenuItem(
                          value: s,
                          child: Text(s[0].toUpperCase() + s.substring(1).replaceAll('_', ' ')),
                        )).toList(),
                        onChanged: (v) => setState(() => _estado = v ?? _estado),
                      ),
                      const SizedBox(height: 16),
                      TextFormField(
                        controller: _obsCtrl,
                        maxLines: 3,
                        decoration: const InputDecoration(labelText: 'Observaciones', prefixIcon: Icon(Icons.notes_rounded), alignLabelWithHint: true),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 24),

              ElevatedButton(
                onPressed: formState.isLoading ? null : _submit,
                child: formState.isLoading
                    ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : Text(_isEdit ? 'Actualizar declaración' : 'Registrar declaración'),
              ),
              const SizedBox(height: 40),
            ],
          ),
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  final String message;
  const _ErrorBanner({required this.message});

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(bottom: 16),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: AppColors.errorLight, borderRadius: BorderRadius.circular(10)),
        child: Text(message, style: const TextStyle(color: AppColors.error, fontSize: 13)),
      );
}

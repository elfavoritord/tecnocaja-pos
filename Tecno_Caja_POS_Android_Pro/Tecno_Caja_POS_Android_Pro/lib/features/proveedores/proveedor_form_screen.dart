import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/service_providers.dart';
import '../../core/utils/formatters.dart';
import '../../core/utils/validators.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/repositories/proveedor_repository.dart';
import '../../domain/entities/proveedor.dart';
import '../../widgets/loading_button.dart';

class ProveedorFormScreen extends ConsumerStatefulWidget {
  const ProveedorFormScreen({super.key, this.proveedor});

  final Proveedor? proveedor;

  @override
  ConsumerState<ProveedorFormScreen> createState() => _ProveedorFormScreenState();
}

class _ProveedorFormScreenState extends ConsumerState<ProveedorFormScreen> {
  final _formKey = GlobalKey<FormState>();
  late final _nombreCtrl = TextEditingController(text: widget.proveedor?.nombre);
  late final _empresaProveedoraCtrl = TextEditingController(text: widget.proveedor?.empresaProveedora);
  late final _telefonoCtrl = TextEditingController(text: widget.proveedor?.telefono);
  late final _emailCtrl = TextEditingController(text: widget.proveedor?.email);
  late final _rncCtrl = TextEditingController(text: widget.proveedor?.rnc);
  late final _contactoCtrl = TextEditingController(text: widget.proveedor?.contacto);
  late final _direccionCtrl = TextEditingController(text: widget.proveedor?.direccion);
  late final _diasVisitaCtrl = TextEditingController(text: widget.proveedor?.diasVisita);
  late final _terminosPagoCtrl = TextEditingController(text: widget.proveedor?.terminosPagoDias?.toString());
  bool _cargando = false;
  double? _cuentaPorPagar;

  bool get _esNuevo => widget.proveedor == null;

  @override
  void initState() {
    super.initState();
    if (!_esNuevo) _cargarCuentaPorPagar();
  }

  Future<void> _cargarCuentaPorPagar() async {
    final total = await ref.read(proveedorRepositoryProvider).cuentaPorPagar(widget.proveedor!.id);
    if (mounted) setState(() => _cuentaPorPagar = total);
  }

  @override
  void dispose() {
    _nombreCtrl.dispose();
    _empresaProveedoraCtrl.dispose();
    _telefonoCtrl.dispose();
    _emailCtrl.dispose();
    _rncCtrl.dispose();
    _contactoCtrl.dispose();
    _direccionCtrl.dispose();
    _diasVisitaCtrl.dispose();
    _terminosPagoCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    if (!_formKey.currentState!.validate()) return;
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;

    setState(() => _cargando = true);
    try {
      final repo = ref.read(proveedorRepositoryProvider);
      final terminosPago = int.tryParse(_terminosPagoCtrl.text.trim());

      if (_esNuevo) {
        final deviceId = await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
        await repo.crear(
          empresaId: empresaId,
          nombre: _nombreCtrl.text.trim(),
          empresaProveedora: _empresaProveedoraCtrl.text.trim().isEmpty ? null : _empresaProveedoraCtrl.text.trim(),
          telefono: _telefonoCtrl.text.trim().isEmpty ? null : _telefonoCtrl.text.trim(),
          email: _emailCtrl.text.trim().isEmpty ? null : _emailCtrl.text.trim(),
          rnc: _rncCtrl.text.trim().isEmpty ? null : _rncCtrl.text.trim(),
          contacto: _contactoCtrl.text.trim().isEmpty ? null : _contactoCtrl.text.trim(),
          direccion: _direccionCtrl.text.trim().isEmpty ? null : _direccionCtrl.text.trim(),
          diasVisita: _diasVisitaCtrl.text.trim().isEmpty ? null : _diasVisitaCtrl.text.trim(),
          terminosPagoDias: terminosPago,
          dispositivoId: deviceId,
        );
      } else {
        final actualizado = widget.proveedor!.copyWith(
          nombre: _nombreCtrl.text.trim(),
          empresaProveedora: _empresaProveedoraCtrl.text.trim(),
          telefono: _telefonoCtrl.text.trim(),
          email: _emailCtrl.text.trim(),
          rnc: _rncCtrl.text.trim(),
          contacto: _contactoCtrl.text.trim(),
          direccion: _direccionCtrl.text.trim(),
          diasVisita: _diasVisitaCtrl.text.trim(),
          terminosPagoDias: terminosPago,
        );
        await repo.actualizar(actualizado);
      }

      if (mounted) Navigator.of(context).pop(true);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _desactivar() async {
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Desactivar proveedor'),
        content: Text('¿Seguro que deseas desactivar a ${widget.proveedor!.nombre}?'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Desactivar')),
        ],
      ),
    );
    if (confirmado != true) return;
    await ref.read(proveedorRepositoryProvider).desactivar(widget.proveedor!.id);
    if (mounted) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_esNuevo ? 'Nuevo proveedor' : 'Editar proveedor'),
        actions: [
          if (!_esNuevo)
            PopupMenuButton<String>(
              onSelected: (v) {
                if (v == 'desactivar') _desactivar();
              },
              itemBuilder: (context) => const [
                PopupMenuItem(value: 'desactivar', child: Text('Desactivar proveedor')),
              ],
            ),
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
                if (_cuentaPorPagar != null && _cuentaPorPagar! > 0)
                  Card(
                    color: Theme.of(context).colorScheme.errorContainer,
                    child: ListTile(
                      leading: const Icon(Icons.receipt_long_outlined),
                      title: const Text('Cuenta por pagar'),
                      trailing: Text(Formatters.currency(_cuentaPorPagar!), style: const TextStyle(fontWeight: FontWeight.bold)),
                    ),
                  ),
                if (_cuentaPorPagar != null && _cuentaPorPagar! > 0) const SizedBox(height: 12),
                TextFormField(
                  controller: _nombreCtrl,
                  textCapitalization: TextCapitalization.words,
                  decoration: const InputDecoration(labelText: 'Nombre'),
                  validator: (v) => Validators.required(v, label: 'El nombre'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _empresaProveedoraCtrl,
                  decoration: const InputDecoration(labelText: 'Empresa (opcional)'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _contactoCtrl,
                  decoration: const InputDecoration(labelText: 'Persona de contacto (opcional)'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _telefonoCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'Teléfono'),
                  validator: (v) => Validators.phoneRD(v, optional: true),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _emailCtrl,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(labelText: 'Correo (opcional)'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _direccionCtrl,
                  decoration: const InputDecoration(labelText: 'Dirección (opcional)'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _rncCtrl,
                  decoration: const InputDecoration(labelText: 'RNC (opcional)'),
                  validator: (v) => Validators.cedulaORnc(v, optional: true),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _diasVisitaCtrl,
                  decoration: const InputDecoration(labelText: 'Días de visita (opcional)', hintText: 'Ej. Lunes y jueves'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _terminosPagoCtrl,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Términos de pago (días, opcional)'),
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

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/service_providers.dart';
import '../../core/utils/validators.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/repositories/cliente_repository.dart';
import '../../domain/entities/cliente.dart';
import '../../widgets/loading_button.dart';

class ClienteFormScreen extends ConsumerStatefulWidget {
  const ClienteFormScreen({super.key, this.cliente});

  final Cliente? cliente;

  @override
  ConsumerState<ClienteFormScreen> createState() => _ClienteFormScreenState();
}

class _ClienteFormScreenState extends ConsumerState<ClienteFormScreen> {
  final _formKey = GlobalKey<FormState>();
  late final _nombreCtrl = TextEditingController(text: widget.cliente?.nombre);
  late final _telefonoCtrl = TextEditingController(text: widget.cliente?.telefono);
  late final _whatsappCtrl = TextEditingController(text: widget.cliente?.whatsapp);
  late final _emailCtrl = TextEditingController(text: widget.cliente?.email);
  late final _direccionCtrl = TextEditingController(text: widget.cliente?.direccion);
  late final _cedulaRncCtrl = TextEditingController(text: widget.cliente?.cedulaRnc);
  late final _limiteCreditoCtrl = TextEditingController(text: widget.cliente?.limiteCredito.toStringAsFixed(2) ?? '0');
  late final _notasCtrl = TextEditingController(text: widget.cliente?.notas);
  bool _cargando = false;

  bool get _esNuevo => widget.cliente == null;

  @override
  void dispose() {
    _nombreCtrl.dispose();
    _telefonoCtrl.dispose();
    _whatsappCtrl.dispose();
    _emailCtrl.dispose();
    _direccionCtrl.dispose();
    _cedulaRncCtrl.dispose();
    _limiteCreditoCtrl.dispose();
    _notasCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    if (!_formKey.currentState!.validate()) return;
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;

    setState(() => _cargando = true);
    try {
      final repo = ref.read(clienteRepositoryProvider);
      final limiteCredito = double.tryParse(_limiteCreditoCtrl.text.replaceAll(',', '.')) ?? 0;

      if (_esNuevo) {
        final deviceId = await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
        await repo.crear(
          empresaId: empresaId,
          nombre: _nombreCtrl.text.trim(),
          telefono: _telefonoCtrl.text.trim().isEmpty ? null : _telefonoCtrl.text.trim(),
          whatsapp: _whatsappCtrl.text.trim().isEmpty ? null : _whatsappCtrl.text.trim(),
          email: _emailCtrl.text.trim().isEmpty ? null : _emailCtrl.text.trim(),
          direccion: _direccionCtrl.text.trim().isEmpty ? null : _direccionCtrl.text.trim(),
          cedulaRnc: _cedulaRncCtrl.text.trim().isEmpty ? null : _cedulaRncCtrl.text.trim(),
          limiteCredito: limiteCredito,
          notas: _notasCtrl.text.trim().isEmpty ? null : _notasCtrl.text.trim(),
          dispositivoId: deviceId,
        );
      } else {
        final actualizado = widget.cliente!.copyWith(
          nombre: _nombreCtrl.text.trim(),
          telefono: _telefonoCtrl.text.trim(),
          whatsapp: _whatsappCtrl.text.trim(),
          email: _emailCtrl.text.trim(),
          direccion: _direccionCtrl.text.trim(),
          cedulaRnc: _cedulaRncCtrl.text.trim(),
          limiteCredito: limiteCredito,
          notas: _notasCtrl.text.trim(),
        );
        await repo.actualizar(actualizado);
      }

      if (mounted) Navigator.of(context).pop(true);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_esNuevo ? 'Nuevo cliente' : 'Editar cliente')),
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
                  textCapitalization: TextCapitalization.words,
                  decoration: const InputDecoration(labelText: 'Nombre'),
                  validator: (v) => Validators.required(v, label: 'El nombre'),
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
                  controller: _whatsappCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'WhatsApp (opcional)'),
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
                  controller: _cedulaRncCtrl,
                  decoration: const InputDecoration(labelText: 'Cédula o RNC (opcional)'),
                  validator: (v) => Validators.cedulaORnc(v, optional: true),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _limiteCreditoCtrl,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(labelText: 'Límite de crédito', prefixText: 'RD\$ '),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _notasCtrl,
                  decoration: const InputDecoration(labelText: 'Notas (opcional)'),
                  maxLines: 3,
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

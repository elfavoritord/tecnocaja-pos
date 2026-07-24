import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../core/utils/id_generator.dart';
import '../../core/providers/service_providers.dart';
import '../../data/repositories/cliente_repository.dart';
import '../../domain/entities/cliente.dart';
import 'cliente_form_screen.dart';

class ClienteDetalleScreen extends ConsumerStatefulWidget {
  const ClienteDetalleScreen({super.key, required this.cliente});

  final Cliente cliente;

  @override
  ConsumerState<ClienteDetalleScreen> createState() => _ClienteDetalleScreenState();
}

class _ClienteDetalleScreenState extends ConsumerState<ClienteDetalleScreen> {
  late Cliente _cliente = widget.cliente;
  List<Map<String, Object?>> _pagos = [];
  bool _cargandoPagos = true;

  @override
  void initState() {
    super.initState();
    _cargarPagos();
  }

  Future<void> _cargarPagos() async {
    setState(() => _cargandoPagos = true);
    final pagos = await ref.read(clienteRepositoryProvider).historialPagos(_cliente.id);
    if (mounted) setState(() { _pagos = pagos; _cargandoPagos = false; });
  }

  Future<void> _editar() async {
    final actualizado = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (context) => ClienteFormScreen(cliente: _cliente)),
    );
    if (actualizado == true) {
      final fresco = await ref.read(clienteRepositoryProvider).porId(_cliente.id);
      if (fresco != null && mounted) setState(() => _cliente = fresco);
    }
  }

  Future<void> _desactivar() async {
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Desactivar cliente'),
        content: Text('¿Seguro que deseas desactivar a ${_cliente.nombre}? Podrás reactivarlo desde el equipo Windows si hace falta.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Desactivar')),
        ],
      ),
    );
    if (confirmado != true) return;
    await ref.read(clienteRepositoryProvider).desactivar(_cliente.id);
    if (mounted) Navigator.of(context).pop();
  }

  Future<void> _registrarAbono() async {
    final resultado = await showDialog<(double, String, String?)>(
      context: context,
      builder: (context) => _DialogoAbono(balanceActual: _cliente.balance),
    );
    if (resultado == null) return;
    final (monto, metodoPago, nota) = resultado;

    final deviceId = await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
    await ref.read(clienteRepositoryProvider).registrarAbono(
      clienteId: _cliente.id,
      idPago: IdGenerator.newId(),
      monto: monto,
      metodoPago: metodoPago,
      nota: nota,
      dispositivoId: deviceId,
    );
    final fresco = await ref.read(clienteRepositoryProvider).porId(_cliente.id);
    if (fresco != null && mounted) setState(() => _cliente = fresco);
    await _cargarPagos();
  }

  @override
  Widget build(BuildContext context) {
    final tieneDeuda = _cliente.balance > 0;

    return Scaffold(
      appBar: AppBar(
        title: Text(_cliente.nombre),
        actions: [
          IconButton(icon: const Icon(Icons.edit_outlined), tooltip: 'Editar', onPressed: _editar),
          PopupMenuButton<String>(
            onSelected: (v) {
              if (v == 'desactivar') _desactivar();
            },
            itemBuilder: (context) => const [
              PopupMenuItem(value: 'desactivar', child: Text('Desactivar cliente')),
            ],
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _registrarAbono,
        icon: const Icon(Icons.payments_outlined),
        label: const Text('Registrar abono'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            color: (tieneDeuda ? AppColors.danger : AppColors.success).withValues(alpha: 0.08),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Balance pendiente', style: Theme.of(context).textTheme.bodySmall),
                        Text(
                          Formatters.currency(_cliente.balance),
                          style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                                color: tieneDeuda ? AppColors.danger : AppColors.success,
                                fontWeight: FontWeight.bold,
                              ),
                        ),
                      ],
                    ),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Crédito disponible', style: Theme.of(context).textTheme.bodySmall),
                        Text(
                          Formatters.currency(_cliente.creditoDisponible),
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          Card(
            child: Column(
              children: [
                if (_cliente.telefono != null && _cliente.telefono!.isNotEmpty)
                  ListTile(leading: const Icon(Icons.phone_outlined), title: Text(_cliente.telefono!)),
                if (_cliente.whatsapp != null && _cliente.whatsapp!.isNotEmpty)
                  ListTile(leading: const Icon(Icons.chat_outlined), title: Text(_cliente.whatsapp!)),
                if (_cliente.email != null && _cliente.email!.isNotEmpty)
                  ListTile(leading: const Icon(Icons.email_outlined), title: Text(_cliente.email!)),
                if (_cliente.direccion != null && _cliente.direccion!.isNotEmpty)
                  ListTile(leading: const Icon(Icons.location_on_outlined), title: Text(_cliente.direccion!)),
                if (_cliente.cedulaRnc != null && _cliente.cedulaRnc!.isNotEmpty)
                  ListTile(leading: const Icon(Icons.badge_outlined), title: Text(_cliente.cedulaRnc!)),
                ListTile(
                  leading: const Icon(Icons.credit_card_outlined),
                  title: Text('Límite de crédito: ${Formatters.currency(_cliente.limiteCredito)}'),
                ),
                if (_cliente.notas != null && _cliente.notas!.isNotEmpty)
                  ListTile(leading: const Icon(Icons.notes_outlined), title: Text(_cliente.notas!)),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text('Historial de abonos', style: Theme.of(context).textTheme.titleMedium),
          ),
          const SizedBox(height: 8),
          if (_cargandoPagos)
            const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()))
          else if (_pagos.isEmpty)
            const Padding(padding: EdgeInsets.all(16), child: Text('Sin abonos registrados todavía.'))
          else
            Card(
              child: Column(
                children: [
                  for (final pago in _pagos)
                    ListTile(
                      leading: const Icon(Icons.arrow_downward, color: AppColors.success),
                      title: Text(Formatters.currency((pago['monto'] as num).toDouble())),
                      subtitle: Text('${pago['metodo_pago']} · ${Formatters.dateTime(DateTime.parse(pago['fecha_pago'] as String))}'),
                      trailing: (pago['nota'] as String?)?.isNotEmpty == true
                          ? Tooltip(message: pago['nota'] as String, child: const Icon(Icons.notes, size: 18))
                          : null,
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _DialogoAbono extends StatefulWidget {
  const _DialogoAbono({required this.balanceActual});

  final double balanceActual;

  @override
  State<_DialogoAbono> createState() => _DialogoAbonoState();
}

class _DialogoAbonoState extends State<_DialogoAbono> {
  final _formKey = GlobalKey<FormState>();
  final _montoCtrl = TextEditingController();
  final _notaCtrl = TextEditingController();
  String _metodoPago = 'efectivo';

  @override
  void dispose() {
    _montoCtrl.dispose();
    _notaCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Registrar abono'),
      content: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Balance actual: ${Formatters.currency(widget.balanceActual)}', style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 12),
            TextFormField(
              controller: _montoCtrl,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Monto', prefixText: 'RD\$ '),
              validator: (v) {
                final parsed = double.tryParse((v ?? '').replaceAll(',', '.'));
                if (parsed == null || parsed <= 0) return 'Ingresa un monto válido.';
                return null;
              },
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _metodoPago,
              decoration: const InputDecoration(labelText: 'Método de pago'),
              items: const [
                DropdownMenuItem(value: 'efectivo', child: Text('Efectivo')),
                DropdownMenuItem(value: 'tarjeta', child: Text('Tarjeta')),
                DropdownMenuItem(value: 'transferencia', child: Text('Transferencia')),
              ],
              onChanged: (v) => setState(() => _metodoPago = v ?? 'efectivo'),
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _notaCtrl,
              decoration: const InputDecoration(labelText: 'Nota (opcional)'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancelar')),
        FilledButton(
          onPressed: () {
            if (!_formKey.currentState!.validate()) return;
            final monto = double.parse(_montoCtrl.text.replaceAll(',', '.'));
            final nota = _notaCtrl.text.trim().isEmpty ? null : _notaCtrl.text.trim();
            Navigator.of(context).pop((monto, _metodoPago, nota));
          },
          child: const Text('Guardar'),
        ),
      ],
    );
  }
}

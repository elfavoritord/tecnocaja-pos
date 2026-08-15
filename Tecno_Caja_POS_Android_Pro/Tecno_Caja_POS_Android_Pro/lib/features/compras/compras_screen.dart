import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/service_providers.dart';
import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/compra_repository.dart';
import '../../data/repositories/proveedor_repository.dart';
import '../../domain/entities/proveedor.dart';

class ComprasScreen extends ConsumerStatefulWidget {
  const ComprasScreen({super.key});

  @override
  ConsumerState<ComprasScreen> createState() => _ComprasScreenState();
}

class _ComprasScreenState extends ConsumerState<ComprasScreen> {
  List<CompraResumen> _compras = [];
  bool _cargando = true;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;
    setState(() => _cargando = true);
    final compras =
        await ref.read(compraRepositoryProvider).deEmpresa(empresaId);
    if (mounted) {
      setState(() {
        _compras = compras;
        _cargando = false;
      });
    }
  }

  Future<void> _registrarFactura() async {
    final guardado = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _FacturaProveedorSheet(),
    );
    if (guardado == true) await _cargar();
  }

  Future<void> _abonar(CompraResumen compra) async {
    final guardado = await showDialog<bool>(
      context: context,
      builder: (_) => _AbonoCompraDialog(compra: compra),
    );
    if (guardado == true) await _cargar();
  }

  @override
  Widget build(BuildContext context) {
    final totalPendiente =
        _compras.fold<double>(0, (sum, c) => sum + c.montoPendiente);
    final facturasPendientes =
        _compras.where((c) => c.montoPendiente > 0).length;

    return Scaffold(
      appBar: AppBar(title: const Text('Compras y CxP')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _registrarFactura,
        icon: const Icon(Icons.add_shopping_cart),
        label: const Text('Factura'),
      ),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _cargando
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: _ResumenCard(
                          title: 'Pendiente',
                          value: Formatters.currency(totalPendiente),
                          icon: Icons.account_balance_wallet_outlined,
                          color: AppColors.warning,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: _ResumenCard(
                          title: 'Facturas',
                          value: '$facturasPendientes',
                          icon: Icons.receipt_long_outlined,
                          color: AppColors.primary,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  if (_compras.isEmpty)
                    const Padding(
                      padding: EdgeInsets.only(top: 72),
                      child: Center(
                        child: Text('No hay compras registradas todavía'),
                      ),
                    )
                  else
                    for (final compra in _compras) ...[
                      _CompraTile(
                        compra: compra,
                        onAbonar: compra.montoPendiente <= 0
                            ? null
                            : () => _abonar(compra),
                      ),
                      const SizedBox(height: 8),
                    ],
                ],
              ),
      ),
    );
  }
}

class _ResumenCard extends StatelessWidget {
  const _ResumenCard({
    required this.title,
    required this.value,
    required this.icon,
    required this.color,
  });

  final String title;
  final String value;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: color),
            const SizedBox(height: 8),
            Text(title, style: Theme.of(context).textTheme.bodySmall),
            Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context)
                  .textTheme
                  .titleMedium
                  ?.copyWith(fontWeight: FontWeight.w700),
            ),
          ],
        ),
      ),
    );
  }
}

class _CompraTile extends StatelessWidget {
  const _CompraTile({required this.compra, required this.onAbonar});

  final CompraResumen compra;
  final VoidCallback? onAbonar;

  @override
  Widget build(BuildContext context) {
    final pagada = compra.montoPendiente <= 0;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                CircleAvatar(
                  backgroundColor:
                      (pagada ? AppColors.success : AppColors.warning)
                          .withValues(alpha: 0.14),
                  child: Icon(
                    pagada
                        ? Icons.check_circle_outline
                        : Icons.schedule_outlined,
                    color: pagada ? AppColors.success : AppColors.warning,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        compra.numeroFactura?.isNotEmpty == true
                            ? compra.numeroFactura!
                            : 'Factura sin número',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      Text(
                        compra.proveedorNombre,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
                Text(
                  Formatters.currency(compra.montoTotal),
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Emitida ${Formatters.date(compra.fechaEmision)}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                Text(
                  pagada
                      ? 'Pagada'
                      : 'Debe ${Formatters.currency(compra.montoPendiente)}',
                  style: TextStyle(
                    color: pagada ? AppColors.success : AppColors.warning,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
            if (onAbonar != null) ...[
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: OutlinedButton.icon(
                  onPressed: onAbonar,
                  icon: const Icon(Icons.payments_outlined),
                  label: const Text('Abonar'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _FacturaProveedorSheet extends ConsumerStatefulWidget {
  const _FacturaProveedorSheet();

  @override
  ConsumerState<_FacturaProveedorSheet> createState() =>
      _FacturaProveedorSheetState();
}

class _FacturaProveedorSheetState
    extends ConsumerState<_FacturaProveedorSheet> {
  final _numeroCtrl = TextEditingController();
  final _totalCtrl = TextEditingController();
  final _pagadoCtrl = TextEditingController(text: '0');
  Proveedor? _proveedor;
  bool _guardando = false;

  @override
  void dispose() {
    _numeroCtrl.dispose();
    _totalCtrl.dispose();
    _pagadoCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    final auth = ref.read(authControllerProvider);
    final usuario = auth.usuario;
    final total = double.tryParse(_totalCtrl.text.replaceAll(',', '.')) ?? 0;
    final pagado = double.tryParse(_pagadoCtrl.text.replaceAll(',', '.')) ?? 0;
    if (auth.empresaId == null || usuario == null || _proveedor == null) return;
    if (total <= 0 || pagado > total) return;

    setState(() => _guardando = true);
    try {
      final sucursal = await ref.read(sucursalActivaProvider.future);
      final caja = await ref.read(cajaActivaProvider.future);
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      await ref.read(compraRepositoryProvider).crearFactura(
            empresaId: auth.empresaId!,
            proveedorId: _proveedor!.id,
            fechaEmision: DateTime.now(),
            montoTotal: total,
            montoPagado: pagado,
            usuarioId: usuario.id,
            sucursalId: sucursal?.id,
            cajaId: caja?.id,
            numeroFactura: _numeroCtrl.text.trim().isEmpty
                ? null
                : _numeroCtrl.text.trim(),
            dispositivoId: deviceId,
          );
      if (mounted) Navigator.of(context).pop(true);
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final empresaId = ref.watch(authControllerProvider).empresaId;
    final proveedoresFuture = empresaId == null
        ? Future<List<Proveedor>>.value(const [])
        : ref.watch(proveedorRepositoryProvider).deEmpresa(empresaId);

    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: FutureBuilder<List<Proveedor>>(
        future: proveedoresFuture,
        builder: (context, snapshot) {
          final proveedores = snapshot.data ?? const <Proveedor>[];
          return SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Registrar factura',
                    style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 16),
                DropdownButtonFormField<Proveedor>(
                  initialValue: _proveedor,
                  decoration: const InputDecoration(labelText: 'Proveedor'),
                  items: [
                    for (final proveedor in proveedores)
                      DropdownMenuItem(
                        value: proveedor,
                        child: Text(proveedor.nombre),
                      ),
                  ],
                  onChanged: (value) => setState(() => _proveedor = value),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _numeroCtrl,
                  decoration:
                      const InputDecoration(labelText: 'Número de factura'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _totalCtrl,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(
                    labelText: 'Monto total',
                    prefixText: 'RD\$ ',
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _pagadoCtrl,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(
                    labelText: 'Abono inicial',
                    prefixText: 'RD\$ ',
                  ),
                ),
                const SizedBox(height: 20),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: _guardando ? null : _guardar,
                    icon: _guardando
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.save_outlined),
                    label: Text(_guardando ? 'Guardando...' : 'Guardar'),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _AbonoCompraDialog extends ConsumerStatefulWidget {
  const _AbonoCompraDialog({required this.compra});

  final CompraResumen compra;

  @override
  ConsumerState<_AbonoCompraDialog> createState() => _AbonoCompraDialogState();
}

class _AbonoCompraDialogState extends ConsumerState<_AbonoCompraDialog> {
  late final TextEditingController _montoCtrl;
  String _metodoPago = 'efectivo';
  bool _guardando = false;

  @override
  void initState() {
    super.initState();
    _montoCtrl = TextEditingController(
      text: widget.compra.montoPendiente.toStringAsFixed(2),
    );
  }

  @override
  void dispose() {
    _montoCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    final usuario = ref.read(authControllerProvider).usuario;
    final monto = double.tryParse(_montoCtrl.text.replaceAll(',', '.')) ?? 0;
    if (usuario == null || monto <= 0) return;
    setState(() => _guardando = true);
    try {
      final sucursal = await ref.read(sucursalActivaProvider.future);
      final caja = await ref.read(cajaActivaProvider.future);
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      await ref.read(compraRepositoryProvider).abonar(
            compra: widget.compra,
            monto: monto,
            metodoPago: _metodoPago,
            usuarioId: usuario.id,
            sucursalId: sucursal?.id,
            cajaId: caja?.id,
            dispositivoId: deviceId,
          );
      if (mounted) Navigator.of(context).pop(true);
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Abonar factura'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(widget.compra.proveedorNombre),
          const SizedBox(height: 12),
          TextField(
            controller: _montoCtrl,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(
              labelText: 'Monto',
              prefixText: 'RD\$ ',
            ),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _metodoPago,
            decoration: const InputDecoration(labelText: 'Método'),
            items: const [
              DropdownMenuItem(value: 'efectivo', child: Text('Efectivo')),
              DropdownMenuItem(value: 'tarjeta', child: Text('Tarjeta')),
              DropdownMenuItem(
                  value: 'transferencia', child: Text('Transferencia')),
            ],
            onChanged: (value) {
              if (value != null) setState(() => _metodoPago = value);
            },
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: _guardando ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancelar'),
        ),
        FilledButton(
          onPressed: _guardando ? null : _guardar,
          child: Text(_guardando ? 'Guardando...' : 'Abonar'),
        ),
      ],
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/service_providers.dart';
import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/delivery_repository.dart';

class DeliveryScreen extends ConsumerStatefulWidget {
  const DeliveryScreen({super.key});

  @override
  ConsumerState<DeliveryScreen> createState() => _DeliveryScreenState();
}

class _DeliveryScreenState extends ConsumerState<DeliveryScreen> {
  String _estado = 'todos';
  List<DeliveryOrden> _ordenes = [];
  bool _cargando = true;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    final auth = ref.read(authControllerProvider);
    if (auth.empresaId == null) return;
    setState(() => _cargando = true);
    final ordenes = await ref.read(deliveryRepositoryProvider).deEmpresa(
          auth.empresaId!,
          estado: _estado,
          repartidorId:
              auth.usuario?.rol.name == 'delivery' ? auth.usuario?.id : null,
        );
    if (mounted) {
      setState(() {
        _ordenes = ordenes;
        _cargando = false;
      });
    }
  }

  Future<void> _crear() async {
    final creada = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _NuevaOrdenDeliverySheet(),
    );
    if (creada == true) await _cargar();
  }

  Future<void> _estadoOrden(DeliveryOrden orden, String estado) async {
    double? recibido;
    if (estado == 'entregado') {
      recibido = await _pedirMontoRecibido(orden);
      if (recibido == null) return;
    }
    final user = ref.read(authControllerProvider).usuario;
    await ref.read(deliveryRepositoryProvider).cambiarEstado(
          orden,
          estado,
          repartidorId: estado == 'en_camino' ? user?.id : null,
          montoRecibido: recibido,
        );
    await _cargar();
  }

  Future<double?> _pedirMontoRecibido(DeliveryOrden orden) async {
    final ctrl =
        TextEditingController(text: orden.montoCobrar.toStringAsFixed(2));
    return showDialog<double>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Confirmar entrega'),
        content: TextField(
          controller: ctrl,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: const InputDecoration(
            labelText: 'Monto recibido',
            prefixText: 'RD\$ ',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context)
                .pop(double.tryParse(ctrl.text.replaceAll(',', '.'))),
            child: const Text('Entregado'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Delivery')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _crear,
        icon: const Icon(Icons.delivery_dining),
        label: const Text('Orden'),
      ),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
          children: [
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'todos', label: Text('Todos')),
                ButtonSegment(value: 'pendiente', label: Text('Pendientes')),
                ButtonSegment(value: 'en_camino', label: Text('Ruta')),
                ButtonSegment(value: 'entregado', label: Text('Listos')),
              ],
              selected: {_estado},
              onSelectionChanged: (value) {
                setState(() => _estado = value.first);
                _cargar();
              },
            ),
            const SizedBox(height: 16),
            if (_cargando)
              const Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_ordenes.isEmpty)
              const Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: Text('No hay órdenes de delivery')),
              )
            else
              for (final orden in _ordenes) ...[
                _DeliveryCard(
                  orden: orden,
                  onEstado: (estado) => _estadoOrden(orden, estado),
                ),
                const SizedBox(height: 8),
              ],
          ],
        ),
      ),
    );
  }
}

class _DeliveryCard extends StatelessWidget {
  const _DeliveryCard({required this.orden, required this.onEstado});

  final DeliveryOrden orden;
  final ValueChanged<String> onEstado;

  @override
  Widget build(BuildContext context) {
    final color = switch (orden.estado) {
      'entregado' => AppColors.success,
      'cancelado' => AppColors.danger,
      'en_camino' => AppColors.info,
      _ => AppColors.warning,
    };
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
                  backgroundColor: color.withValues(alpha: 0.14),
                  child: Icon(Icons.delivery_dining, color: color),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(orden.factura,
                          style: Theme.of(context).textTheme.titleMedium),
                      Text(orden.clienteNombre),
                    ],
                  ),
                ),
                Text(
                  Formatters.currency(orden.montoCobrar),
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ],
            ),
            if (orden.telefono?.isNotEmpty == true ||
                orden.direccion?.isNotEmpty == true) ...[
              const SizedBox(height: 8),
              Text([orden.telefono, orden.direccion]
                  .where((e) => e?.isNotEmpty == true)
                  .join(' · ')),
            ],
            const SizedBox(height: 8),
            Text('Estado: ${orden.estado}'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: [
                if (orden.estado == 'pendiente')
                  OutlinedButton.icon(
                    onPressed: () => onEstado('en_camino'),
                    icon: const Icon(Icons.route),
                    label: const Text('En camino'),
                  ),
                if (orden.estado != 'entregado' && orden.estado != 'cancelado')
                  FilledButton.icon(
                    onPressed: () => onEstado('entregado'),
                    icon: const Icon(Icons.check),
                    label: const Text('Entregado'),
                  ),
                if (orden.estado != 'entregado' && orden.estado != 'cancelado')
                  TextButton.icon(
                    onPressed: () => onEstado('cancelado'),
                    icon: const Icon(Icons.cancel_outlined),
                    label: const Text('Cancelar'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _NuevaOrdenDeliverySheet extends ConsumerStatefulWidget {
  const _NuevaOrdenDeliverySheet();

  @override
  ConsumerState<_NuevaOrdenDeliverySheet> createState() =>
      _NuevaOrdenDeliverySheetState();
}

class _NuevaOrdenDeliverySheetState
    extends ConsumerState<_NuevaOrdenDeliverySheet> {
  final _nombreCtrl = TextEditingController();
  final _telefonoCtrl = TextEditingController();
  final _direccionCtrl = TextEditingController();
  final _referenciaCtrl = TextEditingController();
  Map<String, Object?>? _venta;
  bool _guardando = false;

  @override
  void dispose() {
    _nombreCtrl.dispose();
    _telefonoCtrl.dispose();
    _direccionCtrl.dispose();
    _referenciaCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    final auth = ref.read(authControllerProvider);
    final usuario = auth.usuario;
    final venta = _venta;
    if (auth.empresaId == null || usuario == null || venta == null) return;
    setState(() => _guardando = true);
    try {
      final sucursal = await ref.read(sucursalActivaProvider.future);
      final caja = await ref.read(cajaActivaProvider.future);
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      await ref.read(deliveryRepositoryProvider).crear(
            empresaId: auth.empresaId!,
            ventaId: venta['id'].toString(),
            montoCobrar: (venta['total'] as num?)?.toDouble() ?? 0,
            usuarioId: usuario.id,
            sucursalId: sucursal?.id,
            cajaId: caja?.id,
            clienteNombre: _nombreCtrl.text.trim().isEmpty
                ? venta['cliente_nombre']?.toString()
                : _nombreCtrl.text.trim(),
            telefono: _telefonoCtrl.text.trim(),
            direccion: _direccionCtrl.text.trim(),
            referencia: _referenciaCtrl.text.trim(),
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
    final ventasFuture = empresaId == null
        ? Future<List<Map<String, Object?>>>.value(const [])
        : ref.watch(deliveryRepositoryProvider).ventasElegibles(empresaId);
    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: FutureBuilder<List<Map<String, Object?>>>(
        future: ventasFuture,
        builder: (context, snapshot) {
          final ventas = snapshot.data ?? const <Map<String, Object?>>[];
          return SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Nueva orden delivery',
                    style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 16),
                DropdownButtonFormField<Map<String, Object?>>(
                  initialValue: _venta,
                  decoration: const InputDecoration(labelText: 'Venta'),
                  items: [
                    for (final venta in ventas)
                      DropdownMenuItem(
                        value: venta,
                        child: Text(
                          '${venta['numero_factura'] ?? venta['id']} · '
                          '${Formatters.currency((venta['total'] as num?)?.toDouble() ?? 0)}',
                        ),
                      ),
                  ],
                  onChanged: (value) {
                    setState(() {
                      _venta = value;
                      _nombreCtrl.text =
                          value?['cliente_nombre']?.toString() ?? '';
                    });
                  },
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _nombreCtrl,
                  decoration: const InputDecoration(labelText: 'Cliente'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _telefonoCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'Teléfono'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _direccionCtrl,
                  decoration: const InputDecoration(labelText: 'Dirección'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _referenciaCtrl,
                  decoration: const InputDecoration(labelText: 'Referencia'),
                ),
                const SizedBox(height: 16),
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

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/service_providers.dart';
import '../../core/theme/app_colors.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/producto_repository.dart';
import '../../data/repositories/promocion_repository.dart';
import '../../domain/entities/producto.dart';

class PromocionesScreen extends ConsumerStatefulWidget {
  const PromocionesScreen({super.key});

  @override
  ConsumerState<PromocionesScreen> createState() => _PromocionesScreenState();
}

class _PromocionesScreenState extends ConsumerState<PromocionesScreen> {
  List<PromocionResumen> _promociones = [];
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
    final promociones =
        await ref.read(promocionRepositoryProvider).deEmpresa(empresaId);
    if (mounted) {
      setState(() {
        _promociones = promociones;
        _cargando = false;
      });
    }
  }

  Future<void> _nueva() async {
    final guardada = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _PromocionFormSheet(),
    );
    if (guardada == true) await _cargar();
  }

  Future<void> _toggle(PromocionResumen promocion) async {
    await ref
        .read(promocionRepositoryProvider)
        .cambiarActiva(promocion, !promocion.activa);
    await _cargar();
  }

  Future<void> _eliminar(PromocionResumen promocion) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Eliminar promoción'),
        content: Text('Se eliminará "${promocion.nombre}".'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Eliminar'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await ref.read(promocionRepositoryProvider).eliminar(promocion);
    await _cargar();
  }

  @override
  Widget build(BuildContext context) {
    final activas = _promociones.where((p) => p.activa).length;
    return Scaffold(
      appBar: AppBar(title: const Text('Promociones y combos')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _nueva,
        icon: const Icon(Icons.local_offer),
        label: const Text('Promoción'),
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
                        child: _MetricCard(
                          label: 'Activas',
                          value: '$activas',
                          icon: Icons.play_circle_outline,
                          color: AppColors.success,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: _MetricCard(
                          label: 'Total',
                          value: '${_promociones.length}',
                          icon: Icons.local_offer_outlined,
                          color: AppColors.info,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  if (_promociones.isEmpty)
                    const Padding(
                      padding: EdgeInsets.only(top: 72),
                      child: Center(child: Text('No hay promociones todavía')),
                    )
                  else
                    for (final promo in _promociones) ...[
                      Card(
                        margin: EdgeInsets.zero,
                        child: ListTile(
                          leading: CircleAvatar(
                            backgroundColor:
                                (promo.activa ? AppColors.success : Colors.grey)
                                    .withValues(alpha: 0.14),
                            child: Icon(
                              promo.activa
                                  ? Icons.local_offer
                                  : Icons.pause_circle_outline,
                              color: promo.activa
                                  ? AppColors.success
                                  : Colors.grey,
                            ),
                          ),
                          title: Text(promo.nombre),
                          subtitle: Text([
                            _tipoLabel(promo),
                            if (promo.productos.isNotEmpty)
                              promo.productos.take(2).join(', '),
                          ].join(' · ')),
                          trailing: PopupMenuButton<String>(
                            onSelected: (value) {
                              if (value == 'toggle') _toggle(promo);
                              if (value == 'delete') _eliminar(promo);
                            },
                            itemBuilder: (_) => [
                              PopupMenuItem(
                                value: 'toggle',
                                child:
                                    Text(promo.activa ? 'Pausar' : 'Activar'),
                              ),
                              const PopupMenuItem(
                                value: 'delete',
                                child: Text('Eliminar'),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                    ],
                ],
              ),
      ),
    );
  }

  String _tipoLabel(PromocionResumen promo) {
    final value = promo.valorDescuento ?? 0;
    return promo.tipo == 'monto'
        ? 'RD\$ ${value.toStringAsFixed(2)} de descuento'
        : '${value.toStringAsFixed(2)}% de descuento';
  }
}

class _PromocionFormSheet extends ConsumerStatefulWidget {
  const _PromocionFormSheet();

  @override
  ConsumerState<_PromocionFormSheet> createState() =>
      _PromocionFormSheetState();
}

class _PromocionFormSheetState extends ConsumerState<_PromocionFormSheet> {
  final _nombreCtrl = TextEditingController();
  final _valorCtrl = TextEditingController();
  final Set<String> _productos = {};
  String _tipo = 'porcentaje';
  bool _guardando = false;

  @override
  void dispose() {
    _nombreCtrl.dispose();
    _valorCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    final auth = ref.read(authControllerProvider);
    final usuario = auth.usuario;
    final nombre = _nombreCtrl.text.trim();
    final valor = double.tryParse(_valorCtrl.text.replaceAll(',', '.')) ?? 0;
    if (auth.empresaId == null ||
        usuario == null ||
        nombre.isEmpty ||
        valor <= 0 ||
        _productos.isEmpty) {
      return;
    }
    setState(() => _guardando = true);
    try {
      final sucursal = await ref.read(sucursalActivaProvider.future);
      final caja = await ref.read(cajaActivaProvider.future);
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      await ref.read(promocionRepositoryProvider).crear(
            empresaId: auth.empresaId!,
            usuarioId: usuario.id,
            nombre: nombre,
            tipo: _tipo,
            valorDescuento: valor,
            productoIds: _productos.toList(),
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
    final empresaId = ref.watch(authControllerProvider).empresaId;
    final productosFuture = empresaId == null
        ? Future<List<Producto>>.value(const [])
        : ref.watch(productoRepositoryProvider).deEmpresa(empresaId);

    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: FutureBuilder<List<Producto>>(
        future: productosFuture,
        builder: (context, snapshot) {
          final productos = snapshot.data ?? const <Producto>[];
          return SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Nueva promoción',
                    style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 16),
                TextField(
                  controller: _nombreCtrl,
                  decoration: const InputDecoration(labelText: 'Nombre'),
                ),
                const SizedBox(height: 12),
                SegmentedButton<String>(
                  segments: const [
                    ButtonSegment(
                      value: 'porcentaje',
                      label: Text('%'),
                      icon: Icon(Icons.percent),
                    ),
                    ButtonSegment(
                      value: 'monto',
                      label: Text('Monto'),
                      icon: Icon(Icons.payments_outlined),
                    ),
                  ],
                  selected: {_tipo},
                  onSelectionChanged: (value) =>
                      setState(() => _tipo = value.first),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _valorCtrl,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  decoration: InputDecoration(
                    labelText:
                        _tipo == 'monto' ? 'Monto descuento' : 'Porcentaje',
                    prefixText: _tipo == 'monto' ? 'RD\$ ' : null,
                    suffixText: _tipo == 'porcentaje' ? '%' : null,
                  ),
                ),
                const SizedBox(height: 16),
                Text('Productos',
                    style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 260),
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: productos.length,
                    itemBuilder: (context, index) {
                      final producto = productos[index];
                      return CheckboxListTile(
                        value: _productos.contains(producto.id),
                        title: Text(producto.nombre),
                        subtitle: Text(
                            'RD\$ ${producto.precioVenta.toStringAsFixed(2)}'),
                        onChanged: (checked) {
                          setState(() {
                            if (checked == true) {
                              _productos.add(producto.id);
                            } else {
                              _productos.remove(producto.id);
                            }
                          });
                        },
                      );
                    },
                  ),
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

class _MetricCard extends StatelessWidget {
  const _MetricCard({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  final String label;
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
            Text(label, style: Theme.of(context).textTheme.bodySmall),
            Text(
              value,
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

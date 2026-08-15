import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/service_providers.dart';
import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/restaurante_repository.dart';

class RestauranteScreen extends ConsumerStatefulWidget {
  const RestauranteScreen({super.key});

  @override
  ConsumerState<RestauranteScreen> createState() => _RestauranteScreenState();
}

class _RestauranteScreenState extends ConsumerState<RestauranteScreen> {
  int _tab = 0;
  int _revision = 0;

  Future<void> _refresh() async => setState(() => _revision++);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Mesas y cocina'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(56),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            child: SegmentedButton<int>(
              segments: const [
                ButtonSegment(value: 0, label: Text('Mesas')),
                ButtonSegment(value: 1, label: Text('Cocina')),
              ],
              selected: {_tab},
              onSelectionChanged: (value) => setState(() => _tab = value.first),
            ),
          ),
        ),
      ),
      floatingActionButton: _tab == 0
          ? FloatingActionButton.extended(
              onPressed: () async {
                final created = await showDialog<bool>(
                  context: context,
                  builder: (_) => const _NuevaMesaDialog(),
                );
                if (created == true) await _refresh();
              },
              icon: const Icon(Icons.table_restaurant),
              label: const Text('Mesa'),
            )
          : null,
      body: _tab == 0
          ? _MesasView(key: ValueKey('mesas-$_revision'))
          : _CocinaView(key: ValueKey('cocina-$_revision')),
    );
  }
}

class _MesasView extends ConsumerWidget {
  const _MesasView({super.key});

  Future<List<MesaRestaurante>> _load(WidgetRef ref) async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return const [];
    return ref.read(restauranteRepositoryProvider).mesas(empresaId);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FutureBuilder<List<MesaRestaurante>>(
      future: _load(ref),
      builder: (context, snapshot) {
        final mesas = snapshot.data ?? const <MesaRestaurante>[];
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (mesas.isEmpty) {
          return const Center(child: Text('No hay mesas configuradas'));
        }
        return GridView.builder(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
            maxCrossAxisExtent: 180,
            mainAxisSpacing: 12,
            crossAxisSpacing: 12,
            childAspectRatio: 1.05,
          ),
          itemCount: mesas.length,
          itemBuilder: (context, index) {
            final mesa = mesas[index];
            final color = switch (mesa.estado) {
              'ocupada' => AppColors.warning,
              'reservada' => AppColors.info,
              'limpieza' => AppColors.danger,
              _ => AppColors.success,
            };
            return Card(
              color: color.withValues(alpha: 0.08),
              child: InkWell(
                onTap: () => _cambiarEstado(context, ref, mesa),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.table_bar, color: color, size: 32),
                      const SizedBox(height: 8),
                      Text(mesa.etiqueta,
                          style: Theme.of(context).textTheme.titleMedium),
                      Text(mesa.estado),
                      if (mesa.zona?.isNotEmpty == true) Text(mesa.zona!),
                    ],
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }

  Future<void> _cambiarEstado(
      BuildContext context, WidgetRef ref, MesaRestaurante mesa) async {
    final estado = await showModalBottomSheet<String>(
      context: context,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final item in ['libre', 'ocupada', 'reservada', 'limpieza'])
              ListTile(
                title: Text(item),
                onTap: () => Navigator.of(context).pop(item),
              ),
          ],
        ),
      ),
    );
    if (estado == null) return;
    await ref
        .read(restauranteRepositoryProvider)
        .cambiarMesaEstado(mesa, estado);
    if (context.mounted) {
      (context as Element).markNeedsBuild();
    }
  }
}

class _CocinaView extends ConsumerWidget {
  const _CocinaView({super.key});

  Future<List<CocinaTicket>> _load(WidgetRef ref) async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return const [];
    return ref.read(restauranteRepositoryProvider).cocina(empresaId);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FutureBuilder<List<CocinaTicket>>(
      future: _load(ref),
      builder: (context, snapshot) {
        final tickets = snapshot.data ?? const <CocinaTicket>[];
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (tickets.isEmpty) {
          return const Center(child: Text('No hay pedidos en cocina'));
        }
        return ListView.separated(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
          itemCount: tickets.length,
          separatorBuilder: (_, __) => const SizedBox(height: 8),
          itemBuilder: (context, index) {
            final ticket = tickets[index];
            return Card(
              child: ListTile(
                leading: const CircleAvatar(child: Icon(Icons.restaurant)),
                title: Text(ticket.numeroFactura),
                subtitle: Text([
                  ticket.tipoPedido,
                  ticket.mesa,
                  Formatters.dateTime(ticket.creadoEn),
                  ticket.nota,
                ].whereType<String>().join(' · ')),
                trailing: DropdownButton<String>(
                  value: ticket.estado,
                  items: const [
                    DropdownMenuItem(
                        value: 'pendiente', child: Text('Pendiente')),
                    DropdownMenuItem(
                        value: 'preparando', child: Text('Preparando')),
                    DropdownMenuItem(value: 'listo', child: Text('Listo')),
                    DropdownMenuItem(
                        value: 'entregado', child: Text('Entregado')),
                  ],
                  onChanged: (value) async {
                    if (value == null) return;
                    await ref
                        .read(restauranteRepositoryProvider)
                        .cambiarCocinaEstado(ticket, value);
                    if (context.mounted) {
                      (context as Element).markNeedsBuild();
                    }
                  },
                ),
              ),
            );
          },
        );
      },
    );
  }
}

class _NuevaMesaDialog extends ConsumerStatefulWidget {
  const _NuevaMesaDialog();

  @override
  ConsumerState<_NuevaMesaDialog> createState() => _NuevaMesaDialogState();
}

class _NuevaMesaDialogState extends ConsumerState<_NuevaMesaDialog> {
  final _etiquetaCtrl = TextEditingController();
  final _zonaCtrl = TextEditingController();
  final _capacidadCtrl = TextEditingController();
  bool _guardando = false;

  @override
  void dispose() {
    _etiquetaCtrl.dispose();
    _zonaCtrl.dispose();
    _capacidadCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    final auth = ref.read(authControllerProvider);
    final usuario = auth.usuario;
    final etiqueta = _etiquetaCtrl.text.trim();
    if (auth.empresaId == null || usuario == null || etiqueta.isEmpty) return;
    setState(() => _guardando = true);
    try {
      final sucursal = await ref.read(sucursalActivaProvider.future);
      final caja = await ref.read(cajaActivaProvider.future);
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      await ref.read(restauranteRepositoryProvider).crearMesa(
            empresaId: auth.empresaId!,
            usuarioId: usuario.id,
            etiqueta: etiqueta,
            zona: _zonaCtrl.text.trim().isEmpty ? null : _zonaCtrl.text.trim(),
            capacidad: int.tryParse(_capacidadCtrl.text),
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
      title: const Text('Nueva mesa'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _etiquetaCtrl,
            decoration: const InputDecoration(labelText: 'Etiqueta'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _zonaCtrl,
            decoration: const InputDecoration(labelText: 'Zona'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _capacidadCtrl,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Capacidad'),
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
          child: Text(_guardando ? 'Guardando...' : 'Guardar'),
        ),
      ],
    );
  }
}

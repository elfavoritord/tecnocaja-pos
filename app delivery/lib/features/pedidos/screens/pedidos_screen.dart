import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shimmer/shimmer.dart';

import '../../../core/config/app_colors.dart';
import '../../../core/config/routes.dart';
import '../../../data/models/pedido_delivery_model.dart';
import '../../../data/providers/ubicacion_provider.dart';
import '../../../shared/widgets/pedido_card.dart';
import '../../auth/providers/auth_provider.dart';
import '../providers/pedidos_provider.dart';

class PedidosScreen extends ConsumerStatefulWidget {
  const PedidosScreen({super.key});

  @override
  ConsumerState<PedidosScreen> createState() => _PedidosScreenState();
}

class _PedidosScreenState extends ConsumerState<PedidosScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabCtrl;

  @override
  void initState() {
    super.initState();
    _tabCtrl = TabController(length: 2, vsync: this);
    // GPS arranca automático al abrir la app — el repartidor no puede apagarlo.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(ubicacionProvider.notifier).iniciar();
    });
  }

  @override
  void dispose() {
    _tabCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final repartidor = ref.watch(authStateProvider).valueOrNull;
    final activos = ref.watch(pedidosActivosProvider);
    final historial = ref.watch(historialPedidosProvider);
    final tracking = ref.watch(ubicacionProvider);

    return Scaffold(
      appBar: AppBar(
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Image.asset(
              'assets/images/delivery logo.png',
              height: 36,
              width: 36,
              fit: BoxFit.contain,
            ),
            const SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Mis Pedidos',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                ),
                if (repartidor != null)
                  Text(
                    repartidor.nombre,
                    style: const TextStyle(fontSize: 12, color: Colors.white70),
                  ),
              ],
            ),
          ],
        ),
        actions: [
          // GPS activo → botón desaparece. Error → botón rojo para reintentar.
          if (tracking.error != null)
            IconButton(
              tooltip: 'Error de GPS — toca para reintentar',
              onPressed: () => ref.read(ubicacionProvider.notifier).iniciar(),
              icon: const Icon(Icons.gps_off_rounded, color: Colors.redAccent),
            ),
          IconButton(
            icon: const Icon(Icons.person_outline_rounded),
            tooltip: 'Perfil',
            onPressed: () => context.push(AppRoutes.perfil),
          ),
        ],
        bottom: TabBar(
          controller: _tabCtrl,
          indicatorColor: Colors.white,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white60,
          tabs: [
            Tab(
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.delivery_dining_rounded, size: 18),
                  const SizedBox(width: 6),
                  const Text('Activos'),
                  activos.maybeWhen(
                    data: (list) => list.isNotEmpty
                        ? _badge(list.length)
                        : const SizedBox.shrink(),
                    orElse: () => const SizedBox.shrink(),
                  ),
                ],
              ),
            ),
            const Tab(
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.history_rounded, size: 18),
                  SizedBox(width: 6),
                  Text('Historial'),
                ],
              ),
            ),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabCtrl,
        children: [
          _PedidosList(
            asyncPedidos: activos,
            emptyIcon: Icons.inbox_rounded,
            emptyTitle: 'Sin pedidos activos',
            emptySubtitle:
                'Los pedidos que te asignen aparecerán aquí',
          ),
          _PedidosList(
            asyncPedidos: historial,
            emptyIcon: Icons.history_rounded,
            emptyTitle: 'Sin historial aún',
            emptySubtitle: 'Aquí verás los pedidos entregados',
          ),
        ],
      ),
    );
  }

  Widget _badge(int count) {
    return Container(
      margin: const EdgeInsets.only(left: 6),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        '$count',
        style: const TextStyle(
          color: AppColors.primary,
          fontSize: 11,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _PedidosList extends ConsumerWidget {
  final AsyncValue<List<PedidoDelivery>> asyncPedidos;
  final IconData emptyIcon;
  final String emptyTitle;
  final String emptySubtitle;

  const _PedidosList({
    required this.asyncPedidos,
    required this.emptyIcon,
    required this.emptyTitle,
    required this.emptySubtitle,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return asyncPedidos.when(
      loading: () => _shimmerList(),
      error: (e, _) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: AppColors.error),
            const SizedBox(height: 12),
            Text(
              'Error al cargar pedidos',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(
              e.toString(),
              style: const TextStyle(
                  color: AppColors.textSecondary, fontSize: 12),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
      data: (pedidos) {
        if (pedidos.isEmpty) {
          return Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(emptyIcon, size: 64, color: AppColors.textHint),
                const SizedBox(height: 16),
                Text(
                  emptyTitle,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        color: AppColors.textSecondary,
                        fontWeight: FontWeight.w600,
                      ),
                ),
                const SizedBox(height: 4),
                Text(
                  emptySubtitle,
                  style: const TextStyle(
                      color: AppColors.textHint, fontSize: 13),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          );
        }
        return RefreshIndicator(
          onRefresh: () async {},
          child: ListView.builder(
            padding: const EdgeInsets.symmetric(vertical: 8),
            itemCount: pedidos.length,
            itemBuilder: (_, i) => PedidoCard(
              pedido: pedidos[i],
              onTap: () => context.push(AppRoutes.detalle(pedidos[i].id)),
            ),
          ),
        );
      },
    );
  }

  Widget _shimmerList() {
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: 4,
      itemBuilder: (_, __) => Shimmer.fromColors(
        baseColor: Colors.grey[300]!,
        highlightColor: Colors.grey[100]!,
        child: Container(
          margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          height: 130,
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
          ),
        ),
      ),
    );
  }
}

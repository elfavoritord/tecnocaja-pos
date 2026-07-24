import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/constants/roles.dart';
import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/inventario_repository.dart';
import '../../data/repositories/venta_repository.dart';
import '../../domain/entities/inventario.dart';
import '../../domain/entities/venta.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    final usuario = auth.usuario;
    final sucursalAsync = ref.watch(sucursalActivaProvider);
    final sesionAsync = ref.watch(sesionCajaActivaProvider);

    if (usuario == null) return const Scaffold(body: Center(child: CircularProgressIndicator()));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Tecno Caja POS'),
        actions: [
          IconButton(
            tooltip: 'Cerrar sesión',
            icon: const Icon(Icons.logout),
            onPressed: () => ref.read(authControllerProvider.notifier).cerrarSesion(),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(sesionCajaActivaProvider);
          ref.invalidate(sucursalActivaProvider);
        },
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _saludo(context, usuario.nombreCompleto, usuario.rol.etiqueta),
            const SizedBox(height: 16),
            sesionAsync.when(
              data: (sesion) => _estadoCaja(context, sesion != null),
              loading: () => const SizedBox.shrink(),
              error: (_, __) => const SizedBox.shrink(),
            ),
            const SizedBox(height: 16),
            sucursalAsync.when(
              data: (sucursal) => sucursal == null
                  ? const SizedBox.shrink()
                  : _MetricasHoy(empresaId: usuario.empresaId, sucursalId: sucursal.id),
              loading: () => const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
              error: (e, _) => Text('Error: $e'),
            ),
            const SizedBox(height: 16),
            _tarjetaAccion(
              context,
              icono: Icons.point_of_sale,
              titulo: 'Ir a vender',
              subtitulo: 'Abre el punto de venta',
              onTap: () => context.go('/pos'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _saludo(BuildContext context, String nombre, String rol) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Row(
          children: [
            CircleAvatar(
              radius: 26,
              backgroundColor: AppColors.primary.withValues(alpha: 0.15),
              child: Text(
                nombre.isNotEmpty ? nombre[0].toUpperCase() : '?',
                style: const TextStyle(color: AppColors.primaryDark, fontWeight: FontWeight.bold, fontSize: 20),
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Hola, $nombre', style: Theme.of(context).textTheme.titleMedium),
                  Text(rol, style: Theme.of(context).textTheme.bodySmall),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _estadoCaja(BuildContext context, bool abierta) {
    return Card(
      color: (abierta ? AppColors.success : AppColors.warning).withValues(alpha: 0.1),
      child: ListTile(
        leading: Icon(abierta ? Icons.lock_open : Icons.lock_outline, color: abierta ? AppColors.success : AppColors.warning),
        title: Text(abierta ? 'Caja abierta' : 'Caja cerrada'),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => context.go('/caja'),
      ),
    );
  }

  Widget _tarjetaAccion(
    BuildContext context, {
    required IconData icono,
    required String titulo,
    required String subtitulo,
    required VoidCallback onTap,
  }) {
    return Card(
      child: ListTile(
        leading: CircleAvatar(backgroundColor: AppColors.primary.withValues(alpha: 0.15), child: Icon(icono, color: AppColors.primaryDark)),
        title: Text(titulo),
        subtitle: Text(subtitulo),
        trailing: const Icon(Icons.chevron_right),
        onTap: onTap,
      ),
    );
  }
}

class _MetricasHoy extends ConsumerWidget {
  const _MetricasHoy({required this.empresaId, required this.sucursalId});
  final String empresaId;
  final String sucursalId;

  Future<(List<Venta>, List<InventarioSucursal>)> _cargar(WidgetRef ref) async {
    final ahora = DateTime.now();
    final inicioDelDia = DateTime(ahora.year, ahora.month, ahora.day);
    final resultados = await Future.wait([
      ref.read(ventaRepositoryProvider).deRango(empresaId, inicioDelDia, ahora),
      ref.read(inventarioRepositoryProvider).stockBajo(sucursalId),
    ]);
    return (resultados[0] as List<Venta>, resultados[1] as List<InventarioSucursal>);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FutureBuilder(
      future: _cargar(ref),
      builder: (context, snapshot) {
        if (!snapshot.hasData) {
          return const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()));
        }
        final (ventas, stockBajo) = snapshot.data!;
        final completadas = ventas.where((v) => v.estado == EstadoVenta.completada).toList();
        final totalHoy = completadas.fold<double>(0, (s, v) => s + v.total);

        return Column(
          children: [
            Row(
              children: [
                Expanded(child: _tarjetaMetrica(context, 'Ventas de hoy', Formatters.currency(totalHoy), Icons.trending_up)),
                const SizedBox(width: 12),
                Expanded(child: _tarjetaMetrica(context, 'Transacciones', '${completadas.length}', Icons.receipt_long)),
              ],
            ),
            if (stockBajo.isNotEmpty) ...[
              const SizedBox(height: 12),
              Card(
                color: AppColors.danger.withValues(alpha: 0.08),
                child: ListTile(
                  leading: const Icon(Icons.warning_amber_rounded, color: AppColors.danger),
                  title: Text('${stockBajo.length} producto(s) con stock bajo'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.go('/inventario'),
                ),
              ),
            ],
          ],
        );
      },
    );
  }

  Widget _tarjetaMetrica(BuildContext context, String etiqueta, String valor, IconData icono) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icono, color: AppColors.primaryDark),
            const SizedBox(height: 8),
            Text(etiqueta, style: Theme.of(context).textTheme.bodySmall),
            Text(valor, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
          ],
        ),
      ),
    );
  }
}

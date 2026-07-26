import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/constants/roles.dart';
import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/licensing/license_provider.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/inventario_repository.dart';
import '../../data/repositories/venta_repository.dart';
import '../../domain/entities/inventario.dart';
import '../../domain/entities/venta.dart';
import '../modules/modules_screen.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    final usuario = auth.usuario;
    final sucursalAsync = ref.watch(sucursalActivaProvider);
    final sesionAsync = ref.watch(sesionCajaActivaProvider);
    final license = ref.watch(businessLicenseProvider).valueOrNull;

    if (usuario == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Tecno Caja POS'),
        actions: [
          if (license != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 10),
              child: _LicenseStatusBadge(license: license),
            ),
          const SizedBox(width: 4),
          IconButton(
            tooltip: 'Cerrar sesión',
            icon: const Icon(Icons.logout),
            onPressed: () async {
              final closed = await ref
                  .read(authControllerProvider.notifier)
                  .cerrarSesion();
              if (!closed && context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: const Text(
                      'Debes cerrar la caja antes de cerrar sesión.',
                    ),
                    action: SnackBarAction(
                      label: 'Ir a Caja',
                      onPressed: () => context.go('/caja'),
                    ),
                  ),
                );
              }
            },
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
            if (license?.status == LicenseStatus.trial) ...[
              Card(
                color: Theme.of(context)
                    .colorScheme
                    .primaryContainer
                    .withValues(alpha: 0.55),
                child: ListTile(
                  leading: const Icon(Icons.schedule),
                  title: const Text('Licencia de prueba'),
                  subtitle: Text(
                    '${license?.remainingTrialDays ?? 0} día(s) restante(s)',
                  ),
                  trailing: license?.fromCache == true
                      ? const Icon(Icons.cloud_off)
                      : null,
                ),
              ),
              const SizedBox(height: 16),
            ],
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
                  : _MetricasHoy(
                      empresaId: usuario.empresaId,
                      sucursalId: sucursal.id,
                      usuarioId: usuario.id,
                      soloUsuario: usuario.rol == RolBase.cajero,
                    ),
              loading: () => const Center(
                  child: Padding(
                      padding: EdgeInsets.all(24),
                      child: CircularProgressIndicator())),
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
            const SizedBox(height: 24),
            Row(
              children: [
                Icon(Icons.apps, color: Theme.of(context).colorScheme.primary),
                const SizedBox(width: 8),
                Text('Módulos',
                    style: Theme.of(context)
                        .textTheme
                        .titleLarge
                        ?.copyWith(fontWeight: FontWeight.w700)),
              ],
            ),
            const SizedBox(height: 12),
            const ModulesGrid(),
            const SizedBox(height: 24),
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
                style: const TextStyle(
                    color: AppColors.primaryDark,
                    fontWeight: FontWeight.bold,
                    fontSize: 20),
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Hola, $nombre',
                      style: Theme.of(context).textTheme.titleMedium),
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
      color: (abierta ? AppColors.success : AppColors.warning)
          .withValues(alpha: 0.1),
      child: ListTile(
        leading: Icon(abierta ? Icons.lock_open : Icons.lock_outline,
            color: abierta ? AppColors.success : AppColors.warning),
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
        leading: CircleAvatar(
            backgroundColor: AppColors.primary.withValues(alpha: 0.15),
            child: Icon(icono, color: AppColors.primaryDark)),
        title: Text(titulo),
        subtitle: Text(subtitulo),
        trailing: const Icon(Icons.chevron_right),
        onTap: onTap,
      ),
    );
  }
}

class _LicenseStatusBadge extends StatelessWidget {
  const _LicenseStatusBadge({required this.license});

  final BusinessLicense license;

  @override
  Widget build(BuildContext context) {
    final (label, color, icon) = switch (license.status) {
      LicenseStatus.trial => (
          'Prueba ${license.remainingTrialDays ?? 0}d',
          Colors.orange,
          Icons.schedule,
        ),
      LicenseStatus.active => ('Activa', Colors.green, Icons.verified),
      LicenseStatus.suspended => (
          'Suspendida',
          Colors.deepOrange,
          Icons.pause_circle,
        ),
      LicenseStatus.expired => ('Expirada', Colors.red, Icons.error),
      LicenseStatus.unknown => (
          'Sin validar',
          Colors.blueGrey,
          Icons.cloud_off,
        ),
    };
    return Tooltip(
      message: 'Estado de licencia: $label',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.13),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: color.withValues(alpha: 0.45)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 15, color: color),
            const SizedBox(width: 4),
            Text(
              label,
              style: TextStyle(
                color: color,
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MetricasHoy extends ConsumerWidget {
  const _MetricasHoy({
    required this.empresaId,
    required this.sucursalId,
    required this.usuarioId,
    required this.soloUsuario,
  });
  final String empresaId;
  final String sucursalId;
  final String usuarioId;
  final bool soloUsuario;

  Future<(List<Venta>, List<InventarioSucursal>)> _cargar(WidgetRef ref) async {
    final ahora = DateTime.now();
    final inicioDelDia = DateTime(ahora.year, ahora.month, ahora.day);
    final resultados = await Future.wait([
      ref.read(ventaRepositoryProvider).deRango(empresaId, inicioDelDia, ahora),
      ref.read(inventarioRepositoryProvider).stockBajo(sucursalId),
    ]);
    return (
      resultados[0] as List<Venta>,
      resultados[1] as List<InventarioSucursal>
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FutureBuilder(
      future: _cargar(ref),
      builder: (context, snapshot) {
        if (!snapshot.hasData) {
          return const Center(
              child: Padding(
                  padding: EdgeInsets.all(24),
                  child: CircularProgressIndicator()));
        }
        final (ventas, stockBajo) = snapshot.data!;
        final completadas = ventas
            .where((v) =>
                v.estado == EstadoVenta.completada &&
                (!soloUsuario || v.usuarioId == usuarioId))
            .toList();
        final totalHoy = completadas.fold<double>(0, (s, v) => s + v.total);

        return Column(
          children: [
            Row(
              children: [
                Expanded(
                    child: _tarjetaMetrica(context, 'Ventas de hoy',
                        Formatters.currency(totalHoy), Icons.trending_up)),
                const SizedBox(width: 12),
                Expanded(
                    child: _tarjetaMetrica(context, 'Transacciones',
                        '${completadas.length}', Icons.receipt_long)),
              ],
            ),
            if (stockBajo.isNotEmpty) ...[
              const SizedBox(height: 12),
              Card(
                color: AppColors.danger.withValues(alpha: 0.08),
                child: ListTile(
                  leading: const Icon(Icons.warning_amber_rounded,
                      color: AppColors.danger),
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

  Widget _tarjetaMetrica(
      BuildContext context, String etiqueta, String valor, IconData icono) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icono, color: AppColors.primaryDark),
            const SizedBox(height: 8),
            Text(etiqueta, style: Theme.of(context).textTheme.bodySmall),
            Text(valor,
                style: Theme.of(context)
                    .textTheme
                    .titleLarge
                    ?.copyWith(fontWeight: FontWeight.bold)),
          ],
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../data/licensing/license_provider.dart';

/// Navegacion inferior comun a todos los modulos ya construidos. Cada fase
/// nueva (POS, Productos, Clientes...) agrega su propio [_Destino] aqui --
/// nunca se agrega una pestaña que apunte a una pantalla que todavia no
/// existe de verdad.
///
/// Los modulos que no caben en la barra inferior (5 slots max para que siga
/// siendo comoda con una mano) se navegan desde una lista dentro de Ajustes
/// en vez de agregarse aqui -- un Drawer no funciona porque cada pantalla
/// hija ya trae su propio Scaffold/AppBar anidado.
class AppShell extends ConsumerWidget {
  const AppShell({super.key, required this.child});

  final Widget child;

  static const _destinos = [
    _Destino(
        ruta: '/dashboard',
        icono: Icons.dashboard_outlined,
        iconoActivo: Icons.dashboard,
        etiqueta: 'Inicio'),
    _Destino(
        ruta: '/pos',
        icono: Icons.point_of_sale_outlined,
        iconoActivo: Icons.point_of_sale,
        etiqueta: 'Vender'),
    _Destino(
        ruta: '/productos',
        icono: Icons.inventory_2_outlined,
        iconoActivo: Icons.inventory_2,
        etiqueta: 'Productos'),
    _Destino(
        ruta: '/caja',
        icono: Icons.account_balance_wallet_outlined,
        iconoActivo: Icons.account_balance_wallet,
        etiqueta: 'Caja'),
    _Destino(
        ruta: '/ajustes',
        icono: Icons.settings_outlined,
        iconoActivo: Icons.settings,
        etiqueta: 'Ajustes'),
  ];

  int _indiceActivo(String location) {
    final index = _destinos.indexWhere((d) => location.startsWith(d.ruta));
    return index == -1 ? 0 : index;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final location = GoRouterState.of(context).matchedLocation;
    final licenseAsync = ref.watch(businessLicenseProvider);
    final license = licenseAsync.valueOrNull;
    final mayUseRestrictedRoute = location == '/caja' || location == '/ajustes';
    final blocked =
        license != null && !license.allowsOperations && !mayUseRestrictedRoute;

    return Scaffold(
      body: blocked
          ? _LicenseBlockedView(license: license)
          : licenseAsync.isLoading
              ? const Center(child: CircularProgressIndicator())
              : child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _indiceActivo(location),
        onDestinationSelected: (index) => context.go(_destinos[index].ruta),
        destinations: [
          for (final d in _destinos)
            NavigationDestination(
                icon: Icon(d.icono),
                selectedIcon: Icon(d.iconoActivo),
                label: d.etiqueta),
        ],
      ),
    );
  }
}

class _LicenseBlockedView extends ConsumerWidget {
  const _LicenseBlockedView({required this.license});

  final BusinessLicense license;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final suspended = license.status == LicenseStatus.suspended;
    final unknown = license.status == LicenseStatus.unknown;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    suspended ? Icons.pause_circle_outline : Icons.lock_clock,
                    size: 64,
                    color: Theme.of(context).colorScheme.error,
                  ),
                  const SizedBox(height: 16),
                  Text(
                    unknown
                        ? 'No se pudo validar la licencia'
                        : suspended
                            ? 'Licencia suspendida'
                            : 'Licencia expirada',
                    style: Theme.of(context).textTheme.headlineSmall,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    license.message ??
                        'Renueva o reactiva la licencia para continuar operando.',
                    textAlign: TextAlign.center,
                  ),
                  if (license.fromCache) ...[
                    const SizedBox(height: 8),
                    const Text(
                      'Estado obtenido de la última validación guardada.',
                      textAlign: TextAlign.center,
                    ),
                  ],
                  const SizedBox(height: 20),
                  FilledButton.icon(
                    onPressed: () => context.go('/caja'),
                    icon: const Icon(Icons.point_of_sale),
                    label: const Text('Ir a Caja / cerrar turno'),
                  ),
                  TextButton.icon(
                    onPressed: () => ref.invalidate(businessLicenseProvider),
                    icon: const Icon(Icons.refresh),
                    label: const Text('Validar nuevamente'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Destino {
  const _Destino(
      {required this.ruta,
      required this.icono,
      required this.iconoActivo,
      required this.etiqueta});

  final String ruta;
  final IconData icono;
  final IconData iconoActivo;
  final String etiqueta;
}

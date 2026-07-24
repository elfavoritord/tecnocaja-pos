import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// Navegacion inferior comun a todos los modulos ya construidos. Cada fase
/// nueva (POS, Productos, Clientes...) agrega su propio [_Destino] aqui --
/// nunca se agrega una pestaña que apunte a una pantalla que todavia no
/// existe de verdad.
///
/// Los modulos que no caben en la barra inferior (5 slots max para que siga
/// siendo comoda con una mano) se navegan desde una lista dentro de Ajustes
/// en vez de agregarse aqui -- un Drawer no funciona porque cada pantalla
/// hija ya trae su propio Scaffold/AppBar anidado.
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.child});

  final Widget child;

  static const _destinos = [
    _Destino(ruta: '/dashboard', icono: Icons.dashboard_outlined, iconoActivo: Icons.dashboard, etiqueta: 'Inicio'),
    _Destino(ruta: '/pos', icono: Icons.point_of_sale_outlined, iconoActivo: Icons.point_of_sale, etiqueta: 'Vender'),
    _Destino(ruta: '/productos', icono: Icons.inventory_2_outlined, iconoActivo: Icons.inventory_2, etiqueta: 'Productos'),
    _Destino(ruta: '/caja', icono: Icons.account_balance_wallet_outlined, iconoActivo: Icons.account_balance_wallet, etiqueta: 'Caja'),
    _Destino(ruta: '/ajustes', icono: Icons.settings_outlined, iconoActivo: Icons.settings, etiqueta: 'Ajustes'),
  ];

  int _indiceActivo(String location) {
    final index = _destinos.indexWhere((d) => location.startsWith(d.ruta));
    return index == -1 ? 0 : index;
  }

  @override
  Widget build(BuildContext context) {
    final location = GoRouterState.of(context).matchedLocation;

    return Scaffold(
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _indiceActivo(location),
        onDestinationSelected: (index) => context.go(_destinos[index].ruta),
        destinations: [
          for (final d in _destinos)
            NavigationDestination(icon: Icon(d.icono), selectedIcon: Icon(d.iconoActivo), label: d.etiqueta),
        ],
      ),
    );
  }
}

class _Destino {
  const _Destino({required this.ruta, required this.icono, required this.iconoActivo, required this.etiqueta});

  final String ruta;
  final IconData icono;
  final IconData iconoActivo;
  final String etiqueta;
}

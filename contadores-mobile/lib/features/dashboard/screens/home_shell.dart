import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/config/routes.dart';
import 'dashboard_screen.dart';
import '../../clientes/screens/clientes_screen.dart';
import '../../declaraciones/screens/declaraciones_screen.dart';
import '../../chat/screens/chat_list_screen.dart';
import '../../perfil/screens/perfil_screen.dart';

final _navIndexProvider = StateProvider<int>((ref) => 0);

class HomeShell extends ConsumerWidget {
  const HomeShell({super.key});

  static final _destinations = [
    const NavigationDestination(
      icon: Icon(Icons.dashboard_outlined),
      selectedIcon: Icon(Icons.dashboard_rounded),
      label: 'Inicio',
    ),
    const NavigationDestination(
      icon: Icon(Icons.business_outlined),
      selectedIcon: Icon(Icons.business_rounded),
      label: 'Clientes',
    ),
    const NavigationDestination(
      icon: Icon(Icons.receipt_long_outlined),
      selectedIcon: Icon(Icons.receipt_long_rounded),
      label: 'Declaraciones',
    ),
    const NavigationDestination(
      icon: Icon(Icons.chat_bubble_outline_rounded),
      selectedIcon: Icon(Icons.chat_bubble_rounded),
      label: 'Chat',
    ),
    const NavigationDestination(
      icon: Icon(Icons.person_outline_rounded),
      selectedIcon: Icon(Icons.person_rounded),
      label: 'Perfil',
    ),
  ];

  static const _screens = [
    DashboardScreen(),
    ClientesScreen(),
    DeclaracionesScreen(),
    ChatListScreen(),
    PerfilScreen(),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final index = ref.watch(_navIndexProvider);

    return Scaffold(
      body: IndexedStack(
        index: index,
        children: _screens,
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: (i) => ref.read(_navIndexProvider.notifier).state = i,
        destinations: _destinations,
        animationDuration: const Duration(milliseconds: 300),
      ),
    );
  }
}

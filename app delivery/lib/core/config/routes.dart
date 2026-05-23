import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/providers/auth_provider.dart';
import '../../features/auth/screens/login_screen.dart';
import '../../features/auth/screens/splash_screen.dart';
import '../../features/pedidos/screens/pedidos_screen.dart';
import '../../features/pedidos/screens/detalle_pedido_screen.dart';
import '../../features/entrega/screens/confirmar_entrega_screen.dart';
import '../../features/perfil/screens/perfil_screen.dart';

class AppRoutes {
  static const splash = '/';
  static const login = '/login';
  static const pedidos = '/pedidos';
  static const detallePedido = '/pedidos/:id';
  static const confirmarEntrega = '/pedidos/:id/confirmar';
  static const perfil = '/perfil';

  static String detalle(String id) => '/pedidos/$id';
  static String confirmar(String id) => '/pedidos/$id/confirmar';
}

// Notifica al GoRouter cuando cambia el estado de auth, sin recrearlo.
class _AuthChangeNotifier extends ChangeNotifier {
  _AuthChangeNotifier(Ref ref) {
    ref.listen(authStateProvider, (_, __) => notifyListeners());
  }
}

final routerProvider = Provider<GoRouter>((ref) {
  final authNotifier = _AuthChangeNotifier(ref);
  ref.onDispose(authNotifier.dispose);

  return GoRouter(
    initialLocation: AppRoutes.splash,
    refreshListenable: authNotifier,
    redirect: (context, state) {
      final authState = ref.read(authStateProvider);

      // Mientras carga, no redirigir
      if (authState.isLoading) return null;

      final isAuthenticated = authState.valueOrNull != null;
      final isOnLogin = state.matchedLocation == AppRoutes.login;
      final isOnSplash = state.matchedLocation == AppRoutes.splash;

      // Salir del splash en cuanto auth resuelve
      if (isOnSplash) {
        return isAuthenticated ? AppRoutes.pedidos : AppRoutes.login;
      }
      if (!isAuthenticated && !isOnLogin) return AppRoutes.login;
      if (isAuthenticated && isOnLogin) return AppRoutes.pedidos;
      return null;
    },
    routes: [
      GoRoute(
        path: AppRoutes.splash,
        builder: (_, __) => const SplashScreen(),
      ),
      GoRoute(
        path: AppRoutes.login,
        builder: (_, __) => const LoginScreen(),
      ),
      GoRoute(
        path: AppRoutes.pedidos,
        builder: (_, __) => const PedidosScreen(),
      ),
      GoRoute(
        path: AppRoutes.detallePedido,
        builder: (_, state) {
          final id = state.pathParameters['id']!;
          return DetallePedidoScreen(pedidoId: id);
        },
      ),
      GoRoute(
        path: AppRoutes.confirmarEntrega,
        builder: (_, state) {
          final id = state.pathParameters['id']!;
          return ConfirmarEntregaScreen(pedidoId: id);
        },
      ),
      GoRoute(
        path: AppRoutes.perfil,
        builder: (_, __) => const PerfilScreen(),
      ),
    ],
    errorBuilder: (_, state) => Scaffold(
      body: Center(child: Text('Página no encontrada: ${state.error}')),
    ),
  );
});

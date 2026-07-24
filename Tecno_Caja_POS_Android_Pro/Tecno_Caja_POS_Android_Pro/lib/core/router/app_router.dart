import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../data/auth/auth_controller.dart';
import '../../features/auth/forgot_password_screen.dart';
import '../../features/auth/login_screen.dart';
import '../../features/auth/pin_lock_screen.dart';
import '../../features/auth/register_screen.dart';
import '../../features/caja/caja_screen.dart';
import '../../features/clientes/clientes_screen.dart';
import '../../features/dashboard/dashboard_screen.dart';
import '../../features/inventario/inventario_screen.dart';
import '../../features/onboarding/onboarding_screen.dart';
import '../../features/pos/pos_screen.dart';
import '../../features/productos/productos_screen.dart';
import '../../features/proveedores/proveedores_screen.dart';
import '../../features/settings/settings_screen.dart';
import '../../features/shell/app_shell.dart';
import '../../features/splash/splash_screen.dart';

const _rutasPublicas = {'/login', '/registro', '/recuperar-contrasena'};

/// Notifica a GoRouter cuando cambia AuthState para que vuelva a evaluar
/// `redirect` incluso si la navegacion no la disparo un tap del usuario
/// (ej. Firebase emite un evento de sesion, o el temporizador de bloqueo por
/// PIN se cumple mientras la app esta abierta).
class _RouterRefreshNotifier extends ChangeNotifier {
  _RouterRefreshNotifier(Ref ref) {
    ref.listen<AuthState>(authControllerProvider, (_, __) => notifyListeners());
  }
}

final appRouterProvider = Provider<GoRouter>((ref) {
  final refresh = _RouterRefreshNotifier(ref);

  return GoRouter(
    initialLocation: '/splash',
    debugLogDiagnostics: false,
    refreshListenable: refresh,
    redirect: (context, state) => _redirect(ref, state),
    routes: [
      GoRoute(path: '/splash', builder: (context, state) => const SplashScreen()),
      GoRoute(path: '/login', builder: (context, state) => const LoginScreen()),
      GoRoute(path: '/registro', builder: (context, state) => const RegisterScreen()),
      GoRoute(path: '/recuperar-contrasena', builder: (context, state) => const ForgotPasswordScreen()),
      GoRoute(path: '/onboarding', builder: (context, state) => const OnboardingScreen()),
      GoRoute(path: '/bloqueo', builder: (context, state) => const PinLockScreen()),
      ShellRoute(
        builder: (context, state, child) => AppShell(child: child),
        routes: [
          GoRoute(path: '/dashboard', builder: (context, state) => const DashboardScreen()),
          GoRoute(path: '/pos', builder: (context, state) => const PosScreen()),
          GoRoute(path: '/productos', builder: (context, state) => const ProductosScreen()),
          GoRoute(path: '/caja', builder: (context, state) => const CajaScreen()),
          GoRoute(path: '/ajustes', builder: (context, state) => const SettingsScreen()),
          GoRoute(path: '/clientes', builder: (context, state) => const ClientesScreen()),
          GoRoute(path: '/inventario', builder: (context, state) => const InventarioScreen()),
          GoRoute(path: '/proveedores', builder: (context, state) => const ProveedoresScreen()),
        ],
      ),
    ],
  );
});

String? _redirect(Ref ref, GoRouterState state) {
  final auth = ref.read(authControllerProvider);
  final loc = state.matchedLocation;

  switch (auth.status) {
    case AuthStatus.cargando:
      return loc == '/splash' ? null : '/splash';
    case AuthStatus.noAutenticado:
      return _rutasPublicas.contains(loc) ? null : '/login';
    case AuthStatus.requiereOnboarding:
      return loc == '/onboarding' ? null : '/onboarding';
    case AuthStatus.bloqueado:
      return loc == '/bloqueo' ? null : '/bloqueo';
    case AuthStatus.autenticado:
      final rutasQueYaNoAplican = {..._rutasPublicas, '/onboarding', '/bloqueo', '/splash'};
      return rutasQueYaNoAplican.contains(loc) ? '/dashboard' : null;
  }
}

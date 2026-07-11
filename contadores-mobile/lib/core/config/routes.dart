import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../features/auth/providers/auth_provider.dart';
import '../../features/auth/screens/splash_screen.dart';
import '../../features/auth/screens/login_screen.dart';
import '../../features/auth/screens/forgot_password_screen.dart';
import '../../features/dashboard/screens/home_shell.dart';
import '../../features/clientes/screens/clientes_screen.dart';
import '../../features/clientes/screens/cliente_detail_screen.dart';
import '../../features/clientes/screens/cliente_form_screen.dart';
import '../../features/declaraciones/screens/declaraciones_screen.dart';
import '../../features/declaraciones/screens/declaracion_form_screen.dart';
import '../../features/declaraciones/screens/declaracion_detail_screen.dart';
import '../../features/calendario/screens/calendario_screen.dart';
import '../../features/agenda/screens/agenda_screen.dart';
import '../../features/documentos/screens/documentos_screen.dart';
import '../../features/chat/screens/chat_list_screen.dart';
import '../../features/chat/screens/chat_room_screen.dart';
import '../../features/reportes/screens/reportes_screen.dart';
import '../../features/perfil/screens/perfil_screen.dart';
import '../../features/configuracion/screens/configuracion_screen.dart';
import '../../data/models/user_model.dart';
import '../../data/models/declaracion_model.dart';

class AppRoutes {
  static const String splash = '/';
  static const String login = '/login';
  static const String forgotPassword = '/forgot-password';
  static const String home = '/home';
  static const String clientes = '/clientes';
  static const String clienteDetail = '/clientes/:id';
  static const String clienteNew = '/clientes/new';
  static const String clienteEdit = '/clientes/:id/edit';
  static const String declaraciones = '/declaraciones';
  static const String declaracionNew = '/declaraciones/new';
  static const String declaracionDetail = '/declaraciones/:id';
  static const String calendario = '/calendario';
  static const String agenda = '/agenda';
  static const String documentos = '/documentos';
  static const String chat = '/chat';
  static const String chatRoom = '/chat/:roomId';
  static const String reportes = '/reportes';
  static const String perfil = '/perfil';
  static const String configuracion = '/configuracion';
}

class _RouterNotifier extends ChangeNotifier {
  _RouterNotifier(Ref ref) {
    ref.listen(authStateProvider, (_, __) => notifyListeners());
    ref.listen(userProfileProvider, (_, __) => notifyListeners());
  }
}

final routerProvider = Provider<GoRouter>((ref) {
  final notifier = _RouterNotifier(ref);

  final router = GoRouter(
    initialLocation: AppRoutes.splash,
    refreshListenable: notifier,
    redirect: (context, state) {
      final authState = ref.read(authStateProvider);
      final profileAsync = ref.read(userProfileProvider);

      final firebaseUser = authState.valueOrNull;
      final isSplash = state.matchedLocation == AppRoutes.splash;
      final isAuthScreen = state.matchedLocation == AppRoutes.login ||
          state.matchedLocation == AppRoutes.forgotPassword;

      if (firebaseUser == null) {
        return isAuthScreen || isSplash ? null : AppRoutes.login;
      }

      if (profileAsync.isLoading) return null;

      final profile = profileAsync.valueOrNull;

      if (profile != null) {
        return isSplash || isAuthScreen ? AppRoutes.home : null;
      }

      return isAuthScreen ? null : AppRoutes.login;
    },
    routes: [
      GoRoute(
        path: AppRoutes.splash,
        builder: (_, __) => const SplashScreen(),
      ),
      GoRoute(
        path: AppRoutes.login,
        pageBuilder: (_, state) => CustomTransitionPage(
          key: state.pageKey,
          child: const LoginScreen(),
          transitionsBuilder: _fadeTransition,
        ),
      ),
      GoRoute(
        path: AppRoutes.forgotPassword,
        builder: (_, __) => const ForgotPasswordScreen(),
      ),
      GoRoute(
        path: AppRoutes.home,
        builder: (_, __) => const HomeShell(),
      ),
      GoRoute(
        path: AppRoutes.clientes,
        builder: (_, __) => const ClientesScreen(),
        routes: [
          GoRoute(
            path: 'new',
            builder: (_, __) => const ClienteFormScreen(),
          ),
          GoRoute(
            path: ':id',
            builder: (_, state) => ClienteDetailScreen(id: state.pathParameters['id']!),
            routes: [
              GoRoute(
                path: 'edit',
                builder: (_, state) => ClienteFormScreen(
                  clienteId: state.pathParameters['id'],
                  cliente: state.extra is ClienteModel ? state.extra as ClienteModel : null,
                ),
              ),
            ],
          ),
        ],
      ),
      GoRoute(
        path: AppRoutes.declaraciones,
        builder: (_, __) => const DeclaracionesScreen(),
        routes: [
          GoRoute(
            path: 'new',
            builder: (_, state) => DeclaracionFormScreen(
              clienteId: state.extra is Map ? (state.extra as Map)['clienteId'] as String? : null,
              clienteNombre: state.extra is Map ? (state.extra as Map)['clienteNombre'] as String? : null,
            ),
          ),
          GoRoute(
            path: ':id',
            builder: (_, state) => DeclaracionDetailScreen(
              id: state.pathParameters['id']!,
              declaracion: state.extra is DeclaracionModel ? state.extra as DeclaracionModel : null,
            ),
          ),
        ],
      ),
      GoRoute(path: AppRoutes.calendario, builder: (_, __) => const CalendarioScreen()),
      GoRoute(path: AppRoutes.agenda, builder: (_, __) => const AgendaScreen()),
      GoRoute(path: AppRoutes.documentos, builder: (_, __) => const DocumentosScreen()),
      GoRoute(
        path: AppRoutes.chat,
        builder: (_, __) => const ChatListScreen(),
        routes: [
          GoRoute(
            path: ':roomId',
            builder: (_, state) => ChatRoomScreen(
              roomId: state.pathParameters['roomId']!,
              clienteNombre: state.extra is String ? state.extra as String : 'Chat',
            ),
          ),
        ],
      ),
      GoRoute(path: AppRoutes.reportes, builder: (_, __) => const ReportesScreen()),
      GoRoute(path: AppRoutes.perfil, builder: (_, __) => const PerfilScreen()),
      GoRoute(path: AppRoutes.configuracion, builder: (_, __) => const ConfiguracionScreen()),
    ],
  );

  ref.onDispose(() {
    notifier.dispose();
    router.dispose();
  });

  return router;
});

Widget _fadeTransition(
  BuildContext context,
  Animation<double> animation,
  Animation<double> secondaryAnimation,
  Widget child,
) =>
    FadeTransition(opacity: animation, child: child);

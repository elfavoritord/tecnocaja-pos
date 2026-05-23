import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../features/auth/providers/auth_provider.dart';
import '../../features/auth/screens/splash_screen.dart';
import '../../features/auth/screens/login_screen.dart';
import '../../features/auth/screens/forgot_password_screen.dart';
import '../../features/dashboard/screens/dashboard_screen.dart';
import '../../features/notifications/screens/notifications_screen.dart';
import '../../features/reports/sales/screens/sales_report_screen.dart';
import '../../features/reports/profits/screens/profits_report_screen.dart';
import '../../features/reports/inventory/screens/inventory_report_screen.dart';
import '../../features/reports/cash/screens/cash_report_screen.dart';
import '../../features/reports/receivables/screens/receivables_report_screen.dart';
import '../../features/reports/expenses/screens/expenses_report_screen.dart';
import '../../features/reports/fiscal/screens/fiscal_report_screen.dart';
import '../../features/reports/customers/screens/customers_report_screen.dart';
import '../../features/reports/branches/screens/branches_report_screen.dart';
import '../../features/reports/pdf_export/screens/pdf_export_screen.dart';
import '../../features/settings/screens/settings_screen.dart';

class AppRoutes {
  static const String splash = '/';
  static const String login = '/login';
  static const String forgotPassword = '/forgot-password';
  static const String dashboard = '/dashboard';
  static const String notifications = '/notifications';
  static const String sales = '/reports/sales';
  static const String profits = '/reports/profits';
  static const String inventory = '/reports/inventory';
  static const String cash = '/reports/cash';
  static const String receivables = '/reports/receivables';
  static const String expenses = '/reports/expenses';
  static const String fiscal = '/reports/fiscal';
  static const String customers = '/reports/customers';
  static const String branches = '/reports/branches';
  static const String reportsPdf = '/reports/pdf';
  static const String settings = '/settings';
}

final routerProvider = Provider<GoRouter>((ref) {
  final authState = ref.watch(authStateProvider);
  final profileAsync = ref.watch(currentUserProfileProvider);

  return GoRouter(
    initialLocation: AppRoutes.splash,
    redirect: (context, state) {
      final firebaseUser = authState.valueOrNull;
      final isSplash = state.matchedLocation == AppRoutes.splash;
      final isAuth =
          state.matchedLocation == AppRoutes.login ||
          state.matchedLocation == AppRoutes.forgotPassword;

      // Sin sesión Firebase → login
      if (firebaseUser == null) {
        return isAuth || isSplash ? null : AppRoutes.login;
      }

      // Firebase Auth tiene usuario pero el perfil de Firestore todavía carga.
      // Nos quedamos donde estamos para que el error pueda mostrarse en login.
      if (profileAsync.isLoading) return null;

      final profile =
          profileAsync.valueOrNull ??
          ref.read(authRepositoryProvider).getCachedProfile(firebaseUser.uid);

      // Perfil válido y activo → entrar al dashboard
      if (profile != null && profile.isActive) {
        return isSplash || isAuth ? AppRoutes.dashboard : null;
      }

      // Firebase Auth tiene usuario pero el perfil no existe o no está activo.
      // ensureCurrentUserHasAccess() hará el signOut; mientras, quedar en login.
      return isAuth ? null : AppRoutes.login;
    },
    routes: [
      GoRoute(
        path: AppRoutes.splash,
        builder: (context, state) => const SplashScreen(),
      ),
      GoRoute(
        path: AppRoutes.login,
        pageBuilder: (context, state) => CustomTransitionPage(
          key: state.pageKey,
          child: const LoginScreen(),
          transitionsBuilder: _fadeTransition,
        ),
      ),
      GoRoute(
        path: AppRoutes.forgotPassword,
        builder: (context, state) => const ForgotPasswordScreen(),
      ),
      GoRoute(
        path: AppRoutes.dashboard,
        pageBuilder: (context, state) => CustomTransitionPage(
          key: state.pageKey,
          child: const DashboardScreen(),
          transitionsBuilder: _fadeTransition,
        ),
      ),
      GoRoute(
        path: AppRoutes.notifications,
        builder: (context, state) => const NotificationsScreen(),
      ),
      GoRoute(
        path: AppRoutes.sales,
        builder: (context, state) => const SalesReportScreen(),
      ),
      GoRoute(
        path: AppRoutes.profits,
        builder: (context, state) => const ProfitsReportScreen(),
      ),
      GoRoute(
        path: AppRoutes.inventory,
        builder: (context, state) => const InventoryReportScreen(),
      ),
      GoRoute(
        path: AppRoutes.cash,
        builder: (context, state) => const CashReportScreen(),
      ),
      GoRoute(
        path: AppRoutes.receivables,
        builder: (context, state) => const ReceivablesReportScreen(),
      ),
      GoRoute(
        path: AppRoutes.expenses,
        builder: (context, state) => const ExpensesReportScreen(),
      ),
      GoRoute(
        path: AppRoutes.fiscal,
        builder: (context, state) => const FiscalReportScreen(),
      ),
      GoRoute(
        path: AppRoutes.customers,
        builder: (context, state) => const CustomersReportScreen(),
      ),
      GoRoute(
        path: AppRoutes.branches,
        builder: (context, state) => const BranchesReportScreen(),
      ),
      GoRoute(
        path: AppRoutes.reportsPdf,
        builder: (context, state) => const PdfExportScreen(),
      ),
      GoRoute(
        path: AppRoutes.settings,
        builder: (context, state) => const SettingsScreen(),
      ),
    ],
  );
});

Widget _fadeTransition(
  BuildContext context,
  Animation<double> animation,
  Animation<double> secondaryAnimation,
  Widget child,
) {
  return FadeTransition(opacity: animation, child: child);
}

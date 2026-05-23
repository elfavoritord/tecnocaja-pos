import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/config/routes.dart';
import '../../core/constants/app_colors.dart';
import '../../core/constants/app_modules.dart';
import '../../data/models/user_model.dart';
import '../../features/auth/providers/auth_provider.dart';

class AppDrawer extends ConsumerWidget {
  const AppDrawer({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(currentUserProfileProvider).valueOrNull;

    return Drawer(
      child: SafeArea(
        child: Column(
          children: [
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(gradient: AppColors.primaryGradient),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  CircleAvatar(
                    radius: 28,
                    backgroundColor: Colors.white.withValues(alpha: 0.2),
                    child: Text(
                      profile?.displayName.isNotEmpty == true
                          ? profile!.displayName[0].toUpperCase()
                          : 'A',
                      style: const TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w700,
                        color: Colors.white,
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    profile?.displayName ?? 'Administrador',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    profile?.roleDisplayLabel ?? '',
                    style: TextStyle(
                      color: Colors.white.withValues(alpha: 0.75),
                      fontSize: 12,
                    ),
                  ),
                  if (profile?.hasMultipleBusinesses == true) ...[
                    const SizedBox(height: 8),
                    Text(
                      '${profile!.effectiveBusinessIds.length} negocios vinculados',
                      style: TextStyle(
                        color: Colors.white.withValues(alpha: 0.82),
                        fontSize: 11,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 8),
                children: _visibleItems(profile),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(12),
              child: ListTile(
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                tileColor: AppColors.errorLight,
                leading: const Icon(
                  Icons.logout_rounded,
                  color: AppColors.error,
                ),
                title: const Text(
                  'Cerrar Sesion',
                  style: TextStyle(
                    color: AppColors.error,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                onTap: () async {
                  Navigator.pop(context);
                  await ref.read(authNotifierProvider.notifier).signOut();
                  if (context.mounted) context.go(AppRoutes.login);
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _visibleItems(UserModel? profile) {
    final items = <Widget>[
      const _NavItem(
        icon: Icons.dashboard_rounded,
        label: 'Dashboard',
        route: AppRoutes.dashboard,
        moduleKey: AppModules.dashboard,
      ),
      const _SectionLabel(label: 'REPORTES'),
      const _NavItem(
        icon: Icons.point_of_sale_rounded,
        label: 'Ventas',
        route: AppRoutes.sales,
        moduleKey: AppModules.sales,
      ),
      const _NavItem(
        icon: Icons.trending_up_rounded,
        label: 'Ganancias',
        route: AppRoutes.profits,
        moduleKey: AppModules.profits,
      ),
      const _NavItem(
        icon: Icons.inventory_2_outlined,
        label: 'Inventario',
        route: AppRoutes.inventory,
        moduleKey: AppModules.inventory,
      ),
      const _NavItem(
        icon: Icons.account_balance_wallet_outlined,
        label: 'Caja',
        route: AppRoutes.cash,
        moduleKey: AppModules.cash,
      ),
      const _NavItem(
        icon: Icons.receipt_long_outlined,
        label: 'Cuentas por Pagar y Cobrar',
        route: AppRoutes.receivables,
        moduleKey: AppModules.receivables,
      ),
      const _NavItem(
        icon: Icons.money_off_rounded,
        label: 'Gastos',
        route: AppRoutes.expenses,
        moduleKey: AppModules.expenses,
      ),
      const _NavItem(
        icon: Icons.description_outlined,
        label: 'Fiscal',
        route: AppRoutes.fiscal,
        moduleKey: AppModules.fiscal,
      ),
      const _NavItem(
        icon: Icons.people_outline_rounded,
        label: 'Clientes',
        route: AppRoutes.customers,
        moduleKey: AppModules.customers,
      ),
      const _NavItem(
        icon: Icons.store_outlined,
        label: 'Sucursales',
        route: AppRoutes.branches,
        moduleKey: AppModules.branches,
      ),
      const _NavItem(
        icon: Icons.picture_as_pdf_rounded,
        label: 'Exportar PDF',
        route: AppRoutes.reportsPdf,
        moduleKey: AppModules.settings,
      ),
      const _SectionLabel(label: 'CUENTA'),
      const _NavItem(
        icon: Icons.settings_outlined,
        label: 'Configuracion',
        route: AppRoutes.settings,
        moduleKey: AppModules.settings,
      ),
    ];

    return items.where((item) {
      if (item is! _NavItem) return true;
      return profile?.canAccessModule(item.moduleKey) ?? true;
    }).toList();
  }
}

class _NavItem extends StatelessWidget {
  final IconData icon;
  final String label;
  final String route;
  final String moduleKey;

  const _NavItem({
    required this.icon,
    required this.label,
    required this.route,
    required this.moduleKey,
  });

  @override
  Widget build(BuildContext context) {
    final current = GoRouterState.of(context).matchedLocation;
    final isActive = current == route;

    return ListTile(
      leading: Icon(icon, color: isActive ? AppColors.primary : null, size: 20),
      title: Text(
        label,
        style: TextStyle(
          fontSize: 14,
          fontWeight: isActive ? FontWeight.w600 : FontWeight.w400,
          color: isActive ? AppColors.primary : null,
        ),
      ),
      tileColor: isActive ? AppColors.primary.withValues(alpha: 0.08) : null,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      onTap: () {
        Navigator.pop(context);
        context.go(route);
      },
      dense: true,
      visualDensity: VisualDensity.compact,
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String label;

  const _SectionLabel({required this.label});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.w700,
          color: AppColors.textSecondary,
          letterSpacing: 1,
        ),
      ),
    );
  }
}

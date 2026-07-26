import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers/database_providers.dart';
import '../../core/constants/roles.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';

class ModulesScreen extends StatelessWidget {
  const ModulesScreen({super.key});

  static const modules = [
    _Module('Punto de venta', '/pos', Icons.point_of_sale),
    _Module('Ventas y facturas', '/ventas', Icons.receipt_long),
    _Module('Cotizaciones', '/cotizaciones', Icons.request_quote),
    _Module('Productos', '/productos', Icons.inventory_2),
    _Module('Inventario', '/inventario', Icons.warehouse),
    _Module('Promociones y combos', '/promociones', Icons.local_offer),
    _Module('Clientes', '/clientes', Icons.people),
    _Module('Cuentas por cobrar', '/cuentas-cobrar', Icons.account_balance),
    _Module('Proveedores', '/proveedores', Icons.local_shipping),
    _Module('Compras y cuentas por pagar', '/compras',
        Icons.shopping_cart_checkout),
    _Module('Caja', '/caja', Icons.account_balance_wallet),
    _Module('Movimientos', '/movimientos', Icons.swap_vert_circle),
    _Module('Reportes', '/reportes', Icons.analytics),
    _Module('Usuarios y permisos', '/usuarios', Icons.manage_accounts),
    _Module('Delivery', '/delivery', Icons.delivery_dining),
    _Module('Auditoría', '/auditoria', Icons.fact_check),
    _Module('Configuración fiscal', '/fiscal', Icons.verified_user),
    _Module('Etiquetas', '/etiquetas', Icons.qr_code_2),
    _Module('Respaldos', '/respaldos', Icons.cloud_upload),
    _Module('Ajustes', '/ajustes', Icons.settings),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Todos los módulos')),
      body: const SingleChildScrollView(
        padding: EdgeInsets.all(16),
        child: ModulesGrid(),
      ),
    );
  }
}

class ModulesGrid extends ConsumerWidget {
  const ModulesGrid({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final role = ref.watch(authControllerProvider).usuario?.rol;
    final visibleModules = ModulesScreen.modules
        .where(
            (module) => role == null || canRoleAccessRoute(role, module.route))
        .toList();
    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 900
            ? 4
            : constraints.maxWidth >= 600
                ? 3
                : 2;
        const gap = 12.0;
        final itemWidth =
            (constraints.maxWidth - gap * (columns - 1)) / columns;
        return Wrap(
          spacing: gap,
          runSpacing: gap,
          children: [
            for (final module in visibleModules)
              SizedBox(
                width: itemWidth,
                height: 116,
                child: Card(
                  margin: EdgeInsets.zero,
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: () => context.go(module.route),
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(module.icon,
                              size: 30,
                              color: Theme.of(context).colorScheme.primary),
                          const SizedBox(height: 8),
                          Text(module.label,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              textAlign: TextAlign.center),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

bool canRoleAccessRoute(RolBase role, String route) {
  if (role == RolBase.administradorGeneral ||
      role == RolBase.administradorSucursal) {
    return true;
  }
  const cashierRoutes = {
    '/pos',
    '/ventas',
    '/cotizaciones',
    '/productos',
    '/clientes',
    '/cuentas-cobrar',
    '/caja',
    '/ajustes',
  };
  const supervisorRoutes = {
    ...cashierRoutes,
    '/inventario',
    '/movimientos',
    '/promociones',
    '/reportes',
    '/delivery',
    '/etiquetas',
  };
  const accountantRoutes = {
    '/ventas',
    '/productos',
    '/inventario',
    '/clientes',
    '/cuentas-cobrar',
    '/proveedores',
    '/compras',
    '/caja',
    '/reportes',
    '/auditoria',
    '/fiscal',
    '/ajustes',
  };
  return switch (role) {
    RolBase.cajero => cashierRoutes.contains(route),
    RolBase.supervisor => supervisorRoutes.contains(route),
    RolBase.contador => accountantRoutes.contains(route),
    RolBase.delivery => route == '/delivery' || route == '/ajustes',
    _ => false,
  };
}

class LocalDataModuleScreen extends ConsumerWidget {
  const LocalDataModuleScreen({
    super.key,
    required this.title,
    required this.table,
    required this.icon,
    required this.primaryColumn,
    this.secondaryColumn,
    this.amountColumn,
    this.where,
    this.ownUserOnly = false,
    this.orderBy = 'actualizado_en DESC',
    this.emptyMessage = 'No hay registros todavía',
  });

  final String title;
  final String table;
  final IconData icon;
  final String primaryColumn;
  final String? secondaryColumn;
  final String? amountColumn;
  final String? where;
  final bool ownUserOnly;
  final String orderBy;
  final String emptyMessage;

  Future<List<Map<String, Object?>>> _load(WidgetRef ref) async {
    final businessId = ref.read(authControllerProvider).empresaId;
    final user = ref.read(authControllerProvider).usuario;
    if (businessId == null) return const [];
    final restrictToUser =
        ownUserOnly && user?.rol == RolBase.cajero && user != null;
    final conditions = <String>[
      'empresa_id = ?',
      if (where != null) '($where)',
      if (restrictToUser) 'usuario_id = ?',
    ];
    return ref.read(databaseProvider).query(
          table,
          where: conditions.join(' AND '),
          whereArgs: [
            businessId,
            if (restrictToUser) user.id,
          ],
          orderBy: orderBy,
          limit: 500,
        );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: FutureBuilder(
        future: _load(ref),
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(
                child:
                    Text('No se pudieron cargar los datos: ${snapshot.error}'));
          }
          final rows = snapshot.data ?? const [];
          if (rows.isEmpty) {
            return Center(child: Text(emptyMessage));
          }
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(databaseProvider),
            child: ListView.separated(
              padding: const EdgeInsets.all(12),
              itemCount: rows.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (context, index) {
                final row = rows[index];
                final secondary = secondaryColumn == null
                    ? null
                    : row[secondaryColumn]?.toString();
                final amount = amountColumn == null ? null : row[amountColumn];
                return ListTile(
                  leading: CircleAvatar(child: Icon(icon)),
                  title: Text(row[primaryColumn]?.toString() ?? '—'),
                  subtitle: secondary == null || secondary.isEmpty
                      ? null
                      : Text(secondary),
                  trailing: amount is num
                      ? Text(
                          Formatters.currency(amount.toDouble()),
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        )
                      : null,
                );
              },
            ),
          );
        },
      ),
    );
  }
}

class _Module {
  const _Module(this.label, this.route, this.icon);
  final String label;
  final String route;
  final IconData icon;
}

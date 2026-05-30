import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shimmer/shimmer.dart';

import '../../../../core/constants/app_colors.dart';
import '../../../../core/utils/format_helpers.dart';
import '../../../../data/models/customer_model.dart';
import '../../../../shared/widgets/app_empty_state.dart';
import '../../../../shared/widgets/app_section_header.dart';
import '../../../../shared/widgets/report_scaffold.dart'
    show ReportScaffold, isCompact, hPad;
import '../../../auth/providers/auth_provider.dart';

const _customersQueryTimeout = Duration(seconds: 12);

// ─── Provider ─────────────────────────────────────────────────────────────────

final _customersProvider = FutureProvider.autoDispose
    .family<_CustomerOverview, String>((ref, businessId) async {
      // Intenta leer la colección customers directamente
      // Si falla por permisos, cae al fallback de ventas automáticamente
      QuerySnapshot? snap;
      try {
        snap = await FirebaseFirestore.instance
            .collection('businesses')
            .doc(businessId)
            .collection('customers')
            .orderBy('totalPurchases', descending: true)
            .limit(200)
            .get()
            .timeout(_customersQueryTimeout);
      } catch (_) {
        snap = null; // permiso denegado → fallback
      }

      List<CustomerModel> customers;

      if (snap != null && snap.docs.isNotEmpty) {
        customers = snap.docs
            .map((d) => CustomerModel.fromFirestore(d))
            .toList();
      } else {
        // Fallback: derivar clientes desde ventas con crédito
        final salesSnap = await FirebaseFirestore.instance
            .collection('businesses')
            .doc(businessId)
            .collection('sales')
            .where('paymentMethod', isEqualTo: 'credit')
            .limit(500)
            .get()
            .timeout(_customersQueryTimeout);

        final Map<String, _CustomerAgg> aggMap = {};
        for (final doc in salesSnap.docs) {
          final d = doc.data();
          final customerId = (d['customerId'] ?? '').toString();
          if (customerId.isEmpty) continue;
          final name = (d['customerName'] ?? 'Cliente').toString();
          final total = (d['total'] ?? 0).toDouble();
          final createdAt =
              (d['createdAt'] as Timestamp?)?.toDate() ?? DateTime.now();
          final prev = aggMap[customerId];
          aggMap[customerId] = _CustomerAgg(
            id: customerId,
            name: name,
            total: (prev?.total ?? 0) + total,
            visits: (prev?.visits ?? 0) + 1,
            lastPurchaseAt: prev == null
                ? createdAt
                : (createdAt.isAfter(prev.lastPurchaseAt)
                      ? createdAt
                      : prev.lastPurchaseAt),
            createdAt: prev?.createdAt ?? createdAt,
          );
        }

        customers =
            aggMap.values
                .map(
                  (a) => CustomerModel(
                    id: a.id,
                    name: a.name,
                    totalPurchases: a.total,
                    visitCount: a.visits,
                    totalDebt: 0,
                    lastPurchaseAt: a.lastPurchaseAt,
                    createdAt: a.createdAt,
                  ),
                )
                .toList()
              ..sort((a, b) => b.totalPurchases.compareTo(a.totalPurchases));
      }

      if (customers.isEmpty) return _CustomerOverview.empty();

      final now = DateTime.now();
      final newCount = customers
          .where((c) => now.difference(c.createdAt).inDays <= 30)
          .length;
      final inactiveCount = customers.where((c) {
        final lp = c.lastPurchaseAt;
        return lp == null || now.difference(lp).inDays >= 60;
      }).length;
      final debtCount = customers.where((c) => c.hasDebt).length;
      final totalRevenue = customers.fold<double>(
        0,
        (s, c) => s + c.totalPurchases,
      );

      return _CustomerOverview(
        customers: customers,
        newCount: newCount,
        inactiveCount: inactiveCount,
        debtCount: debtCount,
        totalRevenue: totalRevenue,
      );
    });

// ─── Pantalla ─────────────────────────────────────────────────────────────────

class CustomersReportScreen extends ConsumerStatefulWidget {
  const CustomersReportScreen({super.key});

  @override
  ConsumerState<CustomersReportScreen> createState() =>
      _CustomersReportScreenState();
}

class _CustomersReportScreenState extends ConsumerState<CustomersReportScreen> {
  String _search = '';

  @override
  Widget build(BuildContext context) {
    final businessId = ref.watch(activeBusinessIdProvider);
    if (businessId == null || businessId.isEmpty) {
      return const Scaffold(
        body: AppErrorState(message: 'No hay sesión activa.'),
      );
    }

    final overviewAsync = ref.watch(_customersProvider(businessId));

    return ReportScaffold(
      title: 'Clientes',
      actions: [
        IconButton(
          icon: const Icon(Icons.refresh_rounded),
          onPressed: () => ref.invalidate(_customersProvider(businessId)),
        ),
      ],
      body: overviewAsync.when(
        loading: () => const _CustomersShimmer(),
        error: (e, _) => AppErrorState(
          message: e.toString(),
          onRetry: () => ref.invalidate(_customersProvider(businessId)),
        ),
        data: (overview) {
          if (overview.customers.isEmpty) {
            return const AppEmptyState(
              title: 'Sin clientes',
              message: 'No se encontraron clientes registrados.',
              icon: Icons.people_outline_rounded,
            );
          }
          return _buildContent(overview);
        },
      ),
    );
  }

  Widget _buildContent(_CustomerOverview overview) {
    final compact = isCompact(context);
    final h = hPad(context);
    List<CustomerModel> filtered = List.of(overview.customers);
    if (_search.isNotEmpty) {
      final q = _search.toLowerCase();
      filtered = filtered
          .where(
            (c) =>
                c.name.toLowerCase().contains(q) ||
                (c.phone ?? '').contains(q) ||
                (c.email ?? '').toLowerCase().contains(q),
          )
          .toList();
    }

    return Column(
      children: [
        // Resumen
        Padding(
          padding: EdgeInsets.fromLTRB(h, compact ? 10 : 14, h, 0),
          child: Row(
            children: [
              Expanded(
                child: _StatCard(
                  label: 'Total',
                  value: '${overview.customers.length}',
                  icon: Icons.people_rounded,
                  color: AppColors.primary,
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: _StatCard(
                  label: 'Nuevos (30d)',
                  value: '${overview.newCount}',
                  icon: Icons.person_add_rounded,
                  color: AppColors.success,
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: _StatCard(
                  label: 'Con deuda',
                  value: '${overview.debtCount}',
                  icon: Icons.account_balance_wallet_outlined,
                  color: overview.debtCount > 0
                      ? AppColors.warning
                      : AppColors.textSecondary,
                ),
              ),
            ],
          ),
        ),

        // Buscador
        Padding(
          padding: EdgeInsets.fromLTRB(h, compact ? 8 : 12, h, 0),
          child: TextField(
            decoration: InputDecoration(
              hintText: 'Buscar cliente...',
              prefixIcon: const Icon(Icons.search_rounded),
              suffixIcon: _search.isNotEmpty
                  ? IconButton(
                      icon: const Icon(Icons.clear_rounded),
                      onPressed: () => setState(() => _search = ''),
                    )
                  : null,
              contentPadding: const EdgeInsets.symmetric(vertical: 10),
            ),
            onChanged: (v) => setState(() => _search = v),
          ),
        ),

        AppSectionHeader(
          title: '${filtered.length} cliente${filtered.length != 1 ? 's' : ''}',
        ),

        Expanded(
          child: filtered.isEmpty
              ? const AppEmptyState(
                  title: 'Sin resultados',
                  icon: Icons.search_off_rounded,
                )
              : ListView.builder(
                  padding: EdgeInsets.fromLTRB(h, 0, h, 24),
                  itemCount: filtered.length,
                  itemBuilder: (_, i) =>
                      _CustomerTile(customer: filtered[i], rank: i + 1),
                ),
        ),
      ],
    );
  }
}

class _StatCard extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;
  final Color color;

  const _StatCard({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final compact = MediaQuery.sizeOf(context).width < 400;
    return Container(
      padding: EdgeInsets.all(compact ? 9 : 12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(compact ? 12 : 14),
        border: Border.all(color: color.withValues(alpha: 0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: compact ? 15 : 18, color: color),
          SizedBox(height: compact ? 4 : 6),
          Text(
            value,
            style: TextStyle(
              fontWeight: FontWeight.w800,
              fontSize: compact ? 15 : 18,
              color: color,
            ),
          ),
          Text(
            label,
            style: TextStyle(
              color: isDark
                  ? AppColors.textDarkSecondary
                  : AppColors.textSecondary,
              fontSize: compact ? 9 : 10,
            ),
          ),
        ],
      ),
    );
  }
}

class _CustomerTile extends StatelessWidget {
  final CustomerModel customer;
  final int rank;

  const _CustomerTile({required this.customer, required this.rank});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final isTop = rank <= 3;
    final compact = MediaQuery.sizeOf(context).width < 400;

    return Padding(
      padding: EdgeInsets.only(bottom: compact ? 6 : 8),
      child: Container(
        padding: EdgeInsets.all(compact ? 10 : 14),
        decoration: BoxDecoration(
          color: Theme.of(context).cardColor,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: isTop
                ? AppColors.primary.withValues(alpha: 0.25)
                : (isDark ? AppColors.darkBorder : AppColors.lightBorder),
          ),
        ),
        child: Row(
          children: [
            // Avatar con inicial
            Container(
              width: 40,
              height: 40,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: AppColors
                    .chartColors[(rank - 1) % AppColors.chartColors.length]
                    .withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                customer.name.isNotEmpty ? customer.name[0].toUpperCase() : '?',
                style: TextStyle(
                  fontWeight: FontWeight.w800,
                  fontSize: 16,
                  color: AppColors
                      .chartColors[(rank - 1) % AppColors.chartColors.length],
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    customer.name,
                    style: const TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 14,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      Text(
                        '${customer.visitCount} compra${customer.visitCount != 1 ? 's' : ''}',
                        style: const TextStyle(
                          color: AppColors.textSecondary,
                          fontSize: 12,
                        ),
                      ),
                      if (customer.lastPurchaseAt != null) ...[
                        const Text(
                          ' · ',
                          style: TextStyle(color: AppColors.textSecondary),
                        ),
                        Text(
                          _formatDate(customer.lastPurchaseAt!),
                          style: const TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  FormatHelpers.currency(customer.totalPurchases),
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 14,
                  ),
                ),
                if (customer.hasDebt)
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 7,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: AppColors.warningLight,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      'Debe ${FormatHelpers.currency(customer.totalDebt)}',
                      style: const TextStyle(
                        color: AppColors.warning,
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  String _formatDate(DateTime d) {
    final now = DateTime.now();
    final diff = now.difference(d).inDays;
    if (diff == 0) return 'hoy';
    if (diff == 1) return 'ayer';
    if (diff < 7) return 'hace ${diff}d';
    return '${d.day}/${d.month}/${d.year}';
  }
}

class _CustomersShimmer extends StatelessWidget {
  const _CustomersShimmer();

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Shimmer.fromColors(
      baseColor: isDark ? const Color(0xFF1E293B) : Colors.grey.shade200,
      highlightColor: isDark ? const Color(0xFF334155) : Colors.grey.shade50,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              Expanded(child: _box(70, 14)),
              const SizedBox(width: 8),
              Expanded(child: _box(70, 14)),
              const SizedBox(width: 8),
              Expanded(child: _box(70, 14)),
            ],
          ),
          const SizedBox(height: 12),
          _box(48, 12),
          const SizedBox(height: 12),
          for (var i = 0; i < 6; i++) ...[
            _box(72, 14),
            const SizedBox(height: 8),
          ],
        ],
      ),
    );
  }

  Widget _box(double h, double r) => Container(
    height: h,
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(r),
    ),
  );
}

// ─── Modelos internos ─────────────────────────────────────────────────────────

class _CustomerOverview {
  final List<CustomerModel> customers;
  final int newCount;
  final int inactiveCount;
  final int debtCount;
  final double totalRevenue;

  const _CustomerOverview({
    required this.customers,
    required this.newCount,
    required this.inactiveCount,
    required this.debtCount,
    required this.totalRevenue,
  });

  factory _CustomerOverview.empty() => const _CustomerOverview(
    customers: [],
    newCount: 0,
    inactiveCount: 0,
    debtCount: 0,
    totalRevenue: 0,
  );
}

class _CustomerAgg {
  final String id;
  final String name;
  final double total;
  final int visits;
  final DateTime lastPurchaseAt;
  final DateTime createdAt;

  const _CustomerAgg({
    required this.id,
    required this.name,
    required this.total,
    required this.visits,
    required this.lastPurchaseAt,
    required this.createdAt,
  });
}

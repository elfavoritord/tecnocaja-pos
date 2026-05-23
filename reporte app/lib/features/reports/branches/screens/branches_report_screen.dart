import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shimmer/shimmer.dart';

import '../../../../core/constants/app_colors.dart';
import '../../../../core/utils/format_helpers.dart';
import '../../../../data/models/branch_model.dart';
import '../../../../data/models/sale_model.dart';
import '../../../../shared/widgets/app_empty_state.dart';
import '../../../../shared/widgets/app_section_header.dart';
import '../../../../shared/widgets/report_scaffold.dart' show ReportScaffold, isCompact, hPad;
import '../../../auth/providers/auth_provider.dart';

// ─── Provider ─────────────────────────────────────────────────────────────────

final _branchesProvider =
    FutureProvider.autoDispose.family<List<BranchModel>, String>(
  (ref, businessId) async {
    final now = DateTime.now();
    final from = DateTime(now.year, now.month, 1);

    final snap = await FirebaseFirestore.instance
        .collection('businesses')
        .doc(businessId)
        .collection('sales')
        .where(
          'createdAt',
          isGreaterThanOrEqualTo: Timestamp.fromDate(from),
        )
        .limit(1000)
        .get();

    // Filtro en memoria para evitar índice compuesto
    final sales = snap.docs
        .map(SaleModel.fromFirestore)
        .where((s) => s.status == SaleStatus.completed)
        .toList();

    final branchSales = <String, List<SaleModel>>{};
    for (final s in sales) {
      final key = s.branchId.isNotEmpty ? s.branchId : 'principal';
      (branchSales[key] ??= []).add(s);
    }

    if (branchSales.isEmpty) return [];

    return branchSales.entries.map((entry) {
      final list = entry.value;
      final first = list.first;
      return BranchModel(
        id: entry.key,
        name: first.branchName.isNotEmpty ? first.branchName : 'Principal',
        totalSales: list.fold<double>(0, (s, sale) => s + sale.total),
        totalInvoices: list.length,
        totalExpenses: 0,
        isActive: true,
      );
    }).toList()
      ..sort((a, b) => b.totalSales.compareTo(a.totalSales));
  },
);

// ─── Pantalla ─────────────────────────────────────────────────────────────────

class BranchesReportScreen extends ConsumerWidget {
  const BranchesReportScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final businessId = ref.watch(activeBusinessIdProvider);
    if (businessId == null || businessId.isEmpty) {
      return const Scaffold(body: AppErrorState(message: 'No hay sesión activa.'));
    }

    final branchesAsync = ref.watch(_branchesProvider(businessId));

    return ReportScaffold(
      title: 'Sucursales',
      actions: [
        IconButton(
          icon: const Icon(Icons.refresh_rounded),
          onPressed: () => ref.invalidate(_branchesProvider(businessId)),
        ),
      ],
      body: branchesAsync.when(
        loading: () => const _BranchesShimmer(),
        error: (e, _) => AppErrorState(
          message: e.toString(),
          onRetry: () => ref.invalidate(_branchesProvider(businessId)),
        ),
        data: (branches) {
          if (branches.isEmpty) {
            return const AppEmptyState(
              title: 'Sin ventas este mes',
              message: 'No se encontraron ventas registradas en el mes actual.',
              icon: Icons.store_outlined,
            );
          }

          final totalSales =
              branches.fold<double>(0, (s, b) => s + b.totalSales);
          final totalInvoices =
              branches.fold<int>(0, (s, b) => s + b.totalInvoices);

          return ListView(
            padding: const EdgeInsets.only(bottom: 32),
            children: [
              _HeroCard(
                topBranch: branches.first,
                totalSales: totalSales,
                totalInvoices: totalInvoices,
                branchCount: branches.length,
              ),
              const AppSectionHeader(title: 'Comparativa del mes actual'),
              ...branches.asMap().entries.map(
                    (entry) => _BranchCard(
                      branch: entry.value,
                      rank: entry.key + 1,
                      totalSales: totalSales,
                    ),
                  ),
            ],
          );
        },
      ),
    );
  }
}

class _HeroCard extends StatelessWidget {
  final BranchModel topBranch;
  final double totalSales;
  final int totalInvoices;
  final int branchCount;

  const _HeroCard({
    required this.topBranch,
    required this.totalSales,
    required this.totalInvoices,
    required this.branchCount,
  });

  @override
  Widget build(BuildContext context) {
    final compact = isCompact(context);
    final h = hPad(context);
    return Padding(
      padding: EdgeInsets.fromLTRB(h, compact ? 10 : 16, h, 0),
      child: Container(
        padding: EdgeInsets.all(compact ? 14 : 20),
        decoration: BoxDecoration(
          gradient: AppColors.primaryGradient,
          borderRadius: BorderRadius.circular(compact ? 16 : 20),
          boxShadow: [
            BoxShadow(
              color: AppColors.primary.withValues(alpha: 0.25),
              blurRadius: 20,
              offset: const Offset(0, 8),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  '🏆  Líder del mes',
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.85),
                    fontSize: compact ? 11 : 12,
                  ),
                ),
                const Spacer(),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(
                    '$branchCount sucursal${branchCount > 1 ? 'es' : ''}',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            SizedBox(height: compact ? 4 : 6),
            Text(
              topBranch.name,
              style: TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.w800,
                fontSize: compact ? 18 : 24,
              ),
            ),
            SizedBox(height: compact ? 10 : 14),
            Container(
              padding: EdgeInsets.all(compact ? 10 : 12),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: _Stat(
                      'Total ventas',
                      FormatHelpers.currency(totalSales),
                    ),
                  ),
                  Container(
                    width: 1,
                    height: 30,
                    color: Colors.white.withValues(alpha: 0.3),
                  ),
                  Expanded(
                    child: _Stat('Facturas', '$totalInvoices'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  final String label;
  final String value;
  const _Stat(this.label, this.value);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            value,
            style: const TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.w700,
              fontSize: 16,
            ),
          ),
          Text(
            label,
            style: TextStyle(
              color: Colors.white.withValues(alpha: 0.7),
              fontSize: 11,
            ),
          ),
        ],
      ),
    );
  }
}

class _BranchCard extends StatelessWidget {
  final BranchModel branch;
  final int rank;
  final double totalSales;

  const _BranchCard({
    required this.branch,
    required this.rank,
    required this.totalSales,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final compact = MediaQuery.sizeOf(context).width < 400;
    final h = compact ? 12.0 : 16.0;
    final share = totalSales > 0 ? branch.totalSales / totalSales : 0.0;
    final color =
        AppColors.chartColors[(rank - 1) % AppColors.chartColors.length];
    final isTop = rank == 1;

    return Padding(
      padding: EdgeInsets.fromLTRB(h, 0, h, compact ? 7 : 10),
      child: Container(
        padding: EdgeInsets.all(compact ? 11 : 16),
        decoration: BoxDecoration(
          color: Theme.of(context).cardColor,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: isTop
                ? color.withValues(alpha: 0.4)
                : (isDark ? AppColors.darkBorder : AppColors.lightBorder),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 36,
                  height: 36,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    '$rank',
                    style: TextStyle(
                      fontWeight: FontWeight.w800,
                      color: color,
                      fontSize: 16,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        branch.name,
                        style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 15,
                        ),
                      ),
                      Text(
                        '${branch.totalInvoices} facturas · ${(share * 100).toStringAsFixed(1)}% del total',
                        style: const TextStyle(
                          color: AppColors.textSecondary,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
                Text(
                  FormatHelpers.currency(branch.totalSales),
                  style: const TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 15,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: LinearProgressIndicator(
                value: share.clamp(0.0, 1.0),
                minHeight: 6,
                color: color,
                backgroundColor:
                    isDark ? AppColors.darkBorder : AppColors.lightBorder,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BranchesShimmer extends StatelessWidget {
  const _BranchesShimmer();

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Shimmer.fromColors(
      baseColor: isDark ? const Color(0xFF1E293B) : Colors.grey.shade200,
      highlightColor: isDark ? const Color(0xFF334155) : Colors.grey.shade50,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _box(150, 20),
          const SizedBox(height: 20),
          for (var i = 0; i < 4; i++) ...[
            _box(100, 16),
            const SizedBox(height: 10),
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

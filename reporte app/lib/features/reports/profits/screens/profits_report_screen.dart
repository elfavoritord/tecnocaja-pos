import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shimmer/shimmer.dart';

import '../../../../core/constants/app_colors.dart';
import '../../../../core/utils/format_helpers.dart';
import '../../../../data/models/sale_model.dart';
import '../../../../data/repositories/sales_repository.dart';
import '../../../../shared/widgets/app_empty_state.dart';
import '../../../../shared/widgets/app_filter_bar.dart';
import '../../../../shared/widgets/app_section_header.dart';
import '../../../../shared/widgets/report_scaffold.dart';
import '../../../auth/providers/auth_provider.dart';
import '../../utils/report_date_range.dart';

// ─── Modelos internos ────────────────────────────────────────────────────────

class _ProfitParams {
  final DateRange range;
  final String businessId;
  const _ProfitParams({required this.range, required this.businessId});

  @override
  bool operator ==(Object other) =>
      other is _ProfitParams &&
      other.businessId == businessId &&
      other.range.from == range.from &&
      other.range.to == range.to;

  @override
  int get hashCode => Object.hash(businessId, range.from, range.to);
}

class _ProfitOverview {
  final double revenue;
  final double profit;
  final double marginPercent;
  final int totalSales;
  final List<MapEntry<String, double>> categoryProfit;
  final List<MapEntry<String, double>> branchProfit;
  final List<_ProductProfit> topProducts;

  const _ProfitOverview({
    required this.revenue,
    required this.profit,
    required this.marginPercent,
    required this.totalSales,
    required this.categoryProfit,
    required this.branchProfit,
    required this.topProducts,
  });
}

class _ProductProfit {
  final String name;
  final String category;
  final double revenue;
  final double profit;
  final double quantity;

  const _ProductProfit({
    required this.name,
    required this.category,
    required this.revenue,
    required this.profit,
    required this.quantity,
  });
}

// ─── Provider (100% Firestore, sin servidor HTTP) ────────────────────────────

final _profitsProvider = FutureProvider.autoDispose
    .family<_ProfitOverview, _ProfitParams>((ref, params) async {
  // NOTA: No filtramos 'status' en Firestore para evitar requerir índice
  // compuesto (createdAt + status). Se filtra en memoria abajo.
  final snap = await FirebaseFirestore.instance
      .collection('businesses')
      .doc(params.businessId)
      .collection('sales')
      .where(
        'createdAt',
        isGreaterThanOrEqualTo: Timestamp.fromDate(params.range.from),
      )
      .where(
        'createdAt',
        isLessThanOrEqualTo: Timestamp.fromDate(params.range.to),
      )
      .limit(600)
      .get();

  // Filtro en memoria: solo ventas completadas
  final sales = snap.docs
      .map(SaleModel.fromFirestore)
      .where((s) => s.status == SaleStatus.completed)
      .toList();

  final revenue = sales.fold<double>(0, (s, sale) => s + sale.total);
  final profit = sales.fold<double>(0, (s, sale) => s + sale.profit);
  final margin = revenue > 0 ? (profit / revenue) * 100 : 0.0;

  final catMap = <String, double>{};
  final branchMap = <String, double>{};
  final prodMap = <String, _ProductProfit>{};

  for (final sale in sales) {
    final branch =
        sale.branchName.isNotEmpty ? sale.branchName : 'Principal';
    branchMap[branch] = (branchMap[branch] ?? 0) + sale.profit;

    for (final item in sale.items) {
      final cat =
          item.category.isNotEmpty ? item.category : 'Sin categoría';
      catMap[cat] = (catMap[cat] ?? 0) + item.profit;

      if (item.productId.isNotEmpty) {
        final prev = prodMap[item.productId];
        prodMap[item.productId] = _ProductProfit(
          name: item.productName,
          category: cat,
          revenue: (prev?.revenue ?? 0) + item.totalAfterDiscount,
          profit: (prev?.profit ?? 0) + item.profit,
          quantity: (prev?.quantity ?? 0) + item.quantity,
        );
      }
    }
  }

  return _ProfitOverview(
    revenue: revenue,
    profit: profit,
    marginPercent: margin,
    totalSales: sales.length,
    categoryProfit: catMap.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value)),
    branchProfit: branchMap.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value)),
    topProducts: (prodMap.values.toList()
          ..sort((a, b) => b.profit.compareTo(a.profit)))
        .take(10)
        .toList(),
  );
});

// ─── Pantalla principal ───────────────────────────────────────────────────────

class ProfitsReportScreen extends ConsumerStatefulWidget {
  const ProfitsReportScreen({super.key});

  @override
  ConsumerState<ProfitsReportScreen> createState() =>
      _ProfitsReportScreenState();
}

class _ProfitsReportScreenState extends ConsumerState<ProfitsReportScreen> {
  DateFilter _filter = DateFilter.thisMonth;

  DateRange get _range => stableRangeForFilter(_filter);

  @override
  Widget build(BuildContext context) {
    final businessId = ref.watch(activeBusinessIdProvider);
    if (businessId == null || businessId.isEmpty) {
      return const Scaffold(
        body: AppErrorState(message: 'No hay sesión activa.'),
      );
    }

    final params = _ProfitParams(range: _range, businessId: businessId);
    final overviewAsync = ref.watch(_profitsProvider(params));

    return ReportScaffold(
      title: 'Ganancias',
      actions: [
        IconButton(
          icon: const Icon(Icons.refresh_rounded),
          tooltip: 'Actualizar',
          onPressed: () => ref.invalidate(_profitsProvider),
        ),
      ],
      body: Column(
        children: [
          const SizedBox(height: 8),
          AppFilterBar(
            selected: _filter,
            onChanged: (v) => setState(() => _filter = v),
          ),
          Expanded(
            child: overviewAsync.when(
              loading: () => const _ProfitsShimmer(),
              error: (e, _) => AppErrorState(
                message: e.toString(),
                onRetry: () => ref.invalidate(_profitsProvider),
              ),
              data: (overview) {
                if (overview.totalSales == 0) {
                  return const AppEmptyState(
                    title: 'Sin ventas en este periodo',
                    message:
                        'No hay ventas completadas para calcular ganancias.',
                    icon: Icons.trending_up_rounded,
                  );
                }
                return _ProfitsContent(overview: overview);
              },

            ),
          ),
        ],
      ),
    );
  }
}

// ─── Contenido ────────────────────────────────────────────────────────────────

class _ProfitsContent extends StatelessWidget {
  final _ProfitOverview overview;
  const _ProfitsContent({required this.overview});

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.only(bottom: 40),
      children: [
        _HeroCard(overview: overview),
        if (overview.categoryProfit.isNotEmpty)
          _CategorySection(overview: overview),
        if (overview.branchProfit.length > 1)
          _BranchSection(overview: overview),
        if (overview.topProducts.isNotEmpty)
          _TopProductsSection(overview: overview),
      ],
    );
  }
}

// ─── Hero card ───────────────────────────────────────────────────────────────

class _HeroCard extends StatelessWidget {
  final _ProfitOverview overview;
  const _HeroCard({required this.overview});

  @override
  Widget build(BuildContext context) {
    final compact = isCompact(context);
    final isGood = overview.marginPercent >= 20;
    return Padding(
      padding: EdgeInsets.fromLTRB(hPad(context), compact ? 8 : 12, hPad(context), 0),
      child: Container(
        padding: EdgeInsets.symmetric(
          horizontal: compact ? 12 : 16,
          vertical: compact ? 12 : 14,
        ),
        decoration: BoxDecoration(
          gradient: isGood
              ? AppColors.successGradient
              : AppColors.primaryGradient,
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(
              color: (isGood ? AppColors.success : AppColors.primary)
                  .withValues(alpha: 0.22),
              blurRadius: 14,
              offset: const Offset(0, 6),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  'Ganancia estimada',
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.8),
                    fontSize: 11,
                  ),
                ),
                const Spacer(),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(
                    '${overview.totalSales} ventas',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 3),
            Text(
              FormatHelpers.currency(overview.profit),
              style: TextStyle(
                color: Colors.white,
                fontSize: compact ? 22 : 26,
                fontWeight: FontWeight.w800,
                letterSpacing: -0.5,
              ),
            ),
            SizedBox(height: compact ? 8 : 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: _HeroStat(
                      'Ingresos totales',
                      FormatHelpers.currency(overview.revenue),
                      Icons.payments_outlined,
                    ),
                  ),
                  Container(
                    width: 1,
                    height: 28,
                    color: Colors.white.withValues(alpha: 0.3),
                  ),
                  Expanded(
                    child: _HeroStat(
                      'Margen bruto',
                      '${overview.marginPercent.toStringAsFixed(1)}%',
                      Icons.percent_rounded,
                    ),
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

class _HeroStat extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;

  const _HeroStat(this.label, this.value, this.icon);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6),
      child: Row(
        children: [
          Icon(icon, color: Colors.white.withValues(alpha: 0.7), size: 14),
          const SizedBox(width: 6),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                value,
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w700,
                  fontSize: 13,
                ),
              ),
              Text(
                label,
                style: TextStyle(
                  color: Colors.white.withValues(alpha: 0.7),
                  fontSize: 10,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ─── Categorías ───────────────────────────────────────────────────────────────

class _CategorySection extends StatelessWidget {
  final _ProfitOverview overview;
  const _CategorySection({required this.overview});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final cats = overview.categoryProfit.take(7).toList();
    final maxVal = cats.isEmpty ? 1.0 : cats.first.value;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const AppSectionHeader(title: 'Ganancia por categoría'),
        Padding(
          padding: EdgeInsets.symmetric(horizontal: hPad(context)),
          child: Container(
            padding: EdgeInsets.all(isCompact(context) ? 12 : 16),
            decoration: BoxDecoration(
              color: Theme.of(context).cardColor,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(
                color: isDark ? AppColors.darkBorder : AppColors.lightBorder,
              ),
            ),
            child: Column(
              children: cats.asMap().entries.map((entry) {
                final i = entry.key;
                final e = entry.value;
                final pct = maxVal > 0 ? (e.value / maxVal).clamp(0.0, 1.0) : 0.0;
                final color =
                    AppColors.chartColors[i % AppColors.chartColors.length];

                return Padding(
                  padding: EdgeInsets.only(bottom: isCompact(context) ? 10 : 14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                            child: Row(
                              children: [
                                Container(
                                  width: 10,
                                  height: 10,
                                  decoration: BoxDecoration(
                                    color: color,
                                    shape: BoxShape.circle,
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    e.key,
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w600,
                                      fontSize: 13,
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          Text(
                            FormatHelpers.currency(e.value),
                            style: const TextStyle(
                              fontWeight: FontWeight.w700,
                              fontSize: 13,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: LinearProgressIndicator(
                          value: pct,
                          minHeight: 8,
                          color: color,
                          backgroundColor: isDark
                              ? AppColors.darkBorder
                              : AppColors.lightBorder,
                        ),
                      ),
                    ],
                  ),
                );
              }).toList(),
            ),
          ),
        ),
      ],
    );
  }
}

// ─── Sucursales ───────────────────────────────────────────────────────────────

class _BranchSection extends StatelessWidget {
  final _ProfitOverview overview;
  const _BranchSection({required this.overview});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const AppSectionHeader(title: 'Ganancia por sucursal'),
        ...overview.branchProfit.map(
          (entry) => Padding(
            padding: EdgeInsets.fromLTRB(hPad(context), 0, hPad(context), 6),
            child: Container(
              padding: EdgeInsets.all(isCompact(context) ? 10 : 14),
              decoration: BoxDecoration(
                color: Theme.of(context).cardColor,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                  color:
                      isDark ? AppColors.darkBorder : AppColors.lightBorder,
                ),
              ),
              child: Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: AppColors.infoLight,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Icon(
                      Icons.store_outlined,
                      color: AppColors.info,
                      size: 20,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      entry.key,
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                  ),
                  Text(
                    FormatHelpers.currency(entry.value),
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 15,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

// ─── Top productos ────────────────────────────────────────────────────────────

class _TopProductsSection extends StatelessWidget {
  final _ProfitOverview overview;
  const _TopProductsSection({required this.overview});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const AppSectionHeader(title: 'Productos más rentables'),
        ...overview.topProducts.asMap().entries.map((entry) {
          final i = entry.key;
          final p = entry.value;
          final margin =
              p.revenue > 0 ? (p.profit / p.revenue) * 100 : 0.0;
          final isTop = i < 3;

          return Padding(
            padding: EdgeInsets.fromLTRB(hPad(context), 0, hPad(context), 6),
            child: Container(
              padding: EdgeInsets.all(isCompact(context) ? 10 : 14),
              decoration: BoxDecoration(
                color: Theme.of(context).cardColor,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                  color: isTop
                      ? AppColors.success.withValues(alpha: 0.3)
                      : (isDark
                          ? AppColors.darkBorder
                          : AppColors.lightBorder),
                ),
              ),
              child: Row(
                children: [
                  Container(
                    width: 34,
                    height: 34,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: isTop
                          ? AppColors.success.withValues(alpha: 0.12)
                          : (isDark
                              ? AppColors.darkBorder
                              : AppColors.lightSurfaceVariant),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      '#${i + 1}',
                      style: TextStyle(
                        fontWeight: FontWeight.w800,
                        fontSize: 12,
                        color: isTop
                            ? AppColors.success
                            : AppColors.textSecondary,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          p.name,
                          style: const TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 13,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        Text(
                          '${p.quantity.toStringAsFixed(0)} uds · ${p.category}',
                          style: const TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        FormatHelpers.currency(p.profit),
                        style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 14,
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 7,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: AppColors.successLight,
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          '${margin.toStringAsFixed(1)}%',
                          style: const TextStyle(
                            color: AppColors.success,
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
        }),
      ],
    );
  }
}

// ─── Shimmer loading ─────────────────────────────────────────────────────────

class _ProfitsShimmer extends StatelessWidget {
  const _ProfitsShimmer();

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Shimmer.fromColors(
      baseColor: isDark ? const Color(0xFF1E293B) : Colors.grey.shade200,
      highlightColor: isDark ? const Color(0xFF334155) : Colors.grey.shade50,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 40),
        children: [
          _box(160, 20),
          const SizedBox(height: 20),
          _box(220, 16),
          const SizedBox(height: 16),
          for (var i = 0; i < 5; i++) ...[
            _box(72, 14),
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

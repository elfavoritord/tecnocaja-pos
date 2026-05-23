import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/constants/app_colors.dart';
import '../../../../core/utils/format_helpers.dart';
import '../../../../data/models/sale_model.dart';
import '../../../../data/repositories/sales_repository.dart';
import '../../utils/report_date_range.dart';
import '../../../../shared/widgets/app_drawer.dart';
import '../../../../shared/widgets/app_empty_state.dart';
import '../../../../shared/widgets/app_filter_bar.dart';
import '../../../../shared/widgets/app_section_header.dart';
import '../../../auth/providers/auth_provider.dart';

/// Lee el resumen de ventas directamente desde Firestore.
/// No requiere el servidor HTTP de NovaPOS.
final _salesProvider = FutureProvider.family<SalesSummary, _SalesParams>((
  ref,
  params,
) async {
  final businessId = ref.watch(activeBusinessIdProvider);
  if (businessId == null || businessId.isEmpty) {
    throw StateError('No hay sesión activa. Inicia sesión nuevamente.');
  }
  return SalesRepository().getSalesSummary(
    businessId: businessId,
    filter: SalesFilter(
      dateRange: DateRange(
        from: params.dateRange.from,
        to: params.dateRange.to,
      ),
    ),
  );
});

class _SalesParams {
  final DateRange dateRange;
  const _SalesParams(this.dateRange);

  @override
  bool operator ==(Object other) =>
      other is _SalesParams &&
      other.dateRange.from == dateRange.from &&
      other.dateRange.to == dateRange.to;

  @override
  int get hashCode => dateRange.from.hashCode ^ dateRange.to.hashCode;
}

class SalesReportScreen extends ConsumerStatefulWidget {
  const SalesReportScreen({super.key});

  @override
  ConsumerState<SalesReportScreen> createState() => _SalesReportScreenState();
}

class _SalesReportScreenState extends ConsumerState<SalesReportScreen> {
  DateFilter _filter = DateFilter.today;

  DateRange get _dateRange => stableRangeForFilter(_filter);

  @override
  Widget build(BuildContext context) {
    final summaryAsync = ref.watch(_salesProvider(_SalesParams(_dateRange)));

    return Scaffold(
      drawer: const AppDrawer(),
      appBar: AppBar(title: const Text('Reporte de Ventas'), actions: [IconButton(icon: const Icon(Icons.home_rounded), tooltip: 'Ir al inicio', onPressed: () => context.go('/dashboard'))]),
      body: Column(
        children: [
          const SizedBox(height: 8),
          AppFilterBar(
            selected: _filter,
            onChanged: (f) => setState(() => _filter = f),
          ),
          Expanded(
            child: summaryAsync.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => AppErrorState(
                message: e.toString(),
                onRetry: () => ref.invalidate(_salesProvider),
              ),
              data: (summary) => summary.sales.isEmpty
                  ? const AppEmptyState(
                      title: 'Sin ventas',
                      message: 'No hay ventas en el período seleccionado',
                      icon: Icons.point_of_sale_rounded,
                    )
                  : _buildContent(summary),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildContent(SalesSummary s) {
    return ListView(
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        _buildTotals(s),
        _buildPaymentChart(s),
        _buildBranchBreakdown(s),
        _buildSalesList(s),
      ],
    );
  }

  Widget _buildTotals(SalesSummary s) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: Column(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            decoration: BoxDecoration(
              gradient: AppColors.primaryGradient,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Column(
              children: [
                _bigStat('Total Bruto', FormatHelpers.currency(s.totalGross)),
                const Divider(color: Colors.white24, height: 18),
                Row(
                  children: [
                    Expanded(
                      child: _miniStat(
                        'Facturas',
                        '${s.totalInvoices}',
                        Icons.receipt_outlined,
                      ),
                    ),
                    Expanded(
                      child: _miniStat(
                        'Descuentos',
                        FormatHelpers.currency(s.totalDiscount),
                        Icons.discount_outlined,
                      ),
                    ),
                    Expanded(
                      child: _miniStat(
                        'ITBIS',
                        FormatHelpers.currency(s.totalTax),
                        Icons.percent_rounded,
                      ),
                    ),
                  ],
                ),
                const Divider(color: Colors.white24, height: 18),
                Row(
                  children: [
                    Expanded(
                      child: _miniStat(
                        'Total Neto',
                        FormatHelpers.currency(s.totalNet),
                        Icons.attach_money_rounded,
                      ),
                    ),
                    Expanded(
                      child: _miniStat(
                        'Ganancia',
                        FormatHelpers.currency(s.totalProfit),
                        Icons.trending_up_rounded,
                      ),
                    ),
                    Expanded(
                      child: _miniStat(
                        'Ticket Prom.',
                        FormatHelpers.currency(s.avgTicket),
                        Icons.confirmation_number_outlined,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          if (s.cancelledCount > 0)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: AppColors.errorLight,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Row(
                  children: [
                    const Icon(
                      Icons.cancel_outlined,
                      color: AppColors.error,
                      size: 18,
                    ),
                    const SizedBox(width: 8),
                    Text(
                      '${s.cancelledCount} ventas anuladas en este período',
                      style: const TextStyle(
                        color: AppColors.error,
                        fontWeight: FontWeight.w500,
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _bigStat(String label, String value) {
    return Column(
      children: [
        Text(
          label,
          style: TextStyle(
            color: Colors.white.withValues(alpha: 0.75),
            fontSize: 12,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 24,
            fontWeight: FontWeight.w800,
            letterSpacing: -0.5,
          ),
        ),
      ],
    );
  }

  Widget _miniStat(String label, String value, IconData icon) {
    return Column(
      children: [
        Icon(icon, color: Colors.white70, size: 16),
        const SizedBox(height: 3),
        Text(
          value,
          style: const TextStyle(
            color: Colors.white,
            fontWeight: FontWeight.w700,
            fontSize: 12,
          ),
        ),
        Text(
          label,
          style: TextStyle(
            color: Colors.white.withValues(alpha: 0.65),
            fontSize: 10,
          ),
        ),
      ],
    );
  }

  Widget _buildPaymentChart(SalesSummary s) {
    if (s.byPaymentMethod.isEmpty) {
      return const SizedBox.shrink();
    }

    final entries = s.byPaymentMethod.entries.toList();
    final total = entries.fold(0.0, (acc, e) => acc + e.value);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AppSectionHeader(title: 'Por método de pago'),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 0),
          child: Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Theme.of(context).cardColor,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(
                color: Theme.of(context).brightness == Brightness.dark
                    ? AppColors.darkBorder
                    : AppColors.lightBorder,
              ),
            ),
            child: Row(
              children: [
                SizedBox(
                  height: 140,
                  width: 140,
                  child: PieChart(
                    PieChartData(
                      sections: entries.asMap().entries.map((e) {
                        final pct = total > 0
                            ? (e.value.value / total) * 100
                            : 0;
                        return PieChartSectionData(
                          value: e.value.value,
                          color:
                              AppColors.chartColors[e.key %
                                  AppColors.chartColors.length],
                          title: '${pct.toStringAsFixed(0)}%',
                          radius: 50,
                          titleStyle: const TextStyle(
                            color: Colors.white,
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                          ),
                        );
                      }).toList(),
                      sectionsSpace: 2,
                      centerSpaceRadius: 24,
                    ),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: entries.asMap().entries.map((e) {
                      final color = AppColors
                          .chartColors[e.key % AppColors.chartColors.length];
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 10),
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
                                e.value.key,
                                style: const TextStyle(fontSize: 13),
                              ),
                            ),
                            Text(
                              FormatHelpers.currency(e.value.value),
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                      );
                    }).toList(),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildBranchBreakdown(SalesSummary s) {
    if (s.byBranch.isEmpty || s.byBranch.length <= 1) {
      return const SizedBox.shrink();
    }

    final sorted = s.byBranch.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    final maxVal = sorted.first.value;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AppSectionHeader(title: 'Por sucursal'),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Theme.of(context).cardColor,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(
                color: Theme.of(context).brightness == Brightness.dark
                    ? AppColors.darkBorder
                    : AppColors.lightBorder,
              ),
            ),
            child: Column(
              children: sorted.asMap().entries.map((e) {
                final pct = maxVal > 0 ? e.value.value / maxVal : 0;
                return Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(
                            e.value.key,
                            style: const TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                          Text(
                            FormatHelpers.currency(e.value.value),
                            style: const TextStyle(fontWeight: FontWeight.w700),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(4),
                        child: LinearProgressIndicator(
                          value: pct.toDouble(),
                          backgroundColor: AppColors.lightBorder,
                          color:
                              AppColors.chartColors[e.key %
                                  AppColors.chartColors.length],
                          minHeight: 6,
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

  Widget _buildSalesList(SalesSummary s) {
    final completed = s.sales
        .where((s) => s.status == SaleStatus.completed)
        .take(20)
        .toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AppSectionHeader(
          title: 'Últimas ventas',
          actionLabel: 'Ver todas',
          onAction: () {},
        ),
        ...completed.map((sale) => _SaleTile(sale: sale)),
      ],
    );
  }
}

class _SaleTile extends StatelessWidget {
  final SaleModel sale;
  const _SaleTile({required this.sale});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Theme.of(context).cardColor,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: Theme.of(context).brightness == Brightness.dark
                ? AppColors.darkBorder
                : AppColors.lightBorder,
          ),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: AppColors.successLight,
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Icon(
                Icons.receipt_long_outlined,
                color: AppColors.success,
                size: 18,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    sale.invoiceNumber ?? 'Factura',
                    style: const TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 13,
                    ),
                  ),
                  Text(
                    '${sale.cashierName} · ${sale.paymentMethod.label}',
                    style: const TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  FormatHelpers.currency(sale.total),
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 14,
                  ),
                ),
                Text(
                  DateHelpers.time(sale.createdAt),
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

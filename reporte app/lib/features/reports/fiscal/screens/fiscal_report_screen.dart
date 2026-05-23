import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/constants/app_colors.dart';
import '../../../../core/utils/format_helpers.dart';
import '../../../../data/models/sale_model.dart';
import '../../../../data/repositories/sales_repository.dart';
import '../../../../shared/widgets/app_drawer.dart';
import '../../../../shared/widgets/app_empty_state.dart';
import '../../../../shared/widgets/app_filter_bar.dart';
import '../../../../shared/widgets/app_section_header.dart';
import '../../../auth/providers/auth_provider.dart';
import '../../utils/report_date_range.dart';

final _fiscalProvider = FutureProvider.family<_FiscalOverview, _FiscalParams>((
  ref,
  params,
) async {
  final businessId = ref.watch(activeBusinessIdProvider);
  if (businessId == null || businessId.isEmpty) {
    throw StateError('No hay sesión activa. Inicia sesión nuevamente.');
  }

  final branchIds = ref.watch(activeBranchIdsProvider);
  final snapshot = await FirebaseFirestore.instance
      .collection('businesses')
      .doc(businessId)
      .collection('sales')
      .where(
        'createdAt',
        isGreaterThanOrEqualTo: Timestamp.fromDate(params.range.from),
      )
      .where('createdAt', isLessThan: Timestamp.fromDate(params.range.to))
      .orderBy('createdAt', descending: true)
      .limit(500)
      .get();

  final normalizedBranchIds = (branchIds ?? [])
      .map((value) => value.trim().toLowerCase())
      .where((value) => value.isNotEmpty)
      .toSet();

  final sales = snapshot.docs.map(SaleModel.fromFirestore).where((sale) {
    if (normalizedBranchIds.isEmpty) return true;
    return normalizedBranchIds.contains(sale.branchId.trim().toLowerCase());
  }).toList();

  final byTypeMap = <String, double>{};
  double taxCollected = 0;
  int emitted = 0;
  int cancelled = 0;
  int pending = 0;

  for (final sale in sales) {
    final invoiceType = (sale.invoiceType ?? '').trim().isEmpty
        ? 'Sin NCF'
        : sale.invoiceType!.trim();
    byTypeMap[invoiceType] = (byTypeMap[invoiceType] ?? 0) + sale.total;
    taxCollected += sale.tax;
    emitted += 1;
    if (sale.status == SaleStatus.cancelled) {
      cancelled += 1;
    } else if (sale.status == SaleStatus.pending) {
      pending += 1;
    }
  }

  return _FiscalOverview(
    sales: sales,
    emitted: emitted,
    cancelled: cancelled,
    pending: pending,
    errors: 0,
    taxCollected: taxCollected,
    byType: byTypeMap.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value)),
  );
});

class FiscalReportScreen extends ConsumerStatefulWidget {
  const FiscalReportScreen({super.key});

  @override
  ConsumerState<FiscalReportScreen> createState() => _FiscalReportScreenState();
}

class _FiscalReportScreenState extends ConsumerState<FiscalReportScreen> {
  DateFilter _filter = DateFilter.thisMonth;

  DateRange get _range => stableRangeForFilter(_filter);

  @override
  Widget build(BuildContext context) {
    final overviewAsync = ref.watch(_fiscalProvider(_FiscalParams(_range)));

    return Scaffold(
      drawer: const AppDrawer(),
      appBar: AppBar(
        title: const Text('Reporte Fiscal'),
        actions: [
          IconButton(
            icon: const Icon(Icons.home_rounded),
            tooltip: 'Ir al inicio',
            onPressed: () => context.go('/dashboard'),
          ),
        ],
      ),
      body: Column(
        children: [
          const SizedBox(height: 8),
          AppFilterBar(
            selected: _filter,
            onChanged: (value) => setState(() => _filter = value),
          ),
          Expanded(
            child: overviewAsync.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (error, stackTrace) => AppErrorState(
                message: error.toString(),
                onRetry: () => ref.invalidate(_fiscalProvider),
              ),
              data: (overview) {
                if (overview.sales.isEmpty) {
                  return const AppEmptyState(
                    title: 'Sin facturacion en el periodo',
                    message: 'No se encontraron comprobantes para este filtro.',
                    icon: Icons.description_outlined,
                  );
                }

                return ListView(
                  padding: const EdgeInsets.only(bottom: 32),
                  children: [
                    _FiscalHero(overview: overview),
                    _FiscalTypesSection(overview: overview),
                    _FiscalRecentSection(overview: overview),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _FiscalHero extends StatelessWidget {
  final _FiscalOverview overview;

  const _FiscalHero({required this.overview});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          gradient: AppColors.primaryGradient,
          borderRadius: BorderRadius.circular(20),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Resumen fiscal',
              style: TextStyle(
                color: Colors.white.withValues(alpha: 0.76),
                fontSize: 13,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              '${overview.emitted} comprobantes',
              style: const TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.w800,
                fontSize: 28,
              ),
            ),
            const SizedBox(height: 14),
            Wrap(
              spacing: 16,
              runSpacing: 12,
              children: [
                _FiscalStat(
                  label: 'ITBIS cobrado',
                  value: FormatHelpers.currency(overview.taxCollected),
                ),
                _FiscalStat(label: 'Anuladas', value: '${overview.cancelled}'),
                _FiscalStat(label: 'Pendientes', value: '${overview.pending}'),
                _FiscalStat(label: 'Con error', value: '${overview.errors}'),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _FiscalStat extends StatelessWidget {
  final String label;
  final String value;

  const _FiscalStat({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          value,
          style: const TextStyle(
            color: Colors.white,
            fontWeight: FontWeight.w700,
            fontSize: 14,
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
    );
  }
}

class _FiscalTypesSection extends StatelessWidget {
  final _FiscalOverview overview;

  const _FiscalTypesSection({required this.overview});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const AppSectionHeader(title: 'Totales por tipo de comprobante'),
        ...overview.byType.map((entry) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: ListTile(
              tileColor: Theme.of(context).cardColor,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
                side: BorderSide(
                  color: Theme.of(context).brightness == Brightness.dark
                      ? AppColors.darkBorder
                      : AppColors.lightBorder,
                ),
              ),
              leading: const CircleAvatar(
                backgroundColor: AppColors.infoLight,
                child: Icon(
                  Icons.request_quote_outlined,
                  color: AppColors.info,
                ),
              ),
              title: Text(entry.key),
              trailing: Text(
                FormatHelpers.currency(entry.value),
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
          );
        }),
      ],
    );
  }
}

class _FiscalRecentSection extends StatelessWidget {
  final _FiscalOverview overview;

  const _FiscalRecentSection({required this.overview});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const AppSectionHeader(title: 'Comprobantes recientes'),
        ...overview.sales.take(12).map((sale) {
          final isCancelled = sale.status == SaleStatus.cancelled;
          return Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Theme.of(context).cardColor,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                  color: isCancelled
                      ? AppColors.error.withValues(alpha: 0.4)
                      : (Theme.of(context).brightness == Brightness.dark
                            ? AppColors.darkBorder
                            : AppColors.lightBorder),
                ),
              ),
              child: Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: isCancelled
                          ? AppColors.errorLight
                          : AppColors.infoLight,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Icon(
                      isCancelled
                          ? Icons.cancel_outlined
                          : Icons.receipt_long_outlined,
                      color: isCancelled ? AppColors.error : AppColors.info,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          sale.invoiceNumber ?? 'Factura sin numero',
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                        Text(
                          '${sale.invoiceType ?? 'Sin tipo'} · ${sale.branchName}',
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
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                      Text(
                        DateHelpers.relativeTime(sale.createdAt),
                        style: const TextStyle(
                          color: AppColors.textSecondary,
                          fontSize: 11,
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

class _FiscalParams {
  final DateRange range;

  const _FiscalParams(this.range);

  @override
  bool operator ==(Object other) {
    return other is _FiscalParams &&
        other.range.from == range.from &&
        other.range.to == range.to;
  }

  @override
  int get hashCode => Object.hash(range.from, range.to);
}

class _FiscalOverview {
  final List<SaleModel> sales;
  final int emitted;
  final int cancelled;
  final int pending;
  final int errors;
  final double taxCollected;
  final List<MapEntry<String, double>> byType;

  const _FiscalOverview({
    required this.sales,
    required this.emitted,
    required this.cancelled,
    required this.pending,
    required this.errors,
    required this.taxCollected,
    required this.byType,
  });
}

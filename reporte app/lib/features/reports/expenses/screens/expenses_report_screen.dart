import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/constants/app_colors.dart';
import '../../../../core/utils/format_helpers.dart';
import '../../../../data/models/expense_model.dart';
import '../../../../data/repositories/sales_repository.dart';
import '../../../../shared/widgets/app_drawer.dart';
import '../../../../shared/widgets/app_empty_state.dart';
import '../../../../shared/widgets/app_filter_bar.dart';
import '../../../../shared/widgets/app_section_header.dart';
import '../../utils/report_date_range.dart';
import '../../../auth/providers/auth_provider.dart';

/// Lee los gastos directamente desde Firestore.
/// No requiere el servidor HTTP de NovaPOS.
final _expensesProvider =
    FutureProvider.family<_ExpensesOverview, _ExpenseParams>((
      ref,
      params,
    ) async {
      final businessId = ref.watch(activeBusinessIdProvider);
      if (businessId == null || businessId.isEmpty) {
        throw StateError('No hay sesión activa. Inicia sesión nuevamente.');
      }

      final snapshot = await FirebaseFirestore.instance
          .collection('businesses')
          .doc(businessId)
          .collection('expenses')
          .where(
            'createdAt',
            isGreaterThanOrEqualTo: Timestamp.fromDate(params.range.from),
          )
          .where(
            'createdAt',
            isLessThanOrEqualTo: Timestamp.fromDate(params.range.to),
          )
          .orderBy('createdAt', descending: true)
          .get();

      final expenses = snapshot.docs
          .map((doc) => ExpenseModel.fromFirestore(doc))
          .toList();

      if (expenses.isEmpty) return _ExpensesOverview.empty();

      final total = expenses.fold<double>(
        0,
        (runningTotal, item) => runningTotal + item.amount,
      );
      final byCategory = <String, double>{};
      final byBranch = <String, double>{};

      for (final expense in expenses) {
        byCategory[expense.category] =
            (byCategory[expense.category] ?? 0) + expense.amount;
        byBranch[expense.branchName] =
            (byBranch[expense.branchName] ?? 0) + expense.amount;
      }

      final categoryEntries = byCategory.entries.toList()
        ..sort((a, b) => b.value.compareTo(a.value));
      final branchEntries = byBranch.entries.toList()
        ..sort((a, b) => b.value.compareTo(a.value));

      return _ExpensesOverview(
        expenses: expenses,
        total: total,
        average: total / expenses.length,
        categories: categoryEntries,
        branches: branchEntries,
      );
    });

class ExpensesReportScreen extends ConsumerStatefulWidget {
  const ExpensesReportScreen({super.key});

  @override
  ConsumerState<ExpensesReportScreen> createState() =>
      _ExpensesReportScreenState();
}

class _ExpensesReportScreenState extends ConsumerState<ExpensesReportScreen> {
  DateFilter _filter = DateFilter.thisMonth;

  DateRange get _range => stableRangeForFilter(_filter);

  @override
  Widget build(BuildContext context) {
    final overviewAsync = ref.watch(_expensesProvider(_ExpenseParams(_range)));

    return Scaffold(
      drawer: const AppDrawer(),
      appBar: AppBar(title: const Text('Reporte de Gastos'), actions: [IconButton(icon: const Icon(Icons.home_rounded), tooltip: 'Ir al inicio', onPressed: () => context.go('/dashboard'))]),
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
                onRetry: () => ref.invalidate(_expensesProvider),
              ),
              data: (overview) {
                if (overview.expenses.isEmpty) {
                  return const AppEmptyState(
                    title: 'Sin gastos registrados',
                    message:
                        'No se encontraron gastos en el filtro seleccionado.',
                    icon: Icons.money_off_rounded,
                  );
                }

                return ListView(
                  padding: const EdgeInsets.only(bottom: 32),
                  children: [
                    _ExpensesHero(overview: overview),
                    _ExpenseCategorySection(overview: overview),
                    _ExpenseBranchSection(overview: overview),
                    _ExpenseListSection(overview: overview),
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

class _ExpensesHero extends StatelessWidget {
  final _ExpensesOverview overview;

  const _ExpensesHero({required this.overview});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          gradient: AppColors.dangerGradient,
          borderRadius: BorderRadius.circular(20),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Total de gastos',
              style: TextStyle(
                color: Colors.white.withValues(alpha: 0.75),
                fontSize: 13,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              FormatHelpers.currency(overview.total),
              style: const TextStyle(
                color: Colors.white,
                fontSize: 30,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _ExpenseHeroStat(
                    label: 'Registros',
                    value: '${overview.expenses.length}',
                  ),
                ),
                Expanded(
                  child: _ExpenseHeroStat(
                    label: 'Promedio',
                    value: FormatHelpers.currency(overview.average),
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

class _ExpenseHeroStat extends StatelessWidget {
  final String label;
  final String value;

  const _ExpenseHeroStat({required this.label, required this.value});

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
          ),
        ),
        Text(
          label,
          style: TextStyle(
            color: Colors.white.withValues(alpha: 0.68),
            fontSize: 11,
          ),
        ),
      ],
    );
  }
}

class _ExpenseCategorySection extends StatelessWidget {
  final _ExpensesOverview overview;

  const _ExpenseCategorySection({required this.overview});

  @override
  Widget build(BuildContext context) {
    final maxValue = overview.categories.isEmpty
        ? 0.0
        : overview.categories.first.value;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const AppSectionHeader(title: 'Gastos por categoria'),
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
              children: overview.categories.map((entry) {
                final progress = maxValue > 0 ? entry.value / maxValue : 0.0;
                return Padding(
                  padding: const EdgeInsets.only(bottom: 14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                            child: Text(
                              entry.key,
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                          Text(
                            FormatHelpers.currency(entry.value),
                            style: const TextStyle(fontWeight: FontWeight.w700),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: LinearProgressIndicator(
                          value: progress,
                          minHeight: 8,
                          color: AppColors.error,
                          backgroundColor: AppColors.lightBorder,
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

class _ExpenseBranchSection extends StatelessWidget {
  final _ExpensesOverview overview;

  const _ExpenseBranchSection({required this.overview});

  @override
  Widget build(BuildContext context) {
    if (overview.branches.length <= 1) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const AppSectionHeader(title: 'Comparativa por sucursal'),
        ...overview.branches.map((entry) {
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
                child: Icon(Icons.store_outlined, color: AppColors.info),
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

class _ExpenseListSection extends StatelessWidget {
  final _ExpensesOverview overview;

  const _ExpenseListSection({required this.overview});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const AppSectionHeader(title: 'Historial detallado'),
        ...overview.expenses.take(15).map((expense) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Theme.of(context).cardColor,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                  color: Theme.of(context).brightness == Brightness.dark
                      ? AppColors.darkBorder
                      : AppColors.lightBorder,
                ),
              ),
              child: Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: AppColors.errorLight,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Icon(
                      Icons.money_off_rounded,
                      color: AppColors.error,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          expense.description.isNotEmpty
                              ? expense.description
                              : expense.category,
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                        Text(
                          '${expense.category} · ${expense.branchName}',
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
                        FormatHelpers.currency(expense.amount),
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                      Text(
                        DateHelpers.relativeTime(expense.createdAt),
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

class _ExpenseParams {
  final DateRange range;

  const _ExpenseParams(this.range);

  @override
  bool operator ==(Object other) {
    return other is _ExpenseParams &&
        other.range.from == range.from &&
        other.range.to == range.to;
  }

  @override
  int get hashCode => Object.hash(range.from, range.to);
}

class _ExpensesOverview {
  final List<ExpenseModel> expenses;
  final double total;
  final double average;
  final List<MapEntry<String, double>> categories;
  final List<MapEntry<String, double>> branches;

  const _ExpensesOverview({
    required this.expenses,
    required this.total,
    required this.average,
    required this.categories,
    required this.branches,
  });

  factory _ExpensesOverview.empty() => const _ExpensesOverview(
    expenses: [],
    total: 0,
    average: 0,
    categories: [],
    branches: [],
  );
}

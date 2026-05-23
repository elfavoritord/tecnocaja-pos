import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/constants/app_colors.dart';
import '../../../../core/utils/format_helpers.dart';
import '../../../../data/models/receivable_model.dart';
import '../../../../data/repositories/firestore_reports_repository.dart';
import '../../../../shared/widgets/app_empty_state.dart';
import '../../../../shared/widgets/app_section_header.dart';
import '../../../../shared/widgets/report_scaffold.dart'
    show ReportScaffold, hPad, isCompact;
import '../../../auth/providers/auth_provider.dart';

// ── Provider ─────────────────────────────────────────────────────────────────

final _receivablesProvider =
    FutureProvider.autoDispose<_AccountsOverview>((ref) async {
  final businessId = ref.watch(activeBusinessIdProvider);
  if (businessId == null || businessId.isEmpty) {
    throw StateError('No hay sesión activa.');
  }

  final repo = FirestoreReportsRepository();
  final receivables = await repo.getReceivables(businessId: businessId);
  return _AccountsOverview.fromReceivables(receivables);
});

// ── Screen ────────────────────────────────────────────────────────────────────

class ReceivablesReportScreen extends ConsumerStatefulWidget {
  const ReceivablesReportScreen({super.key});

  @override
  ConsumerState<ReceivablesReportScreen> createState() =>
      _ReceivablesReportScreenState();
}

class _ReceivablesReportScreenState
    extends ConsumerState<ReceivablesReportScreen> {
  String _search = '';

  @override
  Widget build(BuildContext context) {
    final businessId = ref.watch(activeBusinessIdProvider);
    if (businessId == null || businessId.isEmpty) {
      return const Scaffold(
        body: AppErrorState(message: 'No hay sesión activa.'),
      );
    }

    final overviewAsync = ref.watch(_receivablesProvider);

    return ReportScaffold(
      title: 'Cuentas por Cobrar',
      actions: [
        IconButton(
          icon: const Icon(Icons.refresh_rounded),
          onPressed: () => ref.invalidate(_receivablesProvider),
        ),
      ],
      body: overviewAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => AppErrorState(
          message: error.toString(),
          onRetry: () => ref.invalidate(_receivablesProvider),
        ),
        data: (overview) {
          if (!overview.hasPending) {
            return const AppEmptyState(
              title: 'Todo está al día',
              message: 'No hay facturas pendientes de clientes.',
              icon: Icons.check_circle_outline_rounded,
            );
          }
          return _buildContent(context, overview);
        },
      ),
    );
  }

  Widget _buildContent(BuildContext context, _AccountsOverview overview) {
    final compact = isCompact(context);
    final h = hPad(context);
    final query = _search.trim().toLowerCase();

    final customers = overview.topDebtors.where((c) {
      if (query.isEmpty) return true;
      return c.name.toLowerCase().contains(query) ||
          (c.branchName).toLowerCase().contains(query);
    }).toList();

    return ListView(
      padding: const EdgeInsets.only(bottom: 28),
      children: [
        _BalanceHero(overview: overview),
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
              contentPadding: const EdgeInsets.symmetric(vertical: 12),
            ),
            onChanged: (v) => setState(() => _search = v),
          ),
        ),
        const AppSectionHeader(title: 'Resumen rápido'),
        Padding(
          padding: EdgeInsets.fromLTRB(h, 0, h, 0),
          child: Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              _MiniSummaryCard(
                label: 'Clientes con saldo',
                value: '${overview.topDebtors.length}',
                color: AppColors.error,
                icon: Icons.people_outline_rounded,
              ),
              _MiniSummaryCard(
                label: 'Facturas vencidas',
                value: '${overview.overdueCount}',
                color: AppColors.warning,
                icon: Icons.warning_amber_rounded,
              ),
              _MiniSummaryCard(
                label: 'Facturas pendientes',
                value: '${overview.pendingCount}',
                color: AppColors.info,
                icon: Icons.receipt_long_outlined,
              ),
            ],
          ),
        ),
        AppSectionHeader(title: 'Clientes que te deben (${customers.length})'),
        if (customers.isEmpty)
          const AppEmptyState(
            title: 'Sin clientes pendientes',
            message: 'No hay clientes con saldo que coincidan con tu búsqueda.',
            icon: Icons.person_search_outlined,
          )
        else
          ...customers.map((c) => _CustomerDebtTile(customer: c)),
        // Nota sobre facturas de suplidores
        Padding(
          padding: EdgeInsets.fromLTRB(h, 8, h, 0),
          child: Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.lightSurfaceVariant,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AppColors.lightBorder),
            ),
            child: const Row(
              children: [
                Icon(Icons.info_outline_rounded,
                    color: AppColors.textSecondary, size: 18),
                SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Las facturas de suplidores están disponibles en el POS local. '
                    'Esta sección muestra solo cuentas por cobrar a clientes.',
                    style: TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 12.5,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

// ── Data model ────────────────────────────────────────────────────────────────

class _CustomerDebt {
  final String id;
  final String name;
  final String branchName;
  final double balance;
  final int invoices;
  final bool hasOverdue;
  final DateTime? lastCreatedAt;

  const _CustomerDebt({
    required this.id,
    required this.name,
    required this.branchName,
    required this.balance,
    required this.invoices,
    required this.hasOverdue,
    required this.lastCreatedAt,
  });
}

class _AccountsOverview {
  final List<_CustomerDebt> topDebtors;
  final double totalReceivable;
  final int overdueCount;
  final int pendingCount;

  const _AccountsOverview({
    required this.topDebtors,
    required this.totalReceivable,
    required this.overdueCount,
    required this.pendingCount,
  });

  bool get hasPending => topDebtors.isNotEmpty;

  factory _AccountsOverview.fromReceivables(List<ReceivableModel> list) {
    // Agrupar por cliente
    final Map<String, List<ReceivableModel>> byCustomer = {};
    for (final r in list) {
      final key = r.customerId.isNotEmpty ? r.customerId : r.customerName;
      byCustomer.putIfAbsent(key, () => []).add(r);
    }

    final debtors = byCustomer.entries.map((entry) {
      final items = entry.value;
      final balance = items.fold<double>(0, (s, r) => s + r.balance);
      final hasOverdue = items.any((r) => r.isOverdue);
      final lastDate = items
          .map((r) => r.createdAt)
          .reduce((a, b) => a.isAfter(b) ? a : b);
      return _CustomerDebt(
        id: entry.key,
        name: items.first.customerName.isNotEmpty
            ? items.first.customerName
            : 'Cliente',
        branchName: items.first.branchName ?? '',
        balance: balance,
        invoices: items.length,
        hasOverdue: hasOverdue,
        lastCreatedAt: lastDate,
      );
    }).toList()
      ..sort((a, b) => b.balance.compareTo(a.balance));

    final totalReceivable =
        list.fold<double>(0, (s, r) => s + r.balance);
    final overdueCount = list.where((r) => r.isOverdue).length;
    final pendingCount =
        list.where((r) => r.status == ReceivableStatus.pending).length;

    return _AccountsOverview(
      topDebtors: debtors,
      totalReceivable: totalReceivable,
      overdueCount: overdueCount,
      pendingCount: pendingCount,
    );
  }
}

// ── Widgets ───────────────────────────────────────────────────────────────────

class _BalanceHero extends StatelessWidget {
  final _AccountsOverview overview;

  const _BalanceHero({required this.overview});

  @override
  Widget build(BuildContext context) {
    final compact = isCompact(context);
    final h = hPad(context);

    return Padding(
      padding: EdgeInsets.fromLTRB(h, compact ? 12 : 16, h, 0),
      child: Container(
        padding: EdgeInsets.all(compact ? 16 : 20),
        decoration: BoxDecoration(
          gradient: const LinearGradient(
            colors: [Color(0xFF0F766E), Color(0xFF10B981)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
          borderRadius: BorderRadius.circular(compact ? 18 : 22),
          boxShadow: [
            BoxShadow(
              color: AppColors.success.withValues(alpha: 0.25),
              blurRadius: 22,
              offset: const Offset(0, 10),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Total por cobrar',
              style: TextStyle(
                color: Colors.white.withValues(alpha: 0.82),
                fontSize: compact ? 12 : 13,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              FormatHelpers.currency(overview.totalReceivable),
              style: TextStyle(
                color: Colors.white,
                fontSize: compact ? 28 : 34,
                fontWeight: FontWeight.w800,
                letterSpacing: -1.1,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              '${overview.topDebtors.length} cliente(s) con saldo pendiente',
              style: TextStyle(
                color: Colors.white.withValues(alpha: 0.84),
                fontSize: compact ? 12 : 13,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MiniSummaryCard extends StatelessWidget {
  final String label;
  final String value;
  final Color color;
  final IconData icon;

  const _MiniSummaryCard({
    required this.label,
    required this.value,
    required this.color,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    final compact = isCompact(context);
    final width = MediaQuery.sizeOf(context).width;
    final itemWidth = width < 700 ? double.infinity : (width - 72) / 3;

    return SizedBox(
      width: itemWidth,
      child: Container(
        padding: EdgeInsets.all(compact ? 14 : 16),
        decoration: BoxDecoration(
          color: Theme.of(context).cardColor,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: color.withValues(alpha: 0.25)),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, color: color, size: 20),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    value,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    label,
                    style: const TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 12,
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

class _CustomerDebtTile extends StatelessWidget {
  final _CustomerDebt customer;

  const _CustomerDebtTile({required this.customer});

  @override
  Widget build(BuildContext context) {
    final h = hPad(context);
    final accentColor =
        customer.hasOverdue ? AppColors.warning : AppColors.error;

    return Padding(
      padding: EdgeInsets.fromLTRB(h, 0, h, 10),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Theme.of(context).cardColor,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: accentColor.withValues(alpha: 0.16)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 5,
              height: 58,
              decoration: BoxDecoration(
                color: accentColor,
                borderRadius: BorderRadius.circular(999),
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    customer.name,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  if (customer.branchName.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      customer.branchName,
                      style: const TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 12.5,
                      ),
                    ),
                  ],
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _SoftChip(
                        label: '${customer.invoices} factura(s)',
                        color: accentColor,
                      ),
                      if (customer.hasOverdue)
                        const _SoftChip(
                          label: 'Vencida',
                          color: AppColors.warning,
                        ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Text(
              FormatHelpers.currency(customer.balance),
              style: TextStyle(
                fontWeight: FontWeight.w800,
                fontSize: 16,
                color: accentColor,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SoftChip extends StatelessWidget {
  final String label;
  final Color color;

  const _SoftChip({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 11.5,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

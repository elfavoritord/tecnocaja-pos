import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/constants/app_colors.dart';
import '../../../../core/utils/format_helpers.dart';
import '../../../../data/models/cash_closing_model.dart';
import '../../../../data/models/cash_register_model.dart';
import '../../../../data/models/user_model.dart';
import '../../../../shared/widgets/app_drawer.dart';
import '../../../../shared/widgets/app_empty_state.dart';
import '../../../../shared/widgets/app_section_header.dart';
import '../../../auth/providers/auth_provider.dart';

final _cashProvider = FutureProvider.autoDispose<_CashReportData>((ref) async {
  final businessId = ref.watch(activeBusinessIdProvider);
  if (businessId == null || businessId.isEmpty) {
    throw StateError('No hay sesión activa. Inicia sesión nuevamente.');
  }

  final profile = ref.watch(currentUserProfileProvider).valueOrNull;
  final branchIds = ref.watch(activeBranchIdsProvider);
  final firestore = FirebaseFirestore.instance;

  final registersSnapshot = await firestore
      .collection('businesses')
      .doc(businessId)
      .collection('cashRegisters')
      .get();
  var closings = await _loadCashClosings(
    firestore: firestore,
    businessId: businessId,
    scopedBranchIds: branchIds,
  );

  final registerNames = <String, String>{};
  var registers = registersSnapshot.docs
      .map((doc) => CashRegisterModel.fromFirestore(doc))
      .toList();
  for (final register in registers) {
    registerNames[register.id] = register.name;
  }

  registers = _filterRegisters(
    registers,
    branchIds: branchIds,
    profile: profile,
  );
  closings = _filterClosings(closings, branchIds: branchIds, profile: profile);

  return _CashReportData(
    registers: registers,
    closings: closings,
    registerNames: registerNames,
  );
});

class CashReportScreen extends ConsumerWidget {
  const CashReportScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cashAsync = ref.watch(_cashProvider);

    return Scaffold(
      drawer: const AppDrawer(),
      appBar: AppBar(
        title: const Text('Reporte de Caja'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded),
            onPressed: () => ref.invalidate(_cashProvider),
          ),
          IconButton(
            icon: const Icon(Icons.home_rounded),
            tooltip: 'Ir al inicio',
            onPressed: () => context.go('/dashboard'),
          ),
        ],
      ),
      body: cashAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => AppErrorState(message: error.toString()),
        data: (data) {
          if (data.registers.isEmpty && data.closings.isEmpty) {
            return const AppEmptyState(
              title: 'Sin registros de caja',
              message:
                  'No se encontraron cajas o cierres para tu sucursal o usuario.',
              icon: Icons.account_balance_wallet_outlined,
            );
          }

          return _CashReportBody(data: data);
        },
      ),
    );
  }
}

class _CashReportBody extends StatelessWidget {
  final _CashReportData data;

  const _CashReportBody({required this.data});

  @override
  Widget build(BuildContext context) {
    final openRegisters = data.registers
        .where((register) => register.status == CashRegisterStatus.open)
        .toList();
    final closingsWithDiff = data.closings
        .where((closing) => closing.hasDiscrepancy)
        .toList();

    return ListView(
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
          child: Row(
            children: [
              _statusCard(
                'Abiertas',
                '${openRegisters.length}',
                AppColors.success,
                Icons.lock_open_rounded,
              ),
              const SizedBox(width: 12),
              _statusCard(
                'Con diferencia',
                '${closingsWithDiff.length}',
                AppColors.error,
                Icons.warning_amber_rounded,
              ),
            ],
          ),
        ),
        if (openRegisters.isNotEmpty) ...[
          const AppSectionHeader(title: 'Cajas abiertas'),
          ...openRegisters.map((register) => _OpenCashTile(register: register)),
        ],
        const AppSectionHeader(title: 'Historial de cierres'),
        if (data.closings.isEmpty)
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: AppEmptyState(
              title: 'Sin cierres registrados',
              message: 'Aun no hay cierres sincronizados para mostrar.',
              icon: Icons.history_toggle_off_rounded,
            ),
          )
        else
          ...data.closings.map(
            (closing) => _CashClosingTile(
              closing: closing,
              registerName: data.registerNames[closing.cashRegisterId],
            ),
          ),
      ],
    );
  }

  Widget _statusCard(String label, String value, Color color, IconData icon) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: color.withValues(alpha: 0.3)),
        ),
        child: Row(
          children: [
            Icon(icon, color: color, size: 22),
            const SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  value,
                  style: TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 20,
                    color: color,
                  ),
                ),
                Text(label, style: TextStyle(color: color, fontSize: 12)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _OpenCashTile extends StatelessWidget {
  final CashRegisterModel register;

  const _OpenCashTile({required this.register});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Theme.of(context).cardColor,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: Theme.of(context).brightness == Brightness.dark
                ? AppColors.darkBorder
                : AppColors.lightBorder,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    '${register.branchName} · ${register.name}',
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 15,
                    ),
                  ),
                ),
                _statusBadge(
                  label: 'Abierta',
                  background: AppColors.successLight,
                  foreground: AppColors.success,
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              'Abierta por: ${register.openedBy.isEmpty ? 'Sin dato' : register.openedBy}',
              style: const TextStyle(
                color: AppColors.textSecondary,
                fontSize: 12,
              ),
            ),
            if (register.openedAt != null)
              Text(
                DateHelpers.dateTime(register.openedAt!),
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 12,
                ),
              ),
            const Divider(height: 20),
            _CashStatsWrap(
              stats: [
                _CashStat(
                  label: 'Apertura',
                  value: FormatHelpers.currency(register.openingAmount),
                ),
                _CashStat(
                  label: 'Esperado',
                  value: FormatHelpers.currency(register.expectedAmount),
                ),
                _CashStat(
                  label: 'Ingresos',
                  value: FormatHelpers.currency(register.totalIncome),
                ),
                _CashStat(
                  label: 'Retiros',
                  value: FormatHelpers.currency(register.totalWithdrawals),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _CashClosingTile extends StatefulWidget {
  final CashClosingModel closing;
  final String? registerName;

  const _CashClosingTile({required this.closing, required this.registerName});

  @override
  State<_CashClosingTile> createState() => _CashClosingTileState();
}

class _CashClosingTileState extends State<_CashClosingTile> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final closing = widget.closing;
    final hasDiff = closing.hasDiscrepancy;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final rawName = widget.registerName?.trim() ?? '';
    final effectiveRegisterName =
        rawName.isEmpty || RegExp(r'^Caja\s+\d+$', caseSensitive: false).hasMatch(rawName)
            ? 'Caja'
            : rawName;

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Container(
        decoration: BoxDecoration(
          color: Theme.of(context).cardColor,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: hasDiff
                ? AppColors.error.withValues(alpha: 0.4)
                : (isDark ? AppColors.darkBorder : AppColors.lightBorder),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            // Cabecera: siempre visible, tap para expandir
            InkWell(
              onTap: () => setState(() => _expanded = !_expanded),
              borderRadius: BorderRadius.circular(14),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            '${closing.branchName} · $effectiveRegisterName',
                            style: const TextStyle(
                              fontWeight: FontWeight.w700,
                              fontSize: 14,
                            ),
                          ),
                        ),
                        _statusBadge(
                          label: hasDiff ? 'Con diferencia' : 'Cerrada',
                          background: hasDiff
                              ? AppColors.errorLight
                              : AppColors.lightSurfaceVariant,
                          foreground: hasDiff
                              ? AppColors.error
                              : AppColors.textSecondary,
                        ),
                        const SizedBox(width: 4),
                        AnimatedRotation(
                          turns: _expanded ? 0.5 : 0,
                          duration: const Duration(milliseconds: 200),
                          child: const Icon(
                            Icons.keyboard_arrow_down_rounded,
                            color: AppColors.textSecondary,
                            size: 20,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(
                      [
                        if (closing.openedBy.isNotEmpty)
                          'Por: ${closing.openedBy}',
                        if (closing.closedAt != null)
                          DateHelpers.dateTime(closing.closedAt!),
                      ].join(' · '),
                      style: const TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            // Detalle colapsable
            AnimatedCrossFade(
              duration: const Duration(milliseconds: 200),
              crossFadeState: _expanded
                  ? CrossFadeState.showFirst
                  : CrossFadeState.showSecond,
              firstChild: Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
                child: Column(
                  children: [
                    const Divider(height: 1),
                    const SizedBox(height: 12),
                    _CashStatsWrap(
                      stats: [
                        _CashStat(
                          label: 'Apertura',
                          value: FormatHelpers.currency(closing.openingAmount),
                        ),
                        _CashStat(
                          label: 'Cierre',
                          value: FormatHelpers.currency(closing.closingAmount),
                        ),
                        _CashStat(
                          label: 'Esperado',
                          value: FormatHelpers.currency(closing.expectedAmount),
                        ),
                        _CashStat(
                          label: 'Diferencia',
                          value: FormatHelpers.currency(closing.difference),
                          color: hasDiff ? AppColors.error : AppColors.success,
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              secondChild: const SizedBox.shrink(),
            ),
          ],
        ),
      ),
    );
  }
}

class _CashStatsWrap extends StatelessWidget {
  final List<_CashStat> stats;

  const _CashStatsWrap({required this.stats});

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final isWide = constraints.maxWidth >= 520;
        final width = isWide
            ? (constraints.maxWidth - 36) / 4
            : (constraints.maxWidth - 12) / 2;

        return Wrap(
          spacing: 12,
          runSpacing: 12,
          children: stats
              .map(
                (stat) => SizedBox(
                  width: width,
                  child: _CashStatTile(stat: stat),
                ),
              )
              .toList(),
        );
      },
    );
  }
}

class _CashStat {
  final String label;
  final String value;
  final Color? color;

  const _CashStat({required this.label, required this.value, this.color});
}

class _CashStatTile extends StatelessWidget {
  final _CashStat stat;

  const _CashStatTile({required this.stat});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: (stat.color ?? AppColors.primary).withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            stat.value,
            style: TextStyle(
              fontWeight: FontWeight.w700,
              fontSize: 13,
              color: stat.color,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            stat.label,
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 11,
            ),
          ),
        ],
      ),
    );
  }
}

class _CashReportData {
  final List<CashRegisterModel> registers;
  final List<CashClosingModel> closings;
  final Map<String, String> registerNames;

  const _CashReportData({
    required this.registers,
    required this.closings,
    required this.registerNames,
  });
}

Widget _statusBadge({
  required String label,
  required Color background,
  required Color foreground,
}) {
  return Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
    decoration: BoxDecoration(
      color: background,
      borderRadius: BorderRadius.circular(20),
    ),
    child: Text(
      label,
      style: TextStyle(
        color: foreground,
        fontSize: 12,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}

List<CashRegisterModel> _filterRegisters(
  List<CashRegisterModel> registers, {
  required List<String>? branchIds,
  required UserModel? profile,
}) {
  final scopedBranchIds = _normalizedSet(branchIds);
  final scopedCashRegisterIds = _normalizedSet(
    profile?.effectiveCashRegisterIds,
  );

  return registers.where((register) {
    final registerBranchId = register.branchId.trim().toLowerCase();
    final registerId = register.id.trim().toLowerCase();

    if (scopedBranchIds.isNotEmpty &&
        !scopedBranchIds.contains(registerBranchId)) {
      return false;
    }

    if (scopedCashRegisterIds.isNotEmpty) {
      return scopedCashRegisterIds.contains(registerId);
    }

    if (_shouldRestrictToOwnCashData(profile)) {
      return _matchesProfileName(profile, [register.openedBy]);
    }

    return true;
  }).toList();
}

List<CashClosingModel> _filterClosings(
  List<CashClosingModel> closings, {
  required List<String>? branchIds,
  required UserModel? profile,
}) {
  final scopedBranchIds = _normalizedSet(branchIds);
  final scopedCashRegisterIds = _normalizedSet(
    profile?.effectiveCashRegisterIds,
  );

  return closings.where((closing) {
    final branchId = closing.branchId.trim().toLowerCase();
    final registerId = closing.cashRegisterId.trim().toLowerCase();

    if (scopedBranchIds.isNotEmpty && !scopedBranchIds.contains(branchId)) {
      return false;
    }

    if (scopedCashRegisterIds.isNotEmpty) {
      return scopedCashRegisterIds.contains(registerId);
    }

    if (_shouldRestrictToOwnCashData(profile)) {
      return _matchesProfileName(profile, [closing.openedBy, closing.closedBy]);
    }

    return true;
  }).toList();
}

bool _shouldRestrictToOwnCashData(UserModel? profile) {
  if (profile == null) return false;
  return profile.isCashierLike || profile.effectiveCashRegisterIds.isNotEmpty;
}

bool _matchesProfileName(UserModel? profile, List<String> candidates) {
  final profileName = profile?.displayName.trim().toLowerCase() ?? '';
  if (profileName.isEmpty) return false;
  return candidates.any(
    (candidate) => candidate.trim().toLowerCase() == profileName,
  );
}

Set<String> _normalizedSet(List<String>? values) {
  if (values == null) return const <String>{};
  return values
      .map((value) => value.trim().toLowerCase())
      .where((value) => value.isNotEmpty)
      .toSet();
}

Future<List<CashClosingModel>> _loadCashClosings({
  required FirebaseFirestore firestore,
  required String businessId,
  required List<String>? scopedBranchIds,
}) async {
  try {
    final snapshot = await firestore
        .collection('businesses')
        .doc(businessId)
        .collection('cashClosings')
        .orderBy('createdAt', descending: true)
        .limit(200)
        .get();

    return snapshot.docs
        .map((doc) => CashClosingModel.fromFirestore(doc))
        .toList();
  } on FirebaseException catch (error) {
    if (error.code != 'permission-denied') rethrow;
  }

  final branchIds = await _resolveBranchIds(
    firestore: firestore,
    businessId: businessId,
    scopedBranchIds: scopedBranchIds,
  );

  final closings = <CashClosingModel>[];
  for (final branchId in branchIds) {
    try {
      final snapshot = await firestore
          .collection('businesses')
          .doc(businessId)
          .collection('branches')
          .doc(branchId)
          .collection('cash_closings')
          .get();
      closings.addAll(
        snapshot.docs.map((doc) => CashClosingModel.fromFirestore(doc)),
      );
    } on FirebaseException catch (error) {
      if (error.code != 'permission-denied') {
        rethrow;
      }
    }
  }

  closings.sort((a, b) {
    final left =
        a.closedAt ?? a.openedAt ?? DateTime.fromMillisecondsSinceEpoch(0);
    final right =
        b.closedAt ?? b.openedAt ?? DateTime.fromMillisecondsSinceEpoch(0);
    return right.compareTo(left);
  });
  return closings.take(200).toList();
}

Future<List<String>> _resolveBranchIds({
  required FirebaseFirestore firestore,
  required String businessId,
  required List<String>? scopedBranchIds,
}) async {
  final normalizedScoped = (scopedBranchIds ?? [])
      .map((value) => value.trim())
      .where((value) => value.isNotEmpty)
      .toList();
  if (normalizedScoped.isNotEmpty) {
    return normalizedScoped;
  }

  try {
    final snapshot = await firestore
        .collection('businesses')
        .doc(businessId)
        .collection('branches')
        .get();
    return snapshot.docs
        .map((doc) => doc.id.trim())
        .where((value) => value.isNotEmpty)
        .toList();
  } catch (_) {
    return const [];
  }
}

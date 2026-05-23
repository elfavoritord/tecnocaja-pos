import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shimmer/shimmer.dart';

import '../../../../core/constants/app_colors.dart';
import '../../../../core/utils/format_helpers.dart';
import '../../../../data/models/inventory_model.dart';
import '../../../../shared/widgets/app_empty_state.dart';
import '../../../../shared/widgets/report_scaffold.dart'
    show ReportScaffold, isCompact, hPad;
import '../../../../features/auth/providers/auth_provider.dart';

// ─── Provider (StreamProvider en tiempo real, aislado por businessId) ─────────

final _inventoryStreamProvider = StreamProvider.autoDispose
    .family<List<ProductModel>, _InventoryScope>((ref, scope) {
      return FirebaseFirestore.instance
          .collection('businesses')
          .doc(scope.businessId)
          .collection('products')
          .orderBy('name')
          .snapshots()
          .map(
            (snap) => _filterProductsForScope(
              snap.docs.map((doc) => ProductModel.fromFirestore(doc)).toList(),
              scope.branchIds,
            ),
          );
    });

// ─── Pantalla ─────────────────────────────────────────────────────────────────

class InventoryReportScreen extends ConsumerStatefulWidget {
  const InventoryReportScreen({super.key});

  @override
  ConsumerState<InventoryReportScreen> createState() =>
      _InventoryReportScreenState();
}

class _InventoryReportScreenState extends ConsumerState<InventoryReportScreen> {
  String _search = '';
  StockStatus? _filterStatus;
  _SortMode _sort = _SortMode.name;

  @override
  Widget build(BuildContext context) {
    final businessId = ref.watch(activeBusinessIdProvider);
    final branchIds = ref.watch(activeBranchIdsProvider);

    if (businessId == null || businessId.isEmpty) {
      return const Scaffold(
        body: AppErrorState(message: 'No hay sesión activa.'),
      );
    }

    final scope = _InventoryScope(businessId: businessId, branchIds: branchIds);
    final productsAsync = ref.watch(_inventoryStreamProvider(scope));

    return ReportScaffold(
      title: 'Inventario',
      actions: [
        PopupMenuButton<_SortMode>(
          icon: const Icon(Icons.sort_rounded),
          tooltip: 'Ordenar',
          onSelected: (v) => setState(() => _sort = v),
          itemBuilder: (_) => const [
            PopupMenuItem(value: _SortMode.name, child: Text('Nombre A–Z')),
            PopupMenuItem(
              value: _SortMode.stockAsc,
              child: Text('Menor stock'),
            ),
            PopupMenuItem(
              value: _SortMode.stockDesc,
              child: Text('Mayor stock'),
            ),
            PopupMenuItem(value: _SortMode.margin, child: Text('Mayor margen')),
          ],
        ),
      ],
      body: productsAsync.when(
        loading: () => const _InventoryShimmer(),
        error: (e, _) => AppErrorState(
          message: e.toString(),
          onRetry: () => ref.invalidate(_inventoryStreamProvider(scope)),
        ),
        data: (products) => _buildContent(products),
      ),
    );
  }

  Widget _buildContent(List<ProductModel> products) {
    // Métricas
    final outOfStock = products.where((p) => p.stock <= 0).length;
    final lowStock = products
        .where((p) => p.stock > 0 && p.stock <= p.minStock)
        .length;
    final totalValue = products.fold(
      0.0,
      (acc, p) => acc + (p.price * p.stock),
    );
    final totalCostValue = products.fold(
      0.0,
      (acc, p) => acc + (p.cost * p.stock),
    );
    final potentialProfit = totalValue - totalCostValue;

    // Filtros
    List<ProductModel> filtered = List.of(products);

    if (_search.isNotEmpty) {
      final q = _search.toLowerCase();
      filtered = filtered
          .where(
            (p) =>
                p.name.toLowerCase().contains(q) ||
                p.category.toLowerCase().contains(q) ||
                (p.barcode ?? '').contains(q),
          )
          .toList();
    }

    if (_filterStatus != null) {
      filtered = filtered.where((p) => p.stockStatus == _filterStatus).toList();
    }

    // Ordenamiento
    switch (_sort) {
      case _SortMode.name:
        filtered.sort((a, b) => a.name.compareTo(b.name));
        break;
      case _SortMode.stockAsc:
        filtered.sort((a, b) => a.stock.compareTo(b.stock));
        break;
      case _SortMode.stockDesc:
        filtered.sort((a, b) => b.stock.compareTo(a.stock));
        break;
      case _SortMode.margin:
        filtered.sort((a, b) => b.margin.compareTo(a.margin));
        break;
    }

    final compact = isCompact(context);
    final h = hPad(context);

    return Column(
      children: [
        // ── Resumen ────────────────────────────────────────────────────────
        Padding(
          padding: EdgeInsets.fromLTRB(h, compact ? 10 : 14, h, 0),
          child: LayoutBuilder(
            builder: (context, constraints) {
              final isWide = constraints.maxWidth > 500;
              return isWide
                  ? Row(
                      children: [
                        Expanded(
                          child: _SummaryChip(
                            label: 'Agotados',
                            value: '$outOfStock',
                            color: AppColors.error,
                            icon: Icons.remove_circle_outline_rounded,
                            isSelected: _filterStatus == StockStatus.outOfStock,
                            onTap: () => setState(
                              () => _filterStatus =
                                  _filterStatus == StockStatus.outOfStock
                                  ? null
                                  : StockStatus.outOfStock,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: _SummaryChip(
                            label: 'Stock bajo',
                            value: '$lowStock',
                            color: AppColors.warning,
                            icon: Icons.warning_amber_rounded,
                            isSelected: _filterStatus == StockStatus.low,
                            onTap: () => setState(
                              () => _filterStatus =
                                  _filterStatus == StockStatus.low
                                  ? null
                                  : StockStatus.low,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: _ValueChip(
                            label: 'Valor del Inventario',
                            value: FormatHelpers.currencyCompact(totalValue),
                            profit: FormatHelpers.currencyCompact(potentialProfit),
                            cost: FormatHelpers.currencyCompact(totalCostValue),
                          ),
                        ),
                      ],
                    )
                  : Column(
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: _SummaryChip(
                                label: 'Agotados',
                                value: '$outOfStock',
                                color: AppColors.error,
                                icon: Icons.remove_circle_outline_rounded,
                                isSelected:
                                    _filterStatus == StockStatus.outOfStock,
                                onTap: () => setState(
                                  () => _filterStatus =
                                      _filterStatus == StockStatus.outOfStock
                                      ? null
                                      : StockStatus.outOfStock,
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: _SummaryChip(
                                label: 'Stock bajo',
                                value: '$lowStock',
                                color: AppColors.warning,
                                icon: Icons.warning_amber_rounded,
                                isSelected: _filterStatus == StockStatus.low,
                                onTap: () => setState(
                                  () => _filterStatus =
                                      _filterStatus == StockStatus.low
                                      ? null
                                      : StockStatus.low,
                                ),
                              ),
                            ),
                          ],
                        ),
                        SizedBox(height: compact ? 6 : 8),
                        _ValueChip(
                          label: 'Valor del Inventario',
                          value: FormatHelpers.currencyCompact(totalValue),
                          profit: FormatHelpers.currencyCompact(potentialProfit),
                          cost: FormatHelpers.currencyCompact(totalCostValue),
                        ),
                      ],
                    );
            },
          ),
        ),

        // ── Buscador ───────────────────────────────────────────────────────
        Padding(
          padding: EdgeInsets.fromLTRB(h, compact ? 8 : 12, h, 0),
          child: TextField(
            decoration: InputDecoration(
              hintText: 'Buscar por nombre, categoría o código...',
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

        // ── Cabecera de lista ──────────────────────────────────────────────
        Padding(
          padding: EdgeInsets.fromLTRB(h, compact ? 6 : 10, h, 4),
          child: Row(
            children: [
              Text(
                '${filtered.length} de ${products.length} productos',
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                ),
              ),
              const Spacer(),
              if (_filterStatus != null)
                GestureDetector(
                  onTap: () => setState(() => _filterStatus = null),
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: AppColors.primaryLight.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: const Row(
                      children: [
                        Text(
                          'Limpiar filtro',
                          style: TextStyle(
                            color: AppColors.primary,
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        SizedBox(width: 4),
                        Icon(
                          Icons.close_rounded,
                          size: 12,
                          color: AppColors.primary,
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),

        // ── Lista ──────────────────────────────────────────────────────────
        Expanded(
          child: filtered.isEmpty
              ? const AppEmptyState(
                  title: 'Sin resultados',
                  message: 'Intenta con otro término de búsqueda.',
                  icon: Icons.search_off_rounded,
                )
              : LayoutBuilder(
                  builder: (context, constraints) {
                    // Grid en pantallas anchas (tablet/web), lista en móvil
                    if (constraints.maxWidth > 600) {
                      return GridView.builder(
                        padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
                        gridDelegate:
                            const SliverGridDelegateWithMaxCrossAxisExtent(
                              maxCrossAxisExtent: 320,
                              mainAxisSpacing: 10,
                              crossAxisSpacing: 10,
                              childAspectRatio: 1.6,
                            ),
                        itemCount: filtered.length,
                        itemBuilder: (_, i) =>
                            _ProductCard(product: filtered[i]),
                      );
                    }
                    return ListView.builder(
                      padding: EdgeInsets.fromLTRB(h, 4, h, 24),
                      itemCount: filtered.length,
                      itemBuilder: (_, i) => _ProductTile(product: filtered[i]),
                    );
                  },
                ),
        ),
      ],
    );
  }
}

// ─── Chip de resumen ──────────────────────────────────────────────────────────

class _SummaryChip extends StatelessWidget {
  final String label;
  final String value;
  final Color color;
  final IconData icon;
  final bool isSelected;
  final VoidCallback onTap;

  const _SummaryChip({
    required this.label,
    required this.value,
    required this.color,
    required this.icon,
    required this.isSelected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: isSelected
              ? color.withValues(alpha: 0.15)
              : color.withValues(alpha: 0.07),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: isSelected ? color : color.withValues(alpha: 0.25),
            width: isSelected ? 1.5 : 1,
          ),
        ),
        child: Row(
          children: [
            Icon(icon, color: color, size: 18),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  value,
                  style: TextStyle(
                    fontWeight: FontWeight.w800,
                    color: color,
                    fontSize: 16,
                  ),
                ),
                Text(label, style: TextStyle(color: color, fontSize: 10)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ValueChip extends StatelessWidget {
  final String label;
  final String value;
  final String profit;
  final String cost;

  const _ValueChip({
    required this.label,
    required this.value,
    required this.profit,
    required this.cost,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.success.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.success.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.inventory_2_outlined,
            color: AppColors.success,
            size: 18,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  value,
                  style: const TextStyle(
                    fontWeight: FontWeight.w800,
                    color: AppColors.success,
                    fontSize: 15,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                Text(
                  '$label · ganancia $profit · costo $cost',
                  style: const TextStyle(
                    color: AppColors.success,
                    fontSize: 10,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─── Tile de producto (modo lista) ────────────────────────────────────────────

class _ProductTile extends StatelessWidget {
  final ProductModel product;
  const _ProductTile({required this.product});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final compact = MediaQuery.sizeOf(context).width < 400;
    final statusColor = _statusColor(product.stockStatus);
    final statusLabel = _statusLabel(product.stockStatus);
    final isAlert = product.stockStatus != StockStatus.ok;

    return Padding(
      padding: EdgeInsets.only(bottom: compact ? 6 : 8),
      child: Container(
        padding: EdgeInsets.all(compact ? 10 : 14),
        decoration: BoxDecoration(
          color: Theme.of(context).cardColor,
          borderRadius: BorderRadius.circular(compact ? 12 : 14),
          border: Border.all(
            color: isAlert
                ? statusColor.withValues(alpha: 0.35)
                : (isDark ? AppColors.darkBorder : AppColors.lightBorder),
          ),
        ),
        child: Row(
          children: [
            // Indicador lateral
            Container(
              width: 4,
              height: compact ? 42 : 52,
              decoration: BoxDecoration(
                color: statusColor,
                borderRadius: BorderRadius.circular(4),
              ),
            ),
            SizedBox(width: compact ? 8 : 12),
            // Info
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    product.name,
                    style: const TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 14,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    product.category.isNotEmpty
                        ? product.category
                        : 'Sin categoría',
                    style: const TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      _MiniChip(
                        label: 'Costo ${FormatHelpers.currency(product.cost)}',
                        color: AppColors.textSecondary,
                      ),
                      if (product.cost > 0) ...[
                        _MiniChip(
                          label: 'Margen ${product.margin.toStringAsFixed(1)}%',
                          color: product.margin > 20
                              ? AppColors.success
                              : AppColors.warning,
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            // Stock + precio
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: statusColor.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    '${product.stock} · $statusLabel',
                    style: TextStyle(
                      color: statusColor,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  FormatHelpers.currency(product.price),
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 14,
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

// ─── Card de producto (modo grid) ─────────────────────────────────────────────

class _ProductCard extends StatelessWidget {
  final ProductModel product;
  const _ProductCard({required this.product});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final statusColor = _statusColor(product.stockStatus);
    final statusLabel = _statusLabel(product.stockStatus);

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Theme.of(context).cardColor,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: product.stockStatus != StockStatus.ok
              ? statusColor.withValues(alpha: 0.35)
              : (isDark ? AppColors.darkBorder : AppColors.lightBorder),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  product.name,
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 13,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  statusLabel,
                  style: TextStyle(
                    color: statusColor,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const Spacer(),
          Text(
            product.category.isNotEmpty ? product.category : 'Sin categoría',
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 11,
            ),
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    FormatHelpers.currency(product.price),
                    style: const TextStyle(
                      fontWeight: FontWeight.w800,
                      fontSize: 14,
                    ),
                  ),
                  Text(
                    'Stock: ${product.stock}',
                    style: TextStyle(color: statusColor, fontSize: 12),
                  ),
                ],
              ),
              if (product.cost > 0)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 7,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.successLight,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    '${product.margin.toStringAsFixed(0)}%',
                    style: const TextStyle(
                      color: AppColors.success,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

// ─── Mini chip ────────────────────────────────────────────────────────────────

class _MiniChip extends StatelessWidget {
  final String label;
  final Color color;

  const _MiniChip({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 10,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _InventoryScope {
  final String businessId;
  final List<String>? branchIds;

  const _InventoryScope({required this.businessId, required this.branchIds});

  String get _branchKey {
    final normalized =
        (branchIds ?? [])
            .map((value) => value.trim().toLowerCase())
            .where((value) => value.isNotEmpty)
            .toList()
          ..sort();
    return normalized.join('|');
  }

  @override
  bool operator ==(Object other) {
    return other is _InventoryScope &&
        other.businessId == businessId &&
        other._branchKey == _branchKey;
  }

  @override
  int get hashCode => Object.hash(businessId, _branchKey);
}

List<ProductModel> _filterProductsForScope(
  List<ProductModel> products,
  List<String>? branchIds,
) {
  final activeProducts = products.where((product) => product.isActive).toList();
  final normalizedBranchIds = (branchIds ?? [])
      .map((value) => value.trim().toLowerCase())
      .where((value) => value.isNotEmpty)
      .toSet();

  if (normalizedBranchIds.isEmpty) {
    return activeProducts;
  }

  final branchScopedProducts = activeProducts
      .where((product) => (product.branchId ?? '').trim().isNotEmpty)
      .toList();

  if (branchScopedProducts.isEmpty) {
    return activeProducts;
  }

  return branchScopedProducts
      .where(
        (product) => normalizedBranchIds.contains(
          (product.branchId ?? '').trim().toLowerCase(),
        ),
      )
      .toList();
}

// ─── Shimmer loading ─────────────────────────────────────────────────────────

class _InventoryShimmer extends StatelessWidget {
  const _InventoryShimmer();

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Shimmer.fromColors(
      baseColor: isDark ? const Color(0xFF1E293B) : Colors.grey.shade200,
      highlightColor: isDark ? const Color(0xFF334155) : Colors.grey.shade50,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Summary chips
          Row(
            children: [
              Expanded(child: _box(56, 14)),
              const SizedBox(width: 8),
              Expanded(child: _box(56, 14)),
            ],
          ),
          const SizedBox(height: 8),
          _box(48, 14),
          const SizedBox(height: 12),
          // Search
          _box(48, 12),
          const SizedBox(height: 12),
          // List
          for (var i = 0; i < 8; i++) ...[
            _box(82, 14),
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

Color _statusColor(StockStatus s) {
  switch (s) {
    case StockStatus.outOfStock:
      return AppColors.error;
    case StockStatus.critical:
      return AppColors.error;
    case StockStatus.low:
      return AppColors.warning;
    case StockStatus.ok:
      return AppColors.success;
  }
}

String _statusLabel(StockStatus s) {
  switch (s) {
    case StockStatus.outOfStock:
      return 'Agotado';
    case StockStatus.critical:
      return 'Crítico';
    case StockStatus.low:
      return 'Bajo';
    case StockStatus.ok:
      return 'OK';
  }
}

enum _SortMode { name, stockAsc, stockDesc, margin }

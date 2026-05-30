import 'dart:async';
import 'dart:math' as math;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/routes.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/utils/format_helpers.dart';
import '../../../data/models/reports_dashboard_model.dart';
import '../../../features/auth/providers/auth_provider.dart';
import '../../../shared/widgets/app_drawer.dart';
import '../providers/dashboard_provider.dart';

const _dashboardShellColor = Color(0xFF11161F);
const _dashboardPanelColor = Color(0xFF181E2A);
const _dashboardBorderColor = Color(0xFF2A3142);
const _dashboardMutedText = Color(0xFF8B96B5);

class DashboardScreen extends ConsumerStatefulWidget {
  const DashboardScreen({super.key});

  @override
  ConsumerState<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends ConsumerState<DashboardScreen> {
  late ReportsRangePreset _draftPreset;
  String? _draftBranchId;
  String? _draftCashRegisterId;
  String? _draftCashierId;
  bool _filterExpanded = false;
  ProviderSubscription<AsyncValue<int>>? _liveSalesSubscription;
  Timer? _liveRefreshDebounce;
  Future<void>? _refreshInFlight;

  @override
  void initState() {
    super.initState();
    _draftPreset = ref.read(dashboardRangePresetProvider);
    _draftBranchId = ref.read(dashboardSelectedBranchIdProvider);
    _draftCashRegisterId = ref.read(dashboardSelectedCashRegisterIdProvider);
    _draftCashierId = ref.read(dashboardSelectedCashierIdProvider);

    // Escucha ventas en tiempo real — refresca el dashboard al detectar una nueva venta
    _liveSalesSubscription = ref.listenManual<AsyncValue<int>>(
      liveTodaySalesCountProvider,
      (previous, next) {
        if (previous != null &&
            previous.hasValue &&
            next.hasValue &&
            next.value! > previous.value!) {
          _scheduleLiveRefresh();
        }
      },
    );
  }

  @override
  void dispose() {
    _liveRefreshDebounce?.cancel();
    _liveSalesSubscription?.close();
    super.dispose();
  }

  void _scheduleLiveRefresh() {
    _liveRefreshDebounce?.cancel();
    _liveRefreshDebounce = Timer(const Duration(milliseconds: 450), () {
      if (!mounted) {
        return;
      }
      _refresh();
    });
  }

  Future<void> _refresh() async {
    final ongoingRefresh = _refreshInFlight;
    if (ongoingRefresh != null) {
      await ongoingRefresh;
      return;
    }

    final refresh = () async {
      ref.invalidate(dashboardDataProvider);
      try {
        await ref.read(dashboardDataProvider.future);
      } catch (_) {
        // El estado de error ya lo maneja el provider en pantalla.
      }
    }();

    _refreshInFlight = refresh;
    try {
      await refresh;
    } finally {
      if (identical(_refreshInFlight, refresh)) {
        _refreshInFlight = null;
      }
    }
  }

  Future<void> _applyFilters(ReportsDashboardData data) async {
    final effectiveBranchId = _isValidOption(data.branches, _draftBranchId)
        ? _draftBranchId
        : null;
    final availableCashRegisters = _filterCashRegisters(
      data.cashRegisters,
      effectiveBranchId,
    );
    final effectiveCashRegisterId =
        _isValidOption(availableCashRegisters, _draftCashRegisterId)
        ? _draftCashRegisterId
        : null;
    final effectiveCashierId = _isValidOption(data.cashiers, _draftCashierId)
        ? _draftCashierId
        : null;

    setState(() {
      _draftBranchId = effectiveBranchId;
      _draftCashRegisterId = effectiveCashRegisterId;
      _draftCashierId = effectiveCashierId;
    });

    ref.read(dashboardRangePresetProvider.notifier).state = _draftPreset;
    ref.read(dashboardSelectedBranchIdProvider.notifier).state =
        effectiveBranchId;
    ref.read(dashboardSelectedCashRegisterIdProvider.notifier).state =
        effectiveCashRegisterId;
    ref.read(dashboardSelectedCashierIdProvider.notifier).state =
        effectiveCashierId;

    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final dashboardAsync = ref.watch(dashboardDataProvider);
    final profile = ref.watch(currentUserProfileProvider).valueOrNull;
    final liveCount = ref.watch(liveTodaySalesCountProvider).valueOrNull;
    final liveRevenue = ref.watch(liveTodayRevenueProvider).valueOrNull;

    return Scaffold(
      backgroundColor: _dashboardShellColor,
      appBar: AppBar(
        backgroundColor: _dashboardShellColor,
        foregroundColor: Colors.white,
        surfaceTintColor: Colors.transparent,
        titleSpacing: 8,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Hola, ${profile?.displayName.split(' ').first ?? 'admin'}',
              style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: Colors.white,
              ),
            ),
            Text(
              DateHelpers.date(DateTime.now()),
              style: const TextStyle(
                fontSize: 12,
                color: _dashboardMutedText,
                fontWeight: FontWeight.w500,
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.notifications_none_rounded),
            onPressed: () => context.push(AppRoutes.notifications),
          ),
          IconButton(
            icon: const Icon(Icons.refresh_rounded),
            onPressed: _refresh,
          ),
        ],
      ),
      drawer: const AppDrawer(),
      body: Container(
        color: _dashboardShellColor,
        child: dashboardAsync.when(
          loading: () => const _DashboardLoading(),
          error: (error, stackTrace) =>
              _DashboardError(message: '$error', onRetry: _refresh),
          data: (data) {
            return RefreshIndicator(
              onRefresh: _refresh,
              color: AppColors.primaryLight,
              backgroundColor: _dashboardPanelColor,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
                children: [
                  if (liveCount != null)
                    _LiveSalesBanner(count: liveCount, revenue: liveRevenue),
                  _buildFilterPanel(context, data, dashboardAsync.isLoading),
                  const SizedBox(height: 14),
                  _buildKpiGrid(data),
                  const SizedBox(height: 14),
                  _buildChartsSection(data),
                  const SizedBox(height: 14),
                  _buildTopProducts(data),
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _buildFilterPanel(
    BuildContext context,
    ReportsDashboardData data,
    bool isLoading,
  ) {
    final validBranchId = _isValidOption(data.branches, _draftBranchId)
        ? _draftBranchId
        : null;
    final availableCashRegisters = _filterCashRegisters(
      data.cashRegisters,
      validBranchId,
    );
    final validCashRegisterId =
        _isValidOption(availableCashRegisters, _draftCashRegisterId)
        ? _draftCashRegisterId
        : null;
    final validCashierId = _isValidOption(data.cashiers, _draftCashierId)
        ? _draftCashierId
        : null;

    return Container(
      decoration: BoxDecoration(
        color: _dashboardPanelColor,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _dashboardBorderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          // Cabecera siempre visible — tap para expandir/colapsar
          InkWell(
            onTap: () => setState(() => _filterExpanded = !_filterExpanded),
            borderRadius: BorderRadius.circular(16),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Row(
                children: [
                  const Icon(
                    Icons.tune_rounded,
                    size: 16,
                    color: _dashboardMutedText,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${_draftPreset.label}  ·  ${_formatRangeLabel(data.desde, data.hasta)}',
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 8),
                  AnimatedRotation(
                    turns: _filterExpanded ? 0.5 : 0,
                    duration: const Duration(milliseconds: 200),
                    child: const Icon(
                      Icons.keyboard_arrow_down_rounded,
                      color: _dashboardMutedText,
                      size: 20,
                    ),
                  ),
                ],
              ),
            ),
          ),

          // Contenido colapsable
          AnimatedCrossFade(
            duration: const Duration(milliseconds: 220),
            crossFadeState: _filterExpanded
                ? CrossFadeState.showFirst
                : CrossFadeState.showSecond,
            firstChild: Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final isWide = constraints.maxWidth >= 1100;
                  final fieldWidth = isWide ? 180.0 : constraints.maxWidth;

                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Divider(color: _dashboardBorderColor, height: 1),
                      const SizedBox(height: 12),
                      Wrap(
                        spacing: 10,
                        runSpacing: 10,
                        children: [
                          SizedBox(
                            width: fieldWidth,
                            child: _SelectField<ReportsRangePreset>(
                              label: 'Periodo',
                              value: _draftPreset,
                              items: ReportsRangePreset.values
                                  .map(
                                    (preset) => DropdownMenuItem(
                                      value: preset,
                                      child: Text(preset.label),
                                    ),
                                  )
                                  .toList(),
                              onChanged: (value) {
                                if (value == null) return;
                                setState(() => _draftPreset = value);
                              },
                            ),
                          ),
                          SizedBox(
                            width: fieldWidth,
                            child: _SelectField<String>(
                              label: 'Sucursal',
                              value: validBranchId,
                              placeholder: 'Todas',
                              items: data.branches
                                  .map(
                                    (item) => DropdownMenuItem(
                                      value: item.id,
                                      child: Text(item.label),
                                    ),
                                  )
                                  .toList(),
                              onChanged: (value) {
                                setState(() {
                                  _draftBranchId = value;
                                  _draftCashRegisterId = null;
                                });
                              },
                            ),
                          ),
                          SizedBox(
                            width: fieldWidth,
                            child: _SelectField<String>(
                              label: 'Caja',
                              value: validCashRegisterId,
                              placeholder: 'Todas',
                              items: availableCashRegisters
                                  .map(
                                    (item) => DropdownMenuItem(
                                      value: item.id,
                                      child: Text(item.label),
                                    ),
                                  )
                                  .toList(),
                              onChanged: (value) {
                                setState(() => _draftCashRegisterId = value);
                              },
                            ),
                          ),
                          SizedBox(
                            width: fieldWidth,
                            child: _SelectField<String>(
                              label: 'Cajero',
                              value: validCashierId,
                              placeholder: 'Todos',
                              items: data.cashiers
                                  .map(
                                    (item) => DropdownMenuItem(
                                      value: item.id,
                                      child: Text(item.label),
                                    ),
                                  )
                                  .toList(),
                              onChanged: (value) {
                                setState(() => _draftCashierId = value);
                              },
                            ),
                          ),
                          SizedBox(
                            width: isWide ? 140 : constraints.maxWidth,
                            child: FilledButton.icon(
                              onPressed: isLoading
                                  ? null
                                  : () async {
                                      await _applyFilters(data);
                                      if (mounted) {
                                        setState(
                                          () => _filterExpanded = false,
                                        );
                                      }
                                    },
                              icon: isLoading
                                  ? const SizedBox(
                                      width: 16,
                                      height: 16,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: Colors.white,
                                      ),
                                    )
                                  : const Icon(Icons.search_rounded, size: 18),
                              label: const Text('Aplicar'),
                              style: FilledButton.styleFrom(
                                backgroundColor: AppColors.secondaryLight,
                                foregroundColor: Colors.white,
                                minimumSize: const Size.fromHeight(48),
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(12),
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  );
                },
              ),
            ),
            secondChild: const SizedBox.shrink(),
          ),
        ],
      ),
    );
  }

  Widget _buildKpiGrid(ReportsDashboardData data) {
    final kpis = data.kpis;
    final totalSales = kpis.totalSales;

    final cards = <_KpiCardData>[
      _KpiCardData(
        title: 'TOTAL VENTAS',
        value: FormatHelpers.currency(kpis.totalSales),
        subtitle: '${kpis.totalInvoices} facturas',
        accent: AppColors.secondaryLight,
      ),
      _KpiCardData(
        title: 'GANANCIA BRUTA',
        value: FormatHelpers.currency(kpis.grossProfit),
        subtitle: '${kpis.margin.toStringAsFixed(1)}% margen',
        accent: AppColors.success,
      ),
      _KpiCardData(
        title: 'TICKET PROMEDIO',
        value: FormatHelpers.currency(kpis.avgTicket),
        subtitle: 'Por transacción',
        accent: AppColors.info,
      ),
      _KpiCardData(
        title: 'ITBIS RECAUDADO',
        value: FormatHelpers.currency(kpis.totalTax),
        subtitle: '${_shareOfSales(kpis.totalTax, totalSales)} aplicado',
        accent: AppColors.warning,
      ),
      _KpiCardData(
        title: 'EFECTIVO',
        value: FormatHelpers.currency(kpis.cash),
        subtitle: '${_shareOfSales(kpis.cash, totalSales)} de ventas',
        accent: const Color(0xFF1DD79B),
      ),
      _KpiCardData(
        title: 'TARJETA',
        value: FormatHelpers.currency(kpis.card),
        subtitle: '${_shareOfSales(kpis.card, totalSales)} de ventas',
        accent: const Color(0xFF27A8FF),
      ),
      _KpiCardData(
        title: 'TRANSFERENCIA',
        value: FormatHelpers.currency(kpis.transfer),
        subtitle: '${_shareOfSales(kpis.transfer, totalSales)} de ventas',
        accent: const Color(0xFF64B5FF),
      ),
      _KpiCardData(
        title: 'CRÉDITO',
        value: FormatHelpers.currency(kpis.credit),
        subtitle: 'Fiado acumulado',
        accent: const Color(0xFFFFB200),
      ),
    ];

    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 1100 ? 4 : 2;
        const spacing = 10.0;
        final width =
            (constraints.maxWidth - (spacing * (columns - 1))) / columns;

        return Wrap(
          spacing: spacing,
          runSpacing: spacing,
          children: cards
              .map(
                (card) => SizedBox(
                  width: width,
                  child: _DashboardKpiCard(data: card),
                ),
              )
              .toList(),
        );
      },
    );
  }

  Widget _buildChartsSection(ReportsDashboardData data) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final isWide = constraints.maxWidth >= 1024;
        const spacing = 16.0;
        final leftWidth = isWide
            ? (constraints.maxWidth - spacing) * 0.62
            : constraints.maxWidth;
        final rightWidth = isWide
            ? (constraints.maxWidth - spacing) * 0.38
            : constraints.maxWidth;

        return Wrap(
          spacing: spacing,
          runSpacing: spacing,
          children: [
            SizedBox(
              width: leftWidth,
              child: _SalesTrendCard(data: data),
            ),
            SizedBox(
              width: rightWidth,
              child: _PaymentMethodsCard(data: data),
            ),
          ],
        );
      },
    );
  }

  Widget _buildTopProducts(ReportsDashboardData data) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: _dashboardPanelColor,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: _dashboardBorderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Productos más vendidos',
            style: TextStyle(
              color: Colors.white,
              fontSize: 20,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 4),
          const Text(
            'Resumen del período seleccionado',
            style: TextStyle(color: _dashboardMutedText, fontSize: 13),
          ),
          const SizedBox(height: 18),
          if (data.topProducts.isEmpty)
            const _EmptyPanelMessage(
              title: 'No hay productos vendidos en este rango',
              subtitle:
                  'Prueba con otro período o revisa los filtros aplicados.',
            )
          else
            ...data.topProducts.asMap().entries.map((entry) {
              final index = entry.key;
              final product = entry.value;

              return Padding(
                padding: EdgeInsets.only(
                  bottom: index == data.topProducts.length - 1 ? 0 : 14,
                ),
                child: _TopProductTile(product: product, rank: index + 1),
              );
            }),
        ],
      ),
    );
  }

}

class _DashboardLoading extends StatelessWidget {
  const _DashboardLoading();

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(16),
      children: const [
        _LoadingBlock(height: 148),
        SizedBox(height: 16),
        _LoadingBlock(height: 340),
        SizedBox(height: 16),
        _LoadingBlock(height: 320),
      ],
    );
  }
}

class _DashboardError extends StatelessWidget {
  final String message;
  final Future<void> Function() onRetry;

  const _DashboardError({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Container(
          margin: const EdgeInsets.all(24),
          padding: const EdgeInsets.all(24),
          decoration: BoxDecoration(
            color: _dashboardPanelColor,
            borderRadius: BorderRadius.circular(22),
            border: Border.all(color: _dashboardBorderColor),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.error_outline_rounded,
                color: AppColors.error,
                size: 44,
              ),
              const SizedBox(height: 12),
              const Text(
                'No se pudo cargar el dashboard',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                message,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: _dashboardMutedText,
                  fontSize: 13,
                  height: 1.45,
                ),
              ),
              const SizedBox(height: 18),
              FilledButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('Reintentar'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DashboardKpiCard extends StatelessWidget {
  final _KpiCardData data;

  const _DashboardKpiCard({required this.data});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: _dashboardPanelColor,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _dashboardBorderColor),
        boxShadow: [
          BoxShadow(
            color: data.accent.withValues(alpha: 0.10),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Container(
                width: 32,
                height: 3,
                decoration: BoxDecoration(
                  color: data.accent,
                  borderRadius: BorderRadius.circular(999),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            data.title,
            style: const TextStyle(
              color: _dashboardMutedText,
              fontSize: 10,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.9,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            data.value,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 15,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            data.subtitle,
            style: const TextStyle(
              color: _dashboardMutedText,
              fontSize: 11,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}

class _SalesTrendCard extends StatelessWidget {
  final ReportsDashboardData data;

  const _SalesTrendCard({required this.data});

  @override
  Widget build(BuildContext context) {
    final trend = data.trend;
    final maxY = trend.isEmpty
        ? 10.0
        : math
              .max(trend.map((item) => item.total).reduce(math.max) * 1.18, 10)
              .toDouble();

    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: _dashboardPanelColor,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: _dashboardBorderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Tendencia de ventas',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 18,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    SizedBox(height: 4),
                    Text(
                      'Ventas diarias del período',
                      style: TextStyle(
                        color: _dashboardMutedText,
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                decoration: BoxDecoration(
                  color: AppColors.secondaryLight.withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  '${trend.length} días · ${FormatHelpers.currency(data.trendTotal)}',
                  style: const TextStyle(
                    color: Color(0xFFC7C3FF),
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          LayoutBuilder(
            builder: (context, constraints) {
              final chartHeight = constraints.maxWidth < 500 ? 180.0 : 260.0;
              return SizedBox(
                height: chartHeight,
                child: trend.isEmpty
                ? const _EmptyPanelMessage(
                    title: 'Sin ventas en el rango seleccionado',
                    subtitle:
                        'Cuando entren facturas aquí verás la curva diaria.',
                  )
                : LineChart(
                    LineChartData(
                      minY: 0.0,
                      maxY: maxY,
                      gridData: FlGridData(
                        show: true,
                        horizontalInterval: maxY / 5,
                        drawVerticalLine: false,
                        getDrawingHorizontalLine: (_) => const FlLine(
                          color: Color(0x1FFFFFFF),
                          strokeWidth: 1,
                        ),
                      ),
                      borderData: FlBorderData(show: false),
                      lineTouchData: LineTouchData(
                        touchTooltipData: LineTouchTooltipData(
                          getTooltipColor: (_) => const Color(0xFF20283A),
                          tooltipBorder: const BorderSide(
                            color: _dashboardBorderColor,
                          ),
                          getTooltipItems: (spots) => spots.map((spot) {
                            final point = trend[spot.x.toInt()];
                            return LineTooltipItem(
                              '${DateHelpers.dayMonth(point.date)}\n${FormatHelpers.currency(point.total)}',
                              const TextStyle(
                                color: Colors.white,
                                fontWeight: FontWeight.w700,
                                fontSize: 12,
                              ),
                            );
                          }).toList(),
                        ),
                      ),
                      titlesData: FlTitlesData(
                        topTitles: const AxisTitles(
                          sideTitles: SideTitles(showTitles: false),
                        ),
                        rightTitles: const AxisTitles(
                          sideTitles: SideTitles(showTitles: false),
                        ),
                        leftTitles: AxisTitles(
                          sideTitles: SideTitles(
                            showTitles: true,
                            reservedSize: 46,
                            interval: maxY / 5,
                            getTitlesWidget: (value, _) => Text(
                              _axisCompactLabel(value),
                              style: const TextStyle(
                                color: _dashboardMutedText,
                                fontSize: 11,
                              ),
                            ),
                          ),
                        ),
                        bottomTitles: AxisTitles(
                          sideTitles: SideTitles(
                            showTitles: true,
                            reservedSize: 28,
                            getTitlesWidget: (value, _) {
                              final index = value.toInt();
                              if (index < 0 || index >= trend.length) {
                                return const SizedBox.shrink();
                              }

                              final step = trend.length > 7
                                  ? (trend.length / 6).ceil()
                                  : 1;
                              final showLabel =
                                  index == 0 ||
                                  index == trend.length - 1 ||
                                  index % step == 0;
                              if (!showLabel) {
                                return const SizedBox.shrink();
                              }

                              return Padding(
                                padding: const EdgeInsets.only(top: 8),
                                child: Text(
                                  DateHelpers.dayMonth(trend[index].date),
                                  style: const TextStyle(
                                    color: _dashboardMutedText,
                                    fontSize: 11,
                                  ),
                                ),
                              );
                            },
                          ),
                        ),
                      ),
                      lineBarsData: [
                        LineChartBarData(
                          isCurved: true,
                          color: AppColors.secondaryLight,
                          barWidth: 3,
                          spots: trend
                              .asMap()
                              .entries
                              .map(
                                (entry) => FlSpot(
                                  entry.key.toDouble(),
                                  entry.value.total,
                                ),
                              )
                              .toList(),
                          belowBarData: BarAreaData(
                            show: true,
                            gradient: LinearGradient(
                              colors: [
                                AppColors.secondaryLight.withValues(
                                  alpha: 0.32,
                                ),
                                AppColors.secondaryLight.withValues(
                                  alpha: 0.02,
                                ),
                              ],
                              begin: Alignment.topCenter,
                              end: Alignment.bottomCenter,
                            ),
                          ),
                          dotData: FlDotData(
                            show: true,
                            getDotPainter: (spot, a, b, c) =>
                                FlDotCirclePainter(
                                  radius: 3.6,
                                  color: AppColors.secondaryLight,
                                  strokeWidth: 2,
                                  strokeColor: _dashboardPanelColor,
                                ),
                          ),
                        ),
                      ],
                    ),
                  ),
              );
            },
          ),
        ],
      ),
    );
  }
}

class _PaymentMethodsCard extends StatelessWidget {
  final ReportsDashboardData data;

  const _PaymentMethodsCard({required this.data});

  @override
  Widget build(BuildContext context) {
    final methods = data.paymentMethods;
    final total = methods.fold<double>(
      0,
      (runningTotal, item) => runningTotal + item.total,
    );

    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: _dashboardPanelColor,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: _dashboardBorderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Métodos de pago',
            style: TextStyle(
              color: Colors.white,
              fontSize: 18,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 4),
          const Text(
            'Distribución por canal',
            style: TextStyle(color: _dashboardMutedText, fontSize: 13),
          ),
          const SizedBox(height: 18),
          if (methods.isEmpty)
            const SizedBox(
              height: 280,
              child: _EmptyPanelMessage(
                title: 'Sin métodos de pago para mostrar',
                subtitle:
                    'En cuanto entren ventas aquí verás el reparto por canal.',
              ),
            )
          else ...[
            LayoutBuilder(
              builder: (context, constraints) => SizedBox(
                height: constraints.maxWidth < 500 ? 160.0 : 200.0,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    PieChart(
                      PieChartData(
                        centerSpaceRadius: 58,
                        sectionsSpace: 3,
                        sections: methods.asMap().entries.map((entry) {
                          final index = entry.key;
                          final method = entry.value;
                          final color = AppColors
                              .chartColors[index % AppColors.chartColors.length];

                          return PieChartSectionData(
                            color: color,
                            value: method.total,
                            radius: 36,
                            showTitle: false,
                          );
                        }).toList(),
                      ),
                    ),
                    Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text(
                          'TOTAL',
                          style: TextStyle(
                            color: _dashboardMutedText,
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          FormatHelpers.currencyCompact(total),
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 16,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 14),
            ...methods.asMap().entries.map((entry) {
              final index = entry.key;
              final method = entry.value;
              final color =
                  AppColors.chartColors[index % AppColors.chartColors.length];
              return Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Row(
                  children: [
                    Container(
                      width: 12,
                      height: 12,
                      decoration: BoxDecoration(
                        color: color,
                        borderRadius: BorderRadius.circular(999),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        method.label,
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    Text(
                      FormatHelpers.currency(method.total),
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      '${method.percentage.toStringAsFixed(1)}%',
                      style: const TextStyle(
                        color: _dashboardMutedText,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              );
            }),
          ],
        ],
      ),
    );
  }
}

class _TopProductTile extends StatelessWidget {
  final ReportsTopProduct product;
  final int rank;

  const _TopProductTile({required this.product, required this.rank});

  @override
  Widget build(BuildContext context) {
    final progress = (product.participation / 100).clamp(0.0, 1.0);

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF121826),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _dashboardBorderColor),
      ),
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: AppColors.secondaryLight.withValues(alpha: 0.16),
              borderRadius: BorderRadius.circular(14),
            ),
            alignment: Alignment.center,
            child: Text(
              '$rank',
              style: const TextStyle(
                color: Color(0xFFC7C3FF),
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  product.name,
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  [
                        if (product.category.isNotEmpty) product.category,
                        if (product.code.isNotEmpty) 'Cod. ${product.code}',
                      ].join(' · ').isEmpty
                      ? product.quantityLabel
                      : '${[if (product.category.isNotEmpty) product.category, if (product.code.isNotEmpty) 'Cod. ${product.code}'].join(' · ')} · ${product.quantityLabel}',
                  style: const TextStyle(
                    color: _dashboardMutedText,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 10),
                ClipRRect(
                  borderRadius: BorderRadius.circular(999),
                  child: LinearProgressIndicator(
                    minHeight: 7,
                    value: progress,
                    backgroundColor: Colors.white.withValues(alpha: 0.08),
                    valueColor: const AlwaysStoppedAnimation(
                      AppColors.secondaryLight,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 14),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                FormatHelpers.currency(product.totalSold),
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                '${product.participation.toStringAsFixed(1)}%',
                style: const TextStyle(
                  color: _dashboardMutedText,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}


class _SelectField<T> extends StatelessWidget {
  final String label;
  final T? value;
  final String? placeholder;
  final List<DropdownMenuItem<T>> items;
  final ValueChanged<T?> onChanged;

  const _SelectField({
    required this.label,
    required this.value,
    this.placeholder,
    required this.items,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return DropdownButtonFormField<T>(
      initialValue: value,
      dropdownColor: _dashboardPanelColor,
      decoration: InputDecoration(
        labelText: label,
        labelStyle: const TextStyle(color: _dashboardMutedText),
        filled: true,
        fillColor: const Color(0xFF121826),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: const BorderSide(color: _dashboardBorderColor),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: const BorderSide(
            color: AppColors.secondaryLight,
            width: 1.6,
          ),
        ),
      ),
      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600),
      iconEnabledColor: Colors.white,
      hint: placeholder == null
          ? null
          : Text(
              placeholder!,
              style: const TextStyle(color: _dashboardMutedText),
            ),
      items: items,
      onChanged: onChanged,
    );
  }
}

class _EmptyPanelMessage extends StatelessWidget {
  final String title;
  final String subtitle;

  const _EmptyPanelMessage({required this.title, required this.subtitle});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(
              Icons.insights_outlined,
              size: 36,
              color: _dashboardMutedText,
            ),
            const SizedBox(height: 10),
            Text(
              title,
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 15,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              subtitle,
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: _dashboardMutedText,
                fontSize: 12,
                height: 1.45,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LoadingBlock extends StatelessWidget {
  final double height;

  const _LoadingBlock({required this.height});

  @override
  Widget build(BuildContext context) {
    return Container(
      height: height,
      decoration: BoxDecoration(
        color: _dashboardPanelColor,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: _dashboardBorderColor),
      ),
    );
  }
}

class _KpiCardData {
  final String title;
  final String value;
  final String subtitle;
  final Color accent;

  const _KpiCardData({
    required this.title,
    required this.value,
    required this.subtitle,
    required this.accent,
  });
}

bool _isValidOption(List<DashboardFilterOption> options, String? value) {
  if (value == null || value.trim().isEmpty) {
    return false;
  }
  return options.any((item) => item.id == value);
}

List<DashboardFilterOption> _filterCashRegisters(
  List<DashboardFilterOption> options,
  String? branchId,
) {
  if (branchId == null || branchId.trim().isEmpty) {
    return options;
  }
  return options
      .where((item) => item.parentId == null || item.parentId == branchId)
      .toList();
}

String _shareOfSales(double amount, double totalSales) {
  if (totalSales <= 0) {
    return '0.0%';
  }
  final percent = (amount / totalSales) * 100;
  return '${percent.toStringAsFixed(1)}%';
}

String _formatRangeLabel(String desde, String hasta) {
  final from = DateTime.tryParse(desde);
  final to = DateTime.tryParse(hasta);
  if (from == null || to == null) {
    return '$desde - $hasta';
  }
  return '${DateHelpers.date(from)} - ${DateHelpers.date(to)}';
}

String _axisCompactLabel(double value) {
  if (value >= 1000) {
    return '${(value / 1000).toStringAsFixed(0)}k';
  }
  return value.toStringAsFixed(0);
}

/// Banner superior que muestra ventas del día en tiempo real (vía Firestore).
class _LiveSalesBanner extends StatelessWidget {
  const _LiveSalesBanner({required this.count, this.revenue});

  final int count;
  final double? revenue;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF0F2318),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFF1E4D2E)),
      ),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: const BoxDecoration(
              color: Color(0xFF22C55E),
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 8),
          const Text(
            'En vivo hoy',
            style: TextStyle(
              color: Color(0xFF22C55E),
              fontSize: 12,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.5,
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Text(
              count == 0
                  ? 'Sin ventas aún hoy'
                  : revenue != null
                  ? '$count ${count == 1 ? 'venta' : 'ventas'} · ${FormatHelpers.currency(revenue!)}'
                  : '$count ${count == 1 ? 'venta' : 'ventas'}',
              style: const TextStyle(
                color: Colors.white,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}

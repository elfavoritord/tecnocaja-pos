import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/constants/app_colors.dart';
import '../../../../core/utils/format_helpers.dart';
import '../../../../data/models/sale_model.dart';
import '../../../../data/repositories/sales_repository.dart';
import '../../../../features/auth/providers/auth_provider.dart';
import '../../../../shared/widgets/app_drawer.dart';

const _bgColor = Color(0xFF0D1117);
const _panelColor = Color(0xFF161B22);
const _borderColor = Color(0xFF21262D);
const _mutedText = Color(0xFF8B949E);

final _liveSalesProvider = StreamProvider.autoDispose<List<SaleModel>>((ref) {
  ref.keepAlive();
  final businessId = ref.watch(activeBusinessIdProvider);
  if (businessId == null || businessId.isEmpty) return const Stream.empty();
  return SalesRepository().watchSales(
    businessId,
    from: DateHelpers.todayStart,
    to: DateHelpers.todayEnd,
  );
});

class LiveSalesScreen extends ConsumerWidget {
  const LiveSalesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final salesAsync = ref.watch(_liveSalesProvider);

    return Scaffold(
      backgroundColor: _bgColor,
      appBar: AppBar(
        backgroundColor: _bgColor,
        foregroundColor: Colors.white,
        surfaceTintColor: Colors.transparent,
        titleSpacing: 8,
        title: const _LiveIndicatorTitle(),
        actions: [
          IconButton(
            icon: const Icon(Icons.home_rounded),
            tooltip: 'Ir al inicio',
            onPressed: () => context.go('/dashboard'),
          ),
        ],
      ),
      drawer: const AppDrawer(),
      body: salesAsync.when(
        loading: () => const Center(
          child: CircularProgressIndicator(color: AppColors.success),
        ),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.error_outline, color: AppColors.error, size: 44),
                const SizedBox(height: 12),
                Text(
                  'Error al conectar con Firestore',
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  '$e',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: _mutedText, fontSize: 12),
                ),
              ],
            ),
          ),
        ),
        data: (sales) => _LiveBody(sales: sales),
      ),
    );
  }
}

class _LiveIndicatorTitle extends StatefulWidget {
  const _LiveIndicatorTitle();

  @override
  State<_LiveIndicatorTitle> createState() => _LiveIndicatorTitleState();
}

class _LiveIndicatorTitleState extends State<_LiveIndicatorTitle>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  late final Animation<double> _anim;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat(reverse: true);
    _anim = Tween<double>(begin: 0.3, end: 1.0).animate(
      CurvedAnimation(parent: _ctrl, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        FadeTransition(
          opacity: _anim,
          child: Container(
            width: 10,
            height: 10,
            decoration: const BoxDecoration(
              color: Color(0xFF22C55E),
              shape: BoxShape.circle,
            ),
          ),
        ),
        const SizedBox(width: 8),
        const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Feed en vivo',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
            ),
            Text(
              'Ventas de hoy — tiempo real',
              style: TextStyle(fontSize: 11, color: _mutedText),
            ),
          ],
        ),
      ],
    );
  }
}

class _LiveBody extends StatelessWidget {
  final List<SaleModel> sales;

  const _LiveBody({required this.sales});

  @override
  Widget build(BuildContext context) {
    final totalRevenue = sales.fold<double>(0, (s, v) => s + v.total);
    final totalTax = sales.fold<double>(0, (s, v) => s + v.tax);
    final avgTicket = sales.isEmpty ? 0.0 : totalRevenue / sales.length;

    return Column(
      children: [
        _StatsRow(
          count: sales.length,
          revenue: totalRevenue,
          itbis: totalTax,
          avgTicket: avgTicket,
        ),
        Expanded(
          child: sales.isEmpty
              ? const _EmptyLive()
              : ListView.builder(
                  padding: const EdgeInsets.fromLTRB(14, 6, 14, 24),
                  itemCount: sales.length,
                  itemBuilder: (context, index) => Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: _SaleTile(
                      sale: sales[index],
                      isNewest: index == 0,
                    ),
                  ),
                ),
        ),
      ],
    );
  }
}

class _StatsRow extends StatelessWidget {
  final int count;
  final double revenue;
  final double itbis;
  final double avgTicket;

  const _StatsRow({
    required this.count,
    required this.revenue,
    required this.itbis,
    required this.avgTicket,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(14, 12, 14, 6),
      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 16),
      decoration: BoxDecoration(
        color: _panelColor,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _borderColor),
      ),
      child: Row(
        children: [
          _StatPill(
            label: 'VENTAS',
            value: FormatHelpers.currency(revenue),
            accent: AppColors.success,
          ),
          const _Divider(),
          _StatPill(
            label: 'ITBIS',
            value: FormatHelpers.currency(itbis),
            accent: AppColors.warning,
          ),
          const _Divider(),
          _StatPill(
            label: 'TICKET PROM.',
            value: FormatHelpers.currency(avgTicket),
            accent: AppColors.info,
          ),
          const _Divider(),
          _StatPill(
            label: 'TRANSACC.',
            value: '$count',
            accent: AppColors.secondaryLight,
          ),
        ],
      ),
    );
  }
}

class _StatPill extends StatelessWidget {
  final String label;
  final String value;
  final Color accent;

  const _StatPill({
    required this.label,
    required this.value,
    required this.accent,
  });

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Text(
            label,
            style: TextStyle(
              color: accent,
              fontSize: 9,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.8,
            ),
          ),
          const SizedBox(height: 3),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              value,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 14,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Divider extends StatelessWidget {
  const _Divider();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 1,
      height: 32,
      margin: const EdgeInsets.symmetric(horizontal: 10),
      color: _borderColor,
    );
  }
}

class _SaleTile extends StatelessWidget {
  final SaleModel sale;
  final bool isNewest;

  const _SaleTile({required this.sale, required this.isNewest});

  @override
  Widget build(BuildContext context) {
    final accentColor = isNewest ? AppColors.success : _borderColor;

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: isNewest
            ? const Color(0xFF0D2318)
            : _panelColor,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: isNewest ? const Color(0xFF1A4731) : _borderColor,
        ),
      ),
      child: Row(
        children: [
          // Método de pago icono
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: _paymentColor(sale.paymentMethod).withValues(alpha: 0.15),
              borderRadius: BorderRadius.circular(12),
            ),
            alignment: Alignment.center,
            child: Icon(
              _paymentIcon(sale.paymentMethod),
              color: _paymentColor(sale.paymentMethod),
              size: 20,
            ),
          ),
          const SizedBox(width: 12),
          // Info principal
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    if (isNewest) ...[
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 6,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: AppColors.success.withValues(alpha: 0.2),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: const Text(
                          'NUEVA',
                          style: TextStyle(
                            color: AppColors.success,
                            fontSize: 9,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 0.5,
                          ),
                        ),
                      ),
                      const SizedBox(width: 6),
                    ],
                    Expanded(
                      child: Text(
                        sale.cashierName.isNotEmpty
                            ? sale.cashierName
                            : 'Caja principal',
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w600,
                          fontSize: 13,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 3),
                Row(
                  children: [
                    Icon(Icons.schedule_rounded, size: 12, color: _mutedText),
                    const SizedBox(width: 3),
                    Text(
                      DateHelpers.time(sale.createdAt),
                      style: const TextStyle(color: _mutedText, fontSize: 11),
                    ),
                    if (sale.branchName.isNotEmpty) ...[
                      const Text(
                        ' · ',
                        style: TextStyle(color: _mutedText, fontSize: 11),
                      ),
                      Expanded(
                        child: Text(
                          sale.branchName,
                          style: const TextStyle(
                            color: _mutedText,
                            fontSize: 11,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ],
                ),
                if (sale.customerName != null &&
                    sale.customerName!.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      const Icon(
                        Icons.person_outline_rounded,
                        size: 12,
                        color: _mutedText,
                      ),
                      const SizedBox(width: 3),
                      Expanded(
                        child: Text(
                          sale.customerName!,
                          style: const TextStyle(
                            color: _mutedText,
                            fontSize: 11,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 10),
          // Importe + items
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                FormatHelpers.currency(sale.total),
                style: TextStyle(
                  color: accentColor == _borderColor ? Colors.white : accentColor,
                  fontWeight: FontWeight.w800,
                  fontSize: 15,
                ),
              ),
              const SizedBox(height: 3),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: _paymentColor(sale.paymentMethod).withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  sale.paymentMethod.label,
                  style: TextStyle(
                    color: _paymentColor(sale.paymentMethod),
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(height: 3),
              Text(
                '${sale.items.length} ${sale.items.length == 1 ? 'artículo' : 'artículos'}',
                style: const TextStyle(color: _mutedText, fontSize: 10),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Color _paymentColor(PaymentMethod method) {
    switch (method) {
      case PaymentMethod.cash:
        return const Color(0xFF22C55E);
      case PaymentMethod.card:
        return const Color(0xFF3B82F6);
      case PaymentMethod.transfer:
        return const Color(0xFF8B5CF6);
      case PaymentMethod.credit:
        return const Color(0xFFF59E0B);
      case PaymentMethod.mixed:
        return const Color(0xFF0EA5E9);
    }
  }

  IconData _paymentIcon(PaymentMethod method) {
    switch (method) {
      case PaymentMethod.cash:
        return Icons.payments_rounded;
      case PaymentMethod.card:
        return Icons.credit_card_rounded;
      case PaymentMethod.transfer:
        return Icons.swap_horiz_rounded;
      case PaymentMethod.credit:
        return Icons.receipt_long_rounded;
      case PaymentMethod.mixed:
        return Icons.account_balance_wallet_rounded;
    }
  }
}

class _EmptyLive extends StatelessWidget {
  const _EmptyLive();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 72,
            height: 72,
            decoration: BoxDecoration(
              color: AppColors.success.withValues(alpha: 0.1),
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: const Icon(
              Icons.point_of_sale_rounded,
              color: AppColors.success,
              size: 34,
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            'Sin ventas aún hoy',
            style: TextStyle(
              color: Colors.white,
              fontSize: 18,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 6),
          const Text(
            'En cuanto el POS registre una venta\naparecerá aquí automáticamente.',
            textAlign: TextAlign.center,
            style: TextStyle(color: _mutedText, fontSize: 13, height: 1.5),
          ),
        ],
      ),
    );
  }
}

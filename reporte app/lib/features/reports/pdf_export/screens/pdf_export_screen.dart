import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/constants/app_colors.dart';
import '../../../../shared/widgets/report_scaffold.dart' show isCompact, hPad;
import '../../../auth/providers/auth_provider.dart';
import '../services/report_pdf_service.dart';

final _reportPdfServiceProvider = Provider<ReportPdfService>(
  (_) => ReportPdfService(),
);

class _ReportType {
  final String title;
  final String subtitle;
  final IconData icon;
  final Color color;
  final String route;

  const _ReportType({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.color,
    required this.route,
  });
}

const _reports = [
  _ReportType(
    title: 'Ventas',
    subtitle: 'Resumen de ventas por período',
    icon: Icons.point_of_sale_rounded,
    color: Color(0xFF6366F1),
    route: '/reports/sales',
  ),
  _ReportType(
    title: 'Ganancias',
    subtitle: 'Rentabilidad y margen bruto',
    icon: Icons.trending_up_rounded,
    color: Color(0xFF10B981),
    route: '/reports/profits',
  ),
  _ReportType(
    title: 'Inventario',
    subtitle: 'Stock actual y alertas',
    icon: Icons.inventory_2_outlined,
    color: Color(0xFF0EA5E9),
    route: '/reports/inventory',
  ),
  _ReportType(
    title: 'Caja',
    subtitle: 'Aperturas y cierres de caja',
    icon: Icons.account_balance_wallet_outlined,
    color: Color(0xFFF59E0B),
    route: '/reports/cash',
  ),
  _ReportType(
    title: 'Cuentas por Pagar y Cobrar',
    subtitle: 'Clientes y suplidores con saldos pendientes',
    icon: Icons.receipt_long_outlined,
    color: Color(0xFFEF4444),
    route: '/reports/receivables',
  ),
  _ReportType(
    title: 'Gastos',
    subtitle: 'Egresos y categorías de gasto',
    icon: Icons.money_off_rounded,
    color: Color(0xFFF97316),
    route: '/reports/expenses',
  ),
  _ReportType(
    title: 'Clientes',
    subtitle: 'Top clientes y frecuencia',
    icon: Icons.people_outline_rounded,
    color: Color(0xFF8B5CF6),
    route: '/reports/customers',
  ),
  _ReportType(
    title: 'Sucursales',
    subtitle: 'Comparativa entre sucursales',
    icon: Icons.store_outlined,
    color: Color(0xFF14B8A6),
    route: '/reports/branches',
  ),
  _ReportType(
    title: 'Fiscal (NCF)',
    subtitle: 'Comprobantes fiscales DGII',
    icon: Icons.description_outlined,
    color: Color(0xFF64748B),
    route: '/reports/fiscal',
  ),
];

class PdfExportScreen extends ConsumerStatefulWidget {
  const PdfExportScreen({super.key});

  @override
  ConsumerState<PdfExportScreen> createState() => _PdfExportScreenState();
}

class _PdfExportScreenState extends ConsumerState<PdfExportScreen> {
  String? _exportingRoute;

  @override
  Widget build(BuildContext context) {
    final compact = isCompact(context);
    final h = hPad(context);
    final profile = ref.watch(currentUserProfileProvider).valueOrNull;
    final businessId = ref.watch(activeBusinessIdProvider) ?? '';
    final branchIds = ref.watch(activeBranchIdsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Exportar Reportes'),
        leading: BackButton(onPressed: () => context.go('/dashboard')),
        actions: [
          IconButton(
            icon: const Icon(Icons.home_rounded),
            tooltip: 'Ir al inicio',
            onPressed: () => context.go('/dashboard'),
          ),
        ],
      ),
      body: ListView(
        padding: EdgeInsets.fromLTRB(h, compact ? 12 : 16, h, 32),
        children: [
          Container(
            padding: EdgeInsets.all(compact ? 14 : 18),
            decoration: BoxDecoration(
              gradient: AppColors.primaryGradient,
              borderRadius: BorderRadius.circular(compact ? 14 : 18),
              boxShadow: [
                BoxShadow(
                  color: AppColors.primary.withValues(alpha: 0.25),
                  blurRadius: 16,
                  offset: const Offset(0, 6),
                ),
              ],
            ),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: const Icon(
                    Icons.picture_as_pdf_rounded,
                    color: Colors.white,
                    size: 28,
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Panel de Exportación',
                        style: TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w800,
                          fontSize: compact ? 15 : 17,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        'Abre el reporte o descárgalo en PDF directamente desde su icono.',
                        style: TextStyle(
                          color: Colors.white.withValues(alpha: 0.82),
                          fontSize: compact ? 11 : 12,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          SizedBox(height: compact ? 14 : 18),
          if (businessId.isNotEmpty)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              margin: const EdgeInsets.only(bottom: 14),
              decoration: BoxDecoration(
                color: AppColors.primary.withValues(alpha: 0.07),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: AppColors.primary.withValues(alpha: 0.2),
                ),
              ),
              child: Row(
                children: [
                  const Icon(
                    Icons.business_rounded,
                    size: 16,
                    color: AppColors.primary,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      profile != null
                          ? '${profile.displayName} · $businessId'
                          : businessId,
                      style: const TextStyle(
                        fontSize: 12,
                        color: AppColors.primary,
                        fontWeight: FontWeight.w500,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
          LayoutBuilder(
            builder: (context, constraints) {
              final width = constraints.maxWidth;
              final columns = width >= 1280
                  ? 4
                  : width >= 900
                  ? 3
                  : width >= 620
                  ? 2
                  : 2;
              final aspectRatio = width >= 1100
                  ? 1.42
                  : width >= 900
                  ? 1.24
                  : width >= 620
                  ? 1.02
                  : 0.96;

              return GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: columns,
                  crossAxisSpacing: compact ? 10 : 12,
                  mainAxisSpacing: compact ? 10 : 12,
                  childAspectRatio: aspectRatio,
                ),
                itemCount: _reports.length,
                itemBuilder: (context, index) {
                  final report = _reports[index];
                  return _ReportCard(
                    report: report,
                    compact: compact,
                    isExporting: _exportingRoute == report.route,
                    onOpen: () => context.go(report.route),
                    onExport: businessId.isEmpty
                        ? null
                        : () => _exportReport(
                            report: report,
                            businessId: businessId,
                            branchIds: branchIds,
                          ),
                  );
                },
              );
            },
          ),
          SizedBox(height: compact ? 14 : 18),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.warning.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                color: AppColors.warning.withValues(alpha: 0.3),
              ),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(
                  Icons.download_done_rounded,
                  color: AppColors.warning,
                  size: 18,
                ),
                const SizedBox(width: 10),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Descarga directa',
                        style: TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 13,
                          color: AppColors.warning,
                        ),
                      ),
                      SizedBox(height: 4),
                      Text(
                        'El icono PDF descarga el resumen del reporte con los filtros activos de tu negocio o sucursal.',
                        style: TextStyle(
                          fontSize: 12,
                          color: AppColors.textSecondary,
                          height: 1.4,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _exportReport({
    required _ReportType report,
    required String businessId,
    required List<String>? branchIds,
  }) async {
    if (_exportingRoute != null) return;

    final profile = ref.read(currentUserProfileProvider).valueOrNull;
    final normalizedRole = (profile?.posRoleCode ?? profile?.posRole ?? '')
        .trim()
        .toLowerCase();
    final cashRegisterIds =
        profile?.effectiveCashRegisterIds ?? const <String>[];
    final restrictCashToCurrentUser =
        normalizedRole == 'cajero' ||
        normalizedRole == 'cashier' ||
        cashRegisterIds.isNotEmpty;

    setState(() => _exportingRoute = report.route);
    try {
      final result = await ref
          .read(_reportPdfServiceProvider)
          .exportReport(
            ReportPdfRequest(
              title: report.title,
              route: report.route,
              businessId: businessId,
              generatedBy: profile?.displayName ?? 'Usuario POS',
              branchIds: branchIds,
              cashRegisterIds: cashRegisterIds,
              restrictCashToCurrentUser: restrictCashToCurrentUser,
            ),
          );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('PDF guardado: ${result.filePath}'),
          backgroundColor: AppColors.success,
        ),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('No se pudo exportar ${report.title}: $error'),
          backgroundColor: AppColors.error,
        ),
      );
    } finally {
      if (mounted) {
        setState(() => _exportingRoute = null);
      }
    }
  }
}

class _ReportCard extends StatelessWidget {
  final _ReportType report;
  final bool compact;
  final bool isExporting;
  final VoidCallback onOpen;
  final VoidCallback? onExport;

  const _ReportCard({
    required this.report,
    required this.compact,
    required this.isExporting,
    required this.onOpen,
    required this.onExport,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return AnimatedContainer(
      duration: const Duration(milliseconds: 150),
      padding: EdgeInsets.all(compact ? 12 : 14),
      decoration: BoxDecoration(
        color: Theme.of(context).cardColor,
        borderRadius: BorderRadius.circular(compact ? 14 : 16),
        border: Border.all(color: report.color.withValues(alpha: 0.3)),
        boxShadow: [
          BoxShadow(
            color: report.color.withValues(alpha: 0.08),
            blurRadius: 8,
            offset: const Offset(0, 3),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: EdgeInsets.all(compact ? 8 : 10),
                decoration: BoxDecoration(
                  color: report.color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(
                  report.icon,
                  color: report.color,
                  size: compact ? 18 : 20,
                ),
              ),
              const Spacer(),
              IconButton(
                onPressed: isExporting ? null : onExport,
                tooltip: 'Descargar PDF',
                icon: isExporting
                    ? SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          valueColor: AlwaysStoppedAnimation<Color>(
                            report.color,
                          ),
                        ),
                      )
                    : Icon(
                        Icons.picture_as_pdf_rounded,
                        color: isDark
                            ? AppColors.textDarkSecondary
                            : AppColors.textSecondary,
                        size: 18,
                      ),
              ),
            ],
          ),
          const Spacer(),
          Text(
            report.title,
            style: TextStyle(
              fontWeight: FontWeight.w700,
              fontSize: compact ? 13 : 14,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 3),
          Text(
            report.subtitle,
            style: TextStyle(
              color: isDark
                  ? AppColors.textDarkSecondary
                  : AppColors.textSecondary,
              fontSize: compact ? 10 : 11,
              height: 1.3,
            ),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: TextButton(
              style: TextButton.styleFrom(
                backgroundColor: report.color.withValues(alpha: 0.1),
                foregroundColor: report.color,
                padding: EdgeInsets.symmetric(vertical: compact ? 6 : 8),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8),
                ),
                minimumSize: Size.zero,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              onPressed: onOpen,
              child: Text(
                'Ver reporte',
                style: TextStyle(
                  fontSize: compact ? 11 : 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/utils/app_date_utils.dart';
import '../../../core/utils/formatters.dart';
import '../../../data/models/user_model.dart';
import '../../../data/models/declaracion_model.dart';
import '../../auth/providers/auth_provider.dart';
import '../../dashboard/providers/dashboard_provider.dart';
import '../../declaraciones/providers/declaraciones_provider.dart';

class ReportesScreen extends ConsumerWidget {
  const ReportesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text('Reportes')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _SectionTitle(title: 'Resumen general'),
          const SizedBox(height: 8),
          _ReporteCard(
            icon: Icons.business_rounded,
            color: AppColors.primary,
            title: 'Reporte de clientes',
            subtitle: 'Listado de todos los clientes con estado y vencimientos',
            onTap: () => _generarReporteClientes(context, ref),
          ),
          const SizedBox(height: 10),
          _ReporteCard(
            icon: Icons.receipt_long_rounded,
            color: AppColors.secondary,
            title: 'Reporte de declaraciones',
            subtitle: 'Historial de declaraciones por período y estado',
            onTap: () => _generarReporteDeclaraciones(context, ref),
          ),
          const SizedBox(height: 10),
          _ReporteCard(
            icon: Icons.calendar_month_rounded,
            color: AppColors.success,
            title: 'Próximos vencimientos',
            subtitle: 'Declaraciones por vencer en los próximos 30 días',
            onTap: () => _generarReporteVencimientos(context, ref),
          ),
          const SizedBox(height: 24),
          _SectionTitle(title: 'Por período'),
          const SizedBox(height: 8),
          _ReporteCard(
            icon: Icons.bar_chart_rounded,
            color: AppColors.warning,
            title: 'Declaraciones del mes',
            subtitle: 'Resumen de declaraciones del mes actual',
            onTap: () => _generarReporteMes(context, ref),
          ),
          const SizedBox(height: 10),
          _ReporteCard(
            icon: Icons.trending_up_rounded,
            color: AppColors.info,
            title: 'Actividad anual',
            subtitle: 'Estadísticas y actividad del año en curso',
            onTap: () => _generarReporteAnual(context, ref),
          ),
          const SizedBox(height: 80),
        ],
      ),
    );
  }

  Future<void> _generarReporteClientes(BuildContext context, WidgetRef ref) async {
    final profile = ref.read(userProfileProvider).valueOrNull;
    if (profile == null) return;

    _showGenerando(context);

    final stats = await ref.read(dashboardStatsProvider.future).catchError((_) => <String, dynamic>{});
    final clientes = (stats['recientes'] as List? ?? []).cast<ClienteModel>();

    final pdf = pw.Document();
    pdf.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.letter,
        build: (ctx) => [
          pw.Header(level: 0, child: pw.Text('Reporte de Clientes — ${profile.nombreFirma}', style: pw.TextStyle(fontSize: 18, fontWeight: pw.FontWeight.bold))),
          pw.Text('Generado: ${AppDateUtils.formatFechaHora(DateTime.now())}', style: const pw.TextStyle(fontSize: 10)),
          pw.SizedBox(height: 16),
          pw.Text('Resumen', style: pw.TextStyle(fontSize: 14, fontWeight: pw.FontWeight.bold)),
          pw.SizedBox(height: 8),
          pw.Table.fromTextArray(
            headers: ['Métrica', 'Cantidad'],
            data: [
              ['Total clientes', '${stats['total'] ?? 0}'],
              ['Activos', '${stats['activos'] ?? 0}'],
              ['En prueba', '${stats['prueba'] ?? 0}'],
              ['Vencidos', '${stats['vencidos'] ?? 0}'],
              ['Suspendidos', '${stats['suspendidos'] ?? 0}'],
            ],
          ),
          pw.SizedBox(height: 16),
          pw.Text('Listado de clientes', style: pw.TextStyle(fontSize: 14, fontWeight: pw.FontWeight.bold)),
          pw.SizedBox(height: 8),
          pw.Table.fromTextArray(
            headers: ['Empresa', 'RNC', 'Estado', 'Vencimiento'],
            data: clientes.map((c) => [
              c.businessName,
              Formatters.rnc(c.rnc),
              Formatters.estadoLabel(c.status),
              c.vencimiento != null ? AppDateUtils.formatFecha(c.vencimiento) : '—',
            ]).toList(),
            headerStyle: pw.TextStyle(fontWeight: pw.FontWeight.bold),
            cellAlignments: {0: pw.Alignment.centerLeft},
          ),
        ],
      ),
    );

    if (context.mounted) Navigator.of(context).pop();
    await Printing.layoutPdf(onLayout: (_) => pdf.save(), name: 'clientes_${DateTime.now().millisecondsSinceEpoch}.pdf');
  }

  Future<void> _generarReporteDeclaraciones(BuildContext context, WidgetRef ref) async {
    final profile = ref.read(userProfileProvider).valueOrNull;
    if (profile == null) return;

    _showGenerando(context);

    final declaraciones = await ref.read(declaracionServiceProvider).getDeclaraciones(profile.contadorDocId).catchError((_) => <DeclaracionModel>[]);

    final pdf = pw.Document();
    pdf.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.letter,
        build: (ctx) => [
          pw.Header(level: 0, child: pw.Text('Reporte de Declaraciones — ${profile.nombreFirma}', style: pw.TextStyle(fontSize: 16, fontWeight: pw.FontWeight.bold))),
          pw.Text('Generado: ${AppDateUtils.formatFechaHora(DateTime.now())}', style: const pw.TextStyle(fontSize: 10)),
          pw.SizedBox(height: 16),
          pw.Table.fromTextArray(
            headers: ['Tipo', 'Cliente', 'Período', 'Estado', 'Fecha límite'],
            data: declaraciones.map((d) => [
              d.tipo,
              d.clienteNombre ?? '—',
              d.periodo,
              Formatters.estadoLabel(d.estado),
              d.fechaLimite != null ? AppDateUtils.formatFecha(d.fechaLimite) : '—',
            ]).toList(),
            headerStyle: pw.TextStyle(fontWeight: pw.FontWeight.bold),
          ),
        ],
      ),
    );

    if (context.mounted) Navigator.of(context).pop();
    await Printing.layoutPdf(onLayout: (_) => pdf.save(), name: 'declaraciones_${DateTime.now().millisecondsSinceEpoch}.pdf');
  }

  Future<void> _generarReporteVencimientos(BuildContext context, WidgetRef ref) async {
    final profile = ref.read(userProfileProvider).valueOrNull;
    if (profile == null) return;

    _showGenerando(context);

    final prox = await ref.read(declaracionServiceProvider).getProximosVencimientos(profile.contadorDocId).catchError((_) => <DeclaracionModel>[]);

    final pdf = pw.Document();
    pdf.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.letter,
        build: (ctx) => [
          pw.Header(level: 0, child: pw.Text('Próximos Vencimientos — ${profile.nombreFirma}', style: pw.TextStyle(fontSize: 16, fontWeight: pw.FontWeight.bold))),
          pw.Text('Próximos 30 días · Generado: ${AppDateUtils.formatFechaHora(DateTime.now())}', style: const pw.TextStyle(fontSize: 10)),
          pw.SizedBox(height: 16),
          if (prox.isEmpty)
            pw.Text('No hay declaraciones pendientes en los próximos 30 días.')
          else
            pw.Table.fromTextArray(
              headers: ['Tipo', 'Cliente', 'Período', 'Fecha límite', 'Días restantes'],
              data: prox.map((d) => [
                d.tipo,
                d.clienteNombre ?? '—',
                d.periodo,
                d.fechaLimite != null ? AppDateUtils.formatFecha(d.fechaLimite) : '—',
                '${d.diasRestantes} días',
              ]).toList(),
              headerStyle: pw.TextStyle(fontWeight: pw.FontWeight.bold),
            ),
        ],
      ),
    );

    if (context.mounted) Navigator.of(context).pop();
    await Printing.layoutPdf(onLayout: (_) => pdf.save(), name: 'vencimientos_${DateTime.now().millisecondsSinceEpoch}.pdf');
  }

  Future<void> _generarReporteMes(BuildContext context, WidgetRef ref) async {
    final profile = ref.read(userProfileProvider).valueOrNull;
    if (profile == null) return;
    _showGenerando(context);

    final now = DateTime.now();
    final periodo = '${now.year}-${now.month.toString().padLeft(2, '0')}';
    final declaraciones = await ref.read(declaracionServiceProvider)
        .getDeclaraciones(profile.contadorDocId)
        .catchError((_) => <DeclaracionModel>[]);
    final delMes = declaraciones.where((d) => d.periodo == periodo).toList();

    final pdf = pw.Document();
    pdf.addPage(
      pw.Page(
        pageFormat: PdfPageFormat.letter,
        build: (ctx) => pw.Column(
          crossAxisAlignment: pw.CrossAxisAlignment.start,
          children: [
            pw.Text('Declaraciones del mes — ${DateFormat('MMMM yyyy', 'es_DO').format(now)}', style: pw.TextStyle(fontSize: 16, fontWeight: pw.FontWeight.bold)),
            pw.Text(profile.nombreFirma, style: const pw.TextStyle(fontSize: 12)),
            pw.SizedBox(height: 16),
            if (delMes.isEmpty)
              pw.Text('Sin declaraciones este mes.')
            else
              pw.Table.fromTextArray(
                headers: ['Tipo', 'Cliente', 'Estado'],
                data: delMes.map((d) => [d.tipo, d.clienteNombre ?? '—', Formatters.estadoLabel(d.estado)]).toList(),
                headerStyle: pw.TextStyle(fontWeight: pw.FontWeight.bold),
              ),
          ],
        ),
      ),
    );

    if (context.mounted) Navigator.of(context).pop();
    await Printing.layoutPdf(onLayout: (_) => pdf.save(), name: 'mes_${periodo}.pdf');
  }

  Future<void> _generarReporteAnual(BuildContext context, WidgetRef ref) async {
    final profile = ref.read(userProfileProvider).valueOrNull;
    if (profile == null) return;
    _showGenerando(context);

    final stats = await ref.read(dashboardStatsProvider.future).catchError((_) => <String, dynamic>{});
    final decStats = stats['declaraciones'] as Map<String, int>? ?? {};

    final pdf = pw.Document();
    pdf.addPage(
      pw.Page(
        pageFormat: PdfPageFormat.letter,
        build: (ctx) => pw.Column(
          crossAxisAlignment: pw.CrossAxisAlignment.start,
          children: [
            pw.Text('Actividad Anual ${DateTime.now().year}', style: pw.TextStyle(fontSize: 18, fontWeight: pw.FontWeight.bold)),
            pw.Text(profile.nombreFirma, style: const pw.TextStyle(fontSize: 12)),
            pw.SizedBox(height: 20),
            pw.Text('Clientes', style: pw.TextStyle(fontSize: 14, fontWeight: pw.FontWeight.bold)),
            pw.Table.fromTextArray(
              headers: ['Categoría', 'Total'],
              data: [
                ['Total', '${stats['total'] ?? 0}'],
                ['Activos', '${stats['activos'] ?? 0}'],
                ['En prueba', '${stats['prueba'] ?? 0}'],
                ['Vencidos', '${stats['vencidos'] ?? 0}'],
              ],
            ),
            pw.SizedBox(height: 16),
            pw.Text('Declaraciones', style: pw.TextStyle(fontSize: 14, fontWeight: pw.FontWeight.bold)),
            pw.Table.fromTextArray(
              headers: ['Estado', 'Cantidad'],
              data: [
                ['Total', '${decStats['total'] ?? 0}'],
                ['Aprobadas', '${decStats['aprobadas'] ?? 0}'],
                ['Enviadas', '${decStats['enviadas'] ?? 0}'],
                ['Pendientes', '${decStats['pendientes'] ?? 0}'],
                ['Vencidas', '${decStats['vencidas'] ?? 0}'],
              ],
            ),
          ],
        ),
      ),
    );

    if (context.mounted) Navigator.of(context).pop();
    await Printing.layoutPdf(onLayout: (_) => pdf.save(), name: 'anual_${DateTime.now().year}.pdf');
  }

  void _showGenerando(BuildContext context) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => const AlertDialog(
        content: Row(
          children: [
            CircularProgressIndicator(),
            SizedBox(width: 16),
            Text('Generando reporte...'),
          ],
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final String title;
  const _SectionTitle({required this.title});

  @override
  Widget build(BuildContext context) => Text(title, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700));
}

class _ReporteCard extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  const _ReporteCard({required this.icon, required this.color, required this.title, required this.subtitle, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Container(
                width: 48, height: 48,
                decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(12)),
                child: Icon(icon, color: color, size: 24),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
                    const SizedBox(height: 2),
                    Text(subtitle, style: const TextStyle(color: AppColors.textSecondary, fontSize: 13)),
                  ],
                ),
              ),
              const Icon(Icons.picture_as_pdf_rounded, color: AppColors.error, size: 22),
            ],
          ),
        ),
      ),
    );
  }
}

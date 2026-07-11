import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/utils/app_date_utils.dart';
import '../../../core/utils/formatters.dart';
import '../../../data/models/declaracion_model.dart';
import '../providers/declaraciones_provider.dart';

class DeclaracionDetailScreen extends ConsumerWidget {
  final String id;
  final DeclaracionModel? declaracion;

  const DeclaracionDetailScreen({super.key, required this.id, this.declaracion});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final d = declaracion;
    if (d == null) {
      return Scaffold(appBar: AppBar(), body: const Center(child: Text('Declaración no encontrada')));
    }
    return _DetailView(declaracion: d);
  }
}

class _DetailView extends ConsumerWidget {
  final DeclaracionModel declaracion;
  const _DetailView({required this.declaracion});

  Color get _estadoColor {
    switch (declaracion.estado) {
      case 'aprobada': return AppColors.success;
      case 'enviada': return AppColors.info;
      case 'en_proceso': return AppColors.secondary;
      case 'rechazada':
      case 'vencida': return AppColors.error;
      default: return AppColors.warning;
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final formState = ref.watch(declaracionFormProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text(declaracion.tipo),
        actions: [
          IconButton(
            icon: const Icon(Icons.edit_outlined),
            onPressed: () => context.push('/declaraciones/new', extra: {'declaracion': declaracion}),
          ),
          PopupMenuButton(
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'delete', child: Row(children: [Icon(Icons.delete_outline, color: AppColors.error), SizedBox(width: 8), Text('Eliminar', style: TextStyle(color: AppColors.error))])),
            ],
            onSelected: (v) async {
              if (v == 'delete') {
                final confirm = await showDialog<bool>(
                  context: context,
                  builder: (_) => AlertDialog(
                    title: const Text('Eliminar declaración'),
                    content: const Text('¿Esta acción no se puede deshacer. ¿Continuar?'),
                    actions: [
                      TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
                      FilledButton(style: FilledButton.styleFrom(backgroundColor: AppColors.error), onPressed: () => Navigator.pop(context, true), child: const Text('Eliminar')),
                    ],
                  ),
                );
                if (confirm == true && context.mounted) {
                  final ok = await ref.read(declaracionFormProvider.notifier).delete(declaracion.id);
                  if (ok && context.mounted) context.pop();
                }
              }
            },
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Header
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  Row(
                    children: [
                      Container(
                        width: 56, height: 56,
                        decoration: BoxDecoration(color: _estadoColor.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(14)),
                        alignment: Alignment.center,
                        child: Text(declaracion.tipo, style: TextStyle(color: _estadoColor, fontWeight: FontWeight.w800, fontSize: 12), textAlign: TextAlign.center),
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(declaracion.clienteNombre ?? 'Sin cliente', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                            Text(declaracion.periodo, style: const TextStyle(color: AppColors.textSecondary, fontSize: 14)),
                          ],
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                        decoration: BoxDecoration(color: _estadoColor.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
                        child: Text(Formatters.estadoLabel(declaracion.estado), style: TextStyle(color: _estadoColor, fontWeight: FontWeight.w600, fontSize: 13)),
                      ),
                    ],
                  ),
                  if (declaracion.fechaLimite != null) ...[
                    const Divider(height: 24),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceAround,
                      children: [
                        _MiniStat(label: 'Fecha límite', value: AppDateUtils.formatFecha(declaracion.fechaLimite)),
                        if (declaracion.fechaEnvio != null)
                          _MiniStat(label: 'Enviada el', value: AppDateUtils.formatFecha(declaracion.fechaEnvio)),
                        _MiniStat(
                          label: declaracion.isEnviada || declaracion.isAprobada ? 'Estado' : 'Días restantes',
                          value: declaracion.isEnviada || declaracion.isAprobada
                              ? Formatters.estadoLabel(declaracion.estado)
                              : '${declaracion.diasRestantes}',
                          valueColor: declaracion.diasRestantes < 0 ? AppColors.error : declaracion.diasRestantes <= 7 ? AppColors.warning : null,
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),

          // Detalles
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Información', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                  const SizedBox(height: 12),
                  if (declaracion.numeroConfirmacion != null)
                    _InfoRow(icon: Icons.confirmation_number_outlined, label: 'Confirmación', value: declaracion.numeroConfirmacion!),
                  if (declaracion.montoDeclarado != null)
                    _InfoRow(icon: Icons.attach_money_rounded, label: 'Monto declarado', value: Formatters.moneda(declaracion.montoDeclarado)),
                  if (declaracion.montoPagado != null)
                    _InfoRow(icon: Icons.payment_rounded, label: 'Monto pagado', value: Formatters.moneda(declaracion.montoPagado)),
                  if (declaracion.observaciones != null)
                    _InfoRow(icon: Icons.notes_rounded, label: 'Observaciones', value: declaracion.observaciones!),
                  if (declaracion.createdAt != null)
                    _InfoRow(icon: Icons.calendar_today_outlined, label: 'Creado', value: AppDateUtils.formatFechaHora(declaracion.createdAt)),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),

          // Acciones
          if (!declaracion.isEnviada && !declaracion.isAprobada)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text('Acciones', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                    const SizedBox(height: 12),
                    ElevatedButton.icon(
                      icon: const Icon(Icons.send_rounded),
                      label: formState.isLoading ? const Text('Marcando...') : const Text('Marcar como enviada'),
                      onPressed: formState.isLoading ? null : () => _marcarEnviada(context, ref),
                    ),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 40),
        ],
      ),
    );
  }

  Future<void> _marcarEnviada(BuildContext context, WidgetRef ref) async {
    final numCtrl = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Marcar como enviada'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Ingresa el número de confirmación (opcional):'),
            const SizedBox(height: 12),
            TextField(controller: numCtrl, decoration: const InputDecoration(hintText: 'N° de confirmación', prefixIcon: Icon(Icons.confirmation_number_outlined))),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Confirmar')),
        ],
      ),
    );
    if (confirmed == true && context.mounted) {
      await ref.read(declaracionFormProvider.notifier).marcarEnviada(
        declaracion.id,
        numeroConfirmacion: numCtrl.text.trim().isEmpty ? null : numCtrl.text.trim(),
      );
    }
  }
}

class _MiniStat extends StatelessWidget {
  final String label;
  final String value;
  final Color? valueColor;
  const _MiniStat({required this.label, required this.value, this.valueColor});

  @override
  Widget build(BuildContext context) => Column(
        children: [
          Text(value, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15, color: valueColor)),
          const SizedBox(height: 2),
          Text(label, style: const TextStyle(fontSize: 11, color: AppColors.textSecondary)),
        ],
      );
}

class _InfoRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  const _InfoRow({required this.icon, required this.label, required this.value});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 18, color: AppColors.textSecondary),
            const SizedBox(width: 12),
            SizedBox(width: 110, child: Text(label, style: const TextStyle(color: AppColors.textSecondary, fontSize: 13))),
            Expanded(child: Text(value, style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 14))),
          ],
        ),
      );
}

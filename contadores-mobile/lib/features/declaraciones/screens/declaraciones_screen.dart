import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/fiscal_calendar.dart';
import '../../../core/utils/app_date_utils.dart';
import '../../../core/utils/formatters.dart';
import '../../../data/models/declaracion_model.dart';
import '../providers/declaraciones_provider.dart';

class DeclaracionesScreen extends ConsumerWidget {
  const DeclaracionesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(declaracionesFiltradas);
    final filtroEstado = ref.watch(declaracionFiltroEstadoProvider);
    final filtroTipo = ref.watch(declaracionFiltroTipoProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Declaraciones'),
        actions: [
          IconButton(
            icon: Badge(
              isLabelVisible: filtroEstado != null || filtroTipo != null,
              child: const Icon(Icons.filter_list_rounded),
            ),
            onPressed: () => _showFilter(context, ref, filtroEstado, filtroTipo),
          ),
        ],
      ),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(e.toString(), style: const TextStyle(color: AppColors.error))),
        data: (lista) {
          if (lista.isEmpty) {
            return _EmptyView(
              hasFilter: filtroEstado != null || filtroTipo != null,
              onClearFilter: () {
                ref.read(declaracionFiltroEstadoProvider.notifier).state = null;
                ref.read(declaracionFiltroTipoProvider.notifier).state = null;
              },
            );
          }
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(declaracionesProvider),
            child: ListView.builder(
              padding: const EdgeInsets.all(16),
              itemCount: lista.length,
              itemBuilder: (_, i) => _DeclaracionTile(declaracion: lista[i]),
            ),
          );
        },
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => context.push('/declaraciones/new'),
        child: const Icon(Icons.add_rounded),
      ),
    );
  }

  void _showFilter(BuildContext context, WidgetRef ref, String? estado, String? tipo) {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => StatefulBuilder(
        builder: (ctx, setState) => Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Filtros', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
              const SizedBox(height: 16),
              const Text('Estado', style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
              const SizedBox(height: 8),
              Wrap(spacing: 8, children: FiscalCalendar.estadosDeclaracion.map((s) => FilterChip(
                label: Text(Formatters.estadoLabel(s)),
                selected: estado == s,
                onSelected: (_) {
                  ref.read(declaracionFiltroEstadoProvider.notifier).state = estado == s ? null : s;
                  Navigator.pop(context);
                },
              )).toList()),
              const SizedBox(height: 16),
              const Text('Tipo', style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
              const SizedBox(height: 8),
              Wrap(spacing: 8, children: FiscalCalendar.tiposDeclaracion.map((t) => FilterChip(
                label: Text(t),
                selected: tipo == t,
                onSelected: (_) {
                  ref.read(declaracionFiltroTipoProvider.notifier).state = tipo == t ? null : t;
                  Navigator.pop(context);
                },
              )).toList()),
              const SizedBox(height: 16),
              if (estado != null || tipo != null)
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton(
                    onPressed: () {
                      ref.read(declaracionFiltroEstadoProvider.notifier).state = null;
                      ref.read(declaracionFiltroTipoProvider.notifier).state = null;
                      Navigator.pop(context);
                    },
                    child: const Text('Limpiar filtros'),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DeclaracionTile extends StatelessWidget {
  final DeclaracionModel declaracion;
  const _DeclaracionTile({required this.declaracion});

  @override
  Widget build(BuildContext context) {
    final color = _estadoColor(declaracion.estado);
    final dias = declaracion.diasRestantes;

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () => context.push('/declaraciones/${declaracion.id}', extra: declaracion),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: _tipoColor(declaracion.tipo).withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                ),
                alignment: Alignment.center,
                child: Text(
                  declaracion.tipo.replaceAll('-', '\n'),
                  style: TextStyle(color: _tipoColor(declaracion.tipo), fontWeight: FontWeight.w800, fontSize: 11),
                  textAlign: TextAlign.center,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(declaracion.clienteNombre ?? 'Sin cliente', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14), maxLines: 1, overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 2),
                    Text(declaracion.periodo, style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                    if (declaracion.fechaLimite != null)
                      Text(
                        'Límite: ${AppDateUtils.formatFecha(declaracion.fechaLimite)}',
                        style: TextStyle(fontSize: 11, color: dias < 0 ? AppColors.error : dias <= 7 ? AppColors.warning : AppColors.textTertiary),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
                child: Text(Formatters.estadoLabel(declaracion.estado), style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Color _estadoColor(String estado) {
    switch (estado) {
      case 'aprobada': return AppColors.success;
      case 'enviada': return AppColors.info;
      case 'en_proceso': return AppColors.secondary;
      case 'rechazada':
      case 'vencida': return AppColors.error;
      default: return AppColors.warning;
    }
  }

  Color _tipoColor(String tipo) {
    switch (tipo) {
      case 'ITBIS': return AppColors.primary;
      case 'IR-17': return AppColors.secondary;
      case 'IR-3': return AppColors.info;
      case 'ISR': return AppColors.success;
      case 'Anticipos': return AppColors.warning;
      case 'Retenciones': return AppColors.error;
      default: return AppColors.textSecondary;
    }
  }
}

class _EmptyView extends StatelessWidget {
  final bool hasFilter;
  final VoidCallback onClearFilter;
  const _EmptyView({required this.hasFilter, required this.onClearFilter});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.receipt_long_outlined, size: 64, color: AppColors.textTertiary),
          const SizedBox(height: 16),
          Text(
            hasFilter ? 'Sin declaraciones con esos filtros' : 'No hay declaraciones registradas',
            style: const TextStyle(color: AppColors.textSecondary, fontSize: 15),
          ),
          const SizedBox(height: 16),
          if (hasFilter)
            OutlinedButton(onPressed: onClearFilter, child: const Text('Limpiar filtros'))
          else
            FilledButton.icon(
              onPressed: () => context.push('/declaraciones/new'),
              icon: const Icon(Icons.add_rounded),
              label: const Text('Nueva declaración'),
            ),
        ],
      ),
    );
  }
}

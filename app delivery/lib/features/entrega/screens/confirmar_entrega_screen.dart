import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/app_colors.dart';
import '../../../core/config/routes.dart';
import '../../pedidos/providers/pedidos_provider.dart';

const _tiposIncidencia = [
  'Cliente no estaba',
  'Faltó dinero',
  'Pedido rechazado',
  'Dirección incorrecta',
  'Cliente no respondió',
  'Producto dañado',
  'Otro',
];

class ConfirmarEntregaScreen extends ConsumerStatefulWidget {
  final String pedidoId;
  const ConfirmarEntregaScreen({super.key, required this.pedidoId});

  @override
  ConsumerState<ConfirmarEntregaScreen> createState() =>
      _ConfirmarEntregaScreenState();
}

class _ConfirmarEntregaScreenState
    extends ConsumerState<ConfirmarEntregaScreen> {
  final _notasCtrl = TextEditingController();
  bool _esIncidencia = false;
  String? _tipoIncidencia;
  bool _loading = false;

  @override
  void dispose() {
    _notasCtrl.dispose();
    super.dispose();
  }

  Future<void> _confirmar() async {
    if (_esIncidencia && _tipoIncidencia == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Selecciona el tipo de incidencia'),
          backgroundColor: AppColors.warning,
        ),
      );
      return;
    }
    setState(() => _loading = true);
    try {
      final repo = ref.read(pedidosRepositoryProvider);
      if (_esIncidencia) {
        await repo.reportarIncidencia(
          pedidoId: widget.pedidoId,
          tipo: _tipoIncidencia!,
          descripcion: _notasCtrl.text.trim(),
        );
      } else {
        await repo.confirmarEntrega(
          pedidoId: widget.pedidoId,
          notas: _notasCtrl.text.trim().isEmpty
              ? null
              : _notasCtrl.text.trim(),
        );
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            _esIncidencia
                ? 'Incidencia reportada'
                : '¡Entrega confirmada!',
          ),
          backgroundColor:
              _esIncidencia ? AppColors.warning : AppColors.success,
        ),
      );
      context.go(AppRoutes.pedidos);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Error: $e'),
          backgroundColor: AppColors.error,
        ),
      );
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final pedidoAsync = ref.watch(pedidoStreamProvider(widget.pedidoId));
    final factura = pedidoAsync.valueOrNull?.numeroFactura ?? '';
    final cliente = pedidoAsync.valueOrNull?.clienteNombre ?? '';

    return Scaffold(
      appBar: AppBar(
        title: const Text('Confirmar Entrega'),
        leading: BackButton(onPressed: () => context.pop()),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Resumen del pedido
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: AppColors.primary.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                    color: AppColors.primary.withValues(alpha: 0.2)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.receipt_long_rounded,
                      color: AppColors.primary),
                  const SizedBox(width: 12),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Factura #$factura',
                        style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 15,
                        ),
                      ),
                      Text(
                        cliente,
                        style: const TextStyle(
                          color: AppColors.textSecondary,
                          fontSize: 13,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            // Toggle: entrega exitosa vs incidencia
            const Text(
              '¿Cómo resultó la entrega?',
              style: TextStyle(
                fontWeight: FontWeight.w700,
                fontSize: 16,
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _OpcionCard(
                    icon: Icons.check_circle_outline_rounded,
                    label: 'Entregado',
                    selected: !_esIncidencia,
                    color: AppColors.entregado,
                    onTap: () => setState(() {
                      _esIncidencia = false;
                      _tipoIncidencia = null;
                    }),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _OpcionCard(
                    icon: Icons.warning_amber_rounded,
                    label: 'Incidencia',
                    selected: _esIncidencia,
                    color: AppColors.incidencia,
                    onTap: () =>
                        setState(() => _esIncidencia = true),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),

            // Tipos de incidencia
            if (_esIncidencia) ...[
              const Text(
                'Tipo de incidencia',
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  fontSize: 14,
                ),
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: _tiposIncidencia.map((tipo) {
                  final selected = _tipoIncidencia == tipo;
                  return FilterChip(
                    label: Text(tipo),
                    selected: selected,
                    onSelected: (_) =>
                        setState(() => _tipoIncidencia = tipo),
                    selectedColor:
                        AppColors.incidencia.withValues(alpha: 0.15),
                    checkmarkColor: AppColors.incidencia,
                    labelStyle: TextStyle(
                      color: selected
                          ? AppColors.incidencia
                          : AppColors.textPrimary,
                      fontWeight: selected
                          ? FontWeight.w600
                          : FontWeight.normal,
                    ),
                    side: BorderSide(
                      color: selected
                          ? AppColors.incidencia
                          : AppColors.divider,
                    ),
                  );
                }).toList(),
              ),
              const SizedBox(height: 20),
            ],

            // Notas
            Text(
              _esIncidencia ? 'Descripción (opcional)' : 'Notas (opcional)',
              style: const TextStyle(
                fontWeight: FontWeight.w700,
                fontSize: 14,
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _notasCtrl,
              maxLines: 4,
              textCapitalization: TextCapitalization.sentences,
              decoration: InputDecoration(
                hintText: _esIncidencia
                    ? 'Describe lo que ocurrió...'
                    : 'Ej. El cliente recibió personalmente',
              ),
            ),
            const SizedBox(height: 32),

            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                icon: _loading
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : Icon(
                        _esIncidencia
                            ? Icons.warning_amber_rounded
                            : Icons.check_circle_outline_rounded,
                      ),
                label: Text(
                  _esIncidencia ? 'Reportar Incidencia' : 'Confirmar Entrega',
                ),
                style: ElevatedButton.styleFrom(
                  backgroundColor: _esIncidencia
                      ? AppColors.incidencia
                      : AppColors.entregado,
                ),
                onPressed: _loading ? null : _confirmar,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _OpcionCard extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool selected;
  final Color color;
  final VoidCallback onTap;

  const _OpcionCard({
    required this.icon,
    required this.label,
    required this.selected,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(vertical: 16),
        decoration: BoxDecoration(
          color: selected ? color.withValues(alpha: 0.12) : Colors.transparent,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: selected ? color : AppColors.divider,
            width: selected ? 2 : 1,
          ),
        ),
        child: Column(
          children: [
            Icon(icon, color: selected ? color : AppColors.textSecondary,
                size: 28),
            const SizedBox(height: 6),
            Text(
              label,
              style: TextStyle(
                color: selected ? color : AppColors.textSecondary,
                fontWeight:
                    selected ? FontWeight.w700 : FontWeight.normal,
                fontSize: 13,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/config/app_colors.dart';
import '../../../core/config/routes.dart';
import '../../../data/models/pedido_delivery_model.dart';
import '../../../shared/widgets/estado_badge.dart';
import '../providers/pedidos_provider.dart';

class DetallePedidoScreen extends ConsumerWidget {
  final String pedidoId;
  const DetallePedidoScreen({super.key, required this.pedidoId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pedidoAsync = ref.watch(pedidoStreamProvider(pedidoId));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Detalle del Pedido'),
        leading: BackButton(onPressed: () => context.pop()),
      ),
      body: pedidoAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Error: $e')),
        data: (pedido) {
          if (pedido == null) {
            return const Center(child: Text('Pedido no encontrado'));
          }
          return _DetallePedidoBody(pedido: pedido, pedidoId: pedidoId);
        },
      ),
    );
  }
}

class _DetallePedidoBody extends ConsumerWidget {
  final PedidoDelivery pedido;
  final String pedidoId;

  const _DetallePedidoBody({required this.pedido, required this.pedidoId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canStart = pedido.estado == 'asignado';
    final canConfirm = pedido.estado == 'en_camino';
    final isFinished =
        pedido.estado == 'entregado' || pedido.estado == 'incidencia';

    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 32),
      children: [
        // ── Header compacto ───────────────────────────────────────────
        _seccion(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Factura #${pedido.numeroFactura}',
                      style: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      pedido.negocioNombre,
                      style: const TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      DateFormat('dd/MM/yyyy hh:mm a').format(pedido.creadoEn),
                      style: const TextStyle(
                        color: AppColors.textHint,
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
              ),
              EstadoBadge(estado: pedido.estado, large: true),
            ],
          ),
        ),
        const SizedBox(height: 10),

        // ── Cliente ───────────────────────────────────────────────────
        _seccion(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _label('CLIENTE'),
              const SizedBox(height: 8),
              _infoFila(Icons.person_rounded, pedido.clienteNombre),
              if (pedido.clienteDireccion.isNotEmpty) ...[
                const SizedBox(height: 6),
                _infoFila(Icons.location_on_rounded, pedido.clienteDireccion),
              ],
              if (pedido.clienteReferencia.isNotEmpty) ...[
                const SizedBox(height: 6),
                _infoFila(Icons.storefront_rounded, pedido.clienteReferencia),
              ],
              if (pedido.clienteLocationLink != null) ...[
                const SizedBox(height: 6),
                _infoFila(
                  Icons.link_rounded,
                  pedido.clienteLocationLink!,
                  onTap: () => _launch(pedido.clienteLocationLink!),
                ),
              ],
              if (pedido.clienteTelefono.isNotEmpty) ...[
                const SizedBox(height: 6),
                _infoFila(
                  Icons.phone_rounded,
                  pedido.clienteTelefono,
                  onTap: () => _launch('tel:${pedido.clienteTelefono}'),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 10),

        // ── Botones de contacto ───────────────────────────────────────
        Row(
          children: [
            if (pedido.clienteTelefono.isNotEmpty) ...[
              Expanded(
                child: _BotonAccion(
                  icon: Icons.chat_rounded,
                  label: 'WhatsApp',
                  color: const Color(0xFF25D366),
                  onTap: () => _launch(pedido.whatsappUrl),
                ),
              ),
              const SizedBox(width: 8),
            ],
            Expanded(
              child: _BotonAccion(
                icon: Icons.map_rounded,
                label: pedido.tieneLocationLink
                    ? 'Abrir Ubicación'
                    : 'Ver en Mapa',
                color: AppColors.primary,
                onTap: pedido.googleMapsUrl == null
                    ? null
                    : () => _launch(pedido.googleMapsUrl!),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),

        // ── Productos — verificación ───────────────────────────────────
        _seccion(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(
                    Icons.fact_check_rounded,
                    size: 16,
                    color: AppColors.primary,
                  ),
                  const SizedBox(width: 6),
                  _label('VERIFICA TU PEDIDO'),
                ],
              ),
              const SizedBox(height: 4),
              const Text(
                'Confirma que tienes todos los productos antes de salir.',
                style: TextStyle(color: AppColors.textHint, fontSize: 11),
              ),
              const SizedBox(height: 12),
              ...pedido.productos.asMap().entries.map((entry) {
                final i = entry.key;
                final p = entry.value;
                final isLast = i == pedido.productos.length - 1;
                return Column(
                  children: [
                    _ProductoFila(producto: p),
                    if (!isLast) const Divider(height: 12, thickness: 0.5),
                  ],
                );
              }),
              const Divider(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text(
                    'TOTAL',
                    style: TextStyle(
                      fontWeight: FontWeight.w800,
                      fontSize: 13,
                      letterSpacing: 0.5,
                      color: AppColors.textSecondary,
                    ),
                  ),
                  Text(
                    'RD\$ ${pedido.total.toStringAsFixed(2)}',
                    style: const TextStyle(
                      fontWeight: FontWeight.w800,
                      fontSize: 20,
                      color: AppColors.primary,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),

        // ── Notas del cajero ──────────────────────────────────────────
        if (pedido.notasInternas != null &&
            pedido.notasInternas!.isNotEmpty) ...[
          const SizedBox(height: 10),
          _seccion(
            color: AppColors.warning.withValues(alpha: 0.06),
            border: AppColors.warning.withValues(alpha: 0.3),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(
                  Icons.sticky_note_2_outlined,
                  size: 16,
                  color: AppColors.warning,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Nota del cajero',
                        style: TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 12,
                          color: AppColors.warning,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        pedido.notasInternas!,
                        style: const TextStyle(fontSize: 13),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],

        // ── Incidencias ───────────────────────────────────────────────
        if (pedido.incidencias.isNotEmpty) ...[
          const SizedBox(height: 10),
          _seccion(
            color: AppColors.incidencia.withValues(alpha: 0.06),
            border: AppColors.incidencia.withValues(alpha: 0.3),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Row(
                  children: [
                    Icon(
                      Icons.warning_amber_rounded,
                      size: 16,
                      color: AppColors.incidencia,
                    ),
                    SizedBox(width: 6),
                    Text(
                      'Incidencias',
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 12,
                        color: AppColors.incidencia,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                ...pedido.incidencias.map(
                  (inc) => Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          inc.tipo,
                          style: const TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 13,
                          ),
                        ),
                        if (inc.descripcion.isNotEmpty)
                          Text(
                            inc.descripcion,
                            style: const TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 12,
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],

        const SizedBox(height: 20),

        // ── Botones de acción principal ───────────────────────────────
        if (!isFinished) ...[
          if (canStart)
            ElevatedButton.icon(
              icon: const Icon(Icons.delivery_dining_rounded),
              label: const Text('Iniciar Entrega'),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.enCamino,
                minimumSize: const Size.fromHeight(52),
              ),
              onPressed: () async {
                await ref
                    .read(pedidosRepositoryProvider)
                    .iniciarEntrega(pedidoId);
              },
            ),
          if (canConfirm) ...[
            ElevatedButton.icon(
              icon: const Icon(Icons.check_circle_outline_rounded),
              label: const Text('Confirmar Entrega'),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.entregado,
                minimumSize: const Size.fromHeight(52),
              ),
              onPressed: () => context.push(AppRoutes.confirmar(pedidoId)),
            ),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              icon: const Icon(
                Icons.warning_amber_rounded,
                color: AppColors.incidencia,
              ),
              label: const Text(
                'Reportar Incidencia',
                style: TextStyle(color: AppColors.incidencia),
              ),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size.fromHeight(52),
                side: const BorderSide(color: AppColors.incidencia),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                ),
              ),
              onPressed: () => context.push(AppRoutes.confirmar(pedidoId)),
            ),
          ],
        ],

        if (isFinished && pedido.estado == 'entregado')
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.entregado.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                color: AppColors.entregado.withValues(alpha: 0.3),
              ),
            ),
            child: const Row(
              children: [
                Icon(Icons.check_circle_rounded, color: AppColors.entregado),
                SizedBox(width: 10),
                Text(
                  'Pedido entregado exitosamente',
                  style: TextStyle(
                    color: AppColors.entregado,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _seccion({required Widget child, Color? color, Color? border}) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: color ?? Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: border ?? Colors.black.withValues(alpha: 0.07),
        ),
        boxShadow: color == null
            ? [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.04),
                  blurRadius: 8,
                  offset: const Offset(0, 2),
                ),
              ]
            : null,
      ),
      child: child,
    );
  }

  Widget _label(String text) => Text(
    text,
    style: const TextStyle(
      fontSize: 11,
      fontWeight: FontWeight.w700,
      color: AppColors.textSecondary,
      letterSpacing: 0.8,
    ),
  );

  Widget _infoFila(IconData icon, String text, {VoidCallback? onTap}) {
    final row = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 16, color: AppColors.primary),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: onTap != null ? AppColors.primary : null,
              decoration: onTap != null ? TextDecoration.underline : null,
            ),
          ),
        ),
      ],
    );
    if (onTap == null) return row;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: row,
    );
  }

  Future<void> _launch(String url) async {
    final uri = Uri.parse(url);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }
}

// ── Fila de producto con cantidad destacada ───────────────────────────────────
class _ProductoFila extends StatelessWidget {
  final ProductoPedido producto;

  const _ProductoFila({required this.producto});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            color: AppColors.primary.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Center(
            child: Text(
              '${producto.cantidad}x',
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w800,
                color: AppColors.primary,
              ),
            ),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Text(
            producto.nombre,
            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
          ),
        ),
        Text(
          'RD\$ ${(producto.precio * producto.cantidad).toStringAsFixed(2)}',
          style: const TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w700,
            color: AppColors.textSecondary,
          ),
        ),
      ],
    );
  }
}

// ── Botón de acción (WhatsApp / Mapa) ────────────────────────────────────────
class _BotonAccion extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback? onTap;

  const _BotonAccion({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final isEnabled = onTap != null;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 11),
        decoration: BoxDecoration(
          color: color.withValues(alpha: isEnabled ? 0.1 : 0.05),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: color.withValues(alpha: isEnabled ? 0.3 : 0.15),
          ),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, color: isEnabled ? color : AppColors.textHint, size: 18),
            const SizedBox(width: 6),
            Text(
              label,
              style: TextStyle(
                color: isEnabled ? color : AppColors.textHint,
                fontWeight: FontWeight.w600,
                fontSize: 13,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

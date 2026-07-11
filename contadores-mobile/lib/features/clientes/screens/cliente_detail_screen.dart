import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/config/routes.dart';
import '../../../core/utils/formatters.dart';
import '../../../core/utils/app_date_utils.dart';
import '../../../data/models/user_model.dart';
import '../providers/clientes_provider.dart';

class ClienteDetailScreen extends ConsumerWidget {
  final String id;
  const ClienteDetailScreen({super.key, required this.id});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final clienteAsync = ref.watch(clienteDetailProvider(id));

    return clienteAsync.when(
      loading: () => const Scaffold(body: Center(child: CircularProgressIndicator())),
      error: (e, _) => Scaffold(appBar: AppBar(), body: Center(child: Text(e.toString()))),
      data: (cliente) {
        if (cliente == null) {
          return Scaffold(appBar: AppBar(), body: const Center(child: Text('Cliente no encontrado')));
        }
        return _ClienteDetailView(cliente: cliente);
      },
    );
  }
}

class _ClienteDetailView extends ConsumerWidget {
  final ClienteModel cliente;
  const _ClienteDetailView({required this.cliente});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final statusColor = cliente.isActivo
        ? AppColors.success
        : cliente.isTrial
            ? AppColors.warning
            : AppColors.error;

    return Scaffold(
      body: CustomScrollView(
        slivers: [
          SliverAppBar(
            expandedHeight: 180,
            pinned: true,
            actions: [
              IconButton(
                icon: const Icon(Icons.edit_outlined),
                onPressed: () => context.push('/clientes/${cliente.id}/edit', extra: cliente),
              ),
              PopupMenuButton(
                itemBuilder: (_) => [
                  const PopupMenuItem(value: 'delete', child: Row(children: [Icon(Icons.delete_outline, color: AppColors.error), SizedBox(width: 8), Text('Eliminar')])),
                ],
                onSelected: (v) async {
                  if (v == 'delete') {
                    final confirm = await showDialog<bool>(
                      context: context,
                      builder: (_) => AlertDialog(
                        title: const Text('Eliminar cliente'),
                        content: Text('¿Eliminar "${cliente.businessName}"? Esta acción no se puede deshacer.'),
                        actions: [
                          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
                          FilledButton(
                            style: FilledButton.styleFrom(backgroundColor: AppColors.error),
                            onPressed: () => Navigator.pop(context, true),
                            child: const Text('Eliminar'),
                          ),
                        ],
                      ),
                    );
                    if (confirm == true && context.mounted) {
                      final ok = await ref.read(clienteFormProvider.notifier).delete(cliente.id);
                      if (ok && context.mounted) context.pop();
                    }
                  }
                },
              ),
            ],
            flexibleSpace: FlexibleSpaceBar(
              background: Container(
                decoration: const BoxDecoration(gradient: AppColors.primaryGradient),
                padding: const EdgeInsets.fromLTRB(20, 80, 20, 20),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.end,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        CircleAvatar(
                          radius: 28,
                          backgroundColor: Colors.white.withValues(alpha: 0.2),
                          child: Text(
                            Formatters.iniciales(cliente.businessName),
                            style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w700),
                          ),
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(cliente.businessName, style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w700)),
                              if (cliente.rnc != null)
                                Text('RNC: ${Formatters.rnc(cliente.rnc)}', style: TextStyle(color: Colors.white.withValues(alpha: 0.8), fontSize: 13)),
                            ],
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                          decoration: BoxDecoration(
                            color: Colors.white.withValues(alpha: 0.2),
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Text(
                            Formatters.estadoLabel(cliente.status),
                            style: TextStyle(color: statusColor == AppColors.success ? Colors.greenAccent : Colors.white, fontSize: 12, fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
          SliverPadding(
            padding: const EdgeInsets.all(16),
            sliver: SliverList(
              delegate: SliverChildListDelegate([
                _InfoSection(cliente: cliente),
                const SizedBox(height: 16),
                _AccionesRapidas(cliente: cliente),
                const SizedBox(height: 80),
              ]),
            ),
          ),
        ],
      ),
    );
  }
}

class _InfoSection extends StatelessWidget {
  final ClienteModel cliente;
  const _InfoSection({required this.cliente});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Información', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            const SizedBox(height: 12),
            _InfoRow(icon: Icons.person_outline, label: 'Propietario', value: cliente.propietario ?? '—'),
            _InfoRow(icon: Icons.email_outlined, label: 'Correo', value: cliente.correo ?? '—'),
            _InfoRow(icon: Icons.phone_outlined, label: 'Teléfono', value: Formatters.telefono(cliente.telefono)),
            _InfoRow(icon: Icons.location_on_outlined, label: 'Dirección', value: cliente.direccion ?? '—'),
            _InfoRow(icon: Icons.card_membership_outlined, label: 'Plan', value: Formatters.planLabel(cliente.planCode)),
            if (cliente.vencimiento != null)
              _InfoRow(
                icon: Icons.event_outlined,
                label: 'Vencimiento',
                value: AppDateUtils.formatFecha(cliente.vencimiento),
                valueColor: cliente.diasRestantes != null && (cliente.diasRestantes! < 0) ? AppColors.error : null,
              ),
            if (cliente.createdAt != null)
              _InfoRow(icon: Icons.calendar_today_outlined, label: 'Registrado', value: AppDateUtils.formatFecha(cliente.createdAt)),
          ],
        ),
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color? valueColor;

  const _InfoRow({required this.icon, required this.label, required this.value, this.valueColor});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: AppColors.textSecondary),
          const SizedBox(width: 12),
          SizedBox(width: 100, child: Text(label, style: const TextStyle(color: AppColors.textSecondary, fontSize: 13))),
          Expanded(child: Text(value, style: TextStyle(fontWeight: FontWeight.w500, fontSize: 14, color: valueColor))),
        ],
      ),
    );
  }
}

class _AccionesRapidas extends StatelessWidget {
  final ClienteModel cliente;
  const _AccionesRapidas({required this.cliente});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Acciones', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            const SizedBox(height: 8),
            ListTile(
              leading: const Icon(Icons.receipt_long_rounded, color: AppColors.primary),
              title: const Text('Ver declaraciones'),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => context.push(AppRoutes.declaraciones),
            ),
            ListTile(
              leading: const Icon(Icons.folder_open_rounded, color: AppColors.warning),
              title: const Text('Ver documentos'),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => context.push(AppRoutes.documentos),
            ),
            ListTile(
              leading: const Icon(Icons.chat_bubble_outline_rounded, color: AppColors.success),
              title: const Text('Abrir chat'),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => context.push(AppRoutes.chat),
            ),
            ListTile(
              leading: const Icon(Icons.note_add_rounded, color: AppColors.secondary),
              title: const Text('Nueva declaración'),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => context.push('/declaraciones/new', extra: {
                'clienteId': cliente.id,
                'clienteNombre': cliente.businessName,
              }),
            ),
          ],
        ),
      ),
    );
  }
}

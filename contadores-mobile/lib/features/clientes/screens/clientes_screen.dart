import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/utils/formatters.dart';
import '../../../data/models/user_model.dart';
import '../providers/clientes_provider.dart';

class ClientesScreen extends ConsumerWidget {
  const ClientesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final clientesAsync = ref.watch(clientesFiltradosProvider);
    final query = ref.watch(clienteSearchProvider);
    final filter = ref.watch(clienteFilterProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Clientes'),
        actions: [
          IconButton(
            icon: const Icon(Icons.filter_list_rounded),
            onPressed: () => _showFilter(context, ref, filter),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: TextField(
              decoration: const InputDecoration(
                hintText: 'Buscar por nombre, RNC, propietario...',
                prefixIcon: Icon(Icons.search_rounded),
                suffixIcon: null,
              ),
              onChanged: (v) => ref.read(clienteSearchProvider.notifier).state = v,
            ),
          ),
          if (filter != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: Row(
                children: [
                  Chip(
                    label: Text(Formatters.estadoLabel(filter)),
                    deleteIcon: const Icon(Icons.close, size: 16),
                    onDeleted: () => ref.read(clienteFilterProvider.notifier).state = null,
                  ),
                ],
              ),
            ),
          Expanded(
            child: clientesAsync.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => _ErrorView(message: e.toString()),
              data: (clientes) => clientes.isEmpty
                  ? _EmptyView(query: query)
                  : RefreshIndicator(
                      onRefresh: () async => ref.invalidate(clientesProvider),
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: clientes.length,
                        itemBuilder: (_, i) => _ClienteTile(cliente: clientes[i]),
                      ),
                    ),
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => context.push('/clientes/new'),
        child: const Icon(Icons.add_rounded),
      ),
    );
  }

  void _showFilter(BuildContext context, WidgetRef ref, String? current) {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Filtrar por estado', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            Wrap(
              spacing: 8,
              children: [
                for (final s in ['active', 'trial', 'expired', 'suspended'])
                  FilterChip(
                    label: Text(Formatters.estadoLabel(s)),
                    selected: current == s,
                    onSelected: (_) {
                      ref.read(clienteFilterProvider.notifier).state = current == s ? null : s;
                      Navigator.pop(context);
                    },
                  ),
              ],
            ),
            const SizedBox(height: 16),
            if (current != null)
              SizedBox(
                width: double.infinity,
                child: OutlinedButton(
                  onPressed: () {
                    ref.read(clienteFilterProvider.notifier).state = null;
                    Navigator.pop(context);
                  },
                  child: const Text('Limpiar filtro'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ClienteTile extends StatelessWidget {
  final ClienteModel cliente;
  const _ClienteTile({required this.cliente});

  @override
  Widget build(BuildContext context) {
    final statusColor = cliente.isActivo
        ? AppColors.success
        : cliente.isTrial
            ? AppColors.warning
            : AppColors.error;

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: AppColors.primary.withValues(alpha: 0.1),
          child: Text(
            Formatters.iniciales(cliente.businessName),
            style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w700),
          ),
        ),
        title: Text(cliente.businessName, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (cliente.rnc != null)
              Text(Formatters.rnc(cliente.rnc), style: const TextStyle(fontSize: 12)),
            if (cliente.propietario != null)
              Text(cliente.propietario!, style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
          ],
        ),
        isThreeLine: cliente.propietario != null,
        trailing: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: statusColor.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(20),
              ),
              child: Text(
                Formatters.estadoLabel(cliente.status),
                style: TextStyle(color: statusColor, fontSize: 11, fontWeight: FontWeight.w600),
              ),
            ),
            if (cliente.planCode != null) ...[
              const SizedBox(height: 4),
              Text(Formatters.planLabel(cliente.planCode), style: const TextStyle(fontSize: 11, color: AppColors.textSecondary)),
            ],
          ],
        ),
        onTap: () => context.push('/clientes/${cliente.id}', extra: cliente),
      ),
    );
  }
}

class _EmptyView extends StatelessWidget {
  final String query;
  const _EmptyView({required this.query});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.business_outlined, size: 64, color: AppColors.textTertiary),
          const SizedBox(height: 16),
          Text(
            query.isEmpty ? 'No hay clientes registrados' : 'Sin resultados para "$query"',
            style: const TextStyle(color: AppColors.textSecondary, fontSize: 15),
          ),
          if (query.isEmpty) ...[
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () => context.push('/clientes/new'),
              icon: const Icon(Icons.add_rounded),
              label: const Text('Agregar cliente'),
            ),
          ],
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  final String message;
  const _ErrorView({required this.message});

  @override
  Widget build(BuildContext context) => Center(
        child: Text(message, style: const TextStyle(color: AppColors.error)),
      );
}

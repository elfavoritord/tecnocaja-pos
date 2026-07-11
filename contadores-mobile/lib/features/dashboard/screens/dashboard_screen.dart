import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/config/routes.dart';
import '../../../core/utils/app_date_utils.dart';
import '../../../core/utils/formatters.dart';
import '../../../data/models/user_model.dart';
import '../../auth/providers/auth_provider.dart';
import '../providers/dashboard_provider.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(userProfileProvider).valueOrNull;
    final statsAsync = ref.watch(dashboardStatsProvider);

    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(dashboardStatsProvider.future),
        child: CustomScrollView(
          slivers: [
            _buildAppBar(context, ref, profile),
            SliverPadding(
              padding: const EdgeInsets.all(16),
              sliver: SliverList(
                delegate: SliverChildListDelegate([
                  statsAsync.when(
                    loading: () => const _StatsShimmer(),
                    error: (e, _) => _ErrorCard(message: e.toString()),
                    data: (stats) => _StatsSection(stats: stats),
                  ),
                  const SizedBox(height: 20),
                  statsAsync.when(
                    loading: () => const SizedBox.shrink(),
                    error: (_, __) => const SizedBox.shrink(),
                    data: (stats) => _ProximosVencimientos(stats: stats),
                  ),
                  const SizedBox(height: 20),
                  _AccesosRapidos(onNavigate: (route) => context.push(route)),
                  const SizedBox(height: 20),
                  statsAsync.when(
                    loading: () => const SizedBox.shrink(),
                    error: (_, __) => const SizedBox.shrink(),
                    data: (stats) => _ClientesRecientes(stats: stats),
                  ),
                  const SizedBox(height: 80),
                ]),
              ),
            ),
          ],
        ),
      ),
    );
  }

  SliverAppBar _buildAppBar(BuildContext context, WidgetRef ref, UserModel? profile) {
    final hora = DateTime.now().hour;
    final saludo = hora < 12 ? 'Buenos días' : hora < 18 ? 'Buenas tardes' : 'Buenas noches';
    final mes = DateFormat('MMMM yyyy', 'es_DO').format(DateTime.now());

    return SliverAppBar(
      expandedHeight: 150,
      floating: true,
      pinned: true,
      flexibleSpace: FlexibleSpaceBar(
        background: Container(
          decoration: const BoxDecoration(gradient: AppColors.primaryGradient),
          padding: const EdgeInsets.fromLTRB(20, 40, 20, 12),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.end,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '$saludo,',
                style: TextStyle(color: Colors.white.withValues(alpha: 0.8), fontSize: 14),
              ),
              Text(
                profile?.displayName ?? 'Contador',
                style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w700),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              Text(
                mes[0].toUpperCase() + mes.substring(1),
                style: TextStyle(color: Colors.white.withValues(alpha: 0.7), fontSize: 13),
              ),
            ],
          ),
        ),
      ),
      actions: [
        IconButton(
          icon: const Icon(Icons.calendar_month_outlined, color: Colors.white),
          tooltip: 'Calendario fiscal',
          onPressed: () => context.push(AppRoutes.calendario),
        ),
        IconButton(
          icon: const Icon(Icons.settings_outlined, color: Colors.white),
          tooltip: 'Configuración',
          onPressed: () => context.push(AppRoutes.configuracion),
        ),
      ],
    );
  }
}

// ── Tarjetas de estadísticas ───────────────────────────────────────────────
class _StatsSection extends StatelessWidget {
  final Map<String, dynamic> stats;
  const _StatsSection({required this.stats});

  @override
  Widget build(BuildContext context) {
    final decl = stats['declaraciones'] as Map<String, int>? ?? {};

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Resumen', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(child: _StatCard(label: 'Clientes', value: '${stats['total'] ?? 0}', icon: Icons.business_rounded, color: AppColors.primary, sub: '${stats['activos'] ?? 0} activos')),
            const SizedBox(width: 12),
            Expanded(child: _StatCard(label: 'Pendientes', value: '${decl['pendientes'] ?? 0}', icon: Icons.receipt_long_rounded, color: AppColors.warning, sub: 'Declaraciones')),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(child: _StatCard(label: 'Enviadas', value: '${decl['enviadas'] ?? 0}', icon: Icons.send_rounded, color: AppColors.success, sub: 'Este período')),
            const SizedBox(width: 12),
            Expanded(child: _StatCard(label: 'Vencidas', value: '${decl['vencidas'] ?? 0}', icon: Icons.warning_amber_rounded, color: AppColors.error, sub: 'Sin enviar')),
          ],
        ),
      ],
    );
  }
}

class _StatCard extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;
  final Color color;
  final String? sub;

  const _StatCard({required this.label, required this.value, required this.icon, required this.color, this.sub});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(10)),
                  child: Icon(icon, color: color, size: 20),
                ),
                const Spacer(),
              ],
            ),
            const SizedBox(height: 12),
            Text(value, style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800, color: color)),
            const SizedBox(height: 2),
            Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
            if (sub != null)
              Text(sub!, style: const TextStyle(fontSize: 11, color: AppColors.textSecondary)),
          ],
        ),
      ),
    );
  }
}

// ── Próximos vencimientos ─────────────────────────────────────────────────
class _ProximosVencimientos extends StatelessWidget {
  final Map<String, dynamic> stats;
  const _ProximosVencimientos({required this.stats});

  @override
  Widget build(BuildContext context) {
    final lista = stats['proximosVencer'] as List? ?? [];
    if (lista.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text('Próximos a vencer', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
            const Spacer(),
            TextButton(
              onPressed: () => context.push(AppRoutes.clientes),
              child: const Text('Ver todos'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        ...lista.take(3).map((c) {
          final cliente = c as ClienteModel;
          final dias = cliente.vencimiento != null
              ? cliente.vencimiento!.difference(DateTime.now()).inDays
              : null;
          final urgent = dias != null && dias <= 7;

          return Card(
            margin: const EdgeInsets.only(bottom: 8),
            child: ListTile(
              leading: CircleAvatar(
                backgroundColor: urgent ? AppColors.errorLight : AppColors.warningLight,
                child: Icon(
                  Icons.business_rounded,
                  color: urgent ? AppColors.error : AppColors.warning,
                  size: 20,
                ),
              ),
              title: Text(cliente.businessName, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
              subtitle: Text(
                dias != null ? AppDateUtils.diasRestantesLabel(cliente.vencimiento) : '—',
                style: TextStyle(color: urgent ? AppColors.error : AppColors.warning, fontSize: 12),
              ),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => context.push('/clientes/${cliente.id}'),
            ),
          );
        }),
      ],
    );
  }
}

// ── Accesos rápidos ────────────────────────────────────────────────────────
class _AccesosRapidos extends StatelessWidget {
  final void Function(String route) onNavigate;
  const _AccesosRapidos({required this.onNavigate});

  @override
  Widget build(BuildContext context) {
    final items = [
      (_AccesoItem(icon: Icons.add_business_rounded, label: 'Nuevo cliente', color: AppColors.primary), '/clientes/new'),
      (_AccesoItem(icon: Icons.note_add_rounded, label: 'Nueva declaración', color: AppColors.secondary), '/declaraciones/new'),
      (_AccesoItem(icon: Icons.calendar_month_rounded, label: 'Calendario fiscal', color: AppColors.success), AppRoutes.calendario),
      (_AccesoItem(icon: Icons.folder_open_rounded, label: 'Documentos', color: AppColors.warning), AppRoutes.documentos),
      (_AccesoItem(icon: Icons.event_rounded, label: 'Agenda', color: AppColors.info), AppRoutes.agenda),
      (_AccesoItem(icon: Icons.assessment_rounded, label: 'Reportes', color: AppColors.error), AppRoutes.reportes),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Accesos rápidos', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: 12),
        GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 3,
            mainAxisSpacing: 12,
            crossAxisSpacing: 12,
            childAspectRatio: 1.05,
          ),
          itemCount: items.length,
          itemBuilder: (_, i) => GestureDetector(
            onTap: () => onNavigate(items[i].$2),
            child: items[i].$1,
          ),
        ),
      ],
    );
  }
}

class _AccesoItem extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  const _AccesoItem({required this.icon, required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(12)),
              child: Icon(icon, color: color, size: 24),
            ),
            const SizedBox(height: 8),
            Text(label, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600), textAlign: TextAlign.center, maxLines: 2),
          ],
        ),
      ),
    );
  }
}

// ── Clientes recientes ─────────────────────────────────────────────────────
class _ClientesRecientes extends StatelessWidget {
  final Map<String, dynamic> stats;
  const _ClientesRecientes({required this.stats});

  @override
  Widget build(BuildContext context) {
    final lista = stats['recientes'] as List? ?? [];
    if (lista.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text('Clientes', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
            const Spacer(),
            TextButton(
              onPressed: () => context.push(AppRoutes.clientes),
              child: const Text('Ver todos'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        ...lista.take(5).map((c) {
          final cliente = c as ClienteModel;
          final statusColor = cliente.isActivo ? AppColors.success
              : cliente.isTrial ? AppColors.warning
              : AppColors.error;

          return Card(
            margin: const EdgeInsets.only(bottom: 8),
            child: ListTile(
              leading: CircleAvatar(
                backgroundColor: AppColors.primary.withValues(alpha: 0.1),
                child: Text(
                  Formatters.iniciales(cliente.businessName),
                  style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w700, fontSize: 14),
                ),
              ),
              title: Text(cliente.businessName, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
              subtitle: Text(
                cliente.rnc != null ? Formatters.rnc(cliente.rnc) : '—',
                style: const TextStyle(fontSize: 12),
              ),
              trailing: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  Formatters.estadoLabel(cliente.status),
                  style: TextStyle(color: statusColor, fontSize: 11, fontWeight: FontWeight.w600),
                ),
              ),
              onTap: () => context.push('/clientes/${cliente.id}'),
            ),
          );
        }),
      ],
    );
  }
}

class _StatsShimmer extends StatelessWidget {
  const _StatsShimmer();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: List.generate(2, (_) => Row(
        children: List.generate(2, (__) => Expanded(
          child: Card(
            margin: const EdgeInsets.all(6),
            child: Container(height: 100),
          ),
        )),
      )),
    );
  }
}

class _ErrorCard extends StatelessWidget {
  final String message;
  const _ErrorCard({required this.message});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            const Icon(Icons.error_outline, color: AppColors.error),
            const SizedBox(width: 12),
            Expanded(child: Text(message, style: const TextStyle(color: AppColors.error))),
          ],
        ),
      ),
    );
  }
}

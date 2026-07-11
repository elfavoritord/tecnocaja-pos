import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/config/routes.dart';
import '../../../core/utils/formatters.dart';
import '../../auth/providers/auth_provider.dart';
import '../providers/perfil_provider.dart';

class PerfilScreen extends ConsumerWidget {
  const PerfilScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(userProfileProvider).valueOrNull;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Perfil'),
        actions: [
          IconButton(
            icon: const Icon(Icons.edit_outlined),
            onPressed: () => _showEditSheet(context, ref),
          ),
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => context.push(AppRoutes.configuracion),
          ),
        ],
      ),
      body: profile == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _ProfileHeader(profile: profile),
                const SizedBox(height: 20),
                _InfoCard(profile: profile),
                const SizedBox(height: 16),
                _AccionesCard(ref: ref),
                const SizedBox(height: 80),
              ],
            ),
    );
  }

  void _showEditSheet(BuildContext context, WidgetRef ref) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => _EditPerfilSheet(),
    );
  }
}

class _ProfileHeader extends StatelessWidget {
  final profile;
  const _ProfileHeader({required this.profile});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        CircleAvatar(
          radius: 44,
          backgroundColor: AppColors.primary.withValues(alpha: 0.12),
          backgroundImage: profile.logoUrl != null ? NetworkImage(profile.logoUrl!) : null,
          child: profile.logoUrl == null
              ? Text(
                  Formatters.iniciales(profile.displayName),
                  style: const TextStyle(color: AppColors.primary, fontSize: 28, fontWeight: FontWeight.w700),
                )
              : null,
        ),
        const SizedBox(height: 12),
        Text(profile.displayName, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        Text(profile.email, style: const TextStyle(color: AppColors.textSecondary, fontSize: 14)),
        const SizedBox(height: 8),
        if (profile.isColaborador)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            decoration: BoxDecoration(color: AppColors.secondary.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
            child: const Text('Colaborador', style: TextStyle(color: AppColors.secondary, fontSize: 12, fontWeight: FontWeight.w600)),
          )
        else
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            decoration: BoxDecoration(color: AppColors.primary.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
            child: const Text('Contador Principal', style: TextStyle(color: AppColors.primary, fontSize: 12, fontWeight: FontWeight.w600)),
          ),
      ],
    );
  }
}

class _InfoCard extends StatelessWidget {
  final profile;
  const _InfoCard({required this.profile});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Información de la firma', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            const SizedBox(height: 12),
            _Row(icon: Icons.business_rounded, label: 'Firma contable', value: profile.nombreFirma.isEmpty ? '—' : profile.nombreFirma),
            _Row(icon: Icons.person_outline, label: 'Responsable', value: profile.responsable.isEmpty ? '—' : profile.responsable),
            _Row(icon: Icons.badge_outlined, label: 'RNC', value: Formatters.rnc(profile.rnc.isEmpty ? null : profile.rnc)),
            _Row(icon: Icons.phone_outlined, label: 'Teléfono', value: Formatters.telefono(profile.telefono.isEmpty ? null : profile.telefono)),
            _Row(icon: Icons.email_outlined, label: 'Correo', value: profile.correo.isEmpty ? '—' : profile.correo),
          ],
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  const _Row({required this.icon, required this.label, required this.value});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            Icon(icon, size: 18, color: AppColors.textSecondary),
            const SizedBox(width: 12),
            SizedBox(width: 110, child: Text(label, style: const TextStyle(color: AppColors.textSecondary, fontSize: 13))),
            Expanded(child: Text(value, style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 14))),
          ],
        ),
      );
}

class _AccionesCard extends StatelessWidget {
  final WidgetRef ref;
  const _AccionesCard({required this.ref});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Column(
        children: [
          ListTile(
            leading: const Icon(Icons.lock_outline_rounded, color: AppColors.primary),
            title: const Text('Cambiar contraseña'),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: () => context.push(AppRoutes.forgotPassword),
          ),
          const Divider(height: 1, indent: 56),
          ListTile(
            leading: const Icon(Icons.settings_outlined, color: AppColors.secondary),
            title: const Text('Configuración'),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: () => context.push(AppRoutes.configuracion),
          ),
          const Divider(height: 1, indent: 56),
          ListTile(
            leading: const Icon(Icons.logout_rounded, color: AppColors.error),
            title: const Text('Cerrar sesión', style: TextStyle(color: AppColors.error)),
            onTap: () => _confirmLogout(context),
          ),
        ],
      ),
    );
  }

  Future<void> _confirmLogout(BuildContext context) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Cerrar sesión'),
        content: const Text('¿Seguro que deseas cerrar sesión?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.error),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Cerrar sesión'),
          ),
        ],
      ),
    );
    if (confirm == true) {
      await ref.read(userProfileProvider.notifier).signOut();
      if (context.mounted) context.go(AppRoutes.login);
    }
  }
}

class _EditPerfilSheet extends ConsumerStatefulWidget {
  @override
  ConsumerState<_EditPerfilSheet> createState() => _EditPerfilSheetState();
}

class _EditPerfilSheetState extends ConsumerState<_EditPerfilSheet> {
  late final TextEditingController _firmaCtrl;
  late final TextEditingController _responsableCtrl;
  late final TextEditingController _telefonoCtrl;
  late final TextEditingController _correoCtrl;

  @override
  void initState() {
    super.initState();
    final p = ref.read(userProfileProvider).valueOrNull;
    _firmaCtrl = TextEditingController(text: p?.nombreFirma ?? '');
    _responsableCtrl = TextEditingController(text: p?.responsable ?? '');
    _telefonoCtrl = TextEditingController(text: p?.telefono ?? '');
    _correoCtrl = TextEditingController(text: p?.correo ?? '');
  }

  @override
  void dispose() {
    _firmaCtrl.dispose();
    _responsableCtrl.dispose();
    _telefonoCtrl.dispose();
    _correoCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final ok = await ref.read(perfilFormProvider.notifier).save({
      'nombre_firma': _firmaCtrl.text.trim(),
      'responsable': _responsableCtrl.text.trim(),
      'telefono': _telefonoCtrl.text.trim(),
      'correo': _correoCtrl.text.trim(),
    });
    if (ok && mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(perfilFormProvider);
    final bottom = MediaQuery.of(context).viewInsets.bottom;

    return Padding(
      padding: EdgeInsets.fromLTRB(24, 24, 24, 24 + bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Editar perfil', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 20),
          TextField(
            controller: _firmaCtrl,
            decoration: const InputDecoration(labelText: 'Nombre de firma', prefixIcon: Icon(Icons.business_outlined)),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _responsableCtrl,
            decoration: const InputDecoration(labelText: 'Responsable', prefixIcon: Icon(Icons.person_outline)),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _telefonoCtrl,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(labelText: 'Teléfono', prefixIcon: Icon(Icons.phone_outlined)),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _correoCtrl,
            keyboardType: TextInputType.emailAddress,
            decoration: const InputDecoration(labelText: 'Correo de contacto', prefixIcon: Icon(Icons.email_outlined)),
          ),
          const SizedBox(height: 20),
          if (state.error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(state.error!, style: const TextStyle(color: AppColors.error, fontSize: 13)),
            ),
          ElevatedButton(
            onPressed: state.isSaving ? null : _submit,
            child: state.isSaving
                ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Guardar cambios'),
          ),
        ],
      ),
    );
  }
}

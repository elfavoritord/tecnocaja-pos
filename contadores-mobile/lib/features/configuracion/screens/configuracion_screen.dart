import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import '../../../core/constants/app_colors.dart';
import '../../auth/providers/auth_provider.dart';
import '../providers/configuracion_provider.dart';

class ConfiguracionScreen extends ConsumerWidget {
  const ConfiguracionScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeMode = ref.watch(themeProvider);
    final notifEnabled = ref.watch(notifEnabledProvider);
    final biometricsEnabled = ref.watch(biometricsEnabledProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Configuración')),
      body: ListView(
        children: [
          _Section(title: 'Apariencia', children: [
            ListTile(
              leading: const Icon(Icons.palette_outlined),
              title: const Text('Tema'),
              subtitle: Text(_themeLabel(themeMode)),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => _showThemePicker(context, ref, themeMode),
            ),
          ]),
          _Section(title: 'Notificaciones', children: [
            SwitchListTile(
              secondary: const Icon(Icons.notifications_outlined),
              title: const Text('Notificaciones push'),
              subtitle: const Text('Recibir alertas de vencimientos y mensajes'),
              value: notifEnabled,
              onChanged: (_) => ref.read(notifEnabledProvider.notifier).toggle(),
            ),
          ]),
          _Section(title: 'Seguridad', children: [
            SwitchListTile(
              secondary: const Icon(Icons.fingerprint_rounded),
              title: const Text('Autenticación biométrica'),
              subtitle: const Text('Usar huella o Face ID para entrar'),
              value: biometricsEnabled,
              onChanged: (_) => ref.read(biometricsEnabledProvider.notifier).toggle(),
            ),
            ListTile(
              leading: const Icon(Icons.pin_outlined),
              title: const Text('PIN de seguridad'),
              subtitle: const Text('Configura un PIN de 4-6 dígitos'),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => _showPinSetup(context, ref),
            ),
          ]),
          _Section(title: 'Cuenta', children: [
            ListTile(
              leading: const Icon(Icons.devices_rounded),
              title: const Text('Sesiones activas'),
              subtitle: const Text('Ver dispositivos con sesión abierta'),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => _showSesiones(context),
            ),
            ListTile(
              leading: const Icon(Icons.logout_rounded, color: AppColors.error),
              title: const Text('Cerrar sesión', style: TextStyle(color: AppColors.error)),
              onTap: () => _confirmLogout(context, ref),
            ),
          ]),
          _Section(title: 'Información', children: [
            ListTile(
              leading: const Icon(Icons.info_outline_rounded),
              title: const Text('Versión de la app'),
              trailing: FutureBuilder<PackageInfo>(
                future: PackageInfo.fromPlatform(),
                builder: (_, snap) => Text(
                  snap.hasData ? snap.data!.version : '—',
                  style: const TextStyle(color: AppColors.textSecondary),
                ),
              ),
            ),
            ListTile(
              leading: const Icon(Icons.support_agent_rounded),
              title: const Text('Soporte técnico'),
              trailing: const Icon(Icons.open_in_new_rounded, size: 18),
              onTap: () {},
            ),
          ]),
          const SizedBox(height: 40),
        ],
      ),
    );
  }

  String _themeLabel(ThemeMode mode) {
    switch (mode) {
      case ThemeMode.light: return 'Claro';
      case ThemeMode.dark: return 'Oscuro';
      default: return 'Sistema';
    }
  }

  void _showThemePicker(BuildContext context, WidgetRef ref, ThemeMode current) {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Tema de la aplicación', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            for (final mode in ThemeMode.values)
              RadioListTile<ThemeMode>(
                title: Text(_themeLabel(mode)),
                value: mode,
                groupValue: current,
                onChanged: (v) {
                  if (v != null) ref.read(themeProvider.notifier).setMode(v);
                  Navigator.pop(context);
                },
              ),
          ],
        ),
      ),
    );
  }

  void _showPinSetup(BuildContext context, WidgetRef ref) {
    final ctrl = TextEditingController();
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Configurar PIN'),
        content: TextField(
          controller: ctrl,
          keyboardType: TextInputType.number,
          maxLength: 6,
          obscureText: true,
          decoration: const InputDecoration(labelText: 'PIN (4-6 dígitos)', prefixIcon: Icon(Icons.pin_outlined)),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancelar')),
          FilledButton(
            onPressed: () async {
              final pin = ctrl.text.trim();
              if (pin.length >= 4) {
                await ref.read(authServiceProvider).setPin(pin);
                if (context.mounted) {
                  Navigator.pop(context);
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('PIN configurado correctamente')));
                }
              }
            },
            child: const Text('Guardar'),
          ),
        ],
      ),
    );
  }

  void _showSesiones(BuildContext context) {
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Sesiones activas'),
        content: const Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(Icons.phone_android_rounded, color: AppColors.primary),
              title: Text('Este dispositivo'),
              subtitle: Text('Sesión actual · Activa ahora'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar')),
        ],
      ),
    );
  }

  Future<void> _confirmLogout(BuildContext context, WidgetRef ref) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Cerrar sesión'),
        content: const Text('¿Deseas cerrar sesión en este dispositivo?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          FilledButton(style: FilledButton.styleFrom(backgroundColor: AppColors.error), onPressed: () => Navigator.pop(context, true), child: const Text('Cerrar sesión')),
        ],
      ),
    );
    if (confirm == true) await ref.read(userProfileProvider.notifier).signOut();
  }
}

class _Section extends StatelessWidget {
  final String title;
  final List<Widget> children;

  const _Section({required this.title, required this.children});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 20, 16, 6),
          child: Text(title, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: AppColors.textSecondary, letterSpacing: 0.5)),
        ),
        Card(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          child: Column(children: children),
        ),
      ],
    );
  }
}

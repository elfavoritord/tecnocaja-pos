import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;

import '../../../core/constants/app_colors.dart';
import '../../../data/services/novapos_api_settings_service.dart';
import '../../../data/services/pos_session_service.dart';
import '../providers/theme_provider.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeMode = ref.watch(themeProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Configuración'),
        leading: BackButton(onPressed: () => context.go('/dashboard')),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // ── Apariencia ──────────────────────────────────────────────────
          _SettingsCard(
            title: 'Apariencia',
            icon: Icons.palette_outlined,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Selecciona el modo visual del panel.',
                  style: TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                    height: 1.5,
                  ),
                ),
                const SizedBox(height: 14),
                SegmentedButton<ThemeMode>(
                  segments: const [
                    ButtonSegment<ThemeMode>(
                      value: ThemeMode.system,
                      icon: Icon(Icons.auto_mode_rounded),
                      label: Text('Sistema'),
                    ),
                    ButtonSegment<ThemeMode>(
                      value: ThemeMode.light,
                      icon: Icon(Icons.light_mode_outlined),
                      label: Text('Claro'),
                    ),
                    ButtonSegment<ThemeMode>(
                      value: ThemeMode.dark,
                      icon: Icon(Icons.dark_mode_outlined),
                      label: Text('Oscuro'),
                    ),
                  ],
                  selected: {themeMode},
                  onSelectionChanged: (s) =>
                      ref.read(themeProvider.notifier).setTheme(s.first),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // ── Servidor ────────────────────────────────────────────────────
          const _ServerConnectionCard(),
          const SizedBox(height: 16),

          // ── Sincronización ──────────────────────────────────────────────
          const _SettingsCard(
            title: 'Sincronización',
            icon: Icons.cloud_sync_outlined,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _SettingsInfo(
                  icon: Icons.cloud_done_outlined,
                  iconColor: AppColors.success,
                  title: 'Autenticación en la nube',
                  subtitle:
                      'El inicio de sesión y los permisos de usuario se validan mediante Firebase de forma segura desde cualquier lugar.',
                ),
                SizedBox(height: 12),
                _SettingsInfo(
                  icon: Icons.manage_accounts_outlined,
                  iconColor: AppColors.primary,
                  title: 'Datos desde el servidor',
                  subtitle:
                      'Los reportes y el dashboard se obtienen directamente del servidor configurado arriba.',
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // ── Próximas funciones ──────────────────────────────────────────
          const _SettingsCard(
            title: 'Próximas funciones',
            icon: Icons.rocket_launch_outlined,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _SettingsInfo(
                  icon: Icons.picture_as_pdf_outlined,
                  iconColor: AppColors.error,
                  title: 'Exportar PDF',
                  subtitle:
                      'Generar cierres y reportes descargables desde el móvil.',
                ),
                SizedBox(height: 12),
                _SettingsInfo(
                  icon: Icons.table_chart_outlined,
                  iconColor: AppColors.success,
                  title: 'Exportar Excel',
                  subtitle: 'Descargar tablas filtradas para análisis externo.',
                ),
                SizedBox(height: 12),
                _SettingsInfo(
                  icon: Icons.psychology_alt_outlined,
                  iconColor: AppColors.secondary,
                  title: 'Resumen IA del negocio',
                  subtitle:
                      'Analizar ventas, gastos y alertas para dar recomendaciones automáticas.',
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),

          // ── Versión ─────────────────────────────────────────────────────
          const Center(
            child: Text(
              'Tecno Reporte · v1.0.0',
              style: TextStyle(
                color: AppColors.textTertiary,
                fontSize: 12,
              ),
            ),
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

// ─── Widgets ─────────────────────────────────────────────────────────────────

class _ServerConnectionCard extends StatefulWidget {
  const _ServerConnectionCard();

  @override
  State<_ServerConnectionCard> createState() => _ServerConnectionCardState();
}

class _ServerConnectionCardState extends State<_ServerConnectionCard> {
  final _controller = TextEditingController();
  bool _saving = false;
  bool _testing = false;
  bool? _testOk;

  @override
  void initState() {
    super.initState();
    NovaposApiSettingsService.instance.getBaseUrl().then((url) {
      if (mounted) setState(() => _controller.text = url);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final value = _controller.text.trim();
    if (value.isEmpty) return;
    setState(() => _saving = true);
    await NovaposApiSettingsService.instance.setBaseUrl(value);
    await PosSessionService.instance.clearSession();
    if (mounted) {
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('URL guardada. Cierra sesión y vuelve a entrar para reconectar.'),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  Future<void> _testConnection() async {
    final value = _controller.text.trim();
    if (value.isEmpty) return;
    setState(() {
      _testing = true;
      _testOk = null;
    });
    try {
      final normalized = value.startsWith('http') ? value : 'https://$value';
      final uri = Uri.parse(normalized.replaceFirst(RegExp(r'/+$'), ''));
      final response = await http.get(uri).timeout(const Duration(seconds: 8));
      if (mounted) setState(() => _testOk = response.statusCode < 500);
    } catch (_) {
      if (mounted) setState(() => _testOk = false);
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: Theme.of(context).cardColor,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: isDark ? AppColors.darkBorder : AppColors.lightBorder,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.dns_outlined, size: 18, color: AppColors.primary),
              const SizedBox(width: 8),
              const Text(
                'Servidor',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
              ),
              const Spacer(),
              if (_testOk != null)
                Icon(
                  _testOk! ? Icons.check_circle_outline : Icons.error_outline,
                  size: 18,
                  color: _testOk! ? AppColors.success : AppColors.error,
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            'URL pública del servidor (ej. https://mitienda.cfargotunnel.com)',
            style: TextStyle(
              color: AppColors.textSecondary,
              fontSize: 12,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: _controller,
            keyboardType: TextInputType.url,
            autocorrect: false,
            decoration: InputDecoration(
              hintText: 'https://tu-tienda.cfargotunnel.com',
              hintStyle: const TextStyle(fontSize: 13),
              contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide(
                  color: isDark ? AppColors.darkBorder : AppColors.lightBorder,
                ),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide(
                  color: isDark ? AppColors.darkBorder : AppColors.lightBorder,
                ),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(color: AppColors.primary, width: 1.5),
              ),
            ),
            style: const TextStyle(fontSize: 13),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _testing ? null : _testConnection,
                  icon: _testing
                      ? const SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.wifi_tethering_rounded, size: 16),
                  label: Text(_testing ? 'Probando...' : 'Probar'),
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton.icon(
                  onPressed: _saving ? null : _save,
                  icon: _saving
                      ? const SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Icon(Icons.save_outlined, size: 16),
                  label: Text(_saving ? 'Guardando...' : 'Guardar'),
                  style: FilledButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SettingsCard extends StatelessWidget {
  final String title;
  final IconData icon;
  final Widget child;

  const _SettingsCard({
    required this.title,
    required this.icon,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: Theme.of(context).cardColor,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: isDark ? AppColors.darkBorder : AppColors.lightBorder,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: AppColors.primary),
              const SizedBox(width: 8),
              Text(
                title,
                style: const TextStyle(
                  fontWeight: FontWeight.w700,
                  fontSize: 15,
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          child,
        ],
      ),
    );
  }
}

class _SettingsInfo extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final String title;
  final String subtitle;

  const _SettingsInfo({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          padding: const EdgeInsets.all(9),
          decoration: BoxDecoration(
            color: iconColor.withValues(alpha: 0.1),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Icon(icon, color: iconColor, size: 18),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: 13,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                subtitle,
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 12,
                  height: 1.4,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

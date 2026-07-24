import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/auth/auth_repository.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/configuracion_repository.dart';
import '../../data/repositories/empresa_repository.dart';
import '../../data/sync/catalog_sync_repository.dart';
import 'printer_settings_screen.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    final configAsync = ref.watch(configuracionControllerProvider);
    final usuario = auth.usuario;

    return Scaffold(
      appBar: AppBar(title: const Text('Ajustes')),
      body: ListView(
        children: [
          if (usuario != null)
            ListTile(
              leading: const CircleAvatar(child: Icon(Icons.person)),
              title: Text(usuario.nombreCompleto),
              subtitle: Text(usuario.email ?? usuario.usuario),
            ),
          const Divider(),
          const _SeccionTitulo('Apariencia'),
          configAsync.when(
            data: (config) => RadioGroup<String>(
              groupValue: config.tema,
              onChanged: (v) {
                if (v != null) {
                  ref.read(configuracionControllerProvider.notifier).actualizar((c) => c.copyWith(tema: v));
                }
              },
              child: const Column(
                children: [
                  RadioListTile<String>(title: Text('Igual al sistema'), value: 'sistema'),
                  RadioListTile<String>(title: Text('Claro'), value: 'claro'),
                  RadioListTile<String>(title: Text('Oscuro'), value: 'oscuro'),
                ],
              ),
            ),
            loading: () => const Padding(
              padding: EdgeInsets.all(16),
              child: LinearProgressIndicator(),
            ),
            error: (e, _) => Padding(padding: const EdgeInsets.all(16), child: Text('Error: $e')),
          ),
          const Divider(),
          const _SeccionTitulo('Módulos'),
          ListTile(
            leading: const Icon(Icons.people_outline),
            title: const Text('Clientes'),
            subtitle: const Text('Directorio, cuentas por cobrar y abonos'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.go('/clientes'),
          ),
          ListTile(
            leading: const Icon(Icons.inventory_2_outlined),
            title: const Text('Inventario'),
            subtitle: const Text('Stock por sucursal, ajustes y kardex'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.go('/inventario'),
          ),
          ListTile(
            leading: const Icon(Icons.local_shipping_outlined),
            title: const Text('Proveedores'),
            subtitle: const Text('Directorio y cuentas por pagar'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.go('/proveedores'),
          ),
          const Divider(),
          const _SeccionTitulo('Impresión'),
          ListTile(
            leading: const Icon(Icons.print_outlined),
            title: const Text('Impresora Bluetooth'),
            subtitle: Text(
              (configAsync.valueOrNull?.impresoraPredeterminadaMac?.isNotEmpty ?? false)
                  ? 'Configurada · ${configAsync.valueOrNull!.impresoraAnchoMm} mm'
                  : 'Sin configurar',
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push<void>(
              MaterialPageRoute(builder: (_) => const PrinterSettingsScreen()),
            ),
          ),
          const Divider(),
          const _SeccionTitulo('Sincronización con Windows'),
          const _SeccionSincronizacion(),
          const Divider(),
          const _SeccionTitulo('Seguridad'),
          if (usuario != null)
            SwitchListTile(
              title: const Text('Bloqueo con PIN'),
              subtitle: const Text('Pide un PIN al volver a abrir la app'),
              value: usuario.pinHash != null && usuario.pinHash!.isNotEmpty,
              onChanged: (activar) => _alternarPin(context, ref, activar),
            ),
          const Divider(),
          const _SeccionTitulo('Cuenta'),
          ListTile(
            leading: const Icon(Icons.badge_outlined),
            title: const Text('Tecno Caja ID'),
            subtitle: Text(usuario?.firebaseUid ?? '—', style: const TextStyle(fontFamily: 'monospace')),
          ),
          ListTile(
            leading: const Icon(Icons.logout),
            title: const Text('Cerrar sesión'),
            onTap: () => ref.read(authControllerProvider.notifier).cerrarSesion(),
          ),
          const Divider(),
          const _SeccionTitulo('Acerca de'),
          FutureBuilder<PackageInfo>(
            future: PackageInfo.fromPlatform(),
            builder: (context, snapshot) {
              final version = snapshot.data;
              return ListTile(
                leading: const Icon(Icons.info_outline),
                title: const Text('Versión de la app'),
                subtitle: Text(version == null ? '—' : '${version.version}+${version.buildNumber}'),
              );
            },
          ),
        ],
      ),
    );
  }

  Future<void> _alternarPin(BuildContext context, WidgetRef ref, bool activar) async {
    final usuario = ref.read(authControllerProvider).usuario;
    if (usuario == null) return;
    if (!activar) {
      await ref.read(authRepositoryProvider).quitarPin(usuario);
      ref.invalidate(authControllerProvider);
      return;
    }
    final pin = await showDialog<String>(
      context: context,
      builder: (context) => const _DialogoCrearPin(),
    );
    if (pin != null && pin.length >= 4) {
      await ref.read(authRepositoryProvider).establecerPin(usuario, pin);
      ref.invalidate(authControllerProvider);
    }
  }
}

class _SeccionTitulo extends StatelessWidget {
  const _SeccionTitulo(this.texto);
  final String texto;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Text(
        texto,
        style: Theme.of(context).textTheme.labelLarge?.copyWith(color: Theme.of(context).colorScheme.primary),
      ),
    );
  }
}

/// Estado de vinculación con Tecno Caja Windows + botón para forzar un pull
/// de catálogo. La vinculación misma es automática (ver
/// AuthController._intentarVincularConWindows) -- esta sección solo informa
/// y deja repetir la sincronización de catálogo a mano.
class _SeccionSincronizacion extends ConsumerStatefulWidget {
  const _SeccionSincronizacion();

  @override
  ConsumerState<_SeccionSincronizacion> createState() => _SeccionSincronizacionState();
}

class _SeccionSincronizacionState extends ConsumerState<_SeccionSincronizacion> {
  bool _sincronizando = false;

  Future<void> _sincronizarAhora() async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    final sucursal = await ref.read(sucursalActivaProvider.future);
    if (empresaId == null || sucursal == null) return;

    setState(() => _sincronizando = true);
    try {
      final deviceId = await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      final resultado = await ref.read(catalogSyncRepositoryProvider).sincronizarTodo(
            empresaId: empresaId,
            sucursal: sucursal,
            dispositivoId: deviceId,
          );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(
            'Sincronizado: ${resultado.productos} productos, ${resultado.clientes} clientes, ${resultado.proveedores} proveedores.',
          ),
        ));
      }
    } on AppException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message), backgroundColor: AppColors.danger));
      }
    } finally {
      if (mounted) setState(() => _sincronizando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final configAsync = ref.watch(configuracionControllerProvider);

    return configAsync.when(
      loading: () => const Padding(padding: EdgeInsets.all(16), child: LinearProgressIndicator()),
      error: (e, _) => Padding(padding: const EdgeInsets.all(16), child: Text('Error: $e')),
      data: (config) {
        if (!config.windowsVinculado) {
          return const ListTile(
            leading: Icon(Icons.cloud_off_outlined),
            title: Text('No vinculado'),
            subtitle: Text('Se vincula automático si inicias sesión con la misma cuenta de Google que usas en el POS Windows.'),
          );
        }
        return Column(
          children: [
            FutureBuilder(
              future: ref.read(empresaRepositoryProvider).actual(),
              builder: (context, snapshot) {
                final empresa = snapshot.data;
                return ListTile(
                  leading: const Icon(Icons.cloud_done_outlined, color: AppColors.success),
                  title: Text(empresa?.nombre ?? 'Negocio vinculado'),
                  subtitle: Text(
                    config.windowsVinculadoEn == null
                        ? 'Vinculado con Tecno Caja Windows'
                        : 'Vinculado el ${Formatters.dateTime(config.windowsVinculadoEn!)}',
                  ),
                );
              },
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: _sincronizando ? null : _sincronizarAhora,
                  icon: _sincronizando
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.sync),
                  label: Text(_sincronizando ? 'Sincronizando…' : 'Sincronizar catálogo ahora'),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _DialogoCrearPin extends StatefulWidget {
  const _DialogoCrearPin();

  @override
  State<_DialogoCrearPin> createState() => _DialogoCrearPinState();
}

class _DialogoCrearPinState extends State<_DialogoCrearPin> {
  final _pinCtrl = TextEditingController();

  @override
  void dispose() {
    _pinCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Crear PIN'),
      content: TextField(
        controller: _pinCtrl,
        obscureText: true,
        keyboardType: TextInputType.number,
        maxLength: 6,
        decoration: const InputDecoration(hintText: '4 a 6 dígitos'),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancelar')),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_pinCtrl.text),
          child: const Text('Guardar'),
        ),
      ],
    );
  }
}

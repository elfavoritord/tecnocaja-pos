import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../data/auth/auth_controller.dart';
import '../../widgets/app_logo.dart';
import '../../widgets/loading_button.dart';

class PinLockScreen extends ConsumerStatefulWidget {
  const PinLockScreen({super.key});

  @override
  ConsumerState<PinLockScreen> createState() => _PinLockScreenState();
}

class _PinLockScreenState extends ConsumerState<PinLockScreen> {
  final _pinCtrl = TextEditingController();
  bool _cargando = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _intentarBiometria());
  }

  @override
  void dispose() {
    _pinCtrl.dispose();
    super.dispose();
  }

  Future<void> _intentarBiometria() async {
    final biometria = ref.read(biometricServiceProvider);
    if (!await biometria.disponible()) return;
    final ok = await biometria.autenticar(razon: 'Desbloquea Tecno Caja POS');
    if (ok && mounted) {
      ref.read(authControllerProvider.notifier).desbloquearConBiometria();
    }
  }

  Future<void> _desbloquear() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      await ref.read(authControllerProvider.notifier).desbloquearConPin(_pinCtrl.text);
    } on AppException catch (e) {
      setState(() => _error = e.message);
      _pinCtrl.clear();
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final usuario = ref.watch(authControllerProvider).usuario;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 360),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const AppLogo(size: 72),
                  const SizedBox(height: 16),
                  Text('Sesión bloqueada', style: Theme.of(context).textTheme.titleLarge),
                  const SizedBox(height: 4),
                  if (usuario != null)
                    Text(usuario.nombreCompleto, style: Theme.of(context).textTheme.bodyMedium),
                  const SizedBox(height: 24),
                  TextField(
                    controller: _pinCtrl,
                    autofocus: true,
                    obscureText: true,
                    keyboardType: TextInputType.number,
                    textAlign: TextAlign.center,
                    maxLength: 6,
                    style: const TextStyle(fontSize: 28, letterSpacing: 8),
                    decoration: InputDecoration(
                      counterText: '',
                      errorText: _error,
                      hintText: '••••',
                    ),
                    onSubmitted: (_) => _desbloquear(),
                  ),
                  const SizedBox(height: 12),
                  LoadingButton(label: 'Desbloquear', isLoading: _cargando, onPressed: _desbloquear),
                  const SizedBox(height: 12),
                  TextButton.icon(
                    onPressed: _intentarBiometria,
                    icon: const Icon(Icons.fingerprint),
                    label: const Text('Usar huella / rostro'),
                  ),
                  TextButton(
                    onPressed: () => ref.read(authControllerProvider.notifier).cerrarSesion(),
                    child: const Text('Cerrar sesión'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

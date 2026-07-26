import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors/app_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/auth/auth_repository.dart';
import '../../widgets/loading_button.dart';

/// Login con el mismo usuario/contraseña con el que un cajero ya entra en
/// Tecno Caja POS Windows -- para cuentas que nunca han iniciado sesión con
/// Google (ver AuthController.iniciarSesionLocalPos). Requiere que el
/// dispositivo pueda alcanzar ese POS por red (nube o LAN).
class PosLocalLoginScreen extends ConsumerStatefulWidget {
  const PosLocalLoginScreen({super.key});

  @override
  ConsumerState<PosLocalLoginScreen> createState() =>
      _PosLocalLoginScreenState();
}

class _PosLocalLoginScreenState extends ConsumerState<PosLocalLoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _usuarioCtrl = TextEditingController();
  final _contrasenaCtrl = TextEditingController();
  bool _ocultarContrasena = true;
  bool _cargando = false;

  @override
  void dispose() {
    _usuarioCtrl.dispose();
    _contrasenaCtrl.dispose();
    super.dispose();
  }

  Future<void> _iniciarSesion() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _cargando = true);
    try {
      final usuario = _usuarioCtrl.text.trim();
      if (usuario.contains('@')) {
        // Un correo identifica una cuenta Tecno Caja móvil/Firebase y jamás
        // debe intentar conectarse a una computadora Windows.
        await ref.read(authRepositoryProvider).iniciarSesionConCorreo(
              correo: usuario,
              contrasena: _contrasenaCtrl.text,
            );
      } else {
        await ref.read(authControllerProvider.notifier).iniciarSesionLocalPos(
              usuario: usuario,
              password: _contrasenaCtrl.text,
            );
      }
      // El router redirige solo al ver AuthStatus.autenticado.
    } on AppException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Iniciar sesión')),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'Usa tu correo para entrar sin computadora. Solo los nombres de usuario del POS requieren conexión con Windows.',
                      style: Theme.of(context).textTheme.bodyMedium,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 28),
                    TextFormField(
                      controller: _usuarioCtrl,
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(
                        labelText: 'Correo o usuario del POS',
                        helperText:
                            'Con correo no necesitas tener el POS encendido',
                      ),
                      validator: (v) =>
                          Validators.required(v, label: 'El correo o usuario'),
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _contrasenaCtrl,
                      obscureText: _ocultarContrasena,
                      textInputAction: TextInputAction.done,
                      onFieldSubmitted: (_) => _iniciarSesion(),
                      decoration: InputDecoration(
                        labelText: 'Contraseña',
                        suffixIcon: IconButton(
                          icon: Icon(_ocultarContrasena
                              ? Icons.visibility_off
                              : Icons.visibility),
                          onPressed: () => setState(
                              () => _ocultarContrasena = !_ocultarContrasena),
                        ),
                      ),
                      validator: (v) =>
                          Validators.required(v, label: 'La contraseña'),
                    ),
                    const SizedBox(height: 24),
                    LoadingButton(
                      label: 'Iniciar sesión',
                      isLoading: _cargando,
                      onPressed: _iniciarSesion,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

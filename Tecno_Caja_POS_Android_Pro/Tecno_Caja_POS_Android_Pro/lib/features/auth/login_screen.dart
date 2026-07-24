import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/errors/app_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/auth/auth_repository.dart';
import '../../widgets/app_logo.dart';
import '../../widgets/loading_button.dart';
import 'pos_local_login_screen.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _correoCtrl = TextEditingController();
  final _contrasenaCtrl = TextEditingController();
  bool _ocultarContrasena = true;
  bool _cargando = false;
  bool _cargandoGoogle = false;

  @override
  void dispose() {
    _correoCtrl.dispose();
    _contrasenaCtrl.dispose();
    super.dispose();
  }

  Future<void> _iniciarSesion() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _cargando = true);
    try {
      await ref.read(authRepositoryProvider).iniciarSesionConCorreo(
            correo: _correoCtrl.text.trim(),
            contrasena: _contrasenaCtrl.text,
          );
      // El AuthController (escuchando authStateChanges) hace el resto:
      // resuelve el Usuario local y el router redirige automaticamente.
    } on AppException catch (e) {
      _mostrarError(e.message);
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _iniciarSesionConGoogle() async {
    setState(() => _cargandoGoogle = true);
    try {
      await ref.read(authRepositoryProvider).iniciarSesionConGoogle();
    } on AppException catch (e) {
      _mostrarError(e.message);
    } finally {
      if (mounted) setState(() => _cargandoGoogle = false);
    }
  }

  void _mostrarError(String mensaje) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(mensaje)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
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
                  children: [
                    const AppLogo(size: 88),
                    const SizedBox(height: 16),
                    Text('Tecno Caja POS', style: Theme.of(context).textTheme.headlineMedium),
                    const SizedBox(height: 4),
                    Text(
                      'La tecnología que impulsa tus ventas',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 36),
                    TextFormField(
                      controller: _correoCtrl,
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(labelText: 'Correo electrónico'),
                      validator: Validators.email,
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
                          icon: Icon(_ocultarContrasena ? Icons.visibility_off : Icons.visibility),
                          onPressed: () => setState(() => _ocultarContrasena = !_ocultarContrasena),
                        ),
                      ),
                      validator: (v) => Validators.required(v, label: 'La contraseña'),
                    ),
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton(
                        onPressed: () => context.push('/recuperar-contrasena'),
                        child: const Text('¿Olvidaste tu contraseña?'),
                      ),
                    ),
                    const SizedBox(height: 8),
                    LoadingButton(label: 'Iniciar sesión', isLoading: _cargando, onPressed: _iniciarSesion),
                    const SizedBox(height: 12),
                    LoadingButton(
                      label: 'Continuar con Google',
                      outlined: true,
                      icon: Icons.g_mobiledata,
                      isLoading: _cargandoGoogle,
                      onPressed: _iniciarSesionConGoogle,
                    ),
                    const SizedBox(height: 8),
                    TextButton.icon(
                      icon: const Icon(Icons.point_of_sale_outlined, size: 18),
                      label: const Text('Entrar con un usuario del POS'),
                      onPressed: () => Navigator.of(context).push<void>(
                        MaterialPageRoute(builder: (_) => const PosLocalLoginScreen()),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text('¿No tienes cuenta?', style: Theme.of(context).textTheme.bodyMedium),
                        TextButton(
                          onPressed: () => context.push('/registro'),
                          child: const Text('Crear una cuenta'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.cloud_off, size: 18, color: Theme.of(context).textTheme.bodySmall?.color),
                        const SizedBox(width: 8),
                        Text('También funciona sin conexión', style: Theme.of(context).textTheme.bodySmall),
                      ],
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

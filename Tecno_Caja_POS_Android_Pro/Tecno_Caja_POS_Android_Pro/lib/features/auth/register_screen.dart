import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors/app_exception.dart';
import '../../core/utils/validators.dart';
import '../../data/auth/auth_repository.dart';
import '../../widgets/loading_button.dart';

/// Solo datos de la CUENTA (persona). Los datos del NEGOCIO (empresa,
/// sucursal, RNC, moneda, etc.) se piden en /onboarding justo despues --
/// el router redirige ahi automaticamente en cuanto Firebase confirma esta
/// cuenta nueva y AuthController detecta que no hay Usuario local todavia.
class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({super.key});

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nombreCtrl = TextEditingController();
  final _correoCtrl = TextEditingController();
  final _telefonoCtrl = TextEditingController();
  final _contrasenaCtrl = TextEditingController();
  final _confirmarCtrl = TextEditingController();
  bool _cargando = false;
  bool _ocultarContrasena = true;

  @override
  void dispose() {
    _nombreCtrl.dispose();
    _correoCtrl.dispose();
    _telefonoCtrl.dispose();
    _contrasenaCtrl.dispose();
    _confirmarCtrl.dispose();
    super.dispose();
  }

  Future<void> _registrar() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _cargando = true);
    try {
      await ref.read(authRepositoryProvider).registrarConCorreo(
            correo: _correoCtrl.text.trim(),
            contrasena: _contrasenaCtrl.text,
            nombreCompleto: _nombreCtrl.text.trim(),
          );
    } on AppException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Crear cuenta')),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextFormField(
                      controller: _nombreCtrl,
                      textCapitalization: TextCapitalization.words,
                      decoration: const InputDecoration(labelText: 'Nombre completo'),
                      validator: (v) => Validators.required(v, label: 'El nombre'),
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _correoCtrl,
                      keyboardType: TextInputType.emailAddress,
                      decoration: const InputDecoration(labelText: 'Correo electrónico'),
                      validator: Validators.email,
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _telefonoCtrl,
                      keyboardType: TextInputType.phone,
                      decoration: const InputDecoration(labelText: 'Teléfono (809/829/849-000-0000)'),
                      validator: Validators.phoneRD,
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _contrasenaCtrl,
                      obscureText: _ocultarContrasena,
                      decoration: InputDecoration(
                        labelText: 'Contraseña',
                        suffixIcon: IconButton(
                          icon: Icon(_ocultarContrasena ? Icons.visibility_off : Icons.visibility),
                          onPressed: () => setState(() => _ocultarContrasena = !_ocultarContrasena),
                        ),
                      ),
                      validator: Validators.password,
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _confirmarCtrl,
                      obscureText: _ocultarContrasena,
                      decoration: const InputDecoration(labelText: 'Confirmar contraseña'),
                      validator: (v) => Validators.confirmPassword(v, _contrasenaCtrl.text),
                    ),
                    const SizedBox(height: 22),
                    LoadingButton(label: 'Crear cuenta', isLoading: _cargando, onPressed: _registrar),
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

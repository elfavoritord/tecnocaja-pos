import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/constants/app_colors.dart';
import '../providers/auth_provider.dart';

class ForgotPasswordScreen extends ConsumerStatefulWidget {
  const ForgotPasswordScreen({super.key});

  @override
  ConsumerState<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends ConsumerState<ForgotPasswordScreen> {
  final _emailCtrl = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  @override
  void dispose() {
    _emailCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(forgotPasswordProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Recuperar contraseña')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: state.sent
            ? _SuccessView(email: _emailCtrl.text)
            : Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const SizedBox(height: 16),
                    Container(
                      padding: const EdgeInsets.all(20),
                      decoration: BoxDecoration(
                        color: AppColors.primarySurface,
                        borderRadius: BorderRadius.circular(16),
                      ),
                      child: Column(
                        children: [
                          const Icon(Icons.lock_reset_rounded, size: 48, color: AppColors.primary),
                          const SizedBox(height: 12),
                          const Text(
                            'Recupera tu acceso',
                            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                            textAlign: TextAlign.center,
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'Ingresa tu correo y te enviaremos un enlace para restablecer tu contraseña.',
                            style: TextStyle(color: AppColors.textSecondary, fontSize: 14),
                            textAlign: TextAlign.center,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 32),

                    if (state.error != null) ...[
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: AppColors.errorLight,
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Text(state.error!, style: const TextStyle(color: AppColors.error, fontSize: 13)),
                      ),
                      const SizedBox(height: 16),
                    ],

                    TextFormField(
                      controller: _emailCtrl,
                      keyboardType: TextInputType.emailAddress,
                      decoration: const InputDecoration(
                        labelText: 'Correo electrónico',
                        prefixIcon: Icon(Icons.email_outlined),
                      ),
                      validator: (v) {
                        if (v == null || v.trim().isEmpty) return 'Campo requerido';
                        if (!v.contains('@')) return 'Correo inválido';
                        return null;
                      },
                    ),
                    const SizedBox(height: 24),

                    ElevatedButton(
                      onPressed: state.isLoading
                          ? null
                          : () {
                              if (_formKey.currentState!.validate()) {
                                ref.read(forgotPasswordProvider.notifier).send(_emailCtrl.text.trim());
                              }
                            },
                      child: state.isLoading
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                            )
                          : const Text('Enviar enlace de recuperación'),
                    ),
                  ],
                ),
              ),
      ),
    );
  }
}

class _SuccessView extends StatelessWidget {
  final String email;
  const _SuccessView({required this.email});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 80,
            height: 80,
            decoration: BoxDecoration(color: AppColors.successLight, shape: BoxShape.circle),
            child: const Icon(Icons.check_rounded, color: AppColors.success, size: 44),
          ),
          const SizedBox(height: 24),
          const Text(
            'Correo enviado',
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 12),
          Text(
            'Revisa tu bandeja de entrada en $email y sigue las instrucciones para restablecer tu contraseña.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: AppColors.textSecondary, fontSize: 15),
          ),
          const SizedBox(height: 32),
          OutlinedButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Volver al inicio de sesión'),
          ),
        ],
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/config/routes.dart';
import '../providers/auth_provider.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailCtrl = TextEditingController();
  final _passCtrl = TextEditingController();
  bool _obscure = true;

  @override
  void initState() {
    super.initState();
    _loadSavedEmail();
  }

  Future<void> _loadSavedEmail() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString('saved_email') ?? '';
    if (saved.isNotEmpty) _emailCtrl.text = saved;
  }

  @override
  void dispose() {
    _emailCtrl.dispose();
    _passCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    await ref.read(loginProvider.notifier).signIn(_emailCtrl.text.trim(), _passCtrl.text);
  }

  @override
  Widget build(BuildContext context) {
    final loginState = ref.watch(loginProvider);

    ref.listen(userProfileProvider, (_, next) {
      if (next.valueOrNull != null) context.go(AppRoutes.home);
    });

    final err = loginState.error;

    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: AppColors.darkGradient),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Logo
                  Container(
                    width: 80,
                    height: 80,
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(22),
                    ),
                    child: const Icon(Icons.calculate_rounded, color: Colors.white, size: 42),
                  ),
                  const SizedBox(height: 20),
                  const Text(
                    'Tecno Caja Contadores',
                    style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Inicia sesión para continuar',
                    style: TextStyle(color: Colors.white.withValues(alpha: 0.6), fontSize: 14),
                  ),
                  const SizedBox(height: 40),

                  // Card de login
                  Container(
                    padding: const EdgeInsets.all(24),
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.surface,
                      borderRadius: BorderRadius.circular(24),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withValues(alpha: 0.2),
                          blurRadius: 24,
                          offset: const Offset(0, 8),
                        ),
                      ],
                    ),
                    child: Form(
                      key: _formKey,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (err != null) ...[
                            Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: AppColors.errorLight,
                                borderRadius: BorderRadius.circular(10),
                              ),
                              child: Row(
                                children: [
                                  const Icon(Icons.error_outline, color: AppColors.error, size: 18),
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Text(
                                      err,
                                      style: const TextStyle(color: AppColors.error, fontSize: 13),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 16),
                          ],

                          TextFormField(
                            controller: _emailCtrl,
                            keyboardType: TextInputType.emailAddress,
                            textInputAction: TextInputAction.next,
                            autocorrect: false,
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
                          const SizedBox(height: 16),

                          TextFormField(
                            controller: _passCtrl,
                            obscureText: _obscure,
                            textInputAction: TextInputAction.done,
                            onFieldSubmitted: (_) => _submit(),
                            decoration: InputDecoration(
                              labelText: 'Contraseña',
                              prefixIcon: const Icon(Icons.lock_outline),
                              suffixIcon: IconButton(
                                icon: Icon(_obscure ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                                onPressed: () => setState(() => _obscure = !_obscure),
                              ),
                            ),
                            validator: (v) {
                              if (v == null || v.isEmpty) return 'Campo requerido';
                              if (v.length < 6) return 'Mínimo 6 caracteres';
                              return null;
                            },
                          ),
                          const SizedBox(height: 12),

                          Row(
                            children: [
                              Checkbox(
                                value: loginState.rememberMe,
                                onChanged: (_) => ref.read(loginProvider.notifier).toggleRememberMe(),
                                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              ),
                              const Text('Recordar sesión', style: TextStyle(fontSize: 14)),
                              const Spacer(),
                              TextButton(
                                onPressed: () => context.push(AppRoutes.forgotPassword),
                                child: const Text('¿Olvidaste tu contraseña?', style: TextStyle(fontSize: 13)),
                              ),
                            ],
                          ),
                          const SizedBox(height: 20),

                          ElevatedButton(
                            onPressed: loginState.isLoading ? null : _submit,
                            child: loginState.isLoading
                                ? const SizedBox(
                                    height: 20,
                                    width: 20,
                                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                                  )
                                : const Text('Iniciar sesión'),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 24),
                  Text(
                    'Versión 1.0.0',
                    style: TextStyle(color: Colors.white.withValues(alpha: 0.4), fontSize: 12),
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

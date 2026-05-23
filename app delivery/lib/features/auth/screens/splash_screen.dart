import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/app_colors.dart';
import '../../../core/config/routes.dart';
import '../providers/auth_provider.dart';

class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  late final Animation<double> _fade;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    );
    _fade = CurvedAnimation(parent: _ctrl, curve: Curves.easeIn);
    _ctrl.forward();
    _splashTimeout();
  }

  // GoRouter redirige automáticamente cuando auth resuelve (via refreshListenable).
  // Este timer es un fallback de seguridad para no quedar pegado si Firebase tarda.
  Future<void> _splashTimeout() async {
    await Future.delayed(const Duration(seconds: 2));
    if (!mounted) return;

    final authState = ref.read(authStateProvider);
    if (!authState.isLoading) {
      _goNext(authState.valueOrNull);
      return;
    }

    // Auth sigue cargando — esperar hasta 8 segundos más antes de rendirnos
    await Future.delayed(const Duration(seconds: 8));
    if (!mounted) return;
    _goNext(ref.read(authStateProvider).valueOrNull);
  }

  void _goNext(dynamic repartidor) {
    context.go(repartidor != null ? AppRoutes.pedidos : AppRoutes.login);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: AppColors.primaryGradient),
        child: FadeTransition(
          opacity: _fade,
          child: Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Image.asset(
                  'assets/images/delivery logo.png',
                  width: 180,
                  height: 180,
                  fit: BoxFit.contain,
                ),
                const SizedBox(height: 60),
                const SizedBox(
                  width: 28,
                  height: 28,
                  child: CircularProgressIndicator(
                    color: Colors.white54,
                    strokeWidth: 2.5,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

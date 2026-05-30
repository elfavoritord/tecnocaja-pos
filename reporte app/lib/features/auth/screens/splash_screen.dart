import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/config/routes.dart';
import '../../../core/constants/app_colors.dart';
import '../../../shared/widgets/app_brand_logo.dart';
import '../providers/auth_provider.dart';

class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _fadeAnim;
  late Animation<double> _scaleAnim;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    );
    _fadeAnim = Tween<double>(begin: 0, end: 1).animate(
      CurvedAnimation(parent: _controller, curve: const Interval(0, 0.6)),
    );
    _scaleAnim = Tween<double>(
      begin: 0.8,
      end: 1,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.elasticOut));
    _controller.forward();
    _navigate();
  }

  Future<void> _navigate() async {
    // Espera la animación mínima (estética)
    await Future.delayed(const Duration(milliseconds: 1400));
    if (!mounted) return;

    // Espera activamente a que Firebase Auth determine el estado
    // (máx 6 segundos para no quedarse congelado si Firebase falla)
    User? user;
    try {
      user = await ref
          .read(authRepositoryProvider)
          .authStateChanges
          .first
          .timeout(const Duration(seconds: 6));
    } catch (_) {
      user = null;
    }

    if (!mounted) return;

    if (user != null) {
      try {
        final repo = ref.read(authRepositoryProvider);
        final profile = await repo.ensureCurrentUserHasAccess().timeout(
          const Duration(seconds: 8),
        );
        if (!mounted) return;
        if (profile.isActive) {
          context.go(AppRoutes.dashboard);
          return;
        }
        await repo.signOut();
      } catch (_) {
        // Si algo falla al obtener el perfil, va al login
      }
      if (!mounted) return;
    }

    context.go(AppRoutes.login);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: AppColors.primaryGradient),
        child: Center(
          child: AnimatedBuilder(
            animation: _controller,
            builder: (_, child) => FadeTransition(
              opacity: _fadeAnim,
              child: ScaleTransition(
                scale: _scaleAnim,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const AppBrandLogo(width: 320),
                    const SizedBox(height: 24),
                    Text(
                      'Panel Administrativo',
                      style: TextStyle(
                        fontSize: 15,
                        color: Colors.white.withValues(alpha: 0.75),
                        fontWeight: FontWeight.w400,
                        letterSpacing: 0.5,
                      ),
                    ),
                    const SizedBox(height: 60),
                    SizedBox(
                      width: 24,
                      height: 24,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white.withValues(alpha: 0.6),
                      ),
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

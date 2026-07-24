import 'package:flutter/material.dart';

import '../../widgets/app_logo.dart';

/// Se ve mientras AuthController resuelve el estado inicial (sesion de
/// Firebase + Usuario local). El router redirige desde aqui apenas hay
/// respuesta -- normalmente dura menos de un segundo.
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AppLogo(size: 96),
            SizedBox(height: 24),
            CircularProgressIndicator(),
          ],
        ),
      ),
    );
  }
}

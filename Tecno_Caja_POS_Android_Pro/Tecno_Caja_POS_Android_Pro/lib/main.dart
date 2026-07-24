import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/firebase/firebase_bootstrap.dart';
import 'core/providers/database_providers.dart';
import 'core/router/app_router.dart';
import 'core/theme/app_theme.dart';
import 'data/auth/auth_controller.dart';
import 'data/local/database.dart';
import 'data/repositories/configuracion_repository.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // La app debe arrancar aunque Firebase falle (offline-first): un
  // google-services.json mal configurado no puede tumbar la caja registradora.
  final db = await AppDatabase.instance.database;
  try {
    await initializeFirebase();
  } catch (_) {
    // Se reintenta implicitamente la proxima vez que se llame a un metodo de
    // Firebase Auth/Firestore; mientras tanto la app sigue 100% funcional
    // en modo local.
  }

  runApp(
    ProviderScope(
      overrides: [databaseProvider.overrideWithValue(db)],
      child: const TecnoCajaApp(),
    ),
  );
}

class TecnoCajaApp extends ConsumerStatefulWidget {
  const TecnoCajaApp({super.key});

  @override
  ConsumerState<TecnoCajaApp> createState() => _TecnoCajaAppState();
}

class _TecnoCajaAppState extends ConsumerState<TecnoCajaApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final controller = ref.read(authControllerProvider.notifier);
    if (state == AppLifecycleState.paused || state == AppLifecycleState.inactive) {
      controller.notificarAppPausada();
    } else if (state == AppLifecycleState.resumed) {
      controller.notificarAppReanudada();
    }
  }

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(appRouterProvider);
    final temaConfig = ref.watch(configuracionControllerProvider).valueOrNull?.tema ?? 'sistema';
    final themeMode = switch (temaConfig) {
      'claro' => ThemeMode.light,
      'oscuro' => ThemeMode.dark,
      _ => ThemeMode.system,
    };

    return MaterialApp.router(
      debugShowCheckedModeBanner: false,
      title: 'Tecno Caja POS',
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: themeMode,
      routerConfig: router,
    );
  }
}

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/config/routes.dart';
import 'core/theme/app_theme.dart';
import 'data/models/repartidor_model.dart';
import 'data/providers/ubicacion_provider.dart';
import 'data/services/notification_service.dart';
import 'features/auth/providers/auth_provider.dart';
import 'firebase_options.dart';

@pragma('vm:entry-point')
Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);
  try {
    await NotificationService.init();
  } catch (_) {
    // Las notificaciones no son críticas; si fallan (ej. en web sin service worker) la app sigue funcionando.
  }

  runApp(const ProviderScope(child: TecnoDeliveryApp()));
}

class TecnoDeliveryApp extends ConsumerWidget {
  const TecnoDeliveryApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    return _TrackingBootstrap(
      child: MaterialApp.router(
        title: 'Tecno Caja Delivery',
        theme: AppTheme.lightTheme,
        darkTheme: AppTheme.darkTheme,
        themeMode: ThemeMode.system,
        routerConfig: router,
        debugShowCheckedModeBanner: false,
      ),
    );
  }
}

class _TrackingBootstrap extends ConsumerStatefulWidget {
  final Widget child;

  const _TrackingBootstrap({required this.child});

  @override
  ConsumerState<_TrackingBootstrap> createState() => _TrackingBootstrapState();
}

class _TrackingBootstrapState extends ConsumerState<_TrackingBootstrap> {
  ProviderSubscription<AsyncValue<RepartidorModel?>>? _authSubscription;

  @override
  void initState() {
    super.initState();

    WidgetsBinding.instance.addPostFrameCallback((_) {
      _syncTracking(ref.read(authStateProvider));
    });

    _authSubscription = ref.listenManual<AsyncValue<RepartidorModel?>>(
      authStateProvider,
      (_, next) => _syncTracking(next),
    );
  }

  void _syncTracking(AsyncValue<RepartidorModel?> authState) {
    final repartidor = authState.valueOrNull;
    final notifier = ref.read(ubicacionProvider.notifier);
    if (repartidor == null) {
      notifier.detener();
      return;
    }
    notifier.iniciar();
  }

  @override
  void dispose() {
    _authSubscription?.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:intl/intl.dart';

import 'core/config/firebase_options.dart';
import 'core/config/routes.dart';
import 'core/constants/app_strings.dart';
import 'core/theme/app_theme.dart';
import 'features/settings/providers/theme_provider.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  FlutterError.onError = (details) {
    FlutterError.presentError(details);
    debugPrint(details.exceptionAsString());
  };
  ErrorWidget.builder = (details) =>
      _RuntimeErrorView(message: details.exceptionAsString());
  await initializeDateFormatting('es_DO');
  Intl.defaultLocale = 'es_DO';

  final bootstrapState = await _bootstrapApplication();

  runApp(ProviderScope(child: PosReportsApp(bootstrapState: bootstrapState)));
}

class _RuntimeErrorView extends StatelessWidget {
  final String message;

  const _RuntimeErrorView({required this.message});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: const Color(0xFFF8FAFC),
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(
                  Icons.error_outline_rounded,
                  color: Color(0xFFDC2626),
                  size: 44,
                ),
                const SizedBox(height: 12),
                const Text(
                  'La pantalla tuvo un error',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                Text(
                  message,
                  style: const TextStyle(color: Color(0xFF64748B)),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

Future<AppBootstrapState> _bootstrapApplication() async {
  try {
    await _ensureFirebaseInitialized();
    return const AppBootstrapState.ready();
  } catch (error, stackTrace) {
    debugPrint('Firebase bootstrap error: $error');
    debugPrintStack(stackTrace: stackTrace);
    return AppBootstrapState.failed(error.toString());
  }
}

class PosReportsApp extends ConsumerWidget {
  final AppBootstrapState bootstrapState;

  const PosReportsApp({super.key, required this.bootstrapState});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeMode = ref.watch(themeProvider);

    if (!kIsWeb) {
      SystemChrome.setSystemUIOverlayStyle(
        themeMode == ThemeMode.dark
            ? SystemUiOverlayStyle.light
            : SystemUiOverlayStyle.dark,
      );
    }

    if (!bootstrapState.isReady) {
      return MaterialApp(
        debugShowCheckedModeBanner: false,
        title: AppStrings.appName,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        home: _BootstrapInfoScreen(
          title: 'No se pudo iniciar Firebase',
          message:
              'La app ya esta preparada para Android, iOS y PC, pero Firebase no logro iniciar. '
              'Si usas web o escritorio, puedes ajustar los valores en '
              '`lib/core/config/firebase_options.dart` o pasar '
              '`--dart-define` para registrar tus IDs por plataforma.\n\n'
              'Detalle: ${bootstrapState.errorMessage ?? 'desconocido'}',
        ),
      );
    }

    final router = ref.watch(routerProvider);

    return MaterialApp.router(
      debugShowCheckedModeBanner: false,
      title: AppStrings.appName,
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: themeMode,
      routerConfig: router,
    );
  }
}

class AppBootstrapState {
  final bool isReady;
  final String? errorMessage;

  const AppBootstrapState._({required this.isReady, this.errorMessage});

  const AppBootstrapState.ready() : this._(isReady: true);

  AppBootstrapState.failed(String message)
    : this._(isReady: false, errorMessage: message);
}

class _BootstrapInfoScreen extends StatelessWidget {
  final String title;
  final String message;

  const _BootstrapInfoScreen({required this.title, required this.message});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(24),
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            colors: [Color(0xFF0F172A), Color(0xFF1E293B), Color(0xFF2563EB)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.mobile_friendly_rounded, size: 42),
                    const SizedBox(height: 16),
                    Text(
                      title,
                      style: Theme.of(context).textTheme.headlineSmall
                          ?.copyWith(fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      message,
                      style: Theme.of(context).textTheme.bodyMedium,
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

Future<void> _ensureFirebaseInitialized() async {
  final options = DefaultFirebaseOptions.currentPlatform;

  if (!kIsWeb) {
    await Firebase.initializeApp(options: options);
    return;
  }

  try {
    await Firebase.initializeApp(options: options);
  } on Object catch (error, stackTrace) {
    if (!_isRecoverableWebFirebaseInitError(error)) {
      Error.throwWithStackTrace(error, stackTrace);
    }

    debugPrint(
      'Firebase web init failed with optional config fields. '
      'Retrying with the required options only: $error',
    );

    await Firebase.initializeApp(
      options: FirebaseOptions(
        apiKey: options.apiKey,
        appId: options.appId,
        messagingSenderId: options.messagingSenderId,
        projectId: options.projectId,
      ),
    );
  }
}

bool _isRecoverableWebFirebaseInitError(Object error) {
  final message = error.toString().toLowerCase();
  return message.contains('null check operator used on a null value') ||
      message.contains('expected a value of type') ||
      message.contains('cannot read properties of null') ||
      message.contains('cannot read properties of undefined');
}

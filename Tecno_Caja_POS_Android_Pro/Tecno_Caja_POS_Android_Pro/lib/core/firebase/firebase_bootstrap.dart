import 'dart:async';

import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';

import '../../firebase_options.dart';

/// Registrado con `flutterfire configure --project=reporte-sistema-pos` en
/// el MISMO proyecto Firebase que ya usa Tecno Caja POS Windows -- necesario
/// para que la vinculacion por Google/Tecno Caja ID (ver AuthController)
/// reconozca la misma cuenta en ambos lados. No apuntar esto a un proyecto
/// Firebase distinto.
Future<void> initializeFirebase() async {
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);

  // Crashlytics y App Check (con AndroidProvider) no tienen implementacion
  // web -- ver plataformas declaradas en el pubspec de cada paquete.
  if (!kIsWeb) {
    FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError;
    PlatformDispatcher.instance.onError = (error, stack) {
      FirebaseCrashlytics.instance.recordError(error, stack, fatal: true);
      return true;
    };

    try {
      await FirebaseAppCheck.instance.activate(androidProvider: AndroidProvider.playIntegrity);
    } catch (_) {
      // App Check requiere que el proyecto Firebase real tenga Play Integrity
      // configurado -- con el proyecto placeholder esto puede fallar, y no
      // debe tumbar el arranque de la app (el resto sigue funcionando offline).
    }
  }
}

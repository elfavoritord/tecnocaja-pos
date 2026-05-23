// File generado para el proyecto: reporte-sistema-pos
// IMPORTANTE: Registra la app Android en Firebase Console con el paquete
// com.tecnocaja.delivery, descarga el google-services.json y ejecuta:
//   flutterfire configure --project=reporte-sistema-pos
// para actualizar los appId de Android/iOS.
// ignore_for_file: type=lint
import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;

class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    if (kIsWeb) return web;
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        return ios;
      case TargetPlatform.macOS:
        return macos;
      case TargetPlatform.windows:
        return windows;
      default:
        throw UnsupportedError('Plataforma no soportada');
    }
  }

  static const FirebaseOptions web = FirebaseOptions(
    apiKey: 'AIzaSyBLWv3KZeNBtAr9eo3totVfZtp0Mz_Ha2k',
    appId: '1:1052855422372:web:5d1ceec228f279d9b50531',
    messagingSenderId: '1052855422372',
    projectId: 'reporte-sistema-pos',
    authDomain: 'reporte-sistema-pos.firebaseapp.com',
    storageBucket: 'reporte-sistema-pos.firebasestorage.app',
    measurementId: 'G-W2KLJPVW5N',
  );

  // Reemplazar appId después de registrar com.tecnocaja.delivery en Firebase Console
  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyBRRqmLLC6j4nipkyJFa2kjqKfMswW5XYI',
    appId: '1:1052855422372:android:PENDIENTE_FIREBASE_CONSOLE',
    messagingSenderId: '1052855422372',
    projectId: 'reporte-sistema-pos',
    storageBucket: 'reporte-sistema-pos.firebasestorage.app',
  );

  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: 'AIzaSyCl5417pVuoWx5gqrUJOIb2bJcyGHV6pH4',
    appId: '1:1052855422372:ios:PENDIENTE_FIREBASE_CONSOLE',
    messagingSenderId: '1052855422372',
    projectId: 'reporte-sistema-pos',
    storageBucket: 'reporte-sistema-pos.firebasestorage.app',
    iosBundleId: 'com.tecnocaja.delivery',
  );

  static const FirebaseOptions macos = FirebaseOptions(
    apiKey: 'AIzaSyCl5417pVuoWx5gqrUJOIb2bJcyGHV6pH4',
    appId: '1:1052855422372:ios:PENDIENTE_FIREBASE_CONSOLE',
    messagingSenderId: '1052855422372',
    projectId: 'reporte-sistema-pos',
    storageBucket: 'reporte-sistema-pos.firebasestorage.app',
    iosBundleId: 'com.tecnocaja.delivery',
  );

  static const FirebaseOptions windows = FirebaseOptions(
    apiKey: 'AIzaSyBLWv3KZeNBtAr9eo3totVfZtp0Mz_Ha2k',
    appId: '1:1052855422372:web:4a6c84c9a5fd4c69b50531',
    messagingSenderId: '1052855422372',
    projectId: 'reporte-sistema-pos',
    authDomain: 'reporte-sistema-pos.firebaseapp.com',
    storageBucket: 'reporte-sistema-pos.firebasestorage.app',
    measurementId: 'G-YDDBL1M8B3',
  );
}
